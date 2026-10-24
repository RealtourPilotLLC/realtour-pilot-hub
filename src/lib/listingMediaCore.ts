// ---------------------------------------------------------------------------
// THE ARYEO LISTING MEDIA INDEX: ITS RULES (Oct 24 2026). Jordan: "we should
// have a lot more premium videos and monthly social content in the gallery."
//
// The media library only knew the hub's own approved cuts (since Aug 2026)
// and the program's portal rows. Every older delivered video lives on its
// Aryeo listing, so the hub indexes what each listing holds
// (ListingMediaItem) and the library reads the index. Pure: no database, no
// provider, no clock unless one is passed. lib/listingMediaIndex writes with
// these; lib/mediaLibrary reads with them; the drills hold both to them.
//
// WHAT ARYEO'S LISTING SAYS (read live Oct 24 2026, GET /listings/<id>
// ?include=images,videos,floor_plans,interactive_content,files):
//   videos[]  { object: "VIDEO", id (uuid; v7 on listings since 2024, whose
//              first 48 bits are when it went up), title, duration (whole
//              seconds), display_type, source_type, thumbnail_url
//              (image.mux.com, 800x450 smart crop), download_url
//              (videos.aryeo.com/listings/<uuid>/<uuid>.mp4), playback_url
//              (stream.mux.com HLS), share_url }
//   images[]  { object: "PHOTO", id, original_url, large_url, thumbnail_url
//              (cdn.aryeo.com), filename, index, caption, display_in_gallery }
//   the listing's own thumbnail_url / large_thumbnail_url = its cover image.
// No url carries a signature or an expiry, so the urls are kept as given.
// Aryeo gives no width or height for a video; a title that says "Vertical" or
// "Horizontal" is the only orientation the index records.
// ---------------------------------------------------------------------------

export type ListingMediaKind = "VIDEO" | "PHOTO_COVER";

/** One row the index holds for a job, as read off its listing. */
export type IndexRow = {
  aryeoMediaId: string;
  kind: ListingMediaKind;
  title: string | null;
  durationSec: number | null;
  orientation: "vertical" | "horizontal" | null;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  playbackUrl: string | null;
  photoCount: number | null;
  position: number;
  deliveredAt: Date | null;
};

const https = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

const ARYEO_EPOCH_MS = Date.UTC(2015, 0, 1);

/** When an Aryeo UUIDv7 id was minted (= when the media went up). Null for any other id. */
export function uuidV7Time(id: string | null | undefined, now: Date = new Date()): Date | null {
  if (!id) return null;
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex) || hex[12] !== "7") return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < ARYEO_EPOCH_MS || ms > now.getTime() + 86_400_000) return null;
  return new Date(ms);
}

/** Only what the title itself says. */
export function orientationFromTitle(title: string | null | undefined): "vertical" | "horizontal" | null {
  const t = (title ?? "").toLowerCase();
  const v = /\bvertical\b/.test(t);
  const h = /\bhorizontal\b/.test(t);
  return v === h ? null : v ? "vertical" : "horizontal";
}

/**
 * A listing read → the rows the index should hold for it.
 * `videos: null` / `cover: undefined` mean the read did not carry that part
 * (not an array): UNKNOWN, so nothing is marked removed on its account.
 * `cover: null` means the listing has no gallery photo.
 */
export function listingIndexOf(l: Record<string, unknown> | null | undefined, now: Date = new Date()): { videos: IndexRow[] | null; cover: IndexRow | null | undefined } {
  if (!l || typeof l !== "object") return { videos: null, cover: undefined };
  let videos: IndexRow[] | null = null;
  if (Array.isArray(l.videos)) {
    videos = [];
    const seen = new Set<string>();
    rows(l.videos).forEach((v, i) => {
      const id = text(v.id, 80);
      // No id, no row: a video Aryeo will not name has no stable key.
      if (!id || seen.has(id)) return;
      const download = https(v.download_url);
      const playback = https(v.playback_url);
      if (!download && !playback) return; // nothing anyone could watch
      seen.add(id);
      const title = text(v.title);
      const d = typeof v.duration === "number" && Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;
      videos!.push({
        aryeoMediaId: id, kind: "VIDEO", title, durationSec: d, orientation: orientationFromTitle(title),
        thumbnailUrl: https(v.thumbnail_url), downloadUrl: download, playbackUrl: playback, photoCount: null,
        position: i, deliveredAt: uuidV7Time(id, now),
      });
    });
  }
  let cover: IndexRow | null | undefined = undefined;
  if (Array.isArray(l.images)) {
    const gallery = rows(l.images).filter((i) => i.display_in_gallery !== false);
    const usable = gallery.filter((i) => https(i.thumbnail_url) || https(i.large_url) || https(i.original_url));
    if (!usable.length) cover = null;
    else {
      const listingThumb = https(l.thumbnail_url);
      const listingLarge = https(l.large_thumbnail_url);
      // The listing's own cover is one of its images; find which, else the first.
      const own = usable.find((i) => (listingThumb && https(i.thumbnail_url) === listingThumb) || (listingLarge && https(i.large_url) === listingLarge));
      const img = own ?? usable[0];
      const id = text(img.id, 80) ?? `cover:${text(l.id, 80) ?? "listing"}`;
      cover = {
        aryeoMediaId: id, kind: "PHOTO_COVER", title: text(img.filename), durationSec: null, orientation: null,
        thumbnailUrl: (own ? listingThumb : null) ?? https(img.thumbnail_url) ?? https(img.large_url) ?? https(img.original_url),
        downloadUrl: https(img.original_url) ?? https(img.large_url),
        playbackUrl: null, photoCount: gallery.length, position: 0, deliveredAt: uuidV7Time(text(img.id, 80), now),
      };
    }
  }
  return { videos, cover };
}

