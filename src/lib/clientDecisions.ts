import "server-only";
import { prisma } from "@/lib/prisma";
import { cutIdentityHash } from "@/lib/cutTranscripts";
import { cutKeyOf } from "@/lib/reviewCuts";
import { submissionForEnrollment, type PortalViewer } from "@/lib/portal";
import { actorLabel } from "@/lib/portalAccess";
import { cutReleasedAt } from "@/lib/contentVideos";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// CLIENT DECISIONS (spec §8, Sep 17 2026). The client's verdict on ONE
// immutable cut: "Approve this version" or "Submit change request", keyed to
// the submissionId they watched AND the bytes behind it (contentHash via
// cutIdentityHash), attributable to the actual person (clientUserId) or the
// staff member acting on their behalf (staffUserId) — never "the link".
//
// Five concepts stay separate and this file touches exactly two of them:
//   internal QC        ReviewSubmission.status / decidedAt / decidedBy — Jordan's; never written here
//   client visibility  clientReleasedAt (contentVideos.cutReleasedAt) — read only
//   client request     clientRequestedAt/By + a ClientDecision(REQUEST_CHANGES)
//   client approval    a ClientDecision(APPROVE) + the clientApprovedDecisionId cache
//   delivery/publish   not here
//
// A NEW cut needs its OWN decision: a decision names one submission id, and
// when a later round lands the earlier decisions are marked SUPERSEDED (they
// stay — history is visible). Duplicate "Submit change request" clicks
// collide on dedupeKey and produce ONE revision job.
// ---------------------------------------------------------------------------

export type DecisionView = {
  id: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
  actorLabel: string;
  decidedAtISO: string;
  receiptState: string; // RECEIVED | ROUTED | IN_PROGRESS | DONE | SUPERSEDED
  openNotesChoice: string | null;
  note: string | null;
  contentHash: string | null;
};

export type CommentView = {
  id: string;
  timeSec: number | null;
  body: string;
  status: string; // OPEN | SENT | RESOLVED
  createdAtISO: string;
  author: string;
  byStaff: boolean;
  /** The viewer wrote it (so they may remove it while it is still OPEN). */
  mine: boolean;
  resolvedAtISO: string | null;
  resolvedBy: string | null;
  decisionId: string | null;
  replies: CommentView[];
};

export type CutVersion = {
  submissionId: string;
  round: number;
  fileName: string | null;
  releasedAtISO: string | null;
  /** Streamable URL (raw — the page mints the media token). Null when nothing is attached. */
  assetUrl: string | null;
  /** What this version is to the client. */
  clientState: "AWAITING_YOUR_DECISION" | "YOU_REQUESTED_CHANGES" | "YOU_APPROVED" | "SUPERSEDED" | "NOT_RELEASED";
  isCurrent: boolean;
  /** A re-cut is in motion on the project (open editor revision task). */
  revisionOpen: boolean;
  decisions: DecisionView[];
  comments: CommentView[];
};

const ID_RE = /^[a-z0-9]{10,40}$/i;

const stamp = (v: PortalViewer) => ({
  clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  staffUserId: v.actor.kind === "STAFF" ? v.actor.staffUserId : null,
});

const HASH_SELECT = { id: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true } as const;

/** The identity of the bytes the client watched — what every decision records. */
export async function cutHashOf(submissionId: string): Promise<string | null> {
  const s = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: HASH_SELECT });
  return s ? cutIdentityHash(s) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function authorNames(rows: { clientUserId: string | null; staffUserId: string | null }[]): Promise<{ client: Map<string, string>; staff: Map<string, string> }> {
  const cids = [...new Set(rows.map((r) => r.clientUserId).filter((x): x is string => !!x))];
  const sids = [...new Set(rows.map((r) => r.staffUserId).filter((x): x is string => !!x))];
  const [cs, ss] = await Promise.all([
    cids.length ? prisma.clientUser.findMany({ where: { id: { in: cids } }, select: { id: true, name: true, email: true } }) : [],
    sids.length ? prisma.appUser.findMany({ where: { id: { in: sids } }, select: { id: true, name: true } }) : [],
  ]);
  return {
    client: new Map(cs.map((c) => [c.id, c.name || c.email])),
    staff: new Map(ss.map((s) => [s.id, s.name || "RealTour Pilot"])),
  };
}

