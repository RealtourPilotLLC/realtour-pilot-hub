import "server-only";
import { prisma } from "@/lib/prisma";
import { computePayroll, periodBounds, shootPay, type PayrollJob, type PayrollPerson } from "@/lib/payroll";
import { PACKAGE_RULES, STRIPE_PROGRAM_PRICES, type ProgramPackage } from "@/lib/contentProgram";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { etDayKey } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth/user";
import { canSeeMoney } from "@/lib/auth/access";
import { authEnforcedNow } from "@/lib/auth/enforced";
import { usd0 } from "@/lib/money";
import {
  FIXED_PAY, FIXED_PAY_ORDER, FIXED_PAY_FROM, FIRST_BONUS_PERIOD,
  fixedPayFor, fixedPayInRange, type FixedPayKey,
} from "@/lib/payStructure";

// ---------------------------------------------------------------------------
// OLD PAY vs NEW PAY: WHAT THE NEW PAY STRUCTURE SAVES (Jordan, Oct 21 2026).
//
// "I want to be able to track how much I am saving monthly with this new pay
//  structure. So I want to see what it would cost on the old vs what it would
//  cost on the new, and we need to make sure that branding sessions even
//  though they say $0 in aryeo, those are tracked on the old payroll at the
//  prices that clients are currently paying for the 3 different tiers."
//
// OWNER ONLY (Jordan, Oct 27 2026: "Only I see old pay and new pay").
// Harrison and James see their own pay on My Pay, never this comparison, and
// Kyle never sees team pay: the page is Finance (owner tabs), and
// ownerPaySavings() below refuses any other viewer on its own, so the figures
// cannot be fetched around the page.
//
// Both sides start with the first fixed-pay period, Sep 20 2026 (paid Oct 9;
// Jordan, Oct 22 2026: "Oct 9 pay was the new pay structure").
//
// OLD = the per-shoot engine in lib/payroll.ts with fixed pay switched off
// (oldModel), the pass /payouts ran before Sep 20, over the shoots each person
// actually did, attributed to months by shoot day. Two differences, both on
// purpose and both shown on the page:
//   · mileage comes from the MileageDay cache only (cachedMileageOnly): this
//     page never calls the router; a day never worked out counts 0 miles;
//   · a content program session (a $0 order in Aryeo) is priced at what that
//     client pays for their tier, then the old percent and floor run on that.
// NEW = the fixed pay the pay periods pay (lib/payStructure.ts, the same
// figures Payroll pays: 1/26 of the yearly service fee + vehicle for each pay
// period, a period cut by the month's edge counted by its days out of 14),
// $200 for each weekend or company-holiday appointment (assumed approved: there
// is no approval record yet), commissions (not tracked in the hub yet, so $0)
// and the KPI bonus the scorecard gives (lib/kpi bands; paid, or the band the
// score is in now) spread over the bonus period's days (the first bonus
// period starts Sep 25). Until Oct 27 2026 this was the bonus MAXIMUM, a
// second bonus figure Jordan asked to remove.
//
// This computes; it pays nobody and changes nothing /payouts does.
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
const noonUtc = (key: string) => Date.parse(key + "T12:00:00Z");
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (fromKey: string, toKey: string) => Math.round((noonUtc(toKey) - noonUtc(fromKey)) / DAY_MS) + 1;
const lastDayOfMonth = (monthKey: string) => {
  const [y, m] = monthKey.split("-").map(Number);
  return keyOf(Date.UTC(y, m, 0, 12));
};
const nextMonthKey = (monthKey: string) => {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The first day the new pay structure applies (ET): the first fixed-pay period, paid Oct 9. */
export const NEW_PAY_EFFECTIVE_KEY = FIXED_PAY_FROM;
/** Each approved weekend or company-holiday appointment, on the new structure. */
export const WEEKEND_HOLIDAY_PREMIUM = 200;

export type PersonKey = FixedPayKey;

// The two people on the new structure, their terms and the old per-shoot
// rates they had: ONE copy, in lib/payStructure.ts (FIXED_PAY).
const PEOPLE_ORDER: PersonKey[] = FIXED_PAY_ORDER;

// ---- calendar ----------------------------------------------------------------

/** "YYYY-MM-DD" of the nth weekday (0 = Sunday) of a month; n = -1 is the last one. */
function nthWeekdayKey(year: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1, 12));
    const offset = (dow - first.getUTCDay() + 7) % 7;
    return keyOf(first.getTime() + (offset + 7 * (n - 1)) * DAY_MS);
  }
  const last = new Date(Date.UTC(year, month, 0, 12));
  const back = (last.getUTCDay() - dow + 7) % 7;
  return keyOf(last.getTime() - back * DAY_MS);
}

