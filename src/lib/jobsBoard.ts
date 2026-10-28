import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime, etDayKey, etMonthDay, etTime, etTomorrowKey, etWeekday } from "@/lib/datetime";
import { WAITING_FOR_UPLOAD } from "@/lib/photoDelivery/holding";
import { BATCH_TIER_LABEL } from "@/lib/bulkBatchCore";

// ---------------------------------------------------------------------------
// SHOOTS (Jordan, Oct 19 2026): every shoot (job) in progress, one row each,
// with where its PHOTOS and its VIDEO stand side by side, its due date and its
// open client requests. The dashboard imports jobsBoard() with this exact
// signature; the Shoots page (/jobs, menu label "Shoots") renders the same
// rows, so the two agree. The job page's Photos and Video cards
// (jobDeliverables below) use the same stage rules, so a chip on the Shoots
// row and the card on the job say the same thing.
//
// Jordan: "We have projects where they have multiple deliverables. The main
// deliverables that take the most work are photo and video. I need to be able
// to track each job and where they are at, and special requests for either
// photo or video, and individual photos and videos."
//
// ONE READ, NO FAN-OUT. The job list, its due dates and the late / due-today
// split are Kyle's delivery board's own (deliveryBoard: the per-product
// promises, the office's date, a reopened job's clock; test clients left out
// unless asked). On top of it, batched over the whole list: the photo
// pipeline's stage (PhotoJob), the videos from the Video Review Room's own
// board (videoDelivery.videoDeliveryBoard, read only; the furthest-behind
// video leads the chip) or, for monthly content and anything that board does
// not list, the cut states (reviewCuts.videoStatesFor), the open client
// requests (ClientAsk, the client's own words or staff's) and who edits the
// video (the job's edit card).
//
// STAGE WORDS (the chip):
//   photos  Not shot yet · Waiting for upload · Editing · Edit failed · In QC ·
//           Ready to review · On hold · Revisions · Delivering ·
//           Delivery problem · Delivered
//   video   Not shot yet · Not cut · <editor> · Editing · <editor> ·
//           Changes · <editor> · In review · Finishing (the 1080p pass) ·
//           Held · Ready to send · Approved (monthly, goes to the portal) ·
//           Sent
// null = not ordered on this job. Plain words, no amounts, no em dashes.
// ---------------------------------------------------------------------------

export type StageTone = "done" | "active" | "waiting" | "late" | "none";

export type DeliverableStage = {
  /** Short words for the chip: "Editing", "In QC", "Revisions", "Ready to send", "Delivered", "Changes · John". */
  label: string;
  tone: StageTone;
};

export type JobRow = {
  projectId: string;
  street: string;
  client: string | null;
  /** When the next thing is promised (ET ISO); null when nothing is outstanding or no date is known. */
  dueISO: string | null;
  /** "4 days late", "Tue 5 PM", "No date yet". */
  dueWords: string;
  late: boolean;
  dueToday: boolean;
  /** null = not ordered on this job. */
  photos: DeliverableStage | null;
  /** null = not ordered on this job. One chip for the job's videos (the furthest-behind one leads). */
  video: DeliverableStage | null;
  /** Open client requests on this job, by what they are about. */
  requests: { open: number; photo: number; video: number; needsOwner: number };
  monthly: boolean;
  href: string;
};

export type JobsBoard = {
  rows: JobRow[];
  counts: { total: number; late: number; dueToday: number; dueTomorrow: number; oldestLateDays: number | null };
};

/** The Shoots page's row: the dashboard's row plus what the page prints under the street. */
export type ShootRow = JobRow & {
  /** What is holding the job, when the board says it in words the chips do not (on hold, files missing, the brief). */
  holding: string | null;
  /** Delivered and settled (only on the page's "All" filter). */
  delivered: boolean;
  /** Due within the next 7 days (or late). */
  dueThisWeek: boolean;
  /** Oct 22 2026: the order sells more videos than the job has set up ("2 videos ordered, 1 set up"); null when they agree. */
  videoSetup: string | null;
  /** Oct 22 2026: "Video 4 (Premium Social Reel): Waiting on a second shoot: half shot", one line per held video; empty when none. */
  waitingOnShoot?: string[];
  /** Oct 27 2026: the shoot has happened (the Review & deliver filter: in review and delivery). */
  shot?: boolean;
  /** Oct 27 2026 (the Projects page, read with `detail`): one plain line per piece of the job. */
  pieces?: ProjectPiece[];
};

/** Oct 27 2026 (Review & deliver): one piece of a job beyond the Photos and Video chips. */
export type DeliverPiece = { label: string; stage: DeliverableStage };
export type DeliverExtra = {
  pieces: DeliverPiece[];
  missing: string[];
  /** Virtual staging, headshots and anything else ordered beyond photos, video, floor plan and tour. */
  more?: DeliverPiece[];
  /** "drone", "twilight": photo add-ons that ride with the photos (same edit, same delivery). */
  photoAddOns?: string[];
  /** Floor plan / 3D tour finished in our Dropbox and on no listing yet. */
  awaitingSend?: string[];
};

/**
 * PROJECTS, ONE LINE PER PIECE (Jordan, Oct 27 2026 Loom: "we need to know
 * what each job is waiting on and what has been sent ... you can't even read
 * it ... you have to mouse over it, I don't like that"). The photos, each
 * video, the floor plan, the 3D tour and anything else ordered, each with
 * what it is waiting on or "Sent <date>", in plain words that wrap (never a
 * truncated chip with the rest in a tooltip).
 */
