import { isNeverSyntheticClientId, isSyntheticClientRow, isTestClientName } from "@/lib/testClients";
import {
  HUB_WRITE_OPERATION_GROUPS,
  pilotLastDay,
  pilotState,
  type HubPilot,
  type HubWriteScopeConfig,
  type HubWriteSwitch,
  type PilotState,
} from "@/lib/hubWritePermit";

// ---------------------------------------------------------------------------
// WHO THE PROGRAM MAY REACH — the rollout scope, pure (R03, Sep 28 2026).
//
// WHY THIS EXISTS. The Sep 28 external review (R03) found that every
// client-reaching program switch answered only "on or off". Once on, a switch
// reached every client it concerned, and the only narrowing was a per-feature
// testClientsOnly lock that meant "TEST clients" or "everybody" — there was no
// way to say "TEST clients plus these two agents". Jordan's rule the same
// evening: "automatic booking must be enabled for the approved pilot before we
// call the self-service scheduling workflow complete" — so ONE pilot list has
// to drive the program's emails and portal changes AND the Aryeo hub writes
// for pilot clients, with no second list that can drift from it.
//
// WHAT IT IS. One AppSetting row, key "program-rollout", read fresh on every
// decision (src/lib/programRollout.ts). Three modes:
//   TEST_ONLY  Jordan's TEST clients only. The default, and what a missing row
//              means (Stage B).
//   PILOT      TEST clients + an approved, unexpired, named pilot of at most
//              PROGRAM_PILOT_MAX real clients (Stage C).
//   ALL        every client with a program (Stage D). The owner types
//              EVERY CLIENT to choose it (Settings, builder B).
// A switch stays the on/off; this decides WHO. Effective = switch on AND
// rolloutDecision(...).ok. Every feature's own testClientsOnly lock is kept,
// but only as a NARROWING lock inside the scope (featureTestOnly): lifting it
// now means "the rollout scope", never "every real client".
//
// THE ONE DECISION, rolloutDecision, in this order:
//   1. a synthetic client row (TEST name AND not a never-synthetic id)
//                                              → ok, tier TEST, since null
//   2. the feature's own lock (featureTestOnly) → refuse feature_test_only
//   3. mode ALL                               → ok, tier ALL, since modeSince
//   4. mode TEST_ONLY                         → refuse rollout_test_only
//   5. mode PILOT: not listed → not_in_pilot; no approval → pilot_unapproved;
//      past its end → pilot_expired; the op's group not ticked →
//      operation_not_in_pilot; otherwise ok, tier PILOT,
//      since = joinedAt[id] ?? approvedAt.
// A real row renamed "… TEST" (NEVER_SYNTHETIC_CLIENT_IDS) is REAL here: it
// gets nothing unless it is named in the pilot, and the pilot editor refuses
// every TEST-named row, so it can never be named either.
//
// "SINCE". The moment this client entered the scope. Wherever a backlog could
// be dumped on a newly admitted client (review deadlines, automatic approval,
// the 3-day office-reply lookback, auto-share of older drafts, a carry-over in
// the joining month), the caller uses effectiveSince(switch enabledAt, d) —
// the later of the two. null means "nothing is owed": the switch was never on
// or the client is outside the scope. It never means "no lower bound".
// settleRolloutChange (the writer's rule) keeps joinedAt honest: it is stamped
// NOW whenever a client (re-)enters the scope, and kept while the client stays
// in.
//
// SINCE, PER GROUP, AND ACROSS PILOT → ALL (review fix, Sep 28 2026). The
// first cut re-stamped EVERY pilot client's joinedAt when any group was
// ticked, and read "since" in mode ALL as modeSince for everyone — so moving
// a pilot client from PILOT to ALL, or ticking a new group, moved their
// "since" forward: review deadlines they had already been shown stopped being
// enforced (the windows then settled NOT_HELD_BEFORE_SCOPE with no task for
// Kyle), drafts written since they joined were refused auto-share as "drafted
// before this client joined", and topics scripted between the join and the
// change stopped carrying over. Now:
//   · joinedAt[id] is when the CLIENT entered, and a widening leaves it alone;
//   · groupSince[group] is when a GROUP was ticked for the pilot (only a
//     newly ticked group starts now); a PILOT client's since is the later of
//     the two, so the new group has no backlog and the old ones keep theirs;
//   · in mode ALL a client still listed in the pilot keeps the since it had
//     as a pilot client when that is earlier than modeSince (settle keeps
//     joinedAt across PILOT → ALL only while the client stayed admitted, so
//     the earlier date is honest); everyone else's since is modeSince.
//
// THE HUB-WRITE PILOT (Jordan's Sep 28 rule, business default 1). The Aryeo
// and Calendly PILOT route reads THIS pilot, not a per-switch list:
//   programPilotAsHubPilot(rollout, switchKey) → the HubPilot shape
//     hubWritePermit.ts already evaluates (pilotState / pilotProblem /
//     routeHubWrite), built from the program pilot. Its operations are every
//     Aryeo/Calendly operation of that switch when the "bookings" group
//     (op hub_writes) is ticked, and none otherwise.
//   withProgramPilot(config, rollout, switchKey) → the switch's scope config
//     with its `pilot` REPLACED by that; authorizedFixtureClientIds is kept
//     exactly as stored, so the FIXTURE path is unchanged.
// Usage (builder A1, integrations/aryeo.ts hubWritePermit and
// callBooking.callBookingScope): route on
//   routeHubWrite({ ..., config: withProgramPilot(parseHubWriteConfig(cfg), rollout, switchKey) })
// or, server-side with the read and its failure handled, programRollout.ts
// hubWriteScopeWithProgramPilot(config, switchKey). The per-switch pilot on
// file is then read by nobody.
// Mode rules for hub writes: TEST_ONLY → no pilot (no real client is written
// for); PILOT → the pilot; ALL → STILL only the named pilot. Choosing
// "everyone" for program emails does not also put every client's real
// bookings on a creative's calendar — widening Aryeo writes past the named
// pilot is a separate decision Jordan has not made (listed for him to
// confirm).
//
// ADDED TO THE FROZEN API (additions only; every frozen name, signature and
// return type is exactly as designed):
//   here            pilotGroupOf(op), opsForGroups(keys), settleRolloutChange
//                   (the writer's rule, run by updateProgramRollout),
//                   pilotCandidateProblem (the TEST-name refusal the add
//                   action and the writer share), programPilotAsHubPilot,
//                   withProgramPilot, pilotLastDay (re-exported from
//                   hubWritePermit), clientReachSummary and
//                   PROGRAM_PILOT_GROUP_SHORT (one client, every group — the
//                   per-client lists on Settings and readiness).
//   ProgramPilot    groupSince (optional; Sep 28 review fix, see "SINCE").
//   PROGRAM_REACH_OPS  caption_assistant (Sep 28 review fix: a client-invoked
//                   portal feature that had been labelled internal).
//   programRollout  hubWriteScopeWithProgramPilot(config, switchKey) — never
//                   throws; on a read error the pilot is null (nobody real).
//                   readFeatureTestOnly(op) → true | false | "error" and
//                   programReachWithLock(op, clientId) (Sep 28 review fix: a
//                   failed LOCK read is "could not decide", never "locked",
//                   wherever a send decides).
//   programRolloutGate  gate_error means "could not decide — nothing sent,
//                   retry later"; every other GateCode is a decision.
//
// PURE. Imports only testClients and hubWritePermit, which import nothing, so
// client components, drills and readiness can all use it.
//
// PER-CLIENT CHOICES (Oct 5 2026, Jordan: "I'll do each client one by one …
// I can customize what gets sent or not sent"). One shared `operations` list
// for every pilot client could not say "Erica gets the portal, Kristin gets
// the portal and the emails". The pilot now carries an optional
//   clientOps[clientId] = the ops THAT client gets (an empty list = nothing)
// and a listed client with no entry keeps the shared `operations` — so a
// value stored before today means exactly what it meant. rolloutDecision,
// rolloutClientFilter, the hub-write pilot and describeProgramScope all read
// the client's own list (pilotOpsFor), so every enforcement point follows.
// "Since" for a client's own op is the later of when they joined and when
// THAT op was turned on for them (clientOpsSince, written by
// settleRolloutChange), so turning one thing on never dumps a backlog of it.
// setClientOpsChange is the Client onboarding page's one change; it never
// widens anybody but the client it names (see its comment). The cap rose
// from 3 to PROGRAM_PILOT_MAX (30) so every program client can be named —
// still a cap.
//
// REVIEW FIXES (Oct 5 2026, late):
//   · manual_messages — "Messages I send myself" — is its own op in its own
//     group ("messages"). Jordan's step-5 sends used to ride the "Program
//     emails" ops, which ALSO let the automatic reminders / scripts-ready /
//     office-replied emails through the moment their switches went on. Now
//     the manual send asks manual_messages only (the welcome also needs the
//     portal account), and "Program emails" means the automatic ones alone.
//     It has no switch and no feature lock: Jordan pressing Send is the
//     decision. A value stored before it simply does not carry it.
//   · setClientOpsChange no longer brings anybody else's stored choices back
//     to life. When the named list is reaching nobody (the mode is "Only my
//     TEST clients", or it has no approval) and another client on file still
//     has something turned on, an allowing change is REFUSED with their ids
//     (othersOnFile) unless the caller asks for `onlyThisClient`, which sets
//     every other named client to nothing in the same write.
// ---------------------------------------------------------------------------

