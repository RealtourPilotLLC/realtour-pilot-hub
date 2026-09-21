"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { putSetting } from "@/lib/settings";
import {
  commsCoachingSettings,
  COMMS_COACHING_SETTING_KEY,
  type CommsCoachingSettings,
} from "@/lib/commsCoaching";

// ---------------------------------------------------------------------------
// The writes behind the Settings card for end-of-day comms coaching.
//
// The SHAPE is commsCoaching.ts's — that module runs the audit and reads this
// row every evening, so it owns the contract and this card is a writer for it.
// Nothing here invents a field the engine does not honour: a switch on this
// screen that changes nothing is worse than a missing switch.
//
// WHY THESE LIVE HERE and not in src/app/settings/actions.ts, where every other
// settings action lives: this feature was built by several hands at once and
// this directory is the coaching feature's own. Folding it into
// settings/actions.ts on the next pass is a move, not a rewrite.
//
// OWNER ONLY, not owner-or-admin. Every other settings write is admin-or-owner
// because Kyle runs operations. This one decides who is audited and whether a
// note reaches them, and Kyle is the person it is about: an admin gate here
// would let the coached person quietly take himself off the roster, which makes
// the whole report untrustworthy. The admin gate runs first (it is the house
// guard: it blocks view-as, passes sessionless local dev, and is always on in
// production), then the owner check.
// ---------------------------------------------------------------------------

async function requireOwnerActor() {
  await requireAdmin();
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER") throw new Error("Only Jordan can change the coaching rules.");
  return me;
}

export type CoachingRosterRow = {
  id: string;
  name: string;
  role: string;
  /** Can the hub actually reach them with a note? No Slack id = no DM. */
  reachable: boolean;
  /** Do they have a login, i.e. can they open /coaching and read their own notes? */
  hasLogin: boolean;
};

/** Who can be put on the coached roster: the active team, with the two facts
 *  that decide whether coaching them will actually work. Fetched by the card
 *  rather than passed in, the same way the creative-approver picker does it —
 *  /settings should not wait on a query most visits never need. */
export async function loadCoachingRoster(): Promise<CoachingRosterRow[]> {
  await requireOwnerActor();
  const [roster, logins] = await Promise.all([
    prisma.teamMember.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true, slackId: true },
      orderBy: { name: "asc" },
    }),
    prisma.appUser.findMany({ where: { status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } }),
  ]);
  const withLogin = new Set(logins.map((l) => l.teamMemberId).filter((id): id is string => !!id));
  return roster.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    reachable: !!r.slackId,
    hasLogin: withLogin.has(r.id),
  }));
}

export async function saveCoachingSettings(input: {
  teamMemberIds: string[];
  sendEnabled: boolean;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const me = await requireOwnerActor();
    // Only ids that are real, ACTIVE team members go in. A stale id in the
    // stored row would have the evening audit looking for a person who is not
    // there, and the report naming somebody nobody is coaching.
    const wanted = Array.from(new Set(input.teamMemberIds.filter((id) => typeof id === "string" && id)));
    const real = wanted.length
      ? await prisma.teamMember.findMany({ where: { id: { in: wanted }, active: true }, select: { id: true } })
      : [];
    const ids = real.map((r) => r.id);
    const dropped = wanted.length - ids.length;

    // Written through the engine's own key and shape, then read BACK through
    // its getter, so this action can never report a state the audit disagrees
    // with. Only the two fields the engine honours are stored.
    const next: CommsCoachingSettings = { teamMemberIds: ids.slice(0, 20), sendEnabled: input.sendEnabled === true };
    await putSetting(COMMS_COACHING_SETTING_KEY, next, me?.email ?? null);
    revalidatePath("/settings");
    revalidatePath("/coaching");
    const saved = await commsCoachingSettings();

    return {
      ok: true,
      message: [
        saved.teamMemberIds.length === 0
          ? "Saved. Nobody is on the roster, so the evening audit reads nothing and writes nothing."
          : `Saved. ${saved.teamMemberIds.length} on the roster.`,
        saved.teamMemberIds.length === 0
          ? ""
          : saved.sendEnabled
            ? "Tonight's note will be sent to them."
            : "Notes stay on your side — nothing is sent to anyone.",
        dropped > 0 ? `${dropped} name could not be saved (no longer on the active team).` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not save." };
  }
}
