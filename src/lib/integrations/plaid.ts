import "server-only";

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type Transaction,
} from "plaid";
import { prisma } from "@/lib/prisma";
import { getConnection, saveSecret, getSecret, markSynced, markError } from "./connections";
import { encryptSecret, decryptSecret } from "./crypto";

// ---------------------------------------------------------------------------
// Plaid — read-only bank & credit-card connections.
//
// The forensic audit proved the business QuickBooks only sees business checking
// + Stripe, while real costs also flow through Jordan's personal ...0942 account,
// personal Venmo, and a Capital One card that has ZERO rows in the books. Plaid
// closes that gap: it reads transaction history + balances from those accounts.
//
// SECURITY: Plaid pulls data only — it cannot move money. Jordan authenticates
// each bank INSIDE Plaid Link (Plaid's own hosted screen); the bank login never
// touches our server. The per-bank access token is exchanged server-side and
// stored ENCRYPTED (never sent to the browser). App credentials (client_id +
// secret) live in the encrypted "plaid" Connection row, entered by Jordan in
// the in-app form — same posture as the Stripe/Anthropic keys.
// ---------------------------------------------------------------------------

const PROVIDER = "plaid";

export type PlaidEnv = "sandbox" | "production";

type PlaidCreds = { clientId: string; secret: string; env: PlaidEnv };

