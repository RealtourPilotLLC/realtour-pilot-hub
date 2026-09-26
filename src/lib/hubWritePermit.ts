// ---------------------------------------------------------------------------
// HUB WRITE SCOPES — FIXTURE and PILOT (R02 / A26, unified handoff Sep 25 2026).
//
// Every hub-initiated provider write (an Aryeo order, appointment or address;
// a Calendly invitee) is decided by ONE rule set, and this file is that rule
// set, pure, so the Aryeo guard (integrations/aryeo.ts hubWritePermit), the
// Calendly guard (lib/callBooking.ts), the settings screen, the CP-15 probe
// and a drill all read the same answer.
//
// WHAT WAS WRONG. The Aryeo guard asserted "TEST client" unconditionally, so a
// real client could only ever be written for by renaming them TEST — the one
// thing §6.6 forbids ("Add production pilot permission explicitly rather than
// renaming real clients TEST or deleting guards"). There was no way to run an
// approved pilot at all, and nothing to stop a real row that was renamed.
//
// THE RULES, in order (each switch's configJson carries the lists):
//   1. the switch is off (a missing row is off)                → refuse
//   2. the client's name says TEST:
//        · a never-synthetic id (a real row renamed)            → refuse
//        · not in authorizedFixtureClientIds                    → refuse
//        · the caller then proves the fixture's identity (both inboxes are the
//          verified test inbox, testClients.assertFixtureIdentity)
//                                                               → FIXTURE
//   3. a real client:
//        · listed as a FIXTURE (a real row on the fixture list) → refuse
//        · no pilot, not in it, the operation not in it, no approver, or
//          expired                                              → refuse
//                                                               → PILOT
// A FIXTURE decision is providerWriteDecision({ sandbox: true }) — "this is a
// disposable test record"; a PILOT decision is sandbox:false, always, because
// it is a real client's real booking and must never be dressed up as a test.
//
// The pilot lists are EMPTY and every switch is off. Turning a pilot on is
// Jordan's launch decision, made on Settings → Automations by the owner, who
// types the client's name to confirm and is recorded in the audit log.
// ---------------------------------------------------------------------------

/** The switches whose writes are scoped by this file. */
export const HUB_WRITE_SWITCHES = ["session_booking", "address_sync", "call_booking"] as const;
export type HubWriteSwitch = (typeof HUB_WRITE_SWITCHES)[number];
export const isHubWriteSwitch = (k: unknown): k is HubWriteSwitch => typeof k === "string" && (HUB_WRITE_SWITCHES as readonly string[]).includes(k);

export type PermitScope = "FIXTURE" | "PILOT";

/** An approved production pilot for one switch: which real clients, which writes, who said so, until when. */
export type HubPilot = {
  clientIds: string[];
  operations: string[];
  approvedBy: string | null;
  /** ISO. */
  approvedAt: string | null;
  /** ISO, or null for "until turned off". */
  expiresAt: string | null;
  note: string | null;
};

export type HubWriteScopeConfig = {
  authorizedFixtureClientIds: string[];
  pilot: HubPilot | null;
};

/**
 * The writes each switch can make, grouped the way the owner approves them.
 * The operation strings are exactly what the write functions check their
 * permit against (AryeoBooking.* / calendly createInvitee, cancelScheduledEvent).
 */
export const HUB_WRITE_OPERATION_GROUPS: Record<HubWriteSwitch, { key: string; label: string; operations: string[] }[]> = {
  session_booking: [
    // appointments.schedule is the Aryeo-decides travel adapter's write (W02).
    { key: "book", label: "Book new filming sessions", operations: ["addresses.create", "orders.create", "appointments.store", "appointments.schedule"] },
    { key: "cancel", label: "Cancel a session the hub booked", operations: ["appointments.cancel"] },
    { key: "reschedule", label: "Move a session the hub booked", operations: ["appointments.reschedule"] },
  ],
  address_sync: [
    { key: "address", label: "Update a session's exact address in Aryeo", operations: ["addresses.patch"] },
  ],
  call_booking: [
    { key: "book_call", label: "Book the strategy call through Calendly", operations: ["invitees.create"] },
    { key: "cancel_call", label: "Cancel a call the hub booked", operations: ["scheduled_events.cancel"] },
  ],
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))] : []);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);

/** The scope part of a switch's configJson, read tolerantly: anything unreadable is "nobody". */
export function parseHubWriteConfig(raw: unknown): HubWriteScopeConfig {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const p = o.pilot && typeof o.pilot === "object" && !Array.isArray(o.pilot) ? (o.pilot as Record<string, unknown>) : null;
  return {
    authorizedFixtureClientIds: strings(o.authorizedFixtureClientIds),
    pilot: p
      ? {
          clientIds: strings(p.clientIds),
          operations: strings(p.operations),
          approvedBy: textOrNull(p.approvedBy),
          approvedAt: isoOrNull(p.approvedAt),
          expiresAt: isoOrNull(p.expiresAt),
          note: textOrNull(p.note),
        }
      : null,
  };
}

