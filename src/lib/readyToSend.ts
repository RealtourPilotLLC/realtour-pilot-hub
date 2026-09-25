import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { videoStatesFor, cutKeyOf } from "@/lib/reviewCuts";
import { aryeoJobUrl, aryeoJobTitle } from "@/lib/aryeoUrl";
import { parseEvidence, EVIDENCE_STALE_HOURS, type ParsedEvidence } from "@/lib/statusEvidence";
import { etDateTime } from "@/lib/datetime";
import { topazSettings } from "@/lib/settings";
import { cutReleasedAt } from "@/lib/contentVideos";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
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
//     record of its own — NOTHING here clears the row. Not the project's
//     DELIVERED stamp, not Aryeo's count of videos, not the fact that the
//     listing looks finished. The row waits for a person, or for the one
//     machine that is allowed to settle it: the proof pass in lib/aryeoDelivery,
//     which reads the listing, dates each individual video off its UUIDv7 id,
//     measures the cut's own file when a timestamp is not enough, and stamps
//     `sentToClientAt` only where exactly one video can be exactly one file.
//     That pass runs on Aryeo's delivery webhook and, since the webhook lane
//     went silent on Sep 7 and only Aryeo can switch it back on, hourly from
//     cron/sync as well.
//
//     WHY THIS MODULE STOPPED DECIDING IT (Sep 17, evening). It used to, from
//     `aryeo.videos` — a COUNT out of the cached evidence, cleared when the
//     listing had enough videos to go round. The card's first day out ran at
//     50% false positives and the count was behind both of them:
//       · It goes stale in silence. The hourly status sweep stops carrying a
//         job seven days after delivery, so 2051 Old Sumneytown Pike's evidence
//         froze at `videos: 0` on Sep 8 while the video went up on Sep 9 — and
//         a stale zero reads exactly like a confident one. Nine days on the
//         card, asking for a video that was already live.
//       · It cannot say WHICH video, so it also cleared rows it had no business
//         clearing: on 1956 Wetherhill Dr, 332 Ruth Ridge Dr and 439 Lake
//         George Cir the video it was counting had gone up BEFORE the file on
//         the card existed. A video that predates the file is not evidence
//         about the file. Those three were being hidden, not settled.
//     Proving it properly needs a live listing read and an HTTP range read of
//     the cut's own header — half a second each, per row. This function renders
//     on two home screens on every request, so it cannot buy that, and a
//     cheaper guess is what got us here. The hourly pass can, and it writes
//     down what it concluded. One decision, one place, and a record of it.
//
//     The project's own DELIVERED stamp is deliberately not evidence anywhere in
//     this, and it is worth keeping the reason: the status engine marks a job
//     delivered when VIDEO is "present", and VIDEO counts as present when the
//     job's Dropbox Final folder holds a file — the very folder the approval
//     itself copies into. 2051 proves it in the live data: cut approved
//     02:00:26, project stamped DELIVERED 02:01:27, and the evidence written at
//     that same moment reads aryeo.videos: 0. A test that a file went to the
//     client cannot be satisfied by the hub filing that file.
//
//     AND WHERE IT CANNOT PROVE ANYTHING, IT SAYS WHAT IT SAW. Every row carries
//     the listing's own answer in one line — "Aryeo already shows 1 video on
//     this listing — "Cinematic Video", 60s, uploaded Sep 17, 10:21 AM ET, after
//     this file was ready. If that's this one, mark it sent." That is the whole
//     design after this morning: the card does not guess, and it does not make
//     Kyle go and look somewhere else either. A row that is already done costs
//     one tap with the evidence beside it. A row cleared wrongly costs a client
//     their video.
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
    /** THE SAME PATH, AS A DOOR RATHER THAN A STRING (Jordan, Sep 21 2026: "I
     *  dont think we need to show the file path on dropbox, a link to the
     *  dropbox would be better"). A /home deep link into the team's own
     *  Dropbox — free to build, no API call, never null, and it discloses
     *  nothing because it opens behind Dropbox's own sign-in.
     *
     *  NOT a shared link. dropboxSharedLink() is the other helper and it is
     *  wrong here three times over: this app has NO sharing scope, so it
     *  returns null in this tenant (see the note at the top of
     *  /api/topaz/download/[id]); it is an HTTP round trip PER ROW on a card
     *  that renders on two home screens on every request; and a shared link is
     *  a public address for a client's unreleased video, which is the one
     *  thing this lane must never mint.
     *
     *  Null only when there is no path at all. The path itself stays on the
     *  row (as the link's title) because a link into a folder that has been
     *  reorganised lands somewhere unhelpful, and the string is what somebody
     *  searches with when it does — 322 N 62nd St's Final Video folder was
     *  emptied out from under its own pointer. */
    dropboxUrl: string | null;
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
  /** SOMEBODY HAS THE FILE (Jordan, Sep 21 2026).
   *
   *  Written when a person presses Download on this row, and it is the answer
   *  to the question the card could not answer on Sep 21: three approved
   *  videos — 5 Raymond Cir, 453 Cardigan Terrace, 5642 Limeport Rd — sat for
   *  up to three days each, and a row somebody was working on that minute
   *  looked exactly like a row nobody had touched. "Waiting 3 days" over a
   *  file that was pulled ten minutes ago is the card telling a person off for
   *  work they are in the middle of.
   *
   *  IT IS NOT EVIDENCE THE CLIENT HAS IT, and nothing in this module treats
   *  it as any. Downloading a file is a step on the way to Aryeo, not arrival:
   *  the row stays on the card, still says it has not gone, and still needs
   *  "Mark as sent" or the hourly Aryeo proof pass. The stamp is corroboration
   *  for that pass — "a person did take this file" — never a reason on its
   *  own. Marking a video sent when it was not is the exact failure this whole
   *  card exists to prevent. */
  downloadedAtISO: string | null;
  downloadedBy: string | null;
  /** hours since that press, measured HERE rather than in the card — the card
   *  is a client component now, and a `Date.now()` inside it would be read once
   *  on the server and again in the browser, which is how a row renders one way
   *  in the HTML and another way a heartbeat later. Same reason waitingHours is
   *  a number and not a date. */
  downloadedHoursAgo: number | null;
  /** WHAT ARYEO IS SHOWING ON THIS LISTING, ON THE ROW.
   *
   *  The card cannot prove that the video already up there is this file — see
   *  the header — so it stops pretending the question does not exist and puts
   *  the answer it does have in front of Kyle instead. A row that is already
   *  done becomes one tap with the evidence beside it, rather than a trip to
   *  Aryeo in another tab to find out.
   *
   *  Null only when the job has no Aryeo listing at all. */
  listing: {
    says: string;
    checkedAtISO: string | null;
    videos: number;
    /** a video up there could be this file — and nothing on this screen can
     *  tell whether it is, which is why the line ends in "play it" */
    couldBeThisCut: boolean;
    /** the client has reported a problem with this job since this file was
     *  ready. The row is not just unproven, it is actively disputed: this is
     *  322 N 62nd St, and it wants its own colour rather than the same warning
     *  as a row that is probably just already done. */
    contested: boolean;
  } | null;
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
  /**
   * O02: the pass FINISHED but its file could not be checked, so it is held for
   * a person — the only rendering row with something to press. The unchecked
   * file is named and linked (Dropbox's own preview, to listen to it); the
   * approved original is still the editor's file, untouched. Absent on every
   * other row.
   */
  held?: { jobId: string; fileName: string; dropboxUrl: string | null; heldAtISO: string | null; lastCheck: string | null } | null;
};

/** R5: a cut recorded as SENT whose own records did not finish. Survives a refresh. */
export type NeedsFinishing = { submissionId: string; street: string; sentAtISO: string; sentBy: string | null; why: string };

export type ReadyBoard = { ready: ReadyVideo[]; rendering: RenderingVideo[]; needsFinishing: NeedsFinishing[] };

const HOUR = 3_600_000;

/** "5642 Limeport Rd, Coopersburg, PA" -> "5642 Limeport Rd". */
const streetOf = (title: string | null | undefined): string => (title ?? "").split(",")[0].trim();

/** The states the 1080p lane has finished with, whatever the outcome. Written
 *  as the TERMINAL list rather than the live one on purpose: a state this
 *  module has never heard of is treated as "the lane still owes work", so a new
 *  step added to topazJobs can only ever make a row wait, never make it offer
 *  the wrong file. The type tie means a renamed state fails the build here. */
const TERMINAL_TOPAZ: TopazState[] = ["done", "failed", "cancelled", "skipped"];
const stillRendering = (state: string): boolean => !TERMINAL_TOPAZ.includes(state as TopazState);

