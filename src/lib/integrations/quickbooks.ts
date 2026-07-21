import "server-only";
import { getSecret, saveSecret, markSynced, markError, getConnection } from "./connections";

// ---------------------------------------------------------------------------
// QuickBooks Online (Intuit) — the missing half of the money picture.
//
// Aryeo knows what we DELIVERED. Stripe knows what we COLLECTED through Stripe.
// QuickBooks holds everything processed outside Stripe, plus the real expense
// ledger. Until this is connected, every revenue and profit figure in the Hub
// is understated, which is exactly the blind spot that made the pay model
// impossible to trust.
//
// Read-mostly by design: we pull invoices, payments, expenses and the P&L, and
// we never post journal entries back. Jordan authorizes via Intuit's own OAuth
// screen; the refresh token lives encrypted and never leaves this layer.
// ---------------------------------------------------------------------------

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
// Accounting scope only. We deliberately do NOT request payments/payroll write.
const SCOPES = "com.intuit.quickbooks.accounting";

// Two environments, one switch. Intuit issues SEPARATE credentials for the
// Development (sandbox) and Production apps, and they are not interchangeable:
// a sandbox refresh token replayed against the production host fails with a
// misleading auth error. So QBO_ENV picks the credential pair AND the host
// together, and the environment is stamped on the connection (see assertEnv).
//
// Workflow: test end-to-end against a sandbox company on Development keys,
// then flip QBO_ENV to "production" and reconnect once for real.
export const IS_SANDBOX = process.env.QBO_ENV === "sandbox";

const CLIENT_ID =
  (IS_SANDBOX ? process.env.QBO_SANDBOX_CLIENT_ID : process.env.QBO_CLIENT_ID) ?? "";
const CLIENT_SECRET =
  (IS_SANDBOX ? process.env.QBO_SANDBOX_CLIENT_SECRET : process.env.QBO_CLIENT_SECRET) ?? "";

const API_BASE = IS_SANDBOX
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";

/** Which Intuit environment this deploy talks to. Surfaced on /connections. */
export function quickbooksEnv(): "sandbox" | "production" {
  return IS_SANDBOX ? "sandbox" : "production";
}

export class QuickBooksError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "QuickBooksError";
  }
}

function appBase() {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || "http://localhost:3000";
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

export function quickbooksConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function quickbooksRedirectUri(): string {
  return `${appBase()}/api/quickbooks/callback`;
}

/** The Intuit consent URL the owner visits to authorize. */
export function quickbooksAuthorizeUrl(state: string): string {
  const u = new URL(AUTH_BASE);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", quickbooksRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  return u.toString();
}

function basicAuth(): string {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/**
 * Exchange the auth code for tokens. Intuit returns the companyId ("realmId")
 * as a query param on the callback, NOT in the token body, so it is passed in
 * and stored in metadata — every subsequent API call needs it.
 */
export async function exchangeQuickBooksCode(
  code: string,
  realmId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!quickbooksConfigured()) return { ok: false, error: "QuickBooks app credentials are not set." };
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      redirect_uri: quickbooksRedirectUri(),
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.refresh_token) {
    return { ok: false, error: json.error_description || json.error || `Intuit token ${res.status}` };
  }
  const env = quickbooksEnv();
  await saveSecret("quickbooks", json.refresh_token, {
    accountLabel: `QuickBooks${IS_SANDBOX ? " (sandbox)" : ""}`,
    metadata: { realmId, env, refreshedAt: new Date().toISOString() },
  });
  // Best-effort: name the connection after the actual company.
  try {
    const info = await companyInfo();
    if (info?.CompanyName) {
      await saveSecret("quickbooks", json.refresh_token, {
        accountLabel: `QuickBooks · ${info.CompanyName}${IS_SANDBOX ? " (sandbox)" : ""}`,
        metadata: { realmId, env, refreshedAt: new Date().toISOString() },
      });
    }
  } catch { /* label is cosmetic */ }
  return { ok: true };
}

type QboMeta = { realmId?: string; env?: "sandbox" | "production"; lastTxnCreated?: number };

async function readMeta(): Promise<QboMeta> {
  const conn = await getConnection("quickbooks");
  if (!conn?.metadata) return {};
  try { return JSON.parse(conn.metadata) as QboMeta; } catch { return {}; }
}

/**
 * Refuse to use a token minted in the other environment. Without this you get a
 * generic 401 that looks like a broken integration, when the real cause is
 * "QBO_ENV was flipped and nobody reconnected".
 */
function assertEnv(meta: QboMeta) {
  const current = quickbooksEnv();
  if (meta.env && meta.env !== current) {
    throw new QuickBooksError(
      `This QuickBooks connection was made against the ${meta.env} environment, but the app is now set to ${current}. Disconnect and reconnect QuickBooks to continue.`,
      409,
    );
  }
}