/** The company holidays the $200 premium covers, on the day itself (no observed-day shift). */
export function companyHolidayName(dayKey: string): string | null {
  const year = Number(dayKey.slice(0, 4));
  const md = dayKey.slice(5);
  if (md === "01-01") return "New Year's Day";
  if (md === "07-04") return "Independence Day";
  if (md === "12-25") return "Christmas";
  if (dayKey === nthWeekdayKey(year, 5, 1, -1)) return "Memorial Day";
  if (dayKey === nthWeekdayKey(year, 9, 1, 1)) return "Labor Day";
  if (dayKey === nthWeekdayKey(year, 11, 4, 4)) return "Thanksgiving";
  return null;
}

/** Why an appointment on this ET day earns the premium, or null. A holiday on a weekend is still one premium. */
export function premiumReason(dayKey: string): string | null {
  const holiday = companyHolidayName(dayKey);
  if (holiday) return holiday;
  const dow = new Date(noonUtc(dayKey)).getUTCDay();
  return dow === 6 ? "Saturday" : dow === 0 ? "Sunday" : null;
}

/** The KPI bonus period holding a day: Sep 25 to Dec 31 2026, then calendar quarters.
 *  A day before Sep 25 gets the first period too; the caller counts only the days inside it. */
export function bonusPeriodFor(dayKey: string): { startKey: string; endKey: string; label: string; days: number } {
  if (dayKey <= FIRST_BONUS_PERIOD.endKey) {
    const { startKey, endKey } = FIRST_BONUS_PERIOD;
    return { startKey, endKey, label: "Sep 25 to Dec 31 2026", days: daysBetween(startKey, endKey) };
  }
  const y = Number(dayKey.slice(0, 4));
  const q = Math.floor((Number(dayKey.slice(5, 7)) - 1) / 3);
  const startKey = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  const endKey = lastDayOfMonth(`${y}-${String(q * 3 + 3).padStart(2, "0")}`);
  return { startKey, endKey, label: `Q${q + 1} ${y}`, days: daysBetween(startKey, endKey) };
}

// ---- content program prices ---------------------------------------------------

const TIERS: ProgramPackage[] = ["Starter", "Accelerator", "Pro"];
const isTier = (p: string | null | undefined): p is ProgramPackage => TIERS.includes(p as ProgramPackage);

/** The current month-to-month list price of each tier: the highest live M2M Stripe price
 *  (Accelerator has two, $1,599 and $1,699; $1,699 is today's). */
export const TIER_LIST_PRICE: Record<ProgramPackage, number> = Object.fromEntries(
  TIERS.map((t) => [
    t,
    Math.max(0, ...Object.values(STRIPE_PROGRAM_PRICES).filter((p) => p.package === t && p.billingType === "MONTH_TO_MONTH").map((p) => p.amountCents / 100)),
  ]),
) as Record<ProgramPackage, number>;

type EnrollmentTerms = {
  package: string;
  sessionsPerMonth: number;
  billingType: string | null;
  billingRate: number | null;
  billingMonths: number | null;
  programKind: string | null;
  clientSuppliesTopics: boolean;
};

export type SessionPrice = {
  tier: string;
  /** what one month of the program costs this client (or the list price) */
  monthly: number;
  sessionsPerMonth: number;
  /** monthly ÷ sessions: the invoice one session stands for */
  perSession: number;
  source: "their rate" | "list price";
  terms: string;
  notes: string[];
};

