import "server-only";
import type { Prisma } from "@prisma/client";
import {
  EDIT_PRIORITIES,
  EDIT_TIERS,
  type EditComputedView,
  type EditOverrideView,
  type EditPriority,
  type EditTier,
} from "@/lib/editOverrideDefaults";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// THE OFFICE'S OVERRIDES on a video job (Jordan, Sep 13: "I want to be able to
// change the status, amount of deliverables, the due date and all other
// information for the edits in the editing room. I want to be able to
// override anything.").
//
// The nine columns after Project.videosFilmed are HUB-OWNED: no sweep, sync or
// reconciler ever writes them, and every reader prefers them over the value
// it would have computed. This module is the one place that reads them, so
// the queue row, the edit card, the cut slots, the delivery board, the QC card
// and the status sweep all say the same thing about the same job:
//   · effectiveX(p, computed)   — the override when set, else the hub's value
//   · statusPinned(p)           — while true, no ENGINE may write Project.status
//   · overrideView(p)           — what the office set, for the dialog / the chip
//   · describeOverrides(...)    — the one timeline sentence a save writes
// The words (labels, tiers, priorities, the view shapes) live in
// src/lib/editOverrideDefaults.ts, which imports nothing so the client-side
// dialog can share them.
// ---------------------------------------------------------------------------

/** The Prisma select fragment for the override columns (+ videosFilmed, which
 *  the videos-owed ladder falls back to). Spread it into any project read
 *  that will call the helpers below. */
export const OVERRIDE_SELECT = {
  statusPinnedAt: true,
  dueOverrideAt: true,
  videosOwedOverride: true,
  tierOverride: true,
  typeDetailOverride: true,
  priorityOverride: true,
  overrideBy: true,
  overrideAt: true,
  overrideNote: true,
  videosFilmed: true,
} as const satisfies Prisma.ProjectSelect;

/** A project row carrying the override columns (what OVERRIDE_SELECT returns,
 *  or a full Project). */
export type OverrideProject = {
  statusPinnedAt: Date | null;
  dueOverrideAt: Date | null;
  videosOwedOverride: number | null;
  tierOverride: string | null;
  typeDetailOverride: string | null;
  priorityOverride: string | null;
  overrideBy: string | null;
  overrideAt: Date | null;
  overrideNote: string | null;
  videosFilmed: number | null;
};

const isTier = (s: string | null | undefined): s is EditTier => !!s && (EDIT_TIERS as readonly string[]).includes(s);
const isPriority = (s: string | null | undefined): s is EditPriority => !!s && (EDIT_PRIORITIES as readonly string[]).includes(s);

/** While the office has pinned the status, the hourly status sweep, the folder
 *  sweep, the per-project recheck and the Aryeo sync leave Project.status
 *  alone (CANCELLED from Aryeo is the one exception — it clears the pin). A
 *  human status write (the queue pill, the pipeline board, the dialog itself)
 *  clears or renews it. */
export function statusPinned(p: { statusPinnedAt: Date | null }): boolean {
  return !!p.statusPinnedAt;
}

/** True when ANY override or the pin is set — the row's "Override" chip. */
export function anyOverrideSet(p: Omit<OverrideProject, "overrideBy" | "overrideAt" | "overrideNote" | "videosFilmed">): boolean {
  return (
    !!p.statusPinnedAt ||
    !!p.dueOverrideAt ||
    p.videosOwedOverride != null ||
    !!p.tierOverride ||
    !!p.typeDetailOverride ||
    !!p.priorityOverride
  );
}

/** What the office set, for the dialog and the row chip. null on a field = no
 *  override there. Unknown tier/priority text on the column (a hand edit in
 *  Studio) reads as no override rather than a value the dialog can't select. */
