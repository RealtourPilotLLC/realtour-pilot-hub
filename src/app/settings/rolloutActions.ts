"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import type { RolloutMode, ProgramPilotGroupKey, ReachTier, ReachRefusalCode } from "@/lib/programRolloutCore";
import type { PilotState } from "@/lib/hubWritePermit";

// ---------------------------------------------------------------------------
// WHO THE PROGRAM MAY REACH — the owner's editor (R03, Sep 28 2026).
//
// One list decides who every client-facing program feature reaches AND whose
// Aryeo/Calendly bookings the hub writes (Jordan's Sep 28 rule: "automatic
// booking must be enabled for the approved pilot before we call the
// self-service scheduling workflow complete" — one pilot, never a second list
// that drifts). The stored value is one AppSetting row, written ONLY through
// programRollout.updateProgramRollout: an advisory lock, the value and an
// AuditLog row in one transaction, refusing to overwrite a value it cannot
// read. This file adds the owner's checks in front of it, modelled on the hub
// pilot editor (pilotActions.ts):
//   · OWNER only for every change (business default 4); admins may read;
//   · a pilot client is picked AND their name typed exactly;
//   · a TEST-named row is refused — a real row renamed TEST with "fix the
//     name" (programRolloutCore.pilotCandidateProblem, the writer's own
//     backstop says the same) — and so is a client with no ACTIVE program;
//   · at most PROGRAM_PILOT_MAX real clients (3 until Oct 5 2026; raised to 30
//     so Settings → Client onboarding can name every program client);
//   · the end date is optional (30 days is suggested, never required) and is
//     ONE date for the whole pilot, kept unless changed on purpose, exactly
//     the hub pilot's keep-or-clear rule; a date in the past is refused;
//   · "Every client with a program" needs the owner to type EVERY CLIENT;
//   · every change re-stamps the approval (who, when) — a changed pilot is a
//     new approval — and the writer re-stamps joinedAt so a newly admitted
//     client never receives a backlog (settleRolloutChange).
// Nothing here turns a switch on. The save message names the client-reaching
// switches that ARE on, so the owner reads, before he closes the card, what
// will start reaching the client within the hour.
//
// TAKING A CLIENT OUT (business default 3): one write. Their future sends
// stop — queued outbox work is refused at dispatch (programRolloutGate) —
// their people lose program sign-in and fall back to the older shared portal
// link, their seats are kept, and the hub stops writing their bookings.
//
// THE MESSAGES SAY WHAT ACTUALLY CHANGES (review fixes, Sep 28 2026):
//   · taking a client out, or ending the pilot, is worded by the MODE: in
//     "every client" nothing stops but the Aryeo/Calendly bookings; in TEST
//     only, or a pilot that had ended, nothing changes at all — the first cut
//     told Jordan "nothing further goes out to them" in both;
//   · a save names the switches that now reach the client AND those a
//     feature's own lock still holds to TEST clients — "every client" too (it
//     listed locked switches as reaching everyone) — and says WHEN, by how
//     each switch runs: the next hourly run, their next visit, when you invite
//     or press Release, when they ask for a sign-in link;
//   · the per-client list is per group (clientReachSummary), not one op.
//
// ONCE CLIENTS HAVE THEIR OWN CHOICES, THIS CARD STOPS EDITING THEM (review
// fix, Oct 5 2026). "Add a pilot client" rebuilt the pilot with one shared
// list and no per-client choices, so every client fell back to the form's
// ticked groups: a client given only the portal got emails and bookings too,
// and a client set to nothing came back on. Now, as soon as any named client
// has their own choices (Settings → Client onboarding), Add and the group
// ticks here are refused and the card sends Jordan to Client onboarding,
// which changes one client and never anybody else. What stays here is what
// belongs to the whole list: the mode, the end date and note, taking a client
// out (a stop: everyone else's choices are kept exactly), and ending it. A
// pilot with no per-client choices (made here before Oct 5) works as before.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
const squash = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// A "use server" file may export only async functions, so the words the
// owner types live beside the other switch words (programAutomationCopy).
const NOT_IN_PILOT = "__not_in_pilot__";
const UNCHANGED = "__unchanged__";
/** Refused here once anybody has their own choices: those are made one client at a time. */
const PER_CLIENT_HOME = "Each client on the list now has their own choices, so clients are added, and what each one gets is changed, one client at a time in Settings → Client onboarding (it never changes anybody else). Nothing was changed.";

