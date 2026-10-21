import "server-only";
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { etDate, etDayBoundsUtc, etDayKey, etMinutesOfDay, etMonthDay, etTime } from "@/lib/datetime";
import { noDashes } from "@/lib/text";
import { HUB_SMS_PREFIX, staffTextNumber } from "@/lib/hubSms";
import { isSyntheticClientRow } from "@/lib/testClients";
import { categoryHandoffAt, liveHandoffCategories } from "@/lib/handoff";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// THE MORNING-AFTER NUDGE FOR MISSING INSTRUCTIONS (Oct 21 2026). Jordan:
// "Joe's shoot from yesterday is waiting on instructions from Harrison before
// editing starts. Can you please make sure that if instructions are not
// submitted by 10am the next morning after the appointment the creative gets
// a message asking for whatever is missing? James is now creative manager so
// he should get pinged too."
//
// WHAT IS MISSING is never decided here. Each half of the upload page the job
// still owes (lib/handoff liveHandoffCategories, not yet handed off) answers
// with its existing definition:
//   · VIDEO: the handoff engine's own gaps (tasks.handoffReadinessOf, the
//     words the "Raws in … waiting on …" line and the edit card print): the
//     flow and vision, the premium script, the agent's intro script, the
//     video count, the wrap-up itself. A plain social reel owes nothing.
//   · PHOTOS: the delivery checklist's wrap-up test (photoDelivery/clientAsked
//     wrapUpMissing): the cull confirmed and the removal notes answered.
//
// WHEN. Every 5 minutes (cron/gmail), from 10:00 AM ET on any day after the
// shoot's ET day (the job's last live appointment; its shoot date when it has
// none). One ask per job per ET morning, up to MAX_MORNINGS mornings, then the
// existing office alerts carry it. Stops the moment the page (or the half
// that was missing) is submitted. Never for a cancelled or postponed visit, a
// visit still to come, a cancelled, on-hold or delivered job, a test client,
// or a job with no photographer. Shoots before FIRST_SHOOT_DAY are history and
// never asked about (it shipped Oct 21: the last three days were in scope, so
// 859 N Lawrence St, shot Oct 20, was asked on the first run).
//
// WHO. The job's photographer (Project.photographer, the person the handoff
// engine names) gets one text from the company line through the durable
// outbox (kind `instructions_missing`), naming the job, the shoot day, exactly
// what is missing and their upload page. Whoever carries
// TeamMember.creativeManager (James) gets a bell row addressed to them, which
// the team-notification bridge sends on THEIR "Shoot changes" switch (a text
// by default for a photographer, Settings, Team notifications). When the
// photographer IS the creative manager, only the one text goes. A photographer
// inside their own quiet time (notifySchedule) is asked when it ends, and
// James with them; anyone else on the team can be pinged at any hour.
//
// ONCE PER MORNING. The morning is CLAIMED first (an AppSetting row keyed by
// job and ET day, created atomically; a claim a dead tick left behind is taken
// over after CLAIM_STALE_MS), so overlapping ticks never double-send, and the
// outbox key (job, person, day) and the bell's dedupeKey hold underneath it.
// The job's timeline says what went ("Asked Harrison for the missing
// instructions at 10:00 AM; James copied.").
//
// Behind its own switch (Settings, Internal alerts, "Missing instructions,
// the morning after"), default on. Staff only: no client is ever texted here.
// ---------------------------------------------------------------------------

/** The ET hour the morning's ask may go from. */
export const NUDGE_HOUR = 10;
/** How many mornings a job is asked about before the office alerts carry it. */
export const MAX_MORNINGS = 3;
/** The first ET shoot day in scope: the ship day (Oct 21 2026) less three days. */
export const FIRST_SHOOT_DAY = "2026-10-18";
/** How far back the sweep reads shoots at all (bounds the query, not the rule). */
const LOOKBACK_DAYS = 7;
/** A claim older than this was a tick that died mid-send: the next tick takes it over. */
const CLAIM_STALE_MS = 15 * 60_000;
const CLAIM_PREFIX = "instructions_missing:";
const REQUESTED_BY = "missing-instructions-text";
/** The bell kind (notify.ts BELL_RULES, notifyPrefs.ts KIND_TO_EVENT → shoot_change). */
export const MANAGER_BELL_KIND = "instructions_missing";

/** One text per job, per photographer, per ET morning (the outbox identity). */
export const instructionsNudgeKey = (projectId: string, teamMemberId: string, dayKey: string) =>
  `instructions_missing:${projectId}:${teamMemberId}:${dayKey}`;
