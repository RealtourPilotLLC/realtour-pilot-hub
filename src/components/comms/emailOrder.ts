// ---------------------------------------------------------------------------
// NEWEST EMAIL FIRST, ONE WEEK OPEN (Jordan, Oct 27 2026: "newest emails should
// be at the top so we dont have to scroll to the bottom. Older than 7 days
// should be collapsed.").
//
// Every email thread the hub shows (Messages · Email, the client page's Email
// card) reads its messages through these two helpers: newest at the top, and
// anything older than seven days folded under "Show N older emails", closed
// until someone opens it. The newest message always shows, however old, so an
// opened thread is never just a fold.
//
// Plain module (no server-only imports): the client lists and the drill both
// read it.
// ---------------------------------------------------------------------------

export const EMAIL_OPEN_DAYS = 7;
const DAY_MS = 86_400_000;

type When = Date | string | number | null | undefined;

const msOf = (v: When): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return Number.NaN;
};

/** Newest first. Equal times keep their incoming order; an unreadable time
 *  sorts last. */
export function emailNewestFirst<T>(items: readonly T[], at: (m: T) => When): T[] {
  const key = (m: T) => {
    const t = msOf(at(m));
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return items
    .map((m, i) => ({ m, i, t: key(m) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .map((x) => x.m);
}

/** Newest first, split at seven days: `recent` shows, `older` folds. When
 *  every message is older than that, the newest one still shows. */
export function foldOlderEmails<T>(
  items: readonly T[],
  at: (m: T) => When,
  nowMs: number,
  days = EMAIL_OPEN_DAYS,
): { recent: T[]; older: T[] } {
  const sorted = emailNewestFirst(items, at);
  const cut = nowMs - days * DAY_MS;
  let n = 0;
  while (n < sorted.length && msOf(at(sorted[n])) >= cut) n++;
  if (n === 0 && sorted.length > 0) n = 1;
  return { recent: sorted.slice(0, n), older: sorted.slice(n) };
}

/** The fold's label: "Show 3 older emails". */
export function olderEmailsLabel(n: number): string {
  return `Show ${n} older email${n === 1 ? "" : "s"}`;
}