export type ProgramRolloutPanelData = {
  mode: RolloutMode;
  modeSinceISO: string | null;
  problem: string | null;
  updatedBy: string | null;
  updatedAtISO: string | null;
  cap: number;
  pilot: null | {
    state: PilotState;
    /** `own`: the client's own choices from Client onboarding (Oct 5 2026), in
     *  plain words; null = they get the pilot's shared list below. */
    clients: { id: string; name: string; joinedAtISO: string | null; own?: string[] | null }[];
    groups: ProgramPilotGroupKey[];
    approvedBy: string | null;
    approvedAtISO: string | null;
    expiresAtISO: string | null;
    note: string | null;
  };
  groups: { key: ProgramPilotGroupKey; label: string }[];
  /** Real clients with an ACTIVE program, not already in the pilot. */
  candidates: { id: string; name: string }[];
  /**
   * Every client with an ACTIVE or PAUSED program: its tier and the groups the
   * rollout reaches it for (programRolloutCore.clientReachSummary), or why it
   * reaches it for none. No feature lock narrows it (the switch rows say those).
   */
  audience: { clientId: string; name: string; tier: ReachTier | null; code: ReachRefusalCode | null; reason: string; groups: string[] }[];
  /** The client-reaching switches that are on right now (for the "what starts" sentence). */
  switchesOn: string[];
};

/** Read-only. Admins may look; only the owner edits. */
export async function loadProgramRolloutPanel(): Promise<ProgramRolloutPanelData | { error: string }> {
  try { await requireAdmin(); } catch (e) { return { error: fail(e).message }; }
  try {
    const { loadProgramRollout, pilotClientCandidates, programAudience } = await import("@/lib/programRollout");
    const { PROGRAM_PILOT_GROUPS, PROGRAM_PILOT_GROUP_SHORT, PROGRAM_PILOT_MAX, clientReachSummary, pilotStateOf } = await import("@/lib/programRolloutCore");
    const { prisma } = await import("@/lib/prisma");
    const now = new Date();
    const [loaded, candidates, audience, on] = await Promise.all([
      loadProgramRollout(),
      pilotClientCandidates(),
      programAudience("portal_sign_in", { now }),
      switchesOnNow(),
    ]);
    const { rollout, problem } = loaded;
    const p = rollout.pilot;
    const ids = p?.clientIds ?? [];
    const names = new Map(ids.length ? (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]) : []);
    return {
      mode: rollout.mode,
      modeSinceISO: rollout.modeSince,
      problem,
      updatedBy: loaded.updatedBy,
      updatedAtISO: loaded.updatedAt?.toISOString() ?? null,
      cap: PROGRAM_PILOT_MAX,
      pilot: p && p.clientIds.length
        ? {
            state: pilotStateOf(rollout, now),
            clients: p.clientIds.map((id) => ({
              id, name: names.get(id) ?? `${id} (not found)`, joinedAtISO: p.joinedAt[id] ?? null,
              own: p.clientOps && Object.prototype.hasOwnProperty.call(p.clientOps, id)
                ? PROGRAM_PILOT_GROUPS.filter((g) => g.ops.some((op) => p.clientOps![id].includes(op))).map((g) => PROGRAM_PILOT_GROUP_SHORT[g.key])
                : null,
            })),
            groups: PROGRAM_PILOT_GROUPS.filter((g) => g.ops.every((op) => p.operations.includes(op))).map((g) => g.key),
            approvedBy: p.approvedBy, approvedAtISO: p.approvedAt, expiresAtISO: p.expiresAt, note: p.note,
          }
        : null,
      groups: PROGRAM_PILOT_GROUPS.map((g) => ({ key: g.key, label: g.label })),
      candidates: candidates.filter((c) => !ids.includes(c.id)),
      audience: audience.clients.map((c) => {
        if (problem) return { clientId: c.clientId, name: c.name, tier: c.tier, code: c.decision.ok ? null : c.decision.code, reason: c.decision.reason, groups: [] };
        const sum = clientReachSummary(rollout, { id: c.clientId, name: c.name }, now);
        return { clientId: c.clientId, name: c.name, tier: sum.tier, code: sum.code, reason: sum.reason, groups: sum.groups.map((k) => PROGRAM_PILOT_GROUP_SHORT[k]) };
      }),
      switchesOn: on.map((x) => x.title),
    };
  } catch (e) {
    return { error: `Who the program may reach could not be read just now (${fail(e).message}). Nothing has changed.` };
  }
}