export const PROGRAM_ROLLOUT_SETTING_KEY = "program-rollout";

/**
 * Hard cap on REAL pilot clients. Was 3 (business default 2, Sep 28 2026);
 * raised Oct 5 2026 to cover every program client once Jordan turns each one
 * on by hand from Settings → Client onboarding. Still a cap.
 */
export const PROGRAM_PILOT_MAX = 30;

/**
 * Everything the program does that reaches a client, one name each. Twelve
 * are ProgramAutomation switches; portal_sign_in (a signed-in seat may open
 * this client's program) and hub_writes (the program-pilot requirement on
 * Aryeo/Calendly writes) are not switches.
 *
 * caption_assistant (review fix, Sep 28 2026): the client's own "Draft a
 * caption" button in their posting kit, and the AI draft it writes there. It
 * was labelled internal and gated by its switch alone, so turning it on gave
 * every real client, pilot or not, an AI caption drafter. It is a portal
 * change, in the portal_changes group.
 */
export const PROGRAM_REACH_OPS = [
  "reminders",
  "script_share_email",
  "script_auto_share",
  "portal_invites",
  "portal_login_email",
  "portal_sign_in",
  "portal_layout_v2",
  "program_message_notice",
  // Oct 5 2026 review fix: the messages Jordan composes and sends himself from
  // Settings → Client onboarding (step 5). No switch: only his press sends.
  "manual_messages",
  "revision_policy",
  "review_auto_approve",
  "topic_carryover",
  "caption_assistant",
  "publishing",
  "hub_writes",
] as const;
export type ProgramReachOp = (typeof PROGRAM_REACH_OPS)[number];

export function isProgramReachOp(x: unknown): x is ProgramReachOp {
  return typeof x === "string" && (PROGRAM_REACH_OPS as readonly string[]).includes(x);
}

export type ProgramPilotGroupKey = "accounts" | "layout" | "emails" | "messages" | "portal_changes" | "bookings";

/**
 * How the owner approves operations: plain-word groups, all ticked by default
 * when Jordan approves a pilot (business default 1). publishing is in no group
 * on purpose — it reaches TEST clients or ALL only. "messages" (Oct 5 2026) is
 * the messages Jordan sends himself, apart from the automatic emails.
 */
export const PROGRAM_PILOT_GROUPS: readonly { key: ProgramPilotGroupKey; label: string; ops: readonly ProgramReachOp[] }[] = [
  { key: "accounts", label: "Portal accounts — invitations, sign-in emails and signing in", ops: ["portal_invites", "portal_login_email", "portal_sign_in"] },
  { key: "layout", label: "The new portal layout", ops: ["portal_layout_v2"] },
  { key: "emails", label: "Program emails — reminders, scripts-ready and office-replied notices", ops: ["reminders", "script_share_email", "program_message_notice"] },
  { key: "messages", label: "Messages you send yourself from Client onboarding (only when you press Send)", ops: ["manual_messages"] },
  {
    key: "portal_changes",
    label: "Automatic portal changes — auto-shared scripts, review deadlines, automatic approval, topic carry-over and the caption assistant",
    ops: ["script_auto_share", "revision_policy", "review_auto_approve", "topic_carryover", "caption_assistant"],
  },
  { key: "bookings", label: "Booking filming sessions and addresses in Aryeo (and the strategy call in Calendly)", ops: ["hub_writes"] },
];

