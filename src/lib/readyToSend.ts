import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { videoStatesFor, cutKeyOf } from "@/lib/reviewCuts";
import { aryeoJobUrl, aryeoJobTitle } from "@/lib/aryeoUrl";
import { parseEvidence } from "@/lib/statusEvidence";
import { topazSettings } from "@/lib/settings";
import { cutReleasedAt } from "@/lib/contentVideos";
import type { TopazState } from "@/lib/topazJobs";

// ===========================================================================
// READY TO SEND — the videos that are finished and have not gone to the client.
//
// WHY THIS EXISTS. Sep 17 2026, 9:17am: 322 N 62nd St went out with no sound.
// The editor re-cut it, the corrected file was in hand by lunchtime, Kyle was
// told on Slack — and then nothing in the hub said whether the correction had
// actually been re-sent. The project still read DELIVERED off the 9:17 send,
// Aryeo still showed a video live on the listing, and every surface agreed the
// job was done. The one true statement — "this FILE has not gone out" — had
// nowhere to live. Jordan: "I need it to show a card with videos that are ready
// to send — ones that were approved and ready to download and send to the
// client."
//
// "READY TO SEND" IS NOT ONE QUERY. A finished video reaches Kyle three ways,
// and a card that only knew the first would quietly hide the other two:
//   (a) the 1080p pass finished — TopazJob state "done", the file is filed in
//       Dropbox, nobody has confirmed it went out;
//   (b) the 1080p pass was SKIPPED or FAILED, so the EDITOR'S OWN export is the
//       deliverable — 322 N 62nd St exactly: Topaz would not carry the file's
//       uncompressed audio, so the pass was abandoned and the editor's file is
//       what the client must get;
//   (c) there is no TopazJob at all — the lane is switched off, this deliverable
//       type was never added to it, or the cut was found in Dropbox rather than
//       uploaded (queueTopazRender refuses a cut the hub holds no bytes for).
//       The approved cut IS the deliverable and always was.
// The one thing all three share is the cut: an APPROVED ReviewSubmission with
// bytes behind it. So the cut is what this module selects on, and the TopazJob
// (when there is one) only decides WHICH FILE to hand over and why.
//
// AND A FOURTH STATE THAT IS NOT READY AT ALL. Approving a cut QUEUES its 1080p
// pass (approveCut → queueTopazRender), and that render takes half an hour on a
// good day — 893 S Matlack St: job created 22:15:56, file filed 22:45:49. For
// those thirty minutes the cut has bytes, has no finalPath and has no verdict
// from the lane, and an earlier draft of this module could not tell it apart
// from a SKIPPED one: it offered Kyle the editor's un-enhanced export with a
// Download button and a "Mark as sent" beside it, on every normal approval,
// against Jordan's own standing instruction that every video goes through
// Topaz. Worse, the press then stamped the still-queued job delivered, so when
// the render landed minutes later its card ("upload the 1080p to Aryeo") had
// already been closed by a person who had sent something else. A job the lane
// still owes work on is therefore NOT a ready row. It is reported separately,
// read-only, with no file and no button — visible, because a stuck render must
// not vanish from the one screen that tracks finished video, but never
// sendable.
//
// WHOSE WORD COUNTS THAT IT WENT OUT — the rule the whole card turns on:
//
//   · ReviewSubmission.sentToClientAt is the answer whenever it is set. A
//     person pressed the button for THIS cut. Nothing overrides it.
//   · Otherwise, IF THE CUT HAS A TopazJob, that row's deliveredAt is the ONLY
//     other arbiter. Not the project's status, not Aryeo. This is the whole
//     lesson of 322: at the moment of writing, that job's listing on Aryeo
//     carries a video, fulfilledOnAryeo is true and the project is DELIVERED —
//     and the file a client can actually play is the silent one. Once the hub
//     has handed a specific file to a person, only that person saying "sent"
//     closes it.
//   · Otherwise — case (c), where the hub never handed anything over and has no
//     record of its own — the outside world is all there is, and it gets ONE
//     narrow question: is there a video live on the listing that CANNOT be a
//     leftover from an earlier delivery? That means a non-stale Aryeo read
//     taken after this cut was approved, showing video, on a job that had not
//     already been delivered before the approval.
//
//     The project's own DELIVERED stamp is deliberately NOT evidence here, and
//     this is the second thing that would have hidden this morning's miss: the
//     status engine marks a job delivered when VIDEO is "present", and VIDEO
//     counts as present when the job's Dropbox Final folder holds a file —
//     the very folder the approval itself copies into. 2051 Old Sumneytown Pike
//     proves it in the live data: cut approved 02:00:26, project stamped
//     DELIVERED 02:01:27, and the evidence written at that same moment reads
//     aryeo.videos: 0. The stamp fired 61 seconds after the approval, off our
//     own copy, at a minute when Aryeo carried no video at all. A test that a
//     file went to the client cannot be satisfied by the hub filing that file.
//
//     And "a video is live on the listing" is only evidence on a job that was
//     NOT already delivered before this cut existed. On a re-cut — the 322
//     shape — the listing already carries the previous video, so its presence
//     says nothing about the correction. Those rows wait for the human press.
//
//   · One exception on the way in, not the way out: a content-program cut is
//     published to the client's own portal library the moment it is approved
//     (portalLibrary.addApprovedCutToLibrary, and portal.ts opens media for any
//     APPROVED cut), so the client can already watch and download it. There is
//     no Aryeo upload for Kyle to do and nothing for him to send. Those are not
//     ready rows.
//
// AND IT MUST BE SENDABLE. A cut with no bytes anywhere the hub can reach is
// not "ready to send" — it is an approval with nothing behind it, which belongs
// to Video Review, not here. Every row below carries a file, from a route that
// actually serves that file, and says which of the three it is and why.
//
// NEVER, EVER THE CLIENT. Nothing in this module or its action messages a
// client. Aryeo has no upload endpoint and no delivery endpoint (95 operations
// checked — see ARYEO_MANUAL_NOTE in lib/integrations/topaz.ts), and Zillow
// Showcase refuses a linked video, so the last step is Kyle uploading bytes by
// hand. The hub's whole job is to hand him the right file, the right listing,
// and a place to record that he did it.
// ===========================================================================

