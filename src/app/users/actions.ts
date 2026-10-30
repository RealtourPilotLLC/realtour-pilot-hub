"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { appBase } from "@/lib/appUrl";
import { ROLES, PAGES, type PageKey, parsePermissions, roleHasByDefault } from "@/lib/auth/access";

export type UserActionResult = { ok: boolean; message: string; link?: string; outcome?: "confirmed" | "refused" | "unknown" };
type Res = UserActionResult;
export type UserAccessBaseline = { role: string; permissions: string | null };

function failed(e: unknown, writing: boolean): Res {
  return { ok: false, message: e instanceof Error ? e.message : "Failed.", outcome: writing ? "unknown" : "refused" };
}
const staleAccess = (): Res => ({ ok: false, outcome: "refused", message: "This account's role or page access changed. Refresh the account before choosing another change." });
const matchesAccess = (u: UserAccessBaseline, expected: UserAccessBaseline | undefined) =>
  !expected || u.role === expected.role && u.permissions === expected.permissions;

// Every user-management action is owner-only and blocked while previewing
// ("view as" is read-only).
async function requireOwnerActor() {
  const u = await getCurrentUser();
  if (!u) throw new Error("Not signed in.");
  if (u.impersonating) throw new Error("You're previewing another user — exit to make changes.");
  if (u.realRole !== "OWNER") throw new Error("Only the owner can manage users.");
  return u;
}

// Invite links use the hub's one origin helper (audit F23, Oct 20 2026). This
// file carried its own copy that skipped APP_URL and never normalized the
// scheme or a trailing slash, so a link could point at a per-deployment
// Vercel host or come out malformed.

const validRole = (r: string) => (ROLES as string[]).includes(r);

// An EDITOR login is useless without its editorKey — that key scopes their
// board, brief actions, and person-addressed bells. Derive it from the roster
// by first name (Kim → "kim", John → "john"), falling back to the email’s
// local part (kim@…) so a blank invite name can't mint a dead login.
async function deriveEditorKey(name: string | null | undefined, email?: string | null): Promise<string | null> {
  // The key on their team card wins (an editor onboarded here, Oct 30 2026).
  // A failed read falls through to the name match below.
  if (email) {
    try {
      const card = await prisma.teamMember.findFirst({ where: { email: { equals: email, mode: "insensitive" }, editorKey: { not: null } }, select: { editorKey: true } });
      if (card?.editorKey) return card.editorKey;
    } catch { /* the name match decides */ }
  }
  const { TEAM_MEMBER_EDITOR_KEYS, EDITORS } = await import("@/lib/editors");
  const matchKey = (candidate: string | undefined): string | null =>
    candidate
      ? (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).find(
          (k) => k === candidate || EDITORS[k as keyof typeof EDITORS]?.name.split(/\s+/)[0]?.toLowerCase() === candidate,
        ) ?? null
      : null;
  const first = (name ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  return matchKey(first) ?? matchKey((email ?? "").split("@")[0]?.trim().toLowerCase() || undefined);
}

export async function inviteUser(input: { email: string; name?: string; role: string } & TeammateSetup): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    const email = (input.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, outcome: "refused", message: "Enter a valid email." };
    const role = validRole(input.role) ? input.role : "PHOTOGRAPHER";
    const token = randomUUID();
    // The team card's fields are checked before anything is written, so a
    // bad Slack ID can't leave half an onboarding behind.
    const setup = await checkSetup(input, null);
    if (!setup.ok) return { ok: false, outcome: "refused", message: setup.message };

    const editorKey = role === "EDITOR" ? await deriveEditorKey(input.name, email) : null;

    const existing = await prisma.appUser.findUnique({ where: { email } });
    writing = true;
    if (existing) {
      // Re-invite: refresh role + token, keep them able to sign in.
      await prisma.appUser.update({
        where: { id: existing.id },
        data: {
          role,
          name: input.name?.trim() || existing.name,
          ...(editorKey ? { editorKey } : {}),
          inviteToken: token,
          invitedAt: new Date(),
          status: existing.status === "DISABLED" ? "INVITED" : existing.status,
        },
      });
    } else {
      await prisma.appUser.create({
        data: { email, name: input.name?.trim() || null, role, editorKey, status: "INVITED", inviteToken: token, invitedAt: new Date() },
      });
    }
    // Their team card: Slack ID, phone, and for an editor the desk key, clock
    // and the lanes they take work on.
    let setupWords = "";
    const user = await prisma.appUser.findUnique({ where: { email } });
    if (user && (role === "EDITOR" || setup.value.slackId || setup.value.phone || setup.value.location || setup.value.timezone)) {
      try {
        const r = await applyTeammateSetup(user, setup.value, actor.email);
        setupWords = ` ${r.message}`;
      } catch (e) {
        setupWords = ` The login is ready, but the team card was not set up (${e instanceof Error ? e.message : "unknown error"}). Press "Set up" on their card to finish.`;
      }
    }
    revalidatePath("/users");
    return { ok: true, outcome: "confirmed", message: `${existing ? "Re-invited." : "Invite created."}${setupWords}`, link: `${appBase()}/invite/${token}` };
  } catch (e) {
    return failed(e, writing);
  }
}

