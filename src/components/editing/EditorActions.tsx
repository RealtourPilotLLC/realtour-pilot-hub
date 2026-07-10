"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Send } from "lucide-react";
import { submitCutForReview } from "@/app/review/actions";

// The editor's primary "Done — send to review" button. Server-side it finds the
// newest cut in the FINAL Dropbox folder, mints a streaming link, parks a
// ReviewSubmission in the owner's Review Room (/review), completes the editor's
// task and flips the job to Review — then the page revalidates so the card
// drops out of Do-Now. Optimistic disable while pending.
export function SendToReviewButton({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || done}
        onClick={() =>
          start(async () => {
            try {
              const r = await submitCutForReview(projectId);
              if (r.ok) {
                setDone(true);
                setMsg(r.message);
              } else {
                setErr(r.message || "Couldn't send — try again.");
              }
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Couldn't send — try again.");
            }
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#5b53ff] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#4a43e0] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {done ? "Sent for review" : "Done — send to review"}
      </button>
      {msg && <span className="max-w-64 text-right text-xs text-muted">{msg}</span>}
      {err && <span className="max-w-64 text-right text-xs text-danger">{err}</span>}
    </div>
  );
}

// The brief-page version: same action, plus an optional note to the reviewer
// ("music was the client's pick", "went longer on the kitchen — great light").
export function SubmitCutCard({ projectId }: { projectId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (done) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
        <Check className="size-4 shrink-0" /> {msg ?? "Sent for review."}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note to the reviewer…"
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setErr(null);
            const r = await submitCutForReview(projectId, note);
            if (r.ok) {
              setDone(true);
              setMsg(r.message);
            } else {
              setErr(r.message || "Couldn't send — try again.");
            }
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#5b53ff] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#4a43e0] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Done — send to review
      </button>
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}