const claimKey = (projectId: string, dayKey: string) => `${CLAIM_PREFIX}${projectId}:${dayKey}`;

// ---- the words (pure) ---------------------------------------------------------

export type MissingInstructions = {
  /** the handoff engine's photographer-owed gaps for the video half, in its words */
  video: string[];
  /** the photos wrap-up's missing answers (clientAsked.wrapUpMissing), in words */
  photos: string[];
};

/** The photos half's missing answers, from the delivery checklist's own test. */
export function photoWrapUpWords(w: { missing: boolean; removal: boolean; cull: boolean }): string[] {
  if (!w.missing) return [];
  return [!w.cull ? "the cull confirmation" : null, !w.removal ? "the removal notes" : null].filter((x): x is string => !!x);
}

/** One item as a list reads it: an inner comma ("the agent's intro script, as
 *  delivered on camera") would read as two items in a comma list. */
const itemWords = (label: string) => label.replace(/,\s+/g, " ").trim();

/** "a", "a and b", "a, b and c" (the house list style, uploadGaps listWords). */
export function listWords(items: string[]): string {
  const w = items.map(itemWords).filter(Boolean);
  return w.length <= 1 ? w[0] ?? "" : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

const allItems = (m: MissingInstructions) => [...m.video, ...m.photos];
/** "Tue Oct 20" */
const shotDay = (d: Date) => etDate(d).replace(/,/g, "");
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const streetOf = (title: string, addressLine: string | null) =>
  (addressLine?.trim() && !/^\[No address/i.test(addressLine) ? addressLine.trim() : title.split(",")[0].trim()) || "Your shoot";

/** The photographer's text. No dashes; their upload page linked. */
export function composeNudgeText(o: { firstName: string; street: string; shotOn: Date; missing: MissingInstructions; link: string; again?: boolean }): string {
  const waitingFor = o.missing.video.length ? "before editing can start" : "before the photos can go out";
  return noDashes(
    `${HUB_SMS_PREFIX}: Hi ${o.firstName}, ${o.street} (shot ${shotDay(o.shotOn)}) is ${o.again ? "still " : ""}waiting on you ${waitingFor}: ${listWords(allItems(o.missing))}. Finish it here: ${o.link}`,
  );
}

/** The creative manager's heads-up (their bell row's sentence, and their text). */
export function composeManagerLine(o: { photographerFirst: string; street: string; shotOn: Date; missing: MissingInstructions; unreachable?: string | null; again?: boolean }): string {
  const waiting = o.missing.video.length ? "Editing is waiting." : "The photos are waiting.";
  const unreachable = o.unreachable ? ` ${o.photographerFirst} could not be texted (${o.unreachable}).` : "";
  return noDashes(
    `Heads up: ${o.photographerFirst} ${o.again ? "still " : ""}hasn't sent the instructions for ${o.street} (shot ${etMonthDay(o.shotOn)}) yet: ${listWords(allItems(o.missing))}. ${waiting}${unreachable}`,
  );
}

/**
 * When the shoot happened, for this check: the latest live appointment's start
 * (pure). Null when there is nothing to ask about yet, or ever: every visit
 * cancelled or postponed, or a live visit still to come (the wrap-up follows
 * the last one). A job with no appointment rows falls back to its shoot date.
 */
export function shootFinishedAt(
  appointments: { status: string | null; startAt: Date | null }[],
  shootDate: Date | null,
  now: Date,
  live: (a: { status: string | null; startAt: Date | null }) => boolean,
): Date | null {
  if (appointments.length === 0) return shootDate && shootDate.getTime() <= now.getTime() ? shootDate : null;
  const visits = appointments.filter(live);
  if (visits.length === 0) return null;
  if (visits.some((a) => a.startAt!.getTime() > now.getTime())) return null;
  return new Date(Math.max(...visits.map((a) => a.startAt!.getTime())));
}

// ---- what is missing, for one job (reads only) ---------------------------------

const JOB_SELECT = {
  id: true,
  title: true,
  addressLine: true,
  status: true,
  shootDate: true,
  createdAt: true,
  photographerId: true,
  photographer: { select: { id: true, name: true, phone: true, active: true } },
  client: { select: { id: true, name: true } },
  appointments: { select: { status: true, startAt: true } },
  // The handoff engine's inputs (tasks.ensureEditorHandoff's select).
  deliverables: {
    where: OWED_DELIVERABLE_WHERE,
    select: { type: true, label: true, productTitle: true, videoStyle: true, notCompletedReason: true, waivedAt: true, removedFromOrderAt: true },
  },
  orderItems: { where: { isCanceled: false }, select: { title: true } },
  packageName: true,
  debriefSubmittedAt: true,
  photosHandoffAt: true,
  videoHandoffAt: true,
  videoInstructions: true,
  editorBrief: true,
  reelScript: true,
  reelHook: true,
  scriptConfirmedAt: true,
  videosFilmed: true,
  // The photos wrap-up's inputs (clientAsked.wrapUpState's select).
  removalNotes: true,
  cullingConfirmedAt: true,
} satisfies Prisma.ProjectSelect;
type JobRow = Prisma.ProjectGetPayload<{ select: typeof JOB_SELECT }>;

/** What each half the job still owes is missing, in the existing definitions' words. */
async function readMissing(p: JobRow): Promise<MissingInstructions> {
  const out: MissingInstructions = { video: [], photos: [] };
  if (!p.photographer) return out;
  const halves = liveHandoffCategories(p.deliverables);
  if (halves.includes("video") && !categoryHandoffAt(p, "video")) {
    const { handoffReadinessOf } = await import("@/lib/tasks");
    const r = await handoffReadinessOf(p);
    out.video = r.gaps.filter((g) => g.owedBy === "photographer").map((g) => g.label);
  }
  if (halves.includes("photos") && !categoryHandoffAt(p, "photos")) {
    const [{ wrapUpMissing }, { DEBRIEF_PAY_GATE_FROM }] = await Promise.all([import("@/lib/photoDelivery/clientAsked"), import("@/lib/payroll")]);
    out.photos = photoWrapUpWords(
      wrapUpMissing({
        hasPhotographer: true,
        removalNotes: p.removalNotes,
        cullingConfirmedAt: p.cullingConfirmedAt,
        photosOwed: true,
        submitted: !!(p.debriefSubmittedAt || p.photosHandoffAt),
        legacy: (p.shootDate ?? p.createdAt).getTime() < DEBRIEF_PAY_GATE_FROM,
      }),
    );
  }
  return out;
}

/** What this job's upload page is still missing from its photographer (empty when nothing). */
export async function missingInstructionsFor(projectId: string): Promise<MissingInstructions | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: JOB_SELECT });
  return p ? readMissing(p) : null;
}