export type ProjectPiece = {
  key: string;
  /** "Photos", "Photos and drone", "Standard Cinematic Video", "Floor plan". */
  label: string;
  /** What it is waiting on, or "Sent Oct 24". */
  status: string;
  tone: StageTone;
  /** A grouped line ("Videos (12)"): each video's own line, for the row's Details. */
  each?: ProjectPiece[];
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- pure: words ------------------------------------------------------------------------------

/** "5 PM", "10:30 AM" (Eastern). */
const shortTime = (d: Date) => etTime(d).replace(":00 ", " ");

/** "4 days late", "41 h late", "Today 5 PM", "Tue 5 PM", "Oct 30", or `none` when there is no date. */
export function dueWordsFor(dueAt: Date | null, now: Date, none = "No date yet"): string {
  if (!dueAt) return none;
  const ms = now.getTime() - dueAt.getTime();
  if (ms > 0) {
    const h = Math.max(1, Math.round(ms / HOUR));
    return h < 48 ? `${h} h late` : `${Math.round(h / 24)} days late`;
  }
  if (etDayKey(dueAt) === etDayKey(now)) return `Today ${shortTime(dueAt)}`;
  if (dueAt.getTime() - now.getTime() < 6 * DAY) return `${etWeekday(dueAt)} ${shortTime(dueAt)}`;
  return etMonthDay(dueAt);
}

/** "Due Oct 15, 4 days late" / "Due Tue, Oct 21, 5:00 PM" for the job page. */
export function dueLineFor(dueAt: Date | null, now: Date): string | null {
  if (!dueAt) return null;
  return dueAt.getTime() < now.getTime() ? `Due ${etMonthDay(dueAt)}, ${dueWordsFor(dueAt, now)}` : `Due ${etDateTime(dueAt)}`;
}

/** An editor's key or name as the chip says it: first name, "outside" for the outside agency. */
export async function editorWordFor(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const { editorMeta } = await import("@/lib/editors");
  const meta = editorMeta(key);
  if (meta?.kind === "external" && key !== "autohdr" && key !== "cubicasa") return "outside";
  const name = meta?.name ?? key.replace(/_/g, " ");
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first ? first[0].toUpperCase() + first.slice(1) : null;
}

// ---- pure: the photo stage ----------------------------------------------------------------------

export type StageStep = { label: string; state: "done" | "now" | "todo" };

export const PHOTO_STEPS = ["Shot", "Edited", "QC", "Revisions", "Delivered"] as const;
export const VIDEO_STEPS = ["Shot", "Edited", "Reviewed", "Ready", "Sent"] as const;

export type PhotoFacts = {
  /** PhotoJob.stage, when the photo pipeline has the job. */
  jobStage: string | null;
  shootOver: boolean;
  /** The raw photos are in (the deliverable row's upload state). */
  rawsIn: boolean;
  /** Photos are live on the Aryeo listing (the status check). */
  liveOnAryeo: boolean;
  /** Past the photos' promise. */
  late: boolean;
  /** A photo-only job the client reopened (the board's open revision). */
  reopened?: boolean;
  /**
   * Oct 22 2026 (photo audit M3, photo delivery builder): the photo job is in
   * Editing but the hub never saw its raws (no intake batch) and read no
   * edited photo: "Not uploaded" (the photographer's), not "Editing" (AutoHDR's).
   */
  noRawsSeen?: boolean;
};

type PhotoRead = DeliverableStage & { at: number; revision: boolean };

const PHOTO_BY_STAGE: Record<string, { label: string; tone: StageTone; at: number }> = {
  EDITING: { label: "Editing", tone: "active", at: 1 },
  EDIT_FAILED: { label: "Edit failed", tone: "late", at: 1 },
  EDITED: { label: "In QC", tone: "active", at: 2 },
  QC_RUNNING: { label: "In QC", tone: "active", at: 2 },
  QC_REVIEW: { label: "In QC", tone: "active", at: 2 },
  FIXING: { label: "In QC", tone: "active", at: 2 },
  ON_HOLD: { label: "On hold", tone: "waiting", at: 2 },
  READY: { label: "Ready to review", tone: "active", at: 2 },
  REVISION_REQUESTED: { label: "Revisions", tone: "waiting", at: 3 },
  DELIVERING: { label: "Delivering", tone: "active", at: 4 },
  DELIVERY_MISMATCH: { label: "Delivery problem", tone: "late", at: 4 },
  DELIVERED: { label: "Delivered", tone: "done", at: 5 },
};

function readPhotos(f: PhotoFacts): PhotoRead {
  let r: { label: string; tone: StageTone; at: number };
  // Photo audit M3; Oct 23 2026 (huddle item 12): before the raws arrive the photos read "Waiting for upload", never "Editing".
  if (f.jobStage === "EDITING" && f.noRawsSeen) r = { label: WAITING_FOR_UPLOAD, tone: "waiting", at: 1 };
  else if (f.jobStage && PHOTO_BY_STAGE[f.jobStage]) r = PHOTO_BY_STAGE[f.jobStage];
  else if (f.liveOnAryeo) r = f.reopened ? PHOTO_BY_STAGE.REVISION_REQUESTED : PHOTO_BY_STAGE.DELIVERED;
  else if (!f.shootOver) r = { label: "Not shot yet", tone: "waiting", at: 0 };
  else if (!f.rawsIn) r = { label: WAITING_FOR_UPLOAD, tone: "waiting", at: 1 };
  else r = { label: "Editing", tone: "active", at: 1 };
  const tone: StageTone = f.late && r.at < 5 && r.tone !== "late" ? "late" : r.tone;
  return { label: r.label, tone, at: r.at, revision: r.at === 3 };
}

/** The photos' chip. */
export function photoStageOf(f: PhotoFacts): DeliverableStage {
  const r = readPhotos(f);
  return { label: r.label, tone: r.tone };
}

/** The photos' 5-step bar; Revisions shows only while the photos are in revisions. */
export function photoStepsOf(f: PhotoFacts): StageStep[] {
  const r = readPhotos(f);
  return PHOTO_STEPS.map((label, i) => ({ label, i }))
    .filter((s) => s.label !== "Revisions" || r.revision)
    .map((s) => ({ label: s.label, state: s.i < r.at ? "done" : s.i === r.at ? "now" : "todo" }));
}

// ---- pure: the video stage ----------------------------------------------------------------------

export type VideoPhase = "not_shot" | "not_cut" | "editing" | "changes" | "review" | "finishing" | "held" | "ready" | "approved" | "sent";
export type VideoFact = { phase: VideoPhase; late: boolean };

const PHASE_RANK: Record<VideoPhase, number> = { not_shot: 0, not_cut: 1, editing: 1, changes: 2, review: 3, finishing: 4, held: 4, ready: 5, approved: 5, sent: 6 };

/** The furthest-behind video (a late one first on a tie). */
export function leadVideo(facts: VideoFact[]): VideoFact | null {
  if (!facts.length) return null;
  return [...facts].sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || Number(b.late) - Number(a.late))[0];
}

/** The video chip, from the furthest-behind video. `editor` is the chip word ("John", "outside"). */
export function videoStageOf(facts: VideoFact[], editor: string | null): DeliverableStage | null {
  const lead = leadVideo(facts);
  if (!lead) return null;
  const who = (w: string, none: string) => (editor ? `${w} · ${editor}` : none);
  const words: Record<VideoPhase, [string, StageTone]> = {
    not_shot: ["Not shot yet", "waiting"],
    not_cut: [who("Not cut", "Not cut yet"), "waiting"],
    editing: [who("Editing", "Editing"), "active"],
    changes: [who("Changes", "Changes asked"), "waiting"],
    review: ["In review", "active"],
    finishing: ["Finishing", "active"],
    held: ["Held", "waiting"],
    ready: ["Ready to send", "done"],
    approved: ["Approved", "done"],
    sent: ["Sent", "done"],
  };
  const [label, tone] = words[lead.phase];
  // Late is the team's: anything short of approved that is past its promise.
  return { label, tone: lead.late && PHASE_RANK[lead.phase] < 5 ? "late" : tone };
}

/** The video's 5-step bar (a monthly video skips Ready: it goes to the client's portal by itself). */
export function videoStepsOf(facts: VideoFact[], monthly: boolean): StageStep[] {
  const lead = leadVideo(facts);
  const at = !lead ? 0
    : lead.phase === "not_shot" ? 0
    : PHASE_RANK[lead.phase] <= 2 ? 1
    : lead.phase === "review" ? 2
    : lead.phase === "sent" ? 5
    : lead.phase === "approved" && monthly ? 4
    : 3;
  return VIDEO_STEPS.map((label, i) => ({ label, i }))
    .filter((s) => !(monthly && s.label === "Ready"))
    .map((s) => ({ label: s.label, state: s.i < at ? "done" : s.i === at ? "now" : "todo" }));
}

/** One Video Review Room row (videoDelivery.VideoRow) as a phase. */
export function phaseOfVideoRow(r: { lane: string; cutStatus: string | null; stage: string }): VideoPhase {
  if (r.lane === "delivered") return "sent";
  if (r.lane === "sending") return "ready";
  if (r.lane === "held") return "held";
  if (r.lane === "finishing") return "finishing";
  if (r.cutStatus === "PENDING") return "review";
  if (r.cutStatus === "CHANGES_REQUESTED") return "changes";
  if (r.cutStatus === "APPROVED") return "ready";
  if (r.stage === "Not shot yet") return "not_shot";
  if (r.stage === "Editing") return "editing";
  return "not_cut";
}

type CutStateLike = {
  owed: number;
  stage: string;
  slotKeys?: string[];
  slotLabels?: string[];
  waitingOnShoot?: number;
  cuts: { submissionId: string; status: string; round: number; cutLabel: string; editorKey: string | null; slotKey?: string | null }[];
};

/** A job's videos from the cut states (monthly content, test jobs, or a job the room's board does not list). */
export function videoFactsFromState(st: CutStateLike | null | undefined, o: { ordered: boolean; shootOver: boolean; late: boolean; monthly: boolean; sentIds?: Set<string> }): VideoFact[] {
  if (!o.ordered && !(st && st.owed > 0)) return [];
  const facts: VideoFact[] = [];
  const allLive = st?.stage === "delivered";
  for (const c of st?.cuts ?? []) {
    const phase: VideoPhase =
      c.status === "PENDING" ? "review"
      : c.status === "CHANGES_REQUESTED" ? "changes"
      : allLive || o.sentIds?.has(c.submissionId) ? "sent"
      : o.monthly ? "approved"
      : "ready";
    facts.push({ phase, late: o.late && PHASE_RANK[phase] < 5 });
  }
  const owed = Math.max(st?.owed ?? 0, o.ordered ? 1 : 0);
  const missing = allLive ? 0 : Math.max(0, owed - facts.length);
  for (let i = 0; i < missing; i++) {
    const phase: VideoPhase = !o.shootOver ? "not_shot" : st?.stage === "editing" ? "editing" : "not_cut";
    facts.push({ phase, late: o.late });
  }
  if (!facts.length && allLive) facts.push({ phase: "sent", late: false });
  return facts;
}

// ---- pure: requests -------------------------------------------------------------------------------

/** One job's open requests counted: both counts for photos and video; unclear needs an owner once the shoot is over (before it, the creative has it). */
export function countRequests(asks: { medium: string | null }[], shootOver: boolean): JobRow["requests"] {
  const out = { open: 0, photo: 0, video: 0, needsOwner: 0 };
  for (const a of asks) {
    const m = String(a.medium ?? "").toLowerCase();
    out.open++;
    if (m === "photo" || m === "both") out.photo++;
    if (m === "video" || m === "both") out.video++;
    if (m !== "photo" && m !== "video" && m !== "both" && shootOver) out.needsOwner++;
  }
  return out;
}

// ---- pure: the Projects page's lines (Oct 27 2026) ------------------------------------------------

/** More videos than this on one job read as one grouped line, each video under the row's Details. */
export const VIDEO_LINES_MAX = 4;

