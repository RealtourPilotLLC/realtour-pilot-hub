import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { editorOriginalIsFinal } from "@/lib/topazOriginal";
// The press itself: the same function "Upload to Aryeo and send" calls. A
// plain import (videoAryeoPush never imports this module back).
import { isUploadedOnly, requestVideoPush, videoPushReadiness, videoPushRun } from "@/lib/videoAryeoPush";

// ---------------------------------------------------------------------------
// SEND WHEN READY (Jordan, Oct 23 2026: "Can I have Run through topaz and
// upload and deliver button as well? So it automatically runs, uploads, and
// delivers?", then "Ok but I want that for regular too so an approve and send
// button or re-run and send button.").
//
// ONE PRESS NOW, THE REST LATER. Two presses write ONE intent per cut, in
// AppSetting `send-when-ready:<cut id>`:
//   · "Approve and send" (the review workspace, review/sendWhenReadyActions),
//     written right after the approval lands;
//   · "Run it again, then upload and send" (Run Topaz again's confirm),
//     written inside rerunTopazJob's own transaction.
// When the file to send is ready and checked, the hub does exactly what
// "Upload to Aryeo and send" does on the Ready to send row:
// videoAryeoPush.requestVideoPush, by the person who pressed, through every
// gate of its own (the hub's Aryeo login, the listing, the checked file, the
// client's open requests, the job on hold). Nothing here bypasses them: a
// refusal is recorded as "not sent" with requestVideoPush's own words, and
// the row shows the refusal as a normal press does. The one check the press
// makes in the browser (SendVideo's "the listing already shows a video that
// could be this one ... Upload anyway") is made here too, from the same line
// (readyToSend.listingWarningOf): a warning waits for a person.
//
// THE TRIGGERS, all through settleSendWhenReady, which reads where the cut
// and its Topaz pass stand and acts on that alone:
//   · the Topaz pass done and checked (verified, or a person chose a held
//     file: resolved-processed): send;
//   · the already-finished skip (the editor's original IS the file): send;
//   · no Topaz pass at all, known at approval: send at once (the push's own
//     gate decides; it refuses a video with no Topaz pass, see the report);
//   · held: keep waiting (its resolution decides);
//   · failed, stopped, any other skip, kept as the original, reopened,
//     replaced by a newer version: not sent, a plain reason, a bell for the
//     owner and the office, a line on the job's timeline.
// It is called the moment the pass ends (topazJobs: finished, held file
// resolved, skipped, failed, stopped), by every reopen (cutReopen), right
// after the press, and by the every-minute Topaz cron (sweepSendWhenReady),
// which catches anything a dying function missed.
//
// ONCE. The send is claimed with a compare-and-set on the row's exact value
// (waiting → starting) before requestVideoPush is called, so a double press,
// two cron ticks or the inline trigger and the sweep together start it once.
// requestVideoPush is idempotent besides ("Already sending this video").
// ---------------------------------------------------------------------------

export const SEND_WHEN_READY_PREFIX = "send-when-ready:";
export const sendIntentKey = (submissionId: string) => `${SEND_WHEN_READY_PREFIX}${submissionId}`;

export type SendIntentState = "waiting" | "starting" | "started" | "not-sent" | "cancelled";
export type SendIntentSource = "approve" | "rerun";

/** The intent, as stored. */
export type SendIntent = {
  submissionId: string;
  projectId: string;
  /** who pressed (the send goes in their name) */
  by: string;
  /** when they pressed (ISO) */
  at: string;
  source: SendIntentSource;
  state: SendIntentState;
  /** started: requestVideoPush's answer; not-sent / cancelled: why */
  note: string | null;
  doneAt: string | null;
  /** the cut's Topaz pass when the press was made (null: no pass at approval) */
  topazJobId: string | null;
  /** when a caller took it to start the send (state "starting") */
  claimedAt?: string | null;
};

/** The words the presses and the rows share. No em dashes. */
export const SEND_WHEN_READY_SAYS = {
  approveLabel: "Approve and send",
  then: "Then: upload to Aryeo and send",
  cancelLabel: "Don't send it automatically",
  waitsForYou: "If anything would stop that (a client request to check, a listing warning), it waits for you instead.",
  reopened: "This version was reopened for revisions, so it was not sent. The next approved version needs its own press.",
  replaced: "A newer version replaced this one, so it was not sent.",
  plainRerun: "Run again without sending.",
} as const;

