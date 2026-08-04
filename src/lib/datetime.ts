// All RealTour dates are shown/bucketed in US Eastern (the business runs on ET).
// The server runs in UTC (Vercel), so date-fns `format()` would show UTC times —
// e.g. a 1pm EDT shoot as "5:00 PM". Use these Intl-based helpers instead.

export const TZ = "America/New_York";

function fmt(d: Date, opts: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).format(d);
}
const toDate = (d: Date | string | null | undefined): Date | null => {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return isNaN(x.getTime()) ? null : x;
};

export const etTime = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { hour: "numeric", minute: "2-digit" }) : ""; };
export const etDate = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { weekday: "short", month: "short", day: "numeric" }) : ""; };
export const etDateTime = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; };
export const etMonthDay = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { month: "short", day: "numeric" }) : ""; };
export const etDateYear = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { month: "short", day: "numeric", year: "numeric" }) : ""; };
export const etMonth = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { month: "short" }) : ""; };
export const etDayNum = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { day: "numeric" }) : ""; };
export const etFullDate = (d?: Date | string | null) => { const x = toDate(d); return x ? fmt(x, { weekday: "long", month: "long", day: "numeric" }) : ""; };

// ET calendar-day key "YYYY-MM-DD" (DST-safe via Intl) — for comparing/bucketing.
export const etDayKey = (d: Date): string => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA");
export function etDaysAgo(d: Date): number {
  const today = Date.parse(etDayKey(new Date()) + "T00:00:00Z");
  const day = Date.parse(etDayKey(d) + "T00:00:00Z");
  return Math.round((today - day) / 86400000); // +past, -future, 0 today
}
export const isTodayET = (d: Date) => etDaysAgo(d) === 0;
export const isYesterdayET = (d: Date) => etDaysAgo(d) === 1;

// ET day boundaries as UTC Date objects, for DB range queries.
function etOffsetMs(d: Date): number {
  const asUtc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const asEt = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  return asUtc.getTime() - asEt.getTime();
}
export function etDayStartUtc(d: Date = new Date()): Date {
  const utcMidnightOfEtDate = Date.parse(etDayKey(d) + "T00:00:00Z");
  // Refine once: DST flips at 2am, never midnight, so the offset AT the
  // guessed midnight (within ±1h of the true one) is always the right one.
  // Sampling only at `d` was an hour off whenever d sat on the other side of
  // a transition from the midnight it was deriving (every DST eve/day).
  const guess = new Date(utcMidnightOfEtDate + etOffsetMs(d));
  return new Date(utcMidnightOfEtDate + etOffsetMs(guess));
}
export const etAddDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

/**
 * A wall-clock ET time on an ET day, as a real instant. DST-safe.
 *
 * Use this instead of writing an offset into a date string. `"...T17:00:00-04:00"`
 * is 5pm Eastern for eight months of the year and 4pm for the other four, and
 * `"...T17:00:00Z"` is 1pm Eastern in summer and noon in winter — both silently
 * drift when the clocks change. This derives the offset from the day itself.
 *
 * @param dayKey ET calendar day, "YYYY-MM-DD" (as produced by etDayKey)
 */
export function etAt(dayKey: string, hour: number, minute = 0): Date {
  // Noon UTC is 7-8am ET — the same ET day as dayKey either side of a DST flip,
  // which is all etDayStartUtc needs to resolve the correct midnight.
  const midnight = etDayStartUtc(new Date(`${dayKey}T12:00:00Z`));
  return new Date(midnight.getTime() + (hour * 60 + minute) * 60_000);
}

/** End of the working day (5pm ET) — the default when a due date has no time. */
export const etEndOfDay = (dayKey: string) => etAt(dayKey, 17);
