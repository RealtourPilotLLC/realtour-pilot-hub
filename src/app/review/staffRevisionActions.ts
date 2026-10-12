"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { requireCutReviewer } from "@/lib/auth/guards";
import { cutSlots, slotKeyOf } from "@/lib/reviewCuts";
import { applySavedStaffRevision } from "@/lib/comms";
import { ingestBriefItems } from "@/lib/revisionIssues";
import { LOCAL_DEV_AUTHOR, PREVIEW_REFUSED } from "@/lib/reviewAttribution";
import { editorMeta } from "@/lib/editors";
import { createRevisionBrief, staffReceiptTime, staffReceiptIntake, type RevisionItem } from "@/lib/revisionBrief";
import { TASK_DONE_INCLUDING_LEGACY } from "@/lib/programDeskTasks";
import { finishStaffAttachment, skipStaffAttachment, staffAttachmentManifest } from "@/lib/staffRevisionIntake";
import { lockAdvisory } from "@/lib/dbLocks";

export type ApprovedRevisionTarget = {
  submissionId: string;
  label: string;
  round: number;
  fileName: string | null;
};

type Result = { ok: boolean; message: string; briefId?: string };
const reject = (message: string): Result => ({ ok: false, message });
const field = (data: FormData, key: string) => String(data.get(key) ?? "");

function seconds(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const m = value.trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m || Number(m[2]) > 59) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function currentApproved(projectId: string, submissionId: string) {
  const cut = await prisma.reviewSubmission.findFirst({
    where: { id: submissionId, projectId, status: "APPROVED", withdrawnAt: null, deliverableId: { not: null } },
    select: { id: true, deliverableId: true, slot: true, round: true, outputId: true, fileName: true },
  });
  if (!cut?.deliverableId) return null;
  const slot = (await cutSlots(projectId)).find((s) => s.deliverableId === cut.deliverableId && s.slot === cut.slot);
  if (!slot) return null;
  const newest = await prisma.reviewSubmission.findFirst({
    where: { projectId, deliverableId: cut.deliverableId, slot: cut.slot, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { id: true },
  });
  if (newest?.id !== cut.id) return null;
  const output = await prisma.deliverableOutput.findFirst({
    where: { projectId, deliverableId: cut.deliverableId, slot: cut.slot, waivedAt: null, removedFromOrderAt: null },
    select: { id: true, currentSubmissionId: true },
  });
  if (!output || (cut.outputId && cut.outputId !== output.id) || (output.currentSubmissionId && output.currentSubmissionId !== cut.id)) return null;
  return { cut, outputId: output.id, key: slotKeyOf(cut.deliverableId, cut.slot), label: slot.label };
}

/** The choices shown when a teammate converts a chat message into a client ask. */
export async function approvedRevisionTargets(projectId: string): Promise<ApprovedRevisionTarget[]> {
  await requireCutReviewer();
  const me = await getCurrentUser();
  if (me?.impersonating) return [];
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "APPROVED", withdrawnAt: null, deliverableId: { not: null } },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }],
    select: { id: true, round: true, fileName: true },
  });
  const out: ApprovedRevisionTarget[] = [];
  for (const row of rows) {
    const current = await currentApproved(projectId, row.id);
    if (current) out.push({ submissionId: row.id, round: row.round, fileName: row.fileName, label: current.label });
  }
  return out;
}

/** Finish only the saved receipt. Never re-raise its task, re-upload a file,
 * or adopt wording/contact/timecode from a retry of the browser form. */