const sentWords = (at: Date | string | null | undefined) => (at ? `Sent ${etMonthDay(at)}` : "Sent");
const firstNameOf = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || null;
const lateTail = (status: string, tone: StageTone) => (tone === "late" ? `${status}, late` : status);

/** The photos' line: what they are waiting on, or when they were sent. */
export function photoPieceStatus(stage: DeliverableStage, o: { sentAt?: Date | string | null; photographer?: string | null; shootAt?: Date | string | null } = {}): string {
  const who = firstNameOf(o.photographer);
  const words = ((): string => {
    switch (stage.label) {
      case "Delivered": return sentWords(o.sentAt);
      case "Not shot yet": return o.shootAt ? `Waiting on the shoot (${etWeekday(o.shootAt)} ${etMonthDay(o.shootAt)})` : "Waiting on the shoot";
      case WAITING_FOR_UPLOAD: return who ? `Waiting on ${who}'s upload` : "Waiting on the photographer's upload";
      case "Editing": return "Being edited";
      case "Edit failed": return "The edit failed, needs a look";
      case "In QC": return "In the photo check";
      case "On hold": return "On hold";
      case "Ready to review": return "Waiting on review";
      case "Revisions": return "Changes asked, being fixed";
      case "Delivering": return "Going onto the listing";
      case "Delivery problem": return "Delivery problem, needs a look";
      default: return stage.label;
    }
  })();
  return lateTail(words, stage.tone);
}

/** One video on the Projects page, before it is put in words. */
export type VideoLineFact = {
  key: string;
  label: string;
  phase: VideoPhase;
  round: number | null;
  late: boolean;
  /** When it reached the client (the listing, or the portal for a monthly video). */
  sentAt?: Date | string | null;
  /** The Video Review Room's own words for an approved one ("On Aryeo, not sent yet"), or "Ready to edit". */
  stage?: string | null;
};

const VIDEO_TONE: Record<VideoPhase, StageTone> = { not_shot: "waiting", not_cut: "waiting", editing: "active", changes: "waiting", review: "active", finishing: "active", held: "waiting", ready: "done", approved: "done", sent: "done" };

/** One video's line. `editor` is the name the line says ("Kim", "Cliffside Cuts"). */
export function videoPieceStatus(v: VideoLineFact, editor: string | null): { status: string; tone: StageTone } {
  const words = ((): string => {
    switch (v.phase) {
      case "sent": return sentWords(v.sentAt);
      case "approved": return "Approved, goes to the client's portal";
      case "ready": return v.stage === "On Aryeo, not sent yet" ? "On the listing, not sent yet" : v.stage === "Uploading to Aryeo" ? "Uploading to the listing" : "Approved, ready to send";
      case "held": return "Approved, the Topaz file is held (check the sound)";
      case "finishing": return "Approved, in the Topaz pass";
      case "review": return v.round ? `Version ${v.round} waiting on review` : "Waiting on review";
      // "With editors because of a revision reads In revision" (Oct 27 2026, the same words as the Video Review Room).
      case "changes": return `In revision with ${editor ?? "the editor"}`;
      case "editing": return editor ? `${editor} is editing` : "Being edited";
      case "not_shot": return "Waiting on the shoot";
      default: return v.stage === "Ready to edit"
        ? (editor ? `Waiting on ${editor} to start` : "Waiting on an editor to start")
        : editor ? `Waiting on ${editor}'s first cut` : "Waiting on the first cut";
    }
  })();
  const tone: StageTone = v.late && PHASE_RANK[v.phase] < 5 ? "late" : VIDEO_TONE[v.phase];
  return { status: lateTail(words, tone), tone };
}

const GROUP_WORDS: Record<VideoPhase, string> = {
  not_shot: "waiting on the shoot", not_cut: "waiting on the first cut", editing: "being edited", changes: "in revision", review: "waiting on review",
  finishing: "in the Topaz pass", held: "held", ready: "ready to send", approved: "approved", sent: "sent",
};

/** A job's video lines: one per video, or (more than VIDEO_LINES_MAX) one grouped line with each under it. */
export function videoPieces(facts: VideoLineFact[], editor: string | null): ProjectPiece[] {
  const each: ProjectPiece[] = facts.map((v) => ({ key: v.key, label: v.label, ...videoPieceStatus(v, editor) }));
  if (each.length <= VIDEO_LINES_MAX) return each;
  const lead = leadVideo(facts)!;
  const byPhase = new Map<VideoPhase, number>();
  for (const v of [...facts].sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase])) byPhase.set(v.phase, (byPhase.get(v.phase) ?? 0) + 1);
  const late = facts.filter((v) => v.late && PHASE_RANK[v.phase] < 5).length;
  const status = [...byPhase.entries()].map(([p, n]) => `${n} ${GROUP_WORDS[p]}`).join(", ") + (late ? ` (${late} late)` : "");
  return [{ key: "videos", label: `Videos (${facts.length})`, status, tone: late ? "late" : VIDEO_TONE[lead.phase], each }];
}

/** "Video 4 (Premium Social Reel): Waiting on a second shoot: half shot" → its label and its words. */
export function waitingPiece(line: string, i: number): ProjectPiece {
  const at = line.indexOf("): ");
  return at > 0
    ? { key: `waiting-${i}`, label: line.slice(0, at + 1), status: line.slice(at + 3), tone: "waiting" }
    : { key: `waiting-${i}`, label: "Video", status: line, tone: "waiting" };
}

/** A floor plan, 3D tour or other ordered piece (deliverPieces' stage) in words. */
export function otherPieceStatus(label: string, stage: DeliverableStage, o: { shootOver: boolean; awaitingSend?: boolean }): string {
  switch (stage.label) {
    case "Marked delivered": return "Marked delivered by the office";
    case "On the listing": return "Sent, on the listing";
    case "Done": return o.awaitingSend ? "Ready, not sent yet" : "Done";
    case "Flagged": return "Flagged, needs a look";
    case "Ready to check": return "In, waiting on a check";
    case "Not in yet": return lateTail(!o.shootOver ? "Waiting on the shoot" : label === "Floor plan" ? "Waiting on CubiCasa" : "Not in yet", stage.tone);
    default: return stage.label;
  }
}

/** "Photos", "Photos and drone", "Photos, drone and twilight". */
export function photosLabel(addOns: string[] = []): string {
  if (!addOns.length) return "Photos";
  const all = ["Photos", ...addOns];
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/**
 * Every line of one job, in order: the photos, the videos (and any waiting on
 * a second shoot), the floor plan, the 3D tour, then anything else ordered.
 * Without per-video facts (a caller that did not read them) the video chip
 * stands as one line.
 */
export function projectPiecesOf(
  r: Pick<ShootRow, "photos" | "video" | "waitingOnShoot" | "shot" | "monthly">,
  o: { photoSentAt?: Date | string | null; photographer?: string | null; shootAt?: Date | string | null; videos?: VideoLineFact[] | null; editor?: string | null; extra?: DeliverExtra | null } = {},
): ProjectPiece[] {
  const out: ProjectPiece[] = [];
  if (r.photos) out.push({ key: "photos", label: photosLabel(o.extra?.photoAddOns), status: photoPieceStatus(r.photos, { sentAt: o.photoSentAt, photographer: o.photographer, shootAt: o.shootAt }), tone: r.photos.tone });
  if (o.videos?.length) out.push(...videoPieces(o.videos, o.editor ?? null));
  else if (r.video) out.push({ key: "video", label: "Video", status: lateTail(r.video.label, r.video.tone), tone: r.video.tone });
  (r.waitingOnShoot ?? []).forEach((w, i) => out.push(waitingPiece(w, i)));
  const shootOver = r.shot !== false;
  const awaiting = new Set(o.extra?.awaitingSend ?? []);
  for (const p of [...(o.extra?.pieces ?? []), ...(o.extra?.more ?? [])]) {
    out.push({ key: `piece-${p.label}`, label: p.label, status: otherPieceStatus(p.label, p.stage, { shootOver, awaitingSend: awaiting.has(p.label) }), tone: p.stage.tone });
  }
  // What the listing read says is missing ("Floor plan: not on the listing yet") only when that piece has
  // no line of its own (an order item with no deliverable set up): said once, on its own line, never twice.
  const hasLine = (cat: string) =>
    cat === "Photos" ? !!r.photos
      : cat === "Video" ? !!r.video || !!o.videos?.length || out.some((p) => p.key.startsWith("video"))
      : out.some((p) => p.label.toLowerCase().startsWith(cat.toLowerCase()));
  for (const m of o.extra?.missing ?? []) {
    const at = m.indexOf(": ");
    const cat = at > 0 ? m.slice(0, at) : m;
    if (!cat || hasLine(cat)) continue;
    const why = at > 0 ? m.slice(at + 2) : "not on the listing yet";
    out.push({ key: `missing-${cat}`, label: cat, status: why.charAt(0).toUpperCase() + why.slice(1), tone: "waiting" });
  }
  return out;
}

// ---- the board ----------------------------------------------------------------------------------

type BoardJobLike = import("@/lib/deliveryBoard").BoardJob;

/** When THIS medium is promised: the job's ordered items in that category, or the job's own date (the office's date, a reopened job's clock or a bulk plan's batch always wins). */
function mediumDue(j: BoardJobLike, category: "Photos" | "Video", categoryLabelsForLabel: (l: string) => string[]): Date | null {
  if (j.reopened || j.dueTierLabel === "office override" || j.dueTierLabel === BATCH_TIER_LABEL) return j.dueAt;
  if (!j.dueAt) return null; // nothing outstanding, or no clock at all
  const items = j.items.filter((i): i is typeof i & { dueAt: Date } => !!i.dueAt && categoryLabelsForLabel(i.title).includes(category));
  if (items.length) return items.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b)).dueAt;
  return j.dueAt;
}

