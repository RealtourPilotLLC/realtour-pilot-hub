import "server-only";

import { prisma } from "@/lib/prisma";
import { EDITORS, editorKeyForTeamName, editorMeta } from "@/lib/editors";

// ---------------------------------------------------------------------------
// WHAT IS ON WHOSE DESK, AND WHETHER IT FITS (R08, review Sep 18).
//
// The Editing Room counts rows. A count is not workload: eight jobs one of
// which is waiting for footage, three of which are sitting in review and one of
// which is approved and waiting to be sent is FOUR jobs of editing, and the
// three in review are not the editor's to move at all. The header line said
// "8 open" and the person reading it could not tell any of that apart.
//
// FOUR LANES, AND WHO EACH ONE IS ON. This is the whole idea: a lane is not a
// status, it is an answer to "who is holding this up".
//
//   waiting_footage  the photographer or the office   — nobody can edit yet
//   editing          the EDITOR                       — the only real workload
//   in_review        the office (a verdict is owed)    — off the editor's desk
//   awaiting_send    the office (a send is owed)       — finished work, not out
//
// NO INVENTED HOURS. It would be easy to multiply videos by a made-up
// hours-each and print a number that looks like capacity; it would also be a
// guess dressed as a measurement. Everything below is measured off this
// database and says how big its sample was:
//
//   · throughput — approved cuts per editor per week over the sample window.
//     Thin (John Mark 9 in eight weeks, Kim 3) and that is the honest picture
//     of a hub that has never run at scale, so the number is reported WITH its
//     sample and is null rather than misleading when there is too little.
//   · turnaround — the median hours from shoot to first cut, 22 samples on
//     production today. It is ELAPSED time, not hands-on effort, and the
//     wording everywhere says so.
//
// A reader gets "John has 7 videos he can work on, he finishes about 1 a week,
// two are already late" — three facts, each of which came from somewhere.
// ---------------------------------------------------------------------------

export type WorkLane = "waiting_footage" | "editing" | "in_review" | "awaiting_send";

export const LANE_LABEL: Record<WorkLane, string> = {
  waiting_footage: "Waiting on footage",
  editing: "In editing",
  in_review: "Waiting on a verdict",
  awaiting_send: "Approved, not sent",
};

/** Whose move it is. The editor's lane is the only one that is workload. */
export const LANE_OWNER: Record<WorkLane, "editor" | "office" | "field"> = {
  waiting_footage: "field",
  editing: "editor",
  in_review: "office",
  awaiting_send: "office",
};

export const LANES: WorkLane[] = ["editing", "in_review", "awaiting_send", "waiting_footage"];

/** The Editing Room's own status words, mapped to the four lanes. Anything
 *  unrecognised counts as editing — the safe side, because it keeps the work
 *  visible on somebody's desk rather than silently dropping it. */
export function laneOf(status: string): WorkLane {
  switch (status) {
    case "Waiting": return "waiting_footage";
    case "Ready for review": return "in_review";
    case "Approved": return "awaiting_send";
    case "Completed": return "awaiting_send";
    default: return "editing"; // Ready for editing · In editing · Revisions
  }
}

export type LaneTally = { jobs: number; videos: number };
const emptyLanes = (): Record<WorkLane, LaneTally> => ({
  waiting_footage: { jobs: 0, videos: 0 },
  editing: { jobs: 0, videos: 0 },
  in_review: { jobs: 0, videos: 0 },
  awaiting_send: { jobs: 0, videos: 0 },
});

export type EditorLoad = {
  key: string | null;
  name: string;
  kind: "in_house" | "external" | "unassigned";
  lanes: Record<WorkLane, LaneTally>;
  /** videos in the one lane the editor can actually move */
  activeVideos: number;
  activeJobs: number;
  /** measured approved cuts per week; null = too few to say */
  perWeek: number | null;
  /** how many cuts that rate was measured from */
  sampleCuts: number;
  /** activeVideos ÷ perWeek, in weeks; null when the rate is unknown */
  weeksOfWork: number | null;
  overdue: number;
  /** due inside two days and not yet late */
  dueSoon: number;
  nextDueISO: string | null;
  /** the longest any of this editor's editing-lane jobs has been past its date */
  worstOverdueDays: number | null;
};

export type WorkloadView = {
  editors: EditorLoad[];
  totals: Record<WorkLane, LaneTally>;
  overdue: number;
  unassignedActive: number;
  /** measured median ELAPSED hours from shoot to first cut */
  medianFirstCutHours: number | null;
  firstCutSamples: number;
  sampleWeeks: number;
  measuredAt: string;
};

export type WorkloadRow = {
  status: string;
  editorKey: string | null;
  editor: string | null;
  videos: number;
  dueISO: string | null;
  late: boolean;
};

const DAY = 86_400_000;
const SOON_MS = 2 * DAY;

