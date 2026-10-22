// ---------------------------------------------------------------------------
// WHAT EACH PART OF A CLIENT'S MESSAGE IS ABOUT (Oct 22 2026, 859 N Lawrence
// St). Pure: no prisma, no server-only. The analyser, the creative review
// lane, the editor brief, the issue ledger, the photo desk and the drill all
// read the same rule.
//
// Jordan: "Joe Sutow texted about a video revision, then texted about virtual
// staging in photos. The photo staging issue is showing up on the video review
// room. It should not be." A client's texts on a delivered job become a video
// work order (lib/revisionBrief), and every item the model split out of them
// went to the video side: "Virtually stage the upper patio (photo 38)" was
// pinned to the job's one video, and its open question ("what furniture
// style?") opened a creative review card in the Video Review Room.
//
// So every item (and every open question) says what it is about:
//   video    the video(s): the editor's work, the Video Review Room
//   photo    the still photos and what is done to them (a photo number,
//            virtual staging, twilight, lot lines, a floor plan): the photo
//            job's client asks, never the editor
//   both     the same change on both
//   unclear  nobody can tell: shown in both places, labelled
// The model labels each item; this file is the floor under it, used only
// when the model said "unclear" or gave no label: words that name a photo
// mean the photos unless a video is named too. An item with no label and no
// photo words (a row written before this existed) is a video item, as it
// always was.
// ---------------------------------------------------------------------------
import { photoNumbers } from "@/lib/photoDelivery/careRules";

export const ITEM_MEDIA = ["video", "photo", "both", "unclear"] as const;
/** The photo job's asks filed from a work order (lib/briefPhotoAsks), by key prefix: an office question (scope or price, for Jordan or Kyle) and a both / unclear item. */
export const PHOTO_OFFICE_KEY_PREFIX = "photo-office:";
export const PHOTO_SHARED_KEY_PREFIX = "photo-shared:";
export type ItemMedium = (typeof ITEM_MEDIA)[number];
export const isItemMedium = (v: unknown): v is ItemMedium => typeof v === "string" && (ITEM_MEDIA as readonly string[]).includes(v);

/** Words about the photos, and only words that cannot mean anything else
 *  (Oct 22 2026 audit C2): a numbered photo ("photo 4", "pic 11", "photo
 *  #38", "image 12"), "photos" and "pics" / "pictures", "drone photo",
 *  virtual staging, twilight, lot lines, a floor plan. Bare "still", "stage"
 *  and "image" are NOT photo words: "The people are still a bit glitchy",
 *  "Can you still add my logo at the end?" and "make my brand image pop in
 *  the end card" are video changes, and reading them as photos sent them to
 *  the photo desk instead of the editor. "shot" and "cut" are left out too:
 *  both are everyday video words ("the opening shot", "cut the intro"). */
const PHOTO_WORDS = new RegExp(
  [
    String.raw`\b(?:photo|pic|picture|image)s?\s*(?:#|no\.?\s*|number\s*)?\d{1,3}\b`,
    String.raw`\b(?:photos|pics?|pictures)\b`,
    String.raw`\bdrone\s+(?:photo|pic|picture|image)s?\b`,
    String.raw`\bvirtual(?:ly)?[\s-]*stag\w*`,
    String.raw`\btwilights?\b`,
    String.raw`\b(?:lot|property|boundary)[\s-]*lines?\b`,
    String.raw`\bfloor\s*-?\s*plans?\b`,
  ].join("|"),
  "i",
);

/** Words that name a video: the video itself, the parts only a video has, a
 *  video code (V1) or a timestamp (0:12). Words a photo shares ("scene",
 *  "frame", "transition", "walk-through": a staging scene, a picture frame,
 *  a 3D tour) are left out: they would make a photo item read as both. */
const VIDEO_WORDS = new RegExp(
  [
    String.raw`\b(?:videos?|reels?|clips?|footage|films?|cinematic)\b`,
    String.raw`\b(?:rough|final|first|new)\s+cut\b`,
    String.raw`\bre-?cut\b`,
    String.raw`\b(?:music|song|audio|voice-?over|b-?roll|intro|outro|caption|subtitle)s?\b`,
    String.raw`\bon-?screen text\b`,
    String.raw`\bV\d{1,2}\b`,
    String.raw`\b\d{1,2}:\d{2}\b`,
  ].join("|"),
  "i",
);

/** Pure: does this text name the photos? */
export const namesPhotos = (text: string | null | undefined): boolean => PHOTO_WORDS.test(text ?? "");
/** Pure: does this text name a video? */
export const namesVideo = (text: string | null | undefined): boolean => VIDEO_WORDS.test(text ?? "");

/**
 * What one item (or one open question) is about. `words`: everything the item
 * says (the instruction, its detail, the client's quote). `model`: the
 * analyser's label, when it gave one. Pure.
 *
 * The model's label wins whenever it gave one that decides (video, photo or
 * both). The words are only the floor under a missing label or an "unclear"
 * one (Oct 22 2026 audit C2: the backstop must never overrule the model):
 *   · photo words and no video named: photo;
 *   · photo words and a video named: both;
 *   · a video named and no photo words: video;
 *   · neither: the model's "unclear", else video (rows written before labels
 *     existed stay video).
 */
