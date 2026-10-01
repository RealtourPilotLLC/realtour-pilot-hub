"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { requireCutReviewer } from "@/lib/auth/guards";
import { cutSlots, slotKeyOf } from "@/lib/reviewCuts";
import { raiseRevisionDetailed } from "@/lib/comms";
import { saveUpload } from "@/lib/storage";
import { ingestBriefItems } from "@/lib/revisionIssues";
import { LOCAL_DEV_AUTHOR, PREVIEW_REFUSED } from "@/lib/reviewAttribution";
import { editorMeta } from "@/lib/editors";
import { staffReceiptTime, type RevisionItem } from "@/lib/revisionBrief";
import { TASK_DONE_INCLUDING_LEGACY } from "@/lib/programDeskTasks";

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
  revalidatePath(`/review/${projectId}`);
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: `Recorded for version ${cut.round}. The original words, contact, attachments and timestamp are saved; ${taskClosed ? "the revision task remains closed" : `the revision task is with ${owner}`}.`, briefId: brief.id };
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
    const prior = await prisma.revisionBrief.findFirst({
      where: { projectId, source: "review_room_staff", sourceDetail: { startsWith: "staff-cut:", endsWith: `:${requestKey}` } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
    });
    if (prior) return await finishReceipt(projectId, prior.id);
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
    if (file instanceof File && file.size > 0) {
      const meta = await saveUpload(projectId, file);
      await prisma.uploadedFile.create({ data: { projectId, deliverableId: target.cut.deliverableId, ...meta } });
      references.push({ what: meta.originalName, where: `/api/file?path=${encodeURIComponent(meta.storedPath)}` });
    }
    const actor = me?.realName ?? me?.name ?? LOCAL_DEV_AUTHOR;
    const revision = await raiseRevisionDetailed({
      projectId, clientId: project.clientId, clientName: project.client.name, propertyAddress: project.title,
      note: words, source: "review_room_staff", threadRef: sourceDetail,
      requestedBy: { name: `${actor} (on behalf of ${clientContact})`, kind: "CLIENT_STAFF", userId: me?.id ?? null },
      references,
      staffReceipt: { timeSec: at },
      pin: { submissionId, outputId: target.outputId, cutKey: target.key, decisionId: null, roundId: null, videoLabel: target.label },
    });
    if (!revision.ok || !revision.briefId) return reject("The job was flagged, but the revision record could not be completed. Ask Kyle to check the revision task before retrying.");
    return await finishReceipt(projectId, revision.briefId);
  } catch (e) {
    return reject(e instanceof Error ? e.message : "Could not record this revision. Try again.");
  }
}
