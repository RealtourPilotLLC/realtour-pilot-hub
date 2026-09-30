import "server-only";
import { prisma } from "@/lib/prisma";
import { parseChecklist } from "@/lib/checklist";
import { countQcMisses } from "@/lib/tasks";
import { isSyntheticClientRow } from "@/lib/testClients";

// The owner's QC quality dial — reads the QcRecord log (one row per completed QC
// pass, written from both completion paths in src/lib/tasks.ts + actions.ts).
//
// The stored `missCount` is a legacy name for optional boxes left unticked.
// Neither this count nor a later revision proves a quality defect or fault.
// The Review Room labels them as recording gaps; verified revision issues
// carry responsibility separately. This function does no auth itself.

export type QcMissBucket = { label: string; count: number };
export type QcStats = {
  windowDays: number;
  qcPasses: number; // completed QC passes in the window
  avgMisses: number; // legacy name: mean optional items not recorded
  reopenedRate: number; // % later reopened, with cause not established
  byMiss: QcMissBucket[]; // legacy name: optional items not recorded, desc
};

// Aggregate QC quality over the last `days` (default 30). Pure read; safe to call
// from any server context. Never throws on bad rows — a corrupt itemsChecked JSON
// just contributes nothing.
export async function getQcStats(days = 30, opts: { includeTest?: boolean } = {}): Promise<QcStats> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const readRecords = await prisma.qcRecord.findMany({
    where: { completedAt: { gte: since } },
    select: { itemsChecked: true, missCount: true, reopenedByRevisionAt: true, project: { select: { client: { select: { id: true, name: true } } } } },
  });
  const records = opts.includeTest === false ? readRecords.filter((r) => !isSyntheticClientRow(r.project.client)) : readRecords;

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

export async function getFixPatterns(days = 60, opts: { includeTest?: boolean } = {}): Promise<FixPatterns> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const [readFlags, readEditNotes, readCaptureNotes] = await Promise.all([
    prisma.imageFlag.findMany({
      where: { createdAt: { gte: since } },
      select: { tags: true, status: true, project: { select: { client: { select: { id: true, name: true } } } } },
    }),
    prisma.mediaNote.findMany({ where: { lane: "EDIT", parentId: null, createdAt: { gte: since } }, select: { project: { select: { client: { select: { id: true, name: true } } } } } }),
    prisma.mediaNote.findMany({
      where: { lane: "PHOTOGRAPHER", parentId: null, photographerId: { not: null }, createdAt: { gte: since } },
      select: { photographerId: true, project: { select: { client: { select: { id: true, name: true } } } } },
    }),
  ]);
  const visible = (row: { project: { client: { id: string; name: string } } }) => opts.includeTest !== false || !isSyntheticClientRow(row.project.client);
  const flags = readFlags.filter(visible);
  const editNotes = readEditNotes.filter(visible).length;
  const captureNotes = readCaptureNotes.filter(visible);

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

  const memberIds = [...new Set(captureNotes.map((r) => r.photographerId).filter((id): id is string => !!id))];
  const members = memberIds.length
    ? await prisma.teamMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const captureCounts = new Map<string, number>();
  for (const r of captureNotes) if (r.photographerId) captureCounts.set(r.photographerId, (captureCounts.get(r.photographerId) ?? 0) + 1);
  const captureByPhotographer = [...captureCounts.entries()]
    .map(([id, count]) => ({ name: nameOf.get(id) ?? "Unknown", count }))
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
