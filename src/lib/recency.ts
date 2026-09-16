import type { Prisma, ProjectStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// "Recent + moving forward" view window. The hub was back-filled with a year of
// historical orders, most already delivered. Day-to-day views show only the
// last 2 weeks plus anything in the future — based on REAL dates (the Aryeo
// order date, shoot date, delivery date), never the DB import time. Older
// finished/stale jobs drop off the views; nothing is deleted (still in the DB).
//
// IMPORTANT: the window only ages out FINISHED work (Delivered/Cancelled). A
// job that's still active is ALWAYS shown regardless of age — a stalled job's
// dates never move, so the old date-only window made an undelivered job vanish
// from every screen at exactly 14 days, precisely when it most needed eyes
// (audit crack #9). The active set is small (~30 jobs), so this stays cheap.
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 14;

// Every non-terminal stage (everything but DELIVERED and CANCELLED) — never
// aged out of the day-to-day views.
//
// ON_HOLD belongs here (RTP-04, Sep 16 audit). It was the one non-terminal
// stage left out, and the hole was not theoretical: 56 Hillview Rd has been
// held since Jul 30 with the client's own words on the record ("the video that
// I just received … is supposed to be edited differently"), and because a held
// job matches no date in the window either, it appeared on NO screen at all.
// A hold is a decision to pause work, not a decision to stop watching it.
export const ACTIVE_STATUSES: ProjectStatus[] = [
  "BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION", "ON_HOLD",
];

export function recentCutoff(days = RECENT_DAYS): Date {
  return new Date(Date.now() - days * 86400000);
}

// Prisma `where` fragment: show a project if it's still ACTIVE (any age), or if
// any real date is within the window or in the future (upcoming shoots).
// `createdAt` is deliberately NOT used — it reflects when the row was imported,
// not when the order was placed.
export function recentProjectWhere(days = RECENT_DAYS): Prisma.ProjectWhereInput {
  const cutoff = recentCutoff(days);
  return {
    OR: [
      { status: { in: ACTIVE_STATUSES } }, // active work never ages off
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
    status?: ProjectStatus | string | null;
    orderedAt: Date | null;
    shootDate: Date | null;
    deliveredAt: Date | null;
    revisionRequestedAt: Date | null;
  },
  days = RECENT_DAYS,
): boolean {
  if (p.status && (ACTIVE_STATUSES as string[]).includes(p.status)) return true;
  const cutoff = recentCutoff(days);
  return [p.orderedAt, p.shootDate, p.deliveredAt, p.revisionRequestedAt].some(
    (d) => d != null && d >= cutoff,
  );
}
