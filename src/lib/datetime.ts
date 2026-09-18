// All RealTour dates are shown/bucketed in US Eastern (the business runs on ET).
// The server runs in UTC (Vercel), so date-fns `format()` would show UTC times —
// e.g. a 1pm EDT shoot as "5:00 PM". Use these Intl-based helpers instead.

export const TZ = "America/New_York";

function fmt(d: Date, opts: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).format(d);
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (d: Date | string | null | undefined): Date | null => {
  if (!d) return null;
  // A bare day key is a CALENDAR DAY, not an instant. `new Date("2026-09-02")`
  // is UTC midnight, which is 8 PM ET the day BEFORE — so every day-key the
  // finance and books screens printed came out one day early ("as of Tue,
  // Sep 1" for a balance synced on the 2nd). Anchor it at noon UTC, which is
  // the same calendar day in every US timezone.
  const x = typeof d === "string" ? new Date(DAY_KEY.test(d) ? `${d}T12:00:00Z` : d) : d;
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
// UTC − ET at the instant `d` (4h in summer, 5h in winter), read off Intl's
// own ET wall clock. The old version parsed two toLocaleString() strings
// through `new Date(...)`, i.e. through the MACHINE's zone — exact on Vercel
// (UTC), but on a Mac set to New York the two parses straddle the local DST
// flip on the two changeover days and come back an hour short, which put
// every ET wall-clock between midnight and 2 AM on those days an hour off
// (review, Sep 13: "2026-03-08T01:30" → 12:30 AM). Intl never goes through
// the local zone, so this reads the same everywhere.
const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function etOffsetMs(d: Date): number {
  const parts = ET_PARTS.formatToParts(d);
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return d.getTime() - wall;
}
export function etDayStartUtc(d: Date = new Date()): Date {
  const dayKey = etDayKey(d);
  const utcMidnightOfEtDate = Date.parse(dayKey + "T00:00:00Z");
  // Refine once: DST flips at 2am, never midnight, so the offset AT the
  // guessed midnight (within ±1h of the true one) is always the right one.
  // Sampling only at `d` was an hour off whenever d sat on the other side of
  // a transition from the midnight it was deriving (every DST eve/day).
  const guess = new Date(utcMidnightOfEtDate + etOffsetMs(d));
  const refined = new Date(utcMidnightOfEtDate + etOffsetMs(guess));
  // Belt and braces: hand back the candidate that Intl itself reads as
  // 00:00 on this ET day. The refine is right by construction now, but a
  // midnight that is an hour off is exactly the bug this file has had twice,
  // so check the answer rather than trust the derivation.
  for (const m of [refined, guess, new Date(refined.getTime() - 3_600_000), new Date(refined.getTime() + 3_600_000)]) {
    if (etDayKey(m) === dayKey && etTime(m) === "12:00 AM") return m;
  }
  return refined;
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
  // Not "midnight + hour × 60 minutes" any more (review, Sep 13): on the two
  // changeover days the day is 23 or 25 hours long, so counting minutes from
  // midnight put every wall clock after the 2 AM flip an hour off — 5 PM on
  // Mar 8 2026 came out 6 PM EDT, and the 5 PM default due of etEndOfDay
  // with it. Instead: read the wall clock as if it were UTC, pull it back by
  // the ET offset AT that instant, refine (the first guess can sit on the
  // other side of the flip from the answer), and check with Intl that the
  // instant really reads as the wall clock asked for.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return new Date(NaN);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  const n = new Date(naive);
  const pad = (x: number) => String(x).padStart(2, "0");
  const want = `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}T${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`;
  let guess = new Date(naive + etOffsetMs(n));
  for (let i = 0; i < 2; i++) {
    if (etWallMinute(guess) === want) return guess;
    guess = new Date(naive + etOffsetMs(guess));
  }
  // A wall clock that does not exist (2:30 AM on spring-forward day) has no
  // exact answer; this lands an hour either side of it, consistently.
  return guess;
}
// "YYYY-MM-DDTHH:mm" on the ET wall clock — what etAt() is asked for, read
// back off the instant it produced.
function etWallMinute(d: Date): string {
  const parts = ET_PARTS.formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** End of the working day (5pm ET) — the default when a due date has no time. */
export const etEndOfDay = (dayKey: string) => etAt(dayKey, 17);

/** The current ET year ("2026") and its Jan-1 key — finance tabs hard-coded
 *  "2026-01-01" and would have silently frozen at New Year (audit Aug 25). */
export const etYear = () => Number(etDayKey(new Date()).slice(0, 4));
export const etYearStartKey = () => `${etYear()}-01-01`;

// ---------------------------------------------------------------------------
// BUSINESS DAYS — ONE IMPLEMENTATION (audit S0, Sep 18 2026).
//
// There were four. programMonths.addBusinessDaysET walked ET DAY KEYS and was
// right; turnaround.ts, tasks.ts and portal.ts each added 86_400_000 ms in a
// loop, which is a day only when the clocks do not change — so across the March
// and November transitions they drifted an hour and could land a "4 business
// day" deadline on the wrong side of midnight. These are the canonical ones;
// the old copies re-export from here rather than keeping their own arithmetic.
//
// Weekends are not business days. Holidays are deliberately NOT modelled: the
// business does not keep a holiday calendar yet, and inventing one here would
// quietly move real client deadlines. That is a settings question, not a
// datetime one.
// ---------------------------------------------------------------------------

/** Is this instant a Monday-to-Friday in Eastern Time? */
export function isWeekdayET(d: Date = new Date()): boolean {
  const dow = new Date(`${etDayKey(d)}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** The ET day key `days` business days after `from`. Day-key arithmetic, so a
 *  clock change cannot shift the answer. `days` of 0 returns the same day. */
export function addBusinessDayKeysET(from: Date, days: number): string {
  let key = etDayKey(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return key;
}

/** `days` business days after `from`, at midnight ET. */
export function addBusinessDaysET(from: Date, days: number): Date {
  return etAt(addBusinessDayKeysET(from, days), 0);
}

/**
 * `days` business days after `from`, landing at the END of that business day.
 *
 * This is what a promise quoted in DAYS means. "Four business days" is a day,
 * not an hour count: a Friday 9am premium shoot is due end of the following
 * Thursday, and no arithmetic in elapsed hours produces that — 96 hours from
 * Friday 9am is Tuesday 9am, three business days early and at the wrong time of
 * day (Jordan, Sep 18: "Four business days is not simply 96 elapsed hours").
 */
export function endOfBusinessDaysET(from: Date, days: number, hour = 17): Date {
  return etAt(addBusinessDayKeysET(from, days), hour);
}

/** Whole business days between two instants, counting forward from `from`. */
export function businessDaysBetweenET(from: Date, to: Date): number {
  if (to <= from) return 0;
  let n = 0;
  let key = etDayKey(from);
  const end = etDayKey(to);
  while (key < end) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** Minutes past midnight ET. */
export function etMinutesOfDay(d: Date = new Date()): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d)
    .split(":")
    .map(Number);
  return h * 60 + m;
}