/** What one session of this enrollment is worth: their billing terms, else the tier's list price. */
export function sessionPriceFor(e: EnrollmentTerms | null, fallbackTier?: string | null): SessionPrice {
  const notes: string[] = [];
  if (e?.programKind === "BULK") notes.push("bulk plan");
  if (e?.clientSuppliesTopics) notes.push("self-planned");
  const rate = e?.billingRate != null && Number.isFinite(e.billingRate) && e.billingRate > 0 ? e.billingRate : null;
  let monthly: number | null = null;
  let terms = "";
  if (e && rate != null) {
    if (e.billingType === "MONTHLY_CONTRACT") {
      monthly = rate;
      terms = `${usd0(rate)} a month on a ${e.billingMonths ? `${e.billingMonths}-month ` : ""}contract`;
    } else if (e.billingType === "MONTH_TO_MONTH") {
      monthly = rate;
      terms = `${usd0(rate)} a month, month to month`;
    } else if (e.billingType === "PAID_IN_FULL") {
      const months = e.billingMonths && e.billingMonths > 0 ? e.billingMonths : 12;
      monthly = rate / months;
      terms = `paid in full, ${usd0(rate)} over ${months} months`;
      if (!(e.billingMonths && e.billingMonths > 0)) notes.push("no term length on file, 12 months used");
    } else if (e.billingType === "TRIAL") {
      monthly = rate;
      terms = `trial month at ${usd0(rate)}`;
    }
  }
  if (monthly != null && e) {
    const rule = isTier(e.package) ? PACKAGE_RULES[e.package] : null;
    const sessions = e.sessionsPerMonth > 0 ? e.sessionsPerMonth : rule?.sessionsPerMonth ?? 1;
    return { tier: e.package, monthly: r2(monthly), sessionsPerMonth: sessions, perSession: r2(monthly / sessions), source: "their rate", terms, notes };
  }
  const named = e?.package ?? fallbackTier ?? null;
  const tier: ProgramPackage = isTier(named) ? named : "Accelerator";
  if (!isTier(named)) notes.push(named ? `"${named}" is not a tier, Accelerator used` : "tier unknown, Accelerator used");
  const sessions = PACKAGE_RULES[tier].sessionsPerMonth;
  const list = TIER_LIST_PRICE[tier];
  return {
    tier, monthly: list, sessionsPerMonth: sessions, perSession: r2(list / sessions), source: "list price",
    terms: `no billing terms on file: ${tier} list price ${usd0(list)} a month`, notes,
  };
}

// ---- the old engine's rates ------------------------------------------------------

export type OldRates = {
  payPercent: number;
  payFloor: number;
  mileageRate: number;
  homeRadiusMi: number;
  /** "team profile" = every figure from TeamMember; otherwise which ones fell back to the rates they had before fixed pay */
  fromProfile: boolean;
  fellBack: string[];
};

type MemberPay = { payPercent: number | null; payFloor: number | null; mileageRate: number | null; homeRadiusMi: number | null };

/** The member's pay fields when set; a cleared (or zero) field falls back to the rate they had before fixed pay. */
export function resolveOldRates(key: PersonKey, m: MemberPay | null): OldRates {
  const old = FIXED_PAY[key].old;
  const fellBack: string[] = [];
  const pick = (v: number | null | undefined, dflt: number, label: string) => {
    if (v != null && Number.isFinite(v) && v > 0) return v;
    fellBack.push(label);
    return dflt;
  };
  const rates = {
    payPercent: pick(m?.payPercent, old.payPercent, "percent"),
    payFloor: pick(m?.payFloor, old.payFloor, "floor"),
    mileageRate: pick(m?.mileageRate, old.mileageRate, "mileage rate"),
    homeRadiusMi: pick(m?.homeRadiusMi, old.homeRadiusMi, "home radius"),
  };
  return { ...rates, fromProfile: fellBack.length === 0, fellBack };
}

/** Exactly what the engine pays a line, at these rates (lib/payroll.ts computePayroll). */
export function oldLinePay(j: PayrollJob, r: Pick<OldRates, "payPercent" | "payFloor">): number {
  if (j.override?.flatAmount != null) return r2(j.override.flatAmount);
  if (j.returnTrip) return j.override?.invoiceOverride != null ? shootPay(j.override.invoiceOverride, r.payPercent, r.payFloor) : r2(r.payFloor);
  return shootPay(j.invoice, r.payPercent, r.payFloor);
}

// ---- output shapes --------------------------------------------------------------------

export type BrandingSessionLine = {
  projectId: string;
  title: string;
  clientName: string | null;
  dayKey: string;
  tier: string;
  monthly: number;
  sessionsPerMonth: number;
  /** the invoice the old percent ran on for this session */
  priceUsed: number;
  source: "their rate" | "list price" | "owner's invoice on the job" | "Aryeo invoice";
  terms: string;
  notes: string[];
  /** what the Aryeo order showed (usually $0) */
  aryeoInvoice: number;
  /** what the engine would pay on Aryeo's figure (usually the floor) */
  atAryeoPrice: number;
  /** what the old model pays at the price used */
  oldPay: number;
};