/** The same question, for the one other place that has to answer it — the Aryeo
 *  delivery webhook, which decides whether a cut has been handed to anybody yet
 *  (lib/aryeoDelivery). Exported rather than copied: a second list of terminal
 *  states in another file is two definitions of "the lane has finished with
 *  this", held together by nothing but a comment, and the copy would not fail
 *  the build when a state is renamed. */
export function laneStillOwesWork(state: string): boolean {
  return stillRendering(state);
}

// ===========================================================================
// WHAT IS ACTUALLY ON THE LISTING — one matcher, two callers (Sep 17 2026).
//
// Everything in this section used to live in lib/aryeoDelivery, where it was
// written for the delivery webhook. It is here now because THIS card needs the
// same reasoning and must not grow a second version of it.
//
// The reason it moved rather than being copied is the morning of Sep 17. The
// card had a count — `aryeo.videos` out of the status engine's evidence — and a
// count cannot answer the question the card asks. "1 video on the listing"
// is the same number whether that video is the one we owe or the one we are
// replacing, and on 322 N 62nd St it was the one we were replacing. The webhook
// had already been taught the harder version of this: Aryeo's ids are UUIDv7,
// so every video carries the moment it was created, and a video that appeared
// before our file existed cannot be our file. Two definitions of that, in two
// files, held together by a comment, is how the strict one gets fixed and the
// loose one does not.
//
// The webhook still owns the WRITES (lib/aryeoDelivery stamps cuts and closes
// upload cards); this owns the shapes and the arithmetic they both reason with.
// ===========================================================================

/** One video on the listing, with the moment its id says it was created. */
export type ListingVideo = {
  id: string;
  at: Date;
  durationSec: number | null;
  /** what Aryeo calls it — "Cinematic video Revision". Only ever shown to a
   *  person; nothing decides anything on a title. */
  title: string | null;
};

/** No Aryeo id can pre-date Aryeo. A decode outside this is a coincidence, not
 *  a timestamp, and is thrown away. */
const ARYEO_EPOCH_MS = Date.parse("2015-01-01T00:00:00Z");
const DAY_MS = 86_400_000;

/** The creation time carried inside a UUIDv7 id, or null when the id is not one
 *  or the time it yields is not believable.
 *
 *  Verified against live data on Sep 16 2026: every listing id decodes to a few
 *  minutes before the hub imported that listing, and each listing's video ids
 *  decode to days after their own listing id. The decode is checked, not
 *  assumed — wrong length, a version nibble that is not 7, or a nonsense moment
 *  all mean "no evidence", and no evidence means nothing moves. */
export function aryeoIdTime(id: string | null | undefined): Date | null {
  if (!id) return null;
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) return null;
  if (hex[12] !== "7") return null; // version nibble — anything else carries no time
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < ARYEO_EPOCH_MS || ms > Date.now() + DAY_MS) return null;
  return new Date(ms);
}

/** Aryeo's `videos[]` — from a live listing read, or from the copy of it the
 *  status engine files in the evidence blob — reduced to what can be reasoned
 *  with. A video we cannot date is dropped: it proves nothing either way. */
export function videosOnListing(listing: { videos?: unknown[] } | null): ListingVideo[] {
  const raw = Array.isArray(listing?.videos) ? (listing.videos as Record<string, unknown>[]) : [];
  const out: ListingVideo[] = [];
  for (const v of raw) {
    const id = typeof v?.id === "string" ? v.id : null;
    const at = aryeoIdTime(id);
    if (!id || !at) continue;
    const d = typeof v.duration === "number" && Number.isFinite(v.duration) ? v.duration : null;
    out.push({ id, at, durationSec: d, title: typeof v.title === "string" ? v.title : null });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** A file that could have been uploaded: when it was ready, and how long it
 *  runs. The finished 1080p file is the same length as the source — the render
 *  is an upscale and frame interpolation is OFF in Jordan's preset — so the
 *  duration the hub probed off the source MP4 is the uploaded file's duration
 *  too. If that ever stops being true, lengths stop matching and rows simply
 *  wait for Kyle, which is the safe way round. */
export type UploadJob = {
  id: string;
  readyAt: Date;
  durationSec: number | null;
  /** A CLAIMANT THAT MAY NEVER BE PROVEN.
   *
   *  Some rows can be the video on the listing without being allowed to win it:
   *  a cut the card is not showing, an upload card the card-level pass has just
   *  declined to close. Leaving them OUT of the matcher would be the dangerous
   *  way round — their video would then look free and prove somebody else's
   *  cut. So they stay in, take part in the rivalry test, and never win it.
   *
   *  Default (undefined) is stampable; only code that knows a reason sets it
   *  false. */
  stampable?: boolean;
  /** THE CLIENT HAS TOLD US SOMETHING IS WRONG WITH THIS LISTING'S VIDEO SINCE
   *  THIS FILE WAS READY — so a video up there may be the thing they are
   *  complaining about, and cannot prove anything about the fix.
   *
   *  This is the fact that separates 322 N 62nd St from every other row on the
   *  card, and it took the review to find it. Everything else about the two is
   *  the same shape: on 2051 Old Sumneytown Pike a single video appeared 13
   *  hours after a file was ready, matching its length, on a job with a
   *  DELIVERED stamp — and it really is that file. On 322 a single video
   *  appeared 14 hours after a file was ready, matching its length, on a job
   *  with a DELIVERED stamp — and it is the silent one the client rejected at
   *  9:41 that morning. No timestamp, no length and no count can tell those two
   *  apart. The complaint can: it is the hub's own record that a video on this
   *  listing is wrong, dated, in the client's words (RevisionBrief).
   *
   *  A contested claimant still COMPETES — its video is not free for somebody
   *  else to win — it simply can never be proven. */
  contested?: boolean;
};

/** Aryeo reports whole seconds and our probe reports fractions, so a 49.683s
 *  file is a 50s video there. Two seconds covers the rounding without being
 *  wide enough to match a different edit. */
const DURATION_SLACK_SEC = 2;

export function couldBe(job: UploadJob, v: ListingVideo): boolean {
  // No skew allowance, deliberately. Kyle uploads minutes or hours after a file
  // is ready, never seconds before it exists — and any tolerance here only lets
  // an OLDER video count as proof.
  if (v.at.getTime() < job.readyAt.getTime()) return false;
  if (job.durationSec == null || v.durationSec == null) return true;
  return Math.abs(job.durationSec - v.durationSec) <= DURATION_SLACK_SEC;
}

/**
 * COULD BE, AND PROVES, ARE NOT THE SAME TEST (Sep 17, second review).
 *
 * `couldBe` is deliberately generous, because it is what decides whether a
 * claimant COMPETES for a video — and a claimant wrongly left out of the
 * competition makes a video look free, which is how somebody else's row gets
 * cleared. Generous there is safe.
 *
 * Generous is not safe on the way out, and the first cut of this used the same
 * function for both. Three ways that let a row clear itself on nothing:
 *
 *   · AN UNKNOWN LENGTH READ AS A MATCH. `couldBe` returns true when either
 *     side's duration is null, so "the lengths match" was vacuously true for
 *     exactly the cuts that have no length anywhere in the schema — every cut
 *     with no 1080p job. The whole test collapsed to "a video appeared after
 *     this file was ready".
 *   · THE LISTING WAS ALREADY CARRYING VIDEO. When something was up there
 *     before this file existed, this is a REPLACEMENT — and the next video to
 *     appear is as likely to be a re-upload of the wrong export as it is to be
 *     the fix. 308 W Upsal St is that shape today: a 66s original from Sep 14
 *     sits beside a 60s "Cinematic video Revision" from Sep 16.
 *   · THE CLIENT HAS SAID IT IS WRONG. See UploadJob.contested — the only fact
 *     the hub holds that separates 322 N 62nd St from a job where the video up
 *     there really is the one we owe.
 *
 * What is left is narrow on purpose. A row that waits costs a tap; a row
 * cleared wrongly costs a client their video, and nobody is told.
 */
function provenBy(job: UploadJob, v: ListingVideo, videos: ListingVideo[]): boolean {
  if (job.contested) return false;
  // Both lengths KNOWN and agreeing. Null is "we did not measure", never "fine".
  if (job.durationSec == null || v.durationSec == null) return false;
  if (!couldBe(job, v)) return false;
  // Anything at all up there before this file existed → not provable from the
  // listing by anybody. Asked of the LISTING, not of Project.deliveredAt, which
  // this module has always refused to treat as evidence (the status engine
  // stamps it when the hub files the approved file into Dropbox — 2051 Old
  // Sumneytown Pike went DELIVERED 61 seconds after its own approval).
  return !videos.some((o) => o.at.getTime() < job.readyAt.getTime());
}

/**
 * Which claimants this listing can actually account for.
 *
 * `delivered` are the ones already spoken for — a person pressed the button, or
 * their 1080p job is stamped delivered. They go FIRST and take a video each,
 * because each one already claims an upload; otherwise last week's upload gets
 * re-used as proof for this week's file.
 *
 * Returns id → the video that proves it. The caller wants the video as well as
 * the verdict: it is what lets a stamp, or a line on a card, say which file it
 * is talking about.
 */
export function cardsAryeoCanAccountFor(
  videos: ListingVideo[],
  open: UploadJob[],
  delivered: UploadJob[],
): Map<string, string> {
  const taken = new Set<string>();
  // THE NEWEST MATCHING VIDEO, NOT THE OLDEST (Sep 17, second review). `videos`
  // is sorted oldest-first, and taking the first match meant an already-sent cut
  // consumed the OLDEST video it could be and left the NEWEST free — which is
  // precisely the one most likely to match a still-open cut, because open cuts
  // have later readyAt times. The greedy choice was therefore the one that
  // proved the MOST open rows. Backwards for a matcher whose whole rule is that
  // a lingering row is cheap and a cleared row is not.
  const free = (j: UploadJob) => [...videos].reverse().find((v) => !taken.has(v.id) && couldBe(j, v)) ?? null;

  for (const j of [...delivered].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())) {
    const hit = free(j);
    if (hit) taken.add(hit.id);
  }

  const proven = new Map<string, string>();
  for (const j of [...open].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())) {
    const hit = free(j);
    if (!hit) continue;
    // A claimant that is not ours to prove still holds its video: it does NOT
    // consume it (something else may legitimately be it), and it does not win
    // it either. What it does is stay in the rivalry test below.
    if (j.stampable === false) continue;
    // Proof, not resemblance — see provenBy. Everything below this line is
    // about WHICH of several things it is; this is about whether it is anything.
    if (!provenBy(j, hit, videos)) continue;
    // Could another claimant still waiting also be this upload? Then we do not
    // know which one it was, and choosing either is a guess. Leave both.
    const rival = open.some((o) => o.id !== j.id && !proven.has(o.id) && couldBe(o, hit));
    if (rival) continue;
    // And the mirror of that, which was missing: could ANOTHER free video
    // equally be this cut? Then "the video on the listing is this file" names
    // two different files, and stamping picks one by sort order. Two videos of
    // the same length on one listing is exactly what a re-upload looks like.
    const twoWays = videos.some((v) => v.id !== hit.id && !taken.has(v.id) && couldBe(j, v));
    if (twoWays) continue;
    taken.add(hit.id);
    proven.set(j.id, hit.id);
  }
  return proven;
}

