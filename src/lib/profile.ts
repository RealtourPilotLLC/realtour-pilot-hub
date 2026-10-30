import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHOSE PROFILE (Oct 30 2026, /profile). A login (AppUser) is who signs in;
// the TEAM CARD (TeamMember) is where the hub keeps a person's phone, clock,
// location and photo, because that is what every text, Slack ping, editor
// desk and avatar already reads. The card is the login's linked one, else the
// card on the same email, the same rule People → Logins uses.
// ---------------------------------------------------------------------------

export const PROFILE_CARD_SELECT = {
  id: true, name: true, email: true, role: true, active: true,
  phone: true, timezone: true, location: true, photoAt: true, slackId: true, editorKey: true,
} as const;

export async function myTeamCard(me: { teamMemberId: string | null; email: string }) {
  if (me.teamMemberId) {
    const linked = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: PROFILE_CARD_SELECT });
    if (linked) return linked;
  }
  return prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" } }, select: PROFILE_CARD_SELECT });
}