// Regenerate (or fetch) the invite link for someone who hasn't signed in yet.
export async function inviteLinkFor(id: string): Promise<Res> {
  let writing = false;
  try {
    await requireOwnerActor();
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, outcome: "refused", message: "User not found." };
    // A link lives INVITE_TTL_DAYS (audit G15): hand back the live one, or mint
    // a fresh one when there is none or it has lapsed.
    const { inviteTokenExpired } = await import("@/lib/auth/inviteToken");
    const live = u.inviteToken && !inviteTokenExpired(u.invitedAt) ? u.inviteToken : null;
    const token = live || randomUUID();
    if (!live) { writing = true; await prisma.appUser.update({ where: { id }, data: { inviteToken: token, invitedAt: new Date() } }); }
    return { ok: true, outcome: "confirmed", message: "Link ready.", link: `${appBase()}/invite/${token}` };
  } catch (e) {
    return failed(e, writing);
  }
}


// Every roster change writes a receipt — the Kyle role-flip was unattributable
// because nothing recorded who/when/what (audit Aug 25). Best-effort: an audit
// write must never block the change itself.
async function auditRosterChange(actorEmail: string, action: string, target: string, detail: string) {
  await prisma.auditLog.create({ data: { actor: actorEmail, action, target, detail } }).catch(() => {});
}

export async function setUserRole(id: string, role: string, expected?: UserAccessBaseline): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id && role !== "OWNER") return { ok: false, outcome: "refused", message: "You can't change your own role." };
    if (!validRole(role)) return { ok: false, outcome: "refused", message: "Unknown role." };
    const u = await prisma.appUser.findUnique({
      where: { id },
      select: { name: true, email: true, editorKey: true, role: true, permissions: true },
    });
    if (!u) return { ok: false, outcome: "refused", message: "User not found." };
    if (!matchesAccess(u, expected)) return staleAccess();
    // Flipping someone TO editor needs the same key wiring an invite gets —
    // without it their board/brief/bells are all dead on arrival.
    const editorKey = role === "EDITOR" && !u.editorKey ? await deriveEditorKey(u.name, u.email) : null;

    // Page overrides were tailored to the OLD role, and a `false` written against
    // one role's page set can silently revoke a core page of the new one. That
    // bricked a new editor on his onboarding call: his account carried
    // {"editing":false,"tasks":false,"upload":false} — which is every page an
    // EDITOR has — so every door was shut and the middleware bounced him between
    // two of them until the browser gave up (ERR_TOO_MANY_REDIRECTS).
    //
    // So on a role change, drop the REVOCATIONS that collide with the new role's
    // defaults. Grants (`true`) are kept: they're additive, they can't lock
    // anyone out, and they're usually a deliberate exception (a photographer
    // given `clients`, say) that shouldn't silently vanish.
    const perms = parsePermissions(u.permissions);
    for (const k of Object.keys(perms)) {
      if (perms[k] === false && roleHasByDefault(role, k as PageKey)) delete perms[k];
    }
    const nextPerms = Object.keys(perms).length ? JSON.stringify(perms) : null;

    writing = true;
    const changed = await prisma.appUser.updateMany({
      where: { id, role: u.role, permissions: u.permissions },
      data: { role, permissions: nextPerms, ...(editorKey ? { editorKey } : {}) },
    });
    if (!changed.count) return staleAccess();
    await auditRosterChange(actor.email, "role_change", u.email, `${u.role} → ${role}`);
    revalidatePath("/users");
    const needsDesk = role === "EDITOR" && !u.editorKey && !editorKey;
    return { ok: true, outcome: "confirmed", message: needsDesk ? "Role updated. Press \"Set up as editor\" on their card so work can reach them." : "Role updated." };
  } catch (e) {
    return failed(e, writing);
  }
}

