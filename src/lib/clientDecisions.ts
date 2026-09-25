import "server-only";
import { prisma } from "@/lib/prisma";
import { cutIdentityHash } from "@/lib/cutTranscripts";
import { cutChainOf, stableCutIdentity } from "@/lib/cutEntitlement";
import { submissionForEnrollment, type PortalViewer } from "@/lib/portal";
import { actorLabel } from "@/lib/portalAccess";
import { cutReleasedAt } from "@/lib/contentVideos";
import { slotKeyOf } from "@/lib/reviewCuts";
import {
  claimWindow, deadlineLabel, enforced, ensureWindow, extraRoundAckText, mayAcknowledgeFee, outputIdFor, revisionPolicy, roundsUsed, videoKeyOf, videoLabelOf,
  EXTRA_ROUND_ROUTES_IMMEDIATELY, URGENT_CONTACT, type ReviewPanel,
} from "@/lib/reviewWindows";
import { clip } from "@/lib/text";
import { TEXT_KYLE } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// CLIENT DECISIONS (spec §8, Sep 17 2026). The client's verdict on ONE
// immutable cut: "Approve this version" or "Submit change request", keyed to
// the submissionId they watched AND the bytes behind it (contentHash via
// cutEntitlement.stableCutIdentity since CP-01), attributable to the actual
// person (clientUserId) or the staff member acting on their behalf
// (staffUserId) — never "the link".
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
// stay — history is visible).
//
// SINCE CP-02/03 (Sep 24 2026) every decision goes through the cut's review
// window (reviewWindows.ts): approve, request and expiry each take the
// window's compare-and-set, so one cut can never hold both an approval and a
// change request, and a lost race is told what happened instead of writing a
// second verdict. A change request is ONE revision round on the per-video
// ledger; a second submit while it is open is an ADDENDUM that reaches the
// same editor request (new brief on the same task, a ping), never a second
// round — and the old per-PROJECT 15-minute throttle, which refused video 2 of
// a batch because video 1 had just been sent, is gone.
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
  /** CLIENT | STAFF | AUTO_EXPIRY (null on decisions before CP-02). */
  basis: string | null;
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
  /** Streamable URL (raw — the page mints the media token). Only the CURRENT
   *  version carries one (CP-02: the client sees only the latest playable
   *  version; staff keep every round in the Review Room and the workspace). */
  assetUrl: string | null;
  /** What this version is to the client. */
  clientState: "AWAITING_YOUR_DECISION" | "YOU_REQUESTED_CHANGES" | "YOU_APPROVED" | "AUTO_APPROVED" | "SUPERSEDED" | "NOT_RELEASED";
  isCurrent: boolean;
  /** Was the decision behind `clientState` made by THIS viewer? A collaborator
   *  or viewer seat was being told "Approved by you" about the owner's
   *  approval (review, Sep 17). */
  decidedByMe: boolean;
  /** A re-cut of THIS video is in motion (its revision round is open) — not
   *  "some revision task exists on the job", which lit every video of a batch. */
  revisionOpen: boolean;
  decisions: DecisionView[];
  comments: CommentView[];
  /** The review deadline and rounds (reviewWindows.reviewPanelFor), set by
   *  the page on the current version only; null while revision_policy is off. */
  review?: ReviewPanel | null;
};

const ID_RE = /^[a-z0-9]{10,40}$/i;
const REQUEST_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;

/** An addendum costs a brief, reopens the editor's task and QC, rings the
 *  owner, the admins and the editor, and a long one a model call. The old
 *  per-project throttle said so; its per-round replacement left addenda
 *  unbounded. So: one per open request per ADDENDUM_SPACING_MS, and at most
 *  ADDENDA_PER_HOUR on it. Staff are never throttled. */
const ADDENDUM_SPACING_MS = 2 * 60_000;
const ADDENDA_PER_HOUR = 6;

const stamp = (v: PortalViewer) => ({
  clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  staffUserId: v.actor.kind === "STAFF" ? v.actor.staffUserId : null,
});

const roleOf = (v: PortalViewer) => (v.actor.kind === "CLIENT" ? v.actor.membershipRole : v.actor.kind === "STAFF" ? `STAFF:${v.actor.staffRole}` : null);

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
 * while the button that does it was hidden from them. An automatic approval
 * (CP-02) belongs to nobody: it carries no person, which the emailed link's
 * own rows also carry none of, and it must never read "Approved by you".
 */
