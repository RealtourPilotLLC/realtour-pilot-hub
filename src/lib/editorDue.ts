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
// ONE VIDEO DUE FOR EVERY SCREEN (Oct 22 2026, audits H1 and H2). The Video
// Review Room's board (and the behind alert that reads it) dated a listing
// video by the order line whose NAME had a video word in it, and "Social
// Influencer", "Standard Package" and "Agent on Camera" have none, so those
// videos took the job's earliest item instead (the next-day Zillow tour, the
// photos) and read late the day after the shoot. And the same edit showed up
// to four different dates: the ping (the SLA engine), the editor's desk
// (Project.deliveryDue), the edit card (the SLA minus a 12-hour buffer, from
// the shoot date, capped by the pin) and the board (the order's earliest
// item). videoDueOf is the date, stated once: it reads the job's VIDEO
// DELIVERABLE ROWS through the SLA engine (the tier, the visit that shot it,
// the office's editable promises), never a product name, and the board, the
// ping, the desk, the edit card and the brief all call it. The 12 hours the
// edit card used to take off is the AIM (aimAt), shown in words, never the due.
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

export type VideoDueSource = "reopened" | "office" | "batch" | "promise" | "sla";
export type VideoDue = {
  /** When the video is due (late after this). Null: no video owed, or nothing dates it. */
  at: Date | null;
  source: VideoDueSource | null;
  /** When to aim to hand the edit in (EDIT_AIM_HOURS before `at`): words only, never a due date. Null on an office or reopened date. */
  aimAt: Date | null;
  /** What the hub says on its own, before the office or a reopen speak: the
   *  pin, else the SLA (the override dialog's "hub's value"). */
  computedAt: Date | null;
};

const NONE: VideoDue = { at: null, source: null, aimAt: null, computedAt: null };

/** The select videoDueOf needs (plus what videoDuesFor reads to find a reopened job). */
export const VIDEO_DUE_SELECT = {
  shootDate: true, status: true, tierOverride: true, packageName: true, dueOverrideAt: true, promisedDueAt: true,
  deliveredAt: true, revisionRequestedAt: true, overrideAt: true,
  appointments: { select: { status: true, startAt: true } },
  deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
  client: { select: { socialClient: true } },
} as const;

/**
 * THE video due, pure. In the order the hub trusts dates:
 *   1. a reopened job's clock (when the caller passes one: `reopened`),
 *   2. the office's date (dueOverrideAt),
 *   3. a bulk plan's current batch (`batch`: the earliest open video's batch
 *      date, lib/bulkBatches; Jordan, Oct 27 2026: "8 videos done every 7 - 10
 *      business days"), with its aim of 7 business days,
 *   4. the promise the job was sold under (pinnedPromise),
 *   5. the SLA engine off the video deliverable rows (getVideoSlaStatus: the
 *      office's tier, else the hub's reading of the rows; the clock from the
 *      last visit that has happened).
 * A job that owes no video has no date (the photos are not the edit's clock).
 * The pin is the promise as it was SOLD: a pin frozen before Oct 22 2026, when
 * premium reels and monthly batches moved to calendar days, keeps its later
 * date (the ping has always read it that way).
 */
export function videoDueOf(
  p: VideoDueInput,
  opts: { now?: Date; rules?: PromiseRules | null; reopened?: { at: Date | null } | null; batch?: { at: Date; aimAt: Date | null } | null } = {},
): VideoDue {
  if (!videoTier(p.deliverables)) return NONE;
  const aim = (at: Date) => new Date(at.getTime() - EDIT_AIM_HOURS * HOUR);
  const pin = pinnedPromise(p);
  const sla = pin
    ? null
    : getVideoSlaStatus(
        { shootDate: p.shootDate, status: p.status ?? null, deliverables: p.deliverables, client: p.client ?? null, appointments: p.appointments ?? [], tierOverride: p.tierOverride ?? null, packageName: p.packageName ?? null },
        { now: (opts.now ?? new Date()).getTime(), ...(opts.rules ? { rules: opts.rules } : {}) },
      );
  const computedAt = opts.batch?.at ?? pin ?? sla?.due ?? null;
  if (opts.reopened) return { at: opts.reopened.at, source: opts.reopened.at ? "reopened" : null, aimAt: null, computedAt };
  if (p.dueOverrideAt) return { at: p.dueOverrideAt, source: "office", aimAt: null, computedAt };
  if (opts.batch) return { at: opts.batch.at, source: "batch", aimAt: opts.batch.aimAt, computedAt };
  if (pin) return { at: pin, source: "promise", aimAt: aim(pin), computedAt };
  return sla ? { at: sla.due, source: "sla", aimAt: aim(sla.due), computedAt } : NONE;
}

/** The office's editable promises, or the built-in ones when they cannot be read. */
async function promiseRules(): Promise<PromiseRules | undefined> {
  return import("@/lib/settings").then((m) => m.turnaroundRules()).catch(() => undefined);
}

