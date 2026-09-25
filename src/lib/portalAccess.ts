import "server-only";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isTestClientName, isStaffControlledEmail, isVerifiedTestDestinationEmail } from "@/lib/testClients";
import { liveMemberships, type PortalRole, type PortalViewer } from "@/lib/portal";

// ---------------------------------------------------------------------------
// PORTAL ACCESS — who may do what on a client's portal, and the staff-side
// operations that grant, revoke and test it. Spec §2.
//
// LAUNCH IS NOT AUTHORISED (Jordan, Sep 16). Two ProgramAutomation switches —
// `portal_invites` and `portal_login_email` — stay OFF, and this file is where
// that is enforced, not in the UI:
//   · while `portal_invites` is off, a seat may only be created on a TEST
//     client and only for a staff-controlled address, and no email is sent;
//   · while `portal_login_email` is off, a sign-in link is never emailed —
//     the request is recorded and nothing else happens — and the one link
//     staff may mint by hand (mintLoginLink) is limited to TEST clients, so a
//     real client's record can never say "signed in" because Jordan pressed a
//     button.
// Both reads go through isAutomationEnabled: a missing row is OFF.
// ---------------------------------------------------------------------------

export const PORTAL_ROLES: readonly PortalRole[] = ["OWNER", "COLLABORATOR", "VIEWER"];
export const isPortalRole = (r: unknown): r is PortalRole => typeof r === "string" && (PORTAL_ROLES as readonly string[]).includes(r);

export type PortalPermission =
  | "approveEdits" // approve a cut version (wave 2 lands the action; the gate is enforced now)
  | "requestChanges" // send a revision request on a cut
  | "editBrandProfile" // brand colours, video style, preferences, brand-kit uploads
  | "connectPublishing" // link an Instagram account (§12, disabled until credentials exist)
  | "comment" // drop a timestamped note on a cut
  | "suggest" // suggest a change to a script
  | "requestSession" // ask for a filming session
  | "manageTeam" // invite / remove the client's own assistant (§4.9-4.10)
  | "message"; // write on the program conversation (CP-13) — a VIEWER watches, so it cannot

const ALL: Record<PortalPermission, boolean> = {
  approveEdits: true, requestChanges: true, editBrandProfile: true, connectPublishing: true, comment: true, suggest: true, requestSession: true, manageTeam: true, message: true,
};
const NONE: Record<PortalPermission, boolean> = {
  approveEdits: false, requestChanges: false, editBrandProfile: false, connectPublishing: false, comment: false, suggest: false, requestSession: false, manageTeam: false, message: false,
};

/** The matrix, in one place. OWNER decides; COLLABORATOR works the month but
 *  cannot approve, reshape the brand, connect accounts or hand out seats;
 *  VIEWER watches.
 *
 *  §4.9 (Sep 21 2026) says a teammate gets "full program access for this
 *  client, including scheduling, branding, topic answers, script/video
 *  approvals, and revisions". In this three-role model that set IS the OWNER
 *  row, so a client inviting an assistant gives them an OWNER seat by default
 *  (portalInviteTeammate) and may downgrade to COLLABORATOR or VIEWER
 *  deliberately. The matrix below is NOT redefined to suit the new sentence:
 *  the staff card at src/components/portal/staff/PortalAccessControls.tsx
 *  describes COLLABORATOR to Kyle as "cannot approve or change the brand", and
 *  quietly making that sentence false is worse than an honest extra choice.
 *
 *  The consequence is stated rather than hidden: an OWNER-seat teammate can
 *  also invite further people and connect a publishing account. If Jordan
 *  wants an assistant who may approve but may not hand out keys, that is a
 *  fourth role, which is a schema change nobody has authorised. */
export const PERMISSIONS: Record<PortalRole, Record<PortalPermission, boolean>> = {
  OWNER: ALL,
  COLLABORATOR: { ...NONE, requestChanges: true, comment: true, suggest: true, requestSession: true, message: true },
  VIEWER: NONE,
};

/** The legacy link carries no person, so it may do what it could on Sep 15 —
 *  and nothing that needs a name on it: approval "records the actual person"
 *  (§8), a publishing connection is a credential, and an invitation sent from
 *  a link anyone may have forwarded has no author to attribute it to. */
const LEGACY_TOKEN: Record<PortalPermission, boolean> = { ...ALL, approveEdits: false, connectPublishing: false, manageTeam: false };

/**
 * May this viewer do this? READ_ONLY (paused/ended) and NONE refuse
 * everything: released content stays visible, no new activity. Staff acting
 * through the owner iframe carry the hub's own authority (OWNER/ADMIN), never
 * the client's seat.
 */
export function can(viewer: PortalViewer, permission: PortalPermission): boolean {
  if (viewer.access !== "FULL") return false;
  const a = viewer.actor;
  if (a.kind === "TOKEN") return LEGACY_TOKEN[permission];
  if (a.kind === "STAFF") return a.staffRole === "OWNER" || a.staffRole === "ADMIN";
  return PERMISSIONS[a.membershipRole]?.[permission] === true;
}

/** How a write is attributed in words — on the revision brief, the QC row and
 *  the editor's task. Staff are named as themselves, on the client's behalf. */