export function isMine(viewer: PortalViewer, row: { clientUserId: string | null; staffUserId: string | null; basis?: string | null }): boolean {
  if (row.basis === "AUTO_EXPIRY") return false;
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
 * an internal round they never saw is listed as such and never playable, and
 * since CP-02 only the CURRENT version is playable at all.
 */
export async function cutHistory(viewer: PortalViewer, submissionId: string): Promise<CutVersion[]> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return [];
  // The video's ONE chain (CP-01): the library's key, not the Review Room's
  // path key, so a legacy "X v1.mov" beside "X v2.mov" is an older round of
  // the same video here too — and can no longer pass approveCut as current.
  const rounds = await cutChainOf(submissionId);
  if (!rounds.length) return [];
  const anchor = { projectId: rounds[0].projectId };
  const ids = rounds.map((r) => r.id);
  const videoKey = videoKeyOf(rounds[0]);
  const [decisions, comments, windows, ledger, revisionTasks] = await Promise.all([
    prisma.clientDecision.findMany({ where: { submissionId: { in: ids }, enrollmentId: viewer.enrollment.id }, orderBy: { decidedAt: "asc" } }),
    commentsForSubmissions(viewer, ids),
    prisma.contentReviewWindow.findMany({ where: { submissionId: { in: ids } }, select: { id: true, submissionId: true, state: true } }),
    prisma.contentRevisionRound.findMany({ where: { videoKey }, select: { decisionId: true, state: true } }),
    // Only for requests made before the ledger existed (no round row).
    prisma.smartTask.count({ where: { projectId: anchor.projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
  ]);
  const roundOf = new Map(ledger.map((r) => [r.decisionId, r]));
  // Supersession is a fact of the sequence: any decision on a round before the
  // newest RELEASED round is superseded. Stamp it (cheap, idempotent) so the
  // receipt the client reads is persisted state, not a render-time opinion.
  const released = rounds.filter((r) => cutReleasedAt(r));
  const current = released[released.length - 1] ?? null;
  // A change request the newer version answered keeps its DONE receipt ("done
  // — see the newer version"); everything else on an older round is superseded.
  const stale = decisions.filter((d) => current && d.submissionId !== current.id && d.receiptState !== "SUPERSEDED" && !(d.decision === "REQUEST_CHANGES" && d.receiptState === "DONE") && rounds.findIndex((r) => r.id === d.submissionId) < rounds.findIndex((r) => r.id === current.id));
  if (stale.length) {
    await prisma.clientDecision.updateMany({ where: { id: { in: stale.map((d) => d.id) } }, data: { receiptState: "SUPERSEDED" } }).catch(() => {});
    for (const d of stale) d.receiptState = "SUPERSEDED";
    // Free the open dedupe key so a decision on the new cut is its own row.
    await prisma.clientDecision.updateMany({ where: { id: { in: stale.map((d) => d.id) }, dedupeKey: { endsWith: ":open" } }, data: { dedupeKey: null } }).catch(() => {});
  }
  // A change request is DONE when THIS video's round was answered by a newer
  // released version (the ledger). A request made before the ledger existed
  // keeps the old reading: done once the job has no open revision task.
  const openRequests = decisions.filter((d) => d.decision === "REQUEST_CHANGES" && (d.receiptState === "RECEIVED" || d.receiptState === "ROUTED" || d.receiptState === "IN_PROGRESS"));
  const doneIds = openRequests
    .filter((d) => {
      const r = roundOf.get(d.id);
      return r ? r.state === "ANSWERED" : !!d.revisionTaskId && revisionTasks === 0;
    })
    .map((d) => d.id);
  if (doneIds.length) {
    await prisma.clientDecision.updateMany({ where: { id: { in: doneIds } }, data: { receiptState: "DONE" } }).catch(() => {});
    await prisma.clientDecision.updateMany({ where: { id: { in: doneIds }, dedupeKey: { endsWith: ":open" } }, data: { dedupeKey: null } }).catch(() => {});
    for (const d of openRequests) if (doneIds.includes(d.id)) d.receiptState = "DONE";
  }
  const legacyOpen = revisionTasks > 0 && decisions.some((d) => d.decision === "REQUEST_CHANGES" && !roundOf.has(d.id) && !d.windowId && (d.receiptState === "RECEIVED" || d.receiptState === "ROUTED" || d.receiptState === "IN_PROGRESS"));
  const revisionOpen = ledger.some((r) => r.state === "OPEN") || windows.some((w) => w.state === "CHANGES_REQUESTED") || legacyOpen;
  // The client opened it: evidence an automatic approval can stand on (CP-02).
  // The client's own seat or their link — never staff looking through the iframe.
  if (current && (viewer.actor.kind === "CLIENT" || viewer.actor.kind === "TOKEN")) {
    await prisma.contentReviewWindow.updateMany({ where: { submissionId: current.id, firstViewedAt: null }, data: { firstViewedAt: new Date() } }).catch(() => {});
  }
  return rounds.map((r): CutVersion => {
    const releasedAt = cutReleasedAt(r);
    const mine = decisions.filter((d) => d.submissionId === r.id);
    const approval = mine.find((d) => d.decision === "APPROVE" && d.receiptState !== "SUPERSEDED") ?? null;
    const request = mine.find((d) => d.decision === "REQUEST_CHANGES" && d.receiptState !== "SUPERSEDED") ?? null;
    const isCurrent = current?.id === r.id;
    const clientState: CutVersion["clientState"] = !releasedAt
      ? "NOT_RELEASED"
      : !isCurrent
        ? "SUPERSEDED"
        : approval
          ? approval.basis === "AUTO_EXPIRY" ? "AUTO_APPROVED" : "YOU_APPROVED"
          : request ? "YOU_REQUESTED_CHANGES" : "AWAITING_YOUR_DECISION";
    const decisive = approval ?? request;
    return {
      submissionId: r.id, round: r.round, fileName: r.fileName, releasedAtISO: releasedAt?.toISOString() ?? null,
      assetUrl: releasedAt && isCurrent ? r.assetUrl : null, clientState, isCurrent, decidedByMe: !!decisive && isMine(viewer, decisive), revisionOpen,
      decisions: mine.map((d) => ({ id: d.id, decision: d.decision as DecisionView["decision"], actorLabel: d.actorLabel, decidedAtISO: d.decidedAt.toISOString(), receiptState: d.receiptState, openNotesChoice: d.openNotesChoice, note: d.note, contentHash: d.contentHash, basis: d.basis })),
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

/**
 * Mark the live decisions on EARLIER rounds of this cut's video superseded.
 * With a new decision they point at it (supersededById); with none — a release
 * of the next version (reviewWindows), which is not anybody's decision — they
 * are only marked, and a request already answered keeps its DONE receipt.
 */
export async function supersedeEarlierRounds(enrollmentId: string, sub: { id: string; round: number }, newDecisionId: string | null): Promise<void> {
  // Earlier = before this round in the video's chain. Legacy re-uploads often
  // all carry round 1, so the chain's order (round, then upload time) is what
  // says which came first; `round < n` alone found nothing to supersede.
  const chain = await cutChainOf(sub.id);
  const at = chain.findIndex((r) => r.id === sub.id);
  const earlier = at >= 0 ? chain.slice(0, at) : chain.filter((r) => r.round < sub.round);
  if (!earlier.length) return;
  if (newDecisionId) {
    await prisma.clientDecision.updateMany({
      where: { enrollmentId, submissionId: { in: earlier.map((r) => r.id) }, supersededById: null, id: { not: newDecisionId } },
      data: { supersededById: newDecisionId, receiptState: "SUPERSEDED", dedupeKey: null },
    }).catch(() => {});
    return;
  }
  // An approval's receipt is DONE from the start; it is superseded like any
  // other. Only a change request the new version ANSWERED keeps its DONE.
  await prisma.clientDecision.updateMany({
    where: { enrollmentId, submissionId: { in: earlier.map((r) => r.id) }, supersededById: null, receiptState: { not: "SUPERSEDED" }, NOT: { decision: "REQUEST_CHANGES", receiptState: "DONE" } },
    data: { receiptState: "SUPERSEDED", dedupeKey: null },
  }).catch(() => {});
}

/** What a lost race says, by the state the window is in now. */
function stateWords(state: string | undefined): string {
  switch (state) {
    case "APPROVED": return "This version was just approved — nothing else to send on it.";
    case "AUTO_APPROVED": return `This version was approved when its review window closed. If something still needs changing, text or call us at ${URGENT_CONTACT}.`;
    case "CHANGES_REQUESTED": return "You've asked for changes on this version — approve the new version when it arrives.";
    case "SUPERSEDED": case "REMOVED": return "A newer version of this video has replaced this one — review the new version instead.";
    default: return "Someone else acted on this version a moment ago — reload to see where it stands.";
  }
}

/**
 * "Approve this version." One APPROVE per cut (dedupeKey) — a second press
 * returns the same receipt. Records the person, the role, the bytes
 * (contentHash) and what they chose to do with any OPEN notes:
 *   INCLUDE  send the notes along with the approval, as notes for us (SENT)
 *   DISCARD  the notes no longer apply — resolve them
 *   NONE     there were no open notes
 * The window's CAS decides a race with a change request (CP-02). A late
 * approval is always accepted — the deadline only ever stops a new REQUEST.
 */
export async function approveCut(viewer: PortalViewer, submissionId: string, choice: OpenNotesChoice): Promise<ApproveResult> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return { ok: false, message: "That video isn't on your page." };
  const full = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { ...HASH_SELECT, projectId: true, round: true, deliverableId: true, slot: true, assetPath: true, videoId: true, clientApprovedDecisionId: true, status: true, clientRequestedAt: true } });
  if (!full) return { ok: false, message: "That video isn't on your page." };
  // The newest released round is the only one that can be approved: an
  // approval on an old cut can never approve its replacement (spec §8).
  const history = await cutHistory(viewer, submissionId);
  const me = history.find((h) => h.submissionId === submissionId);
  if (!me || !me.isCurrent) return { ok: false, message: "A newer version of this video has replaced this one — approve the new version instead." };
  const open = await prisma.portalComment.findMany({ where: { submissionId, enrollmentId: viewer.enrollment.id, status: "OPEN", parentId: null }, select: { id: true } });
  if (open.length > 0 && choice === "NONE") return { ok: false, message: "You have notes on this video — tell us whether to send them along or set them aside, then approve." };
  const staff = viewer.actor.kind === "STAFF";
  const now = new Date();

  const w = await ensureWindow(submissionId, { enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId });
  let overridden: string | null = null; // the change request a staff approval set aside
  let orphan = false; // the window says approved, but no approval was ever written
  if (w) {
    if (w.state === "APPROVED" || w.state === "AUTO_APPROVED") {
      // "Already approved" only when an approval is ON RECORD. A window can be
      // claimed APPROVED by a writer that then died before the row landed (a
      // transient database error, a timeout): answering "already approved"
      // then told the client so for ever while the download stayed shut. This
      // press finishes the approval instead — the dedupe key keeps it one row
      // even if the first writer is merely slow.
      const live = await prisma.clientDecision.findFirst({
        where: { submissionId, enrollmentId: viewer.enrollment.id, decision: "APPROVE", receiptState: { not: "SUPERSEDED" } },
        orderBy: { decidedAt: "desc" }, select: { id: true, basis: true },
      });
      if (live) return { ok: true, decisionId: live.id, duplicate: true, message: live.basis === "AUTO_EXPIRY" ? "Already approved — this version was approved when its review window closed." : "Already approved — this version is marked as yours." };
      orphan = true;
      if (w.state === "AUTO_APPROVED" && !(await claimWindow(w.id, ["AUTO_APPROVED"], "APPROVED", { decisionId: null }, { closedAt: now, closedReason: staff ? "STAFF" : "CLIENT" }))) {
        const again = await prisma.contentReviewWindow.findUnique({ where: { id: w.id }, select: { state: true } });
        return { ok: false, message: stateWords(again?.state) };
      }
    } else if (w.state === "SUPERSEDED" || w.state === "REMOVED") {
      return { ok: false, message: "A newer version of this video has replaced this one — approve the new version instead." };
    } else if (w.state === "CHANGES_REQUESTED") {
      // The client asked for changes on THIS version; approving it too would
      // put both verdicts on one cut. Staff may set the request aside.
      if (!staff) return { ok: false, message: stateWords("CHANGES_REQUESTED") };
      if (!(await claimWindow(w.id, ["CHANGES_REQUESTED"], "APPROVED", {}, { closedAt: now, closedReason: "STAFF_OVERRIDE" }))) {
        const again = await prisma.contentReviewWindow.findUnique({ where: { id: w.id }, select: { state: true } });
        return { ok: false, message: stateWords(again?.state) };
      }
      overridden = w.decisionId ?? "";
    } else if (!(await claimWindow(w.id, ["OPEN"], "APPROVED", {}, { closedAt: now, closedReason: staff ? "STAFF" : "CLIENT" }))) {
      const again = await prisma.contentReviewWindow.findUnique({ where: { id: w.id }, select: { state: true, decisionId: true } });
      if (again?.state === "APPROVED" || again?.state === "AUTO_APPROVED") {
        return { ok: true, decisionId: again.decisionId ?? "", duplicate: true, message: "Already approved — this version is marked as yours." };
      }
      return { ok: false, message: stateWords(again?.state) };
    }
  }
  let r: Awaited<ReturnType<typeof recordClientApproval>>;
  try {
    r = await recordClientApproval({
      enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId, cut: full,
      actor: { ...stamp(viewer), actorLabel: actorLabel(viewer), membershipRole: roleOf(viewer), resolvedByKind: staff ? "STAFF" : "CLIENT" },
      openCommentIds: open.map((c) => c.id), choice, basis: staff ? "STAFF" : "CLIENT", windowId: w?.id ?? null,
    });
  } catch (e) {
    // A throw is a failure like any other: the window must not be left
    // claimed APPROVED with nothing behind it.
    console.error("[clientDecisions] approval did not record", submissionId, e);
    r = { ok: false, message: "That didn't save — try again." };
  }
  if (!r.ok) {
    // Give the window back: nothing was decided.
    if (w) await claimWindow(w.id, ["APPROVED"], overridden !== null ? "CHANGES_REQUESTED" : "OPEN", {}, { closedAt: null, closedReason: null, ...(orphan ? { decisionId: null } : {}) }).catch(() => false);
    return r;
  }
  if (w) {
    const pinned = await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "APPROVED" }, data: { decisionId: r.decisionId } }).catch(() => ({ count: 0 }));
    // The repair released the window while this approval stalled: the approval
    // is on record, so the window follows it.
    if (pinned.count === 0) await claimWindow(w.id, ["OPEN"], "APPROVED", {}, { decisionId: r.decisionId, closedAt: now, closedReason: staff ? "STAFF" : "CLIENT" }).catch(() => false);
  }
  if (overridden !== null) {
    await setAsideRequest(overridden || null, r.decisionId, actorLabel(viewer), submissionId, full.projectId);
    // The client's request had flipped the cut out of APPROVED; it stands again.
    await prisma.reviewSubmission.updateMany({ where: { id: submissionId, status: "CHANGES_REQUESTED", clientRequestedAt: { not: null } }, data: { status: "APPROVED" } }).catch(() => {});
  }
  if (r.duplicate) return { ok: true, decisionId: r.decisionId, duplicate: true, message: "Already approved — this version is marked as yours." };
  return {
    ok: true, decisionId: r.decisionId, duplicate: false,
    message: overridden !== null
      ? "Approved on the client's behalf — their change request on this version is set aside. Close the editor's revision card if the work should stop."
      : "Approved — this exact version is now marked as yours. If a new cut ever replaces it, that one will ask for its own approval.",
  };
}

/** A staff approval over an open change request: the round is CANCELLED (it
 *  no longer counts against the video's allowance) and the request decision
 *  superseded by the approval, freeing its dedupe key. */
async function setAsideRequest(decisionId: string | null, approvalId: string, by: string, submissionId: string, projectId: string): Promise<void> {
  const ids = decisionId
    ? [decisionId]
    : (await prisma.clientDecision.findMany({ where: { submissionId, decision: "REQUEST_CHANGES", receiptState: { not: "SUPERSEDED" } }, select: { id: true } })).map((d) => d.id);
  if (!ids.length) return;
  await prisma.contentRevisionRound.updateMany({ where: { decisionId: { in: ids }, state: "OPEN" }, data: { state: "CANCELLED" } }).catch(() => {});
  await prisma.clientDecision.updateMany({ where: { id: { in: ids } }, data: { receiptState: "SUPERSEDED", dedupeKey: null, supersededById: approvalId } }).catch(() => {});
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: `${by} approved a version the client had asked to change — their change request is set aside, and its revision round no longer counts.`.slice(0, 500) } }).catch(() => {});
}

