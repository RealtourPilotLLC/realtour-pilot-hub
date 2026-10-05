"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Loader2, X } from "lucide-react";
import { ModalDialog } from "@/components/ui/ModalDialog";

export type DeliveryPreview = { id: string; title: string; src: string };

/** Open the player locally. Routing a Next Link to a large video makes the
 * router fetch media as a page, and gives the person no playback feedback. */
export function WatchDeliveryVideo({ videos, label = "Watch it" }: { videos: DeliveryPreview[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
      <Eye className="size-3.5" /> {label}
    </button>
    {open && <DeliveryPlayer videos={videos} onClose={() => setOpen(false)} />}
  </>;
}

function DeliveryPlayer({ videos, onClose }: { videos: DeliveryPreview[]; onClose: () => void }) {
  const [selected, setSelected] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "slow" | "error">("loading");
  const player = useRef<HTMLVideoElement>(null);
  const video = videos[selected];
  useEffect(() => {
    const timer = setTimeout(() => setState(current => current === "loading" ? "slow" : current), 15_000);
    return () => clearTimeout(timer);
  }, [selected, attempt]);
  if (!video) return null;
  const retry = () => { setState("loading"); setAttempt(value => value + 1); };
  return <ModalDialog label="Watch delivery video" onCancel={onClose} className="w-[min(94vw,64rem)]">
    <div className="mb-3 flex items-start justify-between gap-3">
      <h2 className="min-w-0 break-words text-base font-semibold">{video.title}</h2>
      <button type="button" data-modal-initial-focus aria-label="Close video" onClick={onClose} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-border"><X className="size-5" /></button>
    </div>
    {videos.length > 1 && <label className="mb-3 block text-sm">Video
      <select aria-label="Delivery video" value={selected} onChange={event => { setSelected(Number(event.target.value)); setState("loading"); }} className="mt-1 block min-h-11 w-full rounded-lg border border-border bg-surface px-3">
        {videos.map((item, index) => <option key={item.id} value={index}>{item.title}</option>)}
      </select>
    </label>}
    <video key={`${video.id}:${attempt}`} ref={player} src={video.src} controls autoPlay playsInline preload="metadata"
      className="block max-h-[68dvh] w-full min-w-0 rounded-lg bg-black object-contain"
      onLoadedData={() => setState("ready")} onCanPlay={() => setState("ready")}
      onError={() => setState("error")} />
    {state === "loading" && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading finished video…</p>}
    {(state === "slow" || state === "error") && <div role="alert" className="mt-3 text-sm">
      <p>{state === "slow" ? "The video is taking longer than expected to load." : "The finished video could not be played. Retry, or refresh the delivery queue if the file changed."}</p>
      <button type="button" onClick={retry} className="mt-2 min-h-11 rounded-lg border border-border px-3 font-medium">Retry video</button>
    </div>}
  </ModalDialog>;
}

export function deliveryPreview(id: string, fingerprint: string, title: string): DeliveryPreview {
  return { id, title, src: `/api/review/cut/${encodeURIComponent(id)}/final?f=${encodeURIComponent(fingerprint)}&play=1` };
}