export type OldSide = {
  shoots: number;
  shootPay: number;
  sessions: BrandingSessionLine[];
  branding: number;
  mileage: number;
  miles: number;
  /** days whose miles were never worked out (counted as 0) */
  notComputedDays: number;
  /** shoots without a map location (not in any day's route) */
  noLocation: number;
  total: number;
};

export type PremiumLine = { projectId: string; title: string; dayKey: string; why: string };

export type NewSide = {
  days: number;
  /** what the pay periods pay for these days (lib/payStructure.ts fixedPayInRange) */
  regular: { serviceFee: number; vehicle: number; total: number; periodsLabel: string };
  premiums: { count: number; each: number; total: number; appointments: PremiumLine[] };
  commissions: { total: number; tracked: boolean };
  /** The KPI bonus this month carries: the scorecard's band amount for the
   *  bonus period (`periodAmount`; what was paid, once paid) spread over the
   *  period's days, `days` of them in this month (none before Sep 25). */
  bonus: PeriodBonusShare;
  total: number;
};

/** One person's KPI bonus for one bonus period, as the scorecard has it (lib/kpi). */
export type PeriodBonus = {
  periodKey: string;
  /** dollars for the whole period: what was paid, else the band the score is in now */
  amount: number;
  /** paid = a payout line exists; scorecard = the running or unpaid period's band now; unscored = no score yet, or it could not be read */
  source: "paid" | "scorecard" | "unscored";
  score: number | null;
  /** "80 to 89", or null with no score */
  band: string | null;
  /** the most the period could pay (the person's cap) */
  max: number;
};

export type PeriodBonusShare = PeriodBonus & { total: number; periodLabel: string; periodDays: number; days: number };

export type PersonMonth = {
  key: PersonKey;
  name: string;
  old: OldSide;
  new: NewSide;
  savings: number;
  /** PayoutAdjustment rows dated this month: shown, counted on neither side */
  adjustments: number;
};

export type MonthRow = {
  monthKey: string;
  label: string;
  fromKey: string;
  toKey: string;
  days: number;
  isCurrent: boolean;
  people: PersonMonth[];
  old: number;
  new: number;
  savings: number;
  /** savings since Sep 20 through the end of this row */
  runningSavings: number;
};

export type PersonSummary = {
  key: PersonKey;
  name: string;
  memberId: string | null;
  rates: OldRates;
  annual: number;
  serviceFee: number;
  vehicle: number;
  bonusMax: number;
  old: number;
  new: number;
  savings: number;
};

export type PaySavings = {
  asOfKey: string;
  effectiveKey: string;
  months: MonthRow[];
  currentMonth: MonthRow | null;
  people: PersonSummary[];
  /** someone on the new structure the roster has no row for */
  missing: string[];
  totals: { old: number; new: number; savings: number };
  notComputedDays: number;
  sessionsAtListPrice: number;
  sessionsAtTheirRate: number;
};

