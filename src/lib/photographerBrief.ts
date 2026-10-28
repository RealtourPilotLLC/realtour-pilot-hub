import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { etDayBoundsUtc, etDayKey, etTime } from "@/lib/datetime";
import { noDashes } from "@/lib/text";
import { staffTextNumber } from "@/lib/hubSms";
import { isSyntheticClientRow } from "@/lib/testClients";
import {
  BRIEF_SETTING_KEY,
  DEFAULT_BRIEF_SETTINGS,
  SEND_TIME_CHOICES,
  ackHolds,
  briefDueAt,
  briefStateOf,
  composeBriefText,
  composeUpdateText,
  dayWords,
  daysInScope,
  digestOf,
  emptyRecord,
  liveChanges,
  materialOf,
  parseRecord,
  readBriefSettings,
  sendTimeWords,
  sentenceKey,
  visitFacts,
  type BriefDay,
  type BriefRecord,
  type BriefSend,
  type BriefSettings,
  type MaterialSnapshot,
  type VisitFacts,
} from "@/lib/photographerBriefCore";

// ---------------------------------------------------------------------------
// THE PHOTOGRAPHER BRIEF, WITH "GOT IT" (Oct 23 2026). Jordan's Kyle dashboard
// spec: "A text alone doesn't prove the photographer saw the instructions.
// Prepare a briefing from the current appointment record ... Send at a
// configurable time before the first shoot. Material changes after
// acknowledgment trigger an updated brief and renewed acknowledgment. Failed
// sends and unacknowledged briefs surface on Kyle's dashboard. Prepare the next
// business day before closeout (Monday's shoots on Friday)." Acceptance check 8:
// "Changed shoot instructions require renewed acknowledgment."
//
// ONE BRIEF PER PHOTOGRAPHER PER SHOOT DAY, built from the CURRENT appointment
// rows every time (lib/photographerBriefCore visitFacts): for each of their
// visits that day the time and address, the services THAT visit covers (the
// appointment's own Aryeo items, not the whole order), access and the on-site
// contact, and the must-get items, exclusions and requests made for that visit
// before it (an earlier visit's notes, and anything after the job's first
// delivery, never). The photographer is the appointment's assignee, else the
// job's photographer, exactly as the shoot-day text and the shoot screen read it.
//
// WHEN. The send time (Settings, Internal alerts, "Photographer brief"; 6 PM ET
// by default) on the business day before the shoot day, so Friday's run
// covers Saturday, Sunday and Monday. The gmail cron's 5-minute step sends
// what is due: a booking made after the run still gets its brief on the next
// tick, as long as the day's first shoot has not started.
//
// ONCE, THEN ONLY WHEN IT MATTERS. The first brief goes once per photographer
// per day. After it, the step compares the day as it stands with what was sent:
// a MATERIAL change to a visit that has not started (time, address, services,
// access, contact, requests, a visit added to or taken off their day, which is
// how a reassignment reads) sends an updated brief that says what changed, and
// the Got it no longer holds. Anything else (the order's payment, the weather,
// a note folded under "earlier visits") changes nothing and sends nothing.
//
// NEVER TWICE. A send is CLAIMED first on the day's record (an AppSetting row,
// compare-and-swap, like Remind photographer); the outbox key carries the send
// number, so a retry of the same send collides in the outbox and a real update
// does not. A claim a dead tick left behind is taken over after 15 minutes,
// and the outbox answers for whatever that tick already handed over.
//
// "GOT IT" is the full-brief page (/shoot/brief/<day>): the signed-in
// photographer whose brief it is presses it; the record keeps who, when and
// exactly what they acknowledged, so a later material change shows as
// "changed" until they press it again.
//
// THE SWITCH. AppSetting `photographer_brief` ({"enabled":false,"sendMinute":1080}
// when nothing is saved): OFF until Jordan has seen a sample (scripts/_live/
// oct23-brief-preview.ts prints one). Off, nothing is built or sent, the
// statuses say "off", and the old night-before brief (eveningPush) and the
// shoot-day special-request text carry on exactly as before. On, this brief
// takes their place: the night-before text stops (its access task for Kyle
// stays), and the shoot-day text is not sent to a creative whose brief for
// that day went (the requests are in the brief, and a change re-sends it).
//
// Staff only: no client is ever texted from here.
// ---------------------------------------------------------------------------

export type BriefState = "off" | "pending" | "sent" | "failed" | "acknowledged" | "changed";

const RECORD_PREFIX = "photographer_brief:day:";
const SEEN_PREFIX = "photographer_brief:seen:";
/** One photographer's brief for one ET day. */
export const briefRecordKey = (teamMemberId: string, day: string) => `${RECORD_PREFIX}${teamMemberId}:${day}`;
/** When each sentence of a job's Aryeo order notes was first seen (which visit a note is for). */
export const briefSeenKey = (projectId: string) => `${SEEN_PREFIX}${projectId}`;
const REQUESTED_BY = "photographer-brief";
/** A claim older than this was a tick that died mid-send. */
const CLAIM_STALE_MS = 15 * 60_000;
/** A refused send is tried again after this long, at most this many times, then a person decides. */
const RETRY_GAP_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
/** More updates than this in one day and the hub stops texting; Kyle calls. */
const MAX_UPDATES = 6;
/** Send brief now: not twice inside this window. */
const PRESS_GAP_MS = 2 * 60_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

// ---- settings ---------------------------------------------------------------------

