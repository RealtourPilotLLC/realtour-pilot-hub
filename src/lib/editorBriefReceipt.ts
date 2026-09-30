import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { editorKeyForTeamName } from "@/lib/editors";
import type { OutputBrief } from "@/lib/deliverableOutputs";
import { stripMoneySentences } from "@/lib/text";

export type AssignmentContext = {
  editorBrief: string | null;
  videoInstructions: string | null;
  reelScript: string | null;
};

/** The material the editor receives, with a stable order and no current cut
 * status. A new cut round does not invalidate an assignment receipt; changed
 * direction, script, chosen asset, source, due date or owner does. */
export function assignmentSnapshot(brief: OutputBrief, editorKey: string, context: AssignmentContext): string {
  const safe = (text: string | null) => text ? stripMoneySentences(text).trim() : null;
  return JSON.stringify({
    outputId: brief.outputId,
    key: brief.key,
    label: brief.label,
    format: brief.format,
    editorKey,
    promisedAtISO: brief.promisedAtISO,
    targetAtISO: brief.targetAtISO,
    briefVersion: brief.version,
    sections: brief.sections,
    sharedInstructions: { editorBrief: safe(context.editorBrief), videoInstructions: safe(context.videoInstructions), reelScript: safe(context.reelScript) },
    topicTitle: brief.topicTitle,
    filmedNote: brief.note,
    script: brief.script ? { title: brief.script.title, versionNo: brief.script.versionNo, text: brief.script.text, standing: brief.script.standing, clientApproved: brief.script.clientApproved, direction: brief.script.direction } : null,
    brandAsset: brief.brandAsset ? { versionId: brief.brandAsset.versionId, state: brief.brandAsset.state, name: brief.brandAsset.name } : null,
    folder: brief.folder ? { path: brief.folder.path, label: brief.folder.label } : null,
  });
}

export function assignmentDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

/** A saved owner is required. Routing suggestions do not count as assignments,
 * and an explicit output owner wins over the job's editor. */
export async function assignmentKeysFor(projectId: string, outputIds: string[]): Promise<Map<string, string | null>> {
  const [project, outputs] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { editorManual: true, editorVendorKey: true, editor: { select: { name: true } },
        smartTasks: { where: { taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { updatedAt: "desc" }, take: 1, select: { assignedKey: true } } },
    }),
    prisma.deliverableOutput.findMany({ where: { projectId, id: { in: outputIds }, removedFromOrderAt: null, waivedAt: null }, select: { id: true, ownerKey: true } }),
  ]);
  const task = project?.smartTasks[0];
  const jobKey = task
    ? task.assignedKey
    : project?.editorManual && !project.editor && !project.editorVendorKey
      ? null
      : editorKeyForTeamName(project?.editor?.name) ?? project?.editorVendorKey ?? null;
  return new Map(outputs.map((o) => [o.id, o.ownerKey ?? jobKey ?? null]));
}

export type AssignmentReceiptState = {
  digest: string;
  editorKey: string | null;
  acceptedAtISO: string | null;
  acceptedBy: string | null;
  changedSinceReceipt: boolean;
};

export async function assignmentReceiptStates(projectId: string, briefs: OutputBrief[], context: AssignmentContext): Promise<Map<string, AssignmentReceiptState>> {
  const ids = briefs.map((b) => b.outputId);
  const keys = await assignmentKeysFor(projectId, ids);
  const receipts = await prisma.editorBriefReceipt.findMany({ where: { projectId, outputId: { in: ids } }, orderBy: { acceptedAt: "desc" }, select: { outputId: true, editorKey: true, digest: true, actorName: true, acceptedAt: true } });
  const out = new Map<string, AssignmentReceiptState>();
  for (const b of briefs) {
    const editorKey = keys.get(b.outputId) ?? null;
    const digest = editorKey ? assignmentDigest(assignmentSnapshot(b, editorKey, context)) : "";
    const latest = receipts.find((r) => r.outputId === b.outputId && r.editorKey === editorKey);
    out.set(b.outputId, {
      digest,
      editorKey,
      acceptedAtISO: latest?.acceptedAt.toISOString() ?? null,
      acceptedBy: latest?.actorName ?? null,
      changedSinceReceipt: !!latest && latest.digest !== digest,
    });
  }
  return out;
}