/** Which file the card is telling Kyle to send. */
export type ReadyFileSource =
  /** the finished 1080p render, filed in the job's Final Video folder */
  | "topaz-1080p"
  /** the editor's own export, still held in the hub's own store */
  | "editor-hub-copy"
  /** the editor's own export, read from Dropbox */
  | "editor-dropbox";

export type ReadyVideo = {
  submissionId: string;
  projectId: string;
  /** null for cases (b)/(c) — there is no 1080p job to stamp */
  topazJobId: string | null;
  /** "322 N 62nd St" — the same street the rest of the day uses */
  street: string;
  clientName: string;
  clientAvatarUrl: string | null;
  /** "Standard Cinematic Video" / "Personal Branding Reel — Video 1 of 16",
   *  resolved by the Review Room's own namer so one cut is called one thing */
  cutLabel: string;
  round: number;
  approvedAtISO: string;
  approvedBy: string | null;
  /** how long it has been sitting finished, in hours */
  waitingHours: number;
  /** the hub knows this job's video is past its promised date */
  overdue: boolean;
  file: {
    source: ReadyFileSource;
    fileName: string;
    /** the route that hands over the bytes. It mints its link at the moment of
     *  the press, so it is live on day thirty; null is never rendered as a
     *  button. */
    downloadHref: string;
    /** the Dropbox path ONLY when that is where the offered bytes are read
     *  from — and always the SAME path the download route will serve. A path we
     *  are not serving from is not printed: 322's Final Video folder is empty
     *  today, and a path on screen that is not there any more is worse than no
     *  path. */
    dropboxPath: string | null;
    /** what this file is, in one line Kyle can act on */
    says: string;
    /** the reason the 1080p pass did not produce it, recorded at the time and
     *  quoted — trimmed only of a trailing claim about what was delivered,
     *  never reworded (see trimReason) */
    why: string | null;
  };
  /** older exports of the SAME video still sitting approved on this job, by
   *  file name. The newest is the one offered above; these are named rather
   *  than dropped in silence. */
  alsoOnFile: string[];
  aryeoUrl: string | null;
  aryeoTitle: string;
  /** the Review Room page for this cut, for a last look before it goes */
  reviewHref: string;
};