/** Who an approval is attributed to: the person, staff on the client's behalf,
 *  or (CP-02's expiry) neither — the label then says what happened. */
export type ApprovalActor = {
  clientUserId: string | null;
  staffUserId: string | null;
  actorLabel: string;
  membershipRole: string | null;
  /** Written on notes the approval resolves (DISCARD). */
  resolvedByKind: "CLIENT" | "STAFF" | "SYSTEM";
};

/**
 * THE APPROVE ROW, written one way (CP-01, Sep 24 2026). approveCut's checks
 * (the viewer may approve, this is the current released round, open notes were
 * answered) run BEFORE this; everything after them is here, so an approval
 * made any other way — CP-02's auto-approval on expiry — is the identical row:
 * ClientDecision{APPROVE} keyed `sub:<id>:approve`, carrying the cut's
 * stableCutIdentity (what cutEntitlement checks the bytes against), plus the
 * two caches and the supersession of earlier rounds' decisions.
 *
 * Idempotent on the dedupe key: a second call returns the first row with
 * `duplicate: true`. Call it SEQUENTIALLY per cut — the lookup-then-create is
 * race-safe only because the unique key turns a lost race into a re-read.
 * (Since CP-02 the review window's CAS in front of it is what serialises.)
 */
export async function recordClientApproval(input: {
  enrollmentId: string;
  clientId: string;
  cut: { id: string; projectId: string; round: number; videoId: string | null; contentHash: string | null; sizeBytes: number | null; fileName: string | null };
  actor: ApprovalActor;
  /** OPEN top-level notes on the cut, and what the approver chose to do with them. */
  openCommentIds?: string[];
  choice?: OpenNotesChoice;
  /** CLIENT | STAFF | AUTO_EXPIRY. */
  basis?: string | null;
  windowId?: string | null;
}): Promise<{ ok: true; decisionId: string; duplicate: boolean } | { ok: false; message: string }> {
  const { cut, actor } = input;
  const open = input.openCommentIds ?? [];
  const choice = input.choice ?? "NONE";
  const dedupeKey = `sub:${cut.id}:approve`;
  const existing = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return { ok: true, decisionId: existing.id, duplicate: true };
  let decision: { id: string };
  try {
    decision = await prisma.clientDecision.create({
      data: {
        submissionId: cut.id, projectId: cut.projectId, videoId: cut.videoId, enrollmentId: input.enrollmentId, clientId: input.clientId,
        // Storage-independent (stableCutIdentity): the old cutIdentityHash
        // folded in the blob URL, which the 90-day prune and the private-store
        // cutover both rewrite — voiding every approval on either event.
        round: cut.round, contentHash: stableCutIdentity(cut), decision: "APPROVE", openNotesChoice: open.length ? choice : "NONE", commentIdsJson: open.length ? JSON.stringify(open) : null,
        clientUserId: actor.clientUserId, staffUserId: actor.staffUserId, actorLabel: actor.actorLabel, membershipRole: actor.membershipRole,
        receiptState: "DONE", dedupeKey,
        ...(input.basis ? { basis: input.basis } : {}), ...(input.windowId ? { windowId: input.windowId } : {}),
      },
      select: { id: true },
    });
  } catch {
    const again = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (again) return { ok: true, decisionId: again.id, duplicate: true };
    return { ok: false, message: "That didn't save — try again." };
  }
  // The caches: the cut's approval pointer and the logical video's.
  await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { clientApprovedDecisionId: decision.id } }).catch(() => {});
  if (cut.videoId) {
    await prisma.contentVideo.update({ where: { id: cut.videoId }, data: { approvedSubmissionId: cut.id, status: "APPROVED" } }).catch(() => {});
  }
  if (open.length) {
    const now = new Date();
    if (choice === "DISCARD") {
      await prisma.portalComment.updateMany({ where: { id: { in: open } }, data: { status: "RESOLVED", resolvedAt: now, resolvedBy: actor.actorLabel, resolvedByKind: actor.resolvedByKind, decisionId: decision.id } });
    } else {
      await prisma.portalComment.updateMany({ where: { id: { in: open } }, data: { status: "SENT", decisionId: decision.id } });
    }
  }
  await supersedeEarlierRounds(input.enrollmentId, cut, decision.id);
  return { ok: true, decisionId: decision.id, duplicate: false };
}