export function actorLabel(viewer: PortalViewer): string {
  const a = viewer.actor;
  const client = viewer.enrollment.clientName || "Client";
  if (a.kind === "STAFF") return `${a.staffName || "Staff"} (on behalf of ${client})`;
  if (a.kind === "CLIENT") return a.name || a.email;
  return `${client} (portal)`;
}

/** The message a refused action returns. Client-safe, and honest about WHY. */
export function refusalMessage(viewer: PortalViewer, permission: PortalPermission): string {
  if (viewer.access === "READ_ONLY") {
    return viewer.enrollment.status === "PAUSED"
      ? "Your program is paused, so this is view-only for now. Call or text Kyle at (215) 645-4889 and we'll pick it back up."
      : "Your program has ended, so this is view-only — your finished content stays here for you.";
  }
  if (viewer.actor.kind === "CLIENT" && viewer.actor.membershipRole === "VIEWER") return "Your access is view-only. Ask the program owner if you need to make changes.";
  if (permission === "approveEdits") return "Only the program owner can approve.";
  if (permission === "editBrandProfile") return "Only the program owner can change the brand profile.";
  if (permission === "connectPublishing") return "Only the program owner can connect accounts.";
  if (permission === "manageTeam") {
    return viewer.actor.kind === "TOKEN"
      ? "Sign in with your email to add someone to your account. The shared link doesn't carry a name, and every invitation records who sent it."
      : "Only the program owner can add or remove people on the account.";
  }
  return "You don't have access to do that.";
}

// ---------------------------------------------------------------------------
// One-time sign-in tokens: 32 random bytes, sha256 stored, 15 minutes, single
// use. The raw value lives in exactly two places — the URL the person opens
// and, when the switch is on, the outbox row that emails it.
// ---------------------------------------------------------------------------

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const loginUrl = (raw: string) => `${appBase()}/portal/auth/${raw}`;

async function mintToken(clientUserId: string): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);
  // One live token per person: minting again voids the previous link.
  await prisma.clientUser.update({ where: { id: clientUserId }, data: { loginTokenHash: hashToken(raw), loginTokenExpiresAt: expiresAt } });
  return { raw, expiresAt };
}

export type LoginConsumption =
  | { ok: true; clientUserId: string; email: string }
  | { ok: false; reason: "invalid" | "noaccess" };

/**
 * Consume a link. ATOMIC single use: the conditional update (hash matches AND
 * not expired) clears the hash in the same statement, so two opens of the
 * same link race for one row and exactly one wins. "invalid" covers expired,
 * used and unknown alike, without saying which.
 *
 * A person with NO live seat (every seat revoked since the email went out,
 * or the program's access revoked) is refused as "noaccess" and NOT signed
 * in: no lastLoginAt, no acceptedAt, and the caller sets no cookie — a cookie
 * that no page could honour was how the sign-in loop started (review, Sep
 * 17). The link is still burnt so it cannot be retried.
 */