function appBase(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || "http://localhost:3000";
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

/** The OAuth return URL Plaid Link redirects to for OAuth banks (Capital One,
 *  Chase, etc.). Must be registered in the Plaid dashboard's allowed redirect
 *  URIs. Only sent on https deploys — Plaid rejects http/localhost redirects. */
export function plaidRedirectUri(): string {
  return `${appBase()}/connections/banks`;
}

/** App-level Plaid credentials from the encrypted connection, or null. */
export async function getPlaidCreds(): Promise<PlaidCreds | null> {
  const conn = await getConnection(PROVIDER);
  const secret = await getSecret(PROVIDER);
  if (!conn || !secret) return null;
  let meta: { clientId?: string; env?: string } = {};
  try {
    meta = conn.metadata ? JSON.parse(conn.metadata) : {};
  } catch {
    meta = {};
  }
  if (!meta.clientId) return null;
  const env: PlaidEnv = meta.env === "sandbox" ? "sandbox" : "production";
  return { clientId: meta.clientId, secret, env };
}

export async function plaidConfigured(): Promise<boolean> {
  return (await getPlaidCreds()) !== null;
}

/** Save/replace the app-level Plaid credentials (owner-entered, encrypted). */
export async function savePlaidCreds(clientId: string, secret: string, env: PlaidEnv) {
  await saveSecret(PROVIDER, secret, {
    accountLabel: env === "sandbox" ? "Sandbox" : "Production",
    metadata: { clientId, env },
  });
}

async function client(): Promise<PlaidApi> {
  const creds = await getPlaidCreds();
  if (!creds) throw new Error("Plaid is not configured — add your Plaid credentials first.");
  const config = new Configuration({
    basePath: PlaidEnvironments[creds.env],
    baseOptions: {
      headers: { "PLAID-CLIENT-ID": creds.clientId, "PLAID-SECRET": creds.secret },
    },
  });
  return new PlaidApi(config);
}

/**
 * Create a Link token to initialize Plaid Link in the browser. Requests up to
 * 730 days of transaction history so we capture the full picture, not just the
 * default 90-day window.
 */
export async function createLinkToken(userId: string): Promise<string> {
  const api = await client();
  const base = appBase();
  // OAuth banks require a registered https redirect; omit on localhost/sandbox.
  const redirectUri = base.startsWith("https://") ? `${base}/connections/banks` : undefined;
  const resp = await api.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "RealTour Pilot",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
    transactions: { days_requested: 730 },
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
  return resp.data.link_token;
}

async function institutionName(api: PlaidApi, institutionId: string | null | undefined): Promise<string | null> {
  if (!institutionId) return null;
  try {
    const r = await api.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    return r.data.institution.name ?? null;
  } catch {
    return null;
  }
}

function upsertAccountsData(accounts: AccountBase[], plaidItemId: string) {
  return accounts.map((a) =>
    prisma.plaidAccount.upsert({
      where: { accountId: a.account_id },
      create: {
        plaidItemId,
        accountId: a.account_id,
        name: a.name ?? null,
        officialName: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
        currentBalance: a.balances.current ?? null,
        availableBalance: a.balances.available ?? null,
        isoCurrency: a.balances.iso_currency_code ?? null,
      },
      update: {
        name: a.name ?? null,
        officialName: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
        currentBalance: a.balances.current ?? null,
        availableBalance: a.balances.available ?? null,
        isoCurrency: a.balances.iso_currency_code ?? null,
      },
    }),
  );
}

/**
 * Exchange the public token from a successful Link flow for a permanent,
 * read-only access token; store the item + its accounts. Returns the item.
 */
export async function exchangePublicToken(publicToken: string) {
  const api = await client();
  const ex = await api.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = ex.data.access_token;
  const itemId = ex.data.item_id;

  const acc = await api.accountsGet({ access_token: accessToken });
  const instId = acc.data.item.institution_id ?? null;
  const instName = await institutionName(api, instId);

  const item = await prisma.plaidItem.upsert({
    where: { itemId },
    create: {
      itemId,
      accessTokenEncrypted: encryptSecret(accessToken),
      institutionId: instId,
      institutionName: instName,
      status: "ACTIVE",
    },
    update: {
      accessTokenEncrypted: encryptSecret(accessToken),
      institutionId: instId,
      institutionName: instName,
      status: "ACTIVE",
      lastError: null,
    },
  });

  await prisma.$transaction(upsertAccountsData(acc.data.accounts, item.id));
  await markSynced(PROVIDER, instName ?? undefined);
  // Pull the full available history immediately (not just the ~30-day initial
  // window /transactions/sync returns). If a very large account exceeds the
  // request budget, the item is still saved and the "Pull full history" button
  // completes it — both paths are idempotent.
  await backfillItem(item.id).catch(() => {});
  return item;
}

function txnDate(s: string | null | undefined): Date {
  return s ? new Date(`${s}T12:00:00Z`) : new Date();
}

function txnRow(t: Transaction) {
  return {
    accountId: t.account_id,
    amount: t.amount,
    isoCurrency: t.iso_currency_code ?? null,
    date: txnDate(t.date),
    authorizedDate: t.authorized_date ? txnDate(t.authorized_date) : null,
    name: t.name ?? null,
    merchantName: t.merchant_name ?? null,
    category: t.personal_finance_category?.primary ?? null,
    categoryDetail: t.personal_finance_category?.detailed ?? null,
    paymentChannel: t.payment_channel ?? null,
    pending: t.pending ?? false,
  };
}

/**
 * Pull all available transaction history for one item via /transactions/sync,
 * advancing the stored cursor so re-runs are incremental. Also refreshes each
 * account's balances. Read-only.
 */
export async function syncItem(itemDbId: string): Promise<{ added: number; modified: number; removed: number }> {
  const item = await prisma.plaidItem.findUnique({ where: { id: itemDbId } });
  if (!item) throw new Error("Plaid item not found");
  const api = await client();
  const accessToken = decryptSecret(item.accessTokenEncrypted);

  try {
    // Refresh balances + account list first (also picks up newly-shared accounts).
    const acc = await api.accountsGet({ access_token: accessToken });
    await prisma.$transaction(upsertAccountsData(acc.data.accounts, item.id));

    let cursor = item.cursor ?? undefined;
    const added: Transaction[] = [];
    const modified: Transaction[] = [];
    const removed: string[] = [];
    let hasMore = true;
    // Guard against an unbounded loop; each page is up to 500 txns.
    let pages = 0;
    while (hasMore && pages < 200) {
      const r = await api.transactionsSync({ access_token: accessToken, cursor });
      added.push(...r.data.added);
      modified.push(...r.data.modified);
      removed.push(...r.data.removed.map((x) => x.transaction_id));
      hasMore = r.data.has_more;
      cursor = r.data.next_cursor;
      pages++;
    }

    // Apply changes. added → createMany(skipDuplicates); modified → per-row
    // upsert; removed → deleteMany. Accounts already exist (FK satisfied).
    if (added.length) {
      await prisma.plaidTransaction.createMany({
        data: added.map((t) => ({ id: t.transaction_id, ...txnRow(t) })),
        skipDuplicates: true,
      });
    }
    for (const t of modified) {
      await prisma.plaidTransaction.upsert({
        where: { id: t.transaction_id },
        create: { id: t.transaction_id, ...txnRow(t) },
        update: txnRow(t),
      });
    }
    if (removed.length) {
      await prisma.plaidTransaction.deleteMany({ where: { id: { in: removed } } });
    }

    await prisma.plaidItem.update({
      where: { id: item.id },
      data: { cursor: cursor ?? null, status: "ACTIVE", lastError: null, lastSyncedAt: new Date() },
    });
    await markSynced(PROVIDER);
    return { added: added.length, modified: modified.length, removed: removed.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plaid sync failed";
    await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "ERROR", lastError: msg } }).catch(() => {});
    await markError(PROVIDER, msg);
    throw e;
  }
}