/** The group an operation belongs to, or null (publishing). */
export function pilotGroupOf(op: ProgramReachOp): (typeof PROGRAM_PILOT_GROUPS)[number] | null {
  return PROGRAM_PILOT_GROUPS.find((g) => g.ops.includes(op)) ?? null;
}

/** Does this listed client have their OWN list (Oct 5 2026)? */
const hasOwnOps = (p: ProgramPilot, clientId: string): boolean => !!p.clientOps && Object.prototype.hasOwnProperty.call(p.clientOps, clientId);

/**
 * The ops a listed pilot client gets: their own list when they have one
 * (an empty list = nothing), else the pilot's shared `operations` (today's
 * meaning for every value stored before per-client choices existed).
 */
export function pilotOpsFor(p: ProgramPilot, clientId: string): ProgramReachOp[] {
  return hasOwnOps(p, clientId) ? p.clientOps![clientId] : p.operations;
}

/** Can the pilot carry this op for this client? Only an op in a group — never
 *  publishing, even if a hand-edited stored value lists it. */
const pilotCarries = (p: ProgramPilot, op: ProgramReachOp, clientId: string): boolean => pilotOpsFor(p, clientId).includes(op) && pilotGroupOf(op) !== null;

/** The listed clients the pilot carries this op for, in list order. */
const pilotCarriers = (p: ProgramPilot, op: ProgramReachOp): string[] => p.clientIds.filter((id) => pilotCarries(p, op, id));

/** Every op of the given groups, in canonical order (the editor's "tick what they get"). */
export function opsForGroups(keys: readonly ProgramPilotGroupKey[]): ProgramReachOp[] {
  const want = new Set(PROGRAM_PILOT_GROUPS.filter((g) => keys.includes(g.key)).flatMap((g) => g.ops));
  return PROGRAM_REACH_OPS.filter((op) => want.has(op));
}

export type RolloutMode = "TEST_ONLY" | "PILOT" | "ALL";
const MODES: readonly RolloutMode[] = ["TEST_ONLY", "PILOT", "ALL"];

export type ProgramPilot = {
  clientIds: string[];
  operations: ProgramReachOp[];
  approvedBy: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  joinedAt: Record<string, string>;
  /**
   * When each group was ticked for the pilot (ISO), written by
   * settleRolloutChange. Optional: a value stored before the Sep 28 review fix
   * has none, which means "no bound beyond joinedAt". Only groups the pilot
   * still carries are kept.
   */
  groupSince?: Partial<Record<ProgramPilotGroupKey, string>>;
  /**
   * PER-CLIENT OPERATIONS (Oct 5 2026). A listed client with an entry gets
   * exactly these ops (an empty list = nothing at all); a listed client with
   * no entry gets the shared `operations`. Optional and back-compatible: a
   * value stored without it keeps today's shared meaning. Entries for clients
   * not in clientIds are dropped; only ops some group carries are kept.
   */
  clientOps?: Record<string, ProgramReachOp[]>;
  /**
   * When each of a client's OWN ops was turned on for them (ISO), written by
   * settleRolloutChange. A client's since for such an op is the later of this
   * and their joinedAt, so a newly allowed feature starts with no backlog.
   */
  clientOpsSince?: Record<string, Partial<Record<ProgramReachOp, string>>>;
};
export type ProgramRollout = { mode: RolloutMode; modeSince: string | null; pilot: ProgramPilot | null };

/** The default and the fail-closed value: TEST clients only. Frozen; parse returns fresh copies. */
export const CLOSED_ROLLOUT: ProgramRollout = Object.freeze({ mode: "TEST_ONLY", modeSince: null, pilot: null }) as ProgramRollout;

// ---- reading and writing the stored value --------------------------------

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);
const objOrNull = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The stored JSON, read. A MISSING row (null/undefined) is the default,
 * TEST_ONLY, with no problem — it is Stage B, not a fault. Anything present
 * but unreadable (not JSON, not an object, an unknown mode, a pilot that is
 * not an object, more than PROGRAM_PILOT_MAX clients) reads as TEST_ONLY WITH
 * a problem string: no real client is reached, TEST clients still are, and
 * readiness shows why. Unknown operation names and joinedAt entries for
 * clients not in the pilot are dropped (narrowing only, never a widening).
 */
