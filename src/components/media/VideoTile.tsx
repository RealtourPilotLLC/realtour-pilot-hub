"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Expand, House, ImageDown, MoreHorizontal, Play, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { ModalDialog } from "@/components/ui/ModalDialog";
import type { MediaVideoView } from "./types";
import { fmtDuration, startDownload } from "./util";

// ---------------------------------------------------------------------------
// ONE VIDEO (Oct 23 2026, /media and the listing pages). The poster first
// (Aryeo's own for a video delivered there; for a hub file the first frame,
// read only once the tile is on screen, since the hub stores no poster), it
// plays where it sits when pressed, and View opens it larger. Download,
// the listing and the client are one press away. A vertical reel sits in a
// 9:16 frame and a horizontal video in 16:9; a video whose shape differs from
// its group's frame is shown whole (letterboxed), never cropped.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function VideoTile({ video, frame, hideListing }: { video: MediaVideoView; frame: "vertical" | "horizontal"; hideListing?: boolean }) {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [shape, setShape] = useState(video.orientation);
  const [failed, setFailed] = useState(false);

  // A poster that finished loading before the page came alive never fires
  // onLoad, so its shape is read once on mount as well.
  const posterRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const i = posterRef.current;
    if (!video.orientation && i?.complete && i.naturalWidth && i.naturalHeight) setShape(i.naturalHeight > i.naturalWidth ? "vertical" : "horizontal");
  }, [video.orientation]);

  // The first frame is read only for a tile on (or about to be on) screen.
  useEffect(() => {
    if (near || video.poster) return;
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: "240px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near, video.poster]);

  const fit = shape && shape !== frame ? "object-contain" : "object-cover";
  const duration = fmtDuration(video.durationSec);
  const listingHref = video.projectId && !hideListing ? `/listings/${video.projectId}` : null;
  const clientHref = video.clientId ? `/clients/${video.clientId}` : null;
  const showPlace = !!video.place && !video.place.toLowerCase().startsWith(video.title.toLowerCase());

  return (
    <article data-media-video={video.key} data-frame={frame} className="@container flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface panel-shadow">
      <div ref={frameRef} className={cn("relative w-full overflow-hidden bg-black", frame === "vertical" ? "aspect-[9/16]" : "aspect-video")}>
        {playing && !failed ? (
          <video
            src={video.playSrc}
            poster={video.poster ?? undefined}
            controls
            autoPlay
            playsInline
            onError={() => setFailed(true)}
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setShape(v.videoHeight > v.videoWidth ? "vertical" : "horizontal"); }}
            className="absolute inset-0 size-full bg-black object-contain"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setFailed(false); setPlaying(true); }}
            aria-label={`Play ${video.title}`}
            className="group/play absolute inset-0 flex size-full items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand"
          >
            {video.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={posterRef}
                src={video.poster}
                alt=""
                loading="lazy"
                decoding="async"
                onLoad={(e) => { const i = e.currentTarget; if (!video.orientation && i.naturalWidth && i.naturalHeight) setShape(i.naturalHeight > i.naturalWidth ? "vertical" : "horizontal"); }}
                className={cn("absolute inset-0 size-full transition-transform duration-300 group-hover/play:scale-[1.02] motion-reduce:transition-none", fit)}
              />
            ) : near ? (
              <video
                src={`${video.playSrc}#t=0.5`}
                preload="metadata"
                muted
                playsInline
                tabIndex={-1}
                aria-hidden
                onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setShape(v.videoHeight > v.videoWidth ? "vertical" : "horizontal"); }}
                className={cn("pointer-events-none absolute inset-0 size-full", fit)}
              />
            ) : null}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/55 to-transparent" />
            <span aria-hidden className="relative flex size-14 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 transition group-hover/play:scale-105 group-hover/play:bg-black/70 motion-reduce:transition-none">
              <Play className="ml-0.5 size-6" fill="currentColor" />
            </span>
            {duration && <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">{duration}</span>}
          </button>
        )}
        {failed && (
          <p role="status" className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-xl bg-black/75 p-3 text-center text-xs text-white">
            This video couldn&rsquo;t play here. Try again, or download it.
          </p>
        )}
        <button
          type="button"
          onClick={() => { setPlaying(false); setOpen(true); }}
          aria-label={`View ${video.title} larger`}
          title="View larger"
          className="absolute right-1.5 top-1.5 flex size-11 items-center justify-center rounded-xl bg-black/55 text-white hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Expand className="size-4" />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        {video.eyebrow && <p className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-2">{video.eyebrow}</p>}
        <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug">{video.title}</h3>
        {video.dateText && <p className="truncate text-xs text-muted">{video.dateText}</p>}
        {video.clientName && <p className="truncate text-xs text-muted">{video.clientName}</p>}
        {showPlace && <p className="truncate text-xs text-muted-2">{video.place}</p>}
        <div className="mt-auto flex items-center gap-1.5 pt-2">
          <a href={video.downloadHref} download className={cn(btn, "px-0 @2xs:px-3")} aria-label={`Download ${video.title}`}>
            <Download aria-hidden className="size-4" /><span className="hidden @2xs:inline">Download</span>
          </a>
          {listingHref && <Link href={listingHref} className={cn(btn, "hidden @2xs:inline-flex")}><House aria-hidden className="size-4" />Listing</Link>}
          {clientHref && <Link href={clientHref} className={cn(btn, "hidden @2xs:inline-flex")}><UserRound aria-hidden className="size-4" />Client</Link>}
          <ActionMenu
            label={`More for ${video.title}`}
            title="More"
            className={cn(btn, "ml-auto px-0", !video.coverHref && "@2xs:hidden")}
            items={[
              { id: "view", label: "View larger", text: "View larger", onSelect: () => { setPlaying(false); setOpen(true); } },
              ...(listingHref ? [{ id: "listing", label: "Open listing", text: "Open listing", onSelect: () => router.push(listingHref) }] : []),
              ...(clientHref ? [{ id: "client", label: "Open client", text: "Open client", onSelect: () => router.push(clientHref) }] : []),
              { id: "download", label: "Download", text: "Download", onSelect: () => startDownload(video.downloadHref) },
              // Oct 24 2026: the chosen Instagram cover (lib/videoAnalysis).
              ...(video.coverHref ? [{ id: "cover", label: "Download the Instagram cover", text: "Download cover", onSelect: () => startDownload(video.coverHref as string) }] : []),
            ]}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </ActionMenu>
        </div>
      </div>

      {open && <VideoModal video={video} narrow={frame === "vertical" && shape !== "horizontal"} onClose={() => setOpen(false)} hideListing={hideListing} />}
    </article>
  );
}