/**
 * Is this row the viewer's own? Exported because the WRITE layer needs the very
 * same answer the UI shows: a collaborator could delete the owner's open note
 * while the button that does it was hidden from them.
 */
export function isMine(viewer: PortalViewer, row: { clientUserId: string | null; staffUserId: string | null }): boolean {
  const a = viewer.actor;
  if (a.kind === "CLIENT") return row.clientUserId === a.clientUserId;
  if (a.kind === "STAFF") return row.staffUserId === a.staffUserId;
  return !row.clientUserId && !row.staffUserId;
}

/** Threaded comments for a set of submissions, oldest first, replies under their parent. */
export async function commentsForSubmissions(viewer: PortalViewer, submissionIds: string[]): Promise<Map<string, CommentView[]>> {
  const out = new Map<string, CommentView[]>();
  if (submissionIds.length === 0) return out;
  const rows = await prisma.portalComment.findMany({
    where: { submissionId: { in: submissionIds }, enrollmentId: viewer.enrollment.id },
    orderBy: { createdAt: "asc" },
  });
  const names = await authorNames(rows);
  const clientName = viewer.enrollment.clientName || "Client";
  const view = (r: (typeof rows)[number]): CommentView => ({
    id: r.id, timeSec: r.timeSec, body: r.body, status: r.status, createdAtISO: r.createdAt.toISOString(),
    author: r.staffUserId ? `${names.staff.get(r.staffUserId) ?? "RealTour Pilot"} (RealTour Pilot)` : r.clientUserId ? names.client.get(r.clientUserId) ?? clientName : `${clientName} (portal link)`,
    byStaff: !!r.staffUserId, mine: isMine(viewer, r),
    resolvedAtISO: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy, decisionId: r.decisionId, replies: [],
  });
  const byId = new Map(rows.map((r) => [r.id, view(r)]));
  for (const r of rows) {
    const v = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : null;
    if (parent) parent.replies.push(v);
    else out.set(r.submissionId, [...(out.get(r.submissionId) ?? []), v]);
  }
  return out;
}

/**
 * Every version of ONE cut (same deliverable × slot, or the same file for
 * legacy rows), oldest first, with the client's decisions and notes on each.
 * Only versions the client was shown carry a state other than NOT_RELEASED;
 * an internal round they never saw is listed as such and never playable.
 */
