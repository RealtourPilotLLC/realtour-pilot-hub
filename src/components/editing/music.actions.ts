"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { slugForName } from "@/lib/assignees";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getConnection } from "@/lib/integrations/connections";
import { DropboxError, dropboxCreateFolder, dropboxUpload } from "@/lib/integrations/dropbox";
import {
  collectionTracks,
  epidemicSoundConnected,
  esPartnerUserId,
  listCollections,
  listGenres,
  listMoods,
  reportUsage,
  searchTracks,
  browseTracks,
  similarTracks,
  trackDownloadUrl,
  trackMetadata,
  trackStreamUrl,
} from "@/lib/integrations/epidemicSound";
import {
  EpidemicSoundError,
  esArtist,
  esFriendlyMessage,
  type EsErrorKind,
  type EsGenre,
  type EsMood,
  type EsPage,
  type EsTrack,
  type EsVocals,
} from "@/lib/integrations/epidemicSoundCore";
import { bpmQuery, clampBpmRange, musicPickOf, parseEditSpec, type BpmRange, type MusicPick } from "@/lib/musicPick";
import { buildMusicBriefContext, cachedRecommendation } from "@/lib/musicRecommend";

// ---------------------------------------------------------------------------
// The Music card's server actions (Sep 15 2026). Jordan: "the editor can
// browse and download songs via API connection in the editing room. They
// should be able to find music in the editor brief for copyright free music."
//
// Everything Epidemic Sound is behind these actions — the key is read on the
// server (src/lib/integrations/epidemicSound.ts) and never reaches a browser;
// the card only ever sees track facts, a signed preview URL and a Dropbox
// link. Every action guards with the job's editor scope or the office, the
// same rule the review and queue actions apply: owner/admin always, an EDITOR
// on a job whose open edit/revision task is theirs (or that names them as the
// editor). Photographers never pass — and never see the card.
//
// Beside the component (like cutMessage.actions.ts) rather than in
// /app/editing/actions.ts, which belongs to another lane this week.
// ---------------------------------------------------------------------------

export type MusicResult<T> = { ok: true; data: T } | { ok: false; message: string; kind: EsErrorKind | "access" | "dropbox" };

// What the card needs of a track — the API object is bigger (images, waveform).
export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  durationSec: number | null;
  moods: string[];
  genres: string[];
  /** true = sung/spoken vocals, false = instrumental, null = unknown */
  vocals: boolean | null;
  previewOnly: boolean;
};

const slim = (t: EsTrack): MusicTrack => ({
  id: t.id,
  title: t.title,
  artist: esArtist(t),
  bpm: typeof t.bpm === "number" ? t.bpm : null,
  durationSec: typeof t.length === "number" ? t.length : null,
  moods: (t.moods ?? []).map((m) => m.name).filter(Boolean).slice(0, 4),
  genres: (t.genres ?? []).map((g) => g.name).filter(Boolean).slice(0, 3),
  vocals: typeof t.hasVocals === "boolean" ? t.hasVocals : t.vocalType ? t.vocalType !== "NONE" : null,
  previewOnly: Boolean(t.isPreviewOnly),
});

const fail = <T,>(e: unknown): MusicResult<T> => {
  if (e instanceof DropboxError) return { ok: false, message: `Dropbox: ${e.message}`, kind: "dropbox" };
  const f = esFriendlyMessage(e);
  return { ok: false, message: f.message, kind: f.kind };
};

