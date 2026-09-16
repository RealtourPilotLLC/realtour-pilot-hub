"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Check, CloudDownload, ExternalLink, Loader2, Music, Pause, Play, RefreshCw, Search, SlidersHorizontal, Sparkles, WandSparkles, X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "@/components/ui/Section";
import {
  BPM_MAX,
  BPM_MIN,
  BPM_PRESETS,
  BPM_STEP,
  bpmRangeLabel,
  clampBpmRange,
  fmtMusicDuration,
  musicPickLine,
  sameBpmRange,
  type BpmRange,
  type MusicPick,
} from "@/lib/musicPick";
import {
  collectionMusic,
  downloadTrackToJob,
  musicCollections,
  musicFilters,
  musicPreviewUrl,
  recommendMusicForJob,
  searchMusic,
  similarMusic,
  // Aliased: a `use…` name reads as a React hook to the lint rule, and this is
  // a server action, called from click handlers.
  useTrackForJob as pickTrackForJob,
  type MusicCollection,
  type MusicPage,
  type MusicRecommended,
  type MusicResult,
  type MusicTrack,
} from "@/components/editing/music.actions";
import type { EsVocals } from "@/lib/integrations/epidemicSoundCore";

// ---------------------------------------------------------------------------
// MUSIC — the editor finds a licensed track for the job right in the brief
// (Jordan, Sep 15: "they should be able to find music in the editor brief for
// copyright free music"). Sits under What to make: the editor sees what they
// are cutting, then picks what it sounds like.
//
// Search is semantic (a scene, not a title), the Moods and Genres chips load
// on demand, vocals is the one hard filter the API has; length is not
// filterable server-side, so the duration rides on every row. Play streams
// the HLS preview (hls.js in Chrome, native in Safari) from a signed URL a
// server action fetched — the API key never reaches this browser. "Use this
// track" writes the pick on the job; "Download to the job folder" puts the
// MP3 in the job's RAW-Video/Music folder in Dropbox.
//
// Sep 15, later (Jordan: "set the BPM with a slider … recommended songs based
// on the editing instructions"): a two-handle BPM range with Slow / Mid /
// Upbeat / Fast / Any presets rides on every search and browse, and a
// "Recommended for this edit" block at the top loads by itself when the card
// mounts — the server reads the spec, the photographer's vision, the video
// type and the client's brand notes (src/lib/musicRecommend.ts) and searches
// with what it found. Same Play / Similar / Use / Download on those rows;
// "Use these filters" copies its BPM, vocals and moods into the controls.
//
// Money never appears here (no pricing exists in the catalogue data). The
// files are licensed under RealTour Pilot's Epidemic Sound agreement for
// client deliverables only — the guide says so; the card says so at the top.
// ---------------------------------------------------------------------------

type Filters = { moods: { id: string; name: string }[]; genres: { id: string; name: string }[]; genresTruncated: boolean };
type View = { kind: "search" } | { kind: "collection"; id: string; name: string } | { kind: "similar"; of: MusicTrack };
// What a search may be handed instead of the controls' current state — the
// recommendation's "Use these filters" searches with values the controls are
// only just being set to (state isn't updated until the next render).
type SearchOverrides = Partial<{ term: string; moods: string[]; genres: string[]; vocals: EsVocals; bpm: BpmRange | null }>;

const HLS_MIME = "application/vnd.apple.mpegurl";
// How long Refresh rests after a fresh ask of the AI.
const REFRESH_COOLDOWN_MS = 5_000;

// "Load more" appends a page to the list on screen; `offset` stays where the
// whole list STARTS so the next request asks for offset + length.
const appendPage = (shown: MusicPage, next: MusicPage): MusicPage => ({
  ...next,
  offset: shown.offset,
  tracks: [...shown.tracks, ...next.tracks],
});

const vocalsWord = (v: EsVocals) => (v === "instrumental" ? "instrumental" : v === "vocals" ? "with vocals" : "vocals or instrumental");

// "elegant cinematic piano strings, instrumental, 70–110 BPM, Elegant · Hopeful"
const recoSummary = (r: MusicRecommended) =>
  [r.queries[0], vocalsWord(r.vocals), bpmRangeLabel(r.bpm).replace(/^Any BPM$/, "any BPM"), r.moods.map((m) => m.name).join(" · ")]
    .filter(Boolean)
    .join(", ");

