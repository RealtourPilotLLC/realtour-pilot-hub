import "server-only";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { isSyntheticClientRow, isVerifiedTestDestinationEmail } from "@/lib/testClients";
import type { HubWriteScopeConfig, HubWriteSwitch, PilotState } from "@/lib/hubWritePermit";
import {
  CLOSED_ROLLOUT,
  PROGRAM_ROLLOUT_SETTING_KEY,
  describeProgramScope,
  parseProgramRollout,
  pilotCandidateProblem,
  pilotStateOf,
  rolloutDecision,
  serializeProgramRollout,
  settleRolloutChange,
  withProgramPilot,
  type ProgramReachOp,
  type ProgramRollout,
  type ReachDecision,
  type ReachTier,
  type RolloutMode,
} from "@/lib/programRolloutCore";

// ---------------------------------------------------------------------------
// THE ROLLOUT SCOPE, read and written against the database (R03, Sep 28 2026).
// The rules live in programRolloutCore.ts (pure); this file only fetches what
// they need, FRESH on every call — nothing here caches the scope, so Jordan
// taking a client out of the pilot is one write and the very next decision
// anywhere (creation, dispatch, retry, reconcile, sessions, layout, hub
// writes) refuses them.
//
// FAIL CLOSED, in two different strengths:
//   · a stored value that is present but unreadable → TEST_ONLY plus a
//     problem string (parseProgramRollout). TEST clients are still reached.
//   · a DATABASE error (the row or the client cannot be read at all) →
//     programReach / programReachMany answer scope_unreadable for everyone and
//     never throw. That refusal belongs to program and portal sends only; the
//     existing approved client texts never call in here (business default 6).
// ---------------------------------------------------------------------------

