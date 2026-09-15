import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { etDayStartUtc, etAddDays } from "@/lib/datetime";
import { DELIVERABLE_META } from "@/lib/pipeline";
import type { DeliverableType, ProjectStatus } from "@prisma/client";
import { isFieldFlag } from "@/lib/debrief";
import {
  notesPreview, rawCounts, uploadMark,
  type UploadHistoryRow, type UploadHistoryPage, type UploadHistoryPhotographer,
} from "@/lib/uploadSummary";

// ---------------------------------------------------------------------------
// "Past uploads" on /upload (Jordan, Sep 15 2026): every job whose upload
// page was submitted — or whose raws the sweep detected — older than the
// day buckets' 7-day window, newest shoot first, searchable, 50 a page.
// Photographers see only their own shoots (the same scope as the buckets);
// the office sees everyone's and can filter by photographer.
// ---------------------------------------------------------------------------

export const HISTORY_PAGE = 50;

/** The statuses the upload page is still a to-do for. */
export const UPLOAD_PENDING_STATUSES: ProjectStatus[] = ["BOOKED", "SCHEDULED", "SHOT"];

/** The pending set the day buckets list outside their window ("Previous
 *  weeks" / "Unscheduled"): a pending-status job whose page was never
 *  SUBMITTED — the sweep's uploadedAt alone does not retire it, because a
 *  SHOT job with raws in Dropbox and no submit still owes the photographer's
 *  submit ("Submit to add to payroll"). History excludes exactly this set, so
 *  a job is never listed twice and never listed nowhere (review, Sep 15). */
export const UPLOAD_PENDING_WHERE: Prisma.ProjectWhereInput = {
  status: { in: UPLOAD_PENDING_STATUSES },
  debriefSubmittedAt: null,
};

/** Whose shoot: the project's photographer, or an appointment assignee
 *  (Aryeo assigns per appointment; a job can carry only that). The
 *  photographer's own scope on both /upload sections, the office's filter
 *  chip and the chip counts all use this one predicate, so a chip's count is
 *  exactly what clicking it lists. */
export function ownedBy(memberId: string): Prisma.ProjectWhereInput {
  return { OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }] };
}

/** The start (UTC instant) of the ET day 7 days ago — the boundary between
 *  the "Past 7 days" bucket and the history below it. Same arithmetic as
 *  bucketFor's `etDaysAgo(shootDate) <= 7` on the page. */
export function uploadWindowStart(now = new Date()): Date {
  return etDayStartUtc(etAddDays(now, -7));
}

// Who is looking, and at whose shoots. Resolved by the callers (the /upload
// page from its own pin; the search action in app/upload/historyActions.ts
// from the session) — this module stays free of request-scoped imports so a
// read-only tsx probe can exercise the query.
export type UploadViewerScope = {
  /** photographer's TeamMember id ("__none__" when unresolvable — fail-closed), null for the office */
  mine: string | null;
  office: boolean;
};

export type HistoryQuery = {
  q?: string;
  /** office only — a photographer's scope already pins this */
  photographerId?: string | null;
  offset?: number;
};

// The page + chip shapes live in lib/uploadSummary.ts (client-safe) so the
// client component can type its props without importing this server module.
export type HistoryPage = UploadHistoryPage;
export type HistoryPhotographer = UploadHistoryPhotographer;

function historyWhere(scope: UploadViewerScope, query: HistoryQuery, now: Date): Prisma.ProjectWhereInput {
  const q = (query.q ?? "").trim().slice(0, 80);
  const and: Prisma.ProjectWhereInput[] = [
    { status: { not: "CANCELLED" } },
    // Older than the day buckets' window — or never dated at all. An undated
    // job only sits in "Unscheduled" while it is still pending, so a
    // submitted one that advanced would otherwise be listed nowhere.
    { OR: [{ shootDate: { lt: uploadWindowStart(now) } }, { shootDate: null }] },
    { OR: [{ debriefSubmittedAt: { not: null } }, { uploadedAt: { not: null } }] },
    { NOT: UPLOAD_PENDING_WHERE },
  ];
  if (scope.mine) {
    and.push(ownedBy(scope.mine));
  } else if (query.photographerId) {
    and.push(ownedBy(query.photographerId));
  }
  if (q) {
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { addressLine: { contains: q, mode: "insensitive" } },
        { client: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  return { AND: and };
}

export async function listUploadHistory(scope: UploadViewerScope, query: HistoryQuery = {}, now = new Date()): Promise<HistoryPage> {
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const where = historyWhere(scope, query, now);
  const [total, projects] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: [{ shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: offset,
      take: HISTORY_PAGE,
      select: {
        id: true, title: true, status: true, shootDate: true,
        debriefSubmittedAt: true, uploadedAt: true,
        videoInstructions: true, editorBrief: true, shotOrderNotes: true, removalNotes: true,
        rawPhotoCount: true, dronePhotoCount: true, statusEvidence: true,
        client: { select: { name: true, avatarUrl: true } },
        photographer: { select: { id: true, name: true, avatarColor: true } },
        deliverables: {
          where: { removedFromOrderAt: null },
          orderBy: { createdAt: "asc" },
          select: { type: true, label: true, status: true, uploadedAt: true, notCompletedReason: true },
        },
        activities: { where: { type: "FLAG" }, select: { body: true } },
        _count: { select: { uploads: true } },
      },
    }),
  ]);
  const rows: UploadHistoryRow[] = projects.map((p) => ({
    id: p.id,
    street: (p.title || "this job").split(",")[0].trim(),
    clientName: p.client.name,
    clientAvatarUrl: p.client.avatarUrl,
    shootISO: p.shootDate?.toISOString() ?? null,
    photographer: p.photographer,
    submittedISO: p.debriefSubmittedAt?.toISOString() ?? null,
    uploadedISO: p.uploadedAt?.toISOString() ?? null,
    status: p.status,
    marks: p.deliverables.map((d) => ({
      label: DELIVERABLE_META[d.type as DeliverableType]?.label ?? d.label ?? d.type,
      state: uploadMark(d),
      reason: d.notCompletedReason,
    })),
    counts: rawCounts(p),
    files: p._count.uploads,
    // Human field flags only — FLAG also carries the wrap-up's own "Not
    // completed" echo and machine-written client revision rows.
    flags: p.activities.filter((a) => isFieldFlag(a.body)).length,
    notes: notesPreview(p),
  }));
  return { rows, total, hasMore: offset + rows.length < total, offset };
}

/** The office's filter chips: who has history, with counts. Counted in JS
 *  off one lean read rather than a groupBy on photographerId, so a job counts
 *  for everyone ownedBy() matches (photographer OR an appointment assignee)
 *  and a chip's count is exactly what clicking it lists. */
export async function historyPhotographers(scope: UploadViewerScope, now = new Date()): Promise<HistoryPhotographer[]> {
  if (!scope.office) return [];
  const jobs = await prisma.project.findMany({
    where: historyWhere(scope, {}, now),
    select: { photographerId: true, appointments: { select: { assignedToId: true } } },
  });
  const counts = new Map<string, number>();
  for (const j of jobs) {
    const owners = new Set<string>();
    if (j.photographerId) owners.add(j.photographerId);
    for (const a of j.appointments) if (a.assignedToId) owners.add(a.assignedToId);
    for (const id of owners) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const members = await prisma.teamMember.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true, name: true, avatarColor: true },
  });
  return members
    .map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor, count: counts.get(m.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