/** The larger player: the video, its words, and its actions. */
export function VideoModal({ video, narrow, onClose, hideListing }: { video: MediaVideoView; narrow: boolean; onClose: () => void; hideListing?: boolean }) {
  const listingHref = video.projectId && !hideListing ? `/listings/${video.projectId}` : null;
  const clientHref = video.clientId ? `/clients/${video.clientId}` : null;
  const meta = [video.dateText, video.clientName].filter(Boolean).join(" · ");
  return (
    <ModalDialog label={video.title} onCancel={onClose} className={narrow ? "w-[min(94vw,26rem)]" : "w-[min(96vw,64rem)]"}>
      <video src={video.playSrc} poster={video.poster ?? undefined} controls autoPlay playsInline className="max-h-[68dvh] w-full rounded-xl bg-black object-contain" />
      <div className="mt-3 min-w-0">
        {video.eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-2">{video.eyebrow}</p>}
        <h2 className="break-words text-lg font-semibold leading-snug">{video.title}</h2>
        {meta && <p className="text-sm text-muted">{meta}</p>}
        {video.place && <p className="text-sm text-muted-2">{video.place}</p>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={video.downloadHref} download className={btn}><Download aria-hidden className="size-4" />Download</a>
        {video.coverHref && <a href={video.coverHref} download className={btn} data-cover-download><ImageDown aria-hidden className="size-4" />Cover</a>}
        {listingHref && <Link href={listingHref} className={btn}><House aria-hidden className="size-4" />Open listing</Link>}
        {clientHref && <Link href={clientHref} className={btn}><UserRound aria-hidden className="size-4" />Open client</Link>}
        <button type="button" data-modal-initial-focus onClick={onClose} className={cn(btn, "ml-auto")}>Close</button>
      </div>
    </ModalDialog>
  );
}

/** One finished file as a compact row (a listing page's hub masters): Watch opens the player, Download saves it. */
export function VideoFileRow({ video }: { video: MediaVideoView }) {
  const [open, setOpen] = useState(false);
  const duration = fmtDuration(video.durationSec);
  return (
    <li data-media-file={video.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-medium">{video.title}</p>
        <p className="truncate text-xs text-muted">{[video.eyebrow, video.dateText, duration].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className={btn}><Play aria-hidden className="size-4" />Watch</button>
        <a href={video.downloadHref} download className={btn}><Download aria-hidden className="size-4" />Download</a>
      </div>
      {open && <VideoModal video={video} narrow={video.orientation === "vertical"} onClose={() => setOpen(false)} hideListing />}
    </li>
  );
}

/** A group's tiles, a screenful at a time (Show more). */
export function VideoGroup({ id, label, frame, items, initial, hideListing, headingLevel = 2 }: { id: string; label: string; frame: "vertical" | "horizontal"; items: MediaVideoView[]; initial?: number; hideListing?: boolean; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const step = initial ?? (frame === "vertical" ? 12 : 6);
  const [shown, setShown] = useState(step);
  const more = items.length - shown;
  return (
    <section aria-labelledby={`media-group-${id}`} data-media-group={id} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <Heading id={`media-group-${id}`} className="text-base font-semibold">{label}</Heading>
        <span className="text-xs tabular-nums text-muted">{items.length} {items.length === 1 ? "video" : "videos"}</span>
      </div>
      <div className={cn("grid gap-3", frame === "vertical" ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3")}>
        {items.slice(0, shown).map((v) => <VideoTile key={v.key} video={v} frame={frame} hideListing={hideListing} />)}
      </div>
      {more > 0 && (
        <div className="flex justify-center">
          <button type="button" onClick={() => setShown((n) => n + step)} className={btn}>
            Show {Math.min(step, more)} more <span className="text-muted">({more} left)</span>
          </button>
        </div>
      )}
    </section>
  );
}
