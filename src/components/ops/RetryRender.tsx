"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { retryRenderAction } from "@/app/ops/renderActions";

/**
 * "Try the pass again": the Topaz pass on a video whose pass was skipped or
 * did not finish, on the row where the failure is, not on the Connections
 * page (Jordan, Sep 18).
 *
 * A client component, so it takes an id and calls a server action. It must not
 * import @/lib/topazJobs — that is the single most reliable way to break this
 * build while tsc stays quiet.
 *
 * IT ASKS FIRST, for a different reason than "Mark as sent" does. That button
 * asks because its stamp cannot be cleared; this one asks because a retry
 * SPENDS MONEY — a new render is a new charge — and it sits on a card people
 * scan quickly on a phone.
 *
 * THE QUESTION STAYS until Yes or Cancel (Oct 23 2026 audit). It used to
 * revert by itself after six seconds: the same pattern that ate Jordan's two
 * "Run Topaz again" presses on his phone that day (RerunTopaz, 0c918fb), where
 * the second tap re-armed the question instead of answering it.
 *
 * The answer is shown rather than swallowed, including the refusals: "that one
 * is already on its way" and "that video already went through" are the two
 * things somebody pressing twice most needs to be told.
 */
export function RetryRender({ jobId, street }: { jobId: string; street: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const run = () => {
    setMsg(null);
    start(async () => {
      const r = await retryRenderAction(jobId).catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing changed; refresh the page and try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setAsking(false);
        router.refresh();
      }
    });
  };

  const btn = "inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:bg-surface-2 disabled:opacity-50";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-retry-render={jobId}>
      {!asking ? (
        <button type="button" onClick={() => { setAsking(true); setMsg(null); }} disabled={busy} aria-label={`Run the Topaz pass again for ${street}`} className={btn}>
          <RotateCcw className="size-3" /> Try the pass again
        </button>
      ) : (
        <>
          <button type="button" onClick={run} disabled={busy} aria-label={`Yes, run the Topaz pass again for ${street}`} className={btn}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} {busy ? "Starting..." : "Yes, run it again"}
          </button>
          <button type="button" onClick={() => { setAsking(false); setMsg(null); }} disabled={busy} className={btn}>
            Cancel
          </button>
        </>
      )}
      {msg && <span role="status" className={msg.ok ? "text-xs text-success" : "text-xs text-danger"}>{msg.text}</span>}
    </span>
  );
}
