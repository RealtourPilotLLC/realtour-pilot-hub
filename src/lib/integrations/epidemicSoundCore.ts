// ---------------------------------------------------------------------------
// Epidemic Sound Partner Content API — the HTTP core (Sep 15 2026).
//
// Jordan: "I want to add API access to epidemic sound so the editor can browse
// and download songs via API connection in the editing room." This file is the
// part that talks to https://partner-content-api.epidemicsound.com and NOTHING
// else: no `server-only`, no Prisma, no secret lookup — the key and the
// per-user id are handed in by src/lib/integrations/epidemicSound.ts (the
// server wrapper), so this can be unit-tested against a mocked fetch. Built
// from the published OpenAPI spec (partner-content-api.epidemicsound.com/docs/
// spec.json, read Sep 15) — no key exists in the hub yet, so nothing here has
// been run live.
//
// Auth: API-key authentication, no token exchange —
//   Authorization: Bearer epidemic_live_…
//   x-partner-user-id: <stable anonymised id>   (never a name or email)
// Rate limiting comes back as 429; a search on a partner agreement without
// full-catalogue access comes back 403 ("Only available … when the app
// allows to preview tracks") — both are mapped to a typed error so the UI can
// say something friendly instead of a status code.
// ---------------------------------------------------------------------------

export const ES_BASE = "https://partner-content-api.epidemicsound.com";
export const ES_TIMEOUT_MS = 10_000;

export type EsErrorKind =
  | "not_connected"
  | "unauthorized" // 401 — the key is wrong or revoked
  | "forbidden" // 403 — the agreement doesn't cover this (search, or a download)
  | "rate_limited" // 429
  | "not_found" // 404
  | "unavailable" // 503 (carries Retry-After)
  | "timeout"
  | "network"
  | "http";

export class EpidemicSoundError extends Error {
  constructor(
    message: string,
    public kind: EsErrorKind,
    public status = 0,
    public retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "EpidemicSoundError";
  }
}

// ---- Shapes (the fields the hub reads; the API returns more) ---------------
export type EsMood = { id: string; name: string };
export type EsGenre = { id: string; name: string; parent?: { id: string; name: string } | null };
export type EsTrack = {
  id: string;
  title: string;
  mainArtists: string[];
  featuredArtists?: string[];
  bpm: number;
  /** seconds */
  length: number;
  moods: EsMood[];
  genres: EsGenre[];
  hasVocals?: boolean;
  vocalType?: "LEAD" | "PRESENCE" | "NONE" | string | null;
  isPreviewOnly?: boolean;
  isExplicit?: boolean;
  images?: { default?: string | null; S?: string | null; M?: string | null } | null;
  waveformUrl?: string;
};
export type EsCollection = { id: string; name: string; availableTracks?: number; tracks?: EsTrack[] };
export type EsPage<T> = { items: T[]; offset: number; hasMore: boolean };
export type EsSignedUrl = { url: string; expires: string };

export type EsQuery = Record<string, string | number | boolean | (string | number)[] | undefined | null>;
export type EsRequestInit = { query?: EsQuery; method?: "GET" | "POST"; body?: unknown };

export type EsClientConfig = {
  key: string;
  /** the anonymised, stable per-user id for x-partner-user-id */
  userId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Array parameters are REPEATED keys (genre=a&genre=b) — the docs say bracket
// notation is ignored.
export function buildEsUrl(path: string, query?: EsQuery): string {
  const u = new URL(path.startsWith("/") ? path : `/${path}`, ES_BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) u.searchParams.append(k, String(item));
    } else {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// The one request function. Typed errors, 10s timeout, no retries here — the
// callers are interactive (an editor clicking), so a 429 is shown, not spun on.
export async function esRequestWith<T = unknown>(cfg: EsClientConfig, path: string, init: EsRequestInit = {}): Promise<T> {
  if (!cfg.key) throw new EpidemicSoundError("Epidemic Sound is not connected.", "not_connected");
  const f = cfg.fetchImpl ?? fetch;
  const method = init.method ?? "GET";
  const url = buildEsUrl(path, init.query);
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "x-partner-user-id": cfg.userId,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? ES_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new EpidemicSoundError("Epidemic Sound didn't answer in time.", "timeout");
    }
    throw new EpidemicSoundError(`Couldn't reach Epidemic Sound (${(e as Error)?.message ?? "network"}).`, "network");
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body (edge page) — handled by status below */
  }
  if (!res.ok) throw mapHttpError(res, json, path);
  return json as T;
}