export async function consumeLoginToken(raw: string): Promise<LoginConsumption> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return { ok: false, reason: "invalid" };
  const hash = hashToken(raw);
  const holder = await prisma.clientUser.findUnique({ where: { loginTokenHash: hash }, select: { id: true, email: true, status: true } });
  if (!holder || holder.status === "DISABLED") return { ok: false, reason: "invalid" };
  if ((await liveMemberships(holder.id)).length === 0) {
    await prisma.clientUser.updateMany({ where: { id: holder.id, loginTokenHash: hash }, data: { loginTokenHash: null, loginTokenExpiresAt: null } });
    return { ok: false, reason: "noaccess" };
  }
  const won = await prisma.clientUser.updateMany({
    where: { id: holder.id, loginTokenHash: hash, loginTokenExpiresAt: { gt: new Date() } },
    data: { loginTokenHash: null, loginTokenExpiresAt: null, lastLoginAt: new Date(), status: "ACTIVE" },
  });
  if (won.count !== 1) return { ok: false, reason: "invalid" };
  // The first sign-in accepts every seat this person holds that was still
  // pending — acceptance is "the actual person showed up", not a per-program
  // click.
  await prisma.clientMembership.updateMany({ where: { clientUserId: holder.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
  return { ok: true, clientUserId: holder.id, email: holder.email };
}

async function testClientOf(enrollmentId: string): Promise<{ clientId: string; name: string; isTest: boolean } | null> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return null;
  const c = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
  return { clientId: e.clientId, name: c?.name ?? "", isTest: isTestClientName(c?.name) };
}

/**
 * Give a person a seat. Creates the ClientUser (by lowercased email) if
 * needed and the membership (or re-opens a revoked one — an explicit staff
 * act, never a guess). The invitation EMAIL goes out only while
 * `portal_invites` is on; otherwise the seat exists silently and the card
 * says invitations are switched off until launch.
 */
export async function inviteClientUser(
  enrollmentId: string,
  emailRaw: string,
  nameRaw: string | null,
  role: PortalRole,
  byAppUserId: string | null,
): Promise<{ membershipId: string; clientUserId: string; emailed: boolean; note: string }> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That doesn't look like an email address.");
  if (!isPortalRole(role)) throw new Error("Pick a role: owner, collaborator or viewer.");
  const target = await testClientOf(enrollmentId);
  if (!target) throw new Error("Enrollment not found.");
  const invitesOn = await isAutomationEnabled("portal_invites");
  if (!invitesOn) {
    // Pre-launch: staff-controlled accounts on synthetic clients only. A real
    // person's inbox on a real client's program is an invitation in all but
    // the email, and Jordan has not authorised one.
    if (!target.isTest) throw new Error("Client invitations are switched off until launch is authorised. Only TEST clients can be given portal people right now.");
    if (!isStaffControlledEmail(email)) throw new Error("Until launch, portal people must use a staff-controlled @realtourpilot.com address (for example info+name@realtourpilot.com).");
  }
  const name = (nameRaw ?? "").trim().slice(0, 120) || null;
  const person = await prisma.clientUser.upsert({
    where: { email },
    create: { email, name },
    update: name ? { name } : {},
    select: { id: true },
  });
  const existing = await prisma.clientMembership.findUnique({ where: { clientUserId_enrollmentId: { clientUserId: person.id, enrollmentId } } });
  const membership = existing
    ? await prisma.clientMembership.update({
        where: { id: existing.id },
        data: { role, revokedAt: null, revokedBy: null, invitedByAppUserId: byAppUserId, invitedAt: new Date() },
        select: { id: true },
      })
    : await prisma.clientMembership.create({
        data: { clientUserId: person.id, enrollmentId, clientId: target.clientId, role, invitedByAppUserId: byAppUserId },
        select: { id: true },
      });

  if (!invitesOn) {
    return { membershipId: membership.id, clientUserId: person.id, emailed: false, note: "Seat created. No email was sent — invitations are switched off until launch." };
  }
  const { sendThroughOutbox, portalInviteKey } = await import("@/lib/outbox");
  const first = (name ?? "").split(/\s+/)[0] || "there";
  const body = [
    `Hi ${first},`,
    "",
    `You now have access to the ${target.name} content portal on RealTour Pilot — your videos, your strategy and your schedule in one place.`,
    "",
    `Sign in any time with this email address at ${appBase()}/portal/login — we'll send you a one-time link, no password to remember.`,
    "",
    "Questions? Just reply to this email.",
    "— RealTour Pilot",
  ].join("\n");
  const r = await sendThroughOutbox({
    channel: "email", toRef: email, body,
    dedupeKey: portalInviteKey(membership.id, new Date()),
    clientId: target.clientId, requestedBy: byAppUserId,
  });
  const emailed = r.outcome === "accepted";
  return {
    membershipId: membership.id, clientUserId: person.id, emailed,
    note: emailed ? "Invitation sent." : r.outcome === "unknown" ? "The invitation may have gone out — it is held on Connections for a person to confirm." : `The invitation did not send (${"error" in r ? r.error : r.outcome}). The seat exists; try again.`,
  };
}

// ---------------------------------------------------------------------------
// FROM A VERIFIED PAYMENT TO AN ACCOUNT (F02 / §4.1-4.5, Sep 21 2026)
//
// Until today activation stopped at the enrollment. Phase 0 measured the
// consequence on live data: all three verified Stripe buyers (Mike Flatley,
// Kristin Ciarmella, Arielle Roemer) had ZERO ClientMembership rows, Mike had
// no portal link at all, and no welcome had ever been composed, let alone
// sent. A client could pay $15,290 and have nowhere to sign in.
//
// `grantProgramAccess` is the one door from "Stripe says this is paid" to "this
// person has an account", and it is deliberately the SAME door a Stripe webhook
// will use when Jordan registers one (the account has zero endpoints today, so
// the hourly poll is still what calls it). It is idempotent on (enrollment,
// email): however the events arrive, repeat or race, one seat and one welcome.
//
// THE GATE HOLDS HERE, NOT IN THE UI. While `portal_invites` is off and the
// client is not synthetic, nothing is created and nothing is composed into the
// outbox: no ClientUser, no ClientMembership, no OutboxMessage. The access that
// is OWED is written to an AppSetting row instead, so the moment Jordan
// authorises rollout every paying client who arrived in the meantime can be
// granted in one pass, in payment order, with no replay of Stripe.
// ---------------------------------------------------------------------------

/** The kv row that remembers an account we owe but may not open yet. One per
 *  (enrollment, address); the value is JSON, like every other AppSetting. */
const OWED_PREFIX = "portal-access-owed:";
const owedKey = (enrollmentId: string, email: string) => `${OWED_PREFIX}${enrollmentId}:${email}`;

export type OwedAccess = {
  enrollmentId: string;
  clientId: string;
  email: string;
  /** The person's REAL name as the payment or the inviter gave it, or null.
   *  Never the email's local part: "klciarmella@gmail.com" is not "Klciarmella",
   *  and §4.4 forbids the guess outright. */
  name: string | null;
  role: PortalRole;
  reason: "welcome" | "teammate";
  since: string;
};

export type GrantOutcome =
  /** The seat exists and the welcome is queued (or was already). */
  | { outcome: "GRANTED"; membershipId: string; clientUserId: string; welcome: "queued" | "already" | "suppressed"; note: string }
  /** Launch is not authorised: nothing was created, the debt is recorded. */
  | { outcome: "HELD"; note: string }
  /** Two different people, or one person we cannot safely name. A human decides. */
  | { outcome: "CONFLICT"; note: string };

/**
 * Give the paying client (or a teammate they named) their account.
 *
 * `name` must come from a person: the Stripe checkout's `customer_details.name`,
 * the Calendly invitee name, or what the account owner typed. Passing null is
 * correct and safe — the welcome says "Hi there". Deriving one from the address
 * is not, and this function will not do it for you.
 */
