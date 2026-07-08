import Link from "next/link";
import { Clapperboard } from "lucide-react";
import type { OwnerDials } from "@/lib/queries";

// Two already-built quality dials, surfaced on the owner dashboard as ONE quiet
// strip beneath the pulse. Owner-only (rendered behind the same gate as the
// pulse + money strips). Both light/dark via tokens (surface/border/muted +
// warning/danger) — no hard-coded colors.
//
//   1) VIDEO SLA — a compact roll-up of the in-flight video bench: "N video jobs
//      in editing · M past SLA", linking into /editing (the Editor Queue's full
//      Video-SLA table). We DON'T re-list the individual overdue jobs — most of
//      them already surface in the Stuck Jobs panel above (shot 48h+ undelivered
//      / past deliveryDue); this is the aggregate signal + a jump to the queue,
//      not a second copy of the same fires.
//
//   2) QC QUALITY — revision-after-delivery rate + avg misses/pass from the last
//      30 days of completed QC passes. GUARDED: with zero passes on record (the
//      launch state — QcRecords only accrue as Kyle completes guided-QC cards)
//      we show a muted "tracking starts" hint instead of a misleading 0%/NaN.
export function QualityDials({ dials }: { dials: OwnerDials }) {
  const { video, qc } = dials;
  // Nothing to say at all (no video in the pipeline AND no QC history) → render
  // nothing rather than an empty shell.
  if (video.inEditing === 0 && qc.qcPasses === 0) return null;

  return (
    <div className="panel-shadow flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-2xl border border-border bg-surface px-5 py-3 text-sm">
      {/* Video SLA — the editing bench, one line. Amber-emphasis only when at
          least one job is past its window. */}
      {video.inEditing > 0 && (
        <Link href="/editing" className="inline-flex items-center gap-1.5 hover:opacity-80">
          <Clapperboard className="size-3.5 text-muted-2" />
          <span className="text-muted">Video</span>{" "}
          <b className="tabular-nums">{video.inEditing}</b>
          <span className="text-muted">in editing</span>
          {video.pastSla > 0 && (
            <span className="ml-0.5 rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning tabular-nums">
              {video.pastSla} past SLA
            </span>
          )}
        </Link>
      )}

      {/* QC quality dial — only once there's data. Empty state shows the hint so
          the owner knows the dial is coming, not that quality is 0%. */}
      {qc.qcPasses > 0 ? (
        <>
          <span>
            <span className="text-muted">Revisions after delivery</span>{" "}
            {/* reopenedRate rising = worse, so it reads as a plain number the
                owner watches trend down over the coming weeks. */}
            <b className="tabular-nums">{qc.reopenedRate}%</b>
          </span>
          <span>
            <span className="text-muted">QC misses/job</span>{" "}
            <b className="tabular-nums">{qc.avgMisses}</b>
          </span>
          {/* The single most-skipped checklist item — the owner's "what keeps
              slipping" pointer. Only when we actually have a miss on record. */}
          {qc.byMiss[0] && (
            <span className="text-muted-2">
              most-missed: <span className="text-muted">{qc.byMiss[0].label}</span>
            </span>
          )}
        </>
      ) : (
        video.inEditing > 0 && (
          <span className="text-[11px] text-muted-2">
            QC tracking starts as cards complete
          </span>
        )
      )}
    </div>
  );
}