// The API's error body is { message } (MessageResponse) or { key, messages[] }.
function apiMessage(json: unknown): string | null {
  const j = json as { message?: string; messages?: string[]; key?: string } | undefined;
  if (!j || typeof j !== "object") return null;
  if (typeof j.message === "string" && j.message.trim()) return j.message.trim();
  if (Array.isArray(j.messages) && j.messages.length) return j.messages.join(" ");
  return null;
}

function mapHttpError(res: Response, json: unknown, path: string): EpidemicSoundError {
  const detail = apiMessage(json);
  const retryAfter = Number(res.headers.get("Retry-After"));
  const retryAfterS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  switch (res.status) {
    case 401:
      return new EpidemicSoundError("Epidemic Sound rejected the key.", "unauthorized", 401);
    case 403:
      return new EpidemicSoundError(
        /download/.test(path)
          ? "Our Epidemic Sound agreement doesn't allow downloading this track."
          : "Our Epidemic Sound agreement doesn't cover this — the catalogue is limited to curated collections.",
        "forbidden",
        403,
      );
    case 404:
      return new EpidemicSoundError("Epidemic Sound doesn't know that track.", "not_found", 404);
    case 429:
      return new EpidemicSoundError("Epidemic Sound is rate limiting us — try again in a minute.", "rate_limited", 429, retryAfterS);
    case 503:
      return new EpidemicSoundError("Epidemic Sound is busy — try again shortly.", "unavailable", 503, retryAfterS);
    default:
      return new EpidemicSoundError(detail ? `Epidemic Sound: ${detail}` : `Epidemic Sound ${res.status} on ${path}.`, "http", res.status);
  }
}

// ---- The catalogue calls ------------------------------------------------------
export type EsVocals = "any" | "instrumental" | "vocals";
export type EsSearchArgs = {
  term?: string;
  moods?: string[];
  genres?: string[];
  bpmMin?: number;
  bpmMax?: number;
  vocals?: EsVocals;
  sort?: "Relevance" | "Date" | "Title" | "Popularity" | "Duration" | "BPM";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

type TracksResponse = { tracks?: EsTrack[]; pagination?: { offset?: number; limit?: number }; links?: { next?: string | null } };

const clampInt = (n: number | undefined, lo: number, hi: number, dflt: number) =>
  n === undefined || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, Math.round(n)));

// vocalType is one classification per track (LEAD / PRESENCE / NONE), so
// "instrumental" is NONE and "with vocals" is LEAD — vocal chops (PRESENCE)
// read as instrumental to an editor cutting a listing reel.
// A usable BPM bound is a positive whole number; anything else is dropped
// rather than sent as "NaN" (Sep 15 — the slider and the AI's hint both feed
// this, so the guard sits here once).
const wholeBpm = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined);