export type PilotState = "NONE" | "ACTIVE" | "EXPIRED" | "UNAPPROVED";

/** Where a switch's pilot stands, as a whole. */
export function pilotState(pilot: HubPilot | null, now: Date): PilotState {
  if (!pilot || pilot.clientIds.length === 0) return "NONE";
  if (!pilot.approvedBy || !pilot.approvedAt) return "UNAPPROVED";
  if (pilot.expiresAt && Date.parse(pilot.expiresAt) <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

/** Why this pilot does not cover this client and operation, or null when it does. */
export function pilotProblem(switchKey: HubWriteSwitch, pilot: HubPilot | null, clientId: string, operation: string, now: Date): string | null {
  if (!pilot || !pilot.clientIds.includes(clientId)) {
    return `this client is not in an approved ${switchKey} pilot, so the hub does not write to the provider for it (Kyle books it by hand)`;
  }
  const state = pilotState(pilot, now);
  if (state === "UNAPPROVED") return `the ${switchKey} pilot has no recorded approval (approvedBy/approvedAt), so it covers nobody`;
  if (state === "EXPIRED") return `the ${switchKey} pilot expired ${pilot.expiresAt}, so the hub no longer writes for its clients`;
  if (!pilot.operations.includes(operation)) return `the ${switchKey} pilot does not include ${operation} for this client`;
  return null;
}

export type ScopeRoute =
  | { kind: "REFUSE"; reason: string }
  /** A TEST fixture on the list — the caller must still prove its identity. */
  | { kind: "FIXTURE" }
  | { kind: "PILOT" };

/**
 * Rules 2 and 3 above, for a client row the caller has READ (not the name a
 * caller passed in). Rule 1 (the switch) is the caller's, because only it
 * knows whether the row exists. Pure.
 */
export function routeHubWrite(a: {
  switchKey: HubWriteSwitch;
  config: HubWriteScopeConfig;
  client: { id: string; name: string | null };
  operation: string;
  now: Date;
  /** testClients' two predicates, passed in so this module stays import-free for the client bundle. */
  isTestName: (name: string | null | undefined) => boolean;
  isNeverSynthetic: (id: string | null | undefined) => boolean;
}): ScopeRoute {
  const { switchKey, config, client, operation, now } = a;
  const listedFixture = config.authorizedFixtureClientIds.includes(client.id);
  if (a.isTestName(client.name)) {
    if (a.isNeverSynthetic(client.id)) {
      return { kind: "REFUSE", reason: `client ${client.id} is a real client on the never-synthetic list; a TEST name on it does not make it writable` };
    }
    if (!listedFixture) {
      return { kind: "REFUSE", reason: `this client is not in ${switchKey}'s authorizedFixtureClientIds, so the hub does not write to the provider for it` };
    }
    return { kind: "FIXTURE" };
  }
  if (listedFixture) {
    return { kind: "REFUSE", reason: `this is a real client, but it is on ${switchKey}'s fixture list (authorizedFixtureClientIds) — a real client is written for only through an approved pilot, so the entry is refused as a misconfiguration` };
  }
  const p = pilotProblem(switchKey, config.pilot, client.id, operation, now);
  return p ? { kind: "REFUSE", reason: p } : { kind: "PILOT" };
}

/** One line per switch for the settings screen and the CP-15 probe. `names` maps client id → name. */
export function describeHubWriteScope(
  switchKey: HubWriteSwitch,
  s: { enabled: boolean; missing: boolean; config: HubWriteScopeConfig },
  names: Map<string, string>,
  now: Date,
): { headline: string; fixtures: string; pilot: string; pilotState: PilotState } {
  const who = (ids: string[]) => (ids.length ? ids.map((id) => names.get(id) ?? `${id} (not found)`).join(", ") : "none");
  const ps = pilotState(s.config.pilot, now);
  const p = s.config.pilot;
  const pilot =
    ps === "NONE"
      ? "no pilot — no real client is written for"
      : `${ps.toLowerCase()} · ${who(p!.clientIds)} · ${p!.operations.join(", ") || "no operations"}${p!.approvedBy ? ` · approved by ${p!.approvedBy}${p!.approvedAt ? ` ${p!.approvedAt.slice(0, 10)}` : ""}` : ""}${p!.expiresAt ? ` · until ${p!.expiresAt.slice(0, 10)}` : ""}`;
  const headline = !s.enabled
    ? `${s.missing ? "never configured" : "off"} — no hub writes for anyone, whatever the lists say`
    : ps === "ACTIVE"
      ? "on — TEST fixtures and the approved pilot"
      : "on — TEST fixtures only";
  return { headline, fixtures: who(s.config.authorizedFixtureClientIds), pilot, pilotState: ps };
}