async function finishReceipt(projectId: string, briefId: string): Promise<Result> {
  const brief = await prisma.revisionBrief.findFirst({ where: { id: briefId, projectId, source: "review_room_staff" } });
  if (!brief?.submissionId || !brief.outputId) return reject("The saved request is missing its exact video. Ask Kyle to check the revision record.");
  const receipt = staffReceiptTime(brief.itemsJson);
  if (!receipt) return reject("This older request was saved without a timestamp receipt. Its words and existing issues are unchanged. Ask Kyle to check the original timestamp before completing it.");
  const cut = await prisma.reviewSubmission.findFirst({ where: { id: brief.submissionId, projectId }, select: { id: true, deliverableId: true, slot: true, round: true, outputId: true } });
  if (!cut?.deliverableId) return reject("The saved request's video no longer belongs to this job. Ask Kyle to check the revision record.");
  const output = await prisma.deliverableOutput.findFirst({ where: { id: brief.outputId, projectId, deliverableId: cut.deliverableId, slot: cut.slot ?? 1 }, select: { id: true } });
  if (!output || (cut.outputId && cut.outputId !== output.id)) return reject("The saved request's video and output no longer agree. Ask Kyle to check the revision record.");
  const task = brief.taskId ? await prisma.smartTask.findFirst({ where: { id: brief.taskId, projectId }, select: { assignedKey: true, status: true } }) : null;
  if (!task) return reject("The client's words are saved, but the revision task is missing. Ask Kyle to check the saved request before creating another.");
  const taskClosed = TASK_DONE_INCLUDING_LEGACY.includes(task.status);
  let items: RevisionItem[] = [];
  try { items = JSON.parse(brief.itemsJson ?? "{}").items ?? []; } catch { /* refused below */ }
  const key = slotKeyOf(cut.deliverableId, cut.slot);
  if (!Array.isArray(items) || !items.length || items.some((i) => !i.id || i.cuts?.length !== 1 || i.cuts[0] !== key)) return reject("The saved request's work items no longer match its exact video. Ask Kyle to check the revision record.");
  const sourceIds = [...new Set(items.map((i) => `${brief.id}:${i.id}:${key}`))];
  const issueWhere = { projectId, sourceKind: "BRIEF_ITEM", sourceId: { in: sourceIds } };
  let issues = await prisma.revisionIssue.findMany({ where: issueWhere, select: { id: true, raisedOnSubmissionId: true, outputId: true } });
  if (issues.length < sourceIds.length) {
    if (taskClosed) return reject("This saved request's task is already closed, but some video issues are missing. Ask Kyle to review it; the task has not been reopened.");
    await ingestBriefItems(brief.id);
    issues = await prisma.revisionIssue.findMany({ where: issueWhere, select: { id: true, raisedOnSubmissionId: true, outputId: true } });
  }
  if (issues.length !== sourceIds.length) return reject("The revision task and the client's words are saved, but some video issues are still missing. Retry to finish this same saved request.");
  if (issues.some((issue) => issue.raisedOnSubmissionId !== cut.id || issue.outputId !== output.id)) return reject("The saved request's issues do not match its exact video version. Ask Kyle to check the revision record.");
  await prisma.revisionIssue.updateMany({ where: issueWhere, data: { timeSec: receipt.timeSec } });
  const owner = task.assignedKey === "kyle" ? "Kyle for routing" : task.assignedKey ? `${editorMeta(task.assignedKey)?.name ?? task.assignedKey}'s queue` : "the office for assignment";
  const attachment = staffReceiptIntake(brief.itemsJson)?.attachment ?? null;
  revalidatePath(`/review/${projectId}`);
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  const kept = attachment?.state === "SKIPPED" ? "The original words, contact and timestamp are saved (the attachment was left off)" : "The original words, contact, attachments and timestamp are saved";
  return { ok: true, message: `Recorded for version ${cut.round}. ${kept}; ${taskClosed ? "the revision task remains closed" : `the revision task is with ${owner}`}.`, briefId: brief.id };
}

async function resumeReceipt(projectId: string, briefId: string, data: FormData): Promise<Result> {
  const row = await prisma.revisionBrief.findFirst({ where: { id: briefId, projectId, source: "review_room_staff" }, select: { itemsJson: true } });
  if (row && staffReceiptIntake(row.itemsJson)) {
    const file = data.get("attachment");
    if (file instanceof File && file.size > 5_000_000) return reject("Choose an attachment smaller than 5 MB.");
    await finishStaffAttachment(briefId, file instanceof File ? file : null);
    await applySavedStaffRevision(briefId);
  }
  return finishReceipt(projectId, briefId);
}

