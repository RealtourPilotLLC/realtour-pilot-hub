import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// REOPENING AN APPROVED VIDEO FOR REVISIONS (Oct 14 2026).
//
// Jordan: "Sometimes the client will ask for a revision. Right now it makes us
// fill out a revision form. I dont want that. I want the video to be able to
// be re-opened for review / revisions in the review room, or when a client
// requests a change via open phone, just as the normal review process is.
// Same for when someone sends a message or revision request in the content
// program portal."
//
// One way back for an approved (even delivered) video, whoever asks:
//   · the Review Room: notes on the video, then "Reopen for revisions" (the
//     normal Request changes, now allowed on the current approved version);
//   · a client text (OpenPhone) or email about a delivered video;
//   · a portal message or change request about an approved video.
// What reopening means, always the same:
//   · only the CURRENT version of that video (a newer upload is ruled on
//     instead), compare-and-set so two asks never both win;
//   · the cut goes APPROVED → CHANGES_REQUESTED: the Review Room shows it as
//     back with the editor, and the editor's next upload is the next round;
//   · the job goes to Revisions (a delivered job too), with the clock stamp;
//   · a content-program video: the client's approval is set aside, the review
//     window closes as changes requested, and the video reads "editing";
//   · a line on the job's timeline saying who reopened it and why.
// The copy in 05-Final-Video stays until the next approval moves it aside
// (startDropboxCopy), and the client keeps the delivered video in their
// library meanwhile: they already have it, and the new version joins it.
// ---------------------------------------------------------------------------

export type ReopenSource = "review_room" | "text" | "email" | "call" | "portal";

type Sub = { id: string; projectId: string; status: string; round: number; deliverableId: string | null; slot: number | null; kind?: string | null };

/** The newest live version of this cut's video, or null when `sub` is it. */
export async function newerVersionOf(sub: Sub): Promise<{ id: string; round: number } | null> {
  if (!sub.deliverableId) return null;
  return prisma.reviewSubmission.findFirst({
    where: { projectId: sub.projectId, deliverableId: sub.deliverableId, slot: sub.slot ?? 1, round: { gt: sub.round }, status: { notIn: ["WITHDRAWN", "UPLOAD_FAILED"] } },
    orderBy: { round: "desc" },
    select: { id: true, round: true },
  });
}

/**
 * Everything a reopen changes besides the cut's own status, for a caller that
 * has ALREADY won the compare-and-set on the cut (the Review Room does its own,
 * inside requestCutChanges). Never throws.
 */
export async function reopenBookkeeping(sub: Sub, opts: { by: string; why: string; source: ReopenSource }): Promise<void> {
  const now = new Date();
  try {
    // The job is in revisions again, delivered or not.
    const p = await prisma.project.findUnique({ where: { id: sub.projectId }, select: { status: true } });
    if (p && ["DELIVERED", "REVIEW", "EDITING", "REVISION"].includes(p.status)) {
      await prisma.project.update({ where: { id: sub.projectId }, data: { status: "REVISION", revisionRequestedAt: now, statusPinnedAt: null } });
    }
  } catch (e) {
    console.error("[reopen] job status", sub.id, e);
  }
  try {
    // A content-program video: the client's approval is set aside and the
    // window closes as changes requested, so the portal says "we're on it".
    const approvals = (await prisma.clientDecision.findMany({ where: { submissionId: sub.id, decision: "APPROVE", receiptState: { not: "SUPERSEDED" } }, select: { id: true } })).map((d) => d.id);
    if (approvals.length) {
      await prisma.clientDecision.updateMany({ where: { id: { in: approvals } }, data: { receiptState: "SUPERSEDED", dedupeKey: null } });
      await prisma.reviewSubmission.updateMany({ where: { id: sub.id, clientApprovedDecisionId: { in: approvals } }, data: { clientApprovedDecisionId: null } });
    }
    await prisma.contentReviewWindow.updateMany({ where: { submissionId: sub.id, state: { in: ["APPROVED", "AUTO_APPROVED", "OPEN"] } }, data: { state: "CHANGES_REQUESTED", closedAt: now, closedReason: `REOPENED_${opts.source.toUpperCase()}` } });
    const videos = await prisma.contentVideo.findMany({ where: { approvedSubmissionId: sub.id }, select: { id: true } });
    if (videos.length) await prisma.contentVideo.updateMany({ where: { id: { in: videos.map((v) => v.id) } }, data: { approvedSubmissionId: null, status: "EDITING" } });
  } catch (e) {
    console.error("[reopen] program ledger", sub.id, e);
  }
  try {
    const where = opts.source === "review_room" ? "in the Review Room" : opts.source === "portal" ? "from the client portal" : opts.source === "text" ? "from a client text" : opts.source === "email" ? "from a client email" : "from a client call";
    await prisma.activity.create({ data: { projectId: sub.projectId, type: "SYSTEM", body: `Reopened for revisions ${where}: version ${sub.round} was approved${opts.by ? `, reopened by ${opts.by}` : ""}. ${opts.why}`.slice(0, 1000) } });
  } catch { /* the timeline line is a courtesy */ }
  try {
    const { ensureOutputsForProject, refreshOutputsForProject } = await import("@/lib/deliverableOutputs");
    await ensureOutputsForProject(sub.projectId);
    await refreshOutputsForProject(sub.projectId);
  } catch { /* the hourly sweep repairs the per-video rows */ }
}