/**
 * The video due for many jobs in one read (the board, the desk; one id for the
 * ping and the edit card). A job delivered once and owed again reads its
 * REOPEN clock (A52), by the delivery board's own test and reader
 * (isReopenedJob, reopenedDueFor), never the promise it already kept. A job on
 * a bulk plan reads its current batch: the earliest batch date among its videos
 * not yet approved (DeliverableOutput, promiseSource "bulk-batch"). Jobs not
 * found are absent.
 */
export async function videoDuesFor(projectIds: string[], opts: { now?: Date } = {}): Promise<Map<string, VideoDue>> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return new Map();
  const [rows, rules, batch] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, ...VIDEO_DUE_SELECT } }),
    promiseRules(),
    import("@/lib/bulkBatches").then((m) => m.batchDuesFor(ids)).catch(() => new Map<string, { at: Date; aimAt: Date | null }>()),
  ]);
  const deliveredOnce = rows.filter((p) => !!p.deliveredAt);
  const board = deliveredOnce.length ? await import("@/lib/deliveryBoard") : null;
  const [clocks, dueSet] = board
    ? await Promise.all([
        board.reopenedClocksFor(deliveredOnce.map((p) => p.id)),
        board.dueSetTimesFor(deliveredOnce.filter((p) => !!p.dueOverrideAt).map((p) => p.id)),
      ])
    : [new Map(), new Map()];
  return new Map(
    rows.map((p) => {
      const clock = clocks.get(p.id) ?? null;
      const reopened = board && board.isReopenedJob(p, clock) ? board.reopenedDueFor({ ...p, dueSetAt: dueSet.get(p.id) ?? null }, clock) : null;
      return [p.id, videoDueOf(p, { now: opts.now, rules, reopened: reopened ? { at: reopened.at } : null, batch: batch.get(p.id) ?? null })];
    }),
  );
}

/** The one job's video due (the edit card, the brief). Null when the job is not found. */
export async function videoDueFor(projectId: string, opts: { now?: Date } = {}): Promise<VideoDue | null> {
  return (await videoDuesFor([projectId], opts)).get(projectId) ?? null;
}

/** When this job's edit is due, or null when it owes no video. */
export async function editDueFor(projectId: string): Promise<Date | null> {
  const d = await videoDueFor(projectId).catch(() => null);
  return d?.at ?? null;
}

const fmt = (d: Date, tz: string, weekday = true) =>
  d.toLocaleString("en-US", { timeZone: tz, ...(weekday ? { weekday: "short" as const } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(":00", "");

/** "due Thu, Oct 23, 4 PM ET (Fri, Oct 24, 4 AM Manila)". Pure. `short` drops the weekdays. */
export function dueWordsFor(due: Date, editorTz?: string | null, short = false): string {
  const et = `due ${fmt(due, ET, !short)} ET`;
  if (!editorTz || editorTz === ET) return et;
  const city = editorTz.split("/").pop()?.replace(/_/g, " ") ?? editorTz;
  return `${et} (${fmt(due, editorTz, !short)} ${city})`;
}

/** "Oct 24, 1 PM ET". Pure. */
export function etWhen(d: Date): string {
  return `${fmt(d, ET)} ET`;
}

/** The bell's title cap (notify.notifyInApp cuts every title here). */
export const PING_TITLE_MAX = 90;

/**
 * A ping title that keeps the due words WHOLE (Oct 22 2026, audit L1). The
 * bell cuts titles at 90 characters, and "Ready for editing — 538 Onward Ave,
 * due Sat, Oct 24, 2:07 PM ET (Sun, Oct 25, 2:07 AM Manila)" lost the end of
 * the editor's own time ("…2:07 AM Mani"). So: the full words when they fit;
 * then the words without the weekdays; then the head is shortened (with "…"),
 * never the time. Pure.
 */
export function titleWithDue(head: string, due: Date | null, editorTz?: string | null, max = PING_TITLE_MAX): string {
  if (!due) return head.slice(0, max);
  for (const short of [false, true]) {
    const t = `${head}, ${dueWordsFor(due, editorTz, short)}`;
    if (t.length <= max) return t;
  }
  const words = dueWordsFor(due, editorTz, true);
  const room = Math.max(0, max - words.length - 3); // ", " and "…"
  return `${head.slice(0, room).trimEnd()}…, ${words}`.slice(0, max);
}

/** The words for one job and one editor key, or "" when there is no date. */
export async function editDueWords(projectId: string | null | undefined, editorKey?: string | null): Promise<string> {
  if (!projectId) return "";
  const due = await editDueFor(projectId);
  if (!due) return "";
  const { editorMeta } = await import("@/lib/editors");
  return dueWordsFor(due, editorKey ? editorMeta(editorKey)?.tz ?? null : null);
}

/** The whole ping title for one job and one editor key: `head`, then the due words, which always survive the bell's cut. */
export async function editDueTitle(head: string, projectId: string | null | undefined, editorKey?: string | null): Promise<string> {
  const due = projectId ? await editDueFor(projectId).catch(() => null) : null;
  if (!due) return head.slice(0, PING_TITLE_MAX);
  const { editorMeta } = await import("@/lib/editors");
  return titleWithDue(head, due, editorKey ? editorMeta(editorKey)?.tz ?? null : null);
}
