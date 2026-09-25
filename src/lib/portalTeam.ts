import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";
import type { PortalViewer } from "@/lib/portal";
import {
  can, actorLabel, refusalMessage, isPortalRole, grantProgramAccess, setMembershipRole, revokeMembership, owedAccessFor, cancelOwedAccess,
  portalLoginEmailEnabled,
} from "@/lib/portalAccess";
import { isAutomationEnabled } from "@/lib/programAutomation";

// ===========================================================================
// THE CLIENT'S OWN TEAM (F19 / §4.9-4.10, Sep 21 2026; moved here CP-06,
// Sep 24 2026 so the Settings page and the drills call the same code the
// actions do — src/app/portal/actions.ts keeps thin wrappers).
//
// "The client can invite an assistant/teammate by name and email. Send that
// person their own sign-in path. They have full program access for this client
// … All actions identify the actual person."
//
// Everything below runs through the same four steps as every portal action:
// resolve WHO is asking (the caller hands us the viewer), check they MAY
// (manageTeam, which only an OWNER seat holds — and never the shared link,
// because a forwarded link has no author to attribute an invitation to), prove
// the row belongs to THIS enrollment, then write. A seat is scoped to one
// enrollmentId, so "full program access" is still access to one client's
// program: the resolver reads memberships per request and refuses anything
// else (src/lib/portal.ts), and nothing on the portal renders internal staff
// notes, payroll or billing.
//
// WHILE LAUNCH IS NOT AUTHORISED nothing here reaches an inbox. The invitation
// is composed and the seat is HELD: grantProgramAccess creates no ClientUser,
// no ClientMembership and no outbox row while `portal_invites` is off, and
// records the debt so the whole queue can be granted in one pass when Jordan
// turns it on. The client is told the truth ("we'll send it the moment we
// switch invitations on"), not a fiction — and since CP-06 the held person is
// LISTED on the page (teamSeats) and can be taken back (cancelHeldTeammate);
// before, they vanished on reload and could not be revoked.
// ===========================================================================

type R = { ok: boolean; message: string };
const fail = (m: string): R => ({ ok: false, message: m });

export type TeamSeat = {
  /** The membership id, or `held:<email>` for an invitation not yet sent. */
  seatKey: string;
  membershipId: string | null;
  email: string;
  name: string | null;
  role: "OWNER" | "COLLABORATOR" | "VIEWER";
  invitedAtISO: string;
  acceptedAtISO: string | null;
  lastSignInISO: string | null;
  isYou: boolean;
  pending: boolean; // invited, never signed in
  /** Saved, but nothing has been sent: invitations are switched off (portal_invites). */
  held: boolean;
  /** The paying client's own seat: only they, or the office, can change or remove it. */
  accountHolder: boolean;
};

async function ownerBell(kind: string, title: string, body: string, href: string, dedupeKey: string) {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({ kind, title, body, href, targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey });
  } catch { /* bell is best-effort */ }
}

