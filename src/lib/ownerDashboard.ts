import "server-only";
import { prisma } from "@/lib/prisma";
import { usd0Signed } from "@/lib/money";
import { noDashes } from "@/lib/text";
import { endOfBusinessDaysET, etDate, etDateTime, etDayKey, etMonthDay, etTime } from "@/lib/datetime";
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
};

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
  const [{ revenueByProcessor }, { categoryBreakdown, railFreshness }, { getBillingRows }] = await Promise.all([
    import("@/lib/bookkeeping"),
    import("@/lib/financeCategories"),
    import("@/lib/queries"),
  ]);
  const [banks, revenue, spend, ar, pay, recurring, fresh] = await Promise.all([
    prisma.plaidAccount.findMany({
      where: { isBusiness: true, type: "depository" },
      select: { name: true, mask: true, currentBalance: true, item: { select: { lastSyncedAt: true, status: true } } },
    }).catch(warn("bank balances")),
    revenueByProcessor(monthStartKey, todayKey).catch(warn("revenue")),
    categoryBreakdown(monthStartKey, todayKey).catch(warn("spend")),
    getBillingRows({ excludeClientIds: opts.excludeClientIds }).catch(warn("unpaid list")),
    fixedPayDue(todayKey, horizonKey).catch((e: unknown) => (warn("fixed pay")(e), "failed" as const)),
    recurringExpensesDue(now, horizon).catch((e: unknown) => (warn("recurring costs")(e), "failed" as const)),
    railFreshness().catch(warn("freshness")),
  ]);
  const limitations: string[] = [];

  // ---- cash: the business bank accounts on the live feed -------------------
  const withBalance = (banks ?? []).filter((b) => b.currentBalance != null);
  const cashValue = withBalance.length ? Math.round(withBalance.reduce((s, b) => s + (b.currentBalance ?? 0), 0) * 100) / 100 : null;
  const bankAsOf = withBalance.reduce<Date | null>((m, b) => (b.item.lastSyncedAt && (!m || b.item.lastSyncedAt > m) ? b.item.lastSyncedAt : m), null);
  const bankNames = withBalance.map((b) => (b.mask ? `··${b.mask}` : b.name ?? "account")).join(" + ");
  const cash: Figure = banks == null
    ? { key: "cash", label: "Cash available", value: null, display: "Couldn't load", sub: "The bank balances didn't load. Refresh to try again.", tag: null, tone: null, href: "/connections/banks" }
    : cashValue == null
      ? { key: "cash", label: "Cash available", value: null, display: "Not connected", sub: "No bank account is tagged Business on Connections", tag: null, tone: null, href: "/connections/banks" }
      : { key: "cash", label: "Cash available", value: cashValue, display: usd0Signed(cashValue), sub: `Bank ${bankNames}${bankAsOf ? ` · synced ${etDateTime(bankAsOf)}` : ""}`, tag: null, tone: cashValue < 0 ? "bad" : null, href: "/connections/banks" };
  if ((banks ?? []).some((b) => b.item.status === "ERROR")) limitations.push("A bank login needs reconnecting on Connections, so the balance may be stale.");
  limitations.push("Stripe's balance and payouts still in transit aren't included (no live Stripe read here); a payout counts once it lands in the bank.");

  // ---- obligations: only what is recorded ----------------------------------
  const obligationsFailed = pay === "failed" || recurring === "failed";
  const payRec = pay === "failed" ? null : pay;
  const recRec = recurring === "failed" ? null : recurring;
  const anyObligation = !!payRec || !!recRec;
  const obligationValue = anyObligation ? Math.round(((payRec?.total ?? 0) + (recRec?.total ?? 0)) * 100) / 100 : null;
  const payWords = payRec ? (payRec.lines.length ? payRec.lines.map((l) => `fixed pay ${etMonthDay(new Date(`${l.dayKey}T12:00:00Z`))} (${l.names.join(", ")})`).join(", ") : "no fixed-pay payday in the window") : null;
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
    const value = Math.round((revenue.total - spend.businessTotal) * 100) / 100;
    profit = {
      key: "profit", label: "MTD profit", value, display: usd0Signed(value),
      sub: `Revenue ${usd0Signed(revenue.total)} − business spend ${usd0Signed(spend.businessTotal)}`,
      tag: "provisional", tone: value < 0 ? "bad" : "ok", href: "/sales",
    };
    if (revenue.quickbooksNote) limitations.push(revenue.quickbooksNote);
    if (revenue.venmoNote) limitations.push(revenue.venmoNote);
    if (spend.reviewTotal > 0) limitations.push(`${usd0Signed(spend.reviewTotal)} of this month's spending isn't classified yet, so profit may read high.`);
  }
  if (fresh?.bank.syncedAt && now.getTime() - fresh.bank.syncedAt.getTime() > 2 * DAY) limitations.push(`The bank feed last synced ${etDateTime(fresh.bank.syncedAt)}; spending since then isn't counted.`);

  const freshness = [
    bankAsOf ? `Bank ${etDateTime(bankAsOf)}` : null,
    fresh?.quickbooksPulledAt ? `QuickBooks ${etDateTime(fresh.quickbooksPulledAt)}` : "QuickBooks never synced",
    fresh?.stripe ? `Stripe through ${etDateTime(fresh.stripe)}` : null,
    `read ${etTime(now)} ET`,
  ].filter(Boolean).join(" · ");
  return {
    figures: [cash, obligations, collections, forecast, profit],
    period: `Month to date ${etMonthDay(new Date(`${monthStartKey}T12:00:00Z`))} to ${etMonthDay(now)} · next 14 days to ${etMonthDay(horizon)} (ET)`,
    sources: "Bank feed (Plaid) · revenue at Stripe, QuickBooks Payments and Venmo · spend from the categorized ledger · unpaid from Aryeo",
    freshness,
    // The books' own sentences, in the dashboard's voice (no em dashes).
    limitations: [...new Set(limitations.map((l) => noDashes(l)))],
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

  const [jobs, video, review, photos, exceptions, visits, kyle] = await Promise.all([
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
  ]);
  const officeName = kyle?.name ?? "Kyle";
  const excluded = new Set(exclude);
  const unavailable: string[] = [];

  // ---- pre-production: shoots from now to the end of the next business day ----
  const pre: StageItem[] = (visits ?? []).filter((v): v is typeof v & { startAt: Date } => !!v.startAt).map((v) => ({
    id: `visit:${v.id}`,
    street: street(v.project?.title),
    client: v.project?.client?.name ?? null,
    what: `Shoot ${etDateTime(v.startAt)}`,
    dueISO: v.startAt.toISOString(),
    late: false,
    dueSoon: true,
    blocked: v.assignedToId ? null : "No photographer assigned",
    waitingSinceISO: null,
    owner: v.assignedTo?.name ? firstName(v.assignedTo.name) : officeName,
    href: v.project ? `/projects/${v.project.id}` : "/schedule",
    projectId: v.project?.id ?? null,
  }));
  if (!visits) unavailable.push("upcoming shoots");

  // ---- capture & upload: the shoot happened, the raws are not in -------------
  const notUploaded = (jobs?.rows ?? []).filter((r) => r.photos?.label === "Not uploaded");
  const shooters = notUploaded.length
    ? await prisma.project.findMany({ where: { id: { in: notUploaded.map((r) => r.projectId) } }, select: { id: true, shootDate: true, photographer: { select: { name: true } } } }).catch(() => [])
    : [];
  const shooterOf = new Map(shooters.map((s) => [s.id, s]));
  const capture: StageItem[] = notUploaded.map((r) => ({
    id: `capture:${r.projectId}`,
    street: r.street,
    client: r.client,
    what: "Photos not uploaded",
    dueISO: r.dueISO,
    late: r.late,
    dueSoon: r.dueToday || isSoon(r.dueISO),
    blocked: null,
    waitingSinceISO: shooterOf.get(r.projectId)?.shootDate?.toISOString() ?? null,
    owner: shooterOf.get(r.projectId)?.photographer?.name ? firstName(shooterOf.get(r.projectId)!.photographer!.name) : "The photographer",
    href: r.href,
    projectId: r.projectId,
  }));
  if (!jobs) unavailable.push("the Shoots board");

  // ---- editing, review, delivery -------------------------------------------
  const editorOf = new Map((jobs?.rows ?? []).map((r) => [r.projectId, chipPerson(r.video?.label)]));
  const unassignedIds = new Set((exceptions && !exceptions.unavailable ? exceptions.rows.filter((r) => r.kind === "unassigned") : []).map((r) => (r.href.match(/\/projects\/([^/?#]+)/) ?? [])[1]).filter(Boolean));
  const editing: StageItem[] = [];
  const reviewItems: StageItem[] = [];
  const delivery: StageItem[] = [];
  const videoRows = video && !video.unavailable ? (["late", "today", "upcoming", "review", "sending", "held", "finishing"] as const).flatMap((l) => video.lanes[l]) : [];
  const seenVideo = new Set<string>();
  for (const r of videoRows) {
    if (seenVideo.has(r.key)) continue;
    seenVideo.add(r.key);
    const phase = phaseOfVideoRow(r);
    const base = { street: r.street, client: r.clientName || null, dueISO: r.promiseISO, late: r.late, dueSoon: r.dueToday || isSoon(r.promiseISO), projectId: r.projectId };
    if (phase === "editing" || phase === "changes" || phase === "not_cut") {
      const ed = editorOf.get(r.projectId) ?? null;
      const noEditor = unassignedIds.has(r.projectId);
      editing.push({ ...base, id: `video:${r.key}`, what: `${r.label}${r.round ? ` v${r.round}` : ""}: ${phase === "changes" ? "changes asked" : phase === "not_cut" ? "not cut yet" : "editing"}`, blocked: noEditor ? "No editor assigned" : null, waitingSinceISO: r.sinceISO, owner: noEditor ? officeName : ed ?? "The editor", href: `/projects/${r.projectId}` });
    } else if (phase === "review") {
      // the cut itself is listed from the review queue below (it names the reviewer)
    } else if (phase === "ready" || phase === "held" || phase === "finishing") {
      delivery.push({ ...base, id: `video:${r.key}`, what: `${r.label}: ${phase === "held" ? "held" : phase === "finishing" ? "in the 1080p pass" : "approved, ready to send"}`, blocked: phase === "held" ? r.heldWhy ?? "Held" : null, waitingSinceISO: r.waitingSinceISO ?? r.approvedAtISO, owner: phase === "finishing" ? "The 1080p pass" : officeName, href: r.reviewHref ?? `/review/${r.projectId}` });
    }
  }
  // Unassigned edit jobs the video board did not list (monthly content and the like).
  for (const row of exceptions && !exceptions.unavailable ? exceptions.rows.filter((r) => r.kind === "unassigned") : []) {
    const pid = (row.href.match(/\/projects\/([^/?#]+)/) ?? [])[1] ?? null;
    if (pid && editing.some((e) => e.projectId === pid)) continue;
    editing.push({ id: `unassigned:${row.id}`, street: row.title, client: null, what: row.why, dueISO: null, late: row.severity === "high", dueSoon: false, blocked: "No editor assigned", waitingSinceISO: new Date(now.getTime() - row.ageDays * DAY).toISOString(), owner: officeName, href: row.href, projectId: pid });
  }
  const promiseOf = new Map(videoRows.map((r) => [r.projectId, r]));
  for (const c of review?.pending ?? []) {
    const v = promiseOf.get(c.projectId);
    reviewItems.push({ id: `cut:${c.id}`, street: c.street, client: c.clientName || null, what: `${c.fileName ?? "Video"} v${c.round} from ${c.editorName ?? "the editor"}`, dueISO: v?.promiseISO ?? null, late: !!v?.late, dueSoon: !!v && (v.dueToday || isSoon(v.promiseISO)), blocked: null, waitingSinceISO: c.createdAt, owner: c.reviewer?.name ? firstName(c.reviewer.name) : "Nobody (the office)", href: `/review/${c.projectId}?cut=${c.id}`, projectId: c.projectId });
  }
  if (!video || video.unavailable) unavailable.push("the video board");
  if (!review) unavailable.push("the review queue");
  if (!exceptions || exceptions.unavailable) unavailable.push("unassigned edits");

  // Photos, by the queue's own columns.
  for (const col of photos?.columns ?? []) {
    for (const card of col.cards) {
      if (card.clientId && excluded.has(card.clientId)) continue;
      const base = { id: `photos:${card.id}`, street: street(card.street), client: card.clientName, dueISO: card.slaDueAt, late: isLate(card.slaDueAt), dueSoon: isSoon(card.slaDueAt), waitingSinceISO: card.shootDate, href: `/ops/photo-delivery/${card.id}`, projectId: card.projectId };
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
  const bottlenecks = await bottlenecksFrom({ now, stages, roster, officeName, ownerEmail: opts.ownerEmail ?? null });

  return {
    stages,
    bottlenecks,
    punctuality: "Shoot punctuality isn't measured: arrival times aren't recorded as data (the photographer's Arrived text is optional). Delivery timeliness is in the stages above.",
    unavailable,
  };
}

async function bottlenecksFrom(o: { now: Date; stages: Stage[]; roster: Assignee[]; officeName: string; ownerEmail: string | null }): Promise<Bottleneck[]> {
  const { now, stages, roster } = o;
  const keyOfName = (name: string) => roster.find((a) => a.name.toLowerCase() === name.toLowerCase())?.key ?? null;
  type Cand = Bottleneck & { rank: number };
  const cand: Cand[] = [];
  const all = stages.flatMap((s) => s.items.map((i) => ({ s, i })));
  // Late work, blocked work: one row per record.
  for (const { s, i } of all) {
    if (!i.late && !i.blocked) continue;
    const sourceHref = i.href;
    const lateH = i.dueISO ? Math.max(1, Math.round((now.getTime() - Date.parse(i.dueISO)) / HOUR)) : null;
    const issue = i.blocked && !i.late
      ? `${i.street}: ${i.blocked.toLowerCase()}`
      : `${i.street}: ${i.what.toLowerCase()}${lateH ? `, ${lateH >= 24 ? `${Math.round(lateH / 24)}d` : `${lateH}h`} late` : ""}`;
    const noOwner = /^nobody|^no /i.test(i.owner) || !!i.blocked?.startsWith("No ");
    cand.push({
      id: `${s.key}:${i.id}`,
      issue,
      client: i.client,
      commitment: i.dueISO ? `${s.key === "pre" ? "Shoot" : "Promised"} ${etDateTime(i.dueISO)}` : null,
      owner: i.owner,
      handledBy: null,
      nextStep: i.blocked?.startsWith("No photographer") ? "Assign a photographer" : i.blocked?.startsWith("No editor") ? "Assign an editor" : i.late ? "Recovery plan and new ETA" : `Clear: ${i.blocked}`,
      clientUpdate: i.late && i.projectId ? "pending" : null,
      tone: i.late || noOwner ? "bad" : "warn",
      href: i.href,
      assign: {
        title: i.late ? `Recovery plan: ${i.street} (${i.what})` : `Unblock: ${i.street} (${i.blocked})`,
        outcome: i.late ? "A recovery plan with a new ETA, and the client told" : `Cleared: ${i.blocked}`,
        assigneeKey: keyOfName(i.owner),
        sourceHref,
        projectId: i.projectId,
      },
      taskId: null,
      rank: (noOwner ? 0 : 10) + (i.late ? 0 : 5),
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
      rank: -1,
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
  }
  return cand
    .sort((a, b) => a.rank - b.rank || Number(b.tone === "bad") - Number(a.tone === "bad"))
    .map(({ rank, ...b }) => (void rank, b));
}

// =====================================================================================
// C. CLIENT ISSUES
// =====================================================================================

export type ClientIssueRow = {
  id: string;
  kind: "complaint" | "feedback" | "revisions" | "cancellation" | "refund";
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
};
export type ClientIssues = { rows: ClientIssueRow[]; unavailable: string[] };

export async function clientIssuesSection(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<ClientIssues> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - 30 * DAY);
  const exclude = new Set(opts.excludeClientIds ?? []);
  const unavailable: string[] = [];
  const { listClientIssues } = await import("@/lib/clientIssues");
  const [issues, feedback, revisions, cancels, refunds] = await Promise.all([
    listClientIssues({ states: ["OPEN", "CORRECTED", "UNRESOLVED"], scrubMoney: false, take: 60 }).catch(warn("client issues")),
    prisma.feedback.findMany({
      where: { createdAt: { gte: since }, resolved: false, dismissedAt: null, OR: [{ sentiment: "NEGATIVE" }, { sentimentAuto: "NEGATIVE" }] },
      select: { id: true, body: true, sentiment: true, sentimentAuto: true, sentimentBy: true, source: true, createdAt: true, projectId: true, project: { select: { title: true, clientId: true, client: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }).catch(warn("feedback")),
    prisma.revisionBrief.groupBy({
      by: ["projectId"],
      where: { createdAt: { gte: since }, OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }] },
      _count: { _all: true },
      _max: { createdAt: true },
    }).catch(warn("revisions")),
    prisma.activity.findMany({ where: { createdAt: { gte: since }, body: { startsWith: "Order canceled in Aryeo AFTER delivery" } }, select: { id: true, projectId: true, createdAt: true, body: true, project: { select: { title: true, clientId: true, client: { select: { name: true } } } } }, take: 20 }).catch(warn("cancellations")),
    prisma.stripeTransaction.findMany({ where: { createdAt: { gte: since }, type: { in: ["refund", "payment_refund"] } }, select: { id: true, gross: true, createdAt: true, customerName: true, projectId: true, description: true }, orderBy: { createdAt: "desc" }, take: 20 }).catch(warn("refunds")),
  ]);
  if (!issues) unavailable.push("complaints");
  if (!feedback) unavailable.push("feedback");
  if (!revisions) unavailable.push("revisions");
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
  const repeat = (revisions ?? []).filter((r) => r._count._all >= 2 && !coveredProjects.has(r.projectId));
  if (repeat.length) {
    const ps = await prisma.project.findMany({ where: { id: { in: repeat.map((r) => r.projectId) } }, select: { id: true, title: true, clientId: true, client: { select: { name: true } } } }).catch(() => []);
    for (const r of repeat) {
      const p = ps.find((x) => x.id === r.projectId);
      if (!p || exclude.has(p.clientId)) continue;
      rows.push({
        id: `revisions:${r.projectId}`, kind: "revisions", client: p.client?.name ?? null, clientId: p.clientId, project: street(p.title), projectId: p.id,
        title: `${r._count._all} revision rounds`, summary: `The client asked for changes ${r._count._all} times in 30 days, the latest ${etDateTime(r._max.createdAt)}.`,
        evidence: "Revision requests on the job", severity: r._count._all >= 3 ? "high" : "medium", severityWhy: "Repeated revisions",
        suggested: false, owner: null, lastClientUpdateISO: null, nextAction: "Correction plan", deadlineISO: null, decision: null,
        href: `/projects/${p.id}`, conversationHref: `/communications?client=${p.clientId}`,
        assign: { title: `Correction plan: ${street(p.title)}`, outcome: "A correction plan the client agrees to", sourceHref: `/projects/${p.id}#revisions`, clientId: p.clientId, projectId: p.id },
      });
    }
  }
  for (const c of cancels ?? []) {
    if (exclude.has(c.project.clientId)) continue;
    rows.push({
      id: `cancel:${c.id}`, kind: "cancellation", client: c.project.client?.name ?? null, clientId: c.project.clientId, project: street(c.project.title), projectId: c.projectId,
      title: "Cancelled after delivery", summary: c.body.slice(0, 220), evidence: `Aryeo ${etDate(c.createdAt)}`, severity: "high", severityWhy: "Order cancelled after delivery",
      suggested: false, owner: null, lastClientUpdateISO: null, nextAction: "Find out why and decide on a refund", deadlineISO: null, decision: "Refund or write-off decision",
      href: `/projects/${c.projectId}`, conversationHref: `/communications?client=${c.project.clientId}`,
      assign: { title: `Cancellation follow-up: ${street(c.project.title)}`, outcome: "Reason recorded and the refund decided", sourceHref: `/projects/${c.projectId}#cancel`, clientId: c.project.clientId, projectId: c.projectId },
    });
  }
  for (const r of refunds ?? []) {
    rows.push({
      id: `refund:${r.id}`, kind: "refund", client: r.customerName, clientId: null, project: null, projectId: r.projectId,
      title: `Refund ${usd0Signed(Math.abs(r.gross))}`, summary: r.description ?? "A refund went out through Stripe.", evidence: `Stripe ${etDate(r.createdAt)}`,
      severity: "medium", severityWhy: "Money returned to a client", suggested: false, owner: null, lastClientUpdateISO: null,
      nextAction: "Confirm the reason is recorded", deadlineISO: null, decision: null, href: "/sales", conversationHref: null,
      assign: { title: `Refund reason: ${r.customerName ?? "a client"}`, outcome: "The reason for the refund is recorded", sourceHref: `/sales#refund-${r.id}`, projectId: r.projectId },
    });
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

/** Who is off (PTO entries and capacity exceptions) between two ET days. */
async function timeOffBetween(fromKey: string, toKey: string): Promise<{ teamMemberId: string; words: string }[]> {
  const [ptoRows, caps] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { startsWith: "pto:" } }, select: { key: true, value: true } }),
    prisma.capacityException.findMany({ where: { kind: "TIME_OFF", cancelledAt: null, startsAt: { lte: new Date(`${toKey}T23:59:59Z`) }, OR: [{ endsAt: null }, { endsAt: { gte: new Date(`${fromKey}T00:00:00Z`) } }] }, select: { teamMemberId: true, startsAt: true, endsAt: true } }),
  ]);
  const out: { teamMemberId: string; words: string }[] = [];
  for (const r of ptoRows) {
    const memberId = r.key.split(":")[1];
    let entries: { startKey?: string; endKey?: string; type?: string }[] = [];
    try { entries = (JSON.parse(r.value) as { entries?: typeof entries }).entries ?? []; } catch { continue; }
    for (const e of entries) {
      if (!e.startKey || !e.endKey || e.endKey < fromKey || e.startKey > toKey) continue;
      const d = (k: string) => etMonthDay(new Date(`${k}T12:00:00Z`));
      out.push({ teamMemberId: memberId, words: `Off ${e.startKey === e.endKey ? d(e.startKey) : `${d(e.startKey)} to ${d(e.endKey)}`}` });
    }
  }
  for (const c of caps) out.push({ teamMemberId: c.teamMemberId, words: `Off ${etMonthDay(c.startsAt)}${c.endsAt ? ` to ${etMonthDay(c.endsAt)}` : ""}` });
  return out;
}

export async function teamCoverage(opts: { now?: Date; includeTest?: boolean; roster?: Assignee[]; production?: ProductionHealth | null } = {}): Promise<TeamCoverage> {
  const now = opts.now ?? new Date();
  const roster = opts.roster ?? (await listAssignees());
  const todayKey = etDayKey(now);
  const weekKey = etDayKey(new Date(now.getTime() + 7 * DAY));
  const unavailable: string[] = [];
  const { reviewRoomRules, editorRouting } = await import("@/lib/settings");
  const [delegations, kyle, rules, routing, managers, off, owners] = await Promise.all([
    openDelegations().catch(warn("assignments")),
    kylePerson(roster).catch(() => null),
    reviewRoomRules().catch(() => null),
    editorRouting().catch(() => null),
    prisma.teamMember.findMany({ where: { active: true, creativeManager: true }, select: { id: true, name: true } }).catch(() => []),
    timeOffBetween(todayKey, weekKey).catch(warn("time off")),
    prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT", endedAt: null }, select: { duty: true, appUserId: true, teamMemberId: true, label: true } }).catch(() => []),
  ]);
  if (!delegations) unavailable.push("assignments");
  if (!off) unavailable.push("time off");
  const list = delegations ?? [];
  const nowMs = now.getTime();
  const byPerson: Record<string, DelegatedTaskView[]> = {};
  for (const d of list) if (d.assigneeKey) (byPerson[d.assigneeKey] ||= []).push(d);
  const awaiting = list.filter((d) => d.state === "ASSIGNED");
  const overdue = list.filter((d) => d.dueAt && Date.parse(d.dueAt) < nowMs && d.state !== "READY_FOR_VERIFICATION");
  const keyOfTm = (id: string | null | undefined) => (id ? roster.find((a) => a.teamMemberId === id)?.key ?? null : null);
  const offOf = (tmId: string | null | undefined) => (tmId ? (off ?? []).filter((o) => o.teamMemberId === tmId).map((o) => o.words).join(", ") || null : null);

  const production = opts.production ?? null;
  const stage = (k: StageKey) => production?.stages.find((s) => s.key === k) ?? null;
  const rows: CoverageRow[] = [];
  const push = (r: Omit<CoverageRow, "open" | "overdue" | "awaiting" | "timeOff"> & { tmId?: string | null }) => {
    const mine = r.personKey ? byPerson[r.personKey] ?? [] : [];
    const od = mine.filter((d) => d.dueAt && Date.parse(d.dueAt) < nowMs && d.state !== "READY_FOR_VERIFICATION").length;
    const aw = mine.filter((d) => d.state === "ASSIGNED").length;
    const timeOff = offOf(r.tmId ?? null);
    const extra = [od ? `${plural(od, "overdue assignment")}` : null, aw ? `${aw} awaiting acceptance` : null, timeOff].filter(Boolean);
    const { tmId, ...rest } = r;
    void tmId;
    rows.push({ ...rest, status: [r.status, ...extra].filter(Boolean).join(" · "), tone: od || r.tone === "bad" ? "bad" : aw || timeOff || r.tone === "warn" ? "warn" : "ok", timeOff, open: mine.length, overdue: od, awaiting: aw });
  };

  // Client care & delivery: the office lead.
  if (kyle) {
    const delivery = stage("delivery");
    const pre = stage("pre");
    const noShooter = pre?.items.filter((i) => i.blocked === "No photographer assigned").length ?? 0;
    push({ key: "office", person: kyle.name, personKey: kyle.key, tmId: kyle.teamMemberId, area: "Client care & delivery", status: [delivery ? (delivery.counts.overdue ? `${delivery.counts.overdue} late to send` : "Covered") : "Delivery couldn't load", noShooter ? `${noShooter} shoot${noShooter === 1 ? "" : "s"} with no photographer` : null].filter(Boolean).join(" · "), tone: delivery?.counts.overdue || noShooter ? "bad" : delivery ? "ok" : "warn" });
  }
  // Creative management & review: the creative manager / the review seat.
  const approverId = rules?.creativeApproverTeamMemberId ?? managers[0]?.id ?? null;
  const approver = approverId ? roster.find((a) => a.teamMemberId === approverId) : null;
  if (approver) {
    const review = stage("review");
    const mineToReview = review?.items.filter((i) => i.id.startsWith("cut:") && i.owner === approver.name) ?? [];
    const oldest = mineToReview.reduce<number | null>((m, i) => (i.waitingSinceISO ? Math.max(m ?? 0, (nowMs - Date.parse(i.waitingSinceISO)) / HOUR) : m), null);
    push({ key: "creative", person: approver.name, personKey: approver.key, tmId: approver.teamMemberId, area: "Creative management & review", status: review ? (mineToReview.length ? `${plural(mineToReview.length, "cut")} to review${oldest != null ? `, oldest ${Math.round(oldest)}h` : ""}` : "Covered") : "Review couldn't load", tone: mineToReview.some((i) => i.late) ? "bad" : mineToReview.length ? "warn" : "ok" });
  }
  // Post-production: the editors on the routing rules.
  const editorKeys = routing ? [...new Set([routing.standardVideo, routing.premiumVideo, routing.personalBranding].filter((k): k is NonNullable<typeof k> => !!k).map(String))] : [];
  const editing = stage("editing");
  const unassignedEdits = editing?.items.filter((i) => i.blocked === "No editor assigned").length ?? 0;
  push({
    key: "editors",
    person: editorKeys.length ? editorKeys.map((k) => roster.find((a) => a.key === k)?.name ?? firstName(k)).join(", ") : "Editors",
    personKey: null,
    area: "Post-production",
    status: editing ? (unassignedEdits ? `${plural(unassignedEdits, "unassigned job")}` : editing.counts.overdue ? `${editing.counts.overdue} late in editing` : "Covered") : "Editing couldn't load",
    tone: unassignedEdits || editing?.counts.overdue ? "bad" : editing ? "ok" : "warn",
  });
  // Field: photographers with shoots coming up or uploads owed.
  const capture = stage("capture");
  const field = roster.filter((a) => a.kind === "photographer" && a.teamMemberId);
  if (capture || field.length) {
    const owed = capture?.items.length ?? 0;
    push({ key: "field", person: field.map((f) => f.name).filter((n) => !/^jordan$/i.test(n)).join(", ") || "Photographers", personKey: null, area: "Field shoots & uploads", status: capture ? (owed ? `${plural(owed, "upload")} owed` : "Covered") : "Uploads couldn't load", tone: capture?.counts.overdue ? "bad" : owed ? "warn" : capture ? "ok" : "warn" });
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
export type WeeklyPerformance = { measures: Measure[]; updatedISO: string };

export async function weeklyPerformance(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<WeeklyPerformance> {
  const now = opts.now ?? new Date();
  const weekStart = etWeekStart(now);
  const exclude = opts.excludeClientIds ?? [];
  const in7 = new Date(now.getTime() + 7 * DAY);
  const [week, upcoming, quality] = await Promise.all([
    ownerWeek(now, { excludeClientIds: exclude }).catch(warn("week")),
    prisma.appointment.findMany({ where: { startAt: { gte: now, lte: in7 }, OR: [{ status: null }, { status: { not: "CANCELED" } }], project: { status: { not: "CANCELLED" }, ...(exclude.length ? { clientId: { notIn: exclude } } : {}) } }, select: { assignedToId: true } }).catch(warn("upcoming shoots")),
    import("@/lib/revisionQuality").then((m) => m.revisionQuality(30, { includeTest: false, now })).catch(warn("revision causes")),
  ]);
  const period = `This week, ${etMonthDay(weekStart)} to now`;
  const pctOf = (ok: number, n: number) => (n ? Math.round((ok / n) * 100) : null);
  const measures: Measure[] = [];
  if (week) {
    const t = week.thisWeek, l = week.lastWeek;
    const onTime = (label: string, key: string, s: { judged: number; onTime: number; onTimePct: number | null }, last: { onTimePct: number | null; judged: number }, source: string) => {
      const enough = s.judged >= ON_TIME_MIN_JOBS && s.onTimePct != null;
      measures.push({
        key, label, value: enough ? `${s.onTimePct}%` : s.judged ? "Too few" : "None yet",
        detail: `${s.onTime} of ${s.judged} on time${last.judged >= ON_TIME_MIN_JOBS && last.onTimePct != null ? ` · last week ${last.onTimePct}%` : ""}`,
        period, source, tone: !enough ? null : (s.onTimePct ?? 0) >= 90 ? "ok" : (s.onTimePct ?? 0) >= 75 ? "warn" : "bad",
      });
    };
    onTime("On-time photos", "photos", t.photos, l.photos, "Photo jobs delivered this week with a promise (photo delivery queue)");
    onTime("On-time listing videos", "videos", t.listingVideos, l.listingVideos, "Listing videos delivered this week with a promise (video outputs); monthly content apart");
    const delivered = t.listingVideos.delivered + t.monthlyVideos;
    measures.push({ key: "revisions", label: "Revision asks", value: delivered ? `${t.revisions} / ${delivered}` : `${t.revisions}`, detail: delivered ? `Client revision asks per video delivered${pctOf(t.revisions, delivered) != null ? ` (${pctOf(t.revisions, delivered)}%)` : ""} · last week ${l.revisions}` : `No videos delivered yet this week · last week ${l.revisions}`, period, source: "Client revision requests (one per ask), against videos delivered", tone: null });
    measures.push({ key: "replies", label: "Texts answered in 1 hour", value: t.replies.inbound ? `${t.replies.fastPct}%` : "None yet", detail: `${t.replies.fast} of ${t.replies.inbound} client texts${l.replies.fastPct != null ? ` · last week ${l.replies.fastPct}%` : ""}`, period, source: "Client texts and our next reply (OpenPhone); email isn't timed here", tone: t.replies.inbound ? ((t.replies.fastPct ?? 0) >= 90 ? "ok" : (t.replies.fastPct ?? 0) >= 70 ? "warn" : "bad") : null });
  } else {
    measures.push({ key: "week", label: "This week", value: "Couldn't load", detail: "The week's delivery and reply figures didn't load", period, source: "", tone: "warn" });
  }
  if (upcoming) {
    const covered = upcoming.filter((u) => !!u.assignedToId).length;
    measures.push({ key: "shoots", label: "Upcoming shoots covered", value: upcoming.length ? `${covered}/${upcoming.length}` : "None booked", detail: "Shoots in the next 7 days with a photographer assigned", period: `Next 7 days to ${etMonthDay(in7)}`, source: "Aryeo appointments", tone: upcoming.length && covered < upcoming.length ? "warn" : upcoming.length ? "ok" : null });
  }
  if (quality) {
    const top = [...quality.byCause].sort((a, b) => b.count - a.count)[0];
    measures.push({ key: "quality", label: "Top quality issue", value: top ? `${top.count}` : "None", detail: top ? `${top.label}, of ${quality.confirmedIssues} classified revision issues${quality.awaitingClassification ? ` (${quality.awaitingClassification} not classified yet)` : ""}` : `No classified revision issues${quality.awaitingClassification ? ` (${quality.awaitingClassification} awaiting classification)` : ""}`, period: "Last 30 days", source: "Revision issues by cause (the Quality page)", tone: null });
  }
  return { measures, updatedISO: now.toISOString() };
}

