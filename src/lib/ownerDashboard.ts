import "server-only";
import { prisma } from "@/lib/prisma";
import { cashBalanceOf, postedBesideCash } from "@/lib/bankBalance";
import { usd0Signed } from "@/lib/money";
import { noDashes } from "@/lib/text";
import { endOfBusinessDaysET, etDate, etDateTime, etDayKey, etMinutesOfDay, etMonthDay, etTime } from "@/lib/datetime";
import { listAssignees, firstName, type Assignee } from "@/lib/assignees";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { openDelegations, resurfaceOf, type DelegatedTaskView } from "@/lib/delegation";
// The boards production health is read from (static, so each one is the
// module its own screen and its own drills use).
import { jobsBoard, phaseOfVideoRow } from "@/lib/jobsBoard";
import { videoDeliveryBoard } from "@/lib/videoDelivery";
import { getReviewQueue } from "@/lib/reviewRoom";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import { opsExceptionsBoard } from "@/lib/opsExceptions";
import { kylePerson, chipPerson, ownerWeek, etWeekStart, ON_TIME_MIN_JOBS } from "@/lib/opsHome";
import { ownerShootIssues } from "@/lib/shootIssues";
import { CLOSE_KEY_PREFIX, closeKeyFor, readClosure, roundsStage, signalClosed, type SignalClosure } from "@/lib/issueSignalsCore";
import { offAt, offWords, timeOffBetween } from "@/lib/timeOff";
// The books: Finance's own engines (static, so the drills' seams reach them).
import { revenueByProcessor } from "@/lib/bookkeeping";
import { categoryBreakdown, railFreshness } from "@/lib/financeCategories";
import { stripeSnapshot, type StripeSnapshot } from "@/lib/integrations/stripe";
import { feeFrom, RAIL_FEE_CATEGORY, revenueMonth, type RevenueMonth } from "@/lib/revenueMonthCore";
import { uncountedDepositParts } from "@/lib/financeAuditCore";
import { getBillingRows } from "@/lib/queries";

// ---------------------------------------------------------------------------
// JORDAN'S DASHBOARD, BUSINESS OVERSIGHT (Oct 23 2026, his spec §4 A–D, I).
// Each section is its own read, so the page streams them one by one and a
// section that cannot read says so in its own card. The rules, in code:
//   · NO FABRICATION. Every figure and row comes from a record the hub
//     already keeps; where a source does not exist the section says what is
//     missing ("not recorded", "not connected"), never 0 and never "all
//     clear". A failed read is `unavailable`, never an empty list.
//   · COUNTS ARE THEIR LISTS. A stage's number is the length of the rows its
//     panel opens; a headline is computed from the same array.
//   · REUSE, DON'T RE-DERIVE. Production reads the Shoots board (jobsBoard),
//     the Video Review Room's board (videoDeliveryBoard) and queue
//     (getReviewQueue), the photo delivery queue (loadQueue) and the
//     exceptions board (opsExceptionsBoard); finance reads the bank feed
//     (PlaidAccount), the processor revenue engine (revenueByProcessor), the
//     categorized ledger (categoryBreakdown), the AR list (getBillingRows)
//     and the fixed-pay terms (payStructure).
//   · OWNER ONLY. Money is read here and rendered only on the owner's home.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const street = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "A job";
const warn = (what: string) => (e: unknown) => {
  console.warn(`owner dashboard: ${what} failed`, (e as Error)?.message);
  return null;
};

export type Tone = "ok" | "warn" | "bad";

/** What a row's Assign button carries (the panel fills in the rest). */
export type AssignSeed = {
  title: string;
  outcome?: string;
  assigneeKey?: string | null;
  dueAt?: string | null;
  sourceTaskId?: string | null;
  sourceHref?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  needsVerification?: boolean;
};

/**
 * A row's button (Oct 27 2026, Jordan: "make sure everything has an action
 * that can resolve it, escalate it, respond, or delegate"). Plain data, so a
 * server section can hand it to the client shell:
 *   ask     one press hands the work to the named person through delegation
 *           (Request update, Remind photographer). Keyed to the record, so a
 *           second press is the same task ("Already with James").
 *   nudge   one press asks whoever has the delegated task for an update
 *           (delegation's requestUpdate: at most hourly).
 *   task    opens the delegated task (decide, reassign, its history).
 *   assign  opens the Assign panel with the row's context filled in.
 *   link    goes to where it is done, scrolled to the part (#anchor).
 *   done    closes the row's own open task (it is his, and it is handled).
 */
export type RowAction =
  | { kind: "ask"; label: string; seed: AssignSeed }
  | { kind: "nudge"; label: string; taskId: string }
  | { kind: "task"; label: string; taskId: string }
  | { kind: "assign"; label: string; seed: AssignSeed }
  | { kind: "link"; label: string; href: string }
  | { kind: "done"; label: string; taskId: string };

// =====================================================================================
// A. FINANCIAL POSITION
// =====================================================================================

export type FigureKey = "cash" | "obligations" | "collections" | "forecast" | "profit";
export type Figure = {
  key: FigureKey;
  label: string;
  /** null = not known (not connected, not recorded, or the read failed): never shown as 0 */
  value: number | null;
  display: string;
  /** the small line under the figure: which accounts, which period, how fresh */
  sub: string;
  tag: "forecast" | "provisional" | null;
  tone: Tone | null;
  href: string;
};
export type FinancialPosition = {
  figures: Figure[];
  /** "Month to date: Oct 1 to Oct 23 · next 14 days: Oct 23 to Nov 6" */
  period: string;
  sources: string;
  freshness: string;
  /** coverage gaps, said once, plainly */
  limitations: string[];
  /** all revenue this month, gross and net, rail by rail (null = revenue didn't load) */
  revenue: RevenueMonth | null;
  /** Stripe's balances and month, live (null = Stripe couldn't be read or isn't connected) */
  stripe: StripeSnapshot | null;
};

/** This month's QuickBooks Payments deposits in the bank that QuickBooks has no payment for (the books audit's rule), each with the part
 *  QuickBooks hasn't counted (uncountedDepositParts). The bank is read from ten days before the month too, so a recorded payment that
 *  went out in a late-September deposit is set aside and never taken off an October one. */
async function unrecordedQbpThisMonth(monthStartKey: string): Promise<{ amount: number; date: Date; uncounted: number }[]> {
  const from = new Date(`${monthStartKey}T00:00:00Z`);
  const lead = new Date(from.getTime() - 10 * DAY);
  const [bank, qbo] = await Promise.all([
    prisma.plaidTransaction.findMany({ where: { date: { gte: lead }, financeCategory: "QuickBooks Payments (revenue)" }, select: { amount: true, date: true } }),
    prisma.qboTransaction.findMany({ where: { txnDate: { gte: new Date(lead.getTime() - 10 * DAY) }, type: { in: ["Payment", "SalesReceipt", "Deposit"] }, duplicateOf: null }, select: { type: true, txnDate: true, amount: true } }),
  ]);
  return uncountedDepositParts(bank, qbo)
    .filter((p) => p.deposit.date >= from)
    .map((p) => ({ amount: -p.deposit.amount, date: p.deposit.date, uncounted: p.uncounted }));
}

/** Paydays in [fromKey, toKey] with the fixed team pay due on each (payStructure's terms). */
async function fixedPayDue(fromKey: string, toKey: string): Promise<{ total: number; lines: { dayKey: string; names: string[]; amount: number }[] } | null> {
  const [{ payPeriodFor, shiftPeriod }, { fixedPayFor, fixedPayment, FIXED_PAY_FROM }] = await Promise.all([import("@/lib/payroll"), import("@/lib/payStructure")]);
  const members = await prisma.teamMember.findMany({ where: { active: true }, select: { name: true, active: true } });
  const onFixed = members.map((m) => ({ m, terms: fixedPayFor(m) })).filter((x) => !!x.terms);
  if (!onFixed.length) return null;
  const here = payPeriodFor(fromKey);
  const lines: { dayKey: string; names: string[]; amount: number }[] = [];
  for (const shift of [-1, 0, 1, 2]) {
    const p = shift === 0 ? here : shiftPeriod(here.startKey, shift);
    if (p.payoutKey < fromKey || p.payoutKey > toKey || p.startKey < FIXED_PAY_FROM) continue;
    const amount = onFixed.reduce((s, x) => s + fixedPayment(x.terms!).total, 0);
    lines.push({ dayKey: p.payoutKey, names: onFixed.map((x) => x.terms!.first), amount: Math.round(amount * 100) / 100 });
  }
  return { total: lines.reduce((s, l) => s + l.amount, 0), lines };
}

/** Recurring business costs the owner recorded (Expense.recurring), on their day of the month inside the window. */
async function recurringExpensesDue(from: Date, to: Date): Promise<{ total: number; count: number } | null> {
  const rows = await prisma.expense.findMany({ where: { recurring: true, personal: false }, select: { spentAt: true, amount: true } });
  if (!rows.length) return null;
  let total = 0, count = 0;
  for (const r of rows) {
    const dom = Number(etDayKey(r.spentAt).slice(8, 10));
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      if (Number(etDayKey(new Date(t)).slice(8, 10)) === dom) { total += r.amount; count++; break; }
    }
  }
  return { total, count };
}