export async function grantProgramAccess(input: {
  enrollmentId: string;
  emailRaw: string;
  name: string | null;
  role?: PortalRole;
  reason: "welcome" | "teammate";
  byAppUserId?: string | null;
  /** Who is credited on the email row and in the log. */
  requestedBy?: string;
}): Promise<GrantOutcome> {
  const email = input.emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { outcome: "CONFLICT", note: `"${input.emailRaw}" is not an email address we can open an account on.` };
  const role: PortalRole = input.role && isPortalRole(input.role) ? input.role : "OWNER";
  const target = await testClientOf(input.enrollmentId);
  if (!target) return { outcome: "CONFLICT", note: "Enrollment not found." };

  const invitesOn = await isAutomationEnabled("portal_invites");
  if (!invitesOn && target.isTest && !isStaffControlledEmail(email)) {
    // The same rule inviteClientUser has held since Sep 16: a synthetic client
    // with a real person's inbox on it is not synthetic. Repeated here rather
    // than inherited, because this door is opened by a PAYMENT, and a payment
    // is not a person who read the warning.
    return { outcome: "CONFLICT", note: "Until launch, portal people on a TEST client must use a staff-controlled @realtourpilot.com address." };
  }
  if (!invitesOn && !target.isTest) {
    // HELD. Record the debt (idempotent on the key) and stop. Nothing about
    // this reaches the client, and nothing about it is lost either.
    const value = JSON.stringify({
      enrollmentId: input.enrollmentId, clientId: target.clientId, email,
      name: input.name?.trim() || null, role, reason: input.reason, since: new Date().toISOString(),
    } satisfies OwedAccess);
    const key = owedKey(input.enrollmentId, email);
    await prisma.appSetting
      .upsert({ where: { key }, create: { key, value }, update: {} }) // update:{} — the FIRST time we owed it is the fact worth keeping
      .catch(() => {});
    return {
      outcome: "HELD",
      note: "Account access is held: client invitations are switched off until Jordan authorises rollout. The debt is recorded and will be granted in one pass when the switch turns on.",
    };
  }

  const name = (input.name ?? "").trim().slice(0, 120) || null;

  // THE CROSS-TENANT WRITE, CLOSED (Sep 21 2026).
  // ClientUser is keyed by email GLOBALLY — one row per address, whatever seats
  // it holds — and this door is now reachable BY A CLIENT: portalInviteTeammate
  // (src/app/portal/actions.ts) hands us an address and a name the client typed.
  // The old `update: name ? { name } : {}` wrote that name onto whatever row the
  // address already pointed at, and the only pre-check anywhere looked for a
  // seat on THIS enrollment, so an address belonging to another client fell
  // straight through. Measured read-only the same day: 3 ClientUser rows exist
  // and all 3 carry a name, so all 3 were renameable by a teammate invite sent
  // from an account they have nothing to do with.
  // Two rules now, both conservative:
  //   · an address already seated on a DIFFERENT client is not ours to rename
  //     and not ours to seat either. A person decides, and nothing is written.
  //   · an existing name is never overwritten. A blank one may be filled in,
  //     because that adds a fact rather than replacing somebody's.
  const priorPerson = await prisma.clientUser.findUnique({ where: { email }, select: { id: true, name: true } });
  if (priorPerson) {
    const elsewhere = await prisma.clientMembership.findFirst({
      where: { clientUserId: priorPerson.id, revokedAt: null, clientId: { not: target.clientId } },
      select: { id: true },
    });
    if (elsewhere) {
      return {
        outcome: "CONFLICT",
        note: `${email} already has an account with another client of ours, so we have not added it here or changed the name on it. Someone on the team needs to check with them first.`,
      };
    }
  }
  const person = priorPerson
    ? name && !priorPerson.name
      ? await prisma.clientUser.update({ where: { id: priorPerson.id }, data: { name }, select: { id: true } })
      : { id: priorPerson.id }
    : // upsert, not create: two payment events for the same new address can race
      // here, and losing that race must not lose the seat.
      await prisma.clientUser.upsert({ where: { email }, create: { email, name }, update: {}, select: { id: true } });
  const existing = await prisma.clientMembership.findUnique({ where: { clientUserId_enrollmentId: { clientUserId: person.id, enrollmentId: input.enrollmentId } }, select: { id: true, revokedAt: true } });
  // A REVOKED seat is not re-opened by a payment. Somebody took this person's
  // access away on purpose; a renewal charge is not their decision reversed.
  if (existing?.revokedAt) {
    return { outcome: "CONFLICT", note: `${email} had access to this program and it was revoked. A person should decide whether the payment restores it.` };
  }
  // createMany/skipDuplicates, then read (CP-14, Sep 24 2026): a Stripe
  // webhook and the hourly poll can reach here for the same payer at once,
  // and a plain create would throw the loser's unique violation up through
  // activateSignup as "access needs a person". ON CONFLICT DO NOTHING lets
  // both arrive at the one seat.
  if (!existing) {
    await prisma.clientMembership.createMany({
      data: [{ clientUserId: person.id, enrollmentId: input.enrollmentId, clientId: target.clientId, role, invitedByAppUserId: input.byAppUserId ?? null }],
      skipDuplicates: true,
    });
  }
  const seat = existing ?? (await prisma.clientMembership.findUnique({ where: { clientUserId_enrollmentId: { clientUserId: person.id, enrollmentId: input.enrollmentId } }, select: { id: true, revokedAt: true } }));
  if (!seat) return { outcome: "CONFLICT", note: "The seat could not be opened. Nothing was sent; the next pass tries again." };
  const membershipId = seat.id;

  const welcome = await queueWelcome({
    membershipId, email, name, clientName: target.name, clientId: target.clientId, isTestClient: target.isTest,
    reason: input.reason, requestedBy: input.requestedBy ?? input.byAppUserId ?? "program-activation",
  });
  await prisma.appSetting.deleteMany({ where: { key: owedKey(input.enrollmentId, email) } }).catch(() => {});
  return {
    outcome: "GRANTED", membershipId, clientUserId: person.id, welcome,
    note: welcome === "queued" ? "Account opened and the welcome is queued." : welcome === "already" ? "Account already open; the welcome was queued earlier." : "Account opened. The welcome is suppressed while invitations are switched off.",
  };
}

