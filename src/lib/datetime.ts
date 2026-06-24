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
  return new Date(utcMidnightOfEtDate + etOffsetMs(d));
}
export const etAddDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);
