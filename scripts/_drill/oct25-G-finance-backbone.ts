// ---------------------------------------------------------------------------
// DRILL oct25-G-finance-backbone (Oct 25 2026 audit, area G: finance and the
// cron backbone).
//   §1 one list of Stripe revenue rows: the live Stripe panel and the books
//      agree on what a sale and a refund are (a plain `adjustment` is
//      neither; a chargeback is a refund; a failed or reversed bank payment
//      takes its sale back)
//   §2 the hourly Stripe pull: skips when Stripe isn't connected or was
//      pulled in the last half hour, pulls when it's older, and after it the
//      books' Stripe figure equals the live panel's to the cent
//   §3 the hourly cron runs it, after the website-signup sweep
//   §4 dead code stays gone
// Disposable PGlite. Stripe is answered by canned responses inside the
// drill; nothing leaves the machine.
// @drill-run: conditions=react-server
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();

// Stripe, canned. The rows are this ET month's; `created` is epoch seconds.
type Txn = { id: string; type: string; amount: number; fee: number; net: number; created: number; description: string | null; currency: string };
let txns: Txn[] = [];
let stripeCalls = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://api.stripe.com/")) return null;
  stripeCalls++;
  const u = new URL(url);
  if (u.pathname === "/v1/balance") return json({ available: [{ amount: 12050, currency: "usd" }], pending: [{ amount: 50000, currency: "usd" }] });
  if (u.pathname === "/v1/payouts") return json({ data: [], has_more: false });
  if (u.pathname === "/v1/transfers") return json({ data: [], has_more: false });
  if (u.pathname === "/v1/balance_transactions") return json({ data: txns, has_more: false });
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5969), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-G-finance-backbone" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { etDayKey } = await import("@/lib/datetime");
    const core = await import("@/lib/revenueMonthCore");
    const stripe = await import("@/lib/integrations/stripe");
    const { revenueByProcessor, STRIPE_REVENUE_WHERE } = await import("@/lib/bookkeeping");

    const now = new Date();
    const todayKey = etDayKey(now);
    const mk = todayKey.slice(0, 7);
    const at = (h: number) => Math.floor(Date.parse(`${mk}-01T${String(h).padStart(2, "0")}:00:00Z`) / 1000);
    const cents = (d: number) => Math.round(d * 100);
    const row = (id: string, type: string, gross: number, fee: number, h: number, description: string | null = null): Txn =>
      ({ id, type, amount: cents(gross), fee: cents(fee), net: cents(gross - fee), created: at(h), description, currency: "usd" });
    txns = [
      row("txn_ch", "charge", 1000, 29.3, 13, "Payment for 12 Oak St"),
      row("txn_pay", "payment", 200, 1.6, 14, "ACH payment"),
      row("txn_re", "refund", -50, 0, 15, "REFUND FOR CHARGE"),
      row("txn_pfr", "payment_failure_refund", -200, 0, 16, "ACH payment failed"),
      row("txn_adj_fee", "adjustment", -30, 0, 17, "Stripe fee credit reversal"),
      row("txn_adj_cb", "adjustment", -75, 15, 18, "Chargeback withdrawal for ch_123"),
      row("txn_cap", "financing_paydown", -60, 0, 19, "Stripe Capital"),
      row("txn_po", "payout", -500, 0, 20, "STRIPE PAYOUT"),
    ];

    c.head("§1 · one list of Stripe revenue rows");
    c.ok("sales are charges and payments", core.STRIPE_SALE_TYPES.join(",") === "charge,payment");
    c.ok("a failed or reversed bank payment takes its sale back", ["payment_failure_refund", "payment_reversal", "refund", "payment_refund"].every((t) => core.STRIPE_REVERSAL_TYPES.includes(t)));
    c.ok("an adjustment is a refund only when it's a chargeback or dispute", core.isStripeDispute("adjustment", "Chargeback withdrawal") && core.isStripeDispute("adjustment", "Dispute lost") && !core.isStripeDispute("adjustment", "Stripe fee credit") && !core.isStripeDispute("refund", "dispute"));
    const typesIn = (STRIPE_REVENUE_WHERE[0] as { type: { in: string[] } }).type.in;
    c.ok("the books read the same list", [...core.STRIPE_SALE_TYPES, ...core.STRIPE_REVERSAL_TYPES].every((t) => typesIn.includes(t)) && typesIn.length === core.STRIPE_SALE_TYPES.length + core.STRIPE_REVERSAL_TYPES.length);
    const m = stripe.summarizeStripeMonth(txns.map((t) => ({ type: t.type, gross: t.amount / 100, fee: t.fee / 100, net: t.net / 100, description: t.description })));
    c.ok("the panel: gross = charge + payment", m.gross === 1200 && m.charges === 2, JSON.stringify(m));
    c.ok("the panel: refunds = refund + failed payment + chargeback, never the fee-credit adjustment", m.refunds === 325, String(m.refunds));
    c.ok("the panel: Capital and payouts kept apart", m.capitalWithheld === 60 && m.paidOut === 500);

    c.head("§2 · the hourly Stripe pull");
    c.ok("not connected: skipped, nothing asked of Stripe", "skipped" in (await stripe.syncStripeIfStale()) && stripeCalls === 0);
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("stripe", "rk_test_isolated_drill_key");
    const first = await stripe.syncStripeIfStale();
    c.ok("connected and never pulled: it pulls", "imported" in first && first.imported === txns.length, JSON.stringify(first));
    c.ok("…the ledger has every row", (await prisma.stripeTransaction.count()) === txns.length);
    const conn = await prisma.connection.findUnique({ where: { provider: "stripe" } });
    c.ok("…and the connection says when", !!conn?.lastSyncedAt && Math.abs(conn.lastSyncedAt.getTime() - Date.now()) < 60_000);
    const callsAfterFirst = stripeCalls;
    const again = await stripe.syncStripeIfStale();
    c.ok("pulled minutes ago: skipped, Stripe not asked", "skipped" in again && /pulled \d+ min ago/.test(again.skipped) && stripeCalls === callsAfterFirst, JSON.stringify(again));
    const later = await stripe.syncStripeIfStale(30 * 60_000, new Date(Date.now() + 31 * 60_000));
    c.ok("half an hour later: it pulls again", "imported" in later && stripeCalls > callsAfterFirst, JSON.stringify(later));

    const rev = await revenueByProcessor(`${mk}-01`, todayKey);
    c.ok("the books: Stripe = sales − refunds − failed payment − chargeback; the fee-credit adjustment is out", Math.round(rev.stripe * 100) === 87500 && Math.round(rev.stripeRefunds * 100) === 32500, `${rev.stripe} / ${rev.stripeRefunds}`);
    const live = await stripe.stripeSnapshot(now);
    c.ok("the live panel read Stripe (canned)", live?.source === "live" && live.balance === 120.5 && live.incoming === 500, JSON.stringify(live?.source));
    c.ok("after the pull, the books and the live panel agree to the cent", !!live && Math.round((live.mtd.gross - live.mtd.refunds) * 100) === Math.round(rev.stripe * 100) && live.mtd.refunds === rev.stripeRefunds, live ? `${live.mtd.gross} − ${live.mtd.refunds} vs ${rev.stripe}` : "no snapshot");

    c.head("§3 · the hourly cron runs it");
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/cron/sync/route.ts"), "utf8");
    const iLedger = route.indexOf('step("stripeLedger"');
    c.ok("the hourly sync has a stripeLedger step calling syncStripeIfStale with its own cap", iLedger > 0 && /step\("stripeLedger"[\s\S]{0,200}syncStripeIfStale\(\)[\s\S]{0,40}maxMs: 30_000/.test(route));
    c.ok("…after the website-signup sweep", iLedger > route.indexOf('step("stripeSignups"'));
    const daily = fs.readFileSync(path.join(process.cwd(), "src/app/api/cron/daily/route.ts"), "utf8");
    c.ok("the 4 AM daily pull is still there (money first)", /step\("stripe"[\s\S]{0,120}syncStripe\(\)/.test(daily));

    c.head("§4 · dead code stays gone");
    c.ok("textTemplateDefaults (the retired Text wording card's copy) is gone", !fs.existsSync(path.join(process.cwd(), "src/lib/textTemplateDefaults.ts")));
    const books = fs.readFileSync(path.join(process.cwd(), "src/lib/bookkeeping.ts"), "utf8");
    c.ok("bookkeeping's unused personal buckets are gone", !books.includes("personalBucket") && !books.includes("PERSONAL_BUCKETS"));
    const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const gone: [string, string][] = [
      ["src/lib/bookkeeping.ts", "payeeGroup"], ["src/lib/integrations/stripe.ts", "stripeBalance"],
      ["src/lib/integrations/plaid.ts", "plaidRedirectUri"], ["src/lib/integrations/quickbooks.ts", "testQuickBooks"],
      ["src/lib/integrations/quickbooks.ts", "profitAndLoss"],
    ];
    c.ok("five functions nothing called are gone", gone.every(([p, n]) => !new RegExp(`\\b${n}\\b`).test(src(p))), gone.filter(([p, n]) => new RegExp(`\\b${n}\\b`).test(src(p))).map(([, n]) => n).join(", "));
    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