/** An approved cut whose 1080p pass has not finished — shown, never offered. */
export type RenderingVideo = {
  submissionId: string;
  projectId: string;
  street: string;
  clientName: string;
  cutLabel: string;
  round: number;
  /** the lane's own word for where it is: queued / uploading / processing / … */
  state: string;
  approvedAtISO: string;
  waitingHours: number;
  says: string;
};

export type ReadyBoard = { ready: ReadyVideo[]; rendering: RenderingVideo[] };

const HOUR = 3_600_000;

/** The states the 1080p lane has finished with, whatever the outcome. Written
 *  as the TERMINAL list rather than the live one on purpose: a state this
 *  module has never heard of is treated as "the lane still owes work", so a new
 *  step added to topazJobs can only ever make a row wait, never make it offer
 *  the wrong file. The type tie means a renamed state fails the build here. */
const TERMINAL_TOPAZ: TopazState[] = ["done", "failed", "cancelled", "skipped"];
const stillRendering = (state: string): boolean => !TERMINAL_TOPAZ.includes(state as TopazState);

/** One definition of the columns this module reads, so the query and the
 *  helpers below can never drift apart. */
const CANDIDATE_SELECT = {
  id: true, projectId: true, round: true, fileName: true, deliverableId: true, slot: true,
  assetPath: true, blobUrl: true, finalPath: true,
  decidedAt: true, decidedBy: true, completedAt: true, createdAt: true,
  clientReleasedAt: true, clientRequestedAt: true,
  deliverable: { select: { type: true } },
  topazJob: {
    select: { id: true, state: true, finalPath: true, savedAt: true, deliveredAt: true, skipReason: true, error: true },
  },
  project: {
    select: {
      id: true, status: true, deliveredAt: true, statusEvidence: true, contentMonthId: true,
      aryeoListingId: true, aryeoOrderId: true,
    },
  },
} satisfies Prisma.ReviewSubmissionSelect;

type CandidateSub = Prisma.ReviewSubmissionGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/**
 * Every video finished and not yet sent, oldest first, anything the hub knows
 * is late first of all — plus the ones the 1080p lane is still working on, so
 * a render that stalls is on screen rather than nowhere.
 *
 * Two reads: the candidate cuts, then the Review Room's batched namer over just
 * those cuts' projects. videoStatesFor does double duty — it is also the rule
 * that a SUPERSEDED approval drops out, because it keeps only the latest round
 * of each cut. If the editor is already on a newer version (PENDING, or bounced
 * CHANGES_REQUESTED), the approved round is not in its answer and so is not in
 * ours: nobody should send a file that is being redone.
 */
