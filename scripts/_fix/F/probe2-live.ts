/** READ-ONLY. Live Aryeo listing read for the three flagged jobs, next to the cached blob. */
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { getListingMedia } from "@/lib/integrations/aryeo";

async function main() {
  const rows = await prisma.project.findMany({
    where: { deliveryExceptionAt: { not: null } },
    select: { id: true, title: true, status: true, deliveredAt: true, aryeoListingId: true, statusEvidence: true },
    orderBy: { deliveryExceptionAt: "desc" },
  });
  for (const p of rows) {
    const e = parseEvidence(p.statusEvidence);
    const m = p.aryeoListingId ? await getListingMedia(p.aryeoListingId) : null;
    console.log("-".repeat(80));
    console.log(`${p.title.split(",")[0]}  (${p.status}, deliveredAt ${p.deliveredAt?.toISOString().slice(0, 10) ?? "-"})`);
    console.log(`  CACHED aryeo: ${JSON.stringify(e?.aryeo)}`);
    console.log(
      `  LIVE   aryeo: ${m ? `photos ${m.photoCount} · videos ${m.videoCount} · floorPlans ${m.floorPlanCount} · delivery ${m.deliveryStatus}` : "READ FAILED / no listing id"}`,
    );
    if (m?.videos.length) console.log(`  live video titles: ${m.videos.map((v) => v.title ?? "untitled").join(" | ")}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
