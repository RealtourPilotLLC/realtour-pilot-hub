"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronLeft, ChevronRight, ImageUp, Loader2, Merge, Scissors, Trash2, Upload, X } from "lucide-react";
import { createUploadLinks, finalizeCullUpload } from "@/app/upload/cullActions";

// ---------------------------------------------------------------------------
// Cull BEFORE upload. Pick the card's JPGs → they collapse into bracket SETS
// (5-bracket interiors, single-shot drone) → tap the junk out → only keepers
// upload, straight to the job's 01-RAW-Photos folder via temporary links.
//
// Grouping: brackets fire in a burst, so consecutive frames ≤2.5s apart are
// one set (capped at 7 for messy triggers); DJI_* files are drone singles.
// When the guess is off, the viewer can SPLIT at any frame or MERGE with the
// next set — Jordan: "sometimes it's messy and we have more or less".
//
// The photo itself opens a full-screen LIGHTBOX: ‹ › (or arrow keys) move
// between sets, the keep/drop button (or space) selects, the filmstrip flips
// through a set's brackets. The small ✓/✕ badge on a tile toggles without
// opening.
// ---------------------------------------------------------------------------

const GAP_MS = 2500;
const UPLOAD_CONCURRENCY = 4;
const LINKS_PER_CALL = 25; // links minted per server round-trip, as the upload progresses

type CullSet = {
  id: number;
  files: File[];
  keep: boolean;
  drone: boolean;
};

type Phase = "pick" | "cull" | "uploading" | "done";

// Staged sets survive in-app navigation (File handles live fine in memory for
// the life of the SPA session — checking another tab must not lose the cull).
// A real page reload still clears it: browsers can't rehydrate File handles.
const cullStash = new Map<string, { sets: CullSet[]; phase: Phase }>();

const isDrone = (f: File) => /^DJI[_-]/i.test(f.name);

