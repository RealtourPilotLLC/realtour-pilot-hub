"use server";

import { revalidatePath } from "next/cache";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { JobMedium } from "@/lib/jobChecks";

// ---------------------------------------------------------------------------
// ONE "CHECKED" PER JOB (Oct 19 2026). Pressed from the "Before you send" box
// (components/jobs/BeforeYouSend) on the photo job page, the editor brief, the
// Review Room and the Ready to send rows. Every open client request on the job
// for this medium (the ones the box shows) is Confirmed with who pressed it,
// and the job's timeline gets one line. Barry Rd had six rows to press; now
// it is one.
//
// A server action is a public POST: guarded like the ask buttons
// (ops/requests/actions): owner/admin or a named review seat, never while
// previewing someone else ("view as"). Answers { ok, message } in plain words;
// nothing throws to the page.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;

async function who(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? "staff" : "Owner";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

export async function confirmJobRequests(projectId: string, medium: JobMedium): Promise<{ ok: boolean; message: string }> {
  try {
    await requireCutReviewer();
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
  }
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: "That job is no longer here. Reload the page." };
  if (medium !== "photo" && medium !== "video") return { ok: false, message: "Reload the page and try again." };
  try {
    const { jobRequests, confirmAsks } = await import("@/lib/clientAsks");
    const open = await jobRequests(projectId, medium);
    if (!open.length) return { ok: true, message: "Nothing left to check on this job." };
    const by = await who();
    const r = await confirmAsks(open.map((a) => a.id), by, `checked on the ${medium === "photo" ? "photos" : "video"}`);
    revalidatePath(`/review/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/edit/${projectId}`);
    revalidatePath("/ops/photo-delivery", "layout");
    revalidatePath("/ops/video-delivery");
    revalidatePath("/ops/requests");
    revalidatePath("/");
    if (!r.confirmed) return { ok: true, message: "Someone checked these a moment ago. Nothing changed." };
    return { ok: true, message: `Checked ${r.confirmed === 1 ? "1 request" : `${r.confirmed} requests`}, saved as checked by ${by}.` };
  } catch (e) {
    console.error("[job-checks] confirm failed", projectId, e);
    return { ok: false, message: "That didn't go through. Reload the page to see what is saved, then try again." };
  }
}