// Toggle one page override for a user. value true=grant, false=revoke, null=clear
// back to their role's default.
export async function setUserPermission(id: string, key: string, value: boolean | null, expected?: UserAccessBaseline): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    if (!PAGES.some((p) => p.key === key && !p.ownerOnly)) return { ok: false, outcome: "refused", message: "Can't override that page." };
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, outcome: "refused", message: "User not found." };
    // Owners always see everything — the permission system ignores their
    // overrides, so storing one just makes the toggles lie (audit: an owner
    // account carried fifteen revocations that silently did nothing).
    if (u.role === "OWNER") return { ok: false, outcome: "refused", message: "Owners always see every page — change the role first if you need to restrict this account." };
    if (!matchesAccess(u, expected)) return staleAccess();
    const perms = parsePermissions(u.permissions);
    // A toggle equal to the role's default is a NO-OP — don't store it (audit:
    // stored no-op entries made the Logins screen lie about what's customized).
    if (value === null || value === roleHasByDefault(u.role, key as PageKey)) delete perms[key as PageKey];
    else perms[key as PageKey] = value;
    writing = true;
    const changed = await prisma.appUser.updateMany({ where: { id, role: u.role, permissions: u.permissions }, data: { permissions: Object.keys(perms).length ? JSON.stringify(perms) : null } });
    if (!changed.count) return staleAccess();
    await auditRosterChange(actor.email, "permission_change", u.email, `${key} → ${value === null ? "role default" : value ? "granted" : "revoked"}`);
    revalidatePath("/users");
    return { ok: true, outcome: "confirmed", message: "Access updated." };
  } catch (e) {
    return failed(e, writing);
  }
}

/** Same overridable keys as the former per-page loop, committed atomically. */
export async function resetUserPermissions(id: string, expected?: UserAccessBaseline): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, outcome: "refused", message: "User not found." };
    if (u.role === "OWNER") return { ok: false, outcome: "refused", message: "Owners always see every page — change the role first if you need to restrict this account." };
    if (!matchesAccess(u, expected)) return staleAccess();
    const perms = parsePermissions(u.permissions);
    const keys = PAGES.filter((p) => !p.ownerOnly && p.key in perms).map((p) => p.key);
    if (!keys.length) return { ok: true, outcome: "confirmed", message: "There are no page overrides to reset." };
    for (const key of keys) delete perms[key];
    writing = true;
    const changed = await prisma.appUser.updateMany({ where: { id, role: u.role, permissions: u.permissions }, data: { permissions: Object.keys(perms).length ? JSON.stringify(perms) : null } });
    if (!changed.count) return staleAccess();
    for (const key of keys) await auditRosterChange(actor.email, "permission_change", u.email, `${key} → role default`);
    revalidatePath("/users");
    return { ok: true, outcome: "confirmed", message: "Page access reset to role defaults." };
  } catch (e) { return failed(e, writing); }
}