export function parseProgramRollout(raw: string | null | undefined): { rollout: ProgramRollout; problem: string | null } {
  const closed = (problem: string) => ({ rollout: { ...CLOSED_ROLLOUT }, problem });
  if (raw == null) return { rollout: { ...CLOSED_ROLLOUT }, problem: null };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return closed("the stored rollout is not valid JSON");
  }
  const o = objOrNull(v);
  if (!o) return closed("the stored rollout is not a JSON object");
  if (!MODES.includes(o.mode as RolloutMode)) return closed(`the stored rollout has an unknown mode (${JSON.stringify(o.mode ?? null)})`);
  const mode = o.mode as RolloutMode;
  let pilot: ProgramPilot | null = null;
  if (o.pilot != null) {
    const p = objOrNull(o.pilot);
    if (!p) return closed("the stored pilot is not a JSON object");
    const clientIds = Array.isArray(p.clientIds)
      ? [...new Set(p.clientIds.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
      : [];
    if (clientIds.length > PROGRAM_PILOT_MAX) return closed(`the stored pilot names ${clientIds.length} clients, more than the cap of ${PROGRAM_PILOT_MAX}`);
    const ops = new Set(Array.isArray(p.operations) ? p.operations : []);
    const joined = objOrNull(p.joinedAt) ?? {};
    const joinedAt: Record<string, string> = {};
    for (const id of clientIds) {
      const at = isoOrNull(joined[id]);
      if (at) joinedAt[id] = at;
    }
    // Only ops some group carries: a stored "publishing" is dropped, so a
    // pilot can never reach a client with it (TEST or ALL only).
    const operations = PROGRAM_REACH_OPS.filter((op) => ops.has(op) && pilotGroupOf(op) !== null);
    pilot = {
      clientIds,
      operations,
      approvedBy: textOrNull(p.approvedBy),
      approvedAt: isoOrNull(p.approvedAt),
      expiresAt: isoOrNull(p.expiresAt),
      note: textOrNull(p.note),
      joinedAt,
    };
    const groupSince = keptGroupSince(objOrNull(p.groupSince), operations);
    if (groupSince) pilot.groupSince = groupSince;
    // Per-client choices (Oct 5 2026). PRESENT BUT NOT AN OBJECT is
    // unreadable, never "absent": absent means the shared list, and reading a
    // garbled per-client value as the shared list could WIDEN a client who
    // had been set to nothing. A malformed entry for one client is an empty
    // list for that client (nothing), for the same reason.
    if (p.clientOps != null) {
      const own = objOrNull(p.clientOps);
      if (!own) return closed("the stored per-client choices are not a JSON object");
      const clientOps = keptClientOps(own, clientIds);
      if (clientOps) {
        pilot.clientOps = clientOps;
        const since = keptClientOpsSince(objOrNull(p.clientOpsSince), clientOps);
        if (since) pilot.clientOpsSince = since;
      }
    }
  }
  return { rollout: { mode, modeSince: isoOrNull(o.modeSince), pilot }, problem: null };
}

/** One client's list, read: known ops some group carries, canonical order; anything else → []. */
const opsList = (v: unknown): ProgramReachOp[] => {
  if (!Array.isArray(v)) return [];
  const want = new Set(v);
  return PROGRAM_REACH_OPS.filter((op) => want.has(op) && pilotGroupOf(op) !== null);
};

/** clientOps reduced to listed clients, in list order; null when nobody has their own list. */
function keptClientOps(raw: Record<string, unknown> | Record<string, ProgramReachOp[]> | null | undefined, clientIds: readonly string[]): Record<string, ProgramReachOp[]> | null {
  if (!raw) return null;
  const out: Record<string, ProgramReachOp[]> = {};
  for (const id of clientIds) if (Object.prototype.hasOwnProperty.call(raw, id)) out[id] = opsList((raw as Record<string, unknown>)[id]);
  return Object.keys(out).length ? out : null;
}

/** clientOpsSince reduced to real dates for ops each client still has, in canonical order; null when empty. */
function keptClientOpsSince(raw: Record<string, unknown> | null | undefined, clientOps: Record<string, ProgramReachOp[]>): Record<string, Partial<Record<ProgramReachOp, string>>> | null {
  if (!raw) return null;
  const out: Record<string, Partial<Record<ProgramReachOp, string>>> = {};
  for (const [id, ops] of Object.entries(clientOps)) {
    const per = objOrNull(raw[id]);
    if (!per) continue;
    const kept: Partial<Record<ProgramReachOp, string>> = {};
    for (const op of ops) {
      const at = isoOrNull(per[op]);
      if (at) kept[op] = at;
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return Object.keys(out).length ? out : null;
}

/** A group is carried while any of its ops is in the pilot's operations. */
const groupCarried = (key: ProgramPilotGroupKey, operations: readonly ProgramReachOp[]): boolean =>
  PROGRAM_PILOT_GROUPS.some((g) => g.key === key && g.ops.some((op) => operations.includes(op)));

/** groupSince reduced to real dates for groups the pilot carries, in canonical order; null when empty. */
function keptGroupSince(raw: Record<string, unknown> | null | undefined, operations: readonly ProgramReachOp[]): Partial<Record<ProgramPilotGroupKey, string>> | null {
  if (!raw) return null;
  const out: Partial<Record<ProgramPilotGroupKey, string>> = {};
  for (const g of PROGRAM_PILOT_GROUPS) {
    const at = isoOrNull(raw[g.key]);
    if (at && groupCarried(g.key, operations)) out[g.key] = at;
  }
  return Object.keys(out).length ? out : null;
}

/** The stored JSON. Fixed key order, so a round trip is byte-stable. */
export function serializeProgramRollout(r: ProgramRollout): string {
  const p = r.pilot;
  const groupSince = p ? keptGroupSince(p.groupSince, p.operations) : null;
  // Written only when present, AFTER the older keys: a value without
  // per-client choices serializes byte-for-byte as it did before Oct 5.
  const clientOps = p ? keptClientOps(p.clientOps, p.clientIds) : null;
  const clientOpsSince = clientOps ? keptClientOpsSince(p!.clientOpsSince as Record<string, unknown> | undefined, clientOps) : null;
  return JSON.stringify({
    mode: r.mode,
    modeSince: r.modeSince,
    pilot: p
      ? {
          clientIds: p.clientIds,
          operations: p.operations,
          approvedBy: p.approvedBy,
          approvedAt: p.approvedAt,
          expiresAt: p.expiresAt,
          note: p.note,
          joinedAt: Object.fromEntries(p.clientIds.filter((id) => p.joinedAt[id]).map((id) => [id, p.joinedAt[id]])),
          ...(groupSince ? { groupSince } : {}),
          ...(clientOps ? { clientOps } : {}),
          ...(clientOpsSince ? { clientOpsSince } : {}),
        }
      : null,
  });
}

// ---- the decision ----------------------------------------------------------

export type ReachTier = "TEST" | "PILOT" | "ALL";
export type ReachRefusalCode =
  | "feature_test_only"
  | "rollout_test_only"
  | "not_in_pilot"
  | "pilot_unapproved"
  | "pilot_expired"
  | "operation_not_in_pilot"
  | "client_missing"
  | "scope_unreadable";
export type ReachDecision =
  | { ok: true; tier: ReachTier; since: Date | null; reason: string }
  | { ok: false; code: ReachRefusalCode; reason: string };

/** Where the program pilot stands as a whole, in hubWritePermit's own terms. */
export function pilotStateOf(rollout: ProgramRollout, now: Date): PilotState {
  return pilotState(rollout.pilot, now);
}

/** "Oct 29" in Eastern time — the only way a pilot date is written. */
const etDay = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(iso)) : "";

export { pilotLastDay };

const toDate = (iso: string | null | undefined): Date | null => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso) : null);
const later = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b);

/**
 * A pilot client's since for one op: the later of when THEY joined (else the
 * approval) and when the op's GROUP was ticked (see "SINCE, PER GROUP").
 */
function pilotSince(p: ProgramPilot, clientId: string, op: ProgramReachOp): Date | null {
  const joined = toDate(p.joinedAt[clientId]) ?? toDate(p.approvedAt);
  // A client's OWN op starts when it was turned on for them (Oct 5 2026).
  if (hasOwnOps(p, clientId)) return later(joined, toDate(p.clientOpsSince?.[clientId]?.[op]));
  const g = pilotGroupOf(op);
  return later(joined, g ? toDate(p.groupSince?.[g.key]) : null);
}

/**
 * Mode ALL: modeSince — unless the client is still listed in the pilot with
 * this op, and was reached as a pilot client from an EARLIER moment (settle
 * keeps joinedAt across PILOT → ALL only while the client stayed admitted).
 */