// ---------------------------------------------------------------------------
// "THE CLIENT SAYS THE VIDEO UP THERE IS WRONG" — one query, both callers.
//
// RevisionBrief is the hub's durable record of a client asking for a change: it
// keeps the client's own words, its source (openphone / gmail / review room)
// and the moment it arrived, and — unlike Project.revisionRequestedAt — it is
// NOT cleared when the revision is resolved. That matters here, because 322 N
// 62nd St's revision was marked resolved at 10:23 on the morning its fix was
// still sitting unsent: the live flag was gone within the hour, the record was
// not.
// ---------------------------------------------------------------------------

export type ChangeRequestEvidence = {
  /**
   * FALSE when the read failed. The distinction A02 exists for: "this client
   * has not complained" and "we could not find out whether this client has
   * complained" are different facts, and only the first one may let a delivery
   * stamp itself.
   */
  known: boolean;
  /** Per project, oldest first. Empty when `known` is false. */
  byProject: Map<string, { at: Date; words: string }[]>;
  /** Every ask across the projects asked about, oldest first. */
  all: { at: Date; words: string }[];
  /** Why the evidence is unavailable, for the operational line on the card. */
  error: string | null;
};

/**
 * What the client has asked to be changed on these jobs, newest last. Returned
 * whole rather than as a boolean so the caller can compare each ask against the
 * moment its own file was ready, and so the card can put the date on screen.
 *
 * A02 (Sep 21 audit, fixed Sep 22 2026). This used to `.catch(() => [])`, and
 * the comment above it said "no answer means no complaint, which only ever
 * makes the matcher stricter." That was exactly backwards. Callers turn an
 * empty map into `contested: false`, and the automatic delivery matcher REFUSES
 * a contested item — so a failed read removed a guard and made the decision more
 * permissive, not less. The audit reproduced it: injecting a query failure made
 * a contested cut eligible for an automatic match.
 *
 * It still never throws. It reports.
 */
export async function clientChangeRequestsFor(projectIds: string[]): Promise<ChangeRequestEvidence> {
  const byProject = new Map<string, { at: Date; words: string }[]>();
  if (projectIds.length === 0) return { known: true, byProject, all: [], error: null };
  let rows: { projectId: string; createdAt: Date; headline: string | null; originalText: string | null }[];
  try {
    rows = await prisma.revisionBrief.findMany({
      where: { projectId: { in: [...new Set(projectIds)] } },
      select: { projectId: true, createdAt: true, headline: true, originalText: true },
      orderBy: { createdAt: "asc" },
    });
  } catch (e) {
    return { known: false, byProject, all: [], error: e instanceof Error ? e.message.slice(0, 200) : "the revision history could not be read" };
  }
  const all: { at: Date; words: string }[] = [];
  for (const r of rows) {
    const ask = { at: r.createdAt, words: (r.headline ?? r.originalText ?? "").slice(0, 160) };
    byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), ask]);
    all.push(ask);
  }
  all.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { known: true, byProject, all, error: null };
}

/** The latest ask that landed at or after this file was ready — the one that
 *  makes a video on the listing unattributable. Deliberately NOT filtered to
 *  asks that mention video: the hub's own classification of what a client meant
 *  is a guess, and guessing wide here only ever holds a row for a tap. */
export function contestedSince(
  asks: { at: Date; words: string }[] | undefined,
  readyAt: Date,
): { at: Date; words: string } | null {
  const after = (asks ?? []).filter((a) => a.at.getTime() >= readyAt.getTime());
  return after.length > 0 ? after[after.length - 1] : null;
}

// ---------------------------------------------------------------------------
// THE LISTING, AS THE HUB LAST SAW IT.
//
// The card may not read Aryeo. It renders on Jordan's home screen and on
// Kyle's, both of which are `force-dynamic`, so a live listing read per row
// would be paid on every single page view by everyone all day. The status
// engine already reads these listings and files what it saw; this is that
// filing, read back.
//
// Which makes HOW OLD IT IS part of the fact. "We looked and there was no
// video" and "nobody has looked since last Tuesday" are different statements,
// and it was the second one wearing the first one's clothes — a `videos: 0`
// frozen on Sep 8 — that kept 2051 Old Sumneytown Pike on the card for nine
// days. Past EVIDENCE_STALE_HOURS the counts are history, not a current fact,
// and nothing is allowed to turn on them.
// ---------------------------------------------------------------------------

type ListingFacts = {
  /** when the read that produced these happened */
  at: Date | null;
  /** how many videos Aryeo showed */
  count: number;
  /** the videos themselves, when the blob is new enough to carry them */
  videos: ListingVideo[];
  /** the blob carried a video LIST, not just a count — the difference between
   *  "one video" and "this video, uploaded at 10:21" */
  detailed: boolean;
  /** the read is recent enough to mean anything */
  fresh: boolean;
};

/** The Aryeo block written by THIS CARD's own hourly re-read
 *  (projectStatus.refreshListingEvidence), which is filed under its own key.
 *
 *  WHY IT IS NOT MERGED INTO `aryeo`, which is where it obviously belongs. That
 *  block is read by decisions this card has no business moving. Two of them
 *  gate a text to a CLIENT: the monthly-content batch hold (lib/tasks — hold
 *  the delivery text until the month's videos are live) and "positive proof a
 *  video shipped" (lib/clientTextSweeps). Both are satisfied by a video COUNT,
 *  and both were previously only ever moved by the status engine's own hourly
 *  pass. A re-read that exists to put a sentence on a card must not be able to
 *  release a message to a client as a side effect — the card's refresh reaches
 *  jobs the status sweep has deliberately stopped carrying, including content
 *  months. So it writes here, this function reads it, and nothing else in the
 *  hub can see it.
 *
 *  Absent on every job the refresh has not reached, which is all of them until
 *  the first hourly pass after deploy. */