// ---- the morning's claim ---------------------------------------------------------

type ClaimRecord = { state: "sending" | "sent"; at: string; id?: string; morning?: number; to?: string[]; missing?: string[] };

const parseClaim = (v: string): ClaimRecord | null => {
  try { return JSON.parse(v) as ClaimRecord; } catch { return null; }
};

/** Take this job's ask for this morning in ONE atomic step (photoDelivery/digest's claim). */
async function claimMorning(key: string, existing: { value: string } | null, now: Date): Promise<{ claim: string } | { reason: string }> {
  const claim = JSON.stringify({ state: "sending", at: now.toISOString(), id: crypto.randomUUID() } satisfies ClaimRecord);
  if (!existing) {
    const made = await prisma.appSetting.create({ data: { key, value: claim, updatedBy: "system" } }).then(() => true, () => false);
    return made ? { claim } : { reason: "another run has it" };
  }
  const rec = parseClaim(existing.value);
  if (rec?.state === "sent") return { reason: "already asked this morning" };
  if (rec?.state === "sending" && now.getTime() - Date.parse(rec.at) < CLAIM_STALE_MS) return { reason: "another run is sending it" };
  const r = await prisma.appSetting.updateMany({ where: { key, value: existing.value }, data: { value: claim, updatedBy: "system" } });
  return r.count === 1 ? { claim } : { reason: "another run has it" };
}

// ---- the sweep ---------------------------------------------------------------------

export type MissingInstructionsRun =
  | { skipped: string }
  | { considered: number; sent: string[]; copied: string[]; notSent: string[]; waiting: string[]; done: string[] };

type TextOutcome = { kind: "sent" | "unconfirmed" | "not_sent"; why?: string };