// ---- Access ---------------------------------------------------------------
// Reads (search, preview) are fine from an owner's "view as" preview — it is
// read-only everywhere; writes (pick, download) are not. Dev with auth off
// has no viewer and passes, like every other guard.
async function jobAccess(projectId: string, opts: { write: boolean }): Promise<CurrentUser | null> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforced()) throw new Error("Please sign in to do that.");
    return null;
  }
  if (opts.write && me.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  const role = opts.write ? me.realRole : me.role;
  if (role === "OWNER" || role === "ADMIN") return me;
  if (role === "EDITOR") {
    // Every key this human is addressable by — the same resolution
    // requireTaskAccess uses, so a renamed AppUser keeps their own jobs.
    const keys = new Set<string>();
    if (me.editorKey) keys.add(me.editorKey);
    if (me.name) keys.add(slugForName(me.name));
    if (me.teamMemberId) {
      const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { name: true } });
      if (tm?.name) keys.add(slugForName(tm.name));
    }
    keys.delete("");
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        editorId: true,
        smartTasks: {
          where: { taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          select: { assignedKey: true },
        },
      },
    });
    if (!p) throw new Error("That job no longer exists.");
    if (me.teamMemberId && p.editorId === me.teamMemberId) return me;
    if (p.smartTasks.some((t) => t.assignedKey && keys.has(t.assignedKey))) return me;
  }
  throw new Error("You don't have access to that job's music.");
}

const whoName = (me: CurrentUser | null) => me?.name ?? me?.realName ?? "the office";

// ---- Catalogue reads ------------------------------------------------------
// Walks a 20-a-page list until the API says there is no more, up to a cap.
// The first page's failure is the caller's; a later page failing just ends
// the walk early with what we have (the chips still render).
async function allPages<T extends { id: string }>(
  fetchPage: (offset: number) => Promise<EsPage<T>>,
  maxPages: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const seen = new Map<string, T>();
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    let p: EsPage<T>;
    try {
      p = await fetchPage(offset);
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    for (const x of p.items) seen.set(x.id, x);
    if (!p.hasMore || p.items.length === 0) return { items: [...seen.values()], truncated: false };
    offset += p.items.length;
  }
  return { items: [...seen.values()], truncated: true };
}

const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));

export type MusicFilters = {
  moods: { id: string; name: string }[];
  genres: { id: string; name: string }[];
  /** true when the genre walk hit its cap — the card labels them "Top genres" */
  genresTruncated: boolean;
};

// Moods + genres for the chips, loaded on demand. The API pages both 20 at a
// time: the ~46 moods fit in three pages; genres run to ~500 with the nested
// children, so that walk stops at ten pages (200, in the API's relevance
// order so the cap keeps the ones people actually use) and the card says
// "Top genres" when there were more (review, Sep 15). Both lists come back
// alphabetical so an editor can scan them.
export async function musicFilters(projectId: string): Promise<MusicResult<MusicFilters>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const o = { userId: esPartnerUserId(me?.id) };
    const [moods, genres] = await Promise.all([
      allPages<EsMood>((offset) => listMoods({ limit: 20, offset, sort: "alphabetic" }, o), 5),
      allPages<EsGenre>((offset) => listGenres({ limit: 20, offset, sort: "relevance" }, o), 10),
    ]);
    return {
      ok: true,
      data: {
        moods: byName(moods.items).map((m) => ({ id: m.id, name: m.name })),
        genres: byName(genres.items).map((g) => ({ id: g.id, name: g.name })),
        genresTruncated: genres.truncated,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

export type MusicSearchArgs = {
  term?: string;
  moods?: string[];
  genres?: string[];
  vocals?: EsVocals;
  /** the card's BPM slider — both omitted = Any (Jordan, Sep 15) */
  bpmMin?: number | null;
  bpmMax?: number | null;
  offset?: number;
};
export type MusicPage = { tracks: MusicTrack[]; offset: number; hasMore: boolean };

// A term is a semantic search ("calm morning at a hilltop home"); chips alone
// browse the library by mood/genre. Length can't be filtered server-side, so
// the duration rides on every row instead.
export async function searchMusic(projectId: string, args: MusicSearchArgs): Promise<MusicResult<MusicPage>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const o = { userId: esPartnerUserId(me?.id) };
    const term = (args.term ?? "").trim().slice(0, 500);
    // The slider's range, snapped to its bounds; a range that spans
    // everything sends nothing (clampBpmRange), so "Any" is truly any, and
    // a bound on the slider's own edge is left off (bpmQuery), so "150+"
    // keeps a track filed above 200.
    const bpm = clampBpmRange(args.bpmMin, args.bpmMax);
    const common = {
      moods: (args.moods ?? []).filter((x) => typeof x === "string").slice(0, 6),
      genres: (args.genres ?? []).filter((x) => typeof x === "string").slice(0, 6),
      vocals: args.vocals,
      ...bpmQuery(bpm),
      limit: 24,
      offset: Math.max(0, Math.floor(Number(args.offset) || 0)),
    };
    const r = term ? await searchTracks({ term, ...common }, o) : await browseTracks(common, o);
    return { ok: true, data: { tracks: r.items.map(slim), offset: r.offset, hasMore: r.hasMore } };
  } catch (e) {
    return fail(e);
  }
}

