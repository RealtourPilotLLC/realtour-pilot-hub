import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
export function assignmentSnapshot(brief: OutputBrief, editorKey: string, context: AssignmentContext, generation?: string | null): string {
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
    // Omit additive keys for legacy unspecified briefs/assignments so merely
    // deploying this policy does not invalidate their historical digests.
    ...(brief.brandChoice === "none" ? { brandChoice: "none" } : {}),
    ...(generation ? { assignmentGeneration: generation } : {}),
  });
}

export function assignmentDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

/** A saved owner is required. Routing suggestions do not count as assignments,
 * and an explicit output owner wins over the job's editor. */
type ReceiptDb = Prisma.TransactionClient | typeof prisma;
export type AssignmentRecord = { editorKey: string | null; changedAt: Date | null };

export async function assignmentRecordsFor(projectId: string, outputIds: string[] | undefined, db: ReceiptDb = prisma, includeRetired = false): Promise<Map<string, AssignmentRecord>> {
  const [project, outputs] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      select: { editorManual: true, editorVendorKey: true, editor: { select: { name: true } },
        smartTasks: { where: { taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { updatedAt: "desc" }, take: 1, select: { assignedKey: true } } },
    }),
    db.deliverableOutput.findMany({ where: { projectId, ...(outputIds ? { id: { in: outputIds } } : {}), ...(includeRetired ? {} : { removedFromOrderAt: null, waivedAt: null }) }, select: { id: true, ownerKey: true, ownerSetAt: true } }),
  ]);
  const task = project?.smartTasks[0];
  const jobKey = task
    ? task.assignedKey
    : project?.editorManual && !project.editor && !project.editorVendorKey
      ? null
      : editorKeyForTeamName(project?.editor?.name) ?? project?.editorVendorKey ?? null;
  return new Map(outputs.map((o) => [o.id, { editorKey: o.ownerKey ?? jobKey ?? null, changedAt: o.ownerSetAt }]));
}

export async function assignmentKeysFor(projectId: string, outputIds: string[]): Promise<Map<string, string | null>> {
  return new Map([...(await assignmentRecordsFor(projectId, outputIds))].map(([id, value]) => [id, value.editorKey]));
}

/** Called under the Project lock, before card writes (the Start lock order).
 * ownerSetAt records an actual effective owner transition, including inherited
 * job ownership. It does not claim an explicit owner pin or an editor Start.
 * Explicit output owners retain their generation when only the job changes.
 * Use the transaction passed here for every write in the callback. */
export async function recordEditorAssignmentChange<T>(tx: Prisma.TransactionClient, projectId: string, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  await tx.$queryRaw`SELECT "id" FROM "DeliverableOutput" WHERE "projectId" = ${projectId} ORDER BY "id" FOR NO KEY UPDATE`;
  const before = await assignmentRecordsFor(projectId, undefined, tx, true);
  const result = await write(tx);
  const after = await assignmentRecordsFor(projectId, undefined, tx, true);
  const changed = [...after].filter(([id, current]) => {
    const previous = before.get(id);
    return previous && previous.editorKey !== current.editorKey;
  });
  // Receipt time is the database's clock; generation time is the app's. A
  // transition must be later than BOTH, or a small clock skew could make an
  // old legacy receipt look as though it followed a new ownership change.
  const receiptTimes = changed.length ? await tx.editorBriefReceipt.groupBy({
    by: ["outputId"], where: { projectId, outputId: { in: changed.map(([id]) => id) } }, _max: { acceptedAt: true },
  }) : [];
  const acceptedAt = new Map(receiptTimes.map((r) => [r.outputId, r._max.acceptedAt?.getTime() ?? 0]));
  for (const [id, current] of changed) {
    const previous = before.get(id)!;
    const at = new Date(Math.max(Date.now(), (previous.changedAt?.getTime() ?? 0) + 1, (current.changedAt?.getTime() ?? 0) + 1, (acceptedAt.get(id) ?? 0) + 1));
    await tx.deliverableOutput.update({ where: { id }, data: { ownerSetAt: at } });
  }
  return result;
}

export async function withEditorAssignmentChange<T>(projectId: string, write: (tx: Prisma.TransactionClient) => Promise<T>, what = "an editor assignment change"): Promise<T> {
  const { underJobLock } = await import("@/lib/editorWork");
  return underJobLock(projectId, (tx) => recordEditorAssignmentChange(tx, projectId, write), what);
}

type ReceiptIdentityHistory = { digest: string; acceptedAt: Date };
export function assignmentIdentity(brief: OutputBrief, editorKey: string, context: AssignmentContext, changedAt: Date | null, history: ReceiptIdentityHistory[]): { snapshot: string; digest: string } {
  const legacy = assignmentSnapshot(brief, editorKey, context);
  const legacyDigest = assignmentDigest(legacy);
  // ownerSetAt may predate this policy. Keep a matching historical receipt if
  // it was recorded after that ownership change; new changes must be received.
  const compatibleLegacy = history.some((r) => r.digest === legacyDigest && (!changedAt || r.acceptedAt >= changedAt));
  const snapshot = !changedAt || compatibleLegacy ? legacy : assignmentSnapshot(brief, editorKey, context, changedAt.toISOString());
  return { snapshot, digest: assignmentDigest(snapshot) };
}

export type AssignmentReceiptState = {
  digest: string;
  editorKey: string | null;
  acceptedAtISO: string | null;
  acceptedBy: string | null;
  changedSinceReceipt: boolean;
  intentionalNoBrand?: boolean;
};

export async function assignmentReceiptStates(projectId: string, briefs: OutputBrief[], context: AssignmentContext): Promise<Map<string, AssignmentReceiptState>> {
  const ids = briefs.map((b) => b.outputId);
  const assignments = await assignmentRecordsFor(projectId, ids);
  const receipts = await prisma.editorBriefReceipt.findMany({ where: { projectId, outputId: { in: ids } }, orderBy: { acceptedAt: "desc" }, select: { outputId: true, editorKey: true, digest: true, actorName: true, acceptedAt: true } });
  const out = new Map<string, AssignmentReceiptState>();
  for (const b of briefs) {
    const assignment = assignments.get(b.outputId);
    const editorKey = assignment?.editorKey ?? null;
    const history = receipts.filter((r) => r.outputId === b.outputId && r.editorKey === editorKey);
    const digest = editorKey ? assignmentIdentity(b, editorKey, context, assignment?.changedAt ?? null, history).digest : "";
    // Exact saved evidence wins over timestamp order, including when an old
    // receipt's database clock was ahead of the current one.
    const latest = history.find((r) => r.digest === digest) ?? history[0];
    out.set(b.outputId, {
      digest,
      editorKey,
      acceptedAtISO: latest?.acceptedAt.toISOString() ?? null,
      acceptedBy: latest?.actorName ?? null,
      changedSinceReceipt: !!latest && latest.digest !== digest,
      intentionalNoBrand: b.brandChoice === "none",
    });
  }
  return out;
}
