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

// ---------------------------------------------------------------------------
// "What's slipping through" — the recurring-miss rollup for the Review Room.
// Photo flags (ImageFlag) are things that slipped past editing/QC and got
// caught on review, so their tag counts ARE the most-commonly-missed list;
// capture-note counts per photographer show where field quality needs work.
// ---------------------------------------------------------------------------

export type FixPatterns = {
  windowDays: number;
  flagsTotal: number; // photo flags raised in the window
  flagsOpen: number; // still unfixed
  byTag: QcMissBucket[]; // flag reasons, most common first
  editNotes: number; // review-room EDIT-lane fix notes in the window
  captureByPhotographer: { name: string; count: number }[]; // PHOTOGRAPHER-lane root notes
};

export async function getFixPatterns(days = 60): Promise<FixPatterns> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const [flags, editNotes, capRoll] = await Promise.all([
    prisma.imageFlag.findMany({
      where: { createdAt: { gte: since } },
      select: { tags: true, status: true },
    }),
    prisma.mediaNote.count({ where: { lane: "EDIT", parentId: null, createdAt: { gte: since } } }),
    prisma.mediaNote.groupBy({
      by: ["photographerId"],
      where: { lane: "PHOTOGRAPHER", parentId: null, photographerId: { not: null }, createdAt: { gte: since } },
      _count: true,
    }),
  ]);

  // Tags are a JSON string array per flag; a bad row just contributes nothing.
  const byTagMap = new Map<string, number>();
  for (const f of flags) {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(f.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch { /* skip */ }
    if (tags.length === 0) tags = ["No reason tagged"];
    for (const t of tags) byTagMap.set(t, (byTagMap.get(t) ?? 0) + 1);
  }
  const byTag = [...byTagMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const memberIds = capRoll.map((r) => r.photographerId).filter((id): id is string => !!id);
  const members = memberIds.length
    ? await prisma.teamMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const captureByPhotographer = capRoll
    .map((r) => ({ name: nameOf.get(r.photographerId!) ?? "Unknown", count: r._count }))
    .sort((a, b) => b.count - a.count);

  return {
    windowDays: days,
    flagsTotal: flags.length,
    flagsOpen: flags.filter((f) => f.status === "OPEN").length,
    byTag,
    editNotes,
    captureByPhotographer,
  };
}
