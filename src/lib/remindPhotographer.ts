import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { addBusinessDayKeysET, etAt, etDayKey, etMonthDayTime, etTime } from "@/lib/datetime";
import { noDashes } from "@/lib/text";
import { staffText, staffTextNumber } from "@/lib/hubSms";
import { FLOW_AND_VISION_GAP } from "@/lib/handoff";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";
import {
  ADDED_SUFFIX,
  CLAIM_PREFIX,
  CLAIM_STALE_MS,
  INSTRUCTIONS_JOB_SELECT,
  allItems,
  claimKey,
  firstName,
  listWords,
  morningsBefore,
  NUDGE_HOUR,
  parseClaim,
  readAllMissing,
  streetOf,
  videoGapsFor,
  videoGapsOf,
  type ClaimRecord,
  type InstructionsJob,
  type MissingInstructions,
} from "@/lib/missingInstructions";

// ---------------------------------------------------------------------------
// "REMIND PHOTOGRAPHER" (Jordan, Oct 23 2026): "a 'Remind Photographer' button
// on video projects in the editing room that are missing instructions would be
// great so we can send a text to the photographer to remind them that the
// instructions are missing and editor is waiting and then give them a link to
// go to the upload portal to add them."
//
// WHICH ROWS. A video job in the Editing Room whose video half is missing its
// instructions, by the morning ask's own rule (missingInstructions.videoGapsOf:
// the handoff engine's gaps while the half is not handed in, video 2 and on
// through perVideoInstructions, and a video set up after the handoff). A video
// waiting on a second shoot, a waived one and "couldn't complete" never count.
//
// WHO MAY PRESS. The office (owner, admin) and the creative manager, never
// through "view as" (app/editing/remindActions.ts asks; the row is drawn for
// the same people only).
//
// WHAT GOES. One text, right now, from the company line through the durable
// outbox, to the job's photographer (Project.photographer, the person the
// handoff engine names): the instructions for the street are missing, the
// editor is waiting on them, what is still needed (naming the video when the
// job has more than one), and the job's upload page. Template
// instructions_reminder_photographer (Settings, Text messages). The list is
// everything the morning ask would list, photos wrap-up included, because the
// press is that day's ask (below).
//
// REFUSED, with the reason, when: nothing is missing any more, the job has no
// photographer, they are not active, they have no phone (or it is our own
// line), OpenPhone is not connected, or the last reminder went out less than
// two hours ago (the press, or the hub's morning text). Nothing is sent then.
//
// NOT TWICE. The press is claimed in one atomic step (an AppSetting row per
// job, `instructions_remind:<job>`, holding the last press: when, who, to
// whom), so a double click or two people at once send one text.
//
// THE DAY'S ASK. A press writes the morning ask's own claim for today
// (missingInstructions claimKey, marked `by` the person), so the 10 AM sweep
// does not text the same photographer again that day, and counts the press
// among its three mornings. A morning text already sent today stays as it is.
//
// THE RECORD. Each press is an outbox row (requestedBy = the person), a line on
// the job's timeline, and a delivery-log line for the photographer. The row
// reads "Reminded 2:14 PM by Jordan" (or "by the hub" for the morning text).
// ---------------------------------------------------------------------------

/** No second reminder inside this window, whoever sent the last one. */
export const REMIND_GAP_MS = 2 * 60 * 60_000;
const LOCK_PREFIX = "instructions_remind:";
export const remindLockKey = (projectId: string) => `${LOCK_PREFIX}${projectId}`;
/** The text's outbox identity: the morning ask's kind (a team text, its drain
 *  and its delivery log), one per press. */
export const reminderTextKey = (projectId: string, teamMemberId: string, pressId: string) => `instructions_missing:${projectId}:${teamMemberId}:remind:${pressId}`;

type LockRecord = { state: "sending" | "sent" | "unconfirmed"; at: string; id: string; by: string; to?: string };
const parseLock = (v: string | null | undefined): LockRecord | null => {
  try {
    const j = JSON.parse(v ?? "") as LockRecord | null;
    return j && typeof j.at === "string" && Number.isFinite(Date.parse(j.at)) ? j : null;
  } catch {
    return null;
  }
};

