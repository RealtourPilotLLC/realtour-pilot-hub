"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";
import { NoteComposer } from "./NoteComposer";
import { NoteThread } from "./NoteThread";
import { STATUS_BG, type ReviewKind, type ReviewLane, type ReviewNote, type ReviewStatus } from "./types";

// The review-mode lightbox stage for ONE photo: tap anywhere on the image to
// drop a pin and write a note; tap an existing pin to open its thread. Pins
// use NORMALIZED (0..1) coordinates against the DISPLAYED image rectangle so
// they land on the same pixel at any screen size. The overlay is measured, not
// assumed: the <img> uses object-contain, so if the element ever letterboxes,
// naturalWidth math keeps clicks/pins glued to the photo, not the black bars.
export function ImageReview({
  src,
  alt,
  notes,
  onAdd,
  onReply,
  onSetStatus,
}: {
  src: string;
  alt: string;
  notes: ReviewNote[]; // ROOT notes for this asset (replies live inside each)
  onAdd: (body: string, lane: ReviewLane, kind: ReviewKind, x: number, y: number) => Promise<{ ok: boolean; message?: string }>;
  onReply: (noteId: string, body: string) => Promise<{ ok: boolean; message?: string }>;
  onSetStatus: (noteId: string, status: ReviewStatus) => Promise<{ ok: boolean; message?: string }>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [boxW, setBoxW] = useState(0);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Oldest-first so pin numbers stay stable as new notes are added.
  const pins = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const measure = useCallback(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img) return;
    const b = box.getBoundingClientRect();
    setBoxW(b.width);
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Displayed-image rect inside the element (object-contain letterbox math —
    // usually identical to the element rect, but cheap insurance).
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    setRect({
      left: r.left - b.left + (r.width - w) / 2,
      top: r.top - b.top + (r.height - h) / 2,
      width: w,
      height: h,
    });
  }, []);

  // New photo → drop stale overlay/draft/thread immediately, then re-measure.
  useLayoutEffect(() => {
    setRect(null);
    setDraft(null);
    setOpenId(null);
    measure();
  }, [src, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Tap-to-pin: normalize the click within the overlay (which IS the displayed
  // image rect), clamped 0..1. Click events also fire for touch taps.
  function pick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setOpenId(null);
    setDraft({ x, y });
  }

  const open = openId ? (pins.find((n) => n.id === openId) ?? null) : null;

  // Composer placement: anchored beside the pin on wide stages; pinned to the
  // bottom as a sheet on narrow ones (thumb reach + no half-offscreen popover).
  const narrow = boxW > 0 && boxW < 560;
  let composerStyle: React.CSSProperties | undefined;
  if (draft && rect && !narrow) {
    const px = rect.left + draft.x * rect.width;
    const py = rect.top + draft.y * rect.height;
    const half = 160; // w-80 / 2 — keep the card inside the stage
    composerStyle = {
      left: Math.max(half + 8, Math.min(Math.max(boxW - half - 8, half + 8), px)),
      top: draft.y > 0.55 ? py - 12 : py + 12,
      transform: draft.y > 0.55 ? "translate(-50%, -100%)" : "translate(-50%, 0)",
    };
  }

  return (
    <div ref={boxRef} className="relative flex h-full w-full items-center justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={measure}
        draggable={false}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
      />

      {rect && (
        <div
          className="absolute cursor-crosshair"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          onClick={pick}
        >
          {pins.map((n, i) =>
            n.x == null || n.y == null ? null : (
              <button
                key={n.id}
                onClick={(e) => {
                  e.stopPropagation(); // a pin tap opens the thread, never drops a new pin
                  setDraft(null);
                  setOpenId((v) => (v === n.id ? null : n.id));
                }}
                style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }}
                className={cn(
                  "absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-lg ring-2 transition-transform",
                  STATUS_BG[n.status],
                  // Lane at a glance: photographer pins get a sky ring + camera dot.
                  n.lane === "PHOTOGRAPHER" ? "ring-sky-400" : "ring-white/80",
                  openId === n.id && "scale-125",
                )}
                aria-label={`Note ${i + 1}`}
              >
                {i + 1}
                {n.lane === "PHOTOGRAPHER" && (
                  <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-sky-500">
                    <Camera className="size-2.5 text-white" />
                  </span>
                )}
              </button>
            ),
          )}
          {draft && (
            <span
              style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
              className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-brand ring-2 ring-white"
            />
          )}
        </div>
      )}

      {draft && (
        <NoteComposer
          heading="New note"
          className={cn("absolute z-20", narrow && "inset-x-2 bottom-2 w-auto")}
          style={composerStyle}
          onSave={async (body, lane, kind) => {
            const r = await onAdd(body, lane, kind, draft.x, draft.y);
            if (r.ok) setDraft(null);
            return r;
          }}
          onCancel={() => setDraft(null)}
        />
      )}

      {open && (
        <NoteThread
          note={open}
          index={pins.indexOf(open) + 1}
          onClose={() => setOpenId(null)}
          onReply={(body) => onReply(open.id, body)}
          onSetStatus={(s) => onSetStatus(open.id, s)}
        />
      )}
    </div>
  );
}