/** The switch and the send time, read fresh (never a cached copy: a press of the switch holds at once). */
export async function photographerBriefSettings(): Promise<BriefSettings> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: BRIEF_SETTING_KEY }, select: { value: true } });
    return readBriefSettings(row?.value);
  } catch {
    return DEFAULT_BRIEF_SETTINGS; // unreadable = off
  }
}

/** Save (owner or admin; the caller checks). Refuses a time Settings does not offer. */
export async function savePhotographerBriefSettings(input: BriefSettings, by: string | null): Promise<{ ok: boolean; message: string }> {
  if (typeof input?.enabled !== "boolean" || !SEND_TIME_CHOICES.includes(input.sendMinute)) {
    return { ok: false, message: "Not saved: pick a send time between 3 PM and 9 PM." };
  }
  const value = JSON.stringify({ enabled: input.enabled, sendMinute: input.sendMinute } satisfies BriefSettings);
  await prisma.appSetting.upsert({ where: { key: BRIEF_SETTING_KEY }, create: { key: BRIEF_SETTING_KEY, value, updatedBy: by }, update: { value, updatedBy: by } });
  return {
    ok: true,
    message: input.enabled
      ? `Saved. Each photographer gets their brief at ${sendTimeWords(input.sendMinute)} ET the business day before their shoots (Friday covers the weekend and Monday).`
      : "Saved. The photographer brief is off: nothing sends.",
  };
}

// ---- the build (reads only) -------------------------------------------------------

/** The appointment can still happen at its time: not cancelled, not postponed without a slot. */
const liveAppt = (a: { status: string | null; startAt: Date | null }) => {
  const s = (a.status ?? "").toUpperCase();
  return !!a.startAt && !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && !s.includes("POSTPON");
};

export type BuiltBrief = BriefDay & {
  phone: string | null;
  active: boolean;
  firstShootAt: Date | null;
  material: MaterialSnapshot;
  digest: string;
  /** lat/lng and drone per visit, for the page only */
  extras: Map<string, { lat: number | null; lng: number | null; drone: boolean; title: string; clientName: string }>;
  /** They are on paid time off that whole day (lib/pto): the hub does not text them the day's shoots by itself. */
  offWhy?: string | null;
};

/** Why nothing is texted to a photographer who is off that day (audit Oct 25 2026). */
export const ptoBlockWhy = (name: string, day: string, n: number) =>
  `${firstName(name)} is on PTO ${dayWords(day)}. Reassign ${n === 1 ? "this shoot" : `these ${n} shoots`} in Aryeo (the new photographer gets the brief), or press Send brief now if ${firstName(name)} is shooting after all`;

export type BriefBuild = {
  briefs: BuiltBrief[];
  /** live appointments in range with nobody to brief */
  unassigned: { appointmentId: string; projectId: string; day: string; street: string }[];
  /** the first-seen registry rows this build would add (the sweep writes them) */
  seenWrites: { projectId: string; value: Record<string, string | null>; existed: boolean }[];
};

/**
 * Every brief for these ET days, as it stands right now. `teamMemberIds`
 * narrows it to those people. Reads only.
 */