function allSince(rollout: ProgramRollout, clientId: string, op: ProgramReachOp): Date | null {
  const modeSince = toDate(rollout.modeSince);
  const p = rollout.pilot;
  if (!p || !p.clientIds.includes(clientId) || !pilotCarries(p, op, clientId) || !p.joinedAt[clientId]) return modeSince;
  const asPilot = pilotSince(p, clientId, op);
  if (!modeSince || !asPilot) return modeSince;
  return asPilot.getTime() < modeSince.getTime() ? asPilot : modeSince;
}

/** The lock's name in the place Jordan lifts it, for the refusal sentence. */
const LOCK_HOME: Partial<Record<ProgramReachOp, string>> = {
  reminders: "Program reminders",
  script_share_email: "Program reminders",
  script_auto_share: "Automatic sharing",
  review_auto_approve: "Automatic approval",
};
const lockSentence = (op: ProgramReachOp): string =>
  `this feature's own testClientsOnly lock is on (lift it in ${LOCK_HOME[op] ?? "the feature's settings"} to include the rollout scope)`;

/** THE decision. Pure; the rules are in the header. */
export function rolloutDecision(a: {
  rollout: ProgramRollout;
  client: { id: string; name: string | null };
  op: ProgramReachOp;
  now: Date;
  featureTestOnly?: boolean;
}): ReachDecision {
  const { rollout, client, op, now } = a;
  if (isSyntheticClientRow({ id: client.id, name: client.name })) {
    return { ok: true, tier: "TEST", since: null, reason: "a TEST client — always in the rollout scope" };
  }
  if (a.featureTestOnly) return { ok: false, code: "feature_test_only", reason: `only TEST clients — ${lockSentence(op)}` };
  if (rollout.mode === "ALL") {
    return { ok: true, tier: "ALL", since: allSince(rollout, client.id, op), reason: "the rollout reaches every client with a program" };
  }
  if (rollout.mode === "TEST_ONLY") return { ok: false, code: "rollout_test_only", reason: "the rollout is set to TEST clients only" };
  const p = rollout.pilot;
  if (!p || !p.clientIds.includes(client.id)) return { ok: false, code: "not_in_pilot", reason: "this client is not in the program pilot" };
  const state = pilotState(p, now);
  if (state === "UNAPPROVED") return { ok: false, code: "pilot_unapproved", reason: "the program pilot has no recorded approval, so it covers nobody" };
  if (state === "EXPIRED") return { ok: false, code: "pilot_expired", reason: `the program pilot ended after ${pilotLastDay(p.expiresAt)}, so it no longer reaches its clients` };
  if (!pilotCarries(p, op, client.id)) {
    const g = pilotGroupOf(op);
    return {
      ok: false,
      code: "operation_not_in_pilot",
      reason: g ? `the program pilot does not include "${g.label}" for this client` : `${op} is never part of a pilot — it reaches TEST clients, or every client once the rollout is set to everyone`,
    };
  }
  return {
    ok: true,
    tier: "PILOT",
    since: pilotSince(p, client.id, op),
    // The stored end is the NEXT ET midnight after the day the owner chose;
    // the words name the chosen day (review fix, Sep 28 2026: it read a day late).
    reason: `in the program pilot (approved by ${p.approvedBy}${p.expiresAt ? `, through ${pilotLastDay(p.expiresAt)}` : ""})`,
  };
}

/**
 * Which kind of client this is right now, whatever the operation. PILOT only
 * while the mode is PILOT, the pilot is ACTIVE and the client is named in it;
 * a never-synthetic row renamed TEST is REAL (or PILOT if named).
 */
export function clientTier(rollout: ProgramRollout, client: { id: string; name: string | null }, now: Date): "TEST" | "PILOT" | "REAL" {
  if (isSyntheticClientRow({ id: client.id, name: client.name })) return "TEST";
  const p = rollout.pilot;
  // A client whose OWN list is empty (Oct 5 2026) is named but gets nothing,
  // so they are not a pilot client for anything that asks "PILOT or REAL".
  if (rollout.mode === "PILOT" && p?.clientIds.includes(client.id) && pilotState(p, now) === "ACTIVE" && !(hasOwnOps(p, client.id) && pilotOpsFor(p, client.id).length === 0)) return "PILOT";
  return "REAL";
}

/** Each group in a few words, for a client's line ("in the pilot — program emails, the new layout"). */
export const PROGRAM_PILOT_GROUP_SHORT: Record<ProgramPilotGroupKey, string> = {
  accounts: "portal accounts",
  layout: "the new layout",
  emails: "program emails",
  messages: "messages you send",
  portal_changes: "automatic portal changes",
  bookings: "bookings in Aryeo/Calendly",
};

/**
 * WHO THIS CLIENT IS, FOR EVERY GROUP AT ONCE (review fix, Sep 28 2026). The
 * per-client lists on Settings and on readiness were read through ONE op
 * (portal_sign_in): a pilot that ticked only "Program emails" showed its
 * client as "not reached for this" (never saying for what) beside a reminders
 * row that named them, and an accounts-only pilot showed them green although
 * no email reached them. This answers per group, without any feature's own
 * lock (the rows say those), and bookings the way the hub-write guard reads
 * it (programPilotAsHubPilot: the NAMED pilot, even in ALL; nobody in
 * TEST_ONLY; TEST clients are written for only as fixtures, not here).
 *   tier    TEST, or PILOT / ALL when the rollout reaches them for at least
 *           one group, else null
 *   groups  the groups they are reached for
 *   code / reason   when no group reaches them: the rollout's own refusal
 */
