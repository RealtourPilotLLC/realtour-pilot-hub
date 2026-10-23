import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etTime } from "@/lib/datetime";
import { clip, noDashes, scrubMoney } from "@/lib/text";
import { aryeoCustomerNote } from "@/lib/shoot";
import { isAccessNote } from "@/lib/specialRequests";
import { HUB_SMS_PREFIX, staffTextNumber } from "@/lib/hubSms";
import { isSyntheticClientRow } from "@/lib/testClients";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";

// ---------------------------------------------------------------------------
// THE SPECIAL REQUESTS, TEXTED AT THE SHOOT (Oct 19 2026). Jordan: "if there
// is a special request, make sure we text the creative the special request on
// the day of the appointment at the appointment start time."
//
// WHEN. Every 5 minutes (cron/gmail), any live appointment whose start (ET)
// was in the last 30 minutes: the tick at or just after the start sends, and a
// missed tick still sends inside the half hour. Never before the start, never
// for a cancelled or postponed (UNSCHEDULED) appointment, a cancelled or
// on-hold job, or a test client.
//
// WHO. The creative on that appointment (Appointment.assignedTo; the job's
// photographer when the appointment names nobody), so a photographer and a
// videographer on separate appointments each get their own. Texted from the
// company line through the durable outbox (kind `shoot_day`), keyed per job,
// per creative, per ET shoot day: sent once, never twice, whatever the ticks
// or a second worker do. A creative with no textable number, our own office
// line on file, or inside their own quiet time (notifySchedule) gets nothing.
//
// WHAT. The job's special requests, as written (trimmed, figures scrubbed,
// no dashes; the hub has no cheap summarizer for these lines, and a client
// ask already carries its one-line summary):
//   · the Aryeo order's special instructions and order notes (shoot.ts
//     aryeoCustomerNote, the editor's "customer note");
//   · the requests staff added on the job (Activity SPECIAL_REQUEST typed by
//     a person: not the "Client request (…)" copies, whose live version is
//     the client's ask, nor the "Client access note (…)" rows);
//   · the client's OPEN special requests on the job (clientAsks.jobRequests),
//     prefixed "Client:".
// Door, gate and lockbox codes and who will be there are left out, sentence
// by sentence: the creative already has those on the shoot screen. Nothing
// left → no text. One line on the job's timeline says it went.
//
// Behind its own switch (Settings, Internal alerts, "Special requests at the
// shoot"), default on. Staff only: no client is ever texted from here.
// ---------------------------------------------------------------------------

/** Minutes after an appointment's start in which its text may still go. */
export const SHOOT_DAY_WINDOW_MIN = 30;
/** At most this many requests in one text; each at most this long. */
const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 400;
const REQUESTED_BY = "shoot-day-text";

// ---- the words (pure) ---------------------------------------------------------

/** Who will be there, or that nobody will: the shoot screen's "Who's there". */
const PRESENCE =
  /\b(?:vacant|occupied)\b|\b(?:i|we|seller|sellers|owner|owners|homeowner|homeowners|tenant|tenants|agent|buyer|buyers|someone|nobody|no one)\b[^.!?\n]{0,40}?\b(?:be (?:there|home|present|on ?site)|present at|let (?:you|him|her|them) in|meet (?:you|him|her|them))\b/i;

/** A sentence about getting in (codes, keys, lockbox) or who is there. */
export function isAccessOrPresence(sentence: string): boolean {
  return isAccessNote(sentence) || PRESENCE.test(sentence);
}

const BLANK = /^(?:n\/?a|none|no|nothing|-+)\.?$/i;

/** The sentences of a note that are about the shoot itself, as written. */
export function shootSentences(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat || BLANK.test(flat)) return "";
  return flat
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s && !isAccessOrPresence(s))
    .join(" ")
    .trim();
}

/** Plain words for a phone: figures scrubbed, no dashes, one stop at the end. */
function tidy(s: string): string {
  let t = noDashes(scrubMoney(s)).replace(/\s+-\s+/g, ", ").replace(/\s+/g, " ").trim();
  t = clip(t, MAX_ITEM_CHARS);
  // A link is left bare (a stop after it breaks the link on some phones).
  return /[.!?…]$/.test(t) || /https?:\/\/\S+$/.test(t) ? t : `${t}.`;
}

const normKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type ShootDaySources = {
  /** the appointment's Aryeo brief, raw (special instructions, order notes) */
  brief: string | null;
  /** every SPECIAL_REQUEST line on the job (filtered here) */
  jobLines: string[];
  /** the client's open special requests on the job */
  clientAsks: { summary: string; text: string }[];
};

/** The special requests worth a text, in order: the order's, the office's, the client's. */
export function shootDayRequests(src: ShootDaySources): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string, prefix = "") => {
    if (!s) return;
    const line = tidy(`${prefix}${s}`);
    const k = normKey(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(line);
  };
  // The order's special instructions, then its order notes (one item each).
  for (const part of (aryeoCustomerNote(src.brief) ?? "").split(/\n\s*\n/)) push(shootSentences(part));
  // What the office typed on the job. The client's own words arrive as their
  // asks below (an ask closes; its "Client request (…)" copy never does), and
  // a client's access note is the shoot screen's.
  for (const body of src.jobLines) {
    if (/^Client (?:request|access note) \(/i.test(body.trim())) continue;
    push(shootSentences(body));
  }
  for (const a of src.clientAsks) push(shootSentences(a.summary?.trim() || a.text), "Client: ");
  return out.slice(0, MAX_ITEMS);
}

/** "104 Carlton Ct, 2:30 PM. Special requests for this shoot: 1) … 2) … Shoot screen: <link>"
 *  The words are the shoot_day_requests template (Settings → Text messages,
 *  Oct 21 2026); the hub marker stays in front. `t` = saved wording, else default. */
export function composeShootDayText(o: { street: string; startAt: Date; requests: string[]; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  const items = o.requests.map((r, i) => `${i + 1}) ${r}`).join(" ");
  return noDashes(`${HUB_SMS_PREFIX}: ${t.render("shoot_day_requests", { street: o.street, time: etTime(o.startAt), requestList: items, link: o.link })}`);
}

/** The appointment can still happen at its time: not cancelled, not postponed without a slot. */
export function liveAppointment(a: { status: string | null; startAt: Date | null }): boolean {
  const s = (a.status ?? "").toUpperCase();
  return !!a.startAt && !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && !s.includes("POSTPON");
}

const streetOf = (title: string, addressLine: string | null) =>
  (addressLine?.trim() && !/^\[No address/i.test(addressLine) ? addressLine.trim() : title.split(",")[0].trim()) || "Your shoot";
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

// ---- who and what, right now (reads only) --------------------------------------

export type ShootDayCandidate = {
  projectId: string;
  appointmentId: string;
  startAt: Date;
  shootDay: string;
  street: string;
  teamMemberId: string;
  name: string;
  /** the 10-digit number we would text, null when there is none */
  toKey: string | null;
  dedupeKey: string;
  requests: string[];
  text: string | null;
  /** why nothing goes to this person ("nothing special", "no phone", "already sent") */
  skip: string | null;
};

/** Every (job, creative) whose appointment started in the last half hour, with the text it would get. */
export async function shootDayCandidates(now: Date = new Date()): Promise<ShootDayCandidate[]> {
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gt: new Date(now.getTime() - SHOOT_DAY_WINDOW_MIN * 60_000), lte: now },
      project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } },
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true, startAt: true, status: true, assignedToId: true, description: true,
      project: {
        select: {
          id: true, title: true, addressLine: true, photographerId: true,
          client: { select: { id: true, name: true } },
          appointments: { select: { description: true } },
        },
      },
    },
  });
  // One per (job, creative): their earliest live appointment in the window.
  type Appt = (typeof appts)[number];
  const groups = new Map<string, { a: Appt; teamMemberId: string }>();
  for (const a of appts) {
    if (!liveAppointment(a) || isSyntheticClientRow(a.project.client)) continue;
    const who = a.assignedToId ?? a.project.photographerId;
    if (!who) continue;
    const k = `${a.project.id}|${who}`;
    if (!groups.has(k)) groups.set(k, { a, teamMemberId: who });
  }
  if (groups.size === 0) return [];

  const { shootDayKey } = await import("@/lib/outbox");
  const { appBase } = await import("@/lib/appUrl");
  const { loadTextTemplates } = await import("@/lib/textTemplateStore");
  const words = await loadTextTemplates();
  const rows = [...groups.values()].map(({ a, teamMemberId }) => {
    const shootDay = etDayKey(a.startAt!);
    return { a, teamMemberId, shootDay, dedupeKey: shootDayKey(a.project.id, teamMemberId, shootDay) };
  });
  const projectIds = [...new Set(rows.map((r) => r.a.project.id))];
  const [taken, members, jobLines] = await Promise.all([
    prisma.outboxMessage.findMany({ where: { dedupeKey: { in: rows.map((r) => r.dedupeKey) } }, select: { dedupeKey: true } }),
    prisma.teamMember.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.teamMemberId))] } }, select: { id: true, name: true, phone: true, active: true } }),
    prisma.activity.findMany({ where: { projectId: { in: projectIds }, type: "SPECIAL_REQUEST" }, orderBy: { createdAt: "asc" }, select: { projectId: true, body: true } }),
  ]);
  const takenKeys = new Set(taken.map((t) => t.dedupeKey));
  const memberOf = new Map(members.map((m) => [m.id, m]));

  // The client's open requests, per job (both media: the creative shoots for both).
  const { jobRequests } = await import("@/lib/clientAsks");
  const asksOf = new Map<string, { summary: string; text: string }[]>();
  for (const pid of projectIds) {
    if (rows.every((r) => r.a.project.id !== pid || takenKeys.has(r.dedupeKey))) continue;
    const [photo, video] = await Promise.all([jobRequests(pid, "photo"), jobRequests(pid, "video")]);
    const byId = new Map([...photo, ...video].map((r) => [r.id, r]));
    asksOf.set(pid, [...byId.values()].sort((x, y) => x.askedAt.getTime() - y.askedAt.getTime()));
  }

  // FOLDED INTO THE PHOTOGRAPHER BRIEF (Oct 23 2026, lib/photographerBrief):
  // while that brief is on, a creative whose brief for the day went already has
  // these requests (and a change since re-sends the brief), so this text is not
  // sent as well. A brief that never went (off, failed, no phone) leaves this
  // text exactly as it was.
  const { briefsSentFor } = await import("@/lib/photographerBrief");
  const briefed = await briefsSentFor(rows.filter((r) => !takenKeys.has(r.dedupeKey)).map((r) => ({ teamMemberId: r.teamMemberId, day: r.shootDay }))).catch(() => new Set<string>());

  return rows.map(({ a, teamMemberId, shootDay, dedupeKey }) => {
    const m = memberOf.get(teamMemberId);
    const num = staffTextNumber(m?.phone);
    const base = {
      projectId: a.project.id, appointmentId: a.id, startAt: a.startAt!, shootDay,
      street: streetOf(a.project.title, a.project.addressLine),
      teamMemberId, name: m?.name ?? "(not on the roster)", toKey: num?.key ?? null, dedupeKey,
    };
    if (takenKeys.has(dedupeKey)) return { ...base, requests: [], text: null, skip: "already sent" };
    if (briefed.has(`${teamMemberId}|${shootDay}`)) return { ...base, requests: [], text: null, skip: "in the photographer brief" };
    const brief = a.description?.trim() || a.project.appointments.map((x) => x.description?.trim()).find(Boolean) || null;
    const requests = shootDayRequests({
      brief,
      jobLines: jobLines.filter((l) => l.projectId === a.project.id).map((l) => l.body),
      clientAsks: asksOf.get(a.project.id) ?? [],
    });
    const text = requests.length ? composeShootDayText({ street: base.street, startAt: base.startAt, requests, link: `${appBase()}/shoot/${a.project.id}` }, words) : null;
    const skip = !requests.length ? "nothing special" : !m || !m.active ? "not an active team member" : !num ? "no phone" : null;
    return { ...base, requests, text, skip };
  });
}