/** The stored scope, read now. Throws on a database error — callers that must not throw use programReach. */
export async function loadProgramRollout(): Promise<{ rollout: ProgramRollout; problem: string | null; updatedAt: Date | null; updatedBy: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY }, select: { value: true, updatedAt: true, updatedBy: true } });
  const { rollout, problem } = parseProgramRollout(row?.value ?? null);
  return { rollout, problem, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
const unreadable = (e: unknown): ReachDecision => ({ ok: false, code: "scope_unreadable", reason: `the rollout scope could not be read (${errText(e)}), so nothing is sent` });
const missing: ReachDecision = { ok: false, code: "client_missing", reason: "the client no longer exists" };

/** A refusal made while the stored value was unreadable says so. */
const withProblem = (d: ReachDecision, problem: string | null): ReachDecision =>
  !d.ok && problem ? { ...d, reason: `${d.reason} — the stored rollout could not be read: ${problem}` } : d;

/**
 * May the program do `op` for this client right now? Re-reads the Client row
 * by id (never trusts a caller's name) and, unless one is passed, the scope.
 * Never throws: any error is scope_unreadable.
 */
export async function programReach(
  op: ProgramReachOp,
  clientId: string,
  opts: { now?: Date; rollout?: ProgramRollout; featureTestOnly?: boolean } = {},
): Promise<ReachDecision> {
  try {
    const loaded = opts.rollout ? { rollout: opts.rollout, problem: null } : await loadProgramRollout();
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
    if (!client) return missing;
    const d = rolloutDecision({ rollout: loaded.rollout, client, op, now: opts.now ?? new Date(), featureTestOnly: opts.featureTestOnly });
    return withProblem(d, loaded.problem);
  } catch (e) {
    return unreadable(e);
  }
}

/** programReach for many clients: ONE scope read and ONE client query. On any error every id → scope_unreadable. */
export async function programReachMany(
  op: ProgramReachOp,
  clientIds: string[],
  opts: { now?: Date; rollout?: ProgramRollout; featureTestOnly?: boolean } = {},
): Promise<Map<string, ReachDecision>> {
  const ids = [...new Set(clientIds)];
  const out = new Map<string, ReachDecision>();
  if (ids.length === 0) return out;
  try {
    const loaded = opts.rollout ? { rollout: opts.rollout, problem: null } : await loadProgramRollout();
    const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const byId = new Map(rows.map((c) => [c.id, c]));
    const now = opts.now ?? new Date();
    for (const id of ids) {
      const client = byId.get(id);
      out.set(id, client ? withProblem(rolloutDecision({ rollout: loaded.rollout, client, op, now, featureTestOnly: opts.featureTestOnly }), loaded.problem) : missing);
    }
  } catch (e) {
    for (const id of ids) out.set(id, unreadable(e));
  }
  return out;
}

// ---- the feature locks, ONE reader ------------------------------------------

/** The stored config of each switch, whether the switch is on or off; "unreadable" when not a JSON object. */
async function storedConfigs(keys: string[]): Promise<Map<string, Record<string, unknown> | null | "unreadable">> {
  const rows = await prisma.programAutomation.findMany({ where: { key: { in: keys } }, select: { key: true, configJson: true } });
  const out = new Map<string, Record<string, unknown> | null | "unreadable">();
  for (const k of keys) out.set(k, null);
  for (const r of rows) {
    if (!r.configJson) continue;
    try {
      const v: unknown = JSON.parse(r.configJson);
      out.set(r.key, v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : "unreadable");
    } catch {
      out.set(r.key, "unreadable");
    }
  }
  return out;
}

/**
 * THE LOCK, READ WITH ITS FAILURE KEPT APART (review fix, Sep 28 2026).
 * featureTestOnlyFor folds a database error into "locked" — right for
 * readiness and the previews (a lock that cannot be read is on), wrong for a
 * SEND: the dispatch gate passed it on as featureTestOnly, rolloutDecision
 * refused the pilot client with feature_test_only, the gate mapped that to
 * launch_not_authorised (a DECISION), and recordSendResult wrote the reminder
 * SUPPRESSED for good — one blip, a permanent suppression, and a reason ("the
 * lock is on") that was false. This answers true / false / "error":
 *   · an UNREADABLE stored config is a stored-value problem → true (locked);
 *   · a failed READ is "error" — the caller that sends maps it to gate_error
 *     ("could not decide, nothing sent, retry later"), and the reconcile pass
 *     cancels nothing on it.
 */
export async function readFeatureTestOnly(op: ProgramReachOp): Promise<boolean | "error"> {
  try {
    return await lockFromStored(op);
  } catch {
    return "error";
  }
}

/**
 * programReach with the op's own lock read in the same breath. A failed lock
 * read is scope_unreadable (the gate's gate_error), never feature_test_only.
 * Never throws.
 */
export async function programReachWithLock(op: ProgramReachOp, clientId: string, opts: { now?: Date; rollout?: ProgramRollout } = {}): Promise<ReachDecision> {
  const lock = await readFeatureTestOnly(op);
  if (lock === "error") return { ok: false, code: "scope_unreadable", reason: "this feature's own testClientsOnly lock could not be read just now, so nothing is sent" };
  return programReach(op, clientId, { ...opts, featureTestOnly: lock });
}

/**
 * Is this op's own testClientsOnly lock on? Read from the STORED configJson
 * whether the switch is on or off, so readiness, the outbox gate and the
 * previews all see the same lock (it replaces readiness.ts's private readers).
 *   reminders, script_share_email → the reminders policy's testClientsOnly,
 *       through validateReminderPolicy exactly as readiness read it (an
 *       invalid policy reads as locked; default true)
 *   script_auto_share → its own config (default true)
 *   review_auto_approve → its own config, else revision_policy's, else true
 *   every other op → false (no lock; the scope alone decides)
 * An unreadable config, or a failed read, is TRUE: a lock that cannot be read
 * is on. The defaults are written here as `true` rather than imported: every
 * module's default for these locks is on, and a missing value must read as
 * locked whatever a module's default later says.
 */
export async function featureTestOnlyFor(op: ProgramReachOp): Promise<boolean> {
  const v = await readFeatureTestOnly(op);
  return v === "error" ? true : v;
}

/** The stored lock for one op. Throws on a database error (readFeatureTestOnly keeps that apart). */
async function lockFromStored(op: ProgramReachOp): Promise<boolean> {
  if (op === "reminders" || op === "script_share_email") {
    const cfg = (await storedConfigs(["reminders"])).get("reminders");
    if (cfg === "unreadable") return true;
    if (!cfg) return true;
    const { REMINDER_DEFAULTS, validateReminderPolicy } = await import("@/lib/programReminders");
    const v = validateReminderPolicy({ ...REMINDER_DEFAULTS, ...cfg });
    return v.ok ? v.policy.testClientsOnly !== false : true;
  }
  if (op === "script_auto_share") {
    const cfg = (await storedConfigs(["script_auto_share"])).get("script_auto_share");
    if (cfg === "unreadable") return true;
    return typeof cfg?.testClientsOnly === "boolean" ? cfg.testClientsOnly : true;
  }
  if (op === "review_auto_approve") {
    const cfgs = await storedConfigs(["review_auto_approve", "revision_policy"]);
    const own = cfgs.get("review_auto_approve");
    if (own === "unreadable") return true;
    if (typeof own?.testClientsOnly === "boolean") return own.testClientsOnly;
    const pol = cfgs.get("revision_policy");
    if (pol === "unreadable") return true;
    return typeof pol?.testClientsOnly === "boolean" ? pol.testClientsOnly : true;
  }
  return false;
}

// ---- who one op reaches, for readiness and the previews -------------------

export type ProgramAudience = {
  op: ProgramReachOp;
  mode: RolloutMode;
  pilotState: PilotState;
  featureTestOnly: boolean;
  line: string;
  realClients: boolean;
  problem: string | null;
  clients: { clientId: string; enrollmentId: string; name: string; tier: ReachTier | null; decision: ReachDecision }[];
};

/**
 * Every client with an ACTIVE or PAUSED program, and what the scope decides
 * for them for `op`. (A PAUSED program is listed because queued work and
 * sessions can still concern it; ENDED programs are not.) Never throws: an
 * unreadable scope lists every client as scope_unreadable and says why.
 */
export async function programAudience(op: ProgramReachOp, opts: { now?: Date } = {}): Promise<ProgramAudience> {
  const now = opts.now ?? new Date();
  const featureTestOnly = await featureTestOnlyFor(op);
  let rollout: ProgramRollout = { ...CLOSED_ROLLOUT };
  let problem: string | null = null;
  let readError: unknown = null;
  try {
    ({ rollout, problem } = await loadProgramRollout());
  } catch (e) {
    readError = e;
    problem = `the rollout could not be read from the database (${errText(e)})`;
  }
  try {
    const enrollments = await prisma.contentEnrollment.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, clientId: true } });
    const ids = [...new Set([...enrollments.map((e) => e.clientId), ...(rollout.pilot?.clientIds ?? [])])];
    const rows = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const byId = new Map(rows.map((c) => [c.id, c]));
    const names = new Map(rows.map((c) => [c.id, c.name ?? c.id]));
    const clients: ProgramAudience["clients"] = [];
    for (const e of enrollments) {
      const c = byId.get(e.clientId);
      const decision = readError ? unreadable(readError) : c ? withProblem(rolloutDecision({ rollout, client: c, op, now, featureTestOnly }), problem) : missing;
      clients.push({ clientId: e.clientId, enrollmentId: e.id, name: c?.name ?? e.clientId, tier: decision.ok ? decision.tier : null, decision });
    }
    const rank = (t: ReachTier | null) => (t === "TEST" ? 0 : t === "PILOT" ? 1 : t === "ALL" ? 2 : 3);
    clients.sort((a, b) => rank(a.tier) - rank(b.tier) || a.name.localeCompare(b.name));
    const testRows = rows.filter((c) => isSyntheticClientRow(c) && enrollments.some((e) => e.clientId === c.id));
    // An EMAIL op reaches a TEST client only at one of Jordan's verified
    // inboxes — the outbox floor refuses anything else (review fix, Sep 28
    // 2026: the office-replied row named a TEST client whose only seat is a
    // colleague's inbox, and dispatch then refused every notice to it).
    const unverified = EMAIL_OPS.has(op) ? await testClientsWithoutVerifiedInbox(op, testRows.map((c) => c.id), enrollments) : new Set<string>();
    const testNames = testRows.map((c) => (unverified.has(c.id) ? `${c.name} — no verified inbox, not emailed` : c.name)).sort();
    const d = describeProgramScope({ rollout, op, featureTestOnly, testNames, names, now, problem });
    return { op, mode: rollout.mode, pilotState: d.pilotState, featureTestOnly, line: d.line, realClients: d.realClients, problem, clients };
  } catch (e) {
    const p = problem ?? `the program clients could not be read (${errText(e)})`;
    const d = describeProgramScope({ rollout, op, featureTestOnly, testNames: [], names: new Map(), now, problem: p });
    return { op, mode: rollout.mode, pilotState: pilotStateOf(rollout, now), featureTestOnly, line: d.line, realClients: false, problem: p, clients: [] };
  }
}

