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
    const prior = await prisma.revisionBrief.findFirst({ where: { projectId, source: "review_room_staff", sourceDetail }, select: { id: true } });
    if (prior) return { ok: true, message: `Already recorded for ${target.label}, version ${target.cut.round}.`, briefId: prior.id };

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
      pin: { submissionId, outputId: target.outputId, cutKey: target.key, decisionId: null, roundId: null, videoLabel: target.label },
    });
    if (!revision.ok || !revision.briefId) return reject("The job was flagged, but the revision record could not be completed. Ask Kyle to check the revision task before retrying.");
    await ingestBriefItems(revision.briefId);
    const issueCount = await prisma.revisionIssue.count({ where: { projectId, sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${revision.briefId}:` } } });
    if (!issueCount) return reject("The revision task and the client's words were saved, but the video issue did not appear. Ask Kyle to check the revision record before retrying.");
    if (at !== null) await prisma.revisionIssue.updateMany({
      where: { projectId, sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${revision.briefId}:` } }, data: { timeSec: at },
    });
    const assigned = revision.taskId ? await prisma.smartTask.findUnique({ where: { id: revision.taskId }, select: { assignedKey: true } }) : null;
    const owner = assigned?.assignedKey === "kyle" ? "Kyle for routing" : assigned?.assignedKey ? `${editorMeta(assigned.assignedKey)?.name ?? assigned.assignedKey}'s queue` : "the office for assignment";
    revalidatePath(`/review/${projectId}`);
    revalidatePath(`/edit/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Recorded for ${target.label}, version ${target.cut.round}. The original words are saved; the revision task is with ${owner}.`, briefId: revision.briefId };
  } catch (e) {
    return reject(e instanceof Error ? e.message : "Could not record this revision. Try again.");
  }
}