/** The fold, with no database in it — so a drill can argue with the arithmetic. */
export function foldWorkload(
  rows: WorkloadRow[],
  throughput: Map<string, number>,
  opts: { now?: Date; sampleWeeks?: number } = {},
): Omit<WorkloadView, "medianFirstCutHours" | "firstCutSamples" | "measuredAt"> {
  const now = opts.now ?? new Date();
  const sampleWeeks = opts.sampleWeeks ?? 8;
  const byKey = new Map<string, EditorLoad>();
  const totals = emptyLanes();

  for (const r of rows) {
    const key = r.editorKey ?? "__none__";
    let load = byKey.get(key);
    if (!load) {
      const meta = r.editorKey ? editorMeta(r.editorKey) : null;
      load = {
        key: r.editorKey,
        name: meta?.name ?? r.editor ?? "Nobody yet",
        kind: !r.editorKey ? "unassigned" : meta?.kind === "external" ? "external" : "in_house",
        lanes: emptyLanes(),
        activeVideos: 0,
        activeJobs: 0,
        perWeek: null,
        sampleCuts: 0,
        weeksOfWork: null,
        overdue: 0,
        dueSoon: 0,
        nextDueISO: null,
        worstOverdueDays: null,
      };
      byKey.set(key, load);
    }
    const lane = laneOf(r.status);
    const videos = Math.max(1, r.videos || 1);
    load.lanes[lane].jobs++;
    load.lanes[lane].videos += videos;
    totals[lane].jobs++;
    totals[lane].videos += videos;
    if (lane !== "editing") continue;

    load.activeJobs++;
    load.activeVideos += videos;
    const due = r.dueISO ? new Date(r.dueISO) : null;
    if (due && Number.isFinite(due.getTime())) {
      if (r.late || due < now) {
        load.overdue++;
        const days = Math.floor((now.getTime() - due.getTime()) / DAY);
        load.worstOverdueDays = Math.max(load.worstOverdueDays ?? 0, days);
      } else if (due.getTime() - now.getTime() <= SOON_MS) {
        load.dueSoon++;
      }
      if (!load.nextDueISO || due < new Date(load.nextDueISO)) load.nextDueISO = due.toISOString();
    } else if (r.late) {
      load.overdue++;
    }
  }

  for (const load of byKey.values()) {
    const cuts = load.key ? throughput.get(load.key) ?? 0 : 0;
    load.sampleCuts = cuts;
    // THREE IS THE FLOOR. Two finished cuts in eight weeks is not a rate, it is
    // two events, and dividing by it produces a confident-looking "14 weeks of
    // work" from noise. Below the floor the view says it does not know.
    load.perWeek = cuts >= 3 ? Number((cuts / sampleWeeks).toFixed(2)) : null;
    load.weeksOfWork = load.perWeek && load.perWeek > 0 ? Number((load.activeVideos / load.perWeek).toFixed(1)) : null;
  }

  const editors = [...byKey.values()].sort((a, b) => {
    if (a.kind === "unassigned") return -1; // unassigned work is the first thing to fix
    if (b.kind === "unassigned") return 1;
    if (b.overdue !== a.overdue) return b.overdue - a.overdue;
    return b.activeVideos - a.activeVideos;
  });

  return {
    editors,
    totals,
    overdue: editors.reduce((n, e) => n + e.overdue, 0),
    unassignedActive: editors.find((e) => e.kind === "unassigned")?.activeVideos ?? 0,
    sampleWeeks,
  };
}

/** Approved cuts per editor over the window — the only capacity number that is
 *  not a guess. Keyed the same way the queue keys a row: the vendor pin first,
 *  then the assigned team member's name through the roster. */
export async function measuredThroughput(sampleWeeks = 8): Promise<Map<string, number>> {
  const since = new Date(Date.now() - sampleWeeks * 7 * DAY);
  const rows = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", updatedAt: { gte: since } },
    select: { project: { select: { editorVendorKey: true, editor: { select: { name: true } } } } },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = r.project.editorVendorKey ?? editorKeyForTeamName(r.project.editor?.name);
    if (!key || !(key in EDITORS)) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Median ELAPSED hours from shoot to the first cut being handed in. Not
 *  hands-on effort, and never described as such. */
export async function measuredFirstCut(): Promise<{ medianHours: number | null; samples: number }> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { round: 1, project: { shootDate: { not: null } } },
    select: { createdAt: true, project: { select: { shootDate: true } } },
    take: 400,
  });
  const hours = rows
    .map((r) => (r.project.shootDate ? (r.createdAt.getTime() - r.project.shootDate.getTime()) / 3_600_000 : null))
    .filter((h): h is number => h != null && h > 0 && h < 24 * 30)
    .sort((a, b) => a - b);
  if (hours.length < 5) return { medianHours: null, samples: hours.length };
  return { medianHours: Number(hours[Math.floor(hours.length / 2)].toFixed(1)), samples: hours.length };
}

export async function editingWorkload(rows: WorkloadRow[], opts: { now?: Date; sampleWeeks?: number } = {}): Promise<WorkloadView> {
  const sampleWeeks = opts.sampleWeeks ?? 8;
  const [throughput, firstCut] = await Promise.all([measuredThroughput(sampleWeeks), measuredFirstCut()]);
  const folded = foldWorkload(rows, throughput, { now: opts.now, sampleWeeks });
  return {
    ...folded,
    medianFirstCutHours: firstCut.medianHours,
    firstCutSamples: firstCut.samples,
    measuredAt: (opts.now ?? new Date()).toISOString(),
  };
}
