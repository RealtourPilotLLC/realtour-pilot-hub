import "server-only";
import { prisma } from "@/lib/prisma";
import { deliverablesFromStoredItems, loadManualProductMap, orderedVideoCount } from "@/lib/integrations/aryeo";
import { isMonthlyContentJob } from "@/lib/pipeline";

// ---------------------------------------------------------------------------
// VIDEOS ORDERED vs VIDEOS SET UP (Oct 22 2026). Jordan: "Joe's appointment
// yesterday had two videos. A standard highlight reel, and a Premium reel ...
// make sure that doesn't happen again." 538 Onward Ave's order sold two reels
// and the hub set up one, silently: one editor slot, one due date, one box of
// instructions on the upload page. The order mapping now keeps every video
// product (aryeo.dedupeParsedDeliverables), and this is the alarm for whatever
// still slips past it: when the order's own lines (or the office's videos-owed
// number) say more videos than the job has set up, the job page and the Shoots
// board say "2 videos ordered, 1 set up" instead of showing one.
//
// "Set up" is counted the way the editor's cut slots are (reviewCuts.cutSlots):
// every live video row at its quantity, the office's number laid over it, a
// waived row still counted (the office already said it is not owed). Monthly
// content is left out: its batch size comes from the plan and the session,
// not the order line. So is a job whose work was merged into another job.
// ---------------------------------------------------------------------------

export type VideoSetupGap = {
  /** what the order (or the office's number) says the job owes */
  ordered: number;
  /** what the job has set up: its cut slots */
  setUp: number;
  /** "2 videos ordered, 1 set up" */
  words: string;
  /** the order's video products, for the job page ("Social Influencer, Standard Video Highlight Reel") */
  products: string[];
};

const videos = (n: number) => `${n} video${n === 1 ? "" : "s"}`;

/** The gap, or null when the job has every video it should (pure; load the product map first). */
export function videoSetupGapOf(input: {
  orderItems: { title: string; quantity?: number | null; isCanceled?: boolean | null }[];
  /** the job's live (not removed) VIDEO / SOCIAL_REEL rows, waived ones included */
  videoRows: { quantity?: number | null }[];
  videosOwedOverride: number | null;
  monthly: boolean;
  mergedAway?: boolean;
}): VideoSetupGap | null {
  if (input.monthly || input.mergedAway) return null;
  const parsed = deliverablesFromStoredItems(input.orderItems.filter((it) => !it.isCanceled));
  const fromOrder = orderedVideoCount(parsed);
  const override = input.videosOwedOverride && input.videosOwedOverride > 0 ? input.videosOwedOverride : null;
  const expected = override ?? fromOrder;
  if (!expected) return null;
  const rows = input.videoRows.length;
  const setUp = rows === 0 ? 0 : override ?? input.videoRows.reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
  if (setUp >= expected) return null;
  const products = [...new Set(parsed.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").map((d) => d.productTitle))];
  return { ordered: expected, setUp, words: `${videos(expected)} ${override ? "owed" : "ordered"}, ${setUp} set up`, products };
}

/** The gap for each of these jobs (one read for all of them). Never throws: a failed read is no alarm. */
export async function videoSetupGaps(projectIds: string[]): Promise<Map<string, VideoSetupGap>> {
  const out = new Map<string, VideoSetupGap>();
  if (projectIds.length === 0) return out;
  try {
    await loadManualProductMap();
    const [rows, merges] = await Promise.all([
      prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: {
          id: true, packageName: true, contentMonthId: true, videosOwedOverride: true,
          orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
          deliverables: {
            where: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
            select: { type: true, label: true, quantity: true },
          },
        },
      }),
      import("@/lib/projectMerge").then((m) => m.allMerges()).catch(() => []),
    ]);
    const donors = new Set(merges.filter((m) => !m.undoneAt).map((m) => m.fromId));
    for (const p of rows) {
      const gap = videoSetupGapOf({
        orderItems: p.orderItems,
        videoRows: p.deliverables,
        videosOwedOverride: p.videosOwedOverride,
        monthly: !!p.contentMonthId || isMonthlyContentJob(p.deliverables, p.packageName),
        mergedAway: donors.has(p.id),
      });
      if (gap) out.set(p.id, gap);
    }
  } catch (e) {
    console.warn("[video-setup] could not compare videos ordered with videos set up", (e as Error)?.message);
  }
  return out;
}

export async function videoSetupGapFor(projectId: string): Promise<VideoSetupGap | null> {
  return (await videoSetupGaps([projectId])).get(projectId) ?? null;
}