export function clientReachSummary(
  rollout: ProgramRollout,
  client: { id: string; name: string | null },
  now: Date,
): { tier: ReachTier | null; groups: ProgramPilotGroupKey[]; code: ReachRefusalCode | null; reason: string } {
  if (isSyntheticClientRow({ id: client.id, name: client.name })) {
    return { tier: "TEST", groups: PROGRAM_PILOT_GROUPS.filter((g) => g.key !== "bookings").map((g) => g.key), code: null, reason: "a TEST client — always in the rollout scope (bookings only as a TEST fixture)" };
  }
  const hub = programPilotAsHubPilot(rollout, "session_booking");
  const booked = !!hub && hub.operations.length > 0 && hub.clientIds.includes(client.id) && pilotState(hub, now) === "ACTIVE";
  const groups = PROGRAM_PILOT_GROUPS.filter((g) =>
    g.key === "bookings" ? booked : g.ops.some((op) => rolloutDecision({ rollout, client, op, now }).ok),
  ).map((g) => g.key);
  if (groups.length) {
    const words = groups.map((k) => PROGRAM_PILOT_GROUP_SHORT[k]).join(", ");
    return rollout.mode === "ALL"
      ? { tier: "ALL", groups, code: null, reason: `every client with a program is reached — ${words}${booked ? "" : " (bookings only for named pilot clients)"}` }
      : { tier: "PILOT", groups, code: null, reason: `in the program pilot for: ${words}` };
  }
  const d = rolloutDecision({ rollout, client, op: "portal_sign_in", now });
  return d.ok
    ? { tier: null, groups, code: null, reason: d.reason }
    : { tier: null, groups, code: d.code, reason: d.code === "operation_not_in_pilot" ? "in the pilot, but the pilot covers none of the program's features" : d.reason };
}

/**
 * A prefilter for a sweep's query: which REAL clients rolloutDecision would
 * admit for this op. { everyone: true } only in ALL without the feature lock.
 * The caller always adds synthetic clients through its own TEST-name query
 * (and still decides per row); for every real client, "in this filter" is
 * exactly "rolloutDecision ok" (the drill proves it over the whole matrix).
 */
export function rolloutClientFilter(a: {
  rollout: ProgramRollout;
  op: ProgramReachOp;
  now: Date;
  featureTestOnly?: boolean;
}): { everyone: true } | { everyone: false; realClientIds: string[] } {
  const { rollout, op, now } = a;
  if (a.featureTestOnly) return { everyone: false, realClientIds: [] };
  if (rollout.mode === "ALL") return { everyone: true };
  const p = rollout.pilot;
  if (rollout.mode !== "PILOT" || !p || pilotState(p, now) !== "ACTIVE") return { everyone: false, realClientIds: [] };
  // Per client (Oct 5 2026): only the listed clients whose own list (or the
  // shared one, for a client without their own) carries this op.
  return { everyone: false, realClientIds: pilotCarriers(p, op) };
}

/**
 * The ProgramReminder / notice suppression code for a refusal. The two stay
 * distinct: launch_not_authorised is the feature's own lock, and
 * not_in_rollout_scope is the rollout (every other refusal).
 */
export function reachSuppressionReason(d: ReachDecision): null | "launch_not_authorised" | "not_in_rollout_scope" {
  if (d.ok) return null;
  return d.code === "feature_test_only" ? "launch_not_authorised" : "not_in_rollout_scope";
}

/**
 * The later of the switch's enabledAt and the client's `since`. null when the
 * switch was never enabled OR the decision refuses — null means "nothing is
 * held or owed", the same thing reviewWindows.enforced() reads from a null
 * enabledAt. A TEST client (since null) gets the switch's own enabledAt.
 */
export function effectiveSince(switchEnabledAt: Date | null, d: ReachDecision): Date | null {
  if (!switchEnabledAt || !d.ok) return null;
  if (!d.since) return switchEnabledAt;
  return d.since.getTime() > switchEnabledAt.getTime() ? d.since : switchEnabledAt;
}

// ---- the writer's rule ------------------------------------------------------

/** Was this real client inside the scope under `r` at `now` (for any op)? */
const admitted = (r: ProgramRollout, id: string, now: Date): boolean =>
  r.mode === "ALL" || (r.mode === "PILOT" && !!r.pilot?.clientIds.includes(id) && pilotState(r.pilot, now) === "ACTIVE");

/**
 * What a change to the rollout actually stores, decided in ONE place so every
 * Settings action (builder B) gets the same answer. updateProgramRollout runs
 * it on whatever the action's mutate returned:
 *   · the result must parse cleanly (at most PROGRAM_PILOT_MAX clients, a
 *     known mode) or the change is refused;
 *   · modeSince is NOW when the mode changes, and otherwise what it was (an
 *     action cannot rewrite when a mode began);
 *   · joinedAt[id] is KEPT for a client who was inside the scope before the
 *     change and stays inside after it; otherwise it is NOW. So a client
 *     added, or re-admitted after an expiry or a TEST-only spell, gets "since"
 *     = the moment of that change, and no backlog (review deadlines they were
 *     never shown, older drafts, a 3-day office-reply run, this month's
 *     carry-over) lands on them.
 *   · a WIDENING no longer touches joinedAt (review fix, Sep 28 2026 — it
 *     used to, which un-held deadlines a client had already been shown).
 *     Instead groupSince[group] is NOW for a group the change newly ticks
 *     (the moment the program was last reaching every client, when that is
 *     where the change comes from), kept for a group that stays ticked, and
 *     dropped for a group that is unticked. Since for an op is the later of
 *     joinedAt and its group's start, so only the new group starts now.
 *   · entries for clients no longer in the pilot are dropped, so a later
 *     re-add is stamped fresh.
 */
