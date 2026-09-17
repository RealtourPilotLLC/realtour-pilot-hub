import "server-only";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isTestClientName, isStaffControlledEmail } from "@/lib/testClients";
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
  | "requestSession"; // ask for a filming session

const ALL: Record<PortalPermission, boolean> = {
  approveEdits: true, requestChanges: true, editBrandProfile: true, connectPublishing: true, comment: true, suggest: true, requestSession: true,
};
const NONE: Record<PortalPermission, boolean> = {
  approveEdits: false, requestChanges: false, editBrandProfile: false, connectPublishing: false, comment: false, suggest: false, requestSession: false,
};

/** The matrix, in one place. OWNER decides; COLLABORATOR works the month but
 *  cannot approve, reshape the brand or connect accounts; VIEWER watches. */
export const PERMISSIONS: Record<PortalRole, Record<PortalPermission, boolean>> = {
  OWNER: ALL,
  COLLABORATOR: { ...NONE, requestChanges: true, comment: true, suggest: true, requestSession: true },
  VIEWER: NONE,
};

/** The legacy link carries no person, so it may do what it could on Sep 15 —
 *  and nothing that needs a name on it: approval "records the actual person"
 *  (§8), and a publishing connection is a credential. */
const LEGACY_TOKEN: Record<PortalPermission, boolean> = { ...ALL, approveEdits: false, connectPublishing: false };

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
      ? "Your program is paused, so this is view-only for now — text us and we'll pick it back up."
      : "Your program has ended, so this is view-only — your finished content stays here for you.";
  }
  if (viewer.actor.kind === "CLIENT" && viewer.actor.membershipRole === "VIEWER") return "Your access is view-only. Ask the program owner if you need to make changes.";
  if (permission === "approveEdits") return "Only the program owner can approve.";
  if (permission === "editBrandProfile") return "Only the program owner can change the brand profile.";
  if (permission === "connectPublishing") return "Only the program owner can connect accounts.";
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