export type RequestChangesResult =
  | { ok: true; decisionId: string | null; duplicate: boolean; message: string }
  | { ok: false; message: string; needsFeeAck?: boolean; ackText?: string | null };

const fmtT = (t: number | null) => (t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claim OPEN top-level notes one by one (compare-and-set on OPEN): a note two
 *  submits both saw belongs to whichever claimed it, and is sent exactly once. */
async function claimNotes(submissionId: string, enrollmentId: string, decisionId: string): Promise<string[]> {
  const open = await prisma.portalComment.findMany({ where: { submissionId, enrollmentId, status: "OPEN", parentId: null }, select: { id: true } });
  const mine: string[] = [];
  for (const n of open) {
    const r = await prisma.portalComment.updateMany({ where: { id: n.id, status: "OPEN" }, data: { status: "SENT", decisionId } });
    if (r.count === 1) mine.push(n.id);
  }
  return mine;
}

/**
 * "Submit change request." Bundles every OPEN top-level note on the cut (plus
 * an optional overall note) into ONE revision round for this video, through
 * the same machinery a text or a call uses (raiseRevisionDetailed → work
 * order pinned to the cut, the editor's task, a ping), and records the
 * decision. While a request on this cut is still open a second submit is an
 * ADDENDUM to it: its notes reach the same editor request, no second round.
 *
 * `requestKey` is the browser's id for this submit attempt: a retry of the
 * same attempt returns the same receipt and writes nothing. `acknowledgeExtraFee`
 * is the fee checkbox, required (from an OWNER seat or staff) for a round
 * beyond the plan's included ones while revision_policy is on.
 */
export async function requestChangesOnCut(
  viewer: PortalViewer,
  submissionId: string,
  generalNote: string,
  opts: { requestKey?: string | null; acknowledgeExtraFee?: boolean } = {},
): Promise<RequestChangesResult> {
  const sub = await submissionForEnrollment(viewer.enrollment, submissionId);
  if (!sub) return { ok: false, message: "That video isn't on your page." };
  const full = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { ...HASH_SELECT, projectId: true, round: true, deliverableId: true, slot: true, assetPath: true, videoId: true, status: true } });
  if (!full) return { ok: false, message: "That video isn't on your page." };
  const requestKey = typeof opts.requestKey === "string" && REQUEST_KEY_RE.test(opts.requestKey) ? opts.requestKey : null;
  // A retried submit of an attempt that already landed: the same receipt, nothing written.
  if (requestKey) {
    const seen = await prisma.clientDecision.findFirst({ where: { submissionId, enrollmentId: viewer.enrollment.id, requestKey }, select: { id: true } });
    if (seen) return { ok: true, decisionId: seen.id, duplicate: true, message: "We already have this request — it's with your editor." };
    const seenAdd = await prisma.revisionBrief.findFirst({ where: { submissionId, sourceDetail: { endsWith: `:rk:${requestKey}` } }, select: { decisionId: true } });
    if (seenAdd) return { ok: true, decisionId: seenAdd.decisionId, duplicate: true, message: "Added to your open request — your editor has been notified." };
  }
  const history = await cutHistory(viewer, submissionId);
  const me = history.find((h) => h.submissionId === submissionId);
  if (!me || !me.isCurrent) return { ok: false, message: "A newer version of this video has replaced this one — review the new version instead." };

  const staff = viewer.actor.kind === "STAFF";
  const owner = { enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId };
  const w = await ensureWindow(submissionId, owner);
  if (!w) return { ok: false, message: `That version isn't open for review — ${TEXT_KYLE} and we'll sort it out.` };
  const policy = await revisionPolicy();
  const overall = clip((generalNote ?? "").trim(), 1000);
  const by = actorLabel(viewer);
  const now = new Date();
  const ctx = { viewer, submissionId, full, projectTitle: sub.project?.title ?? null, overall, requestKey, by };

  // EVERY REFUSAL COMES BEFORE ANYTHING MOVES (review, Sep 24). A staff reopen
  // of an approved version used to un-approve it first and only then run the
  // note and fee checks — which could still say no, leaving the page reading
  // "awaiting your review" over an approval the download still honoured, and
  // the window OPEN on a deadline long passed. Now the checks run first and
  // the reopen is the same compare-and-set that records the request (g).

  // (a) An approved version: the client's verdict stands. Staff may reopen it
  // — at (g), once everything below has had its say.
  const reopening = w.state === "APPROVED" || w.state === "AUTO_APPROVED";
  if (reopening && !staff) {
    return {
      ok: false,
      message: w.state === "AUTO_APPROVED" ? stateWords("AUTO_APPROVED") : `You've already approved this version. If something still needs changing, ${TEXT_KYLE} and we'll sort it out.`,
    };
  }
  // (b) Something to send: a note on the video, or an overall note. An
  // addendum needs one too — a one-character "note" used to raise a brief,
  // reopen the editor's task and ring three people.
  const notes = await prisma.portalComment.count({ where: { submissionId, enrollmentId: viewer.enrollment.id, status: "OPEN", parentId: null } });
  if (notes === 0 && overall.length < 3) return { ok: false, message: "Add a note on the video (or an overall note) first, so the editor knows what to change." };

  // (c) A request is already open on this version: new notes join it.
  if (w.state === "CHANGES_REQUESTED") return addToOpenRequest(ctx, w.id);
  if (w.state !== "OPEN" && !reopening) return { ok: false, message: stateWords(w.state) };

  // (d) Past the deadline the window is closed to a CLIENT's new request.
  const held = enforced(w, policy);
  const late = () => lateRefusal(w, viewer);
  if (held && !staff && now.getTime() > w.deadlineAt.getTime()) return late();

  // (e) The ledger: which round this would be, and whether it is included.
  // Checked BEFORE the window is taken, so a refused ask consumes nothing.
  const used = await roundsUsed(w.videoKey);
  const next = used + 1;
  const included = next <= policy.includedRounds;
  const ackText = !included ? extraRoundAckText({ ordinal: next, includedRounds: policy.includedRounds, feeCents: policy.extraRoundFeeCents }) : null;
  const feeApplies = policy.on && !included;
  if (feeApplies && !(opts.acknowledgeExtraFee === true && mayAcknowledgeFee(viewer))) {
    return {
      ok: false, needsFeeAck: true, ackText,
      message: mayAcknowledgeFee(viewer) ? ackText! : "This would be an extra revision round for this video, which may carry a fee. Please sign in with your own account to send it, so we know who agreed.",
    };
  }
  // (f) ANTI-ABUSE, separate from idempotency: new rounds per enrollment per
  // hour. Addenda have their own spacing and hourly cap (addToOpenRequest).
  if (!staff) {
    const recent = await prisma.contentRevisionRound.count({ where: { enrollmentId: viewer.enrollment.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (recent >= Math.max(policy.maxNewRoundsPerHour, (viewer.enrollment.videosPerMonth || 0) * 2)) {
      return { ok: false, message: `We've had a lot of change requests from your account in the last hour. Your notes are saved: send this one again shortly, or ${TEXT_KYLE} if it's urgent.` };
    }
  }

  // (g) THE REFEREE. A client's request is only good before the deadline — in
  // the predicate, so it and an expiry sweep can never both win. A staff
  // reopen takes the window straight from its approved state: it is never
  // OPEN in between, where an expiry could approve it a second time.
  const prior = { state: w.state, decisionId: w.decisionId, closedAt: w.closedAt, closedReason: w.closedReason };
  const won = await claimWindow(w.id, [w.state], "CHANGES_REQUESTED", held && !staff ? { deadlineAt: { gt: now } } : {}, reopening ? { closedAt: null, closedReason: null, decisionId: null } : {});
  if (!won) {
    const again = await prisma.contentReviewWindow.findUnique({ where: { id: w.id } });
    if (again?.state === "CHANGES_REQUESTED") return addToOpenRequest(ctx, w.id);
    if (again?.state === "OPEN" && held && !staff && Date.now() > again.deadlineAt.getTime()) return late();
    return { ok: false, message: stateWords(again?.state) };
  }
  // Nothing was sent: the window goes back to exactly where it was.
  const giveBack = (holding: string | null) =>
    claimWindow(w.id, ["CHANGES_REQUESTED"], prior.state, { decisionId: holding }, reopening ? { decisionId: prior.decisionId, closedAt: prior.closedAt, closedReason: prior.closedReason } : { decisionId: null });
  const withdraw = (id: string) => prisma.clientDecision.update({ where: { id }, data: { receiptState: "SUPERSEDED", dedupeKey: null } }).catch(() => {});

  // (h) The decision, then the window's pointer, then the round — all three,
  // or none of them.
  const dedupeKey = `sub:${submissionId}:changes:open`;
  let decision: { id: string };
  try {
    decision = await prisma.clientDecision.create({
      data: {
        submissionId, projectId: full.projectId, videoId: full.videoId, enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId,
        round: full.round, contentHash: stableCutIdentity(full), decision: "REQUEST_CHANGES",
        ...stamp(viewer), actorLabel: by, membershipRole: roleOf(viewer),
        receiptState: "RECEIVED", dedupeKey, note: overall || null, windowId: w.id, basis: staff ? "STAFF" : "CLIENT", requestKey,
      },
      select: { id: true },
    });
  } catch {
    // Only a legacy open request can hold that key: it is this request.
    const legacy = await prisma.clientDecision.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (legacy) {
      await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "CHANGES_REQUESTED", decisionId: null }, data: { decisionId: legacy.id } });
      return addToOpenRequest(ctx, w.id);
    }
    await giveBack(null);
    return { ok: false, message: `That didn't send — try again in a moment, or ${TEXT_KYLE}.` };
  }
  // The pointer is written only onto the window THIS request holds. A request
  // that stalled past the repair's two minutes finds its window given back
  // (repairPortalRevisionRequests): it takes it again if nobody decided in the
  // meantime, and otherwise it never happened — an unguarded write here put a
  // change request on an OPEN window that could then be approved too.
  const pinned =
    (await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "CHANGES_REQUESTED", decisionId: null }, data: { decisionId: decision.id } })).count === 1
    || (await prisma.contentReviewWindow.count({ where: { id: w.id, state: "CHANGES_REQUESTED", decisionId: decision.id } })) === 1
    || (await claimWindow(w.id, ["OPEN"], "CHANGES_REQUESTED", { decisionId: null }, { decisionId: decision.id }));
  if (!pinned) {
    await withdraw(decision.id);
    const again = await prisma.contentReviewWindow.findUnique({ where: { id: w.id }, select: { state: true } });
    return { ok: false, message: stateWords(again?.state) };
  }

  // The round. A request with no ledger row is a free round, a lost fee
  // acknowledgement and an ask no other video's approval can see (CP-03), so
  // it is retried once with a fresh ordinal and otherwise not sent at all.
  let round: { id: string; feeDecision: string | null; feeCents: number | null } | null = null;
  for (let attempt = 1; attempt <= 2 && !round; attempt++) {
    try {
      // The ordinal is the round's place in the video's ledger (unique with the
      // video); `included` is judged on rounds USED, which a cancelled one is not.
      const top = await prisma.contentRevisionRound.aggregate({ where: { videoKey: w.videoKey }, _max: { ordinal: true } });
      const acked = feeApplies && opts.acknowledgeExtraFee === true;
      round = await prisma.contentRevisionRound.create({
        data: {
          videoKey: w.videoKey, videoId: full.videoId ?? w.videoId, outputId: w.outputId, projectId: full.projectId, enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId,
          submissionId, windowId: w.id, decisionId: decision.id, ordinal: Math.max(next, (top._max.ordinal ?? 0) + 1),
          includedRounds: policy.includedRounds, included, feeCents: feeApplies ? policy.extraRoundFeeCents : null,
          ...(acked ? { feeAckAt: now, feeAckBy: by, feeAckClientUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null, feeAckText: ackText } : {}),
          feeDecision: feeApplies ? "PENDING" : null,
          lateOverrideBy: held && staff && now.getTime() > w.deadlineAt.getTime() ? by : null,
        },
        select: { id: true, feeDecision: true, feeCents: true },
      });
    } catch (e) {
      console.error(`[clientDecisions] revision round did not record (attempt ${attempt})`, decision.id, e);
    }
  }
  if (!round) {
    await withdraw(decision.id);
    await giveBack(decision.id);
    return { ok: false, message: `That didn't send — try again in a moment, or ${TEXT_KYLE}.` };
  }

  // Only now, with the request on record, does a staff reopen set the
  // client's approval aside — pointing at the request that replaced it, so
  // the page, the download and the ledger all read the same thing.
  if (reopening) {
    const approvals = (await prisma.clientDecision.findMany({ where: { submissionId, decision: "APPROVE", receiptState: { not: "SUPERSEDED" } }, select: { id: true } })).map((d) => d.id);
    if (approvals.length) {
      await prisma.clientDecision.updateMany({ where: { id: { in: approvals } }, data: { receiptState: "SUPERSEDED", dedupeKey: null, supersededById: decision.id } });
      await prisma.reviewSubmission.updateMany({ where: { id: submissionId, clientApprovedDecisionId: { in: approvals } }, data: { clientApprovedDecisionId: null } });
      if (full.videoId) await prisma.contentVideo.updateMany({ where: { id: full.videoId, approvedSubmissionId: submissionId }, data: { approvedSubmissionId: null } });
    }
  }

  // (i) The notes this request carries — claimed one by one, so a submit that
  // raced this one cannot send the same note twice — then the editor.
  const claimed = await claimNotes(submissionId, viewer.enrollment.id, decision.id);
  await prisma.clientDecision.update({ where: { id: decision.id }, data: { commentIdsJson: claimed.length ? JSON.stringify(claimed) : null } }).catch(() => {});
  if (overall) await prisma.portalComment.create({ data: { submissionId, projectId: full.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: overall, status: "SENT", decisionId: decision.id, ...stamp(viewer) } }).catch(() => {});
  let routed = false;
  try {
    routed = !!(await routePortalRequest(decision.id));
  } catch (e) {
    // The decision, round and notes are on record; the cron repair
    // (repairPortalRevisionRequests) routes it within minutes.
    console.error("[clientDecisions] routing a portal request failed — the repair will retry", decision.id, e);
  }

  // (j) The fee is the OFFICE's decision, never the editor's business.
  if (round?.feeDecision === "PENDING") await fileFeeDecision(round.id, decision.id).catch(() => {});

  // (k) The client sent this cut back. The STATUS flip stays (the editor lane
  // and findNextCut read it) — but Jordan's QC verdict (decidedAt/decidedBy) is
  // his and is not overwritten; the client's request is its own stamp.
  await prisma.reviewSubmission.updateMany({ where: { id: submissionId, status: "APPROVED" }, data: { status: "CHANGES_REQUESTED", clientRequestedAt: now, clientRequestedBy: by } }).catch(() => {});
  if (full.videoId) await prisma.contentVideo.update({ where: { id: full.videoId }, data: { status: "EDITING" } }).catch(() => {});
  await supersedeEarlierRounds(viewer.enrollment.id, { id: submissionId, round: full.round }, decision.id);
  const feeLine = round?.feeDecision === "PENDING" ? " Our team will confirm the extra-round fee before anything is charged." : "";
  return {
    ok: true, decisionId: decision.id, duplicate: false,
    message: (routed ? "Sent to the editor — we'll text you when the new cut is ready. Your request is on record below." : "Received — it's on its way to your editor. Your request is on record below.") + feeLine,
  };
}

