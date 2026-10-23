"use server";

import { revalidatePath } from "next/cache";
import { authEnforced } from "@/lib/auth/guards";
import { isCreativeLead } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// THE PHOTOGRAPHER BRIEF'S TWO BUTTONS (Oct 23 2026, lib/photographerBrief has
// the rules).
//
// SEND BRIEF NOW (Kyle's dashboard, Shoot Prep): one photographer, one ET day.
// Who may press: the office (owner, admin) and the creative manager, by their
// REAL login, never through "view as". Refused while the brief is switched off.
//
// GOT IT (the full-brief page, /shoot/brief/<day>): only the signed-in
// photographer whose brief it is, never a preview, and only for the version
// their page showed (`digest`).
// ---------------------------------------------------------------------------

export type BriefActionResult = { ok: boolean; message: string };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The dashboard's "Send brief now" for one photographer and day ("YYYY-MM-DD", Eastern). */
export async function sendPhotographerBriefNow(teamMemberId: string, day: string): Promise<BriefActionResult> {
  if (typeof teamMemberId !== "string" || !teamMemberId.trim() || typeof day !== "string" || !DAY_KEY.test(day)) {
    return { ok: false, message: "Pick a photographer and a day." };
  }
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "You're viewing the hub as someone else. Exit the preview to send a brief." };
  if (authEnforced()) {
    if (!me) return { ok: false, message: "Please sign in to do that." };
    if (!isCreativeLead(me.realRole)) return { ok: false, message: "Only the office and the creative manager can send a photographer's brief." };
  }
  const { displayNameFor } = await import("@/lib/actorName");
  const name = (await displayNameFor(me)) ?? "The office";
  const { sendBriefNow } = await import("@/lib/photographerBrief");
  const r = await sendBriefNow(teamMemberId.trim(), day, { name }).catch(
    (e): BriefActionResult => ({ ok: false, message: `That didn't go through (${e instanceof Error ? e.message : "error"}). Try again.` }),
  );
  revalidatePath("/");
  revalidatePath(`/shoot/brief/${day}`);
  return { ok: r.ok, message: r.message };
}

/** The photographer's "Got it" on their brief for `day`, for the version their page showed. */
export async function acknowledgePhotographerBrief(day: string, digest: string): Promise<BriefActionResult> {
  if (typeof day !== "string" || !DAY_KEY.test(day) || typeof digest !== "string" || !/^[a-f0-9]{32}$/.test(digest)) {
    return { ok: false, message: "Reload the brief, then tap Got it." };
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { ok: false, message: "Please sign in to tap Got it." };
  if (me.impersonating) return { ok: false, message: "A preview can't acknowledge a brief. Only the photographer can." };
  const { photographerMemberId } = await import("@/lib/shoot");
  const memberId = await photographerMemberId(me).catch(() => null);
  if (!memberId) return { ok: false, message: "Your login isn't linked to a photographer on the team, so there is no brief to acknowledge." };
  const { displayNameFor } = await import("@/lib/actorName");
  const by = (await displayNameFor(me)) ?? me.email;
  const { acknowledgeBrief } = await import("@/lib/photographerBrief");
  const r = await acknowledgeBrief({ teamMemberId: memberId, day, digest, by, userId: me.id }).catch(
    (e): BriefActionResult => ({ ok: false, message: `That didn't save (${e instanceof Error ? e.message : "error"}). Try again.` }),
  );
  revalidatePath(`/shoot/brief/${day}`);
  return r;
}
