import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etYearStartKey } from "@/lib/datetime";
import { revenueByProcessor, expenseCoverage } from "@/lib/bookkeeping";
import { categoryBreakdown, operatingCutover, OPERATING_MASK } from "@/lib/financeCategories";
import { stripeSnapshot, type StripeSnapshot } from "@/lib/integrations/stripe";
import { groupTotals, unrecordedDeposits, type AuditAction, type AuditCheck, type MoneyGroup } from "@/lib/financeAuditCore";

// ---------------------------------------------------------------------------
// THE YEAR-TO-DATE BOOKS AUDIT (Oct 24 2026). Jordan: "I want my most recent
// YTD Finances audited. Also, make sure to check QuickBooks for payments
// received. Look at all my expenses, categorize what you can prove ... make
// sure it all adds up, flag anything missing, and give me action items in the
// hub to handle that now and in the future."
//
// Every number comes from an engine another Finance tab already shows
// (revenueByProcessor, categoryBreakdown, Stripe), so the audit and the tabs
// can't disagree. What this adds is the CHECKS: does each source tie to the
// next one (Stripe payouts → the bank, QuickBooks Payments deposits →
// QuickBooks, Venmo debits → a statement saying who was paid, card paydowns →
// a card statement), is every source current, and is every dollar sorted.
// Each failed check names the dollars at stake and becomes an action
// (financeAuditTasks opens and closes the matching task on its own).
// Read only. Owner only (it is all money).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const INVEST_WORDS = ["robinhood", "coinbase", "fidelity", "vanguard", "schwab", "acorns", "betterment", "webull", "etrade", "e*trade", "brokerage", "roth", "401k", "treasurydirect"];
const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const nice = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthName = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

export type FinanceAudit = {
  asOf: string;
  startKey: string;
  endKey: string;
  revenue: { total: number; quickbooks: number; stripe: number; venmo: number; notes: string[] };
  groups: MoneyGroup[];
  businessTotal: number;
  profit: number;
  margin: number | null;
  personalTotal: number;
  review: { out: number; outLines: number; incoming: number; incomingLines: number };
  provenPct: number | null;
  checks: AuditCheck[];
  actions: AuditAction[];
  stripe: StripeSnapshot | null;
  qbMonths: { month: string; recorded: number; banked: number; running: number }[];
};

