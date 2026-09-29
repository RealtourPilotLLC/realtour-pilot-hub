import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, type AutomationKey } from "@/lib/programAutomation";
import { isSyntheticClientRow, isVerifiedTestDestinationEmail, isVerifiedTestDestinationPhone } from "@/lib/testClients";
import { programReachMany, programReachWithLock, readFeatureTestOnly } from "@/lib/programRollout";
import type { ProgramReachOp, ReachDecision } from "@/lib/programRolloutCore";
import type { OutboxRow } from "@/lib/outbox";

// ---------------------------------------------------------------------------
// THE OUTBOX DISPATCH GATE for program and portal emails (R03, Sep 28 2026).
//
// WHY. Every program send path decided its audience when the message was
// CREATED. A reminder queued for a client an hour before Jordan took them out
// of the pilot, a held row a person presses Retry on, a pending row the gmail
// cron drains after a dead worker — all of them went out, because nothing
// looked again at the moment of sending. And drainPending / retryHeld skipped
// the TEST floor (refuseTestClientSend runs only in the exported wrappers), so
// a TEST client's row on a colleague's inbox could still be drained.
//
// WHAT. outbox.ts deliver() calls programDispatchGate(row) BEFORE the attempts
// fence for the six rollout kinds — program_reminder, script_share,
// strategy_ready, program_message, portal_invite, portal_login — and only for
// them: this module is imported lazily by outbox.ts, so confirmation,
// delivery, welcome, afterhours, staff and manual rows never load it and never
// read the database for it. Three checks, re-read now:
//   (a) the kind's own switch (a ':welcome' to a synthetic client at one of
//       Jordan's verified inboxes passes with portal_invites off — the one
//       pre-launch hole portalAccess.queueWelcome already documents);
//   (b) the TEST floor: a synthetic client's message must land on a verified
//       test destination;
//   (c) the scope: programReach with the feature's own lock
//       (featureTestOnlyFor); a portal_invite must also still name a live seat
//       on that client; a portal_login (no clientId) needs at least one live
//       seat whose client passes portal_login_email.
// A refusal is a verdict, never a throw: deliver() writes the row failed
// ("refused before send: …") and releases its identity, so nothing is sent.
//
// THE CODES, and what a caller should do with each:
//   switched_off / not_in_rollout_scope / launch_not_authorised /
//   test_client_real_address / seat_mismatch → a decision: write SUPPRESSED
//       (or HELD), never retry.
//   gate_error → the gate could not decide (a database error, an unreadable
//       scope): nothing was sent, and it is safe to try again later — a
//       transient read failure should not permanently suppress a reminder.
//       That includes the feature's own LOCK (review fix, Sep 28 2026): a
//       failed lock read used to arrive here as "the lock is on" and leave as
//       launch_not_authorised, a decision recordSendResult suppresses for
//       good. It is read with readFeatureTestOnly now, and "error" is
//       gate_error.
// ---------------------------------------------------------------------------

export type GateCode = "switched_off" | "not_in_rollout_scope" | "launch_not_authorised" | "test_client_real_address" | "seat_mismatch" | "gate_error";
export type GateVerdict = { ok: true } | { ok: false; code: GateCode; reason: string };

type RolloutKind = "program_reminder" | "script_share" | "strategy_ready" | "program_message" | "portal_invite" | "portal_login";

/** Each rollout kind's switch and scope operation. */
const KIND: Record<RolloutKind, { switchKey: AutomationKey; op: ProgramReachOp }> = {
  program_reminder: { switchKey: "reminders", op: "reminders" },
  script_share: { switchKey: "script_share_email", op: "script_share_email" },
  strategy_ready: { switchKey: "script_share_email", op: "script_share_email" },
  program_message: { switchKey: "program_message_notice", op: "program_message_notice" },
  portal_invite: { switchKey: "portal_invites", op: "portal_invites" },
  portal_login: { switchKey: "portal_login_email", op: "portal_login_email" },
};

// The kind is the dedupeKey's first segment (outbox.outboxKind). Parsed here
// rather than imported so this module and outbox.ts never import each other's
// values (outbox.ts imports this one lazily).
const segments = (key: string | null): string[] => (key ?? "").split(":");
const kindOf = (key: string | null): RolloutKind | null => {
  const head = segments(key)[0];
  return Object.prototype.hasOwnProperty.call(KIND, head) ? (head as RolloutKind) : null;
};

const refuse = (code: GateCode, reason: string): GateVerdict => ({ ok: false, code, reason });
const verifiedDestination = (row: Pick<OutboxRow, "channel" | "toRef">): boolean =>
  row.channel === "email" ? isVerifiedTestDestinationEmail(row.toRef) : isVerifiedTestDestinationPhone(row.toRef);
const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A scope refusal, in the gate's codes. An unreadable scope is gate_error (retry later), not a decision. */
function fromReach(d: Exclude<ReachDecision, { ok: true }>): GateVerdict {
  if (d.code === "scope_unreadable") return refuse("gate_error", d.reason);
  if (d.code === "feature_test_only") return refuse("launch_not_authorised", d.reason);
  return refuse("not_in_rollout_scope", d.reason);
}

/** May this outbox row be sent now? Never throws. */
export async function programDispatchGate(row: OutboxRow): Promise<GateVerdict> {
  try {
    const kind = kindOf(row.dedupeKey);
    if (!kind) return { ok: true }; // not a rollout kind: outbox.ts never asks, and the gate has nothing to say
    return kind === "portal_login" ? await loginGate(row) : await clientGate(row, kind);
  } catch (e) {
    return refuse("gate_error", `the send could not be checked (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200)}), so it was not sent`);
  }
}