/** The client-reaching switches that are ON now, with the ops they need in a pilot. */
async function switchesOnNow(): Promise<{ key: string; title: string; cadence: string }[]> {
  const { prisma } = await import("@/lib/prisma");
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const keys = Object.entries(AUTOMATION_EFFECTS).filter(([, e]) => e.reaches === "clients" && (e.launchGate === "programScope" || e.launchGate === "hubWriteScope")).map(([k]) => k);
  const rows = await prisma.programAutomation.findMany({ where: { key: { in: keys }, enabled: true }, select: { key: true } });
  return rows.map((r) => {
    const e = AUTOMATION_EFFECTS[r.key as keyof typeof AUTOMATION_EFFECTS];
    return { key: r.key, title: e.title, cadence: e.cadence };
  });
}

const HUB_WRITE_KEYS = new Set(["session_booking", "address_sync", "call_booking"]);

/**
 * WHEN a switch first touches a newly reached client — by how it runs, not
 * "the next hourly run" for all of them (review fix, Sep 28 2026). Held portal
 * access is never released on its own: only the owner's Release does it.
 */
function whenItStarts(s: { key: string; cadence: string }): string {
  switch (s.key) {
    case "portal_invites": return "when you invite someone, or press Release for held access";
    case "portal_login_email": return "when they ask for a sign-in link";
    case "caption_assistant": return "when they press Draft a caption";
    case "revision_policy": return "for reviews opened from now";
    case "review_auto_approve": return "for reviews opened from now, when a deadline passes";
    case "session_booking": case "call_booking": return "when they book";
    case "address_sync": return "when they give a filming address";
    default: return s.cadence === "hourly" ? "from the next hourly run" : s.cadence === "daily" ? "from the next daily run" : "the next time it happens";
  }
}

/**
 * The sentence every save ends with: what is ON and will now reach `who`,
 * each with WHEN (whenItStarts), and which of those a feature's own lock
 * still holds to TEST clients. `include(key, op)` says which switches this
 * change concerns (the pilot's ticked groups; for "every client", every
 * program switch but the booking writes, which stay pilot-only).
 */
async function whatStartsFor(who: string, include: (key: string, op: string) => boolean): Promise<string> {
  const { isProgramReachOp } = await import("@/lib/programRolloutCore");
  const { featureTestOnlyFor } = await import("@/lib/programRollout");
  const on = await switchesOnNow();
  const reaching: string[] = [];
  const locked: string[] = [];
  for (const s of on) {
    const op = HUB_WRITE_KEYS.has(s.key) ? "hub_writes" : s.key;
    if (!isProgramReachOp(op) || !include(s.key, op)) continue;
    if (await featureTestOnlyFor(op)) locked.push(s.title);
    else reaching.push(`${s.title} (${whenItStarts(s)})`);
  }
  const parts = [
    reaching.length
      ? `Switched on now, and reaching ${who}: ${reaching.join("; ")}.`
      : `No switch that reaches ${who} is on yet${locked.length ? " without its own lock" : ""}, so nothing changes for them until one is.`,
  ];
  if (locked.length) parts.push(`Still TEST clients only because the feature's own testClientsOnly lock is on: ${locked.join(", ")}.`);
  return ` ${parts.join(" ")}`;
}