function groupFiles(files: File[], bracket: number): CullSet[] {
  const sorted = [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
  const sets: CullSet[] = [];
  let cur: File[] = [];
  let id = 0;
  const flush = () => {
    if (cur.length > 0) sets.push({ id: id++, files: cur, keep: true, drone: cur.every(isDrone) });
    cur = [];
  };
  // Cap sets AT the bracket size: machine-gunned back-to-back bursts (<2.5s
  // between compositions) must split ON the bracket boundary, never mid-HDR.
  // A messy 6th trigger becomes a ×1 the viewer can merge back in.
  const cap = Math.max(1, bracket);
  for (const f of sorted) {
    const prev = cur[cur.length - 1];
    const sameBurst = prev && !isDrone(f) && !isDrone(prev) && f.lastModified - prev.lastModified <= GAP_MS && cur.length < cap;
    if (!sameBurst) flush();
    cur.push(f);
    if (isDrone(f)) flush(); // drone = single-shot sets
  }
  flush();
  return sets;
}

// Lazy thumbnail: object URL created only when the element is near the viewport,
// revoked when it unmounts (a 600-JPG card would eat a phone's memory otherwise).
function Thumb({ file, className, imgClass }: { file: File; className?: string; imgClass?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setUrl(null); // file changed — drop the stale image immediately
    let obj: string | null = null;
    const io = new IntersectionObserver(
      (es) => {
        if (es[0]?.isIntersecting && !obj) {
          obj = URL.createObjectURL(file);
          setUrl(obj);
          io.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [file]);
  return (
    <div ref={ref} className={className ?? "aspect-[3/2] w-full bg-surface-2"}>
      {url ? (
        <img src={url} alt={file.name} decoding="async" className={imgClass ?? "size-full object-cover"} />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-2"><Camera className="size-5" /></div>
      )}
    </div>
  );
}

export function CullUploader({ projectId, photoTarget, bracket }: { projectId: string; photoTarget: number; bracket: number }) {
  // Restore anything staged before a navigation away. An upload that was
  // mid-flight when the page was left may have finished in the background —
  // land back on the cull screen with an honest warning instead of guessing.
  const stashed = cullStash.get(projectId);
  const [phase, setPhase] = useState<Phase>(stashed && stashed.sets.length > 0 ? "cull" : "pick");
  const [sets, setSets] = useState<CullSet[]>(stashed?.sets ?? []);
  const [err, setErr] = useState<string | null>(
    stashed?.phase === "uploading"
      ? "Heads up — an upload was running when you left this page. If it finished, these photos are already in Dropbox (the files list below will show them); only re-upload what's missing."
      : null,
  );
  const [viewerIdx, setViewerIdx] = useState<number | null>(null); // index into sets
  const [heroIdx, setHeroIdx] = useState(0); // frame within the open set
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the stash in sync so leaving the page (in-app) never loses the cull.
  useEffect(() => {
    if ((phase === "cull" || phase === "uploading") && sets.length > 0) cullStash.set(projectId, { sets, phase });
    else cullStash.delete(projectId);
  }, [phase, sets, projectId]);

  // A hard reload/close WOULD lose staged files — warn while work is at stake.
  useEffect(() => {
    const atRisk = (phase === "cull" && sets.length > 0) || phase === "uploading";
    if (!atRisk) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase, sets.length]);

  function onPick(list: FileList | null) {
    setErr(null);
    const files = [...(list ?? [])].filter((f) => /\.(jpe?g)$/i.test(f.name));
    if (files.length === 0) {
      setErr("No JPGs in that selection — pick the photo files off your card.");
      return;
    }
    setSets(groupFiles(files, bracket));
    setPhase("cull");
  }

  const kept = sets.filter((s) => s.keep);
  const keptFiles = kept.reduce((n, s) => n + s.files.length, 0);
  const droppedFiles = sets.reduce((n, s) => n + (s.keep ? 0 : s.files.length), 0);
  const estFinals = kept.length; // one final per kept set
  const overBudget = estFinals > Math.round(photoTarget * 1.15);

  const toggle = (id: number) => setSets((ss) => ss.map((s) => (s.id === id ? { ...s, keep: !s.keep } : s)));

  // Split the set at frame index (frame becomes the first of a NEW set).
  const splitAt = (id: number, frameIdx: number) =>
    setSets((ss) => {
      const i = ss.findIndex((s) => s.id === id);
      if (i < 0 || frameIdx <= 0) return ss;
      const s = ss[i];
      const maxId = Math.max(...ss.map((x) => x.id)) + 1;
      const a = { ...s, files: s.files.slice(0, frameIdx) };
      const b = { ...s, id: maxId, files: s.files.slice(frameIdx) };
      return [...ss.slice(0, i), a, b, ...ss.slice(i + 1)];
    });

  const mergeNext = (id: number) =>
    setSets((ss) => {
      const i = ss.findIndex((s) => s.id === id);
      if (i < 0 || i === ss.length - 1) return ss;
      const merged = { ...ss[i], files: [...ss[i].files, ...ss[i + 1].files], keep: ss[i].keep || ss[i + 1].keep };
      return [...ss.slice(0, i), merged, ...ss.slice(i + 2)];
    });

  const [failedList, setFailedList] = useState<File[]>([]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setPhase("uploading");
    setErr(null);
    setProgress({ done: 0, total: files.length, failed: 0 });

    // Links are minted in small batches AS the upload progresses (not all up
    // front): each server call stays fast, one bad batch only costs those
    // photos (they land in the retry list), and the first bytes move within a
    // second of pressing Upload.
    const failures: File[] = [];
    let linkErr: string | null = null;
    const putOne = async ({ f, url }: { f: File; url: string }) => {
      const attempt = () =>
        fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f }).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        });
      try {
        await attempt();
      } catch {
        try {
          await new Promise((r) => setTimeout(r, 800));
          await attempt(); // one retry after a breather
        } catch {
          failures.push(f);
        }
      }
      setProgress((p) => ({ ...p, done: p.done + 1, failed: failures.length }));
    };

    for (let i = 0; i < files.length; i += LINKS_PER_CALL) {
      const batch = files.slice(i, i + LINKS_PER_CALL);
      const names = batch.map((f) => f.name);
      let linkRes = await createUploadLinks(projectId, names).catch(() => null);
      if (!linkRes?.ok || !linkRes.links || linkRes.links.length !== batch.length) {
        await new Promise((r) => setTimeout(r, 1500)); // transient blip? one more try
        linkRes = await createUploadLinks(projectId, names).catch(() => null);
      }
      if (!linkRes?.ok || !linkRes.links || linkRes.links.length !== batch.length) {
        failures.push(...batch);
        linkErr = (linkRes && !linkRes.ok && linkRes.message) || "Couldn't reach the hub for upload links — check your connection.";
        setProgress((p) => ({ ...p, done: p.done + batch.length, failed: failures.length }));
        continue; // keep going — the rest of the shoot still uploads
      }
      // Pair POSITIONALLY (the server preserves input order): two cards can both
      // have an IMG_0001.jpg, and each one-time link is good for exactly one file.
      const queue = batch.map((f, j) => ({ f, url: linkRes!.links![j].url }));
      await Promise.all(
        Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
          for (;;) {
            const item = queue.shift();
            if (!item) return;
            await putOne(item);
          }
        }),
      );
    }

    setFailedList(failures);
    if (linkErr) setErr(linkErr);
    await finalizeCullUpload(projectId, {
      keptSets: kept.length,
      totalSets: sets.length,
      uploadedFiles: files.length - failures.length,
      droppedFiles,
      failedFiles: failures.length,
    }).catch(() => {});
    setProgress((p) => ({ ...p, failed: failures.length }));
    setPhase("done");
  }
  const upload = () => uploadFiles(kept.flatMap((s) => s.files));

  // ---- Lightbox state ------------------------------------------------------
  const viewerSet = viewerIdx != null ? sets[viewerIdx] ?? null : null;
  const viewerSetId = viewerSet?.id;
  const setsRef = useRef(sets);
  setsRef.current = sets; // fresh sets for the keyboard handler + arrow clamp

  // Sets can shrink (merge) while the viewer is open — keep the index in range.
  useEffect(() => {
    if (viewerIdx != null && viewerIdx >= sets.length) setViewerIdx(sets.length > 0 ? sets.length - 1 : null);
  }, [viewerIdx, sets.length]);

  // A DIFFERENT set on screen → land on its middle frame (the 0EV exposure on
  // brackets). Keyed on the set's id so keep/drop toggles don't reset the frame.
  useEffect(() => {
    if (viewerIdx == null) return;
    const cur = setsRef.current[viewerIdx];
    if (cur) setHeroIdx(Math.floor(cur.files.length / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerSetId]);

  const go = (d: 1 | -1) =>
    setViewerIdx((i) => {
      if (i == null) return i;
      const n = i + d;
      return n < 0 || n >= setsRef.current.length ? i : n;
    });

  // Keyboard: ← → move between sets, space keeps/drops, Esc closes.
  useEffect(() => {
    if (viewerIdx == null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") setViewerIdx(null);
      else if (e.key === " ") {
        e.preventDefault();
        const cur = setsRef.current[viewerIdx];
        if (cur) toggle(cur.id);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [viewerIdx]);

  const hero = useMemo(
    () => (viewerSet ? viewerSet.files[Math.min(heroIdx, viewerSet.files.length - 1)] : null),
    [viewerSet, heroIdx],
  );

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <ImageUp className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Photos — cull, then upload</h2>
        {phase === "cull" && (
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${overBudget ? "bg-warning/15 text-warning" : "bg-success/10 text-success"}`}>
            {estFinals} sets ≈ {estFinals} finals · target ~{photoTarget}
          </span>
        )}
      </div>

      {phase === "pick" && (
        <div className="mt-3">
          <p className="text-xs text-muted">
            Pick every JPG off the card — they&rsquo;ll collapse into {bracket}-bracket sets (drone shots stay single). Drop the junk
            here FIRST, then only the keepers upload. Saves your data and the editor&rsquo;s time.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,image/jpeg"
            className="hidden"
            onChange={(e) => onPick(e.target.files)}
          />
          <button
            onClick={() => inputRef.current?.click()}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            <Camera className="size-4" /> Pick photos from the card
          </button>
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        </div>
      )}

      {phase === "cull" && (
        <>
          <p className="mt-2 text-xs text-muted">
            Tap a photo to open it big — arrows flip through, keep or drop right there. The ✓/✕ badge keeps/drops without opening.
            Keep the best ONE set per room/composition. Your picks stay put if you leave this page and come back.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {sets.map((s, idx) => (
              <div key={s.id} className={`relative overflow-hidden rounded-lg border transition-opacity ${s.keep ? "border-success/60" : "border-danger/40 opacity-45"}`}>
                <button type="button" onClick={() => setViewerIdx(idx)} className="block w-full" title="Open in the viewer">
                  <Thumb file={s.files[Math.floor(s.files.length / 2)]} />
                </button>
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/65 px-1 py-0.5 text-[10px] font-semibold text-white">
                  {s.drone ? "drone" : `×${s.files.length}`}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-label={s.keep ? "Drop this set" : "Keep this set"}
                  title={s.keep ? "Tap to drop this set" : "Tap to keep this set"}
                  className={`absolute right-1 top-1 rounded-full p-1 text-white ${s.keep ? "bg-success" : "bg-danger"}`}
                >
                  {s.keep ? <Check className="size-3" /> : <X className="size-3" />}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={upload}
              disabled={keptFiles === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              <Upload className="size-4" /> Upload {kept.length} sets ({keptFiles} JPGs)
            </button>
            <span className="text-xs text-muted-2">{droppedFiles} culled — never leaves your device</span>
            <button onClick={() => { setSets([]); setPhase("pick"); }} className="ml-auto text-xs text-muted hover:text-foreground">Start over</button>
          </div>
          {overBudget && (
            <p className="mt-2 text-xs text-warning">
              Heads up: {estFinals} finals is over the ~{photoTarget} budget for this home — tighten it if you can.
            </p>
          )}
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        </>
      )}

      {phase === "uploading" && (
        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin text-brand" /> Uploading {progress.done}/{progress.total} JPGs…
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-brand transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <p className="text-[11px] text-muted-2">Straight to the job&rsquo;s 01-RAW-Photos folder — keep this page open.</p>
        </div>
      )}

      {phase === "done" && (
        <div className="mt-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
            <Check className="size-4" /> {progress.total - progress.failed} JPGs uploaded — culled {droppedFiles} before upload.
          </p>
          {err && <p className="text-xs text-warning">{err}</p>}
          {failedList.length > 0 && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-2">
              <p className="text-xs font-medium text-danger">
                {failedList.length} failed: {failedList.slice(0, 6).map((f) => f.name).join(", ")}
                {failedList.length > 6 ? "…" : ""}
              </p>
              <button
                onClick={() => uploadFiles(failedList)}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                <Upload className="size-3.5" /> Retry just those {failedList.length}
              </button>
            </div>
          )}
          <button onClick={() => { setSets([]); setFailedList([]); setPhase("pick"); setProgress({ done: 0, total: 0, failed: 0 }); }} className="text-xs text-muted hover:text-foreground">
            Upload more
          </button>
        </div>
      )}

      {/* Lightbox: one set at a time, big. ‹ › between sets, filmstrip through
          the brackets, keep/drop right here. Split/merge fix a wrong grouping. */}
      {viewerSet && hero &&
        createPortal(
          <div className="fixed inset-0 z-[1500] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label="Photo viewer">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-white sm:px-4">
              <span className="text-sm font-semibold tabular-nums">{(viewerIdx ?? 0) + 1} / {sets.length}</span>
              <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">
                {viewerSet.drone ? "drone" : `×${viewerSet.files.length}`}
              </span>
              <button
                onClick={() => toggle(viewerSet.id)}
                className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold ${viewerSet.keep ? "bg-success text-white" : "bg-danger text-white"}`}
              >
                {viewerSet.keep ? <><Check className="size-3.5" /> Keeping</> : <><Trash2 className="size-3.5" /> Dropped</>}
              </button>
              <button onClick={() => mergeNext(viewerSet.id)} className="inline-flex items-center gap-1 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs font-medium hover:bg-white/25">
                <Merge className="size-3.5" /> Merge next set in
              </button>
              <button onClick={() => setViewerIdx(null)} aria-label="Close" className="ml-auto rounded-full bg-white/15 p-2 hover:bg-white/25">
                <X className="size-4" />
              </button>
            </div>

            <div className="relative min-h-0 flex-1">
              <Thumb file={hero} className="size-full" imgClass="size-full object-contain" />
              {!viewerSet.keep && <div className="pointer-events-none absolute inset-0 bg-danger/10" />}
              <button
                onClick={() => go(-1)}
                disabled={viewerIdx === 0}
                aria-label="Previous photo"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-3 text-white hover:bg-black/85 disabled:opacity-25"
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                onClick={() => go(1)}
                disabled={viewerIdx === sets.length - 1}
                aria-label="Next photo"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-3 text-white hover:bg-black/85 disabled:opacity-25"
              >
                <ChevronRight className="size-6" />
              </button>
            </div>

            {viewerSet.files.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto px-3 pt-2 sm:px-4">
                {viewerSet.files.map((f, i) => (
                  <div key={`${viewerSet.id}-${i}`} className="relative shrink-0">
                    <button
                      onClick={() => setHeroIdx(i)}
                      className={`block h-14 w-20 overflow-hidden rounded-md border-2 ${i === Math.min(heroIdx, viewerSet.files.length - 1) ? "border-brand" : "border-transparent opacity-60 hover:opacity-90"}`}
                      aria-label={`Frame ${i + 1}`}
                    >
                      <Thumb file={f} className="size-full bg-surface-2" />
                    </button>
                    {i > 0 && (
                      <button
                        onClick={() => splitAt(viewerSet.id, i)}
                        title="This frame starts a different composition — split the set here"
                        aria-label="Split the set at this frame"
                        className="absolute -right-1 -top-1 rounded-full bg-black/85 p-1 text-white hover:bg-black"
                      >
                        <Scissors className="size-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="px-4 pb-2.5 pt-1.5 text-center text-[11px] text-white/50">
              ‹ › move between photos · space keeps/drops · tap a frame above the bar to check sharpness
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}