function filterQuery(a: EsSearchArgs): EsQuery {
  const moods = (a.moods ?? []).filter(Boolean);
  const genres = (a.genres ?? []).filter(Boolean);
  // Jordan, Sep 15: "set the BPM with a slider" — the range rides on search
  // AND browse. A reversed pair is put the right way round; a lone bound goes
  // alone (the API treats a missing side as open).
  let bpmMin = wholeBpm(a.bpmMin);
  let bpmMax = wholeBpm(a.bpmMax);
  if (bpmMin !== undefined && bpmMax !== undefined && bpmMin > bpmMax) [bpmMin, bpmMax] = [bpmMax, bpmMin];
  return {
    mood: moods.length ? moods : undefined,
    genre: genres.length ? genres : undefined,
    bpmMin,
    bpmMax,
    vocalType: a.vocals === "instrumental" ? ["NONE"] : a.vocals === "vocals" ? ["LEAD"] : undefined,
    // Several chips of one kind read as "any of these" — allOf (the default)
    // would demand a track carry every mood ticked.
    filterBehaviour: moods.length > 1 || genres.length > 1 ? "anyOf" : undefined,
  };
}

// hasMore is the API's own word — every paginated response in the spec
// carries `links`, and a last page that happens to be exactly `limit` long
// must not offer a "Load more" that fetches nothing (review, Sep 15). The
// length heuristic is only the fallback for a body with no `links` at all.
function page<T>(items: T[] | undefined, offset: number, limit: number, links?: { next?: string | null } | null): EsPage<T> {
  const list = items ?? [];
  const hasMore = links && typeof links === "object" ? Boolean(links.next) : list.length >= limit;
  return { items: list, offset, hasMore };
}

