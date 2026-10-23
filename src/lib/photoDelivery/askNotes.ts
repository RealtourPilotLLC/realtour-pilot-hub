import "server-only";

import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { etTime } from "@/lib/datetime";
import { noDashes } from "@/lib/text";
import { HUB_SMS_PREFIX, staffTextNumber } from "@/lib/hubSms";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// "ASK THE PHOTOGRAPHER FOR NOTES" (Oct 23 2026, Jordan and Kyle's huddle).
//
// Kyle "always has to continue without the photographer's wrap-up" (Harrison
// doesn't add notes). Missing notes never hold the photos any more
// (delivery.ts: the wrap-up line is information for Kyle; only the hub's own
// same-day delivery still waits for it). Instead, the photo job offers one
// button: a text to the shoot's photographer asking whether there are notes
// (what was promised to the client, what should be removed or fixed), with
// the job's upload page, where the wrap-up is. The same staff text path as
// the Editing Room's Remind photographer (remindPhotographer.ts): the
// company line, the durable outbox, a template Jordan can reword (Settings,
// Text messages: photo_notes_ask_photographer).
//
// REFUSED, with the reason: the wrap-up is in (nothing to ask), no
// photographer, not active, no phone (or our own line), OpenPhone not
// connected, or the last ask went out less than two hours ago. NOT TWICE: the
// press is claimed in one compare-and-set (AppSetting photo_notes_ask:<job>),
// so a double click or two people send one text. THE RECORD: the outbox row,
// a line on the job's activity and on the project's timeline.
// ---------------------------------------------------------------------------

/** No second ask inside this window, whoever sent the last one. */
export const NOTES_ASK_GAP_MS = 2 * 60 * 60_000;
export const notesAskKey = (jobId: string) => `photo_notes_ask:${jobId}`;
/** The action the job's activity carries (the page reads the last one). */
export const NOTES_ASK_ACTION = "asked the photographer for notes";

type Lock = { state: "sending" | "sent" | "unconfirmed"; at: string; id: string; by: string; to?: string };
const parseLock = (v: string | null | undefined): Lock | null => {
  try {
    const j = JSON.parse(v ?? "") as Lock | null;
    return j && typeof j.at === "string" && Number.isFinite(Date.parse(j.at)) ? j : null;
  } catch {
    return null;
  }
};

const first = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";
const streetOf = (title: string | null | undefined, address: string | null | undefined) => ((address ?? "").trim() || (title ?? "this shoot").split(",")[0]).trim();

/** The photographer's text: the hub marker, then the template. No dashes. Pure. */
export function composeNotesAskText(o: { firstName: string; street: string; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  return noDashes(`${HUB_SMS_PREFIX}: ${t.render("photo_notes_ask_photographer", { firstName: o.firstName, street: o.street, link: o.link })}`);
}

/** The last ask on this job, for the button's line ("Asked 2:14 PM by Kyle"), or null. */
export async function lastNotesAsk(jobId: string): Promise<{ atISO: string; by: string; unconfirmed: boolean } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: notesAskKey(jobId) }, select: { value: true } }).catch(() => null);
  const l = parseLock(row?.value);
  return l && l.state !== "sending" ? { atISO: l.at, by: l.by, unconfirmed: l.state !== "sent" } : null;
}

export type NotesAskOutcome = { ok: boolean; message: string; text?: string };

