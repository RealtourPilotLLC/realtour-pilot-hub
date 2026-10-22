import "server-only";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isSyntheticClientRow, isStaffControlledEmail, isVerifiedTestDestinationEmail } from "@/lib/testClients";
import { liveMemberships, type PortalRole, type PortalViewer } from "@/lib/portal";
import { programReach, programReachMany } from "@/lib/programRollout";
import type { ReachDecision } from "@/lib/programRolloutCore";
import { OFFICE_LINE } from "@/lib/portalWords";

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
//
// AND THE ROLLOUT SCOPE (R03, Sep 28 2026). A switch being on used to mean
// "every client". Now a REAL client must also be inside the program rollout
// (lib/programRollout — TEST clients, plus the approved pilot of at most three,
// or everyone once Jordan chooses it) for every account operation here: a staff
// invitation, a payment's welcome, the release of held access, a sign-in link,
// and a signed-in session (portal.liveMemberships). A seat on an included
// client never unlocks an excluded one. The outbox dispatch gate re-checks the
// same rule when the email actually leaves.
// ---------------------------------------------------------------------------

/** Where the owner widens who the program reaches — named in every refusal. */
const SCOPE_HOME = "Settings → Who the program may reach";

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
  if (a.kind === "STAFF") return a.staffRole === "OWNER" || a.staffRole === "ADMIN" || a.staffRole === "CREATIVE_MANAGER";
  return PERMISSIONS[a.membershipRole]?.[permission] === true;
}

/** How a write is attributed in words — on the revision brief, the QC row and
 *  the editor's task. Staff are named as themselves, on the client's behalf.
 *  (Sep 28, attribution) A client person with no name keeps their email: it
 *  is the one identity they have, and an OWNER seat is not proof the person is
 *  the client — an assistant can hold one — so the client's name is never
 *  borrowed for them. A nameless staff login reads as our team rather than a
 *  bare "Staff"; the Review Room resolves the roster name (clientDecisions). */
export function actorLabel(viewer: PortalViewer): string {
  const a = viewer.actor;
  const client = viewer.enrollment.clientName || "Client";
  if (a.kind === "STAFF") return `${a.staffName?.trim() || "Realtour Pilot staff"} (on behalf of ${client})`;
  if (a.kind === "CLIENT") return a.name?.trim() || a.email;
  return `${client} (portal)`;
}

/** actorLabel, with a nameless staff login named from the roster first (Sep
 *  28) — the words a client decision and its revision brief are stamped with,
 *  so they match what the Review Room prints for the same person's notes.
 *  Never an email: this label reaches the client's own page. */
export async function actorLabelResolved(viewer: PortalViewer): Promise<string> {
  const a = viewer.actor;
  if (a.kind === "STAFF" && !a.staffName?.trim()) {
    const u = await prisma.appUser.findUnique({ where: { id: a.staffUserId }, select: { teamMemberId: true } }).catch(() => null);
    const tm = u?.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: u.teamMemberId }, select: { name: true } }).catch(() => null) : null;
    if (tm?.name?.trim()) return `${tm.name.trim()} (on behalf of ${viewer.enrollment.clientName || "Client"})`;
  }
  return actorLabel(viewer);
}