const HOLDING_KINDS = new Set(["on_hold", "handoff_incomplete", "awaiting_upload"]);

/**
 * The whole list. jobsBoard() is the dashboard's contract; the Projects page
 * reads this with `includeDelivered` for its "All" filter and `detail` for its
 * one line per piece (each video, the floor plan, the tour: a few more batched
 * reads the dashboard does not pay for). Throws when the delivery board itself
 * cannot be read (the caller shows that, never zeros).
 */
export async function shootsBoard(now: Date = new Date(), opts: { limit?: number; includeTest?: boolean; includeDelivered?: boolean; detail?: boolean } = {}): Promise<{ rows: ShootRow[]; counts: JobsBoard["counts"] }> {
  const [{ deliveryBoard }, { categoryLabelsForLabel }, ca] = await Promise.all([
    import("@/lib/deliveryBoard"),
    import("@/lib/qcCategories"),
    import("@/lib/clientAsks"),
  ]);
  const board = await deliveryBoard({ includeTest: !!opts.includeTest });
  if (board.unavailable) throw new Error("The delivery board could not be read.");
  const live = [...board.today, ...board.tomorrow, ...board.upcoming];
  const jobs = opts.includeDelivered ? [...live, ...board.delivered] : live;
  const ids = jobs.map((j) => j.id);
  if (!ids.length) return { rows: [], counts: { total: 0, late: 0, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } };

  const videoIds = jobs.filter((j) => j.video !== "n/a" || j.media.video.ordered).map((j) => j.id);
  const nearNow = Math.abs(now.getTime() - Date.now()) < 60_000;
  const [extras, photoJobs, asks, editTasks, room] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, contentMonthId: true } }),
    prisma.photoJob.findMany({ where: { projectId: { in: ids } }, select: { projectId: true, stage: true, finalsCount: true, autohdrPhotoshootId: true, deliveredAt: true } }),
    prisma.clientAsk.findMany({
      where: { projectId: { in: ids }, state: "OPEN", kind: "SPECIAL_REQUEST", source: { in: [...ca.ASK_SOURCES] } },
      select: { projectId: true, medium: true, kind: true, askedAt: true },
    }),
    videoIds.length
      ? prisma.smartTask.findMany({ where: { projectId: { in: videoIds }, taskType: "edit_video" }, orderBy: { createdAt: "desc" }, select: { projectId: true, assignedKey: true, status: true } })
      : Promise.resolve([] as { projectId: string | null; assignedKey: string | null; status: string }[]),
    // The Video Review Room's own board (read only; Home reads the same one, so a 15-second-old read is shared).
    videoIds.length
      ? import("@/lib/videoDelivery")
          .then((m) => m.videoDeliveryBoard(nearNow ? {} : { now }))
          .catch((e: unknown) => {
            console.warn("[jobs-board] video board unavailable, reading the cut states", (e as Error)?.message);
            return null;
          })
      : Promise.resolve(null),
  ]);

  // Oct 22 2026 (Jordan, 58 Recreation Dr): add-on work on the order still to
  // confirm before the photos go out ("Lot Lines needed"), from Photo Delivery.
  const addOnsOpen = await import("@/lib/photoDelivery/addOns")
    .then((m) => m.openAddOnsByProject(ids))
    .catch(() => new Map<string, string[]>());
  // Oct 22 2026 (Jordan, 538 Onward Ave): a video the order sells that the job
  // never set up is said on the row, never shown as one video (lib/videoSetup).
  const setupGaps = await import("@/lib/videoSetup")
    .then((m) => m.videoSetupGaps(ids))
    .catch(() => new Map<string, { words: string }>());
  // Oct 22 2026 (Jordan, 34 Oakland Rd): a video held for a second shoot is
  // said on the row with the office's note. One read; the slot names only for
  // the few jobs that have one.
  const waitingOnShoot = await import("@/lib/reviewCuts")
    .then(async (m) => {
      const holds = await m.waitingHoldsByProject(ids);
      const { waitingLine, plainLabel } = await import("@/lib/secondShootCore");
      const out = new Map<string, string[]>();
      for (const [pid, byKey] of holds) {
        const slots = await m.cutSlots(pid, { includeWaiting: true }).catch(() => []);
        out.set(pid, slots.flatMap((s, i) => (byKey.has(`${s.deliverableId}:${s.slot}`) ? [`Video ${i + 1} (${plainLabel(s.label)}): ${waitingLine(byKey.get(`${s.deliverableId}:${s.slot}`)!)}`] : [])));
      }
      return out;
    })
    .catch(() => new Map<string, string[]>());
  const monthlyIds = new Set(extras.filter((p) => p.contentMonthId).map((p) => p.id));
  const photoStageBy = new Map(photoJobs.map((p) => [p.projectId, p.stage]));
  // Photo audit M3 (Oct 22 2026): photo jobs in Editing whose raws the hub never saw. Oct 23 2026 (huddle item 12):
  // "in" = an upload that went on to AutoHDR (uploadState.ts), files still arriving are not. A read that fails marks none.
  const noRawsSeen = await (await import("@/lib/photoDelivery/uploadState")).waitingForUploadOf(photoJobs);
  const asksBy = new Map<string, { medium: string | null; kind: string; askedAt: Date }[]>();
  for (const a of asks) if (a.projectId) asksBy.set(a.projectId, [...(asksBy.get(a.projectId) ?? []), a]);
  // The job's editor: the open edit card's person, else the newest card's (newest first).
  const editorKeyBy = new Map<string, string>();
  const openEditCard = new Set<string>();
  for (const t of editTasks) {
    if (!t.projectId || !t.assignedKey) continue;
    const open = t.status !== "COMPLETED" && t.status !== "CANCELLED";
    if (open && !openEditCard.has(t.projectId)) {
      editorKeyBy.set(t.projectId, t.assignedKey);
      openEditCard.add(t.projectId);
    } else if (!editorKeyBy.has(t.projectId)) editorKeyBy.set(t.projectId, t.assignedKey);
  }
  const editorKeyOf = (pid: string) => editorKeyBy.get(pid) ?? null;
  const roomRows = new Map<string, { lane: string; cutStatus: string | null; stage: string; late: boolean; submissionId: string | null; deliveredAtISO: string | null }[]>();
  if (room) {
    for (const lane of Object.keys(room.lanes) as (keyof typeof room.lanes)[]) {
      for (const r of room.lanes[lane]) roomRows.set(r.projectId, [...(roomRows.get(r.projectId) ?? []), { lane: r.lane, cutStatus: r.cutStatus, stage: r.stage, late: r.late, submissionId: r.submissionId, deliveredAtISO: r.deliveredAtISO }]);
    }
  }
  // Video jobs the room's board does not list (monthly content, test clients, or the room unreadable): the cut states, one batched read.
  // With `detail` (the Projects page) every video job's: the one list of its videos, each named, sent ones too.
  const fallbackIds = videoIds.filter((id) => !roomRows.has(id));
  const stateIds = opts.detail ? videoIds : fallbackIds;
  const states = stateIds.length
    ? await import("@/lib/reviewCuts").then((m) => m.videoStatesFor(stateIds)).catch(() => new Map<string, CutStateLike>())
    : new Map<string, CutStateLike>();
  // `detail`: when each approved video reached the client (the listing, or the portal), then the floor plan, tour and the rest.
  const approvedIds = opts.detail ? [...states.values()].flatMap((s) => s.cuts).filter((c) => c.status === "APPROVED").map((c) => c.submissionId) : [];
  const sentAtOf = new Map<string, Date>();
  if (approvedIds.length) {
    const sent = await prisma.reviewSubmission
      .findMany({ where: { id: { in: approvedIds } }, select: { id: true, sentToClientAt: true, clientReleasedAt: true } })
      .catch(() => [] as { id: string; sentToClientAt: Date | null; clientReleasedAt: Date | null }[]);
    for (const x of sent) {
      const at = x.sentToClientAt ?? x.clientReleasedAt;
      if (at) sentAtOf.set(x.id, at);
    }
  }
  const others: Record<string, DeliverExtra> = opts.detail
    ? await deliverPieces(ids, now).catch((e: unknown) => {
        console.warn("[jobs-board] the other pieces could not be read", (e as Error)?.message);
        return {} as Record<string, DeliverExtra>;
      })
    : {};
  const photoSentBy = new Map(photoJobs.map((p) => [p.projectId, p.deliveredAt ?? null]));
  // The name a line says: an editor's first name, an outside shop's own name ("Cliffside Cuts").
  const lineNames = new Map<string, string | null>();
  if (opts.detail) {
    const { editorMeta } = await import("@/lib/editors");
    for (const k of new Set([...videoIds.map(editorKeyOf), ...[...states.values()].flatMap((s) => s.cuts.map((c) => c.editorKey))].filter((x): x is string => !!x))) {
      const meta = editorMeta(k);
      lineNames.set(k, meta?.kind === "external" ? meta.name : firstNameOf(meta?.name ?? k.replace(/_/g, " ")));
    }
  }
  // An editor word per key, once.
  const words = new Map<string, string | null>();
  for (const k of new Set([...videoIds.map(editorKeyOf), ...[...states.values()].flatMap((s) => s.cuts.map((c) => c.editorKey))].filter((x): x is string => !!x))) {
    words.set(k, await editorWordFor(k));
  }

  const todayKey = etDayKey(now);
  const tomorrowKey = etTomorrowKey(now); // the next ET day by key, not now + 24 h (clock-change days, Oct 28 2026)
  const weekEnd = now.getTime() + 7 * DAY;
  const rows: (ShootRow & { _rank: number; _sort: number })[] = [];
  for (const j of jobs) {
    const delivered = j.settled;
    const monthly = monthlyIds.has(j.id) || !!j.productionDate;
    const shootOver = ca.shootIsOver({ status: j.status, shootDate: j.shootDate }, now);
    const dueAt = delivered ? null : j.dueAt;
    const late = !!dueAt && dueAt.getTime() < now.getTime();

    // Photos.
    const photoJobStage = photoStageBy.get(j.id) ?? null;
    const photosOrdered = j.photos !== "n/a" || j.media.photos.ordered || !!photoJobStage;
    const photoDue = mediumDue(j, "Photos", categoryLabelsForLabel);
    const videoOrdered = j.video !== "n/a" || j.media.video.ordered;
    const photos = photosOrdered
      ? photoStageOf({
          jobStage: photoJobStage,
          shootOver,
          rawsIn: j.photos === "in" || j.photos === "some" || (j.media.photos.rawInDropbox ?? 0) > 0,
          liveOnAryeo: (j.media.photos.liveOnAryeo ?? 0) > 0,
          late: !delivered && !!photoDue && photoDue.getTime() < now.getTime(),
          reopened: j.blocker === "revision" && !videoOrdered,
          noRawsSeen: noRawsSeen.has(j.id),
        })
      : null;

    // Video.
    let video: DeliverableStage | null = null;
    if (videoOrdered) {
      const ed = words.get(editorKeyOf(j.id) ?? "") ?? null;
      const rr = roomRows.get(j.id);
      const videoDue = mediumDue(j, "Video", categoryLabelsForLabel);
      const videoLate = !delivered && !!videoDue && videoDue.getTime() < now.getTime();
      let facts: VideoFact[] = rr
        ? rr.map((r) => {
            const phase = phaseOfVideoRow(r);
            // The room reads "Not shot yet" off the job's stage; a shoot whose time has passed (the photos are often in) is not.
            return { phase: phase === "not_shot" && shootOver ? ("not_cut" as const) : phase, late: r.late && r.lane !== "delivered" };
          })
        : videoFactsFromState(states.get(j.id), { ordered: true, shootOver, late: videoLate, monthly });
      // A video-only job the client reopened: the changes are the video's.
      if (j.blocker === "revision" && !photosOrdered && facts.length && facts.every((f) => f.phase === "sent")) facts = [{ phase: "changes", late }];
      const cutEditor = states.get(j.id)?.cuts.find((c) => c.editorKey)?.editorKey ?? null;
      video = videoStageOf(facts, ed ?? (cutEditor ? words.get(cutEditor) ?? null : null)) ?? { label: shootOver ? "Not cut yet" : "Not shot yet", tone: videoLate ? "late" : "waiting" };
      if (monthly && video.label === "Ready to send") video = { label: "Approved", tone: "done" };
    }

    // THE PROJECTS PAGE'S LINES (`detail`, Oct 27 2026): every video by name
    // (the cut states' one list, the room's own row deciding an approved
    // one's lane), then the floor plan, the tour and the rest.
    let pieces: ProjectPiece[] | undefined;
    if (opts.detail) {
      const st = videoOrdered ? states.get(j.id) : undefined;
      const lines: (VideoLineFact & { order: number })[] = [];
      if (st) {
        const roomBySub = new Map((roomRows.get(j.id) ?? []).flatMap((r) => (r.submissionId ? [[r.submissionId, r] as const] : [])));
        const videoDue = mediumDue(j, "Video", categoryLabelsForLabel);
        const videoLate = !delivered && !!videoDue && videoDue.getTime() < now.getTime();
        const allLive = st.stage === "delivered";
        const slotAt = (k: string | null | undefined, fallback: number) => {
          const i = k ? (st.slotKeys ?? []).indexOf(k) : -1;
          return i >= 0 ? i : fallback;
        };
        st.cuts.forEach((c, i) => {
          const rr = roomBySub.get(c.submissionId);
          const phase: VideoPhase = rr ? phaseOfVideoRow(rr)
            : c.status === "PENDING" ? "review"
            : c.status === "CHANGES_REQUESTED" ? "changes"
            : sentAtOf.has(c.submissionId) || allLive || delivered ? "sent"
            : monthly ? "approved"
            : "ready";
          lines.push({
            key: c.submissionId, label: cleanLabel(c.cutLabel), phase, round: c.round,
            late: rr ? rr.late && rr.lane !== "delivered" : videoLate && PHASE_RANK[phase] < 5,
            sentAt: rr?.deliveredAtISO ?? sentAtOf.get(c.submissionId) ?? (phase === "sent" ? j.deliveredAt : null),
            stage: rr?.stage ?? null,
            order: slotAt(c.slotKey, 1000 + i),
          });
        });
        // Owed and not cut yet, by name. A job whose only videos wait on a second shoot owes none yet.
        const cutKeys = new Set(st.cuts.map((c) => c.slotKey).filter(Boolean));
        const uncut = (st.slotKeys ?? []).map((k, i) => ({ k, label: st.slotLabels?.[i] ?? null })).filter((x) => !cutKeys.has(x.k));
        const owed = st.owed > 0 ? st.owed : (st.waitingOnShoot ?? 0) > 0 ? 0 : 1;
        const missing = allLive ? 0 : Math.max(0, owed - st.cuts.length);
        for (let i = 0; i < missing; i++) {
          const phase: VideoPhase = !shootOver ? "not_shot" : st.stage === "editing" ? "editing" : "not_cut";
          const label = uncut[i]?.label ? cleanLabel(uncut[i].label!) : owed > 1 ? `Video ${st.cuts.length + i + 1} of ${owed}` : monthly ? "Video" : "Listing video";
          lines.push({ key: `uncut-${i}`, label, phase, round: null, late: videoLate, sentAt: null, stage: st.stage === "ready_to_edit" ? "Ready to edit" : null, order: slotAt(uncut[i]?.k, 2000 + i) });
        }
        if (!lines.length && allLive) lines.push({ key: "live", label: monthly ? "Video" : "Listing video", phase: "sent", round: null, late: false, sentAt: j.deliveredAt, order: 0 });
        lines.sort((a, b) => a.order - b.order);
      }
      const edKey = editorKeyOf(j.id) ?? st?.cuts.find((c) => c.editorKey)?.editorKey ?? null;
      pieces = projectPiecesOf(
        { photos, video, waitingOnShoot: waitingOnShoot.get(j.id) ?? [], shot: shootOver, monthly },
        {
          photoSentAt: photoSentBy.get(j.id) ?? (photos?.label === "Delivered" ? j.deliveredAt : null),
          photographer: j.photographer,
          shootAt: j.shootDate,
          videos: lines.length ? lines.map(({ order, ...v }) => (void order, v)) : null,
          editor: edKey ? lineNames.get(edKey) ?? null : null,
          extra: others[j.id] ?? null,
        },
      );
    }

    const open = (asksBy.get(j.id) ?? []).filter((a) => !ca.closesOnDelivery(a, { status: j.status, deliveredAt: j.deliveredAt }));
    const dueWords = delivered
      ? `Delivered${j.deliveredAt ? ` ${etMonthDay(j.deliveredAt)}` : ""}`
      : dueAt ? dueWordsFor(dueAt, now) : j.productionDate?.label ?? "No date yet";
    // Owed work with no clock (held, changes asked, a monthly date to check, reopened undated) rides right under the late ones.
    const owedNoClock = !dueAt && !delivered && (j.blocker === "revision" || j.blocker === "on_hold" || !!j.productionDate?.needsCheck || j.reopenedUndated);
    rows.push({
      projectId: j.id,
      street: j.title,
      client: j.client,
      dueISO: dueAt ? dueAt.toISOString() : null,
      dueWords,
      late,
      dueToday: !late && !!dueAt && etDayKey(dueAt) === todayKey,
      photos,
      video,
      requests: countRequests(open, shootOver),
      monthly,
      href: `/projects/${j.id}`,
      holding: [
        HOLDING_KINDS.has(j.blocker) || j.reopenedUndated ? (j.reopenedUndated ? `${j.blockerLabel} · reopened, no date set` : j.blockerLabel) : null,
        ...(delivered ? [] : addOnsOpen.get(j.id) ?? []),
      ].filter(Boolean).join(" · ") || null,
      delivered,
      dueThisWeek: !delivered && !!dueAt && dueAt.getTime() <= weekEnd,
      videoSetup: delivered ? null : setupGaps.get(j.id)?.words ?? null,
      waitingOnShoot: waitingOnShoot.get(j.id) ?? [],
      shot: shootOver,
      ...(pieces ? { pieces } : {}),
      _rank: delivered ? 4 : late ? 0 : owedNoClock ? 1 : dueAt ? 2 : 3,
      _sort: delivered ? -(j.deliveredAt?.getTime() ?? 0) : dueAt?.getTime() ?? 0,
    });
  }
  rows.sort((a, b) => a._rank - b._rank || a._sort - b._sort || a.street.localeCompare(b.street));
  const liveRows = rows.filter((r) => !r.delivered);
  const lateRows = liveRows.filter((r) => r.late);
  const counts: JobsBoard["counts"] = {
    total: liveRows.length,
    late: lateRows.length,
    dueToday: liveRows.filter((r) => r.dueToday).length,
    dueTomorrow: liveRows.filter((r) => !r.late && !!r.dueISO && etDayKey(new Date(r.dueISO)) === tomorrowKey).length,
    oldestLateDays: lateRows.length ? Math.max(...lateRows.map((r) => Math.max(1, Math.round((now.getTime() - Date.parse(r.dueISO!)) / DAY)))) : null,
  };
  const out: ShootRow[] = rows.map(({ _rank, _sort, ...r }) => (void _rank, void _sort, r));
  return { rows: opts.limit != null ? out.slice(0, Math.max(0, opts.limit)) : out, counts };
}

