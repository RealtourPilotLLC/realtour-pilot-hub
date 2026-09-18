import { prisma } from "@/lib/prisma";

async function main() {
  const waived = await prisma.deliverable.findMany({
    where: { waivedAt: { not: null } },
    select: { id: true, projectId: true, type: true, label: true, quantity: true, waivedAt: true, removedFromOrderAt: true, project: { select: { title: true, status: true, videosOwedOverride: true } } },
  });
  console.log("waived deliverables:", waived.length);
  for (const w of waived) console.log(`  ${w.type} q=${w.quantity} "${w.label}" — ${w.project?.title} [${w.project?.status}] override=${w.project?.videosOwedOverride ?? "-"} removed=${!!w.removedFromOrderAt}`);
  const waivedVideo = waived.filter((w) => w.type === "VIDEO" || w.type === "SOCIAL_REEL");
  console.log("waived VIDEO/SOCIAL_REEL rows:", waivedVideo.length);

  const subs = await prisma.reviewSubmission.count();
  const nullDel = await prisma.reviewSubmission.count({ where: { deliverableId: null } });
  console.log(`reviewSubmissions: ${subs}, with deliverableId null: ${nullDel}`);
  const nulls = await prisma.reviewSubmission.findMany({ where: { deliverableId: null }, select: { id: true, projectId: true, assetPath: true, slot: true, status: true, kind: true } });
  for (const n of nulls) console.log(`  ${n.id} kind=${n.kind} slot=${n.slot} status=${n.status} path=${n.assetPath}`);

  const matlack = await prisma.project.findFirst({ where: { title: { contains: "893 S Matlack" } }, select: { id: true, title: true, status: true, videosOwedOverride: true, videosFilmed: true, packageName: true, deliverables: { select: { id: true, type: true, label: true, quantity: true, removedFromOrderAt: true, waivedAt: true, createdAt: true }, orderBy: { createdAt: "asc" } } } });
  console.log("\n893 S Matlack:", JSON.stringify(matlack, null, 1));

  console.log("\nDeliverableOutput rows now:", await prisma.deliverableOutput.count());
  console.log("projects non-cancelled:", await prisma.project.count({ where: { status: { notIn: ["CANCELLED"] } } }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