// ---------------------------------------------------------------------------
// WHAT TO WRITE: the read set against what the index already holds for the
// job. Only real changes are written; a row that vanished from the listing is
// marked removed (never deleted); one that comes back is restored.
// ---------------------------------------------------------------------------

export type HeldRow = IndexRow & { id: string; removedAt: Date | null };

const SAME_FIELDS = ["title", "durationSec", "orientation", "thumbnailUrl", "downloadUrl", "playbackUrl", "photoCount", "position"] as const;

export function diffIndex(held: HeldRow[], read: { videos: IndexRow[] | null; cover: IndexRow | null | undefined }) {
  const create: IndexRow[] = [];
  const update: { id: string; data: Partial<IndexRow> & { removedAt?: null } }[] = [];
  const remove: string[] = [];
  const seen: string[] = [];
  const consider = (kind: ListingMediaKind, incoming: IndexRow[] | null) => {
    if (incoming === null) return; // unknown: touch nothing of this kind
    const mine = held.filter((h) => h.kind === kind);
    const byId = new Map(mine.map((h) => [h.aryeoMediaId, h]));
    for (const r of incoming) {
      const h = byId.get(r.aryeoMediaId);
      if (!h) { create.push(r); continue; }
      seen.push(h.id);
      const data: Partial<IndexRow> & { removedAt?: null } = {};
      for (const f of SAME_FIELDS) if ((h[f] ?? null) !== (r[f] ?? null)) (data as Record<string, unknown>)[f] = r[f];
      if (!h.deliveredAt && r.deliveredAt) data.deliveredAt = r.deliveredAt;
      if (h.removedAt) data.removedAt = null;
      if (Object.keys(data).length) update.push({ id: h.id, data });
    }
    const ids = new Set(incoming.map((r) => r.aryeoMediaId));
    for (const h of mine) if (!ids.has(h.aryeoMediaId) && !h.removedAt) remove.push(h.id);
  };
  consider("VIDEO", read.videos);
  consider("PHOTO_COVER", read.cover === undefined ? null : read.cover ? [read.cover] : []);
  return { create, update, remove, seen };
}

// ---------------------------------------------------------------------------
// WHICH OF THE JOB'S VIDEO TYPES A LISTING VIDEO IS. A job with one video
// type: that type. A job sold two (a premium reel and a cinematic video, 70
// delivered jobs): what the title says ("Premium Social Media Reel",
// "Cinematic Video", "Standard Reel w/ Agent intro", "Vertical", "Website
// Version"), and when it says nothing, the higher type (premium wins, the
// hub's own rule). Never a type the job did not buy.
// ---------------------------------------------------------------------------

const STYLE_ORDER = ["premium_cinematic", "premium_social_reel", "personal_branding", "standard_reel_agent_intro", "standard_cinematic", "standard_reel"] as const;

