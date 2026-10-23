export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan, with Kyle's screenshot of Delivering:
// 30 Caedman Dr and 850 Springbank Ln read "Late" and "Delivery mismatch",
// "but they're sent". Kyle delivered both in Aryeo at 4:18 and 4:20 PM; the
// only mismatch was "a floor plan was ordered but is not on the listing"
// (CubiCasa's plan comes on its own), which no longer holds the photos'
// delivery (photoDelivery/delivery.ts, deployed first). This re-runs the hub's
// own check (verifyDelivery) on both, so they move to Delivered with the real
// delivery time. Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
import { installNextStubs } from "../_drill/_harness";
installNextStubs();
const STREETS = ["30 Caedman Dr", "850 Springbank Ln"];
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const apply = process.argv.includes("--apply");
  for (const st of STREETS) {
    const p = await prisma.project.findFirstOrThrow({ where: { title: { startsWith: st } }, select: { id: true } });
    const j = await prisma.photoJob.findUniqueOrThrow({ where: { projectId: p.id }, select: { id: true, stage: true, deliveredAt: true } });
    console.log(`${st}: ${j.stage} deliveredAt=${j.deliveredAt?.toISOString() ?? "-"}`);
    if (!apply || j.stage !== "DELIVERY_MISMATCH") continue;
    const { verifyDelivery } = await import("../../src/lib/photoDelivery/delivery");
    const r = await verifyDelivery(j.id, "Hub repair (Oct 23: floor plan comes on its own)");
    const after = await prisma.photoJob.findUniqueOrThrow({ where: { id: j.id }, select: { stage: true, deliveredAt: true } });
    console.log(`   → ${after.stage} deliveredAt=${after.deliveredAt?.toISOString() ?? "-"} · ${r.message}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
