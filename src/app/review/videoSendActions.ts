"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireCreativeLead, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM'S DELIVERY BUTTONS (Jordan, Oct 19 2026).
//
//   · Upload to Aryeo and send: one listing video, ONLY on this press (button
//     only: lib/videoAryeoPush never starts a video by itself). When the job
//     has open client requests the press first shows them; "Checked, upload
//     and send" records them checked (the job box's confirmJobRequests) and
//     then starts the upload.
//   · Upload to Aryeo only (Jordan, Oct 23 2026): the same press with
//     `uploadOnly`: every gate and the same upload, stopped on the listing
//     ("On Aryeo, not sent yet") until Send now (deliverVideoNowAction).
//   · Send all: every ready row with no open request, in one press (a video
//     uploaded only is never one of them: only Send now sends it).
//   · Remind editor / Remind reviewer (lib/remindEditor): at most once every
//     4 hours per video.
//   · Deliver now and Release, on a video a person already started sending
//     (moved here from ops/video-delivery/actions on Oct 20 2026, audit B15).
// A server action is a public POST: each one checks requireAdmin first (Jordan
// or Kyle; the REAL role, "view as" refused). Every answer is { ok, message }
// in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

export type SendResult = { ok: boolean; message: string; started?: boolean };

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const ROW_KEY = /^[A-Za-z0-9_-]{6,64}(:uncut:\d{1,2})?$/;

function denied(e: unknown): SendResult {
  return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
}

async function actor(): Promise<{ name: string; teamMemberId: string | null }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { name: authEnforced() ? "staff" : "local dev", teamMemberId: null };
  return { name: (me.realName || me.name || me.email || "staff").slice(0, 120), teamMemberId: me.impersonating ? null : me.teamMemberId };
}

function refresh() {
  revalidatePath("/review");
  revalidatePath("/");
  revalidatePath("/ops");
}

const failed = (what: string, e: unknown): SendResult => {
  console.error(`[video-review] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

/** Upload to Aryeo and send (also Try again), or Upload to Aryeo only (`uploadOnly: true`, Oct 23 2026;
 *  left out, Try again repeats what was pressed). `checkedRequests`: the person confirmed the job's open
 *  client requests are right. */
export async function sendVideoToAryeoAction(submissionId: string, opts: { checkedRequests?: boolean; uploadOnly?: boolean } = {}): Promise<SendResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  const uploadOnly = opts?.uploadOnly;
  if (uploadOnly !== undefined && typeof uploadOnly !== "boolean") return { ok: false, message: "That choice is not valid." };
  try {
    const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true } });
    if (!cut) return { ok: false, message: "That video no longer exists." };
    if (opts?.checkedRequests === true) {
      const { confirmJobRequests } = await import("@/app/jobs/actions");
      const c = await confirmJobRequests(cut.projectId, "video");
      if (!c.ok) return { ok: false, message: `Nothing was sent: the client's requests could not be marked checked (${c.message})` };
    }
    const { startVideoSend } = await import("@/lib/videoAryeoPush");
    const r = await startVideoSend(submissionId, (await actor()).name, { budgetMs: 25_000, uploadOnly });
    refresh();
    return { ok: r.ok, started: r.started, message: r.message };
  } catch (e) {
    return failed(uploadOnly ? "upload to Aryeo only" : "upload to Aryeo and send", e);
  }
}

