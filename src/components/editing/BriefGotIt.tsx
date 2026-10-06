"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { acknowledgeEditorBrief } from "@/app/edit/[id]/receipt.actions";

// ---------------------------------------------------------------------------
// "GOT IT" FOR THE VIDEO ON THIS PAGE (Oct 5 2026, corrected that night).
//
// The brief used to carry a "Receive this assignment" button inside EVERY
// video's brief — four presses on a monthly session, two paragraphs each, for
// a receipt that gates nothing (Start/Pause and the upload never read it). It
// is still worth having: the office sees that the editor has the current
// brief, and a changed brief asks again.
//
// The first one-line version acknowledged EVERY pending video on the job with
// one press — including videos the editor had never opened — and said "Got
// it" before anything was saved (review, Oct 5 night). Now:
//   · the press records the receipt for the video whose brief is on this
//     page, and only that one; the job's other videos still waiting for a Got
//     it are named with a link to each;
//   · the click answers at once with "Saving…" (the button can't be pressed
//     twice), and "Got it" appears only once the server has saved it;
//   · a refusal (the brief changed, the video was reassigned) or a dropped
//     connection comes back with the reason and the button, so nothing is
//     silently lost. A repeat press is safe — the receipt is idempotent.
// ---------------------------------------------------------------------------

export function BriefGotIt({
  projectId,
  videoNumber,
  pending,
  changed,
  noLogo,
  otherVideos = [],
}: {
  projectId: string;
  /** The number of the video on this page ("Video 2 of 4"). */
  videoNumber: number;
  /** This page's video, when it still needs a receipt — the exact digest the page showed. Empty = already received. */
  pending: { outputId: string; digest: string }[];
  /** True when it was received before and the brief has changed since. */
  changed: boolean;
  /** The office chose to run this video with no logo — named so the press acknowledges that choice too. */
  noLogo: boolean;
  /** This editor's other videos on the job still waiting for a Got it. */
  otherVideos?: { number: number; href: string }[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = otherVideos.length > 0 && (
    <p className="text-xs text-muted" data-got-it-others>
      Still waiting for your Got it:{" "}
      {otherVideos.map((v, i) => (
        <span key={v.href}>
          {i > 0 ? ", " : ""}
          <Link href={v.href} className="font-medium text-brand hover:underline">video {v.number}</Link>
        </span>
      ))}
      .
    </p>
  );
  if (pending.length === 0 || (saved && !error)) {
    return (
      <div className="space-y-1">
        {saved && (
          <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-success">
            <CheckCircle2 className="size-4 shrink-0" /> Got it — the office can see you have video {videoNumber}&rsquo;s brief.
          </p>
        )}
        {others}
      </div>
    );
  }
  const press = () => {
    if (busy) return;
    setError(null);
    start(async () => {
      for (const p of pending) {
        const r = await acknowledgeEditorBrief(projectId, p.outputId, p.digest).catch(() => ({ ok: false, message: "That didn't save — check your connection and try again." }));
        if (!r.ok) {
          setError(r.message);
          return;
        }
      }
      setSaved(true);
      router.refresh();
    });
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={press}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-brand px-4 py-2 text-sm font-semibold text-brand hover:bg-brand-soft/40 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-brand"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} {busy ? "Saving…" : `Got it — video ${videoNumber}`}
        </button>
        <span className="text-xs text-muted">
          {changed ? "This video's brief changed since you last said Got it." : "Tell the office you have this video's brief."}
          {noLogo && " Includes: no logo on this video — the office's choice."}
        </span>
        {error && <p role="alert" className="w-full text-xs text-danger">{error} Nothing was recorded — press Got it again.</p>}
      </div>
      {others}
    </div>
  );
}