export type MusicCollection = { id: string; name: string; count: number | null };

// The curated collections — the whole reach on a collections-only agreement.
export async function musicCollections(projectId: string): Promise<MusicResult<MusicCollection[]>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const r = await listCollections({ limit: 20 }, { userId: esPartnerUserId(me?.id) });
    return {
      ok: true,
      data: r.items.map((c) => ({ id: c.id, name: c.name, count: typeof c.availableTracks === "number" ? c.availableTracks : null })),
    };
  } catch (e) {
    return fail(e);
  }
}

export async function collectionMusic(projectId: string, collectionId: string, offset = 0): Promise<MusicResult<MusicPage>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const r = await collectionTracks(collectionId, { limit: 24, offset: Math.max(0, Math.floor(offset)) }, { userId: esPartnerUserId(me?.id) });
    return { ok: true, data: { tracks: r.items.map(slim), offset: r.offset, hasMore: r.hasMore } };
  } catch (e) {
    return fail(e);
  }
}

export async function similarMusic(projectId: string, trackId: string): Promise<MusicResult<MusicPage>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const r = await similarTracks(trackId, { limit: 24 }, { userId: esPartnerUserId(me?.id) });
    return { ok: true, data: { tracks: r.items.map(slim), offset: 0, hasMore: false } };
  } catch (e) {
    return fail(e);
  }
}

// ---- Recommended for this edit ----------------------------------------------
// Jordan, Sep 15: "recommended songs based on the editing instructions". The
// reading of the brief and the AI ask (cached per job) live in
// src/lib/musicRecommend.ts; this action turns the answer into tracks: one
// search per phrase (8 each, with the BPM and vocals hints), interleaved so
// every phrase gets a say, deduped, twelve at most. The tracks are fetched
// fresh on every open — the preview URLs are signed and expire — only the
// AI's answer is cached. On a curated-only agreement (search → 403) it
// browses by the recommended moods instead; when even that is closed it says
// so and points at the collections. Not connected → not_connected, and the
// card shows nothing (the office's connect note already covers it).
export type MusicRecommended = {
  /** the AI's (or the keyword read's) one sentence */
  why: string;
  queries: string[];
  bpm: BpmRange | null;
  vocals: EsVocals;
  /** id is null when the name isn't in the live mood list */
  moods: { id: string | null; name: string }[];
  tracks: MusicTrack[];
  via: "search" | "browse" | "none";
  note: string | null;
  source: "ai" | "fallback";
};

// The live mood list, memoised an hour per lambda: the AI names moods, the
// filter wants ids, and the list changes about never.
let moodMemo: { at: number; byName: Map<string, EsMood> } | null = null;
async function moodIndex(o: { userId: string }): Promise<Map<string, EsMood>> {
  if (moodMemo && Date.now() - moodMemo.at < 60 * 60_000) return moodMemo.byName;
  const all = await allPages<EsMood>((offset) => listMoods({ limit: 20, offset, sort: "alphabetic" }, o), 5);
  const byName = new Map(all.items.map((m) => [m.name.trim().toLowerCase(), m] as const));
  moodMemo = { at: Date.now(), byName };
  return byName;
}

// Round-robin across the per-phrase pages so the list isn't eight of the
// first phrase and four of the second; first appearance wins.
function interleave(pages: EsTrack[][], cap: number): EsTrack[] {
  const out: EsTrack[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < cap; i++) {
    let any = false;
    for (const p of pages) {
      const t = p[i];
      if (!t) continue;
      any = true;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= cap) break;
    }
    if (!any) break;
  }
  return out;
}