/** The Shoots page's filters. Open (the default) is everything not delivered; Due today has the late ones too (Jordan's rule); This week is due in the next 7 days, late included; Requests is every open shoot with an open client request (the dashboard's Special requests tile opens it, audit A10); All adds the last 10 days' delivered. */
export const SHOOT_FILTERS = [
  { key: "open", label: "Open" },
  // Oct 27 2026 (Jordan: "Clicking Review and Deliver should open a full job status page like the
  // shoots page ... that can show the listing and anything missing"): every job shot and not yet
  // delivered, each piece's state and what is missing. Kyle's Review & Deliver card opens it.
  { key: "deliver", label: "Review & deliver" },
  { key: "late", label: "Late" },
  { key: "today", label: "Due today" },
  { key: "week", label: "This week" },
  { key: "requests", label: "Requests" },
  { key: "monthly", label: "Monthly" },
  { key: "all", label: "All" },
] as const;
export type ShootFilter = (typeof SHOOT_FILTERS)[number]["key"];

export function filterShootRows<T extends ShootRow>(rows: T[], f: ShootFilter): T[] {
  switch (f) {
    case "deliver": return rows.filter((r) => !r.delivered && r.shot === true);
    case "late": return rows.filter((r) => !r.delivered && r.late);
    case "today": return rows.filter((r) => !r.delivered && (r.late || r.dueToday));
    case "week": return rows.filter((r) => !r.delivered && r.dueThisWeek);
    case "requests": return rows.filter((r) => !r.delivered && r.requests.open > 0);
    case "monthly": return rows.filter((r) => !r.delivered && r.monthly);
    case "all": return rows;
    default: return rows.filter((r) => !r.delivered);
  }
}