export function esClient(cfg: EsClientConfig) {
  const req = <T,>(path: string, init?: EsRequestInit) => esRequestWith<T>(cfg, path, init);
  return {
    // Semantic search ("calm morning at a hilltop home") with the filters.
    async searchTracks(a: EsSearchArgs): Promise<EsPage<EsTrack>> {
      const limit = clampInt(a.limit, 1, 60, 24);
      const offset = clampInt(a.offset, 0, 100_000, 0);
      const r = await req<TracksResponse>("/v0/tracks/search", {
        query: {
          term: a.term?.trim().slice(0, 500) || undefined,
          ...filterQuery(a),
          sort: a.sort,
          order: a.order,
          limit,
          offset,
        },
      });
      return page(r.tracks, offset, limit, r.links);
    },
    // Browse by mood/genre/BPM with no term (limit up to 100).
    async browseTracks(a: Omit<EsSearchArgs, "term" | "sort" | "order">): Promise<EsPage<EsTrack>> {
      const limit = clampInt(a.limit, 1, 100, 24);
      const offset = clampInt(a.offset, 0, 100_000, 0);
      const r = await req<TracksResponse>("/v0/tracks", { query: { ...filterQuery(a), limit, offset } });
      return page(r.tracks, offset, limit, r.links);
    },
    async listMoods(opts: { limit?: number; offset?: number; sort?: "alphabetic" | "relevance" } = {}): Promise<EsPage<EsMood>> {
      const limit = clampInt(opts.limit, 1, 20, 20);
      const offset = clampInt(opts.offset, 0, 10_000, 0);
      const r = await req<{ moods?: EsMood[]; links?: { next?: string | null } }>("/v0/moods", {
        query: { limit, offset, sort: opts.sort },
      });
      return page(r.moods, offset, limit, r.links);
    },
    async listGenres(opts: { limit?: number; offset?: number; sort?: "alphabetic" | "relevance" } = {}): Promise<EsPage<EsGenre>> {
      const limit = clampInt(opts.limit, 1, 20, 20);
      const offset = clampInt(opts.offset, 0, 10_000, 0);
      const r = await req<{ genres?: EsGenre[]; links?: { next?: string | null } }>("/v0/genres", {
        query: { limit, offset, sort: opts.sort },
      });
      return page(r.genres, offset, limit, r.links);
    },
    // The curated collections — the whole catalogue on a collections-only
    // agreement, so this is the fallback when search is forbidden.
    async listCollections(opts: { limit?: number; offset?: number } = {}): Promise<EsPage<EsCollection>> {
      const limit = clampInt(opts.limit, 1, 20, 20);
      const offset = clampInt(opts.offset, 0, 10_000, 0);
      const r = await req<{ collections?: EsCollection[]; links?: { next?: string | null } }>("/v0/collections", {
        query: { excludeField: "tracks", limit, offset },
      });
      return page(r.collections, offset, limit, r.links);
    },
    async collectionTracks(collectionId: string, opts: { limit?: number; offset?: number } = {}): Promise<EsPage<EsTrack>> {
      const limit = clampInt(opts.limit, 1, 100, 24);
      const offset = clampInt(opts.offset, 0, 100_000, 0);
      const r = await req<{ tracks?: EsTrack[]; links?: { next?: string | null } }>(
        `/v0/collections/${encodeURIComponent(collectionId)}`,
        { query: { limit, offset } },
      );
      return page(r.tracks, offset, limit, r.links);
    },
    // HLS preview manifest (AAC), signed, expires in 24h.
    async trackStreamUrl(trackId: string): Promise<EsSignedUrl> {
      return req<EsSignedUrl>(`/v0/tracks/${encodeURIComponent(trackId)}/stream`);
    },
    // Signed MP3 URL — expires in 24h (normal, 128kbps) or 1h (high, 320kbps).
    async trackDownloadUrl(trackId: string, opts: { quality?: "normal" | "high" } = {}): Promise<EsSignedUrl> {
      return req<EsSignedUrl>(`/v0/tracks/${encodeURIComponent(trackId)}/download`, {
        query: { format: "mp3", quality: opts.quality ?? "high" },
      });
    },
    async similarTracks(trackId: string, opts: { limit?: number; offset?: number } = {}): Promise<EsPage<EsTrack>> {
      const limit = clampInt(opts.limit, 1, 60, 24);
      const offset = clampInt(opts.offset, 0, 100_000, 0);
      const r = await req<TracksResponse>(`/v0/tracks/${encodeURIComponent(trackId)}/similar`, { query: { limit, offset } });
      return page(r.tracks, offset, limit, r.links);
    },
    async trackMetadata(trackIds: string[]): Promise<EsTrack[]> {
      const ids = trackIds.filter(Boolean).slice(0, 50);
      if (!ids.length) return [];
      const r = await req<EsTrack[] | { tracks?: EsTrack[] }>("/v0/tracks/metadata", { query: { trackId: ids } });
      return Array.isArray(r) ? r : (r.tracks ?? []);
    },
    // Usage reporting — the reference's API-key path is POST /v0/analytics/report
    // (the auth guide's name for it), one trackDownloaded event per download.
    // Reported for EVERY download so the partner agreement's usage is honest;
    // the caller treats a failure as best-effort (log, never block the file).
    async reportUsage(ev: { trackId: string; quality?: "normal" | "high"; userId?: string; at?: Date }): Promise<{ batchId?: string; eventsCount?: number }> {
      return req<{ batchId?: string; eventsCount?: number }>("/v0/analytics/report", {
        method: "POST",
        body: {
          events: [
            {
              userId: ev.userId ?? cfg.userId,
              timestamp: (ev.at ?? new Date()).toISOString(),
              userConnected: false,
              analyticsEvent: { type: "trackDownloaded", trackId: ev.trackId, format: "mp3", quality: ev.quality ?? "high" },
            },
          ],
        },
      });
    },
  };
}

export type EsClient = ReturnType<typeof esClient>;

// ---- Display helpers (shared by the card and the PDF) --------------------------
export const esArtist = (t: Pick<EsTrack, "mainArtists" | "featuredArtists">): string =>
  [...(t.mainArtists ?? []), ...(t.featuredArtists ?? [])].filter(Boolean).join(", ") || "Unknown artist";

export function fmtTrackDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// What the card says for each failure — plain words, no status codes.
export function esFriendlyMessage(e: unknown): { message: string; kind: EsErrorKind } {
  if (e instanceof EpidemicSoundError) return { message: e.message, kind: e.kind };
  return { message: e instanceof Error ? e.message : "Something went wrong talking to Epidemic Sound.", kind: "http" };
}