/** A starting claim older than this died with its function: it may be taken again (requestVideoPush never starts a second run). */
const STALE_CLAIM_MS = 5 * 60_000;
/** A finished pass whose file still isn't ready to send after this long is not going to be (the push's "not yet"). */
const NOT_YET_FOR_MS = 6 * 3_600_000;
const LIVE = ["queued", "estimated", "uploading", "processing", "saving"];
const VERIFIED = new Set(["verified", "resolved-processed"]);

type Db = Pick<Prisma.TransactionClient, "appSetting">;

const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "this job";
/** A quoted reason in this module's words: money out, em and en dashes out. */
async function plain(s: string): Promise<string> {
  const { scrubMoney } = await import("@/lib/text");
  return scrubMoney(s).replace(/\s*[—–]\s*/g, ": ").replace(/\s+/g, " ").trim();
}

function parse(raw: string | null | undefined): SendIntent | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SendIntent;
    return v && typeof v.submissionId === "string" && typeof v.state === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function readSendIntent(submissionId: string, db: Db = prisma): Promise<{ intent: SendIntent | null; raw: string | null }> {
  const row = await db.appSetting.findUnique({ where: { key: sendIntentKey(submissionId) }, select: { value: true } });
  return { intent: parse(row?.value), raw: row?.value ?? null };
}

/** Every intent, by cut (the board's read: one query). */
export async function sendIntentsFor(submissionIds: string[]): Promise<Map<string, SendIntent>> {
  const out = new Map<string, SendIntent>();
  if (!submissionIds.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: submissionIds.map(sendIntentKey) } }, select: { value: true } });
  for (const r of rows) {
    const i = parse(r.value);
    if (i) out.set(i.submissionId, i);
  }
  return out;
}

/** Compare-and-set on the row's exact value. */
async function swap(db: Db, submissionId: string, raw: string, next: SendIntent): Promise<string | null> {
  const value = JSON.stringify(next);
  const r = await db.appSetting.updateMany({ where: { key: sendIntentKey(submissionId), value: raw }, data: { value, updatedBy: "send-when-ready" } });
  return r.count === 1 ? value : null;
}

/** A new intent (the press). Replaces whatever an earlier press left: a new
 *  approval or a new run is the newest word on this cut. */
export async function putSendIntent(db: Db, i: Omit<SendIntent, "state" | "note" | "doneAt" | "claimedAt">): Promise<void> {
  const value = JSON.stringify({ ...i, state: "waiting", note: null, doneAt: null, claimedAt: null } satisfies SendIntent);
  await db.appSetting.upsert({ where: { key: sendIntentKey(i.submissionId) }, create: { key: sendIntentKey(i.submissionId), value, updatedBy: "send-when-ready" }, update: { value, updatedBy: "send-when-ready" } });
}

/** A waiting intent ends without a send (a plain re-run, a cancel, a reopen).
 *  Returns the intent it ended, or null when there was none waiting. */
export async function endWaitingIntent(db: Db, submissionId: string, end: { state: "cancelled" | "not-sent"; note: string }): Promise<SendIntent | null> {
  const { intent, raw } = await readSendIntent(submissionId, db);
  if (!intent || !raw || intent.state !== "waiting") return null;
  const next: SendIntent = { ...intent, state: end.state, note: end.note.slice(0, 400), doneAt: new Date().toISOString() };
  return (await swap(db, submissionId, raw, next)) ? next : null;
}

// ---- telling people -------------------------------------------------------------------------

const asked = (i: SendIntent) => `as ${i.by} asked when ${i.source === "approve" ? "approving it" : "running it through Topaz again"}`;

async function timeline(projectId: string, body: string): Promise<void> {
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: body.slice(0, 500) } }).catch(() => {});
}

/** Not sent: the owner and the office hear it, and the job's timeline says why. */
async function sayNotSent(i: SendIntent, why: string, street: string): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "video_not_sent",
      title: `Not sent automatically: ${street}`,
      body: why,
      href: "/review#ready-to-send",
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `send-when-ready-${i.submissionId}-${i.at}`,
    });
  } catch { /* the bell is best-effort; the row and the timeline carry it */ }
  await timeline(i.projectId, `Not sent to Aryeo automatically (${i.by} asked for it when ${i.source === "approve" ? "approving it" : "running it through Topaz again"}): ${why}`);
}

