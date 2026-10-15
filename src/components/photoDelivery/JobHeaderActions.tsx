"use client";

import Link from "next/link";
import { useTransition } from "react";
import { CloudDownload, Maximize2, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { holdJobAction, releaseHoldAction, requestQcAction, syncFromAutohdrAction, type ActionResult } from "@/app/ops/photo-delivery/actions";
import { usePrompt } from "./usePrompt";

// ---------------------------------------------------------------------------
// Job-level actions in the page header: put the job on hold (a reason is
// required; delivery is blocked until it is released), release the hold, ask
// for a fresh QC run, open review mode, and (Oct 14 2026, huddle finding 3)
// read what AutoHDR shows now, so a change made in AutoHDR's own editor
// (Perspective Off, Crop & Tilt) reaches the hub and the Aryeo folder.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

export function JobHeaderActions({ jobId, stage, qcEnabled, autohdr = false }: { jobId: string; stage: string; qcEnabled: boolean; autohdr?: boolean }) {
  const [pending, start] = useTransition();
  const { toast, show } = useToast();
  const { ask, dialog } = usePrompt();
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      try {
        const r = await fn();
        show(r.ok ? "ok" : "err", r.message);
      } catch {
        show("err", "The hub didn't answer. Reload the page to see what is saved.");
      }
    });
  const canRerun = qcEnabled && !["EDITING", "EDIT_FAILED", "QC_RUNNING", "DELIVERED"].includes(stage);
  return (
    <>
      {stage === "ON_HOLD" ? (
        <button type="button" className={btn} disabled={pending} onClick={() => run(() => releaseHoldAction(jobId))}>
          <PlayCircle aria-hidden className="size-4" /> Release hold
        </button>
      ) : stage !== "DELIVERED" ? (
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={async () => {
            const reason = await ask({
              title: "Put this job on hold?",
              description: "Delivery is blocked until the hold is released. The job then returns to where it left off.",
              presets: ["Waiting on the agent", "Reshoot needed", "Waiting on staging or a fix outside the hub"],
              required: true,
              confirmLabel: "Put on hold",
            });
            if (reason !== null) run(() => holdJobAction(jobId, reason));
          }}
        >
          <PauseCircle aria-hidden className="size-4" /> Put on hold
        </button>
      ) : null}
      {canRerun && (
        <button type="button" className={btn} disabled={pending} onClick={() => run(() => requestQcAction(jobId))} title="QC runs again on the next pass (Anthropic cost, no AutoHDR credits)">
          <RefreshCw aria-hidden className="size-4" /> Re-run QC
        </button>
      )}
      {autohdr && stage !== "DELIVERED" && (
        <button type="button" className={btn} disabled={pending} onClick={() => run(() => syncFromAutohdrAction(jobId))} title="Changed a photo in AutoHDR's editor (Perspective Off, Crop & Tilt)? This brings the change into the hub and the Aryeo folder. Free.">
          <CloudDownload aria-hidden className="size-4" /> Check AutoHDR for changes
        </button>
      )}
      <Link href={`/ops/photo-delivery/${jobId}/review`} className={btn}>
        <Maximize2 aria-hidden className="size-4" /> Review mode
      </Link>
      {dialog}
      {toast}
    </>
  );
}