/**
 * REVIEW & DELIVER, PIECE BY PIECE (Oct 27 2026). Beyond the Photos and Video
 * chips: the floor plan and 3D tour each with its own state (on the listing,
 * marked delivered by the office, ready to check, flagged, not in yet), and
 * what is still missing in words (the status read's own `missing` and
 * `awaitingSend`, less what the office marked delivered). One batched read.
 */
export async function deliverPieces(projectIds: string[], now: Date = new Date()): Promise<Record<string, DeliverExtra>> {
  const ids = [...new Set(projectIds)].slice(0, 300);
  if (!ids.length) return {};
  const [{ parseEvidence }, projects, marks] = await Promise.all([
    import("@/lib/statusEvidence"),
    prisma.project.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, statusEvidence: true, promisedDueAt: true, deliveryDue: true,
        deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: { in: ["FLOORPLAN", "MATTERPORT_3D", "ZILLOW_3D", ...OTHER_TYPES, ...PHOTO_ADD_ON_TYPES] } }, orderBy: { createdAt: "asc" }, select: { type: true, status: true, label: true, productTitle: true } },
      },
    }),
    prisma.appSetting.findMany({ where: { key: { in: ids.flatMap((id) => [`office_delivered:${id}:floorplan`, `office_delivered:${id}:tour`]) } }, select: { key: true } }),
  ]);
  const marked = new Set(marks.map((m) => m.key));
  const out: Record<string, DeliverExtra> = {};
  for (const p of projects) {
    const ev = parseEvidence(p.statusEvidence);
    const late = !!(p.promisedDueAt ?? p.deliveryDue) && (p.promisedDueAt ?? p.deliveryDue)!.getTime() < now.getTime();
    const handMarked = (cat: "Floor plan" | "3D tour") => marked.has(`office_delivered:${p.id}:${cat === "Floor plan" ? "floorplan" : "tour"}`);
    const pieces: DeliverPiece[] = [];
    const stageOf = (ds: { status: string }[]): DeliverableStage =>
      ds.every((d) => d.status === "DONE") ? { label: "Done", tone: "done" }
        : ds.some((d) => d.status === "FLAGGED") ? { label: "Flagged", tone: "late" }
        : ds.some((d) => d.status === "UPLOADED" || d.status === "IN_PROGRESS") ? { label: "Ready to check", tone: "active" }
        : { label: "Not in yet", tone: late ? "late" : "waiting" };
    for (const cat of ["Floor plan", "3D tour"] as const) {
      const ds = p.deliverables.filter((d) => (cat === "Floor plan" ? d.type === "FLOORPLAN" : d.type === "MATTERPORT_3D" || d.type === "ZILLOW_3D"));
      if (!ds.length) continue;
      const stage: DeliverableStage = handMarked(cat) ? { label: "Marked delivered", tone: "done" }
        : ev?.present.includes(cat) ? { label: "On the listing", tone: "done" }
        : stageOf(ds);
      pieces.push({ label: cat, stage });
    }
    // Oct 27 2026 (the Projects page): anything else ordered, one line each, and the photo add-ons the Photos line names.
    const more: DeliverPiece[] = p.deliverables
      .filter((d) => (OTHER_TYPES as readonly string[]).includes(d.type))
      .map((d) => ({ label: d.type === "VIRTUAL_STAGING" ? "Virtual staging" : d.type === "HEADSHOT" ? "Headshots" : cleanLabel(d.productTitle || d.label || "Other"), stage: stageOf([d]) }));
    const photoAddOns = [...new Set(p.deliverables.filter((d) => (PHOTO_ADD_ON_TYPES as readonly string[]).includes(d.type)).map((d) => (d.type === "DRONE" ? "drone" : "twilight")))];
    const missing = [
      ...(ev?.missing ?? []).filter((c) => !((c === "Floor plan" || c === "3D tour") && handMarked(c))).map((c) => `${c}: not on the listing yet`),
      ...(ev?.awaitingSend ?? []).map((c) => `${c}: ready, not sent yet`),
    ];
    out[p.id] = { pieces, missing, more, photoAddOns, awaitingSend: (ev?.awaitingSend ?? []).filter((c) => c === "Floor plan" || c === "3D tour") };
  }
  return out;
}

/** Ordered pieces with a line of their own beyond photos, video, floor plan and tour. */
const OTHER_TYPES = ["VIRTUAL_STAGING", "HEADSHOT", "OTHER"] as const;
/** Ride with the photos (the same edit, the same delivery): named on the Photos line. */
const PHOTO_ADD_ON_TYPES = ["DRONE", "TWILIGHT"] as const;

