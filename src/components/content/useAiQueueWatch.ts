"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { aiQueueStatusAction } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// While anything this page shows is queued or drafting (aiQueue.ts), ask the
// server every few seconds which runs are still going — one small query, not
// a page render — and refresh the page the moment that set changes, so a
// finished draft turns into "Script drafted → View" (or a failure with its
// reason) without a manual reload. Nothing to watch → no polling at all. A
// hidden tab skips its ticks. The poll also restarts the queue when work is
// waiting and a slot is free (aiQueueStatusAction).
// ---------------------------------------------------------------------------

export const QUEUE_POLL_MS = 5000;

export function useAiQueueWatch(enrollmentId: string, active: string[]): void {
  const router = useRouter();
  const rendered = [...active].sort().join(",");
  useEffect(() => {
    if (!rendered || !enrollmentId) return;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const r = await aiQueueStatusAction(enrollmentId);
        if (stopped || !r.ok || !r.active) return;
        if ([...r.active].sort().join(",") !== rendered) router.refresh();
      } catch { /* the next tick tries again */ } finally { inFlight = false; }
    };
    const t = setInterval(tick, QUEUE_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [enrollmentId, rendered, router]);
}