export function itemMediumOf(words: string | null | undefined, model?: unknown): ItemMedium {
  const said = isItemMedium(model) ? model : null;
  if (said && said !== "unclear") return said;
  const t = (words ?? "").replace(/\s+/g, " ");
  const photo = namesPhotos(t);
  const video = namesVideo(t);
  if (photo && !video) return "photo";
  if (photo && video) return "both";
  if (video) return "video";
  return said ?? "video";
}

/** The words an item carries, for itemMediumOf. */
export function itemWords(it: { ask?: string | null; detail?: string | null; quote?: string | null }): string {
  return [it.ask, it.detail, it.quote].filter(Boolean).join(" ");
}

/** An item's medium as stored: a row from before labels existed is video. Pure. */
export function mediumOfItem(it: { medium?: unknown }): ItemMedium {
  return isItemMedium(it.medium) ? it.medium : "video";
}

/** Only about the photos: never the editor's, never the Video Review Room. Pure. */
export const isPhotoOnly = (it: { medium?: unknown }): boolean => mediumOfItem(it) === "photo";
/** Shown on the photo side too (photo, both, unclear). Pure. */
export const reachesPhotos = (it: { medium?: unknown }): boolean => mediumOfItem(it) !== "video";

/** The label a both / unclear item carries wherever it shows. Null for one medium. */
export function mediumLabel(m: unknown): string | null {
  if (m === "both") return "Photos and video";
  if (m === "unclear") return "Photos or video? Not clear";
  return null;
}

/** Virtual staging, or redoing it. Bare "stage" is not (audit C2): "clone
 *  out / stage out the stove" is a photo fix, not new staging work. */
const VIRTUAL_STAGING = /\bvirtual(?:ly)?[\s-]*stag\w*|\bre-?stag\w*/i;

/**
 * A photo item that is new work, not a fix: a scope or price question for the
 * office (Jordan or Kyle), never an editor change. The model's SCOPE, or
 * virtual staging on a job whose order has none. Pure.
 */
export function isOfficeQuestion(it: { kind?: unknown; medium?: unknown; ask?: string | null; detail?: string | null; quote?: string | null }, job: { stagingOrdered: boolean }): boolean {
  if (!isPhotoOnly(it)) return false;
  if (it.kind === "SCOPE") return true;
  return !job.stagingOrdered && VIRTUAL_STAGING.test(itemWords(it));
}

const normWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Did the client say this item in THIS message, or did the model lift it from
 * the conversation around it ("Take items only from what the client said")?
 * True when the item quotes something, and no part of the quote (split where
 * the model joined pieces with "…") is in the message. An item with no quote
 * is never called an echo. Pure.
 */
export function isEcho(quote: string | null | undefined, message: string): boolean {
  const q = (quote ?? "").trim();
  if (!q) return false;
  const text = normWords(message);
  const parts = q.split(/…|\.\.\.|\s\/\s/).map(normWords).filter((p) => p.length >= 6);
  if (parts.length === 0) return false;
  return !parts.some((p) => text.includes(p) || (p.length > 40 && text.includes(p.slice(0, 40))));
}

/** The photo numbers an item names ("38", "1-5, 38-40"), or null. Pure. */
export function itemPhotoNumbers(it: { ask?: string | null; detail?: string | null; quote?: string | null }): string | null {
  return photoNumbers(itemWords(it));
}

type LabelledItem = { ask?: string | null; detail?: string | null; quote?: string | null; medium?: unknown };

/**
 * Label a work order's items and split its open questions (the analyser's
 * output, or a row written before labels existed). Pure.
 *   · `videoOnly`: a portal or staff request pinned to one video: every item
 *     and question is about that video, whatever its words;
 *   · `relabel`: read every item again (an item that already has a label
 *     keeps it otherwise, so a person's or the model's label is not undone);
 *   · questions about the photos only move to `photoQuestions` (the photo
 *     job's open asks); the rest stay the video side's `questions`.
 */
export function labelWorkOrder<T extends LabelledItem>(
  doc: { items: T[]; questions: unknown[]; photoQuestions?: unknown[] },
  opts: { videoOnly?: boolean; relabel?: boolean } = {},
): { items: (T & { medium: ItemMedium })[]; questions: string[]; photoQuestions: string[] } {
  const items = doc.items.map((it) => ({
    ...it,
    medium: opts.videoOnly ? ("video" as const) : !opts.relabel && isItemMedium(it.medium) ? it.medium : itemMediumOf(itemWords(it), it.medium),
  }));
  const questions: string[] = [];
  const photoQuestions = (doc.photoQuestions ?? []).map((q) => String(q ?? "").trim()).filter(Boolean);
  for (const q of doc.questions.map((x) => String(x ?? "").trim()).filter(Boolean)) {
    if (!opts.videoOnly && itemMediumOf(q) === "photo") photoQuestions.push(q);
    else questions.push(q);
  }
  return { items, questions, photoQuestions: [...new Set(photoQuestions)] };
}
