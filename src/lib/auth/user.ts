import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSession } from "./session";
import { canAccess, type PageKey } from "./access";

// The current logged-in person, resolved from the session and re-read from the DB
// (so a role/permission/status change takes effect immediately). `actingAs`
// (owner read-only "view as") resolves to the EFFECTIVE user for rendering while
// `realUid` keeps the true owner for the banner + the impersonation guard.

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: string | null;
  status: string;
  teamMemberId: string | null;
  editorKey: string | null;
  impersonating: boolean; // true when an owner is viewing as someone else
  realRole: string; // the true viewer's role (OWNER when impersonating)
  realName: string | null;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const s = await getSession();
  if (!s) return null;

  // The real session user must still be active.
  const real = await prisma.appUser.findUnique({ where: { id: s.uid } });
  if (!real || real.status !== "ACTIVE") return null;

  // Owner read-only preview: render as the target, but only an active owner may.
  let eff = real;
  let impersonating = false;
  if (s.actingAs && real.role === "OWNER" && s.actingAs !== real.id) {
    const target = await prisma.appUser.findUnique({ where: { id: s.actingAs } });
    if (target) { eff = target; impersonating = true; }
  }

  return {
    id: eff.id,
    email: eff.email,
    name: eff.name,
    role: eff.role,
    permissions: eff.permissions,
    status: eff.status,
    teamMemberId: eff.teamMemberId,
    editorKey: eff.editorKey,
    impersonating,
    realRole: real.role,
    realName: real.name,
  };
}

// Page guards for server components. requireAccess respects role + per-user
// overrides (and the read-only "view as" effective role).
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requireAccess(key: PageKey): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!canAccess(u, key)) redirect("/");
  return u;
}