export async function buildBriefDays(days: string[], opts: { now?: Date; teamMemberIds?: string[] } = {}): Promise<BriefBuild> {
  const now = opts.now ?? new Date();
  const out: BriefBuild = { briefs: [], unassigned: [], seenWrites: [] };
  const keys = [...new Set(days.filter((d) => DAY_KEY.test(d)))].sort();
  if (!keys.length) return out;
  const from = etDayBoundsUtc(keys[0]).start;
  const to = etDayBoundsUtc(keys[keys.length - 1]).end;
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: from, lt: to },
      project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } },
      ...(opts.teamMemberIds ? { OR: [{ assignedToId: { in: opts.teamMemberIds } }, { assignedToId: null, project: { photographerId: { in: opts.teamMemberIds } } }] } : {}),
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true, startAt: true, status: true, assignedToId: true, description: true, rawJson: true,
      project: {
        select: {
          id: true, title: true, addressLine: true, city: true, status: true, deliveredAt: true, photographerId: true, lat: true, lng: true,
          client: { select: { id: true, name: true } },
          orderItems: { select: { title: true, quantity: true, isCanceled: true } },
          appointments: { select: { id: true, startAt: true, status: true } },
          deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: "DRONE" }, select: { id: true } },
        },
      },
    },
  });
  const live = appts.filter((a) => liveAppt(a) && keys.includes(etDayKey(a.startAt!)) && !isSyntheticClientRow(a.project.client));
  if (!live.length) return out;

  const projectIds = [...new Set(live.map((a) => a.project.id))];
  const { ASK_SOURCES } = await import("@/lib/clientAsks");
  const [lines, asks, photoJobs, seenRows, noteAsks] = await Promise.all([
    prisma.activity.findMany({ where: { projectId: { in: projectIds }, type: "SPECIAL_REQUEST" }, select: { projectId: true, body: true, createdAt: true } }),
    prisma.clientAsk.findMany({
      where: { projectId: { in: projectIds }, kind: "SPECIAL_REQUEST", source: { in: [...ASK_SOURCES] }, state: { not: "NOT_NEEDED" } },
      select: { projectId: true, summary: true, text: true, askedAt: true, medium: true },
    }),
    prisma.photoJob.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, deliveredAt: true } }),
    prisma.appSetting.findMany({ where: { key: { in: projectIds.map(briefSeenKey) } }, select: { key: true, value: true } }),
    // When the hub first filed an order note on the job: evidence of when its words appeared.
    // (Photo Delivery's re-filed copies, "photo-order-note:…", carry the first note's date, not their own: never evidence.
    // NOT on a nullable column drops the NULL rows in Prisma, hence the OR.)
    prisma.clientAsk.findMany({ where: { projectId: { in: projectIds }, source: "order_note", OR: [{ dedupeKey: null }, { NOT: { dedupeKey: { startsWith: "photo-order-note:" } } }] }, select: { projectId: true, text: true, askedAt: true } }),
  ]);

  const seenOf = new Map<string, Record<string, string | null>>();
  for (const r of seenRows) {
    try {
      const j = JSON.parse(r.value) as Record<string, string | null>;
      if (j && typeof j === "object") seenOf.set(r.key.slice(SEEN_PREFIX.length), j);
    } catch { /* unreadable: rebuilt as a fresh seed */ }
  }

  // A job's registry, or (never tracked) a seed: each sentence of its order
  // notes, dated by the first order-note ask that carried it, else "the booking's".
  const seedFor = (projectId: string, sentences: string[]): Record<string, string | null> => {
    const ev = noteAsks.filter((n) => n.projectId === projectId).map((n) => ({ k: sentenceKey(n.text), at: n.askedAt }));
    const seed: Record<string, string | null> = {};
    for (const s of sentences) {
      const k = sentenceKey(s);
      const hits = ev.filter((e) => e.k.includes(k)).map((e) => e.at.getTime());
      seed[k] = hits.length ? new Date(Math.min(...hits)).toISOString() : null;
    }
    return seed;
  };

  type Facts = { facts: VisitFacts; who: string | null; day: string; a: (typeof live)[number] };
  const built: Facts[] = [];
  const sentencesByProject = new Map<string, Set<string>>();
  for (const a of live) {
    const p = a.project;
    const photosDelivered = photoJobs.find((j) => j.projectId === p.id)?.deliveredAt ?? null;
    const registry = seenOf.get(p.id);
    // First pass sentences are needed for a seed; visitFacts reports them, so build twice only when seeding.
    const input = {
      appointmentId: a.id,
      startAt: a.startAt!,
      description: a.description,
      rawJson: a.rawJson,
      liveVisits: p.appointments.filter(liveAppt).map((v) => ({ id: v.id, startAt: v.startAt })),
      project: { id: p.id, title: p.title, addressLine: p.addressLine, city: p.city, orderItems: p.orderItems, deliveredAt: p.deliveredAt, photosDeliveredAt: photosDelivered },
      jobLines: lines.filter((l) => l.projectId === p.id).map((l) => ({ body: l.body, createdAt: l.createdAt })),
      asks: asks.filter((x) => x.projectId === p.id).map((x) => ({ summary: x.summary, text: x.text, askedAt: x.askedAt, medium: x.medium })),
      firstSeen: registry ?? {},
      now,
    };
    let facts = visitFacts(input);
    if (!registry && facts.orderSentences.length) facts = visitFacts({ ...input, firstSeen: seedFor(p.id, facts.orderSentences) });
    const set = sentencesByProject.get(p.id) ?? new Set<string>();
    for (const s of facts.orderSentences) set.add(s);
    sentencesByProject.set(p.id, set);
    built.push({ facts, who: a.assignedToId ?? p.photographerId, day: etDayKey(a.startAt!), a });
  }

  // The registry rows to write: a seed for a job never tracked, new sentences dated now.
  for (const [projectId, set] of sentencesByProject) {
    const sentences = [...set];
    const registry = seenOf.get(projectId);
    if (!registry) {
      out.seenWrites.push({ projectId, value: seedFor(projectId, sentences), existed: false });
      continue;
    }
    const fresh = sentences.map(sentenceKey).filter((k) => k && !(k in registry));
    if (fresh.length) out.seenWrites.push({ projectId, value: { ...registry, ...Object.fromEntries(fresh.map((k) => [k, now.toISOString()])) }, existed: true });
  }

  const memberIds = [...new Set(built.map((b) => b.who).filter((x): x is string => !!x))];
  const members = memberIds.length ? await prisma.teamMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, phone: true, active: true } }) : [];
  const memberOf = new Map(members.map((m) => [m.id, m]));
  const groups = new Map<string, Facts[]>();
  for (const b of built) {
    if (!b.who) {
      out.unassigned.push({ appointmentId: b.a.id, projectId: b.a.project.id, day: b.day, street: b.facts.street });
      continue;
    }
    if (opts.teamMemberIds && !opts.teamMemberIds.includes(b.who)) continue;
    const k = `${b.who}|${b.day}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  // Paid time off (audit Oct 25 2026): a whole day off on the tracker means the
  // shoot still naming them is a booking to fix, not a brief to text.
  const { fullDaysOff } = await import("@/lib/pto");
  const off = await fullDaysOff([...groups.keys()].map((k) => ({ teamMemberId: k.split("|")[0], day: k.split("|")[1] }))).catch(() => new Map());
  for (const [k, list] of groups) {
    const [who, day] = k.split("|");
    const m = memberOf.get(who);
    const shoots = list.map((x) => x.facts).sort((x, y) => x.startISO.localeCompare(y.startISO));
    const material = materialOf(shoots);
    out.briefs.push({
      teamMemberId: who,
      name: m?.name ?? "(not on the roster)",
      day,
      shoots,
      phone: m?.phone ?? null,
      active: !!m?.active,
      firstShootAt: shoots.length ? new Date(shoots[0].startISO) : null,
      material,
      digest: digestOf(material),
      extras: new Map(list.map((x) => [x.a.id, { lat: x.a.project.lat, lng: x.a.project.lng, drone: x.a.project.deliverables.length > 0, title: x.a.project.title, clientName: x.a.project.client.name }])),
      offWhy: off.has(k) ? ptoBlockWhy(m?.name ?? "The photographer", day, shoots.length) : null,
    });
  }
  out.briefs.sort((x, y) => x.day.localeCompare(y.day) || x.name.localeCompare(y.name));
  return out;
}

/** A photographer's day with no visits left (all reassigned or cancelled): the empty brief, for an update. */
async function emptyBrief(teamMemberId: string, day: string): Promise<BuiltBrief> {
  const m = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true, phone: true, active: true } }).catch(() => null);
  const material = materialOf([]);
  return { teamMemberId, name: m?.name ?? "(not on the roster)", day, shoots: [], phone: m?.phone ?? null, active: !!m?.active, firstShootAt: null, material, digest: digestOf(material), extras: new Map() };
}

// ---- the record ----------------------------------------------------------------------

async function readRecordRow(teamMemberId: string, day: string): Promise<{ value: string | null; record: BriefRecord | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: briefRecordKey(teamMemberId, day) }, select: { value: true } });
  return { value: row?.value ?? null, record: row ? parseRecord(row.value, teamMemberId, day) : null };
}

/** Compare-and-swap: write `next` only if the row still holds `prev` (null = no row yet). */
async function swapRecord(teamMemberId: string, day: string, prev: string | null, next: BriefRecord, by = "system"): Promise<boolean> {
  const key = briefRecordKey(teamMemberId, day);
  const value = JSON.stringify(next);
  if (prev === null) return prisma.appSetting.create({ data: { key, value, updatedBy: by.slice(0, 120) } }).then(() => true, () => false);
  return (await prisma.appSetting.updateMany({ where: { key, value: prev }, data: { value, updatedBy: by.slice(0, 120) } })).count === 1;
}

const claimFresh = (r: BriefRecord | null, now: Date) => !!r?.claim && now.getTime() - Date.parse(r.claim.at) < CLAIM_STALE_MS;
const nextN = (r: BriefRecord | null) => Math.max(0, ...(r?.sends ?? []).map((s) => s.n), r?.claim?.n ?? 0) + 1;

// ---- the send -------------------------------------------------------------------------

export type SendResult = { outcome: "sent" | "unconfirmed" | "failed" | "busy" | "skipped"; message: string; text?: string };

type ClaimData = { id: string; at: string; n: number; kind: BriefSend["kind"]; by: string | null; digest: string; snapshot: MaterialSnapshot; changes: string[] };

/** The job timelines say the brief went (each job on the day, and any taken off it). */
async function timeline(projectIds: string[], body: string): Promise<void> {
  for (const projectId of [...new Set(projectIds)]) await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: noDashes(body).slice(0, 1000) } }).catch(() => {});
}

/** Write the outcome of a claimed send onto the record (the claim's own row value). */
function settle(r: BriefRecord, c: ClaimData, outcome: "sent" | "unconfirmed" | "failed", at: Date, error?: string): BriefRecord {
  const send: BriefSend = { n: c.n, at: at.toISOString(), kind: c.kind, by: c.by, outcome, digest: c.digest, ...(error ? { error: error.slice(0, 300) } : {}), ...(c.changes.length ? { changes: c.changes } : {}) };
  const next: BriefRecord = { ...r, claim: null, sends: [...r.sends, send].slice(-20) };
  if (outcome === "failed") {
    next.failed = { at: at.toISOString(), why: error ?? "the send failed", attempts: (r.failed?.attempts ?? 0) + 1 };
  } else {
    next.sent = { n: c.n, at: at.toISOString(), digest: c.digest, snapshot: c.snapshot, outcome };
    next.firstSentAt = r.firstSentAt ?? at.toISOString();
    next.failed = null;
  }
  return next;
}

/** A send the hub could not even try (no phone, not on the roster): recorded as failed with the reason. */
async function recordBlocked(b: BuiltBrief, prev: string | null, r: BriefRecord | null, why: string, now: Date): Promise<void> {
  const base = r ?? emptyRecord(b.teamMemberId, b.day);
  // Once per reason: a blocked brief is not re-recorded every tick.
  if (base.failed?.why === why) return;
  await swapRecord(b.teamMemberId, b.day, prev, { ...base, failed: { at: now.toISOString(), why, attempts: (base.failed?.attempts ?? 0) + 1 } });
}

/**
 * Claim, compose, send through the outbox, record. `kind` first / update /
 * resend; `changes` the words of what changed (an update). Never throws.
 */
async function sendBrief(b: BuiltBrief, prev: string | null, r: BriefRecord | null, o: { kind: BriefSend["kind"]; changes: string[]; by: string | null; now: Date; ours?: Set<string> }): Promise<SendResult> {
  const first = firstName(b.name);
  const dayW = dayWords(b.day);
  const num = staffTextNumber(b.phone);
  const blocked = !b.active ? `${b.name} is not an active team member` : !num ? `no phone number on file for ${first}` : o.ours?.has(num.key) ? `${first}'s number on file is our own office line` : null;
  if (blocked) {
    await recordBlocked(b, prev, r, blocked, o.now);
    return { outcome: "failed", message: `Not sent: ${blocked}.` };
  }
  // 1. The claim (a double press or two ticks send one text).
  const base = r ?? emptyRecord(b.teamMemberId, b.day);
  const c: ClaimData = { id: crypto.randomUUID(), at: o.now.toISOString(), n: nextN(r), kind: o.kind, by: o.by, digest: b.digest, snapshot: b.material, changes: o.changes };
  const claimed: BriefRecord = { ...base, claim: c };
  if (!(await swapRecord(b.teamMemberId, b.day, prev, claimed, o.by ?? REQUESTED_BY))) return { outcome: "busy", message: `${first}'s brief for ${dayW} is going out right now.` };
  const mine = JSON.stringify(claimed);

  // 2. The words and the send.
  const { appBase } = await import("@/lib/appUrl");
  const link = `${appBase()}/shoot/brief/${b.day}`;
  const text = o.kind === "update" ? composeUpdateText(b, o.changes, link) : composeBriefText(b, link);
  const { sendThroughOutbox, photographerBriefKey } = await import("@/lib/outbox");
  let res: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    res = await sendThroughOutbox({ channel: "sms", toRef: num!.key, body: text, dedupeKey: photographerBriefKey(b.teamMemberId, b.day, c.n), requestedBy: (o.by ?? REQUESTED_BY).slice(0, 120) });
  } catch (e) {
    // Nothing handed over (or the watchdog owns the row): release the claim; the next tick asks again.
    await prisma.appSetting.updateMany({ where: { key: briefRecordKey(b.teamMemberId, b.day), value: mine }, data: { value: prev ?? JSON.stringify(base) } }).catch(() => {});
    return { outcome: "failed", message: `The brief could not be queued (${e instanceof Error ? e.message : "error"}). Nothing was sent.` };
  }
  if (res.outcome === "busy") return { outcome: "busy", message: `${first}'s brief for ${dayW} is going out right now.` };
  const outcome: "sent" | "unconfirmed" | "failed" =
    res.outcome === "accepted" || (res.outcome === "duplicate" && res.state === "accepted") ? "sent"
    : res.outcome === "failed" || (res.outcome === "duplicate" && res.state === "failed") ? "failed"
    : res.outcome === "duplicate" && (res.state === "pending" || res.state === "attempting") ? "unconfirmed"
    : "unconfirmed";
  const error = res.outcome === "failed" ? `OpenPhone refused it: ${res.error}` : res.outcome === "unknown" ? `OpenPhone did not confirm it: ${res.error}` : outcome === "failed" ? "OpenPhone refused it" : undefined;
  const now = new Date();
  await prisma.appSetting.updateMany({ where: { key: briefRecordKey(b.teamMemberId, b.day), value: mine }, data: { value: JSON.stringify(settle(claimed, c, outcome, now, error)) } }).catch(() => {});

  // 3. The record everyone else reads: the job timelines and the delivery log.
  if (outcome !== "failed") {
    const what = o.kind === "update" ? `an updated shoot brief for ${dayW} (${o.changes.join("; ") || "details changed"})` : o.kind === "resend" ? `the shoot brief for ${dayW} again` : `the shoot brief for ${dayW}`;
    const who = o.by ? `${o.by} texted ${first}` : `Texted ${first}`;
    const tail = outcome === "unconfirmed" ? ", but OpenPhone did not confirm it. Check Connections before sending again." : ".";
    const removed = (r?.sent?.snapshot ?? []).filter((s) => !b.material.some((m) => m.a === s.a)).map((s) => s.p);
    await timeline([...b.shoots.map((s) => s.projectId), ...removed], `${who} ${what} at ${etTime(now)}${tail}`);
    if (outcome === "sent") {
      try {
        const { logDelivery } = await import("@/lib/notify");
        await logDelivery({ teamMemberId: b.teamMemberId, kind: "photographer_brief", channel: "sms", status: "sent", detail: `${"providerId" in res && res.providerId ? `op-${res.providerId} ` : ""}${b.day} #${c.n}` });
      } catch { /* the outbox row is the record */ }
    }
  }
  return outcome === "sent"
    ? { outcome, message: `Texted ${first} the ${o.kind === "update" ? "updated " : ""}brief for ${dayW}.`, text }
    : outcome === "unconfirmed"
      ? { outcome, message: `OpenPhone did not confirm the brief to ${first}. It may have gone; check Connections before sending again.`, text }
      : { outcome, message: `Not sent: ${error ?? "OpenPhone refused it"}.`.slice(0, 300) };
}

