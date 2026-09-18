/** READ-ONLY. What the three flagged rows actually look like in production. */
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";

async function main() {
  const flagged = await prisma.project.findMany({
    where: { deliveryExceptionAt: { not: null } },
    select: {
      id: true, title: true, status: true, deliveredAt: true, aryeoListingId: true, aryeoMissingAt: true,
      deliveryExceptionAt: true, deliveryExceptionNote: true, statusEvidence: true,
      deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true, label: true, productTitle: true, quantity: true, waivedAt: true } },
      reviewSubmissions: { select: { id: true, deliverableId: true, slot: true, round: true, status: true, sentToClientAt: true, withdrawnAt: true, outputId: true } },
    },
    orderBy: { deliveryExceptionAt: "desc" },
  });
  for (const p of flagged) {
    const e = parseEvidence(p.statusEvidence);
    const outputs = await prisma.deliverableOutput.findMany({
      where: { projectId: p.id },
      select: { id: true, deliverableId: true, slot: true, category: true, deliveredAt: true, waivedAt: true, removedFromOrderAt: true, approvedAt: true },
      orderBy: { slot: "asc" },
    });
    console.log("=".repeat(90));
    console.log(`${p.title}`);
    console.log(`  id=${p.id} status=${p.status} deliveredAt=${p.deliveredAt?.toISOString() ?? "-"} listing=${p.aryeoListingId ?? "-"} missing=${p.aryeoMissingAt?.toISOString() ?? "-"}`);
    console.log(`  flaggedAt=${p.deliveryExceptionAt?.toISOString()}`);
    console.log(`  NOTE: ${p.deliveryExceptionNote}`);
    console.log(`  evidence.expected=${JSON.stringify(e?.expected)} awaitingSend=${JSON.stringify(e?.awaitingSend)}`);
    console.log(`  evidence.aryeo=${JSON.stringify(e?.aryeo)}`);
    console.log(`  evidence.dropbox=${JSON.stringify(e?.dropbox)}`);
    console.log(`  evidence.checkedAt=${e?.checkedAt}`);
    console.log(`  deliverables:`);
    for (const d of p.deliverables) console.log(`     ${d.id} ${d.type} q=${d.quantity} waived=${d.waivedAt ? "Y" : "n"} "${d.productTitle ?? d.label ?? ""}"`);
    console.log(`  reviewSubmissions (${p.reviewSubmissions.length}):`);
    for (const r of p.reviewSubmissions) console.log(`     ${r.id} del=${r.deliverableId ?? "-"} slot=${r.slot} round=${r.round} ${r.status} sent=${r.sentToClientAt?.toISOString() ?? "-"} withdrawn=${r.withdrawnAt ? "Y" : "n"} outputId=${r.outputId ?? "-"}`);
    console.log(`  outputs (${outputs.length}):`);
    for (const o of outputs) console.log(`     ${o.id} del=${o.deliverableId} slot=${o.slot} cat=${o.category} approved=${o.approvedAt?.toISOString() ?? "-"} delivered=${o.deliveredAt?.toISOString() ?? "-"} waived=${o.waivedAt ? "Y" : "n"} removed=${o.removedFromOrderAt ? "Y" : "n"}`);
  }
  console.log(`\nflagged rows: ${flagged.length}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