export function overrideView(p: OverrideProject): EditOverrideView {
  return {
    statusPinned: statusPinned(p),
    dueAt: p.dueOverrideAt ? p.dueOverrideAt.toISOString() : null,
    // A 0 on the column (a hand edit in Studio) is no override, exactly as
    // effectiveVideosOwed reads it — never "0 videos owed" on the chip.
    videosOwed: p.videosOwedOverride != null && p.videosOwedOverride > 0 ? p.videosOwedOverride : null,
    tier: isTier(p.tierOverride) ? p.tierOverride : null,
    typeDetail: p.typeDetailOverride?.trim() || null,
    priority: isPriority(p.priorityOverride) ? p.priorityOverride : null,
    by: p.overrideBy ?? null,
    at: p.overrideAt ? p.overrideAt.toISOString() : null,
    note: p.overrideNote?.trim() || null,
  };
}

type VideoRow = { type: string; quantity?: number | null };
const isVideoRow = (d: { type: string }) => d.type === "VIDEO" || d.type === "SOCIAL_REEL";

/** The hub's own videos-owed ladder (no override): the photographer's count
 *  from the upload wrap-up, else the order rows' batch size (a monthly plan is
 *  ONE row whose quantity is the batch — the sweep heals it up to the plan
 *  quota). Exported so the queue row's `computed` cell can show it. */
export function computedVideosOwed(p: { videosFilmed: number | null }, deliverables: VideoRow[]): number {
  const fromRows = deliverables.filter(isVideoRow).reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
  return p.videosFilmed ?? fromRows;
}

/** How many videos this job owes: the office's number when set, else the
 *  hub's ladder above. Wins over videosFilmed and the order quantity
 *  EVERYWHERE — queue cell, cut slots, the approved-cut gate, the monthly
 *  delivery-text quota. */
export function effectiveVideosOwed(
  p: { videosOwedOverride: number | null; videosFilmed: number | null },
  deliverables: VideoRow[],
): number {
  if (p.videosOwedOverride != null && p.videosOwedOverride > 0) return p.videosOwedOverride;
  return computedVideosOwed(p, deliverables);
}

/** Per-video-row cut counts for the slot builders (reviewCuts.cutSlots and its
 *  pure twin). `baseCounts` is what each row would owe on the hub's own rule
 *  (quantity, with the monthly batch on the first row); with an override the
 *  office's TOTAL lands on the first video row and every other row keeps one
 *  cut, so the slots add up to the number the office typed. Nearly every job
 *  has a single video row, where this is simply "first row = the override". */
export function effectiveSlotCounts(p: { videosOwedOverride: number | null }, baseCounts: number[]): number[] {
  const override = p.videosOwedOverride;
  if (override == null || override <= 0 || baseCounts.length === 0) return baseCounts;
  const others = baseCounts.length - 1;
  // Fewer videos than video rows (a three-row job the office cut to two):
  // the first `override` rows owe one cut each and the rest owe none, so the
  // slots still add up to the office's number — the count the queue cell,
  // the Completed gate and the handoff all read (review, Sep 13). Both slot
  // builders loop `slot <= count`, so a 0 simply makes no slot.
  if (override <= others) return baseCounts.map((_, i) => (i < override ? 1 : 0));
  return baseCounts.map((_, i) => (i === 0 ? override - others : 1));
}

/** The delivery due: the office's date when set, else what the turnaround
 *  engine computed (Project.deliveryDue on the row, the SLA elsewhere). */
export function effectiveDue(p: { dueOverrideAt: Date | null }, computed: Date | null): Date | null {
  return p.dueOverrideAt ?? computed;
}

export function effectiveTier(p: { tierOverride: string | null }, computed: EditTier): EditTier {
  return isTier(p.tierOverride) ? p.tierOverride : computed;
}

export function effectiveTypeDetail(p: { typeDetailOverride: string | null }, computed: string): string {
  const t = p.typeDetailOverride?.trim();
  return t || computed;
}

/** Priority for the queue row and the edit card. `computed` is whatever the
 *  caller would have written (Project.priority, or the task engine's
 *  computePriority — which speaks MEDIUM; that reads as NORMAL here). */
