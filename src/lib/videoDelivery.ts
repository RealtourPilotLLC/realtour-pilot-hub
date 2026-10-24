import "server-only";

import { prisma } from "@/lib/prisma";
import type { JobCounts } from "@/lib/opsCounts";
import { etDateTime, etDayKey, etAt } from "@/lib/datetime";
import type { VideoPushLine } from "@/lib/videoAryeoPush";
import type { ReadyBoard, ReadyVideo } from "@/lib/readyToSend";
import type { VideoPushMode } from "@/lib/videoDeliverySettings";

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM'S DELIVERY BOARD (Oct 19 2026; /review, which
// /ops/video-delivery now redirects to).
//
// Jordan: "how many videos are going out today or need to go out today or are
// due today, and how many we're behind on", then (Oct 19): Ready to send at
// the top with "Upload to Aryeo and send", Late with "Remind editor", Due
// today "due on the current day's date, but also the ones that are late", In
// revision, Coming up. One read builds the room's delivery sections and the
// numbers on Kyle's Home (videoDeliveryCounts, videoSummary), so a number never
// disagrees with the page it opens. Test clients are left out.
//
// LISTING VIDEOS, one row per video where the hub can tell them apart (each
// cut the Review Room knows; a video not cut yet is a row of its own), dated
// by THE video due (editorDue.videoDueOf, Oct 22 2026 audit H1: the promise
// the job was sold under, else the SLA off its video deliverable rows; the
// same date the editor's ping and brief carry), with a reopened job's clock
// or the office's date from Kyle's delivery board winning when there is one.
// Each row lives in ONE lane:
//   late       past its promise, not approved yet
//   today      due by the end of today (ET), not approved yet
//   review     a cut waiting for a verdict (not late, not due today)
//   upcoming   everything else still owed (not shot, editing, changes asked,
//              no date)
//   sending    approved and READY TO SEND: the file is ready (the 1080p pass
//              back, or not needed), nothing but a press (or a run a person
//              started) between it and the client. The client's open
//              requests do not move it out: the press shows them first.
//   held       approved but held: the 1080p file held by the sound check, a
//              run a person started that is held, a person's hold
//   finishing  approved, the 1080p pass still running (Oct 19: no longer in
//              "sending", which now means ready to send)
//   delivered  this week
// THE COUNTS, each video once per number (Oct 19 audit): lateListing = listing
// videos past their promise (any lane but delivered); dueToday = listing videos
// due by tonight, the late ones included (Jordan's rule); behind = lateListing;
// open = the listing videos ready to send or due today (late included);
// readyToSend = the sending lane. CONTENT-PROGRAM videos (monthly, the
// client's portal) are not on this board: they publish to the portal by
// themselves, and the Dashboard's program watch tracks them (Oct 20 2026,
// audit B6: the board's unread program section was removed). The one
// exception (Oct 21 2026): a branding video the office switched to Aryeo
// ("Upload to Aryeo instead") is a listing video from then on, so its
// approved version sits in Ready to send (or finishing / held) like any other;
// the program's other videos stay off the board.
// ---------------------------------------------------------------------------

export type VideoDeliveryCounts = JobCounts & {
  /** Listing videos past their promise, not delivered. */
  lateListing: number;
  /** Hours the most-late listing video is past its promise; null when none. */
  oldestLateHours: number | null;
  /** Listing videos approved and ready to send (the room's top section). */
  readyToSend?: number;
};

export type VideoLane = "late" | "today" | "review" | "upcoming" | "sending" | "held" | "finishing" | "delivered";
export const VIDEO_LANES: VideoLane[] = ["late", "today", "sending", "held", "finishing", "review", "upcoming", "delivered"];

