"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, DownloadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { startDownload } from "./util";

// ---------------------------------------------------------------------------
// A LISTING'S PHOTOS (or floor plans), as the client received them: a grid,
// and a full-screen viewer (arrows, swipe, Esc) with this photo's download.
// "Download all" saves every full-size file one at a time, never a zip (Mike
// Ciunci can't open a zip on his phone; on a phone, the viewer's Download
// saves the one photo on screen). Files come through the hub's staff proxy,
// /api/media/download, which forces a real download from Aryeo's host.
// ---------------------------------------------------------------------------

export type GalleryPhoto = { thumb: string; large: string; caption: string | null; downloadHref: string };

const iconBtn = "flex size-11 shrink-0 items-center justify-center rounded-xl text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function ListingGallery({ photos, noun = "photo" }: { photos: GalleryPhoto[]; noun?: "photo" | "floor plan" }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [idx, setIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const startX = useRef<number | null>(null);
  const total = photos.length;
  const prev = useCallback(() => setIdx((i) => (i == null ? i : (i - 1 + total) % total)), [total]);
  const next = useCallback(() => setIdx((i) => (i == null ? i : (i + 1) % total)), [total]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (idx != null && !d.open) d.showModal();
    if (idx == null && d.open) d.close();
  }, [idx]);
  // The neighbours load while this one is looked at.
  useEffect(() => {
    if (idx == null || total < 2) return;
    for (const j of [(idx + 1) % total, (idx - 1 + total) % total]) { const im = new Image(); im.src = photos[j].large; }
  }, [idx, photos, total]);

  async function downloadAll() {
    for (let i = 0; i < photos.length; i++) {
      setSaving(i + 1);
      startDownload(photos[i].downloadHref);
      await new Promise((r) => setTimeout(r, 450));
    }
    setSaving(null);
  }

  const cur = idx != null ? photos[idx] : null;
  const plural = `${noun}s`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Tap a {noun} to see it full screen and download it on its own.</p>
        <button
          type="button"
          onClick={downloadAll}
          disabled={saving != null}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-2 disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <DownloadCloud aria-hidden className="size-4" />
          {saving != null ? `Saving ${saving} of ${total}…` : total === 1 ? `Download the ${noun}` : `Download all ${total} ${plural}`}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((p, i) => (
          <button
            key={`${p.thumb}-${i}`}
            type="button"
            onClick={() => setIdx(i)}
            aria-label={`Open ${noun} ${i + 1} of ${total}${p.caption ? `: ${p.caption}` : ""}`}
            className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.thumb} alt="" loading="lazy" decoding="async" className={cn("absolute inset-0 size-full transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none", noun === "floor plan" ? "bg-white object-contain p-2" : "object-cover")} />
          </button>
        ))}
      </div>

      <dialog
        ref={dialog}
        aria-label={cur ? `${noun} ${(idx ?? 0) + 1} of ${total}` : "Viewer"}
        onCancel={(e) => { e.preventDefault(); setIdx(null); }}
        onClose={() => setIdx(null)}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); prev(); } else if (e.key === "ArrowRight") { e.preventDefault(); next(); } }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-black/95 p-0 text-white backdrop:bg-black/80"
      >
        {cur && (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-2 py-2 sm:px-4">
              <p className="min-w-0 flex-1 truncate text-sm text-white/80"><span className="tabular-nums">{(idx ?? 0) + 1} / {total}</span>{cur.caption ? <span className="ml-2 text-white/60">{cur.caption}</span> : null}</p>
              <a href={cur.downloadHref} download className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-brand">
                <Download aria-hidden className="size-4" />Download
              </a>
              <button type="button" onClick={() => setIdx(null)} aria-label="Close" className={iconBtn} autoFocus><X className="size-5" /></button>
            </div>
            <div
              className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center px-2 pb-4 sm:px-16"
              onPointerDown={(e) => { startX.current = e.clientX; }}
              onPointerUp={(e) => { const s = startX.current; startX.current = null; if (s == null) return; const dx = e.clientX - s; if (Math.abs(dx) > 50) (dx > 0 ? prev : next)(); }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={cur.large} src={cur.large} alt={cur.caption ?? `${noun} ${(idx ?? 0) + 1}`} className={cn("max-h-full max-w-full select-none rounded-lg object-contain", noun === "floor plan" && "bg-white")} draggable={false} />
              {total > 1 && (
                <>
                  <button type="button" onClick={prev} aria-label={`Previous ${noun}`} className={cn(iconBtn, "absolute left-1 top-1/2 -translate-y-1/2 bg-black/40 sm:left-3")}><ChevronLeft className="size-6" /></button>
                  <button type="button" onClick={next} aria-label={`Next ${noun}`} className={cn(iconBtn, "absolute right-1 top-1/2 -translate-y-1/2 bg-black/40 sm:right-3")}><ChevronRight className="size-6" /></button>
                </>
              )}
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