/** The ops whose only client-facing effect is an email (the TEST floor applies). */
const EMAIL_OPS: ReadonlySet<ProgramReachOp> = new Set(["reminders", "script_share_email", "program_message_notice", "portal_invites", "portal_login_email"]);

/**
 * The TEST clients an email op would never actually reach: no address it
 * would use is one of Jordan's verified inboxes. Per op, the address the send
 * itself picks:
 *   reminders, script_share_email → ONE address (programReminders.recipientFor):
 *       the first OWNER seat's person (else the first seat's), else the
 *       client's own email;
 *   program_message_notice → every OWNER / COLLABORATOR seat;
 *   portal_invites, portal_login_email → every live seat.
 */
async function testClientsWithoutVerifiedInbox(
  op: ProgramReachOp,
  clientIds: string[],
  enrollments: { id: string; clientId: string }[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!clientIds.length) return out;
  const enrollmentIds = enrollments.filter((e) => clientIds.includes(e.clientId)).map((e) => e.id);
  const [seats, clients] = await Promise.all([
    prisma.clientMembership.findMany({ where: { enrollmentId: { in: enrollmentIds }, revokedAt: null }, orderBy: { invitedAt: "asc" }, select: { enrollmentId: true, clientId: true, role: true, clientUserId: true } }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, email: true } }),
  ]);
  const people = seats.length ? await prisma.clientUser.findMany({ where: { id: { in: [...new Set(seats.map((s) => s.clientUserId))] } }, select: { id: true, email: true, status: true } }) : [];
  const person = new Map(people.map((u) => [u.id, u]));
  const liveEmail = (clientUserId: string): string | null => { const u = person.get(clientUserId); return u && u.status !== "DISABLED" && u.email ? u.email : null; };
  for (const clientId of clientIds) {
    const own = seats.filter((s) => s.clientId === clientId);
    let addresses: (string | null)[];
    if (op === "reminders" || op === "script_share_email") {
      const first = own.find((s) => s.role === "OWNER") ?? own[0] ?? null;
      const seatEmail = first ? liveEmail(first.clientUserId) : null;
      addresses = [seatEmail ?? (clients.find((c) => c.id === clientId)?.email ?? "").trim().toLowerCase() ?? null];
    } else if (op === "program_message_notice") {
      addresses = own.filter((s) => s.role === "OWNER" || s.role === "COLLABORATOR").map((s) => liveEmail(s.clientUserId));
    } else {
      addresses = own.map((s) => liveEmail(s.clientUserId));
    }
    if (!addresses.some((a) => !!a && isVerifiedTestDestinationEmail(a))) out.add(clientId);
  }
  return out;
}

