import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { homeFor } from "@/lib/auth/access";
import { listAssignees, slugForName, type Assignee } from "@/lib/assignees";
import { taskClientScopeWhere } from "@/lib/taskClientScope";
import { etDate, etDayKey, etDayStartUtc, etHour } from "@/lib/datetime";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { CLIENT_TEXT_TYPES } from "@/lib/clientTexts";
import { noDashes, scrubMoney } from "@/lib/text";
import { DISMISSED_PREFIX } from "@/lib/triage";

// ---------------------------------------------------------------------------
// OLD ITEMS (Jordan, Oct 19 2026): "Things that are really old need to be
// followed up on, flagged for Kyle. He leaves so much in the ops hub untouched
// that it gets backed up. I don't know how to enforce that, maybe through
// notifications."
//
// THE RULE, in one place: an OPEN task that names a PERSON (assignedKey, or the
// TeamMember the routers filed it to) and whose date is 3 or more days behind
// us is OLD. "Its date" is the later of the due date and the chase date
// (followUpAt): a person who picked a new date with "New date" moved the chase
// date, never the promise, so the promise stays honest on every other screen
// while this list stops nagging until the new date is 3 days gone too.
//
// What each old item can become, from Home or /ops/old: Done, Not needed (the
// existing dismissal), or a New date. Every New date is an AuditLog row, so the
// pushes are counted, and the third one flags Jordan.
//
// Once a day, in the morning, each person with old items gets one bell and one
// Slack DM (Kyle's lines ride his existing morning digest instead of a second
// message), and Jordan gets the list of items over a week old.
//
// The one thing this module closes by itself: an AI-extracted shoot note ("Note
// basement to be photographed at 22 White Birch Dr shoot") once the shoot has
// happened. It is closed as a dismissal with its reason, recorded in AuditLog,
// and reversible (undoExpiredShootNotes; scripts/_fix/oct19/old-items-cleanup.ts
// --undo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** Days past its date before an open, assigned task counts as old. */
export const OLD_AFTER_DAYS = 3;
/** Days past its date before an old item is listed to Jordan. */
export const WEEK_OLD_DAYS = 7;
/** The push that flags Jordan ("a 3rd push flags Jordan"). */
export const PUSHES_BEFORE_FLAG = 3;
/** How many "from earlier days" items Kyle's checklist shows before the rest fold. */
export const EARLIER_SHOWN = 5;
/** The furthest out a New date may go. */
export const MAX_PUSH_DAYS = 60;

/** AuditLog actions this module writes. */
export const PUSH_ACTION = "old_item_new_date";
export const EXPIRE_ACTION = "task_auto_expired";
export const EXPIRE_UNDO_ACTION = "task_auto_expire_undone";

const CLOSED = ["COMPLETED", "CANCELLED"];

/** The date an item is judged by: the later of its due date and its chase date. */
export function chaseDate(t: { dueAt: Date | null; followUpAt: Date | null }): Date | null {
  if (t.dueAt && t.followUpAt) return t.dueAt > t.followUpAt ? t.dueAt : t.followUpAt;
  return t.dueAt ?? t.followUpAt ?? null;
}

/** Whole days an item is past its date (0 when it is not past it). */
export function daysPast(t: { dueAt: Date | null; followUpAt: Date | null }, now: Date): number {
  const at = chaseDate(t);
  if (!at) return 0;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY));
}

/** THE RULE. Open, names a person, and its date is 3+ days behind us. */
export function isOldTask(
  t: { status: string; dueAt: Date | null; followUpAt: Date | null; assignedKey: string | null; ownerId: string | null },
  now: Date,
): boolean {
  if (CLOSED.includes(t.status)) return false;
  if (!t.assignedKey && !t.ownerId) return false;
  const at = chaseDate(t);
  return !!at && now.getTime() - at.getTime() >= OLD_AFTER_DAYS * DAY;
}

/** isOldTask, as a query. Kept beside it so the two can only move together. */
export function oldTaskWhere(now: Date, opts: { excludeClientIds?: string[] } = {}): Prisma.SmartTaskWhereInput {
  const cutoff = new Date(now.getTime() - OLD_AFTER_DAYS * DAY);
  return {
    status: { notIn: CLOSED },
    AND: [
      { OR: [{ assignedKey: { not: null } }, { ownerId: { not: null } }] },
      {
        OR: [
          { dueAt: { lte: cutoff }, OR: [{ followUpAt: null }, { followUpAt: { lte: cutoff } }] },
          { dueAt: null, followUpAt: { lte: cutoff } },
        ],
      },
      taskClientScopeWhere(opts),
    ],
  };
}

