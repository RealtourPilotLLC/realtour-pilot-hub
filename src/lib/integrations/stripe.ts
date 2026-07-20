import "server-only";
import { getSecret, saveSecret, markSynced, markError, getConnection } from "./connections";

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
  const res = await fetch(url, {
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

// Live balance — real money available + about to land. Best-effort (null if the
// key can't read it), so the cash hero degrades gracefully.
export async function stripeBalance(): Promise<{ available: number; pending: number } | null> {
  try {
    const b = await stripeGet<StripeBalance>("/balance");
    const sum = (rows?: { amount: number }[]) => dollars((rows ?? []).reduce((s, r) => s + r.amount, 0));
    return { available: sum(b.available), pending: sum(b.pending) };
  } catch {
    return null;
  }
}

// Sync balance transactions since the high-water mark (first run: last 120 days),
// upserting StripeTransaction. Fee-accurate: gross/fee/net straight from Stripe.
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
    const floor = meta.lastTxnCreated
      ? meta.lastTxnCreated - 3 * 86400 // small overlap so nothing straddling the cursor is missed
      : Math.floor(Date.now() / 1000) - (opts.fullDays ?? 120) * 86400;

    let imported = 0;
    let startingAfter: string | undefined;
    let maxCreated = meta.lastTxnCreated ?? 0;
    for (let page = 0; page < 40; page++) {
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