/** The deadline has passed on this version: the client's notes stay saved and
 *  Kyle is asked to reopen it (restartReviewClock). */
async function lateRefusal(w: { id: string; enrollmentId: string; deadlineAt: Date; round: number }, viewer: PortalViewer): Promise<RequestChangesResult> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "review_late_request",
      title: `Late change request — ${viewer.enrollment.clientName || "a client"}`,
      body: `${actorLabel(viewer)} tried to send changes on v${w.round} after its review window closed (${deadlineLabel(w.deadlineAt)}). Restart the clock to let it through.`,
      href: `/content/${w.enrollmentId}?tab=content`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `review-late-${w.id}`,
    });
  } catch { /* the refusal still stands */ }
  return { ok: false, message: `The review window for this version closed ${deadlineLabel(w.deadlineAt)}. Your notes are saved. Call or text Kyle at ${URGENT_CONTACT} and he can reopen it for you.` };
}

type RequestCtx = {
  viewer: PortalViewer;
  submissionId: string;
  full: { projectId: string; round: number; deliverableId: string | null; slot: number; fileName: string | null };
  projectTitle: string | null;
  overall: string;
  requestKey: string | null;
  by: string;
};

/**
 * ADDENDUM: the version already has an open request. The new notes join it —
 * claimed, recorded as a new brief on the SAME editor task (which goes back to
 * OPEN), and the editor is pinged. No new round, no second job. The old join
 * only relabelled PortalComment rows, which no editor surface reads, and told
 * the client their notes had been added.
 */
