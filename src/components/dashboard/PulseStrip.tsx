import type { OwnerPulse } from "@/lib/queries";

// Direction arrow next to a pulse number. Deltas compare the trailing 30 days
// to the 30 before. GREEN MEANS BETTER — and "better" is per-metric: on-time %
// and reply % improve going UP, turnaround improves going DOWN (faster), so
// color keys off `downIsGood`, never off the arrow direction alone.
function Delta({ delta, downIsGood = false, suffix = "" }: { delta: number | null; downIsGood?: boolean; suffix?: string }) {
  if (delta == null || delta === 0) return null; // flat/unknowable — no arrow, no noise
  const up = delta > 0;
  const better = downIsGood ? !up : up;
  return (
    <span className={`ml-0.5 text-[10px] font-semibold ${better ? "text-success" : "text-danger"}`}>
      {up ? "↑" : "↓"}{Math.abs(delta)}{suffix}
    </span>
  );
}

// Owner pulse — "is the machine healthy?" in one glance-able strip: on-time
// delivery %, median turnaround, texts answered <1h, open revisions. Owner-only
// (rendered behind the same guard as the money strip) and shown even in the
// all-clear state — a quiet day is exactly when trend arrows matter.
export function PulseStrip({ pulse }: { pulse: OwnerPulse }) {
  const na = "—"; // metric had no data in the window (e.g. nothing delivered)
  return (
    <div className="panel-shadow flex flex-wrap items-center gap-x-5 gap-y-1 rounded-2xl border border-border bg-surface px-5 py-3 text-sm">
      <span>
        <span className="text-muted">On-time</span>{" "}
        <b className="tabular-nums">{pulse.onTimePct != null ? `${pulse.onTimePct}%` : na}</b>
        <Delta delta={pulse.onTimeDelta} />
      </span>
      <span>
        <span className="text-muted">Turnaround</span>{" "}
        <b className="tabular-nums">{pulse.turnaroundH != null ? `${pulse.turnaroundH}h` : na}</b>
        <Delta delta={pulse.turnaroundDeltaH} downIsGood suffix="h" />
      </span>
      <span>
        <span className="text-muted">Replies &lt;1h</span>{" "}
        <b className="tabular-nums">{pulse.replyPct != null ? `${pulse.replyPct}%` : na}</b>
        <Delta delta={pulse.replyDelta} />
      </span>
      <span>
        <span className="text-muted">Revisions</span>{" "}
        <b className="tabular-nums">{pulse.openRevisions}</b>
      </span>
    </div>
  );
}