/** The message a refused action returns. Client-safe, and honest about WHY. */
export function refusalMessage(viewer: PortalViewer, permission: PortalPermission): string {
  if (viewer.access === "READ_ONLY") {
    return viewer.enrollment.status === "PAUSED"
      ? `Your program is paused, so this is view-only for now. Call or text ${OFFICE_LINE.name} at ${OFFICE_LINE.display} and we'll pick it back up.`
      : "Your program has ended, so this is view-only. Your finished content stays here for you.";
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
// One-time sign-in tokens: 32 random bytes, sha256 stored, single use. The raw
// value lives in exactly two places — the URL the person opens and, when the
// switch is on, the outbox row that emails it.
//
// HOW LONG (Oct 5 2026). The link a person asks for by typing their email
// lasts 15 minutes: they are at the sign-in page waiting for it. A link that
// arrives inside an email we sent on our own clock — a review reminder, a
// script ready to approve — lasts 24 hours: it is read whenever the inbox is.
// And OPENING a link no longer spends it (src/app/portal/auth/[token]): mail
// scanners and iMessage previews fetch every link they see, so the page asks
// for one press and only that press signs the person in.
// ---------------------------------------------------------------------------

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
export const EMAILED_LINK_TTL_MS = 24 * 3600_000;
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const loginUrl = (raw: string) => `${appBase()}/portal/auth/${raw}`;

/** A person holds a live link they asked for by email address (a 15-minute
 *  one) — the one minting must not cut off. A longer-lived emailed link may be
 *  replaced: the newest email carries the working one. */
export function holdsTypedLoginLink(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() > now.getTime() && expiresAt.getTime() - now.getTime() <= LOGIN_TOKEN_TTL_MS;
}

async function mintToken(clientUserId: string, ttlMs: number = LOGIN_TOKEN_TTL_MS): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
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
/**
 * Is this link still good, WITHOUT spending it? The GET of the sign-in page
 * asks this so a dead link goes straight to the sign-in screen with its
 * reason; only the press (consumeLoginToken) uses it up. No write.
 */
export async function peekLoginToken(raw: string): Promise<{ ok: true; clientUserId: string } | { ok: false; reason: "invalid" }> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return { ok: false, reason: "invalid" };
  const holder = await prisma.clientUser.findUnique({ where: { loginTokenHash: hashToken(raw) }, select: { id: true, status: true, loginTokenExpiresAt: true } });
  if (!holder || holder.status === "DISABLED" || !holder.loginTokenExpiresAt || holder.loginTokenExpiresAt.getTime() <= Date.now()) return { ok: false, reason: "invalid" };
  // Oct 22 2026: whose link it is, so the sign-in page can pass a person who is
  // already signed in on this device straight through (their own link only).
  return { ok: true, clientUserId: holder.id };
}

export async function consumeLoginToken(raw: string): Promise<LoginConsumption> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return { ok: false, reason: "invalid" };
  const hash = hashToken(raw);
  const holder = await prisma.clientUser.findUnique({ where: { loginTokenHash: hash }, select: { id: true, email: true, status: true } });
  if (!holder || holder.status === "DISABLED") return { ok: false, reason: "invalid" };
  // Live AND inside the rollout scope (R03): a person whose only seats are on
  // excluded clients is "noaccess" here, exactly like one whose seats were revoked.
  const live = await liveMemberships(holder.id);
  if (live.length === 0) {
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
  // click. R03 (Sep 28 2026): only the seats they could actually open. A seat
  // on a client outside the rollout was not shown to them, so its record must
  // not say they accepted it.
  await prisma.clientMembership.updateMany({ where: { id: { in: live.map((m) => m.id) }, clientUserId: holder.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
  return { ok: true, clientUserId: holder.id, email: holder.email };
}

/** The enrollment's client, and whether it is a synthetic TEST row. BY ID as
 *  well as by name (R03, Sep 28 2026): a never-synthetic real row renamed
 *  "… TEST" is REAL here — in invitations, grants and minted links — and gets
 *  nothing a real client outside the rollout would not. */
async function testClientOf(enrollmentId: string): Promise<{ clientId: string; name: string; isTest: boolean } | null> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return null;
  const c = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
  return { clientId: e.clientId, name: c?.name ?? "", isTest: isSyntheticClientRow({ id: e.clientId, name: c?.name ?? null }) };
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
  // R03 (Sep 28 2026): the switch on is not "every client". A real client must
  // be inside the rollout for portal accounts, checked BEFORE any seat or
  // person is written, so a refused invitation leaves nothing behind.
  if (!target.isTest) {
    const d = await programReach("portal_invites", target.clientId);
    if (!d.ok) throw new Error(`${target.name || "This client"} is not in the program rollout for portal accounts (${d.reason}). Add them in ${SCOPE_HOME} first. No seat was created and nothing was sent.`);
  }
  const name = (nameRaw ?? "").trim().slice(0, 120) || null;
  // A NAME IS FILLED IN, NEVER REPLACED (R03 review, Sep 28 2026). ClientUser
  // is keyed by email across every client, so the old `update: { name }` let
  // an invitation on one program rename a person another program knows —
  // grantProgramAccess has refused that since Sep 21; this door now agrees.
  const prior = await prisma.clientUser.findUnique({ where: { email }, select: { id: true, name: true } });
  const person = prior
    ? name && !prior.name?.trim()
      ? await prisma.clientUser.update({ where: { id: prior.id }, data: { name }, select: { id: true } })
      : { id: prior.id }
    : await prisma.clientUser.upsert({ where: { email }, create: { email, name }, update: {}, select: { id: true } });
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
  const { renderPortalInviteEmail } = await import("@/lib/welcomeEmail");
  const body = renderPortalInviteEmail({ firstName: (name ?? "").split(/\s+/)[0] || "there", clientName: target.name, signInUrl: `${appBase()}/portal/login`, signInEmail: email });
  const r = await sendThroughOutbox({
    channel: "email", toRef: email, body,
    dedupeKey: portalInviteKey(membership.id, new Date()),
    clientId: target.clientId, requestedBy: byAppUserId,
  });
  const emailed = r.outcome === "accepted";
  return {
    membershipId: membership.id, clientUserId: person.id, emailed,
    note: emailed
      ? "Invitation sent."
      : r.outcome === "unknown"
        ? "The invitation may have gone out — it is held on Connections for a person to confirm."
        : r.outcome === "failed" && r.refused
          ? `The invitation was not sent: ${r.error.replace(/^refused before send: /, "")}. The seat exists.`
          : `The invitation did not send (${"error" in r ? r.error : r.outcome}). The seat exists; try again.`,
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
  /** R03 (Sep 28 2026): why it is held — the switch, or the rollout scope
   *  (a ReachRefusalCode such as not_in_pilot). Absent on rows written before. */
  heldBecause?: { code: string; reason: string };
};

export type GrantOutcome =
  /** The seat exists and the welcome is queued (or was already). "failed":
   *  the provider refused it or the dispatch gate stopped it — nothing was
   *  sent, and the debt stays on file so a release re-sends it (R03). */
  | { outcome: "GRANTED"; membershipId: string; clientUserId: string; welcome: "queued" | "already" | "suppressed" | "failed"; note: string }
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
  // R03 (Sep 28 2026): a REAL client is held unless invitations are on AND
  // the client is inside the program rollout. A payment from a client outside
  // the pilot opens no account and composes no email — the debt is recorded
  // with the reason, and granted by the owner's release once they are in.
  const reach: ReachDecision | null = target.isTest ? null : invitesOn ? await programReach("portal_invites", target.clientId) : null;
  if (!target.isTest && (!invitesOn || !reach?.ok)) {
    // HELD. Record the debt (idempotent on the key) and stop. Nothing about
    // this reaches the client, and nothing about it is lost either.
    const heldBecause = !invitesOn || !reach || reach.ok
      ? { code: "switched_off", reason: "client invitations are switched off until Jordan authorises rollout" }
      : { code: reach.code, reason: reach.reason };
    await recordOwed({
      enrollmentId: input.enrollmentId, clientId: target.clientId, email,
      name: input.name?.trim() || null, role, reason: input.reason, since: new Date().toISOString(), heldBecause,
    });
    return {
      outcome: "HELD",
      note: heldBecause.code === "switched_off"
        ? "Account access is held: client invitations are switched off until Jordan authorises rollout. The debt is recorded and will be granted in one pass when the switch turns on."
        : `Account access is held: ${target.name || "this client"} is not in the program rollout yet (${heldBecause.reason}). The debt is recorded; once they are added in ${SCOPE_HOME}, the owner's "Release held access" grants it.`,
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

  const w = await queueWelcome({
    membershipId, email, name, clientName: target.name, clientId: target.clientId, isTestClient: target.isTest,
    reason: input.reason, requestedBy: input.requestedBy ?? input.byAppUserId ?? "program-activation",
  });
  const welcome = w.welcome;
  if (w.keepDebt) {
    // THE WELCOME DID NOT GO (R03, Sep 28 2026). Deleting the debt here used
    // to leave a seat with no welcome and nothing that would ever send one —
    // and a failed send was reported as "queued". The debt stays (with why),
    // so a release re-sends it: the seat already exists, and the welcome's
    // identity was released by the refusal.
    await recordOwed({
      enrollmentId: input.enrollmentId, clientId: target.clientId, email, name, role, reason: input.reason, since: new Date().toISOString(),
      heldBecause: { code: w.code ?? "send_failed", reason: w.why ?? "the welcome did not send" },
    });
  } else {
    await prisma.appSetting.deleteMany({ where: { key: owedKey(input.enrollmentId, email) } }).catch(() => {});
  }
  return {
    outcome: "GRANTED", membershipId, clientUserId: person.id, welcome,
    note:
      welcome === "queued" ? "Account opened and the welcome is queued."
      : welcome === "already" ? "Account already open; the welcome was queued earlier."
      : welcome === "failed" ? `Account opened, but the welcome did not send (${w.why ?? "unknown"}). It stays on the held list and goes out on the next release.`
      : w.keepDebt ? `Account opened. The welcome was not sent: ${w.why ?? "the rollout does not reach this client"}. It stays on the held list.`
      : "Account opened. The welcome is suppressed while invitations are switched off.",
  };
}

/** ONE welcome per seat, for ever. The dedupeKey carries no timestamp on
 *  purpose (portalInviteKey does, because a re-invitation is a real second
 *  message): payment webhooks repeat, the poll runs hourly, and A01 says one
 *  welcome however the events arrive. */
export const portalWelcomeKey = (membershipId: string) => `portal_invite:${membershipId}:welcome`;

/** Write one owed-access row, or refresh the reason on the one already there.
 *  The FIRST write is the fact worth keeping (who, which role, since when —
 *  as before); only `heldBecause` is refreshed on a later pass, so the held
 *  list always says the current reason. */
async function recordOwed(o: OwedAccess): Promise<void> {
  const key = owedKey(o.enrollmentId, o.email);
  const fresh: OwedAccess = { enrollmentId: o.enrollmentId, clientId: o.clientId, email: o.email, name: o.name, role: o.role, reason: o.reason, since: o.since, ...(o.heldBecause ? { heldBecause: o.heldBecause } : {}) };
  try {
    const prior = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    let value = JSON.stringify(fresh);
    if (prior) {
      try {
        const kept = JSON.parse(prior.value) as OwedAccess;
        if (kept && typeof kept.email === "string") value = JSON.stringify({ ...kept, ...(o.heldBecause ? { heldBecause: o.heldBecause } : {}) } satisfies OwedAccess);
      } catch { /* a hand-edited row: write it fresh */ }
    }
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch { /* a failed write must not fail the payment path; the next pass writes it */ }
}

type WelcomeResult = { welcome: "queued" | "already" | "suppressed" | "failed"; keepDebt: boolean; code?: string; why?: string };

async function queueWelcome(input: {
  membershipId: string; email: string; name: string | null; clientName: string; clientId: string; isTestClient: boolean;
  reason: "welcome" | "teammate"; requestedBy: string;
}): Promise<WelcomeResult> {
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
  //
  // R03 (Sep 28 2026): "on" also means "this client is inside the rollout".
  // A real client outside it gets no welcome even with the switch on; the
  // TEST exception above is unchanged.
  // ONE WELCOME, WHICHEVER ROAD SENT IT (Oct 14 2026). Client onboarding (the
  // owner's Send now, "marked sent", or autoOnboarding's automatic welcome)
  // may already have welcomed this client before their payment's grant opens
  // the seat. Then this one is "already": nothing is queued, and the debt is
  // settled. A teammate's invitation is a different person's and still goes.
  if (input.reason === "welcome") {
    const { welcomeAlreadySentFromOnboarding } = await import("@/lib/clientOnboarding");
    if (await welcomeAlreadySentFromOnboarding(input.clientId)) return { welcome: "already", keepDebt: false };
  }
  const invitesOn = await isAutomationEnabled("portal_invites");
  const reach = invitesOn ? await programReach("portal_invites", input.clientId) : null;
  const allowed = (invitesOn && !!reach?.ok) || (input.isTestClient && isVerifiedTestDestinationEmail(input.email));
  if (!allowed) {
    // Out of scope with the switch on is a debt, not a silence: kept, with why.
    if (invitesOn && reach && !reach.ok && !input.isTestClient) return { welcome: "suppressed", keepDebt: true, code: reach.code, why: reach.reason };
    return { welcome: "suppressed", keepDebt: false };
  }
  // Composed NOW, not when access was first owed: a held welcome released
  // later reads the discovery booking as it stands at that moment (CP-14).
  const body = await composeWelcomeEmail({ name: input.name, clientName: input.clientName, reason: input.reason, clientId: input.clientId, email: input.email });
  const { sendThroughOutbox, TestClientSendRefusedError } = await import("@/lib/outbox");
  let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    r = await sendThroughOutbox({
      channel: "email", toRef: input.email, body,
      dedupeKey: portalWelcomeKey(input.membershipId),
      clientId: input.clientId, requestedBy: input.requestedBy,
    });
  } catch (e) {
    if (e instanceof TestClientSendRefusedError) return { welcome: "suppressed", keepDebt: false, code: "test_client_real_address", why: e.message };
    throw e;
  }
  if (r.outcome === "duplicate") return { welcome: "already", keepDebt: false };
  // THE DISPATCH GATE SAID NO between this check and the send (the client was
  // taken out of the pilot, the switch turned off): suppressed, debt kept.
  if (r.outcome === "failed" && r.refused) return { welcome: "suppressed", keepDebt: true, code: r.refused, why: r.error.replace(/^refused before send: /, "") };
  // A provider refusal is NOT "queued" (it used to be reported as one): nothing
  // went, the identity is free, and the debt keeps it on the held list.
  if (r.outcome === "failed") return { welcome: "failed", keepDebt: true, code: "send_failed", why: r.error };
  return { welcome: "queued", keepDebt: false };
}

/**
 * The welcome, in Jordan's voice, composed whether or not it may be sent — so
 * the exact words can be read and approved before the gate ever opens.
 *
 * It points at the DURABLE sign-in page, never a one-time token: §4.5 asks for
 * a link that still works after the 15-minute link in some other email has
 * expired, and /portal/login mints a fresh one on request.
 *
 * Oct 12 2026 (Jordan): the brand discovery call is a step only while they
 * still need one, and the rest is what the portal is for, for how THEIR month
 * runs. The words are lib/welcomeEmail's (pure); this reads the facts.
 */
export async function composeWelcomeEmail(input: { name: string | null; clientName: string; reason: "welcome" | "teammate"; clientId?: string | null; email?: string | null }): Promise<string> {
  const { renderWelcomeEmail, renderTeammateWelcomeEmail } = await import("@/lib/welcomeEmail");
  const firstName = (input.name ?? "").trim().split(/\s+/)[0] || "there";
  const signInUrl = `${appBase()}/portal/login`;
  // Oct 21 2026: the sign-in line names the seat's address when it is known.
  const signInEmail = input.email?.trim().toLowerCase() || null;
  if (input.reason === "teammate") return renderTeammateWelcomeEmail({ firstName, clientName: input.clientName, signInUrl, signInEmail });
  return renderWelcomeEmail({ firstName, signInUrl, ...(await welcomeFactsFor(input.clientId ?? null, new Date())), signInEmail });
}

/**
 * What the welcome may say about ONE client, read when it is composed (a held
 * welcome released later reads the discovery booking as it stands then, CP-14).
 * Every read fails soft: a fact we cannot read is never a reason to fail a
 * payment's welcome, and an unreadable booking is read as "not booked".
 */
export async function welcomeFactsFor(clientId: string | null, now: Date): Promise<Omit<import("@/lib/welcomeEmail").WelcomeFacts, "firstName" | "signInUrl">> {
  const { discoveryStateOf } = await import("@/lib/welcomeEmail");
  const enrollment = clientId
    ? await prisma.contentEnrollment
        .findUnique({ where: { clientId }, select: { id: true, callMode: true, strategyCallRequired: true, noCallEligible: true, clientSuppliesTopics: true, sessionsPerMonth: true, programKind: true } })
        .catch(() => null)
    : null;
  const [booking, strategies, released, onboarding, monthlyHeld, mapping] = await Promise.all([
    // CP-14: only a booking the matcher tied to THIS client counts — a
    // CANDIDATE or an unverified alias is not a booking we can name to them.
    // A no-show is not a held call.
    clientId
      ? prisma.programCallRecord
          .findFirst({
            where: { clientId, callType: "BRAND_DISCOVERY", status: { notIn: ["CANCELLED", "RESCHEDULED", "NO_SHOW"] }, matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, scheduledStart: { not: null } },
            orderBy: { scheduledStart: "desc" },
            select: { scheduledStart: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
    // "If we didn't put together a content strategy for them": any strategy on
    // file, approved or still being written, means discovery is behind them.
    clientId
      ? prisma.contentStrategy.count({ where: { clientId, status: { not: "ARCHIVED" } } }).catch(() => 0)
      : Promise.resolve(0),
    // Readable in the portal now: the rule portal.portalStrategy shows by.
    enrollment && clientId
      ? prisma.contentStrategyVersion.count({ where: { enrollmentId: enrollment.id, clientId, releasedAt: { not: null }, status: { in: ["APPROVED", "SUPERSEDED", "SHARED"] } } }).catch(() => 0)
      : Promise.resolve(0),
    enrollment
      ? prisma.programOnboarding.findUnique({ where: { enrollmentId: enrollment.id }, select: { discoveryRequired: true, discoveryWaivedAt: true, status: true } }).catch(() => null)
      : Promise.resolve(null),
    enrollment
      ? prisma.programCallRecord.count({ where: { enrollmentId: enrollment.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] } } }).catch(() => 0)
      : Promise.resolve(0),
    prisma.programCalendlyEventMapping
      .findFirst({ where: { purpose: "BRAND_DISCOVERY", enabled: true, publicUrl: { not: null } }, select: { publicUrl: true } })
      .catch(() => null),
  ]);
  const clientPlanned = !!enrollment?.clientSuppliesTopics;
  const waived = onboarding?.discoveryRequired === false || !!onboarding?.discoveryWaivedAt || onboarding?.status === "WAIVED";
  const hasStrategy = strategies > 0 || released > 0;
  // §6.1 (Sep 25 2026): a booking that MAY be theirs under another address
  // (paid from gmail, booked from the brokerage) is not one we can name to
  // them, and not one we may tell them to repeat either. Asked only when the
  // answer can change the words.
  const candidate = !booking?.scheduledStart && clientId && !hasStrategy && !waived && !clientPlanned && monthlyHeld === 0
    ? await import("@/lib/contentCallRecords")
        .then(({ candidateDiscoveryBookingsFor }) => candidateDiscoveryBookingsFor(clientId))
        .then((rows) => rows.length > 0)
        .catch(() => false)
    : false;
  const discovery = discoveryStateOf({
    now, booking: booking?.scheduledStart ? { at: booking.scheduledStart } : null, candidate, hasStrategy, waived, clientPlanned, monthlyCallHeld: monthlyHeld > 0,
  });
  // How their month runs (programMonths.callModeOf / effectiveCallMode, read
  // for the enrollment): an explicit mode wins; the legacy-derived REQUIRED
  // holds until a first monthly call has been held OR their content strategy
  // is approved and released (Jordan, Oct 12 2026: "Or skip the call and
  // select topics and answer questions here"), then the month may be planned
  // in writing unless they are switched off the written route.
  const explicit = enrollment?.callMode === "REQUIRED" || enrollment?.callMode === "OPTIONAL_WRITTEN" || enrollment?.callMode === "NOT_INCLUDED" ? enrollment.callMode : null;
  const base = explicit ?? (enrollment?.strategyCallRequired === false ? "NOT_INCLUDED" : "REQUIRED");
  const mode = !explicit && base === "REQUIRED" && (monthlyHeld > 0 || released > 0) && enrollment?.noCallEligible !== false ? "OPTIONAL_WRITTEN" : base;
  const planning = clientPlanned ? "CLIENT_PLANNED" as const
    : mode === "NOT_INCLUDED" ? "WRITTEN" as const
    : mode === "OPTIONAL_WRITTEN" && enrollment?.noCallEligible !== false ? "CALL_OR_WRITTEN" as const
    : "CALL" as const;
  const setupMissing = enrollment && clientId
    ? await import("@/lib/portalSetup").then((m) => m.setupMissingWords(enrollment.id, clientId)).catch(() => [] as string[])
    : [];
  // Oct 16 2026: a bulk plan has its own welcome (welcomeEmail BULK): no
  // monthly call, topics or booking; the scripts by session and the first date.
  let bulk: { videos: number; sessions: number; firstSessionISO: string | null } | null = null;
  if (enrollment?.programKind === "BULK") {
    const { latestBulkPlanFor, planShoots } = await import("@/lib/bulkPlan");
    const plan = await latestBulkPlanFor(enrollment.id).catch(() => null);
    if (plan) {
      const shoots = await planShoots(plan.monthId).catch(() => []);
      const next = shoots.filter((s) => s.shootDateISO && new Date(s.shootDateISO).getTime() > now.getTime()).sort((a, b) => a.shootDateISO!.localeCompare(b.shootDateISO!))[0];
      bulk = { videos: plan.totalVideos, sessions: plan.sessionsPlanned, firstSessionISO: next?.shootDateISO ?? plan.startsOn?.toISOString() ?? null };
    }
  }
  // Oct 21 2026: no booking asks before the strategy is in the portal (strategyGate).
  const gate = enrollment ? await import("@/lib/strategyGate").then((m) => m.strategyGateFor(enrollment.id)).catch(() => null) : null;
  return { discovery, discoveryUrl: mapping?.publicUrl ?? null, strategyReady: released > 0, planning: bulk ? "BULK" as const : planning, strategyCallsOn: !bulk && mode !== "NOT_INCLUDED", setupMissing, sessionsPerMonth: enrollment?.sessionsPerMonth ?? 1, bulk, bookingOpen: gate ? gate.open : true };
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
  return { ok: true, note: "Cancelled. Nothing was ever sent to them." };
}

// ---------------------------------------------------------------------------
// RELEASING HELD ACCESS, SCOPED (R03, Sep 28 2026).
//
// The release used to grant EVERY owed row the moment `portal_invites` was on —
// every paying client who arrived while invitations were off, pilot or not.
// It now grants only the rows whose client the rollout admits for portal
// accounts; every other row stays HELD with the reason. ONE classifier decides
// for the preview and the release, so "what would be granted" and "what was
// granted" cannot disagree. Still deliberately NOT wired to the switch: the
// owner previews, then presses Release (content/portalAccessActions.ts).
// ---------------------------------------------------------------------------

type OwedClassified = { switchOn: boolean; grant: OwedAccess[]; stay: (OwedAccess & { code: string; why: string })[] };

async function classifyOwedAccess(owed: OwedAccess[]): Promise<OwedClassified> {
  const switchOn = await isAutomationEnabled("portal_invites");
  if (!switchOn) return { switchOn, grant: [], stay: owed.map((o) => ({ ...o, code: "switched_off", why: "client invitations are switched off" })) };
  const reach = await programReachMany("portal_invites", owed.map((o) => o.clientId));
  const out: OwedClassified = { switchOn, grant: [], stay: [] };
  for (const o of owed) {
    const d = reach.get(o.clientId);
    if (d?.ok) out.grant.push(o);
    else out.stay.push({ ...o, code: d && !d.ok ? d.code : "scope_unreadable", why: d && !d.ok ? d.reason : "the rollout scope could not be read" });
  }
  return out;
}

export type OwedPreview = { enrollmentId: string; clientId: string; clientName: string; email: string; reason: "welcome" | "teammate"; since: string };

/** What a release would do right now — the same classifier, read-only, addresses masked. */
export async function previewHeldAccessRelease(): Promise<{ switchOn: boolean; grant: OwedPreview[]; stay: (OwedPreview & { code: string; why: string })[] }> {
  const owed = await pendingProgramAccess();
  const c = await classifyOwedAccess(owed);
  const ids = [...new Set(owed.map((o) => o.clientId))];
  const names = new Map(ids.length ? (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]) : []);
  const { maskToRef } = await import("@/lib/outbox");
  const view = (o: OwedAccess): OwedPreview => ({ enrollmentId: o.enrollmentId, clientId: o.clientId, clientName: names.get(o.clientId) ?? o.clientId, email: maskToRef("email", o.email), reason: o.reason, since: o.since });
  return { switchOn: c.switchOn, grant: c.grant.map(view), stay: c.stay.map((o) => ({ ...view(o), code: o.code, why: o.why })) };
}

/**
 * Grant what the rollout admits, in the order it was owed. Safe to call twice:
 * `grantProgramAccess` is idempotent and clears each debt as it settles. Does
 * nothing at all while `portal_invites` is still off, so a stray call cannot
 * open the gate — only the switch can. Rows outside the scope stay HELD, with
 * the reason written on the row.
 */
export async function releasePendingProgramAccess(by: string | null): Promise<{ granted: number; held: number; conflicts: string[] }> {
  const owed = await pendingProgramAccess();
  const c = await classifyOwedAccess(owed);
  if (!c.switchOn) return { granted: 0, held: owed.length, conflicts: [] };
  let granted = 0;
  let held = 0;
  const conflicts: string[] = [];
  for (const o of c.stay) {
    held++;
    await recordOwed({ ...o, heldBecause: { code: o.code, reason: o.why } });
  }
  for (const o of c.grant) {
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
 * with no email — and the reminder and script emails mint one to send
 * (`emailed`: 24 hours, Oct 5 2026). Limited to TEST clients while `portal_login_email` is off:
 * signing in as a real client's person would write lastLoginAt/acceptedAt on
 * a real record that no real person touched.
 */
export async function mintLoginLink(membershipId: string, byAppUserId: string | null, opts: { emailed?: boolean } = {}): Promise<{ url: string; expiresAt: Date }> {
  const m = await prisma.clientMembership.findUnique({ where: { id: membershipId }, select: { clientUserId: true, enrollmentId: true, revokedAt: true } });
  if (!m || m.revokedAt) throw new Error("That seat is revoked or doesn't exist.");
  const target = await testClientOf(m.enrollmentId);
  if (!target) throw new Error("Enrollment not found.");
  if (!target.isTest && !(await isAutomationEnabled("portal_login_email"))) {
    throw new Error("Sign-in links for real clients are switched off until launch is authorised. Test with a TEST client.");
  }
  // R03 (Sep 28 2026): a link that signs a real client's person in is a
  // program sign-in, so the client must be inside the rollout for it — the
  // session it opens would be refused anyway (portal.liveMemberships). The
  // reminder and share emails that mint one fall back to the token page.
  if (!target.isTest) {
    const d = await programReach("portal_sign_in", target.clientId);
    if (!d.ok) throw new Error(`${target.name || "This client"} is not in the program rollout for signing in (${d.reason}). Use their portal link, or add them in ${SCOPE_HOME}.`);
  }
  // A link that goes into one of our emails (a reminder, a script to approve)
  // lasts 24 hours; staff opening one themselves keep the 15 minutes.
  const { raw, expiresAt } = await mintToken(m.clientUserId, opts.emailed ? EMAILED_LINK_TTL_MS : LOGIN_TOKEN_TTL_MS);
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

/** The same question for ONE client (R03, Sep 28 2026): the switch AND the
 *  rollout. A client outside the rollout is not offered email sign-in on their
 *  token page, because requestLoginLink would never send them a link.
 *
 *  A TEST CLIENT NEEDS A VERIFIED INBOX TOO (review fix, Sep 28 2026). For a
 *  TEST client requestLoginLink sends only when the address is one of
 *  Jordan's verified test inboxes, so a TEST client whose seats are all on
 *  other addresses (a colleague's nick@…) was offered sign-in and then sent
 *  nothing. Offered now only when at least one live seat's person is on a
 *  verified inbox — the same rule the send uses. */
export async function portalLoginEmailEnabledFor(clientId: string): Promise<boolean> {
  if (!(await isAutomationEnabled("portal_login_email"))) return false;
  const d = await programReach("portal_login_email", clientId);
  if (!d.ok) return false;
  if (d.tier !== "TEST") return true;
  const seats = await prisma.clientMembership.findMany({ where: { clientId, revokedAt: null }, select: { clientUserId: true } });
  if (!seats.length) return false;
  const people = await prisma.clientUser.findMany({ where: { id: { in: seats.map((x) => x.clientUserId) } }, select: { email: true, status: true } });
  return people.some((u) => u.status !== "DISABLED" && isVerifiedTestDestinationEmail(u.email));
}

/** The counter the public form writes when it sends nothing (switch off, or
 *  no seat the rollout admits) — "someone asked", never "someone got a link". */
async function recordLoginRequest(personId: string, why: string): Promise<void> {
  const key = `portal-login-requested:${personId}`;
  await prisma.appSetting
    .upsert({ where: { key }, create: { key, value: `1 @ ${new Date().toISOString()}` }, update: { value: `${await nextCount(key)} @ ${new Date().toISOString()}` } })
    .catch(() => {});
  console.info(`[portal] sign-in link requested for ${personId} — ${why}, nothing sent`);
}

export async function requestLoginLink(emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const person = await prisma.clientUser.findUnique({ where: { email }, select: { id: true, name: true, status: true, loginTokenExpiresAt: true } });
  if (!person || person.status === "DISABLED") return;
  // Live seats the rollout lets them OPEN (portal_sign_in — liveMemberships).
  const seats = await liveMemberships(person.id);
  if (seats.length === 0) {
    // Seats that exist but sit on clients outside the rollout: the request is
    // recorded (someone asked), and nothing is minted or sent. A person with
    // no seat at all is still silence, as before.
    if ((await prisma.clientMembership.count({ where: { clientUserId: person.id, revokedAt: null } })) > 0) {
      await recordLoginRequest(person.id, "their seats are on clients the rollout does not reach");
    }
    return;
  }

  if (!(await isAutomationEnabled("portal_login_email"))) {
    await recordLoginRequest(person.id, "portal_login_email is off");
    return;
  }

  // THE SEAT THAT EARNS THE EMAIL (R03, Sep 28 2026). The link signs the
  // person in to every seat they may open, so it may only be SENT because of a
  // seat on a client the rollout reaches for sign-in emails — a seat on an
  // included program never unlocks an excluded one, and a seat on an excluded
  // one never earns a link. A real client in scope comes first; a TEST seat
  // counts only when this address is one of Jordan's verified inboxes (the
  // outbox's TEST floor would refuse anything else). The row carries that
  // seat's clientId so the floor, and the dispatch gate, see whose it is.
  const reach = await programReachMany("portal_login_email", seats.map((s) => s.clientId));
  const tierOf = (clientId: string) => { const d = reach.get(clientId); return d?.ok ? d.tier : null; };
  const earning =
    seats.find((s) => { const t = tierOf(s.clientId); return t === "PILOT" || t === "ALL"; }) ??
    seats.find((s) => tierOf(s.clientId) === "TEST" && isVerifiedTestDestinationEmail(email)) ??
    null;
  if (!earning) {
    await recordLoginRequest(person.id, "no seat of theirs is on a client the rollout reaches for sign-in emails");
    return;
  }

  // Throttle on a link THEY asked for (15 minutes). A 24-hour link from one of
  // our emails does not stop them getting a fresh one by typing their address.
  if (holdsTypedLoginLink(person.loginTokenExpiresAt)) {
    console.info(`[portal] sign-in link requested for ${person.id} while one is still live (until ${person.loginTokenExpiresAt!.toISOString()}) — not re-sent`);
    return;
  }

  const { raw, expiresAt } = await mintToken(person.id);
  const { renderSignInLinkEmail } = await import("@/lib/welcomeEmail");
  const body = renderSignInLinkEmail({ firstName: (person.name ?? "").split(/\s+/)[0] || "there", url: loginUrl(raw) });
  const { sendThroughOutbox, portalLoginKey } = await import("@/lib/outbox");
  try {
    const r = await sendThroughOutbox({ channel: "email", toRef: email, body, dedupeKey: portalLoginKey(person.id, expiresAt), clientId: earning.clientId, requestedBy: "portal-login" });
    if (r.outcome !== "accepted") console.warn(`[portal] sign-in link for ${person.id}: ${r.outcome}${"error" in r ? ` — ${r.error}` : ""}`);
  } catch (e) {
    // The TEST floor refusing is loud in the log and silent on the page (the
    // form never says whether an address exists).
    console.warn(`[portal] sign-in link for ${person.id} refused: ${e instanceof Error ? e.message : String(e)}`);
  }
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
    isTestClient: isSyntheticClientRow({ id: e.clientId, name: client?.name ?? null }),
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

// ---------------------------------------------------------------------------
// PROGRAM EMAILS (Oct 21 2026). Jordan, about Arielle Roemer: "can you please
// add a second email to her content program account so we can email her on
// both emails and add a way for me to do that? I think her Fox and Roach email
// should be the one with access to her account. We should resend the
// onboarding email to her."
//
// Three owner tools on the content Settings tab (components/content/
// ProgramEmailsCard, actions in app/content/emailActions.ts):
//   · changeSeatEmail: the address a seat SIGNS IN with. One ClientUser row
//     keeps its id, so the seat, its role and everything it did stay; any
//     unused sign-in link is cleared; an AuditLog row says who changed what.
//     A portal session is bound to the ClientUser id, not the address
//     (auth/clientSession + portal.resolvePortalViewer read `cu` only), so a
//     person already signed in stays signed in; their next sign-in link goes
//     to the new address.
//   · changeAlsoEmails: extra addresses that get a copy of every email the hub
//     sends this client (overridesJson `alsoEmails`; how the copy travels is
//     clientEmailMonitor.planAlsoEmail).
//   · resendPortalWelcome: the welcome again, to the OWNER seat, under a FRESH
//     identity (portalWelcomeResendKey), through the same gates as the first.
// ---------------------------------------------------------------------------

/**
 * A resend of a seat's welcome. A new identity, so it is a new message rather
 * than a duplicate of the one-for-ever welcome (portalWelcomeKey), that still
 * reads as the welcome everywhere: the kind is portal_invite (outbox
 * outboxKind); it ends ":welcome" (subjectFor's "Welcome to your Realtour
 * Pilot content portal", clientActivity's "Welcome email sent"); segment 1 is
 * the seat (the dispatch gate's live-seat check) and segment 2 is "welcome"
 * (the gate's TEST-client welcome to Jordan's own inbox). The stamp carries no
 * colon, so none of those segments move.
 */
export const portalWelcomeResendKey = (membershipId: string, at: Date, reminder = false) =>
  `portal_invite:${membershipId}:welcome:${at.toISOString().replace(/[-:.]/g, "")}${reminder ? "-reminder" : ""}:welcome`;

/** Oct 21 2026 (Jordan: "send a reminder to any clients who have not signed
 *  in"): the welcome's words with one reminder line after the greeting. The
 *  subject comes from the key's "-reminder" stamp (outbox subjectFor). */
export function asSignInReminder(welcome: string): string {
  const lines = welcome.split("\n");
  const greet = lines.findIndex((l) => l.trim().length > 0);
  if (greet < 0) return welcome;
  return [...lines.slice(0, greet + 1), "", "A quick reminder: your content portal is set up and waiting for you, and you haven't signed in yet. It only takes a minute.", ...lines.slice(greet + 1)].join("\n");
}

export type ProgramEmailsGate = { ok: true } | { ok: false; why: string };

/** May the welcome go to this address now? The rule queueWelcome applies, in words. */
async function welcomeGateFor(clientId: string, email: string, isTest: boolean): Promise<ProgramEmailsGate> {
  if (isTest) {
    return isVerifiedTestDestinationEmail(email)
      ? { ok: true }
      : { ok: false, why: "This is a TEST client, so its welcome can only go to one of Jordan's verified test inboxes." };
  }
  if (!(await isAutomationEnabled("portal_invites"))) return { ok: false, why: "Client invitations are switched off (the portal_invites program automation), so no welcome can go out." };
  const reach = await programReach("portal_invites", clientId);
  if (!reach.ok) return { ok: false, why: `This client is not in the program rollout for portal accounts (${reach.reason}). Add them in ${SCOPE_HOME} first.` };
  return { ok: true };
}

export type ProgramEmailsState = {
  enrollmentId: string;
  clientName: string;
  isTestClient: boolean;
  /** Live seats: who signs in, and whether they have yet. */
  seats: { membershipId: string; email: string; name: string | null; role: PortalRole; signedIn: boolean; lastLoginAtISO: string | null; disabled: boolean }[];
  alsoEmails: string[];
  welcome: {
    /** The OWNER seat the welcome goes to, or null when there is none. */
    to: { membershipId: string; email: string } | null;
    gate: ProgramEmailsGate;
    /** The welcomes on record, newest first. */
    sent: { atISO: string; to: string; state: string; resend: boolean }[];
  };
};

const liveSeatRows = (enrollmentId: string) =>
  prisma.clientMembership.findMany({ where: { enrollmentId, revokedAt: null }, orderBy: { invitedAt: "asc" }, select: { id: true, clientUserId: true, clientId: true, role: true, acceptedAt: true } });

export async function programEmailsState(enrollmentId: string): Promise<ProgramEmailsState | null> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true, overridesJson: true, accessRevokedAt: true } });
  if (!e) return null;
  const [client, seatRows, sent] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    liveSeatRows(enrollmentId),
    prisma.outboxMessage.findMany({
      where: { clientId: e.clientId, OR: [{ dedupeKey: { startsWith: "portal_invite:", endsWith: ":welcome" } }, { dedupeKey: { startsWith: `onboarding:welcome:${e.clientId}:` } }] },
      orderBy: { createdAt: "desc" }, take: 5,
      select: { toRef: true, state: true, createdAt: true, acceptedAt: true, dedupeKey: true },
    }),
  ]);
  const people = seatRows.length ? await prisma.clientUser.findMany({ where: { id: { in: seatRows.map((s) => s.clientUserId) } }, select: { id: true, email: true, name: true, status: true, lastLoginAt: true } }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const seats = seatRows.flatMap((s) => {
    const p = byId.get(s.clientUserId);
    if (!p) return [];
    return [{
      membershipId: s.id, email: p.email, name: p.name, role: isPortalRole(s.role) ? s.role : ("VIEWER" as PortalRole),
      signedIn: !!(p.lastLoginAt || s.acceptedAt), lastLoginAtISO: p.lastLoginAt?.toISOString() ?? null, disabled: p.status === "DISABLED",
    }];
  });
  const clientName = client?.name ?? "";
  const isTestClient = isSyntheticClientRow({ id: e.clientId, name: clientName });
  const owner = seats.find((s) => s.role === "OWNER" && !s.disabled) ?? null;
  const gate: ProgramEmailsGate = e.accessRevokedAt
    ? { ok: false, why: "This program's portal access is revoked." }
    : !owner
      ? { ok: false, why: "No one signs in to this portal as its owner yet, so there is nobody to welcome. Invite them in Portal access first." }
      : await welcomeGateFor(e.clientId, owner.email, isTestClient);
  const { alsoEmailsFromOverrides } = await import("@/lib/clientEmailMonitor");
  return {
    enrollmentId, clientName, isTestClient, seats,
    alsoEmails: alsoEmailsFromOverrides(e.overridesJson),
    welcome: {
      to: owner ? { membershipId: owner.membershipId, email: owner.email } : null,
      gate,
      sent: sent.map((r) => ({ atISO: (r.acceptedAt ?? r.createdAt).toISOString(), to: r.toRef, state: r.state, resend: /:welcome:[^:]+:welcome$/.test(r.dedupeKey ?? "") })),
    },
  };
}

type EmailsResult = { ok: boolean; message: string };

/**
 * Write the program's "Also email" list: compare-and-swap on the whole
 * overrides bag (the creative guard, video style and catch-up records share
 * it), ledgered like every other program setting. `next` answers the new
 * list, or a refusal in words.
 */
async function writeAlsoEmails(
  enrollmentId: string,
  next: (current: string[]) => { list: string[]; reason: string } | { refuse: string } | null,
  actor: string | null,
): Promise<EmailsResult & { changed?: boolean }> {
  const { alsoEmailsFromOverrides, ALSO_EMAILS_KEY } = await import("@/lib/clientEmailMonitor");
  const { readOverrides, recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  const { etMonthKey } = await import("@/lib/datetime");
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
    if (!e) return { ok: false, message: "That program no longer exists." };
    const current = alsoEmailsFromOverrides(e.overridesJson);
    const decided = next(current);
    if (!decided) return { ok: true, changed: false, message: "Nothing to change." };
    if ("refuse" in decided) return { ok: false, message: decided.refuse };
    const bag = { ...readOverrides(e.overridesJson) };
    if (decided.list.length) bag[ALSO_EMAILS_KEY] = decided.list;
    else delete bag[ALSO_EMAILS_KEY];
    const json = Object.keys(bag).length ? JSON.stringify(bag) : null;
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: e.overridesJson }, data: { overridesJson: json } });
    if (!w.count) continue; // another write to the bag landed first: read it again
    const now = new Date();
    await recordEnrollmentChange({
      enrollmentId, clientId: e.clientId, field: "overrides", from: { [ALSO_EMAILS_KEY]: current }, to: { [ALSO_EMAILS_KEY]: decided.list },
      effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: actor, appliedAt: now, reason: decided.reason,
    });
    return { ok: true, changed: true, message: decided.reason };
  }
  return { ok: false, message: "The client file changed while saving. Try again." };
}

/** Add or remove one "Also email" address. */
export async function changeAlsoEmails(enrollmentId: string, change: { add?: string | null; remove?: string | null }, actor: string | null): Promise<EmailsResult> {
  const { cleanMonitorAddress, ALSO_EMAILS_MAX } = await import("@/lib/clientEmailMonitor");
  const { canonicalInbox } = await import("@/lib/testClients");
  if (change.add != null) {
    const email = cleanMonitorAddress(change.add);
    if (!email) return { ok: false, message: "That doesn't look like an email address." };
    const target = await testClientOf(enrollmentId);
    if (!target) return { ok: false, message: "That program no longer exists." };
    if (target.isTest && !isVerifiedTestDestinationEmail(email)) return { ok: false, message: "This is a TEST client, so its copies can only go to one of Jordan's verified test inboxes." };
    const seats = await liveSeatRows(enrollmentId);
    const seatEmails = seats.length ? (await prisma.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) } }, select: { email: true } })).map((p) => p.email) : [];
    if (seatEmails.some((s) => canonicalInbox(s) === canonicalInbox(email))) return { ok: false, message: `${email} already signs in to this portal, so it gets these emails already.` };
    return writeAlsoEmails(enrollmentId, (current) => {
      if (current.some((a) => canonicalInbox(a) === canonicalInbox(email))) return { refuse: `${email} is already on the list.` };
      if (current.length >= ALSO_EMAILS_MAX) return { refuse: `A program can copy at most ${ALSO_EMAILS_MAX} extra addresses.` };
      return { list: [...current, email], reason: `Also email: ${email} added (Program emails).` };
    }, actor);
  }
  if (change.remove != null) {
    const key = canonicalInbox(change.remove);
    return writeAlsoEmails(enrollmentId, (current) => {
      const kept = current.filter((a) => canonicalInbox(a) !== key);
      if (kept.length === current.length) return { refuse: `${change.remove} is not on the list.` };
      return { list: kept, reason: `Also email: ${current.find((a) => canonicalInbox(a) === key)} removed (Program emails).` };
    }, actor);
  }
  return { ok: false, message: "Nothing to change." };
}