function cardRefreshBlockOf(raw: string | null): ParsedEvidence["aryeo"] {
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as { listing?: ParsedEvidence["aryeo"] };
    return blob?.listing ?? null;
  } catch {
    return null;
  }
}

/** Whichever of the two blocks was read most recently. A block with no time on
 *  it at all falls back to the pass's own `checkedAt`, and loses to one that
 *  can say when it looked. */
function newerOf(
  engine: ParsedEvidence["aryeo"],
  card: ParsedEvidence["aryeo"],
  checkedAt: string | undefined,
): ParsedEvidence["aryeo"] {
  if (!card) return engine;
  if (!engine) return card;
  const t = (b: NonNullable<ParsedEvidence["aryeo"]>) => Date.parse(b.at ?? checkedAt ?? "") || 0;
  return t(card) >= t(engine) ? card : engine;
}

/** The Aryeo half of a job's evidence, read defensively.
 *
 *  `videoList` is written by lib/projectStatus and is deliberately NOT in
 *  statusEvidence's ParsedEvidence type — that parser is the client-safe
 *  whitelist for the fields the cards render, and it passes anything else
 *  through untouched. So it is read here, validated here, and a blob that
 *  predates the field simply reports `detailed: false`. */
function listingFactsOf(ev: ParsedEvidence | null, raw: string | null): ListingFacts | null {
  const a = newerOf(ev?.aryeo ?? null, cardRefreshBlockOf(raw), ev?.checkedAt);
  if (!a) return null;
  const extra = a as { at?: unknown; videoList?: unknown };
  const atRaw = typeof extra.at === "string" ? extra.at : ev?.checkedAt;
  const ms = Date.parse(atRaw ?? "");
  const at = Number.isFinite(ms) ? new Date(ms) : null;
  // A carried-forward count is last week's news wearing today's date.
  const fresh = !a.stale && at != null && Date.now() - at.getTime() < EVIDENCE_STALE_HOURS * HOUR;
  const list = Array.isArray(extra.videoList) ? (extra.videoList as unknown[]) : null;
  return {
    at,
    count: a.videos ?? 0,
    videos: list ? videosOnListing({ videos: list }) : [],
    detailed: list != null,
    fresh,
  };
}

/** One definition of the columns this module reads, so the query and the
 *  helpers below can never drift apart. */