/** What the Ready to send row needs beyond the lane (approved rows only). */
export type VideoSend = {
  approvedBy: string | null;
  /** "1080p" or the editor's own file (the 1080p pass was not needed or did not finish). */
  fileSource: "topaz-1080p" | "editor-hub-copy" | "editor-dropbox";
  fileName: string;
  fileSays: string;
  downloadHref: string;
  /** Plays the same file on the row ("Watch it"): the 1080p render when the pass finished. */
  watchHref: string;
  uploadFingerprint: string | null;
  /** A person (or the listing check) recorded this exact version on the listing. */
  uploaded: { by: string; at: string } | null;
  listingMissing: boolean;
  /** The listing already shows a video that could be this one (or the client says it is wrong): play it first. */
  listingWarning: string | null;
  /** The client's open requests that must be checked before it goes. */
  openAsks: { summary: string; askedBy: string | null }[];
  /** The requests could not be read just now (the press is refused until they can). */
  asksUnknown: boolean;
  /** Why the button is not offered (the hub cannot send this file itself); null when it is. */
  byHandWhy: string | null;
  /** The upload status could not be read just now: the row says reload, never "by hand" (audit B12). */
  pushUnknown: boolean;
};

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
  /** The cut's own state (null: no cut yet). */
  cutStatus: "PENDING" | "CHANGES_REQUESTED" | "APPROVED" | null;
  /** When the cut's state began (uploaded, sent back, approved). */
  sinceISO: string | null;
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
  /** Approved rows that are ready (sending, held): what the Ready to send row shows. */
  send: VideoSend | null;
  /** A 1080p file the sound check held (the held lane): the file to listen to and decide on. */
  heldRender: { jobId: string; fileName: string; dropboxUrl: string | null; lastCheck: string | null } | null;
  /** "Run Topaz again" (Oct 23 2026): a finished or held Topaz file not sent yet (readyToSend's offer). */
  rerun?: import("@/lib/topazRerun").RerunOffer | null;
  /** The finishing lane: where the Topaz pass is and when it was last run again (Oct 23 2026). */
  topaz?: import("@/lib/readyToSend").TopazProgress | null;
  /** "Approve and send" / "Run it again, then upload and send" (Oct 23 2026,
   *  lib/sendWhenReady): a send still to come (waiting), or one that did not
   *  go and why (not-sent, the last 14 days). Absent: nothing asked, or it started. */
  sendWhenReady?: SendWhenReadyLine | null;
};

/** What a row says about a "send when ready" (lib/sendWhenReady's intent, for the screen). */
export type SendWhenReadyLine = { state: "waiting" | "not-sent"; by: string; atISO: string; source: "approve" | "rerun"; note: string | null };

export type VideoDeliveryBoard = {
  asOf: string;
  lanes: Record<VideoLane, VideoRow[]>;
  counts: VideoDeliveryCounts;
  /** The stored switch (read only; button only since Oct 19, it starts nothing). */
  mode: VideoPushMode;
  /** The hub's Aryeo login is set up (Connections). */
  connected: boolean;
  unavailable?: boolean;
  /** Only on the room's read ({ followUps: true }). */
  followUps?: VideoFollowUps | null;
  /** Only on the room's read: each Ready to send / held job's open video requests (projectId → rows), for its "Before you send" box. */
  jobRequests?: Record<string, import("@/lib/clientAsks").JobRequestRow[]> | null;
};

