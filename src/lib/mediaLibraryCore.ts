import { etAt, etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// THE MEDIA LIBRARY'S RULES (Jordan, Oct 23 2026: "a really nice media page so
// we can see all of the videos that we have done and download them. Organized
// by media type, and date … Photos have their own tab, and are organized by
// address, and premium videos have their own tab, monthly social has its own
// tab, and standard videos have their own tab").
//
// Pure: no database, no provider, no clock unless one is passed. The readers
// (lib/mediaLibrary.ts) and the download route (api/media/video/[id]) both
// decide with these, so the page and the file it serves can never disagree
// about which videos are done or which file is the finished one.
//
// WHICH TAB A VIDEO IS ON comes from the video row's Style Guide type
// (Deliverable.videoStyle, the six VIDEO_STYLE keys in integrations/aryeo.ts,
// set at sync from the product and Settings → Products), never from a guess
// at the file name:
//   premium_social_reel, premium_cinematic        → Premium videos
//   standard_reel, standard_reel_agent_intro,
//   standard_cinematic                            → Standard videos
//   personal_branding, or the monthly program's
//   portal library                                → Monthly social
// A premium reel bought on a monthly client's job stays premium (the hub's
// own rule since Jun 2026: premium wins over monthly, it is a one-off listing
// deliverable). The live data has NO premium or standard monthly program:
// every program video's product is a session (Video Starter 2HR, Video
// Accelerator 4HR, VIDEO PRO 8HR), so Monthly social groups by those
// packages. A branding package sold outside the program (Sharra Mercer's
// Custom Branding Video Package, Paul Zgalich's Promotional Campaign) is a
// personal-branding video too and gets a group of its own there.
// ---------------------------------------------------------------------------

export type MediaTab = "standard" | "premium" | "monthly" | "photos";
export type VideoTab = Exclude<MediaTab, "photos">;

export const MEDIA_TABS: { key: MediaTab; label: string; short: string }[] = [
  { key: "standard", label: "Standard videos", short: "Standard" },
  { key: "premium", label: "Premium videos", short: "Premium" },
  { key: "monthly", label: "Monthly social", short: "Monthly" },
  { key: "photos", label: "Photos", short: "Photos" },
];

export const isMediaTab = (v: unknown): v is MediaTab => MEDIA_TABS.some((t) => t.key === v);

/** The Style Guide type names (integrations/aryeo VIDEO_STYLE; a drill holds the two equal). */
export const MEDIA_TYPE_NAME = {
  standard_reel: "Standard Reel",
  standard_reel_agent_intro: "Standard Reel with Agent Intro",
  standard_cinematic: "Standard Cinematic Video",
  personal_branding: "Personal Branding Reel",
  premium_social_reel: "Premium Social Media Reel",
  premium_cinematic: "Premium Cinematic Video",
} as const;
export type MediaStyleKey = keyof typeof MEDIA_TYPE_NAME;
export const isMediaStyleKey = (s: unknown): s is MediaStyleKey => typeof s === "string" && s in MEDIA_TYPE_NAME;

export type MediaPlacement = { tab: VideoTab; groupKey: string; groupLabel: string; groupOrder: number };

/** The monthly program's package a video was filmed under: the session product on its job, else the client's package. */
export function programPackageOf(productTitle: string | null | undefined, enrollmentPackage?: string | null, programKind?: string | null): { key: string; label: string; order: number } {
  if (programKind === "BULK") return { key: "bulk", label: "Bulk plan", order: 3 };
  for (const t of [productTitle ?? "", enrollmentPackage ?? ""]) {
    if (/\bpro\b/i.test(t)) return { key: "pro", label: "Video Pro", order: 0 };
    if (/accelerator/i.test(t)) return { key: "accelerator", label: "Video Accelerator", order: 1 };
    if (/starter/i.test(t)) return { key: "starter", label: "Video Starter", order: 2 };
  }
  return { key: "sessions", label: "Content sessions", order: 4 };
}

const STYLE_PLACE: Record<Exclude<MediaStyleKey, "personal_branding">, MediaPlacement> = {
  premium_cinematic: { tab: "premium", groupKey: "premium_cinematic", groupLabel: MEDIA_TYPE_NAME.premium_cinematic, groupOrder: 0 },
  premium_social_reel: { tab: "premium", groupKey: "premium_social_reel", groupLabel: MEDIA_TYPE_NAME.premium_social_reel, groupOrder: 1 },
  standard_cinematic: { tab: "standard", groupKey: "standard_cinematic", groupLabel: MEDIA_TYPE_NAME.standard_cinematic, groupOrder: 0 },
  standard_reel: { tab: "standard", groupKey: "standard_reel", groupLabel: MEDIA_TYPE_NAME.standard_reel, groupOrder: 1 },
  standard_reel_agent_intro: { tab: "standard", groupKey: "standard_reel_agent_intro", groupLabel: MEDIA_TYPE_NAME.standard_reel_agent_intro, groupOrder: 2 },
};

/**
 * Where one finished video sits. `monthly` = it belongs to the monthly program
 * (a content-session job, or a row in a client's portal library); `pkg` is
 * that program's package (programPackageOf).
 */
export function placeVideo(input: { style: string | null | undefined; monthly: boolean; pkg?: { key: string; label: string; order: number } | null }): MediaPlacement {
  const style = isMediaStyleKey(input.style) ? input.style : null;
  if (style && style !== "personal_branding") return STYLE_PLACE[style];
  if (input.monthly) {
    const p = input.pkg ?? { key: "sessions", label: "Content sessions", order: 4 };
    return { tab: "monthly", groupKey: `program_${p.key}`, groupLabel: p.label, groupOrder: p.order };
  }
  if (style === "personal_branding") return { tab: "monthly", groupKey: "branding_package", groupLabel: "Branding packages", groupOrder: 5 };
  // A listing video whose row carries no type (a legacy folder cut with no
  // deliverable): standard by the hub's default, and said so.
  return { tab: "standard", groupKey: "listing_other", groupLabel: "Listing videos (type not recorded)", groupOrder: 3 };
}

// ---------------------------------------------------------------------------
// DONE: a listing video counts once it was delivered or sent, never because it
// was approved. Monthly videos count once the portal library has them.
// ---------------------------------------------------------------------------

export type CutFacts = {
  status: string;
  sentToClientAt: Date | null;
  decidedAt: Date | null;
  topazDeliveredAt: Date | null;
  /** The owed video's own delivery stamp, only when it names this cut (or names none). */
  outputDeliveredAt: Date | null;
  projectStatus: string;
  projectDeliveredAt: Date | null;
  /** When the client's portal library got this cut (a PortalVideo row that plays it). */
  portalPublishedAt: Date | null;
};

export function cutDone(c: CutFacts): { done: boolean; at: Date | null; word: "Delivered" | "Published" } {
  if (c.status !== "APPROVED" || c.projectStatus === "CANCELLED") return { done: false, at: null, word: "Delivered" };
  const sent = c.sentToClientAt ?? c.topazDeliveredAt ?? c.outputDeliveredAt;
  if (sent) return { done: true, at: sent, word: "Delivered" };
  if (c.portalPublishedAt) return { done: true, at: c.portalPublishedAt, word: "Published" };
  if (c.projectStatus === "DELIVERED") return { done: true, at: c.projectDeliveredAt ?? c.decidedAt, word: "Delivered" };
  return { done: false, at: null, word: "Delivered" };
}

// ---------------------------------------------------------------------------
// THE FINISHED FILE, in the order readyToSend.fileFor sends it: the Topaz
// file when the pass finished and was filed (unless a reviewer kept the
// editor's original), else the editor's own export from the hub's store, else
// the cut's Dropbox path. The route serves exactly what this names.
// ---------------------------------------------------------------------------

export type FileFacts = {
  fileName: string | null;
  blobUrl: string | null;
  assetPath: string | null;
  finalPath: string | null;
  topaz: { state: string; finalPath: string | null; savedAt: Date | null; outputCheck: string | null } | null;
};

export type FinishedFile =
  | { kind: "dropbox"; path: string; fileName: string; source: "topaz" | "editor" }
  | { kind: "blob"; url: string; fileName: string; source: "editor" };

const baseName = (p: string | null | undefined) => (p ? p.split("/").pop() || null : null);

export function finishedFileOf(f: FileFacts): FinishedFile | null {
  const j = f.topaz;
  if (j && j.state === "done" && j.finalPath && j.savedAt && j.outputCheck !== "resolved-original" && j.outputCheck !== "unverified") {
    return { kind: "dropbox", path: j.finalPath, fileName: baseName(j.finalPath) ?? f.fileName ?? "video.mp4", source: "topaz" };
  }
  if (f.blobUrl) return { kind: "blob", url: f.blobUrl, fileName: f.fileName ?? baseName(f.finalPath) ?? "video.mp4", source: "editor" };
  const path = f.assetPath ?? f.finalPath;
  if (path) return { kind: "dropbox", path, fileName: baseName(path) ?? f.fileName ?? "video.mp4", source: "editor" };
  return null;
}

/** One finished version per owed video: the newest done round of each slot. */
export function latestPerSlot<T>(items: T[], slotOf: (x: T) => string, rankOf: (x: T) => number): T[] {
  const best = new Map<string, T>();
  for (const x of items) {
    const k = slotOf(x);
    const cur = best.get(k);
    if (!cur || rankOf(x) > rankOf(cur)) best.set(k, x);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// SHAPE AND WORDS
// ---------------------------------------------------------------------------

export type Orientation = "vertical" | "horizontal" | null;

export function orientationOf(w: number | null | undefined, h: number | null | undefined): Orientation {
  if (!w || !h) return null;
  return h > w ? "vertical" : "horizontal";
}

/** The frame a group's tiles share: the shape most of its known videos have, else the type's own (a reel is vertical, a cinematic video horizontal). */
export function groupFrame(items: { orientation: Orientation }[], groupKey: string): "vertical" | "horizontal" {
  const v = items.filter((i) => i.orientation === "vertical").length;
  const h = items.filter((i) => i.orientation === "horizontal").length;
  if (v || h) return v >= h ? "vertical" : "horizontal";
  return /cinematic|listing_other/.test(groupKey) ? "horizontal" : "vertical";
}

/** A title fit to show: no file extension, no runs of spaces. Never invents words. */
export function cleanVideoTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().replace(/\.(mov|mp4|m4v|avi|mkv|webm)$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

export const streetOf = (title: string | null | undefined): string => (title ?? "").split(",")[0].trim();

/** One address, however it was typed: the street and town, lower-cased, no punctuation. */
export function addressKey(title: string | null | undefined): string {
  return (title ?? "").toLowerCase().replace(/\b(pa|nj|de|ny|md)\b\s*\d{5}(-\d{4})?/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A filename-safe stem from an address or title. */
export function fileStem(s: string | null | undefined, fallback = "media"): string {
  return (s ?? "").split(",")[0].trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || fallback;
}

// ---------------------------------------------------------------------------
// FILTERS: a search over the words a person would type (address, client,
// title), a date range, newest or oldest first.
// ---------------------------------------------------------------------------

export type MediaSort = "new" | "old";
export type MediaRangeKey = "all" | "30d" | "90d" | "365d" | `y${number}`;

export function parseSort(v: unknown): MediaSort {
  return v === "old" ? "old" : "new";
}

export function parseRange(v: unknown, now: Date = new Date()): { key: MediaRangeKey; from: Date | null; to: Date | null } {
  const s = typeof v === "string" ? v : "all";
  const days = /^(30|90|365)d$/.exec(s);
  if (days) return { key: s as MediaRangeKey, from: new Date(now.getTime() - Number(days[1]) * 86_400_000), to: null };
  const year = /^y(20\d\d)$/.exec(s);
  if (year) {
    const y = Number(year[1]);
    return { key: s as MediaRangeKey, from: etAt(`${y}-01-01`, 0), to: etAt(`${y + 1}-01-01`, 0) };
  }
  return { key: "all", from: null, to: null };
}

/** The years a range picker offers: this year back to the oldest dated item. */
export function rangeYears(dates: (Date | string | null | undefined)[], now: Date = new Date()): number[] {
  const thisYear = Number(etDayKey(now).slice(0, 4));
  let oldest = thisYear;
  for (const d of dates) {
    if (!d) continue;
    const y = Number(etDayKey(new Date(d)).slice(0, 4));
    if (Number.isFinite(y) && y < oldest) oldest = y;
  }
  const out: number[] = [];
  for (let y = thisYear; y >= Math.max(oldest, thisYear - 10); y--) out.push(y);
  return out;
}

export function cleanQuery(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

/** Every word of the query appears somewhere in the fields (case and punctuation ignored). */
export function matchesQuery(q: string, fields: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return words.every((w) => hay.includes(w));
}

export function inRange(at: Date | string | null | undefined, r: { from: Date | null; to: Date | null }): boolean {
  if (!r.from && !r.to) return true;
  if (!at) return false;
  const t = new Date(at).getTime();
  return (!r.from || t >= r.from.getTime()) && (!r.to || t < r.to.getTime());
}

export function byDate<T>(sort: MediaSort, dateOf: (x: T) => string | Date | null | undefined) {
  return (a: T, b: T) => {
    const x = dateOf(a);
    const y = dateOf(b);
    const ax = x ? new Date(x).getTime() : 0;
    const by = y ? new Date(y).getTime() : 0;
    return sort === "old" ? (ax || Number.MAX_SAFE_INTEGER) - (by || Number.MAX_SAFE_INTEGER) : by - ax;
  };
}

/** Group placed items by their group, in the tab's fixed order; inside each, by date. */
export function groupPlaced<T extends { placement: MediaPlacement; orientation: Orientation; dateISO: string | null }>(items: T[], sort: MediaSort) {
  const groups = new Map<string, { key: string; label: string; order: number; items: T[] }>();
  for (const it of items) {
    const g = groups.get(it.placement.groupKey) ?? { key: it.placement.groupKey, label: it.placement.groupLabel, order: it.placement.groupOrder, items: [] };
    g.items.push(it);
    groups.set(g.key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((g) => ({ key: g.key, label: g.label, frame: groupFrame(g.items, g.key), items: g.items.sort(byDate(sort, (x) => x.dateISO)) }));
}

/** Show more, a page at a time. */
export const PAGE_SIZE = 24;
export function pageCount(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(n) || n < PAGE_SIZE) return PAGE_SIZE;
  return Math.min(Math.ceil(n / PAGE_SIZE) * PAGE_SIZE, 2400);
}