// ---- the one writer -----------------------------------------------------------

export type RolloutUpdate = ProgramRollout | { error: string };

/**
 * Change the rollout. The caller checks requireOwner (only the owner edits the
 * pilot or the mode — business default 4); this is the one place the value is
 * written. One transaction: the advisory lock on "program-rollout" (two
 * owners saving at once cannot drop each other's change) → read → REFUSE if
 * the stored value is unreadable (it is never silently replaced) → mutate →
 * settleRolloutChange (modeSince/joinedAt, the cap) → a backstop on every
 * newly named client (it exists, is not TEST-named, has an ACTIVE program) →
 * upsert the AppSetting {value, updatedBy} → AuditLog {actor, action, target
 * "program-rollout", detail before -> after}. Either both rows land or
 * neither does.
 */
export async function updateProgramRollout(
  mutate: (current: ProgramRollout, now: Date) => RolloutUpdate,
  by: string,
  auditAction: string,
): Promise<{ ok: true; from: ProgramRollout; to: ProgramRollout } | { ok: false; message: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, PROGRAM_ROLLOUT_SETTING_KEY);
      const now = new Date();
      const row = await tx.appSetting.findUnique({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY }, select: { value: true } });
      const { rollout: from, problem } = parseProgramRollout(row?.value ?? null);
      if (problem) {
        return { ok: false as const, message: `The stored rollout could not be read (${problem}), so it was not changed. Fix the stored value before editing it here.` };
      }
      const wanted = mutate(from, now);
      if ("error" in wanted) return { ok: false as const, message: wanted.error };
      const settled = settleRolloutChange(from, wanted, now);
      if ("error" in settled) return { ok: false as const, message: settled.error };
      const to = settled.rollout;

      const added = (to.pilot?.clientIds ?? []).filter((id) => !(from.pilot?.clientIds ?? []).includes(id));
      if (added.length) {
        const [clients, enrollments] = await Promise.all([
          tx.client.findMany({ where: { id: { in: added } }, select: { id: true, name: true } }),
          tx.contentEnrollment.findMany({ where: { clientId: { in: added }, status: "ACTIVE" }, select: { clientId: true } }),
        ]);
        for (const id of added) {
          const c = clients.find((x) => x.id === id);
          if (!c) return { ok: false as const, message: `Client ${id} was not found, so the pilot was not changed.` };
          const bad = pilotCandidateProblem(c);
          if (bad) return { ok: false as const, message: `${bad}. The pilot was not changed.` };
          if (!enrollments.some((e) => e.clientId === id)) return { ok: false as const, message: `"${c.name}" has no ACTIVE program, so they cannot join the pilot.` };
        }
      }

      const value = serializeProgramRollout(to);
      await tx.appSetting.upsert({
        where: { key: PROGRAM_ROLLOUT_SETTING_KEY },
        create: { key: PROGRAM_ROLLOUT_SETTING_KEY, value, updatedBy: by },
        update: { value, updatedBy: by },
      });
      await tx.auditLog.create({
        data: { actor: by, action: auditAction, target: PROGRAM_ROLLOUT_SETTING_KEY, detail: `${serializeProgramRollout(from)} -> ${value}`.slice(0, 4000) },
      });
      return { ok: true as const, from, to };
    });
  } catch (e) {
    return { ok: false, message: `The rollout was not saved: ${errText(e)}` };
  }
}

