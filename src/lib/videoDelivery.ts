import "server-only";

import { prisma } from "@/lib/prisma";
import { EMPTY_COUNTS, type JobCounts } from "@/lib/opsCounts";
import { etDateTime, etDayKey, etAt } from "@/lib/datetime";
import type { VideoPushLine } from "@/lib/videoAryeoPush";
import type { VideoPushMode } from "@/lib/videoDeliverySettings";

// ---------------------------------------------------------------------------
// VIDEO DELIVERY, KYLE'S SCREEN (Oct 19 2026).
//
// Jordan: a video delivery section like the photo one, "how many videos are
// going out today or need to go out today or are due today, and how many
// we're behind on." One read builds the screen (/ops/video-delivery) and the
// four numbers on Kyle's Home tile (videoDeliveryCounts), so the tile never
// disagrees with the page it opens. Test clients are left out.
//
// LISTING VIDEOS, one row per video where the hub can tell them apart (each
// cut the Review Room knows; a video not cut yet is a row of its own), dated
// by the same promise Kyle's delivery board uses (deliveryBoard: the job's
// video item, capped by the promise it was sold under; the office's date or a
// reopened job's clock when there is one), in lanes:
//   Late          past its promise, not approved yet
//   Due today     due by the end of today (ET), not approved yet
//   In review     a cut waiting for a verdict
//   Coming up     everything else still owed (not shot, editing, no date)
//   Sending       approved: the 1080p pass, then the hub's upload and delivery
//                 to Aryeo (or Kyle by hand while the switch is off)
//   Held          approved but held: the client's open asks, the sound check,
//                 the job on hold, a person's hold
//   Delivered     this week
// Approved and held rows count as late too when they are past their promise.
// CONTENT-PROGRAM videos (monthly, the client's portal) are a smaller section:
// late and due today, from the program watch (lib/programWatch).
// ---------------------------------------------------------------------------

export type VideoDeliveryCounts = JobCounts & {
  /** Listing videos past their promise, not delivered. */
  lateListing: number;
  /** Hours the most-late listing video is past its promise; null when none. */
  oldestLateHours: number | null;
  /** Content-program (monthly) videos past their date. */
  lateMonthly: number;
};

export type VideoLane = "late" | "today" | "review" | "upcoming" | "sending" | "held" | "delivered";
export const VIDEO_LANES: VideoLane[] = ["late", "today", "sending", "held", "review", "upcoming", "delivered"];

export type VideoRow = {
  key: string;
  submissionId: string | null;
  projectId: string;
  street: string;
  clientName: string;
  label: string;
  round: number | null;
  lane: VideoLane;
  /** Where it stands, in a few words ("In review, version 2", "In the 1080p pass"). */
  stage: string;
  promiseISO: string | null;
  promiseWords: string;
  late: boolean;
  dueToday: boolean;
  lateHours: number | null;
  approvedAtISO: string | null;
  deliveredAtISO: string | null;
  deliveredBy: string | null;
  push: VideoPushLine | null;
  heldWhy: string | null;
  reviewHref: string | null;
  aryeoUrl: string | null;
  /** Since when this one has been waiting to go out (counts' oldest). */
  waitingSinceISO: string | null;
};

export type ProgramRow = {
  outputId: string;
  projectId: string;
  clientName: string;
  title: string;
  monthWords: string;
  promiseISO: string | null;
  promiseWords: string;
  late: boolean;
  stage: string;
  why: string;
};