/** THE DASHBOARD'S CONTRACT: every live job, late first then by due. Test clients left out unless `includeTest`. */
export async function jobsBoard(now: Date = new Date(), opts: { limit?: number; includeTest?: boolean } = {}): Promise<JobsBoard> {
  const b = await shootsBoard(now, { limit: opts.limit, includeTest: opts.includeTest });
  // Exactly the contract's fields (the page's extras stay on the page).
  // Live shoots only (the contract): delivered and settled rows are the page's "All" filter, never the dashboard's.
  const rows: JobRow[] = b.rows.filter((r) => !r.delivered).map((r) => ({
    projectId: r.projectId, street: r.street, client: r.client, dueISO: r.dueISO, dueWords: r.dueWords, late: r.late, dueToday: r.dueToday,
    photos: r.photos, video: r.video, requests: r.requests, monthly: r.monthly, href: r.href,
  }));
  return { rows, counts: b.counts };
}

// ---- one job: the Photos and Video cards (the job page) -----------------------------------------

export type VideoItem = {
  key: string;
  /** "Listing video", "Personal Branding Reel, Video 2 of 4". */
  label: string;
  version: number | null;
  /** "Version 2 in review", "Version 1 approved, ready to send", "Not cut yet". */
  words: string;
  phase: VideoPhase;
  late: boolean;
  /** The Review Room's player for this cut. */
  href: string | null;
  /** Ready to send: what the send button needs, from the Review Room's own row; null otherwise. `canPress` and
   *  `label` are the room's own decision (no run in the way, the hub can send this file); when the button is not
   *  offered here, the page links to the room, where a person sends it or records it done by hand. */
  send: {
    submissionId: string;
    canPress: boolean;
    label: "Upload to Aryeo and send" | "Send" | "Try again";
    /** "Upload to Aryeo only" is offered beside a fresh "Upload to Aryeo and send" (Oct 23 2026), as in the room. */
    uploadOnly: boolean;
    /** On the listing, uploaded only ("On Aryeo, not sent yet"): the row's one press is Send now. */
    sendNow: boolean;
    /** What the room says about the upload, once a person pressed it. */
    progress: string | null;
    openAsks: { summary: string; askedBy: string | null }[];
    asksUnknown: boolean;
    listingWarning: string | null;
    byHandWhy: string | null;
  } | null;
  /** "Run Topaz again" (Oct 23 2026): the Review Room's own offer, on a finished or held Topaz file not sent yet. */
  rerun?: import("@/lib/topazRerun").RerunOffer | null;
};

export type JobDeliverables = {
  projectId: string;
  street: string;
  monthly: boolean;
  shootOver: boolean;
  /** The job's next promise, the board's own: "Due Oct 15, 4 days late". */
  due: { atISO: string | null; line: string | null; late: boolean };
  photos: {
    ordered: boolean;
    stage: DeliverableStage | null;
    steps: StageStep[];
    photoJobId: string | null;
    /** Edited photos in the job; null when the photo pipeline does not have the job. */
    photoCount: number | null;
    /** Photos with an open QC finding. */
    flagged: number;
    href: string | null;
  };
  video: {
    ordered: boolean;
    stage: DeliverableStage | null;
    steps: StageStep[];
    items: VideoItem[];
    /** The job's video editor (first name), or null. */
    editor: string | null;
    href: string;
  };
};

const cleanLabel = (s: string) => s.replace(/\s+[—–]\s+/g, ", ");

/**
 * The two cards on one job page. A handful of small reads for this job only:
 * the dates come from the delivery board's own promise engine (the same
 * per-product promises, the office's date, a reopened job's clock), so the
 * card and the Shoots row agree; the Video Review Room's board is read only
 * when a listing video has been approved (where it stands and the send
 * button), and that read is shared with Home for 15 seconds.
 */
