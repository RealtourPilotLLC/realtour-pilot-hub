"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { retryRenderAction } from "@/app/ops/renderActions";

/**
 * "Run the 1080p pass again" — on the row where the failure is, not on the
 * Connections page (Jordan, Sep 18).
 *
 * A client component, so it takes an id and calls a server action. It must not
 * import @/lib/topazJobs — that is the single most reliable way to break this
 * build while tsc stays quiet.
 *
 * IT ASKS FIRST, for a different reason than "Mark as sent" does. That button
 * asks because its stamp cannot be cleared; this one asks because a retry
 * SPENDS MONEY — a new render is a new charge — and it sits on a card people
 * scan quickly on a phone. The question reverts on its own, so a mis-tap costs
 * nothing.
 *
 * The answer is shown rather than swallowed, including the refusals: "that one
 * is already on its way" and "that video already went through" are the two
 * things somebody pressing twice most needs to be told.
 */
export function RetryRender({ jobId, street }: { jobId: string; street: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A row that leaves on a refresh must not take a pending timer with it.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const press = () => {
    if (!asking) {
      setAsking(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAsking(false), 6000);
      return;
    }
    setAsking(false);
    start(async () => {
      const r = await retryRenderAction(jobId);
      setMsg(r.message);
      if (r.ok) router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={press}
        disabled={busy}
        aria-label={asking ? `Yes, run the 1080p pass again for ${street}` : `Run the 1080p pass again for ${street}`}
        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:bg-surface-2 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
        {asking ? "Yes, run it again" : "Try the pass again"}
      </button>
      {msg && <span className="text-[10px] text-muted-2">{msg}</span>}
    </span>
  );
}