/** Who the pilot editor may offer: real (non-synthetic) clients with an ACTIVE program, by name. */
export async function pilotClientCandidates(): Promise<{ id: string; name: string }[]> {
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true } });
  const ids = [...new Set(enrollments.map((e) => e.clientId))];
  if (!ids.length) return [];
  const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return rows
    .filter((c) => !isSyntheticClientRow(c))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- the hub-write pilot, read (Jordan's Sep 28 rule) ----------------------

/**
 * A hub-write switch's scope config with its PILOT replaced by the program
 * pilot (programRolloutCore.withProgramPilot) — the one list for Aryeo and
 * Calendly writes. The fixture list is kept as stored. Never throws: if the
 * rollout cannot be read, the pilot is null (no real client is written for;
 * fixtures unchanged) and `problem` says why.
 */
export async function hubWriteScopeWithProgramPilot(
  config: HubWriteScopeConfig,
  switchKey: HubWriteSwitch,
  opts: { rollout?: ProgramRollout } = {},
): Promise<{ config: HubWriteScopeConfig; problem: string | null }> {
  try {
    const loaded = opts.rollout ? { rollout: opts.rollout, problem: null } : await loadProgramRollout();
    return { config: withProgramPilot(config, loaded.rollout, switchKey), problem: loaded.problem };
  } catch (e) {
    return {
      config: { authorizedFixtureClientIds: [...config.authorizedFixtureClientIds], pilot: null },
      problem: `the program rollout could not be read (${errText(e)}), so no pilot client is written for`,
    };
  }
}

// ---- a sweep's prefilter (added by builder A1, R03 Sep 28 2026) -------------

/**
 * ADDITION to the frozen API (A1). The clients an hourly sweep should even
 * LOOK at for `op`: every synthetic TEST client (the "caller adds synthetic
 * clients through its own name query" half of rolloutClientFilter, written
 * once here) plus the real clients rolloutClientFilter admits. null means
 * "no filter" — mode ALL without the feature's own lock. The sweep still
 * decides per row; this only keeps rows that can never qualify out of its
 * `take`. Never throws: an unreadable scope narrows to TEST clients only.
 */
export async function rolloutSweepClientIds(
  op: ProgramReachOp,
  opts: { now?: Date; featureTestOnly?: boolean; rollout?: ProgramRollout } = {},
): Promise<string[] | null> {
  const now = opts.now ?? new Date();
  let rollout: ProgramRollout = { ...CLOSED_ROLLOUT };
  try {
    rollout = opts.rollout ?? (await loadProgramRollout()).rollout;
  } catch {
    rollout = { ...CLOSED_ROLLOUT };
  }
  const { rolloutClientFilter } = await import("@/lib/programRolloutCore");
  const f = rolloutClientFilter({ rollout, op, now, featureTestOnly: opts.featureTestOnly });
  if (f.everyone) return null;
  const named = await prisma.client
    .findMany({ where: { OR: [{ name: { contains: "test", mode: "insensitive" } }, { name: { contains: "john doe", mode: "insensitive" } }] }, select: { id: true, name: true } })
    .catch(() => [] as { id: string; name: string }[]);
  const synthetic = named.filter((c) => isSyntheticClientRow(c)).map((c) => c.id);
  return [...new Set([...synthetic, ...f.realClientIds])];
}
