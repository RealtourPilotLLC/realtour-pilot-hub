"use client";

import { useState } from "react";
import { Camera, Check, CheckCheck, Loader2, Pencil, RotateCcw, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionTextarea } from "@/components/mentions/MentionTextarea";
import { etDateTime } from "@/lib/datetime";
import { STATUS_BG, STATUS_CHIP, STATUS_LABEL, fmtClock, type ReviewNote, type ReviewStatus } from "./types";

// One note's thread: body → replies → reply box + the owner's status controls.
// Rendered INSIDE the lightbox stage (the parent wrapper is position:relative):
// a bottom sheet on phones, a right-hand side panel on larger screens — same
// element, responsive classes, so touch and desktop share one code path.
export function NoteThread({
  note,
  index,
  onClose,
  onReply,
  onSetStatus,
}: {
  note: ReviewNote;
  index: number; // the pin/list number, so the panel visibly matches its dot
  onClose: () => void;
  onReply: (body: string) => Promise<{ ok: boolean; message?: string }>;
  onSetStatus: (status: ReviewStatus) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setErr(r.message ?? "That didn't save.");
  }

  const sendReply = () => {
    const text = reply.trim();
    if (!text) return;
    void run(async () => {
      const r = await onReply(text);
      if (r.ok) setReply("");
      return r;
    });
  };

  // Status controls follow the lifecycle OPEN → FIXED → RESOLVED; anything
  // past OPEN can be reopened (the review room is owner/admin-only, so no
  // per-button role checks needed here).
  const statusButtons: { label: string; icon: typeof Check; to: ReviewStatus }[] =
    note.status === "OPEN"
      ? [
          { label: "Mark fixed", icon: Check, to: "FIXED" },
          { label: "Approve", icon: CheckCheck, to: "RESOLVED" },
        ]
      : note.status === "FIXED"
        ? [
            { label: "Approve", icon: CheckCheck, to: "RESOLVED" },
            { label: "Reopen", icon: RotateCcw, to: "OPEN" },
          ]
        : [{ label: "Reopen", icon: RotateCcw, to: "OPEN" }];

  const LaneIcon = note.lane === "PHOTOGRAPHER" ? Camera : Pencil;
  const laneLabel =
    note.lane === "EDIT" ? "Kyle — fix" : note.kind === "coaching" ? "Photographer — coaching" : "Photographer — fix";

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-x-2 bottom-2 z-20 flex max-h-[65%] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl sm:inset-x-auto sm:bottom-2 sm:right-2 sm:top-2 sm:max-h-none sm:w-80"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white", STATUS_BG[note.status])}>
          {index}
        </span>
        <LaneIcon className="size-3.5 shrink-0 text-muted" />
        <span className="truncate text-xs font-semibold">{laneLabel}</span>
        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", STATUS_CHIP[note.status])}>
          {STATUS_LABEL[note.status]}
        </span>
        {note.timeSec != null && <span className="shrink-0 text-[10px] tabular-nums text-muted">at {fmtClock(note.timeSec)}</span>}
        <button onClick={onClose} aria-label="Close note" className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        <div>
          <p className="break-words text-sm">{note.body}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {note.authorName ?? "—"} · {etDateTime(note.createdAt)}
          </p>
        </div>
        {note.replies.map((r) => (
          <div key={r.id} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
            <p className="break-words text-sm">{r.body}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {r.authorName ?? "—"} · {etDateTime(r.createdAt)}
            </p>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-2.5">
        <div className="flex items-center gap-1.5">
          <MentionTextarea
            value={reply}
            onChange={setReply}
            onEnter={sendReply}
            rows={1}
            placeholder="Reply… (@ to tag)"
            className="w-full resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand"
          />
          <button
            onClick={sendReply}
            disabled={busy || !reply.trim()}
            aria-label="Send reply"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {statusButtons.map((b) => {
            const Icon = b.icon;
            return (
              <button
                key={b.to}
                onClick={() => void run(() => onSetStatus(b.to))}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
              >
                <Icon className="size-3" /> {b.label}
              </button>
            );
          })}
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      </div>
    </div>
  );
}
