// QC checklist vocabulary — the labels a media_qa card is built from, and the
// pure "which media category does this row belong to" read that the card, the
// home, the reconciler and the one-press "Photos done" all share.
//
// Client-safe on purpose (no prisma, no settings, no server imports): the
// /tasks card is a client component and needs the same classification the
// server uses, and a second copy of these label lists is exactly how the
// isEvidenceRow twin in TaskCard.tsx drifted before. tasks.ts re-exports
// everything here so server callers keep their old import path.
//
// Labels are STABLE strings: the reconciler merges Kyle's ticks by label, so
// changing a word here silently drops every tick on every open card.

import { QC_LABEL_REMOVALS, QC_LABEL_VIDEO_BRIEF } from "@/lib/debrief";

// Friendly per-deliverable label for the consolidated QC checklist ("QC Photos",
// "QC Reel", "QC Zillow 3D tour", …).
export const QC_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Drone / aerial", TWILIGHT: "Twilight", HEADSHOT: "Headshots",
  VIRTUAL_STAGING: "Virtual staging", VIDEO: "Video", SOCIAL_REEL: "Reel",
  FLOORPLAN: "Floor plan", MATTERPORT_3D: "Matterport 3D", ZILLOW_3D: "Zillow 3D tour", OTHER: "Other",
};

// Media category label for a deliverable type — mirrors CATEGORY_LABEL in
// projectStatus.ts (kept here to avoid a circular import). Lets us tell, from a
// project's status evidence (which lists present/missing by category label),
// whether a given ordered deliverable is already live on Aryeo.
export const TYPE_CATEGORY_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Photos", TWILIGHT: "Photos", HEADSHOT: "Photos", VIRTUAL_STAGING: "Photos",
  VIDEO: "Video", SOCIAL_REEL: "Video",
  FLOORPLAN: "Floor plan",
  MATTERPORT_3D: "3D tour", ZILLOW_3D: "3D tour",
};

/** The four media categories a job can owe, in the order the card lists them. */
export type QcCategory = "Photos" | "Video" | "Floor plan" | "3D tour";
export const QC_CATEGORIES: QcCategory[] = ["Photos", "Video", "Floor plan", "3D tour"];

// Media category KEY → the label the status evidence lists in present/missing.
// The delivery board kept a private copy of this three lines above the import
// that needed it (review, Sep 16) — it lives here now, next to the rest of the
// category vocabulary, and the board reads it from here.
export type MediaCategoryKey = "PHOTOS" | "VIDEO" | "FLOORPLAN" | "THREED";
export const MEDIA_CATEGORY_LABEL: Record<MediaCategoryKey, QcCategory> = {
  PHOTOS: "Photos", VIDEO: "Video", FLOORPLAN: "Floor plan", THREED: "3D tour",
};

// Product-name keywords → the categories that line item implies. A single line
// item can imply several ("Gold Package + Video + Floor Plan"), so we scan for
// ALL matches; photos last and broad, because packages/bundles/tiers and every
// photo add-on are delivered as listing images.
//
// ⚠️ projectStatus.ts carries the same table (CATEGORY_KEYWORDS) for the status
// engine's expectedCategories; it is server-only and out of this batch's file
// set, so the two still have to be changed together until its owner folds it
// into this one. The board's read fails SAFE if they ever drift: an item this
// parser can't classify stays OUTSTANDING (we can't prove it was delivered).
const CATEGORY_KEYWORDS: [RegExp, MediaCategoryKey][] = [
  [/floor\s?plan|2d plan|iguide/i, "FLOORPLAN"],
  [/matterport|3d tour|3-d|zillow 3d|virtual tour|interactive tour/i, "THREED"],
  [/reel|video|cinematic|walkthrough|walk-through|motion|social media|teaser|vertical/i, "VIDEO"],
  [/photo|hdr|image|gallery|package|bundle|bronze|silver|gold|platinum|diamond|essential|twilight|dusk|drone|aerial|headshot|portrait|virtual stag/i, "PHOTOS"],
];

/** The evidence LABELS a product name implies ("Standard Package + Reel" →
 *  Photos, Video) — what a caller comparing against statusEvidence needs. */