const KIND_LABEL: Record<string, string> = {
  todo: "To-do",
  internal_instruction: "Instruction",
  lead: "New lead",
  client_reply: "Reply owed",
  comms_followup: "Follow-up",
  callback: "Callback",
  media_qa: "Photo check",
  revision: "Revision",
  edit_video: "Video edit",
  delivery: "Delivery",
  finish_delivery: "Delivery",
  vendor_update: "Vendor",
};
export const kindLabel = (taskType: string) => KIND_LABEL[taskType] ?? "Task";

/** Where an old item is worked from. The same rule as the checklist's loop
 *  rows: a Slack ask's one home is the Slack tab, a job's task opens its job,
 *  anything else the task board's deep link. */
export function oldItemHref(t: { id: string; source: string; projectId: string | null }): string {
  if (t.source === "slack") return `/tasks?tab=slack&task=${t.id}`;
  if (t.projectId) return `/projects/${t.projectId}`;
  return `/tasks?tab=other&task=${t.id}`;
}

export type OldItem = {
  id: string;
  title: string;
  taskType: string;
  kind: string;
  source: string;
  projectId: string | null;
  projectTitle: string | null;
  personKey: string;
  personName: string;
  dueISO: string | null;
  /** the later of due and chase date: what "how old" is counted from */
  chaseISO: string;
  /** set when somebody picked a New date (the chase date is after the due) */
  pushedToISO: string | null;
  daysPast: number;
  pushes: number;
  href: string;
};

export type OldPerson = {
  key: string;
  name: string;
  teamMemberId: string | null;
  total: number;
  /** 7+ days past their date */
  weekOld: number;
  /** pushed three or more times */
  pushedOften: number;
};

export type OldItemsRead = {
  /** the list asked for (one person, or everyone), oldest first */
  items: OldItem[];
  /** everybody, for the owner's roll-up and the morning digests */
  people: OldPerson[];
  total: number;
};

const OWNER_TASK_SELECT = {
  id: true, title: true, taskType: true, source: true, status: true, projectId: true,
  dueAt: true, followUpAt: true, assignedKey: true, ownerId: true,
  owner: { select: { name: true } },
  project: { select: { title: true } },
} satisfies Prisma.SmartTaskSelect;

/** Who an old item belongs to: its assignedKey, else the person the routers
 *  filed it to (ownerId → their first-name key, the openLoopsList rule). */