// ---- the words (pure) ----------------------------------------------------------

/** The photographer's text: the hub marker, then the template. No dashes. */
export function composeReminderText(o: { firstName: string; street: string; missing: string[]; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  return staffText(t.render("instructions_reminder_photographer", { firstName: o.firstName, street: o.street, missingList: listWords(o.missing), link: o.link }));
}

/** The last reminder a job had: a press (by a person) or the hub's morning text (by null). */
export type LastReminder = { at: Date; by: string | null; unconfirmed?: boolean };

/** "2:14 PM" today, else "Oct 22, 2:14 PM" (Eastern). */
const whenWords = (at: Date, now: Date) => (etDayKey(at) === etDayKey(now) ? etTime(at) : etMonthDayTime(at));
const byWords = (last: LastReminder) => (last.by ? firstName(last.by) : "the hub");

/** What the row says under the button (pure). */
export function reminderWords(last: LastReminder, now: Date): string {
  return `Reminded ${whenWords(last.at, now)} by ${byWords(last)}${last.unconfirmed ? " (OpenPhone did not confirm it)" : ""}`;
}

/** The newest reminder: the last press, or a morning text the hub sent itself. */
function lastReminder(lock: LockRecord | null, claims: { value: string }[]): LastReminder | null {
  const seen: LastReminder[] = [];
  if (lock) seen.push({ at: new Date(lock.at), by: lock.by, unconfirmed: lock.state !== "sent" });
  for (const c of claims) {
    const r = parseClaim(c.value);
    // A press's own claim is the lock's record already; the sweep's has no `by`.
    if (r?.state === "sent" && !r.by && Number.isFinite(Date.parse(r.at))) seen.push({ at: new Date(r.at), by: null });
  }
  return seen.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
}

// ---- the rows (reads only) -------------------------------------------------------

/** What a row needs to draw the button: what is missing, who would be texted, the last reminder. */
export type RemindView = { missing: string[]; photographer: string | null; last: { atISO: string; words: string } | null };

// ---------------------------------------------------------------------------
// WHEN A ROW SHOWS (Oct 27 2026). Kyle's desk listed "Missing upload details"
// for shoots filmed TODAY that were still going on: the photographer had not
// even left the house. Jordan's order is photographer first, office second:
//   · nothing before the shoot is over (the last live visit's end: its endAt,
//     else its start plus its booked length, else two hours), for anyone;
//   · the Editing Room ("editing") shows the button from the shoot's end, as
//     the editor waiting on the words may want to press it;
//   · the office desk ("office", the default: Kyle's Follow-Ups) only once the
//     photographer has had the morning-after ask (missingInstructions, 10 AM)
//     and two hours with it, on the first business day after the shoot day.
//     Still missing then, it is Kyle's to chase.
// A job with no shoot time on record shows as before (nothing to wait for).
// ---------------------------------------------------------------------------

/** "office" = Kyle's desk (the default); "editing" = the Editing Room's button. */
export type RemindAudience = "office" | "editing";
const DEFAULT_SHOOT_MIN = 120;

type Visit = { status: string | null; startAt: Date | null; endAt: Date | null; durationMin: number | null };

/** When the shoot was over (pure): null = a live visit is still to come or
 *  under way; undefined = no shoot time on record at all. */
export function shootOverAt(visits: Visit[], shootDate: Date | null, now: Date, live: (a: { status: string | null; startAt: Date | null }) => boolean): Date | null | undefined {
  const ends = (start: Date, end: Date | null, min: number | null) => end ?? new Date(start.getTime() + (min && min > 0 ? min : DEFAULT_SHOOT_MIN) * 60_000);
  if (visits.length === 0) {
    if (!shootDate) return undefined;
    const end = ends(shootDate, null, null);
    return end.getTime() > now.getTime() ? null : end;
  }
  const lives = visits.filter(live);
  if (lives.length === 0) return undefined; // every visit cancelled or postponed: the ask decides, not the clock
  if (lives.some((v) => v.startAt!.getTime() > now.getTime())) return null;
  const end = Math.max(...lives.map((v) => ends(v.startAt!, v.endAt, v.durationMin).getTime()));
  return end > now.getTime() ? null : new Date(end); // still on site
}

/** When a row may show to `audience` (pure). Null = not yet (the shoot is not over). */
export function remindShowsFrom(over: Date | null | undefined, audience: RemindAudience): Date | null {
  if (over === null) return null;
  if (over === undefined) return new Date(0);
  if (audience === "editing") return over;
  // The first business day after the shoot's ET day, two hours after the 10 AM ask.
  return new Date(Math.max(over.getTime(), etAt(addBusinessDayKeysET(over, 1), NUDGE_HOUR + 2).getTime()));
}

/** For the Editing Room and the office desk: the rows missing their video
 *  instructions, with their last reminder. Only those come back, and only
 *  once the audience should see them (above). */
export async function remindViewsFor(projectIds: string[], now: Date = new Date(), opts: { audience?: RemindAudience } = {}): Promise<Map<string, RemindView>> {
  const out = new Map<string, RemindView>();
  const gaps = await videoGapsFor(projectIds);
  if (!gaps.size) return out;
  const audience = opts.audience ?? "office";
  const { liveAppointment } = await import("@/lib/shootDayText");
  const visits = await prisma.appointment.findMany({
    where: { projectId: { in: [...gaps.keys()] } },
    select: { projectId: true, status: true, startAt: true, endAt: true, durationMin: true },
  });
  const ids = [...gaps.keys()].filter((id) => {
    const from = remindShowsFrom(shootOverAt(visits.filter((v) => v.projectId === id), gaps.get(id)!.job.shootDate, now, liveAppointment), audience);
    return from !== null && from.getTime() <= now.getTime();
  });
  if (!ids.length) return out;
  const rows = await prisma.appSetting.findMany({
    where: { OR: [{ key: { in: ids.map(remindLockKey) } }, ...ids.map((id) => ({ key: { startsWith: `${CLAIM_PREFIX}${id}:` } }))] },
    select: { key: true, value: true },
  });
  for (const id of ids) {
    const g = gaps.get(id)!;
    const last = lastReminder(
      parseLock(rows.find((r) => r.key === remindLockKey(id))?.value),
      rows.filter((r) => r.key.startsWith(`${CLAIM_PREFIX}${id}:`)),
    );
    out.set(id, { missing: g.missing, photographer: g.job.photographer?.name ?? null, last: last ? { atISO: last.at.toISOString(), words: reminderWords(last, now) } : null });
  }
  return out;
}

/** The list the text carries: on a job owing two or more videos, video 1's own
 *  words are named as video 1 (later videos already name themselves). */
async function namedItems(job: InstructionsJob, missing: MissingInstructions): Promise<string[]> {
  const items = allItems(missing);
  if (!items.includes(FLOW_AND_VISION_GAP)) return items;
  const { videoInstructionsFor } = await import("@/lib/deliverableOutputs");
  const rows = await videoInstructionsFor(job.id).catch(() => []);
  const one = rows.find((r) => r.number === 1);
  if (rows.length < 2 || !one) return items;
  return items.map((l) => (l === FLOW_AND_VISION_GAP ? `the flow and vision for video 1 (${one.label})` : l));
}

// ---- the press -------------------------------------------------------------------

export type RemindOutcome = {
  ok: boolean;
  message: string;
  /** the row's "Reminded …" line after this press (or the one that refused it) */
  last?: { atISO: string; words: string } | null;
  /** the words that went (a sent or unconfirmed text only) */
  text?: string;
};

/**
 * Text the job's photographer now, if anything is still missing and nothing
 * stops it. `who` is the person pressing (the caller has checked they may).
 */
export async function remindPhotographer(projectId: string, who: { name: string; teamMemberId?: string | null }, now: Date = new Date()): Promise<RemindOutcome> {
  const job = await prisma.project.findUnique({ where: { id: projectId }, select: INSTRUCTIONS_JOB_SELECT });
  if (!job) return { ok: false, message: "That job is not in the hub any more." };
  const street = streetOf(job.title, job.addressLine);
  if (job.status === "CANCELLED") return { ok: false, message: `${street} is cancelled, so no text was sent.` };

  // 1. Is anything still missing? Read now, never from the row.
  const video = await videoGapsOf(job);
  if (!video.length) return { ok: false, message: `Nothing is missing on ${street} any more, so no text was sent.` };

  // 2. Someone to text, and a way to text them.
  const ph = job.photographer;
  if (!ph) return { ok: false, message: `${street} has no photographer on it, so there is nobody to text. Add one on the job first.` };
  const first = firstName(ph.name);
  if (!ph.active) return { ok: false, message: `${ph.name} is not an active team member, so no text was sent.` };
  const num = staffTextNumber(ph.phone);
  if (!num) return { ok: false, message: `${first} has no phone number on file, so no text was sent.` };
  const { defaultOpenPhoneNumber, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  if (!(await defaultOpenPhoneNumber())) return { ok: false, message: "OpenPhone isn't connected, so no text was sent." };
  if ((await ourOpenPhoneNumberKeys().catch(() => new Set<string>())).has(num.key)) {
    return { ok: false, message: `${first}'s number on file is our own office line, so no text was sent.` };
  }

  // 3. Not again inside two hours, and not over the hub's own morning text.
  const { missing, addedOnly, addedSince } = await readAllMissing(job);
  const today = etDayKey(now);
  const dayKey = addedOnly ? `${today}${ADDED_SUFFIX}` : today;
  const morningKey = claimKey(job.id, dayKey);
  const lockKey = remindLockKey(job.id);
  const [lockRow, prior] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: lockKey }, select: { value: true } }),
    prisma.appSetting.findMany({ where: { key: { startsWith: `${CLAIM_PREFIX}${job.id}:` } }, select: { key: true, value: true } }),
  ]);
  const last = lastReminder(parseLock(lockRow?.value), prior);
  if (last && now.getTime() - last.at.getTime() < REMIND_GAP_MS) {
    return {
      ok: false,
      message: `${first} was reminded at ${whenWords(last.at, now)} by ${byWords(last)}. You can remind again after ${etTime(new Date(last.at.getTime() + REMIND_GAP_MS))}.`,
      last: { atISO: last.at.toISOString(), words: reminderWords(last, now) },
    };
  }
  const morningRow = prior.find((r) => r.key === morningKey) ?? null;
  const morningRec = morningRow ? parseClaim(morningRow.value) : null;
  if (morningRec?.state === "sending" && now.getTime() - Date.parse(morningRec.at) < CLAIM_STALE_MS) {
    return { ok: false, message: `The hub's morning text to ${first} about ${street} is going out right now.` };
  }

  // 4. The press, taken in one atomic step (a double click sends one text).
  const by = who.name.trim() || "The office";
  const pressId = crypto.randomUUID();
  const mine = JSON.stringify({ state: "sending", at: now.toISOString(), id: pressId, by, to: ph.name } satisfies LockRecord);
  const taken = lockRow
    ? (await prisma.appSetting.updateMany({ where: { key: lockKey, value: lockRow.value }, data: { value: mine, updatedBy: by.slice(0, 120) } })).count === 1
    : await prisma.appSetting.create({ data: { key: lockKey, value: mine, updatedBy: by.slice(0, 120) } }).then(() => true, () => false);
  if (!taken) return { ok: false, message: `Someone else just reminded ${first} about ${street}.` };
  const releaseLock = () =>
    (lockRow
      ? prisma.appSetting.updateMany({ where: { key: lockKey, value: mine }, data: { value: lockRow.value } })
      : prisma.appSetting.deleteMany({ where: { key: lockKey, value: mine } })
    ).catch(() => {});

  // 5. This press is the day's ask: the morning sweep's own claim, so it does
  //    not text again today. A morning text already sent stays as it was.
  let ourMorning: string | null = null;
  if (morningRec?.state !== "sent") {
    const claim = JSON.stringify({ state: "sending", at: now.toISOString(), id: pressId, by } satisfies ClaimRecord);
    const ok = morningRow
      ? (await prisma.appSetting.updateMany({ where: { key: morningKey, value: morningRow.value }, data: { value: claim, updatedBy: "system" } })).count === 1
      : await prisma.appSetting.create({ data: { key: morningKey, value: claim, updatedBy: "system" } }).then(() => true, () => false);
    if (!ok) {
      await releaseLock();
      return { ok: false, message: `The hub's morning text to ${first} about ${street} is going out right now.` };
    }
    ourMorning = claim;
  }
  const releaseMorning = () => (ourMorning ? prisma.appSetting.deleteMany({ where: { key: morningKey, value: ourMorning } }).catch(() => {}) : Promise.resolve());

  // 6. The text, through the outbox.
  const [{ loadTextTemplates }, { appBase }, { sendThroughOutbox }] = await Promise.all([import("@/lib/textTemplateStore"), import("@/lib/appUrl"), import("@/lib/outbox")]);
  const words = await loadTextTemplates().catch(() => DEFAULT_TEXTS);
  const items = await namedItems(job, missing);
  const text = composeReminderText({ firstName: first, street, missing: items, link: `${appBase()}/upload/${job.id}` }, words);
  let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    r = await sendThroughOutbox({ channel: "sms", toRef: num.key, body: text, dedupeKey: reminderTextKey(job.id, ph.id, pressId), projectId: job.id, requestedBy: by.slice(0, 120) });
  } catch (e) {
    await releaseMorning();
    await releaseLock();
    return { ok: false, message: `The text could not be queued (${e instanceof Error ? e.message : "error"}), so nothing was sent. Try again.` };
  }
  const outcome: "sent" | "unconfirmed" | "refused" =
    r.outcome === "accepted" || (r.outcome === "duplicate" && r.state === "accepted") ? "sent"
    : r.outcome === "failed" || (r.outcome === "duplicate" && r.state === "failed") ? "refused"
    : "unconfirmed";
  if (outcome === "refused") {
    // Nothing left the building: the morning is free again, and so is the button.
    await releaseMorning();
    await releaseLock();
    return { ok: false, message: `OpenPhone refused the text to ${first}, so nothing was sent: ${"error" in r ? r.error : "refused"}`.slice(0, 300) };
  }

  // 7. Sent (or may have gone): the day's ask is spent, the row and the timeline say so.
  const at = etTime(now);
  if (ourMorning) {
    const done: ClaimRecord = {
      state: "sent", at: now.toISOString(), id: pressId, by, to: [ph.name], missing: allItems(missing),
      morning: morningsBefore(prior, job.id, dayKey, { only: addedOnly, since: addedSince }) + 1,
    };
    await prisma.appSetting.updateMany({ where: { key: morningKey, value: ourMorning }, data: { value: JSON.stringify(done) } }).catch(() => {});
  }
  const lockDone: LockRecord = { state: outcome === "sent" ? "sent" : "unconfirmed", at: now.toISOString(), id: pressId, by, to: ph.name };
  await prisma.appSetting.updateMany({ where: { key: lockKey, value: mine }, data: { value: JSON.stringify(lockDone) } }).catch(() => {});
  if (outcome === "sent") {
    try {
      const { logDelivery } = await import("@/lib/notify");
      await logDelivery({ teamMemberId: ph.id, kind: "instructions_missing_text", channel: "sms", status: "sent", detail: `${"providerId" in r && r.providerId ? `op-${r.providerId} ` : ""}(Remind photographer, ${by})` });
    } catch { /* the outbox row is the record */ }
  }
  const line = noDashes(
    outcome === "sent"
      ? `${by} reminded ${first} by text about the missing instructions at ${at} (Remind photographer). Missing: ${listWords(items)}.`
      : `${by} pressed Remind photographer at ${at}, but OpenPhone did not confirm the text to ${first}. Check Connections before sending again. Missing: ${listWords(items)}.`,
  ).slice(0, 1000);
  const authorId = who.teamMemberId ?? null;
  await prisma.activity.create({ data: { projectId: job.id, type: "SYSTEM", body: line, authorId } })
    .catch(() => (authorId ? prisma.activity.create({ data: { projectId: job.id, type: "SYSTEM", body: line } }) : null))
    .catch(() => {});

  const after: LastReminder = { at: now, by, unconfirmed: outcome !== "sent" };
  const view = { atISO: now.toISOString(), words: reminderWords(after, now) };
  return outcome === "sent"
    ? { ok: true, message: `Texted ${first} at ${at} with the upload page link.`, last: view, text }
    : { ok: false, message: `OpenPhone did not confirm the text to ${first}. It may have gone; check Connections before pressing again.`, last: view, text };
}
