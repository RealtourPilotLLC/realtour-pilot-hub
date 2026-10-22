import "server-only";

// ---------------------------------------------------------------------------
// FIXED PAY: THE ONE COPY OF THE TERMS (Oct 22 2026).
//
// Harrison Wells and James Livingston moved from per-shoot percentage pay to a
// fixed yearly service fee plus a fixed vehicle amount. Jordan, Oct 22 2026:
// "Oct 9 pay was the new pay structure." The Oct 9 payday paid the Sep 20 to
// Oct 3 period, so every pay period that STARTS on or after Sep 20 2026 is
// fixed pay for them, in full.
//
//   · one payment per pay period = the yearly amount ÷ 26, to the cent
//     (James $2,776.92 + $300.00 = $3,076.92; Harrison $2,238.46 + $300.00 =
//     $2,538.46). The yearly amounts are the terms; the cents follow.
//   · the vehicle amount REPLACES mileage: never mileage on top.
//   · KPI bonuses, the $200 weekend/holiday premium and commissions are paid
//     on their own (today as payroll adjustments, PayoutAdjustment).
//
// OWNER ONLY. Pay is hidden from everyone but the owner (settings.payHiddenFor).
// "server-only" keeps these figures out of any browser bundle: a client
// component gets the computed block from the server, never this table.
//
// Who is on fixed pay is decided HERE, by exact roster name (case-insensitive)
// on an ACTIVE TeamMember row. Their old percent and floor stay on the row
// (the savings comparison reads them); the code decides, not the row.
// ---------------------------------------------------------------------------

// ---- bi-weekly pay periods (lib/payroll.ts reads these) -----------------------
/** A real period start; every period is 14 days from here. */
export const PAY_PERIOD_ANCHOR = "2026-05-31";
export const PAY_PERIOD_DAYS = 14;
/** Payments a year: one per pay period. */
export const PAYMENTS_PER_YEAR = 26;

/** The first pay period on fixed pay: Sep 20 to Oct 3 2026, paid Fri Oct 9. */
export const FIXED_PAY_FROM = "2026-09-20";
/** The first KPI bonus period (then calendar quarters). */
export const FIRST_BONUS_PERIOD = { startKey: "2026-09-25", endKey: "2026-12-31" } as const;

export type FixedPayKey = "james" | "harrison";

export type FixedPayTerms = {
  key: FixedPayKey;
  /** the roster name, matched exactly (case-insensitive, spaces collapsed) */
  fullName: string;
  first: string;
  /** a year */
  serviceFee: number;
  /** a year; replaces mileage */
  vehicle: number;
  /** the most the quarterly KPI bonus can pay in one bonus period */
  bonusMax: number;
  /** the per-shoot rates they had before fixed pay: the savings baseline when the row is cleared */
  old: { payPercent: number; payFloor: number; mileageRate: number; homeRadiusMi: number };
};

export const FIXED_PAY: Record<FixedPayKey, FixedPayTerms> = {
  james: {
    key: "james", fullName: "James Livingston", first: "James",
    serviceFee: 72_200, vehicle: 7_800, bonusMax: 1_500,
    old: { payPercent: 0.3, payFloor: 75, mileageRate: 0.65, homeRadiusMi: 35 },
  },
  harrison: {
    key: "harrison", fullName: "Harrison Wells", first: "Harrison",
    serviceFee: 58_200, vehicle: 7_800, bonusMax: 1_000,
    old: { payPercent: 0.35, payFloor: 100, mileageRate: 0.67, homeRadiusMi: 35 },
  },
};
export const FIXED_PAY_ORDER: FixedPayKey[] = ["james", "harrison"];

const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The fixed-pay terms for a roster row: an exact name match on an ACTIVE row, else null (per-shoot pay). */
export function fixedPayFor(member: { name: string | null | undefined; active: boolean | null | undefined } | null | undefined): FixedPayTerms | null {
  if (!member?.name || member.active !== true) return null;
  const n = normName(member.name);
  return FIXED_PAY_ORDER.map((k) => FIXED_PAY[k]).find((t) => normName(t.fullName) === n) ?? null;
}

// ---- period arithmetic (pure, on yyyy-mm-dd ET day keys) ----------------------
const DAY_MS = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const noonUtc = (key: string) => Date.parse(key + "T12:00:00Z");
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (key: string, n: number) => keyOf(noonUtc(key) + n * DAY_MS);
const daysBetween = (fromKey: string, toKey: string) => Math.round((noonUtc(toKey) - noonUtc(fromKey)) / DAY_MS) + 1;
const short = (key: string, year = false) =>
  new Date(noonUtc(key)).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