export function effectivePriority(p: { priorityOverride: string | null }, computed: string): EditPriority {
  if (isPriority(p.priorityOverride)) return p.priorityOverride;
  if (isPriority(computed)) return computed;
  // The task engine's MEDIUM (and any stray word) is the queue's NORMAL.
  return "NORMAL";
}

/** The queue row's "what the hub would say on its own" — every value BEFORE
 *  the overrides are applied. Built by editorQueue for each row. */
export function computedView(v: {
  dueAt: Date | null;
  videosOwed: number;
  tier: EditTier;
  typeDetail: string;
  priority: string;
}): EditComputedView {
  return {
    dueAt: v.dueAt ? v.dueAt.toISOString() : null,
    videosOwed: v.videosOwed,
    tier: v.tier,
    typeDetail: v.typeDetail,
    priority: effectivePriority({ priorityOverride: null }, v.priority),
  };
}

// ---------------------------------------------------------------------------
// THE TIMELINE SENTENCE. One Activity row per save, in the shape
//   "Override by Jordan Spackman: status In editing → Waiting (pinned) ·
//    due Tue, Sep 15, 5:00 PM (was Mon, Sep 14, 5:00 PM) · videos owed 4 → 6
//    · note: rush for the open house"
// `before` and `after` are the job's EFFECTIVE values either side of the save
// (the label the row reads, the due it shows, the count it owes), so a reset
// to the hub's value reads as a change back, not as nothing.
// ---------------------------------------------------------------------------
export type OverrideSnapshot = {
  /** the queue ladder's label — "In editing", "Waiting", … */
  status: string;
  pinned: boolean;
  /** the editor's display name, "External agency", or null for nobody */
  editor: string | null;
  dueAt: Date | null;
  videosOwed: number;
  tier: EditTier;
  typeDetail: string;
  priority: EditPriority;
  note: string | null;
};

const TIER_WORD: Record<EditTier, string> = { standard: "Standard", premium: "Premium", branding: "Personal Branding" };
const PRIORITY_WORD: Record<EditPriority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
const fmtDue = (d: Date | null) => (d ? etDateTime(d) : "no date");
const sameInstant = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export function describeOverrides(before: OverrideSnapshot, after: OverrideSnapshot, by: string): string {
  const parts: string[] = [];
  if (before.status !== after.status) {
    parts.push(`status ${before.status} → ${after.status}${after.pinned ? " (pinned)" : ""}`);
  } else if (before.pinned !== after.pinned) {
    parts.push(after.pinned ? `status pinned on ${after.status}` : `status unpinned — the hub manages it again`);
  }
  if ((before.editor ?? null) !== (after.editor ?? null)) {
    parts.push(`editor ${before.editor ?? "nobody"} → ${after.editor ?? "nobody"}`);
  }
  if (!sameInstant(before.dueAt, after.dueAt)) {
    parts.push(`due ${fmtDue(after.dueAt)} (was ${fmtDue(before.dueAt)})`);
  }
  if (before.videosOwed !== after.videosOwed) {
    parts.push(`videos owed ${before.videosOwed} → ${after.videosOwed}`);
  }
  if (before.tier !== after.tier) {
    parts.push(`tier ${TIER_WORD[before.tier]} → ${TIER_WORD[after.tier]}`);
  }
  if (before.typeDetail !== after.typeDetail) {
    parts.push(`video type “${before.typeDetail || "—"}” → “${after.typeDetail || "—"}”`);
  }
  if (before.priority !== after.priority) {
    parts.push(`priority ${PRIORITY_WORD[before.priority]} → ${PRIORITY_WORD[after.priority]}`);
  }
  const note = after.note?.trim();
  if (note && note !== (before.note?.trim() ?? "")) parts.push(`note: ${note.slice(0, 200)}`);
  if (parts.length === 0) return `Override saved by ${by} — nothing changed.`;
  return `Override by ${by}: ${parts.join(" · ")}`;
}
