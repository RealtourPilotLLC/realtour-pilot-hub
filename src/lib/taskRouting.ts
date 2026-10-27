import "server-only";
import { prisma } from "@/lib/prisma";
import { slugForName } from "@/lib/assignees";

// ---------------------------------------------------------------------------
// WHO GETS WHICH TASK, AT THE SOURCE (Jordan, Oct 27 2026: "Kyle handles comms,
// delegation, review, delivery, and coordination. James is the creative
// manager. I am CEO. Make sure everything is structured that way." And:
// "Kyle should not have to do anything with Kristen Pavillard. ... That should
// go to the Creative Manager and Jordan.").
//
// The engines that mint these tasks ask here instead of writing "kyle":
//
//   brand update (brand-ack, CP-06)          brandProfile.ensureAckTask        creative manager
//   content-program mid-month milestone      programReminders.raiseMidMonth…   creative manager
//     (never before the program has started: no strategy in the portal yet,
//      or the program began after that month's 15th)
//   "Filmed beyond the plan"                 tasks.fileCapacityReview          creative manager
//   Script Studio script package / client    webhooks/scripting                listing-scripts owner
//     response on a listing script, and the   tasks.createCommTask (todo)       (the creative manager
//     brain's "...script package" to-dos                                         since the Loom, 3:51)
//   overdue program escalations              programReminders.escalate         ESCALATION duty (Jordan), unchanged
//
// The creative manager is whoever carries TeamMember.creativeManager (James),
// read off the roster, never a name. With nobody carrying the flag the work is
// the owner's (content-program clients are the creative manager's and
// Jordan's, never the office's), and with no owner on the roster either the
// row is left unassigned rather than guessed.
//
// A row's `assignedKey` is the assignee slug (assignees.slugForName), the same
// key the creative desk reads as "mine" (creativeDesk readAssigned) and the
// daily checklist reads through personTaskWhere; `ownerId` is the roster row.
// ---------------------------------------------------------------------------

/** One person's desk, as a task row stores them. */
export type TaskDesk = { id: string; key: string; name: string };

const deskOf = (tm: { id: string; name: string } | null): TaskDesk | null => {
  if (!tm) return null;
  const key = slugForName(tm.name);
  return key ? { id: tm.id, key, name: tm.name } : null;
};

/** The creative manager's desk: the active roster row with the creativeManager
 *  flag (the first by name if, unusually, two carry it). Null when nobody does. */
export async function creativeManagerDesk(): Promise<TaskDesk | null> {
  const tm = await prisma.teamMember
    .findFirst({ where: { creativeManager: true, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } })
    .catch(() => null);
  return deskOf(tm);
}

/** The owner's desk: the active OWNER login's roster row (by its link, else by
 *  its email), else the roster's owner chip (assignees.listAssignees, the same
 *  "owner" the assignee picker and meeting prep use). Null when none resolves. */
export async function ownerDesk(): Promise<TaskDesk | null> {
  const login = await prisma.appUser
    .findFirst({ where: { role: "OWNER", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { teamMemberId: true, email: true } })
    .catch(() => null);
  const tm =
    (login?.teamMemberId
      ? await prisma.teamMember.findFirst({ where: { id: login.teamMemberId, active: true }, select: { id: true, name: true } }).catch(() => null)
      : null) ??
    (login?.email
      ? await prisma.teamMember.findFirst({ where: { email: { equals: login.email, mode: "insensitive" }, active: true }, select: { id: true, name: true } }).catch(() => null)
      : null);
  if (tm) return deskOf(tm);
  const { listAssignees } = await import("@/lib/assignees");
  const chip = (await listAssignees().catch(() => [])).find((a) => a.kind === "owner" && a.teamMemberId);
  return chip?.teamMemberId ? { id: chip.teamMemberId, key: chip.key, name: chip.name } : null;
}

/** Creative work on a content client (brand updates, program milestones,
 *  filmed extras): the creative manager, else the owner. */
export async function creativeWorkDesk(): Promise<TaskDesk | null> {
  return (await creativeManagerDesk()) ?? (await ownerDesk());
}

/** Listing scripts (Script Studio's packages, "Review and action Premium Reel
 *  script package", and the client's replies on them). The creative manager
 *  approves them (Jordan's Loom, Oct 27 2026, 3:51: "I don't need to approve
 *  the scripts, James can approve them ... he's the content manager"), else
 *  the owner when there is no creative manager. */
export async function listingScriptsDesk(): Promise<TaskDesk | null> {
  return (await creativeManagerDesk()) ?? (await ownerDesk());
}

/** A to-do the comms brain filed about a listing script (Script Studio's
 *  "Review and action Premium Reel script package" email, Oct 27 2026): the
 *  listing-scripts desk's, not the office's. Monthly content scripts never
 *  say "reel", "listing" or "script package". */
export const isListingScriptTask = (title: string | null | undefined): boolean =>
  /\bscript package\b/i.test(title ?? "") || /\b(reel|listing) script\b/i.test(title ?? "");

/** The fields a task row takes for a desk (both null when nobody resolves). */
export const deskFields = (d: TaskDesk | null) => ({ assignedKey: d?.key ?? null, ownerId: d?.id ?? null });