const monthLabel = (monthKey: string) =>
  new Date(noonUtc(`${monthKey}-01`)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Harrison's and James's roster rows, matched exactly as Payroll matches them
 *  (lib/payStructure.ts fixedPayFor: the full name on an active row, the oldest
 *  row when there are two), so this page compares the same people Payroll pays. */
async function findPeople(): Promise<Map<PersonKey, { id: string; name: string } & MemberPay>> {
  const rows = await prisma.teamMember.findMany({
    where: { active: true, OR: PEOPLE_ORDER.map((k) => ({ name: { contains: FIXED_PAY[k].first, mode: "insensitive" as const } })) },
    select: { id: true, name: true, active: true, createdAt: true, payPercent: true, payFloor: true, mileageRate: true, homeRadiusMi: true },
    orderBy: { createdAt: "asc" },
  });
  const out = new Map<PersonKey, { id: string; name: string } & MemberPay>();
  for (const r of rows) {
    const t = fixedPayFor(r);
    if (!t || out.has(t.key)) continue;
    out.set(t.key, { id: r.id, name: r.name, payPercent: r.payPercent, payFloor: r.payFloor, mileageRate: r.mileageRate, homeRadiusMi: r.homeRadiusMi });
  }
  return out;
}

type BrandingInfo = { price: SessionPrice; primaryDayKey: string | null; notes: string[] };

/**
 * Which shoots are content program sessions, and what each is worth.
 *
 * The real link is Project.contentMonthId: attachMonthlyProjects (lib/
 * contentProgram.ts) files every monthly-plan shoot of an enrolled client
 * under its ContentMonth, and the month names the enrollment. A shoot the
 * sweep has not reached yet (an enrolled client, monthly-plan deliverables,
 * no month) counts too, marked "not linked to a month yet". A branding shoot
 * for someone who is not enrolled is an ordinary paid order and keeps its
 * Aryeo invoice.
 */
async function brandingSessions(projectIds: string[]): Promise<Map<string, BrandingInfo>> {
  const out = new Map<string, BrandingInfo>();
  if (projectIds.length === 0) return out;
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: {
      id: true, clientId: true, contentMonthId: true, shootDate: true, packageName: true,
      client: { select: { socialPlan: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { label: true } },
      appointments: { where: { status: { not: "CANCELED" }, startAt: { not: null } }, select: { startAt: true }, orderBy: { startAt: "asc" }, take: 1 },
    },
  });
  const monthIds = [...new Set(projects.map((p) => p.contentMonthId).filter((x): x is string => !!x))];
  const months = monthIds.length
    ? await prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, enrollmentId: true } })
    : [];
  const clientIds = [...new Set(projects.map((p) => p.clientId).filter((x): x is string => !!x))];
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { OR: [{ id: { in: months.map((m) => m.enrollmentId) } }, { clientId: { in: clientIds } }] },
    select: { id: true, clientId: true, package: true, sessionsPerMonth: true, billingType: true, billingRate: true, billingMonths: true, programKind: true, clientSuppliesTopics: true },
  });
  const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));
  const enrollmentByClient = new Map(enrollments.map((e) => [e.clientId, e]));
  const monthEnrollment = new Map(months.map((m) => [m.id, m.enrollmentId]));
  for (const p of projects) {
    const notes: string[] = [];
    let e = p.contentMonthId ? enrollmentById.get(monthEnrollment.get(p.contentMonthId) ?? "") ?? null : null;
    if (p.contentMonthId && !e) {
      // Linked to a month whose enrollment row is gone: still a session; price it off the client's plan.
      notes.push("its program month has no enrollment on file");
    } else if (!p.contentMonthId) {
      const enrolled = p.clientId ? enrollmentByClient.get(p.clientId) ?? null : null;
      if (!enrolled || !isMonthlyContentJob(p.deliverables, p.packageName)) continue;
      e = enrolled;
      notes.push("not linked to a program month yet");
    }
    const first = p.appointments[0]?.startAt ?? p.shootDate ?? null;
    out.set(p.id, {
      price: sessionPriceFor(e, p.client?.socialPlan ?? null),
      primaryDayKey: first ? etDayKey(first) : null,
      notes,
    });
  }
  return out;
}

const emptyOld = (): OldSide => ({ shoots: 0, shootPay: 0, sessions: [], branding: 0, mileage: 0, miles: 0, notComputedDays: 0, noLocation: 0, total: 0 });

/**
 * The comparison, month by month from September 2026 (from Sep 20, the first
 * fixed-pay period) through today. Not gated: ownerPaySavings() is the guarded
 * door for pages.
 */