/** Every rollout kind that carries a clientId. */
async function clientGate(row: OutboxRow, kind: Exclude<RolloutKind, "portal_login">): Promise<GateVerdict> {
  const { switchKey, op } = KIND[kind];
  if (!row.clientId) return refuse("not_in_rollout_scope", "the message names no client, so the rollout cannot admit it");
  const client = await prisma.client.findUnique({ where: { id: row.clientId }, select: { id: true, name: true } });
  if (!client) return refuse("not_in_rollout_scope", "the client no longer exists");
  const synthetic = isSyntheticClientRow(client);
  const verified = verifiedDestination(row);

  // (a) the switch.
  if (!(await isAutomationEnabled(switchKey))) {
    const selfWelcome = kind === "portal_invite" && segments(row.dedupeKey)[2] === "welcome" && synthetic && verified;
    if (!selfWelcome) return refuse("switched_off", `${switchKey} is switched off`);
  }
  // (b) the TEST floor.
  if (synthetic && !verified) return refuse("test_client_real_address", "a TEST client may only be emailed at one of Jordan's verified test inboxes");
  // (c) a portal invitation still names a live seat on THIS client, for THIS person.
  if (kind === "portal_invite") {
    const seat = await liveSeat(segments(row.dedupeKey)[1] ?? "");
    if (!seat || seat.clientId !== row.clientId) return refuse("seat_mismatch", "the invitation's seat is revoked, gone, or on another client");
    if (!sameEmail(seat.email, row.toRef)) return refuse("seat_mismatch", "the invitation's address is not the seat holder's");
  }
  // (c) the scope, with the feature's own lock (a failed lock read is
  // scope_unreadable → gate_error, never feature_test_only).
  const d = await programReachWithLock(op, row.clientId);
  return d.ok ? { ok: true } : fromReach(d);
}

/** One seat, live the way portal.liveMemberships means it: not revoked, the program's access not revoked, and the seat's client the program's. */
async function liveSeat(membershipId: string): Promise<{ clientId: string; email: string | null } | null> {
  if (!membershipId) return null;
  const m = await prisma.clientMembership.findUnique({ where: { id: membershipId }, select: { clientId: true, enrollmentId: true, revokedAt: true, clientUserId: true } });
  if (!m || m.revokedAt) return null;
  const [e, person] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { clientId: true, accessRevokedAt: true } }),
    prisma.clientUser.findUnique({ where: { id: m.clientUserId }, select: { email: true, status: true } }),
  ]);
  if (!e || e.accessRevokedAt || e.clientId !== m.clientId || !person || person.status === "DISABLED") return null;
  return { clientId: m.clientId, email: person.email };
}

/**
 * A sign-in link has no clientId (portalAccess.requestLoginLink): the person
 * is key segment 2. It may go when at least one of their live seats is on a
 * client portal_login_email reaches — and, if that client is TEST, the
 * address is a verified test inbox.
 */
async function loginGate(row: OutboxRow): Promise<GateVerdict> {
  const personId = segments(row.dedupeKey)[1] ?? "";
  const person = personId ? await prisma.clientUser.findUnique({ where: { id: personId }, select: { email: true, status: true } }) : null;
  if (!person || person.status === "DISABLED") return refuse("seat_mismatch", "the person asking to sign in no longer has an account");
  if (!sameEmail(person.email, row.toRef)) return refuse("seat_mismatch", "the sign-in link's address is not the account's");
  if (!(await isAutomationEnabled("portal_login_email"))) return refuse("switched_off", "portal_login_email is switched off");

  const seats = await prisma.clientMembership.findMany({ where: { clientUserId: personId, revokedAt: null }, select: { enrollmentId: true, clientId: true } });
  const enrollments = seats.length
    ? await prisma.contentEnrollment.findMany({ where: { id: { in: seats.map((s) => s.enrollmentId) }, accessRevokedAt: null }, select: { id: true, clientId: true } })
    : [];
  const live = seats.filter((s) => enrollments.some((e) => e.id === s.enrollmentId && e.clientId === s.clientId));
  if (!live.length) return refuse("seat_mismatch", "the person has no live seat on any program");

  const op: ProgramReachOp = "portal_login_email";
  const lock = await readFeatureTestOnly(op);
  if (lock === "error") return refuse("gate_error", "the sign-in email's own lock could not be read just now, so it was not sent");
  const decisions = await programReachMany(op, live.map((s) => s.clientId), { featureTestOnly: lock });
  const verified = verifiedDestination(row);
  let testOnRealAddress = false;
  let firstRefusal: Exclude<ReachDecision, { ok: true }> | null = null;
  for (const s of live) {
    const d = decisions.get(s.clientId);
    if (!d) continue;
    if (d.ok) {
      if (d.tier !== "TEST" || verified) return { ok: true };
      testOnRealAddress = true;
    } else if (!firstRefusal || firstRefusal.code === "scope_unreadable") {
      firstRefusal = d;
    }
  }
  if (testOnRealAddress) return refuse("test_client_real_address", "the only seat the rollout admits is on a TEST client, and this is not one of Jordan's verified test inboxes");
  return firstRefusal ? fromReach(firstRefusal) : refuse("not_in_rollout_scope", "no seat of this person is in the rollout scope");
}
