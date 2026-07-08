"use client";

import { useRef, useState } from "react";
import { Camera, MessageSquarePlus, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaVideo } from "@/lib/integrations/aryeo";
import { NoteComposer } from "./NoteComposer";
import { NoteThread } from "./NoteThread";
import { STATUS_BG, fmtClock, type ReviewKind, type ReviewLane, type ReviewNote, type ReviewStatus } from "./types";

// Review-mode lightbox stage for ONE video: the same <video> source the normal
// player uses (Aryeo's direct-MP4 download, else HLS playback), plus an
// "Add note at m:ss" button that pauses and captures currentTime, and a
// timestamped note list under the player (tap a time to seek, tap the text to
// open its thread). Graceful degradation: no playable source → show the poster
// and let notes carry a hand-typed mm:ss instead of a captured one.
export function VideoReview({
  video,
  notes,
  onAdd,
  onReply,
  onSetStatus,
}: {
  video: MediaVideo;
  notes: ReviewNote[]; // ROOT notes for this asset
  onAdd: (body: string, lane: ReviewLane, kind: ReviewKind, timeSec: number | null) => Promise<{ ok: boolean; message?: string }>;
  onReply: (noteId: string, body: string) => Promise<{ ok: boolean; message?: string }>;
  onSetStatus: (noteId: string, status: ReviewStatus) => Promise<{ ok: boolean; message?: string }>;
}) {
  // Same source preference as the plain VideoPlayer so playback behaves alike.
  const src = video.download ?? video.playback ?? null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [composing, setComposing] = useState(false);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Timestamped notes in play order; un-timestamped ones sink to the end.
  const sorted = [...notes].sort(
    (a, b) => (a.timeSec ?? Infinity) - (b.timeSec ?? Infinity) || a.createdAt.localeCompare(b.createdAt),
  );
  const open = openId ? (sorted.find((n) => n.id === openId) ?? null) : null;

  function startNote() {
    const el = videoRef.current;
    if (el) {
      el.pause(); // freeze the frame the note is about
      setCapturedAt(Math.round(el.currentTime * 10) / 10);
    } else {
      setCapturedAt(null); // no player → the composer shows a manual mm:ss field
    }
    setOpenId(null);
    setComposing(true);
  }

  function seek(t: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = t;
    el.pause();
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        {src ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            src={src}
            poster={video.thumb ?? undefined}
            controls
            autoPlay
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            className="max-h-full max-w-full rounded-lg"
          />
        ) : video.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumb} alt={video.title ?? "video"} className="max-h-full max-w-full rounded-lg object-contain opacity-80" />
        ) : (
          <div className="text-white/60">Video unavailable</div>
        )}
      </div>

      <div className="flex w-full max-w-3xl flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={startNote}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
        >
          <MessageSquarePlus className="size-4" /> {src ? `Add note at ${fmtClock(now)}` : "Add video note"}
        </button>
        {!src && <span className="text-xs text-white/60">No playable source — type a timestamp on the note if you need one.</span>}
      </div>

      {sorted.length > 0 && (
        <div
          className="max-h-36 w-full max-w-3xl space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          {sorted.map((n) => (
            <div
              key={n.id}
              className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/10", openId === n.id && "bg-white/10")}
            >
              {n.timeSec != null ? (
                <button
                  onClick={() => seek(n.timeSec!)}
                  disabled={!src}
                  className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white hover:bg-white/25 disabled:opacity-60"
                >
                  {fmtClock(n.timeSec)}
                </button>
              ) : (
                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[11px] tabular-nums text-white/50">—:—</span>
              )}
              <span className={cn("size-2 shrink-0 rounded-full", STATUS_BG[n.status])} />
              {n.lane === "PHOTOGRAPHER" ? (
                <Camera className="size-3 shrink-0 text-sky-300" />
              ) : (
                <Pencil className="size-3 shrink-0 text-white/60" />
              )}
              <button
                onClick={() => {
                  setComposing(false);
                  setOpenId((v) => (v === n.id ? null : n.id));
                }}
                className="min-w-0 flex-1 truncate text-left text-xs text-white/90"
              >
                {n.body}
              </button>
            </div>
          ))}
        </div>
      )}

      {composing && (
        <NoteComposer
          heading="Video note"
          timeLabel={capturedAt != null ? `at ${fmtClock(capturedAt)}` : null}
          manualTime={capturedAt == null}
          className="absolute inset-x-2 bottom-2 z-20 w-auto sm:inset-x-auto sm:right-2 sm:w-80"
          onSave={async (body, lane, kind, manualSec) => {
            const r = await onAdd(body, lane, kind, capturedAt ?? manualSec);
            if (r.ok) setComposing(false);
            return r;
          }}
          onCancel={() => setComposing(false)}
        />
      )}

      {open && (
        <NoteThread
          note={open}
          index={sorted.indexOf(open) + 1}
          onClose={() => setOpenId(null)}
          onReply={(body) => onReply(open.id, body)}
          onSetStatus={(s) => onSetStatus(open.id, s)}
        />
      )}
    </div>
  );
}
