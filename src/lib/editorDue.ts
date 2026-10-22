import "server-only";
import { prisma } from "@/lib/prisma";
import { getVideoSlaStatus, videoTier } from "@/lib/projectStatus";
import { pinnedPromise, type PromiseRules } from "@/lib/turnaround";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// THE EDIT'S DUE DATE IN EVERY "YOU HAVE WORK" MESSAGE (Oct 22 2026). Jordan:
// "it would be helpful for the editors to know when a project is due." The
// brief's header already counted down, but the Slack DMs and texts that tell
// Kim and John Mark about work ("Ready for editing", "New edit", "Reassigned to
// you", "Task for you") never said when, and their desk list showed only the
// day. One reading of the date, the same as the brief's header (the video
// clock from the visit that shot it, the office's tier, then an office date
// override or a pinned promise: editOverrides.effectiveDue), worded in Eastern
// time with the editor's own time beside it.
//
// ONE VIDEO DUE FOR EVERY SCREEN (Oct 22 2026, audit H1). The Video Review
// Room's board (and the behind alert that reads it) dated a listing video by
// the order line whose NAME had a video word in it, and "Social Influencer",
// "Standard Package" and "Agent on Camera" have none — so those videos took
// the job's earliest item instead (the next-day Zillow tour, the photos) and
// read late the day after the shoot. videoDueOf is the date, stated once: it
// reads the job's VIDEO DELIVERABLE ROWS through the SLA engine (the tier, the
// visit that shot it, the office's editable promises), never a product name,
// and the board, the ping and the brief all call it.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const HOUR = 3_600_000;
/** The edit is handed in this long before the video is due, so review has time (the aim, never the due). */
export const EDIT_AIM_HOURS = 12;

/** What the one video due reads off a project row. */
export type VideoDueInput = {
  shootDate: Date | null;
  status?: string | null;
  tierOverride?: string | null;
  packageName?: string | null;
  /** the office's date for the job (editOverrides): wins over everything but a reopen's clock */
  dueOverrideAt: Date | null;
  /** the promise the job was sold under (pinnedPromise: void when a rebooked visit passed it) */
  promisedDueAt?: Date | null;
  appointments?: { status: string | null; startAt: Date | null }[];
  /** OWED rows only (OWED_DELIVERABLE_WHERE) */
  deliverables: { type: string; label: string | null }[];
  client?: { socialClient?: boolean | null } | null;
};

export type VideoDueSource = "reopened" | "office" | "promise" | "sla";
export type VideoDue = {
  /** When the video is due (late after this). Null: no video owed, or nothing dates it. */
  at: Date | null;
  source: VideoDueSource | null;
  /** When to aim to hand the edit in (EDIT_AIM_HOURS before `at`) — words only, never a due date. Null on an office or reopened date. */
  aimAt: Date | null;
};

/** The select videoDueOf needs. */
export const VIDEO_DUE_SELECT = {
  shootDate: true, status: true, tierOverride: true, packageName: true, dueOverrideAt: true, promisedDueAt: true,
  appointments: { select: { status: true, startAt: true } },
  deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
  client: { select: { socialClient: true } },
} as const;

/**
 * THE video due, pure. In the order the hub trusts dates:
 *   1. a reopened job's clock (when the caller passes one: `reopened`),
 *   2. the office's date (dueOverrideAt),
 *   3. the promise the job was sold under (pinnedPromise),
 *   4. the SLA engine off the video deliverable rows (getVideoSlaStatus: the
 *      office's tier, else the hub's reading of the rows; the clock from the
 *      last visit that has happened).
 * A job that owes no video has no date (the photos are not the edit's clock).
 */
export function videoDueOf(
  p: VideoDueInput,
  opts: { now?: Date; rules?: PromiseRules | null; reopened?: { at: Date | null } | null } = {},
): VideoDue {
  if (!videoTier(p.deliverables)) return { at: null, source: null, aimAt: null };
  if (opts.reopened) return { at: opts.reopened.at, source: opts.reopened.at ? "reopened" : null, aimAt: null };
  if (p.dueOverrideAt) return { at: p.dueOverrideAt, source: "office", aimAt: null };
  const aim = (at: Date) => new Date(at.getTime() - EDIT_AIM_HOURS * HOUR);
  const pin = pinnedPromise(p);
  if (pin) return { at: pin, source: "promise", aimAt: aim(pin) };
  const sla = getVideoSlaStatus(
    { shootDate: p.shootDate, status: p.status ?? null, deliverables: p.deliverables, client: p.client ?? null, appointments: p.appointments ?? [], tierOverride: p.tierOverride ?? null, packageName: p.packageName ?? null },
    { now: (opts.now ?? new Date()).getTime(), ...(opts.rules ? { rules: opts.rules } : {}) },
  );
  return sla ? { at: sla.due, source: "sla", aimAt: aim(sla.due) } : { at: null, source: null, aimAt: null };
}

/** The office's editable promises, or the built-in ones when they cannot be read. */
async function promiseRules(): Promise<PromiseRules | undefined> {
  return import("@/lib/settings").then((m) => m.turnaroundRules()).catch(() => undefined);
}

/** The video due for many jobs in one read (the board). Jobs not found are absent. */
export async function videoDuesFor(projectIds: string[], opts: { now?: Date } = {}): Promise<Map<string, VideoDue>> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return new Map();
  const [rows, rules] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, ...VIDEO_DUE_SELECT } }),
    promiseRules(),
  ]);
  return new Map(rows.map((p) => [p.id, videoDueOf(p, { now: opts.now, rules })]));
}

/** When this job's edit is due, or null when it owes no video. */
export async function editDueFor(projectId: string): Promise<Date | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: VIDEO_DUE_SELECT }).catch(() => null);
  if (!p) return null;
  return videoDueOf(p, { rules: await promiseRules() }).at;
}

const fmt = (d: Date, tz: string) =>
  d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(":00", "");

/** "due Thu, Oct 23, 4 PM ET (Fri, Oct 24, 4 AM Manila)". Pure. */
export function dueWordsFor(due: Date, editorTz?: string | null): string {
  const et = `due ${fmt(due, ET)} ET`;
  if (!editorTz || editorTz === ET) return et;
  const city = editorTz.split("/").pop()?.replace(/_/g, " ") ?? editorTz;
  return `${et} (${fmt(due, editorTz)} ${city})`;
}

/** The words for one job and one editor key, or "" when there is no date. */
export async function editDueWords(projectId: string | null | undefined, editorKey?: string | null): Promise<string> {
  if (!projectId) return "";
  const due = await editDueFor(projectId);
  if (!due) return "";
  const { editorMeta } = await import("@/lib/editors");
  return dueWordsFor(due, editorKey ? editorMeta(editorKey)?.tz ?? null : null);
}