/** whatStartsFor the named pilot clients and the ops the pilot now covers. */
async function whatStarts(names: string[], opsNow: string[]): Promise<string> {
  if (!names.length) return "";
  return whatStartsFor(names.join(", "), (_key, op) => opsNow.includes(op));
}

/**
 * The same sentence, CLIENT BY CLIENT (Oct 5 2026): with per-client choices a
 * shared list says nothing true about anybody. For each switch that is on, the
 * named clients whose own list (or the shared one) carries it; a client set to
 * nothing is never named as reached. `ids` narrows it to some clients.
 */
async function whatStartsPerClient(pilot: import("@/lib/programRolloutCore").ProgramPilot, ids?: string[]): Promise<string> {
  const { isProgramReachOp, pilotOpsFor } = await import("@/lib/programRolloutCore");
  const { featureTestOnlyFor } = await import("@/lib/programRollout");
  const { prisma } = await import("@/lib/prisma");
  const who = (ids ?? pilot.clientIds).filter((id) => pilot.clientIds.includes(id) && pilotOpsFor(pilot, id).length > 0);
  if (!who.length) return " Nobody named has anything turned on, so nothing changes for anybody.";
  const names = new Map((await prisma.client.findMany({ where: { id: { in: who } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const reaching: string[] = [];
  const locked: string[] = [];
  for (const s of await switchesOnNow()) {
    const op = HUB_WRITE_KEYS.has(s.key) ? "hub_writes" : s.key;
    if (!isProgramReachOp(op)) continue;
    const reached = who.filter((id) => pilotOpsFor(pilot, id).includes(op));
    if (!reached.length) continue;
    if (await featureTestOnlyFor(op)) locked.push(s.title);
    else reaching.push(`${s.title} → ${reached.map(nameOf).join(", ")} (${whenItStarts(s)})`);
  }
  const parts = [
    reaching.length
      ? `Switched on now, and reaching: ${reaching.join("; ")}.`
      : `No switch that reaches ${who.map(nameOf).join(", ")} is on yet${locked.length ? " without its own lock" : ""}, so nothing changes for them until one is.`,
  ];
  if (locked.length) parts.push(`Still TEST clients only because the feature's own testClientsOnly lock is on: ${locked.join(", ")}.`);
  return ` ${parts.join(" ")}`;
}

async function ownerEmail(): Promise<string> {
  await requireOwner();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}

/** A pilot's stored end (the NEXT ET midnight after the chosen day) as the day the owner chose. */
function pilotEndDay(iso: string): string {
  return new Date(Date.parse(iso) - 1).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}

/** "YYYY-MM-DD" (ET) → the end of that ET day (the next ET midnight, DST-correct), or an error sentence. */
async function endOfEtDay(day: string): Promise<{ iso: string } | { error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Pick an end date from the calendar (or leave it empty)." };
  const { etAt } = await import("@/lib/datetime");
  const [y, m, d] = day.split("-").map(Number);
  const t = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0).getTime();
  if (!Number.isFinite(t) || t <= Date.now()) return { error: "The end date has to be in the future (or left empty)." };
  return { iso: new Date(t).toISOString() };
}

function done(message: string): Result {
  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true, message };
}

/**
 * Name ONE real client in the pilot, with what the pilot covers (for every
 * client in it; all five groups are ticked by default in the form).
 */
export async function addProgramPilotClientAction(input: {
  clientId: string;
  typedName: string;
  groups: string[];
  /** "YYYY-MM-DD" in ET: the pilot runs to the END of that day. Empty/null = keep the current end date. */
  expiresOnET?: string | null;
  /** true = remove the pilot's end date. */
  clearExpiry?: boolean;
  note?: string | null;
}): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { prisma } = await import("@/lib/prisma");
    const { PROGRAM_PILOT_GROUPS, PROGRAM_PILOT_MAX, opsForGroups, pilotCandidateProblem } = await import("@/lib/programRolloutCore");
    const { updateProgramRollout } = await import("@/lib/programRollout");
    const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
    if (!client) return { ok: false, message: "That client no longer exists. Nothing was changed." };
    if (squash(input.typedName) !== squash(client.name)) return { ok: false, message: `Type the client's name exactly as it appears ("${client.name}") to approve them for the pilot. Nothing was changed.` };
    const bad = pilotCandidateProblem(client);
    if (bad) return { ok: false, message: `${bad[0].toUpperCase()}${bad.slice(1)}. Nothing was changed.` };
    const active = await prisma.contentEnrollment.count({ where: { clientId: client.id, status: "ACTIVE" } });
    if (!active) return { ok: false, message: `${client.name} has no active program, so there is nothing for the pilot to reach. Nothing was changed.` };
    const keys = PROGRAM_PILOT_GROUPS.map((g) => g.key).filter((k) => input.groups.includes(k));
    if (!keys.length) return { ok: false, message: "Tick at least one thing the pilot covers. Nothing was changed." };
    let newEnd: { iso: string } | null = null;
    if (input.expiresOnET) {
      const r = await endOfEtDay(input.expiresOnET);
      if ("error" in r) return { ok: false, message: `${r.error} Nothing was changed.` };
      newEnd = r;
    }
    let endLine = "";
    const r = await updateProgramRollout((cur, now) => {
      // Read under the writer's lock, so a client given their own choices a
      // moment ago is never overwritten by this form (Oct 5 2026 review fix).
      if (cur.pilot?.clientOps) return { error: PER_CLIENT_HOME };
      const was = cur.pilot?.clientIds.length ? cur.pilot.expiresAt : null;
      if (cur.pilot?.clientIds.includes(client.id)) return { error: `${client.name} is already in the pilot. To change what it covers or when it ends, use "Change the pilot". Nothing was changed.` };
      const ids = [...(cur.pilot?.clientIds ?? []), client.id];
      if (ids.length > PROGRAM_PILOT_MAX) return { error: `The pilot already has ${ids.length - 1} clients, the most it may have is ${PROGRAM_PILOT_MAX}. Take one out first. Nothing was changed.` };
      let expiresAt = was;
      if (newEnd) expiresAt = newEnd.iso;
      else if (input.clearExpiry) expiresAt = null;
      else if (was && Date.parse(was) <= now.getTime()) return { error: `This pilot ended on ${pilotEndDay(was)}. Pick a new end date, or remove the end date, to add a client. Nothing was changed.` };
      endLine = (was ?? null) === (expiresAt ?? null)
        ? expiresAt ? ` The pilot ends ${pilotEndDay(expiresAt)}.` : " The pilot has no end date."
        : cur.pilot?.clientIds.length
          ? ` The pilot's end date changed from ${was ? pilotEndDay(was) : "none"} to ${expiresAt ? pilotEndDay(expiresAt) : "none"}, for every client in it.`
          : expiresAt ? ` The pilot ends ${pilotEndDay(expiresAt)}.` : " The pilot has no end date.";
      return {
        ...cur,
        pilot: {
          clientIds: ids,
          operations: opsForGroups(keys),
          approvedBy: by,
          approvedAt: now.toISOString(),
          expiresAt,
          note: input.note?.trim().slice(0, 500) || cur.pilot?.note || null,
          joinedAt: { ...(cur.pilot?.joinedAt ?? {}) },
        },
      };
    }, by, "program_pilot_add");
    if (!r.ok) return { ok: false, message: r.message };
    const covers = PROGRAM_PILOT_GROUPS.filter((g) => keys.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ");
    const modeLine = r.to.mode === "PILOT"
      ? ""
      : r.to.mode === "TEST_ONLY"
        ? ` The rollout is still set to "Only my TEST clients", so ${client.name} is not reached until you choose "My TEST clients and the clients I name below".`
        : ` The rollout is set to every client, so everyone is reached already; the pilot list still decides whose bookings the hub writes.`;
    return done(`${client.name} is in the program pilot for: ${covers}.${endLine}${modeLine}${r.to.mode === "PILOT" ? await whatStarts([client.name], r.to.pilot?.operations ?? []) : ""}`);
  } catch (e) { return fail(e); }
}

/**
 * Change what the whole pilot covers, its end date or its note (a new approval).
 * Once any client has their own choices (Oct 5 2026), `groups` is left out —
 * the card offers only the end date and note — and a groups change is refused:
 * what each client gets is changed on Settings → Client onboarding.
 */
export async function editProgramPilotAction(input: { groups?: string[]; expiresOnET?: string | null; clearExpiry?: boolean; note?: string | null }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { PROGRAM_PILOT_GROUPS, opsForGroups } = await import("@/lib/programRolloutCore");
    const { updateProgramRollout } = await import("@/lib/programRollout");
    const { prisma } = await import("@/lib/prisma");
    const keys = input.groups ? PROGRAM_PILOT_GROUPS.map((g) => g.key).filter((k) => input.groups!.includes(k)) : null;
    let newEnd: { iso: string } | null = null;
    if (input.expiresOnET) {
      const r = await endOfEtDay(input.expiresOnET);
      if ("error" in r) return { ok: false, message: `${r.error} Nothing was changed.` };
      newEnd = r;
    }
    const r = await updateProgramRollout((cur, now) => {
      if (!cur.pilot?.clientIds.length) return { error: "There is no pilot to change. Add a client first." };
      let operations = cur.pilot.operations;
      if (cur.pilot.clientOps) {
        // Per-client choices: the shared ticks are not this card's to change.
        const carried = PROGRAM_PILOT_GROUPS.filter((g) => g.ops.every((op) => cur.pilot!.operations.includes(op))).map((g) => g.key);
        if (keys && opsForGroups(keys).join() !== opsForGroups(carried).join()) return { error: PER_CLIENT_HOME };
      } else {
        if (!keys?.length) return { error: "Tick at least one thing the pilot covers (or end the pilot). Nothing was changed." };
        operations = opsForGroups(keys);
      }
      const expiresAt = newEnd ? newEnd.iso : input.clearExpiry ? null : cur.pilot.expiresAt;
      return { ...cur, pilot: { ...cur.pilot, operations, approvedBy: by, approvedAt: now.toISOString(), expiresAt, note: input.note === undefined ? cur.pilot.note : input.note?.trim().slice(0, 500) || null } };
    }, by, "program_pilot_edit");
    if (!r.ok) return { ok: false, message: r.message };
    const end = r.to.pilot?.expiresAt ? ` It ends ${pilotEndDay(r.to.pilot.expiresAt)}.` : " It has no end date.";
    if (r.to.pilot?.clientOps) {
      return done(`The pilot is saved; each client keeps exactly their own choices.${end}${r.to.mode === "PILOT" ? await whatStartsPerClient(r.to.pilot) : ""}`);
    }
    const ids = r.to.pilot?.clientIds ?? [];
    const names = (await prisma.client.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((c) => c.name);
    const covers = PROGRAM_PILOT_GROUPS.filter((g) => (keys ?? []).includes(g.key)).map((g) => g.label.toLowerCase()).join("; ");
    return done(`The pilot now covers: ${covers}.${end}${r.to.mode === "PILOT" ? await whatStarts(names, r.to.pilot?.operations ?? []) : ""}`);
  } catch (e) { return fail(e); }
}

/** Take ONE client out of the pilot. An emptied pilot is removed. */
export async function removeProgramPilotClientAction(input: { clientId: string }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { updateProgramRollout } = await import("@/lib/programRollout");
    const { clientReachSummary } = await import("@/lib/programRolloutCore");
    const { prisma } = await import("@/lib/prisma");
    const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { name: true } });
    const name = client?.name ?? input.clientId;
    let at = new Date();
    // Not in the pilot → no write at all (the writer audits every save).
    const r = await updateProgramRollout((cur, now) => {
      at = now;
      if (!cur.pilot?.clientIds.includes(input.clientId)) return { error: NOT_IN_PILOT };
      const rest = cur.pilot.clientIds.filter((id) => id !== input.clientId);
      return { ...cur, pilot: rest.length ? { ...cur.pilot, clientIds: rest, approvedBy: by, approvedAt: now.toISOString() } : null };
    }, by, "program_pilot_remove");
    if (!r.ok) return r.message === NOT_IN_PILOT ? { ok: true, message: `${name} was not in the pilot. Nothing was changed.` } : { ok: false, message: r.message };
    // Worded by what actually changes for them (review fix, Sep 28 2026).
    const was = clientReachSummary(r.from, { id: input.clientId, name: client?.name ?? null }, at);
    const booked = was.groups.includes("bookings");
    if (r.to.mode === "ALL") {
      return done(`${name} is out of the pilot, but they still get every program feature that is on, because the rollout is set to every client with a program.${booked ? " Only the hub stops booking for them in Aryeo and Calendly." : " Nothing else changes for them."}`);
    }
    if (was.tier !== "PILOT") {
      return done(`${name} is out of the pilot. Nothing changes for them now: they were not being reached (${was.reason}).`);
    }
    return done(`${name} is out of the pilot. Nothing further goes out to them (anything already queued is stopped at sending), their people go back to the shared portal link and lose program sign-in (their seats are kept), and the hub no longer books for them in Aryeo or Calendly.${r.to.pilot ? "" : " The pilot is now empty, so no real client is reached."}`);
  } catch (e) { return fail(e); }
}

