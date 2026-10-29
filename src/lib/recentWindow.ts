// ---------------------------------------------------------------------------
// THE LAST SEVEN DAYS OPEN, THE REST FOLDED (Jordan and James, Oct 29 2026:
// "A client's message history overwhelmed the QC review ... make it
// collapsible and default to a recent window, such as seven days"). The job
// page already folds its feed at ten days (Oct 28); the review and task
// screens that list a client's messages or notes fold at seven with this.
// Pure: the screens and the drill read the same split.
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 7;

const DAY = 86_400_000;

/**
 * Split `items` (in whatever order the screen shows them) into the ones from
 * the last `days` and the older ones, keeping each side's order. An item with
 * no readable date stays in the recent side (nothing to fold it by). When
 * nothing is recent, the newest item stays in view so the screen never opens
 * on an empty list with everything behind "Show older". `now` comes from the
 * caller (the server's time on a page, the moment a conversation was fetched
 * on a client screen), never the clock while rendering, so the server and the
 * browser always fold the same items.
 */
export function splitRecent<T>(
  items: readonly T[],
  at: (item: T) => string | Date | null | undefined,
  now: Date,
  days: number = RECENT_DAYS,
): { recent: T[]; older: T[] } {
  const cutoff = now.getTime() - days * DAY;
  const time = (item: T): number | null => {
    const v = at(item);
    const t = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const recent: T[] = [];
  const older: T[] = [];
  for (const item of items) {
    const t = time(item);
    (t == null || t >= cutoff ? recent : older).push(item);
  }
  if (!recent.length && older.length) {
    let newest = 0;
    for (let i = 1; i < older.length; i++) if ((time(older[i]) ?? 0) > (time(older[newest]) ?? 0)) newest = i;
    recent.push(older[newest]);
    older.splice(newest, 1);
  }
  return { recent, older };
}

/** "Show 4 older messages (more than 7 days ago)". */
export function olderLabel(count: number, noun: string, days: number = RECENT_DAYS): string {
  return `Show ${count} older ${noun}${count === 1 ? "" : "s"} (more than ${days} days ago)`;
}
