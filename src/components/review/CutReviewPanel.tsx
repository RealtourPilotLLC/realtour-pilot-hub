"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Camera, Check, CornerDownRight, Loader2, MessageSquarePlus, Pencil, RotateCcw, Send, ThumbsUp, Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionTextarea } from "@/components/mentions/MentionTextarea";
import { addCutNote, approveCut, replyCutNote, requestCutChanges, setCutNoteStatus } from "@/app/review/actions";
import type { CutNote, CutSubmission } from "@/lib/reviewRoom";
import { CutTakeBack, CutTakeBackFlags } from "./CutTakeBack";
import type { CutTakeBackInfo } from "./types";
import { fmtClock, parseClock } from "./types";

// ---------------------------------------------------------------------------
// The Review Room's cut workspace panel (client): the submitted video with
// "Add note at m:ss" (pauses + captures the moment), the running note list
// (tap a time to seek, expand for the thread), and the verdict — Approve or
// Request changes. Owner/admin only; the page gates before rendering this.
// Notes route to the EDITOR (fix/coaching) or the PHOTOGRAPHER (capture note),
// mirroring the gallery review's one-tap lane chips.
//
// Sep 16 (Jordan): the verdict bar also carries the quiet "Wrong video?" link —
// withdraw the cut, or move it to the job it should have gone to — plus the
// flags for a cut that was taken back and for an approved file left behind in
// Dropbox. Approve stays the loud green button; the escape hatch is grey text.
// ---------------------------------------------------------------------------

type LaneChoice = { lane: "EDITOR" | "PHOTOGRAPHER"; kind: "fix" | "coaching"; label: string; icon: "pencil" | "camera" };
const CHOICES: LaneChoice[] = [
  { lane: "EDITOR", kind: "fix", label: "Editor — fix", icon: "pencil" },
  { lane: "EDITOR", kind: "coaching", label: "Editor — coaching", icon: "pencil" },
  { lane: "PHOTOGRAPHER", kind: "fix", label: "Photographer — capture", icon: "camera" },
];

const STATUS_DOT: Record<string, string> = {
  OPEN: "bg-brand",
  FIXED: "bg-success",
  RESOLVED: "bg-muted-2",
};