export function categoryLabelsForLabel(label: string): QcCategory[] {
  const out: QcCategory[] = [];
  for (const [re, key] of CATEGORY_KEYWORDS) {
    const l = MEDIA_CATEGORY_LABEL[key];
    if (re.test(label) && !out.includes(l)) out.push(l);
  }
  return out;
}

// Guided QC failure modes — the SPECIFIC things Kyle must actually eyeball before
// a category ships. These exist because QC was blind: his written guidance was one
// static sentence and the checklist had nothing to tick, so revisions ran ~13.7%
// and the sampled bounce-back reasons were EXACTLY the misses below (crooked
// verticals/perspective, item-removal left undone, reflections, sign/clutter). The
// vocabulary is keyed to IMAGE_FLAG_TAGS so a later auto-QA model trains on the
// same labels. Keyed by media CATEGORY (Photos / Video / Floor plan) — one block
// per category, appended to the checklist ONLY once that category is live on Aryeo
// (so we never ask Kyle to verify photos that haven't landed yet, and nothing gates
// prematurely). Labels are STABLE strings: the reconciler merge keys on label to
// preserve Kyle's manual ticks across syncs, so these must never change wording
// once shipped or a re-sync would drop the tick and silently re-open the gate.
export const QC_FAILURE_MODES: Record<string, string[]> = {
  // Photos (covers PHOTOS / DRONE / TWILIGHT / HEADSHOT / VIRTUAL_STAGING — all
  // fold to the "Photos" category in TYPE_CATEGORY_LABEL and QC together).
  Photos: [
    "Verticals & horizontals straight (perspective)",
    "Blemishes / AI errors removed",
    "Colors & lighting consistent",
    "Clutter + our yard sign removed",
    "People / camera in mirrors & reflections gone",
    "Virtual staging / item removal done (if ordered)",
  ],
  // Video covers VIDEO + SOCIAL_REEL (both "Video" category).
  Video: [
    "Text on screen spelled right",
    "Music + branding correct",
  ],
  "Floor plan": [
    "Square footage matches the listing",
  ],
};

// The two extra passes we ask for on VIP / heavy clients — 38% of deliveries are
// VIP-segment (66% VIP+heavy) yet QC was client-blind. These are the two misses
// that most often bounce a high-value client. Prefixed "VIP —" so the card can
// render them as a distinct extra-pass section; they're real Kyle-ticks and gate
// auto-close like any other failure-mode item.
export const VIP_EXTRA_PASS = [
  "VIP — Mirrors/reflections re-checked frame by frame",
  "VIP — Clutter sweep on every room",
] as const;

// "QC <friendly label>" evidence rows → their category ("QC Drone / aerial" is
// Photos, "QC Reel" is Video). Built once from the two maps above.
const QC_ROW_CATEGORY: Record<string, QcCategory> = Object.fromEntries(
  Object.entries(QC_LABEL)
    .filter(([type]) => TYPE_CATEGORY_LABEL[type])
    .map(([type, label]) => [`QC ${label}`, TYPE_CATEGORY_LABEL[type] as QcCategory]),
);
const FAILURE_MODE_CATEGORY: Record<string, QcCategory> = Object.fromEntries(
  Object.entries(QC_FAILURE_MODES).flatMap(([cat, labels]) => labels.map((l) => [l, cat as QcCategory])),
);

/**
 * Which media category a checklist row belongs to, or null for the rows that
 * belong to the JOB (deliver the gallery, upload page submitted, shot order,
 * the cull note, a generic "Re-QC after revision"). Failure-mode ticks and the
 * VIP extra pass are Photos work; the removals row is Photos (that is where
 * item removal is checked); the video-brief row is Video. The "QC <x>"
 * evidence rows map too, including a revision-injected "QC Reel (revision)".
 */
export function qcCategoryOfRow(label: string): QcCategory | null {
  const l = label.trim();
  if (FAILURE_MODE_CATEGORY[l]) return FAILURE_MODE_CATEGORY[l];
  if (/^VIP —/.test(l)) return "Photos";
  if (l === QC_LABEL_REMOVALS) return "Photos";
  if (l === QC_LABEL_VIDEO_BRIEF) return "Video";
  const base = l.replace(/\s*\(revision\)\s*$/i, "");
  if (QC_ROW_CATEGORY[base]) return QC_ROW_CATEGORY[base];
  return null;
}