const CANDIDATE_SELECT = {
  id: true, projectId: true, round: true, fileName: true, deliverableId: true, slot: true,
  assetPath: true, blobUrl: true, finalPath: true,
  decidedAt: true, decidedBy: true, completedAt: true, createdAt: true,
  downloadedAt: true, downloadedBy: true,
  clientReleasedAt: true, clientRequestedAt: true,
  deliverable: { select: { type: true } },
  topazJob: {
    // sourceDurationSec: how long the file runs, probed off its own header when
    // the 1080p pass was set up. It is the only length the hub holds for a cut,
    // and it is what tells a 60s correction from the 66s video beside it on the
    // listing (308 W Upsal St).
    // heldPath/heldAt/outputCheckJson: only a HELD row reads them (O02), to name
    // the unchecked file and say what the last look at it found.
    select: { id: true, state: true, finalPath: true, savedAt: true, deliveredAt: true, skipReason: true, error: true, sourceDurationSec: true, heldPath: true, heldAt: true, outputCheckJson: true },
  },
  project: {
    select: {
      id: true, status: true, deliveredAt: true, statusEvidence: true, contentMonthId: true,
      aryeoListingId: true, aryeoOrderId: true,
      // WHOSE portal we would be claiming the video is on (R09, Sep 18).
      clientId: true,
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
 *
 * `projectId` narrows the whole board to one job without changing a single rule
 * about what belongs on it. It is there for the Aryeo delivery webhook, which
 * has to ask "which of THIS job's cuts is the card still asking for?" and must
 * get that answer from this module rather than re-deriving the eligibility
 * rules beside it — see cutsOnTheCardFor.
 */
export async function readyToSend(opts?: { projectId?: string }): Promise<ReadyBoard> {
  const subs = await prisma.reviewSubmission.findMany({
    where: {
      ...(opts?.projectId ? { projectId: opts.projectId } : {}),
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
  if (subs.length === 0) return { ready: [], rendering: [], needsFinishing: await deliveriesNeedingFinishing({ projectId: opts?.projectId }).catch(() => []) };

  // Still the live version of its cut, and not already with the client.
  // WHO CAN ACTUALLY OPEN THE PORTAL. One query for the whole board, because
  // "released to the portal" only closes a row for a client who has a way in —
  // see wentOut. A membership is the concrete test: it is what a sign-in
  // resolves to, and it is what will start existing when the portal launches.
  //
  // Since the release gate (CP-01, Sep 24 2026) a released cut is only the
  // client's once someone who CAN APPROVE it is able to: a live OWNER seat on
  // an ACTIVE program whose access is not revoked. A revoked seat, a
  // collaborator- or viewer-only account, or a paused/ended program can watch
  // at most — the cut would sit at "awaiting approval" for good while leaving
  // this card, the only place Kyle can Mark it sent.
  const activeEnrollmentIds = (await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", accessRevokedAt: null }, select: { id: true } }).catch(() => [])).map((e) => e.id);
  const portalClientIds = new Set(
    activeEnrollmentIds.length
      ? (await prisma.clientMembership.findMany({ where: { role: "OWNER", revokedAt: null, enrollmentId: { in: activeEnrollmentIds } }, select: { clientId: true } }).catch(() => [])).map((m) => m.clientId)
      : [],
  );
  const open = subs.filter((s) => !wentOut(s, portalClientIds));
  if (open.length === 0) return { ready: [], rendering: [], needsFinishing: await deliveriesNeedingFinishing({ projectId: opts?.projectId }).catch(() => []) };

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

  // One query for the whole board: what each of these clients has asked to be
  // changed, and when. A row whose client complained AFTER its file was ready
  // is a row where a video on the listing may be the complaint rather than the
  // fix, and the line says so instead of inviting a press (see listingLine).
  const asks = await clientChangeRequestsFor(winners.map((w) => w.projectId));

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
        held: sub.topazJob.state === "held" ? heldLine(sub.topazJob) : null,
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
      downloadedAtISO: sub.downloadedAt?.toISOString() ?? null,
      downloadedBy: sub.downloadedBy,
      downloadedHoursAgo: sub.downloadedAt ? Math.max(0, Math.floor((now - sub.downloadedAt.getTime()) / HOUR)) : null,
      listing: sub.project.aryeoListingId
        ? listingLine(
            sub,
            listingFactsOf(ev, sub.project.statusEvidence),
            asks.known ? contestedSince(asks.byProject.get(sub.projectId), claimantOf(sub).readyAt) : null,
            asks.known ? null : asks.error,
          )
        : null,
    });
  }

  // Late first, then oldest first — the order a person would work them in.
  ready.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.approvedAtISO.localeCompare(b.approvedAtISO));
  rendering.sort((a, b) => a.approvedAtISO.localeCompare(b.approvedAtISO));
  // R5: rows already recorded as sent whose own records did not finish. Derived
  // on every read, so a refresh keeps showing it until it is genuinely fixed.
  const needsFinishing = await deliveriesNeedingFinishing({ projectId: opts?.projectId }).catch(() => []);
  return { ready, rendering, needsFinishing };
}

/**
 * WHICH OF THIS JOB'S CUTS THE CARD IS CURRENTLY ASKING FOR — by submission id.
 *
 * The Aryeo delivery webhook may only ever stamp a row the card is actually
 * showing, and this is how it knows which those are. It is the board's own
 * answer, not a second opinion: the bytes requirement, cancelled and parked
 * jobs, a deliverable taken off the order, a content-program cut that is
 * already in the client's portal, a round the editor is redoing, a still-running
 * 1080p pass and the two-exports-of-one-video collapse are all decided by the
 * code above, once.
 *
 * (An earlier cut of the webhook re-implemented four of those rules beside it
 * and got all four slightly different, which is how it could have written
 * "Video sent to the client" on a row that was never on the card at all.)
 */
export async function cutsOnTheCardFor(projectId: string): Promise<Set<string>> {
  const board = await readyToSend({ projectId });
  return new Set(board.ready.map((r) => r.submissionId));
}

/** The claimant this cut is, in the matcher's terms: the earliest moment its
 *  file could have been uploaded, and how long it runs when anything knows.
 *
 *  `readyAt` is the moment the 1080p file was FILED when there is one — the
 *  same floor lib/aryeoDelivery uses, so the two reach the same answer about
 *  the same upload — and otherwise the approval, because the card that tells
 *  Kyle to send it does not exist before then. */
function claimantOf(sub: CandidateSub): UploadJob {
  const approvedAt = sub.decidedAt ?? sub.completedAt ?? sub.createdAt;
  const j = sub.topazJob;
  return {
    id: sub.id,
    readyAt: j?.savedAt ?? approvedAt,
    durationSec: j?.sourceDurationSec ?? null,
  };
}

/**
 * THE ONE LINE THAT PUTS ARYEO'S OWN ANSWER ON THE ROW.
 *
 * Every row here is a row the hub could NOT clear by itself, and after this
 * morning that is the right default — but "I can't prove it" is not the same
 * as "I know nothing", and the difference was being thrown away. Aryeo's own
 * answer about the listing was sitting in the evidence blob the whole time.
 *
 * So the row now says what is up there and when it went up, and Kyle decides in
 * a second instead of opening Aryeo in another tab. Five shapes, and they are
 * genuinely different facts:
 *
 *   · nobody has checked lately          → say so, and say since when. Never
 *                                          "no video": a stale zero reading as
 *                                          a confident zero is the bug that
 *                                          started all this.
 *   · nothing is up there                → the row is unambiguously owed. This
 *                                          is 893 S Matlack St today.
 *   · something is up there, but it went  → real support FOR the row: the video
 *     up before this file existed          on the listing is the old one.
 *   · something is up there that COULD    → name it, date it, and say what
 *     be this file                         actually settles it.
 *   · …and the client has complained      → the strongest reason not to guess:
 *     about this listing's video since     what is up there may be the very
 *     this file was ready                  thing they are complaining about.
 *
 * WHAT IT DOES NOT DO ANY MORE, and this is the Sep 17 second review. It used
 * to finish the fourth shape with "If that's this one, mark it sent." — on
 * every row where a video merely COULD be the file, decided on time and length
 * alone. That is a looser rule than the one the proof pass uses on the same
 * data, and on the one row in the hub that must never be cleared it rendered
 * word for word the same invitation as on a row that really was already sent:
 * 322 N 62nd St's listing carries a 60-second video, uploaded after the file
 * was ready, which is the SILENT one the client rejected that morning. The card
 * was asking Kyle to confirm the thing the machine beside it was refusing to
 * conclude, and "Mark as sent" then asks him to confirm that the file is on
 * Aryeo and the listing is delivered — both of which are true on 322.
 *
 * So the line states what is there and names the only thing that settles it:
 * somebody has to play the video. It never says "this has been sent", and it
 * never asks for a press on evidence that would not satisfy the machine.
 */
function listingLine(
  sub: CandidateSub,
  facts: ListingFacts | null,
  /** the client's latest complaint about this job since this file was ready */
  contested: { at: Date; words: string } | null,
  /**
   * A02: set when the revision history could not be READ. Distinct from
   * `contested: null`, which means it was read and there is nothing. The card
   * must not imply the client is happy when we did not manage to ask.
   */
  evidenceUnavailable: string | null = null,
): ReadyVideo["listing"] {
  const when = facts?.at ? ` (checked ${etDateTime(facts.at)} ET)` : "";
  // THE COLOUR FOLLOWS THE SENTENCE. `contested` is what turns this line red on
  // the card, so it is only ever true on the two branches that actually SAY the
  // client has complained. A red line on a row whose words are "the hub hasn't
  // checked this listing" is a row nobody can act on — and it happens: 1956
  // Wetherhill Dr's ask is about two closet PHOTOS, which is a good reason for
  // the matcher to keep its hands off the row (holding wide costs a tap) and no
  // reason at all to shout at Kyle about a video.
  const base = { checkedAtISO: facts?.at?.toISOString() ?? null, videos: facts?.count ?? 0, contested: false };
  // An unreadable history colours the line too: "we could not check" is a
  // reason to look, and the sentence above says which of the two it is.
  const disputed = { ...base, contested: Boolean(contested) || Boolean(evidenceUnavailable) };
  // What to do about a video that might be this file. Never "mark it sent": the
  // hub cannot tell a re-cut from the thing it replaces, and neither can a
  // sentence. Playing it is what settles it, and the row's own Aryeo button is
  // one click away.
  const settleIt = contested
    ? ` The client reported a problem with this job on ${etDateTime(contested.at)} ET — after this file was ready — so what’s up there may be the one they’re complaining about. Play it before marking this sent.`
    : evidenceUnavailable
      ? ` The hub could not check this client’s revision history just now, so it cannot tell you whether they have asked for a change since. Play it before marking this sent.`
      : ` Nothing here can tell that apart from the file it replaces — play it before marking this sent.`;

  if (!facts || !facts.at || !facts.fresh) {
    const since = facts?.at ? `since ${etDateTime(facts.at)} ET` : "yet";
    // "Hasn't checked", not "hasn't been able to read": nothing failed. The
    // status sweep stops carrying a job seven days after delivery, which is a
    // choice, and the hourly listing pass picks it up again. Saying it the
    // other way sent the reader looking for a broken integration — on five of
    // the ten rows live the day this shipped.
    return { ...base, couldBeThisCut: false, says: `The hub hasn’t checked this listing ${since}, so it can’t say what Aryeo is showing. It re-checks every hour.` };
  }
  if (facts.count === 0) {
    return { ...base, couldBeThisCut: false, says: `Aryeo shows no video on this listing${when} — nothing has gone up yet.` };
  }

  const n = `${facts.count} video${facts.count > 1 ? "s" : ""}`;
  // A count with no ids behind it (a blob written before Sep 17, which is every
  // job until the hourly pass has been round once) can say how many, and must
  // not pretend to say which.
  if (!facts.detailed) {
    return { ...disputed, couldBeThisCut: true, says: `Aryeo already shows ${n} on this listing${when}. The hub can’t say from here which video that is — the hourly listing check names it.${settleIt}` };
  }

  const me = claimantOf(sub);
  const candidates = facts.videos.filter((v) => couldBe(me, v));
  if (candidates.length === 0) {
    const newest = facts.videos[facts.videos.length - 1];
    // WHY none of them can be it, because the two reasons are different news.
    // Everything up there is older than the file → the listing is carrying an
    // earlier version and this one has not gone up (or went up before the hub
    // had it, which a person can settle with one tap). A length that does not
    // match → something else is up there entirely. Said plainly either way, and
    // never as an instruction: the card does not know what Kyle did outside it.
    const tooOld = newest != null && newest.at.getTime() < me.readyAt.getTime();
    const many = facts.count > 1;
    const says = tooOld
      ? `Aryeo already shows ${n} on this listing, but the ${many ? "newest" : "one"} up there went up ${etDateTime(newest!.at)} ET — before the hub had this file — so ${many ? "none of them can" : "it can’t"} be this one.`
      : `Aryeo already shows ${n} on this listing, but ${many ? "none of them is" : "it isn’t"} the right length for this file — ${many ? "none of them can" : "it can’t"} be this one.`;
    return { ...base, couldBeThisCut: false, says };
  }
  const hit = candidates[candidates.length - 1];
  const named = hit.title ? `“${hit.title}”` : "a video";
  const len = hit.durationSec != null ? `, ${Math.round(hit.durationSec)}s` : "";
  return {
    ...disputed,
    couldBeThisCut: true,
    says: `Aryeo already shows ${n} on this listing — ${named}${len}, uploaded ${etDateTime(hit.at)} ET, after this file was ready.${settleIt}`,
  };
}

/** Where the 1080p pass has got to, in Kyle's words rather than the lane's. */
function renderingSays(state: string): string {
  // O02: finished, filed aside, and not trusted — the one rendering row that is
  // waiting on a PERSON rather than on the lane.
  if (state === "held") return "The 1080p file's sound couldn't be verified — waiting for a reviewer to listen to it or keep the original.";
  if (state === "queued" || state === "estimated") return "The 1080p pass is queued — nothing to send yet.";
  if (state === "saving") return "The 1080p file is being filed into Dropbox — nearly there.";
  if (state === "uploading" || state === "processing") return "The 1080p pass is running — nothing to send yet.";
  // An unknown state is still the lane's, and still not ours to send.
  return "The 1080p pass hasn't finished — nothing to send yet.";
}

/** What a held row shows: the unchecked file, a link to listen to it, and what
 *  the last look at it found (topazJobs.verifyProcessedOutput's own record). */
function heldLine(j: { id: string; heldPath: string | null; heldAt: Date | null; outputCheckJson: string | null }): NonNullable<RenderingVideo["held"]> {
  let lastCheck: string | null = null;
  try {
    const c = j.outputCheckJson ? (JSON.parse(j.outputCheckJson) as { verdict?: string; reason?: string | null; where?: string }) : null;
    if (c?.verdict === "unreadable") {
      lastCheck = c.reason && c.reason !== "the file couldn't be read"
        ? `Last check: ${c.reason}.`
        : `Last check: couldn't be read${c.where === "dropbox" ? " from Topaz or from Dropbox" : ""}.`;
    }
    else if (c?.verdict === "lost") lastCheck = "The last check read it as silent — keep the original.";
    else if (c?.verdict === "mismatch") lastCheck = `The last check found it ${c.reason ?? "isn't the approved video"} — keep the original.`;
  } catch { /* an unreadable record says nothing rather than something wrong */ }
  return {
    jobId: j.id,
    fileName: j.heldPath?.split("/").pop() ?? "the 1080p file",
    dropboxUrl: j.heldPath ? dropboxFileUrl(j.heldPath) : null,
    heldAtISO: j.heldAt?.toISOString() ?? null,
    lastCheck,
  };
}

/**
 * Has this cut's file already reached the client?
 *
 * True only on evidence about THIS CUT. Nothing about the listing appears here
 * any more, and that is the Sep 17 change: a row leaves this card when a person
 * presses the button, when the 1080p job the hub handed that person is stamped
 * delivered, or when the proof pass in lib/aryeoDelivery has matched an
 * individual video on Aryeo to this individual file and written
 * `sentToClientAt` for it — a fact, recorded, with a line on the job's
 * timeline saying so.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS GONE. The board carried its own, weaker
 * version of that proof: `aryeo.videos`, a count out of the cached evidence,
 * cleared a row when the listing had enough videos to go round. It was wrong
 * twice over on its first day out, and the second way is the one that matters.
 *   · A count goes stale in silence — 2051 Old Sumneytown Pike's was nine days
 *     old and said zero while the video had been live since the day after.
 *   · A count cannot say WHICH video, so it cleared rows on evidence that does
 *     not support them: 1956 Wetherhill Dr, 332 Ruth Ridge Dr and 439 Lake
 *     George Cir were all being cleared by a video that went up BEFORE the file
 *     on the card existed, which is no evidence about that file at all.
 * A render cannot do better than that on its own: proving a cut means measuring
 * the file (an HTTP range read per cut) and reading the listing live, and this
 * function runs on two home screens on every request. So it stopped guessing.
 * The hourly pass does the proving, where a read and a measurement are
 * affordable and the answer can be written down; the rows it cannot prove stay
 * here, each one now carrying Aryeo's own answer for Kyle to act on (see
 * listingLine). One decision, in one place, that leaves a record.
 */
function wentOut(sub: CandidateSub, portalClientIds: ReadonlySet<string>): boolean {
  // A person pressed the button for this cut: the caller has already filtered
  // on `sentToClientAt: null`, so reaching here means nobody has.

  // The hub handed a specific file to a specific person: only their press
  // closes it — or lib/aryeoDelivery proving the upload that card named, which
  // stamps the job itself. Aryeo showing "a video" is not evidence about THIS
  // file: on 322 N 62nd St the video Aryeo shows is 60 seconds long, went up
  // after the file was ready, and is the silent one the client rejected.
  // (A job the lane is still working on has not been handed to anybody either;
  // it is filtered out later, as a rendering row rather than a sent one.)
  if (sub.topazJob) return Boolean(sub.topazJob.deliveredAt);

  // A content-program cut IS the client's the moment it is approved — IF the
  // client can actually open the portal (R09, external review, Sep 18).
  //
  // The first half of that was already true: the library row is written on
  // approval and the media gate opens for any APPROVED cut, so Kyle has nothing
  // to upload and nothing to send. The second half was assumed, and it is not
  // true of this business: THE PORTAL HAS NEVER BEEN ISSUED TO CLIENTS.
  // Measured Sep 18 — 29 content enrollments, 3 ClientUser rows, and exactly
  // ONE client with any portal membership, which is a TEST client. So "released
  // to the portal" was closing the row on a screen nobody could reach, and
  // Sarina Spinelli's video left Kyle's card while the delivery reconciliation
  // was independently flagging the same job as OWED. Two surfaces, two answers,
  // one video.
  //
  // Release and delivery are different facts and this is where they part. A cut
  // is released for client review on approval; it has REACHED the client only
  // once there is somebody who can sign in and see it. When the portal launches
  // and clients get memberships, this reads true on its own — no switch to
  // remember to flip.
  if (sub.project.contentMonthId && cutReleasedAt({ ...sub, status: "APPROVED" })) {
    return !!sub.project.clientId && portalClientIds.has(sub.project.clientId);
  }

  return false;
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
/** The minimum a row needs to be grouped — so resolveListingInference can use
 *  the same key without carrying a whole CandidateSub. */
export type Groupable = {
  id: string;
  projectId: string;
  deliverableId: string | null;
  slot: number | null;
  assetPath: string | null;
  fileName: string | null;
};

/** ONE definition of "these rows are the same video", used to collapse the
 *  card's rows, to count how many videos a job is actually owed, and by the
 *  Aryeo webhook to work out which cuts are rivals for one upload. Splitting
 *  these apart is how a job ends up needing more videos than it ever ordered —
 *  or how two exports of one reel end up blocking each other's proof. */
export function groupKeyOf(r: Groupable): string {
  return r.deliverableId
    ? `${r.projectId}|${cutKeyOf(r)}`
    : `${r.projectId}|${fileIdentity(r.fileName ?? r.assetPath, r.id)}`;
}

function collapseReExports(rows: CandidateSub[]): { winners: CandidateSub[]; others: Map<string, CandidateSub[]> } {
  const groups = new Map<string, CandidateSub[]>();
  for (const r of rows) {
    groups.set(groupKeyOf(r), [...(groups.get(groupKeyOf(r)) ?? []), r]);
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

export type SentResult = {
  ok: boolean;
  message: string;
  already?: boolean;
  /** A04: bookkeeping this call finished off that an earlier attempt did not. */
  repaired?: string[];
  /** A04: bookkeeping that STILL did not land. The send stands; pressing again retries only these. */
  incomplete?: string[];
};

// ---------------------------------------------------------------------------
// "SOMEBODY HAS THE FILE" — the other write, and the smaller one.
//
// WHY IT EXISTS. Sep 21 2026: three approved videos had been sitting unsent for
// up to three days — 5 Raymond Cir (Brie Martinez), 453 Cardigan Terrace (Renee
// Ryan), 5642 Limeport Rd (Sarina Spinelli). Nobody had ignored them; the card
// was on a screen Kyle could not get to. Fixing that surfaces a second problem
// immediately: once a person IS working the list, a row they pulled a minute
// ago and a row nobody has ever touched render identically, both shouting
// "ready 3 days". So the press is recorded.
//
// WHAT IT IS NOT. It is not delivery, and this module will never let it become
// delivery. A file on Kyle's machine is one step of three — download, upload to
// Aryeo, deliver the listing — and only the last of those reaches the client.
// The row stays on the card, keeps saying it has not gone, and still needs
// "Mark as sent" or the hourly Aryeo proof pass in lib/aryeoDelivery. Nothing
// here touches sentToClientAt, DeliverableOutput.deliveredAt, TopazJob or the
// project's status, and nothing here messages anybody.
// ---------------------------------------------------------------------------

/**
 * Record that a person took this cut's file.
 *
 * CALLED WHERE THE HAND-OFF IS KNOWN, not where it was requested (review, Sep
 * 21 2026). It used to be fired from the card's onClick, before anything knew
 * whether a file came back: /api/topaz/download has three real failure exits
 * (409 not filed yet, 404 moved or renamed, 502 Dropbox refused), and the 404
 * is not hypothetical — 322 N 62nd St's Final Video folder was emptied out from
 * under its own pointer. Every one of those wrote "Downloaded by Kyle" for a
 * file nobody had, first-press-wins meant nothing could correct it, and the
 * four-hour quiet period then suppressed the red "waiting 3 days" on the one
 * row where the file was actually missing. The two download routes now call
 * this AFTER Dropbox has handed over a link or the store has started returning
 * bytes.
 *
 * FIRST PRESS WINS, and that is deliberate. The question the row is answering
 * is "has anybody picked this up, and when" — the age of the oldest press is
 * what tells you whether somebody is on it or whether it went quiet again.
 * Re-pressing Download (a second copy, a different machine) must not reset that
 * clock or overwrite the first person's name. Idempotent in Postgres rather
 * than by a read-then-write: the WHERE still carries `downloadedAt: null`, so
 * two presses race and exactly one lands.
 *
 * Never throws and never blocks the download — the bytes are the point, the
 * stamp is a courtesy. A row that fails to stamp reads as untouched, which is
 * where every row was before Sep 21; a row that stamps a download that never
 * happened is a lie the card cannot take back.
 */
export async function markCutDownloaded(
  submissionId: string,
  by: string | null,
): Promise<{ ok: boolean; message: string; already?: boolean }> {
  const claimed = await prisma.reviewSubmission
    .updateMany({
      where: { id: submissionId, downloadedAt: null },
      data: { downloadedAt: new Date(), downloadedBy: by },
    })
    .catch(() => null);
  if (!claimed) return { ok: false, message: "Couldn’t record that download." };
  // count 0 = somebody (or this person, twice) already has it. `already` is a
  // flag rather than a sentence because a caller decides whether to re-render
  // the page on it, and a decision keyed on prose breaks the day the prose
  // changes.
  if (claimed.count === 0) return { ok: true, already: true, message: "Already recorded." };
  return { ok: true, message: "Download recorded." };
}


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
  // A04 (Sep 21 audit, fixed Sep 22 2026). This used to return here, full stop.
  // The stamp on the cut row is written FIRST, so any later write that failed —
  // the per-video delivery row, the 1080p job, Kyle's upload task — was
  // unreachable forever: every retry hit this line and reported success. The
  // historical timestamp is still immutable; what happens now is that the rest
  // of the bookkeeping is reconciled and the caller is told what it repaired.
  if (sub.sentToClientAt) {
    const repair = await settleDeliveryBookkeeping(sub, sub.sentToClientBy ?? by, { first: false });
    return alreadySent(sub.sentToClientAt, sub.sentToClientBy, repair);
  }
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

  const settled = await settleDeliveryBookkeeping(sub, by, { first: true });
  if (settled.incomplete.length) {
    // The send happened and the stamp is real. What did NOT happen is named,
    // and pressing again now re-runs exactly the steps that failed.
    return { ok: true, message: `Marked sent — but ${settled.incomplete.join("; ")}. Press it again to finish that off.`, incomplete: settled.incomplete };
  }
  return { ok: true, message: "Marked sent." };
}

/**
 * EVERYTHING THAT HAS TO BE TRUE ONCE A CUT IS SENT, made repeatable (A04).
 *
 * Four writes hang off one send: the per-video delivery row, the 1080p job's
 * own stamp, Kyle's upload task, and the timeline line. They were inline, they
 * were each `.catch(() => {})`, and they ran exactly once — behind a stamp that
 * made every retry a no-op. Pulled out here, each one is filtered on the field
 * it sets still being null, so running this a second time repairs the gaps and
 * touches nothing that already landed.
 *
 * `first` controls only the things that are genuinely once-per-send: the
 * timeline line, and whether a silent success is worth reporting.
 */
async function settleDeliveryBookkeeping(
  sub: CandidateSub & { sentToClientBy?: string | null },
  by: string | null,
  opts: { first: boolean },
): Promise<{ repaired: string[]; incomplete: string[] }> {
  const repaired: string[] = [];
  const incomplete: string[] = [];

  // 1. THE ONE FACT THE VIDEO'S OWN ROW EXISTS TO HOLD (audit WF-02): this
  // particular video reached the client, and how we know. The cut row says it
  // for the round; DeliverableOutput says it for the VIDEO, which is what the
  // project view, the promise clock and the content meter read. Only ever
  // written when it is still null — a stamp somebody already made by hand is
  // not ours to restate — and never the other way round: nothing here can
  // un-send a video.
  if (sub.deliverableId) {
    // `by` carries the proof pass's own sentence when the hourly Aryeo reader
    // settled it ("Aryeo — “Cinematic Video”, 60s on the listing since …"), so
    // the channel is read from that rather than guessed: a person pressing the
    // button is the office sending the file by hand, which is the only way
    // finished video actually leaves this business (see the header note).
    const via = by?.startsWith("Aryeo") ? "aryeo-listing" : "office-hand";
    try {
      const r = await prisma.deliverableOutput.updateMany({
        where: { deliverableId: sub.deliverableId, slot: sub.slot ?? 1, deliveredAt: null },
        data: {
          sentSubmissionId: sub.id,
          deliveredAt: new Date(),
          deliveredBy: by,
          deliveredVia: via,
          evidenceSource: via === "aryeo-listing" ? "aryeo-listing" : "review-sent",
          evidenceSucceededAt: new Date(),
        },
      });
      if (r.count > 0 && !opts.first) repaired.push("the video's own delivery row");
      if (r.count === 0) {
        // `count: 0` means EITHER already stamped OR there is no row to stamp,
        // and only one of those is fine. Ask which, so a cut whose per-video
        // row has not been minted yet is reported rather than reading as a
        // clean send. (sweepOutputUnits mints it; this says so out loud.)
        const exists = await prisma.deliverableOutput.count({ where: { deliverableId: sub.deliverableId, slot: sub.slot ?? 1 } });
        if (exists === 0) incomplete.push("this video has no per-video delivery row yet — the hourly output sweep mints it, then press again");
      }
    } catch (e) {
      incomplete.push(`the video's own delivery row did not stamp (${e instanceof Error ? e.message.slice(0, 100) : "unknown"})`);
    }
  }

  // 2. THE 1080p LANE. The done path goes through markTopazDelivered, which
  // since A04 reconciles the task on a repeat call instead of returning early —
  // so this reaches an upload task the first attempt left open.
  const j = sub.topazJob;
  if (j?.state === "done") {
    try {
      const { markTopazDelivered } = await import("@/lib/topazJobs");
      const r = await markTopazDelivered(j.id, by);
      if (r.incomplete) incomplete.push(r.incomplete);
      else if (r.repaired) repaired.push("the upload task the 1080p job left open");
    } catch (e) {
      incomplete.push(`the 1080p job did not close (${e instanceof Error ? e.message.slice(0, 100) : "unknown"})`);
    }
  } else if (j) {
    // Cases (b) and (c): the same writes, in words that fit the file that
    // actually went out. markTopazDelivered's line says "1080p video uploaded"
    // and names job.finalPath — both untrue here, where the whole point is that
    // the 1080p file does not exist and the editor's export is the deliverable.
    try {
      // Stamp the job anyway: its card on /connections and its "waiting on
      // Kyle" count must clear with the row it describes.
      const stamped = await prisma.topazJob.updateMany({ where: { id: j.id, deliveredAt: null }, data: { deliveredAt: new Date(), deliveredBy: by } });
      if (stamped.count > 0 && !opts.first) repaired.push("the 1080p job's stamp");
      const task = await prisma.topazJob.findUnique({ where: { id: j.id }, select: { taskId: true } });
      if (task?.taskId) {
        const closed = await prisma.smartTask.updateMany({ where: { id: task.taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } });
        if (closed.count > 0 && !opts.first) repaired.push("the upload task");
      }
    } catch (e) {
      incomplete.push(`the 1080p job did not close (${e instanceof Error ? e.message.slice(0, 100) : "unknown"})`);
    }
  }

  // 3. THE TIMELINE LINE — once per send, never on a repair. Writing a second
  // "Video sent to the client" months later would be a false record.
  if (opts.first) {
    const file = fileFor(sub, null);
    // It says WHICH file went out, in the same words the card used — a fixed
    // "the editor's own export; no 1080p pass" was untrue for a cut whose
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
  }

  return { repaired, incomplete };
}

function alreadySent(at: Date, by: string | null, repair?: { repaired: string[]; incomplete: string[] }): SentResult {
  const when = at.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const head = `Already marked sent${by ? ` by ${by}` : ""} — ${when} ET.`;
  if (repair?.incomplete.length) {
    // Both, when both happened: a press that fixed two of three things and
    // failed the third used to report only the failure in the structured field.
    return { ok: true, already: true, message: `${head}${repair.repaired.length ? ` Finished off: ${repair.repaired.join(", ")}.` : ""} ${repair.incomplete.join("; ")} — press again to retry.`, incomplete: repair.incomplete, ...(repair.repaired.length ? { repaired: repair.repaired } : {}) };
  }
  if (repair?.repaired.length) return { ok: true, already: true, message: `${head} Finished off what the first attempt left: ${repair.repaired.join(", ")}.`, repaired: repair.repaired };
  return { ok: true, already: true, message: head };
}

/**
 * A Dropbox link that opens THIS FILE — the only form of it in this module.
 *
 * dropboxWebUrl builds `/home/<path>` and its own comment says it takes a
 * FOLDER; all ten other call sites in the repo pass one. Handed a file path it
 * produced
 * `…/05-Final-Video/Standard%20Cinematic%20Video%20-%20v1%20-%20FINAL%20(Topaz).mp4`
 * under a link labelled "Open the Dropbox folder" — neither what the label
 * promised nor a place Dropbox reliably lands you (review, Sep 21 2026).
 *
 * The shape below is the one this repo already found for linking to a file:
 * open the PARENT folder and name the file in `?preview=`. /edit/[id] uses it
 * for the music pick and music.actions.ts returns it, both because somebody had
 * already discovered that `/home/<path to a file>` does not go where you want.
 * Written once, here, so the card's three sources cannot drift apart — the
 * three copies are how one of them would have been fixed and the others left.
 *
 * A path with no slash in it is not a real Dropbox path; it falls back rather
 * than inventing an empty parent folder.
 */
function dropboxFileUrl(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return dropboxWebUrl(path);
  return `${dropboxWebUrl(path.slice(0, cut))}?preview=${encodeURIComponent(path.slice(cut + 1))}`;
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
      dropboxUrl: dropboxFileUrl(j.finalPath),
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
      dropboxUrl: (() => {
        const p = sub.finalPath ?? sub.assetPath;
        return p ? dropboxFileUrl(p) : null;
      })(),
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
      // ?dl=1 on this branch too. The bytes come back as a Dropbox 302 either
      // way, so it changes nothing about what is served — it is the DOWNLOAD
      // INTENT the stream route reads before it stamps the hand-off. Without it
      // this href is character-for-character the Review Room's playback URL,
      // and an editor pressing play would have read as Kyle taking the file
      // (review, Sep 21 2026).
      downloadHref: `/api/review/cut/${sub.id}/stream?dl=1`,
      dropboxPath: path,
      dropboxUrl: dropboxFileUrl(path),
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

// ---------------------------------------------------------------------------
// R5 — THE DURABLE HALF: a sent video whose own records did not finish.
//
// markVideoSent repairs on a repeat press, and the card now keeps that press
// reachable. Neither helps if nobody presses it again — and the machine path
// (aryeoDelivery's proof pass) calls markVideoSent too and has no fingers.
//
// THE PREDICATE IS NARROW ON PURPOSE, and this is the whole design.
//
// A TopazJob with `deliveredAt` NULL and an open upload task is NOT broken: it
// is the ordinary "Kyle still has to upload this" state, and its
// `topaz-deliver-<jobId>` card is a real, owner-assigned chase card that
// completing runs the very same repair. A sweep that closed those would mass-
// close Kyle's queue and destroy the only record that the upload is owed.
//
// The unambiguous break is the other way round: the job IS stamped delivered
// and its task is still open. Nothing legitimate produces that — the only
// writer of deliveredAt closes the task in the same breath, so an open task
// beside a delivered job is exactly the half-finished settle A04 described.
//
// The DeliverableOutput arm needs nothing here: refreshOutputsForProject
// already stamps `if (sent && !o.deliveredAt)` on every live job, every hour.
// ---------------------------------------------------------------------------
export async function repairIncompleteDeliveries(opts: { sinceDays?: number; max?: number } = {}): Promise<{
  checked: number;
  repaired: number;
  failed: number;
  lastError: string | null;
  detail: { jobId: string; taskId: string }[];
}> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86_400_000);
  const jobs = await prisma.topazJob.findMany({
    where: { deliveredAt: { not: null, gte: since }, taskId: { not: null } },
    select: { id: true, taskId: true },
    orderBy: { deliveredAt: "desc" },
    take: opts.max ?? 200,
  });
  if (!jobs.length) return { checked: 0, repaired: 0, failed: 0, lastError: null, detail: [] };

  // One read for the tasks that are genuinely still open.
  const open = await prisma.smartTask.findMany({
    where: { id: { in: jobs.map((j) => j.taskId!).filter(Boolean) }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (!open.length) return { checked: jobs.length, repaired: 0, failed: 0, lastError: null, detail: [] };
  const openIds = new Set(open.map((t) => t.id));

  const { markTopazDelivered } = await import("@/lib/topazJobs");
  let repaired = 0, failed = 0;
  let lastError: string | null = null;
  const detail: { jobId: string; taskId: string }[] = [];
  for (const j of jobs) {
    if (!j.taskId || !openIds.has(j.taskId)) continue;
    try {
      // The same function a person's press calls. It leaves the historical
      // deliveredAt alone and closes the task that was left open.
      const r = await markTopazDelivered(j.id, "delivery-repair");
      if (r.repaired) { repaired++; detail.push({ jobId: j.id, taskId: j.taskId }); }
      else if (r.incomplete) { failed++; lastError = r.incomplete; }
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    }
  }
  if (repaired > 0) {
    console.info(`[delivery] ${repaired} delivered 1080p job(s) still had an open upload card — closed. A "mark as sent" had stamped the job and not finished the card.`);
  }
  return { checked: jobs.length, repaired, failed, lastError, detail };
}

// ---------------------------------------------------------------------------
// R5 — THE REPAIR ITEM THAT SURVIVES A REFRESH.
//
// A press that came back incomplete keeps the row on screen with a live button,
// which is the immediate half. It is not enough on its own: reload the page and
// the row is gone, because it now carries sentToClientAt and the board is
// filtered on that. The cron sweep still repairs it within the hour, but the
// person who pressed has nothing to look at in the meantime.
//
// So the card asks the same question the sweep does, and shows what it finds.
// DERIVED, not a status column — nothing has to remember to set or clear it.
//
// Two shapes, and only these two, for the same reason the sweep is narrow:
//   · a 1080p job stamped delivered whose upload card is still open. Nothing
//     legitimate produces that. (The reverse — undelivered, card open — is
//     Kyle's ordinary chase card and must never be listed as a fault.)
//   · a sent cut whose per-video delivery row was never minted for its slot.
// ---------------------------------------------------------------------------
export async function deliveriesNeedingFinishing(opts: { projectId?: string; sinceDays?: number; max?: number } = {}): Promise<NeedsFinishing[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 14) * 86_400_000);
  const sent = await prisma.reviewSubmission.findMany({
    where: { ...(opts.projectId ? { projectId: opts.projectId } : {}), sentToClientAt: { not: null, gte: since } },
    select: {
      id: true, slot: true, deliverableId: true, sentToClientAt: true, sentToClientBy: true,
      project: { select: { title: true } },
      topazJob: { select: { id: true, deliveredAt: true, taskId: true } },
    },
    orderBy: { sentToClientAt: "desc" },
    take: opts.max ?? 60,
  });
  if (!sent.length) return [];

  const taskIds = sent.map((s) => s.topazJob?.taskId).filter((x): x is string => !!x);
  const openTasks = taskIds.length
    ? new Set((await prisma.smartTask.findMany({ where: { id: { in: taskIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } })).map((t) => t.id))
    : new Set<string>();

  const pairs = sent.filter((s) => s.deliverableId).map((s) => ({ deliverableId: s.deliverableId!, slot: s.slot ?? 1 }));
  const outs = pairs.length
    ? await prisma.deliverableOutput.findMany({ where: { deliverableId: { in: [...new Set(pairs.map((p) => p.deliverableId))] } }, select: { deliverableId: true, slot: true } })
    : [];
  const haveOutput = new Set(outs.map((o) => `${o.deliverableId}:${o.slot}`));

  const out: NeedsFinishing[] = [];
  for (const s of sent) {
    const why: string[] = [];
    if (s.topazJob?.deliveredAt && s.topazJob.taskId && openTasks.has(s.topazJob.taskId)) {
      why.push("its 1080p upload card never closed");
    }
    if (s.deliverableId && !haveOutput.has(`${s.deliverableId}:${s.slot ?? 1}`)) {
      why.push("this video has no per-video delivery row");
    }
    if (!why.length) continue;
    out.push({
      submissionId: s.id,
      street: streetOf(s.project?.title) || (s.project?.title ?? "a job"),
      sentAtISO: s.sentToClientAt!.toISOString(),
      sentBy: s.sentToClientBy,
      why: why.join(" and "),
    });
  }
  return out;
}