export function settleRolloutChange(from: ProgramRollout, to: ProgramRollout, now: Date): { rollout: ProgramRollout } | { error: string } {
  const named = new Set((to.pilot?.clientIds ?? []).map((id) => id.trim()).filter(Boolean)).size;
  if (named > PROGRAM_PILOT_MAX) return { error: `That change names ${named} clients — the pilot's cap is ${PROGRAM_PILOT_MAX} real clients. Nothing was saved.` };
  const parsed = parseProgramRollout(serializeProgramRollout(to));
  if (parsed.problem) return { error: `That change was not saved: ${parsed.problem}.` };
  const next = parsed.rollout;
  const at = now.toISOString();
  next.modeSince = next.mode !== from.mode ? at : from.modeSince;
  if (next.pilot) {
    const before = from.pilot;
    const beforeOps = before?.operations ?? [];
    const joinedAt: Record<string, string> = {};
    for (const id of next.pilot.clientIds) {
      const stays = admitted(from, id, now) && admitted(next, id, now);
      const kept = before?.joinedAt[id] ?? (from.mode === "ALL" ? from.modeSince : null);
      joinedAt[id] = stays && kept ? kept : at;
    }
    next.pilot.joinedAt = joinedAt;
    // Per-group start. Under ALL every op already reached every client from
    // modeSince, so a group ticked while the rollout was everyone starts then.
    const newGroupStart = from.mode === "ALL" && from.modeSince ? from.modeSince : at;
    const groupSince: Partial<Record<ProgramPilotGroupKey, string>> = {};
    for (const g of PROGRAM_PILOT_GROUPS) {
      if (!groupCarried(g.key, next.pilot.operations)) continue;
      const newlyTicked = g.ops.some((op) => next.pilot!.operations.includes(op) && !beforeOps.includes(op));
      const was = before?.groupSince?.[g.key];
      if (newlyTicked) groupSince[g.key] = newGroupStart;
      else if (was) groupSince[g.key] = was;
    }
    if (Object.keys(groupSince).length) next.pilot.groupSince = groupSince;
    else delete next.pilot.groupSince;
    // Per client, per op (Oct 5 2026) — the same rule as groupSince, one
    // client at a time: an op newly on FOR THIS CLIENT starts now (or at
    // modeSince when the rollout was everyone, which already reached them);
    // an op they already had keeps its start — their own stamp, or, the first
    // time a shared-list client gets their own list, the shared group's.
    const own = next.pilot.clientOps;
    if (own) {
      const since: Record<string, Partial<Record<ProgramReachOp, string>>> = {};
      for (const [id, ops] of Object.entries(own)) {
        const had = before && before.clientIds.includes(id) ? pilotOpsFor(before, id) : [];
        const per: Partial<Record<ProgramReachOp, string>> = {};
        for (const op of ops) {
          if (!had.includes(op)) { per[op] = newGroupStart; continue; }
          const g = pilotGroupOf(op);
          const was = before && hasOwnOps(before, id) ? before.clientOpsSince?.[id]?.[op] : g ? before?.groupSince?.[g.key] : undefined;
          if (was) per[op] = was;
        }
        if (Object.keys(per).length) since[id] = per;
      }
      if (Object.keys(since).length) next.pilot.clientOpsSince = since;
      else delete next.pilot.clientOpsSince;
    } else delete next.pilot.clientOpsSince;
  }
  return { rollout: next };
}

/**
 * THE CLIENT ONBOARDING PAGE'S ONE CHANGE (Oct 5 2026): set exactly what ONE
 * real client gets. Pure; updateProgramRollout runs it as the mutate and
 * settleRolloutChange stamps the dates. Rules:
 *   · the client gets their OWN list (`ops`, groups' ops only); an empty list
 *     takes them out of the named list altogether (a later turn-on is a fresh
 *     join, so nothing from the gap is owed);
 *   · a change that ALLOWS something new is an approval: it re-stamps who
 *     and when, and the first one while the rollout is "TEST clients only"
 *     sets the mode to PILOT (named clients). "Every client" is left alone —
 *     nothing here ever widens the mode to everyone, or narrows it from
 *     there. A change that only takes things away re-stamps nothing;
 *   · NOBODY ELSE IS WIDENED. The re-stamped approval, or the mode becoming
 *     PILOT, could switch on a list that was sitting on file reaching nobody
 *     (an old pilot under "TEST clients only", or one with no recorded
 *     approval). So when the named list was reaching nobody before an
 *     allowing change and any OTHER named client still has something on file
 *     (their own list or the shared one), the change is REFUSED with their ids
 *     in `othersOnFile` (review fix, Oct 5 2026: the first cut pinned only the
 *     shared-list clients, and a client with their own list came back on).
 *     With `onlyThisClient` every other named client is set to nothing (an
 *     empty own list) in the same write, so only this client is reached;
 *   · allowing something on a named list that has ENDED is refused:
 *     re-opening it from here would restart everyone on it. Its end date is
 *     changed in Settings → Who the program may reach. Taking things away
 *     from an ended list is fine;
 *   · TEST clients are never named (the writer refuses them too): they are
 *     always reached.
 * Returns the wanted rollout, or { error } with the sentence the page shows.
 */
export function setClientOpsChange(
  cur: ProgramRollout,
  a: { client: { id: string; name: string | null }; ops: readonly ProgramReachOp[]; by: string; now: Date; onlyThisClient?: boolean },
): ProgramRollout | { error: string; othersOnFile?: string[] } {
  const bad = pilotCandidateProblem(a.client);
  if (bad) return { error: `${bad[0].toUpperCase()}${bad.slice(1)}. Nothing was changed.` };
  const ops = opsList(a.ops);
  const p = cur.pilot;
  const listed = !!p?.clientIds.includes(a.client.id);
  const had = p && listed ? pilotOpsFor(p, a.client.id) : [];
  const allowing = ops.some((op) => !had.includes(op));
  if (allowing && p && p.clientIds.length && pilotState(p, a.now) === "EXPIRED") {
    return { error: `The named-client list ended after ${pilotLastDay(p.expiresAt)}. Change or remove its end date in Settings → Who the program may reach first. Nothing was changed.` };
  }
  const reachingBefore = cur.mode === "ALL" || (cur.mode === "PILOT" && !!p && pilotState(p, a.now) === "ACTIVE");
  // This change would switch the named list on: anybody else with something
  // on file would come back with it. Refuse, unless asked to turn them off.
  const wakes = allowing && !reachingBefore;
  const othersOnFile = wakes && p ? p.clientIds.filter((id) => id !== a.client.id && pilotOpsFor(p, id).some((op) => pilotGroupOf(op) !== null)) : [];
  if (othersOnFile.length && !a.onlyThisClient) {
    return {
      error: `${othersOnFile.length === 1 ? "Another client still has" : `${othersOnFile.length} other clients still have`} choices on file, and this change would turn them back on as well. Nothing was changed.`,
      othersOnFile,
    };
  }
  const clientIds = ops.length
    ? listed ? [...p!.clientIds] : [...(p?.clientIds ?? []), a.client.id]
    : (p?.clientIds ?? []).filter((id) => id !== a.client.id);
  if (clientIds.length > PROGRAM_PILOT_MAX) return { error: `The named list already has ${clientIds.length - 1} clients, the most it may have is ${PROGRAM_PILOT_MAX}. Nothing was changed.` };
  const clientOps: Record<string, ProgramReachOp[]> = {};
  for (const id of clientIds) {
    if (id === a.client.id) clientOps[id] = ops;
    else if (wakes) clientOps[id] = []; // set to nothing: never widened by this change
    else if (p && hasOwnOps(p, id)) clientOps[id] = [...p.clientOps![id]];
  }
  const mode: RolloutMode = cur.mode === "TEST_ONLY" && allowing ? "PILOT" : cur.mode;
  if (!clientIds.length) return { ...cur, mode, pilot: null };
  return {
    ...cur,
    mode,
    pilot: {
      clientIds,
      operations: p ? [...p.operations] : [],
      approvedBy: allowing ? a.by : p?.approvedBy ?? null,
      approvedAt: allowing ? a.now.toISOString() : p?.approvedAt ?? null,
      expiresAt: p?.expiresAt ?? null,
      note: p?.note ?? null,
      joinedAt: { ...(p?.joinedAt ?? {}) },
      ...(p?.groupSince ? { groupSince: { ...p.groupSince } } : {}),
      clientOps,
      ...(p?.clientOpsSince ? { clientOpsSince: { ...p.clientOpsSince } } : {}),
    },
  };
}

