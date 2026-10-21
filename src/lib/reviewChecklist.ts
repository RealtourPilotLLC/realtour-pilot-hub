import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHO MAY GIVE CREATIVE DIRECTION (Oct 15 2026).
//
// This file held the reviewer's two-part check (a technical and a creative
// block to tick before Approve) and its server gate. Jordan took the checklist
// out of the Review Room on Oct 16 ("Make sure you didn't overcomplicate the
// review portion ... We know what to look for"), and on Oct 20 2026 (audit B5)
// the gate went too: it read a `review_checklist` switch nothing could turn on
// or off, and with it on every approval would have been refused with no
// checklist to fill. The approval itself is the sign-off.
//
// What is left is the one question other screens still ask: is this person a
// creative approver (Jordan, or the creative-approver seat, James)?
// ---------------------------------------------------------------------------

type Actor = { realRole: string; impersonating: boolean; teamMemberId: string | null; status?: string; name: string | null; editorKey: string | null; id?: string | null; email?: string | null } | null | undefined;

/**
 * Is this person a CREATIVE approver? Jordan (the owner login) or the
 * creative-approver seat (review_room.creativeApproverTeamMemberId, James).
 * Kyle's admin login is not, by design. Sessionless local dev answers yes,
 * like every guard.
 */
export async function isCreativeApprover(me: Actor, opts: { authEnforced: boolean }): Promise<boolean> {
  if (!me) return !opts.authEnforced;
  if (me.impersonating) return false;
  if (me.realRole === "OWNER") return true;
  if (!me.teamMemberId) return false;
  const { reviewRoomRules } = await import("@/lib/settings");
  const rules = await reviewRoomRules().catch(() => null);
  if (!rules?.creativeApproverTeamMemberId || rules.creativeApproverTeamMemberId !== me.teamMemberId) return false;
  const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { active: true } }).catch(() => null);
  return !!tm?.active;
}
