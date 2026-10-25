import "server-only";
import { getSecret, markSynced, markError, getConnection } from "./connections";
import { fetchWithTimeout } from "@/lib/http";
import { STRIPE_SALE_TYPES, STRIPE_REVERSAL_TYPES, isStripeDispute } from "@/lib/revenueMonthCore";

// ---------------------------------------------------------------------------
// Stripe — the AUTHORITATIVE money-in source. Stripe always knows exactly what
// was charged, what it netted after fees, and when it hit the bank. Read-only:
// we sync balance transactions (the fee-accurate ledger) into StripeTransaction
// and never push writes. Jordan pastes a RESTRICTED read key on /connections;
// the secret lives encrypted and never leaves this layer.
// ---------------------------------------------------------------------------

const BASE = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "StripeError";
  }
}

// Stripe amounts are in CENTS — everything else in the Hub is dollars.
const dollars = (cents: number | null | undefined) => Math.round(((cents ?? 0) / 100) * 100) / 100;

async function stripeGet<T>(path: string, opts: { key?: string; query?: Record<string, string | number | string[]> } = {}): Promise<T> {
  const key = opts.key ?? (await getSecret("stripe"));
  if (!key) throw new StripeError("Stripe is not connected.", 401);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}${qs.toString() ? `?${qs}` : ""}`;
  // 30 s a request (Oct 20 2026, audit H7): the daily money sync pages through
  // this, and a hung page used to hold the step until the platform killed it.
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new StripeError(body.error?.message || `Stripe error ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

type StripeAccount = { id: string; business_profile?: { name?: string } | null; email?: string | null };
type StripeBalance = { available?: { amount: number; currency: string }[]; pending?: { amount: number; currency: string }[] };
type BalanceTxn = {
  id: string; type: string; amount: number; fee: number; net: number; currency: string; created: number;
  description?: string | null;
  source?: { billing_details?: { name?: string | null } | null; customer?: string | null } | string | null;
};

// Connect-time validation: does this key work + read balance? Label from the
// account when the key can see it (a restricted key may not — degrade cleanly).
export async function testStripeKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    await stripeGet<StripeBalance>("/balance", { key }); // core read — proves the key is valid
    let label = "Stripe";
    try {
      const acct = await stripeGet<StripeAccount>("/account", { key });
      label = `Stripe · ${acct.business_profile?.name || acct.email || acct.id}`;
    } catch { /* restricted key without account read — fine */ }
    return { ok: true, label };
  } catch (e) {
    return { ok: false, error: e instanceof StripeError ? e.message : "Couldn't reach Stripe." };
  }
}

// ---------------------------------------------------------------------------
// STRIPE AT A GLANCE (Oct 24 2026, Jordan: "I want to see Stripe balances
// too. The stripe balances should show incoming, balance, MTD Gross and Net
// Rev."). The four numbers Stripe's own home page leads with, read LIVE so
// they match it, not last night's sync:
//   balance   available now (can be paid out)
//   incoming  pending: paid by clients, not yet available
//   inTransit payouts already on their way to the bank
//   MTD gross every charge this ET month; MTD net = gross − refunds and
//             disputes − Stripe's fees on those sales
// Stripe Capital's flex-loan withholding and Stripe's own billing fees are
// shown beside them, never inside revenue: loan repayments aren't a cost of a
// sale. A failed live read falls back to the synced ledger, labelled as such.
// ---------------------------------------------------------------------------
export type StripeSnapshot = {
  asOf: string;
  source: "live" | "synced";
  balance: number | null;
  incoming: number | null;
  inTransit: number | null;
  mtd: { gross: number; refunds: number; fees: number; net: number; charges: number; capitalWithheld: number; billingFees: number; paidOut: number };
  monthLabel: string;
};
// The same rows the books count as revenue (revenueMonthCore, shared with
// bookkeeping's STRIPE_REVENUE_WHERE): an adjustment is a refund only when it
// is a chargeback or dispute, so the panel and Finance can't disagree.
const SALE_TYPES = new Set(STRIPE_SALE_TYPES);
const REVERSAL_TYPES = new Set(STRIPE_REVERSAL_TYPES);

export function summarizeStripeMonth(rows: { type: string; gross: number; fee: number; net: number; description?: string | null }[]): StripeSnapshot["mtd"] {
  const m = { gross: 0, refunds: 0, fees: 0, net: 0, charges: 0, capitalWithheld: 0, billingFees: 0, paidOut: 0 };
  for (const r of rows) {
    if (SALE_TYPES.has(r.type)) { m.gross += r.gross; m.fees += r.fee; m.net += r.net; m.charges++; }
    else if (REVERSAL_TYPES.has(r.type) || isStripeDispute(r.type, r.description)) { m.refunds += -r.gross; m.fees += r.fee; m.net += r.net; }
    else if (r.type === "financing_paydown") m.capitalWithheld += -r.gross;
    else if (r.type === "stripe_fee") m.billingFees += -r.net;
    else if (r.type === "payout") m.paidOut += -r.gross;
  }
  const c = (n: number) => Math.round(n * 100) / 100;
  return { gross: c(m.gross), refunds: c(m.refunds), fees: c(m.fees), net: c(m.net), charges: m.charges, capitalWithheld: c(m.capitalWithheld), billingFees: c(m.billingFees), paidOut: c(m.paidOut) };
}