// ---- deciding -------------------------------------------------------------------------------

type How = "rendered" | "chosen" | "not-needed" | "no-pass";
type Decision = { kind: "wait" } | { kind: "send"; how: How } | { kind: "drop"; why: string; quiet?: boolean };

const reasonOf = async (s: string | null | undefined) => (s && s.trim() ? ` (${(await plain(s)).replace(/[.\s]+$/, "")})` : "");

async function decide(i: SendIntent): Promise<Decision & { street: string; finishedAt: Date | null }> {
  const cut = await prisma.reviewSubmission.findUnique({
    where: { id: i.submissionId },
    select: {
      status: true, sentToClientAt: true, sentToClientBy: true,
      project: { select: { title: true, status: true } },
      topazJob: { select: { id: true, state: true, outputCheck: true, error: true, skipReason: true, resolvedBy: true, finishedAt: true } },
    },
  });
  const street = streetOf(cut?.project.title);
  const j = cut?.topazJob ?? null;
  const finishedAt = j?.finishedAt ?? null;
  const out = (d: Decision) => ({ ...d, street, finishedAt });
  if (!cut) return out({ kind: "drop", why: "That video no longer exists.", quiet: true });
  if (cut.sentToClientAt) return out({ kind: "drop", why: `It was already sent${cut.sentToClientBy ? ` (recorded by ${cut.sentToClientBy})` : ""}.`, quiet: true });
  if (cut.status !== "APPROVED") return out({ kind: "drop", why: SEND_WHEN_READY_SAYS.reopened });
  if (cut.project.status === "CANCELLED") return out({ kind: "drop", why: "The job was cancelled, so it was not sent." });
  // A job on hold is the push's own hold (it goes once the hold is released);
  // currentApproved reads "on hold" as not current, so it is asked only otherwise.
  if (cut.project.status !== "ON_HOLD") {
    const { loadCut, currentApproved } = await import("@/lib/finalRendition");
    const full = await loadCut(i.submissionId);
    if (!full || !(await currentApproved(full))) return out({ kind: "drop", why: SEND_WHEN_READY_SAYS.replaced });
  }
  if (!j) {
    return out(i.topazJobId
      ? { kind: "drop", why: "The Topaz pass for this video is gone, so it was not sent." }
      : { kind: "send", how: "no-pass" });
  }
  if (LIVE.includes(j.state) || j.state === "held") return out({ kind: "wait" });
  if (j.state === "done") {
    if (VERIFIED.has(j.outputCheck ?? "")) return out({ kind: "send", how: j.outputCheck === "resolved-processed" ? "chosen" : "rendered" });
    return out({ kind: "drop", why: "The Topaz file was never checked, so it was not sent. It goes up by hand." });
  }
  if (j.state === "skipped") {
    if (editorOriginalIsFinal(j)) return out({ kind: "send", how: "not-needed" });
    return out({ kind: "drop", why: `The Topaz pass was skipped${await reasonOf(j.skipReason)}, so it was not sent. The editor's file goes up by hand.` });
  }
  if (j.state === "failed") {
    if (j.outputCheck === "resolved-original") {
      return out({ kind: "drop", why: `${j.resolvedBy ?? "A reviewer"} kept the editor's original instead of the Topaz file, so it was not sent. The original goes up by hand.` });
    }
    return out({ kind: "drop", why: `The Topaz pass couldn't finish${await reasonOf(j.error)}, so it was not sent.` });
  }
  if (j.state === "cancelled") return out({ kind: "drop", why: `The Topaz pass was stopped${await reasonOf(j.skipReason ?? j.error)}, so it was not sent.` });
  // A state this module has never heard of is still the lane's (readyToSend's rule).
  return out({ kind: "wait" });
}

/** The one check SendVideo makes in the browser: the listing may already show
 *  this video. undefined = the row could not be read (wait and look again). */
