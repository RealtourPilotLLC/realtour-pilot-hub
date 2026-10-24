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

/** Run Topaz (no pass ever ran) or Retry Topaz (it did not finish). */
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
    return { ok: true, message: "The Topaz pass is queued. It starts within five minutes, and this row updates when the file is checked." };
  }
  const refusal = await topaz.retryTopazJobRefusal(job.id);
  if (refusal) return { ok: false, message: refusal };
  await background(async () => {
    const r = await topaz.retryTopazJob(job.id);
    if (!r.ok) console.warn("[delivery] Topaz retry refused in the background", job.id, r.message);
  });
  refresh();
  return {
    ok: true,
    message: job.outputCheck === "resolved-original"
      ? "Bringing the Topaz file back for a listen. It shows on this card in a moment."
      : "Running the Topaz pass again. It starts within five minutes, and this row updates when the file is checked.",
  };
}

/**
 * RUN TOPAZ AGAIN (Jordan, Oct 23 2026): a finished Topaz file that doesn't
 * look right, on a video not sent yet, goes back through the pass with
 * today's Settings (topazJobs.rerunTopazJob; the rule is lib/topazRerun).
 * The owner and the office only (staff(): requireAdmin, never a preview), so
 * the creative manager and the editors are refused here whatever a screen
 * draws. It runs while the person waits: one Dropbox move and one database
 * write, and the answer (a refusal, or Dropbox saying no) is the one they
 * need to read. Nothing is spent here: the lane's free price check is next.
 *
 * `thenSend` (Oct 23 2026, "Run it again, then upload and send"): the same
 * re-run, and once the new file is back and checked the hub uploads it to
 * Aryeo and sends it in this person's name (lib/sendWhenReady, written in the
 * re-run's own transaction). An Aryeo listing video only: a portal video
 * publishes to the client's portal by itself.
 */
export async function rerunTopazAction(jobId: string, opts?: { thenSend?: boolean }): Promise<Result> {
  const who = await staff();
  if (!who.ok) return who;
  if (typeof jobId !== "string" || !ID_RE.test(jobId)) return { ok: false, message: "Which video?" };
  const thenSend = opts?.thenSend;
  if (thenSend !== undefined && typeof thenSend !== "boolean") return { ok: false, message: "That choice is not valid." };
  if (thenSend) {
    const job = await prisma.topazJob.findUnique({ where: { id: jobId }, select: { submissionId: true } });
    if (!job) return { ok: false, message: "That Topaz job no longer exists." };
    const { loadCut } = await import("@/lib/finalRendition");
    const { usesAryeoDelivery } = await import("@/lib/videoDeliveryDestination");
    const cut = await loadCut(job.submissionId);
    if (!cut || !(await usesAryeoDelivery(cut))) return { ok: false, message: "This video goes to the client's portal by itself, so it can't be sent to Aryeo. Use Run Topaz again." };
  }
  const me = await getCurrentUser().catch(() => null);
  const { displayNameFor } = await import("@/lib/actorName");
  const by = (await displayNameFor(me).catch(() => null)) ?? who.name;
  const { rerunTopazJob } = await import("@/lib/topazJobs");
  const r = await rerunTopazJob(jobId, by, { thenSend: !!thenSend });
  if (r.ok) refresh();
  return r;
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
