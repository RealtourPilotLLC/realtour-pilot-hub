import "server-only";
import { createHash } from "crypto";
import { getConnection, getSecret } from "./connections";
import {
  EpidemicSoundError,
  esClient,
  esRequestWith,
  type EsClientConfig,
  type EsRequestInit,
  type EsSearchArgs,
} from "./epidemicSoundCore";

// ---------------------------------------------------------------------------
// Epidemic Sound — the server side (Sep 15 2026). Jordan: "the editor can
// browse and download songs via API connection in the editing room … I have it
// and I have my API key." The key is pasted ONCE on Connections and stored
// through the same encrypted plumbing as every other provider (saveSecret);
// it is read back here and nowhere else, so it never reaches a browser — the
// Music card on /edit calls server actions, which call this.
//
// The HTTP work is in epidemicSoundCore.ts (pure, unit-tested against a mocked
// fetch). This file only adds what needs the server: the secret, and the
// stable ANONYMISED per-user id Epidemic Sound wants on every request
// (x-partner-user-id) — a sha256 of the hub user id, never a name or email.
// ---------------------------------------------------------------------------

export const ES_PROVIDER = "epidemic_sound";

// Stable + anonymised: the same hub user always reports as the same id, and
// the id says nothing about who they are. Truncated to 32 hex chars.
export function esPartnerUserId(hubUserId: string | null | undefined): string {
  return createHash("sha256").update(`rtp-es:${hubUserId || "anonymous"}`).digest("hex").slice(0, 32);
}

// Connected = a CONNECTED row whose secret still decrypts (getSecret is the
// same test the connections page makes: a stored-but-unreadable key is not a
// connection).
export async function epidemicSoundConnected(): Promise<boolean> {
  const c = await getConnection(ES_PROVIDER).catch(() => null);
  if (!c || c.status !== "CONNECTED" || !c.secretEncrypted) return false;
  return Boolean(await getSecret(ES_PROVIDER));
}

async function cfg(userId?: string | null, key?: string): Promise<EsClientConfig> {
  const k = key ?? (await getSecret(ES_PROVIDER));
  if (!k) throw new EpidemicSoundError("Epidemic Sound is not connected.", "not_connected");
  return { key: k, userId: userId ?? esPartnerUserId(null) };
}

export type EsCallOpts = { userId?: string | null };

// The generic request, for anything the named helpers below don't cover.
export async function esRequest<T = unknown>(path: string, init: EsRequestInit & EsCallOpts = {}): Promise<T> {
  return esRequestWith<T>(await cfg(init.userId), path, init);
}

export const searchTracks = async (a: EsSearchArgs, o: EsCallOpts = {}) => esClient(await cfg(o.userId)).searchTracks(a);
export const browseTracks = async (a: Omit<EsSearchArgs, "term" | "sort" | "order">, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).browseTracks(a);
export const listMoods = async (p: { limit?: number; offset?: number; sort?: "alphabetic" | "relevance" } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).listMoods(p);
export const listGenres = async (p: { limit?: number; offset?: number; sort?: "alphabetic" | "relevance" } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).listGenres(p);
export const listCollections = async (p: { limit?: number; offset?: number } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).listCollections(p);
export const collectionTracks = async (id: string, p: { limit?: number; offset?: number } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).collectionTracks(id, p);
export const trackStreamUrl = async (id: string, o: EsCallOpts = {}) => esClient(await cfg(o.userId)).trackStreamUrl(id);
export const trackDownloadUrl = async (id: string, p: { quality?: "normal" | "high" } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).trackDownloadUrl(id, p);
export const similarTracks = async (id: string, p: { limit?: number; offset?: number } = {}, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId)).similarTracks(id, p);
export const trackMetadata = async (ids: string[], o: EsCallOpts = {}) => esClient(await cfg(o.userId)).trackMetadata(ids);
export const reportUsage = async (ev: { trackId: string; quality?: "normal" | "high"; userId?: string }, o: EsCallOpts = {}) =>
  esClient(await cfg(o.userId ?? ev.userId)).reportUsage(ev);

// ---- Test connection (Connections page) ---------------------------------------
// What the partner agreement actually opens up, in one line: the key works
// (GET /v0/moods?limit=1), and whether full-catalogue SEARCH is on it or only
// the curated collections are (a 403 on /v0/tracks/search is the documented
// "not on this agreement" answer, not a broken key).
export type EsReach = {
  moods: number;
  collections: number;
  search: "full" | "curated" | "empty";
  label: string;
  note: string;
};

export async function epidemicSoundReach(key?: string): Promise<EsReach> {
  const c = esClient(await cfg(null, key));
  await c.listMoods({ limit: 1 }); // the auth check — throws unauthorized / rate_limited
  const [moodsPage, collectionsPage] = await Promise.all([
    c.listMoods({ limit: 20 }).catch(() => ({ items: [], hasMore: false, offset: 0 })),
    c.listCollections({ limit: 20 }).catch(() => ({ items: [], hasMore: false, offset: 0 })),
  ]);
  let search: EsReach["search"] = "empty";
  try {
    const r = await c.searchTracks({ term: "calm beach morning", limit: 1 });
    search = r.items.length ? "full" : "empty";
  } catch (e) {
    if (e instanceof EpidemicSoundError && e.kind === "forbidden") search = "curated";
    else throw e;
  }
  // The API pages moods 20 at a time with no total, so "20+" is the honest
  // count when there is another page.
  const moods = moodsPage.items.length;
  const collections = collectionsPage.items.length;
  const moodsText = `${moods}${moodsPage.hasMore ? "+" : ""} mood${moods === 1 ? "" : "s"}`;
  const collText = `${collections}${collectionsPage.hasMore ? "+" : ""} collection${collections === 1 ? "" : "s"}`;
  const searchText =
    search === "full"
      ? "full catalogue search"
      : search === "curated"
        ? "curated collections only (search isn't on this agreement)"
        : "search on, but it returned nothing";
  return {
    moods,
    collections,
    search,
    label: `Epidemic Sound · ${search === "full" ? "full catalogue" : search === "curated" ? "curated collections" : "search returned nothing"}`,
    note: `Key works — ${moodsText}, ${collText}, ${searchText}.`,
  };
}

// The Connections tester (same shape as testSlackKey & co): a 401/403 reads
// "rejected the key", a 429 "rate limited — try again in a minute".
export async function testEpidemicSoundKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const k = key.trim();
  if (!k.startsWith("epidemic_live_")) {
    return { ok: false, error: "That doesn't look like a Partner Content API key — it should start with epidemic_live_." };
  }
  try {
    const r = await epidemicSoundReach(k);
    return { ok: true, label: r.label };
  } catch (e) {
    if (e instanceof EpidemicSoundError) {
      if (e.kind === "unauthorized" || e.kind === "forbidden") return { ok: false, error: "Epidemic Sound rejected the key." };
      if (e.kind === "rate_limited") return { ok: false, error: "Epidemic Sound is rate limiting us — try again in a minute." };
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
