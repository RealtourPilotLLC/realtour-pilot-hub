"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { changeAlsoEmails, changeSeatEmail, programEmailsState, resendPortalWelcome, type ProgramEmailsState } from "@/lib/portalAccess";

// ---------------------------------------------------------------------------
// PROGRAM EMAILS (Oct 21 2026): the owner's card on /content/<id> → Settings
// (components/content/ProgramEmailsCard). Who signs in, who else gets a copy,
// and the welcome again. Each one touches a client's sign-in or what lands in
// their inbox, so each is requireOwner(), the guard every portal-access action
// carries (portalAccessActions.ts); "view as" is refused there, so a preview is
// read-only. The rules themselves live in lib/portalAccess.ts.
// ---------------------------------------------------------------------------

export type EmailsActionResult = { ok: boolean; message: string; state?: ProgramEmailsState | null };

const fail = (e: unknown): EmailsActionResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
const actor = async () => {
  const u = await getCurrentUser().catch(() => null);
  return { appUserId: u?.id ?? null, actor: u?.email ?? u?.id ?? null };
};
const done = async (enrollmentId: string, r: { ok: boolean; message: string }): Promise<EmailsActionResult> => {
  revalidatePath(`/content/${enrollmentId}`);
  return { ok: r.ok, message: r.message, state: await programEmailsState(enrollmentId).catch(() => null) };
};

export async function changeSeatEmailAction(enrollmentId: string, membershipId: string, email: string): Promise<EmailsActionResult> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    return done(enrollmentId, await changeSeatEmail({ enrollmentId, membershipId, email: String(email ?? ""), actor: me.actor }));
  } catch (e) { return fail(e); }
}

export async function addAlsoEmailAction(enrollmentId: string, email: string): Promise<EmailsActionResult> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    return done(enrollmentId, await changeAlsoEmails(enrollmentId, { add: String(email ?? "") }, me.actor));
  } catch (e) { return fail(e); }
}

export async function removeAlsoEmailAction(enrollmentId: string, email: string): Promise<EmailsActionResult> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    return done(enrollmentId, await changeAlsoEmails(enrollmentId, { remove: String(email ?? "") }, me.actor));
  } catch (e) { return fail(e); }
}

export async function resendWelcomeAction(enrollmentId: string): Promise<EmailsActionResult> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    return done(enrollmentId, await resendPortalWelcome(enrollmentId, me));
  } catch (e) { return fail(e); }
}
