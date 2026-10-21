"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { displayNameFor } from "@/lib/actorName";
import { LOCAL_DEV_AUTHOR, PREVIEW_REFUSED } from "@/lib/reviewAttribution";

// ---------------------------------------------------------------------------
// Answer a creative review (lib/creativeReview.ts, Oct 15 2026). It refuses a
// "view as" preview, like every verdict-shaped write in this room. Oct 20 2026
// (audit B5): the reviewer checklist's save (saveReviewCheck) was removed with
// its gate; no screen had offered it since Oct 16.
// ---------------------------------------------------------------------------

async function author(): Promise<{ name: string; userId: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { name: LOCAL_DEV_AUTHOR, userId: null };
  return { name: (await displayNameFor(u)) ?? "Reviewer", userId: u.id };
}

export async function resolveCreativeReviewAction(input: { briefId: string; mode: string; changes?: string | null; note?: string | null }): Promise<{ ok: boolean; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: PREVIEW_REFUSED };
  // Creative direction is Jordan's or the creative approver's (James), the
  // creative-approver seat (lib/reviewChecklist.isCreativeApprover).
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