export function classifyListingVideo(title: string | null | undefined, styles: (string | null | undefined)[]): string | null {
  const candidates = [...new Set(styles.filter((s): s is string => !!s))];
  if (candidates.length <= 1) return candidates[0] ?? null;
  const t = (title ?? "").toLowerCase();
  const premium = /premium|luxury|signature|influencer/.test(t);
  const standard = /\bstandard\b/.test(t);
  const cinematic = /cinematic|horizontal|website|youtube(?!\s*short)|walk-?through|\bfilm\b/.test(t);
  const reel = /\breels?\b|vertical|instagram|tiktok|\bshorts?\b/.test(t);
  const intro = /agent\s*(intro|tour)|w\/\s*agent|with agent/.test(t);
  const branding = /branding|personal/.test(t);
  const score = (s: string) => {
    let n = 0;
    if (premium && s.startsWith("premium_")) n += 2;
    if (standard && s.startsWith("standard_")) n += 2;
    if (cinematic && s.endsWith("cinematic")) n += 2;
    if (reel && (s.includes("reel") || s === "personal_branding")) n += 1;
    if (reel && !cinematic && s.endsWith("cinematic")) n -= 1;
    if (intro && s === "standard_reel_agent_intro") n += 3;
    if (branding && s === "personal_branding") n += 3;
    return n;
  };
  const rank = (s: string) => {
    const i = (STYLE_ORDER as readonly string[]).indexOf(s);
    return i < 0 ? STYLE_ORDER.length : i;
  };
  return candidates.sort((a, b) => score(b) - score(a) || rank(a) - rank(b))[0];
}

// ---------------------------------------------------------------------------
// THE SAME VIDEO TWICE. The library prefers the hub's own file; an indexed
// Aryeo video is dropped when it is a video the hub (or the portal) already
// shows. Titles are compared loosely (case, punctuation, a file extension);
// durations within two seconds, when both are known.
// ---------------------------------------------------------------------------

/** Aryeo's media hosts, the same list the staff download proxy allows (api/media/download). */
export const ARYEO_MEDIA_HOSTS = ["aryeo.com", "digitaloceanspaces.com", "mux.com", "cloudfront.net"] as const;

/** An address on one of Aryeo's media hosts (https, no credentials, the standard port), else null. */
export function aryeoMediaUrl(v: string | null | undefined): URL | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
    return ARYEO_MEDIA_HOSTS.some((s) => host === s || host.endsWith(`.${s}`)) ? u : null;
  } catch {
    return null;
  }
}

export function normTitle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\.(mov|mp4|m4v)$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function sameDuration(a: number | null | undefined, b: number | null | undefined): boolean | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) <= 2;
}

// ---------------------------------------------------------------------------
// THE ONE-TIME BACKFILL'S STATE (AppSetting `listing_media_backfill`). A
// missing row is "not started": nothing reads Aryeo until someone starts it.
// ---------------------------------------------------------------------------

export const BACKFILL_KEY = "listing_media_backfill";

export type BackfillState = {
  state: "running" | "paused" | "done";
  startedAt: string;
  startedBy: string | null;
  /** The last project id read (projects are walked by id, ascending). */
  cursor: string | null;
  /** Listings read so far, and how many there were when the last tick counted. */
  done: number;
  total: number;
  videos: number;
  covers: number;
  /** Listings Aryeo would not return (404) or that failed three times running, skipped. */
  skipped: { id: string; why: string }[];
  failStreak: { id: string; n: number } | null;
  /** A refusal for load (429) waits this long before the next read. */
  backoffUntil: string | null;
  backoffMs: number;
  /** One tick at a time: a tick holds this until it finishes (or it lapses). */
  leaseUntil: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  finishedAt: string | null;
};

export function freshBackfill(now: Date, by: string | null): BackfillState {
  return {
    state: "running", startedAt: now.toISOString(), startedBy: by, cursor: null, done: 0, total: 0, videos: 0, covers: 0,
    skipped: [], failStreak: null, backoffUntil: null, backoffMs: 0, leaseUntil: null, lastTickAt: null, lastError: null, finishedAt: null,
  };
}

export function parseBackfill(raw: string | null | undefined): BackfillState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BackfillState>;
    if (!v || typeof v !== "object" || !["running", "paused", "done"].includes(String(v.state))) return null;
    return { ...freshBackfill(new Date(0), null), ...v, skipped: Array.isArray(v.skipped) ? v.skipped.slice(0, 50) : [] } as BackfillState;
  } catch {
    return null;
  }
}

/** The wait after a refusal for load: one minute, doubling, at most thirty. */
export function nextBackoffMs(prevMs: number): number {
  return Math.min(30 * 60_000, Math.max(60_000, (prevMs || 0) * 2));
}

/** "312 of 1,544 listings indexed" — for the page and the run log. */
export function backfillLine(s: BackfillState | null): string | null {
  if (!s) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  if (s.state === "done") return `All ${n(s.done)} delivered listings indexed${s.skipped.length ? ` (${s.skipped.length} Aryeo would not return)` : ""}.`;
  const of = s.total ? ` of ${n(Math.max(s.total, s.done))}` : "";
  return `${s.state === "paused" ? "Paused: reading" : "Reading"} the older Aryeo listings: ${n(s.done)}${of} so far. Their videos and covers appear here as it goes.`;
}