export async function financeAuditYtd(now: Date = new Date()): Promise<FinanceAudit> {
  const startKey = etYearStartKey();
  const endKey = etDayKey(now);
  const from = new Date(`${startKey}T00:00:00Z`);
  const [rev, cats, coverage, stripe, cutover, lockRows, stripeRows] = await Promise.all([
    revenueByProcessor(startKey, endKey),
    categoryBreakdown(startKey, endKey),
    expenseCoverage(startKey, endKey).catch(() => null),
    stripeSnapshot(now).catch(() => null),
    operatingCutover(),
    prisma.plaidTransaction.groupBy({ by: ["financeKind", "financeLocked", "accountId"], where: { date: { gte: from }, pending: false, financeKind: { in: ["BUSINESS", "PERSONAL"] } }, _sum: { amount: true } }),
    prisma.stripeTransaction.groupBy({ by: ["type"], where: { createdAt: { gte: from } }, _sum: { gross: true, fee: true } }),
  ]);
  const checks: AuditCheck[] = [];
  const actions: AuditAction[] = [];

  // ---- what came in, where it went ------------------------------------------------
  const capital = r2(-(stripeRows.find((s) => s.type === "financing_paydown")?._sum.gross ?? 0));
  // Savings and investing: money moved out to a savings, brokerage or retirement account.
  const saved = await prisma.plaidTransaction.findMany({
    where: { date: { gte: from }, pending: false, amount: { gt: 0 }, OR: [{ name: { contains: "savings", mode: "insensitive" } }, ...INVEST_WORDS.map((w) => ({ name: { contains: w, mode: "insensitive" as const } }))] },
    select: { name: true, amount: true },
  });
  const savingsRows = saved.length ? [{ category: "Savings & investment transfers", sum: r2(saved.reduce((s, r) => s + r.amount, 0)), count: saved.length }] : [];
  const groups = groupTotals(cats, capital, savingsRows);
  const businessTotal = r2(cats.businessTotal);
  const personalTotal = r2(cats.personalTotal);
  const profit = r2(rev.total - businessTotal);
  // How much of the spend is proven: on a statement (Venmo, Stripe) or confirmed by hand.
  let provenAmt = 0, allAmt = 0;
  for (const g of lockRows) {
    const amt = Math.max(0, g._sum.amount ?? 0);
    allAmt += amt;
    if (g.financeLocked || g.accountId.startsWith("venmo")) provenAmt += amt;
  }
  const stripeConnect = -(stripeRows.find((s) => s.type === "transfer")?._sum.gross ?? 0);
  provenAmt += stripeConnect; allAmt += stripeConnect;

  // ---- 1. Stripe payouts → the bank ---------------------------------------------
  const [payouts, reversals, bankStripe] = await Promise.all([
    prisma.stripeTransaction.findMany({ where: { type: "payout", createdAt: { gte: from } }, select: { gross: true, createdAt: true } }),
    prisma.stripeTransaction.findMany({ where: { type: { in: ["payout_cancel", "payout_failure"] }, createdAt: { gte: from } }, select: { gross: true } }),
    prisma.plaidTransaction.findMany({ where: { date: { gte: new Date(from.getTime() - 7 * DAY) }, financeCategory: "Stripe payout (revenue)" }, select: { id: true, amount: true, date: true } }),
  ]);
  {
    const used = new Set<string>();
    const reversed = reversals.map((r) => Math.abs(r.gross));
    let matched = 0, matchedAmt = 0;
    const missing: { at: string; amount: number }[] = [];
    for (const p of payouts.filter((x) => x.gross < 0).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const amt = Math.abs(p.gross);
      const b = bankStripe.find((x) => !used.has(x.id) && Math.abs(Math.abs(x.amount) - amt) < 0.01 && x.date.getTime() >= p.createdAt.getTime() - 5 * DAY && x.date.getTime() <= p.createdAt.getTime() + 7 * DAY);
      if (b) { used.add(b.id); matched++; matchedAmt += amt; continue; }
      const ri = reversed.findIndex((x) => Math.abs(x - amt) < 0.01);
      if (ri >= 0) { reversed.splice(ri, 1); continue; } // cancelled or failed: Stripe kept the money
      if (now.getTime() - p.createdAt.getTime() < 5 * DAY) continue; // still landing
      missing.push({ at: day(p.createdAt), amount: amt });
    }
    const miss = r2(missing.reduce((s, m) => s + m.amount, 0));
    checks.push({
      key: "stripe-bank", title: "Stripe payouts reached the bank", status: missing.length ? "gap" : "ok",
      result: missing.length ? `${missing.length} payout${missing.length === 1 ? "" : "s"} (${usd(miss)}) never showed up in a connected bank account.` : `All ${matched} payouts (${usd(matchedAmt)}) match a bank deposit to the cent. Cancelled and failed payouts came back to Stripe.`,
      detail: missing.slice(0, 6).map((m) => `${nice(m.at)}: ${usd(m.amount)}`).join(" · ") || null, amount: miss || null, href: "/sales?tab=overview",
    });
    if (missing.length) actions.push({ key: "stripe-payout-missing", title: `Find ${usd(miss)} of Stripe payouts that never reached the bank`, why: `Stripe sent ${missing.length} payout${missing.length === 1 ? "" : "s"} the bank feed never received (${missing.map((m) => `${nice(m.at)} ${usd(m.amount)}`).join(", ")}).`, how: "In Stripe → Balances → Payouts, open each one and check which bank or card it went to. If it went to an account the hub doesn't see, connect that account on Connections.", when: "now", dueDays: 3, amount: miss, href: "/connections" });
  }

  // ---- 2. QuickBooks Payments: deposited → recorded in QuickBooks -------------------
  const qboRows = await prisma.qboTransaction.findMany({ where: { txnDate: { gte: new Date(from.getTime() - 10 * DAY) }, type: { in: ["Payment", "SalesReceipt", "Deposit"] }, duplicateOf: null }, select: { type: true, txnDate: true, amount: true } });
  const bankQbp = await prisma.plaidTransaction.findMany({ where: { date: { gte: from }, financeCategory: "QuickBooks Payments (revenue)" }, orderBy: { date: "asc" }, select: { amount: true, date: true } });
  const qbMonths: FinanceAudit["qbMonths"] = [];
  {
    let running = 0;
    for (let m = 1; m <= Number(endKey.slice(5, 7)); m++) {
      const mk = `${endKey.slice(0, 4)}-${String(m).padStart(2, "0")}`;
      const recorded = r2(qboRows.filter((r) => r.type !== "Deposit" && day(r.txnDate).startsWith(mk)).reduce((s, r) => s + r.amount, 0));
      const banked = r2(bankQbp.filter((r) => day(r.date).startsWith(mk)).reduce((s, r) => s - r.amount, 0));
      running = r2(running + recorded - banked);
      qbMonths.push({ month: mk, recorded, banked, running });
    }
    const unrecorded = unrecordedDeposits(bankQbp, qboRows);
    const sum = r2(unrecorded.reduce((s, b) => s - b.amount, 0));
    const recordedYtd = r2(qbMonths.reduce((s, m) => s + m.recorded, 0));
    const bankedYtd = r2(qbMonths.reduce((s, m) => s + m.banked, 0));
    checks.push({
      key: "qbp-recorded", title: "QuickBooks payments received are recorded", status: unrecorded.length ? "gap" : "ok",
      result: unrecorded.length
        ? `${usd(sum)} arrived from QuickBooks Payments that QuickBooks has no payment for, so it isn't in revenue yet.`
        : `Every QuickBooks Payments deposit matches a payment recorded in QuickBooks.`,
      detail: `This year QuickBooks recorded ${usd(recordedYtd)} of payments; the bank received ${usd(bankedYtd)} of QuickBooks Payments deposits.${unrecorded.length ? ` Not recorded: ${unrecorded.map((u) => `${nice(day(u.date))} ${usd(-u.amount)}`).join(", ")}.` : ""}`,
      amount: sum || null, href: "/connections",
    });
    if (unrecorded.length) actions.push({ key: "qbp-unrecorded", title: `Record ${usd(sum)} of QuickBooks payments in QuickBooks`, why: `The bank received ${unrecorded.map((u) => `${usd(-u.amount)} on ${nice(day(u.date))}`).join(", ")} from QuickBooks Payments, and QuickBooks has no payment or sales receipt for it, so the hub's revenue is short by that much.`, how: "In QuickBooks → Sales → Invoices, receive payment on the invoices those deposits paid (for a monthly client the deposit is their recurring charge), then the hub picks it up on the next pull.", when: "now", dueDays: 3, amount: sum, href: "https://qbo.intuit.com" });
  }

  // ---- 3. Venmo: every Venmo debit has a statement saying who it paid --------------
  const venmoOwners = [
    { label: "Your Venmo", who: "your", accountId: "venmo-jordan", masks: ["0942", "3002"] },
    { label: "Lauren's Venmo", who: "Lauren's", accountId: "venmo-lauren", masks: ["4284"] },
  ];
  for (const v of venmoOwners) {
    const last = await prisma.plaidTransaction.findFirst({ where: { accountId: v.accountId, NOT: { id: { contains: "-fee-" } } }, orderBy: { date: "desc" }, select: { date: true } });
    const lastKey = last ? day(last.date) : null;
    const after = last ? new Date(last.date.getTime() + 3 * DAY) : from;
    const uncovered = await prisma.plaidTransaction.findMany({ where: { date: { gt: after }, financeCategory: "Venmo (see Venmo rows)", amount: { gt: 0 }, account: { mask: { in: v.masks } } }, select: { amount: true, date: true } });
    const sum = r2(uncovered.reduce((s, r) => s + r.amount, 0));
    const firstKey = uncovered.length ? day(uncovered.reduce((m, r) => (r.date < m ? r.date : m), uncovered[0].date)) : null;
    checks.push({
      key: `venmo-${v.accountId}`, title: `${v.label}: every payment has a statement`, status: uncovered.length ? "gap" : "ok",
      result: uncovered.length
        ? `${usd(sum)} went out to Venmo since ${nice(firstKey!)} (${uncovered.length} payment${uncovered.length === 1 ? "" : "s"}) with no statement to say who it paid, so it isn't counted as business or personal.`
        : `Statements in through ${lastKey ? nice(lastKey) : "—"}; every Venmo debit from the bank is explained.`,
      amount: sum || null, href: "/sales?tab=audit#venmo",
    });
    if (uncovered.length) {
      const months = [...new Set(uncovered.map((r) => day(r.date).slice(0, 7)))].sort().map(monthName);
      actions.push({ key: `venmo-missing-${v.accountId}`, title: `Upload ${v.who} Venmo statement${months.length === 1 ? "" : "s"} for ${months.join(", ")}`, why: `${usd(sum)} left ${v.masks.map((m) => `··${m}`).join("/")} for Venmo since ${nice(firstKey!)}, and without the statement the hub can't tell whether it paid the nanny, a contractor or family.`, how: `On venmo.com (signed in as ${v.who === "your" ? "you" : "Lauren"}) → Statements → pick each month → Download CSV. Then Finance → Audit → Upload Venmo statement.`, when: "now", dueDays: 3, amount: sum, href: "/sales?tab=audit#venmo" });
    }
  }

  // ---- 4. Card statements (cards the bank feed can't read) ---------------------------
  {
    const tiltLast = await prisma.plaidTransaction.findFirst({ where: { accountId: "tilt-9323" }, orderBy: { date: "desc" }, select: { date: true } });
    if (tiltLast) {
      const paid = await prisma.plaidTransaction.findMany({ where: { date: { gt: new Date(tiltLast.date.getTime() + 5 * DAY) }, amount: { gt: 0 }, OR: [{ name: { contains: "tilt", mode: "insensitive" } }, { merchantName: { contains: "tilt", mode: "insensitive" } }] }, select: { amount: true, date: true } });
      const sum = r2(paid.reduce((s, r) => s + r.amount, 0));
      checks.push({ key: "tilt-statements", title: "Tilt card: statements are in", status: paid.length ? "gap" : "ok", result: paid.length ? `You paid ${usd(sum)} toward the Tilt card since its last statement (${nice(day(tiltLast.date))}), so its purchases since then are missing.` : `Statements in through ${nice(day(tiltLast.date))}; no payments to the card since.`, amount: sum || null, href: "/sales?tab=spending" });
      if (paid.length) actions.push({ key: "tilt-statements", title: "Upload the Tilt card statements since July", why: `${usd(sum)} was paid to the Tilt card since ${nice(day(tiltLast.date))}, but the purchases it paid for aren't in the books.`, how: "Download the monthly statements from the Tilt app and send them over (Tilt has no bank-feed connection).", when: "now", dueDays: 5, amount: sum, href: "/sales?tab=spending" });
    }
  }

  // ---- 5. Live bank and card feeds --------------------------------------------------
  {
    const accts = await prisma.plaidAccount.findMany({ where: { NOT: { accountId: { startsWith: "venmo" } }, type: { in: ["depository", "credit"] }, item: { NOT: { itemId: { startsWith: "stmt-" } } } }, select: { mask: true, name: true, accountId: true, item: { select: { lastError: true } } } });
    const stale: string[] = [];
    for (const a of accts) {
      if (a.mask === "3002") continue; // closed Sep 2026 (financeCategories: the operating account moved)
      const newest = await prisma.plaidTransaction.findFirst({ where: { accountId: a.accountId }, orderBy: { date: "desc" }, select: { date: true } });
      const behind = newest ? Math.floor((now.getTime() - newest.date.getTime()) / DAY) : null;
      if (a.item.lastError || behind == null || behind > 10) stale.push(`··${a.mask ?? "?"} ${a.name ?? ""}${behind != null ? ` (newest line ${behind} days old)` : ""}${a.item.lastError ? ` (error: ${a.item.lastError.slice(0, 60)})` : ""}`);
    }
    checks.push({ key: "feeds", title: "Bank and card feeds are current", status: stale.length ? "flag" : "ok", result: stale.length ? `Behind: ${stale.join("; ")}.` : `All ${accts.length - accts.filter((a) => a.mask === "3002").length} connected accounts synced within the last few days (··3002 closed in September; ··0942 is the business account).`, href: "/connections/banks" });
    if (stale.length) actions.push({ key: "feeds-stale", title: "Reconnect the bank or card feed that stopped", why: `No new lines from ${stale.join("; ")}.`, how: "Connections → Banks → Reconnect on the account that stopped.", when: "now", dueDays: 2, href: "/connections/banks" });
  }

  // ---- 6. Everything sorted -----------------------------------------------------------
  const review = { out: r2(cats.reviewTotal), outLines: cats.review.reduce((s, r) => s + r.count, 0), incoming: r2(cats.reviewIncomingTotal), incomingLines: cats.reviewIncoming.reduce((s, r) => s + r.count, 0) };
  checks.push({ key: "review", title: "Every dollar is sorted", status: review.out + review.incoming > 250 ? "flag" : "ok", result: review.out + review.incoming > 0 ? `${usd(review.out)} of spending (${review.outLines} lines) and ${usd(review.incoming)} of deposits (${review.incomingLines}) still need a business or personal call.` : "Nothing is waiting to be sorted.", amount: r2(review.out + review.incoming) || null, href: "/sales?tab=spending" });
  if (review.out + review.incoming > 250) actions.push({ key: "review-backlog", title: `Sort ${usd(review.out + review.incoming)} of unsorted lines`, why: `${review.outLines + review.incomingLines} bank and card lines this year have no business or personal call, so they're in neither total.`, how: "Finance → Categories → To review: tick the lines and press Business, Personal or Not spend. Each call is remembered.", when: "monthly", dueDays: 7, amount: r2(review.out + review.incoming), href: "/sales?tab=spending" });

  // ---- 7. QuickBooks itself (what your CPA works from) ---------------------------------
  if (coverage) {
    const low = coverage.pct != null && coverage.pct < 0.8;
    checks.push({ key: "qbo-entered", title: "QuickBooks has this year's spending entered", status: low ? "flag" : "ok", result: coverage.pct == null ? coverage.note : `QuickBooks has ${usd(coverage.entered)} of the ${usd(coverage.actual)} that really left the accounts this year (${Math.round(coverage.pct * 100)}%).${low ? " The hub's own numbers above don't depend on it, but your CPA's do." : ""}`, amount: low ? r2(coverage.missing) : null, href: "/sales?tab=overview" });
    if (low) actions.push({ key: "qbo-catch-up", title: `Catch QuickBooks up: ${usd(coverage.missing)} of spending isn't entered`, why: `QuickBooks stopped being kept up in August (purchases entered: ${usd(coverage.entered)} of ${usd(coverage.actual)} this year). Tax time runs off QuickBooks.`, how: "In QuickBooks → Banking → For review, accept the bank-feed lines Aug–Oct (the hub's categories can be the guide), or hand your CPA the hub's Categories export.", when: "now", dueDays: 14, amount: r2(coverage.missing), href: "https://qbo.intuit.com" });
  }

  // ---- 8. Revenue rails current --------------------------------------------------------
  // Venmo arrives as a monthly statement, so a gap under ten days is the normal lag.
  const notes = [rev.quickbooksNote, rev.venmoGapDays >= 10 ? rev.venmoNote : ""].filter((x): x is string => !!x);
  if (notes.length) checks.push({ key: "rails", title: "Revenue sources are current", status: "flag", result: notes.join(" "), href: "/connections" });

  // ---- 9. Owner money: personal spending through the business account, taxes, savings ---
  {
    const mixed = await prisma.plaidTransaction.aggregate({ where: { date: { gte: new Date(`${cutover}T00:00:00Z`) }, financeKind: "PERSONAL", amount: { gt: 0 }, account: { mask: OPERATING_MASK } }, _sum: { amount: true }, _count: true });
    const m = r2(mixed._sum.amount ?? 0);
    if (m > 0) {
      checks.push({ key: "commingled", title: "Business and personal money are separate", status: "flag", result: `Since ··0942 became the business account (${nice(cutover)}), ${usd(m)} of personal spending (${mixed._count} lines) has gone through it.`, detail: "The hub sorts every line, so the numbers stay right, but your CPA will want a clean line: a set owner's draw moved to a personal account, and personal spending from there.", amount: m, href: "/sales?tab=personal" });
      actions.push({ key: "separate-accounts", title: "Open a personal checking account and pay yourself a set draw", why: `${usd(m)} of personal spending ran through the business account since ${nice(cutover)}. Mixed accounts are the first thing a CPA or lender flags.`, how: "Open a personal checking account, connect it on Connections → Banks, and move a fixed owner's draw to it on payday. Spend personally from there.", when: "now", dueDays: 30, amount: m, href: "/connections/banks" });
    }
    const taxes = groups.find((g) => g.key === "taxes")?.total ?? 0;
    checks.push({ key: "taxes", title: "Taxes paid this year", status: profit > 0 && taxes < profit * 0.1 ? "flag" : "ok", result: `${usd(taxes)} of tax payments found this year, against ${usd(profit)} of business profit. ${profit > 0 && taxes < profit * 0.1 ? "That's well under what a profit this size usually owes; confirm your quarterly estimates with your CPA." : ""}`.trim(), amount: taxes, href: "/sales?tab=personal" });
    if (profit > 0 && taxes < profit * 0.1) actions.push({ key: "estimated-taxes", title: "Confirm quarterly estimated taxes with your CPA", why: `Only ${usd(taxes)} of tax payments show up this year against ${usd(profit)} of profit. The Q4 estimate is due Jan 15.`, how: "Send your CPA this Audit page (Finance → Audit) and ask what's owed for 2026 and whether Q3 was paid from an account the hub can't see.", when: "now", dueDays: 7, amount: taxes, href: "/sales?tab=audit" });
    const saved = groups.find((g) => g.key === "savings")?.total ?? 0;
    checks.push({ key: "savings", title: "Savings and investments", status: saved >= 100 ? "ok" : "flag", result: saved >= 100 ? `${usd(saved)} moved to savings or investments this year.` : `No real transfers to savings, retirement or investment accounts in any connected account this year${saved > 0 ? ` (${usd(saved)} in total)` : ""}.`, amount: saved, href: "/sales?tab=budget" });
  }

  // ---- monthly, for the future: last month's statements ------------------------------
  const today = Number(endKey.slice(8, 10));
  if (today >= 5) {
    const prev = new Date(`${endKey.slice(0, 7)}-01T12:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1);
    const pk = day(prev).slice(0, 7);
    for (const v of venmoOwners) {
      const has = await prisma.plaidTransaction.count({ where: { accountId: v.accountId, date: { gte: new Date(`${pk}-01T00:00:00Z`), lt: new Date(`${endKey.slice(0, 7)}-01T00:00:00Z`) } } });
      const used = await prisma.plaidTransaction.count({ where: { financeCategory: "Venmo (see Venmo rows)", account: { mask: { in: v.masks } }, date: { gte: new Date(`${pk}-01T00:00:00Z`), lt: new Date(`${endKey.slice(0, 7)}-01T00:00:00Z`) } } });
      if (!has && used && !actions.some((a) => a.key === `venmo-missing-${v.accountId}`)) {
        actions.push({ key: `venmo-month-${v.accountId}-${pk}`, title: `Upload ${v.who} ${monthName(pk)} Venmo statement`, why: `Venmo was used in ${monthName(pk)} and the statement isn't in yet.`, how: "venmo.com → Statements → Download CSV, then Finance → Audit → Upload Venmo statement.", when: "monthly", dueDays: 5, href: "/sales?tab=audit#venmo" });
      }
    }
  }

  return {
    asOf: now.toISOString(), startKey, endKey,
    revenue: { total: r2(rev.total), quickbooks: r2(rev.quickbooks), stripe: r2(rev.stripe), venmo: r2(rev.venmo), notes },
    groups, businessTotal, profit, margin: rev.total > 0 ? profit / rev.total : null, personalTotal,
    review, provenPct: allAmt > 0 ? provenAmt / allAmt : null,
    checks, actions, stripe, qbMonths,
  };
}

