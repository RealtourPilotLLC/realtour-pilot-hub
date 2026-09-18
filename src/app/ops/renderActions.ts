"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * PUT A RENDER BACK IN THE QUEUE, FROM WHERE THE PROBLEM IS (Jordan, Sep 18
 * 2026: "I need a way to retry the render without going into connections. I
 * want kyle to be able to retry").
 *
 * The retry already existed — on /connections, beside the Topaz API key, which
 * is a page about a credential rather than a page about a job. Kyle meets a
 * failed render on his own card, reading the sentence that says why it did not
 * happen; making him leave that card, find a settings page and identify the
 * same job in a different list is three steps for a decision he has already
 * made.
 *
 * Same guard as the Connections button (ADMIN), same underlying operation, so
 * there is one retry and not two: retryTopazJob hands the old request back to
 * Topaz before starting a new one, because an accepted request can be holding a
 * credit reservation that Jordan paid for and cannot otherwise use.
 *
 * It spends money — a retry is a new render — which is why it stays behind the
 * admin guard and why the button asks before it fires.
 */
export async function retryRenderAction(jobId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { retryTopazJob } = await import("@/lib/topazJobs");
  const r = await retryTopazJob(jobId);
  // Everywhere the row can be looked at, so the card Kyle is standing on
  // updates along with the page he might open next.
  revalidatePath("/ops");
  revalidatePath("/");
  revalidatePath("/review");
  revalidatePath("/connections");
  return r;
}
