"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Clapperboard, FolderOpen, ExternalLink, Loader2, MessageSquarePlus, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { addCutNote } from "@/app/review/actions";
import type { CutNote } from "@/lib/reviewRoom";

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// The EDITOR'S side of the in-hub review — built to mirror the owner's Review
// Room desk (Jordan: "rebuild frame io into the system like how we have in the
// review room, but this should be the editor's side of it").
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
  SUPERSEDED: { label: "Replaced by a newer version", cls: "bg-surface-2 text-muted" },
  // Pulled back by the editor (Sep 16) — the row and the file are kept, but it
  // is not a live round any more, so it reads as struck-through history.
  WITHDRAWN: { label: "Withdrawn", cls: "bg-surface-2 text-muted" },
};

export function EditorCutPanel({
  projectId,
  submissionId,
  round,
  status,
  cutIndex,
  cutTotal,
  cutLabel,
  assetUrl,
  streamable = true,
  fileName,
  finalFolderUrl,
  notes,
  canFix,
  viewerName,
  player = true,
}: {
  projectId: string;
  submissionId: string;
  round: number;
  status: string;
  /** Which of the job's cuts this is — "Cut 1 of 16" (Jordan, Sep 16: a single
   *  bounced cut buried in sixteen slots names nothing). Null on a legacy
   *  folder row that belongs to no deliverable/slot. */
  cutIndex?: number | null;
  cutTotal?: number | null;
  /** The slot's own name — "Personal Branding Reel". */
  cutLabel?: string | null;
  assetUrl: string | null;
  /** false for legacy Dropbox-folder rows (they download, they don't stream) */
  streamable?: boolean;
  fileName: string | null;
  finalFolderUrl: string;
  notes: CutNote[];
  canFix: boolean;
  viewerName?: string | null;
  /** Mount the video for this cut. Only the cut the page opened on plays here
   *  — a job with four bounced cuts would otherwise mount four players and
   *  fetch four sets of metadata (Sep 16 review). The others still carry their
   *  anchor and their notes, with one click to open and play. */
  player?: boolean;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const meta = STATUS_META[status] ?? { label: status, cls: "bg-surface-2 text-muted" };
  // The editor's own note — Jordan: "I also want the video editor to be able
  // to leave feedback." Captures the paused timestamp like the owner's desk.
  const [composing, setComposing] = useState(false);
  const [noteAt, setNoteAt] = useState<number | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const seek = (sec: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    el.pause();
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const startNote = () => {
    const el = videoRef.current;
    if (el) el.pause();
    setNoteAt(el ? Math.round(el.currentTime * 10) / 10 : null);
    setComposing(true);
  };

  const saveNote = () => {
    const body = noteBody.trim();
    if (!body || pending) return;
    start(async () => {
      setErr(null);
      const r = await addCutNote({ projectId, submissionId, body, lane: "EDITOR", kind: "fix", timeSec: noteAt }).catch(() => ({ ok: false as const, message: "That didn't work — try again." }));
      if (!r.ok) setErr(r.message ?? "That didn't work — try again.");
      else {
        setComposing(false);
        setNoteBody("");
        router.refresh();
      }
    });
  };

  const withdrawn = status === "WITHDRAWN";
  // The heading NAMES the cut — "Cut 1 of 16 · round 2 · Personal Branding
  // Reel". Sixteen identical slots and one bounced cut is exactly the screen
  // Jordan was looking at on Sep 16; "Your cut — round 1" told him nothing
  // about WHICH of the sixteen he was looking at.
  const named = !!(cutIndex && cutTotal);

  return (
    // The anchor every revision link on this page (and every cut-note bell)
    // lands on — one per cut, scroll-mt so the heading clears the sticky header.
    <section
      id={`cut-${submissionId}`}
      className={cn(
        "panel-shadow scroll-mt-24 overflow-hidden rounded-2xl border bg-surface",
        withdrawn ? "border-border opacity-75" : "border-brand/25",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <Clapperboard className={cn("size-4", withdrawn ? "text-muted-2" : "text-brand")} />
        <h2 className={cn("text-sm font-semibold", withdrawn && "text-muted line-through")}>
          {named ? `Cut ${cutIndex} of ${cutTotal}` : "Your cut"} · round {round}
        </h2>
        {cutLabel && <span className="truncate text-xs text-muted">{cutLabel}</span>}
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>{meta.label}</span>
        {fileName && <span className={cn("truncate text-xs text-muted-2", withdrawn && "line-through")}>{fileName}</span>}
      </div>

      {assetUrl && player ? (
        <div className="bg-black">
          { }
          <video
            ref={videoRef}
            src={assetUrl}
            controls
            playsInline
            preload="metadata"
            className="mx-auto max-h-[70vh] w-full object-contain"
          />
        </div>
      ) : assetUrl ? (
        // Notes-only: this cut is on the page so its anchor and its notes are
        // here, but the player belongs to the cut in front of them. One click
        // opens this one and the timestamps become playable.
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
          <Link
            href={`/edit/${projectId}?cut=${submissionId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-surface-2"
          >
            <PlayCircle className="size-3.5" /> Open this cut to play it
          </Link>
          <span className="text-xs text-muted">The notes below are on this version.</span>
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          No file is attached to this version — it lives in the{" "}
          <a href={finalFolderUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            <FolderOpen className="size-3.5" /> Final footage folder <ExternalLink className="size-3" />
          </a>
          . Upload the next version above and it will play right here.
        </p>
      )}
      {assetUrl && player && !streamable && (
        <p className="px-4 py-2 text-[11px] text-muted-2 sm:px-5">
          This version came from the Dropbox Final folder. If the player doesn&apos;t start, <a href={assetUrl} className="text-brand hover:underline">download it</a>.
        </p>
      )}

      {/* Nothing to say to a reviewer about a version that was pulled back. */}
      {canFix && !withdrawn && (
        <div className="border-b border-border px-4 py-2.5 sm:px-5">
          {composing ? (
            <div className="space-y-2">
              <textarea
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                rows={2}
                autoFocus
                placeholder={noteAt != null ? `Your note at ${fmtClock(noteAt)}…` : "Your note for the reviewer…"}
                className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveNote}
                  disabled={pending || !noteBody.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
                  {noteAt != null ? `Note at ${fmtClock(noteAt)}` : "Add note"}
                </button>
                <button onClick={() => setComposing(false)} className="text-xs font-medium text-muted hover:text-foreground">
                  Cancel
                </button>
                {err && <span className="text-xs text-danger">{err}</span>}
              </div>
            </div>
          ) : (
            <button
              onClick={startNote}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
            >
              <MessageSquarePlus className="size-3.5" />
              {assetUrl && player ? "Add a note at the current moment" : "Add a note for the reviewer"}
            </button>
          )}
        </div>
      )}

      {notes.length > 0 ? (
        <EditFeedback notes={notes} canFix={canFix} viewerName={viewerName} embedded onSeek={assetUrl && player ? seek : undefined} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          {withdrawn
            ? "This version was withdrawn — it is kept here as history. Upload a replacement above."
            : status === "PENDING"
              ? "No notes yet — you'll see them here the moment the review starts."
              : "No notes on this round."}
        </p>
      )}
    </section>
  );
}
