"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import {
  inviteClientUser, revokeMembership, setMembershipRole, rotatePortalToken, expirePortalToken, mintLoginLink, isPortalRole,
} from "@/lib/portalAccess";

// ---------------------------------------------------------------------------
// OWNER-ONLY portal access actions (the card on /content/<id> → Their portal).
// Every one of these touches a CLIENT-FACING credential — the link, a seat,
// a sign-in — so every one is requireOwner(), the same guard issuePortalLink
// has carried since Phase 5. The launch gates themselves live in
// src/lib/portalAccess.ts, not here: an action cannot forget them.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
const me = async () => (await getCurrentUser())?.id ?? null;

export async function rotatePortalLink(enrollmentId: string): Promise<Result & { url?: string }> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const r = await rotatePortalToken(enrollmentId);
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: r.rotated ? "Link rotated — the old one now shows the sign-in page." : "Portal link created.", url: r.url };
  } catch (e) { return fail(e); }
}

/** days = 0 expires the link now; null clears the expiry. */
export async function expirePortalLink(enrollmentId: string, days: number | null): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const r = await expirePortalToken(enrollmentId, days);
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: r.expiresAt ? (days === 0 ? "Link expired — it now shows the sign-in page." : `Link expires ${r.expiresAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}.`) : "Link no longer expires." };
  } catch (e) { return fail(e); }
}

export async function invitePortalPerson(enrollmentId: string, email: string, name: string, role: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  if (!isPortalRole(role)) return { ok: false, message: "Pick a role." };
  try {
    const r = await inviteClientUser(enrollmentId, email, name, role, await me());
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: r.note };
  } catch (e) { return fail(e); }
}

export async function revokePortalPerson(enrollmentId: string, membershipId: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    await revokeMembership(membershipId, await me());
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: "Access revoked — their next request is refused." };
  } catch (e) { return fail(e); }
}

export async function setPortalPersonRole(enrollmentId: string, membershipId: string, role: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  if (!isPortalRole(role)) return { ok: false, message: "Pick a role." };
  try {
    await setMembershipRole(membershipId, role);
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: `Role set to ${role.toLowerCase()}.` };
  } catch (e) { return fail(e); }
}

/** The owner's own test path: a one-time sign-in URL to open themselves. */
export async function getPortalSignInLink(enrollmentId: string, membershipId: string): Promise<Result & { url?: string; expiresAtISO?: string }> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const r = await mintLoginLink(membershipId, await me());
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: "Sign-in link minted — it works once and expires in 15 minutes.", url: r.url, expiresAtISO: r.expiresAt.toISOString() };
  } catch (e) { return fail(e); }
}