export async function cutHistory(viewer: PortalViewer, submissionId: string): Promise<CutVersion[]> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return [];
  const anchor = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true } });
  if (!anchor) return [];
  const key = cutKeyOf(anchor);
  const rounds = (await prisma.reviewSubmission.findMany({
    where: { projectId: anchor.projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: [{ round: "asc" }, { createdAt: "asc" }],
    select: { id: true, round: true, fileName: true, assetUrl: true, status: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true, clientApprovedDecisionId: true, deliverableId: true, slot: true, assetPath: true },
  })).filter((r) => cutKeyOf(r) === key);
  const ids = rounds.map((r) => r.id);
  const [decisions, comments, revisionTasks] = await Promise.all([
    prisma.clientDecision.findMany({ where: { submissionId: { in: ids }, enrollmentId: viewer.enrollment.id }, orderBy: { decidedAt: "asc" } }),
    commentsForSubmissions(viewer, ids),
    prisma.smartTask.findMany({ where: { projectId: anchor.projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } }),
  ]);
  // Supersession is a fact of the sequence: any decision on a round before the
  // newest RELEASED round is superseded. Stamp it (cheap, idempotent) so the
  // receipt the client reads is persisted state, not a render-time opinion.
  const released = rounds.filter((r) => cutReleasedAt(r));
  const current = released[released.length - 1] ?? null;
  const stale = decisions.filter((d) => current && d.submissionId !== current.id && d.receiptState !== "SUPERSEDED" && rounds.findIndex((r) => r.id === d.submissionId) < rounds.findIndex((r) => r.id === current.id));
  if (stale.length) {
    await prisma.clientDecision.updateMany({ where: { id: { in: stale.map((d) => d.id) } }, data: { receiptState: "SUPERSEDED" } }).catch(() => {});
    for (const d of stale) d.receiptState = "SUPERSEDED";
    // Free the open dedupe key so a decision on the new cut is its own row.
    await prisma.clientDecision.updateMany({ where: { id: { in: stale.map((d) => d.id) }, dedupeKey: { endsWith: ":open" } }, data: { dedupeKey: null } }).catch(() => {});
  }
  // A change request whose editor task is closed is DONE.
  const openRequests = decisions.filter((d) => d.decision === "REQUEST_CHANGES" && (d.receiptState === "RECEIVED" || d.receiptState === "ROUTED" || d.receiptState === "IN_PROGRESS"));
  if (openRequests.length && revisionTasks.length === 0) {
    const doneIds = openRequests.filter((d) => d.revisionTaskId).map((d) => d.id);
    if (doneIds.length) {
      await prisma.clientDecision.updateMany({ where: { id: { in: doneIds } }, data: { receiptState: "DONE" } }).catch(() => {});
      await prisma.clientDecision.updateMany({ where: { id: { in: doneIds }, dedupeKey: { endsWith: ":open" } }, data: { dedupeKey: null } }).catch(() => {});
      for (const d of openRequests) if (doneIds.includes(d.id)) d.receiptState = "DONE";
    }
  }
  return rounds.map((r): CutVersion => {
    const releasedAt = cutReleasedAt(r);
    const mine = decisions.filter((d) => d.submissionId === r.id);
    const approved = mine.some((d) => d.decision === "APPROVE" && d.receiptState !== "SUPERSEDED");
    const requested = mine.some((d) => d.decision === "REQUEST_CHANGES" && d.receiptState !== "SUPERSEDED");
    const isCurrent = current?.id === r.id;
    const clientState: CutVersion["clientState"] = !releasedAt ? "NOT_RELEASED" : !isCurrent ? "SUPERSEDED" : approved ? "YOU_APPROVED" : requested ? "YOU_REQUESTED_CHANGES" : "AWAITING_YOUR_DECISION";
    return {
      submissionId: r.id, round: r.round, fileName: r.fileName, releasedAtISO: releasedAt?.toISOString() ?? null,
      assetUrl: releasedAt ? r.assetUrl : null, clientState, isCurrent, revisionOpen: revisionTasks.length > 0,
      decisions: mine.map((d) => ({ id: d.id, decision: d.decision as DecisionView["decision"], actorLabel: d.actorLabel, decidedAtISO: d.decidedAt.toISOString(), receiptState: d.receiptState, openNotesChoice: d.openNotesChoice, note: d.note, contentHash: d.contentHash })),
      comments: comments.get(r.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Writes — the caller (src/app/portal/actions.ts) has already resolved the
// viewer and checked can(viewer, "approveEdits" | "requestChanges" | "comment").
// ---------------------------------------------------------------------------

export type OpenNotesChoice = "INCLUDE" | "DISCARD" | "NONE";

export type ApproveResult = { ok: true; decisionId: string; duplicate: boolean; message: string } | { ok: false; message: string };

async function supersedeEarlierRounds(enrollmentId: string, sub: { id: string; projectId: string; deliverableId: string | null; slot: number; assetPath: string | null; round: number }, newDecisionId: string): Promise<void> {
  const key = cutKeyOf(sub);
  const earlier = (await prisma.reviewSubmission.findMany({ where: { projectId: sub.projectId, round: { lt: sub.round } }, select: { id: true, deliverableId: true, slot: true, assetPath: true } })).filter((r) => cutKeyOf(r) === key);
  if (!earlier.length) return;
  await prisma.clientDecision.updateMany({
    where: { enrollmentId, submissionId: { in: earlier.map((r) => r.id) }, supersededById: null, id: { not: newDecisionId } },
    data: { supersededById: newDecisionId, receiptState: "SUPERSEDED", dedupeKey: null },
  }).catch(() => {});
}

/**
 * "Approve this version." One APPROVE per cut per actor path (dedupeKey) —
 * a second press returns the same receipt. Records the person, the role, the
 * bytes (contentHash) and what they chose to do with any OPEN notes:
 *   INCLUDE  send the notes along with the approval, as notes for us (SENT)
 *   DISCARD  the notes no longer apply — resolve them
 *   NONE     there were no open notes
 */
export async function approveCut(viewer: PortalViewer, submissionId: string, choice: OpenNotesChoice): Promise<ApproveResult> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return { ok: false, message: "That video isn't on your page." };
  const full = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { ...HASH_SELECT, projectId: true, round: true, deliverableId: true, slot: true, assetPath: true, videoId: true, clientApprovedDecisionId: true } });
  if (!full) return { ok: false, message: "That video isn't on your page." };
  // The newest released round is the only one that can be approved: an
  // approval on an old cut can never approve its replacement (spec §8).
  const history = await cutHistory(viewer, submissionId);
  const me = history.find((h) => h.submissionId === submissionId);
  if (!me || !me.isCurrent) return { ok: false, message: "A newer version of this video has replaced this one — approve the new version instead." };
  const open = await prisma.portalComment.findMany({ where: { submissionId, enrollmentId: viewer.enrollment.id, status: "OPEN", parentId: null }, select: { id: true } });
  if (open.length > 0 && choice === "NONE") return { ok: false, message: "You have notes on this video — tell us whether to send them along or set them aside, then approve." };
  const contentHash = cutIdentityHash(full);
  const dedupeKey = `sub:${submissionId}:approve`;
  const existing = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return { ok: true, decisionId: existing.id, duplicate: true, message: "Already approved — this version is marked as yours." };
  const a = viewer.actor;
  let decision: { id: string };
  try {
    decision = await prisma.clientDecision.create({
      data: {
        submissionId, projectId: full.projectId, videoId: full.videoId, enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId,
        round: full.round, contentHash, decision: "APPROVE", openNotesChoice: open.length ? choice : "NONE", commentIdsJson: open.length ? JSON.stringify(open.map((c) => c.id)) : null,
        ...stamp(viewer), actorLabel: actorLabel(viewer), membershipRole: a.kind === "CLIENT" ? a.membershipRole : a.kind === "STAFF" ? `STAFF:${a.staffRole}` : null,
        receiptState: "DONE", dedupeKey,
      },
      select: { id: true },
    });
  } catch {
    const again = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (again) return { ok: true, decisionId: again.id, duplicate: true, message: "Already approved — this version is marked as yours." };
    return { ok: false, message: "That didn't save — try again." };
  }
  // The caches: the cut's approval pointer and the logical video's.
  await prisma.reviewSubmission.update({ where: { id: submissionId }, data: { clientApprovedDecisionId: decision.id } }).catch(() => {});
  if (full.videoId) {
    await prisma.contentVideo.update({ where: { id: full.videoId }, data: { approvedSubmissionId: submissionId, status: "APPROVED" } }).catch(() => {});
  }
  if (open.length) {
    const now = new Date();
    if (choice === "DISCARD") {
      await prisma.portalComment.updateMany({ where: { id: { in: open.map((c) => c.id) } }, data: { status: "RESOLVED", resolvedAt: now, resolvedBy: actorLabel(viewer), resolvedByKind: a.kind === "STAFF" ? "STAFF" : "CLIENT", decisionId: decision.id } });
    } else {
      await prisma.portalComment.updateMany({ where: { id: { in: open.map((c) => c.id) } }, data: { status: "SENT", decisionId: decision.id } });
    }
  }
  await supersedeEarlierRounds(viewer.enrollment.id, { id: submissionId, projectId: full.projectId, deliverableId: full.deliverableId, slot: full.slot, assetPath: full.assetPath, round: full.round }, decision.id);
  return { ok: true, decisionId: decision.id, duplicate: false, message: "Approved — this exact version is now marked as yours. If a new cut ever replaces it, that one will ask for its own approval." };
}

export type RequestChangesResult = { ok: true; decisionId: string; duplicate: boolean; message: string } | { ok: false; message: string };

/**
 * "Submit change request." Bundles every OPEN top-level note on the cut (plus
 * an optional overall note) into ONE revision through the same machinery a
 * text or a call uses (raiseRevision → work order, editor task, bells), and
 * records the decision. While a request on this cut is still open a second
 * submit is the SAME request: new notes ride along, no second job.
 */
export async function requestChangesOnCut(viewer: PortalViewer, submissionId: string, generalNote: string): Promise<RequestChangesResult> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return { ok: false, message: "That video isn't on your page." };
  const full = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { ...HASH_SELECT, projectId: true, round: true, deliverableId: true, slot: true, assetPath: true, videoId: true, status: true } });
  if (!full) return { ok: false, message: "That video isn't on your page." };
  const history = await cutHistory(viewer, submissionId);
  const me = history.find((h) => h.submissionId === submissionId);
  if (!me || !me.isCurrent) return { ok: false, message: "A newer version of this video has replaced this one — review the new version instead." };

  const notes = await prisma.portalComment.findMany({
    where: { submissionId, enrollmentId: viewer.enrollment.id, status: "OPEN", parentId: null },
    orderBy: [{ timeSec: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: { id: true, timeSec: true, body: true },
  });
  const overall = clip((generalNote ?? "").trim(), 1000);
  const dedupeKey = `sub:${submissionId}:changes:open`;
  const openDecision = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true, receiptState: true } });
  if (openDecision && openDecision.receiptState !== "DONE" && openDecision.receiptState !== "SUPERSEDED") {
    // Same cut, request still open: the new notes join it. No second job.
    if (notes.length) await prisma.portalComment.updateMany({ where: { id: { in: notes.map((n) => n.id) } }, data: { status: "SENT", decisionId: openDecision.id } });
    if (overall) await prisma.portalComment.create({ data: { submissionId, projectId: full.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: overall, status: "SENT", decisionId: openDecision.id, ...stamp(viewer) } });
    return { ok: true, decisionId: openDecision.id, duplicate: true, message: "We already have your request for this version — your new notes have been added to it." };
  }
  if (notes.length === 0 && overall.length < 3) return { ok: false, message: "Add a note on the video (or an overall note) first, so the editor knows what to change." };

  // THROTTLE: one send per project per 15 minutes (a billable analysis + several rows per call).
  const recent = await prisma.revisionBrief.count({ where: { projectId: full.projectId, source: "portal", createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
  if (recent > 0) return { ok: false, message: "We already got your last request — add any extra notes above and send again in a few minutes." };

  const fmtT = (t: number | null) => (t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `);
  const lines = [...notes.map((n) => `${fmtT(n.timeSec)}${n.body}`), ...(overall ? [overall] : [])];
  const by = actorLabel(viewer);
  const compiled = `Video revision requested from the client portal by ${by}${sub.project?.title ? ` on ${sub.project.title.split(",")[0]}` : ""}${full.fileName ? ` (cut: ${full.fileName}, v${full.round})` : ""}:\n${lines.map((l) => `• ${l}`).join("\n")}`;
  const startedAt = new Date();
  try {
    const { raiseRevision } = await import("@/lib/comms");
    const ok = await raiseRevision({ projectId: full.projectId, clientId: viewer.enrollment.clientId, clientName: viewer.enrollment.clientName || null, propertyAddress: sub.project?.title ?? null, note: compiled, source: "portal" });
    if (!ok) return { ok: false, message: "Something hiccuped on our side — text us and we'll get right on it." };
  } catch {
    return { ok: false, message: "Something hiccuped on our side — text us and we'll get right on it." };
  }
  // The job raiseRevision just created — so the receipt can be traced from note to task.
  const [task, brief] = await Promise.all([
    prisma.smartTask.findFirst({ where: { projectId: full.projectId, taskType: "revision", createdAt: { gte: new Date(startedAt.getTime() - 5000) } }, orderBy: { createdAt: "desc" }, select: { id: true } }),
    prisma.revisionBrief.findFirst({ where: { projectId: full.projectId, source: "portal", createdAt: { gte: new Date(startedAt.getTime() - 5000) } }, orderBy: { createdAt: "desc" }, select: { id: true, taskId: true } }),
  ]);
  const a = viewer.actor;
  let decision: { id: string };
  try {
    decision = await prisma.clientDecision.create({
      data: {
        submissionId, projectId: full.projectId, videoId: full.videoId, enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId,
        round: full.round, contentHash: cutIdentityHash(full), decision: "REQUEST_CHANGES", commentIdsJson: notes.length ? JSON.stringify(notes.map((n) => n.id)) : null,
        ...stamp(viewer), actorLabel: by, membershipRole: a.kind === "CLIENT" ? a.membershipRole : a.kind === "STAFF" ? `STAFF:${a.staffRole}` : null,
        revisionTaskId: task?.id ?? brief?.taskId ?? null, revisionBriefId: brief?.id ?? null, receiptState: task ? "ROUTED" : "RECEIVED", dedupeKey, note: overall || null,
      },
      select: { id: true },
    });
  } catch {
    const again = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (again) return { ok: true, decisionId: again.id, duplicate: true, message: "We already have your request for this version." };
    return { ok: false, message: "The request went to the editor but the receipt didn't save — text us if it doesn't show here." };
  }
  if (notes.length) await prisma.portalComment.updateMany({ where: { id: { in: notes.map((n) => n.id) } }, data: { status: "SENT", decisionId: decision.id } });
  if (overall) await prisma.portalComment.create({ data: { submissionId, projectId: full.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: overall, status: "SENT", decisionId: decision.id, ...stamp(viewer) } }).catch(() => {});
  // The client sent this cut back. The STATUS flip stays (the editor lane and
  // findNextCut read it) — but Jordan's QC verdict (decidedAt/decidedBy) is
  // his and is not overwritten; the client's request is its own stamp.
  await prisma.reviewSubmission.updateMany({ where: { id: submissionId, status: "APPROVED" }, data: { status: "CHANGES_REQUESTED", clientRequestedAt: new Date(), clientRequestedBy: by } }).catch(() => {});
  if (full.videoId) await prisma.contentVideo.update({ where: { id: full.videoId }, data: { status: "EDITING" } }).catch(() => {});
  await supersedeEarlierRounds(viewer.enrollment.id, { id: submissionId, projectId: full.projectId, deliverableId: full.deliverableId, slot: full.slot, assetPath: full.assetPath, round: full.round }, decision.id);
  return { ok: true, decisionId: decision.id, duplicate: false, message: "Sent to the editor — we'll text you when the new cut is ready. Your request is on record below." };
}

/** Mark a note resolved (or reopen it). The note stays; only its resolution changes. */
export async function setCommentResolved(viewer: PortalViewer, commentId: string, resolved: boolean): Promise<{ ok: boolean; message: string }> {
  if (!ID_RE.test(commentId)) return { ok: false, message: "That note isn't on your page." };
  const c = await prisma.portalComment.findUnique({ where: { id: commentId }, select: { enrollmentId: true, status: true, decisionId: true, parentId: true } });
  if (!c || c.enrollmentId !== viewer.enrollment.id) return { ok: false, message: "That note isn't on your page." };
  if (c.parentId) return { ok: false, message: "Resolve the note itself, not a reply." };
  const a = viewer.actor;
  if (resolved) {
    await prisma.portalComment.update({ where: { id: commentId }, data: { resolvedAt: new Date(), resolvedBy: actorLabel(viewer), resolvedByKind: a.kind === "STAFF" ? "STAFF" : "CLIENT", ...(c.status === "OPEN" ? { status: "RESOLVED" } : {}) } });
    return { ok: true, message: "Resolved." };
  }
  await prisma.portalComment.update({ where: { id: commentId }, data: { resolvedAt: null, resolvedBy: null, resolvedByKind: null, ...(c.status === "RESOLVED" ? { status: c.decisionId ? "SENT" : "OPEN" } : {}) } });
  return { ok: true, message: "Reopened." };
}

/** A reply under an existing note on one of the viewer's cuts. */
export async function replyToComment(viewer: PortalViewer, parentId: string, body: string): Promise<{ ok: boolean; message: string; id?: string }> {
  if (!ID_RE.test(parentId)) return { ok: false, message: "That note isn't on your page." };
  const parent = await prisma.portalComment.findUnique({ where: { id: parentId }, select: { id: true, submissionId: true, projectId: true, enrollmentId: true, parentId: true } });
  if (!parent || parent.enrollmentId !== viewer.enrollment.id) return { ok: false, message: "That note isn't on your page." };
  const text = clip((body ?? "").trim(), 1000);
  if (text.length < 2) return { ok: false, message: "Write a quick reply first." };
  const created = await prisma.portalComment.create({
    // Replies attach to the top-level note (a reply to a reply lands in the same thread).
    data: { submissionId: parent.submissionId, projectId: parent.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: text, status: "SENT", parentId: parent.parentId ?? parent.id, ...stamp(viewer) },
    select: { id: true },
  });
  return { ok: true, message: "Replied.", id: created.id };
}
