"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronLeft, ChevronRight, ImageUp, Loader2, Scissors, Trash2, Upload, X } from "lucide-react";
import { createUploadLinks, finalizeCullUpload } from "@/app/upload/cullActions";

// ---------------------------------------------------------------------------
// Cull BEFORE upload. Pick the card's JPGs → they collapse into bracket SETS
// (5-bracket interiors, single-shot drone) → tap the junk out → only keepers
// upload, straight to the job's 01-RAW-Photos folder via temporary links.
//
// Grouping: brackets fire in a burst, so consecutive frames ≤2.5s apart are
// one set (capped at 7 for messy triggers); DJI_* files are drone singles.
// When the guess is off, the set viewer can SPLIT at any frame or MERGE with
// the next set — Jordan: "sometimes it's messy and we have more or less".
// ---------------------------------------------------------------------------

const GAP_MS = 2500;
const UPLOAD_CONCURRENCY = 4;

type CullSet = {
  id: number;
  files: File[];
  keep: boolean;
  drone: boolean;
};

type Phase = "pick" | "cull" | "uploading" | "done";

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

// Lazy thumbnail: object URL created only when the card is near the viewport,
// revoked when it unmounts (a 600-JPG card would eat a phone's memory otherwise).
function Thumb({ file, className }: { file: File; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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
        <img src={url} alt={file.name} decoding="async" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-2"><Camera className="size-5" /></div>
      )}
    </div>
  );
}

export function CullUploader({ projectId, photoTarget, bracket }: { projectId: string; photoTarget: number; bracket: number }) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [sets, setSets] = useState<CullSet[]>([]);
  const [viewer, setViewer] = useState<number | null>(null); // set id
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  async function upload() {
    const files = kept.flatMap((s) => s.files);
    if (files.length === 0) return;
    setPhase("uploading");
    setErr(null);
    setProgress({ done: 0, total: files.length, failed: 0 });

    const linkRes = await createUploadLinks(projectId, files.map((f) => f.name)).catch(() => null);
    if (!linkRes?.ok || !linkRes.links || linkRes.links.length !== files.length) {
      setErr(linkRes?.message ?? "Couldn't get upload links — check your connection and try again.");
      setPhase("cull");
      return;
    }
    // Pair POSITIONALLY (the server preserves input order): two cards can both
    // have an IMG_0001.jpg, and each one-time link is good for exactly one file.
    let failed = 0;
    const queue = files.map((f, i) => ({ f, url: linkRes.links![i].url }));
    const putOne = async ({ f, url }: { f: File; url: string }) => {
      const attempt = () =>
        fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f }).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        });
      try {
        await attempt();
      } catch {
        try {
          await attempt(); // one retry
        } catch {
          failed++;
        }
      }
      setProgress((p) => ({ ...p, done: p.done + 1, failed }));
    };
    await Promise.all(
      Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          await putOne(item);
        }
      }),
    );

    await finalizeCullUpload(projectId, {
      keptSets: kept.length,
      totalSets: sets.length,
      uploadedFiles: files.length - failed,
      droppedFiles,
      failedFiles: failed,
    }).catch(() => {});
    setProgress((p) => ({ ...p, failed }));
    setPhase("done");
  }

  const viewerSet = viewer != null ? sets.find((s) => s.id === viewer) ?? null : null;

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
            Tap a set to keep/drop it · tap <ChevronRight className="inline size-3" /> to open it (check sharpness, fix the grouping).
            Keep the best ONE set per room/composition.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {sets.map((s) => (
              <div key={s.id} className={`relative overflow-hidden rounded-lg border transition-opacity ${s.keep ? "border-success/60" : "border-danger/40 opacity-45"}`}>
                <button type="button" onClick={() => toggle(s.id)} className="block w-full" title={s.keep ? "Tap to drop this set" : "Tap to keep this set"}>
                  <Thumb file={s.files[Math.floor(s.files.length / 2)]} />
                </button>
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/65 px-1 py-0.5 text-[10px] font-semibold text-white">
                  {s.drone ? "drone" : `×${s.files.length}`}
                </span>
                <span className={`pointer-events-none absolute right-1 top-1 rounded-full p-0.5 text-white ${s.keep ? "bg-success" : "bg-danger"}`}>
                  {s.keep ? <Check className="size-3" /> : <X className="size-3" />}
                </span>
                <button
                  type="button"
                  onClick={() => setViewer(s.id)}
                  aria-label="Open this set"
                  className="absolute bottom-1 right-1 rounded-full bg-black/65 p-1 text-white hover:bg-black/85"
                >
                  <ChevronRight className="size-3" />
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
          {progress.failed > 0 && (
            <p className="text-xs text-danger">{progress.failed} files failed — tap &ldquo;Start over&rdquo;, re-pick just those, and upload again.</p>
          )}
          <button onClick={() => { setSets([]); setPhase("pick"); setProgress({ done: 0, total: 0, failed: 0 }); }} className="text-xs text-muted hover:text-foreground">
            Upload more
          </button>
        </div>
      )}

      {/* Set viewer: every frame in the set — verify sharpness, fix the grouping. */}
      {viewerSet &&
        createPortal(
          <div className="fixed inset-0 z-[1500] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label="Bracket set">
            <div className="flex items-center gap-2 px-4 py-3 text-white">
              <span className="text-sm font-semibold">{viewerSet.drone ? "Drone shot" : `${viewerSet.files.length}-shot set`}</span>
              <button
                onClick={() => { toggle(viewerSet.id); }}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold ${viewerSet.keep ? "bg-success text-white" : "bg-danger text-white"}`}
              >
                {viewerSet.keep ? <><Check className="size-3.5" /> Keeping</> : <><Trash2 className="size-3.5" /> Dropped</>}
              </button>
              <button onClick={() => mergeNext(viewerSet.id)} className="inline-flex items-center gap-1 rounded-lg bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <ChevronLeft className="size-3.5" /> Merge next set in
              </button>
              <button onClick={() => setViewer(null)} aria-label="Close" className="ml-auto rounded-full bg-white/15 p-2 hover:bg-white/25">
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
              {viewerSet.files.map((f, i) => (
                <div key={`${viewerSet.id}-${i}`} className="relative">
                  <Thumb file={f} className="max-h-[70vh] w-full overflow-hidden rounded-xl bg-black object-contain" />
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-white/70">
                    <span className="truncate">{f.name}</span>
                    {i > 0 && (
                      <button
                        onClick={() => { splitAt(viewerSet.id, i); setViewer(null); }}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25"
                        title="This frame starts a different composition — split the set here"
                      >
                        <Scissors className="size-3" /> New set starts here
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