/** ONE welcome per seat, for ever. The dedupeKey carries no timestamp on
 *  purpose (portalInviteKey does, because a re-invitation is a real second
 *  message): payment webhooks repeat, the poll runs hourly, and A01 says one
 *  welcome however the events arrive. */
export const portalWelcomeKey = (membershipId: string) => `portal_invite:${membershipId}:welcome`;

async function queueWelcome(input: {
  membershipId: string; email: string; name: string | null; clientName: string; clientId: string; isTestClient: boolean;
  reason: "welcome" | "teammate"; requestedBy: string;
}): Promise<"queued" | "already" | "suppressed"> {
  // THE ONE WAY THIS EMAIL LEAVES THE BUILDING BEFORE LAUNCH (Jordan, Sep 21:
  // "Keep client invitations and new client-facing automations held until I
  // test the Jordan account and approve rollout"). He cannot approve a welcome
  // he has never received, so a SYNTHETIC client writing to JORDAN'S OWN
  // VERIFIED INBOX may send while the switch is off — that is Jordan emailing
  // himself through the real rail, not a client being contacted. Both halves
  // are re-checked here, at the moment of enqueue, not inherited from a caller.
  //
  // IT IS ONE INBOX, NOT A DOMAIN (Sep 21 2026). This test used to be
  // isStaffControlledEmail, i.e. ANY @realtourpilot.com address, and that is
  // wider than the only destination Jordan actually verified
  // (info@realtourpilot.com, with 215-534-8650 for texts). Measured read-only
  // the same day: of the four staff-controlled addresses on file, three are
  // info+…@realtourpilot.com plus-addresses that land in Jordan's own inbox and
  // the fourth is nick@realtourpilot.com — a colleague's mailbox that the old
  // rule would have put a pre-launch client welcome into. hello@ and james@ are
  // the same shape and neither is Jordan. isVerifiedTestDestinationEmail folds
  // plus-addressing away (canonicalInbox), so the test account keeps its own
  // distinct sign-in address without a second inbox.
  //
  // This is also the ONE hole in the outbox invariant documented at
  // src/lib/outbox.ts:67-72 ("nothing of these kinds is even enqueued while a
  // switch is off"). Narrowing it from a domain to a single verified inbox is
  // as close to keeping that sentence true as a testable pre-launch rail can
  // get; outbox.ts was outside this pass's files, so its parenthetical still
  // needs the matching one-line amendment.
  const allowed =
    (await isAutomationEnabled("portal_invites")) || (input.isTestClient && isVerifiedTestDestinationEmail(input.email));
  if (!allowed) return "suppressed";
  // Composed NOW, not when access was first owed: a held welcome released
  // later reads the discovery booking as it stands at that moment (CP-14).
  const body = await composeWelcomeEmail({ name: input.name, clientName: input.clientName, reason: input.reason, clientId: input.clientId });
  const { sendThroughOutbox } = await import("@/lib/outbox");
  const r = await sendThroughOutbox({
    channel: "email", toRef: input.email, body,
    dedupeKey: portalWelcomeKey(input.membershipId),
    clientId: input.clientId, requestedBy: input.requestedBy,
  });
  return r.outcome === "duplicate" ? "already" : "queued";
}

/**
 * The welcome, in Jordan's voice, composed whether or not it may be sent — so
 * the exact words can be read and approved before the gate ever opens.
 *
 * It points at the DURABLE sign-in page, never a one-time token: §4.5 asks for
 * a link that still works after the 15-minute link in some other email has
 * expired, and /portal/login mints a fresh one on request.
 */