// ---- the sweep (cron/gmail, every 5 minutes) ---------------------------------------------

export type BriefRun =
  | { skipped: string }
  | { considered: number; sent: string[]; updated: string[]; notSent: string[]; absorbed: string[]; waiting: string[] };

/** A brief sent after its sweep stopped (the outbox watchdog drained it): the record its sweep would have written. */
export async function recordDrainedBriefText(row: { dedupeKey: string | null }, providerId: string | null): Promise<string | null> {
  const [kind, teamMemberId, day, nStr] = (row.dedupeKey ?? "").split(":");
  const n = Number(nStr);
  if (kind !== "photographer_brief" || !teamMemberId || !day || !Number.isInteger(n)) return null;
  const { value, record } = await readRecordRow(teamMemberId, day).catch(() => ({ value: null, record: null }));
  const c = record?.claim as ClaimData | null | undefined;
  if (record && value && c && c.n === n && Array.isArray(c.snapshot)) {
    await prisma.appSetting.updateMany({ where: { key: briefRecordKey(teamMemberId, day), value }, data: { value: JSON.stringify(settle(record, c, "sent", new Date())) } }).catch(() => {});
  }
  try {
    const { logDelivery } = await import("@/lib/notify");
    await logDelivery({ teamMemberId, kind: "photographer_brief", channel: "sms", status: "sent", detail: `${providerId ? `op-${providerId} ` : ""}${day} #${n} (recovered)` });
  } catch { /* the outbox row is the record */ }
  return `recovered and sent the photographer brief for ${day} to ${teamMemberId}`;
}