export async function financialPosition(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<FinancialPosition> {
  const now = opts.now ?? new Date();
  const todayKey = etDayKey(now);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const horizon = new Date(now.getTime() + 14 * DAY);
  const horizonKey = etDayKey(horizon);
  const [banks, revenue, spend, ar, pay, recurring, fresh, stripe, qbpMissing] = await Promise.all([
    prisma.plaidAccount.findMany({
      where: { isBusiness: true, type: "depository" },
      select: { name: true, mask: true, type: true, currentBalance: true, availableBalance: true, item: { select: { lastSyncedAt: true, status: true } } },
    }).catch(warn("bank balances")),
    revenueByProcessor(monthStartKey, todayKey).catch(warn("revenue")),
    categoryBreakdown(monthStartKey, todayKey).catch(warn("spend")),
    getBillingRows({ excludeClientIds: opts.excludeClientIds }).catch(warn("unpaid list")),
    fixedPayDue(todayKey, horizonKey).catch((e: unknown) => (warn("fixed pay")(e), "failed" as const)),
    recurringExpensesDue(now, horizon).catch((e: unknown) => (warn("recurring costs")(e), "failed" as const)),
    railFreshness().catch(warn("freshness")),
    stripeSnapshot(now).catch(warn("stripe")),
    unrecordedQbpThisMonth(monthStartKey).catch(warn("QuickBooks deposits")),
  ]);
  const limitations: string[] = [];

  // ---- all revenue this month, gross and net (revenueMonthCore) ------------
  // Stripe from Stripe itself (the same read as the Stripe panel, so the two
  // agree to the cent); QuickBooks Payments and Venmo from the books' engine,
  // each rail's fees from the categorized ledger.
  const monthLabel = new Date(`${monthStartKey.slice(0, 7)}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  // QuickBooks Payments is counted where QuickBooks records it, PLUS the part
  // of an Intuit deposit QuickBooks hasn't recorded yet (Oct 26 2026, Jordan
  // of the Oct 3 deposit: "Include this the amount from this in my
  // QuickBooks revenue"). Only the part that isn't already a recorded payment
  // (uncountedDepositParts), so nothing is counted twice; once QuickBooks
  // records it the deposit matches and drops out of here on its own. The
  // books audit keeps its task to record it in QuickBooks itself.
  const qbpNew = (qbpMissing ?? []).filter((b) => b.uncounted > 0);
  const qbpAdded = Math.round(qbpNew.reduce((s, b) => s + b.uncounted, 0) * 100) / 100;
  const depositWords = (b: { amount: number; date: Date; uncounted: number }) =>
    b.uncounted < b.amount ? `${usd0Signed(b.uncounted)} of the ${usd0Signed(b.amount)} Intuit deposited ${etMonthDay(b.date)}` : `${usd0Signed(b.amount)} Intuit deposited ${etMonthDay(b.date)}`;
  const qbpAddedWords = qbpNew.length
    ? `Includes ${qbpNew.length === 1 ? depositWords(qbpNew[0]) : `${usd0Signed(qbpAdded)} Intuit deposited (${qbpNew.map(depositWords).join("; ")})`} that QuickBooks hasn't recorded yet${qbpNew.some((b) => b.uncounted < b.amount) ? "; the rest is a payment it already has" : ""}`
    : null;
  const month: RevenueMonth | null = revenue
    ? revenueMonth(monthLabel, {
        quickbooks: { gross: revenue.quickbooks + qbpAdded, fees: feeFrom(spend?.business, RAIL_FEE_CATEGORY.quickbooks), included: qbpAddedWords, through: revenue.quickbooksNote && revenue.quickbooksCoverageThrough ? `through ${etMonthDay(new Date(`${revenue.quickbooksCoverageThrough}T12:00:00Z`))}` : null },
        stripe: stripe
          ? { gross: stripe.mtd.gross, refunds: stripe.mtd.refunds, fees: stripe.mtd.fees, through: stripe.source === "live" ? null : `as of ${etDateTime(stripe.asOf)}` }
          : { gross: revenue.stripe + revenue.stripeRefunds, refunds: revenue.stripeRefunds, fees: revenue.stripeFees, through: fresh?.stripe ? `as of ${etDateTime(fresh.stripe)}` : null },
        venmo: { gross: revenue.venmo, fees: feeFrom(spend?.business, RAIL_FEE_CATEGORY.venmo), through: revenue.venmoNote && revenue.venmoCoverageThrough ? `statements through ${etMonthDay(new Date(`${revenue.venmoCoverageThrough}T12:00:00Z`))}` : null },
      })
    : null;

  // ---- cash: the business bank accounts on the live feed -------------------
  // The bank's AVAILABLE balance, as its own app shows it (lib/bankBalance; Oct 25 2026).
  const withBalance = (banks ?? []).filter((b) => cashBalanceOf(b) != null);
  const cashValue = withBalance.length ? Math.round(withBalance.reduce((s, b) => s + (cashBalanceOf(b) ?? 0), 0) * 100) / 100 : null;
  const postedValue = withBalance.some((b) => postedBesideCash(b) != null) ? Math.round(withBalance.reduce((s, b) => s + (b.currentBalance ?? 0), 0) * 100) / 100 : null;
  const bankAsOf = withBalance.reduce<Date | null>((m, b) => (b.item.lastSyncedAt && (!m || b.item.lastSyncedAt > m) ? b.item.lastSyncedAt : m), null);
  const bankNames = withBalance.map((b) => (b.mask ? `··${b.mask}` : b.name ?? "account")).join(" + ");
  const cash: Figure = banks == null
    ? { key: "cash", label: "Cash available", value: null, display: "Couldn't load", sub: "The bank balances didn't load. Refresh to try again.", tag: null, tone: null, href: "/connections/banks" }
    : cashValue == null
      ? { key: "cash", label: "Cash available", value: null, display: "Not connected", sub: "No bank account is tagged Business on Connections", tag: null, tone: null, href: "/connections/banks" }
      : { key: "cash", label: "Cash available", value: cashValue, display: usd0Signed(cashValue), sub: `Bank ${bankNames}${postedValue != null ? ` · ${usd0Signed(postedValue)} posted` : ""}${bankAsOf ? ` · synced ${etDateTime(bankAsOf)}` : ""}`, tag: null, tone: cashValue < 0 ? "bad" : null, href: "/connections/banks" };
  if ((banks ?? []).some((b) => b.item.status === "ERROR")) limitations.push("A bank login needs reconnecting on Connections, so the balance may be stale.");
  limitations.push(stripe
    ? "Cash available is the bank only. Stripe's balance and payouts on their way are on the Stripe panel; a payout counts as cash once it lands in the bank."
    : "Stripe's balance and payouts on their way aren't shown (Stripe isn't connected or didn't answer); a payout counts as cash once it lands in the bank.");

  // ---- obligations: only what is recorded ----------------------------------
  const obligationsFailed = pay === "failed" || recurring === "failed";
  const payRec = pay === "failed" ? null : pay;
  const recRec = recurring === "failed" ? null : recurring;
  const anyObligation = !!payRec || !!recRec;
  const obligationValue = anyObligation ? Math.round(((payRec?.total ?? 0) + (recRec?.total ?? 0)) * 100) / 100 : null;
  const payWords = payRec ? (payRec.lines.length ? payRec.lines.map((l) => (l.dayKey === todayKey ? `fixed pay today (${l.names.join(", ")}; may already be out of the bank)` : `fixed pay ${etMonthDay(new Date(`${l.dayKey}T12:00:00Z`))} (${l.names.join(", ")})`)).join(", ") : "no fixed-pay payday in the window") : null;
  const obligations: Figure = obligationsFailed
    ? { key: "obligations", label: "Due next 14 days", value: null, display: "Couldn't load", sub: "The pay schedule or recurring costs didn't load", tag: null, tone: null, href: "/sales?tab=payroll" }
    : !anyObligation
      ? { key: "obligations", label: "Due next 14 days", value: null, display: "Not recorded", sub: "No bills or payroll schedule are recorded in the hub", tag: null, tone: null, href: "/sales?tab=payroll" }
      : { key: "obligations", label: "Due next 14 days", value: obligationValue, display: usd0Signed(obligationValue ?? 0), sub: ["Recorded only:", payWords, recRec ? plural(recRec.count, "recurring cost") : null].filter(Boolean).join(" "), tag: null, tone: null, href: "/sales?tab=payroll" };
  limitations.push("Obligations count only what the hub records (fixed team pay on paydays, recurring costs you entered). Card payments, editor invoices, software, loans and per-shoot creative pay aren't recorded as bills.");

  // ---- expected collections: unpaid delivered work --------------------------
  let collections: Figure;
  if (!ar) {
    collections = { key: "collections", label: "Expected collections", value: null, display: "Couldn't load", sub: "The unpaid list didn't load", tag: null, tone: null, href: "/sales?tab=unpaid" };
  } else {
    // Never count one payment twice: a row QuickBooks already shows paid is out.
    const owed = ar.rows.filter((r) => !r.possiblyPaidQbo);
    const likelyPaid = ar.rows.length - owed.length;
    const sum = Math.round(owed.reduce((s, r) => s + r.outstanding, 0) * 100) / 100;
    collections = {
      key: "collections", label: "Expected collections", value: sum, display: usd0Signed(sum),
      sub: `Unpaid on ${plural(owed.length, "delivered job")} (Aryeo) · when it lands isn't known${likelyPaid ? ` · ${likelyPaid} more look paid in QuickBooks, left out` : ""}`,
      tag: null, tone: null, href: "/sales?tab=unpaid",
    };
  }

  // ---- forecast: cash + collections − recorded obligations ------------------
  const forecastValue = cash.value != null && collections.value != null && !obligationsFailed ? Math.round((cash.value + collections.value - (obligationValue ?? 0)) * 100) / 100 : null;
  const forecast: Figure = forecastValue == null
    ? { key: "forecast", label: "Forecast cash", value: null, display: "Can't forecast", sub: cash.value == null ? "Needs a bank balance" : collections.value == null ? "Needs the unpaid list" : "Needs the obligations", tag: "forecast", tone: null, href: "/sales" }
    : { key: "forecast", label: "Forecast cash", value: forecastValue, display: usd0Signed(forecastValue), sub: `Cash + collections − recorded obligations by ${etMonthDay(horizon)}${anyObligation ? "" : " (none recorded)"}`, tag: "forecast", tone: forecastValue < 0 ? "bad" : null, href: "/sales" };

  // ---- profit this month: the books' own engine ---------------------------
  // A rail that has never synced is not a $0 month: no Stripe rows and no
  // QuickBooks pull means revenue is unknown; no bank feed means spend is.
  const revenueKnown = !!fresh && (!!fresh.stripe || !!fresh.quickbooksPulledAt);
  const spendKnown = !!fresh && (!!fresh.bank.syncedAt || !!fresh.bank.newest);
  let profit: Figure;
  if (!revenue || !spend || !fresh) {
    profit = { key: "profit", label: "MTD profit", value: null, display: "Couldn't load", sub: !revenue ? "Revenue didn't load" : !spend ? "Spending didn't load" : "The books' freshness didn't load", tag: "provisional", tone: null, href: "/sales" };
  } else if (!revenueKnown || !spendKnown) {
    profit = { key: "profit", label: "MTD profit", value: null, display: "Not connected", sub: !revenueKnown ? "No revenue source (Stripe, QuickBooks) has synced" : "No bank or card feed has synced", tag: "provisional", tone: null, href: "/connections" };
  } else {
    // Revenue after refunds (before fees: every rail's fee is already in
    // business spend), from the same figures as the revenue panel.
    const sales = month ? month.gross - month.refunds : revenue.total;
    const value = Math.round((sales - spend.businessTotal) * 100) / 100;
    profit = {
      key: "profit", label: "MTD profit", value, display: usd0Signed(value),
      sub: `Revenue ${usd0Signed(sales)} − business spend ${usd0Signed(spend.businessTotal)} (fees included)`,
      tag: "provisional", tone: value < 0 ? "bad" : "ok", href: "/sales",
    };
    if (revenue.quickbooksNote) limitations.push(revenue.quickbooksNote);
    if (qbpAddedWords) limitations.push(`QuickBooks Payments: ${qbpAddedWords}. Receive the payment in QuickBooks so the books match too (it's on your task list from the books audit); the figure won't change.`);
    if (revenue.venmoNote) limitations.push(revenue.venmoNote);
    if (spend.reviewTotal > 0) limitations.push(`${usd0Signed(spend.reviewTotal)} of this month's spending isn't classified yet, so profit may read high.`);
  }
  if (fresh?.bank.syncedAt && now.getTime() - fresh.bank.syncedAt.getTime() > 2 * DAY) limitations.push(`The bank feed last synced ${etDateTime(fresh.bank.syncedAt)}; spending since then isn't counted.`);

  const freshness = [
    bankAsOf ? `Bank ${etDateTime(bankAsOf)}` : null,
    fresh?.quickbooksPulledAt ? `QuickBooks ${etDateTime(fresh.quickbooksPulledAt)}` : "QuickBooks never synced",
    stripe?.source === "live" ? "Stripe live" : fresh?.stripe ? `Stripe through ${etDateTime(fresh.stripe)}` : null,
    `read ${etTime(now)} ET`,
  ].filter(Boolean).join(" · ");
  return {
    figures: [cash, obligations, collections, forecast, profit],
    period: `Month to date ${etMonthDay(new Date(`${monthStartKey}T12:00:00Z`))} to ${etMonthDay(now)} · next 14 days to ${etMonthDay(horizon)} (ET)`,
    sources: "Bank feed (Plaid) · revenue at Stripe, QuickBooks Payments and Venmo · spend from the categorized ledger · unpaid from Aryeo",
    freshness,
    // The books' own sentences, in the dashboard's voice (no em dashes).
    limitations: [...new Set(limitations.map((l) => noDashes(l)))],
    revenue: month,
    stripe,
  };
}

// =====================================================================================
// B. PRODUCTION HEALTH + BOTTLENECKS
// =====================================================================================

export type StageKey = "pre" | "capture" | "editing" | "review" | "delivery";
export const STAGES: { key: StageKey; label: string }[] = [
  { key: "pre", label: "Pre-production" },
  { key: "capture", label: "Capture & upload" },
  { key: "editing", label: "Editing" },
  { key: "review", label: "Review" },
  { key: "delivery", label: "Delivery" },
];

export type StageItem = {
  id: string;
  street: string;
  client: string | null;
  /** what it is and where it stands, in a few words */
  what: string;
  dueISO: string | null;
  late: boolean;
  dueSoon: boolean;
  /** why it can't move, or null */
  blocked: string | null;
  waitingSinceISO: string | null;
  /** whose move it is */
  owner: string;
  /** the owner's roster key when they are a person on the roster (who a one-press ask goes to) */
  ownerKey?: string | null;
  /** the office holds it because nobody is named on the job */
  ownerIsOffice?: boolean;
  href: string;
  projectId: string | null;
};
export type Stage = {
  key: StageKey;
  label: string;
  items: StageItem[];
  counts: { total: number; dueSoon: number; overdue: number; blocked: number };
  oldestWaitHours: number | null;
  nextOwner: string | null;
  headline: { n: number; words: string };
  tone: Tone;
  /** the source could not be read: never shown as an empty stage */
  unavailable: string | null;
};

export type Bottleneck = {
  id: string;
  issue: string;
  client: string | null;
  /** the original commitment ("Promised Oct 22, 5 PM") */
  commitment: string | null;
  owner: string;
  /** an existing delegated task on this record: who has it and its state */
  handledBy: { taskId: string; words: string } | null;
  nextStep: string;
  /** "Client updated Oct 23 2:10 PM" | "Client update due" | null when not a client commitment */
  clientUpdate: string | null;
  tone: Tone;
  href: string;
  assign: AssignSeed;
  /** a delegated task's id: Request update targets it */
  taskId: string | null;
  /** The buttons, the right one for the issue (Oct 27 2026: every row read
   *  "Assign"). The first is the primary; at most two. */
  actions: RowAction[];
};

export type ProductionHealth = {
  stages: Stage[];
  bottlenecks: Bottleneck[];
  punctuality: string;
  unavailable: string[];
};

function stageOf(key: StageKey, items: StageItem[], unavailable: string | null, now: Date): Stage {
  const label = STAGES.find((s) => s.key === key)!.label;
  const overdue = items.filter((i) => i.late).length;
  const dueSoon = items.filter((i) => !i.late && i.dueSoon).length;
  const blocked = items.filter((i) => !!i.blocked).length;
  const waits = items.map((i) => (i.waitingSinceISO ? (now.getTime() - Date.parse(i.waitingSinceISO)) / HOUR : null)).filter((h): h is number => h != null && h >= 0);
  // The person whose move is most often next on this stage (by count, then the most overdue).
  const byOwner = new Map<string, number>();
  for (const i of items) byOwner.set(i.owner, (byOwner.get(i.owner) ?? 0) + (i.late ? 100 : 1));
  const nextOwner = [...byOwner.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const headline =
    key === "pre" ? (blocked ? { n: blocked, words: "blocked" } : { n: items.length, words: items.length === 1 ? "shoot coming up" : "shoots coming up" })
      : key === "capture" ? { n: items.length, words: "missing upload" }
        : key === "editing" ? (overdue + dueSoon + blocked ? { n: overdue + dueSoon + blocked, words: "at risk" } : { n: items.length, words: "in editing" })
          : key === "review" ? { n: items.length, words: "awaiting review" }
            : { n: items.length, words: "ready or sending" };
  const tone: Tone = unavailable ? "warn" : overdue || blocked ? "bad" : dueSoon ? "warn" : "ok";
  return {
    key, label, items, unavailable,
    counts: { total: items.length, dueSoon, overdue, blocked },
    oldestWaitHours: waits.length ? Math.round(Math.max(...waits)) : null,
    nextOwner,
    headline,
    tone,
  };
}

export async function productionHealth(opts: { now?: Date; includeTest?: boolean; excludeClientIds?: string[]; roster?: Assignee[]; ownerEmail?: string | null } = {}): Promise<ProductionHealth> {
  const now = opts.now ?? new Date();
  const soonEnd = endOfBusinessDaysET(now, 1);
  const isSoon = (iso: string | null) => !!iso && Date.parse(iso) >= now.getTime() && Date.parse(iso) <= soonEnd.getTime();
  const isLate = (iso: string | null) => !!iso && Date.parse(iso) < now.getTime();
  const roster = opts.roster ?? (await listAssignees());
  const exclude = opts.excludeClientIds ?? (opts.includeTest ? [] : await syntheticClientIds());
  const current = Math.abs(now.getTime() - Date.now()) < 60_000;

  const ownerName = firstName(roster.find((a) => a.kind === "owner")?.name ?? "Jordan");
  const [jobs, video, review, photos, exceptions, visits, kyle, flags, off, cm, scripts] = await Promise.all([
    jobsBoard(now, { includeTest: !!opts.includeTest }).catch(warn("shoots board")),
    videoDeliveryBoard(current ? {} : { now }).catch(warn("video board")),
    getReviewQueue({ includeTest: !!opts.includeTest }).catch(warn("review queue")),
    loadQueue({ now }).catch(warn("photo queue")),
    opsExceptionsBoard({ now, includeTest: !!opts.includeTest }).catch(warn("exceptions")),
    prisma.appointment.findMany({
      where: {
        startAt: { gte: now, lte: soonEnd },
        OR: [{ status: null }, { status: { not: "CANCELED" } }],
        project: { status: { not: "CANCELLED" }, ...(exclude.length ? { clientId: { notIn: exclude } } : {}) },
      },
      orderBy: { startAt: "asc" },
      select: { id: true, startAt: true, assignedToId: true, assignedTo: { select: { name: true } }, project: { select: { id: true, title: true, client: { select: { name: true } } } } },
    }).catch(warn("upcoming shoots")),
    kylePerson(roster).catch(() => null),
    ownerShootIssues(now).catch(warn("shoot issues")),
    timeOffBetween(etDayKey(now), etDayKey(soonEnd)).catch(warn("time off")),
    // The creative manager: late editing recovery and cut review are his (Jordan, Oct 27 2026: "James is the creative manager").
    prisma.teamMember.findFirst({ where: { active: true, creativeManager: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }).catch(() => null),
    // Listing scripts missing or unapproved for a shoot by the end of the next business day (his mockup's third row).
    import("@/lib/ownerWork").then((m) => m.scriptsBottleneck({ now, excludeClientIds: exclude, ownerName })).catch(warn("listing scripts")),
  ]);
  const officeName = kyle?.name ?? "Kyle";
  const officeKey = kyle?.key ?? roster.find((a) => a.key === "kyle")?.key ?? null;
  const keyOfTm = (id: string | null | undefined) => (id ? roster.find((a) => a.teamMemberId === id)?.key ?? null : null);
  const cmName = cm?.name ? firstName(cm.name) : null;
  const cmKey = keyOfTm(cm?.id);
  const excluded = new Set(exclude);
  const unavailable: string[] = [];

  // ---- pre-production: shoots from now to the end of the next business day ----
  // A shoot on someone who is off that day is blocked (audit, Oct 25 2026:
  // Harrison's week off with five shoots still on his calendar read "coming
  // up" in green). The office reassigns or moves it, so it is the office's move.
  const pre: StageItem[] = (visits ?? []).filter((v): v is typeof v & { startAt: Date } => !!v.startAt).map((v) => {
    const away = offAt(off ?? [], v.assignedToId, v.startAt);
    const offAll = !!away && away.fraction >= 1;
    return {
      id: `visit:${v.id}`,
      street: street(v.project?.title),
      client: v.project?.client?.name ?? null,
      what: `Shoot ${etDateTime(v.startAt)}${away && !offAll ? ` · ${offWords(v.assignedTo?.name, away)}` : ""}`,
      dueISO: v.startAt.toISOString(),
      late: false,
      dueSoon: true,
      blocked: !v.assignedToId ? "No photographer assigned" : offAll ? offWords(v.assignedTo?.name, away) : null,
      waitingSinceISO: null,
      owner: offAll ? officeName : v.assignedTo?.name ? firstName(v.assignedTo.name) : officeName,
      ownerKey: offAll || !v.assignedToId ? officeKey : keyOfTm(v.assignedToId),
      href: v.project ? `/projects/${v.project.id}` : "/schedule",
      projectId: v.project?.id ?? null,
    };
  });
  if (!visits) unavailable.push("upcoming shoots");
  if (!off) unavailable.push("time off");

  // ---- capture & upload: the shoot happened, the raws are not in -------------
  const notUploaded = (jobs?.rows ?? []).filter((r) => r.photos?.label === "Not uploaded");
  const shooters = notUploaded.length
    ? await prisma.project.findMany({ where: { id: { in: notUploaded.map((r) => r.projectId) } }, select: { id: true, shootDate: true, photographerId: true, photographer: { select: { name: true } } } }).catch(() => [])
    : [];
  const shooterOf = new Map(shooters.map((s) => [s.id, s]));
  // The owner is the real person (Oct 27 2026): a job with no photographer on
  // it is the office's to sort out, never "The photographer".
  const capture: StageItem[] = notUploaded.map((r) => {
    const s = shooterOf.get(r.projectId);
    return {
      id: `capture:${r.projectId}`,
      street: r.street,
      client: r.client,
      what: "Photos not uploaded",
      dueISO: r.dueISO,
      late: r.late,
      dueSoon: r.dueToday || isSoon(r.dueISO),
      blocked: null,
      waitingSinceISO: s?.shootDate?.toISOString() ?? null,
      owner: s?.photographer?.name ? firstName(s.photographer.name) : officeName,
      ownerKey: s?.photographerId ? keyOfTm(s.photographerId) : officeKey,
      ownerIsOffice: !s?.photographerId,
      href: r.href,
      projectId: r.projectId,
    };
  });
  if (!jobs) unavailable.push("the Shoots board");

  // ---- editing, review, delivery -------------------------------------------
  const editorOf = new Map((jobs?.rows ?? []).map((r) => [r.projectId, chipPerson(r.video?.label)]));
  const unassignedIds = new Set((exceptions && !exceptions.unavailable ? exceptions.rows.filter((r) => r.kind === "unassigned") : []).map((r) => (r.href.match(/\/projects\/([^/?#]+)/) ?? [])[1]).filter(Boolean));
  const editing: StageItem[] = [];
  const reviewItems: StageItem[] = [];
  const delivery: StageItem[] = [];
  const videoRows = video && !video.unavailable ? (["late", "today", "upcoming", "review", "sending", "held", "finishing"] as const).flatMap((l) => video.lanes[l]) : [];
  // THE EDITOR BY NAME (Oct 27 2026: the bottleneck read "Owner: The editor").
  // The Shoots board's chip names whoever holds the video when it can
  // ("Changes · John"); when it can't (not cut yet, an outside shop), the
  // job's open edit card names them, the board's own source (jobsBoard).
  const unnamed = [...new Set(videoRows.map((r) => r.projectId).filter((id) => !editorOf.get(id)))];
  const editCards = unnamed.length
    ? await prisma.smartTask.findMany({ where: { projectId: { in: unnamed }, taskType: "edit_video", assignedKey: { not: null }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { createdAt: "desc" }, select: { projectId: true, assignedKey: true } }).catch(() => [])
    : [];
  const { editorMeta } = await import("@/lib/editors");
  const editorName = (key: string) => {
    const meta = editorMeta(key);
    // An outside shop keeps its whole name ("Luma Visuals"); a person goes by their first.
    return meta ? (meta.kind === "external" ? meta.name : firstName(meta.name)) : firstName(roster.find((a) => a.key === key)?.name ?? key);
  };
  const cardEditor = new Map<string, string>();
  for (const t of editCards) if (t.projectId && t.assignedKey && !cardEditor.has(t.projectId)) cardEditor.set(t.projectId, editorName(t.assignedKey));
  const seenVideo = new Set<string>();
  for (const r of videoRows) {
    if (seenVideo.has(r.key)) continue;
    seenVideo.add(r.key);
    const phase = phaseOfVideoRow(r);
    const base = { street: r.street, client: r.clientName || null, dueISO: r.promiseISO, late: r.late, dueSoon: r.dueToday || isSoon(r.promiseISO), projectId: r.projectId };
    if (phase === "editing" || phase === "changes" || phase === "not_cut") {
      const ed = editorOf.get(r.projectId) ?? cardEditor.get(r.projectId) ?? null;
      const noEditor = unassignedIds.has(r.projectId);
      // Nobody named on it at all: the creative manager answers for late editing (the office when there is none).
      editing.push({ ...base, id: `video:${r.key}`, what: `${r.label}${r.round ? ` v${r.round}` : ""}: ${phase === "changes" ? "changes asked" : phase === "not_cut" ? "not cut yet" : "editing"}`, blocked: noEditor ? "No editor assigned" : null, waitingSinceISO: r.sinceISO, owner: noEditor ? officeName : ed ?? cmName ?? officeName, ownerKey: noEditor ? officeKey : ed ? null : cmKey ?? officeKey, href: `/projects/${r.projectId}` });
    } else if (phase === "review") {
      // the cut itself is listed from the review queue below (it names the reviewer)
    } else if (phase === "ready" || phase === "held" || phase === "finishing") {
      delivery.push({ ...base, id: `video:${r.key}`, what: `${r.label}: ${phase === "held" ? "held" : phase === "finishing" ? "with Topaz" : "approved, ready to send"}`, blocked: phase === "held" ? r.heldWhy ?? "Held" : null, waitingSinceISO: r.waitingSinceISO ?? r.approvedAtISO, owner: phase === "finishing" ? "Topaz" : officeName, ownerKey: officeKey, href: r.reviewHref ?? `/review/${r.projectId}` });
    }
  }
  // Unassigned edit jobs the video board did not list (monthly content and the like).
  for (const row of exceptions && !exceptions.unavailable ? exceptions.rows.filter((r) => r.kind === "unassigned") : []) {
    const pid = (row.href.match(/\/projects\/([^/?#]+)/) ?? [])[1] ?? null;
    if (pid && editing.some((e) => e.projectId === pid)) continue;
    editing.push({ id: `unassigned:${row.id}`, street: row.title, client: null, what: row.why, dueISO: null, late: row.severity === "high", dueSoon: false, blocked: "No editor assigned", waitingSinceISO: new Date(now.getTime() - row.ageDays * DAY).toISOString(), owner: officeName, ownerKey: officeKey, href: row.href, projectId: pid });
  }
  const promiseOf = new Map(videoRows.map((r) => [r.projectId, r]));
  for (const c of review?.pending ?? []) {
    const v = promiseOf.get(c.projectId);
    // A cut nobody holds is the creative manager's to review (the review seat), never "Nobody (the office)".
    const reviewer = c.reviewer?.name ? firstName(c.reviewer.name) : cmName ?? officeName;
    const reviewerKey = c.reviewer ? keyOfTm(c.reviewer.id) ?? roster.find((a) => a.name === reviewer)?.key ?? null : cmKey ?? officeKey;
    reviewItems.push({ id: `cut:${c.id}`, street: c.street, client: c.clientName || null, what: `${c.fileName ?? "Video"} v${c.round} from ${c.editorName ?? "the editor"}`, dueISO: v?.promiseISO ?? null, late: !!v?.late, dueSoon: !!v && (v.dueToday || isSoon(v.promiseISO)), blocked: null, waitingSinceISO: c.createdAt, owner: reviewer, ownerKey: reviewerKey, href: `/review/${c.projectId}?cut=${c.id}`, projectId: c.projectId });
  }
  if (!video || video.unavailable) unavailable.push("the video board");
  if (!review) unavailable.push("the review queue");
  if (!exceptions || exceptions.unavailable) unavailable.push("unassigned edits");

  // Photos, by the queue's own columns.
  for (const col of photos?.columns ?? []) {
    for (const card of col.cards) {
      if (card.clientId && excluded.has(card.clientId)) continue;
      // The office chases AutoHDR and the photo fixes, so a one-press ask about a photo set goes to the office.
      const base = { id: `photos:${card.id}`, street: street(card.street), client: card.clientName, dueISO: card.slaDueAt, late: isLate(card.slaDueAt), dueSoon: isSoon(card.slaDueAt), waitingSinceISO: card.shootDate, href: `/ops/photo-delivery/${card.id}`, projectId: card.projectId, ownerKey: officeKey };
      if (col.key === "editing" || col.key === "fixing") editing.push({ ...base, what: `Photos: ${card.stageLabel}`, blocked: card.lastError ? `Edit problem: ${card.lastError}`.slice(0, 120) : null, owner: col.key === "editing" ? "AutoHDR" : "Photo fixes" });
      else if (col.key === "qc" || col.key === "decision" || col.key === "hold" || col.key === "ready") reviewItems.push({ ...base, what: `Photos: ${card.stageLabel}`, blocked: col.key === "hold" ? card.holdReason ?? "On hold" : null, owner: officeName });
      else if (col.key === "delivering") delivery.push({ ...base, what: "Photos: delivering", blocked: card.lastError ? "Delivery problem" : null, owner: officeName });
    }
  }
  if (!photos) unavailable.push("the photo queue");

  const sortItems = (a: StageItem, b: StageItem) => Number(b.late) - Number(a.late) || Number(!!b.blocked) - Number(!!a.blocked) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999");
  const stages: Stage[] = [
    stageOf("pre", pre.sort(sortItems), visits ? null : "Upcoming shoots couldn't load", now),
    stageOf("capture", capture.sort(sortItems), jobs ? null : "The Shoots board couldn't load", now),
    stageOf("editing", editing.sort(sortItems), (!video || video.unavailable) && !photos ? "The video board and photo queue couldn't load" : null, now),
    stageOf("review", reviewItems.sort(sortItems), !review && !photos ? "The review queue couldn't load" : null, now),
    stageOf("delivery", delivery.sort(sortItems), (!video || video.unavailable) && !photos ? "The video board and photo queue couldn't load" : null, now),
  ];

  // ---- bottlenecks requiring action -----------------------------------------
  const bottlenecks = await bottlenecksFrom({ now, stages, roster, officeName, officeKey, cmKey, ownerEmail: opts.ownerEmail ?? null, flags: flags?.open ?? [], scripts: scripts ?? null });
  if (!flags) unavailable.push("shoot issues");

  return {
    stages,
    bottlenecks,
    punctuality: "Shoot punctuality isn't measured: arrival times aren't recorded as data (the photographer's Arrived text is optional). Delivery timeliness is in the stages above.",
    unavailable,
  };
}

type From = "work" | "flag" | "deleg" | "scripts";

/** Owners that are a tool or a vendor, not a person: the office chases them. */
const NOT_A_PERSON = new Set(["AutoHDR", "Photo fixes", "Topaz"]);

async function bottlenecksFrom(o: { now: Date; stages: Stage[]; roster: Assignee[]; officeName: string; officeKey: string | null; cmKey: string | null; ownerEmail: string | null; flags: { id: string; client: string; street: string | null; text: string; by: string | null; atISO: string; href: string }[]; scripts?: Awaited<ReturnType<typeof import("@/lib/ownerWork").scriptsBottleneck>> }): Promise<Bottleneck[]> {
  const { now, stages, roster } = o;
  const keyOfName = (name: string) => roster.find((a) => a.name.toLowerCase() === name.toLowerCase())?.key ?? null;
  type Cand = Bottleneck & { rank: number; from: From; stage: StageKey | null; item: StageItem | null };
  const cand: Cand[] = [];
  const all = stages.flatMap((s) => s.items.map((i) => ({ s, i })));
  // Late work, blocked work: one row per record.
  for (const { s, i } of all) {
    if (!i.late && !i.blocked) continue;
    const sourceHref = i.href;
    const lateH = i.dueISO ? Math.max(1, Math.round((now.getTime() - Date.parse(i.dueISO)) / HOUR)) : null;
    // A shoot on someone who is off that day has nobody on it either.
    const offDay = s.key === "pre" && !!i.blocked && / is off that day /.test(i.blocked);
    const issue = i.blocked && !i.late
      ? `${i.street}: ${offDay ? `${i.what}, but ${i.blocked}` : i.blocked.toLowerCase()}`
      : `${i.street}: ${i.what.toLowerCase()}${lateH ? `, ${lateH >= 24 ? `${Math.round(lateH / 24)}d` : `${lateH}h`} late` : ""}`;
    const noOwner = /^nobody|^no /i.test(i.owner) || !!i.blocked?.startsWith("No ") || offDay;
    // A tool or a vendor holding it (AutoHDR, Topaz) is the office's to chase: the row names the person.
    const vendor = NOT_A_PERSON.has(i.owner);
    const isPhotos = i.id.startsWith("photos:");
    const late = i.late && !i.blocked;
    cand.push({
      id: `${s.key}:${i.id}`,
      issue,
      client: i.client,
      commitment: i.dueISO ? `${s.key === "pre" ? "Shoot" : "Promised"} ${etDateTime(i.dueISO)}` : null,
      owner: vendor ? o.officeName : i.owner,
      handledBy: null,
      nextStep: i.blocked?.startsWith("No photographer") ? "Assign a photographer" : offDay ? "Reassign the shoot, or move it" : i.blocked?.startsWith("No editor") ? "Assign an editor"
        : !late ? `Clear: ${i.blocked}`
          : s.key === "capture" ? "Upload the photos"
            : s.key === "editing" && isPhotos ? `Chase ${i.owner} for the edit`
              : s.key === "review" && !isPhotos ? "Review the cut"
                : s.key === "review" ? "Finish the check and deliver"
                  : s.key === "delivery" ? (vendor ? `Chase ${i.owner}, then send` : "Send it")
                    : "Recovery plan and new ETA",
      clientUpdate: i.late && i.projectId ? "pending" : null,
      tone: i.late || noOwner ? "bad" : "warn",
      href: i.href,
      assign: {
        title: i.late ? `Recovery plan: ${i.street} (${i.what})` : offDay ? `Reassign the shoot: ${i.street} (${i.blocked})` : `Unblock: ${i.street} (${i.blocked})`,
        outcome: i.late ? "A recovery plan with a new ETA, and the client told" : offDay ? "Another photographer on it, or the shoot moved with the client's OK" : `Cleared: ${i.blocked}`,
        assigneeKey: vendor ? o.officeKey : keyOfName(i.owner),
        sourceHref,
        projectId: i.projectId,
      },
      taskId: null,
      actions: [],
      rank: (noOwner ? 0 : 10) + (i.late ? 0 : 5),
      from: "work",
      stage: s.key,
      item: i,
    });
  }
  // Shoot issues a creative flagged for the owner (his own loop task, one per job).
  for (const f of o.flags) {
    cand.push({
      id: `flag:${f.id}`,
      issue: `${f.street ?? f.client}: ${f.text}`.slice(0, 160),
      client: f.client,
      commitment: `Flagged ${etDateTime(f.atISO)}${f.by ? ` by ${firstName(f.by)}` : ""}`,
      owner: "You",
      handledBy: null,
      nextStep: "Decide, or hand it on",
      clientUpdate: null,
      tone: "warn",
      href: f.href,
      assign: { title: `Shoot issue: ${f.street ?? f.client}`, outcome: "Resolved, and the cause recorded", sourceTaskId: f.id },
      taskId: null,
      actions: [],
      rank: 3,
      from: "flag",
      stage: null,
      item: null,
    });
  }
  // Listing scripts his shoots wait on: his own move, one row however many.
  if (o.scripts) {
    const sc = o.scripts;
    cand.push({
      id: "scripts:listing",
      issue: sc.issue,
      client: null,
      commitment: sc.firstShootISO ? `Shoot ${etDateTime(sc.firstShootISO)}` : null,
      owner: sc.owner,
      handledBy: null,
      nextStep: sc.nextStep,
      clientUpdate: null,
      tone: sc.tone,
      href: sc.href,
      assign: { title: sc.projectId ? `Listing script: ${sc.issue.split(":")[0]}` : "Listing scripts for the next shoots", outcome: "An approved script before each shoot", projectId: sc.projectId },
      taskId: null,
      actions: [],
      rank: 6, // after work nobody holds, before late work someone holds
      from: "scripts",
      stage: null,
      item: null,
    });
  }
  // Escalations and recommendations that wait on the owner.
  const delegations = await openDelegations().catch(() => [] as DelegatedTaskView[]);
  for (const d of delegations) {
    const r = resurfaceOf(d, now);
    if (!r || (r.kind !== "escalated" && r.kind !== "recommended")) continue;
    cand.push({
      id: `deleg:${d.taskId}`,
      issue: `${d.title}`,
      client: null,
      commitment: d.dueAt ? `Due ${etDateTime(d.dueAt)}` : null,
      owner: d.assigneeName ?? "Nobody",
      handledBy: { taskId: d.taskId, words: r.words },
      nextStep: r.kind === "recommended" ? "Decide who takes it" : "Your decision",
      clientUpdate: null,
      tone: "bad",
      href: d.sourceHref ?? "/",
      assign: { title: d.title, sourceTaskId: d.taskId, assigneeKey: null },
      taskId: d.taskId,
      actions: [],
      rank: -1,
      from: "deleg",
      stage: null,
      item: null,
    });
  }
  // Who already handles each record: its canonical delegated task (dedupeKey "deleg:<href>").
  const keys = [...new Set(cand.filter((c) => c.assign.sourceHref).map((c) => `deleg:${c.assign.sourceHref}`.slice(0, 190)))];
  const tasks = keys.length
    ? await prisma.smartTask.findMany({ where: { dedupeKey: { in: keys }, status: { notIn: ["COMPLETED", "CANCELLED"] }, delegatedAt: { not: null } }, select: { id: true, dedupeKey: true } }).catch(() => [])
    : [];
  const views = tasks.length ? await import("@/lib/delegation").then((m) => m.delegationFor(tasks.map((t) => t.id))) : new Map();
  const byKey = new Map(tasks.map((t) => [t.dedupeKey, views.get(t.id)]));
  // The last word to each client since its promise passed (client update due or given).
  const lateProjects = [...new Set(cand.filter((c) => c.clientUpdate === "pending" && c.assign.projectId).map((c) => c.assign.projectId!))];
  const projects = lateProjects.length ? await prisma.project.findMany({ where: { id: { in: lateProjects } }, select: { id: true, clientId: true } }).catch(() => []) : [];
  const clientOf = new Map(projects.map((p) => [p.id, p.clientId]));
  const outs = projects.length
    ? await prisma.commLog.findMany({ where: { clientId: { in: [...new Set(projects.map((p) => p.clientId))] }, direction: "out", occurredAt: { gte: new Date(now.getTime() - 14 * DAY) } }, select: { clientId: true, occurredAt: true }, orderBy: { occurredAt: "desc" } }).catch(() => [])
    : [];
  for (const c of cand) {
    const v = c.assign.sourceHref ? byKey.get(`deleg:${c.assign.sourceHref}`.slice(0, 190)) : undefined;
    if (v) {
      c.handledBy = { taskId: v.taskId, words: `${v.assigneeName ?? "Someone"} has it · ${v.state === "ASSIGNED" ? "not accepted yet" : v.state.toLowerCase().replace(/_/g, " ")}` };
      c.taskId = v.taskId;
      c.owner = v.assigneeName ?? c.owner;
      c.rank += v.state === "ASSIGNED" ? 2 : 20; // a credible plan sinks
      if (v.state !== "ASSIGNED") c.tone = c.tone === "bad" && c.rank >= 20 ? "warn" : c.tone;
    }
    if (c.clientUpdate === "pending") {
      const pid = c.assign.projectId!;
      const cid = clientOf.get(pid);
      const last = cid ? outs.find((x) => x.clientId === cid) : undefined;
      const dueISO = all.find((x) => `${x.s.key}:${x.i.id}` === c.id)?.i.dueISO ?? null;
      c.clientUpdate = last && dueISO && last.occurredAt.getTime() >= Date.parse(dueISO) ? `Client updated ${etDateTime(last.occurredAt)}` : "Client update due";
    }
    c.actions = bottleneckActions(c, { officeKey: o.officeKey, cmKey: o.cmKey, ownerKey: roster.find((a) => a.kind === "owner")?.key ?? null, now });
  }
  return cand
    .sort((a, b) => a.rank - b.rank || Number(b.tone === "bad") - Number(a.tone === "bad"))
    .map(({ rank, from, stage, item, ...b }) => (void rank, void from, void stage, void item, b));
}

/**
 * THE RIGHT BUTTON FOR THE ISSUE (Oct 27 2026; every bottleneck read
 * "Assign"). Whoever answers for the work is asked through the one
 * delegation path (lib/delegation), keyed to the record, so the next read
 * shows "<name> has it" and a second press is the same task:
 *   · a late edit: Request update asks the creative manager for a recovery
 *     plan (late editing recovery is his, with the editors), and Reassign
 *     goes to the job's Team section, where the editor is changed;
 *   · photos not uploaded: Remind photographer hands the upload to them;
 *   · a cut late for review: Request update asks the reviewer;
 *   · late photos, late or held sending: Request update asks the office;
 *   · no photographer, someone off that day: Assign or Reassign, to the office
 *     (Aryeo holds the booking);
 *   · no editor: Assign editor on the job's Team section;
 *   · already given to someone: Request update to them, Reassign in its panel;
 *   · a creative's shoot flag: Decide on the job; an escalation: Decide.
 * Nothing goes to anyone without a press.
 */
function bottleneckActions(c: Bottleneck & { from: From; stage: StageKey | null; item: StageItem | null }, k: { officeKey: string | null; cmKey: string | null; ownerKey: string | null; now: Date }): RowAction[] {
  if (c.from === "deleg") return [{ kind: "task", label: "Decide", taskId: c.taskId! }];
  if (c.from === "scripts") return [{ kind: "link", label: "Review scripts", href: c.href }];
  if (c.from === "flag") return [{ kind: "link", label: "Decide", href: c.href }, { kind: "assign", label: "Delegate", seed: c.assign }];
  if (c.handledBy && c.taskId) return [{ kind: "nudge", label: "Request update", taskId: c.taskId }, { kind: "task", label: "Reassign", taskId: c.taskId }];
  const i = c.item!;
  const team = i.projectId ? `/projects/${i.projectId}#team` : i.href;
  // By the end of today (5 PM ET), or the next business day once it's past 5.
  const due = endOfBusinessDaysET(k.now, etMinutesOfDay(k.now) < 17 * 60 ? 0 : 1).toISOString();
  const ask = (label: string, to: string | null | undefined, title: string, outcome: string): RowAction =>
    to && to !== k.ownerKey
      ? { kind: "ask", label, seed: { ...c.assign, title, outcome, assigneeKey: to, dueAt: due } }
      : { kind: "assign", label: "Assign", seed: { ...c.assign, title, outcome } };
  const open = (label: string): RowAction => ({ kind: "link", label, href: i.href });
  const what = `${i.street} (${i.what})`;
  switch (c.stage) {
    case "pre":
      if (/ is off that day /.test(i.blocked ?? "")) return [{ kind: "assign", label: "Reassign", seed: { ...c.assign, assigneeKey: k.officeKey } }];
      return [{ kind: "assign", label: "Assign", seed: { ...c.assign, title: i.blocked?.startsWith("No photographer") ? `Book a photographer: ${what}` : c.assign.title, assigneeKey: k.officeKey } }];
    case "capture":
      // No photographer on the job: the office finds out who has the photos.
      return [ask(i.ownerIsOffice ? "Request update" : "Remind photographer", i.ownerKey, `Upload the photos: ${i.street}`, "The photos are uploaded, so editing can start")];
    case "editing":
      if (i.blocked?.startsWith("No editor")) return [{ kind: "link", label: "Assign editor", href: team }, { kind: "assign", label: "Delegate", seed: { ...c.assign, assigneeKey: k.officeKey } }];
      if (i.id.startsWith("photos:")) return [ask("Request update", k.officeKey, `Chase the photo edit: ${what}`, "The photos back from editing, with a new ETA if they're late"), open("Open")];
      return [ask("Request update", k.cmKey ?? k.officeKey, `Recovery plan: ${what}`, `A new ETA from ${c.owner}, and the client told`), { kind: "link", label: "Reassign", href: team }];
    case "review":
      if (i.id.startsWith("photos:")) return [ask("Request update", k.officeKey, `Finish the photo check: ${what}`, "Checked and delivered, or the hold cleared"), open("Open")];
      return [ask("Request update", i.ownerKey ?? k.cmKey, `Review the cut: ${what}`, "Reviewed: approved or sent back with notes"), open("Open review")];
    case "delivery":
      return [ask("Request update", k.officeKey, `Send: ${what}`, "Delivered to the client, or the hold cleared and a new date given"), open("Open")];
    default:
      return [{ kind: "assign", label: "Assign", seed: c.assign }];
  }
}

// =====================================================================================
// C. CLIENT ISSUES
// =====================================================================================

export type ClientIssueRow = {
  id: string;
  kind: "complaint" | "feedback" | "revisions" | "cancellation" | "refund" | "pattern";
  client: string | null;
  clientId: string | null;
  project: string | null;
  projectId: string | null;
  title: string;
  summary: string;
  /** where it came from, in words */
  evidence: string;
  severity: "high" | "medium" | "low";
  severityWhy: string;
  /** an AI classifier's read, not a fact: shown as a suggested flag for review */
  suggested: boolean;
  owner: string | null;
  lastClientUpdateISO: string | null;
  nextAction: string;
  deadlineISO: string | null;
  decision: string | null;
  href: string;
  conversationHref: string | null;
  assign: AssignSeed;
  /** a signal's reason for being on the card, in words (lib/issueSignalsCore) */
  whyHere?: string | null;
  /** how the panel closes a signal; null for complaints and feedback (their own records) */
  close?: SignalClose | null;
  /** The open task somebody was given from this row (Assign): the card shows who has it instead of Assign (Oct 26 2026). */
  handledBy?: { taskId: string; words: string } | null;
  /** The records behind a pattern, listed in the panel with a link to each job (Oct 26 2026: the shoot-issues row opened the Shoots list). */
  records?: { id: string; label: string; text: string; atISO: string; href: string }[] | null;
};
/** Revisions close with the client's answer and the cause; the rest with one line. */
export type SignalClose =
  | { kind: "rounds"; rounds: number; clientFirst: string; settlesAtISO: string | null; reopenedFrom: string | null }
  | { kind: "done"; prompt: string };
export type ClientIssues = { rows: ClientIssueRow[]; unavailable: string[] };

/** The Assign link a repeated-revisions row carries: its delegated task is keyed to it. */
export const roundsHref = (projectId: string) => `/projects/${projectId}#revisions`;
/** Revision work that, while open, means the round is still being fixed. */
const FIX_TASKS = ["revision", "creative_review"];

export async function clientIssuesSection(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<ClientIssues> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - 30 * DAY);
  const exclude = new Set(opts.excludeClientIds ?? []);
  const unavailable: string[] = [];
  const { listClientIssues } = await import("@/lib/clientIssues");
  const [issues, feedback, revisions, cancels, refunds, flags] = await Promise.all([
    listClientIssues({ states: ["OPEN", "CORRECTED", "UNRESOLVED"], scrubMoney: false, take: 60 }).catch(warn("client issues")),
    prisma.feedback.findMany({
      where: { createdAt: { gte: since }, resolved: false, dismissedAt: null, OR: [{ sentiment: "NEGATIVE" }, { sentimentAuto: "NEGATIVE" }] },
      select: { id: true, body: true, sentiment: true, sentimentAuto: true, sentimentBy: true, source: true, createdAt: true, projectId: true, project: { select: { title: true, clientId: true, client: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }).catch(warn("feedback")),
    prisma.revisionBrief.findMany({
      where: { createdAt: { gte: since }, OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }] },
      select: { projectId: true, createdAt: true },
    }).catch(warn("revisions")),
    prisma.activity.findMany({ where: { createdAt: { gte: since }, body: { startsWith: "Order canceled in Aryeo AFTER delivery" } }, select: { id: true, projectId: true, createdAt: true, body: true, project: { select: { title: true, clientId: true, client: { select: { name: true } } } } }, take: 20 }).catch(warn("cancellations")),
    prisma.stripeTransaction.findMany({ where: { createdAt: { gte: since }, type: { in: ["refund", "payment_refund"] } }, select: { id: true, gross: true, createdAt: true, customerName: true, projectId: true, description: true }, orderBy: { createdAt: "desc" }, take: 20 }).catch(warn("refunds")),
    ownerShootIssues(now).catch(warn("shoot issues")),
  ]);
  if (!issues) unavailable.push("complaints");
  if (!feedback) unavailable.push("feedback");
  if (!revisions) unavailable.push("revisions");
  // Closures people recorded on signals (Close it, in the panel).
  const closureRows = await prisma.appSetting.findMany({ where: { key: { startsWith: CLOSE_KEY_PREFIX } }, select: { key: true, value: true } }).catch(() => []);
  const closures = new Map<string, SignalClosure>();
  for (const c of closureRows) { const v = readClosure(c.value); if (v) closures.set(c.key, v); }
  const closureOf = (rowId: string) => closures.get(closeKeyFor(rowId)) ?? null;
  const reopenedWords = (c: SignalClosure | null) => (c ? `${c.by ?? "Someone"} closed it ${etDate(c.at)}${c.outcome === "HAPPY" ? " (client happy)" : ""}` : null);
  const rows: ClientIssueRow[] = [];
  const linkedFeedback = new Set<string>();
  const coveredProjects = new Set<string>();

  // Last word FROM us to each client (the last client update).
  const clientIds = [...new Set([...(issues ?? []).map((i) => i.clientId), ...(feedback ?? []).map((f) => f.project.clientId)].filter(Boolean))];
  const lastOut = clientIds.length
    ? await prisma.commLog.groupBy({ by: ["clientId"], where: { clientId: { in: clientIds }, direction: "out" }, _max: { occurredAt: true } }).catch(() => [])
    : [];
  const lastOutOf = new Map(lastOut.map((r) => [r.clientId, r._max.occurredAt]));
  const issueFeedback = await prisma.clientIssue.findMany({ where: { feedbackId: { not: null } }, select: { feedbackId: true } }).catch(() => []);
  for (const f of issueFeedback) if (f.feedbackId) linkedFeedback.add(f.feedbackId);

  for (const i of issues ?? []) {
    if (exclude.has(i.clientId)) continue;
    const pastDue = !!i.dueAtISO && Date.parse(i.dueAtISO) < now.getTime();
    const severity: ClientIssueRow["severity"] = i.state === "UNRESOLVED" || pastDue ? "high" : i.state === "OPEN" ? "medium" : "low";
    const severityWhy = i.state === "UNRESOLVED" ? "Still unhappy after the fix" : pastDue ? "Past its correction date" : i.state === "OPEN" ? "Open complaint" : "Fixed; check-in pending";
    for (const p of i.projectIds) coveredProjects.add(p);
    rows.push({
      id: `issue:${i.id}`, kind: "complaint", client: i.clientName, clientId: i.clientId, project: null, projectId: i.projectIds[0] ?? null,
      title: i.title, summary: i.whatHappened, evidence: `Recorded from ${i.source === "staff" ? "the team" : `a ${i.source}`} ${etDate(i.createdAtISO)}`,
      severity, severityWhy, suggested: false, owner: i.ownerName,
      lastClientUpdateISO: lastOutOf.get(i.clientId)?.toISOString() ?? null,
      nextAction: i.state === "OPEN" ? "Correct it" : i.state === "CORRECTED" ? "Confirm the client is satisfied" : "Decide the recovery",
      deadlineISO: i.dueAtISO,
      decision: i.state === "UNRESOLVED" ? "Recovery decision needed from you" : null,
      href: `/clients/${i.clientId}#issues`,
      conversationHref: `/communications?client=${i.clientId}`,
      assign: { title: `Recovery: ${i.title}`, outcome: "The client confirms they're satisfied", sourceTaskId: i.state === "CORRECTED" ? i.checkInTaskId : null, sourceHref: `/clients/${i.clientId}#issue-${i.id}`, clientId: i.clientId, projectId: i.projectIds[0] ?? null, assigneeKey: i.ownerKey },
    });
  }
  for (const f of feedback ?? []) {
    if (linkedFeedback.has(f.id) || exclude.has(f.project.clientId)) continue;
    const suggested = f.sentiment !== "NEGATIVE" || (!!f.sentimentAuto && !f.sentimentBy);
    rows.push({
      id: `feedback:${f.id}`, kind: "feedback", client: f.project.client?.name ?? null, clientId: f.project.clientId, project: street(f.project.title), projectId: f.projectId,
      title: suggested ? "Possible dissatisfaction" : "Negative feedback", summary: f.body.slice(0, 220),
      evidence: `${f.source === "form" ? "Feedback form" : `A ${f.source}`} ${etDate(f.createdAt)}${suggested ? " · read as negative by the classifier" : ""}`,
      severity: suggested ? "low" : "medium", severityWhy: suggested ? "Suggested flag: review the message" : "The client rated it badly",
      suggested, owner: null, lastClientUpdateISO: lastOutOf.get(f.project.clientId)?.toISOString() ?? null,
      nextAction: suggested ? "Review the message" : "Reply and decide the recovery", deadlineISO: null, decision: null,
      href: `/projects/${f.projectId}`, conversationHref: `/communications?client=${f.project.clientId}`,
      assign: { title: `Follow up on feedback: ${street(f.project.title)}`, outcome: "The client heard back and the cause is recorded", sourceHref: `/projects/${f.projectId}#feedback-${f.id}`, clientId: f.project.clientId, projectId: f.projectId },
    });
  }
  // A round is a client ask on its own ET day: the same ask by text and by
  // email the same day is one round, not two.
  const rounds = new Map<string, { days: Set<string>; latest: Date }>();
  for (const r of revisions ?? []) {
    const cur = rounds.get(r.projectId) ?? { days: new Set<string>(), latest: r.createdAt };
    cur.days.add(etDayKey(r.createdAt));
    if (r.createdAt > cur.latest) cur.latest = r.createdAt;
    rounds.set(r.projectId, cur);
  }
  const repeat = [...rounds.entries()].map(([projectId, v]) => ({ projectId, days: [...v.days].sort(), latest: v.latest })).filter((r) => r.days.length >= 2 && !coveredProjects.has(r.projectId));
  if (repeat.length) {
    // Where each job's rounds stand (lib/issueSignalsCore.roundsStage): still
    // being fixed, waiting on the client's word, or settled and closed.
    const ids = repeat.map((r) => r.projectId);
    const delegKeys = ids.map((id) => `deleg:${roundsHref(id)}`);
    const [ps, openFix, doneFix, sent, deleg, roster] = await Promise.all([
      prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, clientId: true, client: { select: { name: true } } } }).catch(() => []),
      prisma.smartTask.findMany({ where: { projectId: { in: ids }, taskType: { in: FIX_TASKS }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { createdAt: "asc" }, select: { projectId: true, title: true, assignedKey: true } }).catch(() => []),
      // A creative review closing is paperwork, not a fix reaching the client.
      prisma.smartTask.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, taskType: "revision", status: "COMPLETED" }, _max: { completedAt: true } }).catch(() => []),
      prisma.reviewSubmission.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, sentToClientAt: { not: null } }, _max: { sentToClientAt: true } }).catch(() => []),
      prisma.smartTask.findMany({ where: { dedupeKey: { in: delegKeys } }, select: { dedupeKey: true, status: true, assignedKey: true, completedAt: true } }).catch(() => []),
      listAssignees().catch(() => [] as Assignee[]),
    ]);
    const nameOf = (key: string | null | undefined) => (key ? firstName(roster.find((a) => a.key === key)?.name ?? key) : null);
    const later = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? (a > b ? a : b) : (a ?? b ?? null));
    for (const r of repeat) {
      const p = ps.find((x) => x.id === r.projectId);
      if (!p || exclude.has(p.clientId)) continue;
      const id = `revisions:${r.projectId}`;
      const n = r.days.length;
      const clientFirst = p.client?.name ? firstName(p.client.name) : "the client";
      const closure = closureOf(id);
      const d = deleg.find((t) => t.dedupeKey === `deleg:${roundsHref(r.projectId)}`);
      const st = roundsStage({
        rounds: n, latestRoundAt: r.latest, clientFirst, now, closure,
        openWork: openFix.filter((t) => t.projectId === r.projectId).map((t) => ({ title: t.title.split(" — ")[0].trim() || t.title, who: nameOf(t.assignedKey) })),
        lastFixAt: later(doneFix.find((x) => x.projectId === r.projectId)?._max.completedAt, sent.find((x) => x.projectId === r.projectId)?._max.sentToClientAt),
        delegated: d ? { open: !["COMPLETED", "CANCELLED"].includes(d.status), who: nameOf(d.assignedKey), completedAt: d.status === "COMPLETED" ? d.completedAt : null } : null,
      });
      if (!st.show) continue;
      const dayList = r.days.map((k) => etMonthDay(new Date(`${k}T12:00:00Z`))).join(", ");
      rows.push({
        id, kind: "revisions", client: p.client?.name ?? null, clientId: p.clientId, project: street(p.title), projectId: p.id,
        title: `${n} revision rounds${st.reopened ? " · new ask after it was closed" : ""}`,
        summary: `The client asked for changes on ${n} different days in 30 days (${dayList}), the latest ${etDateTime(r.latest)}.`,
        evidence: "Revision requests on the job", severity: st.reopened || n >= 3 ? "high" : "medium",
        severityWhy: st.reopened ? "A new ask after it was closed" : "Repeated revisions",
        suggested: false, owner: st.owner, lastClientUpdateISO: null, nextAction: st.nextAction, deadlineISO: null, decision: null,
        href: `/projects/${p.id}`, conversationHref: `/communications?client=${p.clientId}`,
        whyHere: st.whyHere,
        close: { kind: "rounds", rounds: n, clientFirst, settlesAtISO: st.settlesAt?.toISOString() ?? null, reopenedFrom: st.reopened ? reopenedWords(closure) : null },
        assign: st.stage === "FIXING"
          ? { title: `Finish the fix: ${street(p.title)}`, outcome: `Round ${n} fixed and sent to ${clientFirst}`, sourceHref: roundsHref(p.id), clientId: p.clientId, projectId: p.id }
          : { title: `Check in with ${clientFirst}: is ${street(p.title)} right now?`, outcome: `${clientFirst} confirms it's right, or we know what's still wrong`, assigneeKey: "kyle", sourceHref: roundsHref(p.id), clientId: p.clientId, projectId: p.id },
      });
    }
  }
  for (const c of cancels ?? []) {
    if (exclude.has(c.project.clientId)) continue;
    if (signalClosed(closureOf(`cancel:${c.id}`), { atISO: c.createdAt.toISOString() })) continue;
    rows.push({
      whyHere: "Nobody has recorded why it was cancelled or what was decided about the money.",
      close: { kind: "done", prompt: "Why they cancelled, and the refund or write-off decided" },
      id: `cancel:${c.id}`, kind: "cancellation", client: c.project.client?.name ?? null, clientId: c.project.clientId, project: street(c.project.title), projectId: c.projectId,
      title: "Cancelled after delivery", summary: c.body.slice(0, 220), evidence: `Aryeo ${etDate(c.createdAt)}`, severity: "high", severityWhy: "Order cancelled after delivery",
      suggested: false, owner: null, lastClientUpdateISO: null, nextAction: "Find out why and decide on a refund", deadlineISO: null, decision: "Refund or write-off decision",
      href: `/projects/${c.projectId}`, conversationHref: `/communications?client=${c.project.clientId}`,
      assign: { title: `Cancellation follow-up: ${street(c.project.title)}`, outcome: "Reason recorded and the refund decided", sourceHref: `/projects/${c.projectId}#cancel`, clientId: c.project.clientId, projectId: c.projectId },
    });
  }
  for (const r of refunds ?? []) {
    if (signalClosed(closureOf(`refund:${r.id}`), { atISO: r.createdAt.toISOString() })) continue;
    rows.push({
      whyHere: "Nobody has recorded why the money went back.",
      close: { kind: "done", prompt: "Why the refund went out" },
      id: `refund:${r.id}`, kind: "refund", client: r.customerName, clientId: null, project: null, projectId: r.projectId,
      title: `Refund ${usd0Signed(Math.abs(r.gross))}`, summary: r.description ?? "A refund went out through Stripe.", evidence: `Stripe ${etDate(r.createdAt)}`,
      severity: "medium", severityWhy: "Money returned to a client", suggested: false, owner: null, lastClientUpdateISO: null,
      nextAction: "Confirm the reason is recorded", deadlineISO: null, decision: null, href: "/sales", conversationHref: null,
      assign: { title: `Refund reason: ${r.customerName ?? "a client"}`, outcome: "The reason for the refund is recorded", sourceHref: `/sales#refund-${r.id}`, projectId: r.projectId },
    });
  }
  // What keeps happening on one client's shoots (the old Shoot issues card's
  // "by client" line): two or more flags in 60 days.
  for (const b of (flags?.byClient ?? []).filter((x) => x.count >= 2)) {
    if (b.clientId && exclude.has(b.clientId)) continue;
    const closed = closureOf(`pattern:${b.client}`);
    if (signalClosed(closed, { count: b.count })) continue;
    rows.push({
      whyHere: closed ? `More issues were flagged after ${reopenedWords(closed)}.` : "Nobody has named the common cause yet.",
      close: { kind: "done", prompt: "The common cause, and the fix agreed" },
      id: `pattern:${b.client}`, kind: "pattern", client: b.client, clientId: b.clientId, project: null, projectId: null,
      title: "Shoot issues keep coming up", summary: `${b.count} issues flagged on ${b.client}'s shoots in the last 60 days.`, evidence: "Flags raised on shoots", severity: b.count >= 3 ? "medium" : "low", severityWhy: "A repeating pattern",
      suggested: false, owner: null, lastClientUpdateISO: null, nextAction: "Look for the common cause", deadlineISO: null, decision: null,
      href: b.clientId ? `/clients/${b.clientId}` : "/jobs", conversationHref: null,
      records: b.items.map((f) => ({ id: f.id, label: f.street ?? "A shoot", text: f.text, atISO: f.atISO, href: f.href })),
      // sourceHref is this row's assignment key (deleg:<sourceHref>): unchanged, so a task already given from it still matches.
      assign: { title: `Find the cause: ${b.client}'s shoot issues`, outcome: "The common cause named and a fix agreed", sourceHref: `/jobs#shoot-issues-${b.client.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
    });
  }
  // Who already has each row: its canonical delegated task (dedupeKey
  // "deleg:<sourceHref>"), the same lookup the bottlenecks use. Without it the
  // card kept offering Assign after Jordan had given the row to someone (Mike
  // Ciunci's rounds, given to John, Oct 26 2026).
  const keys = [...new Set(rows.filter((r) => r.assign.sourceHref).map((r) => `deleg:${r.assign.sourceHref}`.slice(0, 190)))];
  const handled = keys.length
    ? await prisma.smartTask.findMany({ where: { dedupeKey: { in: keys }, status: { notIn: ["COMPLETED", "CANCELLED"] }, delegatedAt: { not: null } }, select: { id: true, dedupeKey: true } }).catch(() => [])
    : [];
  if (handled.length) {
    const views = await import("@/lib/delegation").then((m) => m.delegationFor(handled.map((t) => t.id))).catch(() => new Map());
    const byKey = new Map(handled.map((t) => [t.dedupeKey, views.get(t.id)]));
    for (const r of rows) {
      const v = r.assign.sourceHref ? byKey.get(`deleg:${r.assign.sourceHref}`.slice(0, 190)) : undefined;
      if (!v) continue;
      r.handledBy = { taskId: v.taskId, words: `${v.assigneeName ? firstName(v.assigneeName) : "Someone"} has it · ${v.state === "ASSIGNED" ? "not accepted yet" : v.state.toLowerCase().replace(/_/g, " ")}` };
      r.owner = v.assigneeName ? firstName(v.assigneeName) : r.owner;
    }
  }
  const sev = { high: 0, medium: 1, low: 2 } as const;
  rows.sort((a, b) => sev[a.severity] - sev[b.severity] || Number(a.suggested) - Number(b.suggested) || (a.deadlineISO ?? "9999").localeCompare(b.deadlineISO ?? "9999"));
  return { rows, unavailable };
}

// =====================================================================================
// D. TEAM COVERAGE
// =====================================================================================

export type CoverageRow = {
  key: string;
  person: string;
  personKey: string | null;
  area: string;
  status: string;
  tone: Tone;
  timeOff: string | null;
  open: number;
  overdue: number;
  awaiting: number;
  /** The row's button (Oct 27 2026: every row has an action). A row with a
   *  problem gets the move that clears it; a covered row hands that person work. */
  action: RowAction;
};
export type TeamCoverage = {
  rows: CoverageRow[];
  awaitingAcceptance: DelegatedTaskView[];
  overdue: DelegatedTaskView[];
  unassigned: { what: string; count: number; href: string }[];
  byPerson: Record<string, DelegatedTaskView[]>;
  timeOff: { name: string; words: string }[];
  note: string;
  unavailable: string[];
};

export async function teamCoverage(opts: { now?: Date; includeTest?: boolean; roster?: Assignee[]; production?: ProductionHealth | null } = {}): Promise<TeamCoverage> {
  const now = opts.now ?? new Date();
  const roster = opts.roster ?? (await listAssignees());
  const todayKey = etDayKey(now);
  const weekKey = etDayKey(new Date(now.getTime() + 7 * DAY));
  const unavailable: string[] = [];
  const { reviewRoomRules, editorRouting } = await import("@/lib/settings");
  const [delegations, kyle, rules, routing, managers, off, owners, booked] = await Promise.all([
    openDelegations().catch(warn("assignments")),
    kylePerson(roster).catch(() => null),
    reviewRoomRules().catch(() => null),
    editorRouting().catch(() => null),
    prisma.teamMember.findMany({ where: { active: true, creativeManager: true }, select: { id: true, name: true } }).catch(() => []),
    timeOffBetween(todayKey, weekKey).catch(warn("time off")),
    prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT", endedAt: null }, select: { duty: true, appUserId: true, teamMemberId: true, label: true } }).catch(() => []),
    // The week's assigned shoots, to check against who is off (audit, Oct 25 2026).
    (opts.includeTest ? Promise.resolve([] as string[]) : syntheticClientIds()).then((ex) => prisma.appointment.findMany({
      where: {
        startAt: { gte: now, lte: new Date(now.getTime() + 7 * DAY) }, assignedToId: { not: null },
        OR: [{ status: null }, { status: { not: "CANCELED" } }],
        project: { status: { not: "CANCELLED" }, ...(ex.length ? { clientId: { notIn: ex } } : {}) },
      },
      select: { startAt: true, assignedToId: true, assignedTo: { select: { name: true } } },
      take: 200,
    })).catch(warn("shoots this week")),
  ]);
  if (!delegations) unavailable.push("assignments");
  if (!off) unavailable.push("time off");
  if (!booked) unavailable.push("this week's shoots");
  // Shoots booked on someone who is off that day (whole days only: part of a day is the office's question).
  const offShoots = off && booked ? booked.filter((b) => (offAt(off, b.assignedToId, b.startAt)?.fraction ?? 0) >= 1) : [];
  const offNames = [...new Set(offShoots.map((b) => firstName(b.assignedTo?.name ?? "")).filter(Boolean))];
  const list = delegations ?? [];
  const nowMs = now.getTime();
  const byPerson: Record<string, DelegatedTaskView[]> = {};
  for (const d of list) if (d.assigneeKey) (byPerson[d.assigneeKey] ||= []).push(d);
  const awaiting = list.filter((d) => d.state === "ASSIGNED");
  const overdue = list.filter((d) => d.dueAt && Date.parse(d.dueAt) < nowMs && d.state !== "READY_FOR_VERIFICATION");
  const keyOfTm = (id: string | null | undefined) => (id ? roster.find((a) => a.teamMemberId === id)?.key ?? null : null);
  const cmKeyOf = () => keyOfTm(rules?.creativeApproverTeamMemberId ?? managers[0]?.id ?? null) ?? kyle?.key ?? null;
  const offOf = (tmId: string | null | undefined) => (tmId ? (off ?? []).filter((o) => o.teamMemberId === tmId).map((o) => o.words).join(", ") || null : null);

  const production = opts.production ?? null;
  const stage = (k: StageKey) => production?.stages.find((s) => s.key === k) ?? null;
  const rows: CoverageRow[] = [];
  // A team-level ask is keyed to the page it is about, so a second press is the same task.
  const due = endOfBusinessDaysET(now, etMinutesOfDay(now) < 17 * 60 ? 0 : 1).toISOString();
  const askTo = (label: string, key: string | null | undefined, title: string, outcome: string, sourceHref: string): RowAction =>
    key ? { kind: "ask", label, seed: { title, outcome, assigneeKey: key, dueAt: due, sourceHref } } : { kind: "assign", label: "Assign", seed: { title, outcome, sourceHref } };
  const giveTo = (key: string | null | undefined): RowAction => ({ kind: "assign", label: "Assign", seed: { title: "", assigneeKey: key ?? null } });
  const push = (r: Omit<CoverageRow, "open" | "overdue" | "awaiting" | "timeOff" | "action"> & { tmId?: string | null; action?: RowAction | null }) => {
    const mine = r.personKey ? byPerson[r.personKey] ?? [] : [];
    const od = mine.filter((d) => d.dueAt && Date.parse(d.dueAt) < nowMs && d.state !== "READY_FOR_VERIFICATION").length;
    const aw = mine.filter((d) => d.state === "ASSIGNED").length;
    const timeOff = offOf(r.tmId ?? null);
    const extra = [od ? `${plural(od, "overdue assignment")}` : null, aw ? `${aw} awaiting acceptance` : null, timeOff].filter(Boolean);
    const { tmId, action, ...rest } = r;
    void tmId;
    // Overdue assignments and nothing more pressing: follow up on the oldest one.
    const oldestLate = mine.filter((d) => d.dueAt && Date.parse(d.dueAt) < nowMs && d.state !== "READY_FOR_VERIFICATION").sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
    const act: RowAction = action ?? (oldestLate ? { kind: "nudge", label: "Follow up", taskId: oldestLate.taskId } : giveTo(r.personKey));
    rows.push({ ...rest, status: [r.status, ...extra].filter(Boolean).join(" · "), tone: od || r.tone === "bad" ? "bad" : aw || timeOff || r.tone === "warn" ? "warn" : "ok", timeOff, open: mine.length, overdue: od, awaiting: aw, action: act });
  };

  // Client care & delivery: the office lead.
  if (kyle) {
    const delivery = stage("delivery");
    const pre = stage("pre");
    const noShooter = pre?.items.filter((i) => i.blocked === "No photographer assigned").length ?? 0;
    const lateSends = delivery?.counts.overdue ?? 0;
    push({
      key: "office", person: kyle.name, personKey: kyle.key, tmId: kyle.teamMemberId, area: "Client care & delivery",
      status: [delivery ? (lateSends ? `${lateSends} late to send` : "Covered") : "Delivery couldn't load", noShooter ? `${noShooter} shoot${noShooter === 1 ? "" : "s"} with no photographer` : null].filter(Boolean).join(" · "),
      tone: lateSends || noShooter ? "bad" : delivery ? "ok" : "warn",
      action: lateSends
        ? askTo("Request update", kyle.key, `Send the ${plural(lateSends, "late delivery", "late deliveries")}`, "Delivered, or each client told the new date", "/jobs")
        : noShooter ? askTo("Request update", kyle.key, `Book a photographer on ${plural(noShooter, "shoot")}`, "A photographer on every shoot, or the shoot moved with the client's OK", "/schedule") : null,
    });
  }
  // Creative management & review: the creative manager / the review seat.
  const approverId = rules?.creativeApproverTeamMemberId ?? managers[0]?.id ?? null;
  const approver = approverId ? roster.find((a) => a.teamMemberId === approverId) : null;
  if (approver) {
    const review = stage("review");
    // By roster key first (two people can share a first name).
    const mineToReview = review?.items.filter((i) => i.id.startsWith("cut:") && (i.ownerKey === approver.key || i.owner === firstName(approver.name))) ?? [];
    const oldest = mineToReview.reduce<number | null>((m, i) => (i.waitingSinceISO ? Math.max(m ?? 0, (nowMs - Date.parse(i.waitingSinceISO)) / HOUR) : m), null);
    push({
      key: "creative", person: approver.name, personKey: approver.key, tmId: approver.teamMemberId, area: "Creative management & review",
      status: review ? (mineToReview.length ? `${plural(mineToReview.length, "cut")} to review${oldest != null ? `, oldest ${Math.round(oldest)}h` : ""}` : "Covered") : "Review couldn't load",
      tone: mineToReview.some((i) => i.late) ? "bad" : mineToReview.length ? "warn" : "ok",
      action: mineToReview.some((i) => i.late) ? askTo("Request update", approver.key, `Review the ${plural(mineToReview.length, "waiting cut")}`, "Each cut approved or sent back with notes", "/review") : null,
    });
  }
  // Post-production: the editors on the routing rules.
  const editorKeys = routing ? [...new Set([routing.standardVideo, routing.premiumVideo, routing.personalBranding].filter((k): k is NonNullable<typeof k> => !!k).map(String))] : [];
  const editing = stage("editing");
  const unassignedEdits = editing?.items.filter((i) => i.blocked === "No editor assigned").length ?? 0;
  const firstUnassigned = editing?.items.find((i) => i.blocked === "No editor assigned");
  const lateEdits = editing?.items.filter((i) => i.late && i.id.startsWith("video:")).length ?? 0;
  push({
    key: "editors",
    // One job with no editor: straight to its Team section; more: the Editing page.
    action: unassignedEdits
      ? { kind: "link", label: "Assign editor", href: unassignedEdits === 1 && firstUnassigned?.projectId ? `/projects/${firstUnassigned.projectId}#team` : "/editing" }
      : lateEdits ? askTo("Request update", cmKeyOf(), `Recovery plan for ${plural(lateEdits, "late edit")}`, "A new ETA on each, and the clients told", "/editing") : { kind: "link", label: "Open", href: "/editing" },
    person: editorKeys.length ? editorKeys.map((k) => roster.find((a) => a.key === k)?.name ?? firstName(k)).join(", ") : "Editors",
    personKey: null,
    area: "Post-production",
    status: editing ? (unassignedEdits ? `${plural(unassignedEdits, "unassigned job")}` : editing.counts.overdue ? `${editing.counts.overdue} late in editing` : "Covered") : "Editing couldn't load",
    tone: unassignedEdits || editing?.counts.overdue ? "bad" : editing ? "ok" : "warn",
  });
  // Field: photographers with shoots coming up or uploads owed.
  const capture = stage("capture");
  const shooters = await prisma.teamMember.findMany({ where: { active: true, role: "PHOTOGRAPHER" }, select: { id: true } }).catch(() => [] as { id: string }[]);
  const shooterIds = new Set(shooters.map((x) => x.id));
  const field = roster.filter((a) => !!a.teamMemberId && shooterIds.has(a.teamMemberId));
  if (capture || field.length || offShoots.length) {
    const owed = capture?.items.length ?? 0;
    const clash = offShoots.length ? `${plural(offShoots.length, "shoot")} this week booked on ${offNames.join(" and ")} while off` : null;
    push({
      key: "field", person: field.map((f) => f.name).filter((n) => !/^jordan$/i.test(n)).join(", ") || "Photographers", personKey: null, area: "Field shoots & uploads",
      // A shoot on someone who is off is the office's to move; uploads owed open the Shoots board.
      action: clash ? askTo("Reassign", kyle?.key, `Reassign ${plural(offShoots.length, "shoot")} booked on ${offNames.join(" and ")} while off`, "Another photographer on each, or the shoot moved with the client's OK", "/schedule") : { kind: "link", label: owed ? "Review" : "Open", href: "/jobs" },
      status: [clash, capture ? (owed ? `${plural(owed, "upload")} owed` : clash ? null : "Covered") : "Uploads couldn't load"].filter(Boolean).join(" · "), tone: clash || capture?.counts.overdue ? "bad" : owed ? "warn" : capture ? "ok" : "warn" });
  }
  // The owner's own areas (the content program's default duties).
  const ownerDuties = owners.filter((o) => o.duty === "STRATEGY" || o.duty === "SCRIPTS" || o.duty === "ESCALATION");
  if (ownerDuties.length) {
    const users = await prisma.appUser.findMany({ where: { id: { in: ownerDuties.map((o) => o.appUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true, teamMemberId: true } }).catch(() => []);
    const holders = new Map<string, string[]>();
    for (const o of ownerDuties) {
      const u = users.find((x) => x.id === o.appUserId);
      const name = u?.name ? firstName(u.name) : o.label ?? "Unassigned";
      holders.set(name, [...(holders.get(name) ?? []), o.duty.toLowerCase()]);
    }
    for (const [name, duties] of holders) {
      const u = users.find((x) => x.name && firstName(x.name) === name);
      push({ key: `program:${name}`, person: name, personKey: keyOfTm(u?.teamMemberId), tmId: u?.teamMemberId ?? null, area: `Monthly content: ${duties.join(", ")}`, status: "Owner on record", tone: "ok" });
    }
  }

  const unassigned = [
    unassignedEdits ? { what: "Edit jobs with no editor", count: unassignedEdits, href: "/editing" } : null,
    (stage("pre")?.items.filter((i) => i.blocked === "No photographer assigned").length ?? 0) > 0 ? { what: "Shoots with no photographer", count: stage("pre")!.items.filter((i) => i.blocked === "No photographer assigned").length, href: "/schedule" } : null,
    offShoots.length ? { what: `Shoots booked on ${offNames.join(" and ")} while off`, count: offShoots.length, href: "/schedule" } : null,
  ].filter((x): x is { what: string; count: number; href: string } => !!x);
  const names = new Map(roster.filter((a) => a.teamMemberId).map((a) => [a.teamMemberId!, a.name]));
  return {
    rows,
    awaitingAcceptance: awaiting,
    overdue,
    unassigned,
    byPerson,
    timeOff: (off ?? []).map((o) => ({ name: names.get(o.teamMemberId) ?? "Someone", words: o.words })),
    note: "Capacity isn't estimated from task counts. Time off comes from PTO and the capacity register; working hours aren't recorded per person.",
    unavailable,
  };
}

// =====================================================================================
// I. WEEKLY PERFORMANCE
// =====================================================================================

export type Measure = { key: string; label: string; value: string; detail: string; period: string; source: string; tone: Tone | null };

/** Fewer than this many to judge reads "Not enough data", never a percent
 *  (Jordan, Oct 19: one late job of two read as "50% on time"). */
const NOT_ENOUGH = "Not enough data";

/**
 * REVISION RATE (Oct 27 2026; the tile read "7 / 2 (350%)": seven asks this
 * week over two videos delivered this week, two counts that don't measure
 * the same jobs). Now one plain share: of the jobs whose video was delivered
 * in the last 30 days, how many had a client revision ask on record (one
 * RevisionBrief per ask; the office's own notes and system rows are not asks).
 */
async function revisionRate(now: Date, exclude: string[]): Promise<{ jobs: number; revised: number }> {
  const since = new Date(now.getTime() - 30 * DAY);
  const outs = await prisma.deliverableOutput.findMany({
    where: { deliveredAt: { gte: since, lt: now }, category: "VIDEO", ...(exclude.length ? { project: { clientId: { notIn: exclude } } } : {}) },
    select: { projectId: true },
  });
  const jobs = [...new Set(outs.map((o) => o.projectId))];
  if (!jobs.length) return { jobs: 0, revised: 0 };
  const asks = await prisma.revisionBrief.findMany({
    where: { projectId: { in: jobs }, OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }] },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  return { jobs: jobs.length, revised: asks.length };
}
export type WeeklyPerformance = { measures: Measure[]; updatedISO: string };

export async function weeklyPerformance(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<WeeklyPerformance> {
  const now = opts.now ?? new Date();
  const weekStart = etWeekStart(now);
  const exclude = opts.excludeClientIds ?? [];
  const in7 = new Date(now.getTime() + 7 * DAY);
  const [week, upcoming, quality, off, rate] = await Promise.all([
    ownerWeek(now, { excludeClientIds: exclude }).catch(warn("week")),
    prisma.appointment.findMany({ where: { startAt: { gte: now, lte: in7 }, OR: [{ status: null }, { status: { not: "CANCELED" } }], project: { status: { not: "CANCELLED" }, ...(exclude.length ? { clientId: { notIn: exclude } } : {}) } }, select: { assignedToId: true, startAt: true } }).catch(warn("upcoming shoots")),
    import("@/lib/revisionQuality").then((m) => m.revisionQuality(30, { includeTest: false, now })).catch(warn("revision causes")),
    timeOffBetween(etDayKey(now), etDayKey(in7)).catch(warn("time off")),
    revisionRate(now, exclude).catch(warn("revision rate")),
  ]);
  const period = `This week, ${etMonthDay(weekStart)} to now`;
  const pctOf = (ok: number, n: number) => (n ? Math.round((ok / n) * 100) : null);
  const measures: Measure[] = [];
  if (week) {
    const t = week.thisWeek, l = week.lastWeek;
    const onTime = (label: string, key: string, s: { judged: number; onTime: number; onTimePct: number | null }, last: { onTimePct: number | null; judged: number }, source: string) => {
      const enough = s.judged >= ON_TIME_MIN_JOBS && s.onTimePct != null;
      measures.push({
        key, label, value: enough ? `${s.onTimePct}%` : s.judged ? NOT_ENOUGH : "None yet",
        detail: `${s.onTime} of ${s.judged} on time${last.judged >= ON_TIME_MIN_JOBS && last.onTimePct != null ? ` · last week ${last.onTimePct}%` : ""}`,
        period, source, tone: !enough ? null : (s.onTimePct ?? 0) >= 90 ? "ok" : (s.onTimePct ?? 0) >= 75 ? "warn" : "bad",
      });
    };
    onTime("On-time photos", "photos", t.photos, l.photos, "Photo jobs delivered this week with a promise (photo delivery queue)");
    onTime("On-time listing videos", "videos", t.listingVideos, l.listingVideos, "Listing videos delivered this week with a promise (video outputs); monthly content apart");
    const asksWeek = `${plural(t.revisions, "client revision ask")} this week · last week ${l.revisions}`;
    if (rate) {
      const enough = rate.jobs >= ON_TIME_MIN_JOBS;
      measures.push({
        key: "revisions", label: "Revision rate", value: enough ? `${pctOf(rate.revised, rate.jobs)}%` : rate.jobs ? NOT_ENOUGH : "None yet",
        detail: rate.jobs ? `${rate.revised} of ${plural(rate.jobs, "job")} with a video delivered had a client revision ask · ${asksWeek}` : `No videos delivered in the last 30 days · ${asksWeek}`,
        period: "Last 30 days", source: "Jobs with a video delivered (video outputs), and whether the client asked for a revision on that job (one record per ask; office notes not counted)", tone: null,
      });
    } else {
      measures.push({ key: "revisions", label: "Revision rate", value: "Couldn't load", detail: asksWeek, period: "Last 30 days", source: "Video outputs and client revision asks", tone: "warn" });
    }
    const repliesEnough = t.replies.inbound >= ON_TIME_MIN_JOBS && t.replies.fastPct != null;
    measures.push({ key: "replies", label: "Client replies within 1 hour", value: repliesEnough ? `${t.replies.fastPct}%` : t.replies.inbound ? NOT_ENOUGH : "None yet", detail: `${t.replies.fast} of ${t.replies.inbound} client texts answered within an hour${l.replies.fastPct != null ? ` · last week ${l.replies.fastPct}%` : ""}`, period, source: "Client texts and our next reply (OpenPhone); email isn't timed here", tone: repliesEnough ? ((t.replies.fastPct ?? 0) >= 90 ? "ok" : (t.replies.fastPct ?? 0) >= 70 ? "warn" : "bad") : null });
  } else {
    measures.push({ key: "week", label: "This week", value: "Couldn't load", detail: "The week's delivery and reply figures didn't load", period, source: "", tone: "warn" });
  }
  if (upcoming) {
    // Covered = a photographer is on it AND working that day (audit, Oct 25
    // 2026: five shoots on Harrison during his week off counted as covered).
    const away = upcoming.filter((u) => !!u.assignedToId && (offAt(off ?? [], u.assignedToId, u.startAt)?.fraction ?? 0) >= 1).length;
    const covered = upcoming.filter((u) => !!u.assignedToId).length - away;
    measures.push({
      key: "shoots", label: "Upcoming shoots covered", value: upcoming.length ? `${covered}/${upcoming.length}` : "None booked",
      detail: `Shoots in the next 7 days with a photographer assigned who isn't off that day${away ? ` · ${plural(away, "shoot")} on someone who is off` : ""}${off ? "" : " · time off couldn't be read"}`,
      period: `Next 7 days to ${etMonthDay(in7)}`, source: "Aryeo appointments, against PTO and the capacity register",
      tone: away ? "bad" : upcoming.length && covered < upcoming.length ? "warn" : upcoming.length ? "ok" : null,
    });
  }
  if (quality) {
    const top = [...quality.byCause].sort((a, b) => b.count - a.count)[0];
    measures.push({ key: "quality", label: "Top quality issue", value: top ? `${top.count}` : "None", detail: top ? `${top.label}, of ${quality.confirmedIssues} classified revision issues${quality.awaitingClassification ? ` (${quality.awaitingClassification} not classified yet)` : ""}` : `No classified revision issues${quality.awaitingClassification ? ` (${quality.awaitingClassification} awaiting classification)` : ""}`, period: "Last 30 days", source: "Revision issues by cause (the Quality page)", tone: null });
  }
  return { measures, updatedISO: now.toISOString() };
}