/** Change the address one seat signs in with. */
export async function changeSeatEmail(input: { enrollmentId: string; membershipId: string; email: string; actor: string | null }): Promise<EmailsResult & { changed?: boolean }> {
  const { cleanMonitorAddress } = await import("@/lib/clientEmailMonitor");
  const { canonicalInbox } = await import("@/lib/testClients");
  const email = cleanMonitorAddress(input.email);
  if (!email) return { ok: false, message: "That doesn't look like an email address." };
  const seat = await prisma.clientMembership.findUnique({ where: { id: input.membershipId }, select: { id: true, enrollmentId: true, clientId: true, clientUserId: true, role: true, revokedAt: true } });
  if (!seat || seat.enrollmentId !== input.enrollmentId) return { ok: false, message: "That seat isn't on this program." };
  if (seat.revokedAt) return { ok: false, message: "That seat's access was revoked. Invite the new address in Portal access instead." };
  const person = await prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { id: true, email: true } });
  if (!person) return { ok: false, message: "That seat has no sign-in on file." };
  if (person.email === email) return { ok: true, changed: false, message: `${email} already signs in to this seat.` };
  const target = await testClientOf(input.enrollmentId);
  if (target?.isTest && !isStaffControlledEmail(email) && !isVerifiedTestDestinationEmail(email)) {
    return { ok: false, message: "This is a TEST client, so its portal people use a staff-controlled address (for example info+name@realtourpilot.com)." };
  }
  // ONE ClientUser per address across every client: a person seated on
  // another client's program is not ours to re-address from this one.
  const elsewhere = await prisma.clientMembership.findFirst({ where: { clientUserId: person.id, revokedAt: null, clientId: { not: seat.clientId } }, select: { id: true } });
  if (elsewhere) return { ok: false, message: `${person.email} also signs in to another client's portal, so its sign-in email can't be changed from here. Invite ${email} to this program in Portal access instead.` };
  const taken = await prisma.clientUser.findUnique({ where: { email }, select: { id: true } });
  const takenMessage = async (id: string) => {
    const where = await prisma.clientMembership.findFirst({ where: { clientUserId: id, revokedAt: null }, select: { enrollmentId: true } });
    const whose = !where ? "with no seat on any program" : where.enrollmentId === input.enrollmentId ? "with its own seat on this program" : "with a seat on another client's program";
    return `${email} already belongs to another portal account (${whose}). Two accounts can't share one sign-in email, so nothing was changed.`;
  };
  if (taken && taken.id !== person.id) return { ok: false, message: await takenMessage(taken.id) };
  try {
    await prisma.$transaction([
      // The id stays, so the seat, its role, its sign-ins and everything it did
      // stay with it. An unused sign-in link was minted for the OLD address:
      // cleared, so nothing sent there still opens the account.
      prisma.clientUser.update({ where: { id: person.id }, data: { email, loginTokenHash: null, loginTokenExpiresAt: null } }),
      prisma.auditLog.create({
        data: {
          actor: input.actor ?? "unknown", action: "portal_sign_in_email_change", target: seat.clientId,
          detail: `Sign-in email for the ${seat.role.toLowerCase()} seat ${seat.id} changed from ${person.email} to ${email}. Any unused sign-in link was cleared; the seat, its access and its history are unchanged.`,
        },
      }),
    ]);
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      const now = await prisma.clientUser.findUnique({ where: { email }, select: { id: true } });
      return { ok: false, message: now ? await takenMessage(now.id) : `${email} already belongs to another portal account. Nothing was changed.` };
    }
    throw e;
  }
  // The new sign-in address no longer needs a copy of its own emails.
  await writeAlsoEmails(input.enrollmentId, (current) => {
    const kept = current.filter((a) => canonicalInbox(a) !== canonicalInbox(email));
    return kept.length === current.length ? null : { list: kept, reason: `Also email: ${email} removed (it signs in to the portal now).` };
  }, input.actor).catch(() => null);
  return {
    ok: true, changed: true,
    message: `${email} now signs in to this seat. Anyone already signed in stays signed in; the next sign-in link goes to ${email}.`,
  };
}