/** Every 5 minutes. Idle while switched off. */
export async function sweepPhotographerBriefs(now: Date = new Date()): Promise<BriefRun> {
  const settings = await photographerBriefSettings();
  if (!settings.enabled) return { skipped: "switched off (Settings, Internal alerts, Photographer brief)" };
  const days = daysInScope(now);
  const build = await buildBriefDays(days, { now });
  const run = { considered: 0, sent: [] as string[], updated: [] as string[], notSent: [] as string[], absorbed: [] as string[], waiting: [] as string[] };

  // Which visit a note is for: record when each order-note sentence first appeared.
  for (const w of build.seenWrites) {
    const key = briefSeenKey(w.projectId);
    const value = JSON.stringify(w.value);
    await (w.existed ? prisma.appSetting.update({ where: { key }, data: { value, updatedBy: REQUESTED_BY } }) : prisma.appSetting.create({ data: { key, value, updatedBy: REQUESTED_BY } })).catch(() => {});
  }
  for (const u of build.unassigned) if (etDayKey(now) <= u.day) run.waiting.push(`${u.street} (${u.day}): no photographer on it`);

  // Days with a brief already out whose visits are all gone (reassigned, cancelled): an update says so.
  const recordRows = await prisma.appSetting.findMany({ where: { OR: days.map((d) => ({ key: { startsWith: RECORD_PREFIX, endsWith: `:${d}` } })) }, select: { key: true, value: true } });
  const briefs = [...build.briefs];
  for (const row of recordRows) {
    const [tm, day] = row.key.slice(RECORD_PREFIX.length).split(":");
    if (!tm || !day || briefs.some((b) => b.teamMemberId === tm && b.day === day)) continue;
    const rec = parseRecord(row.value, tm, day);
    if (rec?.sent?.snapshot.length) briefs.push(await emptyBrief(tm, day));
  }

  let ours: Set<string> | null = null;
  const { holdFor } = await import("@/lib/notifySchedule");
  for (const b of briefs) {
    const label = `${b.name} for ${b.day}`;
    const { value, record } = await readRecordRow(b.teamMemberId, b.day);
    if (claimFresh(record, now)) continue;
    let kind: BriefSend["kind"] | null = null;
    let changes: string[] = [];
    if (!record?.sent) {
      if (!b.shoots.length) continue;
      if (now < briefDueAt(b.day, settings)) continue;
      run.considered++;
      if (b.firstShootAt && b.firstShootAt <= now) { run.notSent.push(`${label}: the day's first shoot already started`); continue; }
      if (record?.failed && (record.failed.attempts >= MAX_ATTEMPTS || now.getTime() - Date.parse(record.failed.at) < RETRY_GAP_MS)) continue;
      kind = "first";
    } else {
      if (record.sent.outcome === "unconfirmed") continue; // may have gone: a person decides
      const live = liveChanges(record.sent.snapshot, b.material, now);
      if (!live.length || ackHolds(record, b.material, now)) {
        // Nothing that matters, or they already acknowledged this version on the page: keep the record level, send nothing.
        if (record.sent.digest !== b.digest) {
          const next: BriefRecord = { ...record, sent: { ...record.sent, digest: b.digest, snapshot: b.material } };
          if (await swapRecord(b.teamMemberId, b.day, value, next)) run.absorbed.push(label);
        }
        continue;
      }
      run.considered++;
      if (record.sends.filter((s) => s.kind === "update").length >= MAX_UPDATES) { run.notSent.push(`${label}: ${MAX_UPDATES} updates already today, call them`); continue; }
      if (record.failed && Date.parse(record.failed.at) > Date.parse(record.sent.at) && (record.failed.attempts >= MAX_ATTEMPTS || now.getTime() - Date.parse(record.failed.at) < RETRY_GAP_MS)) continue;
      kind = "update";
      changes = live.map((c) => c.words);
    }
    // On PTO that whole day: nothing goes to them by itself, and the dashboards
    // say why (briefStatusForAppointments). An update that takes every shoot
    // off their day still goes: it tells them they are off it.
    if (b.offWhy && b.shoots.length) {
      await recordBlocked(b, value, record, b.offWhy, now);
      run.notSent.push(`${label}: ${b.offWhy}`);
      continue;
    }
    const quiet = await holdFor(b.teamMemberId, now);
    if (quiet) { run.waiting.push(`${label}: their quiet time until ${quiet.toISOString()}`); continue; }
    if (!ours) {
      const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
      ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
    }
    const r = await sendBrief(b, value, record, { kind, changes, by: null, now, ours });
    if (r.outcome === "sent") (kind === "update" ? run.updated : run.sent).push(label);
    else if (r.outcome !== "busy") run.notSent.push(`${label}: ${r.message}`);
  }
  return run;
}