/** Staff records a client's exact words against one approved, current version. */
export async function requestApprovedCutRevision(data: FormData): Promise<Result> {
  try {
    await requireCutReviewer();
    const me = await getCurrentUser();
    if (me?.impersonating) return reject(PREVIEW_REFUSED);
    const projectId = field(data, "projectId");
    const submissionId = field(data, "submissionId");
    const requestKey = field(data, "requestKey");
    const clientContact = field(data, "clientContact").trim();
    if (!projectId || !submissionId || !/^[a-f\d-]{36}$/i.test(requestKey)) return reject("Reload the page and try again.");
    // The request key belongs to the first saved receipt, even if a form was
    // edited or its cut was superseded before Retry. Auth/preview guards still
    // run; only a genuinely new ask uses the current-version/input guards.
    const prior = await savedReceiptFor(projectId, requestKey);
    if (prior) return await resumeReceipt(projectId, prior.id, data);
    if (data.get("confirmedClientWords") !== "yes") return reject("Confirm these are the client's own words before recording a client request.");
    if (clientContact.length < 2 || clientContact.length > 120) return reject("Name the client contact who asked for this change.");
    const at = seconds(field(data, "timecode"));
    if (at === undefined) return reject("Use a timestamp like 1:23, or leave it blank.");
    const file = data.get("attachment");
    if (file instanceof File && file.size > 5_000_000) return reject("Choose an attachment smaller than 5 MB.");
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true, title: true, client: { select: { name: true } } } });
    if (!project) return reject("This job no longer exists.");
    const target = await currentApproved(projectId, submissionId);
    if (!target) return reject("This approved video is no longer the current version. Reload and choose the current cut.");

    const sourceMessageId = field(data, "sourceMessageId");
    const sourceMessage = sourceMessageId
      ? await prisma.projectMessage.findFirst({ where: { id: sourceMessageId, projectId }, select: { body: true } })
      : null;
    if (sourceMessageId && !sourceMessage) return reject("The source team message was not found on this job.");
    const words = sourceMessage ? sourceMessage.body : field(data, "originalText");
    if (!words.trim() || words.length > 24_000) return reject("Include the client's request (up to 24,000 characters).");
    const sourceDetail = `staff-cut:${submissionId}:${requestKey}`;
    const references: { what: string; where: string }[] = [];
    if (sourceMessage) references.push({ what: "Original team message", where: `/projects/${projectId}#msg-${sourceMessageId}` });
    const actor = me?.realName ?? me?.name ?? LOCAL_DEV_AUTHOR;
    const briefId = await createRevisionBrief({
      projectId, clientName: project.client.name, propertyAddress: project.title,
      text: words, source: "review_room_staff", sourceDetail,
      requestedBy: { name: `${actor} (on behalf of ${clientContact})`, kind: "CLIENT_STAFF", userId: me?.id ?? null },
      references,
      staffReceipt: { timeSec: at, intake: { version: 1, videoLabel: target.label, attachment: await staffAttachmentManifest(projectId, requestKey, file instanceof File ? file : null) } },
      deferStaffEffects: true,
      pin: { submissionId, outputId: target.outputId, cutKey: target.key, decisionId: null, roundId: null, label: target.label },
    });
    if (!briefId) return reject("The revision receipt could not be confirmed. Retry this same request before creating another.");
    return await resumeReceipt(projectId, briefId, data);
  } catch (e) {
    return reject(e instanceof Error ? e.message : "Could not record this revision. Try again.");
  }
}

// ---------------------------------------------------------------------------
// THE SAVED REQUEST, SHOWN AND SETTLED (Oct 12 2026).
//
// Kyle's request for Mike Ciunci's Video 2 sat as a receipt with no task for
// five days: its .docx could never upload (storage.ts), and the form offered
// only "Resume saved request" — which re-showed EMPTY fields (the server never
// adopts a retry's words anyway) and failed the same way every time. The form
// now reads what was actually saved and offers three honest ways out: upload
// the same file and finish, finish without the file, or discard the request.
// ---------------------------------------------------------------------------