/** The start (yyyy-mm-dd) of the pay period holding an ET day. */
export function payPeriodStartOf(dayKey: string): string {
  const idx = Math.floor((noonUtc(dayKey) - noonUtc(PAY_PERIOD_ANCHOR)) / (PAY_PERIOD_DAYS * DAY_MS));
  return keyOf(noonUtc(PAY_PERIOD_ANCHOR) + idx * PAY_PERIOD_DAYS * DAY_MS);
}

/** True when the ET day sits in a pay period that starts on or after FIXED_PAY_FROM. */
export function isFixedPayDay(dayKey: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dayKey) && payPeriodStartOf(dayKey) >= FIXED_PAY_FROM;
}

/** One pay period's payment, to the cent: the yearly amount ÷ 26. */
export function fixedPayment(terms: Pick<FixedPayTerms, "serviceFee" | "vehicle">): { serviceFee: number; vehicle: number; total: number } {
  const serviceFee = r2(terms.serviceFee / PAYMENTS_PER_YEAR);
  const vehicle = r2(terms.vehicle / PAYMENTS_PER_YEAR);
  return { serviceFee, vehicle, total: r2(serviceFee + vehicle) };
}

export type FixedPayPeriodPart = {
  startKey: string;
  endKey: string;
  /** days of this period inside the asked range (14 = the whole payment) */
  days: number;
  serviceFee: number;
  vehicle: number;
  total: number;
};

export type FixedPayInRange = {
  serviceFee: number;
  vehicle: number;
  total: number;
  periods: FixedPayPeriodPart[];
  /** plain words for the card: "Sep 20 to Oct 3 pay period", "2 pay periods and 9 days, Sep 20 to Oct 22" */
  periodsLabel: string;
};

/**
 * Fixed pay owed for an ET day range [startKey, endKey], both inclusive: every
 * pay period overlapping the range that starts on or after FIXED_PAY_FROM. A
 * whole period inside the range is exactly one payment (÷ 26, to the cent); a
 * period the range only partly covers pays that payment × overlapping days ÷ 14.
 * Periods before FIXED_PAY_FROM pay nothing here (they are per-shoot pay).
 */
export function fixedPayInRange(terms: Pick<FixedPayTerms, "serviceFee" | "vehicle">, startKey: string, endKey: string): FixedPayInRange {
  const empty: FixedPayInRange = { serviceFee: 0, vehicle: 0, total: 0, periods: [], periodsLabel: "no fixed-pay periods" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey) || startKey > endKey) return empty;
  const pay = fixedPayment(terms);
  const periods: FixedPayPeriodPart[] = [];
  // Guarded walk: a range of many years still ends (27 periods a year).
  for (let p = payPeriodStartOf(startKey), guard = 0; p <= endKey && guard < 2000; p = addDays(p, PAY_PERIOD_DAYS), guard++) {
    if (p < FIXED_PAY_FROM) continue;
    const pEnd = addDays(p, PAY_PERIOD_DAYS - 1);
    const from = startKey > p ? startKey : p;
    const to = endKey < pEnd ? endKey : pEnd;
    const days = daysBetween(from, to);
    if (days <= 0) continue;
    const whole = days === PAY_PERIOD_DAYS;
    const serviceFee = whole ? pay.serviceFee : r2((pay.serviceFee * days) / PAY_PERIOD_DAYS);
    const vehicle = whole ? pay.vehicle : r2((pay.vehicle * days) / PAY_PERIOD_DAYS);
    periods.push({ startKey: p, endKey: pEnd, days, serviceFee, vehicle, total: r2(serviceFee + vehicle) });
  }
  if (periods.length === 0) return empty;
  const serviceFee = r2(periods.reduce((s, x) => s + x.serviceFee, 0));
  const vehicle = r2(periods.reduce((s, x) => s + x.vehicle, 0));
  return { serviceFee, vehicle, total: r2(serviceFee + vehicle), periods, periodsLabel: periodsLabel(periods, startKey, endKey) };
}

function periodsLabel(periods: FixedPayPeriodPart[], startKey: string, endKey: string): string {
  const full = periods.filter((x) => x.days === PAY_PERIOD_DAYS);
  const partDays = periods.filter((x) => x.days !== PAY_PERIOD_DAYS).reduce((s, x) => s + x.days, 0);
  if (periods.length === 1 && full.length === 1) return `${short(full[0].startKey)} to ${short(full[0].endKey)} pay period`;
  const from = periods[0].startKey > startKey ? periods[0].startKey : startKey;
  const last = periods[periods.length - 1];
  const to = last.endKey < endKey ? last.endKey : endKey;
  const parts = [
    full.length > 0 ? `${full.length} pay period${full.length === 1 ? "" : "s"}` : null,
    partDays > 0 ? `${partDays} day${partDays === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" and ");
  return `${parts}, ${short(from)} to ${short(to, true)}`;
}
