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
};

export type SpeedCell = {
  videos: number;
  /** average hours, with how many videos each average is over */
  assignedToStart: { hours: number | null; n: number };
  startToFirstCut: { hours: number | null; n: number };
  toApproval: { hours: number | null; n: number };
  onTime: { hit: number; of: number };
};

export type SpeedRow = {
  editorKey: string;
  overall: SpeedCell;
  byType: { styleName: string; cell: SpeedCell }[];
};

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
  let hit = 0;
  let of = 0;
  for (const v of videos) {
    const x = span(v.assignedAt, v.startedAt);
    if (x !== null) a2s.push(x);
    const y = span(v.startedAt, v.firstCutAt);
    if (y !== null) s2c.push(y);
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
  return { videos: videos.length, assignedToStart: avg(a2s), startToFirstCut: avg(s2c), toApproval: avg(total), onTime: { hit, of } };
}

/** One row per editor (in the order given, then any other editor seen), each with its kinds of video, busiest first. */
export function foldEditorSpeed(videos: SpeedVideo[], opts: { now?: Date; editorKeys?: string[] } = {}): SpeedRow[] {
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
    };
  });
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
  const firsts = await prisma.reviewSubmission.findMany({
    where: {
      round: 1,
      status: { notIn: [...NOT_A_CUT] },
      createdAt: { gte: from, lte: now },
      submittedByKey: { in: IN_HOUSE },
      ...(opts.excludeClientIds?.length ? { project: { clientId: { notIn: opts.excludeClientIds } } } : {}),
    },
    select: { projectId: true, deliverableId: true, slot: true, outputId: true, submittedByKey: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 800,
  });
  const laneOf = (r: { projectId: string; deliverableId: string | null; slot: number | null }) => `${r.projectId}|${r.deliverableId ?? "job"}:${r.slot ?? 1}`;
  const firstByLane = new Map<string, (typeof firsts)[number]>();
  for (const r of firsts) if (!firstByLane.has(laneOf(r))) firstByLane.set(laneOf(r), r);
  const projectIds = [...new Set(firsts.map((r) => r.projectId))];
  if (!projectIds.length) {
    return { days: opts.days, readAtISO: now.toISOString(), rows: foldEditorSpeed([], { now, editorKeys: ["kim", "john"] }).map((r) => ({ ...r, name: editorMeta(r.editorKey)?.name ?? r.editorKey })) };
  }
  const [projects, approvals, starts, outputs, deliverables] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, contentMonthId: true, handoffReadyAt: true, videoHandoffAt: true, debriefSubmittedAt: true, ...VIDEO_DUE_SELECT },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId: { in: projectIds }, status: "APPROVED" },
      select: { projectId: true, deliverableId: true, slot: true, decidedAt: true, completedAt: true, createdAt: true },
    }),
    prisma.editorWorkEvent.findMany({
      where: { projectId: { in: projectIds }, kind: "START" },
      select: { projectId: true, outputId: true, editorKey: true, at: true },
      orderBy: { at: "asc" },
    }),
    prisma.deliverableOutput.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, deliverableId: true, slot: true, promisedAt: true } }),
    prisma.deliverable.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, type: true, label: true, videoStyle: true, productTitle: true } }),
  ]);
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const deliverableOf = new Map(deliverables.map((d) => [d.id, d]));
  const outputOf = new Map(outputs.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
  const approvedAt = new Map<string, Date>();
  for (const a of approvals) {
    const at = a.decidedAt ?? a.completedAt ?? a.createdAt;
    const k = laneOf(a);
    const was = approvedAt.get(k);
    if (!was || at < was) approvedAt.set(k, at);
  }
  const videos: SpeedVideo[] = [];
  for (const [lane, r] of firstByLane) {
    const p = projectOf.get(r.projectId);
    if (!p || !r.submittedByKey) continue;
    const out = r.deliverableId ? outputOf.get(`${r.deliverableId}:${r.slot ?? 1}`) ?? null : null;
    const outId = r.outputId ?? out?.id ?? null;
    const mineStarts = starts.filter((s) => s.projectId === r.projectId && s.editorKey === r.submittedByKey);
    const startedAt = (outId ? mineStarts.find((s) => s.outputId === outId) : null)?.at ?? mineStarts.find((s) => !s.outputId)?.at ?? mineStarts[0]?.at ?? null;
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
    });
  }
  return {
    days: opts.days,
    readAtISO: now.toISOString(),
    rows: foldEditorSpeed(videos, { now, editorKeys: ["kim", "john"] }).map((r) => ({ ...r, name: editorMeta(r.editorKey)?.name ?? r.editorKey })),
  };
}