export async function setUserStatus(id: string, status: "ACTIVE" | "DISABLED"): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, outcome: "refused", message: "You can't disable your own account." };
    const target = await prisma.appUser.findUnique({ where: { id }, select: { email: true } });
    writing = true;
    await prisma.appUser.update({ where: { id }, data: { status } });
    await auditRosterChange(actor.email, "status_change", target?.email ?? id, status);
    revalidatePath("/users");
    return { ok: true, outcome: "confirmed", message: status === "DISABLED" ? "Access revoked." : "Access restored." };
  } catch (e) {
    return failed(e, writing);
  }
}

// Owner read-only preview of another user's view. Sets `actingAs` in the session;
// getCurrentUser resolves the effective user for rendering while the guards keep
// the real owner + block every mutation (see requireRole). Exit restores it.
export async function viewAs(id: string): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, outcome: "refused", message: "That's already you." };
    const target = await prisma.appUser.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!target) return { ok: false, outcome: "refused", message: "User not found." };
    const { getSession, setSession } = await import("@/lib/auth/session");
    const s = await getSession();
    if (!s) return { ok: false, outcome: "refused", message: "Not signed in." };
    writing = true;
    await setSession({ ...s, actingAs: id });
    revalidatePath("/", "layout");
    return { ok: true, outcome: "confirmed", message: `Now viewing as ${target.name ?? "user"}.` };
  } catch (e) {
    return failed(e, writing);
  }
}

