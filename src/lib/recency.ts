import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// "Last 30 days" view window. The hub fills up with hundreds of finished jobs,
// so views show only CURRENT work: everything still active (any age) plus
// anything delivered/cancelled within this window. Older finished jobs are
// hidden from the day-to-day views — never deleted (still in the DB + reports).
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 30;

export function recentCutoff(days = RECENT_DAYS): Date {
  return new Date(Date.now() - days * 86400000);
}

// Prisma `where` fragment: a project is "current" if it's not finished, or it
// finished within the window (delivered → deliveredAt; cancelled → createdAt).
export function recentProjectWhere(days = RECENT_DAYS): Prisma.ProjectWhereInput {
  const cutoff = recentCutoff(days);
  return {
    OR: [
      { status: { notIn: ["DELIVERED", "CANCELLED"] } },
      { status: "DELIVERED", deliveredAt: { gte: cutoff } },
      { status: "CANCELLED", createdAt: { gte: cutoff } },
    ],
  };
}

// In-memory equivalent for lists already loaded (e.g. the dashboard).
export function isProjectRecent(
  p: { status: string; deliveredAt: Date | null; createdAt: Date },
  days = RECENT_DAYS,
): boolean {
  if (p.status !== "DELIVERED" && p.status !== "CANCELLED") return true;
  const cutoff = recentCutoff(days);
  if (p.status === "DELIVERED") return !!p.deliveredAt && p.deliveredAt >= cutoff;
  return p.createdAt >= cutoff;
}