// ---- Send brief now (the dashboard's button) -----------------------------------------------

/**
 * Send one photographer's brief for one day now: the first brief if none went,
 * an updated one if something changed, else the same brief again. `who` is the
 * person pressing (the caller has checked they may). Refused while switched off.
 */
export async function sendBriefNow(teamMemberId: string, day: string, who: { name: string }, now: Date = new Date()): Promise<{ ok: boolean; message: string; text?: string }> {
  if (!teamMemberId || !DAY_KEY.test(day)) return { ok: false, message: "Pick a photographer and a day." };
  const settings = await photographerBriefSettings();
  if (!settings.enabled) return { ok: false, message: "The photographer brief is switched off (Settings, Internal alerts), so nothing was sent." };
  const build = await buildBriefDays([day], { now, teamMemberIds: [teamMemberId] });
  const { value, record } = await readRecordRow(teamMemberId, day);
  const b = build.briefs.find((x) => x.teamMemberId === teamMemberId && x.day === day) ?? (record?.sent ? await emptyBrief(teamMemberId, day) : null);
  if (!b) {
    const m = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true } }).catch(() => null);
    return { ok: false, message: `${m ? firstName(m.name) : "That photographer"} has no shoots on ${dayWords(day)}, so there is no brief to send.` };
  }
  const last = b.shoots.length ? Date.parse(b.shoots[b.shoots.length - 1].startISO) : null;
  if (last !== null && last <= now.getTime()) return { ok: false, message: `Every shoot on ${dayWords(day)} has started, so no brief was sent.` };
  if (claimFresh(record, now)) return { ok: false, message: `${firstName(b.name)}'s brief for ${dayWords(day)} is going out right now.` };
  const lastSend = record?.sends.length ? record.sends[record.sends.length - 1] : null;
  if (lastSend && lastSend.outcome !== "failed" && now.getTime() - Date.parse(lastSend.at) < PRESS_GAP_MS) {
    return { ok: false, message: `${firstName(b.name)}'s brief went at ${etTime(new Date(lastSend.at))}. Give it a couple of minutes before sending again.` };
  }
  const live = record?.sent ? liveChanges(record.sent.snapshot, b.material, now) : [];
  const kind: BriefSend["kind"] = !record?.sent ? "first" : live.length ? "update" : "resend";
  const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  const r = await sendBrief(b, value, record, { kind, changes: live.map((c) => c.words), by: who.name.trim() || "The office", now, ours });
  return { ok: r.outcome === "sent", message: r.message, text: r.text };
}