/** The auto-evidence row for a category ("QC Photos"), as opposed to Kyle's ticks. */
export function isQcEvidenceRow(label: string): boolean {
  const l = label.trim();
  return /^QC\s/.test(l) && !/\(revision\)/i.test(l);
}

export type QcCategoryState = {
  label: QcCategory;
  /** the media is on Aryeo (or in the Final folder) — the status engine's word */
  live: boolean;
  /** Kyle's optional rows for this category (failure modes, VIP pass, debrief lines) */
  total: number;
  ticked: number;
  /** live and every optional row ticked — "Photos ✓ done" */
  done: boolean;
};

/**
 * Per ORDERED category (one entry for every "QC <x>" evidence row on the
 * card, in QC_CATEGORIES order): is it live, how many optional rows does it
 * carry, how many are ticked. `present` is the status evidence's present
 * list; when the caller has none (the /tasks card only sees the checklist)
 * the evidence row's own tick stands in — it is auto-ticked the hour the
 * category lands and never un-ticked.
 */
export function qcCategoryStates(
  items: { label: string; done?: boolean }[],
  present?: string[] | null,
): QcCategoryState[] {
  const ordered = new Set<QcCategory>();
  const liveByRow = new Set<QcCategory>();
  for (const i of items) {
    if (!isQcEvidenceRow(i.label)) continue;
    const c = qcCategoryOfRow(i.label);
    if (!c) continue;
    ordered.add(c);
    if (i.done) liveByRow.add(c);
  }
  return QC_CATEGORIES.filter((c) => ordered.has(c)).map((label) => {
    const live = present ? present.includes(label) : liveByRow.has(label);
    const rows = items.filter((i) => !isQcEvidenceRow(i.label) && qcCategoryOfRow(i.label) === label);
    const ticked = rows.filter((i) => !!i.done).length;
    return { label, live, total: rows.length, ticked, done: live && ticked === rows.length };
  });
}

/**
 * True when the card's only unticked rows belong to categories that are not
 * live yet — nothing for Kyle to do until media lands. Rows that belong to
 * the job as a whole (deliver the gallery, upload page) keep their own say:
 * unticked, they mean the card is NOT merely waiting on media.
 */
export function qcWaitingOnMediaOnly(items: { label: string; done?: boolean }[], present: string[]): boolean {
  const open = items.filter((i) => !i.done);
  if (open.length === 0) return false;
  return open.every((i) => {
    const c = qcCategoryOfRow(i.label);
    return !!c && !present.includes(c);
  });
}

/**
 * Categories that LANDED between two reads of the same card: their "QC <x>"
 * evidence row was unticked before and is ticked now. The reconciler uses it
 * to tell a by-hand close that a NEW category has arrived since (Sep 16).
 */
export function qcCategoriesLanded(
  before: { label: string; done?: boolean }[],
  after: { label: string; done?: boolean }[],
): Set<QcCategory> {
  const wasLive = new Set<QcCategory>();
  for (const i of before) {
    if (!isQcEvidenceRow(i.label) || !i.done) continue;
    const c = qcCategoryOfRow(i.label);
    if (c) wasLive.add(c);
  }
  const landed = new Set<QcCategory>();
  for (const i of after) {
    if (!isQcEvidenceRow(i.label) || !i.done) continue;
    const c = qcCategoryOfRow(i.label);
    // A category the old card never listed (added to the order after the
    // close) counts as landed too — it was never part of the human decision.
    if (c && !wasLive.has(c)) landed.add(c);
  }
  return landed;
}

/** "Photos" → "photos", "Floor plan" → "the floor plan" — for sentences. */
export function qcCategoryNoun(c: QcCategory | string): string {
  switch (c) {
    case "Photos": return "photos";
    case "Video": return "video";
    case "Floor plan": return "the floor plan";
    case "3D tour": return "the 3D tour";
    default: return c.toLowerCase();
  }
}

/** "Photos aren't on Aryeo yet" / "The floor plan isn't on Aryeo yet". */
export function qcNotLiveMessage(c: QcCategory | string): string {
  if (c === "Photos") return "Photos aren't on Aryeo yet.";
  const noun = qcCategoryNoun(c);
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} isn't on Aryeo yet.`;
}