async function addToOpenRequest(ctx: RequestCtx, windowId: string): Promise<RequestChangesResult> {
  const { viewer, submissionId } = ctx;
  // The request that won the window may still be writing its decision; it
  // claims every OPEN note once it has, so waiting a moment keeps this simple.
  let w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId } });
  for (let i = 0; i < 15 && w && !w.decisionId && w.state === "CHANGES_REQUESTED"; i++) {
    await sleep(200);
    w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId } });
  }
  if (!w || w.state !== "CHANGES_REQUESTED") return { ok: false, message: stateWords(w?.state) };
  if (!w.decisionId) {
    // Still mid-flight: leave everything OPEN — the winner's claim, or the
    // cron repair, carries it.
    if (ctx.overall) await prisma.portalComment.create({ data: { submissionId, projectId: ctx.full.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: ctx.overall, status: "OPEN", ...stamp(viewer) } }).catch(() => {});
    return { ok: true, decisionId: null, duplicate: true, message: "Received — it goes with your request." };
  }
  const d = await prisma.clientDecision.findUnique({ where: { id: w.decisionId } });
  if (!d || d.decision !== "REQUEST_CHANGES") return { ok: false, message: stateWords(w.state) };
  if (ctx.requestKey && d.requestKey === ctx.requestKey) {
    return { ok: true, decisionId: d.id, duplicate: true, message: "We already have this request — it's with your editor." };
  }
  if (viewer.actor.kind !== "STAFF") {
    const recent = await prisma.revisionBrief.findMany({
      where: { decisionId: d.id, sourceDetail: { contains: ":addendum:" }, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      select: { createdAt: true },
    });
    const last = recent.reduce((m, r) => Math.max(m, r.createdAt.getTime()), 0);
    // Nothing is claimed: the notes stay saved on the video and go with the
    // next send.
    if (recent.length >= ADDENDA_PER_HOUR || Date.now() - last < ADDENDUM_SPACING_MS) {
      return { ok: false, message: `You just added notes to this request. Your notes are saved: send again in a couple of minutes and they'll join it, or ${TEXT_KYLE} if it's urgent.` };
    }
  }
  const claimed = await claimNotes(submissionId, viewer.enrollment.id, d.id);
  if (ctx.overall) await prisma.portalComment.create({ data: { submissionId, projectId: ctx.full.projectId, enrollmentId: viewer.enrollment.id, timeSec: null, body: ctx.overall, status: "SENT", decisionId: d.id, ...stamp(viewer) } }).catch(() => {});
  if (!claimed.length && !ctx.overall) return { ok: true, decisionId: d.id, duplicate: true, message: "We already have your request for this version." };
  await raiseAddendum(d, claimed, ctx.overall || null, ctx.by, ctx.requestKey);
  return { ok: true, decisionId: d.id, duplicate: true, message: "Added to your open request — your editor has been notified." };
}