export async function readyToSend(): Promise<ReadyBoard> {
  const subs = await prisma.reviewSubmission.findMany({
    where: {
      status: "APPROVED",
      // A person already said this exact cut went out.
      sentToClientAt: null,
      // Nothing is owed on a job that was cancelled or parked.
      project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } },
      // It must have bytes somewhere: the 1080p render, the hub's own copy of
      // the editor's upload, or a file in Dropbox.
      OR: [
        { blobUrl: { not: null } },
        { assetPath: { not: null } },
        { finalPath: { not: null } },
        { topazJob: { is: { finalPath: { not: null } } } },
      ],
      // A deliverable taken off the order is not owed to anybody. videoStatesFor
      // already drops it from the job's slots (which is why such a cut loses its
      // product name), but the cut row itself survives — and the hub has jobs
      // carrying discounted-away deliverables today.
      AND: [{ OR: [{ deliverableId: null }, { deliverable: { is: { removedFromOrderAt: null } } }] }],
    },
    select: CANDIDATE_SELECT,
  });
  if (subs.length === 0) return { ready: [], rendering: [] };

  // Still the live version of its cut, and not already with the client.
  const open = subs.filter((s) => !wentOut(s));
  if (open.length === 0) return { ready: [], rendering: [] };

  const states = await videoStatesFor([...new Set(open.map((s) => s.projectId))]);
  const byId = new Map(
    [...states.values()].flatMap((v) => v.cuts).map((c) => [c.submissionId, c] as const),
  );
  // The Review Room's own answer about which round is live, not a second
  // opinion: a newer PENDING / CHANGES_REQUESTED round means this approval is
  // being redone.
  const liveCuts = open.filter((s) => byId.get(s.id)?.status === "APPROVED");

  // Two approved exports of ONE video are one row. A cut with no deliverable is
  // keyed by its file PATH (reviewCuts.cutKeyOf), so the editor re-filing the
  // same reel under a new name makes a second, permanently approved "cut" —
  // 1956 Wetherhill Dr carries "Finish_…" and "Revised_…" of one video. Offering
  // both would put the older file in front of Kyle as if it were a second
  // deliverable.
  const { winners, others } = collapseReExports(liveCuts);

  // Only read the settings when a row actually needs them to explain itself —
  // case (c) is the only branch that asks WHY no pass ever ran.
  const needSettings = winners.some((s) => !s.topazJob);
  const s = needSettings ? await topazSettings().catch(() => null) : null;

  const now = Date.now();
  const ready: ReadyVideo[] = [];
  const rendering: RenderingVideo[] = [];
  for (const sub of winners) {
    const cut = byId.get(sub.id)!;
    const approvedAt = sub.decidedAt ?? sub.completedAt ?? sub.createdAt;
    const waitingHours = Math.max(0, Math.floor((now - approvedAt.getTime()) / HOUR));

    // The lane still owes work on this cut: report it, offer nothing.
    if (sub.topazJob && stillRendering(sub.topazJob.state)) {
      rendering.push({
        submissionId: sub.id,
        projectId: sub.projectId,
        street: cut.street,
        clientName: cut.clientName,
        cutLabel: cut.cutLabel,
        round: sub.round,
        state: sub.topazJob.state,
        approvedAtISO: approvedAt.toISOString(),
        waitingHours,
        says: renderingSays(sub.topazJob.state),
      });
      continue;
    }

    const file = fileFor(sub, s);
    if (!file) continue; // no bytes the hub can hand over

    const ev = parseEvidence(sub.project.statusEvidence);
    ready.push({
      submissionId: sub.id,
      projectId: sub.projectId,
      topazJobId: sub.topazJob?.id ?? null,
      street: cut.street,
      clientName: cut.clientName,
      clientAvatarUrl: cut.clientAvatarUrl,
      cutLabel: cut.cutLabel,
      round: sub.round,
      approvedAtISO: approvedAt.toISOString(),
      approvedBy: sub.decidedBy,
      waitingHours,
      overdue: ev?.videoOverdue ?? false,
      file,
      alsoOnFile: (others.get(sub.id) ?? []).map((o) => o.fileName ?? o.assetPath?.split("/").pop() ?? "another file"),
      aryeoUrl: aryeoJobUrl(sub.project),
      aryeoTitle: aryeoJobTitle(sub.project),
      reviewHref: `/review/${sub.projectId}?cut=${sub.id}`,
    });
  }

  // Late first, then oldest first — the order a person would work them in.
  ready.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.approvedAtISO.localeCompare(b.approvedAtISO));
  rendering.sort((a, b) => a.approvedAtISO.localeCompare(b.approvedAtISO));
  return { ready, rendering };
}

/** Where the 1080p pass has got to, in Kyle's words rather than the lane's. */
function renderingSays(state: string): string {
  if (state === "queued" || state === "estimated") return "The 1080p pass is queued — nothing to send yet.";
  if (state === "saving") return "The 1080p file is being filed into Dropbox — nearly there.";
  if (state === "uploading" || state === "processing") return "The 1080p pass is running — nothing to send yet.";
  // An unknown state is still the lane's, and still not ours to send.
  return "The 1080p pass hasn't finished — nothing to send yet.";
}

/**
 * Has this cut's file already reached the client? The precedence here is the
 * point of the whole module — see the header.
 */
function wentOut(sub: CandidateSub): boolean {
  // The hub handed a specific file to a specific person: only their press
  // closes it. Aryeo showing "a video" is not evidence about THIS file — on 322
  // the video Aryeo shows is the broken one. (A job the lane is still working
  // on has not been handed to anybody either; it is filtered out later, as a
  // rendering row rather than a sent one.)
  if (sub.topazJob) return !!sub.topazJob.deliveredAt;

  const approvedAt = (sub.decidedAt ?? sub.completedAt ?? sub.createdAt).getTime();

  // A content-program cut IS the client's the moment it is approved: the portal
  // library row is written on approval and the media gate opens for any
  // APPROVED cut. Kyle has nothing to upload and nothing to send. The question
  // "can the client see this cut" is answered by the portal's own helper, so
  // the two surfaces cannot drift.
  if (sub.project.contentMonthId && cutReleasedAt({ ...sub, status: "APPROVED" })) return true;

  // Case (c). The listing must be carrying a video that CANNOT be a leftover:
  // observed by Aryeo itself (not a carried-forward stale count), after this cut
  // was approved, on a job that had not already been delivered beforehand.
  const ev = parseEvidence(sub.project.statusEvidence);
  if (!ev?.aryeo || ev.aryeo.stale || (ev.aryeo.videos ?? 0) <= 0) return false;
  const seenAt = Date.parse(ev.aryeo.at ?? ev.checkedAt ?? "");
  if (Number.isNaN(seenAt) || seenAt < approvedAt) return false;
  // Delivered BEFORE this cut existed → the video on the listing is the old
  // one until a person says otherwise. This is the 322 shape exactly.
  if (sub.project.deliveredAt && sub.project.deliveredAt.getTime() < approvedAt) return false;
  return true;
}