function personKeyOf(t: { assignedKey: string | null; ownerId: string | null; owner: { name: string } | null }, roster: Assignee[]): string | null {
  if (t.assignedKey) return t.assignedKey;
  if (!t.ownerId) return null;
  const hit = roster.find((a) => a.teamMemberId === t.ownerId);
  if (hit) return hit.key;
  return t.owner?.name ? slugForName(t.owner.name) : null;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

type ItemRow = {
  id: string; title: string; taskType: string; source: string; projectId: string | null;
  dueAt: Date | null; followUpAt: Date | null;
  project: { title: string } | null;
};

/** One task as a list row (the old items list and the daily checklist share it). */
function toOldItem(
  t: ItemRow,
  o: { key: string | null; roster: Assignee[]; now: Date; pushes: Map<string, number>; scrub?: boolean },
): OldItem {
  const at = chaseDate(t);
  const pushed = !!t.followUpAt && (!t.dueAt || t.followUpAt > t.dueAt) && (o.pushes.get(t.id) ?? 0) > 0;
  return {
    id: t.id,
    title: o.scrub ? scrubMoney(t.title) : t.title,
    taskType: t.taskType,
    kind: kindLabel(t.taskType),
    source: t.source,
    projectId: t.projectId,
    projectTitle: t.project?.title?.split(",")[0]?.trim() ?? null,
    personKey: o.key ?? "",
    personName: o.key ? capitalize(o.roster.find((a) => a.key === o.key)?.name ?? o.key) : "Nobody yet",
    dueISO: t.dueAt?.toISOString() ?? null,
    chaseISO: (at ?? o.now).toISOString(),
    pushedToISO: pushed ? t.followUpAt!.toISOString() : null,
    daysPast: daysPast(t, o.now),
    pushes: o.pushes.get(t.id) ?? 0,
    href: oldItemHref(t),
  };
}

/** How many New dates each task has had. */
export async function pushCounts(taskIds: string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await prisma.auditLog.groupBy({ by: ["target"], where: { action: PUSH_ACTION, target: { in: taskIds } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.target, r._count._all]));
}

/**
 * The old items, oldest first. `personKey` narrows `items` to one person (the
 * viewer's own list on Home); `people` always covers everybody, so the owner's
 * roll-up and the morning digests read the same pass. `scrub` takes figures
 * out of titles for a non-owner (Kyle never sees dollar amounts).
 */
export async function listOldItems(
  now: Date = new Date(),
  opts: { personKey?: string | null; excludeClientIds?: string[]; scrub?: boolean; roster?: Assignee[] } = {},
): Promise<OldItemsRead> {
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({
      where: oldTaskWhere(now, { excludeClientIds: opts.excludeClientIds }),
      select: OWNER_TASK_SELECT,
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      take: 600,
    }),
    opts.roster ? Promise.resolve(opts.roster) : listAssignees().catch(() => [] as Assignee[]),
  ]);
  // The query and the rule are one rule; the filter is a belt for a row that
  // changed between the two (and documents that isOldTask is the source).
  const old = rows.filter((t) => isOldTask(t, now));
  const pushes = await pushCounts(old.map((t) => t.id)).catch(() => new Map<string, number>());
  const all: OldItem[] = [];
  for (const t of old) {
    const key = personKeyOf(t, roster);
    if (!key) continue;
    all.push(toOldItem(t, { key, roster, now, pushes, scrub: opts.scrub }));
  }
  all.sort((a, b) => Date.parse(a.chaseISO) - Date.parse(b.chaseISO) || a.title.localeCompare(b.title));
  const byKey = new Map<string, OldPerson>();
  for (const i of all) {
    const p = byKey.get(i.personKey) ?? {
      key: i.personKey,
      name: i.personName,
      teamMemberId: roster.find((a) => a.key === i.personKey)?.teamMemberId ?? null,
      total: 0, weekOld: 0, pushedOften: 0,
    };
    p.total++;
    if (i.daysPast >= WEEK_OLD_DAYS) p.weekOld++;
    if (i.pushes >= PUSHES_BEFORE_FLAG) p.pushedOften++;
    byKey.set(i.personKey, p);
  }
  const people = [...byKey.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const items = opts.personKey === undefined || opts.personKey === null ? all : all.filter((i) => i.personKey === opts.personKey);
  return { items, people, total: items.length };
}

// ---------------------------------------------------------------------------
// THE DAILY CHECKLIST'S TASKS (Jordan, Oct 19 2026: "We just need Kyle to be
// able to keep track of what he got done and what's still outstanding at the
// end of the day"). One person's open tasks, judged by the same date as the
// old items (chaseDate: the later of the due date and a picked New date):
//   · its date is today (ET)     → "Follow-ups due"
//   · its date is before today   → "From earlier days, still open", oldest
//                                  first; 3+ days past is OLD (the rule above)
// and what was closed today, for "Done today".
//
// Whose: the tasks named to the person (assignedKey, or filed to their
// TeamMember with no assignedKey), the leads nobody holds (the lead desk's
// rule: an unassigned lead is the office's to call), and the follow-ups on
// the shared ops pile (no name at all; opsDay.openLoopsList's OPS lane).
// Never: drafted client texts (the Outbox sends those), and a shoot note that
// closes itself (shootNoteExpires, below) is left off.
// ---------------------------------------------------------------------------

/** Whose checklist: an assignee key and/or a TeamMember id (either may be unknown). */
export type ChecklistPerson = { key: string | null; teamMemberId: string | null };

/** Loop kinds that sit on the shared ops pile when nobody's name is on them. */
const OPS_PILE_TYPES = ["comms_followup", "internal_instruction", "callback"];
/** Unclaimed work whose nature is the owner's (opsDay OWNER_LANE_SOURCES). */
const OWNER_PILE_SOURCES = ["content_program"];

/** The person's tasks, as a query (status and dates are the caller's). */
export function personTaskWhere(person: ChecklistPerson, opts: { excludeClientIds?: string[] } = {}): Prisma.SmartTaskWhereInput {
  const whose: Prisma.SmartTaskWhereInput[] = [
    ...(person.key ? [{ assignedKey: person.key }] : []),
    ...(person.teamMemberId ? [{ assignedKey: null, ownerId: person.teamMemberId }] : []),
    { assignedKey: null, taskType: "lead" },
    { assignedKey: null, ownerId: null, taskType: { in: OPS_PILE_TYPES }, source: { notIn: OWNER_PILE_SOURCES } },
  ];
  return { AND: [{ OR: whose }, { taskType: { notIn: [...CLIENT_TEXT_TYPES] } }, taskClientScopeWhere(opts)] };
}