export async function composeWelcomeEmail(input: { name: string | null; clientName: string; reason: "welcome" | "teammate"; clientId?: string | null }): Promise<string> {
  const first = (input.name ?? "").trim().split(/\s+/)[0] || "there";
  // CP-14: a client who booked discovery BEFORE the payment was polled must
  // not be told to book it (the audit's acceptance case). Only a booking the
  // matcher tied to THIS client counts — a CANDIDATE or an unverified alias is
  // not a booking we can name to them.
  const booked = input.clientId && input.reason === "welcome"
    ? await prisma.programCallRecord
        .findFirst({
          where: { clientId: input.clientId, callType: "BRAND_DISCOVERY", status: { notIn: ["CANCELLED", "RESCHEDULED"] }, matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, scheduledStart: { not: null } },
          orderBy: { scheduledStart: "desc" },
          select: { scheduledStart: true },
        })
        .catch(() => null)
    : null;
  const discovery = await prisma.programCalendlyEventMapping
    .findFirst({ where: { purpose: "BRAND_DISCOVERY", enabled: true, publicUrl: { not: null } }, select: { publicUrl: true } })
    .catch(() => null);
  // §6.1 (Sep 25 2026): a booking that MAY be theirs under another address
  // (paid from gmail, booked from the brokerage) is not one we can name to
  // them, and not one we may tell them to repeat either. The sentence below
  // covers both without saying which booking we mean.
  const maybeBooked = !booked && input.clientId && input.reason === "welcome"
    ? await import("@/lib/contentCallRecords")
        .then(({ candidateDiscoveryBookingsFor }) => candidateDiscoveryBookingsFor(input.clientId!))
        .then((rows) => rows.length > 0)
        .catch(() => false)
    : false;
  const signIn = `${appBase()}/portal/login`;
  if (input.reason === "teammate") {
    return [
      `Hi ${first},`,
      "",
      `${input.clientName} added you to their RealTour Pilot content account, so you can work the program with them: topics, scripts, filming dates, and approving the videos when they come back.`,
      "",
      `Sign in any time with this email address at ${signIn}. We send you a one time link, so there is no password to set up.`,
      "",
      "Anything you do in there shows up under your own name, so the team always knows who asked for what.",
      "",
      "If you have a question, just reply to this email and we'll pick it up.",
      "",
      "RealTour Pilot",
    ].join("\n");
  }
  return [
    `Hi ${first},`,
    "",
    "You're in, and everything for your content program now lives in one place: your strategy, your topics, your scripts, your filming dates, and every finished video ready to download.",
    "",
    `Sign in any time with this email address at ${signIn}. We send you a one time link, so there is no password to set up.`,
    "",
    "Here's the way forward:",
    booked?.scheduledStart
      ? booked.scheduledStart.getTime() > Date.now()
        ? `1. Your brand discovery call is booked for ${booked.scheduledStart.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} Eastern. That call is where we build your strategy, so bring anything you want us to know.`
        : `1. We had your brand discovery call on ${booked.scheduledStart.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric" })}, and your strategy is built from it. We'll let you know when it's ready to read.`
      : maybeBooked
        ? `1. If you've already booked your brand discovery call, you're all set and we'll confirm it with you. If not, ${discovery?.publicUrl ? `book it at ${discovery.publicUrl}` : "just reply to this email and we'll find a time"}. That call is where we build your strategy, and it only happens once.`
        : discovery?.publicUrl
          ? `1. Book your brand discovery call at ${discovery.publicUrl}. That call is where we build your strategy, and it only happens once.`
          : "1. Book your brand discovery call. That call is where we build your strategy, and it only happens once.",
    "2. Add your logo, headshot and brand colors in the portal so the editing team matches your look from the very first video.",
    "3. Pick your topics for the month, and we'll get you on the filming calendar.",
    "",
    "None of it is a test. If something looks wrong, reply to this email and we'll sort it out with you.",
    "",
    "RealTour Pilot",
  ].join("\n");
}

/** Every account we owe but have not opened, oldest debt first. The owner's
 *  /content strip reads this so "held" is visible rather than silent. */
export async function pendingProgramAccess(): Promise<OwedAccess[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: OWED_PREFIX } }, select: { value: true } });
  const out: OwedAccess[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as OwedAccess;
      if (v && typeof v.email === "string" && typeof v.enrollmentId === "string") out.push(v);
    } catch { /* a hand-edited row is not a reason to fail the page */ }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * The access owed on ONE program, oldest first (CP-06). With `portal_invites`
 * off, a real client's teammate invitation is only this AppSetting row — no
 * ClientUser, no seat — so a team page that read memberships alone lost it on
 * reload and could not take it back. The client's Settings page lists these as
 * "held" beside the live seats.
 */
export async function owedAccessFor(enrollmentId: string): Promise<OwedAccess[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: `${OWED_PREFIX}${enrollmentId}:` } }, select: { value: true } });
  const out: OwedAccess[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as OwedAccess;
      if (v && typeof v.email === "string" && v.enrollmentId === enrollmentId) out.push(v);
    } catch { /* a hand-edited row is not a reason to fail the page */ }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * Take back a HELD teammate invitation before it was ever sent. Teammate debts
 * only: the payer's own "welcome" debt is the account they paid for, and no
 * client (or client screen) may cancel it.
 */
export async function cancelOwedAccess(enrollmentId: string, emailRaw: string): Promise<{ ok: boolean; note: string }> {
  const email = emailRaw.trim().toLowerCase();
  const key = owedKey(enrollmentId, email);
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (!row) return { ok: false, note: "That invitation isn't waiting any more." };
  let reason: string | null = null;
  try { reason = (JSON.parse(row.value) as OwedAccess).reason ?? null; } catch { reason = null; }
  if (reason !== "teammate") return { ok: false, note: "That's the account owner's own access, which can't be cancelled here." };
  await prisma.appSetting.deleteMany({ where: { key } });
  return { ok: true, note: "Cancelled — nothing was ever sent to them." };
}