// ---- Got it ------------------------------------------------------------------------------------

/**
 * The photographer acknowledges their brief for a day. `digest` is the version
 * their page showed: a brief that changed while it was open is refused, so a
 * Got it always means the version they read. Records who and when.
 */
export async function acknowledgeBrief(o: { teamMemberId: string; day: string; digest: string; by: string; userId: string | null; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const now = o.now ?? new Date();
  if (!DAY_KEY.test(o.day)) return { ok: false, message: "That day is not a brief." };
  const build = await buildBriefDays([o.day], { now, teamMemberIds: [o.teamMemberId] });
  const b = build.briefs.find((x) => x.teamMemberId === o.teamMemberId && x.day === o.day);
  if (!b || !b.shoots.length) return { ok: false, message: `You have no shoots on ${dayWords(o.day)}.` };
  if (b.digest !== o.digest) return { ok: false, message: "The brief changed while this page was open. Reload to see the latest, then tap Got it." };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, record } = await readRecordRow(o.teamMemberId, o.day);
    const base = record ?? emptyRecord(o.teamMemberId, o.day);
    if (base.ack && base.ack.digest === b.digest) return { ok: true, message: `Already acknowledged at ${etTime(new Date(base.ack.at))}.` };
    const ack = { at: now.toISOString(), by: o.by, userId: o.userId, digest: b.digest, snapshot: b.material };
    const next: BriefRecord = { ...base, ack, acks: [...base.acks, { at: ack.at, by: ack.by, digest: ack.digest }].slice(-10) };
    if (await swapRecord(o.teamMemberId, o.day, value, next, o.by)) {
      await timeline(b.shoots.map((s) => s.projectId), `${firstName(o.by)} tapped Got it on the shoot brief for ${dayWords(o.day)} at ${etTime(now)}.`);
      return { ok: true, message: `Got it. Recorded at ${etTime(now)}.` };
    }
  }
  return { ok: false, message: "Could not save that just now. Try again." };
}

// ---- reading: the page, the dashboard, the shoot-day text ----------------------------------------

/** The full-brief page's data for one photographer and day. */
export async function briefPageView(teamMemberId: string, day: string, now: Date = new Date()) {
  const [settings, build, { record }] = await Promise.all([
    photographerBriefSettings(),
    buildBriefDays([day], { now, teamMemberIds: [teamMemberId] }),
    readRecordRow(teamMemberId, day),
  ]);
  const b = build.briefs.find((x) => x.teamMemberId === teamMemberId && x.day === day) ?? null;
  const status = b
    ? briefStateOf({ enabled: settings.enabled, record, current: b.material, firstShootAt: b.firstShootAt, dueAt: briefDueAt(day, settings), now, blocker: null, name: b.name })
    : null;
  const holds = !!b && ackHolds(record, b.material, now);
  // WHAT CHANGED (Oct 28 2026: James saw "Brief changed" for Ashley Brunner's 3 PM
  // and the page only said "Sent"). Before any Got it: every update texted since
  // the first brief, plus what changed since the last text. After a Got it that no
  // longer holds: exactly what changed since he confirmed. An update kept only
  // its words, so its shoot is the one whose street the words name.
  const shootOf = (words: string) => b?.shoots.find((s) => words.includes(s.street))?.appointmentId ?? null;
  const updates = (record?.sends ?? [])
    .filter((s) => s.kind === "update" && s.outcome !== "failed")
    .flatMap((s) => (s.changes ?? []).map((words) => ({ at: s.at as string | null, words, appointmentId: shootOf(words) })));
  const live = (from: MaterialSnapshot | undefined) =>
    from && b ? liveChanges(from, b.material, now).map((c) => ({ at: null as string | null, words: c.words, appointmentId: c.appointmentId as string | null })) : [];
  const changed = !b || holds
    ? []
    : record?.ack
      ? live(record.ack.snapshot)
      : [...updates, ...live(record?.sent?.snapshot)];
  return {
    brief: b,
    record,
    status,
    settings,
    ackHolds: holds,
    /** what to read again before Got it (empty when the Got it holds) */
    changed,
    /** the updates already confirmed with a Got it, for the record */
    confirmedUpdates: holds ? updates : [],
  };
}