/**
 * Reopen an approved cut for a client's ask that arrived outside the Review
 * Room (a text, an email, a portal message). The cut's status and the
 * bookkeeping; the caller raises the revision (the brief and the editor's
 * bell) with a pin to this cut.
 */
export async function reopenApprovedCut(submissionId: string, opts: { by: string; why: string; source: ReopenSource }): Promise<{ ok: boolean; reopened: boolean; message: string }> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { id: true, projectId: true, status: true, round: true, deliverableId: true, slot: true, kind: true } });
  if (!sub) return { ok: false, reopened: false, message: "That video no longer exists." };
  if (sub.status === "CHANGES_REQUESTED") return { ok: true, reopened: false, message: "It is already back with the editor." };
  if (sub.status !== "APPROVED") return { ok: false, reopened: false, message: "Only an approved video can be reopened." };
  const newer = await newerVersionOf(sub);
  if (newer) return { ok: false, reopened: false, message: `A newer version (v${newer.round}) is in already; the change goes on that one.` };
  const now = new Date();
  const client = opts.source !== "review_room";
  const won = await prisma.reviewSubmission.updateMany({
    where: { id: sub.id, status: "APPROVED" },
    data: client
      ? { status: "CHANGES_REQUESTED", completedAt: null, clientRequestedAt: now, clientRequestedBy: opts.by.slice(0, 120) }
      : { status: "CHANGES_REQUESTED", completedAt: null, decidedAt: now, decidedBy: opts.by.slice(0, 120) },
  });
  if (!won.count) return { ok: true, reopened: false, message: "Someone ruled on it a moment ago." };
  await reopenBookkeeping(sub, opts);
  return { ok: true, reopened: true, message: `Reopened for revisions (version ${sub.round}).` };
}

/**
 * The one approved video a client most likely means, for an ask that names
 * none: the job's current approved video versions; exactly one → that one.
 * Several (a four-video batch) → null, and the brief's own reading of the
 * words picks, or the office does.
 */
export async function soleApprovedVideo(projectId: string): Promise<{ submissionId: string; outputId: string | null; cutKey: string | null; videoLabel: string } | null> {
  const approved = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "APPROVED", deliverableId: { not: null } },
    orderBy: { round: "desc" },
    select: { id: true, projectId: true, status: true, round: true, deliverableId: true, slot: true, outputId: true, kind: true },
  });
  const current: typeof approved = [];
  for (const s of approved) {
    if ((s.kind ?? "video") !== "video") continue;
    if (current.some((c) => c.deliverableId === s.deliverableId && (c.slot ?? 1) === (s.slot ?? 1))) continue;
    if (await newerVersionOf(s)) continue;
    current.push(s);
  }
  if (current.length !== 1) return null;
  const s = current[0];
  const { slotKeyOf, cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(projectId).catch(() => []);
  const label = slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === (s.slot ?? 1))?.label ?? "the video";
  return { submissionId: s.id, outputId: s.outputId ?? null, cutKey: slotKeyOf(s.deliverableId!, s.slot ?? 1), videoLabel: label };
}

/**
 * The approved program video a portal message is about: the one it names
 * (a VIDEO reference), else the enrollment's only video approved in the last
 * 45 days. Several, or none → null (the office decides, as before).
 */
export async function approvedProgramVideoFor(enrollmentId: string, videoId?: string | null): Promise<{ projectId: string; submissionId: string; outputId: string | null; cutKey: string | null; videoLabel: string } | null> {
  const videos = await prisma.contentVideo.findMany({
    where: { enrollmentId, approvedSubmissionId: { not: null }, ...(videoId ? { id: videoId } : { updatedAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }) },
    select: { id: true, title: true, approvedSubmissionId: true },
    take: 5,
  });
  if (videos.length !== 1) return null;
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: videos[0].approvedSubmissionId! }, select: { id: true, projectId: true, status: true, round: true, deliverableId: true, slot: true, outputId: true } });
  if (!sub?.deliverableId || sub.status !== "APPROVED" || (await newerVersionOf(sub))) return null;
  const { slotKeyOf, cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(sub.projectId).catch(() => []);
  const label = slots.find((sl) => sl.deliverableId === sub.deliverableId && sl.slot === (sub.slot ?? 1))?.label ?? videos[0].title ?? "the video";
  return { projectId: sub.projectId, submissionId: sub.id, outputId: sub.outputId ?? null, cutKey: slotKeyOf(sub.deliverableId, sub.slot ?? 1), videoLabel: label };
}
