import "server-only";

import { prisma } from "@/lib/prisma";
import { EDITORS, VIDEO_LANE_KEYS, editorKeyForTeamName, editorMeta, editorTeamMemberId } from "@/lib/editors";
import { NOT_A_CUT } from "@/lib/reviewCuts";
import { capacityWindows, type CapacityWindows } from "@/lib/capacity";

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
//                    (OWED to them — not "being edited": §7.1, Sep 25. Which
//                    job an editor is on right now is lib/editorWork's answer,
//                    shown in the Working-now panel; this lane is the pile.)
//   in_review        the office (a verdict is owed)    — off the editor's desk
//   awaiting_send    the office (a send is owed)       — finished work, not out
//
// NO INVENTED HOURS. It would be easy to multiply videos by a made-up
// hours-each and print a number that looks like capacity; it would also be a
// guess dressed as a measurement. Everything below is measured off this
// database and says how big its sample was:
//
//   · throughput — approved cuts per editor per week over the sample window,
//     dated by the decision that finished them and credited to whoever handed
//     each one in (see measuredThroughput for why both of those are the rule).
//     The sample is thin, because this is a hub that has never run at scale, so
//     the number is reported WITH its sample and is null rather than misleading
//     when there is too little. No counts are written into this comment: they
//     rot. This line read "John Mark 9 in eight weeks, Kim 3" while the panel
//     was printing 13 and 5, and the panel prints the sample beside every rate
//     anyway, which is the copy a reader should trust.
//   · turnaround — the median hours from shoot to first cut. Same rule about
//     counts: the footer prints how many rows it was measured over. It is
//     ELAPSED time, not hands-on effort, and the wording everywhere says so.
//
// A reader gets "John has 7 videos he can work on, he finishes about 1 a week,
// two are already late" — three facts, each of which came from somewhere.
// ---------------------------------------------------------------------------

export type WorkLane = "waiting_footage" | "editing" | "in_review" | "awaiting_send";

