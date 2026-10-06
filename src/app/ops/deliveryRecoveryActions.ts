"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// A PORTAL VIDEO'S ONE BUTTON (Oct 5 2026). Kyle's delivery card names what
// stands between a monthly video and the client (readyToSend.portalStepFor)
// and offers the one action that moves it. Every press answers at once; the
// slow part (Topaz's cancel call, the Dropbox move back, the library rebuild
// and portal publication) runs after the reply, and its outcome lands where
// the next look finds it: the job row, or the publication failure the card
// prints. Nothing is lost if that background work dies — the hourly
// publication repair and the five-minute Topaz lane pick the same rows up.
//
// OWNER/ADMIN only, checked here: a server action is a public endpoint.
// Nothing here reaches a client — Mark as sent records what Kyle already did.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const ID_RE = /^[a-z0-9]{10,40}$/i;

async function staff(): Promise<{ ok: true; name: string | null } | { ok: false; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "Leave preview mode before changing delivery." };
  return { ok: true, name: me?.name ?? me?.email ?? null };
}

/** after(), or now when there is no request to run after (a drill, a script). */
async function background(work: () => Promise<unknown>): Promise<void> {
  const safe = async () => {
    try { await work(); } catch (e) { console.warn("[delivery] background step failed", e); }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}

const refresh = () => {
  for (const p of ["/", "/ops", "/review", "/connections"]) {
    try { revalidatePath(p); } catch { /* outside a request */ }
  }
};

/** Run 1080p (no pass ever ran) or Retry 1080p (it did not finish). */
export async function run1080pAction(submissionId: string): Promise<Result> {
  const who = await staff();
  if (!who.ok) return who;
  if (!ID_RE.test(submissionId)) return { ok: false, message: "That video isn't on the delivery queue." };
  const job = await prisma.topazJob.findUnique({ where: { submissionId }, select: { id: true, outputCheck: true } });
  const topaz = await import("@/lib/topazJobs");
  if (!job) {
    // One insert, guarded by the one-job-per-cut constraint: instant.
    const q = await topaz.queueTopazRender(submissionId);
    if (!q.queued) return { ok: false, message: q.reason };
    refresh();
    return { ok: true, message: "The 1080p pass is queued. It starts within five minutes, and this row updates when the file is checked." };
  }
  const refusal = await topaz.retryTopazJobRefusal(job.id);
  if (refusal) return { ok: false, message: refusal };
  await background(async () => {
    const r = await topaz.retryTopazJob(job.id);
    if (!r.ok) console.warn("[delivery] 1080p retry refused in the background", job.id, r.message);
  });
  refresh();
  return {
    ok: true,
    message: job.outputCheck === "resolved-original"
      ? "Bringing the 1080p file back for a listen. It shows on this card in a moment."
      : "Running the 1080p pass again. It starts within five minutes, and this row updates when the file is checked.",
  };
}

/** Retry publication: put the checked file on the client's portal now. */
export async function retryPortalPublicationAction(submissionId: string): Promise<Result> {
  const who = await staff();
  if (!who.ok) return who;
  if (!ID_RE.test(submissionId)) return { ok: false, message: "That video isn't on the delivery queue." };
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { status: true, sentToClientAt: true, project: { select: { contentMonthId: true } } } });
  if (!cut?.project.contentMonthId || cut.status !== "APPROVED") return { ok: false, message: "Only an approved monthly video can be published to the portal." };
  if (cut.sentToClientAt) return { ok: true, message: "Already delivered." };
  await background(async () => {
    const { publishApprovedCutToLibrary } = await import("@/lib/contentVideos");
    await publishApprovedCutToLibrary(submissionId);
  });
  refresh();
  return { ok: true, message: "Publishing to the client's portal now. This row clears when it lands; if it can't, the reason shows here." };
}

/** Kyle sent the Final Dropbox link to a client whose portal isn't live yet. */
export async function markSentOutsidePortalAction(submissionId: string): Promise<Result & { already?: boolean; incomplete?: string[] }> {
  const who = await staff();
  if (!who.ok) return who;
  if (!ID_RE.test(submissionId)) return { ok: false, message: "That video isn't on the delivery queue." };
  const { markVideoSent } = await import("@/lib/readyToSend");
  const r = await markVideoSent(submissionId, who.name, { outsidePortal: true });
  if (r.ok && !r.incomplete?.length) refresh();
  return { ok: r.ok, message: r.ok && !r.already && !r.incomplete?.length ? "Marked as sent." : r.message, already: r.already, incomplete: r.incomplete };
}