/** The first receipt this browser key made on this job, if any. */
async function savedReceiptFor(projectId: string, requestKey: string) {
  return prisma.revisionBrief.findFirst({
    where: { projectId, source: "review_room_staff", sourceDetail: { startsWith: "staff-cut:", endsWith: `:${requestKey}` } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
  });
}

const KEY_RE = /^[a-f\d-]{36}$/i;

export type SavedStaffRevision =
  | { found: false }
  | {
      found: true;
      requestKey: string;
      submissionId: string;
      recorded: boolean;
      videoLabel: string;
      round: number | null;
      fileName: string | null;
      contact: string;
      words: string;
      savedAtISO: string;
      attachment: null | { name: string; size: number; state: "PENDING" | "UPLOADING" | "UNKNOWN" | "CONFIRMED" | "SKIPPED" };
      /** A later version of the same video uploaded since this request was saved. */
      newerRound: number | null;
    };

/**
 * What the server actually holds for a saved request. Read-only. With this
 * browser's key: that request. With no key (a different browser, a cleared
 * one): the oldest request on this job that was saved but never handed to an
 * editor — so a stuck one is visible to whoever opens the form next, not only
 * on the one laptop that started it.
 */
export async function savedStaffRevision(projectId: string, requestKey: string | null): Promise<SavedStaffRevision> {
  await requireCutReviewer();
  if (!projectId || (requestKey !== null && !KEY_RE.test(requestKey))) return { found: false };
  const prior = requestKey
    ? await savedReceiptFor(projectId, requestKey)
    : await prisma.revisionBrief.findFirst({
        where: { projectId, source: "review_room_staff", taskId: null, sourceDetail: { startsWith: "staff-cut:" } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
      });
  if (!prior) return { found: false };
  const brief = await prisma.revisionBrief.findUnique({ where: { id: prior.id } });
  if (!brief) return { found: false };
  // sourceDetail is staff-cut:<submissionId>:<requestKey> (see the create below).
  const [, keptSubmission = "", keptKey = ""] = /^staff-cut:([^:]+):([a-f\d-]{36})$/i.exec(brief.sourceDetail ?? "") ?? [];
  if (!KEY_RE.test(keptKey)) return { found: false };
  const intake = staffReceiptIntake(brief.itemsJson);
  const cut = brief.submissionId
    ? await prisma.reviewSubmission.findFirst({ where: { id: brief.submissionId, projectId }, select: { round: true, fileName: true, deliverableId: true, slot: true } })
    : null;
  const newer = cut?.deliverableId
    ? await prisma.reviewSubmission.findFirst({
        where: { projectId, deliverableId: cut.deliverableId, slot: cut.slot, round: { gt: cut.round }, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
        orderBy: { round: "desc" }, select: { round: true },
      })
    : null;
  const contact = /\(on behalf of (.+)\)\s*$/.exec(brief.requestedBy ?? "")?.[1]?.trim() ?? brief.requestedBy ?? "";
  const a = intake?.attachment ?? null;
  return {
    found: true,
    requestKey: keptKey,
    submissionId: brief.submissionId ?? keptSubmission,
    recorded: !!brief.taskId,
    videoLabel: intake?.videoLabel ?? brief.headline?.replace(/^Changes on /, "") ?? "this video",
    round: cut?.round ?? null,
    fileName: cut?.fileName ?? null,
    contact,
    words: brief.originalText,
    savedAtISO: brief.createdAt.toISOString(),
    attachment: a ? { name: a.originalName, size: a.size, state: a.state } : null,
    newerRound: newer?.round ?? null,
  };
}

/** Finish the saved request without its attachment, then hand it off. */
export async function finishStaffRevisionWithoutAttachment(projectId: string, requestKey: string): Promise<Result> {
  try {
    await requireCutReviewer();
    const me = await getCurrentUser();
    if (me?.impersonating) return reject(PREVIEW_REFUSED);
    if (!projectId || !KEY_RE.test(requestKey)) return reject("Reload the page and try again.");
    const prior = await savedReceiptFor(projectId, requestKey);
    if (!prior) return reject("Nothing was saved for this request yet. Fill in the form and record it.");
    await skipStaffAttachment(prior.id, me?.realName ?? me?.name ?? LOCAL_DEV_AUTHOR);
    await applySavedStaffRevision(prior.id);
    return await finishReceipt(projectId, prior.id);
  } catch (e) {
    return reject(e instanceof Error ? e.message : "Could not finish this request. Try again.");
  }
}

/**
 * Throw away a saved request that never reached an editor. Refused once a task
 * exists (that request IS recorded — close the task instead) or once any video
 * issue was raised from it. The row goes, so no board counts an ask that was
 * never handed off (its due date fed the reopen clock); a job note keeps who
 * discarded what, with the words.
 */
export async function discardStaffRevision(projectId: string, requestKey: string): Promise<Result> {
  try {
    await requireCutReviewer();
    const me = await getCurrentUser();
    if (me?.impersonating) return reject(PREVIEW_REFUSED);
    if (!projectId || !KEY_RE.test(requestKey)) return reject("Reload the page and try again.");
    const prior = await savedReceiptFor(projectId, requestKey);
    if (!prior) return { ok: true, message: "Nothing was saved for that request. The form is clear." };
    const actor = me?.realName ?? me?.name ?? LOCAL_DEV_AUTHOR;
    const outcome = await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, `staff-intake:${prior.id}`);
      const row = await tx.revisionBrief.findUnique({ where: { id: prior.id }, select: { id: true, taskId: true, originalText: true, itemsJson: true, headline: true } });
      if (!row) return "gone" as const;
      if (row.taskId) return "recorded" as const;
      const issues = await tx.revisionIssue.count({ where: { projectId, sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${row.id}:` } } });
      if (issues) return "issues" as const;
      const label = staffReceiptIntake(row.itemsJson)?.videoLabel ?? row.headline?.replace(/^Changes on /, "") ?? "a video";
      const words = row.originalText.replace(/\s+/g, " ").trim();
      await tx.revisionBrief.delete({ where: { id: row.id } });
      await tx.activity.create({ data: { projectId, type: "NOTE", body: `${actor} discarded an unfinished revision request for ${label}. It was never sent to an editor. The words were: “${words.length > 300 ? `${words.slice(0, 299)}…` : words}”` } });
      return "discarded" as const;
    });
    if (outcome === "recorded") return reject("This request was already recorded and sent to the editor, so it can't be discarded here. Close its revision task instead.");
    if (outcome === "issues") return reject("Video issues were already raised from this request, so it can't be discarded here. Ask Kyle to check it.");
    revalidatePath(`/edit/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: "Discarded. Nothing was sent to an editor." };
  } catch (e) {
    return reject(e instanceof Error ? e.message : "Could not discard this request. Try again.");
  }
}
