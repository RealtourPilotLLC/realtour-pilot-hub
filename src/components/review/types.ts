// ---------------------------------------------------------------------------
// Shared types + tiny pure helpers for the media review room UI. ReviewNote
// mirrors src/lib/review's ReviewNote EXACTLY (structural
// match) so the ListingMedia server wrapper can pass getProjectReview() output
// straight through WITHOUT client code ever importing the server-only read
// layer (importing "@/lib/review" from a client component would throw via its
// "server-only" guard).
// ---------------------------------------------------------------------------

export type ReviewLane = "EDIT" | "PHOTOGRAPHER";
export type ReviewKind = "fix" | "coaching";
export type ReviewStatus = "OPEN" | "FIXED" | "RESOLVED";
export type ReviewVerdict = "APPROVED" | "NEEDS_WORK";

export type ReviewReply = { id: string; body: string; authorName: string | null; createdAt: string };

export type ReviewNote = {
  id: string;
  assetUrl: string;
  thumbUrl: string | null;
  assetType: "image" | "video";
  x: number | null;
  y: number | null;
  timeSec: number | null;
  lane: ReviewLane;
  kind: ReviewKind;
  body: string;
  status: ReviewStatus;
  authorName: string | null;
  createdAt: string;
  replies: ReviewReply[];
};

// What ListingMedia hands MediaGallery when the viewer may review (owner/admin
// only — creatives never receive this prop, so EDIT-lane content can't leak).
export type ReviewData = {
  notes: ReviewNote[];
  verdicts: Record<string, ReviewVerdict>;
  enabled: boolean;
};

// The three one-tap routing choices when writing a note. EDIT is always a fix
// (the server coerces kind to "fix" on that lane anyway); PHOTOGRAPHER splits
// actionable fixes from do-better-next-time coaching.
export const LANE_CHOICES: { lane: ReviewLane; kind: ReviewKind; label: string }[] = [
  { lane: "EDIT", kind: "fix", label: "Kyle — fix" },
  { lane: "PHOTOGRAPHER", kind: "fix", label: "Photographer — fix" },
  { lane: "PHOTOGRAPHER", kind: "coaching", label: "Photographer — coaching" },
];

// Pin/dot fill per status: open = brand orange, fixed = green (awaiting
// re-review), resolved = grey (kept only as history).
export const STATUS_BG: Record<ReviewStatus, string> = {
  OPEN: "bg-brand",
  FIXED: "bg-success",
  RESOLVED: "bg-muted-2",
};

// Matching soft chip styles for status labels in thread headers.
export const STATUS_CHIP: Record<ReviewStatus, string> = {
  OPEN: "bg-brand-soft text-brand",
  FIXED: "bg-success-soft text-success",
  RESOLVED: "bg-surface-2 text-muted",
};

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  OPEN: "Open",
  FIXED: "Fixed",
  RESOLVED: "Approved",
};

// mm:ss for video timestamps (timeSec is stored as float seconds).
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Parse a hand-typed "m:ss" or plain-seconds string into seconds, else null —
// the graceful-degradation path for videos with no playable source.
export function parseClock(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const m = t.match(/^(\d+):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return /^\d+$/.test(t) ? parseInt(t, 10) : null;
}

// ---------------------------------------------------------------------------
// WRONG VIDEO — the remove / move controls (Jordan, Sep 16: "I want the editor
// to be able to remove the video from upload / for review in case they
// mistakenly upload the wrong video or to the wrong project. It would also be
// cool if they could reassign that video to a different project" — and, that
// evening, "When removing the cut, I want it to remove completely.")
//
// Plain data on purpose: the server action (src/app/review/actions.ts) imports
// these as TYPES ONLY, and the client components render them — neither side
// pulls the other's runtime in.
// ---------------------------------------------------------------------------

/** One cut's remove/move state, plus what THIS viewer may do about it. */
export type CutTakeBackInfo = {
  submissionId: string;
  round: number;
  /** UPLOADING | PENDING | CHANGES_REQUESTED | APPROVED | SUPERSEDED | WITHDRAWN
   *  (WITHDRAWN only ever on rows written the afternoon of Sep 16, before a
   *  take-back started deleting — they must still render.) */
  status: string;
  fileName: string | null;
  /** the viewer may REMOVE this version outright (the editor who sent it, or
   *  the office; an approved cut is the office's alone) */
  canRemove: boolean;
  /** the viewer may MOVE it to another job — narrower: an old round is
   *  removable but has no business becoming the cut waiting on another job */
  canMove: boolean;
  /** the viewer is OWNER/ADMIN — the only people who may touch the Dropbox file */
  office: boolean;
  /** an approved cut's copy in the job's Final folder, so the confirm can name
   *  exactly what the Dropbox checkbox would delete */
  finalPath: string | null;
  /** the OTHER kind of Dropbox file (Sep 16): a folder-discovered cut's own
   *  source file — the editor's export, already in 05-Final-Video, which is
   *  where the row came from. Never deleted by a removal (it isn't a copy the
   *  hub made), so the confirm has to say it stays rather than let "this
   *  deletes the version and its file" read as a promise it can't keep. */
  folderSourcePath: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawnReason: string | null;
  /** the approved cut's file, still sitting in the job's Final folder after an
   *  afternoon-of-Sep-16 withdrawal (a removal records it as a SmartTask
   *  instead — the row it used to hang off is deleted) */
  strandedFinalPath: string | null;
  movedFromStreet: string | null;
  movedAt: string | null;
  movedBy: string | null;
};

/** One row in the "Move to another job" picker. */
export type CutMoveOption = {
  projectId: string;
  street: string;
  clientName: string | null;
  status: string;
  shootDateISO: string | null;
};