async function raiseAddendum(d: { id: string; projectId: string; submissionId: string; clientId: string; revisionBriefId: string | null }, noteIds: string[], overall: string | null, by: string, requestKey: string | null): Promise<void> {
  const notes = noteIds.length ? await prisma.portalComment.findMany({ where: { id: { in: noteIds } }, orderBy: [{ timeSec: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], select: { timeSec: true, body: true } }) : [];
  const lines = [...notes.map((n) => `${fmtT(n.timeSec)}${n.body}`), ...(overall ? [overall] : [])];
  if (!lines.length) return;
  const [cut, round, client, project] = await Promise.all([
    prisma.reviewSubmission.findUnique({ where: { id: d.submissionId }, select: { projectId: true, deliverableId: true, slot: true, fileName: true, round: true } }),
    prisma.contentRevisionRound.findUnique({ where: { decisionId: d.id }, select: { id: true, outputId: true } }),
    prisma.client.findUnique({ where: { id: d.clientId }, select: { name: true } }),
    prisma.project.findUnique({ where: { id: d.projectId }, select: { title: true } }),
  ]);
  if (!cut) return;
  const label = await videoLabelOf(cut);
  const n = (await prisma.revisionBrief.count({ where: { decisionId: d.id, sourceDetail: { contains: ":addendum:" } } })) + 1;
  const { raiseRevisionDetailed } = await import("@/lib/comms");
  const r = await raiseRevisionDetailed({
    projectId: d.projectId, clientId: d.clientId, clientName: client?.name ?? null, propertyAddress: project?.title ?? null, source: "portal",
    note: `Additional notes from the client portal by ${by} on ${label} (v${cut.round}):\n${lines.map((l) => `• ${l}`).join("\n")}`,
    pin: { submissionId: d.submissionId, outputId: round?.outputId ?? (await outputIdFor(cut)), cutKey: cut.deliverableId ? slotKeyOf(cut.deliverableId, cut.slot) : null, decisionId: d.id, roundId: round?.id ?? null, videoLabel: label },
    addendum: { n, requestKey },
  });
  // Back to "with your editor" — unless the original request itself never got
  // there, which the repair still owes (it looks for RECEIVED).
  if (r.ok && d.revisionBriefId) {
    await prisma.clientDecision.updateMany({ where: { id: d.id, receiptState: { in: ["RECEIVED", "ROUTED", "IN_PROGRESS"] } }, data: { receiptState: "ROUTED" } });
  }
}

/**
 * Put ONE change request in front of its editor: compile the notes it claimed
 * (and its overall note) and raise the revision pinned to the exact cut. Used
 * by the submit itself and by the cron repair, so a request that did not get
 * there the first time gets there exactly the same way. Idempotent: a request
 * already routed, or whose brief exists, is only linked.
 */
export async function routePortalRequest(decisionId: string): Promise<{ taskId: string | null; briefId: string | null } | null> {
  const d = await prisma.clientDecision.findUnique({ where: { id: decisionId } });
  if (!d || d.decision !== "REQUEST_CHANGES") return null;
  if (d.revisionBriefId) return { taskId: d.revisionTaskId, briefId: d.revisionBriefId };
  const round = await prisma.contentRevisionRound.findUnique({ where: { decisionId }, select: { id: true, outputId: true, feeDecision: true } });
  const link = async (taskId: string | null, briefId: string | null) => {
    await prisma.clientDecision.updateMany({ where: { id: decisionId, revisionBriefId: null }, data: { revisionTaskId: taskId, revisionBriefId: briefId } });
    await prisma.clientDecision.updateMany({ where: { id: decisionId, receiptState: "RECEIVED" }, data: { receiptState: "ROUTED" } });
    if (round) await prisma.contentRevisionRound.update({ where: { id: round.id }, data: { revisionTaskId: taskId, revisionBriefId: briefId } }).catch(() => {});
    return { taskId, briefId };
  };
  // An earlier attempt wrote the brief and died before linking it.
  const prior = await prisma.revisionBrief.findFirst({ where: { decisionId, sourceDetail: `decision:${decisionId}` }, select: { id: true, taskId: true } });
  if (prior) return link(prior.taskId, prior.id);
  // Jordan's default routes an extra round at once; the other branch waits for
  // the office (reviewWindows.EXTRA_ROUND_ROUTES_IMMEDIATELY).
  if (round?.feeDecision === "PENDING" && !EXTRA_ROUND_ROUTES_IMMEDIATELY) return null;
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: d.submissionId }, select: { projectId: true, deliverableId: true, slot: true, fileName: true, round: true, project: { select: { title: true } } } });
  if (!cut) return null;
  let ids: string[] = [];
  try { ids = d.commentIdsJson ? (JSON.parse(d.commentIdsJson) as string[]) : []; } catch { /* no notes recorded */ }
  const notes = ids.length
    ? await prisma.portalComment.findMany({ where: { id: { in: ids } }, orderBy: [{ timeSec: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], select: { timeSec: true, body: true } })
    : [];
  const lines = [...notes.map((n) => `${fmtT(n.timeSec)}${n.body}`), ...(d.note ? [d.note] : [])];
  if (!lines.length) {
    // Every note it saw was claimed by a submit that raced it and went to the
    // editor as an addendum on this very request: that brief IS its routing.
    const addendum = await prisma.revisionBrief.findFirst({ where: { decisionId }, orderBy: { createdAt: "asc" }, select: { id: true, taskId: true } });
    return addendum ? link(addendum.taskId, addendum.id) : null;
  }
  const label = await videoLabelOf(cut);
  const street = cut.project?.title?.split(",")[0] ?? null;
  // The compiled note is the client's words and nothing else — in particular
  // NEVER the fee (the $50 lives on the round and the office's card only).
  const compiled = `Video revision requested from the client portal by ${d.actorLabel}${street ? ` on ${street}` : ""}, ${label}${cut.fileName ? ` (cut: ${cut.fileName}, v${cut.round})` : ""}:\n${lines.map((l) => `• ${l}`).join("\n")}`;
  const client = await prisma.client.findUnique({ where: { id: d.clientId }, select: { name: true } });
  const { raiseRevisionDetailed } = await import("@/lib/comms");
  const r = await raiseRevisionDetailed({
    projectId: d.projectId, clientId: d.clientId, clientName: client?.name ?? null, propertyAddress: cut.project?.title ?? null, note: compiled, source: "portal",
    pin: { submissionId: d.submissionId, outputId: round?.outputId ?? (await outputIdFor(cut)), cutKey: cut.deliverableId ? slotKeyOf(cut.deliverableId, cut.slot) : null, decisionId, roundId: round?.id ?? null, videoLabel: label },
  });
  if (!r.ok) throw new Error("the revision could not be raised");
  return link(r.taskId, r.briefId);
}