/**
 * Grant everything that was held, in the order it was owed. Safe to call twice:
 * `grantProgramAccess` is idempotent and clears each debt as it settles. Does
 * nothing at all while `portal_invites` is still off, so a stray call cannot
 * open the gate — only the switch can.
 */
export async function releasePendingProgramAccess(by: string | null): Promise<{ granted: number; held: number; conflicts: string[] }> {
  if (!(await isAutomationEnabled("portal_invites"))) return { granted: 0, held: (await pendingProgramAccess()).length, conflicts: [] };
  const owed = await pendingProgramAccess();
  let granted = 0;
  let held = 0;
  const conflicts: string[] = [];
  for (const o of owed) {
    const r = await grantProgramAccess({
      enrollmentId: o.enrollmentId, emailRaw: o.email, name: o.name, role: o.role, reason: o.reason,
      byAppUserId: by, requestedBy: by ?? "release-held-access",
    });
    if (r.outcome === "GRANTED") granted++;
    else if (r.outcome === "HELD") held++;
    else conflicts.push(`${o.email}: ${r.note}`);
  }
  return { granted, held, conflicts };
}

/** Take a seat away. Immediate: the resolver re-reads memberships per request. */
export async function revokeMembership(membershipId: string, byAppUserId: string | null): Promise<void> {
  const n = await prisma.clientMembership.updateMany({ where: { id: membershipId, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: byAppUserId } });
  if (n.count === 0) throw new Error("That seat is already revoked (or never existed).");
}

/** Change a seat's role. */
export async function setMembershipRole(membershipId: string, role: PortalRole): Promise<void> {
  if (!isPortalRole(role)) throw new Error("Pick a role: owner, collaborator or viewer.");
  const n = await prisma.clientMembership.updateMany({ where: { id: membershipId, revokedAt: null }, data: { role } });
  if (n.count === 0) throw new Error("That seat is revoked or doesn't exist.");
}

const newPortalToken = () => randomBytes(24).toString("base64url");

/** Mint (first time) or ROTATE the share link. The old link stops matching
 *  anything the moment this commits and renders the sign-in page. */
export async function rotatePortalToken(enrollmentId: string): Promise<{ url: string; rotated: boolean }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { portalToken: true } });
  if (!e) throw new Error("Enrollment not found.");
  const token = newPortalToken();
  const now = new Date();
  await prisma.contentEnrollment.update({
    where: { id: enrollmentId },
    data: { portalToken: token, portalTokenIssuedAt: now, ...(e.portalToken ? { portalTokenRotatedAt: now } : {}), portalTokenExpiresAt: null },
  });
  return { url: `${appBase()}/portal/${token}`, rotated: !!e.portalToken };
}

/** Put a clock on the link: 0 days = expire now; null = never (clears it). */
export async function expirePortalToken(enrollmentId: string, days: number | null): Promise<{ expiresAt: Date | null }> {
  if (days != null && (!Number.isFinite(days) || days < 0 || days > 3650)) throw new Error("Days must be between 0 and 3650.");
  const expiresAt = days == null ? null : new Date(Date.now() + days * 86_400_000);
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { portalTokenExpiresAt: expiresAt } });
  return { expiresAt };
}

/**
 * Staff mint a sign-in link and open it THEMSELVES — how sign-in is tested
 * with no email. Limited to TEST clients while `portal_login_email` is off:
 * signing in as a real client's person would write lastLoginAt/acceptedAt on
 * a real record that no real person touched.
 */
export async function mintLoginLink(membershipId: string, byAppUserId: string | null): Promise<{ url: string; expiresAt: Date }> {
  const m = await prisma.clientMembership.findUnique({ where: { id: membershipId }, select: { clientUserId: true, enrollmentId: true, revokedAt: true } });
  if (!m || m.revokedAt) throw new Error("That seat is revoked or doesn't exist.");
  const target = await testClientOf(m.enrollmentId);
  if (!target) throw new Error("Enrollment not found.");
  if (!target.isTest && !(await isAutomationEnabled("portal_login_email"))) {
    throw new Error("Sign-in links for real clients are switched off until launch is authorised. Test with a TEST client.");
  }
  const { raw, expiresAt } = await mintToken(m.clientUserId);
  console.info(`[portal] login link minted for membership ${membershipId} by ${byAppUserId ?? "unknown"} (expires ${expiresAt.toISOString()})`);
  return { url: loginUrl(raw), expiresAt };
}

/**
 * The public "email me a link" form. NEVER reveals whether the address exists:
 * every path returns void and the page says "check your inbox" regardless.
 * While `portal_login_email` is off, the request is recorded (an AppSetting
 * counter per person — the same kv the portal uses for its other counters)
 * and NOTHING is minted or enqueued: no token, no OutboxMessage.
 *
 * Throttle: while the person's previous link is still live (15 minutes), a
 * new request mints and sends nothing — the form is public, so without this
 * anyone who knows a client's address could fill their inbox from it the day
 * the switch turns on (review, Sep 17). The page says the same sentence
 * either way; the first link still works.
 */
/** Is the magic-link email actually able to go out? The sign-in screen asks so
 *  it can say "not switched on yet" instead of promising an email that
 *  `requestLoginLink` will not send (review blocker, Sep 17). */
export async function portalLoginEmailEnabled(): Promise<boolean> {
  return isAutomationEnabled("portal_login_email");
}

