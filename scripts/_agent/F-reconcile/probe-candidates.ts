// READ-ONLY probe. Gathers the candidate population and one LIVE Aryeo read
// each, dumps to JSON so the classification can be iterated without paying for
// the API again. Writes nothing to the database.
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { getListingMedia } from "@/lib/integrations/aryeo";
import { writeFileSync } from "fs";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/tmp/f-candidates.json";

async function main() {
  const ps = await prisma.project.findMany({
    where: { status: { notIn: ["CANCELLED"] } },
    select: {
      id: true, title: true, status: true, source: true,
      deliveredAt: true, deliveredBy: true, deliveredVia: true,
      deliveryExceptionAt: true, deliveryExceptionNote: true,
      aryeoListingId: true, aryeoOrderId: true, aryeoMissingAt: true,
      statusEvidence: true, evidenceSucceededAt: true, evidenceError: true,
      revisionRequestedAt: true, updatedAt: true,
      deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true, label: true, quantity: true, status: true, waivedAt: true } },
      reviewSubmissions: { select: { id: true, round: true, slot: true, status: true, fileName: true, sentToClientAt: true, completedAt: true, createdAt: true } },
    },
    take: 3000,
  });
  console.log(`scanned ${ps.length} non-cancelled projects`);

  const cands = ps.filter((p) => {
    if (p.deliveryExceptionAt) return true;
    const e = parseEvidence(p.statusEvidence);
    if (!e || !e.aryeo || !e.dropbox) return false;
    const v = e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video");
    const ph = e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos");
    return v || ph;
  });
  console.log(`candidates: ${cands.length}`);

  const out: unknown[] = [];
  for (const p of cands) {
    const m = p.aryeoListingId ? await getListingMedia(p.aryeoListingId) : null;
    const e = parseEvidence(p.statusEvidence);
    out.push({
      id: p.id, title: p.title, status: p.status, source: p.source,
      deliveredAt: p.deliveredAt, deliveredBy: p.deliveredBy, deliveredVia: p.deliveredVia,
      exceptionAt: p.deliveryExceptionAt, exceptionNote: p.deliveryExceptionNote,
      listingId: p.aryeoListingId, orderId: p.aryeoOrderId, aryeoMissingAt: p.aryeoMissingAt,
      evidenceSucceededAt: p.evidenceSucceededAt, evidenceError: p.evidenceError,
      expected: e?.expected ?? [], missing: e?.missing ?? [], awaitingSend: e?.awaitingSend ?? [],
      cachedAryeo: e?.aryeo ?? null, dropbox: e?.dropbox ?? null, reason: e?.reason ?? "",
      live: m ? { deliveryStatus: m.deliveryStatus, photos: m.photoCount, videos: m.videoCount, floorPlans: m.floorPlanCount, videoTitles: m.videos.map((v) => v.title) } : null,
      liveReadable: !!m,
      deliverables: p.deliverables,
      subs: p.reviewSubmissions,
    });
    const tag = m ? `vid=${m.videoCount} img=${m.photoCount} fp=${m.floorPlanCount} ${m.deliveryStatus ?? "?"}` : "UNREADABLE";
    console.log(`  ${p.status.padEnd(10)} ${p.title.slice(0, 40).padEnd(40)} LIVE ${tag}`);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\n-> ${OUT}`);
  console.log(`DeliverableOutput rows: ${await prisma.deliverableOutput.count()}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
