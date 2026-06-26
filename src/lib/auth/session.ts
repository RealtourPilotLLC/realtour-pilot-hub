import "server-only";
import { cookies } from "next/headers";
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

export type { SessionPayload };