export async function recommendMusicForJob(projectId: string, opts: { fresh?: boolean } = {}): Promise<MusicResult<MusicRecommended>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    if (!(await epidemicSoundConnected())) {
      return { ok: false, message: "Epidemic Sound isn't connected.", kind: "not_connected" };
    }
    const ctx = await buildMusicBriefContext(projectId);
    if (!ctx) return { ok: false, message: "That job no longer exists.", kind: "access" };
    const reco = await cachedRecommendation(projectId, ctx, { fresh: opts?.fresh === true });
    const o = { userId: esPartnerUserId(me?.id) };

    let byName = new Map<string, EsMood>();
    try {
      byName = await moodIndex(o);
    } catch (e) {
      console.warn("[epidemic-sound] mood list unavailable for the recommendation", projectId, e instanceof Error ? e.message : e);
    }
    const moods = reco.moods.map((name) => {
      const m = byName.get(name.trim().toLowerCase());
      return { id: m?.id ?? null, name: m?.name ?? name };
    });
    const moodIds = moods.map((m) => m.id).filter((id): id is string => !!id);
    const bpm = clampBpmRange(reco.bpmMin, reco.bpmMax);
    const vocals: EsVocals = reco.vocals === "instrumental" ? "instrumental" : "any";
    const hints = { ...bpmQuery(bpm), vocals };

    const settled = await Promise.allSettled(reco.queries.map((term) => searchTracks({ term, ...hints, limit: 8 }, o)));
    const pages = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value.items] : []));
    const failures = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    let tracks = interleave(pages, 12);
    let via: MusicRecommended["via"] = "search";
    let note: string | null = null;
    if (pages.length === 0) {
      const forbidden = failures.some((e) => e instanceof EpidemicSoundError && e.kind === "forbidden");
      if (!forbidden) throw failures[0] ?? new Error("Nothing came back from Epidemic Sound.");
      // Curated-only agreement: search is closed, browsing by mood may not be.
      try {
        const b = await browseTracks({ moods: moodIds, ...hints, limit: 12 }, o);
        tracks = b.items;
        via = "browse";
        note = "Search isn't on our Epidemic Sound agreement, so these are browsed by the recommended moods instead.";
      } catch (e) {
        via = "none";
        note = `${esFriendlyMessage(e).message} Try the collections below.`;
      }
    } else if (failures.length) {
      note = `Some of the searches didn't come back (${esFriendlyMessage(failures[0]).message})`;
    }
    if (via === "search" && tracks.length === 0) note = "Nothing matched the recommendation — try its phrases with the chips loosened.";
    return {
      ok: true,
      data: { why: reco.why, queries: reco.queries, bpm, vocals, moods, tracks: tracks.map(slim), via, note, source: reco.source },
    };
  } catch (e) {
    return fail(e);
  }
}

// The HLS preview manifest, signed by Epidemic Sound for 24h. Fetched here so
// the key never leaves the server; the browser only gets the signed URL.
export async function musicPreviewUrl(projectId: string, trackId: string): Promise<MusicResult<{ url: string; expires: string }>> {
  try {
    const me = await jobAccess(projectId, { write: false });
    const r = await trackStreamUrl(trackId, { userId: esPartnerUserId(me?.id) });
    return { ok: true, data: { url: r.url, expires: r.expires } };
  } catch (e) {
    return fail(e);
  }
}

// ---- The pick -------------------------------------------------------------
const cleanStr = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

