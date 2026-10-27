import "server-only";
import { prisma } from "@/lib/prisma";
import { batchStamps, BULK_BATCH_SOURCE, type BatchVideo } from "@/lib/bulkBatchCore";

// ---------------------------------------------------------------------------
// STAMPING THE BATCH DATES (Oct 27 2026; the clock itself is bulkBatchCore).
// Every ACTIVE bulk plan's videos get their batch's due (promisedAt), aim
// (targetAt) and window start (promiseAnchorAt) on their own row, with
// promiseSource "bulk-batch". Recomputed on every run, because a session's
// videos arrive when the videographer submits the upload (Rick's second
// session owed 4 rows until it was filmed), and a video added or retired
// moves everything after it. A row another rule dated (a second shoot, an
// additional shoot) keeps its date and still counts in the order. Staff
// dates only: nothing here is shown to the client or sent to anyone.
// ---------------------------------------------------------------------------

export type BatchChange = {
  outputId: string;
  projectId: string;
  slot: number;
  index: number;
  batchNo: number;
  from: { promisedAt: Date | null; targetAt: Date | null; source: string | null };
  to: { promisedAt: Date; targetAt: Date; anchorAt: Date };
};
export type BatchStampResult = { plans: number; videos: number; changed: number; keptOtherRule: number; changes: BatchChange[] };

const same = (a: Date | null, b: Date) => !!a && a.getTime() === b.getTime();

/**
 * Stamp (or, with `dryRun`, only list) the batch dates of every ACTIVE bulk
 * plan, or of the one plan anchored on `monthId`.
 */
export async function stampBulkBatches(opts: { monthId?: string; dryRun?: boolean } = {}): Promise<BatchStampResult> {
  const out: BatchStampResult = { plans: 0, videos: 0, changed: 0, keptOtherRule: 0, changes: [] };
  const plans = await prisma.contentBulkPlan.findMany({
    where: { status: "ACTIVE", ...(opts.monthId ? { monthId: opts.monthId } : {}) },
    select: { id: true, monthId: true, startsOn: true },
  });
  if (!plans.length) return out;
  const { planShoots } = await import("@/lib/bulkPlan");
  for (const plan of plans) {
    const shoots = await planShoots(plan.monthId);
    if (!shoots.length) continue;
    const bySession = [...shoots].sort((a, b) => a.sessionNo - b.sessionNo);
    const firstShoot = bySession.find((s) => s.shootDateISO)?.shootDateISO ?? null;
    const startAt = firstShoot ? new Date(firstShoot) : plan.startsOn;
    if (!startAt) continue;
    out.plans++;
    const shootOf = new Map(shoots.map((s) => [s.projectId, s]));
    const rows = await prisma.deliverableOutput.findMany({
      where: {
        projectId: { in: shoots.map((s) => s.projectId) },
        waivedAt: null,
        removedFromOrderAt: null,
        deliverable: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null },
      },
      select: {
        id: true, projectId: true, slot: true, promisedAt: true, targetAt: true, promiseAnchorAt: true, promiseSource: true,
        deliverable: { select: { createdAt: true } },
      },
    });
    // One job can carry more than one video line; its lines are counted in the
    // order they were added, each line's videos by slot.
    const lines = new Map<string, number[]>();
    for (const r of rows) {
      const t = r.deliverable.createdAt.getTime();
      const l = lines.get(r.projectId) ?? [];
      if (!l.includes(t)) l.push(t);
      lines.set(r.projectId, l);
    }
    for (const l of lines.values()) l.sort((a, b) => a - b);
    const videos: BatchVideo[] = rows.map((r) => {
      const s = shootOf.get(r.projectId)!;
      return {
        key: r.id,
        sessionNo: s.sessionNo,
        slot: lines.get(r.projectId)!.indexOf(r.deliverable.createdAt.getTime()) * 1000 + r.slot,
        shootAt: s.shootDateISO ? new Date(s.shootDateISO) : null,
      };
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const st of batchStamps(videos, startAt)) {
      out.videos++;
      const r = byId.get(st.key)!;
      if (r.promiseSource && r.promiseSource !== BULK_BATCH_SOURCE) {
        out.keptOtherRule++;
        continue;
      }
      if (r.promiseSource === BULK_BATCH_SOURCE && same(r.promisedAt, st.dueAt) && same(r.targetAt, st.aimAt) && same(r.promiseAnchorAt, st.anchorAt)) continue;
      out.changed++;
      out.changes.push({
        outputId: r.id, projectId: r.projectId, slot: r.slot, index: st.index, batchNo: st.batchNo,
        from: { promisedAt: r.promisedAt, targetAt: r.targetAt, source: r.promiseSource },
        to: { promisedAt: st.dueAt, targetAt: st.aimAt, anchorAt: st.anchorAt },
      });
      if (!opts.dryRun) {
        await prisma.deliverableOutput.update({
          where: { id: r.id },
          data: { promisedAt: st.dueAt, targetAt: st.aimAt, promiseAnchorAt: st.anchorAt, promiseSource: BULK_BATCH_SOURCE },
        });
      }
    }
  }
  return out;
}