// ---- the send -------------------------------------------------------------------

export type ShootDayRun =
  | { skipped: string }
  | { considered: number; sent: string[]; notSent: string[] };

/** The job's timeline line for a text that went (or may have). */
async function timelineLine(projectId: string, name: string, at: Date, confirmed: boolean): Promise<void> {
  const body = confirmed
    ? `Texted ${firstName(name)} the special requests at ${etTime(at)}.`
    : `Texted ${firstName(name)} the special requests at ${etTime(at)}, but OpenPhone did not confirm it. Check Connections before sending again.`;
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body } }).catch(() => {});
}

async function logSent(teamMemberId: string, providerId: string | null, detail?: string): Promise<void> {
  try {
    const { logDelivery } = await import("@/lib/notify");
    await logDelivery({ teamMemberId, kind: "shoot_day_text", channel: "sms", status: "sent", detail: detail ?? (providerId ? `op-${providerId}` : null) });
  } catch { /* the outbox row is the record */ }
}

/** Every 5 minutes (cron/gmail). Idle unless an appointment just started. */
export async function sweepShootDayTexts(now: Date = new Date()): Promise<ShootDayRun> {
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  if (!rules.shootDayText.enabled) return { skipped: "switched off (Settings, Internal alerts, Special requests at the shoot)" };
  const candidates = await shootDayCandidates(now);
  const run = { considered: candidates.length, sent: [] as string[], notSent: [] as string[] };
  const due = candidates.filter((c) => !c.skip && c.text && c.toKey);
  for (const c of candidates) if (c.skip && c.skip !== "already sent") run.notSent.push(`${c.street} to ${c.name}: ${c.skip}`);
  if (due.length === 0) return run;

  const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const { holdFor } = await import("@/lib/notifySchedule");
  const { sendThroughOutbox } = await import("@/lib/outbox");
  const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  for (const c of due) {
    const label = `${c.street} to ${c.name}`;
    if (ours.has(c.toKey!)) { run.notSent.push(`${label}: their number is our own office line`); continue; }
    if (await holdFor(c.teamMemberId, now)) { run.notSent.push(`${label}: their quiet time`); continue; }
    let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
    try {
      r = await sendThroughOutbox({ channel: "sms", toRef: c.toKey!, body: c.text!, dedupeKey: c.dedupeKey, projectId: c.projectId, requestedBy: REQUESTED_BY });
    } catch (e) {
      // A database failure while queueing: nothing was handed over, or the
      // watchdog owns the row. The next tick asks again inside the window.
      run.notSent.push(`${label}: could not queue (${e instanceof Error ? e.message : "error"})`);
      continue;
    }
    if (r.outcome === "accepted") {
      await Promise.all([timelineLine(c.projectId, c.name, new Date(), true), logSent(c.teamMemberId, r.providerId)]);
      run.sent.push(label);
    } else if (r.outcome === "unknown") {
      await timelineLine(c.projectId, c.name, new Date(), false);
      run.notSent.push(`${label}: unconfirmed, held for a person (${r.error})`);
    } else if (r.outcome === "failed") {
      run.notSent.push(`${label}: refused, nothing sent (${r.error}); the next tick tries again`);
    } else {
      run.notSent.push(`${label}: ${r.outcome}`);
    }
  }
  return run;
}

/** A shoot-day text the outbox watchdog sent after its sweep stopped (cron/gmail
 *  drainPending): the timeline line and the delivery log its sweep would have written. */
export async function recordDrainedShootDayText(row: { dedupeKey: string | null }, providerId: string | null): Promise<string | null> {
  const [kind, projectId, teamMemberId] = (row.dedupeKey ?? "").split(":");
  if (kind !== "shoot_day" || !projectId || !teamMemberId) return null;
  const m = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true } }).catch(() => null);
  await Promise.all([timelineLine(projectId, m?.name ?? "the creative", new Date(), true), logSent(teamMemberId, providerId, providerId ? `op-${providerId} (recovered)` : "(recovered)")]);
  return `recovered and sent the shoot-day text for ${projectId} to ${m?.name ?? teamMemberId}`;
}
