"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canViewProject, requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { outputBriefsFor } from "@/lib/deliverableOutputs";
import { assignmentDigest, assignmentKeysFor, assignmentSnapshot } from "@/lib/editorBriefReceipt";

/** Receipt for one in-house editor's current video assignment. It does not
 * change task ownership, creative approval or the manual Start/Pause clock. */
export async function acknowledgeEditorBrief(projectId: string, outputId: string, pageDigest: string): Promise<{ ok: boolean; message: string }> {
  try { await requireRole(["EDITOR"]); }
  catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Only the assigned editor can receive this brief." }; }
  const me = await getCurrentUser().catch(() => null);
  if (!me || me.realRole !== "EDITOR" || !me.editorKey || me.impersonating) return { ok: false, message: "Sign in as the assigned editor to receive this brief." };
  if (!/^[a-z0-9]{10,40}$/i.test(projectId) || !/^[a-z0-9]{10,40}$/i.test(outputId) || !(await canViewProject(projectId, me))) {
    return { ok: false, message: "This video is not on your editing list." };
  }
  try {
    const [project, briefs, keys] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { editorBrief: true, videoInstructions: true, reelScript: true } }),
      outputBriefsFor(projectId, { scrub: true }),
      assignmentKeysFor(projectId, [outputId]),
    ]);
    const brief = briefs.find((b) => b.outputId === outputId);
    if (!project || !brief || keys.get(outputId) !== me.editorKey) return { ok: false, message: "This video is no longer assigned to you. Refresh the brief." };
    const snapshot = assignmentSnapshot(brief, me.editorKey, project);
    const digest = assignmentDigest(snapshot);
    if (pageDigest !== digest) return { ok: false, message: "This video’s assignment changed. Refresh and read the current brief before acknowledging it." };
    // A concurrent second click is idempotent. The unique key preserves every
    // older version while preventing two receipts for one exact version.
    const identity = { outputId, editorKey: me.editorKey, digest };
    if (!(await prisma.editorBriefReceipt.findUnique({ where: { outputId_editorKey_digest: identity }, select: { id: true } }))) {
      await prisma.editorBriefReceipt.create({
        data: { projectId, ...identity, snapshotJson: snapshot, actorUserId: me.id, actorName: me.name?.trim() || me.email },
      }).catch((e: unknown) => { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; });
    }
    try { revalidatePath(`/edit/${projectId}`); } catch { /* outside a request */ }
    return { ok: true, message: "Received this video’s current assignment. Start editing separately when you begin work." };
  } catch {
    return { ok: false, message: "Could not save the receipt. Try again; no acknowledgment was recorded." };
  }
}
