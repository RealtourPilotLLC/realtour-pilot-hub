"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// §7.6 × §7.5 (Sep 28 2026): a limitation written on one video's brief becomes
// missing work in ONE press, signed by whoever pressed it. The office's —
// requireAdmin, and a "view as" preview is refused there too. Nothing is
// waived, booked or charged: lib/productionGaps.raiseGapFromBrief records the
// gap, and the office plans its recovery like any other.
// ---------------------------------------------------------------------------

export async function raiseGapFromBriefAction(
  projectId: string,
  outputId: string,
): Promise<{ ok: boolean; created: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, created: false, message: e instanceof Error ? e.message : "Only the office can raise missing work." };
  }
  const me = await getCurrentUser().catch(() => null);
  const { displayNameFor } = await import("@/lib/actorName");
  const actor = (await displayNameFor(me).catch(() => null)) ?? "the office";
  const { raiseGapFromBrief } = await import("@/lib/productionGaps");
  const r = await raiseGapFromBrief({ outputId, projectId, actor });
  if (!r.ok) return { ok: false, created: false, message: r.message };
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  return {
    ok: true,
    created: r.created,
    message: r.created ? "Raised as missing work. It is on the delivery board until the office plans the recovery." : "Already raised as missing work.",
  };
}

/** The plain form post from the brief card on /edit/<id>; lands back on that video's brief. */
export async function raiseGapFromBriefForm(form: FormData): Promise<void> {
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const projectId = text("projectId");
  const outputId = text("outputId");
  const r = await raiseGapFromBriefAction(projectId, outputId);
  const { redirect } = await import("next/navigation");
  redirect(`/edit/${encodeURIComponent(projectId)}?notice=${r.ok ? (r.created ? "gap-raised" : "gap-exists") : "gap-error"}#brief-${outputId}`);
}
