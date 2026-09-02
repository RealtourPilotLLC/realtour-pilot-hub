"use client";

import { useRef, useState, useTransition } from "react";
import { CheckCircle2, Clock, Loader2, Send, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalAddComment, portalDeleteComment, portalRequestRevision } from "@/app/portal/actions";
import type { PortalCut } from "@/lib/portal";

// The client's video review — a timestamped review loop on their own portal page
// (interactive layer, Aug 28): watch the cut, drop notes at the moment they
// pause, then send everything as ONE revision request. Mobile-first: agents
// review reels on their phone.

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function PortalVideoReview({ token, cut, monthLabel }: { token: string; cut: PortalCut; monthLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [comments, setComments] = useState(cut.comments);
  const [note, setNote] = useState("");
  const [atTime, setAtTime] = useState(true);
  const [overall, setOverall] = useState("");
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const open = comments.filter((c) => c.status === "OPEN");
  const already = cut.revisionOpen || comments.some((c) => c.status === "SENT");

  const add = () => {
    const t = atTime && videoRef.current ? videoRef.current.currentTime : null;
    videoRef.current?.pause();
    const body = note.trim();
    if (!body) return;
    start(async () => {
      const r = (await portalAddComment(token, cut.submissionId, t, body).catch(() => ({ ok: false, message: "That didn't save — try again." }))) as { ok: boolean; message: string; id?: string };
      if (r.ok) {
        // The real id comes back from the server, so Remove works immediately.
        setComments((c) => [...c, { id: r.id ?? `tmp-${Date.now()}`, timeSec: t == null ? null : Math.round(t * 10) / 10, body, status: "OPEN", createdAtISO: new Date().toISOString() }]);
        setNote("");
        setMsg(null);
      } else setMsg(r.message);
    });
  };

  const remove = (id: string) => {
    start(async () => {
      const r = await portalDeleteComment(token, id).catch(() => ({ ok: false, message: "" }));
      if (r.ok) setComments((c) => c.filter((x) => x.id !== id));
    });
  };

  const send = () => {
    start(async () => {
      const r = await portalRequestRevision(token, cut.submissionId, overall).catch(() => ({ ok: false, message: "That didn't send — text us and we'll get on it." }));
      if (r.ok) {
        setSent(true);
        setAsking(false);
        setComments((c) => c.map((x) => (x.status === "OPEN" ? { ...x, status: "SENT" } : x)));
        setMsg(r.message);
      } else setMsg(r.message);
    });
  };

  const seek = (t: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      videoRef.current.play().catch(() => {});
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{cut.fileName ?? "Your video"}</span>
        <span className="text-[11px] text-muted-2">{monthLabel}</span>
        {(already || sent) && (
          <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">
            <Undo2 className="size-3" /> Updates in progress
          </span>
        )}
      </div>

      <video ref={videoRef} src={cut.assetUrl} controls playsInline preload="metadata" className="mt-2 w-full rounded-lg bg-black" />

      {/* Their notes so far */}
      {comments.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {comments.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-sm">
              {c.timeSec != null ? (
                <button onClick={() => seek(c.timeSec!)} className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                  <Clock className="size-3" /> {fmtT(c.timeSec)}
                </button>
              ) : (
                <span className="mt-0.5 shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-muted-2">overall</span>
              )}
              <span className={cn("min-w-0 flex-1 leading-snug", c.status === "SENT" ? "text-muted-2" : "text-foreground/90")}>{c.body}</span>
              {c.status === "OPEN" && !c.id.startsWith("tmp-") ? (
                <button onClick={() => remove(c.id)} aria-label="Remove note" className="mt-0.5 shrink-0 text-muted-2 hover:text-danger">
                  <Trash2 className="size-3.5" />
                </button>
              ) : c.status === "SENT" ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Note composer */}
      <div className="mt-3 flex items-start gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Pause the video and tell us what to change…"
          rows={2}
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={add}
          disabled={busy || !note.trim()}
          className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Add"}
        </button>
      </div>
      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-2">
        <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} className="accent-[var(--brand)]" />
        pin this note to the paused moment
      </label>

      {/* Send it */}
      {!sent && (
        <div className="mt-3 border-t border-border pt-3">
          {!asking ? (
            <button
              onClick={() => setAsking(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface"
            >
              <Send className="size-3.5" /> Request changes{open.length > 0 ? ` (${open.length} note${open.length === 1 ? "" : "s"})` : ""}
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={overall}
                onChange={(e) => setOverall(e.target.value)}
                placeholder="Anything overall? (optional — your notes above come with it)"
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="flex items-center gap-2">
                <button onClick={send} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                  {busy && <Loader2 className="size-3.5 animate-spin" />} Send to the editor
                </button>
                <button onClick={() => setAsking(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p className={cn("mt-2 text-xs", sent ? "text-success" : "text-danger")}>{msg}</p>}
    </div>
  );
}
