// ---------------------------------------------------------------------------
// FORFEITED MONTHS (Oct 8 2026) — the pure half. No prisma, no server-only:
// the staff screens, the portal and a drill read the same rule.
//
// Jordan: "General rule of thumb, a missed month is a forfeited month. Only
// with our approval and discretion do we allow a catch-up session."
//
// A program month is FORFEITED when ALL of these hold:
//   · it is a live month (not imported history) still OPEN — a month staff
//     skipped, closed or caught up is already what it is;
//   · its ET calendar month is over;
//   · nothing was ever done on it: no shoot linked, no filming session booked
//     or asked for, no video, no filmed topic, no topics / answers / scripts
//     planned, and no strategy call booked or held for it.
// Anything partly done is NOT forfeited — it is what it is, and the office
// still owes (or is owed) that work.
//
// DERIVED, NEVER STORED. Nothing writes "forfeited" onto the row: the month
// stays OPEN in the database, so it is reversible by construction (a shoot
// linked to it later simply makes it not forfeited) and the catch-up flow can
// still pick it (monthCatchUp only accepts OPEN months). Every reader asks
// monthForfeit.forfeitedMonths, which loads the evidence below in a fixed set
// of grouped queries and hands it here.
// ---------------------------------------------------------------------------

export type ForfeitMonthRow = { monthKey: string; status: string; historical: boolean; strategyCallStatus?: string | null };

export type ForfeitEvidence = {
  /** Non-cancelled jobs linked to the month. */
  shoots: number;
  /** Filming sessions booked or asked for (REQUESTED / CONFIRMED / moving / cancelling). */
  sessionRequests: number;
  /** ContentVideo rows on the month. */
  videos: number;
  /** Topics already filmed, in editing or delivered on the month. */
  filmedTopics: number;
  /** Live topic selections, scripts and answer sets on the month. */
  plannedWork: number;
  /** Live monthly-strategy call records filed on the month. */
  calls: number;
};

export const NO_EVIDENCE: ForfeitEvidence = { shoots: 0, sessionRequests: 0, videos: 0, filmedTopics: 0, plannedWork: 0, calls: 0 };

/** "2026-10" for an instant, on the ET calendar. */
export function etMonthKeyOf(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}`;
}

/** The month's ET calendar month is over. */
export function monthEnded(monthKey: string, now: Date): boolean {
  return monthKey < etMonthKeyOf(now);
}

/** Could this month be forfeited at all (before looking at its evidence)? */
export function forfeitCandidate(m: ForfeitMonthRow, now: Date): boolean {
  return !m.historical && m.status === "OPEN" && monthEnded(m.monthKey, now);
}

/** THE RULE. */
export function isForfeited(m: ForfeitMonthRow, ev: ForfeitEvidence, now: Date): boolean {
  if (!forfeitCandidate(m, now)) return false;
  // A call booked or held for the month (a stored stamp counts — the legacy
  // sweep wrote those) is planning that happened: the month is not untouched.
  if (m.strategyCallStatus === "SCHEDULED" || m.strategyCallStatus === "COMPLETED") return false;
  return ev.shoots === 0 && ev.sessionRequests === 0 && ev.videos === 0 && ev.filmedTopics === 0 && ev.plannedWork === 0 && ev.calls === 0;
}

const nameOf = (monthKey: string) => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
};

/** Staff words for a forfeited month. Plain, no blame. */
export function forfeitedLine(monthKey: string): string {
  return `${nameOf(monthKey)} was missed, so it is forfeited — nothing is owed or chased.`;
}

export const FORFEITED_WORD = "Forfeited";