// One pick per job, inside Project.editSpec (JSON) as `music` — picking again
// replaces it. The Review Room's "music was client's pick" cut-note convention
// is a different thing and untouched.
export async function useTrackForJob(projectId: string, track: MusicTrack): Promise<MusicResult<{ pick: MusicPick }>> {
  let me: CurrentUser | null;
  try {
    me = await jobAccess(projectId, { write: true });
  } catch (e) {
    return { ok: false, message: (e as Error).message, kind: "access" };
  }
  const trackId = cleanStr(track?.id, 120);
  const title = cleanStr(track?.title, 200);
  if (!TRACK_ID_RE.test(trackId) || !title) return { ok: false, message: "That track didn't come through properly — search again.", kind: "http" };
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { editSpec: true } });
  if (!project) return { ok: false, message: "That job no longer exists.", kind: "access" };
  const spec = parseEditSpec(project.editSpec);
  const prev = musicPickOf(spec);
  // The facts on the brief come from Epidemic Sound, not the browser — the
  // card's copy of title/artist/BPM is only the fallback when the lookup
  // can't answer right now (rate limited, timed out), so the PDF and the
  // Dropbox file name never carry a made-up title (review, Sep 15).
  let facts = {
    title,
    artist: cleanStr(track?.artist, 200),
    bpm: typeof track?.bpm === "number" && Number.isFinite(track.bpm) ? Math.round(track.bpm) : null,
    durationSec: typeof track?.durationSec === "number" && Number.isFinite(track.durationSec) ? Math.round(track.durationSec) : null,
  };
  try {
    const [meta] = await trackMetadata([trackId], { userId: esPartnerUserId(me?.id) });
    if (meta) {
      const s = slim(meta);
      facts = { title: cleanStr(s.title, 200) || title, artist: cleanStr(s.artist, 200), bpm: s.bpm, durationSec: s.durationSec };
    }
  } catch (e) {
    console.warn("[epidemic-sound] metadata lookup failed, keeping the card's facts", projectId, trackId, e instanceof Error ? e.message : e);
  }
  const pick: MusicPick = {
    provider: "epidemic_sound",
    trackId,
    ...facts,
    pickedBy: whoName(me),
    pickedAt: new Date().toISOString(),
    // Re-picking the same track keeps the file it already has in Dropbox.
    dropboxPath: prev && prev.trackId === trackId ? (prev.dropboxPath ?? null) : null,
  };
  await prisma.project.update({ where: { id: projectId }, data: { editSpec: JSON.stringify({ ...spec, music: pick }) } });
  await prisma.activity
    .create({
      data: {
        projectId,
        type: "SYSTEM",
        body: `Music: ${pick.title}${pick.artist ? ` — ${pick.artist}` : ""} picked by ${pick.pickedBy}`,
        authorId: me?.teamMemberId ?? null,
      },
    })
    .catch(() => {});
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, data: { pick } };
}

// ---- Download to the job folder -------------------------------------------
// A 320kbps MP3 runs ~2.4MB a minute; the cap leaves room for a ten-minute
// track and stops a bad link from filling a lambda.
const MAX_MP3_BYTES = 60 * 1024 * 1024;