/** Who is on this account, for the Settings screen: live seats, then held invitations. */
export async function teamSeats(v: PortalViewer): Promise<{ ok: boolean; message: string; seats: TeamSeat[]; invitationsOn: boolean; signInEmailOn: boolean }> {
  if (!can(v, "manageTeam")) return { ok: false, message: refusalMessage(v, "manageTeam"), seats: [], invitationsOn: false, signInEmailOn: false };
  const rows = await prisma.clientMembership.findMany({
    where: { enrollmentId: v.enrollment.id, revokedAt: null },
    orderBy: { invitedAt: "asc" },
    select: { id: true, clientUserId: true, role: true, invitedAt: true, acceptedAt: true },
  });
  const users = rows.length
    ? await prisma.clientUser.findMany({ where: { id: { in: rows.map((r) => r.clientUserId) } }, select: { id: true, email: true, name: true, lastLoginAt: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const me = v.actor.kind === "CLIENT" ? v.actor.clientUserId : null;
  const holders = await accountHolderSeatIds(v.enrollment.id);
  const seats: TeamSeat[] = rows.map((r) => {
    const u = byId.get(r.clientUserId);
    return {
      seatKey: r.id, membershipId: r.id,
      email: u?.email ?? "",
      name: u?.name ?? null,
      role: isPortalRole(r.role) ? r.role : "VIEWER",
      invitedAtISO: r.invitedAt.toISOString(),
      acceptedAtISO: r.acceptedAt ? r.acceptedAt.toISOString() : null,
      lastSignInISO: u?.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      isYou: !!me && r.clientUserId === me,
      pending: !r.acceptedAt,
      held: false,
      accountHolder: holders.has(r.id),
    };
  });
  // Held teammates only — the payer's own held "welcome" is the account itself,
  // not someone they added, and it is not theirs to cancel.
  const seated = new Set(seats.map((s) => s.email.toLowerCase()));
  for (const o of await owedAccessFor(v.enrollment.id)) {
    if (o.reason !== "teammate" || seated.has(o.email.toLowerCase())) continue;
    seats.push({
      seatKey: `held:${o.email}`, membershipId: null, email: o.email, name: o.name, role: isPortalRole(o.role) ? o.role : "OWNER",
      invitedAtISO: o.since, acceptedAtISO: null, lastSignInISO: null, isYou: false, pending: true, held: true, accountHolder: false,
    });
  }
  return { ok: true, message: "", seats, invitationsOn: await isAutomationEnabled("portal_invites"), signInEmailOn: await portalLoginEmailEnabled().catch(() => false) };
}

/**
 * Invite an assistant BY NAME AND EMAIL (§4.9). The name is required and it is
 * the person's, typed by the client — never derived from the address, which
 * §4.4 forbids outright and which would put "Klciarmella" at the top of
 * somebody's welcome email.
 *
 * The default role is OWNER because §4.9's list (scheduling, branding, topic
 * answers, script and video approvals, revisions) IS the OWNER row of the
 * permission matrix. The client may choose a narrower seat instead, and the
 * message says plainly what each one means.
 */
export async function inviteTeammate(
  v: PortalViewer,
  input: { name: string; email: string; role?: string },
): Promise<R & { membershipId?: string; held?: boolean }> {
  if (!can(v, "manageTeam")) return fail(refusalMessage(v, "manageTeam"));
  const name = clip((input.name ?? "").trim(), 120);
  if (name.length < 2) return fail("Add their name so we know who we're writing to, and so their actions show up under their own name.");
  const email = (input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That doesn't look like an email address.");
  const role = isPortalRole(input.role) ? input.role : "OWNER";

  // Already here? Say so rather than sending a second welcome.
  const existing = await prisma.clientUser.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    const seat = await prisma.clientMembership.findUnique({
      where: { clientUserId_enrollmentId: { clientUserId: existing.id, enrollmentId: v.enrollment.id } },
      select: { id: true, revokedAt: true },
    });
    if (seat && !seat.revokedAt) return { ok: true, message: `${name} already has access to this account.`, membershipId: seat.id };
    // SOMEBODY ELSE'S PERSON (Sep 21 2026). This check used to look only at the
    // caller's own enrollment, so an address belonging to a DIFFERENT client
    // fell straight through into grantProgramAccess — which is keyed on the
    // email globally and would have written this client's typed name onto that
    // other person's row. grantProgramAccess now refuses it outright; the stop
    // is repeated here so the client gets a sentence that makes sense to them
    // instead of a staff-shaped refusal.
    const elsewhere = await prisma.clientMembership.findFirst({
      where: { clientUserId: existing.id, revokedAt: null, clientId: { not: v.enrollment.clientId } },
      select: { id: true },
    });
    if (elsewhere) {
      return fail("That email address already has an account with us under a different client. Reply to any of our emails and we'll get them added to your account the right way.");
    }
  }

  const g = await grantProgramAccess({
    enrollmentId: v.enrollment.id, emailRaw: email, name, role, reason: "teammate",
    requestedBy: `portal:${actorLabel(v)}`,
  });
  if (g.outcome === "CONFLICT") return fail(g.note);
  await ownerBell(
    "portal_teammate",
    `Teammate added — ${v.enrollment.clientName || "a client"}`,
    `${actorLabel(v)} gave ${name} <${email}> ${role.toLowerCase()} access${g.outcome === "HELD" ? " (held: invitations are switched off)" : ""}.`,
    `/content/${v.enrollment.id}`,
    `portal-teammate-${v.enrollment.id}-${email}`,
  );
  if (g.outcome === "HELD") {
    return {
      ok: true, held: true,
      message: `Saved. ${name} is on your account, and we'll send their sign-in email the moment we switch invitations on. Nothing has gone to them yet.`,
    };
  }
  return {
    ok: true, membershipId: g.membershipId,
    message:
      g.welcome === "suppressed"
        ? `${name} is on your account. Invitations aren't being sent yet, so we haven't emailed them — we'll send their sign-in the moment we switch them on.`
        : role === "OWNER"
          ? `${name} is in. They can do everything you can on this account, including approving videos, and we've emailed them their sign-in link.`
          : role === "COLLABORATOR"
            ? `${name} is in. They can plan, comment and request changes, and you keep the approvals. We've emailed them their sign-in link.`
            : `${name} is in, with view-only access. We've emailed them their sign-in link.`,
  };
}

/**
 * THE ACCOUNT HOLDER'S SEAT (review, Sep 24 2026). The stops below kept a
 * client from removing THEMSELVES and the LAST owner — but an assistant given
 * the default full access is an owner too, so they could remove the paying
 * client or make them view-only, and re-granting that seat then needs staff
 * (grantProgramAccess refuses to reopen a revoked seat). Nothing on the seat
 * says who pays, so it is read from what does: the seat whose person is the
 * Stripe checkout's email for this enrollment (ProgramSignup), or — for a
 * client onboarded by hand — the enrollment's first owner seat.
 */
export async function accountHolderSeatIds(enrollmentId: string): Promise<Set<string>> {
  const seats = await prisma.clientMembership.findMany({ where: { enrollmentId, revokedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, role: true, clientUserId: true } });
  if (!seats.length) return new Set();
  const payerEmails = new Set(
    (await prisma.programSignup.findMany({ where: { enrollmentId, email: { not: null } }, select: { email: true } })).map((x) => (x.email ?? "").trim().toLowerCase()).filter(Boolean),
  );
  if (payerEmails.size) {
    const users = await prisma.clientUser.findMany({ where: { id: { in: seats.map((x) => x.clientUserId) } }, select: { id: true, email: true } });
    const payers = new Set(users.filter((u) => payerEmails.has(u.email.toLowerCase())).map((u) => u.id));
    const ids = seats.filter((x) => payers.has(x.clientUserId)).map((x) => x.id);
    if (ids.length) return new Set(ids);
  }
  const first = seats.find((x) => x.role === "OWNER");
  return new Set(first ? [first.id] : []);
}

const HOLDER_REFUSAL = "That's the account holder's own access, so only they or our office can change it. Text us and we'll help.";

async function lastOwnerSeat(enrollmentId: string, exceptId: string): Promise<boolean> {
  const others = await prisma.clientMembership.count({ where: { enrollmentId, revokedAt: null, role: "OWNER", id: { not: exceptId } } });
  return others === 0;
}

/** Change what a teammate may do. The account cannot be left with nobody who can approve. */
export async function setTeammateRole(v: PortalViewer, membershipId: string, role: string): Promise<R> {
  if (!can(v, "manageTeam")) return fail(refusalMessage(v, "manageTeam"));
  if (!isPortalRole(role)) return fail("Pick owner, collaborator or viewer.");
  const seat = await prisma.clientMembership.findFirst({
    where: { id: membershipId, enrollmentId: v.enrollment.id, revokedAt: null },
    select: { id: true, role: true, clientUserId: true },
  });
  if (!seat) return fail("That person isn't on this account.");
  // A teammate cannot narrow the account holder's access; the holder and the office can.
  if (role !== seat.role && v.actor.kind !== "STAFF" && !(v.actor.kind === "CLIENT" && seat.clientUserId === v.actor.clientUserId) && (await accountHolderSeatIds(v.enrollment.id)).has(seat.id)) {
    return fail(HOLDER_REFUSAL);
  }
  if (seat.role === "OWNER" && role !== "OWNER" && (await lastOwnerSeat(v.enrollment.id, seat.id))) {
    return fail("Someone has to be able to approve your videos. Give another person owner access first, then change this one.");
  }
  await setMembershipRole(seat.id, role);
  return { ok: true, message: "Updated." };
}

/** Remove a teammate. Immediate — the resolver re-reads seats on every request. */
export async function revokeTeammate(v: PortalViewer, membershipId: string): Promise<R> {
  if (!can(v, "manageTeam")) return fail(refusalMessage(v, "manageTeam"));
  const seat = await prisma.clientMembership.findFirst({
    where: { id: membershipId, enrollmentId: v.enrollment.id, revokedAt: null },
    select: { id: true, role: true, clientUserId: true },
  });
  if (!seat) return fail("That person isn't on this account.");
  // Two doors that must not lock behind you: your own seat, and the last one
  // that can approve. Either would leave a paying client unable to use their
  // own account, and only staff could undo it.
  if (v.actor.kind === "CLIENT" && seat.clientUserId === v.actor.clientUserId) {
    return fail("You can't remove your own access. Text us and we'll help you hand the account over.");
  }
  if (seat.role === "OWNER" && (await lastOwnerSeat(v.enrollment.id, seat.id))) {
    return fail("That's the only person who can approve videos on this account. Give someone else owner access first.");
  }
  // The third door: the paying client's seat, removed by someone they invited.
  if (v.actor.kind !== "STAFF" && (await accountHolderSeatIds(v.enrollment.id)).has(seat.id)) return fail(HOLDER_REFUSAL);
  await revokeMembership(seat.id, null);
  await ownerBell(
    "portal_teammate",
    `Teammate removed — ${v.enrollment.clientName || "a client"}`,
    `${actorLabel(v)} removed a person from the account.`,
    `/content/${v.enrollment.id}`,
    `portal-teammate-off-${seat.id}`,
  );
  return { ok: true, message: "Removed. They lose access straight away." };
}

/** Take back an invitation that is still HELD (never sent). Scoped to this enrollment by the key itself. */
export async function cancelHeldTeammate(v: PortalViewer, email: string): Promise<R> {
  if (!can(v, "manageTeam")) return fail(refusalMessage(v, "manageTeam"));
  const r = await cancelOwedAccess(v.enrollment.id, email ?? "");
  if (!r.ok) return fail(r.note);
  await ownerBell(
    "portal_teammate",
    `Held invitation cancelled — ${v.enrollment.clientName || "a client"}`,
    `${actorLabel(v)} cancelled the held invitation for ${(email ?? "").trim().toLowerCase()}.`,
    `/content/${v.enrollment.id}`,
    `portal-teammate-held-off-${v.enrollment.id}-${(email ?? "").trim().toLowerCase()}`,
  );
  return { ok: true, message: r.note };
}