export type ResendWelcomeResult = { ok: boolean; outcome: "sent" | "held" | "failed" | "unknown"; message: string };

/**
 * The welcome again, to the OWNER seat's sign-in address. The words are the
 * welcome's, composed now; the client's "Also email" addresses are copied by
 * the outbox (a Cc: the welcome carries the durable sign-in page, never a
 * one-use link). Same gates as the first welcome (queueWelcome): the
 * portal_invites switch and the rollout scope, or a TEST client writing to one
 * of Jordan's verified inboxes; then the outbox's TEST floor and dispatch gate.
 * Not the "welcome already sent from onboarding" check: a resend is a person
 * asking for a second one on purpose.
 */
export async function resendPortalWelcome(enrollmentId: string, by: { appUserId: string | null; actor: string | null }, opts: { reminder?: boolean } = {}): Promise<ResendWelcomeResult> {
  const held = (message: string): ResendWelcomeResult => ({ ok: false, outcome: "held", message });
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, accessRevokedAt: true } });
  if (!e) return held("That program no longer exists.");
  if (e.accessRevokedAt) return held("This program's portal access is revoked, so no welcome was sent.");
  const target = await testClientOf(enrollmentId);
  if (!target) return held("That program no longer exists.");
  const seats = await liveSeatRows(enrollmentId);
  const people = seats.length ? await prisma.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) } }, select: { id: true, email: true, name: true, status: true } }) : [];
  const seat = seats.find((s) => s.role === "OWNER" && people.some((p) => p.id === s.clientUserId && p.status !== "DISABLED"));
  const person = seat ? people.find((p) => p.id === seat.clientUserId) : null;
  if (!seat || !person) return held("No one signs in to this portal as its owner yet, so there is nobody to welcome. Invite them in Portal access first.");
  const gate = await welcomeGateFor(e.clientId, person.email, target.isTest);
  if (!gate.ok) return held(`Not sent: ${gate.why}`);
  const { alsoEmailsFromOverrides, planAlsoEmailWith } = await import("@/lib/clientEmailMonitor");
  const welcome = await composeWelcomeEmail({ name: person.name, clientName: target.name, reason: "welcome", clientId: e.clientId, email: person.email });
  const body = opts.reminder ? asSignInReminder(welcome) : welcome;
  const overrides = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const copies = planAlsoEmailWith({ kind: "portal_invite", to: person.email, body, alsoEmails: alsoEmailsFromOverrides(overrides?.overridesJson ?? null), synthetic: target.isTest });
  const copied = copies.cc.length ? ` (copy to ${copies.cc.join(", ")})` : "";
  const { sendThroughOutbox, TestClientSendRefusedError } = await import("@/lib/outbox");
  let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    r = await sendThroughOutbox({ channel: "email", toRef: person.email, body, dedupeKey: portalWelcomeResendKey(seat.id, new Date(), !!opts.reminder), clientId: e.clientId, requestedBy: by.appUserId });
  } catch (err) {
    if (err instanceof TestClientSendRefusedError) return held(`Not sent: ${err.message}`);
    throw err;
  }
  const result: ResendWelcomeResult =
    r.outcome === "accepted" ? { ok: true, outcome: "sent", message: `${opts.reminder ? "Sign-in reminder" : "Welcome"} sent to ${person.email}${copied}.` }
    : r.outcome === "failed" && r.refused ? held(`Not sent: ${r.error.replace(/^refused before send: /, "")}.`)
    : r.outcome === "failed" ? { ok: false, outcome: "failed", message: `The welcome did not send (${r.error}). Nothing went out; try again.` }
    : r.outcome === "unknown" ? { ok: false, outcome: "unknown", message: "The welcome may have gone out. It is held on Connections for a person to confirm, so don't press again." }
    : { ok: false, outcome: "unknown", message: "A welcome to this seat is already being sent. Refresh in a minute." };
  await prisma.auditLog.create({
    data: { actor: by.actor ?? "unknown", action: opts.reminder ? "portal_sign_in_reminder" : "portal_welcome_resent", target: e.clientId, detail: `${opts.reminder ? "Sign-in reminder" : "Welcome resend"} to ${person.email}${copied}: ${result.outcome}. ${result.message}`.slice(0, 4000) },
  }).catch(() => {});
  return result;
}
