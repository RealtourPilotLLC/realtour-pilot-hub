// ---------------------------------------------------------------------------
// Shared types + tiny pure helpers for the media review room UI (Frame.io-
// style). ReviewNote mirrors src/lib/review's ReviewNote EXACTLY (structural
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