/**
 * What ONE client is allowed right now, op by op, for the onboarding page:
 * TEST clients get everything (always in scope); a real client gets what
 * their own list (or the shared list) carries — whatever the mode or the
 * pilot's state, which the page says separately. Pure.
 */
export function clientAllowedOps(rollout: ProgramRollout, client: { id: string; name: string | null }): ProgramReachOp[] {
  if (isSyntheticClientRow({ id: client.id, name: client.name })) return PROGRAM_REACH_OPS.filter((op) => pilotGroupOf(op) !== null);
  const p = rollout.pilot;
  if (!p || !p.clientIds.includes(client.id)) return [];
  return pilotOpsFor(p, client.id).filter((op) => pilotGroupOf(op) !== null);
}

// ---- the hub-write pilot (Jordan's Sep 28 rule) ---------------------------

/**
 * The program pilot, as the HubPilot hubWritePermit.ts evaluates for one
 * switch. null in TEST_ONLY (no real client is written for). In PILOT and in
 * ALL it is the NAMED pilot only (see the header). Its operations are every
 * operation of the switch when "bookings" (hub_writes) is ticked, else none —
 * so pilotProblem answers "does not include …" for a pilot client without it.
 */
export function programPilotAsHubPilot(rollout: ProgramRollout, switchKey: HubWriteSwitch): HubPilot | null {
  const p = rollout.pilot;
  if (rollout.mode === "TEST_ONLY" || !p) return null;
  // PER CLIENT (Oct 5 2026). HubPilot has one operations list for all its
  // clients, so with per-client choices it names only the clients whose own
  // list (or the shared one) carries bookings — anyone else on the program
  // list is "not in the program pilot" for writes, which is the same answer.
  // With nobody booked it keeps every name and no operations, so the refusal
  // still reads "does not include bookings".
  const booked = pilotCarriers(p, "hub_writes");
  return {
    clientIds: booked.length ? booked : [...p.clientIds],
    operations: booked.length ? HUB_WRITE_OPERATION_GROUPS[switchKey].flatMap((g) => g.operations) : [],
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    expiresAt: p.expiresAt,
    note: p.note,
  };
}

/** A switch's scope config with its pilot replaced by the program pilot; the fixture list untouched. */
export function withProgramPilot(config: HubWriteScopeConfig, rollout: ProgramRollout, switchKey: HubWriteSwitch): HubWriteScopeConfig {
  return { authorizedFixtureClientIds: [...config.authorizedFixtureClientIds], pilot: programPilotAsHubPilot(rollout, switchKey) };
}

// ---- the one line readiness and Settings show -----------------------------

/**
 * The scope for one op in one sentence, plus whether it admits any real
 * client. It says "every client" ONLY in mode ALL without the feature lock.
 * `testNames` are the TEST clients with a program; `names` maps client id →
 * name for the pilot.
 */
export function describeProgramScope(a: {
  rollout: ProgramRollout;
  op: ProgramReachOp;
  featureTestOnly: boolean;
  testNames: string[];
  names: Map<string, string>;
  now: Date;
  problem?: string | null;
}): { line: string; realClients: boolean; pilotNames: string[]; pilotState: PilotState } {
  const { rollout, op, now } = a;
  const ps = pilotState(rollout.pilot, now);
  const pilotNames = (rollout.pilot?.clientIds ?? []).map((id) => a.names.get(id) ?? `${id} (not found)`);
  const tests = `TEST clients (${a.testNames.length ? a.testNames.join(", ") : "none yet"})`;
  const only = (why: string) => ({ line: `${tests} only — ${why}`, realClients: false, pilotNames, pilotState: ps });
  if (a.problem) return only(`the stored rollout could not be read: ${a.problem}`);
  if (a.featureTestOnly) return only(`${lockSentence(op)}${rollout.mode === "TEST_ONLY" ? ", and the rollout is set to TEST only" : ""}`);
  if (rollout.mode === "ALL") return { line: "every client with a program (rollout: everyone)", realClients: true, pilotNames, pilotState: ps };
  if (rollout.mode === "TEST_ONLY") return only("the rollout is set to TEST only");
  const p = rollout.pilot;
  if (ps === "NONE" || !p) return only("the rollout is set to a pilot, but no pilot client is named yet");
  if (ps === "UNAPPROVED") return only("the pilot has no recorded approval, so it covers nobody");
  if (ps === "EXPIRED") return only(`the pilot ended after ${pilotLastDay(p.expiresAt)}`);
  // Per client (Oct 5 2026): the clients this op actually reaches. Without
  // per-client choices that is the whole list or nobody, exactly as before.
  const carriers = pilotCarriers(p, op);
  if (!carriers.length) {
    const g = pilotGroupOf(op);
    return only(g ? (p.clientOps ? `no named client has "${g.label}" turned on` : `the pilot does not include "${g.label}"`) : `${op} is never part of a pilot`);
  }
  const reached = carriers.map((id) => a.names.get(id) ?? `${id} (not found)`);
  const approval = `approved by ${p.approvedBy} ${etDay(p.approvedAt)}${p.expiresAt ? `, through ${pilotLastDay(p.expiresAt)}` : ""}`;
  return { line: `${tests} + pilot: ${reached.join(", ")} (${approval})`, realClients: true, pilotNames: p.clientOps ? reached : pilotNames, pilotState: ps };
}

/**
 * Would the pilot editor refuse this row as a pilot client? Every TEST-named
 * row is refused; a never-synthetic row renamed TEST gets "fix the name". The
 * one rule builder B's add action and updateProgramRollout's backstop share.
 */
export function pilotCandidateProblem(client: { id: string; name: string | null }): string | null {
  if (!isTestClientName(client.name)) return null;
  return isNeverSyntheticClientId(client.id)
    ? `"${client.name}" is a real client whose name carries the word TEST — fix the name first; a TEST name is never put in the pilot`
    : `"${client.name}" is a TEST client — TEST clients are always in the rollout and are never named in the pilot`;
}
