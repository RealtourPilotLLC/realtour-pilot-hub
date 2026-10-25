// ---------------------------------------------------------------------------
// DRILL oct25-revenue-month: ALL REVENUE THIS MONTH, GROSS AND NET, AND STRIPE
// ON THE DASHBOARD (Oct 24 2026, Jordan: "Add Stripe to the dashboard too and
// add MTD Revenue for all revenue gross and net").
//   §1 the arithmetic (revenueMonthCore): rails add up, net = gross − refunds
//      − fees, a fee record that didn't load makes net unknown, never $0
//   §2 QuickBooks deposits the books don't have (financeAuditCore): a single
//      payment or a 2–4 payment batch records it; a lone deposit doesn't;
//      verification pennies and payments outside the week don't count
//   §3 the dashboard's Financial Position on a seeded month: three rails,
//      each rail's fees from the ledger, the unrecorded deposit said beside
//      QuickBooks and kept out of gross, profit from the same revenue
//   §4 the panels, server-rendered: Revenue this month and the inset Stripe
// Disposable PGlite; Stripe isn't connected here, so nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5967), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-revenue-month" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/revenueMonthCore");
    const { unrecordedDeposits } = await import("@/lib/financeAuditCore");

    c.head("§1 · gross and net, rail by rail");
    const m = core.revenueMonth("October", {
      quickbooks: { gross: 2998, fees: 234.27 },
      stripe: { gross: 62193.5, refunds: 125, fees: 1815.66 },
      venmo: { gross: 2075, fees: 33.75, through: "statements through Oct 23" },
    });
    c.ok("gross is every rail before refunds and fees", m.gross === 67266.5, String(m.gross));
    c.ok("refunds and fees total across rails", m.refunds === 125 && m.fees === 2083.68, `${m.refunds} / ${m.fees}`);
    c.ok("net = gross − refunds − fees", m.net === 65057.82, String(m.net));
    c.ok("each rail carries its own net", m.rails.map((r) => r.net).join(",") === "2763.73,60252.84,2041.25", m.rails.map((r) => r.net).join(","));
    c.ok("rails in a fixed order with plain names", m.rails.map((r) => r.label).join(" | ") === "QuickBooks Payments | Stripe | Venmo");
    c.ok("a rail's coverage words ride along", m.rails[2].through === "statements through Oct 23" && m.rails[0].through === null);
    const unknown = core.revenueMonth("October", { quickbooks: { gross: 100, fees: null }, stripe: { gross: 200, fees: 6 }, venmo: { gross: 0, fees: 0 } });
    c.ok("a fee record that didn't load makes net unknown, not the gross", unknown.net === null && unknown.fees === null && unknown.rails[0].net === null && unknown.gross === 300);
    c.ok("feeFrom sums one category and says unknown when spend didn't load",
      core.feeFrom([{ category: "QuickBooks Payments fees", sum: 189.45 }, { category: "QuickBooks Payments fees", sum: 44.82 }, { category: "Software & subscriptions", sum: 40 }], core.RAIL_FEE_CATEGORY.quickbooks) === 234.27
      && core.feeFrom(null, core.RAIL_FEE_CATEGORY.venmo) === null && core.feeFrom([], core.RAIL_FEE_CATEGORY.venmo) === 0);

    c.head("§2 · QuickBooks deposits the books don't have");
    const D = (iso: string) => new Date(`${iso}T12:00:00Z`);
    const bank = [
      { amount: -4297, date: D("2026-10-03"), id: "batch" },
      { amount: -1499, date: D("2026-10-06"), id: "single" },
      { amount: -0.25, date: D("2026-10-02"), id: "penny" },
      { amount: -997, date: D("2026-10-20"), id: "lonely" },
      { amount: -800, date: D("2026-10-21"), id: "late-payment" },
    ];
    const qbo = [
      { type: "Payment", txnDate: D("2026-10-01"), amount: 2798 },
      { type: "Payment", txnDate: D("2026-10-01"), amount: 1499 },
      { type: "Payment", txnDate: D("2026-10-05"), amount: 1499 },
      { type: "Payment", txnDate: D("2026-10-30"), amount: 800 },
      { type: "Payment", txnDate: D("2026-10-18"), amount: 500 },
    ];
    const miss = unrecordedDeposits(bank, qbo).map((b) => b.id);
    c.ok("a deposit QuickBooks recorded as two payments is recorded (Intuit batches a day)", !miss.includes("batch"), miss.join(","));
    c.ok("a single matching payment within the week records it", !miss.includes("single"));
    c.ok("Intuit's verification pennies are ignored", !miss.includes("penny"));
    c.ok("a deposit with nothing that adds up is unrecorded", miss.includes("lonely"));
    c.ok("a payment more than a week away doesn't count", miss.includes("late-payment"));
    c.ok("one payment can't stand in for a bigger deposit", unrecordedDeposits([{ amount: -2000, date: D("2026-10-10") }], [{ type: "Payment", txnDate: D("2026-10-09"), amount: 1000 }]).length === 1);
    c.ok("without the batch's second payment the deposit is unrecorded", unrecordedDeposits([bank[0]], [qbo[0]]).length === 1);

    c.head("§3 · the dashboard's Financial Position on a seeded month");
    const { prisma } = await import("@/lib/prisma");
    const { etDayKey } = await import("@/lib/datetime");
    const now = new Date();
    const mk = etDayKey(now).slice(0, 7);
    const day1 = new Date(`${mk}-01T12:00:00Z`);
    const today = new Date(`${etDayKey(now)}T12:00:00Z`);
    await prisma.connection.create({ data: { provider: "quickbooks", status: "CONNECTED", lastSyncedAt: now } });
    await prisma.qboTransaction.createMany({ data: [
      { qboId: "p1", type: "Payment", txnDate: day1, amount: 1499, customerName: "Monthly client" },
      { qboId: "p2", type: "SalesReceipt", txnDate: today, amount: 600, customerName: "Walk-in" },
    ] });
    const item = await prisma.plaidItem.create({ data: { itemId: "isolated-bank", accessTokenEncrypted: "not-a-provider-token", lastSyncedAt: now } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "biz", name: "Isolated checking", mask: "0942", type: "depository", isBusiness: true, currentBalance: 9000 } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "vm", name: "Venmo", mask: "venmo", type: "depository", isBusiness: false } });
    const tx = (id: string, accountId: string, amount: number, date: Date, financeKind: string, financeCategory: string, name = id) =>
      prisma.plaidTransaction.create({ data: { id, accountId, amount, date, name, financeKind, financeCategory, financeLocked: true } });
    await tx("qbp-in-recorded", "biz", -1499, day1, "INCOME", "QuickBooks Payments (revenue)");
    await tx("qbp-in-missing", "biz", -2400, day1, "INCOME", "QuickBooks Payments (revenue)");
    await tx("qbp-fee", "biz", 64.5, day1, "BUSINESS", "QuickBooks Payments fees", "*7828 TRAN FEE INTUIT");
    await tx("venmo-stmt-in-1", "vm", -550, day1, "INCOME", "Venmo revenue (client)");
    await tx("venmo-fee-1", "vm", 9.62, day1, "BUSINESS", "Venmo transfer fees");
    await tx("rent", "biz", 1000, day1, "BUSINESS", "Office & studio rent");
    await prisma.stripeTransaction.createMany({ data: [
      { id: "ch1", type: "charge", gross: 1000, fee: 29.3, net: 970.7, createdAt: day1 },
      { id: "ch2", type: "charge", gross: 500, fee: 14.8, net: 485.2, createdAt: day1 },
      { id: "re1", type: "refund", gross: -100, fee: 0, net: -100, createdAt: day1 },
    ] });

    const od = await import("@/lib/ownerDashboard");
    const f = await od.financialPosition({ now });
    const r = f.revenue!;
    const rail = (k: string) => r.rails.find((x) => x.key === k)!;
    c.ok("the revenue panel loaded", !!r);
    c.ok("QuickBooks gross = what QuickBooks recorded (the unrecorded deposit stays out)", rail("quickbooks").gross === 2099, String(rail("quickbooks").gross));
    c.ok("QuickBooks net takes off its fee from the ledger", rail("quickbooks").net === 2034.5, String(rail("quickbooks").net));
    c.ok("the unrecorded $2,400 is said beside QuickBooks", /\$2,400 landed in the bank .* QuickBooks hasn't recorded, so it isn't counted yet/.test(rail("quickbooks").missing ?? ""), rail("quickbooks").missing ?? "none");
    c.ok("…and in the card's notes, pointing at the task", f.limitations.some((l) => l.startsWith("QuickBooks Payments: $2,400") && l.includes("task list")));
    c.ok("Stripe without a live read: sales before refunds, the refund apart, fees from the ledger", rail("stripe").gross === 1500 && rail("stripe").refunds === 100 && rail("stripe").fees === 44.1 && rail("stripe").net === 1355.9, JSON.stringify(rail("stripe")));
    c.ok("Venmo: client money from the statements, less the instant-transfer fee", rail("venmo").gross === 550 && rail("venmo").net === 540.38, JSON.stringify(rail("venmo")));
    c.ok("all revenue gross and net add the rails", r.gross === 4149 && r.net === 3930.78, `${r.gross} / ${r.net}`);
    const profit = f.figures.find((x) => x.key === "profit")!;
    c.ok("profit uses the same revenue (after refunds) less business spend", profit.sub.startsWith("Revenue $4,049 − business spend") && profit.sub.endsWith("(fees included)"), profit.sub);
    c.ok("Stripe unread: the card says so instead of a $0 balance", f.stripe === null && f.limitations.some((l) => l.startsWith("Stripe's balance and payouts on their way aren't shown")));

    c.head("§4 · the panels");
    const { RevenueMonthPanel } = await import("@/components/finance/RevenueMonthPanel");
    const { StripeCard } = await import("@/components/finance/StripeCard");
    const html = ssr(createElement(RevenueMonthPanel, { r }));
    const t = text(html);
    c.ok("Revenue this month: gross and net headline", t.includes("Revenue this month") && /gross \$4,149/.test(t) && /net \$3,931/.test(t), t.slice(0, 200));
    c.ok("the fee and refund words under net", t.includes("After $118 of processing fees and $100 refunded"));
    c.ok("a row per rail with gross and net", html.includes('data-rail="quickbooks"') && html.includes('data-rail="stripe"') && html.includes('data-rail="venmo"') && /Venmo[^$]*\$550 \$540/.test(t));
    c.ok("the unrecorded deposit shows under QuickBooks in the warning color", /data-rail-missing[^>]*>\$2,400 landed/.test(html.replace(/class="[^"]*"/g, "")) && html.includes("text-warning"));
    c.ok("revenue that didn't load is never $0", text(ssr(createElement(RevenueMonthPanel, { r: null }))).includes("This is not $0"));
    const snap = { asOf: now.toISOString(), source: "live" as const, balance: 120.5, incoming: 13994.93, inTransit: 0, monthLabel: "October", mtd: { gross: 1500, refunds: 100, fees: 44.1, net: 1355.9, charges: 2, capitalWithheld: 300, billingFees: 10, paidOut: 900 } };
    const inset = ssr(createElement(StripeCard, { s: snap, inset: true }));
    c.ok("the inset Stripe panel: balances and month, two tiles a row, no card shadow", text(inset).includes("Incoming $13,994.93") && text(inset).includes("October net revenue $1,355.90") && !inset.includes("lg:grid-cols-4") && !inset.includes("panel-shadow") && inset.includes("<h4"));
    c.ok("the footnote keeps its spaces (\"$10.00 of its own fees\")", text(inset).includes("billed $10.00 of its own fees"));
    const full = ssr(createElement(StripeCard, { s: snap }));
    c.ok("Finance's own Stripe card is unchanged (four across, its own card)", full.includes("lg:grid-cols-4") && full.includes("panel-shadow") && full.includes("<h2"));
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
