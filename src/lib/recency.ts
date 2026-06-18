import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// "Recent + moving forward" view window. The hub was back-filled with a year of
// historical orders, most already delivered. Day-to-day views show only the
// last 2 weeks plus anything in the future — based on REAL dates (the Aryeo
// order date, shoot date, delivery date), never the DB import time. Older
// finished/stale jobs drop off the views; nothing is deleted (still in the DB).
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 14;

export function recentCutoff(days = RECENT_DAYS): Date {
  return new Date(Date.now() - days * 86400000);
}

// Prisma `where` fragment: show a project if any real date is within the window
// or in the future (upcoming shoots). `createdAt` is deliberately NOT used — it
// reflects when the row was imported, not when the order was placed.
export function recentProjectWhere(days = RECENT_DAYS): Prisma.ProjectWhereInput {
  const cutoff = recentCutoff(days);
  return {
    OR: [
      { orderedAt: { gte: cutoff } }, // ordered in the last 2 weeks
      { shootDate: { gte: cutoff } }, // recent or upcoming shoot (moving forward)
      { deliveredAt: { gte: cutoff } }, // recently delivered
      { revisionRequestedAt: { gte: cutoff } }, // just reopened for changes
    ],
  };
}

// In-memory equivalent for lists already loaded (e.g. the dashboard).
export function isProjectRecent(
  p: {
    orderedAt: Date | null;
    shootDate: Date | null;
    deliveredAt: Date | null;
    revisionRequestedAt: Date | null;
  },
  days = RECENT_DAYS,
): boolean {
  const cutoff = recentCutoff(days);
  return [p.orderedAt, p.shootDate, p.deliveredAt, p.revisionRequestedAt].some(
    (d) => d != null && d >= cutoff,
  );
}
