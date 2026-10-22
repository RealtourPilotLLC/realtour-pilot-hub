import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// EVERYTHING ON SLACK (Oct 22 2026). Jordan: "please make sure I get all
// notifications via slack." A per-person switch (AppSetting
// `notify-all-slack:<teamMemberId>` = {"on":true}): every bell row addressed
// to them is also a Slack DM, and for an owner every OWNER broadcast too
// (notify.ts). Their quiet time still holds the DM, exactly like any other.
//
// Its own module with prisma as its only import: notify.ts loads it
// statically, and reaching it through notifyPrefs/smsPrefs (which lead back
// to notify.ts) made Turbopack emit two different copies of one chunk.
// ---------------------------------------------------------------------------

export const allSlackKey = (teamMemberId: string) => `notify-all-slack:${teamMemberId}`;

export async function wantsAllSlack(teamMemberId: string): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: allSlackKey(teamMemberId) }, select: { value: true } });
    return !!row && (JSON.parse(row.value) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

/** The owners (roster ids, active OWNER logins) who asked for every notification on Slack. */
export async function allSlackOwnerIds(): Promise<string[]> {
  const owners = await prisma.appUser
    .findMany({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } })
    .catch(() => [] as { teamMemberId: string | null }[]);
  const out: string[] = [];
  for (const o of owners) if (o.teamMemberId && (await wantsAllSlack(o.teamMemberId))) out.push(o.teamMemberId);
  return out;
}