async function listingWarning(projectId: string, submissionId: string): Promise<string | null | undefined> {
  try {
    const { readyToSend, listingWarningOf } = await import("@/lib/readyToSend");
    const b = await readyToSend({ projectId, readyOnly: true });
    const row = b.ready.find((r) => r.submissionId === submissionId);
    // Not on the card: the push's own gates are the answer.
    return row ? listingWarningOf(row) : null;
  } catch {
    return undefined;
  }
}

export type SettleOutcome = "none" | "waiting" | "started" | "not-sent";

/**
 * Where this cut's "send when ready" stands, acted on: wait, send (once), or
 * say why not. Safe to call at any time, from anywhere, any number of times.
 * Never throws.
 */
export async function settleSendWhenReady(submissionId: string): Promise<SettleOutcome> {
  try {
    const { intent, raw } = await readSendIntent(submissionId);
    if (!intent || !raw) return "none";
    const stale = intent.state === "starting" && (!intent.claimedAt || Date.now() - Date.parse(intent.claimedAt) > STALE_CLAIM_MS);
    if (intent.state !== "waiting" && !stale) return intent.state === "started" ? "started" : intent.state === "not-sent" ? "not-sent" : "none";

    const d = await decide(intent);
    if (d.kind === "wait") return "waiting";
    if (d.kind === "drop") {
      const why = await plain(d.why);
      const next: SendIntent = { ...intent, state: "not-sent", note: why.slice(0, 400), doneAt: new Date().toISOString(), claimedAt: null };
      if (!(await swap(prisma, submissionId, raw, next))) return "none";
      if (!d.quiet) await sayNotSent(intent, why, d.street);
      return "not-sent";
    }

    // What the push's gates say, read only: a "not yet" (the editor's original
    // still landing in the Final folder, say) waits for the next look.
    const ready = await videoPushReadiness(submissionId);
    if (!ready.ready && ready.kind === "not-yet") {
      const since = d.finishedAt?.getTime() ?? Date.parse(intent.at);
      if (Date.now() - since < NOT_YET_FOR_MS) return "waiting";
    }
    // The browser's own check (SendVideo's "Upload anyway"): a person decides.
    const warn = await listingWarning(intent.projectId, submissionId);
    if (warn === undefined) return "waiting";
    if (warn) {
      const why = `The Aryeo listing needs a look first, so it waits for you. ${await plain(warn)}`;
      const next: SendIntent = { ...intent, state: "not-sent", note: why.slice(0, 400), doneAt: new Date().toISOString(), claimedAt: null };
      if (!(await swap(prisma, submissionId, raw, next))) return "none";
      await sayNotSent(intent, why, d.street);
      return "not-sent";
    }

    // ONCE: the claim, then the press.
    const claimed: SendIntent = { ...intent, state: "starting", claimedAt: new Date().toISOString() };
    const claimedRaw = await swap(prisma, submissionId, raw, claimed);
    if (!claimedRaw) return "none";
    const r = await requestVideoPush(submissionId, { by: intent.by }).catch((e: unknown) => {
      console.warn("[send-when-ready] requestVideoPush threw", submissionId, (e as Error)?.message);
      return { ok: false, started: false, message: "The hub couldn't start the upload just now. Press Upload to Aryeo and send on Ready to send." };
    });
    // Already on its way (or delivered) counts as started; a refusal, a hold
    // or an upload-only run waiting for Send now does not.
    const run = r.started ? null : await videoPushRun(submissionId).catch(() => null);
    const going = r.started || (r.ok && !!run && run.state !== "FAILED" && run.state !== "HELD" && !isUploadedOnly(run));
    const message = await plain(r.message);
    const done: SendIntent = { ...claimed, state: going ? "started" : "not-sent", note: message.slice(0, 400), doneAt: new Date().toISOString() };
    await swap(prisma, submissionId, claimedRaw, done);
    if (going) {
      const lead = d.how === "rendered" ? "Topaz pass finished" : d.how === "chosen" ? "Topaz file chosen after a listen" : d.how === "not-needed" ? "Topaz pass not needed" : "Approved";
      await timeline(intent.projectId, `${lead}: uploading to Aryeo and sending, ${asked(intent)}.`);
      return "started";
    }
    await sayNotSent(intent, message, d.street);
    return "not-sent";
  } catch (e) {
    console.warn("[send-when-ready] settle failed", submissionId, (e as Error)?.message);
    return "none";
  }
}

