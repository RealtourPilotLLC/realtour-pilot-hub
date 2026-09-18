import "server-only";
import { internalAlertRules } from "@/lib/settings";
import { etAt, etDayKey, etMinutesOfDay, isWeekdayET } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// WHEN IS SOMEBODY ACTUALLY THERE? (audit WF-06, Sep 18 2026)
//
// Jordan: "Normal coverage is Monday-Friday, 9 AM-6 PM Eastern. Continue
// capturing messages outside those hours, but queue routine alerts for the next
// covered period. Urgent coverage should use an explicitly assigned person, not
// assumed weekend availability."
//
// The paging path had no weekday awareness anywhere: commsSla.withinBusinessHours
// read the ET hour and nothing else, so 47 of the 196 reply-SLA pages in the
// last 90 days fired on a Saturday or Sunday, and 8 of 20 photos-undelivered
// alerts did too — those text Jordan and Kyle directly.
//
// THREE RULES, AND THE THIRD IS THE IMPORTANT ONE:
//   1. CAPTURE ALWAYS. Nothing here changes what the hub records. An unanswered
//      message is still logged, still counted, still on the board at 3am on a
//      Sunday. Coverage decides who gets WOKEN, never what gets seen.
//   2. ROUTINE DEFERS. An alert that can wait carries the next covered moment
//      instead of firing, and goes out when somebody is there to act on it.
//   3. URGENT FAILS SAFE. With an on-call person named, urgent goes to them.
//      With NOBODY named, urgent behaves exactly as it does today — it pages
//      the ADMIN/OWNER roles. Silence is the one outcome an urgent alert must
//      never have, so an unset rota degrades to the old behaviour rather than
//      swallowing the page.
// ---------------------------------------------------------------------------

export type Coverage = {
  weekdaysOnly: boolean;
  fromHour: number;
  toHour: number;
  onCallTeamMemberId: string | null;
};

export async function coverageRules(): Promise<Coverage> {
  return (await internalAlertRules()).coverage;
}

/** Is somebody on shift right now? */
export function withinCoverageAt(at: Date, c: Coverage): boolean {
  if (c.weekdaysOnly && !isWeekdayET(at)) return false;
  const mins = etMinutesOfDay(at);
  return mins >= c.fromHour * 60 && mins < c.toHour * 60;
}

export async function withinCoverage(at: Date = new Date()): Promise<boolean> {
  return withinCoverageAt(at, await coverageRules());
}

/**
 * The next instant somebody is on shift — `at` itself when that is already
 * true. Walks forward a day at a time, so a Friday evening lands on Monday
 * morning and a clock change cannot shift it (the walk is over ET day keys).
 */
export function nextCoveredMomentAt(at: Date, c: Coverage): Date {
  if (withinCoverageAt(at, c)) return at;
  // Later today, if today is covered and we are simply early.
  if ((!c.weekdaysOnly || isWeekdayET(at)) && etMinutesOfDay(at) < c.fromHour * 60) {
    return etAt(etDayKey(at), c.fromHour);
  }
  // Otherwise the start of the next covered day. 10 is enough for any weekend
  // plus a long holiday closure; the guard stops a misconfigured rule (every
  // day excluded) spinning.
  let key = etDayKey(at);
  for (let i = 0; i < 10; i++) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
    const candidate = etAt(key, c.fromHour);
    if (!c.weekdaysOnly || isWeekdayET(candidate)) return candidate;
  }
  return etAt(key, c.fromHour);
}

export async function nextCoveredMoment(at: Date = new Date()): Promise<Date> {
  return nextCoveredMomentAt(at, await coverageRules());
}

/**
 * How an alert should be handled right now.
 *
 * `urgency` is decided by the caller from what it already knows (a VIP client,
 * an unhappy message, a second escalation tier) — it is NOT stored anywhere,
 * because a persisted severity is a second source of truth to keep in step.
 */
export type AlertRouting =
  | { send: "now"; toOnCall: string | null; why: string }
  | { send: "defer"; until: Date; why: string };

export async function routeAlert(
  urgency: "routine" | "urgent",
  at: Date = new Date(),
): Promise<AlertRouting> {
  const c = await coverageRules();
  if (withinCoverageAt(at, c)) return { send: "now", toOnCall: null, why: "within covered hours" };
  if (urgency === "urgent") {
    return c.onCallTeamMemberId
      ? { send: "now", toOnCall: c.onCallTeamMemberId, why: "urgent, out of hours — the named on-call" }
      : // Fail safe, and say so: the alert still goes, to whoever it would have
        // gone to before. Naming somebody in Settings is what changes this.
        { send: "now", toOnCall: null, why: "urgent, out of hours, nobody on call — sent the old way" };
  }
  return { send: "defer", until: nextCoveredMomentAt(at, c), why: "routine, out of hours" };
}

/** Plain-English coverage, for a settings screen or an alert's own footnote. */
export function describeCoverage(c: Coverage): string {
  const h = (n: number) => (n === 12 ? "12pm" : n > 12 ? `${n - 12}pm` : `${n}am`);
  const days = c.weekdaysOnly ? "Mon–Fri" : "every day";
  return `${days}, ${h(c.fromHour)}–${h(c.toHour)} ET`;
}