export type VideoDeliveryBoard = {
  asOf: string;
  lanes: Record<VideoLane, VideoRow[]>;
  program: { late: ProgramRow[]; dueToday: ProgramRow[]; atRisk: number; unavailable: boolean };
  counts: VideoDeliveryCounts;
  mode: VideoPushMode;
  /** The hub's Aryeo login is set up (Connections). */
  connected: boolean;
  unavailable?: boolean;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "Untitled job";
const hoursBetween = (a: number, b: number) => Math.max(0, Math.round((b - a) / HOUR));

function promiseWords(at: Date | null, now: Date, delivered = false): string {
  if (!at) return "No date yet";
  const late = at.getTime() < now.getTime();
  if (delivered) return `Promised ${etDateTime(at)} ET`;
  if (late) {
    const h = hoursBetween(at.getTime(), now.getTime());
    return `Late by ${h < 48 ? `${h} h` : `${Math.round(h / 24)} days`} (due ${etDateTime(at)} ET)`;
  }
  if (etDayKey(at) === etDayKey(now)) return `Due today, ${etDateTime(at).split(", ").pop()} ET`;
  return `Due ${etDateTime(at)} ET`;
}

/** The video promise for a listing job: its video item, capped by the promise it was sold under; the office's date or a reopened clock win. */
function videoPromise(
  job: { dueAt: Date | null; dueTierLabel: string | null; reopened: boolean; items: { title: string; dueAt: Date | null }[] } | undefined,
  project: { promisedDueAt: Date | null; shootDate: Date | null },
  helpers: { categoryLabelsForLabel: (l: string) => string[]; pinnedPromise: (p: { promisedDueAt?: Date | null; shootDate?: Date | null }) => Date | null; cappedByPromise: (c: Date | null, p: Date | null | undefined) => Date | null },
): Date | null {
  const pin = helpers.pinnedPromise(project);
  if (!job) return pin;
  if (job.reopened || job.dueTierLabel === "office override") return job.dueAt;
  const vids = job.items.filter((i): i is { title: string; dueAt: Date } => !!i.dueAt && helpers.categoryLabelsForLabel(i.title).includes("Video"));
  const itemDue = vids.length ? vids.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b)).dueAt : null;
  if (itemDue) return helpers.cappedByPromise(itemDue, pin);
  return job.dueAt ?? pin;
}

const EMPTY_LANES = (): Record<VideoLane, VideoRow[]> => ({ late: [], today: [], review: [], upcoming: [], sending: [], held: [], delivered: [] });

let memo: { at: number; value: VideoDeliveryBoard } | null = null;

/** The whole screen. `now` is for drills. Home's tile may reuse a read up to
 *  15 seconds old; the screen itself (`fresh`) always reads anew, so a press
 *  shows at once. */
export async function videoDeliveryBoard(opts: { now?: Date; fresh?: boolean } = {}): Promise<VideoDeliveryBoard> {
  if (!opts.now && !opts.fresh && memo && Date.now() - memo.at < 15_000) return memo.value;
  const value = await buildBoard(opts.now ?? new Date());
  if (!opts.now) memo = { at: Date.now(), value };
  return value;
}