const nextEtDayStart = (now: Date) => etDayStartUtc(new Date(etDayStartUtc(now).getTime() + 36 * 3_600_000));

export type ChecklistTasks = {
  /** its date is today: the "Follow-ups due" group */
  dueToday: OldItem[];
  /** its date is before today, oldest first: "From earlier days, still open" */
  earlier: OldItem[];
};

/** The person's open tasks for today's checklist. `scrub` takes figures out
 *  of titles (Kyle never sees dollar amounts). */
export async function checklistTasks(
  now: Date,
  opts: { person: ChecklistPerson; excludeClientIds?: string[]; scrub?: boolean; roster?: Assignee[] },
): Promise<ChecklistTasks> {
  const startToday = etDayStartUtc(now);
  const startTomorrow = nextEtDayStart(now);
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({
      where: {
        status: { notIn: CLOSED },
        AND: [personTaskWhere(opts.person, opts), { OR: [{ dueAt: { lt: startTomorrow } }, { followUpAt: { lt: startTomorrow } }] }],
      },
      select: {
        id: true, title: true, taskType: true, source: true, status: true, projectId: true,
        dueAt: true, followUpAt: true, assignedKey: true, ownerId: true,
        reasonCreated: true, description: true, flaggedAt: true, assignedManually: true, createdAt: true,
        owner: { select: { name: true } },
        project: { select: { title: true, status: true, shootDate: true } },
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      take: 500,
    }),
    opts.roster ? Promise.resolve(opts.roster) : listAssignees().catch(() => [] as Assignee[]),
  ]);
  // The date is the later of due and chase: a New date in the future keeps a
  // row off today's list even when its promise has passed.
  const dated = rows.filter((t) => {
    const at = chaseDate(t);
    return !!at && at < startTomorrow;
  });
  const pushes = await pushCounts(dated.map((t) => t.id)).catch(() => new Map<string, number>());
  const out: ChecklistTasks = { dueToday: [], earlier: [] };
  for (const t of dated) {
    if (shootNoteExpires({ ...t, pushed: (pushes.get(t.id) ?? 0) > 0 }, now)) continue;
    const item = toOldItem(t, { key: personKeyOf(t, roster), roster, now, pushes, scrub: opts.scrub });
    (chaseDate(t)! >= startToday ? out.dueToday : out.earlier).push(item);
  }
  const byDate = (a: OldItem, b: OldItem) => Date.parse(a.chaseISO) - Date.parse(b.chaseISO) || a.title.localeCompare(b.title);
  out.dueToday.sort(byDate);
  out.earlier.sort(byDate);
  return out;
}

export type ClosedTask = { id: string; title: string; taskType: string; kind: string; how: "done" | "not needed"; atISO: string; href: string };

/** The person's tasks closed today (ET) by anyone: Done (completed today) or
 *  Not needed (a person dismissed it today). The hub's own closes (a shoot
 *  note expiring) are not anybody's work and are left out, and so are client
 *  replies (the checklist counts those under Messages). */