/** End the pilot altogether (the mode is left as it is; with no pilot, PILOT reaches TEST clients only). */
export async function endProgramPilotAction(): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { updateProgramRollout } = await import("@/lib/programRollout");
    const { pilotStateOf } = await import("@/lib/programRolloutCore");
    let at = new Date();
    const r = await updateProgramRollout((cur, now) => { at = now; return cur.pilot ? { ...cur, pilot: null } : { error: UNCHANGED }; }, by, "program_pilot_end");
    if (!r.ok) return r.message === UNCHANGED ? { ok: true, message: "There is no pilot to end. Nothing was changed." } : { ok: false, message: r.message };
    // Worded by the mode (review fix, Sep 28 2026).
    if (r.to.mode === "ALL") return done("The pilot has ended. The rollout is set to every client with a program, so every program feature that is on still reaches every client; only the hub stops booking in Aryeo and Calendly for the former pilot clients.");
    if (r.to.mode === "TEST_ONLY") return done("The pilot has ended. Nothing changes now: the rollout is set to TEST clients only, so no real client was being reached, and the hub books for no real client.");
    if (pilotStateOf(r.from, at) !== "ACTIVE") return done("The pilot has ended. Nothing changes now: it had already ended (or had no recorded approval), so no real client was being reached.");
    return done("The pilot has ended. No real client is reached by the program any more (anything already queued is stopped at sending), and the hub books for no real client.");
  } catch (e) { return fail(e); }
}