export const LANE_LABEL: Record<WorkLane, string> = {
  waiting_footage: "Waiting on footage",
  // Not "In editing" (§7.1): this lane folds Ready for editing, Paused,
  // Revisions and anything unrecognised — work OWED, not work happening now.
  editing: "Owed to the editor",
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
    default: return "editing"; // Ready for editing · In editing · Paused · Revisions · Extra video owed
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
  /**
   * §10 capacity (Sep 26 2026): who is out now or in the next week, by editor
   * key — recorded facts (lib/capacity.ts), shown as chips. Kept BESIDE the
   * editors rather than inside EditorLoad on purpose: the lanes, rates and
   * weeks-of-work above are byte-identical with and without an exception,
   * because an exception is a sentence for a person to weigh, never an input
   * to the arithmetic. Absent when the read failed.
   */
  capacity?: Record<string, CapacityWindows>;
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
 *  not a guess.
 *
 *  TWO RULES, BOTH ABOUT NOT CREDITING THE WRONG THING (review Sep 20 2026).
 *
 *  THE CLOCK IS `decidedAt`, NOT `updatedAt`. `updatedAt` is `@updatedAt`: it
 *  moves every time anything later touches the row, and plenty does. On
 *  production today 20 of 25 approved cuts carry an `updatedAt` more than an
 *  hour past their decision, 14 more than a day, and "August 2026 Personal
 *  Branding" round 1 is 404 hours out — dragged forward by readyToSend stamping
 *  sentToClientAt on it, and deliverableOutputs backfilling an outputId is the
 *  same story in bulk. Since `updatedAt >= decidedAt` always, the error only
 *  ever runs one way: an old approval gets pulled back INTO the window and the
 *  rate reads high. Nothing has miscounted yet only because the whole review
 *  room is younger than eight weeks — the oldest approval is Aug 4, so that
 *  cover runs out around Oct 1 and Kyle marking one old cut "sent" would start
 *  inflating somebody's rate. The decision stamp cannot move, so it is the one
 *  to window on. An APPROVED row with no `decidedAt` (none exist today) falls
 *  out of the count rather than in, which is the safe side of the mistake.
 *
 *  THE CREDIT GOES TO WHOEVER HANDED THE CUT IN. The project's editor pin is
 *  who is on the job NOW, which is not the same person the moment anybody
 *  repoints a job — reassignEditor refuses on a DELIVERED job for exactly this
 *  reason, but a REVIEW or REVISION job is two clicks, and the project merge
 *  moves every submission of the losing job in one updateMany. The row already
 *  records its own author, so use it, the same order review/actions.ts uses
 *  for a cut's notes: submitter first, the project pin behind it.
 *
 *  Only a VIDEO LANE key takes the credit, and the reason is NOT that an
 *  operator might otherwise take a cut off its editor — the first draft of this
 *  comment said that and the review of Sep 20 2026 disproved it. An operator
 *  never lands an operator key here: uploadAuthor (review/actions.ts) writes
 *  `submittedByKey` only when the uploader's role is EDITOR, so Kyle's one row
 *  and Jordan's three are already NULL and already fall through to the project
 *  pin, and the submit-for-review button stamps the PROJECT's editor key, which
 *  is how Jordan's one submit-on-behalf row carries `luma`. The gate earns its
 *  place for a different case: an EDITOR whose key falls back to
 *  `slugForName(name)` produces a slug that is not on the roster, and without
 *  the gate the `key in EDITORS` guard below would DROP that cut outright
 *  rather than let the project pin count it.
 */
export async function measuredThroughput(sampleWeeks = 8): Promise<Map<string, number>> {
  const since = new Date(Date.now() - sampleWeeks * 7 * DAY);
  const rows = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", decidedAt: { gte: since } },
    select: {
      submittedByKey: true,
      project: { select: { editorVendorKey: true, editor: { select: { name: true } } } },
    },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const submitter =
      r.submittedByKey && (VIDEO_LANE_KEYS as readonly string[]).includes(r.submittedByKey)
        ? r.submittedByKey
        : null;
    const key = submitter ?? r.project.editorVendorKey ?? editorKeyForTeamName(r.project.editor?.name);
    if (!key || !(key in EDITORS)) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Median ELAPSED hours from shoot to the first cut being handed in. Not
 *  hands-on effort, and never described as such.
 *
 *  ONLY ROWS THAT ARE A CUT (review Sep 20 2026). A round-1 row is dated by
 *  when it was CREATED, and two kinds of row get created without a cut ever
 *  arriving: an upload that was reserved and abandoned (reviewCuts flips it to
 *  UPLOAD_FAILED after 24h, and UPLOADING is the same row before the sweep sees
 *  it), and the legacy withdrawn rows — 328 Columbia Ave is the one still in
 *  the table, and at 50 hours it was sitting in this median as a first cut that
 *  was taken down. That is precisely the set the review room already exports as
 *  NOT_A_CUT (reviewCuts.ts), so this imports it rather than retyping it — a
 *  retyped copy is a list that drifts.
 *
 *  SUPERSEDED IS DELIBERATELY NOT EXCLUDED, and the first pass of this change
 *  wrongly added it (caught in review, Sep 20 2026). The Editing Room's own
 *  counts do spell `[...NOT_A_CUT, "SUPERSEDED"]`, but they are asking a
 *  different question — "is anybody still waiting on this?" — and a superseded
 *  round is nobody's wait. Here the question is when the first cut arrived, and
 *  a SUPERSEDED round 1 is an editor who handed one in and then replaced it
 *  before anyone ruled: reviewCuts supersedes ANY earlier PENDING round of the
 *  same deliverable+slot, round 1 included. Dropping it would not mis-date that
 *  job, it would delete the job from the median entirely, because this query
 *  only ever looks at round 1. No such row exists today, so the wrong list
 *  would have been a silent under-count waiting to happen.
 *
 *  PENDING and CHANGES_REQUESTED stay IN for the same reason: a cut that was
 *  handed in and is awaiting a verdict, or came back for changes, is exactly
 *  the event this is trying to date.
 *
 *  AND THE SAMPLE IS THE NEWEST 400, not whichever 400 Postgres felt like. The
 *  cap has never been reached (27 rows today), so this changes nothing now and
 *  stops the number from silently becoming an all-time slice later. */
export async function measuredFirstCut(): Promise<{ medianHours: number | null; samples: number }> {
  const rows = await prisma.reviewSubmission.findMany({
    where: {
      round: 1,
      status: { notIn: [...NOT_A_CUT] },
      project: { shootDate: { not: null } },
    },
    select: { createdAt: true, project: { select: { shootDate: true } } },
    orderBy: { createdAt: "desc" },
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
  const capacity = await editorCapacity(folded.editors.map((e) => e.key), opts.now ?? new Date()).catch(() => undefined);
  return {
    ...folded,
    medianFirstCutHours: firstCut.medianHours,
    firstCutSamples: firstCut.samples,
    measuredAt: (opts.now ?? new Date()).toISOString(),
    ...(capacity ? { capacity } : {}),
  };
}

/** Capacity entries for the editors on the panel, keyed by editor key. Only a
 *  key that is a roster person can carry one (the outside shop has no row). */
export async function editorCapacity(keys: (string | null)[], at: Date = new Date()): Promise<Record<string, CapacityWindows>> {
  const pairs = (
    await Promise.all([...new Set(keys.filter((k): k is string => !!k))].map(async (k) => [k, await editorTeamMemberId(k)] as const))
  ).filter((p): p is readonly [string, string] => !!p[1]);
  const windows = await capacityWindows(pairs.map(([, id]) => id), at);
  const out: Record<string, CapacityWindows> = {};
  for (const [key, id] of pairs) {
    const w = windows.get(id);
    if (w && (w.now.length || w.next7d.length)) out[key] = w;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHAT A RUSH PUSHES BACK (§10 priority/rush + AU-24, Sep 26 2026).
//
// The override dialog could pull any job's date forward and nobody saw what it
// cost. The queue is ordered by due date (editorQueue's byDue), so an earlier
// date on one job silently moves it ahead of everything due between the new
// date and the old one on the same editor's desk. Priority does not reorder
// the queue, but URGENT on a row is the office telling the editor to do it
// first — ahead of jobs that are due sooner.
//
// priorityImpact answers one question, read-only: if this change were saved,
// which of the SAME editor's jobs would it put behind, and how tight are they?
// It never reorders anything and never re-pins a promise; the queue's own
// ordering is unchanged, and other editors' desks are never in the answer.
//
// Jordan, Sep 25-26: "James and Kyle - James is the creative manager now. Also
// It can be escalated to me." So a change that displaces anybody needs James or
// Kyle (the review seats: primary and backup), who must see the displaced jobs
// before saving; Jordan is the escalation and may always decide. Recorded on
// the timeline with who, when and why. Nothing here touches pay.
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
const rankOf = (p: string | null | undefined) => PRIORITY_RANK[p ?? "NORMAL"] ?? 1;
const PAID_RUSH_RE = /\bsame[-\s]?day\b|\brush\b|\bexpedit/i;
/** Same threshold the status engine calls "at risk" (statusEvidence.AT_RISK_HOURS). */
const IMPACT_AT_RISK_HOURS = 24;
const HOUR_MS = 3_600_000;

export type DisplacedJob = {
  projectId: string;
  street: string;
  client: string;
  dueISO: string | null;
  /** the promise it was SOLD under (Project.promisedDueAt), when pinned */
  promiseISO: string | null;
  /** hours from now to its due; negative = already late; null = undated */
  slackHours: number | null;
  /** due inside a day or already late — the ones a delay is most likely to break */
  atRisk: boolean;
  /** date = it would now sort behind; priority = it is due sooner but now outranked */
  why: "date" | "priority";
  priority: string;
};

export type PriorityImpact = {
  projectId: string;
  street: string;
  editorKey: string | null;
  editorName: string | null;
  before: { dueISO: string | null; priority: string };
  after: { dueISO: string | null; priority: string };
  /** this job's own pinned promise */
  promiseISO: string | null;
  /** a same-day / rush line is on the order — the client paid for speed */
  paidRush: boolean;
  /** the new date is earlier than the promise the client was sold */
  fasterThanPromise: boolean;
  displaced: DisplacedJob[];
  /** capacity entries for this editor in force now or in the next week — INTERNAL words only */
  editorOut: string[];
  /** one line for the dialog and the timeline */
  sentence: string;
  /** why nothing was computed, when that is the answer */
  note: string | null;
};

type QueueLike = { id: string; street: string; client: string; editorKey: string | null; editor: string | null; status: string; dueISO: string | null; shootISO: string | null; priority: string };

/** editorQueue's byDue, restated for a row whose date is hypothetical: undated
 *  last, then the older shoot, then the street. Kept identical on purpose. */
function queueOrder(a: Pick<QueueLike, "dueISO" | "shootISO" | "street">, b: Pick<QueueLike, "dueISO" | "shootISO" | "street">): number {
  const at = a.dueISO ? new Date(a.dueISO).getTime() : Infinity;
  const bt = b.dueISO ? new Date(b.dueISO).getTime() : Infinity;
  return at - bt || (a.shootISO ?? "").localeCompare(b.shootISO ?? "") || a.street.localeCompare(b.street);
}

/** The fold, with no database in it. `rows` is the Not Done rail. */
export function foldPriorityImpact(
  rows: QueueLike[],
  targetId: string,
  /** editorKey: the desk it lands on when the same save reassigns it ("" = nobody) */
  after: { dueISO: string | null; priority: string; editorKey?: string | null },
  now: Date,
): { displaced: Omit<DisplacedJob, "promiseISO">[]; note: string | null; target: QueueLike | null } {
  const target = rows.find((r) => r.id === targetId) ?? null;
  if (!target) return { displaced: [], note: "It isn't on the editing board yet (the shoot is still ahead) — nothing on a desk moves.", target };
  const desk = after.editorKey === undefined ? target.editorKey : after.editorKey || null;
  if (!desk) return { displaced: [], note: "No editor is on it yet — nothing on anybody's desk moves until one is.", target };
  const targetLane = laneOf(target.status);
  if (targetLane === "in_review" || targetLane === "awaiting_send") {
    return { displaced: [], note: "It is waiting on the office, not the editor — nothing on the editor's desk moves.", target };
  }
  // A job handed to another editor in the same save lands on THEIR desk: there
  // was no "before" place there, so everything it now sorts ahead of is moved.
  const newDesk = desk !== target.editorKey;
  const before = target;
  const moved = { ...target, dueISO: after.dueISO };
  const raised = newDesk ? rankOf(after.priority) > rankOf("NORMAL") : rankOf(after.priority) > rankOf(before.priority);
  const floor = newDesk ? rankOf("LOW") : rankOf(before.priority);
  const out: Omit<DisplacedJob, "promiseISO">[] = [];
  for (const r of rows) {
    if (r.id === target.id || r.editorKey !== desk || laneOf(r.status) !== "editing") continue;
    const aheadBefore = newDesk || queueOrder(r, before) < 0;
    const behindAfter = queueOrder(moved, r) < 0;
    let why: DisplacedJob["why"] | null = null;
    if (aheadBefore && behindAfter) why = "date";
    else if (raised && queueOrder(r, moved) < 0 && rankOf(r.priority) < rankOf(after.priority) && rankOf(r.priority) >= floor) why = "priority";
    if (!why) continue;
    const due = r.dueISO ? new Date(r.dueISO) : null;
    // Whole hours LEFT, rounded down: "22 hours" when it is 22½ never
    // overstates the room a job has.
    const slack = due ? Math.floor((due.getTime() - now.getTime()) / HOUR_MS) : null;
    out.push({
      projectId: r.id,
      street: r.street,
      client: r.client,
      dueISO: r.dueISO,
      slackHours: slack,
      atRisk: slack != null && slack <= IMPACT_AT_RISK_HOURS,
      why,
      priority: r.priority,
    });
  }
  return { displaced: out, note: null, target };
}

/**
 * What saving { dueAt, priority } on this job would push back. Read-only.
 * `change.dueAt`: undefined = unchanged, null = hand back to the hub's date,
 * an ISO string = the office's date. Same for priority.
 */
export async function priorityImpact(
  projectId: string,
  change: { dueAt?: string | null; priority?: string | null; editorKey?: string | null },
  opts: { now?: Date } = {},
): Promise<PriorityImpact> {
  const now = opts.now ?? new Date();
  const [{ buildEditorQueue }, { effectiveDue, effectivePriority }, { etDateTime }] = await Promise.all([
    import("@/lib/editorQueue"),
    import("@/lib/editOverrides"),
    import("@/lib/datetime"),
  ]);
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, priority: true, priorityOverride: true, dueOverrideAt: true, promisedDueAt: true, shootDate: true, deliveryDue: true,
      orderItems: { where: { isCanceled: false }, select: { title: true } },
    },
  });
  if (!p) throw new Error("That job no longer exists.");
  const queue = await buildEditorQueue();
  const row = queue.notDone.find((r) => r.id === projectId) ?? null;
  const beforeDue = row?.dueISO ?? effectiveDue(p, p.deliveryDue)?.toISOString() ?? null;
  const beforePriority = row?.priority ?? effectivePriority(p, p.priority);
  const afterDue =
    change.dueAt === undefined ? beforeDue
    : change.dueAt === null ? effectiveDue({ ...p, dueOverrideAt: null }, p.deliveryDue)?.toISOString() ?? null
    : new Date(change.dueAt).toISOString();
  const afterPriority = change.priority === undefined ? beforePriority : effectivePriority({ priorityOverride: change.priority }, p.priority);

  const folded = foldPriorityImpact(
    queue.notDone,
    projectId,
    { dueISO: afterDue, priority: afterPriority, ...(change.editorKey !== undefined && change.editorKey !== null ? { editorKey: change.editorKey } : {}) },
    now,
  );
  const promises = new Map(
    folded.displaced.length
      ? (await prisma.project.findMany({ where: { id: { in: folded.displaced.map((d) => d.projectId) } }, select: { id: true, promisedDueAt: true } })).map((x) => [x.id, x.promisedDueAt])
      : [],
  );
  const displaced: DisplacedJob[] = folded.displaced.map((d) => ({ ...d, promiseISO: promises.get(d.projectId)?.toISOString() ?? null }));
  const reassigned = change.editorKey != null && change.editorKey !== (row?.editorKey ?? "");
  const editorKey = reassigned ? change.editorKey || null : row?.editorKey ?? null;
  const editorName = reassigned ? (editorKey ? editorMeta(editorKey)?.name ?? editorKey : null) : row?.editor ?? null;
  // INTERNAL reason only (AU-24): an editor out this week is a fact for the
  // person deciding, never a sentence for a client.
  const editorOut = editorKey
    ? await editorCapacity([editorKey], now)
        .then((m) => [...(m[editorKey]?.now ?? []), ...(m[editorKey]?.next7d ?? [])].map((c) => `${editorName ?? "The editor"}: ${c.label.toLowerCase()} ${c.when}`))
        .catch(() => [] as string[])
    : [];

  const promise = p.promisedDueAt;
  const who = editorName ? `${editorName}'s` : "the editor's";
  // The board's date first when it is not the promise (the office already
  // moved it), so "due inside a day" is never printed beside a date a week out.
  const when = (d: DisplacedJob) =>
    d.dueISO && d.promiseISO && d.dueISO !== d.promiseISO
      ? `due ${etDateTime(d.dueISO)} ET, promised ${etDateTime(d.promiseISO)} ET`
      : d.promiseISO ? `promised ${etDateTime(d.promiseISO)} ET`
      : d.dueISO ? `due ${etDateTime(d.dueISO)} ET`
      : "no date";
  const name = (d: DisplacedJob) =>
    `${d.street} (${when(d)}${d.atRisk ? (d.slackHours != null && d.slackHours < 0 ? "; already late" : "; due inside a day") : ""})`;
  const list = (xs: DisplacedJob[]) => xs.slice(0, 4).map(name).join(", ") + (xs.length > 4 ? ` and ${xs.length - 4} more` : "");
  const byDate = displaced.filter((d) => d.why === "date");
  const byRank = displaced.filter((d) => d.why === "priority");
  const parts: string[] = [];
  if (byDate.length) parts.push(`moves ahead of ${byDate.length} of ${who} jobs — ${list(byDate)}`);
  if (byRank.length) parts.push(`is flagged above ${byRank.length} of ${who} jobs due sooner — ${list(byRank)}`);
  const sentence = parts.length ? `This ${parts.join("; and ")}` : folded.note ?? `Moves nothing ahead on ${who} desk.`;

  return {
    projectId,
    street: (p.title || "this job").split(",")[0].trim(),
    editorKey,
    editorName,
    before: { dueISO: beforeDue, priority: beforePriority },
    after: { dueISO: afterDue, priority: afterPriority },
    promiseISO: promise?.toISOString() ?? null,
    paidRush: p.orderItems.some((it) => PAID_RUSH_RE.test(it.title)),
    fasterThanPromise: !!afterDue && !!promise && new Date(afterDue).getTime() < promise.getTime(),
    displaced,
    editorOut,
    sentence,
    note: folded.note,
  };
}

/** Could this change displace anything at all? False when the date only moves
 *  later (or stays) and the priority does not rise — the cheap answer that
 *  lets a save skip the queue read entirely. */
export function mayDisplace(before: { dueISO: string | null; priority: string }, after: { dueISO: string | null; priority: string }): boolean {
  if (rankOf(after.priority) > rankOf(before.priority)) return true;
  const b = before.dueISO ? new Date(before.dueISO).getTime() : Infinity;
  const a = after.dueISO ? new Date(after.dueISO).getTime() : Infinity;
  return a < b;
}

// ---------------------------------------------------------------------------
// THE ASK ON JORDAN'S CARD, AS DATA (review, Sep 28 2026). "Approve by saving
// the same change" needs to know what the change WAS: the card's summary is
// words, so the asked columns ride on the card's sourceDetail too
// ("rush-ask:{...}", the dueOverrideAt / priorityOverride values the dialog
// asked for). With them a save can tell the ask has landed (whoever saved it,
// once it pushes nobody back there is nothing left to approve), and the job
// page stops showing "Waiting on approval" for a date the job already carries.
// A card written before this carries no ask data and reads as before.
// ---------------------------------------------------------------------------
const RUSH_ASK_PREFIX = "rush-ask:";
export type RushAskChange = { dueAt?: string | null; priority?: string | null };

/** The card's sourceDetail for an ask. Only the two columns a rush is. Pure. */
export function rushAskDetail(change: RushAskChange): string {
  const out: RushAskChange = {};
  if (change.dueAt !== undefined) out.dueAt = change.dueAt;
  if (change.priority !== undefined) out.priority = change.priority;
  return `${RUSH_ASK_PREFIX}${JSON.stringify(out)}`;
}

/** The ask back off a card, or null for a card that carries none. Pure, shape-tolerant. */
export function readRushAsk(sourceDetail: string | null | undefined): RushAskChange | null {
  if (!sourceDetail?.startsWith(RUSH_ASK_PREFIX)) return null;
  try {
    const v = JSON.parse(sourceDetail.slice(RUSH_ASK_PREFIX.length)) as Record<string, unknown>;
    const out: RushAskChange = {};
    if (v.dueAt === null || typeof v.dueAt === "string") out.dueAt = v.dueAt;
    if (v.priority === null || typeof v.priority === "string") out.priority = v.priority;
    return out.dueAt === undefined && out.priority === undefined ? null : out;
  } catch {
    return null;
  }
}

/** Does the job already carry everything the ask asked for? False for no ask. Pure. */
export function rushAskLanded(ask: RushAskChange | null, job: { dueOverrideAt: Date | null; priorityOverride: string | null }): boolean {
  if (!ask || (ask.dueAt === undefined && ask.priority === undefined)) return false;
  if (ask.dueAt !== undefined) {
    const want = ask.dueAt === null ? null : new Date(ask.dueAt).getTime();
    if (want !== null && Number.isNaN(want)) return false;
    if ((job.dueOverrideAt?.getTime() ?? null) !== want) return false;
  }
  if (ask.priority !== undefined && (job.priorityOverride ?? null) !== ask.priority) return false;
  return true;
}

/**
 * The open "approve this rush?" card on a job, as the job page shows it: who
 * sent it, when, and its words without the card's how-to-approve tail (the
 * dialog says how, in its own words). Null when none is open. The sender is
 * the card's flaggedBy: a person sent this card to Jordan, which is exactly
 * what that column records (never a "who asked" for a client's revision).
 */
export async function openRushAsk(projectId: string): Promise<{ by: string | null; atISO: string; words: string } | null> {
  const t = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "rush_approval", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    orderBy: { updatedAt: "desc" },
    select: { flaggedBy: true, flaggedAt: true, updatedAt: true, summary: true },
  });
  if (!t) return null;
  return { by: t.flaggedBy, atISO: (t.flaggedAt ?? t.updatedAt).toISOString(), words: (t.summary ?? "").replace(/\s*Approve by saving[\s\S]*$/, "").trim() };
}

export type RushAuthority = {
  /** this login may approve a change that displaces other jobs */
  may: boolean;
  /** which seat it is approving from */
  as: "PRIMARY" | "BACKUP" | "OWNER" | "OFFICE" | null;
  /** the people who may approve, for the sentence */
  approvers: string[];
  /** who a rush is escalated to (Jordan) */
  escalateTo: string | null;
  /** the refusal, in words, when may = false */
  why: string | null;
  /** the review seats are named — otherwise the office's old authority stands */
  seatsNamed: boolean;
};

/**
 * WHO MAY APPROVE A RUSH (Jordan, Sep 25-26). The review seats, read the way
 * the Review Room reads them (reviewerAssignment.reviewerChain): the PRIMARY
 * (James) and the BACKUP (Kyle). The owner may always decide — "it can be
 * escalated to me" — and so may the FALLBACK seat, which is him. Never the
 * creative-manager flag: that is a shoot-bonus basis and grants nothing.
 *
 * With no seat named at all the office's existing authority stands (owner and
 * admin), exactly as before this rule — §4 never narrows anybody silently —
 * and the dialog says the seats are not set.
 */
export async function rushAuthority(
  me: { realRole: string; teamMemberId: string | null; impersonating: boolean; status?: string } | null,
  opts: { authEnforced: boolean },
): Promise<RushAuthority> {
  const { reviewerChain } = await import("@/lib/reviewerAssignment");
  const chain = await reviewerChain().catch(() => null);
  const owner = chain?.fallback
    ? null
    : await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, select: { name: true } }).catch(() => null);
  const escalateTo = chain?.fallback?.name ?? owner?.name ?? "Jordan";
  if (!chain?.configured) {
    const may = !me ? !opts.authEnforced : !me.impersonating && (me.realRole === "OWNER" || me.realRole === "ADMIN");
    return {
      may,
      as: may ? (me?.realRole === "OWNER" ? "OWNER" : "OFFICE") : null,
      approvers: ["the office"],
      escalateTo,
      why: may ? null : "Only the office can approve this.",
      seatsNamed: false,
    };
  }
  const approvers = [chain.primary, chain.backup].filter((m): m is NonNullable<typeof m> => !!m && m.canRule);
  const names = approvers.map((m) => m.name);
  if (!me) {
    const may = !opts.authEnforced;
    return { may, as: may ? "OFFICE" : null, approvers: names, escalateTo, why: may ? null : "Please sign in to do that.", seatsNamed: true };
  }
  if (me.impersonating) return { may: false, as: null, approvers: names, escalateTo, why: "You're previewing another user — exit the preview to make changes.", seatsNamed: true };
  if (me.status && me.status !== "ACTIVE") return { may: false, as: null, approvers: names, escalateTo, why: "You don't have access to do that.", seatsNamed: true };
  const seat = approvers.find((m) => m.teamMemberId === me.teamMemberId);
  if (seat) return { may: true, as: seat.slot === "PRIMARY" ? "PRIMARY" : "BACKUP", approvers: names, escalateTo, why: null, seatsNamed: true };
  if (me.realRole === "OWNER" || (chain.fallback && chain.fallback.teamMemberId === me.teamMemberId)) {
    return { may: true, as: "OWNER", approvers: names, escalateTo, why: null, seatsNamed: true };
  }
  const first = (n: string) => n.split(/\s+/)[0];
  return {
    may: false,
    as: null,
    approvers: names,
    escalateTo,
    why: `Only ${names.length ? names.map(first).join(" or ") : "the review seats"} can approve moving this ahead of other jobs — or send it to ${first(escalateTo)}.`,
    seatsNamed: true,
  };
}