export async function requestLoginLink(emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const person = await prisma.clientUser.findUnique({ where: { email }, select: { id: true, name: true, status: true, loginTokenExpiresAt: true } });
  if (!person || person.status === "DISABLED") return;
  if ((await liveMemberships(person.id)).length === 0) return;

  if (!(await isAutomationEnabled("portal_login_email"))) {
    const key = `portal-login-requested:${person.id}`;
    await prisma.appSetting
      .upsert({ where: { key }, create: { key, value: `1 @ ${new Date().toISOString()}` }, update: { value: `${await nextCount(key)} @ ${new Date().toISOString()}` } })
      .catch(() => {});
    console.info(`[portal] sign-in link requested for ${person.id} — portal_login_email is off, nothing sent`);
    return;
  }

  if (person.loginTokenExpiresAt && person.loginTokenExpiresAt.getTime() > Date.now()) {
    console.info(`[portal] sign-in link requested for ${person.id} while one is still live (until ${person.loginTokenExpiresAt.toISOString()}) — not re-sent`);
    return;
  }

  const { raw, expiresAt } = await mintToken(person.id);
  const first = (person.name ?? "").split(/\s+/)[0] || "there";
  const body = [
    `Hi ${first},`,
    "",
    "Here's your one-time link to sign in to your RealTour Pilot content portal:",
    loginUrl(raw),
    "",
    "It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email — nothing changes.",
    "— RealTour Pilot",
  ].join("\n");
  const { sendThroughOutbox, portalLoginKey } = await import("@/lib/outbox");
  const r = await sendThroughOutbox({ channel: "email", toRef: email, body, dedupeKey: portalLoginKey(person.id, expiresAt), requestedBy: "portal-login" });
  if (r.outcome !== "accepted") console.warn(`[portal] sign-in link for ${person.id}: ${r.outcome}${"error" in r ? ` — ${r.error}` : ""}`);
}

async function nextCount(key: string): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } }).catch(() => null);
  const n = parseInt((row?.value ?? "0").split(" ")[0], 10);
  return (Number.isFinite(n) ? n : 0) + 1;
}

// ---------------------------------------------------------------------------
// What the staff card shows.
// ---------------------------------------------------------------------------

export type PortalAccessSummary = {
  enrollmentId: string;
  clientName: string;
  isTestClient: boolean;
  status: string;
  link: {
    issued: boolean;
    url: string | null; // owner-only surface; the card renders it behind a copy button
    issuedAt: Date | null;
    expiresAt: Date | null;
    rotatedAt: Date | null;
    expired: boolean;
  };
  accessRevokedAt: Date | null;
  people: {
    membershipId: string;
    email: string;
    name: string | null;
    role: PortalRole;
    invitedAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    lastLoginAt: Date | null;
  }[];
  lastOpened: { at: Date; via: string; who: string | null } | null;
  visits: number;
  switches: { invites: boolean; loginEmail: boolean };
};

export async function portalAccessSummary(enrollmentId: string): Promise<PortalAccessSummary | null> {
  const e = await prisma.contentEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, clientId: true, status: true, portalToken: true, portalTokenIssuedAt: true, portalTokenExpiresAt: true, portalTokenRotatedAt: true, accessRevokedAt: true },
  });
  if (!e) return null;
  const [client, seats, last, visits, invites, loginEmail] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    prisma.clientMembership.findMany({ where: { enrollmentId }, orderBy: { invitedAt: "asc" } }),
    prisma.portalVisit.findFirst({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, via: true, clientUserId: true, staffUserId: true } }),
    prisma.portalVisit.count({ where: { enrollmentId } }),
    isAutomationEnabled("portal_invites"),
    isAutomationEnabled("portal_login_email"),
  ]);
  const users = seats.length ? await prisma.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) } } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  let who: string | null = null;
  if (last?.clientUserId) who = userById.get(last.clientUserId)?.name ?? userById.get(last.clientUserId)?.email ?? null;
  else if (last?.staffUserId) who = (await prisma.appUser.findUnique({ where: { id: last.staffUserId }, select: { name: true } }))?.name ?? null;
  return {
    enrollmentId,
    clientName: client?.name ?? "",
    isTestClient: isTestClientName(client?.name),
    status: e.status,
    link: {
      issued: !!e.portalToken,
      url: e.portalToken ? `${appBase()}/portal/${e.portalToken}` : null,
      issuedAt: e.portalTokenIssuedAt,
      expiresAt: e.portalTokenExpiresAt,
      rotatedAt: e.portalTokenRotatedAt,
      expired: !!e.portalTokenExpiresAt && e.portalTokenExpiresAt.getTime() <= Date.now(),
    },
    accessRevokedAt: e.accessRevokedAt,
    people: seats.map((s) => {
      const u = userById.get(s.clientUserId);
      return {
        membershipId: s.id, email: u?.email ?? "", name: u?.name ?? null,
        role: isPortalRole(s.role) ? s.role : "VIEWER",
        invitedAt: s.invitedAt, acceptedAt: s.acceptedAt, revokedAt: s.revokedAt, lastLoginAt: u?.lastLoginAt ?? null,
      };
    }),
    lastOpened: last ? { at: last.createdAt, via: last.via, who } : null,
    visits,
    switches: { invites, loginEmail },
  };
}