export function MusicCard({
  projectId,
  connected,
  isOffice,
  canAct,
  pick: initialPick,
  pickUrl,
  musicType,
}: {
  projectId: string;
  connected: boolean;
  /** owner/admin — sees the "connect it" note when the key isn't in */
  isOffice: boolean;
  /** may pick + download (not a "view as" preview) */
  canAct: boolean;
  pick: MusicPick | null;
  /** the pick's "Open in Dropbox" link, when the MP3 is already in the job folder */
  pickUrl?: string | null;
  /** the spec's "Music type" line, as a hint under the search box */
  musicType?: string | null;
}) {
  const [pick, setPick] = useState<MusicPick | null>(initialPick);
  const [term, setTerm] = useState("");
  const [vocals, setVocals] = useState<EsVocals>("any");
  const [bpm, setBpm] = useState<BpmRange | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [moods, setMoods] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [collections, setCollections] = useState<MusicCollection[] | null>(null);
  const [showCollections, setShowCollections] = useState(false);
  const [view, setView] = useState<View>({ kind: "search" });
  const [page, setPage] = useState<MusicPage | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "muted" | "warn" | "ok" } | null>(null);
  const [searching, startSearch] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Seeded from the page so "Open in Dropbox" survives a reload, not just the
  // session that clicked Download (review, Sep 15).
  const [downloaded, setDownloaded] = useState<{ id: string; url: string } | null>(
    initialPick?.dropboxPath ? { id: initialPick.trackId, url: pickUrl ?? "" } : null,
  );

  // ---- Recommended for this edit ----------------------------------------
  const [reco, setReco] = useState<MusicRecommended | null>(null);
  // Starts "reading" whenever the catalogue is wired, so the server render
  // shows the spinner the mount effect is about to earn — not a flash of
  // "press Refresh" before hydration.
  // Collapsed until someone opens it (Jordan, Sep 16: "keep the music tab on
  // the editor brief minimized until it's clicked") — so an unopened card never
  // spends an AI or Epidemic Sound call, and the brief reads shorter.
  const [open, setOpen] = useState(false);
  const [recoBusy, setRecoBusy] = useState(false);
  const [recoNote, setRecoNote] = useState<string | null>(null);
  const recoAsked = useRef(false);
  // Refresh is a real AI call every time (it bypasses the per-job cache), so
  // it rests for a few seconds after each answer: a double-click or an
  // impatient second press must not fire two asks and two cache writes
  // (review, Sep 15). The ref is the guard, the state greys the button.
  const lastFreshAt = useRef(0);
  const [recoCooling, setRecoCooling] = useState(false);
  const coolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (coolTimer.current) clearTimeout(coolTimer.current); }, []);

  const loadReco = useCallback(
    async (fresh: boolean) => {
      if (fresh) {
        if (Date.now() - lastFreshAt.current < REFRESH_COOLDOWN_MS) return;
        lastFreshAt.current = Date.now();
      }
      setRecoBusy(true);
      setRecoNote(null);
      try {
        const r = await recommendMusicForJob(projectId, { fresh });
        if (!r.ok) {
          // Not connected: the block stays quiet — the connect note covers it.
          if (r.kind !== "not_connected") setRecoNote(r.message);
          return;
        }
        setReco(r.data);
        if (r.data.note) setRecoNote(r.data.note);
      } catch {
        setRecoNote("Couldn't read the edit instructions just now — press Refresh.");
      } finally {
        setRecoBusy(false);
        if (fresh) {
          lastFreshAt.current = Date.now();
          setRecoCooling(true);
          if (coolTimer.current) clearTimeout(coolTimer.current);
          coolTimer.current = setTimeout(() => setRecoCooling(false), REFRESH_COOLDOWN_MS);
        }
      }
    },
    [projectId],
  );

  // Auto-load once per mount when the catalogue is wired. Dev strict mode
  // mounts twice; the ref keeps it to one ask (and one AI call at most —
  // the answer is cached per job on the server anyway).
  useEffect(() => {
    if (!open || !connected || recoAsked.current) return;
    recoAsked.current = true;
    void loadReco(false);
  }, [open, connected, loadReco]);

  // ---- Preview playback: one <audio>, one hls.js instance ---------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const urlCache = useRef<Map<string, string>>(new Map());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPlayingId(null);
  }, []);
  useEffect(() => () => stop(), [stop]);

  const play = async (t: MusicTrack) => {
    if (playingId === t.id) return stop();
    stop();
    setLoadingId(t.id);
    try {
      let url = urlCache.current.get(t.id);
      if (!url) {
        const r = await musicPreviewUrl(projectId, t.id);
        if (!r.ok) return fromResult(r);
        url = r.data.url;
        urlCache.current.set(t.id, url);
      }
      const a = audioRef.current;
      if (!a) return;
      if (a.canPlayType(HLS_MIME)) {
        a.src = url; // Safari plays HLS natively
      } else {
        const { default: Hls } = await import("hls.js");
        if (!Hls.isSupported()) {
          setNote({ text: "This browser can't play the preview — try Chrome or Safari.", tone: "warn" });
          return;
        }
        const hls = new Hls({ enableWorker: false });
        hls.loadSource(url);
        hls.attachMedia(a);
        hls.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal) {
            setNote({ text: "The preview stream stopped — press play again.", tone: "warn" });
            stop();
          }
        });
        hlsRef.current = hls;
      }
      await a.play();
      setPlayingId(t.id);
    } catch {
      setNote({ text: "Couldn't start the preview — try again.", tone: "warn" });
      stop();
    } finally {
      setLoadingId(null);
    }
  };

  // ---- Notes from the server, in the card's own words -------------------
  function fromResult<T>(r: MusicResult<T>): void {
    if (r.ok) return;
    setNote({ text: r.message, tone: r.kind === "forbidden" || r.kind === "rate_limited" || r.kind === "not_connected" ? "warn" : "muted" });
    // Search isn't on the agreement → offer the collections instead.
    if (r.kind === "forbidden" && !showCollections) void openCollections();
  }

  // ---- Searching --------------------------------------------------------
  // The BPM range rides on search AND browse (a term-less search with chips
  // is the browse). Both bounds are omitted when the range is Any.
  const runSearch = (offset = 0, o: SearchOverrides = {}) =>
    startSearch(async () => {
      setNote(null);
      setView({ kind: "search" });
      const range = o.bpm === undefined ? bpm : o.bpm;
      const q = { term: o.term ?? term, moods: o.moods ?? moods, genres: o.genres ?? genres, vocals: o.vocals ?? vocals };
      const r = await searchMusic(projectId, { ...q, bpmMin: range?.min, bpmMax: range?.max, offset });
      if (!r.ok) return fromResult(r);
      setPage(offset && page ? appendPage(page, r.data) : r.data);
      if (r.data.tracks.length === 0 && offset === 0) {
        setNote({
          text: q.term
            ? "Nothing matched — try describing the scene differently, or loosen the chips or the BPM range."
            : "Nothing in the catalogue for those chips and that BPM range.",
          tone: "muted",
        });
      }
    });

  const openFilters = async () => {
    setShowFilters((s) => !s);
    if (filters) return;
    const r = await musicFilters(projectId);
    if (!r.ok) return fromResult(r);
    setFilters(r.data);
  };

  const openCollections = async () => {
    setShowCollections(true);
    if (collections) return;
    const r = await musicCollections(projectId);
    if (!r.ok) return fromResult(r);
    setCollections(r.data);
    if (r.data.length === 0) setNote({ text: "No collections are open to us yet — ask Jordan to check the Epidemic Sound agreement.", tone: "warn" });
  };

  const openCollection = (c: MusicCollection, offset = 0) =>
    startSearch(async () => {
      setNote(null);
      setView({ kind: "collection", id: c.id, name: c.name });
      const r = await collectionMusic(projectId, c.id, offset);
      if (!r.ok) return fromResult(r);
      setPage(offset && page ? appendPage(page, r.data) : r.data);
    });

  const openSimilar = (t: MusicTrack) =>
    startSearch(async () => {
      setNote(null);
      setView({ kind: "similar", of: t });
      const r = await similarMusic(projectId, t.id);
      if (!r.ok) return fromResult(r);
      setPage(r.data);
      if (r.data.tracks.length === 0) setNote({ text: "Nothing similar came back.", tone: "muted" });
    });

  // The accumulated list always starts at its first page's offset (appendPage
  // keeps it there), so the next page is start + everything shown. It used to
  // take the LAST page's offset and skipped tracks from the third page on
  // (review, Sep 15).
  const loadMore = () => {
    if (!page) return;
    const next = page.offset + page.tracks.length;
    if (view.kind === "collection") openCollection({ id: view.id, name: view.name, count: null }, next);
    else if (view.kind === "search") runSearch(next);
  };

  // "Use these filters": the recommendation's BPM, vocals and moods go into
  // the controls (mood chips by id — names the live list didn't know are
  // skipped), the chip panel opens so the ticks are visible, and a search
  // runs with exactly those values so the click shows something. The term
  // is whatever the box says (a phrase chip sets it first): the list and a
  // later Load more must page the SAME query (review, Sep 15).
  const recoMoodIds = () => (reco ? reco.moods.map((m) => m.id).filter((id): id is string => !!id) : []);
  const applyRecoFilters = (withTerm?: string) => {
    if (!reco) return;
    const ids = recoMoodIds();
    setVocals(reco.vocals);
    setBpm(reco.bpm);
    setMoods(ids);
    setGenres([]);
    if (withTerm !== undefined) setTerm(withTerm);
    if (ids.length && !showFilters) void openFilters();
    runSearch(0, { term: withTerm ?? term, vocals: reco.vocals, bpm: reco.bpm, moods: ids, genres: [] });
  };

  // ---- Pick + download --------------------------------------------------
  const use = async (t: MusicTrack) => {
    setBusyId(t.id);
    setNote(null);
    try {
      const r = await pickTrackForJob(projectId, t);
      if (!r.ok) return fromResult(r);
      setPick(r.data.pick);
      setDownloaded(r.data.pick.dropboxPath ? { id: r.data.pick.trackId, url: "" } : null);
      setNote({ text: `Picked — ${t.title} is on the brief now.`, tone: "ok" });
    } finally {
      setBusyId(null);
    }
  };

  const download = async (trackId: string, title: string) => {
    setBusyId(trackId);
    setNote({ text: `Pulling ${title} into the job's Dropbox folder…`, tone: "muted" });
    try {
      const r = await downloadTrackToJob(projectId, trackId, "high");
      if (!r.ok) return fromResult(r);
      setPick(r.data.pick);
      setDownloaded({ id: trackId, url: r.data.url });
      setNote({ text: `In Dropbox — 02-RAW-Video/Music/${r.data.fileName}`, tone: "ok" });
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const toggleOpen = () => {
    setOpen((o) => {
      if (o) stop(); // collapsing ends any preview
      return !o;
    });
  };
  const header = (
    <span className="inline-flex items-center gap-3">
      {!open && pick && (
        <span className="hidden max-w-64 truncate text-[11px] text-muted-2 sm:inline" title={`${pick.title} — ${pick.artist}`}>
          Picked: {pick.title} — {pick.artist}
        </span>
      )}
      <span className="hidden text-[11px] text-muted-2 lg:inline">Epidemic Sound · licensed for client deliverables only</span>
      {connected && (
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {open ? "Collapse" : "Open"}
        </button>
      )}
    </span>
  );

  // Not connected: the office is told where to go; editors never see this
  // card (the page hides it for them).
  if (!connected) {
    if (!isOffice) return null;
    return (
      <Section icon={Music} title="Music" action={header}>
        <p className="text-sm text-muted">
          <Link href="/connections" className="font-medium text-brand hover:underline">Connect Epidemic Sound on Connections</Link>{" "}
          and the editors can search, preview and download licensed music for this job right here.
        </p>
      </Section>
    );
  }

  const rowProps = { pick, busyId, playingId, loadingId, canAct, onPlay: play, onSimilar: openSimilar, onUse: use, onDownload: download };

  if (!open) {
    return (
      <Section icon={Music} title="Music" action={header}>
        <button
          type="button"
          onClick={toggleOpen}
          className="w-full rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-left text-sm text-muted hover:border-brand hover:text-foreground"
        >
          <span className="font-medium text-foreground">Open the music library</span>{" "}
          — recommendations for this edit, search, preview and download to the job folder.
        </button>
      </Section>
    );
  }

  return (
    <Section icon={Music} title="Music" action={header}>
      {/* The one preview player — a music preview, so no caption track. */}
      <audio ref={audioRef} preload="none" onEnded={() => setPlayingId(null)} className="hidden" />
      <div className="space-y-4">
        {/* RECOMMENDED FOR THIS EDIT — read off the instructions, loaded on
            mount. Hidden entirely when not connected (the branch above). */}
        <div data-music-reco className="rounded-xl border border-brand/25 bg-brand-soft/20 p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-brand">
              <WandSparkles className="size-3" /> Recommended for this edit
            </span>
            {reco?.source === "fallback" && (
              <span className="text-[10px] text-muted-2" title="The AI wasn't available, so the hub read the brief's own words.">hub&apos;s own read</span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              {reco && (
                <button type="button" onClick={() => applyRecoFilters()} className="text-[11px] font-medium text-brand hover:underline" title="Copy its BPM, vocals and moods into the search controls">
                  Use these filters
                </button>
              )}
              <button
                type="button"
                onClick={() => loadReco(true)}
                disabled={recoBusy || recoCooling}
                title={recoCooling ? "Just asked — give it a moment" : "Read the edit instructions again"}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3", recoBusy && "animate-spin")} /> Refresh
              </button>
            </span>
          </div>
          {reco ? (
            <>
              <p className="mt-1.5 text-xs text-foreground/90">
                Based on the edit instructions: <span className="font-medium">{recoSummary(reco)}</span>
              </p>
              <p className="text-xs text-muted">{reco.why}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {reco.queries.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => applyRecoFilters(q)}
                    title="Search this phrase with the recommended filters"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground/80 hover:border-brand"
                  >
                    <Search className="size-3" /> {q}
                  </button>
                ))}
              </div>
              {recoNote && <p className="mt-1.5 text-xs text-warning">{recoNote}</p>}
              {reco.tracks.length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-surface">
                  {reco.tracks.map((t) => (
                    <TrackRow key={t.id} t={t} {...rowProps} />
                  ))}
                </ul>
              )}
            </>
          ) : recoBusy ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="size-3.5 animate-spin" /> Reading the edit instructions…
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-muted">{recoNote ?? "No recommendation yet — press Refresh."}</p>
          )}
        </div>

        {/* THE PICK — what this job sounds like, on the brief. */}
        {pick && (
          <div className="rounded-xl border border-brand/30 bg-brand-soft/40 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-brand">
                <Check className="size-3" /> Picked for this job
              </span>
              <span className="text-sm font-medium text-foreground">{musicPickLine(pick)}</span>
              {pick.pickedBy && <span className="text-xs text-muted">by {pick.pickedBy}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {pick.dropboxPath ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                    <Check className="size-3" /> In the job folder · 02-RAW-Video/Music
                  </span>
                  {downloaded?.url && (
                    <a href={downloaded.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                      Open in Dropbox <ExternalLink className="size-3" />
                    </a>
                  )}
                </>
              ) : (
                <button
                  onClick={() => download(pick.trackId, pick.title)}
                  disabled={!canAct || busyId === pick.trackId}
                  title={canAct ? "Pull the MP3 into the job's RAW-Video/Music folder" : "Read-only preview"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {busyId === pick.trackId ? <Loader2 className="size-3.5 animate-spin" /> : <CloudDownload className="size-3.5" />}
                  Download to the job folder
                </button>
              )}
            </div>
          </div>
        )}

        {/* SEARCH — describe the scene. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(0);
          }}
          className="space-y-2"
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="calm morning at a hilltop home"
                maxLength={500}
                className="w-full rounded-lg border border-border bg-bg py-2 pl-8 pr-2.5 text-sm outline-none focus:border-brand"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Search
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex overflow-hidden rounded-lg border border-border">
              {(
                [
                  ["any", "Any"],
                  ["instrumental", "Instrumental"],
                  ["vocals", "With vocals"],
                ] as [EsVocals, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVocals(v)}
                  className={cn("px-2.5 py-1 font-medium", vocals === v ? "bg-brand text-white" : "bg-surface text-muted hover:text-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" onClick={openFilters} className={cn("rounded-lg border border-border px-2.5 py-1 font-medium", showFilters ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground")}>
              Moods &amp; genres{moods.length + genres.length > 0 ? ` · ${moods.length + genres.length}` : ""}
            </button>
            <button type="button" onClick={() => (showCollections ? setShowCollections(false) : openCollections())} className={cn("rounded-lg border border-border px-2.5 py-1 font-medium", showCollections ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground")}>
              Collections
            </button>
            {musicType && <span className="text-muted-2">Spec says: <span className="text-foreground/80">{musicType}</span></span>}
          </div>
          {/* BPM — Jordan, Sep 15: "set the BPM with a slider". */}
          <BpmControl value={bpm} onChange={setBpm} />
        </form>

        {showFilters && (
          <div className="space-y-2 rounded-xl border border-border bg-surface-2/40 p-3">
            {!filters ? (
              <p className="inline-flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Loading moods and genres…</p>
            ) : (
              <>
                <Chips label="Moods" items={filters.moods} selected={moods} onToggle={(id) => toggle(moods, setMoods, id)} />
                <Chips label={filters.genresTruncated ? "Top genres" : "Genres"} items={filters.genres} selected={genres} onToggle={(id) => toggle(genres, setGenres, id)} />
                {(moods.length > 0 || genres.length > 0) && (
                  <button type="button" onClick={() => { setMoods([]); setGenres([]); }} className="text-[11px] font-medium text-muted hover:text-foreground">
                    Clear chips
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {showCollections && (
          <div className="rounded-xl border border-border bg-surface-2/40 p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Curated collections</div>
            {!collections ? (
              <p className="inline-flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>
            ) : collections.length === 0 ? (
              <p className="text-xs text-muted">None open to us yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {collections.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openCollection(c)}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                      view.kind === "collection" && view.id === c.id ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-foreground/80 hover:border-brand",
                    )}
                  >
                    {c.name}{c.count != null ? ` · ${c.count}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {note && (
          <p className={cn("text-xs", note.tone === "warn" ? "rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-warning" : note.tone === "ok" ? "text-success" : "text-muted")}>
            {note.text}
          </p>
        )}

        {/* RESULTS */}
        {view.kind !== "search" && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>
              {view.kind === "collection" ? <>Collection · <span className="font-medium text-foreground">{view.name}</span></> : <>Similar to <span className="font-medium text-foreground">{view.of.title}</span></>}
            </span>
            <button type="button" onClick={() => { setView({ kind: "search" }); setPage(null); }} className="inline-flex items-center gap-0.5 font-medium hover:text-foreground">
              <X className="size-3" /> Back to search
            </button>
          </div>
        )}
        {page && page.tracks.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {page.tracks.map((t) => (
              <TrackRow key={t.id} t={t} {...rowProps} />
            ))}
          </ul>
        )}
        {page && page.hasMore && view.kind !== "similar" && (
          <button type="button" onClick={loadMore} disabled={searching} className="text-xs font-medium text-muted hover:text-foreground disabled:opacity-50">
            {searching ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </Section>
  );
}

// One track, the same row everywhere it appears (the recommendation, a
// search, a collection, a Similar list): Play · facts · Similar · Use ·
// Download. The BPM stays on every row — the slider narrows, the row tells.
function TrackRow({
  t,
  pick,
  busyId,
  playingId,
  loadingId,
  canAct,
  onPlay,
  onSimilar,
  onUse,
  onDownload,
}: {
  t: MusicTrack;
  pick: MusicPick | null;
  busyId: string | null;
  playingId: string | null;
  loadingId: string | null;
  canAct: boolean;
  onPlay: (t: MusicTrack) => void;
  onSimilar: (t: MusicTrack) => void;
  onUse: (t: MusicTrack) => void;
  onDownload: (trackId: string, title: string) => void;
}) {
  const isPick = pick?.trackId === t.id;
  const inDropbox = isPick && !!pick?.dropboxPath;
  const busy = busyId === t.id;
  return (
    <li className={cn("flex flex-wrap items-center gap-2 px-3 py-2", isPick && "bg-brand-soft/30")}>
      <button
        type="button"
        onClick={() => onPlay(t)}
        aria-label={playingId === t.id ? "Pause preview" : "Play preview"}
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-foreground hover:border-brand hover:text-brand"
      >
        {loadingId === t.id ? <Loader2 className="size-4 animate-spin" /> : playingId === t.id ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm font-medium">{t.title}</span>
          <span className="truncate text-xs text-muted">{t.artist}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-2">
          {t.bpm != null && <span>{t.bpm} BPM</span>}
          {t.durationSec != null && <span>{fmtMusicDuration(t.durationSec)}</span>}
          {t.vocals != null && <span>{t.vocals ? "vocals" : "instrumental"}</span>}
          {t.moods.map((m) => (
            <span key={m} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">{m}</span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={() => onSimilar(t)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted hover:text-foreground" title="Find tracks that sound like this one">
          <Sparkles className="size-3" /> Similar
        </button>
        <button
          type="button"
          onClick={() => onUse(t)}
          disabled={!canAct || busy || isPick}
          title={canAct ? "Put this track on the brief" : "Read-only preview"}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50",
            isPick ? "border-brand/40 bg-brand-soft text-brand" : "border-border bg-surface hover:border-brand",
          )}
        >
          {isPick ? <><Check className="size-3" /> Picked</> : "Use this track"}
        </button>
        <button
          type="button"
          onClick={() => onDownload(t.id, t.title)}
          disabled={!canAct || busy || inDropbox || t.previewOnly}
          title={t.previewOnly ? "Preview only on our agreement" : canAct ? "Pull the MP3 into the job's RAW-Video/Music folder" : "Read-only preview"}
          className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <CloudDownload className="size-3" />}
          {inDropbox ? "In Dropbox" : "Download"}
        </button>
      </div>
    </li>
  );
}

// The BPM range: two native range inputs stacked on one track (each thumb
// takes the pointer, the inputs themselves don't), so it is keyboard-
// accessible for free — Tab to a handle, arrows step by 5 — and needs no
// slider library. Presets set the pair in one click; "Any" is null, which
// sends no bpm at all. A handle can't cross the other one. When the two
// thumbs meet, whichever was touched last stays on top, so the pair can be
// pulled apart again by the handle that was just pushed (review, Sep 15 —
// the max thumb, last in the DOM, used to win every overlap but the top end).
const THUMB =
  "pointer-events-none absolute inset-0 h-4 w-full appearance-none bg-transparent focus-visible:outline-none " +
  "[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-sm " +
  "[&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-brand/40 " +
  "[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand [&::-moz-range-thumb]:bg-surface " +
  "[&:focus-visible::-moz-range-thumb]:ring-2 [&:focus-visible::-moz-range-thumb]:ring-brand/40";

function BpmControl({ value, onChange }: { value: BpmRange | null; onChange: (v: BpmRange | null) => void }) {
  const lo = value?.min ?? BPM_MIN;
  const hi = value?.max ?? BPM_MAX;
  const pct = (n: number) => ((n - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100;
  const setLo = (n: number) => onChange(clampBpmRange(Math.min(n, hi), hi));
  const setHi = (n: number) => onChange(clampBpmRange(lo, Math.max(n, lo)));
  const [top, setTop] = useState<"min" | "max">("max");
  return (
    <div data-bpm-control className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      <span className="inline-flex items-center gap-1 font-medium text-muted">
        <SlidersHorizontal className="size-3.5" /> BPM
      </span>
      <div className="inline-flex flex-wrap gap-1">
        {BPM_PRESETS.map((p) => {
          const on = sameBpmRange(p.range, value);
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.range)}
              aria-pressed={on}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                on ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-foreground/80 hover:border-brand",
              )}
            >
              {p.label}
              {p.hint && <span className={cn("ml-1", on ? "text-brand/70" : "text-muted-2")}>{p.hint}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex min-w-[220px] flex-1 items-center gap-2">
        <div className="relative h-4 flex-1">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border" />
          <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand" style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }} />
          <input
            type="range"
            aria-label="Minimum BPM"
            min={BPM_MIN}
            max={BPM_MAX}
            step={BPM_STEP}
            value={lo}
            onChange={(e) => setLo(Number(e.target.value))}
            onPointerDown={() => setTop("min")}
            onFocus={() => setTop("min")}
            style={{ zIndex: top === "min" ? 3 : 2 }}
            className={THUMB}
          />
          <input
            type="range"
            aria-label="Maximum BPM"
            min={BPM_MIN}
            max={BPM_MAX}
            step={BPM_STEP}
            value={hi}
            onChange={(e) => setHi(Number(e.target.value))}
            onPointerDown={() => setTop("max")}
            onFocus={() => setTop("max")}
            style={{ zIndex: top === "max" ? 3 : 2 }}
            className={THUMB}
          />
        </div>
        <span className="w-[84px] shrink-0 tabular-nums text-foreground/80" aria-live="polite">{bpmRangeLabel(value)}</span>
      </div>
    </div>
  );
}

function Chips({
  label,
  items,
  selected,
  onToggle,
}: {
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((m) => {
          const on = selected.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onToggle(m.id)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                on ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-foreground/80 hover:border-brand",
              )}
            >
              {m.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