/**
 * Mint a short-lived access token from the stored refresh token.
 * Intuit ROTATES the refresh token on most refreshes — if we don't persist the
 * new one the connection silently dies in ~24h. That is the single most common
 * way a QuickBooks integration breaks, so we always write it back.
 */
async function accessToken(): Promise<string> {
  const refresh = await getSecret("quickbooks");
  if (!refresh) throw new QuickBooksError("QuickBooks is not connected.", 401);
  assertEnv(await readMeta());
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new QuickBooksError(
      json.error_description || json.error || `Intuit refresh failed (${res.status}). Reconnect QuickBooks.`,
      res.status,
    );
  }
  if (json.refresh_token && json.refresh_token !== refresh) {
    const meta = await readMeta();
    await saveSecret("quickbooks", json.refresh_token, {
      metadata: { ...meta, refreshedAt: new Date().toISOString() },
    });
  }
  return json.access_token;
}

async function qbo<T>(path: string, opts: { query?: Record<string, string> } = {}): Promise<T> {
  const { realmId } = await readMeta();
  if (!realmId) throw new QuickBooksError("QuickBooks company id is missing. Reconnect.", 400);
  const token = await accessToken();
  const url = new URL(`${API_BASE}/v3/company/${realmId}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("minorversion", "70");
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new QuickBooksError(`QuickBooks ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** Run a QuickBooks SQL-ish query. Returns the QueryResponse payload. */
export async function qboQuery<T = Record<string, unknown>>(
  sql: string,
): Promise<{ rows: T[]; total: number }> {
  const json = await qbo<{ QueryResponse?: Record<string, unknown> }>("/query", { query: { query: sql } });
  const qr = json.QueryResponse ?? {};
  const key = Object.keys(qr).find((k) => Array.isArray((qr as Record<string, unknown>)[k]));
  const rows = (key ? (qr as Record<string, unknown>)[key] : []) as T[];
  return { rows: rows ?? [], total: Number((qr as { totalCount?: number }).totalCount ?? rows?.length ?? 0) };
}

export type QboCompany = { CompanyName?: string; LegalName?: string; Id?: string };

export async function companyInfo(): Promise<QboCompany | null> {
  const { realmId } = await readMeta();
  if (!realmId) return null;
  const json = await qbo<{ CompanyInfo?: QboCompany }>(`/companyinfo/${realmId}`);
  return json.CompanyInfo ?? null;
}

/** Connect-time validation: can we actually read this company? */
export async function testQuickBooks(): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const info = await companyInfo();
    if (!info) return { ok: false, error: "Connected, but no company info came back. Try reconnecting." };
    return { ok: true, label: `QuickBooks · ${info.CompanyName || info.LegalName || info.Id}` };
  } catch (e) {
    return { ok: false, error: e instanceof QuickBooksError ? e.message : "Couldn't reach QuickBooks." };
  }
}

// --- Reporting -------------------------------------------------------------

export type PnlLine = { label: string; amount: number; group: string };
export type QboPnl = { start: string; end: string; income: number; expenses: number; netIncome: number; lines: PnlLine[] };

type ReportCell = { value?: string };
type ReportRow = {
  Header?: { ColData?: ReportCell[] };
  Summary?: { ColData?: ReportCell[] };
  ColData?: ReportCell[];
  Rows?: { Row?: ReportRow[] };
  group?: string;
  type?: string;
};

