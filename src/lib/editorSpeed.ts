import { etDayKey, etDayKeyPlus } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// EDITOR SPEED, PER EDITOR AND PER KIND OF VIDEO (Jordan, Oct 27 2026: "I
// would like to see the average time of how long it takes Kim to work on
// specific videos of personal branding, how long it takes him to start. Start
// one video and then get the video to us. Same thing with John Mark ... so
// that I can keep track of that and know when to hire other editors, and
// also make sure that they are hitting turnaround times").
//
// Read from timestamps the hub already keeps, nothing new is recorded:
//   · assigned      the job's footage and instructions were ready for the
//                   editor (Project.handoffReadyAt, else the video handoff,
//                   else the photographer's submit);
//   · started       the editor's first Start on that video (EditorWorkEvent
//                   START, the video's own when it has one, else the job's);
//   · first cut     version 1 of that video reaching review;
//   · approval      the first time a version of it was approved;
//   · due           the video's own promised date, else the job's video due.
// The sample is every video whose version 1 an in-house editor sent in the
// window (30 or 90 days). A step whose two ends are out of order (a Start
// pressed after the cut was already in) is left out of that average rather
// than counted as a negative.
//
// On time: approved by the due date. A video not approved yet counts only
// once its due date has passed (late); one with no due date is not counted.
// The fold is pure (foldEditorSpeed) so the drill pins it; the read is
// editorSpeedReport. Owner and creative manager only (the Editing Room).
//
// PER VIDEO, START TO SENT (Jordan, Oct 29 2026: "I want to see the average
// number of videos they get done per day, and how long it takes them from
// start to finish ... It would have to work that way for each individual
// video so we can track how long it takes them"). Added:
//   · videos a day  first versions sent in the window ÷ the weekdays (Mon to
//                   Fri, Eastern: Kim and John Mark work Manila nights, which
//                   is the Eastern day) among its last 7 / 30 / 90 days; and
//                   ÷ the days they actually sent one;
//   · Start to sent the clock time from their first Start on that video to
//                   version 1 sent (the "Start to first cut" column);
//   · on the clock  the Start-to-stop stretches on that video before version
//                   1 was sent, added up. Pause, another job, another video or
//                   the send itself ends a stretch (lib/editorWork). A stretch
//                   longer than LEFT_RUNNING_HOURS was almost surely left
//                   running overnight: the video still counts everywhere else,
//                   but stays out of this average, and the panel says how many;
//   · fixing        from a send-back to the next version sent, clock time;
//   · no Start      a version 1 sent with no Start on that video before it:
//                   counted, never given an invented start.
// Which stretch belongs to which video (attributeStretches): a Start that
// named a video counts for that video's next version sent; a Start that named
// no video (most before Oct 29) counts for the next version they sent on that
// job. Each stretch is cut off at that send. Nothing new is recorded.
// ---------------------------------------------------------------------------

export type SpeedVideo = {
  editorKey: string;
  /** "Personal Branding Reel", "Premium Social Media Reel", … */
  styleName: string;
  assignedAt: Date | null;
  startedAt: Date | null;
  firstCutAt: Date;
  approvedAt: Date | null;
  dueAt: Date | null;
  /** hours on the clock before version 1 was sent; null = no stretch on record */
  workHours?: number | null;
  /** one of those stretches ran longer than LEFT_RUNNING_HOURS */
  leftRunning?: boolean;
  /** each later version: hours from the send-back to it being sent */
  fixHours?: number[];
  /** for the per-video list */
  projectId?: string;
  outputId?: string | null;
  street?: string;
  title?: string;
};

export type SpeedCell = {
  videos: number;
  /** average hours, with how many videos each average is over */
  assignedToStart: { hours: number | null; n: number };
  startToFirstCut: { hours: number | null; n: number };
  toApproval: { hours: number | null; n: number };
  onTime: { hit: number; of: number };
  /** hours on the clock (stretches added up), over the videos with no stretch left running */
  onClock: { hours: number | null; n: number };
  /** videos left out of onClock: a stretch was left running */
  leftRunning: number;
  /** version 1 sent with no Start on that video before it */
  startUnknown: number;
  /** send-back to the next version sent */
  fixTime: { hours: number | null; n: number };
};

/** Videos a day: first versions sent ÷ weekdays in the window, and ÷ days they sent one. */
export type SpeedPace = { sent: number; weekdays: number; perWeekday: number | null; activeDays: number; perActiveDay: number | null };

export type SpeedRow = {
  editorKey: string;
  overall: SpeedCell;
  byType: { styleName: string; cell: SpeedCell }[];
  pace: SpeedPace;
  /** every video in the sample, newest version 1 first */
  list: SpeedVideo[];
};

