import { Scissors } from "lucide-react";

// Jordan's culling policy (Jul 2026): galleries kept coming in way over count —
// extra photos cost real editing money and clients said oversized galleries are
// a hassle to sort through. Targets: ~50 photos for most homes, ~80 for large
// properties. Over-delivering is now pay-deductible, so the reminder lives on
// the upload list AND on every shoot's drop page.
export function CullingReminder({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed">
        <Scissors className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          <strong>Cull before you drop:</strong> aim for <strong>~50 photos</strong> on most homes,
          up to <strong>~80</strong> on large properties. Over-delivering comes out of shoot pay.
        </span>
      </p>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
      <Scissors className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="text-sm leading-relaxed">
        <p className="font-semibold">Cull your photos before uploading</p>
        <p className="mt-1 text-muted">
          Most homes should be <strong className="text-foreground">around 50 photos or fewer</strong> — large
          properties up to <strong className="text-foreground">about 80</strong>. Extra photos cost real editing
          money, and clients have told us oversized galleries are a hassle to sort through and organize.
        </p>
        <p className="mt-1.5 text-xs font-medium text-warning">
          Heads up: over-delivering photos will come out of shoot pay going forward.
        </p>
      </div>
    </div>
  );
}
