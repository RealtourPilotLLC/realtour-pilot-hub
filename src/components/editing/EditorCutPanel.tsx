"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Clapperboard, FolderOpen, ExternalLink, Loader2, MessageSquarePlus, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { AskQuestionButton } from "@/components/editing/AskQuestionButton";
import { addCutNote } from "@/app/review/actions";
import type { CutNote } from "@/lib/reviewRoom";
import { verdictLine, type Verdict } from "@/lib/reviewAttribution";

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
  cutLabel,
  assetUrl,
  streamable = true,
  fileName,
  finalFolderUrl,
  notes,
  ownNotes = [],
  issues = [],
  removed = [],
  canFix,
  viewerName,
  player = true,
  verdict = null,
  ask = false,
}: {
  projectId: string;
  submissionId: string;
  round: number;
  status: string;
  /** Kept for callers; the heading names the version only (Oct 15 2026). */
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
  /** The editor's own notes for the reviewer: shown apart, never as fixes (Oct 15 2026). */
  ownNotes?: CutNote[];
  /** The reviewer's notes on this video still to fix (or marked fixed, waiting on the reviewer): under the player, each time plays its moment. */
  issues?: { id: string; state: string; text: string; timeSec: number | null; by: string | null; round: number | null; askWho?: string | null; changed?: string | null }[];
  /** Notes on this video a person deleted or took off the list after the
   *  editor had them (Oct 28 2026, lib/noteEdits): one plain line each, so
   *  "note 2" vanishing is never a mystery. */
  removed?: { id: string; line: string }[];
  /** Oct 27 2026 (Jordan: "an ask a question button ... about a specific
   *  revision"): a small Ask a question on each note, for the editor. */
  ask?: boolean;
  canFix: boolean;
  viewerName?: string | null;
  /** Mount the video for this cut. Only the cut the page opened on plays here
   *  — a job with four bounced cuts would otherwise mount four players and
   *  fetch four sets of metadata (Sep 16 review). The others still carry their
   *  anchor and their notes, with one click to open and play. */
  player?: boolean;
  /** Who ruled on this version, and when (Sep 28) — the badge said only what. */
  verdict?: Verdict | null;
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
      const r = await addCutNote({ projectId, submissionId, body, lane: "EDITOR", kind: "fix", timeSec: noteAt }).catch(() => ({ ok: false as const, message: "That didn't work. Try again." }));
      if (!r.ok) setErr(r.message ?? "That didn't work. Try again.");
      else {
        setComposing(false);
        setNoteBody("");
        router.refresh();
      }
    });
  };

  const withdrawn = status === "WITHDRAWN";

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
          {/* Oct 15 2026: the video's number is the page's ("Video 2 of 3"); this
              panel names the version only, so the two can never disagree. */}
          Version {round}
        </h2>
        {cutLabel && <span className="truncate text-xs text-muted">{cutLabel}</span>}
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>{meta.label}</span>
        {verdictLine(verdict) && <span className="text-[11px] text-muted">{verdictLine(verdict)}</span>}
        {fileName && <span title={fileName} className={cn("min-w-0 max-w-full truncate text-xs text-muted-2", withdrawn && "line-through")}>{fileName}</span>}
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
            <PlayCircle className="size-3.5" /> Open this version to play it
          </Link>
          <span className="text-xs text-muted">The notes below are on this version.</span>
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          No file is attached to this version. It lives in the{" "}
          <a href={finalFolderUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            <FolderOpen className="size-3.5" /> Final footage folder <ExternalLink className="size-3" />
          </a>
          . Upload the next version below and it will play right here.
        </p>
      )}
      {assetUrl && player && !streamable && (
        <p className="px-4 py-2 text-[11px] text-muted-2 sm:px-5">
          This version came from the Dropbox Final folder. If the player doesn&apos;t start, <a href={assetUrl} className="text-brand hover:underline">download it</a>.
        </p>
      )}

      {/* Nothing to say to a reviewer about a version that was pulled back. */}
      {canFix && !withdrawn && status !== "APPROVED" && (
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
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                >
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
                  {noteAt != null ? `Note at ${fmtClock(noteAt)}` : "Add note"}
                </button>
                <button onClick={() => setComposing(false)} className="min-h-11 px-2 text-xs font-medium text-muted hover:text-foreground">
                  Cancel
                </button>
                {err && <span className="text-xs text-danger">{err}</span>}
              </div>
            </div>
          ) : (
            <button
              onClick={startNote}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
            >
              <MessageSquarePlus className="size-3.5" />
              {assetUrl && player ? "Add a note at the current moment" : "Add a note for the reviewer"}
            </button>
          )}
        </div>
      )}

      {/* THE REVIEWER'S NOTES, under the player (Oct 15 2026). Every fix note
          the reviewer writes becomes an item the reviewer later checks; they
          used to be kept off this panel, which then said there was nothing to
          fix while the notes sat elsewhere with no way to play their moment. */}
      {issues.length > 0 && (
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">To fix</p>
          {/* Numbered (Oct 15 2026, the brief audit): "note 2" is how an editor
              and a reviewer talk about one of them in the messages. */}
          <ol className="mt-2 space-y-2" data-fix-list>
            {issues.map((i, n) => {
              const done = i.state === "ADDRESSED";
              return (
                <li key={i.id} className="flex items-start gap-2.5 text-sm">
                  <span aria-hidden className={cn("mt-2.5 w-5 shrink-0 text-right text-xs font-semibold tabular-nums", done ? "text-muted-2" : "text-foreground/70")}>{n + 1}.</span>
                  {i.timeSec != null && assetUrl && player ? (
                    <button type="button" onClick={() => seek(i.timeSec!)} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 px-2 font-mono text-xs font-semibold text-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand" title="Play this moment" aria-label={`Play ${fmtClock(i.timeSec)}`}>
                      {fmtClock(i.timeSec)}
                    </button>
                  ) : i.timeSec != null ? (
                    <span className="mt-2 shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{fmtClock(i.timeSec)}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 pt-2">
                    <span className={cn("whitespace-pre-wrap", done && "text-muted")}>{i.text}</span>
                    {/* WHAT CHANGED (Oct 28 2026): a note edited or reworded
                        after the editor had it says so, in one line. */}
                    {i.changed && <span className="mt-0.5 block text-[12px] text-warning" data-note-changed>{i.changed}</span>}
                    <span className="mt-0.5 block text-[11px] text-muted-2">
                      {i.by ? `${i.by.split(/\s+/)[0]}` : "The reviewer"}{i.round ? ` · on version ${i.round}` : ""} ·{" "}
                      <span className={done ? "text-brand" : "font-semibold text-danger"}>{done ? "marked fixed, the reviewer checks it" : "to fix"}</span>
                    </span>
                    {ask && <AskQuestionButton projectId={projectId} target={{ kind: "issue", id: i.id }} who={i.askWho ?? "the creative manager"} className="-ml-2" />}
                  </span>
                </li>
              );
            })}
          </ol>
          {canFix && <p className="mt-2 text-[11px] text-muted-2">When you upload the next version, the final check asks which of these you fixed.</p>}
        </div>
      )}
      {removed.length > 0 && (
        <div className="border-b border-border px-4 py-3 sm:px-5" data-notes-removed>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">Taken off your list</p>
          <ul className="mt-1.5 space-y-1">
            {removed.map((r) => <li key={r.id} className="text-[13px] text-muted">{r.line}</li>)}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <EditFeedback notes={notes} canFix={canFix} viewerName={viewerName} embedded onSeek={assetUrl && player ? seek : undefined} />
      )}
      {ownNotes.length > 0 && (
        <div className="border-t border-border">
          <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-2 sm:px-5">{canFix ? "Your notes for the reviewer" : "The editor's notes for the reviewer"}</p>
          <EditFeedback notes={ownNotes} canFix={false} viewerName={viewerName} embedded onSeek={assetUrl && player ? seek : undefined} />
        </div>
      )}
      {issues.length === 0 && notes.length === 0 && removed.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          {withdrawn
            ? "This version was withdrawn. It is kept here as history. Upload a replacement below."
            : status === "PENDING"
              ? "No notes yet. You'll see them here the moment the review starts."
              : status === "APPROVED"
                ? "Approved. Nothing to fix on this version."
                : "Nothing to fix on this version."}
        </p>
      )}
    </section>
  );
}