/**
 * Reliable FULL-history load via /transactions/get over an explicit window.
 * /transactions/sync delivers history in async batches and stops short on the
 * initial connect (it left PNC at ~30 days while Plaid actually held 7,664);
 * this pages the whole window in one pass so nothing is missed. Idempotent
 * (upsert / skipDuplicates). Used on connect and by the "Pull full history"
 * button. monthsBack defaults to 24 (Plaid's max transactions history).
 */
export async function backfillItem(itemDbId: string, monthsBack = 24): Promise<number> {
  const item = await prisma.plaidItem.findUnique({ where: { id: itemDbId } });
  if (!item) throw new Error("Plaid item not found");
  const api = await client();
  const accessToken = decryptSecret(item.accessTokenEncrypted);
  const end = new Date();
  const start = new Date(end.getTime() - monthsBack * 30 * 864e5);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  try {
    const acc = await api.accountsGet({ access_token: accessToken });
    await prisma.$transaction(upsertAccountsData(acc.data.accounts, item.id));

    let offset = 0;
    let total = Infinity;
    let fetched = 0;
    while (offset < total) {
      const r = await api.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset },
      });
      total = r.data.total_transactions;
      const txns = r.data.transactions;
      if (!txns.length) break;
      await prisma.plaidTransaction.createMany({
        data: txns.map((t) => ({ id: t.transaction_id, ...txnRow(t) })),
        skipDuplicates: true,
      });
      fetched += txns.length;
      offset += txns.length;
    }
    await prisma.plaidItem.update({
      where: { id: item.id },
      data: { status: "ACTIVE", lastError: null, lastSyncedAt: new Date() },
    });
    await markSynced(PROVIDER);
    return fetched;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plaid backfill failed";
    await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "ERROR", lastError: msg } }).catch(() => {});
    await markError(PROVIDER, msg);
    throw e;
  }
}

/** Full-history backfill across every connected item. */
export async function backfillAllPlaid(): Promise<{ items: number; fetched: number }> {
  const items = await prisma.plaidItem.findMany({ where: { status: { not: "DISCONNECTED" } } });
  let fetched = 0;
  for (const it of items) {
    try {
      fetched += await backfillItem(it.id);
    } catch {
      /* item already marked ERROR; keep going */
    }
  }
  return { items: items.length, fetched };
}

/** Sync every active connected item. Used by the "Sync now" button + daily cron. */
export async function syncAllPlaid(): Promise<{ items: number; added: number; modified: number; removed: number }> {
  const items = await prisma.plaidItem.findMany({ where: { status: { not: "DISCONNECTED" } } });
  let added = 0,
    modified = 0,
    removed = 0;
  for (const it of items) {
    try {
      const r = await syncItem(it.id);
      added += r.added;
      modified += r.modified;
      removed += r.removed;
    } catch {
      /* item already marked ERROR; keep going */
    }
  }
  return { items: items.length, added, modified, removed };
}

// Second chance for items that FAILED the morning sweep. One daily sync used to
// be the only attempt an item got, so a single transient 429 froze it for a full
// day (PNC sat stuck 2 days on exactly this). The daily cron calls this as its
// LAST step — minutes after syncAllPlaid, comfortably past minute-scale rate
// limits, with no sleep burning the cron budget. Real errors (login required)
// stay ERROR and keep their "Needs attention" chip on the banks page.
export async function retryErroredPlaidItems(): Promise<{ retried: number; recovered: number }> {
  const errored = await prisma.plaidItem.findMany({ where: { status: "ERROR" }, select: { id: true } });
  let recovered = 0;
  for (const it of errored) {
    try {
      await syncItem(it.id);
      recovered++;
    } catch {
      /* still failing — keeps its ERROR badge */
    }
  }
  return { retried: errored.length, recovered };
}

/** Everything the connect UI needs: connected banks, their accounts + balances. */
export async function listPlaidBanks() {
  const items = await prisma.plaidItem.findMany({
    where: { status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    include: {
      accounts: { orderBy: { name: "asc" } },
      _count: { select: { accounts: true } },
    },
  });
  const txnCount = await prisma.plaidTransaction.count();
  return { items, txnCount };
}

/** Disconnect one bank: remove it at Plaid, then drop it locally (cascades). */
export async function removePlaidItem(itemDbId: string) {
  const item = await prisma.plaidItem.findUnique({ where: { id: itemDbId } });
  if (!item) return;
  try {
    const api = await client();
    await api.itemRemove({ access_token: decryptSecret(item.accessTokenEncrypted) });
  } catch {
    /* remove locally even if Plaid call fails */
  }
  await prisma.plaidItem.delete({ where: { id: item.id } });
}
