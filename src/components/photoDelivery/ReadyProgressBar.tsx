"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE "GETTING THEM READY" BAR (Oct 14 2026, Jordan: "need instant response
// instead of a loading button when clicking get ready again. It should show a
// progress bar at the bottom of the page and confirmation that it's getting
// ready"). It sits on the top edge of the sticky deliver panel, so it is at
// the bottom of the page wherever Kyle scrolls. While a copy is going it asks
// every two seconds how far it is (each ask also moves the copy on a step when
// nothing else is), counts the photos Dropbox has CONFIRMED, and when the
// folder is swapped in it says so, then refreshes the page. The asks go to a
// GET route (Oct 15: a server action made Kyle's clicks wait behind them) and
// pause while the tab is hidden. The panel's Download photos sits right below.
// ---------------------------------------------------------------------------

export type ReadyBarState = { active: boolean; done: number; total: number; failed: number; note: string | null; finished?: boolean };
/** What the progress route answers (handoff.ts ReadyProgress, the parts the bar reads). */
type ReadyProgress = { active: boolean; done: number; total: number; failed: number; note: string | null };

export function ReadyProgressBar({ jobId, state, setState }: { jobId: string; state: ReadyBarState | null; setState: (s: ReadyBarState | null) => void }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const active = !!state?.active;
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      while (!stop && alive.current) {
        if (!document.hidden) {
          const r = (await fetch(`/api/photo-delivery/progress/${jobId}?what=ready`, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null)) as { progress: ReadyProgress | null } | null;
          if (stop || !alive.current) return;
          const p = r?.progress;
          if (p) {
            if (!p.active) {
              setState({ active: false, done: p.done, total: p.total, failed: p.failed, note: p.note, finished: true });
              router.refresh();
              return;
            }
            setState({ active: true, done: p.done, total: p.total, failed: p.failed, note: p.note });
          }
        }
        await new Promise((res) => setTimeout(res, 2_000));
      }
    };
    void tick();
    return () => { stop = true; };
  }, [active, jobId, router, setState]);

  // A finished bar clears itself after a while (unless something failed).
  useEffect(() => {
    if (!state?.finished || state.failed) return;
    const t = setTimeout(() => setHidden(true), 12_000);
    return () => clearTimeout(t);
  }, [state?.finished, state?.failed]);

  // A new press remounts the bar (DeliverPanel keys it), so a dismissed bar comes back.
  if (!state || (hidden && !state.active)) return null;
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  const failed = !!state.finished && state.failed > 0;
  return (
    <div role="status" aria-live="polite" className="border-b border-border px-3 py-2 sm:px-4">
      <div className="flex items-center gap-2 text-[13px]">
        {state.active ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-brand" /> : failed ? <CircleAlert aria-hidden className="size-4 shrink-0 text-warning" /> : <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />}
        <span className="min-w-0 flex-1 font-medium">
          {state.active
            ? `Getting the photos ready: ${state.done} of ${state.total} copied`
            : failed
              ? `${state.done} of ${state.total} ready. ${state.note ?? ""}`
              : `Ready: all ${state.total} photos are in 06-Ready-for-Aryeo.`}
        </span>
        {!state.active && (
          <button type="button" onClick={() => { setHidden(true); setState(null); }} aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground">
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div className={cn("h-full rounded-full transition-[width] duration-500", failed ? "bg-warning" : state.active ? "bg-brand" : "bg-success")} style={{ width: `${state.active ? Math.max(pct, 4) : pct}%` }} />
      </div>
    </div>
  );
}
