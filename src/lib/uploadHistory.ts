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

// ---------------------------------------------------------------------------
// THE JOB CAME BACK (Jordan, Sep 18 — 204 Spring Ln). A photographer who shot
// an extra video for a job that already finished gets a manual video row with
// `capturedAt` set to the day they shot it; see app/upload/additionalShoots.ts
// for why it is a row on the same job rather than a second job.
//
// These three predicates are the only thing that reads that shape, and they
// live together on purpose: the same fact has to pull the job BACK into the
// day buckets and keep it OUT of "Past uploads" while it is open, or the job is
// listed twice — the exact double-listing the Sep 15 rebuild was written to
// stop.
// ---------------------------------------------------------------------------

/** A manual video row minted by a return trip to the portal. `manual` alone is
 *  not enough: the Editing Room's own queue-add mints a manual VIDEO row too
 *  (editing/actions.ts, "Video — added manually") and that one is an edit of
 *  existing footage, not a second visit. `capturedAt` is what says a
 *  photographer stood at the property again. */
export const ADDITIONAL_SHOOT_WHERE: Prisma.DeliverableWhereInput = {
  manual: true,
  removedFromOrderAt: null,
  capturedAt: { not: null },
  type: { in: ["VIDEO", "SOCIAL_REEL"] },
};

/** …and the raws are not in yet, so the portal still owes the photographer a
 *  screen. `uploadedAt` here is the photographer's own tick on the checklist
 *  (upload/actions.markDeliverableUploaded), never the Dropbox sweep's
 *  project-level stamp — that one was written by the FIRST shoot and would
 *  retire the second one before it ever appeared. */
export const OPEN_ADDITIONAL_SHOOT_WHERE: Prisma.DeliverableWhereInput = {
  ...ADDITIONAL_SHOOT_WHERE,
  uploadedAt: null,
};

/** Jobs with an extra shoot still to upload — listed in the /upload day
 *  buckets whatever their status, which is the whole point: a DELIVERED job
 *  has no other way back onto that page. */
export const REOPENED_FOR_ADDITIONAL_SHOOT: Prisma.ProjectWhereInput = {
  deliverables: { some: OPEN_ADDITIONAL_SHOOT_WHERE },
};

/** …and the EDITOR's half of the same fact, which runs on past the portal's.
 *
 *  The photographer's screen closes when the raws are ticked in
 *  (OPEN_ADDITIONAL_SHOOT_WHERE above); that is the moment the editor's opens,
 *  so the editing rail cannot use `uploadedAt: null` — the job would leave the
 *  portal and the queue in the same instant and be owed by nobody. The end of
 *  an extra shoot is an APPROVED cut in the Review Room, which is the same
 *  signal the queue's own status ladder reads (editorQueue.cutTally). A stale
 *  row here means a video somebody still owes; an absent one meant nothing at
 *  all, which is what the Sep 18 review found. */
export const UNFINISHED_ADDITIONAL_SHOOT_WHERE: Prisma.DeliverableWhereInput = {
  ...ADDITIONAL_SHOOT_WHERE,
  reviewSubmissions: { none: { status: "APPROVED" } },
};

/** Jobs an extra video is still owed on, WHATEVER their status — the whole
 *  point, exactly as REOPENED_FOR_ADDITIONAL_SHOOT is for /upload. Measured
 *  Sep 18: of the 646 non-cancelled jobs with a live video row, 609 are
 *  DELIVERED, and a DELIVERED job reaches the editor queue's Done tab only. */
export const OWES_AN_ADDITIONAL_SHOOT: Prisma.ProjectWhereInput = {
  deliverables: { some: UNFINISHED_ADDITIONAL_SHOOT_WHERE },
};

// WHY A MERGED-IN VIDEO IS NOT ADMITTED HERE (Sep 20 2026, audit F01 re-review).
//
// The other way a delivered job can end up owing a video is a second shoot that
// arrived as its own Aryeo order and was merged onto the finished one
// (editing/actions.mergeProjectWork). That row is manual=false with capturedAt
// null, so it fails the clause above, and the proposal was to widen this
// predicate to admit "a live owed VIDEO/SOCIAL_REEL whose id sits in a live
// merge marker". It was not done, and this note is here so nobody spends the
// afternoon finding out why:
//
//   · SCOPE, not impossibility (corrected Sep 20 2026, wave-3 review — the
//     first version of this note said a marker clause could not be built
//     because this constant is static and buildEditorQueue "cannot await
//     anything". That is not true, and a wrong WHY is worse than no WHY: the
//     next person reads it and stops looking. buildEditorQueue awaits TWO
//     AppSetting marker reads of its own — WAITING_HOLD_PREFIX and
//     removedProjectIds() — and injects `id: { in: heldIds }` into the very OR
//     array this constant sits in (editorQueue.ts:74-120). A live-merge clause
//     is the pattern already in use there. It was not done because
//     editorQueue.ts was outside the change's file list, and because a rail
//     clause keyed on a marker only holds while the merge stands — undo the
//     merge and the rail silently loses the row again.
//   · no column on Deliverable records that a row arrived by merge, and every
//     proxy was measured read-only on live Neon on Sep 20: 604 DELIVERED jobs
//     hold a live video row with no approved cut, so "delivered and still owed"
//     floods the rail; `capturedAt` alone is 3 jobs, but it means the
//     photographer's own on-site tick and would have to be written onto the
//     moved row to be useful, which is the "added manually" regex all over
//     again.
//
// So the guarantee lives where the work moves instead, in two halves, both in
// src/app/editing/actions.ts: mergeProjectWork REFUSES a destination no Editing
// Room rail can show (DELIVERED, ON_HOLD, CANCELLED), and setQueueStatus
// refuses a Completed on a survivor while a merged-in video is still owed. The
// second shoot keeps its own job, its own video row and its own place on the
// Not-Done rail either way. This predicate stays exactly what its name says:
// the portal's return trip.

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
    // A job reopened for an extra shoot is back in the day buckets above, on
    // the day it was re-shot. History is "jobs that have left the portal", and
    // this one has walked back in — listing it in both would be the same job
    // twice on one screen.
    { NOT: REOPENED_FOR_ADDITIONAL_SHOOT },
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
