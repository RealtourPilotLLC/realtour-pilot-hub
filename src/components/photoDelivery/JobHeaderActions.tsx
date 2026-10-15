"use client";

import Link from "next/link";
import { useEffect, useRef, useTransition } from "react";
import { ChevronDown, CloudDownload, Maximize2, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";
import { holdJobAction, releaseHoldAction, requestQcAction, syncFromAutohdrAction, type ActionResult } from "@/app/ops/photo-delivery/actions";
import { usePrompt } from "./usePrompt";

// ---------------------------------------------------------------------------
// Job-level actions in the page header. One stays in view: Review mode, or
// Release hold while the job is on hold. The rest sit under "More" (Oct 15
// 2026: four equal buttons wrapped into rows on Kyle's phone): put the job on
// hold (a reason is required; delivery is blocked until it is released), check
// the photos again, and (Oct 14 2026, huddle finding 3) Sync from AutoHDR, so a
// change made in AutoHDR's own editor (Perspective Off, Crop & Tilt) reaches
// the hub and the Aryeo folder.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";
const item = "flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

export function JobHeaderActions({ jobId, stage, qcEnabled, autohdr = false }: { jobId: string; stage: string; qcEnabled: boolean; autohdr?: boolean }) {
  const [pending, start] = useTransition();
  const { toast, show } = useToast();
  const { ask, dialog } = usePrompt();
  const more = useRef<HTMLDetailsElement>(null);
  // The menu closes on a click anywhere else.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const d = more.current;
      if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const run = (fn: () => Promise<ActionResult>) => {
    if (more.current) more.current.open = false;
    start(async () => {
      try {
        const r = await fn();
        show(r.ok ? "ok" : "err", r.message);
      } catch {
        show("err", "The hub didn't answer. Reload the page to see what is saved.");
      }
    });
  };
  const onHold = stage === "ON_HOLD";
  const canHold = !onHold && stage !== "DELIVERED";
  const canRerun = qcEnabled && !["EDITING", "EDIT_FAILED", "QC_RUNNING", "DELIVERED"].includes(stage);
  const canSync = autohdr && stage !== "DELIVERED";
  const hold = async () => {
    if (more.current) more.current.open = false;
    const reason = await ask({
      title: "Put this job on hold?",
      description: "Delivery is blocked until the hold is released. The job then returns to where it left off.",
      presets: ["Waiting on the agent", "Reshoot needed", "Waiting on staging or a fix outside the hub"],
      required: true,
      confirmLabel: "Put on hold",
    });
    if (reason !== null) run(() => holdJobAction(jobId, reason));
  };
  const reviewHref = `/ops/photo-delivery/${jobId}/review`;
  return (
    <>
      {onHold ? (
        <button type="button" className={btn} disabled={pending} onClick={() => run(() => releaseHoldAction(jobId))}>
          <PlayCircle aria-hidden className="size-4" /> Release hold
        </button>
      ) : (
        <Link href={reviewHref} className={btn}>
          <Maximize2 aria-hidden className="size-4" /> Review mode
        </Link>
      )}
      {(onHold || canHold || canRerun || canSync) && (
        <details ref={more} className="relative">
          <summary className={cn(btn, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
            More <ChevronDown aria-hidden className="size-4" />
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-border bg-surface p-1 shadow-lg">
            {onHold && (
              <Link href={reviewHref} className={item}>
                <Maximize2 aria-hidden className="size-4" /> Review mode
              </Link>
            )}
            {canHold && (
              <button type="button" className={item} disabled={pending} onClick={() => void hold()}>
                <PauseCircle aria-hidden className="size-4" /> Put on hold
              </button>
            )}
            {canRerun && (
              <button type="button" className={item} disabled={pending} onClick={() => run(() => requestQcAction(jobId))} title="Runs the photo check again.">
                <RefreshCw aria-hidden className="size-4" /> Check again
              </button>
            )}
            {canSync && (
              <button type="button" className={item} disabled={pending} onClick={() => run(() => syncFromAutohdrAction(jobId))} title="Changed a photo in AutoHDR's editor (Perspective Off, Crop & Tilt)? This brings the change into the hub and the Aryeo folder.">
                <CloudDownload aria-hidden className="size-4" /> Sync from AutoHDR
              </button>
            )}
          </div>
        </details>
      )}
      {dialog}
      {toast}
    </>
  );
}
