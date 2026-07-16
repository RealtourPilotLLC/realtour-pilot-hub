"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GraduationCap, RotateCcw, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { PALETTE } from "@/lib/palette";
import type { ReviewNote } from "@/lib/review";

// Tap a feedback note → see the exact spot it's about. Images open full-size
// with the reviewer's pin right where it was dropped; videos open the SAME
// source the gallery player uses, parked on the noted timestamp (the "#t="
// media fragment shows that frame before play is even pressed). Read-only by
// design — replies/fixes stay on the note card.

const WARNING_HEX = "#fbbf24";

export const clockLabel = (sec: number) => {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** The video src parked at the note's moment (frame preview pre-play). */
export const videoSrcAt = (url: string, sec: number | null) =>
  sec != null && sec > 0 ? `${url}#t=${Math.max(0, Math.floor(sec))}` : url;

export function NotePreview({ note, onClose }: { note: ReviewNote; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoBroken, setVideoBroken] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const seekBack = () => {
    const v = videoRef.current;
    if (v && note.timeSec != null) {
      v.currentTime = note.timeSec;
      void v.play().catch(() => {});
    }
  };

  // A video note whose canonical asset fell back to a thumbnail image (no
  // playable source at note time) degrades to the still + timestamp.
  const showVideo = note.assetType === "video" && !videoBroken;

  return createPortal(
    <div className="fixed inset-0 z-[1500] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Feedback location preview">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/80" />

      <div className="relative flex max-h-full max-w-4xl flex-col items-center">
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="absolute -top-2 right-0 z-10 -translate-y-full rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
        >
          <X className="size-4" />
        </button>

        {/* Stage: shrink-wraps to the media, so pin % coords land on the image
            itself — no letterbox math needed. */}
        <div className="relative inline-block overflow-hidden rounded-xl">
          {showVideo ? (
            <video
              ref={videoRef}
              src={videoSrcAt(note.assetUrl, note.timeSec)}
              controls
              playsInline
              preload="metadata"
              onError={() => setVideoBroken(true)}
              onLoadedMetadata={(e) => {
                if (note.timeSec != null) e.currentTarget.currentTime = note.timeSec;
              }}
              className="max-h-[76vh] max-w-[92vw] rounded-xl bg-black sm:max-w-[80vw]"
            />
          ) : (
            <img
              src={(note.assetType === "image" ? note.assetUrl : null) ?? note.thumbUrl ?? note.assetUrl}
              alt="Noted media"
              className="max-h-[76vh] max-w-[92vw] rounded-xl object-contain sm:max-w-[80vw]"
            />
          )}
          {!showVideo && note.x != null && note.y != null && (
            <span
              className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-[3px] border-white shadow-lg"
              style={{
                left: `${note.x * 100}%`,
                top: `${note.y * 100}%`,
                backgroundColor: note.kind === "fix" ? "var(--warning)" : PALETTE.blue,
              }}
            />
          )}
        </div>

        {/* Caption: what the note says + where it points. */}
        <div className="mt-3 w-full max-w-2xl rounded-xl border border-white/10 bg-black/60 p-3 text-white backdrop-blur">
          <div className="flex flex-wrap items-center gap-1.5">
            {note.kind === "fix" ? (
              <Badge color={WARNING_HEX}><Wrench className="size-3" /> Fix needed</Badge>
            ) : (
              <Badge color={PALETTE.blue}><GraduationCap className="size-3" /> Coaching</Badge>
            )}
            {showVideo && note.timeSec != null && (
              <button
                onClick={seekBack}
                className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium hover:bg-white/25"
                title="Jump back to the noted moment"
              >
                <RotateCcw className="size-3" /> {clockLabel(note.timeSec)}
              </button>
            )}
            {!showVideo && note.assetType === "video" && note.timeSec != null && (
              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium">at {clockLabel(note.timeSec)} — video preview unavailable</span>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-snug text-white/90">{note.body}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