export async function checklistTasksClosedToday(
  now: Date,
  opts: { person: ChecklistPerson; excludeClientIds?: string[]; scrub?: boolean },
): Promise<ClosedTask[]> {
  const startToday = etDayStartUtc(now);
  const rows = await prisma.smartTask.findMany({
    where: {
      AND: [
        personTaskWhere(opts.person, opts),
        { taskType: { not: "client_reply" } },
        {
          OR: [
            { status: "COMPLETED", completedAt: { gte: startToday } },
            { status: "CANCELLED", updatedAt: { gte: startToday }, summary: { startsWith: DISMISSED_PREFIX }, NOT: { summary: { startsWith: `${DISMISSED_PREFIX}the hub` } } },
          ],
        },
      ],
    },
    select: { id: true, title: true, taskType: true, source: true, status: true, projectId: true, completedAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return rows.map((t) => ({
    id: t.id,
    title: opts.scrub ? scrubMoney(t.title) : t.title,
    taskType: t.taskType,
    kind: kindLabel(t.taskType),
    how: t.status === "COMPLETED" ? "done" : "not needed",
    atISO: (t.status === "COMPLETED" ? t.completedAt ?? t.updatedAt : t.updatedAt).toISOString(),
    href: oldItemHref(t),
  }));
}

// ---------------------------------------------------------------------------
// The morning digest lines. Plain words, no dashes (staff-message house style).
// ---------------------------------------------------------------------------

const daysWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** "Old items to clear (12): …" for one person's own list. */
export function oldItemsDigestLines(items: OldItem[], base: string, opts: { shown?: number; owner?: boolean; link?: string } = {}): string[] {
  if (items.length === 0) return [];
  const shown = opts.shown ?? 6;
  // Figures out for everybody but the owner (Kyle never sees dollar amounts).
  const clean = (s: string) => noDashes(opts.owner ? s : scrubMoney(s));
  const lines = [`🧹 Old items to clear (${items.length}): for each one pick Done, Not needed or a new date.`];
  for (const i of items.slice(0, shown)) lines.push(`• ${clean(i.title)} (${daysWord(i.daysPast)} past its date${i.pushes > 0 ? `, pushed ${i.pushes}x` : ""})`);
  if (items.length > shown) lines.push(`  and ${items.length - shown} more`);
  lines.push(`${base}${opts.link ?? "/ops/old"}`);
  return lines;
}

/** "Kyle has 33 items over a week old" for the owner. */
export function weekOldSummaryLines(people: OldPerson[], base: string, opts: { exceptKeys?: string[] } = {}): string[] {
  const rows = people.filter((p) => p.weekOld > 0 && !(opts.exceptKeys ?? []).includes(p.key));
  if (rows.length === 0) return [];
  const lines = rows.map((p) => `• ${p.name} has ${p.weekOld} item${p.weekOld === 1 ? "" : "s"} over a week old${p.pushedOften > 0 ? ` (${p.pushedOften} pushed ${PUSHES_BEFORE_FLAG}+ times)` : ""}`);
  return ["📌 Over a week old on the team:", ...lines, `${base}/ops/old?who=all`];
}

/** Kyle's own lines, for his existing morning digest (notify.kyleMorningDigest). */
export async function kyleOldItemLines(base: string, now: Date = new Date()): Promise<{ lines: string[]; count: number }> {
  const { kyleDigestRecipient } = await import("@/lib/notify");
  const [to, roster] = await Promise.all([kyleDigestRecipient(), listAssignees().catch(() => [] as Assignee[])]);
  const key = roster.find((a) => a.teamMemberId === to.teamMemberId)?.key ?? "kyle";
  const synthetic = await syntheticClientIds();
  const read = await listOldItems(now, { personKey: key, excludeClientIds: synthetic, scrub: true, roster });
  return { lines: oldItemsDigestLines(read.items, base), count: read.items.length };
}

// ---------------------------------------------------------------------------
// ONCE A DAY, IN THE MORNING (the comms cron, every 5 minutes, 8 to 10 AM ET).
// One bell and one Slack DM per person with old items, claimed per person per
// ET day. Kyle's DM is his existing morning digest (the lines above ride it),
// so here he gets only the bell. Jordan's one DM carries his own old items and
// the team's week-old list. Quiet time is the person's own (deliverDigestDm →
// notifySchedule.holdFor: Jordan's Saturday until 7:30 PM is kept, not lost).
// ---------------------------------------------------------------------------

export type MorningResult = { window: boolean; people: { name: string; bell: boolean; dm: string }[] };

export async function oldItemsMorning(now: Date = new Date()): Promise<MorningResult> {
  const hour = etHour(now);
  if (hour < 8 || hour >= 10) return { window: false, people: [] };
  const day = etDayKey(now);
  const { notifyInApp, deliverDigestDm, kyleDigestRecipient } = await import("@/lib/notify");
  const { appBase } = await import("@/lib/appUrl");
  const base = appBase();
  const roster = await listAssignees().catch(() => [] as Assignee[]);
  const read = await listOldItems(now, { excludeClientIds: await syntheticClientIds(), roster });
  const kyle = await kyleDigestRecipient().catch(() => ({ teamMemberId: null, slackId: "" }));
  const owners = await prisma.appUser.findMany({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } });
  const ownerTmIds = new Set(owners.map((o) => o.teamMemberId!));
  const out: MorningResult = { window: true, people: [] };

  // Everybody with old items, plus every owner (the week-old list is theirs
  // even on a day their own list is empty).
  const recipients = new Map<string, { tmId: string; key: string | null; name: string }>();
  for (const p of read.people) {
    const tmId = p.teamMemberId ?? (await import("@/lib/editors").then((m) => m.editorTeamMemberId(p.key)).catch(() => null));
    if (tmId) recipients.set(tmId, { tmId, key: p.key, name: p.name });
  }
  const weekOldAny = read.people.some((p) => p.weekOld > 0);
  if (weekOldAny) for (const id of ownerTmIds) if (!recipients.has(id)) recipients.set(id, { tmId: id, key: roster.find((a) => a.teamMemberId === id)?.key ?? null, name: "Owner" });

  for (const r of recipients.values()) {
    const member = await prisma.teamMember.findUnique({ where: { id: r.tmId }, select: { name: true, slackId: true, active: true } });
    if (!member?.active) continue;
    const isOwner = ownerTmIds.has(r.tmId);
    const mine = r.key ? read.items.filter((i) => i.personKey === r.key) : [];
    const team = isOwner ? weekOldSummaryLines(read.people, base, { exceptKeys: r.key ? [r.key] : [] }) : [];
    if (mine.length === 0 && team.length === 0) continue;
    // ONE claim per person per ET day. The bell's own dedupeKey (the same
    // string, on Notification) keeps a retry from ringing it twice; a refused
    // DM releases this claim (deliverDigestDm) so the next tick retries the DM
    // alone.
    const claimKey = `old-items-${day}-${r.tmId}`;
    // Read first: this runs on every 5-minute tick of the window, and a bare
    // create would log a unique-key error per person per tick once claimed.
    if (await prisma.appSetting.findUnique({ where: { key: claimKey }, select: { key: true } })) continue;
    try {
      await prisma.appSetting.create({ data: { key: claimKey, value: "sent" } });
    } catch {
      continue; // a twin tick took it first
    }
    const user = await prisma.appUser.findFirst({ where: { teamMemberId: r.tmId, status: "ACTIVE" }, select: { role: true } });
    const role = (user?.role ?? (isOwner ? "OWNER" : "ADMIN")) as "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER";
    // /ops/old is an office screen: an editor or photographer is pointed at
    // their own desk, where those same items live.
    const deskHref = role === "OWNER" || role === "ADMIN" ? "/ops/old" : homeFor(role);
    const weekOldTeam = read.people.filter((p) => p.key !== r.key).reduce((n, p) => n + p.weekOld, 0);
    const title = mine.length > 0
      ? `${mine.length} old item${mine.length === 1 ? "" : "s"} to clear`
      : `${weekOldTeam} team item${weekOldTeam === 1 ? "" : "s"} over a week old`;
    const oldest = mine[0];
    const bodyText = oldest
      ? `Oldest: ${noDashes(isOwner ? oldest.title : scrubMoney(oldest.title))} (${daysWord(oldest.daysPast)})`
      : team.slice(1, 3).map((l) => l.replace(/^• /, "")).join("; ");
    await notifyInApp({
      kind: "old_items",
      title,
      body: bodyText,
      href: mine.length > 0 ? deskHref : "/ops/old?who=all",
      targets: [{ roles: [role], userKey: `tm:${r.tmId}` }],
      dedupeKey: claimKey,
    });
    // KYLE: his lines are inside the morning digest he already gets.
    if (kyle.teamMemberId && r.tmId === kyle.teamMemberId) {
      out.people.push({ name: member.name, bell: true, dm: "in the morning digest" });
      continue;
    }
    if (!member.slackId) {
      out.people.push({ name: member.name, bell: true, dm: "no Slack ID on file" });
      continue;
    }
    const lines = [...(mine.length > 0 ? oldItemsDigestLines(mine, base, { owner: isOwner, link: deskHref }) : []), ...team];
    const dm = await deliverDigestDm({ teamMemberId: r.tmId, slackId: member.slackId, text: lines.join("\n"), kind: "old_items", claimKey });
    out.people.push({ name: member.name, bell: true, dm: dm.sent ? "sent" : dm.reason ?? "not sent" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHOOT NOTES THAT OUTLIVED THEIR SHOOT. The inbound-message brain files some
// messages as bookkeeping to-dos rather than replies (tasks.createCommTask,
// taskType "todo", reasonCreated "Inbound message from client (…)"): "Note
// basement to be photographed at 22 White Birch Dr shoot", "Log access codes
// for 3024 N 8th St shoot today". They are information for one shoot. Once
// that shoot has happened nobody will ever tick them, and they were most of
// Kyle's pile of September to-dos. They close themselves now, as a dismissal
// that says why, recorded and reversible.
//
// Precise on purpose (only these close):
//   · taskType todo, source openphone or gmail, reasonCreated "Inbound message
//     from client…" (the brain's to-do from a client message);
//   · open, not flagged by a person, not assigned by hand;
//   · on a job whose shoot DAY is over (ET) and that is past the shoot
//     (SHOT, EDITING, REVIEW, REVISION, DELIVERED) or cancelled;
//   · a title that is a note, not an action: it starts with "Note" or "Log",
//     or it is about getting in (lockbox, access, gate or door code), or it is
//     about "today's shoot";
//   · and when the note is about the EDIT (video, edit, song, music, script,
//     reel, revision), only once the job is DELIVERED.
// Tightened the same evening (audit): status OPEN only (nobody started it),
// written on or before the shoot's day (a note written AFTER the shoot is a
// real ask, not a shoot note), never added to by a later message (a merged
// "New request:" line), and never given a New date by a person.
// ---------------------------------------------------------------------------

const NOTE_START = /^\s*(note|log)\b/i;
const ACCESS_WORDS = /\b(lockbox|lock box|access codes?|gate codes?|door codes?)\b/i;
const TODAYS_SHOOT = /\btoday'?s shoot\b/i;
const EDIT_WORDS = /\b(video|videos|edit|editing|song|music|script|scripts|reel|reels|revision|revisions)\b/i;
const SHOT_STATUSES = ["SHOT", "EDITING", "REVIEW", "REVISION", "DELIVERED", "CANCELLED"];

/** Is this title a shoot note (information for one shoot), not an action? */
export function isShootNoteTitle(title: string): boolean {
  return NOTE_START.test(title) || ACCESS_WORDS.test(title) || TODAYS_SHOOT.test(title);
}

export type ShootNoteCandidate = {
  id: string;
  title: string;
  status: string;
  personKey: string | null;
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  shootISO: string;
  dueISO: string | null;
  createdISO: string;
};

/** The pure decision, for one row (the drill and the query agree on it). */
export function shootNoteExpires(
  t: {
    taskType: string; source: string; status: string; reasonCreated: string | null; title: string;
    flaggedAt: Date | null; assignedManually: boolean;
    project: { status: string; shootDate: Date | null } | null;
    createdAt?: Date | null; description?: string | null; pushed?: boolean;
  },
  now: Date,
): boolean {
  if (t.taskType !== "todo" || t.status !== "OPEN") return false;
  if (t.pushed) return false;
  // Added to by a later message: comms' "New request:" merge, or tasks' "— <time>: <line>" append.
  if (/\n\n(\[[^\]]*\] )?New request: |\n\n— /.test(t.description ?? "")) return false;
  if (t.source !== "openphone" && t.source !== "gmail") return false;
  if (!(t.reasonCreated ?? "").startsWith("Inbound message from client")) return false;
  if (t.flaggedAt || t.assignedManually) return false;
  const p = t.project;
  if (!p?.shootDate || !SHOT_STATUSES.includes(p.status)) return false;
  if (etDayKey(p.shootDate) >= etDayKey(now)) return false; // the shoot day is not over
  if (t.createdAt && etDayKey(t.createdAt) > etDayKey(p.shootDate)) return false; // written after the shoot: a real ask
  if (!isShootNoteTitle(t.title)) return false;
  if (EDIT_WORDS.test(t.title) && p.status !== "DELIVERED") return false;
  return true;
}

export async function findExpiringShootNotes(now: Date = new Date()): Promise<ShootNoteCandidate[]> {
  const rows = await prisma.smartTask.findMany({
    where: {
      taskType: "todo",
      status: { notIn: CLOSED },
      source: { in: ["openphone", "gmail"] },
      reasonCreated: { startsWith: "Inbound message from client" },
      projectId: { not: null },
    },
    select: {
      id: true, title: true, status: true, taskType: true, source: true, reasonCreated: true, description: true,
      flaggedAt: true, assignedManually: true, assignedKey: true, dueAt: true, createdAt: true, projectId: true,
      owner: { select: { name: true } },
      project: { select: { title: true, status: true, shootDate: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  // A person who gave the row a New date has said it is still live.
  const pushedIds = rows.length
    ? new Set((await prisma.auditLog.findMany({ where: { action: PUSH_ACTION, target: { in: rows.map((r) => r.id) } }, select: { target: true } })).map((a) => a.target))
    : new Set<string | null>();
  return rows
    .filter((t) => shootNoteExpires({ ...t, pushed: pushedIds.has(t.id) }, now))
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      personKey: t.assignedKey ?? (t.owner?.name ? slugForName(t.owner.name) : null),
      projectId: t.projectId!,
      projectTitle: t.project!.title.split(",")[0],
      projectStatus: t.project!.status,
      shootISO: t.project!.shootDate!.toISOString(),
      dueISO: t.dueAt?.toISOString() ?? null,
      createdISO: t.createdAt.toISOString(),
    }));
}

/** The stamp an expired note carries (the dismissal vocabulary, so the Done
 *  tab files it under Dismissed and the routers do not reopen it on a "thanks"). */
export function expiredStamp(shoot: Date): string {
  return `${DISMISSED_PREFIX}the hub — shoot note, the shoot happened ${etDate(shoot)}.`;
}

export async function expireShootNotes(now: Date = new Date(), opts: { apply: boolean; actor?: string }): Promise<{ candidates: ShootNoteCandidate[]; closed: number }> {
  const candidates = await findExpiringShootNotes(now);
  if (!opts.apply) return { candidates, closed: 0 };
  let closed = 0;
  for (const c of candidates) {
    const before = await prisma.smartTask.findUnique({ where: { id: c.id }, select: { status: true, summary: true } });
    if (!before || CLOSED.includes(before.status)) continue;
    const stamp = expiredStamp(new Date(c.shootISO));
    const summary = (before.summary ? `${stamp}\n${before.summary}` : stamp).slice(0, 500);
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.smartTask.updateMany({ where: { id: c.id, status: before.status }, data: { status: "CANCELLED", completedAt: null, summary } });
      if (r.count !== 1) return 0;
      await tx.auditLog.create({
        data: {
          actor: opts.actor ?? "system",
          action: EXPIRE_ACTION,
          target: c.id,
          detail: JSON.stringify({ rule: "shoot-note", fromStatus: before.status, summaryBefore: before.summary, shootDate: c.shootISO, projectStatus: c.projectStatus, title: c.title }),
        },
      });
      return 1;
    });
    closed += done;
  }
  return { candidates, closed };
}

/** Put expired shoot notes back exactly as they were. Only rows still in the
 *  state the expiry left them (cancelled, still carrying the stamp). */
export async function undoExpiredShootNotes(opts: { since?: Date; ids?: string[]; apply: boolean; actor?: string }): Promise<{ eligible: { id: string; title: string }[]; reopened: number }> {
  const logs = await prisma.auditLog.findMany({
    where: { action: EXPIRE_ACTION, ...(opts.since ? { createdAt: { gte: opts.since } } : {}), ...(opts.ids?.length ? { target: { in: opts.ids } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const seen = new Set<string>();
  const eligible: { id: string; title: string; fromStatus: string; summaryBefore: string | null }[] = [];
  for (const l of logs) {
    if (seen.has(l.target)) continue;
    seen.add(l.target);
    let d: { fromStatus?: string; summaryBefore?: string | null; title?: string };
    try { d = JSON.parse(l.detail); } catch { continue; }
    const t = await prisma.smartTask.findUnique({ where: { id: l.target }, select: { status: true, summary: true, title: true } });
    if (!t || t.status !== "CANCELLED" || !(t.summary ?? "").startsWith(`${DISMISSED_PREFIX}the hub — shoot note`)) continue;
    eligible.push({ id: l.target, title: t.title, fromStatus: d.fromStatus ?? "OPEN", summaryBefore: d.summaryBefore ?? null });
  }
  if (!opts.apply) return { eligible: eligible.map(({ id, title }) => ({ id, title })), reopened: 0 };
  let reopened = 0;
  for (const e of eligible) {
    const r = await prisma.$transaction(async (tx) => {
      const u = await tx.smartTask.updateMany({ where: { id: e.id, status: "CANCELLED" }, data: { status: e.fromStatus, summary: e.summaryBefore } });
      if (u.count !== 1) return 0;
      await tx.auditLog.create({ data: { actor: opts.actor ?? "system", action: EXPIRE_UNDO_ACTION, target: e.id, detail: JSON.stringify({ restoredStatus: e.fromStatus }) } });
      return 1;
    });
    reopened += r;
  }
  return { eligible: eligible.map(({ id, title }) => ({ id, title })), reopened };
}

/** Counts by type and by age, for the cleanup script's dry run. */
export async function oldItemsCensus(now: Date = new Date(), opts: { excludeClientIds?: string[] } = {}): Promise<{
  total: number;
  byType: [string, number][];
  byAge: [string, number][];
  byPerson: [string, number][];
}> {
  const read = await listOldItems(now, opts);
  const tally = (f: (i: OldItem) => string) => {
    const m = new Map<string, number>();
    for (const i of read.items) m.set(f(i), (m.get(f(i)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const bucket = (d: number) => (d >= 30 ? "30+ days" : d >= 14 ? "14 to 29 days" : d >= 7 ? "7 to 13 days" : "3 to 6 days");
  return { total: read.items.length, byType: tally((i) => i.taskType), byAge: tally((i) => bucket(i.daysPast)), byPerson: tally((i) => i.personName) };
}
