// READ-ONLY. 358 N Church St — is its approved cut a finished video the client
// cannot see, or a cut that was never rendered?
import { prisma } from "@/lib/prisma";

async function main() {
  const p = await prisma.project.findFirst({
    where: { title: { contains: "358 N Church" } },
    select: {
      id: true, title: true, status: true, deliveredAt: true, statusEvidence: true,
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, productTitle: true, quantity: true, status: true } },
      reviewSubmissions: {
        select: { id: true, round: true, slot: true, status: true, fileName: true, assetPath: true, sizeBytes: true, sentToClientAt: true, decidedAt: true, createdAt: true,
          topazJob: { select: { state: true, finalPath: true, savedAt: true, deliveredAt: true, error: true } } },
        orderBy: { createdAt: "asc" },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 8, select: { createdAt: true, body: true } },
    },
  });
  if (!p) { console.log("not found"); return; }
  console.log(`${p.title} [${p.status}] delivered=${p.deliveredAt?.toISOString().slice(0, 10) ?? "none"}`);
  for (const d of p.deliverables) console.log(`   ordered ${d.type.padEnd(14)} q=${d.quantity ?? 1} ${d.status} "${(d.productTitle ?? "").slice(0, 48)}"`);
  for (const s of p.reviewSubmissions) {
    console.log(`   cut r${s.round}/s${s.slot} ${s.status.padEnd(18)} sent=${s.sentToClientAt ? s.sentToClientAt.toISOString().slice(0, 10) : "no"} bytes=${s.sizeBytes ?? "?"} file=${String(s.fileName ?? "").slice(0, 44)}`);
    console.log(`        topaz=${s.topazJob ? `${s.topazJob.state} final=${s.topazJob.finalPath ? "yes" : "no"} saved=${s.topazJob.savedAt?.toISOString().slice(0, 10) ?? "-"} delivered=${s.topazJob.deliveredAt?.toISOString().slice(0, 10) ?? "-"}` : "none"}`);
  }
  console.log(`   evidence: ${String(p.statusEvidence ?? "").slice(0, 400)}`);
  for (const a of p.activities) console.log(`   ${a.createdAt.toISOString().slice(0, 16)} ${a.body.replace(/\s+/g, " ").slice(0, 110)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