/** Every 5 minutes (cron/gmail). Idle before 10 AM ET. */
export async function sweepMissingInstructions(now: Date = new Date()): Promise<MissingInstructionsRun> {
  const { internalAlertRules } = await import("@/lib/settings");
  if (!(await internalAlertRules()).missingInstructions.enabled) {
    return { skipped: "switched off (Settings, Internal alerts, Missing instructions, the morning after)" };
  }
  if (etMinutesOfDay(now) < NUDGE_HOUR * 60) return { skipped: "before 10 AM ET" };
  const today = etDayKey(now);
  const from = new Date(Math.max(etDayBoundsUtc(FIRST_SHOOT_DAY).start.getTime(), now.getTime() - LOOKBACK_DAYS * 86_400_000));
  const rows = await prisma.project.findMany({
    where: {
      status: { notIn: ["CANCELLED", "ON_HOLD", "DELIVERED"] },
      aryeoMissingAt: null,
      photographerId: { not: null },
      // The whole wrap-up is in: nothing is owed by anyone.
      debriefSubmittedAt: null,
      OR: [
        { appointments: { some: { startAt: { gte: from, lte: now } } } },
        { appointments: { none: {} }, shootDate: { gte: from, lte: now } },
      ],
    },
    orderBy: { shootDate: "asc" },
    select: JOB_SELECT,
  });
  const run = { considered: 0, sent: [] as string[], copied: [] as string[], notSent: [] as string[], waiting: [] as string[], done: [] as string[] };
  if (rows.length === 0) return run;

  const { liveAppointment } = await import("@/lib/shootDayText");
  const { holdFor } = await import("@/lib/notifySchedule");
  let managers: { id: string; name: string }[] | null = null;
  let ours: Set<string> | null = null;

  for (const p of rows) {
    if (!p.photographer || isSyntheticClientRow(p.client)) continue;
    const shotAt = shootFinishedAt(p.appointments, p.shootDate, now, liveAppointment);
    if (!shotAt) continue;
    const shootDay = etDayKey(shotAt);
    // Not before the morning after, and never history from before it shipped.
    if (shootDay < FIRST_SHOOT_DAY || shootDay >= today) continue;
    // Asked already this morning: nothing to work out (most ticks after 10 AM).
    const prior = await prisma.appSetting.findMany({ where: { key: { startsWith: `${CLAIM_PREFIX}${p.id}:` } }, select: { key: true, value: true } });
    const todayRow = prior.find((r) => r.key === claimKey(p.id, today)) ?? null;
    if (todayRow && parseClaim(todayRow.value)?.state === "sent") continue;
    const missing = await readMissing(p);
    if (!allItems(missing).length) continue;
    run.considered++;
    const street = streetOf(p.title, p.addressLine);
    const ph = p.photographer;
    const label = `${street} to ${ph.name}`;

    // Every earlier morning that was claimed counts, finished or not: a tick
    // that died mid-send may still have texted, and a fourth ask is the one
    // outcome this must never have.
    const mornings = prior.filter((r) => r.key !== claimKey(p.id, today)).length;
    if (mornings >= MAX_MORNINGS) {
      run.done.push(`${street}: asked ${MAX_MORNINGS} mornings, the office alerts carry it`);
      continue;
    }
    // Their own quiet time: the ask (and James's copy) waits for its end.
    const quiet = await holdFor(ph.id, now);
    if (quiet) {
      run.waiting.push(`${label}: their quiet time until ${quiet.toISOString()}`);
      continue;
    }
    const key = claimKey(p.id, today);
    const taken = await claimMorning(key, todayRow, now);
    if ("reason" in taken) continue;

    // 1. The photographer's text.
    const { appBase } = await import("@/lib/appUrl");
    const text = composeNudgeText({ firstName: firstName(ph.name), street, shotOn: shotAt, missing, link: `${appBase()}/upload/${p.id}`, again: mornings > 0 });
    let out: TextOutcome;
    const num = staffTextNumber(ph.phone);
    if (!ph.active) out = { kind: "not_sent", why: "not an active team member" };
    else if (!num) out = { kind: "not_sent", why: "no phone on file" };
    else {
      if (!ours) {
        const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
        ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
      }
      if (ours.has(num.key)) out = { kind: "not_sent", why: "their number is our own office line" };
      else {
        const { sendThroughOutbox } = await import("@/lib/outbox");
        let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
        try {
          r = await sendThroughOutbox({ channel: "sms", toRef: num.key, body: text, dedupeKey: instructionsNudgeKey(p.id, ph.id, today), projectId: p.id, requestedBy: REQUESTED_BY });
        } catch (e) {
          // A database failure while queueing: nothing was handed over, or the
          // watchdog owns the row. The morning is released; the next tick asks again.
          await prisma.appSetting.deleteMany({ where: { key, value: taken.claim } }).catch(() => {});
          run.notSent.push(`${label}: could not queue (${e instanceof Error ? e.message : "error"})`);
          continue;
        }
        if (r.outcome === "accepted") {
          out = { kind: "sent" };
          try {
            const { logDelivery } = await import("@/lib/notify");
            await logDelivery({ teamMemberId: ph.id, kind: "instructions_missing_text", channel: "sms", status: "sent", detail: r.providerId ? `op-${r.providerId}` : null });
          } catch { /* the outbox row is the record */ }
        } else if (r.outcome === "duplicate") {
          // An earlier tick (or the outbox watchdog) owns this exact text.
          out = r.state === "unknown" ? { kind: "unconfirmed", why: "OpenPhone did not confirm it" } : r.state === "failed" ? { kind: "not_sent", why: "OpenPhone refused it" } : { kind: "sent" };
        } else if (r.outcome === "busy") out = { kind: "sent" }; // another worker is mid-send on this very text
        else if (r.outcome === "unknown") out = { kind: "unconfirmed", why: "OpenPhone did not confirm it" };
        // Refused: nothing was sent. James still hears today; the next morning asks again.
        else out = { kind: "not_sent", why: `OpenPhone refused it: ${r.error}`.slice(0, 160) };
      }
    }
    if (out.kind === "sent") run.sent.push(label);
    else run.notSent.push(`${label}: ${out.why}`);

    // 2. The creative manager, unless that is who shot it.
    if (!managers) {
      managers = await prisma.teamMember.findMany({ where: { creativeManager: true, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => []);
    }
    const copy = managers.filter((m) => m.id !== ph.id);
    const told: string[] = [];
    if (copy.length) {
      const href = `/projects/${p.id}`;
      const line = composeManagerLine({ photographerFirst: firstName(ph.name), street, shotOn: shotAt, missing, unreachable: out.kind === "not_sent" ? out.why : null, again: mornings > 0 });
      try {
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: MANAGER_BELL_KIND,
          title: `Instructions missing: ${street}`,
          href,
          // Roles kept broad so the row stays visible whatever their login
          // role is (tasks.ts creativeAlertTargets, same reason).
          targets: copy.map((m) => ({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${m.id}`, href, slackDm: `${line}\n${appBase()}${href}` })),
          dedupeKey: `instructions-missing-${p.id}-${today}`,
        });
        told.push(...copy.map((m) => firstName(m.name)));
        run.copied.push(...copy.map((m) => `${street} to ${m.name}`));
      } catch (e) {
        run.notSent.push(`${street} to the creative manager: ${e instanceof Error ? e.message : "bell failed"}`);
      }
    }

    // 3. The morning is spent, and the job's timeline says what happened.
    const at = etTime(now);
    const who = firstName(ph.name);
    const copied = told.length ? `; ${told.join(" and ")} copied` : "";
    const head =
      out.kind === "sent" ? `Asked ${who} for the missing instructions at ${at}${copied}.`
      : out.kind === "unconfirmed" ? `Texted ${who} for the missing instructions at ${at}, but OpenPhone did not confirm it${copied}. Check Connections before sending again.`
      : `Could not text ${who} for the missing instructions (${out.why})${told.length ? `; ${told.join(" and ")} told at ${at}` : ""}.`;
    const last = mornings + 1 >= MAX_MORNINGS ? ` Last of ${MAX_MORNINGS} morning asks; the office alerts carry it from here.` : "";
    await prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body: `${head} Missing: ${listWords(allItems(missing))}.${last}`.slice(0, 1000) } }).catch(() => {});
    const done: ClaimRecord = { state: "sent", at: now.toISOString(), morning: mornings + 1, to: [ph.name, ...copy.map((m) => m.name)], missing: allItems(missing) };
    await prisma.appSetting.updateMany({ where: { key, value: taken.claim }, data: { value: JSON.stringify(done), updatedBy: "system" } }).catch(() => {});
  }
  return run;
}

/** A missing-instructions text the outbox watchdog sent after its sweep stopped
 *  (cron/gmail drainPending): the delivery log. The timeline line is written by
 *  the sweep when it takes the morning's stale claim over and meets this row. */
export async function recordDrainedInstructionsText(row: { dedupeKey: string | null }, providerId: string | null): Promise<string | null> {
  const [kind, projectId, teamMemberId] = (row.dedupeKey ?? "").split(":");
  if (kind !== "instructions_missing" || !projectId || !teamMemberId) return null;
  try {
    const { logDelivery } = await import("@/lib/notify");
    await logDelivery({ teamMemberId, kind: "instructions_missing_text", channel: "sms", status: "sent", detail: providerId ? `op-${providerId} (recovered)` : "(recovered)" });
  } catch { /* the outbox row is the record */ }
  return `recovered and sent the missing-instructions text for ${projectId} to ${teamMemberId}`;
}
