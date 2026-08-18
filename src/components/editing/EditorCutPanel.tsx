"use client";

import { useRef } from "react";
import { Clapperboard, FolderOpen, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditFeedback } from "@/components/editing/EditFeedback";
import type { CutNote } from "@/lib/reviewRoom";

// ---------------------------------------------------------------------------
// The EDITOR'S side of the in-hub review — Frame.io rebuilt to mirror the
// owner's Review Room desk (Jordan: "rebuild frame io into the system like how
// we have in the review room, but this should be the editor's side of it").
//
// One card on /edit/[id]: the cut they submitted plays right here, and the
// owner's timestamped notes sit under it — tap a timestamp and the player
// jumps to that exact moment, reply in the thread, hit Mark fixed when it's
// handled. The owner reviews in /review; the editor works the notes here.
// Same MediaNote threads on both sides, so nothing can drift.
// ---------------------------------------------------------------------------

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Waiting on review", cls: "bg-warning-soft text-warning" },
  CHANGES_REQUESTED: { label: "Changes requested", cls: "bg-danger-soft text-danger" },
  APPROVED: { label: "Approved", cls: "bg-success/10 text-success" },
};

export function EditorCutPanel({
  round,
  status,
  assetUrl,
  fileName,
  finalFolderUrl,
  notes,
  canFix,
  viewerName,
}: {
  round: number;
  status: string;
  assetUrl: string | null;
  fileName: string | null;
  finalFolderUrl: string;
  notes: CutNote[];
  canFix: boolean;
  viewerName?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const meta = STATUS_META[status] ?? { label: status, cls: "bg-surface-2 text-muted" };

  const seek = (sec: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    el.pause();
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-brand/25 bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <Clapperboard className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Your cut — round {round}</h2>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>{meta.label}</span>
        {fileName && <span className="truncate text-xs text-muted-2">{fileName}</span>}
      </div>

      {assetUrl ? (
        <div className="bg-black">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={assetUrl}
            controls
            playsInline
            preload="metadata"
            className="mx-auto max-h-[70vh] w-full object-contain"
          />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          No streamable link was minted for this round — the cut file lives in the{" "}
          <a href={finalFolderUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            <FolderOpen className="size-3.5" /> Final footage folder <ExternalLink className="size-3" />
          </a>
          .
        </p>
      )}

      {notes.length > 0 ? (
        <EditFeedback notes={notes} canFix={canFix} viewerName={viewerName} embedded onSeek={assetUrl ? seek : undefined} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          {status === "PENDING"
            ? "No notes yet — you'll see them here the moment the review starts."
            : "No notes on this round."}
        </p>
      )}
    </section>
  );
}
