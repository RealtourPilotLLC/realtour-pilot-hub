"use server";

import { revalidatePath } from "next/cache";
import { canViewProject, requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { outputBriefsFor, readOutputBrief } from "@/lib/deliverableOutputs";
import { assignmentIdentity, assignmentRecordsFor } from "@/lib/editorBriefReceipt";

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
    // Material reads remain outside the transaction (the shared brief readers
    // use the global client). Ownership/generation and the exact stored brief
    // version are rechecked under the same lock as assignment changes.
    const briefs = await outputBriefsFor(projectId, { scrub: true });
    const brief = briefs.find((b) => b.outputId === outputId);
    if (!brief) return { ok: false, message: "This video is no longer assigned to you. Refresh the brief." };
    const { underJobLock } = await import("@/lib/editorWork");
    const result = await underJobLock(projectId, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DeliverableOutput" WHERE "projectId" = ${projectId} AND "id" = ${outputId} FOR NO KEY UPDATE`;
      const [project, output, assignments, history] = await Promise.all([
        tx.project.findUnique({ where: { id: projectId }, select: { editorBrief: true, videoInstructions: true, reelScript: true } }),
        tx.deliverableOutput.findUnique({ where: { id: outputId }, select: { briefJson: true } }),
        assignmentRecordsFor(projectId, [outputId], tx),
        tx.editorBriefReceipt.findMany({ where: { projectId, outputId, editorKey: me.editorKey! }, select: { digest: true, acceptedAt: true } }),
      ]);
      const assignment = assignments.get(outputId);
      if (!project || !output || assignment?.editorKey !== me.editorKey) return { ok: false, message: "This video is no longer assigned to you. Refresh the brief." };
      if ((readOutputBrief(output.briefJson)?.version ?? null) !== brief.version) return { ok: false, message: "The brief changed. Refresh and read it before acknowledging." };
      const { snapshot, digest } = assignmentIdentity(brief, me.editorKey!, project, assignment.changedAt, history);
      if (pageDigest !== digest) return { ok: false, message: "This video’s assignment changed. Refresh and read the current brief before acknowledging it." };
      await tx.editorBriefReceipt.createMany({ data: [{ projectId, outputId, editorKey: me.editorKey!, digest, snapshotJson: snapshot, actorUserId: me.id, actorName: me.name?.trim() || me.email }], skipDuplicates: true });
      return { ok: true, message: brief.brandChoice === "none"
        ? "Received this assignment, including the intentional choice to use no logo or branding card. Start editing separately when you begin work."
        : "Received this video’s current assignment. Start editing separately when you begin work." };
    }, "an exact assignment receipt");
    if (!result.ok) return result;
    try { revalidatePath(`/edit/${projectId}`); } catch { /* outside a request */ }
    return result;
  } catch {
    return { ok: false, message: "The receipt could not be confirmed. Refresh to check it; your exact assignment receipt is safe to repeat." };
  }
}