async function fetchCapped(url: string, max: number): Promise<Buffer> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`The download link answered ${res.status} — try again.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`That file is ${Math.round(declared / 1e6)} MB — over the ${Math.round(max / 1e6)} MB cap.`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`That file is over the ${Math.round(max / 1e6)} MB cap.`);
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("The download came back empty — try again.");
  return Buffer.concat(chunks);
}

// A Dropbox-safe name piece: no path or reserved characters, no control
// characters, no trailing dot, capped.
const safeSegment = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 80)
    .trim() || "Untitled";

export type MusicDownload = { pick: MusicPick; path: string; fileName: string; url: string };

// Gets the signed MP3 link, pulls the file server-side (size-capped), puts it
// at <job folder>/02-RAW-Video/Music/<Artist> - <Title>.mp3 (overwriting the
// same name, so a second click is idempotent), records the path on the pick,
// reports the download to Epidemic Sound (best-effort — never blocks the
// file), and logs the job's timeline. Refuses up front when Dropbox has
// nowhere to put it.
export async function downloadTrackToJob(
  projectId: string,
  trackId: string,
  quality: "normal" | "high" = "high",
): Promise<MusicResult<MusicDownload>> {
  let me: CurrentUser | null;
  try {
    me = await jobAccess(projectId, { write: true });
  } catch (e) {
    return { ok: false, message: (e as Error).message, kind: "access" };
  }
  const id = cleanStr(trackId, 120);
  if (!TRACK_ID_RE.test(id)) return { ok: false, message: "That track id doesn't look right.", kind: "http" };
  const q: "normal" | "high" = quality === "normal" ? "normal" : "high";
  try {
    if (!(await epidemicSoundConnected())) {
      return { ok: false, message: "Epidemic Sound isn't connected — ask Jordan to connect it on Connections.", kind: "not_connected" };
    }
    const dbx = await getConnection("dropbox").catch(() => null);
    if (!dbx || dbx.status !== "CONNECTED" || !dbx.secretEncrypted) {
      return { ok: false, message: "Dropbox isn't connected, so the file has nowhere to go — connect Dropbox on Connections first.", kind: "dropbox" };
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        addressLine: true,
        shootDate: true,
        createdAt: true,
        editSpec: true,
        dropboxFolder: true,
        client: { select: { name: true } },
      },
    });
    if (!project) return { ok: false, message: "That job no longer exists.", kind: "access" };
    const uid = esPartnerUserId(me?.id);
    const spec = parseEditSpec(project.editSpec);
    const prev = musicPickOf(spec);

    // The facts for the file name + the pick: the current pick when it is
    // this track, else the track's metadata from Epidemic Sound.
    let facts: { title: string; artist: string; bpm: number | null; durationSec: number | null };
    if (prev && prev.trackId === id) {
      facts = { title: prev.title, artist: prev.artist, bpm: prev.bpm, durationSec: prev.durationSec };
    } else {
      const [meta] = await trackMetadata([id], { userId: uid });
      if (!meta) return { ok: false, message: "Epidemic Sound doesn't know that track.", kind: "not_found" };
      const s = slim(meta);
      facts = { title: s.title, artist: s.artist, bpm: s.bpm, durationSec: s.durationSec };
    }

    const { url: signed } = await trackDownloadUrl(id, { quality: q }, { userId: uid });
    const bytes = await fetchCapped(signed, MAX_MP3_BYTES);

    const folders = actualFolderPaths(project); // the job's OWN folder (Sep 8 audit), not the convention path
    const musicFolder = `${folders.rawVideo}/Music`;
    const fileName = `${safeSegment(facts.artist || "Epidemic Sound")} - ${safeSegment(facts.title)}.mp3`;
    const path = `${musicFolder}/${fileName}`;
    await dropboxCreateFolder(musicFolder);
    await dropboxUpload(path, bytes, { overwrite: true });

    const now = new Date().toISOString();
    const pickChanged = !prev || prev.trackId !== id;
    const pick: MusicPick = {
      provider: "epidemic_sound",
      trackId: id,
      title: facts.title,
      artist: facts.artist,
      bpm: facts.bpm,
      durationSec: facts.durationSec,
      pickedBy: pickChanged ? whoName(me) : prev.pickedBy,
      pickedAt: pickChanged ? now : prev.pickedAt,
      dropboxPath: path,
    };
    await prisma.project.update({ where: { id: projectId }, data: { editSpec: JSON.stringify({ ...spec, music: pick }) } });
    const lines = [
      ...(pickChanged ? [`Music: ${pick.title}${pick.artist ? ` — ${pick.artist}` : ""} picked by ${whoName(me)}`] : []),
      `Music: ${pick.title} downloaded to Dropbox by ${whoName(me)}`,
    ];
    for (const body of lines) {
      await prisma.activity.create({ data: { projectId, type: "SYSTEM", body, authorId: me?.teamMemberId ?? null } }).catch(() => {});
    }

    // Usage reporting is part of the partner agreement — every download,
    // under the same anonymised id — but a failure here must never cost the
    // editor the file they already have.
    try {
      await reportUsage({ trackId: id, quality: q, userId: uid });
    } catch (e) {
      console.warn("[epidemic-sound] usage report failed", projectId, id, e instanceof Error ? e.message : e);
    }

    revalidatePath(`/edit/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      data: { pick, path, fileName, url: `${dropboxWebUrl(musicFolder)}?preview=${encodeURIComponent(fileName)}` },
    };
  } catch (e) {
    return fail(e);
  }
}