export async function computePaySavings(opts: { now?: Date } = {}): Promise<PaySavings> {
  const now = opts.now ?? new Date();
  const todayKey = etDayKey(now);
  const effectiveKey = NEW_PAY_EFFECTIVE_KEY;
  const people = await findPeople();
  const missing = PEOPLE_ORDER.filter((k) => !people.has(k)).map((k) => FIXED_PAY[k].fullName);

  const months: MonthRow[] = [];
  if (todayKey < effectiveKey) {
    return { asOfKey: todayKey, effectiveKey, months, currentMonth: null, people: [], missing, totals: { old: 0, new: 0, savings: 0 }, notComputedDays: 0, sessionsAtListPrice: 0, sessionsAtTheirRate: 0 };
  }

  // ONE engine pass per person over the whole stretch, mileage from the cache
  // only, fixed pay switched OFF (oldModel): this is what the old per-shoot pay
  // would have cost, never what Payroll pays now. Sequential on purpose (the
  // shared Neon pool; see kpi.ts).
  const { start, end } = periodBounds({ startKey: effectiveKey, endKey: todayKey });
  const runs = new Map<PersonKey, PayrollPerson | null>();
  for (const k of PEOPLE_ORDER) {
    const m = people.get(k);
    if (!m) continue;
    const out = await computePayroll(start, end, { memberId: m.id, cachedMileageOnly: true, oldModel: true });
    runs.set(k, out.find((p) => p.member.id === m.id) ?? null);
  }

  const allLines = [...runs.entries()].flatMap(([k, p]) => (p?.jobs ?? []).map((j) => ({ k, j })));
  const branding = await brandingSessions([...new Set(allLines.map((x) => x.j.projectId))]);

  // Which lines are sessions. The engine's primary line on a session shoot is
  // one; a later visit on ANOTHER day counts as a further session only when the
  // client buys more than one a month (Pro), once per day. Anything else on a
  // session shoot (a second shooter the same day, a reshoot) keeps the
  // engine's own pay.
  const sessionLine = new Set<string>();
  const claimed = new Set<string>();
  const lineId = (k: PersonKey, j: PayrollJob) => `${k}|${j.projectId}|${j.shootISO ?? j.dayKey}`;
  for (const { k, j } of [...allLines].sort((a, b) => (a.j.shootISO ?? "").localeCompare(b.j.shootISO ?? ""))) {
    const info = branding.get(j.projectId);
    if (!info) continue;
    const day = `${j.projectId}|${j.dayKey}`;
    if (!j.returnTrip) { sessionLine.add(lineId(k, j)); claimed.add(day); continue; }
    if (info.price.sessionsPerMonth > 1 && j.dayKey !== info.primaryDayKey && !claimed.has(day)) {
      sessionLine.add(lineId(k, j));
      claimed.add(day);
    }
  }

  // Months: September 2026 (from Sep 20) through this month (through today).
  const monthKeys: string[] = [];
  for (let mk = effectiveKey.slice(0, 7); mk <= todayKey.slice(0, 7); mk = nextMonthKey(mk)) monthKeys.push(mk);

  const summaries = new Map<PersonKey, PersonSummary>();
  for (const k of PEOPLE_ORDER) {
    const m = people.get(k);
    if (!m) continue;
    const t = FIXED_PAY[k];
    summaries.set(k, {
      key: k, name: m.name, memberId: m.id, rates: resolveOldRates(k, m),
      annual: t.serviceFee + t.vehicle, serviceFee: t.serviceFee, vehicle: t.vehicle, bonusMax: t.bonusMax,
      old: 0, new: 0, savings: 0,
    });
  }

  // THE BONUS IS THE SCORECARD'S (Jordan, Oct 27 2026, asked which of two
  // bonus figures is real: the bands, "but James has a different bonus
  // amount"). This page used to carry each period's MAXIMUM spread over its
  // days, a second bonus figure next to the one Finance → Bonus pays. Now each
  // bonus period counts what lib/kpi says: the amount paid, once a payout line
  // exists, else the band the score is in today (James $1,500 / $900 / $375,
  // Harrison $1,000 / $600 / $250 at 90+, 80 to 89, 70 to 79; nothing under
  // 70 or with no score yet). One read per person per period, sequential (the
  // shared Neon pool; see kpi.ts).
  const kpi = await import("@/lib/kpi");
  const bonusMemo = new Map<string, PeriodBonus>();
  const periodBonus = async (k: PersonKey, memberId: string, name: string, dayKey: string): Promise<PeriodBonus> => {
    const period = kpi.periodFor(dayKey);
    const memo = `${k}|${period.key}`;
    const hit = bonusMemo.get(memo);
    if (hit) return hit;
    const paid = await prisma.payoutAdjustment.findMany({ where: { teamMemberId: memberId, label: { startsWith: `Quarterly bonus ${period.key}` } }, select: { amount: true } });
    const card = await kpi.scorePeriod({ memberId, name, period, now }).catch(() => null);
    const out: PeriodBonus = {
      periodKey: period.key,
      amount: paid.length ? r2(paid.reduce((n, x) => n + x.amount, 0)) : r2(card?.bonus ?? 0),
      source: paid.length ? "paid" : card?.score != null ? "scorecard" : "unscored",
      score: card?.score ?? null,
      band: card?.band?.label ?? null,
      max: card?.possible ?? FIXED_PAY[k].bonusMax,
    };
    bonusMemo.set(memo, out);
    return out;
  };
  const isContractBonusLine = (label: string) => {
    const m = /^Quarterly bonus (\d{4}-Q[1-4])/.exec(label);
    return !!m && kpi.periodFromKey(m[1])?.legacy === false;
  };

  let running = 0;
  for (const mk of monthKeys) {
    const fromKey = `${mk}-01` < effectiveKey ? effectiveKey : `${mk}-01`;
    const toKey = lastDayOfMonth(mk) > todayKey ? todayKey : lastDayOfMonth(mk);
    const days = daysBetween(fromKey, toKey);
    const row: MonthRow = {
      monthKey: mk, label: monthLabel(mk), fromKey, toKey, days, isCurrent: mk === todayKey.slice(0, 7),
      people: [], old: 0, new: 0, savings: 0, runningSavings: 0,
    };
    for (const k of PEOPLE_ORDER) {
      const s = summaries.get(k);
      if (!s) continue;
      const t = FIXED_PAY[k];
      const run = runs.get(k) ?? null;
      const rates = s.rates;
      const inMonth = (dayKey: string) => dayKey >= fromKey && dayKey <= toKey;
      const lines = (run?.jobs ?? []).filter((j) => inMonth(j.dayKey));

      // ---- OLD -------------------------------------------------------------
      const old = emptyOld();
      for (const j of lines) {
        const info = branding.get(j.projectId);
        if (info && sessionLine.has(lineId(k, j))) {
          const aryeoInvoice = j.returnTrip ? r2(j.override?.invoiceOverride ?? 0) : j.invoice;
          let priceUsed: number;
          let source: BrandingSessionLine["source"];
          if (j.override?.invoiceOverride != null) { priceUsed = r2(j.override.invoiceOverride); source = "owner's invoice on the job"; }
          else if (aryeoInvoice > info.price.perSession) { priceUsed = aryeoInvoice; source = "Aryeo invoice"; }
          else { priceUsed = info.price.perSession; source = info.price.source; }
          const oldPay = j.override?.flatAmount != null ? r2(j.override.flatAmount) : shootPay(priceUsed, rates.payPercent, rates.payFloor);
          const notes = [...info.price.notes, ...info.notes];
          if (j.returnTrip) notes.push("a further session on a later day");
          if (j.override?.flatAmount != null) notes.push("flat amount set on Payroll");
          old.sessions.push({
            projectId: j.projectId, title: j.title, clientName: j.clientName, dayKey: j.dayKey,
            tier: info.price.tier, monthly: info.price.monthly, sessionsPerMonth: info.price.sessionsPerMonth,
            priceUsed, source, terms: info.price.terms, notes,
            aryeoInvoice, atAryeoPrice: oldLinePay(j, rates), oldPay,
          });
          old.branding = r2(old.branding + oldPay);
        } else {
          old.shoots += 1;
          old.shootPay = r2(old.shootPay + oldLinePay(j, rates));
        }
        if (!j.hasCoords) old.noLocation += 1;
      }
      // Mileage, day by day, exactly as the engine shares it (jobs on a
      // no-mileage override do not take a share).
      for (const d of (run?.days ?? []).filter((x) => inMonth(x.dayKey))) {
        const mileageJobs = lines.filter((j) => j.dayKey === d.dayKey && !j.override?.noMileage).length;
        if (mileageJobs === 0) continue;
        const payable = Math.max(d.miles - rates.homeRadiusMi * 2, 0);
        const share = r2((payable * rates.mileageRate) / mileageJobs);
        old.mileage = r2(old.mileage + share * mileageJobs);
        old.miles = r2(old.miles + d.miles);
        if (d.notComputed) old.notComputedDays += 1;
      }
      old.total = r2(old.shootPay + old.branding + old.mileage);

      // ---- NEW -------------------------------------------------------------
      // Regular pay: exactly what the pay periods pay for these days (the same
      // helper Payroll uses), never mileage on top.
      const regular = fixedPayInRange(t, fromKey, toKey);
      const premiumLines: PremiumLine[] = [];
      for (const j of lines) {
        const why = premiumReason(j.dayKey);
        if (why) premiumLines.push({ projectId: j.projectId, title: j.title, dayKey: j.dayKey, why });
      }
      // The bonus counts only the month's days inside a bonus period: the
      // first one starts Sep 25, so Sep 20 to 24 carry none. The amount is
      // the scorecard's (see periodBonus above), spread over the period's days.
      const bp = bonusPeriodFor(fromKey);
      const bonusFrom = fromKey > bp.startKey ? fromKey : bp.startKey;
      const bonusTo = toKey < bp.endKey ? toKey : bp.endKey;
      const bonusDays = bonusFrom <= bonusTo ? daysBetween(bonusFrom, bonusTo) : 0;
      const pb: PeriodBonus = bonusDays > 0
        ? await periodBonus(k, people.get(k)!.id, s.name, bonusFrom)
        : { periodKey: "", amount: 0, source: "unscored", score: null, band: null, max: t.bonusMax };
      const bonus = r2((pb.amount / bp.days) * bonusDays);
      const premiums = r2(premiumLines.length * WEEKEND_HOLIDAY_PREMIUM);
      const commissions = 0; // no sales attribution in the hub yet
      const next: NewSide = {
        days,
        regular: { serviceFee: regular.serviceFee, vehicle: regular.vehicle, total: regular.total, periodsLabel: regular.periodsLabel },
        premiums: { count: premiumLines.length, each: WEEKEND_HOLIDAY_PREMIUM, total: premiums, appointments: premiumLines },
        commissions: { total: commissions, tracked: false },
        bonus: { ...pb, total: bonus, periodLabel: bp.label, periodDays: bp.days, days: bonusDays },
        total: r2(regular.total + premiums + commissions + bonus),
      };

      // A contract period's bonus payout line is already on the new side
      // (above), so it is left out of the "counted on neither side" figure.
      const adjustments = r2((run?.adjustments ?? [])
        .filter((a) => inMonth(etDayKey(new Date(a.dateISO))) && !isContractBonusLine(a.label))
        .reduce((sum, a) => sum + a.amount, 0));
      const pm: PersonMonth = { key: k, name: s.name, old, new: next, savings: r2(old.total - next.total), adjustments };
      row.people.push(pm);
      row.old = r2(row.old + old.total);
      row.new = r2(row.new + next.total);
      s.old = r2(s.old + old.total);
      s.new = r2(s.new + next.total);
      s.savings = r2(s.old - s.new);
    }
    row.savings = r2(row.old - row.new);
    running = r2(running + row.savings);
    row.runningSavings = running;
    months.push(row);
  }

  const allSessions = months.flatMap((m) => m.people.flatMap((p) => p.old.sessions));
  const totals = months.reduce((t, m) => ({ old: r2(t.old + m.old), new: r2(t.new + m.new), savings: 0 }), { old: 0, new: 0, savings: 0 });
  totals.savings = r2(totals.old - totals.new);
  return {
    asOfKey: todayKey,
    effectiveKey,
    months,
    currentMonth: months.find((m) => m.isCurrent) ?? null,
    people: PEOPLE_ORDER.map((k) => summaries.get(k)).filter((x): x is PersonSummary => !!x),
    missing,
    totals,
    notComputedDays: months.reduce((n, m) => n + m.people.reduce((s, p) => s + p.old.notComputedDays, 0), 0),
    sessionsAtListPrice: allSessions.filter((x) => x.source === "list price").length,
    sessionsAtTheirRate: allSessions.filter((x) => x.source === "their rate").length,
  };
}

/** True only for an owner looking as the owner: the hub's money rule (canSeeMoney) on the
 *  previewed role, so "view as" anyone else shows what that person would see (nothing).
 *  No session at all is the owner view only while auth is off (local dev), exactly
 *  as the Finance page decides it; in production that fails closed. */
export async function canSeePaySavings(): Promise<boolean> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return !authEnforcedNow();
  return me.realRole === "OWNER" && canSeeMoney(me.role);
}

/** The guarded door: the comparison for the owner, a refusal for anyone else. */
export async function ownerPaySavings(opts: { now?: Date } = {}): Promise<PaySavings> {
  if (!(await canSeePaySavings())) throw new Error("Only the owner can see pay.");
  return computePaySavings(opts);
}