const num = (s?: string) => {
  const n = Number(String(s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pull the real Profit & Loss for a date range. This is the number that has
 * been missing: it includes revenue processed OUTSIDE Stripe and the expenses
 * that never made it into the Hub.
 */
export async function profitAndLoss(startKey: string, endKey: string): Promise<QboPnl> {
  const json = await qbo<{ Rows?: { Row?: ReportRow[] } }>("/reports/ProfitAndLoss", {
    query: { start_date: startKey, end_date: endKey, accounting_method: "Cash" },
  });
  const lines: PnlLine[] = [];
  let income = 0;
  let expenses = 0;

  const walk = (rows: ReportRow[] | undefined, group: string) => {
    for (const r of rows ?? []) {
      const g = r.group || group;
      const cols = r.ColData;
      if (cols && cols.length >= 2 && cols[0]?.value) {
        const amount = num(cols[cols.length - 1]?.value);
        if (amount) lines.push({ label: cols[0].value, amount, group: g });
      }
      const sum = r.Summary?.ColData;
      if (sum && sum.length >= 2) {
        const label = String(sum[0]?.value ?? "");
        const amount = num(sum[sum.length - 1]?.value);
        if (/^total income$/i.test(label)) income = amount;
        if (/^total expenses$/i.test(label)) expenses = amount;
      }
      walk(r.Rows?.Row, g);
    }
  };
  walk(json.Rows?.Row, "");

  return { start: startKey, end: endKey, income, expenses, netIncome: Math.round((income - expenses) * 100) / 100, lines };
}

// --- Sync ------------------------------------------------------------------

/**
 * Pull invoices + payments + purchases into the Hub so the Money tab can show a
 * true picture and so we can reconcile against Aryeo and Stripe.
 * Gated on the SECRET being present rather than status === CONNECTED, so one
 * transient error can't freeze sync forever.
 */
export async function syncQuickBooks(opts: { sinceKey?: string } = {}): Promise<{
  invoices: number; payments: number; purchases: number;
}> {
  const { prisma } = await import("@/lib/prisma");
  try {
    const conn = await getConnection("quickbooks");
    if (!conn || conn.status === "DISCONNECTED" || !conn.secretEncrypted) {
      return { invoices: 0, payments: 0, purchases: 0 };
    }
    const since = opts.sinceKey ?? new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    let invoices = 0, payments = 0, purchases = 0;

    // Invoices (what we billed, including everything not in Stripe)
    for (let start = 1; start < 4000; start += 200) {
      const { rows } = await qboQuery<Record<string, unknown>>(
        `select * from Invoice where TxnDate >= '${since}' startposition ${start} maxresults 200`,
      );
      if (!rows.length) break;
      for (const r of rows) {
        const id = String(r.Id ?? "");
        if (!id) continue;
        const total = Number(r.TotalAmt ?? 0);
        const balance = Number(r.Balance ?? 0);
        const txnDate = String(r.TxnDate ?? "");
        const cust = (r.CustomerRef as { name?: string } | undefined)?.name ?? null;
        await prisma.qboTransaction.upsert({
          where: { qboId_type: { qboId: id, type: "Invoice" } },
          create: {
            qboId: id, type: "Invoice", txnDate: new Date(`${txnDate}T12:00:00Z`),
            amount: total, balance, customerName: cust, docNumber: String(r.DocNumber ?? "") || null,
            raw: JSON.stringify(r).slice(0, 8000),
          },
          update: { amount: total, balance, customerName: cust, syncedAt: new Date() },
        });
        invoices++;
      }
      if (rows.length < 200) break;
    }

    // Payments (cash actually received, any processor)
    for (let start = 1; start < 4000; start += 200) {
      const { rows } = await qboQuery<Record<string, unknown>>(
        `select * from Payment where TxnDate >= '${since}' startposition ${start} maxresults 200`,
      );
      if (!rows.length) break;
      for (const r of rows) {
        const id = String(r.Id ?? "");
        if (!id) continue;
        const txnDate = String(r.TxnDate ?? "");
        await prisma.qboTransaction.upsert({
          where: { qboId_type: { qboId: id, type: "Payment" } },
          create: {
            qboId: id, type: "Payment", txnDate: new Date(`${txnDate}T12:00:00Z`),
            amount: Number(r.TotalAmt ?? 0), balance: 0,
            customerName: (r.CustomerRef as { name?: string } | undefined)?.name ?? null,
            docNumber: null, raw: JSON.stringify(r).slice(0, 8000),
          },
          update: { amount: Number(r.TotalAmt ?? 0), syncedAt: new Date() },
        });
        payments++;
      }
      if (rows.length < 200) break;
    }

    // Purchases (expenses — the half of the P&L the Hub has never seen)
    for (let start = 1; start < 4000; start += 200) {
      const { rows } = await qboQuery<Record<string, unknown>>(
        `select * from Purchase where TxnDate >= '${since}' startposition ${start} maxresults 200`,
      );
      if (!rows.length) break;
      for (const r of rows) {
        const id = String(r.Id ?? "");
        if (!id) continue;
        const txnDate = String(r.TxnDate ?? "");
        const acct = (r.AccountRef as { name?: string } | undefined)?.name ?? null;
        const entity = (r.EntityRef as { name?: string } | undefined)?.name ?? null;
        await prisma.qboTransaction.upsert({
          where: { qboId_type: { qboId: id, type: "Purchase" } },
          create: {
            qboId: id, type: "Purchase", txnDate: new Date(`${txnDate}T12:00:00Z`),
            amount: Number(r.TotalAmt ?? 0), balance: 0,
            customerName: entity, accountName: acct, docNumber: null,
            raw: JSON.stringify(r).slice(0, 8000),
          },
          update: { amount: Number(r.TotalAmt ?? 0), accountName: acct, syncedAt: new Date() },
        });
        purchases++;
      }
      if (rows.length < 200) break;
    }

    await markSynced("quickbooks");
    return { invoices, payments, purchases };
  } catch (e) {
    await markError("quickbooks", e instanceof Error ? e.message : "QuickBooks sync failed").catch(() => {});
    throw e;
  }
}