export async function exitViewAs(): Promise<Res> {
  try {
    const { getSession, setSession } = await import("@/lib/auth/session");
    const s = await getSession();
    if (!s) return { ok: false, message: "Not signed in." };
    if (s.role !== "OWNER") return { ok: false, message: "Nothing to exit." };
    const rest = { ...s };
    delete rest.actingAs;
    await setSession(rest);
    revalidatePath("/", "layout");
    return { ok: true, message: "Exited preview." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

// ---------------------------------------------------------------------------
// ONBOARDING A TEAMMATE (Jordan, Oct 30 2026: "I just onboarded a new editor
// her name is Reychelle. I need to make sure the ops hub is set up to be able
// to onboard new editors and new users, and add their Slack ID, assignment,
// etc."). A login (AppUser) is who can sign in; the TEAM CARD (TeamMember) is
// who the hub can reach and hand work to: the Slack ID a mention DMs, the
// phone a text goes to, and for a video editor the desk key their jobs, bell
// and Editing Room are filed under, their clock, and the lanes ticked for
// them on Settings → Editor auto-assignment. Reychelle had a login and no
// card, so nothing could ever reach her. One writer for both doors: the
// "Add a user" form and "Set up" on an existing login.
// ---------------------------------------------------------------------------
export type TeammateSetup = {
  phone?: string | null;
  slackId?: string | null;
  timezone?: string | null;
  /** where they are, as written ("Manila, Philippines") */
  location?: string | null;
  /** editor only: the auto-assignment lanes (lib/editors ROUTING_LANES) */
  lanes?: string[] | null;
};
type CleanSetup = { phone: string | null; slackId: string | null; timezone: string | null; location: string | null; lanes: string[] | null };


async function checkSetup(input: TeammateSetup, teamMemberId: string | null): Promise<{ ok: true; value: CleanSetup } | { ok: false; message: string }> {
  const { SLACK_MEMBER_ID_RE } = await import("@/lib/slackScopes");
  const { ROUTING_LANES } = await import("@/lib/editors");
  const slackId = (input.slackId ?? "").trim().toUpperCase() || null;
  if (slackId && !SLACK_MEMBER_ID_RE.test(slackId)) {
    return { ok: false, message: "That doesn't look like a Slack member ID. It starts with U or W (e.g. U07SCBTPDC7). In Slack: click the person → ⋯ → Copy member ID." };
  }
  if (slackId) {
    const other = await prisma.teamMember.findFirst({ where: { slackId, ...(teamMemberId ? { NOT: { id: teamMemberId } } : {}) }, select: { name: true, email: true } });
    if (other) return { ok: false, message: `That Slack ID is already on ${other.name}'s card. One Slack account, one person.` };
  }
  const rawPhone = (input.phone ?? "").trim();
  const { cleanTeamPhone, isTimeZone } = await import("@/lib/phoneKey");
  const phone = rawPhone ? cleanTeamPhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, message: "That phone number doesn't look right. Include the country code for a number outside the US (e.g. +63 917 123 4567)." };
  const timezone = (input.timezone ?? "").trim() || null;
  if (timezone) {
    if (!isTimeZone(timezone)) return { ok: false, message: "Unknown time zone." };
  }
  const lanes = input.lanes == null ? null : [...new Set(input.lanes)].filter((l) => (ROUTING_LANES as string[]).includes(l));
  const location = (input.location ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  return { ok: true, value: { phone, slackId, timezone, location, lanes } };
}

// AppUser role → the team card's role (TeamMember.role is the older enum).
const CARD_ROLE: Record<string, "EDITOR" | "PHOTOGRAPHER" | "MANAGER"> = {
  EDITOR: "EDITOR", PHOTOGRAPHER: "PHOTOGRAPHER", CREATIVE_MANAGER: "PHOTOGRAPHER", ADMIN: "MANAGER", OWNER: "MANAGER",
};

/** A desk key nobody holds: their first name, then name2, name3… */
async function freshEditorKey(name: string, email: string): Promise<string> {
  const { slugForName } = await import("@/lib/assignees");
  const { EDITORS, isFreshEditorKey } = await import("@/lib/editors");
  let base = slugForName(name) || slugForName(email.split("@")[0].replace(/[._-]+/g, " "));
  if (!/^[a-z]/.test(base)) base = `editor${base}`;
  base = base.slice(0, 24);
  for (let n = 1; n < 50; n++) {
    const key = n === 1 ? base : `${base}${n}`;
    if (!isFreshEditorKey(key) || key in EDITORS) continue;
    const held = await prisma.teamMember.count({ where: { editorKey: key } }) + await prisma.appUser.count({ where: { editorKey: key, NOT: { email } } });
    if (!held) return key;
  }
  throw new Error("Could not find a free editor key for this name.");
}

async function applyTeammateSetup(
  user: { id: string; email: string; name: string | null; role: string; teamMemberId: string | null; editorKey: string | null },
  input: CleanSetup,
  actorEmail: string,
): Promise<{ teamMemberId: string; editorKey: string | null; message: string }> {
  const { editorKeyForTeamName, isVideoEditorKey } = await import("@/lib/editors");
  const { ensureEditorRoster } = await import("@/lib/editorRoster");
  const isEditor = user.role === "EDITOR";
  const displayName = user.name?.trim() || user.email.split("@")[0];

  // Their card: the one linked, else the one under their email, else a new one.
  let tm =
    (user.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: user.teamMemberId } }) : null) ??
    (await prisma.teamMember.findFirst({ where: { email: { equals: user.email, mode: "insensitive" } } }));
  const notes: string[] = [];
  if (!tm) {
    tm = await prisma.teamMember.create({
      data: {
        name: displayName, email: user.email, role: CARD_ROLE[user.role] ?? "PHOTOGRAPHER", active: true,
        phone: input.phone, slackId: input.slackId, timezone: input.timezone ?? (isEditor ? "Asia/Manila" : null), location: input.location,
        ...(isEditor ? { title: "Video Editor" } : {}),
      },
    });
    notes.push(`Team card created for ${displayName}.`);
  } else {
    const data: { phone?: string; slackId?: string; timezone?: string; location?: string; active?: boolean } = {};
    if (input.phone) data.phone = input.phone;
    if (input.slackId) data.slackId = input.slackId;
    if (input.timezone) data.timezone = input.timezone;
    if (input.location) data.location = input.location;
    if (!tm.active) data.active = true;
    if (Object.keys(data).length) tm = await prisma.teamMember.update({ where: { id: tm.id }, data });
  }

  // A video editor's desk key: the card's, else a built-in editor this card
  // already is (Kim's, Jhon Mark's), else a new one from their first name.
  let editorKey: string | null = null;
  if (isEditor) {
    editorKey = tm.editorKey;
    if (!editorKey) {
      const builtin = editorKeyForTeamName(tm.name);
      const builtinFree = builtin && isVideoEditorKey(builtin) && !(await prisma.teamMember.count({ where: { editorKey: builtin } }));
      editorKey = builtinFree ? builtin : await freshEditorKey(tm.name, user.email);
      tm = await prisma.teamMember.update({ where: { id: tm.id }, data: { editorKey } });
      notes.push(`Editor desk ready (${tm.name}).`);
    }
  }
  await prisma.appUser.update({
    where: { id: user.id },
    data: { teamMemberId: tm.id, ...(editorKey ? { editorKey } : {}) },
  });
  await ensureEditorRoster({ force: true });

  if (isEditor && editorKey && input.lanes) {
    const { setEditorLanes } = await import("@/lib/settings");
    const { ROUTING_LANE_LABEL } = await import("@/lib/editors");
    await setEditorLanes(editorKey, input.lanes as import("@/lib/editors").RoutingLane[], actorEmail);
    notes.push(input.lanes.length
      ? `Takes new work on: ${input.lanes.map((l) => ROUTING_LANE_LABEL[l as keyof typeof ROUTING_LANE_LABEL]).join(", ")}.`
      : "Not ticked for any lane yet, so no work is handed to them automatically.");
  }

  // No Slack ID typed: ask Slack by their email (works once the bot can read emails).
  if (!tm.slackId) {
    try {
      const { slackLookupByEmail } = await import("@/lib/integrations/slack");
      const r = await slackLookupByEmail(tm.email);
      if (r.ok && !(await prisma.teamMember.count({ where: { slackId: r.id, NOT: { id: tm.id } } }))) {
        await prisma.teamMember.update({ where: { id: tm.id }, data: { slackId: r.id } });
        notes.push(`Found on Slack (${r.id}).`);
      } else {
        notes.push("No Slack ID yet: add it on their card so mentions reach them on Slack.");
      }
    } catch {
      notes.push("No Slack ID yet: add it on their card so mentions reach them on Slack.");
    }
  }
  await auditRosterChange(actorEmail, "teammate_setup", user.email,
    `card ${tm.id}${editorKey ? ` · editor ${editorKey}` : ""}${input.lanes ? ` · lanes ${input.lanes.join(",") || "none"}` : ""}`);
  revalidatePath("/users");
  revalidatePath("/settings");
  revalidatePath("/editing");
  return { teamMemberId: tm.id, editorKey, message: notes.join(" ") };
}

/** "Set up" / "Save" on a login's team card. Owner only, like every roster change. */
export async function saveTeammateSetup(id: string, input: TeammateSetup): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    const user = await prisma.appUser.findUnique({ where: { id } });
    if (!user) return { ok: false, outcome: "refused", message: "User not found." };
    const linked = user.teamMemberId ?? (await prisma.teamMember.findFirst({ where: { email: { equals: user.email, mode: "insensitive" } }, select: { id: true } }))?.id ?? null;
    const setup = await checkSetup(input, linked);
    if (!setup.ok) return { ok: false, outcome: "refused", message: setup.message };
    writing = true;
    const r = await applyTeammateSetup(user, setup.value, actor.email);
    return { ok: true, outcome: "confirmed", message: r.message || "Saved." };
  } catch (e) {
    return failed(e, writing);
  }
}

export async function removeUser(id: string): Promise<Res> {
  let writing = false;
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, outcome: "refused", message: "You can't remove your own account." };
    writing = true;
    await prisma.appUser.delete({ where: { id } });
    revalidatePath("/users");
    return { ok: true, outcome: "confirmed", message: "Removed." };
  } catch (e) {
    return failed(e, writing);
  }
}