/** For the shoot-day special-request text: the creative's brief for that day went, so the requests were in it. */
export async function briefsSentFor(pairs: { teamMemberId: string; day: string }[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!pairs.length || !(await photographerBriefSettings()).enabled) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: pairs.map((p) => briefRecordKey(p.teamMemberId, p.day)) } }, select: { key: true, value: true } }).catch(() => []);
  for (const p of pairs) {
    const row = rows.find((r) => r.key === briefRecordKey(p.teamMemberId, p.day));
    const rec = row ? parseRecord(row.value, p.teamMemberId, p.day) : null;
    if (rec?.sent) out.add(`${p.teamMemberId}|${p.day}`);
  }
  return out;
}

/**
 * THE DASHBOARD'S READ (Kyle's Shoot Prep tab). For each appointment: the state
 * of its photographer's brief for its day, when it was first sent, when it was
 * last acknowledged, and why (a plain sentence; for "sent" and "changed" it is
 * set only when it needs a person: the first shoot is within 2 hours and there
 * is no Got it for the current version). Every id asked for is in the map.
 */
export async function briefStatusForAppointments(appointmentIds: string[]): Promise<Map<string, { state: BriefState; sentAt: string | null; ackAt: string | null; why: string | null }>> {
  const out = new Map<string, { state: BriefState; sentAt: string | null; ackAt: string | null; why: string | null }>();
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  if (!ids.length) return out;
  const now = new Date();
  const [settings, appts] = await Promise.all([
    photographerBriefSettings(),
    prisma.appointment.findMany({ where: { id: { in: ids } }, select: { id: true, startAt: true, status: true, assignedToId: true, project: { select: { photographerId: true, status: true, client: { select: { id: true, name: true } } } } } }),
  ]);
  const offWhy = "The photographer brief is switched off (Settings, Internal alerts).";
  const groups = new Map<string, { who: string; day: string }>();
  for (const a of appts) {
    const who = a.assignedToId ?? a.project.photographerId;
    if (a.startAt && who) groups.set(`${who}|${etDayKey(a.startAt)}`, { who, day: etDayKey(a.startAt) });
  }
  const days = [...new Set([...groups.values()].map((g) => g.day))];
  const whos = [...new Set([...groups.values()].map((g) => g.who))];
  const [build, rows] = settings.enabled && days.length
    ? await Promise.all([
        buildBriefDays(days, { now, teamMemberIds: whos }),
        prisma.appSetting.findMany({ where: { key: { in: [...groups.values()].map((g) => briefRecordKey(g.who, g.day)) } }, select: { key: true, value: true } }),
      ])
    : [null, []];
  for (const id of ids) {
    const a = appts.find((x) => x.id === id);
    if (!settings.enabled) {
      out.set(id, { state: "off", sentAt: null, ackAt: null, why: offWhy });
      continue;
    }
    if (!a) { out.set(id, { state: "pending", sentAt: null, ackAt: null, why: "That appointment is not in the hub." }); continue; }
    if (!liveAppt(a)) { out.set(id, { state: "pending", sentAt: null, ackAt: null, why: "Cancelled or postponed, so it is in no brief." }); continue; }
    if (a.project.status === "CANCELLED" || a.project.status === "ON_HOLD") { out.set(id, { state: "pending", sentAt: null, ackAt: null, why: a.project.status === "ON_HOLD" ? "The job is on hold, so it is in no brief." : "The job is cancelled, so it is in no brief." }); continue; }
    const day = etDayKey(a.startAt!);
    const who = a.assignedToId ?? a.project.photographerId;
    const due = briefDueAt(day, settings);
    if (!who) {
      out.set(id, { state: now >= due ? "failed" : "pending", sentAt: null, ackAt: null, why: "No photographer on this shoot, so there is nobody to brief." });
      continue;
    }
    const b = build?.briefs.find((x) => x.teamMemberId === who && x.day === day) ?? null;
    const row = rows.find((r) => r.key === briefRecordKey(who, day));
    const record = row ? parseRecord(row.value, who, day) : null;
    const current = b?.material ?? materialOf([]);
    const blocker = !b ? null : !b.active ? `${b.name} is not an active team member` : !staffTextNumber(b.phone) ? `no phone number on file for ${firstName(b.name)}` : b.offWhy ?? null;
    const s = briefStateOf({ enabled: true, record, current, firstShootAt: b?.firstShootAt ?? a.startAt, dueAt: due, now, blocker, name: b?.name ?? "the photographer" });
    // A brief that went before the time off was entered (Monday Oct 26's went on
    // the Friday) still names someone who is off: the desk shows the booking to
    // fix, unless they tapped Got it (they are shooting after all).
    if (b?.offWhy && record?.sent && s.state !== "acknowledged" && s.state !== "off") {
      out.set(id, { ...s, state: "failed", why: noDashes(`${firstName(b.name)} is on PTO ${dayWords(day)}, but this shoot still names them. Reassign it in Aryeo, or confirm ${firstName(b.name)} is shooting.`) });
      continue;
    }
    out.set(id, s);
  }
  return out;
}

/** What the dry run and the Settings card print: the day each brief covers and when it goes. */
export function briefScheduleWords(s: BriefSettings): string {
  return `${sendTimeWords(s.sendMinute)} ET the business day before (Friday covers Saturday, Sunday and Monday)`;
}

export { daysInScope, briefDueAt, composeBriefText, composeUpdateText, dayWords };