async function buildBoard(now: Date): Promise<VideoDeliveryBoard> {
  const todayKey = etDayKey(now);
  const endOfToday = etAt(todayKey, 23, 59);
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const { videoDeliverySettings } = await import("@/lib/videoDeliverySettings");
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const excludeClientIds = clients.filter(isSyntheticClientRow).map((c) => c.id);
  const excluded = new Set(excludeClientIds);

  const [{ deliveryBoard }, { readyToSend }, { videoStatesFor }, turnaround, qc, settings, connected] = await Promise.all([
    import("@/lib/deliveryBoard"),
    import("@/lib/readyToSend"),
    import("@/lib/reviewCuts"),
    import("@/lib/turnaround"),
    import("@/lib/qcCategories"),
    videoDeliverySettings(),
    import("@/lib/integrations/aryeoWeb").then((m) => m.aryeoWebCredentials()).then((c) => !!c).catch(() => false),
  ]);
  const helpers = { categoryLabelsForLabel: qc.categoryLabelsForLabel as (l: string) => string[], pinnedPromise: turnaround.pinnedPromise, cappedByPromise: turnaround.cappedByPromise };

  const [board, ready, deliveredRecently] = await Promise.all([
    deliveryBoard({ excludeClientIds }),
    readyToSend({ excludeClientIds, recordFollowUpHealth: false, includeNoticeIncidents: false }),
    prisma.reviewSubmission.findMany({
      where: { status: "APPROVED", sentToClientAt: { gte: new Date(now.getTime() - 7 * DAY) }, project: { contentMonthId: null, ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}) } },
      select: { id: true, projectId: true, round: true, sentToClientAt: true, sentToClientBy: true, decidedAt: true },
    }),
  ]);
  if (board.unavailable) throw new Error("The delivery board could not be read.");
  const jobs = [...board.today, ...board.tomorrow, ...board.upcoming, ...board.delivered];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const readyRows = ready.ready.filter((v) => v.deliveryDestination !== "client-portal" && !v.monthlyProgram);
  const renderingRows = ready.rendering.filter((v) => v.deliveryDestination !== "client-portal" && !v.monthlyProgram);

  const candidateIds = [...new Set([...jobs.map((j) => j.id), ...readyRows.map((v) => v.projectId), ...renderingRows.map((v) => v.projectId), ...deliveredRecently.map((d) => d.projectId)])];
  const projects = candidateIds.length
    ? await prisma.project.findMany({
        where: { id: { in: candidateIds }, contentMonthId: null, ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}) },
        select: { id: true, title: true, status: true, promisedDueAt: true, shootDate: true, aryeoListingId: true, aryeoOrderId: true, client: { select: { name: true } } },
      })
    : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  // Listing jobs that owe a video (or have one ready or just delivered).
  const videoJobIds = projects.filter((p) => {
    const j = jobById.get(p.id);
    return (j && j.video !== "n/a") || readyRows.some((v) => v.projectId === p.id) || renderingRows.some((v) => v.projectId === p.id) || deliveredRecently.some((d) => d.projectId === p.id);
  }).map((p) => p.id);
  const states = await videoStatesFor(videoJobIds);
  const { aryeoJobUrl } = await import("@/lib/aryeoUrl");

  // What holds an approved video: the hub's own push line, a held 1080p file, the client's open asks.
  const readyBySub = new Map(readyRows.map((v) => [v.submissionId, v]));
  const renderingBySub = new Map(renderingRows.map((v) => [v.submissionId, v]));
  const approvedProjects = [...new Set([...readyRows, ...renderingRows].map((v) => v.projectId))];
  const asks = new Map<string, string | null>();
  await Promise.all(approvedProjects.map(async (pid) => {
    try {
      const { openAsksHolding } = await import("@/lib/clientAsks");
      const a = await openAsksHolding(pid, "video");
      asks.set(pid, a.length ? `Waiting on Kyle to confirm ${a.length} client ask${a.length === 1 ? "" : "s"}${a[0]?.summary ? ` ("${a[0].summary.slice(0, 100)}")` : ""}.` : null);
    } catch {
      asks.set(pid, "The client's open asks could not be read just now.");
    }
  }));
  const deliveredBySub = new Map(deliveredRecently.map((d) => [d.id, d]));
  // Approved cuts that are on no list: settled earlier (a 1080p job stamped delivered, an older send).
  const approvedIds = [...states.values()].flatMap((s) => s.cuts).filter((c) => c.status === "APPROVED" && !readyBySub.has(c.submissionId) && !renderingBySub.has(c.submissionId) && !deliveredBySub.has(c.submissionId)).map((c) => c.submissionId);
  const settledElsewhere = new Map(
    (approvedIds.length
      ? await prisma.reviewSubmission.findMany({ where: { id: { in: approvedIds } }, select: { id: true, topazJob: { select: { deliveredAt: true, deliveredBy: true } } } })
      : []
    ).map((s) => [s.id, s.topazJob]),
  );

  const lanes = EMPTY_LANES();
  const nowMs = now.getTime();
  const push = (row: VideoRow) => lanes[row.lane].push(row);

  for (const pid of videoJobIds) {
    const p = projectById.get(pid);
    if (!p || excluded.has(pid)) continue;
    const job = jobById.get(pid);
    const st = states.get(pid);
    const promise = videoPromise(job, p, helpers);
    const late = !!promise && promise.getTime() < nowMs;
    const dueToday = !!promise && promise.getTime() <= endOfToday.getTime();
    const base = {
      projectId: pid, street: streetOf(p.title), clientName: p.client?.name ?? "Client",
      promiseISO: promise?.toISOString() ?? null, aryeoUrl: aryeoJobUrl(p),
    };
    const settledJob = !!job?.settled || p.status === "DELIVERED";
    const cuts = st?.cuts ?? [];
    for (const c of cuts) {
      const common = { ...base, key: c.submissionId, submissionId: c.submissionId, label: c.cutLabel, round: c.round, reviewHref: `/review/${pid}?cut=${c.submissionId}` };
      if (c.status === "APPROVED") {
        const r = readyBySub.get(c.submissionId);
        const rend = renderingBySub.get(c.submissionId);
        const sent = deliveredBySub.get(c.submissionId);
        if (r || rend) {
          const pushLine = r?.push ?? null;
          const heldWhy = rend?.held ? `${rend.says}${rend.held.lastCheck ? ` ${rend.held.lastCheck}` : ""}`
            : pushLine && (pushLine.tone === "held") ? pushLine.says
            : asks.get(pid) ?? null;
          const approvedAt = r?.approvedAtISO ?? rend?.approvedAtISO ?? c.sinceISO;
          push({
            ...common, lane: heldWhy ? "held" : "sending",
            stage: rend ? (rend.held ? "1080p file held" : "In the 1080p pass") : pushLine?.state === "WAITING" && pushLine.waitingForKyle ? "On Aryeo, not delivered" : r?.uploaded ? "On Aryeo, not delivered" : "Approved, ready to send",
            promiseWords: promiseWords(promise, now), late, dueToday, lateHours: late ? hoursBetween(promise!.getTime(), nowMs) : null,
            approvedAtISO: approvedAt, deliveredAtISO: null, deliveredBy: null, push: pushLine, heldWhy,
            waitingSinceISO: rend ? null : approvedAt,
          });
          continue;
        }
        if (sent?.sentToClientAt) {
          push({
            ...common, lane: "delivered", stage: "Delivered",
            promiseWords: promiseWords(promise, now, true), late: !!promise && sent.sentToClientAt.getTime() > promise.getTime(), dueToday: false, lateHours: null,
            approvedAtISO: sent.decidedAt?.toISOString() ?? null, deliveredAtISO: sent.sentToClientAt.toISOString(), deliveredBy: sent.sentToClientBy ?? null,
            push: null, heldWhy: null, waitingSinceISO: null,
          });
          continue;
        }
        const tj = settledElsewhere.get(c.submissionId);
        if (tj?.deliveredAt && nowMs - tj.deliveredAt.getTime() < 7 * DAY) {
          push({
            ...common, lane: "delivered", stage: "Delivered",
            promiseWords: promiseWords(promise, now, true), late: !!promise && tj.deliveredAt.getTime() > promise.getTime(), dueToday: false, lateHours: null,
            approvedAtISO: null, deliveredAtISO: tj.deliveredAt.toISOString(), deliveredBy: tj.deliveredBy ?? null, push: null, heldWhy: null, waitingSinceISO: null,
          });
        }
        continue;
      }
      if (settledJob) continue;
      const stage = c.status === "PENDING" ? `In review, version ${c.round}` : `Changes asked, version ${c.round}`;
      const lane: VideoLane = late ? "late" : dueToday ? "today" : c.status === "PENDING" ? "review" : "upcoming";
      push({
        ...common, lane, stage, promiseWords: promiseWords(promise, now), late, dueToday, lateHours: late ? hoursBetween(promise!.getTime(), nowMs) : null,
        approvedAtISO: null, deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, waitingSinceISO: late ? promise!.toISOString() : null,
      });
    }
    // Videos owed with no cut yet.
    if (!settledJob && st) {
      const missing = Math.max(0, st.owed - cuts.length);
      const stage = ["BOOKED", "SCHEDULED"].includes(p.status) ? "Not shot yet"
        : st.stage === "editing" ? "Editing"
        : st.stage === "ready_to_edit" ? "Ready to edit"
        : "Not cut yet";
      for (let i = 0; i < missing; i++) {
        const lane: VideoLane = late ? "late" : dueToday ? "today" : "upcoming";
        push({
          ...base, key: `${pid}:uncut:${i}`, submissionId: null, label: st.owed > 1 ? `Video ${cuts.length + i + 1} of ${st.owed}` : "Listing video", round: null,
          lane, stage, promiseWords: promiseWords(promise, now), late, dueToday, lateHours: late ? hoursBetween(promise!.getTime(), nowMs) : null,
          approvedAtISO: null, deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, reviewHref: null, waitingSinceISO: late ? promise!.toISOString() : null,
        });
      }
    }
  }

  // Order: the most late first; then by promise; undated last.
  const byPromise = (a: VideoRow, b: VideoRow) => (a.promiseISO ?? "9999").localeCompare(b.promiseISO ?? "9999");
  for (const k of VIDEO_LANES) lanes[k].sort(byPromise);
  lanes.delivered.sort((a, b) => (b.deliveredAtISO ?? "").localeCompare(a.deliveredAtISO ?? ""));
  lanes.sending.sort((a, b) => Number(b.late) - Number(a.late) || (a.approvedAtISO ?? "").localeCompare(b.approvedAtISO ?? ""));

  // ---- the content program (monthly, the client's portal) ----
  const program = { late: [] as ProgramRow[], dueToday: [] as ProgramRow[], atRisk: 0, unavailable: false };
  try {
    const { programVideos } = await import("@/lib/programWatch");
    const { STAGE_STAFF_WORDS } = await import("@/lib/programWatchCore");
    const rows = (await programVideos({ now })).filter((r) => !excluded.has(r.clientId) && r.evaluation && r.evaluation.status !== "DONE");
    for (const r of rows) {
      const e = r.evaluation!;
      if (e.status === "AT_RISK") program.atRisk++;
      const row: ProgramRow = {
        outputId: r.outputId, projectId: r.projectId, clientName: r.clientName, title: r.title, monthWords: r.monthWords,
        promiseISO: r.promisedAt?.toISOString() ?? null, promiseWords: promiseWords(r.promisedAt, now), late: e.status === "LATE",
        stage: STAGE_STAFF_WORDS[e.stage] ?? e.stage, why: r.why,
      };
      if (e.status === "LATE") program.late.push(row);
      else if (r.promisedAt && r.promisedAt.getTime() <= endOfToday.getTime()) program.dueToday.push(row);
    }
    program.late.sort((a, b) => (a.promiseISO ?? "").localeCompare(b.promiseISO ?? ""));
  } catch (e) {
    console.warn("[video-delivery] program videos unavailable", e);
    program.unavailable = true;
  }

  // ---- the counts (Kyle's Home tile reads these, nothing else) ----
  const owedRows = VIDEO_LANES.filter((l) => l !== "delivered").flatMap((l) => lanes[l]);
  const lateRows = owedRows.filter((r) => r.late);
  const openRows = [...lanes.late, ...lanes.today, ...lanes.sending, ...lanes.held];
  const waits = [
    ...openRows.map((r) => r.waitingSinceISO),
    ...program.late.map((r) => r.promiseISO),
  ].filter((x): x is string => !!x).map((x) => hoursBetween(Date.parse(x), nowMs));
  const counts: VideoDeliveryCounts = {
    open: openRows.length + program.late.length + program.dueToday.length,
    dueToday: owedRows.filter((r) => r.dueToday).length + program.late.length + program.dueToday.length,
    behind: lateRows.length + program.late.length,
    oldestHours: waits.length ? Math.max(...waits) : null,
    lateListing: lateRows.length,
    oldestLateHours: lateRows.length ? Math.max(...lateRows.map((r) => r.lateHours ?? 0)) : null,
    lateMonthly: program.late.length,
  };
  return { asOf: now.toISOString(), lanes, program, counts, mode: settings.aryeoPush, connected };
}

/** Counts for Kyle's Video tile (test clients excluded). A read that fails
 *  throws (Home greys the tile) rather than reporting "nothing late". */
export async function videoDeliveryCounts(now: Date = new Date()): Promise<VideoDeliveryCounts> {
  const b = await videoDeliveryBoard(Math.abs(now.getTime() - Date.now()) < 60_000 ? {} : { now });
  return { ...EMPTY_COUNTS, ...b.counts };
}