/** A stretch longer than this was left running (overnight): out of the on-the-clock average. */
export const LEFT_RUNNING_HOURS = 12;
/** The windows the panel offers. */
export const SPEED_WINDOWS = [7, 30, 90] as const;
export type SpeedWindow = (typeof SPEED_WINDOWS)[number];

const H = 3_600_000;
const avg = (xs: number[]): { hours: number | null; n: number } =>
  xs.length ? { hours: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, n: xs.length } : { hours: null, n: 0 };
const span = (from: Date | null, to: Date | null): number | null => {
  if (!from || !to) return null;
  const h = (to.getTime() - from.getTime()) / H;
  return h >= 0 ? h : null;
};

export function speedCell(videos: SpeedVideo[], now: Date): SpeedCell {
  const a2s: number[] = [];
  const s2c: number[] = [];
  const total: number[] = [];
  const clock: number[] = [];
  const fixes: number[] = [];
  let hit = 0;
  let of = 0;
  let leftRunning = 0;
  let startUnknown = 0;
  for (const v of videos) {
    const x = span(v.assignedAt, v.startedAt);
    if (x !== null) a2s.push(x);
    const y = span(v.startedAt, v.firstCutAt);
    if (y !== null) s2c.push(y);
    else startUnknown++;
    if (v.leftRunning) leftRunning++;
    else if (typeof v.workHours === "number") clock.push(v.workHours);
    for (const f of v.fixHours ?? []) if (f >= 0) fixes.push(f);
    // The whole turnaround from when it was the editor's to approve: from
    // the handoff, else from their Start.
    const z = span(v.assignedAt ?? v.startedAt, v.approvedAt);
    if (z !== null) total.push(z);
    if (v.dueAt) {
      if (v.approvedAt) {
        of++;
        if (v.approvedAt.getTime() <= v.dueAt.getTime()) hit++;
      } else if (now.getTime() > v.dueAt.getTime()) of++;
    }
  }
  return {
    videos: videos.length, assignedToStart: avg(a2s), startToFirstCut: avg(s2c), toApproval: avg(total), onTime: { hit, of },
    onClock: avg(clock), leftRunning, startUnknown, fixTime: avg(fixes),
  };
}