/** Every waiting intent (and any claim that died), looked at again: the
 *  every-minute Topaz cron, so a function that died mid-way never strands one. */
export async function sweepSendWhenReady(opts: { max?: number } = {}): Promise<{ looked: number; started: number; notSent: number }> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: SEND_WHEN_READY_PREFIX }, OR: [{ value: { contains: '"state":"waiting"' } }, { value: { contains: '"state":"starting"' } }] },
    select: { key: true },
    orderBy: { updatedAt: "asc" },
    take: opts.max ?? 40,
  });
  let started = 0;
  let notSent = 0;
  for (const r of rows) {
    const o = await settleSendWhenReady(r.key.slice(SEND_WHEN_READY_PREFIX.length));
    if (o === "started") started++;
    else if (o === "not-sent") notSent++;
  }
  return { looked: rows.length, started, notSent };
}

/** A reopen (cutReopen.reopenBookkeeping): a waiting send stops, said once. Never throws. */
export async function dropSendWhenReady(submissionId: string, why: string = SEND_WHEN_READY_SAYS.reopened): Promise<void> {
  try {
    const ended = await endWaitingIntent(prisma, submissionId, { state: "not-sent", note: why });
    if (!ended) return;
    const p = await prisma.project.findUnique({ where: { id: ended.projectId }, select: { title: true } }).catch(() => null);
    await sayNotSent(ended, why, streetOf(p?.title));
  } catch (e) {
    console.warn("[send-when-ready] drop failed", submissionId, (e as Error)?.message);
  }
}

/** "Don't send it automatically" (the With Topaz row): the waiting send ends; the video waits for a person's press. */
export async function cancelSendWhenReady(submissionId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const ended = await endWaitingIntent(prisma, submissionId, { state: "cancelled", note: `Turned off by ${by}.` });
  if (!ended) {
    const { intent } = await readSendIntent(submissionId);
    if (intent?.state === "started" || intent?.state === "starting") return { ok: false, message: "It has already started uploading to Aryeo. Hold it on Ready to send if it should stop." };
    return { ok: true, message: "It wasn't set to send automatically." };
  }
  await timeline(ended.projectId, `${by} turned off the automatic send ${ended.source === "approve" ? "asked for when approving" : "asked for when running it through Topaz again"}. It waits for a person to press Upload to Aryeo and send.`);
  return { ok: true, message: "It won't be sent automatically. Send it from Ready to send once it is there." };
}

/**
 * May "Approve and send" be offered on this cut? An Aryeo listing video (or a
 * program video the office switched to Aryeo) whose Topaz pass the lane will
 * run, or that already has one. Without a Topaz pass the push's own gate
 * refuses ("No Topaz pass ran for this video, so the hub does not send it on
 * its own"), so the button is not drawn for a press that could only fail.
 * The client's open requests come with it, for the confirm SendVideo shows.
 * Null: not offered.
 */
export async function approveAndSendOffer(submissionId: string): Promise<{ openAsks: { summary: string; askedBy: string | null }[]; asksUnknown: boolean } | null> {
  try {
    const { loadCut } = await import("@/lib/finalRendition");
    const cut = await loadCut(submissionId);
    if (!cut) return null;
    const { usesAryeoDelivery } = await import("@/lib/videoDeliveryDestination");
    if (!(await usesAryeoDelivery(cut))) return null;
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { blobUrl: true, deliverable: { select: { type: true } }, topazJob: { select: { id: true } } } });
    if (!sub) return null;
    if (!sub.topazJob) {
      const { topazSettings } = await import("@/lib/settings");
      const s = await topazSettings();
      if (!s.enabled || !sub.blobUrl || !s.deliverableTypes.includes(sub.deliverable?.type ?? "VIDEO")) return null;
    }
    try {
      const { openAsksHolding } = await import("@/lib/clientAsks");
      const asks = await openAsksHolding(cut.projectId, "video");
      return { openAsks: asks.map((a) => ({ summary: a.summary, askedBy: a.askedBy })), asksUnknown: false };
    } catch {
      return { openAsks: [], asksUnknown: true };
    }
  } catch {
    return null;
  }
}