/** Send all: the ready rows the page offered (each one still checked by the run itself). */
export async function sendAllVideosAction(submissionIds: string[]): Promise<SendResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!Array.isArray(submissionIds) || submissionIds.length < 1 || submissionIds.length > 20 || !submissionIds.every((x) => typeof x === "string" && ID.test(x))) {
    return { ok: false, message: "Those videos are not valid." };
  }
  try {
    const ids = [...new Set(submissionIds)];
    const by = (await actor()).name;
    const { requestVideoPush, advanceVideoPush } = await import("@/lib/videoAryeoPush");
    const started: string[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const r = await requestVideoPush(id, { by }).catch((e) => ({ ok: false, started: false, message: (e as Error).message }));
      if (r.started) started.push(id);
      else if (!r.ok) refused.push(r.message);
    }
    // Move them on a little now; the cron (every minute) carries on.
    const t0 = Date.now();
    for (const id of started) {
      const left = 40_000 - (Date.now() - t0);
      if (left < 8_000) break;
      await advanceVideoPush(id, { budgetMs: Math.min(left, 20_000) }).catch(() => null);
    }
    refresh();
    const n = started.length;
    const head = n ? `Sending ${n} video${n === 1 ? "" : "s"} to Aryeo.` : "Nothing was started.";
    return { ok: n > 0, started: n > 0, message: refused.length ? `${head} ${refused.length} could not start: ${refused[0]}` : head };
  } catch (e) {
    return failed("send all", e);
  }
}

/** Deliver now: the video is on the listing and waiting for a person (lib/videoAryeoPush.deliverVideoNow).
 *  Also Send now on a video uploaded only (Oct 23 2026): the same path, the same gates. */
export async function deliverVideoNowAction(submissionId: string): Promise<SendResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { deliverVideoNow } = await import("@/lib/videoAryeoPush");
    const r = await deliverVideoNow(submissionId, (await actor()).name);
    refresh();
    return r;
  } catch (e) {
    return failed("deliver now", e);
  }
}

/** Release: a run a person held goes on (lib/videoAryeoPush.releaseVideoPush). */
export async function releaseVideoPushAction(submissionId: string): Promise<SendResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { releaseVideoPush } = await import("@/lib/videoAryeoPush");
    const r = await releaseVideoPush(submissionId, (await actor()).name);
    refresh();
    return r;
  } catch (e) {
    return failed("release", e);
  }
}

/** Remind editor / Remind reviewer, for one video on the room. */
export async function remindVideoAction(input: { key: string; projectId: string; submissionId: string | null }): Promise<SendResult & { atISO?: string; to?: string }> {
  try {
    // Chasing an editor or a reviewer is creative coordination: the creative
    // manager too (Oct 21 2026). Sending a video stays requireAdmin above.
    await requireCreativeLead();
  } catch (e) {
    return denied(e);
  }
  if (!input || typeof input.key !== "string" || !ROW_KEY.test(input.key) || typeof input.projectId !== "string" || !ID.test(input.projectId) || (input.submissionId !== null && (typeof input.submissionId !== "string" || !ID.test(input.submissionId)))) {
    return { ok: false, message: "That video is not valid." };
  }
  try {
    // What the room shows is the truth the message is written from (never
    // the browser's word for how late it is). The room's own read, when it is
    // under 15 s old, rather than a whole new board per press (Oct 20 2026,
    // audit B17); who holds the video is read fresh by remindVideo itself.
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    const board = await videoDeliveryBoard();
    const row = Object.values(board.lanes).flat().find((r) => r.key === input.key && r.projectId === input.projectId);
    let item: import("@/lib/remindEditor").RemindItem | null = row
      ? { key: row.key, projectId: row.projectId, submissionId: row.submissionId, street: row.street, promiseISO: row.promiseISO, late: row.late, dueToday: row.dueToday, revisionSinceISO: row.cutStatus === "CHANGES_REQUESTED" ? row.sinceISO : null }
      : null;
    if (!item && input.submissionId && input.key === input.submissionId) {
      // A sent-back version that is not a listing video (a program video in In revision).
      const cut = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { projectId: true, status: true, decidedAt: true, project: { select: { title: true } } } });
      if (cut && cut.projectId === input.projectId && cut.status === "CHANGES_REQUESTED") {
        item = { key: input.key, projectId: cut.projectId, submissionId: input.submissionId, street: (cut.project.title ?? "").split(",")[0].trim() || "The job", promiseISO: null, late: false, dueToday: false, revisionSinceISO: cut.decidedAt?.toISOString() ?? null };
      }
    }
    if (!item) return { ok: false, message: "That video is not waiting on anyone any more. Reload the page." };
    const { remindVideo } = await import("@/lib/remindEditor");
    const r = await remindVideo({ item, by: await actor() });
    if (r.ok) refresh();
    return { ok: r.ok, message: r.message, atISO: r.atISO, to: r.to };
  } catch (e) {
    return failed("remind", e);
  }
}