export function CutReviewPanel({
  projectId,
  submission,
  notes,
  editorLabel,
  takeBack,
  cutLabel,
}: {
  projectId: string;
  submission: CutSubmission;
  notes: CutNote[];
  editorLabel: string;
  /** withdraw / move state for THIS cut (null = the page couldn't read it) */
  takeBack?: CutTakeBackInfo | null;
  cutLabel?: string;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [composing, setComposing] = useState(false);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [choice, setChoice] = useState(0);
  const [clock, setClock] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const src = submission.assetUrl;
  // Uploaded cuts stream from the hub's own store; legacy rows stream through
  // the route from Dropbox (verified in a visible tab) but get a download
  // link too, for the day a link stalls.
  const legacy = !submission.blobUrl && !!submission.assetUrl;
  // A withdrawn cut has no verdict to give: the buttons come off and the row
  // says what happened instead (Sep 16).
  const withdrawn = submission.status === "WITHDRAWN";
  const decided = submission.status !== "PENDING";
  const openEditorNotes = notes.filter((n) => n.lane === "EDITOR" && n.status === "OPEN").length;
  const sorted = [...notes].sort(
    (a, b) => (a.timeSec ?? Infinity) - (b.timeSec ?? Infinity) || a.createdAt.localeCompare(b.createdAt),
  );
  const open = openId ? (sorted.find((n) => n.id === openId) ?? null) : null;

  function startNote() {
    const el = videoRef.current;
    if (el) {
      el.pause();
      setCapturedAt(Math.round(el.currentTime * 10) / 10);
    } else {
      setCapturedAt(null); // no player → manual mm:ss field
    }
    setOpenId(null);
    setComposing(true);
    setErr(null);
  }

  function seek(t: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = t;
    el.pause();
  }

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await fn();
      if (!r.ok) setErr(r.message ?? "That didn't work — try again.");
      else {
        if (r.message) setMsg(r.message);
        after?.();
        router.refresh();
      }
    });

  return (
    <div className="space-y-3">
      {/* Player */}
      <div className="overflow-hidden rounded-2xl border bg-black">
        {src ? (
           
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            className="mx-auto max-h-[70vh] w-full"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 px-6 py-14 text-center text-sm text-white/70">
            <span>No file was found for this round.</span>
            <span className="text-xs text-white/40">
              Notes below still work with typed timestamps.
            </span>
          </div>
        )}
      </div>

      {legacy && (
        <p className="text-[11px] text-muted-2">
          This version came from the Dropbox Final folder. If the player doesn&apos;t start,{" "}
          <a href={submission.assetUrl!} className="text-brand hover:underline">download it</a> — uploads from the editor portal play from the hub directly.
        </p>
      )}
      {/* Withdrawn / moved-here / leftover-file flags — shown whatever the
          verdict state, because they change what the buttons below mean. */}
      {takeBack && <CutTakeBackFlags info={takeBack} />}
      {/* Note + verdict bar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={startNote}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <MessageSquarePlus className="size-4" /> {src ? `Add note at ${fmtClock(now)}` : "Add note"}
        </button>
        {/* The escape hatch, deliberately quiet beside the verdict buttons. */}
        {takeBack && <CutTakeBack info={takeBack} cutLabel={cutLabel ?? "this cut"} />}
        <span className="flex-1" />
        {withdrawn ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-medium text-muted">
            <Undo2 className="size-4" /> Withdrawn — waiting on the next version
          </span>
        ) : decided ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
              submission.status === "APPROVED" ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
            )}
          >
            {submission.status === "APPROVED" ? <ThumbsUp className="size-4" /> : <Undo2 className="size-4" />}
            {submission.status === "APPROVED" ? "Approved" : `Changes requested — waiting on ${editorLabel}`}
          </span>
        ) : (
          <>
            <button
              onClick={() => run(() => requestCutChanges(submission.id))}
              disabled={pending || openEditorNotes === 0}
              title={openEditorNotes === 0 ? "Add at least one editor note first" : `Send ${openEditorNotes} open note${openEditorNotes === 1 ? "" : "s"} back to ${editorLabel}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-sm font-medium text-warning hover:bg-warning/20 disabled:opacity-50"
            >
              <Undo2 className="size-4" /> Request changes{openEditorNotes > 0 ? ` (${openEditorNotes})` : ""}
            </button>
            <button
              onClick={() => run(() => approveCut(submission.id))}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <ThumbsUp className="size-4" />} Approve cut
            </button>
          </>
        )}
      </div>
      {msg && <p className="text-xs text-success">{msg}</p>}
      {err && <p className="text-xs text-danger">{err}</p>}

      {/* Composer */}
      {composing && (
        <div className="rounded-2xl border border-brand/40 bg-surface p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-brand">
            <MessageSquarePlus className="size-3.5" /> Cut note
            {capturedAt != null && <span className="rounded bg-brand-soft px-1.5 py-0.5 tabular-nums">at {fmtClock(capturedAt)}</span>}
          </div>
          <MentionTextarea
            autoFocus
            value={body}
            onChange={setBody}
            rows={2}
            placeholder="What needs to change here… (@ to tag someone)"
            className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CHOICES.map((c, i) => {
              const Icon = c.icon === "camera" ? Camera : Pencil;
              return (
                <button
                  key={c.label}
                  onClick={() => setChoice(i)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                    i === choice ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-2",
                  )}
                >
                  <Icon className="size-3" /> {c.label}
                </button>
              );
            })}
          </div>
          {capturedAt == null && !src && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <span>Timestamp (optional)</span>
              <input
                value={clock}
                onChange={(e) => setClock(e.target.value)}
                placeholder="mm:ss"
                className="w-20 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand"
              />
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() =>
                run(
                  () =>
                    addCutNote({
                      projectId,
                      submissionId: submission.id,
                      body,
                      lane: CHOICES[choice].lane,
                      kind: CHOICES[choice].kind,
                      timeSec: capturedAt ?? parseClock(clock),
                    }),
                  () => {
                    setBody("");
                    setClock("");
                    setComposing(false);
                  },
                )
              }
              disabled={pending || !body.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />} Save note
            </button>
            <button onClick={() => setComposing(false)} className="px-1 text-xs font-medium text-muted hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Notes */}
      {sorted.length > 0 && (
        <div className="divide-y divide-border rounded-2xl border bg-surface">
          {sorted.map((n) => (
            <div key={n.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                {n.timeSec != null ? (
                  <button
                    onClick={() => seek(n.timeSec!)}
                    disabled={!src}
                    className="mt-0.5 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums hover:bg-border disabled:opacity-60"
                  >
                    {fmtClock(n.timeSec)}
                  </button>
                ) : (
                  <span className="mt-0.5 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-2">—:—</span>
                )}
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATUS_DOT[n.status] ?? "bg-brand")} />
                {n.lane === "PHOTOGRAPHER" ? (
                  <Camera className="mt-1 size-3.5 shrink-0 text-sky-500" />
                ) : (
                  <Pencil className="mt-1 size-3.5 shrink-0 text-muted-2" />
                )}
                <button
                  onClick={() => setOpenId((v) => (v === n.id ? null : n.id))}
                  className="min-w-0 flex-1 text-left text-sm text-foreground/90"
                >
                  {n.body}
                  <span className="ml-2 text-xs text-muted-2">
                    {n.kind === "coaching" ? "coaching · " : ""}
                    {n.replies.length > 0 ? `${n.replies.length} repl${n.replies.length === 1 ? "y" : "ies"}` : ""}
                  </span>
                </button>
                {n.status !== "RESOLVED" ? (
                  <button
                    onClick={() => run(() => setCutNoteStatus(n.id, "RESOLVED"))}
                    disabled={pending}
                    title="Resolve — this is handled"
                    className="shrink-0 rounded-lg p-1.5 text-muted-2 hover:bg-success/10 hover:text-success"
                  >
                    <Check className="size-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => run(() => setCutNoteStatus(n.id, "OPEN"))}
                    disabled={pending}
                    title="Reopen"
                    className="shrink-0 rounded-lg p-1.5 text-muted-2 hover:bg-surface-2 hover:text-foreground"
                  >
                    <RotateCcw className="size-4" />
                  </button>
                )}
              </div>

              {open?.id === n.id && (
                <div className="mt-2 space-y-2 border-l-2 border-border pl-4">
                  {n.replies.map((r) => (
                    <div key={r.id} className="flex items-start gap-1.5 text-sm">
                      <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-muted-2" />
                      <div>
                        <span className="text-xs font-medium text-muted">{r.authorName ?? "Someone"}: </span>
                        <span className="text-foreground/85">{r.body}</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <MentionTextarea
                      value={reply}
                      onChange={setReply}
                      onEnter={() => { if (reply.trim() && !pending) run(() => replyCutNote(n.id, reply), () => setReply("")); }}
                      rows={1}
                      placeholder="Reply… (@ to tag)"
                      className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-brand"
                    />
                    <button
                      onClick={() => run(() => replyCutNote(n.id, reply), () => setReply(""))}
                      disabled={pending || !reply.trim()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
                    >
                      <Send className="size-3.5" /> Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