export async function jobDeliverables(projectId: string, now: Date = new Date()): Promise<JobDeliverables | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, clientId: true, title: true, status: true, shootDate: true, deliveredAt: true, revisionRequestedAt: true, contentMonthId: true, packageName: true, statusEvidence: true,
      dueOverrideAt: true, overrideAt: true, tierOverride: true, promisedDueAt: true, promisedReason: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, status: true, uploadedAt: true } },
      appointments: { orderBy: { startAt: "asc" }, select: { id: true, startAt: true, endAt: true, durationMin: true, status: true } },
      editor: { select: { name: true } },
    },
  });
  if (!p) return null;
  const [{ shootIsOver }, { isMonthlyContentJob }, { parseEvidence }, db, { categoryLabelsForLabel }, { turnaroundRules }] = await Promise.all([
    import("@/lib/clientAsks"), import("@/lib/pipeline"), import("@/lib/statusEvidence"), import("@/lib/deliveryBoard"), import("@/lib/qcCategories"), import("@/lib/settings"),
  ]);
  const monthly = !!p.contentMonthId || isMonthlyContentJob(p.deliverables, p.packageName);
  const last = [...p.appointments].reverse().find((a) => a.startAt);
  const endAt = last?.endAt ?? (last?.startAt && last.durationMin ? new Date(last.startAt.getTime() + last.durationMin * 60_000) : null);
  const shootOver = shootIsOver({ status: p.status, shootDate: p.shootDate ?? last?.startAt ?? null, endAt }, now);
  const ev = parseEvidence(p.statusEvidence);
  const isIn = (d: { uploadedAt: Date | null; status: string }) => !!d.uploadedAt || d.status === "DONE" || d.status === "UPLOADED";
  const photoRows = p.deliverables.filter((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
  const videoRows = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");

  const [photoJob, states, editTasks, sent, turnarounds, clocks, dueSet, batches] = await Promise.all([
    prisma.photoJob.findUnique({ where: { projectId }, select: { id: true, stage: true, finalsCount: true, autohdrPhotoshootId: true } }),
    import("@/lib/reviewCuts").then((m) => m.videoStatesFor([projectId])).catch(() => new Map<string, CutStateLike>()),
    prisma.smartTask.findMany({ where: { projectId, taskType: "edit_video" }, orderBy: { createdAt: "desc" }, take: 10, select: { assignedKey: true, status: true } }),
    prisma.reviewSubmission.findMany({ where: { projectId, status: "APPROVED", sentToClientAt: { not: null } }, select: { id: true, sentToClientAt: true } }),
    turnaroundRules().catch(() => undefined),
    p.deliveredAt ? db.reopenedClocksFor([projectId]) : Promise.resolve(new Map<string, import("@/lib/deliveryBoard").ReopenedClock>()),
    p.deliveredAt && p.dueOverrideAt ? db.dueSetTimesFor([projectId]) : Promise.resolve(new Map<string, Date>()),
    import("@/lib/bulkBatches").then((m) => m.batchDuesFor([projectId])).catch(() => new Map<string, { at: Date; aimAt: Date | null }>()),
  ]);

  // ---- the dates: the board's engine, per medium ----
  const promise = db.outstandingPromise({ ...p, reopenedClock: clocks.get(projectId) ?? null, dueSetAt: dueSet.get(projectId) ?? null, batchDue: batches.get(projectId) ?? null }, { now, turnarounds, evidence: ev });
  const items0 = db.boardItems(p, now, turnarounds);
  const dueOf = (category: "Photos" | "Video"): Date | null => {
    if (promise.reopened || promise.office || promise.tierLabel === BATCH_TIER_LABEL) return promise.at;
    if (!promise.at) return null; // nothing outstanding (settled), or no clock at all
    const its = items0.filter((i): i is typeof i & { dueAt: Date } => !!i.dueAt && categoryLabelsForLabel(i.title).includes(category));
    return its.length ? its.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b)).dueAt : promise.at;
  };
  const pastDue = (d: Date | null) => !!d && d.getTime() < now.getTime();

  // ---- photos ----
  const [photoCount, flagged] = photoJob
    ? await Promise.all([
        // Oct 22 2026: a split job counts the photos already on the listing too (59 on 615 Cliff Ln, not 35).
        prisma.photoAsset.count({ where: { jobId: photoJob.id, status: { in: ["ACTIVE", "ON_LISTING"] } } }),
        (async () => {
          // "Flagged" = photos with an open QC issue, counted the photo job page's way (qc/verdict.groupFindings):
          // the display floor, checks switched off house-wide or for this client left out, add-on suggestions too.
          // Once the photos are delivered, what QC left open is history (a change now is a revision): not counted.
          if (photoJob.stage === "DELIVERED") return 0;
          const [{ photoDeliverySettings }, { houseOverrides, mergeOverrides }, { groupFindings }] = await Promise.all([
            import("@/lib/photoDelivery/settings"), import("@/lib/photoDelivery/houseRules"), import("@/lib/photoDelivery/qc/verdict"),
          ]);
          const [settings, house, profile, findings, excluded] = await Promise.all([
            photoDeliverySettings().catch(() => null),
            houseOverrides().catch(() => []),
            prisma.clientQcProfile.findUnique({ where: { clientId: p.clientId }, select: { ruleOverridesJson: true } }).catch(() => null),
            prisma.photoQcFinding.findMany({
              where: { jobId: photoJob.id, status: "OPEN" },
              select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, source: true },
            }),
            prisma.photoAsset.findMany({ where: { jobId: photoJob.id, status: { not: "ACTIVE" } }, select: { id: true } }),
          ]);
          let own: import("@/lib/photoDelivery/registry").RuleOverride[] = [];
          try {
            const parsed = JSON.parse(profile?.ruleOverridesJson ?? "[]") as unknown;
            if (Array.isArray(parsed)) own = parsed.filter((o): o is import("@/lib/photoDelivery/registry").RuleOverride => !!o && typeof (o as { ruleId?: unknown }).ruleId === "string");
          } catch { /* none */ }
          const { groups } = groupFindings(findings, { floor: settings?.displayConfidenceFloor, overrides: mergeOverrides(house, own), excludedPhotoIds: excluded.map((x) => x.id) });
          return new Set(groups.flatMap((g) => g.photoIds)).size;
        })(),
      ])
    : [null, 0];
  const photosOrdered = photoRows.length > 0 || !!photoJob;
  const photoFacts: PhotoFacts = {
    jobStage: photoJob?.stage ?? null,
    shootOver,
    rawsIn: photoRows.some(isIn) || (ev?.dropbox?.rawPhotos ?? 0) > 0,
    liveOnAryeo: (ev?.aryeo?.photos ?? 0) > 0,
    late: pastDue(dueOf("Photos")),
    reopened: (p.status === "REVISION" || (!!p.revisionRequestedAt && (!p.deliveredAt || p.revisionRequestedAt > p.deliveredAt))) && videoRows.length === 0,
    // Photo audit M3 (Oct 22 2026): in Editing with no raws ever seen and no photos read.
    // Oct 23 2026 (huddle item 12): files still arriving are not in yet (uploadState.ts).
    noRawsSeen: photoJob ? (await (await import("@/lib/photoDelivery/uploadState")).waitingForUploadOf([{ projectId, ...photoJob }])).has(projectId) : false,
  };

  // ---- video ----
  const st = states.get(projectId) ?? null;
  const open = editTasks.find((t) => t.assignedKey && t.status !== "COMPLETED" && t.status !== "CANCELLED");
  const editorKey = (open ?? editTasks.find((t) => t.assignedKey))?.assignedKey ?? st?.cuts.find((c) => c.editorKey)?.editorKey ?? null;
  const editor = (await editorWordFor(editorKey)) ?? (p.editor?.name ? p.editor.name.trim().split(/\s+/)[0] : null);
  const videoOrdered = videoRows.length > 0 || (st?.owed ?? 0) > 0;
  const videoLate = pastDue(dueOf("Video"));
  const sentAt = new Map(sent.map((s) => [s.id, s.sentToClientAt!]));
  // The Video Review Room's own row for an approved listing cut (ready to send, held, in the 1080p pass, sent this
  // week) decides where it stands, exactly as the room shows it, and carries what the send button needs.
  const roomRow = new Map<string, { lane: string; late: boolean; send: VideoItem["send"]; stage: string; uploadedOnly: boolean; rerun: VideoItem["rerun"] }>();
  if (!monthly && (st?.cuts ?? []).some((c) => c.status === "APPROVED")) {
    const room = await import("@/lib/videoDelivery")
      .then((m) => m.videoDeliveryBoard(Math.abs(now.getTime() - Date.now()) < 60_000 ? {} : { now }))
      .catch(() => null);
    for (const lane of ["sending", "held", "finishing", "delivered"] as const) {
      for (const r of room?.lanes[lane] ?? []) {
        if (r.projectId !== projectId || !r.submissionId) continue;
        const label = r.push?.canRetry ? "Try again" as const : r.send?.uploaded ? "Send" as const : "Upload to Aryeo and send" as const;
        roomRow.set(r.submissionId, {
          lane,
          late: r.late,
          stage: r.stage,
          uploadedOnly: !!r.push?.uploadedOnly,
          rerun: r.rerun ?? null,
          // The room's ReadyRow rule (review/page.tsx): the button only when the hub can send this file and no run is in the way.
          send: r.send
            ? {
                submissionId: r.submissionId,
                canPress: !r.send.byHandWhy && !!r.push?.canStart,
                label,
                // The same choice as the room (Oct 23 2026): Upload to Aryeo only beside a fresh press; Send now once it is up.
                uploadOnly: label === "Upload to Aryeo and send",
                sendNow: !!r.push?.uploadedOnly && r.push.canDeliverNow,
                progress: r.push && (r.push.state || r.send.uploaded) ? r.push.says : null,
                openAsks: r.send.openAsks,
                asksUnknown: r.send.asksUnknown,
                listingWarning: r.send.listingWarning,
                byHandWhy: r.send.byHandWhy,
              }
            : null,
        });
      }
    }
  }
  const allLive = st?.stage === "delivered";
  const items: VideoItem[] = [];
  for (const c of st?.cuts ?? []) {
    const rr = roomRow.get(c.submissionId);
    const phase: VideoPhase =
      c.status === "PENDING" ? "review"
      : c.status === "CHANGES_REQUESTED" ? "changes"
      : rr ? phaseOfVideoRow({ lane: rr.lane, cutStatus: "APPROVED", stage: rr.stage })
      : sentAt.has(c.submissionId) || allLive ? "sent"
      : monthly ? "approved"
      : "ready";
    const v = `Version ${c.round}`;
    const sentOn = sentAt.get(c.submissionId);
    const words =
      phase === "review" ? `${v} in review`
      : phase === "changes" ? `${v}, changes asked`
      : phase === "sent" ? `${v} sent${sentOn ? ` ${etMonthDay(sentOn)}` : ""}`
      : phase === "finishing" ? `${v} approved, in the Topaz pass`
      : phase === "held" ? `${v} approved, the Topaz file is held (check the sound)`
      : phase === "approved" ? `${v} approved, goes to the client's portal`
      : rr?.uploadedOnly ? `${v} on Aryeo, not sent yet`
      : `${v} approved, ready to send`;
    items.push({
      key: c.submissionId, label: cleanLabel(c.cutLabel), version: c.round, words, phase,
      late: phase !== "sent" && (rr ? rr.late : videoLate && PHASE_RANK[phase] < 5),
      href: `/review/${projectId}?cut=${c.submissionId}`,
      send: phase === "ready" ? rr?.send ?? null : null,
      rerun: phase === "ready" || phase === "held" ? rr?.rerun ?? null : null,
    });
  }
  const owed = Math.max(st?.owed ?? 0, videoOrdered ? 1 : 0);
  const missing = allLive ? 0 : Math.max(0, owed - items.length);
  for (let i = 0; i < missing; i++) {
    const phase: VideoPhase = !shootOver ? "not_shot" : st?.stage === "editing" ? "editing" : "not_cut";
    items.push({
      key: `uncut-${i}`, label: owed > 1 ? `Video ${items.length + 1} of ${owed}` : monthly ? "Video" : "Listing video", version: null,
      words: phase === "not_shot" ? "Not shot yet" : phase === "editing" ? `Editing${editor ? ` · ${editor}` : ""}` : `Not cut yet${editor ? ` · ${editor}` : ""}`,
      phase, late: videoLate, href: null, send: null,
    });
  }
  const facts: VideoFact[] = items.map((i) => ({ phase: i.phase, late: i.late }));
  let videoStage = videoOrdered ? videoStageOf(facts, editor) : null;
  if (videoStage && monthly && videoStage.label === "Ready to send") videoStage = { label: "Approved", tone: "done" };

  return {
    projectId,
    street: (p.title || "Untitled job").split(",")[0].trim(),
    monthly,
    shootOver,
    due: { atISO: promise.at ? promise.at.toISOString() : null, line: dueLineFor(promise.at, now), late: pastDue(promise.at) },
    photos: {
      ordered: photosOrdered,
      stage: photosOrdered ? photoStageOf(photoFacts) : null,
      steps: photosOrdered ? photoStepsOf(photoFacts) : [],
      photoJobId: photoJob?.id ?? null,
      photoCount: photoJob ? photoCount || photoJob.finalsCount || 0 : null,
      flagged: flagged ?? 0,
      href: photoJob ? `/ops/photo-delivery/${photoJob.id}` : null,
    },
    video: {
      ordered: videoOrdered,
      stage: videoStage,
      steps: videoOrdered ? videoStepsOf(facts, monthly) : [],
      items: videoOrdered ? items : [],
      editor,
      href: `/review/${projectId}`,
    },
  };
}
