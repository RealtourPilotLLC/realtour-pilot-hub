"use server";

import { prisma } from "@/lib/prisma";
import { verifyPassword, hashPassword, passwordProblem } from "@/lib/auth/password";
import { establishSession } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/access";

export type AuthResult = { ok: true; redirect: string } | { ok: false; message: string };

// Best-effort brute-force throttle. Per-email failed-attempt counter kept in
// process memory — on serverless it's per-instance (not global), but combined
// with the invite-only allowlist (an attacker must know a real invited email)
// and scrypt's deliberate slowness, it's a sensible deterrent for a small team.
// A correct login clears the counter.
const attempts = new Map<string, { n: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;

function throttled(email: string): boolean {
  const rec = attempts.get(email);
  return !!rec && rec.n >= MAX_ATTEMPTS && Date.now() < rec.until;
}
function noteFailure(email: string) {
  const rec = attempts.get(email) ?? { n: 0, until: 0 };
  rec.n += 1;
  rec.until = Date.now() + LOCK_MS;
  attempts.set(email, rec);
}

// Email + password sign-in. Same allowlist + session as Google login: only an
// existing, non-disabled AppUser who has SET a password can get in. The error
// message is deliberately identical for "no such user", "no password set", and
// "wrong password" so it never reveals which emails are on the allowlist.
export async function loginWithPassword(formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  if (!email || !password) return { ok: false, message: "Enter your email and password." };
  if (throttled(email)) return { ok: false, message: "Too many attempts. Wait a few minutes and try again." };

  const user = await prisma.appUser.findUnique({ where: { email } });
  const ok = user && user.status !== "DISABLED" && (await verifyPassword(password, user.passwordHash));
  if (!ok || !user) {
    noteFailure(email);
    return { ok: false, message: "That email and password don't match. (Owners/admins can also use Google.)" };
  }

  attempts.delete(email);
  await establishSession(user.id);
  const dest = next.startsWith("/") && !next.startsWith("//") && next !== "/" ? next : homeFor(user.role);
  return { ok: true, redirect: dest };
}

// Set (or reset) a password from a valid invite/reset link, then sign in. The
// token identifies the user; the email is never trusted from the client. Works
// for INVITED (first-time) and ACTIVE (reset) users; DISABLED is refused.
export async function setPasswordFromToken(formData: FormData): Promise<AuthResult> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!token) return { ok: false, message: "This link is missing its code — ask the owner for a fresh one." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, message: problem };

  const user = await prisma.appUser.findUnique({ where: { inviteToken: token } });
  if (!user || user.status === "DISABLED") {
    return { ok: false, message: "This link has already been used or was revoked. Ask the owner for a new one." };
  }

  const passwordHash = await hashPassword(password);
  // Consume the one-time token as we set the password (so the link can't be
  // reused), then establishSession activates + links + signs them in.
  await prisma.appUser.update({ where: { id: user.id }, data: { passwordHash, inviteToken: null } });
  await establishSession(user.id);
  return { ok: true, redirect: homeFor(user.role) };
}
