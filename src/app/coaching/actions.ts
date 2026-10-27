"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { readCoachingAudit } from "@/lib/commsCoaching";
import { cleanAckNote, coachingAckKey, parseAck, validAckTarget, type CoachingAck } from "@/lib/coachingAck";
import { photographerMemberId as teamMemberIdForLogin } from "@/lib/shoot";

// ---------------------------------------------------------------------------
// "GOT IT" (Jordan, Oct 27 2026: "give him an option to acknowledge, you know,
// whatever the coaching is"). The person a coaching note is about marks it
// read, with an optional note; pressing again changes the note and keeps the
// first time. The guard is the page's own rule: the login must resolve to the
// person the note is about (the same house email → TeamMember resolution the
// page reads their notes with). Jordan reads the report and does not press it
// for anyone; a preview ("view as") is refused like every other write here;
// a signed-out call is refused even with sign-in switched off, because a
// "Got it" with nobody's name on it means nothing. Nothing is sent.
// ---------------------------------------------------------------------------

export type AckResult = { ok: true; ack: CoachingAck } | { ok: false; message: string };

export async function acknowledgeCoachingNote(input: { teamMemberId: string; dayKey: string; note?: string | null }): Promise<AckResult> {
  try {
    const me = await getCurrentUser().catch(() => null);
    if (!me) return { ok: false, message: "Please sign in to do that." };
    if (me.impersonating) return { ok: false, message: "You're previewing another user. Exit the preview to make changes." };
    if (!validAckTarget(input?.teamMemberId, input?.dayKey)) return { ok: false, message: "That note could not be found." };
    const myId = await teamMemberIdForLogin(me).catch(() => null);
    if (!myId || myId !== input.teamMemberId) return { ok: false, message: "Only the person this note is about can say Got it." };
    const audit = await readCoachingAudit(input.teamMemberId, input.dayKey);
    if (!audit) return { ok: false, message: "That note could not be found." };

    const key = coachingAckKey(input.teamMemberId, input.dayKey);
    const before = parseAck((await prisma.appSetting.findUnique({ where: { key }, select: { value: true } }))?.value);
    const note = cleanAckNote(input.note);
    const now = new Date().toISOString();
    const ack: CoachingAck = {
      teamMemberId: input.teamMemberId,
      dayKey: input.dayKey,
      by: me.realName || me.name || me.email,
      byEmail: me.email,
      at: before?.at ?? now,
      note,
      noteAt: before && before.note !== note ? now : before?.noteAt ?? null,
    };
    const value = JSON.stringify(ack);
    await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy: me.email }, update: { value, updatedBy: me.email } });
    revalidatePath("/coaching");
    return { ok: true, ack };
  } catch (e) {
    console.error("[coaching] Got it failed", e);
    return { ok: false, message: "Not saved. Try again." };
  }
}