/** Remove a note this action wrote and could not use: the note, and the
 *  revision issue made from it (revisionIssues.ingestReviewNote) with its
 *  history. Best-effort; never throws. */
async function dropUnsentNote(noteId: string): Promise<void> {
  try {
    const issues = await prisma.revisionIssue.findMany({ where: { sourceKind: "REVIEW_NOTE", sourceId: noteId }, select: { id: true } });
    if (issues.length) {
      await prisma.revisionIssueEvent.deleteMany({ where: { issueId: { in: issues.map((i) => i.id) } } });
      await prisma.revisionIssue.deleteMany({ where: { id: { in: issues.map((i) => i.id) } } });
    }
    await prisma.mediaNote.deleteMany({ where: { id: noteId, status: "OPEN" } });
  } catch (e) {
    console.warn("[video-review] could not remove the unsent note", noteId, e);
  }
}

/**
 * SEND BACK FOR REVISIONS FROM READY TO SEND (Jordan, Oct 19 2026: "We also
 * approved this one, but I learned from Kyle it wasn't ready yet and needs to
 * be revised. Make sure I have a way to send back for revision / remove this
 * from ready to send."). The same reopen the review screen's "Reopen for
 * revisions" does (review/actions.requestCutChanges with reopen), which needs
 * at least one note for the editor: the words typed here become that note
 * (the editor lane, a fix). The video leaves Ready to send, the job goes back
 * to revisions and the editor is told, as with any reopen.
 */
export async function sendBackForRevisionsAction(submissionId: string, projectId: string, note: string): Promise<SendResult> {
  if (!ID.test(submissionId) || !ID.test(projectId)) return { ok: false, message: "That video wasn't found." };
  const body = (note ?? "").trim().slice(0, 2000);
  if (body.length < 3) return { ok: false, message: "Say what needs changing, so the editor knows what to fix." };
  try {
    // A creative verdict (the reopen behind it asks requireCutReviewer too):
    // the creative manager may send a video back (Oct 21 2026).
    await requireCreativeLead();
  } catch (e) {
    return denied(e);
  }
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true, status: true } });
  if (!sub || sub.projectId !== projectId) return { ok: false, message: "That video wasn't found." };
  if (sub.status === "CHANGES_REQUESTED") return { ok: true, message: "It is already back with the editor." };
  if (sub.status !== "APPROVED") return { ok: false, message: "Only an approved video can be sent back from here." };
  const { addCutNote, requestCutChanges } = await import("@/app/review/actions");
  const n = await addCutNote({ projectId, submissionId, body, lane: "EDITOR", kind: "fix", timeSec: null });
  if (!n.ok) return { ok: false, message: n.message ?? "The note couldn't be saved." };
  const r = await requestCutChanges(submissionId, { reopen: true });
  // A REFUSED REOPEN LEAVES NO NOTE BEHIND (Oct 20 2026, audit B19). The note
  // was written first because the reopen needs one; if the reopen was refused
  // (a newer version is in, the version is waiting on the editor's check) and
  // the video is still approved, an open editor note on an approved cut would
  // only inflate the "open notes" count. A video somebody else reopened in
  // the meantime keeps it: it is a real note on a cut that is with the editor.
  if (!r.ok && n.noteId) {
    const still = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { status: true } }).catch(() => null);
    if (still?.status === "APPROVED") await dropUnsentNote(n.noteId);
  }
  revalidatePath("/review");
  revalidatePath("/");
  return { ok: r.ok, message: r.ok ? "Sent back to the editor. It's off Ready to send." : r.message };
}
