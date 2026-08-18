"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CornerDownRight, Loader2, MessageSquare, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionTextarea } from "@/components/mentions/MentionTextarea";
import { replyCutNote, setCutNoteStatus } from "@/app/review/actions";
import type { CutNote } from "@/lib/reviewRoom";

// ---------------------------------------------------------------------------
// The EDITOR's receiving end of the Review Room — rendered on their /edit/[id]
// brief. Shows the owner's cut notes addressed to them (timestamped), lets them
// talk back in the thread and mark a note FIXED once it's handled. Ordering:
// open fixes first, then fixed-awaiting-re-review, then coaching/resolved.
// Owner/admin see the same list read-only-ish (their desk is /review).
// ---------------------------------------------------------------------------

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const STATUS_CHIP: Record<string, string> = {
  OPEN: "bg-brand-soft text-brand",
  FIXED: "bg-success/10 text-success",
  RESOLVED: "bg-surface-2 text-muted",
};
const STATUS_LABEL: Record<string, string> = { OPEN: "Open", FIXED: "Fixed — awaiting re-review", RESOLVED: "Approved" };

function rank(n: CutNote): number {
  if (n.status === "OPEN" && n.kind === "fix") return 0;
  if (n.status === "FIXED") return 1;
  if (n.status === "OPEN") return 2; // coaching
  return 3; // resolved
}

export function EditFeedback({
  notes,
  canFix,
  viewerName,
  embedded = false,
  onSeek,
}: {
  notes: CutNote[];
  canFix: boolean;
  viewerName?: string | null;
  // embedded: rendered INSIDE the cut panel (no card chrome of its own) with
  // onSeek wiring timestamp chips to the panel's player — the Frame.io feel.
  embedded?: boolean;
  onSeek?: (sec: number) => void;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (notes.length === 0) return null;
  const sorted = [...notes].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  const openCount = sorted.filter((n) => n.status === "OPEN" && n.kind === "fix").length;

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      setErr(null);
      const r = await fn();
      if (!r.ok) setErr(r.message ?? "That didn't work — try again.");
      else {
        after?.();
        router.refresh();
      }
    });

  const Wrapper = embedded ? "div" : "section";
  return (
    <Wrapper className={embedded ? undefined : "rounded-2xl border border-brand/25 bg-surface"}>
      <div className={cn("flex items-center justify-between px-4 py-3 sm:px-5", !embedded && "border-b border-border")}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="size-4 text-brand" /> {embedded ? "Notes on this cut" : "Review feedback"}
          {openCount > 0 && (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
              {openCount} to fix
            </span>
          )}
        </h2>
        {!canFix && viewerName && <span className="text-[11px] text-muted-2">Previewing {viewerName}&rsquo;s feedback</span>}
      </div>
      <ul className="divide-y divide-border">
        {sorted.map((n) => (
          <li key={n.id} className="px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-start gap-2">
              {n.timeSec != null && (
                // With a player on screen (embedded), the chip SEEKS to the
                // moment the note is about — the whole point of timestamps.
                onSeek ? (
                  <button
                    onClick={() => onSeek(n.timeSec!)}
                    title="Jump the player to this moment"
                    className="mt-0.5 shrink-0 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-brand hover:bg-brand/20"
                  >
                    {fmtClock(n.timeSec)}
                  </button>
                ) : (
                  <span className="mt-0.5 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                    {fmtClock(n.timeSec)}
                  </span>
                )
              )}
              <button onClick={() => setOpenId((v) => (v === n.id ? null : n.id))} className="min-w-0 flex-1 text-left">
                <span className="text-sm text-foreground/90">{n.body}</span>
                <span className="ml-2 align-middle">
                  <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", STATUS_CHIP[n.status] ?? "bg-surface-2 text-muted")}>
                    {n.kind === "coaching" ? "Coaching" : STATUS_LABEL[n.status] ?? n.status}
                  </span>
                </span>
                {n.replies.length > 0 && (
                  <span className="ml-2 text-xs text-muted-2">
                    {n.replies.length} repl{n.replies.length === 1 ? "y" : "ies"}
                  </span>
                )}
              </button>
              {canFix && n.status === "OPEN" && n.kind === "fix" && (
                <button
                  onClick={() => run(() => setCutNoteStatus(n.id, "FIXED"))}
                  disabled={pending}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-50"
                >
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Mark fixed
                </button>
              )}
            </div>

            {openId === n.id && (
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
          </li>
        ))}
      </ul>
      {err && <p className="px-4 pb-3 text-xs text-danger sm:px-5">{err}</p>}
    </Wrapper>
  );
}
