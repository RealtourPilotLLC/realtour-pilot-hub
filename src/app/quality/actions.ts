"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// Mark one piece of client feedback handled (or put it back). `Feedback.resolved`
// has existed since the model was written and nothing has ever set it — an
// unhappy client stayed "open" forever with no way to close the loop, so the
// Unhandled count on /quality could only ever go up. Owner/admin only, same as
// the page. The NEGATIVE ones also raise an URGENT SmartTask (see
// recordFeedback); this flag is the record on the feedback row itself.
export async function setFeedbackHandled(id: string, handled: boolean): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." };
  }
  // The WRITE has to be inside a try too. With only requireAdmin() guarded, a
  // failed update (row deleted under them, a Neon blip, a pool timeout) threw
  // past the return, the transition settled, and the optimistic button sat
  // there reading "Handled" on a row that never saved — the exact "looks like
  // it saved" lie the guard above was added to stop.
  try {
    await prisma.feedback.update({ where: { id }, data: { resolved: handled } });
  } catch (e) {
    console.error("[quality] setFeedbackHandled failed", { id, handled, error: e });
    const gone = e instanceof Error && "code" in e && (e as { code?: string }).code === "P2025";
    return {
      ok: false,
      message: gone ? "That feedback is no longer there — refresh the page." : "That didn't save. Try again.",
    };
  }
  revalidatePath("/quality");
  return { ok: true };
}
