import "server-only";
import { prisma } from "@/lib/prisma";
import { parseChecklist } from "@/lib/checklist";
import { countQcMisses } from "@/lib/tasks";

// The owner's QC quality dial — reads the QcRecord log (one row per completed QC
// pass, written from both completion paths in src/lib/tasks.ts + actions.ts).
//
// NOT WIRED YET: this is a ready-to-adopt data source. The dashboard owns
// src/app/page.tsx + src/lib/queries.ts (a different agent), so to surface this,
// that page can `import { getQcStats } from "@/lib/qc"` and render one owner-only
// tile — e.g. "Revision-after-delivery rate {reopenedRate}% · avg {avgMisses}
// misses/pass" with the top byMiss labels beneath. Owner-gate it at the call site
// (requireOwner / role check) — this function does no auth itself.

export type QcMissBucket = { label: string; count: number };
export type QcStats = {
  windowDays: number;
  qcPasses: number; // completed QC passes in the window
  avgMisses: number; // mean Kyle-tick items left unchecked at completion
  reopenedRate: number; // % of passes a revision later bounced (the real QC-miss rate)
  byMiss: QcMissBucket[]; // which failure-mode items got missed most, desc
};

// Aggregate QC quality over the last `days` (default 30). Pure read; safe to call
// from any server context. Never throws on bad rows — a corrupt itemsChecked JSON
// just contributes nothing.
export async function getQcStats(days = 30): Promise<QcStats> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const records = await prisma.qcRecord.findMany({
    where: { completedAt: { gte: since } },
    select: { itemsChecked: true, missCount: true, reopenedByRevisionAt: true },
  });

  const qcPasses = records.length;
  const totalMisses = records.reduce((sum, r) => sum + (r.missCount ?? 0), 0);
  const reopened = records.filter((r) => !!r.reopenedByRevisionAt).length;

  // Which specific failure-mode items were left unticked most often — the
  // owner's "what's slipping through" list. Counts unchecked Kyle-tick items
  // across every pass (evidence rows excluded via countQcMisses's same rule).
  const missByLabel = new Map<string, number>();
  for (const r of records) {
    const items = parseChecklist(r.itemsChecked);
    // Reuse the exact miss rule so per-label counts reconcile with missCount.
    if (countQcMisses(items) === 0) continue;
    for (const it of items) {
      if (it.done) continue;
      // Skip evidence rows (they aren't misses). countQcMisses already excludes
      // them; here we mirror by only counting rows it would have counted — cheap
      // to just re-filter with the same predicate via a single-item probe.
      if (countQcMisses([it]) === 0) continue;
      missByLabel.set(it.label, (missByLabel.get(it.label) ?? 0) + 1);
    }
  }
  const byMiss: QcMissBucket[] = [...missByLabel.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    windowDays: days,
    qcPasses,
    avgMisses: qcPasses ? Math.round((totalMisses / qcPasses) * 10) / 10 : 0,
    reopenedRate: qcPasses ? Math.round((reopened / qcPasses) * 1000) / 10 : 0,
    byMiss,
  };
}
