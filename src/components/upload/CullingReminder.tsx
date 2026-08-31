import { Scissors } from "lucide-react";

// The Photography SOP's culling reminder (rewritten Sep 1 2026 when the SOP
// replaced the old flat 50/80 caps with size-tier RANGES). `target` is THIS
// home's enforcement ceiling from photoTargetFor — when present we lead with
// it. `hidePay` drops the pay line for the /shoot field view (counts only,
// never money).
export function CullingReminder({
  compact,
  target,
  hidePay,
}: {
  compact?: boolean;
  target?: number;
  hidePay?: boolean;
}) {
  if (compact) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed">
        <Scissors className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          {target != null && (
            <>
              <strong>This home&rsquo;s ceiling: ~{target} finals — and the ceiling is not a goal.</strong>{" "}
            </>
          )}
          <strong>Cull before you upload:</strong> a hero shot per space, one composition once, every photo adds
          new information. Extras go to Backup Photos.
          {!hidePay && " Clearly unnecessary photos can carry a $1 production charge."}
        </span>
      </p>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
      <Scissors className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="text-sm leading-relaxed">
        <p className="font-semibold">
          {target != null ? `This home's ceiling: ~${target} finals — the ceiling is not a goal` : "Cull to the Photography SOP before uploading"}
        </p>
        <p className="mt-1 text-muted">
          Gallery targets run by home size — <strong className="text-foreground">25–35 finals on the smallest
          homes up to 70–85 on the largest</strong>. A hero shot per space, one composition once, every photo must
          add new information; alternates go to Backup Photos. Complete coverage, zero unnecessary repetition.
        </p>
        {!hidePay && (
          <p className="mt-1.5 text-xs font-medium text-warning">
            Clearly unnecessary photos (duplicates, distance variations, backups uploaded as finals) can carry a
            $1 production charge. You&rsquo;re never charged for photos a property genuinely needed.
          </p>
        )}
      </div>
    </div>
  );
}