/** Text the job's photographer now, asking for their notes. `who` is the person pressing (the caller checked they may). */
export async function askPhotographerForNotes(jobId: string, who: { name: string; teamMemberId?: string | null }, now: Date = new Date()): Promise<NotesAskOutcome> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true } });
  if (!job) return { ok: false, message: "That photo job is not in the hub any more." };
  const p = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { id: true, title: true, addressLine: true, status: true, photographer: { select: { id: true, name: true, phone: true, active: true } } },
  });
  if (!p) return { ok: false, message: "That job is not in the hub any more." };
  const street = streetOf(p.title, p.addressLine);
  if (p.status === "CANCELLED") return { ok: false, message: `${street} is cancelled, so no text was sent.` };

  // 1. Still something to ask? Read now, never from the page.
  const { wrapUpState } = await import("./clientAsked");
  const w = await wrapUpState(p.id, jobId).catch(() => null);
  if (w && !w.missing) return { ok: false, message: `${w.firstName ?? "The photographer"}'s wrap-up is in, so there is nothing to ask. Their notes are on the job.` };

  // 2. Someone to text, and a way to text them.
  const ph = p.photographer;
  if (!ph) return { ok: false, message: `${street} has no photographer on it, so there is nobody to text.` };
  const name = first(ph.name);
  if (!ph.active) return { ok: false, message: `${ph.name} is not an active team member, so no text was sent.` };
  const num = staffTextNumber(ph.phone);
  if (!num) return { ok: false, message: `${name} has no phone number on file, so no text was sent.` };
  const { defaultOpenPhoneNumber, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  if (!(await defaultOpenPhoneNumber())) return { ok: false, message: "OpenPhone isn't connected, so no text was sent." };
  if ((await ourOpenPhoneNumberKeys().catch(() => new Set<string>())).has(num.key)) return { ok: false, message: `${name}'s number on file is our own office line, so no text was sent.` };

  // 3. Not again inside two hours: one compare-and-set claim.
  const key = notesAskKey(jobId);
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  const prev = parseLock(row?.value);
  if (prev && now.getTime() - Date.parse(prev.at) < NOTES_ASK_GAP_MS) {
    return { ok: false, message: prev.state === "sending" ? `A text to ${name} is going out right now.` : `${first(prev.by)} asked ${name} at ${etTime(new Date(prev.at))}. Give it two hours before asking again.` };
  }
  const by = (who.name || "staff").slice(0, 120);
  const pressId = crypto.randomUUID();
  const mine = JSON.stringify({ state: "sending", at: now.toISOString(), id: pressId, by } satisfies Lock);
  const claimed = row
    ? (await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value: mine, updatedBy: by } })).count === 1
    : await prisma.appSetting.create({ data: { key, value: mine, updatedBy: by } }).then(() => true, () => false);
  if (!claimed) return { ok: false, message: `Someone asked ${name} a moment ago. Reload the page.` };
  const release = () => (row ? prisma.appSetting.updateMany({ where: { key, value: mine }, data: { value: row.value } }) : prisma.appSetting.deleteMany({ where: { key, value: mine } })).catch(() => {});

  // 4. The text, through the outbox.
  const [{ loadTextTemplates }, { appBase }, { sendThroughOutbox }] = await Promise.all([import("@/lib/textTemplateStore"), import("@/lib/appUrl"), import("@/lib/outbox")]);
  const words = await loadTextTemplates().catch(() => DEFAULT_TEXTS);
  const text = composeNotesAskText({ firstName: name, street, link: `${appBase()}/upload/${p.id}` }, words);
  let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    r = await sendThroughOutbox({ channel: "sms", toRef: num.key, body: text, dedupeKey: `photo_notes_ask:${jobId}:${ph.id}:${pressId}`, projectId: p.id, requestedBy: by });
  } catch (e) {
    await release();
    return { ok: false, message: `The text could not be queued (${e instanceof Error ? e.message : "error"}), so nothing was sent. Try again.` };
  }
  const outcome: "sent" | "unconfirmed" | "refused" =
    r.outcome === "accepted" || (r.outcome === "duplicate" && r.state === "accepted") ? "sent"
    : r.outcome === "failed" || (r.outcome === "duplicate" && r.state === "failed") ? "refused"
    : "unconfirmed";
  if (outcome === "refused") {
    await release();
    return { ok: false, message: `OpenPhone refused the text to ${name}, so nothing was sent: ${"error" in r ? r.error : "refused"}`.slice(0, 300) };
  }

  // 5. Sent (or may have gone): the claim says so, and the job's record.
  const done: Lock = { state: outcome === "sent" ? "sent" : "unconfirmed", at: now.toISOString(), id: pressId, by, to: ph.name };
  await prisma.appSetting.updateMany({ where: { key, value: mine }, data: { value: JSON.stringify(done) } }).catch(() => {});
  const at = etTime(now);
  await logJobEvent(jobId, by, `${NOTES_ASK_ACTION}: texted ${name} at ${at}${outcome === "sent" ? "" : " (OpenPhone did not confirm it)"}`, { photographerId: ph.id, outcome });
  await prisma.activity
    .create({ data: { projectId: p.id, type: "SYSTEM", body: noDashes(`${by} asked ${name} by text for notes on the photos at ${at} (Photo Delivery).`).slice(0, 1000), authorId: who.teamMemberId ?? null } })
    .catch(() => prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body: noDashes(`${by} asked ${name} by text for notes on the photos at ${at} (Photo Delivery).`).slice(0, 1000) } }))
    .catch(() => {});
  return outcome === "sent"
    ? { ok: true, message: `Texted ${name} at ${at}, asking for notes, with the wrap-up link. The photos don't wait for the answer.`, text }
    : { ok: false, message: `OpenPhone did not confirm the text to ${name}. It may have gone; check Connections before asking again.`, text };
}