/**
 * Collapse two approved exports of the same video into one row.
 *
 * Only ever groups cuts that carry NO deliverable: an uploaded cut is
 * (deliverable × slot) and the Review Room already keeps one round of it, so
 * two such rows are genuinely two deliverables. A folder-keyed row has no such
 * identity, so the FILE NAME is used — with the prefix editors put in front of
 * a re-export stripped, which is the only thing that differs between
 * "Finish_1956 Wetherhill Dr…_1_prob4.mp4" and "Revised_1956 Wetherhill
 * Dr…_1_prob4.mp4". A name too short to identify anything keeps its own row.
 *
 * The newest approval wins; the others are handed back so the card can name
 * them. Nothing is dropped in silence — that is the failure mode this whole
 * module exists to prevent.
 */
function collapseReExports(rows: CandidateSub[]): { winners: CandidateSub[]; others: Map<string, CandidateSub[]> } {
  const groups = new Map<string, CandidateSub[]>();
  for (const r of rows) {
    const key = r.deliverableId
      ? `${r.projectId}|${cutKeyOf(r)}`
      : `${r.projectId}|${fileIdentity(r.fileName ?? r.assetPath, r.id)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const winners: CandidateSub[] = [];
  const others = new Map<string, CandidateSub[]>();
  for (const g of groups.values()) {
    if (g.length === 1) { winners.push(g[0]); continue; }
    const at = (r: CandidateSub) => (r.decidedAt ?? r.completedAt ?? r.createdAt).getTime();
    const sorted = [...g].sort((a, b) => at(b) - at(a) || b.round - a.round || b.id.localeCompare(a.id));
    winners.push(sorted[0]);
    others.set(sorted[0].id, sorted.slice(1));
  }
  return { winners, others };
}

/** "Revised_V3_632 Greenridge Rd (Andrea Neff)_1_prob4.mp4" and
 *  "Finish_632 Greenridge Rd (Andrea Neff)_1_prob4.mp4" are one video. The
 *  prefixes are the editors' own workflow words; strip them, strip the
 *  extension and a trailing version marker, and compare what is left. */
const RE_EXPORT_PREFIX = /^(?:done|final|finish|finished|revised|revision|rev|new|fix|fixed|update|updated|v\d+)[\s_-]+/i;
function fileIdentity(name: string | null, fallback: string): string {
  let base = (name ?? "").split("/").pop()?.replace(/\.[a-z0-9]{2,4}$/i, "") ?? "";
  // Twice over: "Revised_V3_…" carries two of them.
  for (let i = 0; i < 3 && RE_EXPORT_PREFIX.test(base); i++) base = base.replace(RE_EXPORT_PREFIX, "");
  base = base
    .replace(/[\s_-]*\(?\s*v\s*\d+\s*\)?(?:[\s_-]*final)?\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return base.length >= 6 ? `file:${base}` : fallback;
}

// ---------------------------------------------------------------------------
// "MARK AS SENT" — the one write this module makes.
//
// It records a fact that already happened outside the hub (Kyle uploaded the
// file to Aryeo and delivered the listing). It sends nothing, to anyone, ever.
// ---------------------------------------------------------------------------

export type SentResult = { ok: boolean; message: string; already?: boolean };

/**
 * Record that THIS cut's file went to the client.
 *
 * IDEMPOTENT BY THE DATABASE, not by a read-then-write: the stamp goes on
 * through an updateMany whose WHERE still contains `sentToClientAt: null`, so
 * two presses (a double tap, two tabs, a retried transition) race in Postgres
 * and exactly one wins. The loser is told the truth — who marked it and when —
 * instead of quietly overwriting the first person's name.
 */
export async function markVideoSent(submissionId: string, by: string | null): Promise<SentResult> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { ...CANDIDATE_SELECT, status: true, sentToClientAt: true, sentToClientBy: true },
  });
  if (!sub) return { ok: false, message: "That cut no longer exists." };
  if (sub.status !== "APPROVED") return { ok: false, message: "Only an approved cut can be marked sent." };
  if (sub.sentToClientAt) return alreadySent(sub.sentToClientAt, sub.sentToClientBy);
  // The card never offers a button on a cut the 1080p lane is still working on,
  // but a server action is a public endpoint and a stale tab is a real thing.
  // Refusing here is what stops the stamp landing on a queued job minutes before
  // its render arrives — which would close Kyle's upload card for a file he has
  // never seen.
  if (sub.topazJob && stillRendering(sub.topazJob.state)) {
    return { ok: false, message: "The 1080p pass hasn't finished on this one yet — it isn't ready to send." };
  }

  const claimed = await prisma.reviewSubmission.updateMany({
    where: { id: submissionId, sentToClientAt: null },
    data: { sentToClientAt: new Date(), sentToClientBy: by },
  });
  if (claimed.count === 0) {
    // Somebody else won the race in the milliseconds since the read above.
    const now = await prisma.reviewSubmission.findUnique({
      where: { id: submissionId },
      select: { sentToClientAt: true, sentToClientBy: true },
    });
    return alreadySent(now?.sentToClientAt ?? new Date(), now?.sentToClientBy ?? null);
  }

  const j = sub.topazJob;
  if (j?.state === "done" && !j.deliveredAt) {
    // The 1080p path has had its own closer since Sep 16 — it stamps the job,
    // completes Kyle's card and writes the timeline line. Reuse it whole rather
    // than keeping a second copy of those three writes in step with it.
    const { markTopazDelivered } = await import("@/lib/topazJobs");
    await markTopazDelivered(j.id, by).catch(() => null);
    return { ok: true, message: "Marked sent." };
  }

  // Cases (b) and (c): the same three writes, in words that fit the file that
  // actually went out. markTopazDelivered's line says "1080p video uploaded"
  // and names job.finalPath — both untrue here, where the whole point is that
  // the 1080p file does not exist and the editor's export is the deliverable.
  if (j && !j.deliveredAt) {
    // Stamp the job anyway: its card on /connections and its "waiting on Kyle"
    // count must clear with the row it describes.
    await prisma.topazJob.updateMany({ where: { id: j.id, deliveredAt: null }, data: { deliveredAt: new Date(), deliveredBy: by } }).catch(() => {});
    const task = await prisma.topazJob.findUnique({ where: { id: j.id }, select: { taskId: true } }).catch(() => null);
    if (task?.taskId) {
      await prisma.smartTask
        .updateMany({ where: { id: task.taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } })
        .catch(() => {});
    }
  }
  const file = fileFor(sub, null);
  // The timeline says WHICH file went out, in the same words the card used —
  // a fixed "the editor's own export; no 1080p pass" was untrue for a cut whose
  // deliverable type simply never goes through the lane, and for one whose
  // finished 1080p file is exactly what was sent.
  await prisma.activity
    .create({
      data: {
        projectId: sub.projectId,
        type: "SYSTEM",
        body: `Video sent to the client${by ? ` by ${by}` : ""} — ${file?.fileName ?? sub.fileName ?? "video"}${file ? ` (${file.says.replace(/\.$/, "")})` : ""}.`,
      },
    })
    .catch(() => {});
  return { ok: true, message: "Marked sent." };
}

function alreadySent(at: Date, by: string | null): SentResult {
  const when = at.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { ok: true, already: true, message: `Already marked sent${by ? ` by ${by}` : ""} — ${when} ET.` };
}

/**
 * Which file to send, where it comes from and why — in that order of
 * preference, because a finished 1080p pass is always the better file when one
 * exists, and the hub's own store is more dependable than a Dropbox path (322's
 * Final Video folder is empty: the pass was undone and took both copies with
 * it, and the only surviving bytes are the ones the editor uploaded).
 *
 * The path this returns is always the path the download route will actually
 * serve — /api/review/cut/<id>/stream reads blobUrl, then assetPath, then
 * finalPath, and so does this. A button that 404s, or a path on screen that is
 * not the file behind the button, is the same class of lie this card exists to
 * stop.
 */
function fileFor(sub: CandidateSub, s: { enabled: boolean; deliverableTypes: string[] } | null): ReadyVideo["file"] | null {
  const j = sub.topazJob;
  const named = (path: string | null, fallback: string | null) => path?.split("/").pop() ?? fallback ?? "video.mp4";

  if (j?.finalPath && j.savedAt) {
    return {
      source: "topaz-1080p",
      fileName: named(j.finalPath, sub.fileName),
      downloadHref: `/api/topaz/download/${j.id}`,
      dropboxPath: j.finalPath,
      says: "The 1080p pass finished — this is the file to send.",
      why: null,
    };
  }

  // Everything below hands over the EDITOR'S OWN export. Say which of the three
  // reasons put us here, so nobody has to go looking for it.
  const type = sub.deliverable?.type ?? "VIDEO";
  const says =
    j?.state === "skipped"
      ? "The 1080p pass was skipped — send the editor's own export."
      : j?.state === "failed" || j?.state === "cancelled"
        ? "The 1080p pass didn't produce a file — send the editor's own export."
        : j
          ? "The 1080p file isn't filed yet — the editor's own export is what's in hand."
          : s && !s.enabled
            ? "The 1080p pass is switched off in Settings — the editor's export is the deliverable."
            : s && !s.deliverableTypes.includes(type)
              ? `${type} doesn't go through the 1080p pass — the editor's export is the deliverable.`
              : "No 1080p pass ran for this cut — the editor's export is the deliverable.";
  const why = trimReason(j?.skipReason ?? j?.error ?? null);

  if (sub.blobUrl) {
    return {
      source: "editor-hub-copy",
      fileName: sub.fileName ?? named(sub.finalPath, null),
      // ?dl=1 asks the stream route for an attachment instead of playback. That
      // route is already gated to the job's own people and proxies the bytes,
      // so the store's public URL never leaves the building.
      downloadHref: `/api/review/cut/${sub.id}/stream?dl=1`,
      // The hub serves the bytes, but the SAME file is usually also filed in the
      // job's Final Video folder — that copy is what the approval writes there,
      // and Dropbox is where Kyle actually works. Name it when the record has
      // one. (It can be stale: on 322 N 62nd St this pointer still named a file
      // that had been moved that morning, which is why the card treats a path
      // as a signpost and keeps the download on the route it controls.)
      dropboxPath: sub.finalPath ?? sub.assetPath ?? null,
      says,
      why,
    };
  }
  // Same order as the route: assetPath first, finalPath only when the upload
  // was pruned and the filed copy is all that is left.
  const path = sub.assetPath ?? sub.finalPath;
  if (path) {
    return {
      source: "editor-dropbox",
      fileName: named(path, sub.fileName),
      downloadHref: `/api/review/cut/${sub.id}/stream`,
      dropboxPath: path,
      says,
      why,
    };
  }
  return null;
}

/**
 * The recorded reason, minus any trailing sentence that makes a claim about
 * DELIVERY.
 *
 * 322 N 62nd St's skip note ends "The editor's own file was delivered instead"
 * — written when the pass was abandoned, and untrue by the afternoon. Printed
 * under an instruction to send the file, it reads as "already handled", which
 * is exactly how a corrected video sat in hand all morning. This card is the
 * authority on whether something went out, so a stored note does not get to
 * answer that question on it.
 *
 * It only ever REMOVES whole sentences from the end, and never rewrites a word
 * of what is left: the explanation of the fault is the part that matters and it
 * is quoted as written. The stored note itself is left alone — correcting
 * history is a person's call, not this function's.
 */
function trimReason(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.match(/[^.!?]+[.!?]*/g)?.map((p) => p.trim()).filter(Boolean) ?? [raw.trim()];
  const claimsDelivery = (p: string) => /\b(deliver|delivered|sent|re-?sent|went out|uploaded to aryeo)\b/i.test(p);
  let end = parts.length;
  while (end > 1 && claimsDelivery(parts[end - 1])) end--;
  const kept = parts.slice(0, end).join(" ").trim();
  return kept || raw.trim();
}