/** The office's card for an extra round: charge or waive. OWNER/ADMIN bell,
 *  Kyle's queue — never an editor surface, and nothing is charged. */
async function fileFeeDecision(roundId: string, decisionId: string): Promise<void> {
  const round = await prisma.contentRevisionRound.findUnique({ where: { id: roundId } });
  if (!round || round.feeDecision !== "PENDING") return;
  const [d, cut, client, kyle] = await Promise.all([
    prisma.clientDecision.findUnique({ where: { id: decisionId }, select: { actorLabel: true } }),
    prisma.reviewSubmission.findUnique({ where: { id: round.submissionId }, select: { projectId: true, deliverableId: true, slot: true, fileName: true, round: true } }),
    prisma.client.findUnique({ where: { id: round.clientId }, select: { name: true } }),
    prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } }),
  ]);
  const label = cut ? await videoLabelOf(cut) : "a video";
  const fee = `$${((round.feeCents ?? 0) / 100).toFixed(0)}`;
  const key = `revision-fee:${round.id}`;
  await prisma.smartTask.createMany({
    data: [{
      taskType: "revision_fee", status: "OPEN", source: "content_program", priority: "MEDIUM",
      title: `Extra revision round: charge or waive — ${client?.name ?? "client"} · ${label}`.slice(0, 140),
      summary: `Client acknowledged the ${fee} extra-round fee — charge or waive. ${d?.actorLabel ?? "The client"} asked for round ${round.ordinal} on ${label}; the plan includes ${round.includedRounds} per video. The editor already has the work, and nothing is charged automatically.`.slice(0, 500),
      description: `What they agreed to, word for word:\n“${round.feeAckText ?? "(no acknowledgement recorded)"}”\n\nAcknowledged by ${round.feeAckBy ?? "?"} at ${round.feeAckAt?.toISOString() ?? "?"}.\nDecide on the client's Content tab (/content/${round.enrollmentId}?tab=content). Recording CHARGE bills nothing: invoice it the usual way.`.slice(0, 4000),
      reasonCreated: "A client acknowledged an extra revision round (CP-02)",
      clientId: round.clientId, projectId: round.projectId, assignedKey: "kyle", ownerId: kyle?.id ?? null, dedupeKey: key,
      dueAt: new Date(Date.now() + 864e5),
    }],
    skipDuplicates: true,
  });
  const task = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } });
  if (task) await prisma.contentRevisionRound.updateMany({ where: { id: round.id, feeTaskId: null }, data: { feeTaskId: task.id } });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "revision_fee",
      title: `Extra revision round — ${client?.name ?? "a client"}`,
      body: `${label}: round ${round.ordinal} (plan includes ${round.includedRounds}). ${fee} fee acknowledged — charge or waive.`,
      href: `/content/${round.enrollmentId}?tab=content`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `revision-fee-${round.id}`,
    });
  } catch { /* the card is the record */ }
}

/**
 * The cron's safety net for portal requests (libraryRepair step). Three cases,
 * each normally empty:
 *   · a request still RECEIVED with no brief two minutes on — routing failed
 *     after the decision was written — is routed, once;
 *   · notes left OPEN beside a routed request by a submit that raced it (saved
 *     within a minute of the request) go to the editor as an addendum;
 *   · a window taken for a request whose decision never got written is given
 *     back, so the client can send it again — to APPROVED when it was a staff
 *     reopen of a still-live approval, never to OPEN over it. A window whose
 *     request DID write its decision (the process died before the pointer, or
 *     is still running slowly) is pointed at it instead of released: releasing
 *     it put a change request on an OPEN window that could then be approved.
 */
export async function repairPortalRevisionRequests(opts: { now?: Date; max?: number } = {}): Promise<{ routed: number; addenda: number; released: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - 2 * 60_000);
  const max = opts.max ?? 50;
  let routed = 0, addenda = 0, released = 0;
  const stuck = await prisma.clientDecision.findMany({
    where: { decision: "REQUEST_CHANGES", receiptState: "RECEIVED", revisionBriefId: null, windowId: { not: null }, decidedAt: { lt: cutoff } },
    orderBy: { decidedAt: "asc" }, take: max, select: { id: true },
  });
  for (const s of stuck) {
    try { if (await routePortalRequest(s.id)) routed++; } catch (e) { console.error("[repairPortalRevisionRequests] route failed", s.id, e); }
  }
  const open = await prisma.contentReviewWindow.findMany({ where: { state: "CHANGES_REQUESTED" }, orderBy: { updatedAt: "desc" }, take: 200, select: { id: true, submissionId: true, enrollmentId: true, decisionId: true, updatedAt: true } });
  for (const w of open) {
    if (!w.decisionId) {
      if (w.updatedAt >= cutoff) continue;
      const written = await prisma.clientDecision.findFirst({
        where: { windowId: w.id, submissionId: w.submissionId, decision: "REQUEST_CHANGES", receiptState: { not: "SUPERSEDED" } },
        orderBy: { decidedAt: "desc" }, select: { id: true },
      });
      if (written) {
        await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "CHANGES_REQUESTED", decisionId: null }, data: { decisionId: written.id } });
        continue;
      }
      const approval = await prisma.clientDecision.findFirst({
        where: { submissionId: w.submissionId, enrollmentId: w.enrollmentId, decision: "APPROVE", receiptState: { not: "SUPERSEDED" } },
        orderBy: { decidedAt: "desc" }, select: { id: true, basis: true },
      });
      const to = approval ? (approval.basis === "AUTO_EXPIRY" ? "AUTO_APPROVED" : "APPROVED") : "OPEN";
      if (await claimWindow(w.id, ["CHANGES_REQUESTED"], to, { decisionId: null, updatedAt: w.updatedAt }, approval ? { decisionId: approval.id, closedAt: now } : {})) released++;
      continue;
    }
    const d = await prisma.clientDecision.findUnique({ where: { id: w.decisionId } });
    if (!d || d.decision !== "REQUEST_CHANGES" || !d.revisionBriefId || d.decidedAt >= cutoff) continue;
    const strays = await prisma.portalComment.findMany({
      where: { submissionId: w.submissionId, enrollmentId: w.enrollmentId, status: "OPEN", parentId: null, createdAt: { lte: new Date(d.decidedAt.getTime() + 60_000) } },
      select: { id: true },
    });
    if (!strays.length) continue;
    const mine: string[] = [];
    for (const n of strays) {
      const r = await prisma.portalComment.updateMany({ where: { id: n.id, status: "OPEN" }, data: { status: "SENT", decisionId: d.id } });
      if (r.count === 1) mine.push(n.id);
    }
    if (!mine.length) continue;
    try { await raiseAddendum(d, mine, null, d.actorLabel, null); addenda++; } catch (e) { console.error("[repairPortalRevisionRequests] addendum failed", d.id, e); }
  }
  return { routed, addenda, released };
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
