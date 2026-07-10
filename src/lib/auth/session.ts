import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { signSession, verifySession, SESSION_COOKIE, SESSION_MAX_AGE, type SessionPayload } from "./jwt";

// Server-side cookie helpers (use next/headers — NOT importable from middleware).

export async function setSession(p: SessionPayload): Promise<void> {
  const token = await signSession(p);
  const c = await cookies();
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function getSession(): Promise<SessionPayload | null> {
  const c = await cookies();
  return verifySession(c.get(SESSION_COOKIE)?.value);
}

// Sign an AppUser in — the shared final step for EVERY login path (Google
// callback, email+password, set-password-from-invite). Activates + stamps
// lastLoginAt, links the photographer roster record by email on first login,
// then sets the session cookie. One place so no path drifts on session claims.
export async function establishSession(userId: string): Promise<{ role: string }> {
  let user = await prisma.appUser.update({
    where: { id: userId },
    data: { status: "ACTIVE", lastLoginAt: new Date() },
  });
  if (!user.teamMemberId) {
    const tm = await prisma.teamMember.findFirst({
      where: { email: { equals: user.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (tm) user = await prisma.appUser.update({ where: { id: user.id }, data: { teamMemberId: tm.id } });
  }
  await setSession({
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name ?? undefined,
    permissions: user.permissions,
  });
  return { role: user.role };
}

export type { SessionPayload };