/** The Mon to Fri dates among the last `days` Eastern dates ending on `now`'s. Pure. */
export function weekdaysIn(days: number, now: Date): number {
  const today = etDayKey(now);
  let n = 0;
  for (let i = 0; i < days; i++) {
    const dow = new Date(`${etDayKeyPlus(today, -i)}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

/** Videos a day for one editor's sample. Pure. */
export function paceOf(videos: SpeedVideo[], days: number, now: Date): SpeedPace {
  const weekdays = weekdaysIn(days, now);
  const activeDays = new Set(videos.map((v) => etDayKey(v.firstCutAt))).size;
  const per = (d: number) => (d ? Math.round((videos.length / d) * 10) / 10 : null);
  return { sent: videos.length, weekdays, perWeekday: per(weekdays), activeDays, perActiveDay: per(activeDays) };
}

/** One row per editor (in the order given, then any other editor seen), each with its kinds of video, busiest first. */
export function foldEditorSpeed(videos: SpeedVideo[], opts: { now?: Date; editorKeys?: string[]; days?: number } = {}): SpeedRow[] {
  const now = opts.now ?? new Date();
  const keys = [...new Set([...(opts.editorKeys ?? []), ...videos.map((v) => v.editorKey)])];
  return keys.map((editorKey) => {
    const mine = videos.filter((v) => v.editorKey === editorKey);
    const types = new Map<string, SpeedVideo[]>();
    for (const v of mine) types.set(v.styleName, [...(types.get(v.styleName) ?? []), v]);
    return {
      editorKey,
      overall: speedCell(mine, now),
      byType: [...types.entries()]
        .map(([styleName, list]) => ({ styleName, cell: speedCell(list, now) }))
        .sort((a, b) => b.cell.videos - a.cell.videos || a.styleName.localeCompare(b.styleName)),
      pace: paceOf(mine, opts.days ?? 30, now),
      list: [...mine].sort((a, b) => b.firstCutAt.getTime() - a.firstCutAt.getTime()),
    };
  });
}

// ---- Which stretch belongs to which version sent (pure, for the drill) ----

export type WorkEventLite = { itemId: string; editorKey: string; projectId: string; outputId: string | null; kind: string; at: Date };
export type Stretch = { editorKey: string; projectId: string; outputId: string | null; from: Date; to: Date | null };
export type SentVersion = { id: string; editorKey: string; projectId: string; outputId: string | null; at: Date };

const OPENS = new Set(["START", "RESUME"]);
const ENDS = new Set(["PAUSE", "AUTO_PAUSE", "SUBMIT", "CLOSE"]);

/** Start/Resume to the next Pause, switch, send or close on the same work item. `to` null = still running. Pure. */
export function stretchesFromEvents(events: WorkEventLite[]): Stretch[] {
  const out: Stretch[] = [];
  const open = new Map<string, Stretch>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const cur = open.get(e.itemId);
    if (OPENS.has(e.kind)) {
      if (cur) cur.to = e.at; // a Start on top of a running one ends the first there
      const s: Stretch = { editorKey: e.editorKey, projectId: e.projectId, outputId: e.outputId, from: e.at, to: null };
      out.push(s);
      open.set(e.itemId, s);
    } else if (ENDS.has(e.kind) && cur) {
      cur.to = e.at;
      open.delete(e.itemId);
    }
  }
  return out;
}

/**
 * Each stretch to the version it led to: a stretch that named a video counts
 * for that video's next version sent after it began; one that named no video,
 * for the next version the editor sent on that job. Cut off at that send. A
 * stretch with no version after it (still being worked on) belongs to none.
 * Returns version id → its stretches (hours each, and where each began). Pure.
 */
export function attributeStretches(stretches: Stretch[], sent: SentVersion[], now: Date): Map<string, { from: Date; hours: number }[]> {
  const out = new Map<string, { from: Date; hours: number }[]>();
  const sorted = [...sent].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const s of stretches) {
    const next = sorted.find((v) =>
      v.editorKey === s.editorKey && v.projectId === s.projectId && v.at.getTime() >= s.from.getTime() &&
      (!s.outputId || v.outputId === s.outputId));
    if (!next) continue;
    const end = Math.min((s.to ?? now).getTime(), next.at.getTime());
    const hours = Math.max(0, (end - s.from.getTime()) / H);
    out.set(next.id, [...(out.get(next.id) ?? []), { from: s.from, hours }]);
  }
  return out;
}

/** "45 min", "6 h", "1.5 days": a duration in plain words. */
export function durationWords(hours: number | null): string {
  if (hours === null) return "Not enough data";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${Math.round(hours * 10) / 10} h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} day${days === 1 ? "" : "s"}`;
}

export type EditorSpeedReport = {
  days: number;
  readAtISO: string;
  rows: (SpeedRow & { name: string })[];
};

/** The read: every video an in-house editor sent version 1 of in the last `days` days. */
export async function editorSpeedReport(opts: { days: number; now?: Date; excludeClientIds?: string[] }): Promise<EditorSpeedReport> {
  const { prisma } = await import("@/lib/prisma");
  const { NOT_A_CUT } = await import("@/lib/reviewCuts");
  const { VIDEO_DUE_SELECT, videoDueOf } = await import("@/lib/editorDue");
  const { videoStyleFor } = await import("@/lib/videoStyles");
  const { editorMeta } = await import("@/lib/editors");
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.days * 24 * H);
  // Kim and John Mark (Remar's history still counts while it is in the window).
  const IN_HOUSE = ["kim", "john", "remar"];
  const named = (rows: SpeedRow[]) => rows.map((r) => ({ ...r, name: editorMeta(r.editorKey)?.name ?? r.editorKey }));
  const firsts = await prisma.reviewSubmission.findMany({
    where: {
      round: 1,
      status: { notIn: [...NOT_A_CUT] },
      createdAt: { gte: from, lte: now },
      submittedByKey: { in: IN_HOUSE },
      ...(opts.excludeClientIds?.length ? { project: { clientId: { notIn: opts.excludeClientIds } } } : {}),
    },
    select: { id: true, projectId: true, deliverableId: true, slot: true, outputId: true, submittedByKey: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 800,
  });
  const laneOf = (r: { projectId: string; deliverableId: string | null; slot: number | null }) => `${r.projectId}|${r.deliverableId ?? "job"}:${r.slot ?? 1}`;
  const firstByLane = new Map<string, (typeof firsts)[number]>();
  for (const r of firsts) if (!firstByLane.has(laneOf(r))) firstByLane.set(laneOf(r), r);
  const projectIds = [...new Set(firsts.map((r) => r.projectId))];
  if (!projectIds.length) {
    return { days: opts.days, readAtISO: now.toISOString(), rows: named(foldEditorSpeed([], { now, editorKeys: ["kim", "john"], days: opts.days })) };
  }
  const [projects, sent, events, outputs, deliverables] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, title: true, contentMonthId: true, handoffReadyAt: true, videoHandoffAt: true, debriefSubmittedAt: true, ...VIDEO_DUE_SELECT },
    }),
    // Every version of these videos (approvals, send-backs, later versions).
    prisma.reviewSubmission.findMany({
      where: { projectId: { in: projectIds }, status: { notIn: [...NOT_A_CUT] }, createdAt: { lte: now } },
      select: { id: true, projectId: true, deliverableId: true, slot: true, outputId: true, round: true, status: true, submittedByKey: true, createdAt: true, decidedAt: true, completedAt: true, clientRequestedAt: true },
      orderBy: [{ round: "asc" }, { createdAt: "asc" }],
    }),
    prisma.editorWorkEvent.findMany({
      where: { projectId: { in: projectIds }, editorKey: { in: IN_HOUSE }, at: { lte: now } },
      select: { itemId: true, editorKey: true, projectId: true, outputId: true, kind: true, at: true },
      orderBy: { at: "asc" },
    }),
    prisma.deliverableOutput.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, deliverableId: true, slot: true, promisedAt: true, title: true } }),
    prisma.deliverable.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, type: true, label: true, videoStyle: true, productTitle: true } }),
  ]);
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const deliverableOf = new Map(deliverables.map((d) => [d.id, d]));
  const outputOf = new Map(outputs.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
  const outputIdOf = (r: { outputId: string | null; deliverableId: string | null; slot: number | null }) =>
    r.outputId ?? (r.deliverableId ? outputOf.get(`${r.deliverableId}:${r.slot ?? 1}`)?.id ?? null : null);
  const approvedAt = new Map<string, Date>();
  for (const a of sent) {
    if (a.status !== "APPROVED") continue;
    const at = a.decidedAt ?? a.completedAt ?? a.createdAt;
    const k = laneOf(a);
    const was = approvedAt.get(k);
    if (!was || at < was) approvedAt.set(k, at);
  }
  // Which Start-to-stop stretches led to which version (attributeStretches).
  const versions: SentVersion[] = sent
    .filter((v) => v.submittedByKey && IN_HOUSE.includes(v.submittedByKey))
    .map((v) => ({ id: v.id, editorKey: v.submittedByKey!, projectId: v.projectId, outputId: outputIdOf(v), at: v.createdAt }));
  const byVersion = attributeStretches(stretchesFromEvents(events), versions, now);
  const roundsOf = new Map<string, typeof sent>();
  for (const v of sent) roundsOf.set(laneOf(v), [...(roundsOf.get(laneOf(v)) ?? []), v]);

  const videos: SpeedVideo[] = [];
  for (const [lane, r] of firstByLane) {
    const p = projectOf.get(r.projectId);
    if (!p || !r.submittedByKey) continue;
    const out = r.deliverableId ? outputOf.get(`${r.deliverableId}:${r.slot ?? 1}`) ?? null : null;
    const parts = byVersion.get(r.id) ?? [];
    // The first Start that led to this version; none on record = no Start
    // (counted as such, never guessed from another video's Start).
    const startedAt = parts.length ? new Date(Math.min(...parts.map((x) => x.from.getTime()))) : null;
    const workHours = parts.length ? Math.round(parts.reduce((a, x) => a + x.hours, 0) * 10) / 10 : null;
    // FIXING: each later version they sent, from the send-back before it.
    const rounds = roundsOf.get(lane) ?? [];
    const fixHours: number[] = [];
    for (let i = 1; i < rounds.length; i++) {
      const v = rounds[i];
      const prev = rounds[i - 1];
      if (v.submittedByKey !== r.submittedByKey || v.round <= prev.round) continue;
      const back = prev.clientRequestedAt ?? (prev.status === "CHANGES_REQUESTED" ? prev.decidedAt : null);
      const h = span(back, v.createdAt);
      if (h !== null) fixHours.push(Math.round(h * 10) / 10);
    }
    const d = r.deliverableId ? deliverableOf.get(r.deliverableId) : null;
    const styleName = d ? videoStyleFor(d, { monthly: !!p.contentMonthId }).name : "Video";
    const due = out?.promisedAt ?? videoDueOf(p, { now }).at ?? null;
    videos.push({
      editorKey: r.submittedByKey,
      styleName,
      assignedAt: p.handoffReadyAt ?? p.videoHandoffAt ?? p.debriefSubmittedAt ?? null,
      startedAt,
      firstCutAt: r.createdAt,
      approvedAt: approvedAt.get(lane) ?? null,
      dueAt: due,
      workHours,
      leftRunning: parts.some((x) => x.hours > LEFT_RUNNING_HOURS),
      fixHours,
      projectId: r.projectId,
      outputId: r.outputId ?? out?.id ?? null,
      street: p.title?.split(",")[0]?.trim() || p.title || "Project",
      title: out?.title?.trim() || (out ? `Video ${out.slot}` : styleName),
    });
  }
  return {
    days: opts.days,
    readAtISO: now.toISOString(),
    rows: named(foldEditorSpeed(videos, { now, editorKeys: ["kim", "john"], days: opts.days })),
  };
}
