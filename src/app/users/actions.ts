"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { ROLES, PAGES, type PageKey, parsePermissions, roleHasByDefault } from "@/lib/auth/access";

type Res = { ok: boolean; message: string; link?: string };

// Every user-management action is owner-only and blocked while previewing
// ("view as" is read-only).
async function requireOwnerActor() {
  const u = await getCurrentUser();
  if (!u) throw new Error("Not signed in.");
  if (u.impersonating) throw new Error("You're previewing another user — exit to make changes.");
  if (u.realRole !== "OWNER") throw new Error("Only the owner can manage users.");
  return u;
}

function appBase(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

const validRole = (r: string) => (ROLES as string[]).includes(r);

// An EDITOR login is useless without its editorKey — that key scopes their
// board, brief actions, and person-addressed bells. Derive it from the roster
// by first name (Kim → "kim", John → "john"), falling back to the email’s
// local part (kim@…) so a blank invite name can't mint a dead login.
async function deriveEditorKey(name: string | null | undefined, email?: string | null): Promise<string | null> {
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

export async function inviteUser(input: { email: string; name?: string; role: string }): Promise<Res> {
  try {
    await requireOwnerActor();
    const email = (input.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
    const role = validRole(input.role) ? input.role : "PHOTOGRAPHER";
    const token = randomUUID();

    const editorKey = role === "EDITOR" ? await deriveEditorKey(input.name, email) : null;

    const existing = await prisma.appUser.findUnique({ where: { email } });
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
    revalidatePath("/users");
    return { ok: true, message: existing ? "Re-invited." : "Invite created.", link: `${appBase()}/invite/${token}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

// Regenerate (or fetch) the invite link for someone who hasn't signed in yet.
export async function inviteLinkFor(id: string): Promise<Res> {
  try {
    await requireOwnerActor();
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, message: "User not found." };
    const token = u.inviteToken || randomUUID();
    if (!u.inviteToken) await prisma.appUser.update({ where: { id }, data: { inviteToken: token, invitedAt: new Date() } });
    return { ok: true, message: "Link ready.", link: `${appBase()}/invite/${token}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}


// Every roster change writes a receipt — the Kyle role-flip was unattributable
// because nothing recorded who/when/what (audit Aug 25). Best-effort: an audit
// write must never block the change itself.
async function auditRosterChange(actorEmail: string, action: string, target: string, detail: string) {
  await prisma.auditLog.create({ data: { actor: actorEmail, action, target, detail } }).catch(() => {});
}

export async function setUserRole(id: string, role: string): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id && role !== "OWNER") return { ok: false, message: "You can't change your own role." };
    if (!validRole(role)) return { ok: false, message: "Unknown role." };
    const u = await prisma.appUser.findUnique({
      where: { id },
      select: { name: true, email: true, editorKey: true, permissions: true },
    });
    if (!u) return { ok: false, message: "User not found." };
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

    const prevRole = (await prisma.appUser.findUnique({ where: { id }, select: { role: true } }))?.role;
    await prisma.appUser.update({
      where: { id },
      data: { role, permissions: nextPerms, ...(editorKey ? { editorKey } : {}) },
    });
    await auditRosterChange(actor.email, "role_change", u.email, `${prevRole ?? "?"} → ${role}`);
    revalidatePath("/users");
    return { ok: true, message: "Role updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

// Toggle one page override for a user. value true=grant, false=revoke, null=clear
// back to their role's default.
export async function setUserPermission(id: string, key: string, value: boolean | null): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (!PAGES.some((p) => p.key === key && !p.ownerOnly)) return { ok: false, message: "Can't override that page." };
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, message: "User not found." };
    // Owners always see everything — the permission system ignores their
    // overrides, so storing one just makes the toggles lie (audit: an owner
    // account carried fifteen revocations that silently did nothing).
    if (u.role === "OWNER") return { ok: false, message: "Owners always see every page — change the role first if you need to restrict this account." };
    const perms = parsePermissions(u.permissions);
    // A toggle equal to the role's default is a NO-OP — don't store it (audit:
    // stored no-op entries made the Logins screen lie about what's customized).
    if (value === null || value === roleHasByDefault(u.role, key as PageKey)) delete perms[key as PageKey];
    else perms[key as PageKey] = value;
    await prisma.appUser.update({ where: { id }, data: { permissions: Object.keys(perms).length ? JSON.stringify(perms) : null } });
    await auditRosterChange(actor.email, "permission_change", u.email, `${key} → ${value === null ? "role default" : value ? "granted" : "revoked"}`);
    revalidatePath("/users");
    return { ok: true, message: "Access updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function setUserStatus(id: string, status: "ACTIVE" | "DISABLED"): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, message: "You can't disable your own account." };
    const target = await prisma.appUser.findUnique({ where: { id }, select: { email: true } });
    await prisma.appUser.update({ where: { id }, data: { status } });
    await auditRosterChange(actor.email, "status_change", target?.email ?? id, status);
    revalidatePath("/users");
    return { ok: true, message: status === "DISABLED" ? "Access revoked." : "Access restored." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

// Owner read-only preview of another user's view. Sets `actingAs` in the session;
// getCurrentUser resolves the effective user for rendering while the guards keep
// the real owner + block every mutation (see requireRole). Exit restores it.
export async function viewAs(id: string): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, message: "That's already you." };
    const target = await prisma.appUser.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!target) return { ok: false, message: "User not found." };
    const { getSession, setSession } = await import("@/lib/auth/session");
    const s = await getSession();
    if (!s) return { ok: false, message: "Not signed in." };
    await setSession({ ...s, actingAs: id });
    revalidatePath("/", "layout");
    return { ok: true, message: `Now viewing as ${target.name ?? "user"}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
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

export async function removeUser(id: string): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id) return { ok: false, message: "You can't remove your own account." };
    await prisma.appUser.delete({ where: { id } });
    revalidatePath("/users");
    return { ok: true, message: "Removed." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
