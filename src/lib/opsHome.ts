import "server-only";
import { prisma } from "@/lib/prisma";
import { type JobCounts } from "@/lib/opsCounts";
import { videoDeliveryCounts, type VideoDeliveryCounts } from "@/lib/videoDelivery";
import { askBoardCounts } from "@/lib/clientAsks";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import type { QueueData } from "@/components/photoDelivery/types";
import { unansweredCommsBoard, type CommsGroup } from "@/lib/commsBoard";
import { openLoopsList, shootEndFor, type LoopViewer, type OpsLoop } from "@/lib/opsDay";
import { clientTextWhere } from "@/lib/clientTexts";
import { OWED_DELIVERABLE_WHERE, hasSameDayAddOn, sameDayAddOns } from "@/lib/tasks";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { pinnedPromise } from "@/lib/turnaround";
import { etAddDays, etDayKey, etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// KYLE'S HOME, IN FIVE JOBS (Jordan, Oct 19 2026): "His main jobs are photo
// delivery, video delivery, communications with clients, special requests,
// and scheduling/rescheduling requests. … A section for: these are how many
// videos need to go out today or are due today, and how many we're behind on."
//
// One tile per job. THE NUMBER RULE (Home's, since Sep 2): every count on a
// tile is computed by the SAME function that builds the screen the tile opens:
//   photos     → loadQueue()            (/ops/photo-delivery's own loader)
//   videos     → videoDeliveryCounts()  (/ops/video-delivery's contract)
//   messages   → messagesBoard()        (/ops/messages renders this object)
//   requests   → askBoardCounts().special    (/ops/requests' contract)
//   scheduling → askBoardCounts().scheduling (/ops/scheduling's contract)
//
// JobCounts semantics here: `behind` is past its time; `dueToday` is due later
// today and not behind yet (so "3 due today · 2 behind" never counts one item
// twice); `open` is everything the screen lists as work.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

// ---- THRESHOLDS, in one place -------------------------------------------------
/** Red banner: this many listing videos past their promise… */
export const VIDEO_VERY_BEHIND_COUNT = 3;
/** …or any one listing video this many hours past its promise. */
export const VIDEO_VERY_BEHIND_HOURS = 48;
/** A client waiting this long for an answer counts as behind. */
export const MESSAGE_BEHIND_HOURS = 24;

export type JobKey = "photos" | "videos" | "messages" | "requests" | "scheduling";

export type JobTile = {
  key: JobKey;
  label: string;
  href: string;
  /** null = the source could not be read; the tile says so instead of a 0 */
  counts: JobCounts | null;
  /** one plain sentence: what to do about it */
  status: string;
  tone: "danger" | "warning" | "ok" | "muted";
  /** a second, smaller line (e.g. photo sets still on the older QC cards) */
  note?: { text: string; href: string } | null;
};

export type VideoAlert = {
  level: "red" | "amber";
  late: number;
  oldestHours: number | null;
  headline: string;
  detail: string;
  href: string;
};

/** "2.7 days" / "9 hours" — how late, in the unit a person would say. */
export function lateWords(hours: number | null): string {
  if (hours == null) return "an unknown time";
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round((hours / 24) * 10) / 10;
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The video banner (Jordan: "If we're really behind on videos, Kyle should be
 * flagged on the home screen: we're very behind on these, let's prioritize
 * delivering this, maybe reach out to a vendor to take the load off").
 * Red when VIDEO_VERY_BEHIND_COUNT+ listing videos are past their promise or
 * any one is VIDEO_VERY_BEHIND_HOURS+ past it; amber for one or two late.
 */
export function videoAlert(v: VideoDeliveryCounts | null): VideoAlert | null {
  if (!v || v.lateListing <= 0) return null;
  const red = v.lateListing >= VIDEO_VERY_BEHIND_COUNT || (v.oldestLateHours ?? 0) >= VIDEO_VERY_BEHIND_HOURS;
  const n = v.lateListing;
  const oldest = lateWords(v.oldestLateHours);
  return red
    ? {
        level: "red",
        late: n,
        oldestHours: v.oldestLateHours,
        headline: `We're behind on videos: ${n} late, the oldest ${oldest}.`,
        detail: "Deliver these first. If this keeps up, bring in a vendor editor to take the load off.",
        href: "/ops/video-delivery",
      }
    : {
        level: "amber",
        late: n,
        oldestHours: v.oldestLateHours,
        headline: `${n} listing video${n === 1 ? " is" : "s are"} past the promised date, the oldest ${oldest}.`,
        detail: "Deliver these first.",
        href: "/ops/video-delivery",
      };
}

// ---- PHOTOS: the photo delivery queue's own cards --------------------------------

export type PhotoCounts = JobCounts & { readyForReview: number; needsDecision: number };

/** Counted off loadQueue()'s cards, exactly as /ops/photo-delivery renders them. */
export function photoCountsFromQueue(q: QueueData, now: Date = new Date()): PhotoCounts {
  const today = etDayKey(now);
  const open = q.columns.filter((c) => c.key !== "delivered").flatMap((c) => c.cards);
  let behind = 0, dueToday = 0, oldest: number | null = null;
  for (const c of open) {
    const due = c.slaDueAt ? Date.parse(c.slaDueAt) : null;
    if (due != null && due < now.getTime()) behind++;
    else if (due != null && etDayKey(new Date(due)) === today) dueToday++;
    const since = c.shootDate ? Date.parse(c.shootDate) : null;
    if (since != null && since < now.getTime()) {
      const h = (now.getTime() - since) / HOUR;
      oldest = oldest == null ? h : Math.max(oldest, h);
    }
  }
  return {
    open: open.length,
    dueToday,
    behind,
    oldestHours: oldest == null ? null : Math.round(oldest),
    readyForReview: q.columns.find((c) => c.key === "ready")?.cards.length ?? 0,
    needsDecision: q.columns.find((c) => c.key === "decision")?.cards.length ?? 0,
  };
}

// ---- MESSAGES: texts + email + follow-ups + leads, one board ---------------------

export type WaitingClient = { family: "phone" | "email"; group: CommsGroup; behind: boolean };
export type MessageLead = { id: string; title: string; createdAt: Date; dueAt: Date | null; assignedKey: string | null; behind: boolean; dueToday: boolean };

export type MessagesBoard = {
  /** clients still owed an answer, text and email together, longest wait first */
  waiting: WaitingClient[];
  /** follow-ups owed now (overdue or due today), not already a waiting client */
  loops: OpsLoop[];
  /** the viewer's follow-ups that are not due yet (listed, not counted) */
  laterLoops: number;
  /** open leads waiting on a call or text back, oldest first */
  leads: MessageLead[];
  /** client texts drafted and ready in the Outbox (a send, not a reply owed) */
  outbox: number;
  counts: JobCounts;
};

/** Leads for a viewer: the owner (or the team view) sees every one; anyone
 *  else the leads filed to them plus the ones nobody holds. leadDesk.openLeadsFor's
 *  rule, read with the due date the board needs. */
async function leadsFor(opts: { team: boolean; key: string | null; teamMemberId: string | null }) {
  const mine = [
    { assignedKey: null },
    ...(opts.key ? [{ assignedKey: opts.key }] : []),
    ...(opts.teamMemberId ? [{ ownerId: opts.teamMemberId }] : []),
  ];
  return prisma.smartTask.findMany({
    where: { taskType: "lead", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...(opts.team ? {} : { OR: mine }) },
    select: { id: true, title: true, createdAt: true, dueAt: true, assignedKey: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
}

/**
 * The client-messages job, as ONE object: /ops/messages renders it and the
 * Messages tile counts it. `viewer` is the person whose follow-ups and leads
 * these are (undefined = the signed-in person); `team: true` is the owner's
 * whole-business view (every loop, every lead).
 *
 * Nothing is counted twice: a follow-up or lead that IS a waiting client's
 * open reply task (the comms ledger carries client_reply and lead rows) is
 * counted on the waiting client only.
 */
export async function messagesBoard(opts: {
  now?: Date;
  excludeClientIds?: string[];
  viewer?: LoopViewer | null;
  team?: boolean;
} = {}): Promise<MessagesBoard> {
  const now = opts.now ?? new Date();
  const scope = { excludeClientIds: opts.excludeClientIds };
  const team = !!opts.team;
  const [phone, email, loopsAll, outbox] = await Promise.all([
    unansweredCommsBoard("phone", now, scope),
    unansweredCommsBoard("email", now, scope),
    openLoopsList(now, team ? null : opts.viewer, scope),
    prisma.smartTask.count({ where: clientTextWhere(now, scope) }),
  ]);
  // The lead rule needs the viewer's key; openLoopsList resolved it from the
  // session when viewer is undefined, so resolve the same way here.
  let viewer: LoopViewer | null | undefined = opts.viewer;
  if (!team && viewer === undefined) {
    const [{ getCurrentUser }, { listAssignees, viewerAssigneeKey }] = await Promise.all([import("@/lib/auth/user"), import("@/lib/assignees")]);
    const [me, roster] = await Promise.all([getCurrentUser().catch(() => null), listAssignees().catch(() => [])]);
    viewer = me ? { key: viewerAssigneeKey(me, roster), role: me.role, teamMemberId: me.teamMemberId } : null;
  }
  const leadRows = await leadsFor({ team: team || !viewer || viewer.role === "OWNER", key: viewer?.key ?? null, teamMemberId: viewer?.teamMemberId ?? null });

  const waiting: WaitingClient[] = [
    ...phone.map((g) => ({ family: "phone" as const, group: g, behind: g.oldestHours >= MESSAGE_BEHIND_HOURS })),
    ...email.map((g) => ({ family: "email" as const, group: g, behind: g.oldestHours >= MESSAGE_BEHIND_HOURS })),
  ].sort((a, b) => b.group.oldestHours - a.group.oldestHours);
  const onBoard = new Set(waiting.map((w) => w.group.openTaskId).filter((x): x is string => !!x));
  const ownLoops = team ? loopsAll : loopsAll.filter((l) => l.mine);
  const loops = ownLoops.filter((l) => l.actNow && !onBoard.has(l.taskId));
  const laterLoops = ownLoops.filter((l) => !l.actNow && !onBoard.has(l.taskId)).length;
  const today = etDayKey(now);
  const leads: MessageLead[] = leadRows
    .filter((l) => !onBoard.has(l.id))
    .map((l) => ({
      ...l,
      behind: !!l.dueAt && l.dueAt < now,
      dueToday: !!l.dueAt && l.dueAt >= now && etDayKey(l.dueAt) === today,
    }));

  let behind = 0, dueToday = 0, oldest: number | null = null;
  const age = (h: number) => { oldest = oldest == null ? h : Math.max(oldest, h); };
  for (const w of waiting) {
    if (w.behind) behind++;
    else dueToday++;
    age(w.group.oldestHours);
  }
  for (const l of loops) {
    if (l.overdue) behind++;
    else dueToday++;
    if (l.overdue && l.dueISO) age((now.getTime() - Date.parse(l.dueISO)) / HOUR);
  }
  for (const l of leads) {
    if (l.behind) behind++;
    else if (l.dueToday) dueToday++;
    age((now.getTime() - l.createdAt.getTime()) / HOUR);
  }
  const open = waiting.length + loops.length + leads.length;
  return {
    waiting,
    loops,
    laterLoops,
    leads,
    outbox,
    counts: { open, dueToday, behind, oldestHours: open === 0 || oldest == null ? null : Math.round(oldest) },
  };
}

// ---- THE TILES --------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function toneOf(c: JobCounts | null): JobTile["tone"] {
  if (!c) return "muted";
  return c.behind > 0 ? "danger" : c.dueToday > 0 ? "warning" : "ok";
}

const COULD_NOT_LOAD = "Couldn't load. Open the screen to check.";

export function photoStatus(c: PhotoCounts | null): string {
  if (!c) return COULD_NOT_LOAD;
  const ready = c.readyForReview > 0 ? ` ${plural(c.readyForReview, "set")} ready for you to approve.` : "";
  if (c.behind > 0) return `${plural(c.behind, "job")} past due. Deliver these first.${ready}`;
  if (c.dueToday > 0) return `${plural(c.dueToday, "job")} due today.${ready}`;
  if (c.open > 0) return `${plural(c.open, "job")} in progress, none due today.${ready}`;
  return "All photos are out.";
}

export function videoStatus(v: VideoDeliveryCounts | null): string {
  if (!v) return COULD_NOT_LOAD;
  const monthly = v.lateMonthly > 0 ? ` ${plural(v.lateMonthly, "monthly video")} past their date.` : "";
  if (v.lateListing > 0) return `${plural(v.lateListing, "listing video")} late. Deliver these first.${monthly}`;
  if (v.behind > 0) return `${plural(v.behind, "video")} behind.${monthly}`;
  if (v.dueToday > 0) return `${plural(v.dueToday, "video")} due today.${monthly}`;
  if (v.open > 0) return `${plural(v.open, "video")} in progress, none due today.${monthly}`;
  return monthly ? monthly.trim() : "No videos waiting to go out.";
}

export function messageStatus(c: JobCounts | null): string {
  if (!c) return COULD_NOT_LOAD;
  if (c.behind > 0) return `${plural(c.behind, "follow-up")} overdue or waiting over a day. Answer these first.`;
  if (c.dueToday > 0) return `${plural(c.dueToday, "message")} to answer today.`;
  return "Nobody is waiting on us.";
}

export function requestStatus(c: JobCounts | null): string {
  if (!c) return COULD_NOT_LOAD;
  if (c.behind > 0) return `${plural(c.behind, "request")} overdue. Make sure these are correct.`;
  if (c.open > 0) return `${plural(c.open, "request")} open. Make sure these are correct.`;
  return "No special requests open.";
}

export function schedulingStatus(c: JobCounts | null): string {
  if (!c) return COULD_NOT_LOAD;
  if (c.behind > 0) return `${plural(c.behind, "request")} overdue. Follow up.`;
  if (c.open > 0) return `${plural(c.open, "request")} to follow up.`;
  return "No scheduling requests open.";
}

export const TILE_HREF: Record<JobKey, string> = {
  photos: "/ops/photo-delivery",
  videos: "/ops/video-delivery",
  messages: "/ops/messages",
  requests: "/ops/requests",
  scheduling: "/ops/scheduling",
};

/** The five tiles with nothing read: every one says it could not load. */
export function unavailableTiles(): OpsTiles {
  const t = (key: JobKey, label: string): JobTile => ({ key, label, href: TILE_HREF[key], counts: null, status: COULD_NOT_LOAD, tone: "muted" });
  return {
    tiles: [t("photos", "Photos"), t("videos", "Videos"), t("messages", "Client messages"), t("requests", "Special requests"), t("scheduling", "Scheduling")],
    video: null, alert: null, photos: null, messages: null,
  };
}

export type OpsTiles = {
  tiles: JobTile[];
  video: VideoDeliveryCounts | null;
  alert: VideoAlert | null;
  photos: PhotoCounts | null;
  messages: MessagesBoard | null;
};

/**
 * The five tiles. Kyle's Home passes his own viewer (his follow-ups and
 * leads); the owner's "What we're behind on" passes team: true. Each source
 * fails on its own: one unreadable screen greys one tile, never the row.
 */
export async function opsHomeTiles(opts: {
  now?: Date;
  excludeClientIds?: string[];
  viewer?: LoopViewer | null;
  team?: boolean;
  /** the photo sets still on the older QC cards (Review Room's own count) */
  photoQcCards?: number | null;
} = {}): Promise<OpsTiles> {
  const now = opts.now ?? new Date();
  const warn = (what: string) => (e: unknown) => {
    console.warn(`opsHome: ${what} failed`, (e as Error)?.message);
    return null;
  };
  const [queue, video, messages, asks] = await Promise.all([
    loadQueue({ now }).catch(warn("photo queue")),
    videoDeliveryCounts(now).catch(warn("video delivery")),
    messagesBoard({ now, excludeClientIds: opts.excludeClientIds, viewer: opts.viewer, team: opts.team }).catch(warn("messages")),
    askBoardCounts(now).catch(warn("client asks")),
  ]);
  const photos = queue ? photoCountsFromQueue(queue, now) : null;
  const qcCards = opts.photoQcCards ?? 0;
  const tiles: JobTile[] = [
    {
      key: "photos", label: "Photos", href: TILE_HREF.photos, counts: photos, status: photoStatus(photos), tone: toneOf(photos),
      note: qcCards > 0 ? { text: `${plural(qcCards, "photo set")} still on the older QC cards`, href: "/review" } : null,
    },
    { key: "videos", label: "Videos", href: TILE_HREF.videos, counts: video, status: videoStatus(video), tone: video && video.lateListing > 0 ? "danger" : toneOf(video) },
    { key: "messages", label: "Client messages", href: TILE_HREF.messages, counts: messages?.counts ?? null, status: messageStatus(messages?.counts ?? null), tone: toneOf(messages?.counts ?? null) },
    { key: "requests", label: "Special requests", href: TILE_HREF.requests, counts: asks?.special ?? null, status: requestStatus(asks?.special ?? null), tone: toneOf(asks?.special ?? null) },
    { key: "scheduling", label: "Scheduling", href: TILE_HREF.scheduling, counts: asks?.scheduling ?? null, status: schedulingStatus(asks?.scheduling ?? null), tone: toneOf(asks?.scheduling ?? null) },
  ];
  return { tiles, video, alert: videoAlert(video), photos, messages };
}

// ---- TODAY'S SHOOTS, as one line ---------------------------------------------------

export type ShootsLine = {
  count: number;
  next: { timeISO: string | null; street: string; photographer: string | null } | null;
  untimed: string[];
  /** shoots promised same-day photos or floor plan (the SLA engine's flag) */
  rush: number;
};

/**
 * Today's shoots for the one line on Kyle's Home. The same population as the
 * checklist's "Today's shoots" section (opsDay.buildOpsDay todayProjects:
 * shoot date inside today's ET day, not cancelled or on hold, test clients
 * out), without the weather, airspace and comms reads the cards need.
 */
export async function todayShootsLine(now: Date = new Date(), opts: { excludeClientIds?: string[] } = {}): Promise<ShootsLine> {
  const start = etDayStartUtc(now);
  const end = etDayStartUtc(etAddDays(new Date(start.getTime() + 12 * HOUR), 1));
  const rows = await prisma.project.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      ...(opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {}),
    },
    select: {
      title: true, shootDate: true,
      photographer: { select: { name: true } },
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, productTitle: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      appointments: { select: { startAt: true, endAt: true, status: true } },
    },
    orderBy: { shootDate: "asc" },
  });
  const upcoming = rows.find((r) => {
    const end = shootEndFor(r.shootDate, r.appointments);
    return !!r.shootDate && (end?.end ?? r.shootDate).getTime() >= now.getTime();
  });
  return {
    count: rows.length,
    next: upcoming ? { timeISO: upcoming.shootDate?.toISOString() ?? null, street: upcoming.title.split(",")[0], photographer: upcoming.photographer?.name ?? null } : null,
    untimed: rows.filter((r) => !r.shootDate).map((r) => r.title.split(",")[0]),
    rush: rows.filter((r) => hasSameDayAddOn(sameDayAddOns(r.deliverables, r.orderItems))).length,
  };
}

// ---- THE OWNER'S WEEK (Jordan: "I want a way to see on my side how we're doing
// this week, what we're behind on") --------------------------------------------------

export type WeekStats = {
  /** shoots on the calendar from Monday to now (cancelled ones out) */
  shoots: number;
  photos: { delivered: number; judged: number; onTime: number; onTimePct: number | null };
  listingVideos: { delivered: number; judged: number; onTime: number; onTimePct: number | null };
  monthlyVideos: number;
  replies: { inbound: number; fast: number; fastPct: number | null };
  revisions: number;
};

export type OwnerWeek = {
  startISO: string;
  nowISO: string;
  thisWeek: WeekStats;
  /** last week from its Monday to the same point in the week */
  lastWeek: WeekStats;
};

/** Monday 00:00 ET of the week holding `now`. */
export function etWeekStart(now: Date): Date {
  const dow = new Date(`${etDayKey(now)}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  const noon = new Date(etDayStartUtc(now).getTime() + 12 * HOUR);
  return etDayStartUtc(new Date(noon.getTime() - back * 24 * HOUR));
}

const pct = (ok: number, total: number) => (total ? Math.round((ok / total) * 100) : null);

async function weekStats(start: Date, end: Date, excludeClientIds: string[]): Promise<WeekStats> {
  const clientScope = excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {};
  const excludedProjectIds = excludeClientIds.length
    ? (await prisma.project.findMany({ where: { clientId: { in: excludeClientIds } }, select: { id: true } })).map((p) => p.id)
    : [];
  const projectScope = excludedProjectIds.length ? { projectId: { notIn: excludedProjectIds } } : {};
  const [shoots, photoJobs, outputs, texts, revisions] = await Promise.all([
    prisma.project.count({ where: { shootDate: { gte: start, lt: end }, status: { not: "CANCELLED" }, ...clientScope } }),
    prisma.photoJob.findMany({ where: { deliveredAt: { gte: start, lt: end }, ...projectScope }, select: { deliveredAt: true, slaDueAt: true } }),
    prisma.deliverableOutput.findMany({ where: { deliveredAt: { gte: start, lt: end }, category: "VIDEO", ...projectScope }, select: { projectId: true, deliveredAt: true } }),
    // Texts only, paired per client: the 30-day reply dial's own rule
    // (queries.getOwnerPulse), on this window. An hour past the end is read so
    // an answer to the window's last message can still pair.
    prisma.commLog.findMany({
      where: {
        channel: "text", occurredAt: { gte: start, lt: new Date(end.getTime() + HOUR) },
        clientId: { not: null, ...(excludeClientIds.length ? { notIn: excludeClientIds } : {}) },
        ...(excludedProjectIds.length ? { OR: [{ projectId: null }, { projectId: { notIn: excludedProjectIds } }] } : {}),
      },
      select: { direction: true, clientId: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    // A revision ASKED FOR: one RevisionBrief per client ask. The office's
    // own notes and system rows are not asks.
    prisma.revisionBrief.count({
      where: {
        createdAt: { gte: start, lt: end },
        OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }],
        ...(excludeClientIds.length ? { project: { clientId: { notIn: excludeClientIds } } } : {}),
      },
    }),
  ]);
  const photosJudged = photoJobs.filter((p) => p.slaDueAt);
  const photosOnTime = photosJudged.filter((p) => p.deliveredAt! <= p.slaDueAt!).length;

  const projects = outputs.length
    ? await prisma.project.findMany({
        where: { id: { in: [...new Set(outputs.map((o) => o.projectId))] } },
        select: { id: true, contentMonthId: true, packageName: true, deliveryDue: true, promisedDueAt: true, shootDate: true, deliverables: { select: { type: true, label: true } } },
      })
    : [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const monthly = (p: (typeof projects)[number] | undefined) => !!p && (!!p.contentMonthId || isMonthlyContentJob(p.deliverables, p.packageName));
  const listing = outputs.filter((o) => !monthly(byId.get(o.projectId)));
  // The promise the job was sold under, else the live due: the 30-day
  // on-time dial's rule (getOwnerPulse promiseOf).
  const promiseOf = (id: string) => {
    const p = byId.get(id);
    return p ? pinnedPromise(p) ?? p.deliveryDue : null;
  };
  const listingJudged = listing.filter((o) => promiseOf(o.projectId));
  const listingOnTime = listingJudged.filter((o) => o.deliveredAt! <= promiseOf(o.projectId)!).length;

  const byClient = new Map<string, { dir: string; at: number }[]>();
  for (const t of texts) {
    const arr = byClient.get(t.clientId!) ?? [];
    arr.push({ dir: t.direction, at: t.occurredAt.getTime() });
    byClient.set(t.clientId!, arr);
  }
  let inbound = 0, fast = 0;
  for (const events of byClient.values()) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].dir !== "in" || events[i].at >= end.getTime()) continue;
      inbound++;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].dir !== "out") continue;
        if (events[j].at - events[i].at <= HOUR) fast++;
        break;
      }
    }
  }
  return {
    shoots,
    photos: { delivered: photoJobs.length, judged: photosJudged.length, onTime: photosOnTime, onTimePct: pct(photosOnTime, photosJudged.length) },
    listingVideos: { delivered: listing.length, judged: listingJudged.length, onTime: listingOnTime, onTimePct: pct(listingOnTime, listingJudged.length) },
    monthlyVideos: outputs.length - listing.length,
    replies: { inbound, fast, fastPct: pct(fast, inbound) },
    revisions,
  };
}

/** This week (Monday to now, ET) beside last week to the same point. */
export async function ownerWeek(now: Date = new Date(), opts: { excludeClientIds?: string[] } = {}): Promise<OwnerWeek> {
  const start = etWeekStart(now);
  const lastStart = etWeekStart(new Date(start.getTime() - 3 * 24 * HOUR));
  const lastEnd = new Date(lastStart.getTime() + (now.getTime() - start.getTime()));
  const ex = opts.excludeClientIds ?? [];
  const [thisWeek, lastWeek] = await Promise.all([weekStats(start, now, ex), weekStats(lastStart, lastEnd, ex)]);
  return { startISO: start.toISOString(), nowISO: now.toISOString(), thisWeek, lastWeek };
}