/** The delivery follow-up lanes (readyToSend's), shown in the room under Ready to send since Home stopped showing the delivery card (Oct 19). */
export type VideoFollowUps = Pick<ReadyBoard, "needsFinishing" | "followUpChecks" | "followUpLastSuccess" | "noticeIncidentCheck" | "boardUnavailable"> & {
  notTold: NonNullable<ReadyBoard["notTold"]>;
  noticeIncidents: NonNullable<ReadyBoard["noticeIncidents"]>;
  portal: ReadyVideo[];
  /** Branding videos still in the 1080p pass, on their way to the portal, that
   *  can still be switched to Aryeo (Oct 21 2026). Information, never counted. */
  portalFinishing: import("@/lib/readyToSend").RenderingVideo[];
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

/** The video promise for a listing job: a reopened clock or the office's date
 *  (the delivery board's), else THE video due (editorDue.videoDueOf: the
 *  promise the job was sold under, else the SLA off its video deliverable
 *  rows). Never the order's product names (Oct 22 2026, audit H1: "Social
 *  Influencer", "Standard Package" and "Agent on Camera" carry no video word,
 *  so they were dated by the next-day Zillow tour or the photos and read late
 *  the day after the shoot). A job with no video row falls back to the
 *  office's date or its pin, never the earliest item. */
function videoPromise(
  job: { dueAt: Date | null; dueTierLabel: string | null; reopened: boolean } | undefined,
  project: { promisedDueAt: Date | null; shootDate: Date | null },
  due: { at: Date | null; source: string | null } | undefined,
  pinnedPromise: (p: { promisedDueAt?: Date | null; shootDate?: Date | null }) => Date | null,
): Date | null {
  if (job && (job.reopened || job.dueTierLabel === "office override")) return job.dueAt;
  if (due?.source) return due.at;
  return pinnedPromise(project);
}

const EMPTY_LANES = (): Record<VideoLane, VideoRow[]> => ({ late: [], today: [], review: [], upcoming: [], sending: [], held: [], finishing: [], delivered: [] });

// The read in flight, not only the finished one (Oct 20 2026, audit A3): the
// dashboard starts four or five readers of this board at once (its tiles, the
// checklist's two, the red line, the Shoots rows), and a memo that held only a
// finished value let each of them build its own on a cold start. A read that
// fails drops out of the memo, so the next caller tries again.
let memo: { at: number; value: Promise<VideoDeliveryBoard> } | null = null;

/** The whole board. `now` is for drills. Home's tile may reuse a read up to
 *  15 seconds old; the screen itself (`fresh`) always reads anew, so a press
 *  shows at once. */
export async function videoDeliveryBoard(opts: { now?: Date; fresh?: boolean; followUps?: boolean } = {}): Promise<VideoDeliveryBoard> {
  if (!opts.now && !opts.fresh && !opts.followUps && memo && Date.now() - memo.at < 15_000) return memo.value;
  const value = buildBoard(opts.now ?? new Date(), !!opts.followUps);
  if (!opts.now) {
    const entry = { at: Date.now(), value };
    memo = entry;
    // Its 15 seconds count from when the read finished, as before.
    value.then(() => { entry.at = Date.now(); }, () => { if (memo === entry) memo = null; });
  }
  return value;
}

async function buildBoard(now: Date, withFollowUps: boolean): Promise<VideoDeliveryBoard> {
  const todayKey = etDayKey(now);
  const endOfToday = etAt(todayKey, 23, 59);
  const { videoDeliverySettings } = await import("@/lib/videoDeliverySettings");
  // The test clients' ids, read once per render (queries.syntheticClientIds,
  // Oct 21 2026, audit A3/H): every board build used to read every client row.
  const excludeClientIds = await import("@/lib/queries").then((m) => m.syntheticClientIds());

  const [{ deliveryBoard }, { readyToSend }, { videoStatesFor }, turnaround, editorDue, settings, connected] = await Promise.all([
    import("@/lib/deliveryBoard"),
    import("@/lib/readyToSend"),
    import("@/lib/reviewCuts"),
    import("@/lib/turnaround"),
    import("@/lib/editorDue"),
    videoDeliverySettings(),
    import("@/lib/integrations/aryeoWeb").then((m) => m.aryeoWebCredentials()).then((c) => !!c).catch(() => false),
  ]);

  const { listingWarningOf } = await import("@/lib/readyToSend");
  const [board, ready, deliveredRecently] = await Promise.all([
    deliveryBoard({ excludeClientIds }),
    // The room's read (followUps) also records the follow-up lanes' health and reads the delivery-text outcomes, as Kyle's Home did.
    readyToSend({ excludeClientIds, recordFollowUpHealth: withFollowUps, includeNoticeIncidents: withFollowUps }),
    prisma.reviewSubmission.findMany({
      where: { status: "APPROVED", sentToClientAt: { gte: new Date(now.getTime() - 7 * DAY) }, project: { contentMonthId: null, ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}) } },
      select: { id: true, projectId: true, round: true, sentToClientAt: true, sentToClientBy: true, decidedAt: true },
    }),
  ]);
  if (board.unavailable) throw new Error("The delivery board could not be read.");
  const jobs = [...board.today, ...board.tomorrow, ...board.upcoming, ...board.delivered];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  // Listing videos, plus a branding video the office switched to Aryeo (its
  // destination says aryeo-listing; every other program video says portal).
  const onBoard = (v: { deliveryDestination?: "client-portal" | "aryeo-listing"; monthlyProgram?: boolean }) => v.deliveryDestination === "aryeo-listing" || (!v.deliveryDestination && !v.monthlyProgram);
  const readyRows = ready.ready.filter(onBoard);
  const renderingRows = ready.rendering.filter(onBoard);
  // The program jobs that are here only for those switched versions.
  const switchedJobIds = new Set([...readyRows, ...renderingRows].filter((v) => v.monthlyProgram).map((v) => v.projectId));

  const candidateIds = [...new Set([...jobs.map((j) => j.id), ...readyRows.map((v) => v.projectId), ...renderingRows.map((v) => v.projectId), ...deliveredRecently.map((d) => d.projectId)])];
  const projects = candidateIds.length
    ? await prisma.project.findMany({
        where: { id: { in: candidateIds }, OR: [{ contentMonthId: null }, { id: { in: [...switchedJobIds] } }], ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}) },
        select: { id: true, title: true, status: true, promisedDueAt: true, shootDate: true, aryeoListingId: true, aryeoOrderId: true, contentMonthId: true, client: { select: { name: true } } },
      })
    : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  // Listing jobs that owe a video (or have one ready or just delivered).
  const videoJobIds = projects.filter((p) => {
    const j = jobById.get(p.id);
    return (j && j.video !== "n/a") || readyRows.some((v) => v.projectId === p.id) || renderingRows.some((v) => v.projectId === p.id) || deliveredRecently.some((d) => d.projectId === p.id);
  }).map((p) => p.id);
  const states = await videoStatesFor(videoJobIds);
  // THE video due per job (audit H1): the same date the editor's ping and brief read.
  const dues = await editorDue.videoDuesFor(videoJobIds, { now });
  const { aryeoJobUrl } = await import("@/lib/aryeoUrl");
  // A VIDEO RELEASED FROM A SECOND SHOOT (Oct 22 2026, lib/secondShoot) runs
  // on its OWN clock, from the shoot its footage came from, never the job's
  // (which belongs to the videos shot the first time). A video still WAITING
  // is not owed at all (videoStatesFor leaves it out), so it is never late.
  const ownClock = new Map<string, Date>();
  const openSecondKeys = new Set<string>();
  const openSecondJobs = new Set<string>();
  if (videoJobIds.length) {
    const released = await prisma.deliverableOutput
      .findMany({
        where: { projectId: { in: videoJobIds }, promiseSource: "second-shoot", promisedAt: { not: null }, waivedAt: null, removedFromOrderAt: null },
        select: { projectId: true, deliverableId: true, slot: true, promisedAt: true, approvedAt: true, deliveredAt: true },
      })
      .catch(() => [] as { projectId: string; deliverableId: string; slot: number; promisedAt: Date | null; approvedAt: Date | null; deliveredAt: Date | null }[]);
    for (const o of released) {
      const k = `${o.deliverableId}:${o.slot}`;
      ownClock.set(k, o.promisedAt!);
      if (!o.approvedAt && !o.deliveredAt) {
        openSecondKeys.add(k);
        openSecondJobs.add(o.projectId);
      }
    }
  }

  // What stands between an approved video and the client: a run a person
  // started (its line), a held 1080p file, the client's open requests (shown
  // on the row and checked by the press, never a hold by themselves).
  const readyBySub = new Map(readyRows.map((v) => [v.submissionId, v]));
  const renderingBySub = new Map(renderingRows.map((v) => [v.submissionId, v]));
  const askProjects = [...new Set(readyRows.map((v) => v.projectId))];
  const asks = new Map<string, { list: { summary: string; askedBy: string | null }[]; unknown: boolean }>();
  await Promise.all(askProjects.map(async (pid) => {
    try {
      const { openAsksHolding } = await import("@/lib/clientAsks");
      const a = await openAsksHolding(pid, "video");
      asks.set(pid, { list: a.map((x) => ({ summary: x.summary, askedBy: x.askedBy })), unknown: false });
    } catch {
      asks.set(pid, { list: [], unknown: true });
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

  // A recorded 1080p reason is free text (a skip note, a service's error): money scrubbed, as on Kyle's Home.
  const { scrubMoney: scrubWhy } = await import("@/lib/text");
  /** Why the hub cannot send this ready file itself (the row shows the hand path instead of the button). */
  const byHandWhy = (r: ReadyVideo): string | null => {
    if (r.listingMissing) return "This job has no Aryeo listing linked yet. Open the job and press Refresh from Aryeo, then send it.";
    // The Settings rule's "already 1080p" original IS the checked file (Oct 22
    // 2026, audit C2): the button sends it from the Final folder exactly as it
    // sends a render (videoAryeoPush), so it keeps the button.
    if (r.file.source !== "topaz-1080p" && !r.originalIsFinal) return `This is the editor's own file (the Topaz pass did not produce one${r.file.why ? `: ${scrubWhy(r.file.why).replace(/[.\s]+$/, "")}` : ""}), so it goes up by hand.`;
    if (!connected) return "The hub's Aryeo login is not set up yet, so this one goes up by hand. Jordan adds it on Connections, Aryeo hub login.";
    // A failed read of the upload status is not "never checked" (audit B12).
    if (r.pushUnknown) return null;
    if (!r.push) return "The Topaz file was never checked, so the hub does not send it on its own. Upload it by hand.";
    return null;
  };

  const lanes = EMPTY_LANES();
  const nowMs = now.getTime();
  const push = (row: VideoRow) => lanes[row.lane].push(row);

  for (const pid of videoJobIds) {
    const p = projectById.get(pid);
    if (!p) continue;
    const job = jobById.get(pid);
    const st = states.get(pid);
    // The job's video due (audit H1: THE video due, editorDue.videoDueOf).
    const jobPromise = videoPromise(job, p, dues.get(pid), turnaround.pinnedPromise);
    // The clock a video runs on: its own when it came from a second shoot
    // (Oct 22 2026), else the job's.
    const clockOf = (slotKey: string | null | undefined) => {
      const at = (slotKey ? ownClock.get(slotKey) : undefined) ?? jobPromise;
      return { promise: at, late: !!at && at.getTime() < nowMs, dueToday: !!at && at.getTime() <= endOfToday.getTime() };
    };
    const base = {
      projectId: pid, street: streetOf(p.title), clientName: p.client?.name ?? "Client",
      promiseISO: jobPromise?.toISOString() ?? null, aryeoUrl: aryeoJobUrl(p),
    };
    // A delivered job that owes a video released from a second shoot is live
    // again for THAT video only (the others were delivered).
    const doneOnce = !!job?.settled || p.status === "DELIVERED";
    const reopenedForShoot = doneOnce && openSecondJobs.has(pid);
    const settledJob = doneOnce && !reopenedForShoot;
    // A program job is here only for its switched versions: nothing else of it
    // (its other videos, its uncut ones) belongs on this board.
    const programJob = !!p.contentMonthId;
    const cuts = (st?.cuts ?? []).filter((c) => !programJob || readyBySub.has(c.submissionId) || renderingBySub.has(c.submissionId));
    for (const c of cuts) {
      const { promise, late, dueToday } = clockOf(c.slotKey);
      const common = { ...base, promiseISO: promise?.toISOString() ?? null, key: c.submissionId, submissionId: c.submissionId, label: c.cutLabel, round: c.round, reviewHref: `/review/${pid}?cut=${c.submissionId}`, cutStatus: c.status, sinceISO: c.sinceISO, heldRender: null, send: null };
      if (c.status === "APPROVED") {
        const r = readyBySub.get(c.submissionId);
        const rend = renderingBySub.get(c.submissionId);
        const sent = deliveredBySub.get(c.submissionId);
        if (r || rend) {
          const pushLine = r?.push ?? null;
          const heldWhy = rend?.held ? `${rend.says}${rend.held.lastCheck ? ` ${rend.held.lastCheck}` : ""}`
            : pushLine && pushLine.tone === "held" ? pushLine.says
            : null;
          const approvedAt = r?.approvedAtISO ?? rend?.approvedAtISO ?? c.sinceISO;
          const a = asks.get(pid);
          const lane: VideoLane = heldWhy ? "held" : rend ? "finishing" : "sending";
          push({
            ...common, lane,
            stage: rend ? (rend.held ? "Topaz file held" : "In the Topaz pass") : pushLine?.progress === "on-listing" || r?.uploaded ? "On Aryeo, not sent yet" : pushLine?.progress === "uploading" ? "Uploading to Aryeo" : "Approved, ready to send",
            promiseWords: promiseWords(promise, now), late, dueToday, lateHours: late ? hoursBetween(promise!.getTime(), nowMs) : null,
            approvedAtISO: approvedAt, deliveredAtISO: null, deliveredBy: null, push: pushLine, heldWhy,
            waitingSinceISO: rend ? null : approvedAt,
            heldRender: rend?.held ? { jobId: rend.held.jobId, fileName: rend.held.fileName, dropboxUrl: rend.held.dropboxUrl, lastCheck: rend.held.lastCheck } : null,
            rerun: r?.rerun ?? rend?.rerun ?? null,
            topaz: rend && !rend.held ? rend.topaz ?? null : null,
            send: r ? {
              approvedBy: r.approvedBy, fileSource: r.file.source, fileName: r.file.fileName, fileSays: r.file.says.replace(/\s*[\u2014\u2013]\s*/g, ": "), downloadHref: r.file.downloadHref, watchHref: r.file.watchHref,
              uploadFingerprint: r.uploadFingerprint ?? null,
              uploaded: r.uploaded ? { by: r.uploaded.by, at: r.uploaded.at } : null,
              listingMissing: !!r.listingMissing,
              listingWarning: listingWarningOf(r),
              openAsks: a?.list ?? [], asksUnknown: a?.unknown ?? false,
              byHandWhy: byHandWhy(r),
              pushUnknown: !!r.pushUnknown,
            } : null,
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
      if (reopenedForShoot && !(c.slotKey && openSecondKeys.has(c.slotKey))) continue;
      const stage = c.status === "PENDING" ? `In review, version ${c.round}` : `Changes asked, version ${c.round}`;
      const lane: VideoLane = late ? "late" : dueToday ? "today" : c.status === "PENDING" ? "review" : "upcoming";
      push({
        ...common, lane, stage, promiseWords: promiseWords(promise, now), late, dueToday, lateHours: late ? hoursBetween(promise!.getTime(), nowMs) : null,
        approvedAtISO: null, deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, waitingSinceISO: late ? promise!.toISOString() : null,
      });
    }
    // Videos owed with no cut yet.
    if (!settledJob && st && !programJob) {
      // Uncut videos released from a second shoot carry their own clock; on a
      // job delivered once they are the only uncut videos it owes.
      const cutKeys = new Set(cuts.map((c) => c.slotKey).filter((k): k is string => !!k));
      const ownUncut = (st.slotKeys ?? []).filter((k) => ownClock.has(k) && !cutKeys.has(k) && (!reopenedForShoot || openSecondKeys.has(k)));
      const missing = reopenedForShoot ? ownUncut.length : Math.max(0, st.owed - cuts.length);
      const stage = ["BOOKED", "SCHEDULED"].includes(p.status) ? "Not shot yet"
        : st.stage === "editing" ? "Editing"
        : st.stage === "ready_to_edit" ? "Ready to edit"
        : "Not cut yet";
      for (let i = 0; i < missing; i++) {
        const { promise, late, dueToday } = clockOf(ownUncut[i]);
        const lane: VideoLane = late ? "late" : dueToday ? "today" : "upcoming";
        const at = ownUncut[i] ? (st.slotKeys ?? []).indexOf(ownUncut[i]) : -1;
        const number = at >= 0 ? at + 1 : cuts.length + i + 1;
        push({
          ...base, promiseISO: promise?.toISOString() ?? null, key: `${pid}:uncut:${i}`, submissionId: null, label: st.owed > 1 ? `Video ${number} of ${st.owed}` : "Listing video", round: null, cutStatus: null, sinceISO: null, heldRender: null, send: null,
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

  // "SEND WHEN READY" (Oct 23 2026): what was asked of the approved rows, one read.
  const approvedRows = [...lanes.sending, ...lanes.held, ...lanes.finishing].filter((r) => !!r.submissionId);
  if (approvedRows.length) {
    try {
      const { sendIntentsFor } = await import("@/lib/sendWhenReady");
      const intents = await sendIntentsFor(approvedRows.map((r) => r.submissionId!));
      for (const r of approvedRows) {
        const i = intents.get(r.submissionId!);
        if (!i) continue;
        const waiting = i.state === "waiting" || i.state === "starting";
        const recent = i.state === "not-sent" && !!i.doneAt && nowMs - Date.parse(i.doneAt) < 14 * DAY;
        if (waiting || recent) r.sendWhenReady = { state: waiting ? "waiting" : "not-sent", by: i.by, atISO: i.at, source: i.source, note: i.note };
      }
    } catch (e) {
      console.warn("[video-board] send-when-ready read failed", e);
    }
  }

  // ---- the counts (Kyle's Home reads these): each video once per number ----
  const owedRows = VIDEO_LANES.filter((l) => l !== "delivered").flatMap((l) => lanes[l]);
  const lateRows = owedRows.filter((r) => r.late);
  const dueRows = owedRows.filter((r) => r.dueToday); // the late ones are due by tonight too
  const openRows = new Map<string, VideoRow>();
  for (const r of [...lanes.sending, ...lanes.held, ...dueRows]) openRows.set(r.key, r);
  const waits = [...openRows.values()].map((r) => r.waitingSinceISO ?? (r.late ? r.promiseISO : null)).filter((x): x is string => !!x).map((x) => hoursBetween(Date.parse(x), nowMs));
  const counts: VideoDeliveryCounts = {
    open: openRows.size,
    dueToday: dueRows.length,
    behind: lateRows.length,
    oldestHours: waits.length ? Math.max(...waits) : null,
    lateListing: lateRows.length,
    oldestLateHours: lateRows.length ? Math.max(...lateRows.map((r) => r.lateHours ?? 0)) : null,
    readyToSend: lanes.sending.length,
  };
  // ---- the follow-ups (the room only): what the delivery card used to carry ----
  const { scrubMoney } = await import("@/lib/text");
  const followUps: VideoFollowUps | null = withFollowUps
    ? {
        needsFinishing: ready.needsFinishing,
        notTold: ready.notTold ?? [],
        noticeIncidents: ready.noticeIncidents ?? [],
        followUpChecks: ready.followUpChecks,
        followUpLastSuccess: ready.followUpLastSuccess,
        noticeIncidentCheck: ready.noticeIncidentCheck,
        boardUnavailable: ready.boardUnavailable,
        // Monthly / branding videos whose portal step needs a person (the delivery card's "Portal delivery needs attention").
        portal: ready.ready.filter((v) => v.deliveryDestination === "client-portal").map((v) => ({ ...v, file: { ...v.file, why: v.file.why ? scrubMoney(v.file.why) : null } })),
        // Branding videos still in the 1080p pass that can still go to Aryeo instead (Oct 21 2026).
        portalFinishing: ready.rendering.filter((v) => v.deliveryDestination === "client-portal" && v.canChooseAryeo && !!v.destinationFingerprint).map((v) => ({ ...v, says: scrubMoney(v.says) })),
      }
    : null;
  // The room's "Before you send" boxes (Oct 21 2026, audit B9): every Ready to
  // send and held job's open requests in one read, handed to each box, rather
  // than each box reading its own. Null when the read failed: each box then
  // reads its own, as before.
  const jobRequests = withFollowUps
    ? await import("@/lib/clientAsks")
        .then((m) => m.jobRequestsFor([...lanes.sending, ...lanes.held].map((r) => r.projectId), "video"))
        .then((m) => Object.fromEntries(m))
        .catch(() => null)
    : null;
  return { asOf: now.toISOString(), lanes, counts, mode: settings.aryeoPush, connected, followUps, jobRequests };
}

/** Home's summary box (Oct 19 2026): listing videos ready to send, late, and
 *  due today (the late ones included, Jordan's rule), each video once, the
 *  same numbers as the Video Review Room's headings. */
export async function videoSummary(now: Date = new Date()): Promise<{ readyToSend: number; late: number; dueToday: number }> {
  const b = await videoDeliveryBoard(Math.abs(now.getTime() - Date.now()) < 60_000 ? {} : { now });
  return { readyToSend: b.counts.readyToSend ?? b.lanes.sending.length, late: b.counts.lateListing, dueToday: b.counts.dueToday };
}

/** The Due today section: every listing video due by tonight, the late ones first (Jordan, Oct 19). */
export function dueTodayRows(b: VideoDeliveryBoard): VideoRow[] {
  const rows = VIDEO_LANES.filter((l) => l !== "delivered").flatMap((l) => b.lanes[l]).filter((r) => r.dueToday);
  return rows.sort((a, c) => Number(c.late) - Number(a.late) || (a.promiseISO ?? "9999").localeCompare(c.promiseISO ?? "9999"));
}