// The dashboard refreshes every two minutes and Finance pages read it too: one
// live read a minute per server instance is plenty.
let lastLive: { at: number; monthKey: string; s: StripeSnapshot } | null = null;

export async function stripeSnapshot(now: Date = new Date()): Promise<StripeSnapshot | null> {
  const { etDayKey, etDayStartUtc } = await import("@/lib/datetime");
  const monthKey = etDayKey(now).slice(0, 7);
  if (lastLive && lastLive.monthKey === monthKey && Date.now() - lastLive.at < 60_000 && Math.abs(now.getTime() - Date.now()) < 60_000) return lastLive.s;
  const monthStart = etDayStartUtc(new Date(`${monthKey}-01T12:00:00Z`));
  const monthLabel = new Date(`${monthKey}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  try {
    const [bal, transit] = await Promise.all([
      stripeGet<StripeBalance>("/balance"),
      // The status filter isn't honoured under every key: read the latest
      // payouts and keep the ones still on their way.
      stripeGet<{ data: { amount: number; status: string }[] }>("/payouts", { query: { limit: 30 } }).catch(() => null),
    ]);
    const rows: { type: string; gross: number; fee: number; net: number; description: string | null }[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q: Record<string, string | number> = { limit: 100, "created[gte]": Math.floor(monthStart.getTime() / 1000) };
      if (after) q.starting_after = after;
      const res = await stripeGet<{ data: BalanceTxn[]; has_more: boolean }>("/balance_transactions", { query: q });
      for (const t of res.data) rows.push({ type: t.type, gross: dollars(t.amount), fee: dollars(t.fee), net: dollars(t.net), description: t.description ?? null });
      if (!res.has_more || !res.data.length) break;
      after = res.data[res.data.length - 1].id;
    }
    const sum = (r?: { amount: number }[]) => dollars((r ?? []).reduce((s, x) => s + x.amount, 0));
    const s: StripeSnapshot = {
      asOf: now.toISOString(), source: "live",
      balance: sum(bal.available), incoming: sum(bal.pending), inTransit: transit ? sum(transit.data.filter((p) => p.status === "in_transit" || p.status === "pending")) : null,
      mtd: summarizeStripeMonth(rows), monthLabel,
    };
    lastLive = { at: Date.now(), monthKey, s };
    return s;
  } catch {
    // Live read failed (key revoked, Stripe down): the synced ledger, said so.
    try {
      const { prisma } = await import("@/lib/prisma");
      const conn = await getConnection("stripe");
      if (!conn?.secretEncrypted) return null;
      const rows = await prisma.stripeTransaction.findMany({ where: { createdAt: { gte: monthStart } }, select: { type: true, gross: true, fee: true, net: true, description: true } });
      const last = await prisma.stripeTransaction.aggregate({ _max: { createdAt: true } });
      return { asOf: (last._max.createdAt ?? now).toISOString(), source: "synced", balance: null, incoming: null, inTransit: null, mtd: summarizeStripeMonth(rows), monthLabel };
    } catch {
      return null;
    }
  }
}

// Sync balance transactions since the high-water mark (first run: last 120 days),
// upserting StripeTransaction. Fee-accurate: gross/fee/net straight from Stripe.
//
// BACKFILL: pass an explicit `fullDays` to ignore the high-water mark and re-scan
// that whole window. Without this the cursor is a one-way ratchet — once set, the
// floor is always `lastTxnCreated`, so history EARLIER than the first run can never
// be reached. That is exactly how 2025 went missing: the connection was made in
// 2026, the first run reached back 120 days, and every run since has only moved
// forward. Upserts are keyed on Stripe's own txn id, so a re-scan is idempotent.
export async function syncStripe(opts: { fullDays?: number } = {}): Promise<{ imported: number }> {
  const { prisma } = await import("@/lib/prisma");
  try {
    const conn = await getConnection("stripe");
    // Gate on the SECRET being present, not status === CONNECTED — otherwise one
    // transient ERROR would freeze sync forever (a later success never runs to
    // clear the error). A disconnected/keyless account no-ops cleanly.
    if (!conn || conn.status === "DISCONNECTED" || !conn.secretEncrypted) return { imported: 0 };
    let meta: { lastTxnCreated?: number } = {};
    try { meta = conn.metadata ? JSON.parse(conn.metadata) : {}; } catch { /* fresh */ }
    const backfill = typeof opts.fullDays === "number";
    const floor = !backfill && meta.lastTxnCreated
      ? meta.lastTxnCreated - 3 * 86400 // small overlap so nothing straddling the cursor is missed
      : Math.floor(Date.now() / 1000) - (opts.fullDays ?? 120) * 86400;

    let imported = 0;
    let startingAfter: string | undefined;
    let maxCreated = meta.lastTxnCreated ?? 0; // never rewinds — a backfill must not move the cursor back
    // 100 rows/page. The old 40-page cap silently truncated at 4,000 rows, which a
    // multi-year backfill blows straight through; incremental runs still exit on
    // `has_more` after one or two pages.
    const maxPages = backfill ? 400 : 40;
    for (let page = 0; page < maxPages; page++) {
      // No expand[] — data.source expansion can 403 under a narrow restricted
      // key; customerName enrichment isn't worth failing the whole sync over.
      const q: Record<string, string | number | string[]> = { limit: 100, "created[gte]": floor };
      if (startingAfter) q.starting_after = startingAfter;
      const res = await stripeGet<{ data: BalanceTxn[]; has_more: boolean }>("/balance_transactions", { query: q });
      for (const t of res.data) {
        const src = typeof t.source === "object" && t.source ? t.source : null;
        const customerName = src?.billing_details?.name ?? null;
        await prisma.stripeTransaction.upsert({
          where: { id: t.id },
          create: {
            id: t.id, type: t.type, gross: dollars(t.amount), fee: dollars(t.fee), net: dollars(t.net),
            currency: t.currency, createdAt: new Date(t.created * 1000), description: t.description ?? null, customerName,
          },
          update: {
            type: t.type, gross: dollars(t.amount), fee: dollars(t.fee), net: dollars(t.net),
            description: t.description ?? null, customerName, syncedAt: new Date(),
          },
        });
        imported++;
        if (t.created > maxCreated) maxCreated = t.created;
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    // Stamp Connect-transfer DESTINATIONS (who got paid). Balance transactions
    // don't carry them; /v1/transfers does, and its balance_transaction field is
    // exactly our row id. Best-effort — the per-person People/vendor split falls
    // back to a combined line for any row left unstamped, never a guess.
    try {
      const tFloor = Math.floor(Date.now() / 1000) - 60 * 86400;
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const q: Record<string, string | number> = { limit: 100, "created[gte]": tFloor };
        if (after) q.starting_after = after;
        const res = await stripeGet<{ data: { id: string; destination?: string; balance_transaction?: string }[]; has_more: boolean }>("/transfers", { query: q });
        for (const t of res.data) {
          if (t.destination && t.balance_transaction) {
            await prisma.stripeTransaction.updateMany({ where: { id: t.balance_transaction }, data: { destination: t.destination } });
          }
        }
        if (!res.has_more || res.data.length === 0) break;
        after = res.data[res.data.length - 1].id;
      }
    } catch { /* destination stamping must never fail the sync */ }

    // Persist the high-water mark on the connection, then mark synced.
    await prisma.connection.update({
      where: { provider: "stripe" },
      data: { metadata: JSON.stringify({ ...meta, lastTxnCreated: maxCreated }) },
    }).catch(() => {});
    await markSynced("stripe");
    return { imported };
  } catch (e) {
    await markError("stripe", e instanceof Error ? e.message : "Stripe sync failed").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// HOURLY, NOT JUST AT 4 AM (Oct 25 2026 audit). The ledger was pulled once a
// day, so all afternoon Finance → Overview and the books audit read Stripe as
// of 4 AM while the dashboard's Stripe panel read it live: the same month,
// two revenue figures, apart by the day's sales. The hourly cron calls this;
// an incremental pull is one or two pages. A pull in the last half hour (the
// 4 AM daily run, or the Sync button) is enough, and skipping it keeps two
// pulls from upserting the same new rows at once.
// ---------------------------------------------------------------------------
export async function syncStripeIfStale(maxAgeMs = 30 * 60_000, now: Date = new Date()): Promise<{ imported: number } | { skipped: string }> {
  const conn = await getConnection("stripe");
  if (!conn || conn.status === "DISCONNECTED" || !conn.secretEncrypted) return { skipped: "Stripe isn't connected" };
  if (conn.lastSyncedAt && now.getTime() - conn.lastSyncedAt.getTime() < maxAgeMs) {
    return { skipped: `pulled ${Math.round((now.getTime() - conn.lastSyncedAt.getTime()) / 60_000)} min ago` };
  }
  return syncStripe();
}
