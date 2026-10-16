"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { displayNameFor } from "@/lib/actorName";
import { LOCAL_DEV_AUTHOR, PREVIEW_REFUSED } from "@/lib/reviewAttribution";
import { isCheckBlock, type CheckAnswer } from "@/lib/reviewChecklistCore";

// ---------------------------------------------------------------------------
// The Review Room's two new writes (Oct 15 2026): save one block of the
// reviewer's two-part check (lib/reviewChecklist.ts), and answer a creative
// review (lib/creativeReview.ts). Both refuse a "view as" preview, like every
// verdict-shaped write in this room.
// ---------------------------------------------------------------------------

async function author(): Promise<{ name: string; userId: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { name: LOCAL_DEV_AUTHOR, userId: null };
  return { name: (await displayNameFor(u)) ?? "Reviewer", userId: u.id };
}

export async function saveReviewCheck(input: { submissionId: string; block: string; answers: CheckAnswer[]; note?: string | null }): Promise<{ ok: boolean; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: PREVIEW_REFUSED };
  try {
    await requireCutReviewer();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!isCheckBlock(input.block)) return { ok: false, message: "That isn't one of the checks." };
  if (!Array.isArray(input.answers)) return { ok: false, message: "Tick every line first." };
  const { recordReviewCheck } = await import("@/lib/reviewChecklist");
  const who = await author();
  const r = await recordReviewCheck({
    submissionId: input.submissionId, block: input.block, answers: input.answers, note: input.note ?? null,
    actor: me, authorName: who.name, authorUserId: who.userId, authEnforced: authEnforced(),
  });
  if (r.ok) {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { projectId: true } }).catch(() => null);
    if (sub) revalidatePath(`/review/${sub.projectId}`);
  }
  return r;
}

export async function resolveCreativeReviewAction(input: { briefId: string; mode: string; changes?: string | null; note?: string | null }): Promise<{ ok: boolean; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: PREVIEW_REFUSED };
  // Creative direction is Jordan's or the creative approver's (James), the
  // same people who sign the creative check on program videos.
  const { isCreativeApprover } = await import("@/lib/reviewChecklist");
  if (!(await isCreativeApprover(me, { authEnforced: authEnforced() }))) return { ok: false, message: "Creative review is Jordan's or James's call." };
  if (input.mode !== "CHANGES" && input.mode !== "AS_IS" && input.mode !== "NOT_NEEDED") return { ok: false, message: "Pick what to do with it." };
  const { resolveCreativeReview } = await import("@/lib/creativeReview");
  const who = await author();
  const r = await resolveCreativeReview({ briefId: input.briefId, mode: input.mode, changes: input.changes ?? null, note: input.note ?? null, actor: { name: who.name, userId: who.userId } });
  if (r.ok) {
    const b = await prisma.revisionBrief.findUnique({ where: { id: input.briefId }, select: { projectId: true } }).catch(() => null);
    if (b) {
      revalidatePath(`/review/${b.projectId}`);
      revalidatePath(`/edit/${b.projectId}`);
    }
  }
  return r;
}