/** Choose the mode. "ALL" needs EVERY CLIENT typed. */
export async function setProgramRolloutModeAction(input: { mode: string; typedConfirm?: string | null }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const mode = input.mode;
    if (mode !== "TEST_ONLY" && mode !== "PILOT" && mode !== "ALL") return { ok: false, message: "Pick one of the three choices. Nothing was changed." };
    const { EVERY_CLIENT_CONFIRM } = await import("@/lib/programAutomationCopy");
    if (mode === "ALL" && (input.typedConfirm ?? "").trim() !== EVERY_CLIENT_CONFIRM) {
      return { ok: false, message: `Type ${EVERY_CLIENT_CONFIRM} to let the program reach every client with a program. Nothing was changed.` };
    }
    const { updateProgramRollout } = await import("@/lib/programRollout");
    const { prisma } = await import("@/lib/prisma");
    const r = await updateProgramRollout((cur) => (cur.mode === mode ? { error: UNCHANGED } : { ...cur, mode }), by, "program_rollout_mode");
    if (!r.ok) return r.message === UNCHANGED ? { ok: true, message: "That is already the setting. Nothing was changed." } : { ok: false, message: r.message };
    if (mode === "TEST_ONLY") return done("The program now reaches only your TEST clients. Nothing further goes out to a real client, anything already queued for one is stopped at sending, and the hub books for no real client. The pilot list is kept on file.");
    if (mode === "ALL") return done(`The program may now reach EVERY client with a program, for every switch that is on and not held by its own lock. The hub still books in Aryeo and Calendly only for the pilot clients.${await whatStartsFor("every client with a program", (key) => !HUB_WRITE_KEYS.has(key))}`);
    const ids = r.to.pilot?.clientIds ?? [];
    const { pilotStateOf, pilotOpsFor } = await import("@/lib/programRolloutCore");
    // Only the clients with something turned on are reached (Oct 5 2026: a
    // client set to nothing on Client onboarding is never named as reached).
    const reachedIds = r.to.pilot ? ids.filter((id) => pilotOpsFor(r.to.pilot!, id).length > 0) : [];
    const names = ids.length ? (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) : [];
    const nameOf = (id: string) => names.find((c) => c.id === id)?.name ?? id;
    const state = pilotStateOf(r.to, new Date());
    if (names.length && state !== "ACTIVE") {
      return done(`The program is set to a pilot, but the pilot on file (${ids.map(nameOf).join(", ")}) ${state === "EXPIRED" ? "has ended" : "has no recorded approval"}, so only your TEST clients are reached until you change it below.`);
    }
    if (r.to.pilot?.clientOps) {
      return done(reachedIds.length
        ? `The program now reaches your TEST clients and, for what each has turned on: ${reachedIds.map(nameOf).join(", ")}.${await whatStartsPerClient(r.to.pilot)}`
        : "The program is set to named clients, but nobody named has anything turned on, so only your TEST clients are reached.");
    }
    return done(ids.length
      ? `The program now reaches your TEST clients and the pilot: ${ids.map(nameOf).join(", ")}.${await whatStarts(ids.map(nameOf), r.to.pilot?.operations ?? [])}`
      : "The program is set to a pilot, but no pilot client is named yet, so only your TEST clients are reached.");
  } catch (e) { return fail(e); }
}

/**
 * "What would go out now?" — every lane, read-only, from the functions the
 * sends themselves run (lib/programAudiencePreview). Admins may look.
 */
export async function previewProgramAudienceAction(): Promise<{ ok: boolean; message: string; rows: import("@/lib/programAudiencePreview").AudiencePreviewRow[] }> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), rows: [] }; }
  try {
    const { previewProgramAudience } = await import("@/lib/programAudiencePreview");
    const rows = await previewProgramAudience();
    const send = rows.filter((r) => r.decision === "send").length;
    return { ok: true, message: `${rows.length} row${rows.length === 1 ? "" : "s"}; ${send} would go out now. Nothing was written or sent.`, rows };
  } catch (e) { return { ...fail(e), rows: [] }; }
}
