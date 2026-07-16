"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { ROLES, PAGES, type PageKey, parsePermissions } from "@/lib/auth/access";

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

export async function inviteUser(input: { email: string; name?: string; role: string }): Promise<Res> {
  try {
    await requireOwnerActor();
    const email = (input.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
    const role = validRole(input.role) ? input.role : "PHOTOGRAPHER";
    const token = randomUUID();

    // An EDITOR login is useless without its editorKey — that key scopes their
    // board, brief actions, and person-addressed bells. Derive it from the
    // roster by first name (Kim → "kim", Remar → "remar") so day-one logins
    // work instead of landing with dead buttons (audit critical).
    let editorKey: string | null = null;
    if (role === "EDITOR") {
      const { TEAM_MEMBER_EDITOR_KEYS, EDITORS } = await import("@/lib/editors");
      const first = (input.name ?? "").trim().split(/\s+/)[0]?.toLowerCase();
      editorKey =
        (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).find(
          (k) => k === first || EDITORS[k as keyof typeof EDITORS]?.name.split(/\s+/)[0]?.toLowerCase() === first,
        ) ?? null;
    }

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

export async function setUserRole(id: string, role: string): Promise<Res> {
  try {
    const actor = await requireOwnerActor();
    if (id === actor.id && role !== "OWNER") return { ok: false, message: "You can't change your own role." };
    if (!validRole(role)) return { ok: false, message: "Unknown role." };
    await prisma.appUser.update({ where: { id }, data: { role } });
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
    await requireOwnerActor();
    if (!PAGES.some((p) => p.key === key && !p.ownerOnly)) return { ok: false, message: "Can't override that page." };
    const u = await prisma.appUser.findUnique({ where: { id } });
    if (!u) return { ok: false, message: "User not found." };
    const perms = parsePermissions(u.permissions);
    if (value === null) delete perms[key as PageKey];
    else perms[key as PageKey] = value;
    await prisma.appUser.update({ where: { id }, data: { permissions: Object.keys(perms).length ? JSON.stringify(perms) : null } });
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
    await prisma.appUser.update({ where: { id }, data: { status } });
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
