// READ-ONLY verification of the materialisation (acceptance 2, 3 and 5).
import { prisma } from "@/lib/prisma";
import { outputsForProject } from "@/lib/deliverableOutputs";

async function main() {
  const total = await prisma.deliverableOutput.count();
  const projects = (await prisma.deliverableOutput.groupBy({ by: ["projectId"] })).length;
  console.log(`DeliverableOutput rows: ${total} across ${projects} jobs`);
  console.log(`  retired: ${await prisma.deliverableOutput.count({ where: { removedFromOrderAt: { not: null } } })}`);
  console.log(`  waived:  ${await prisma.deliverableOutput.count({ where: { waivedAt: { not: null } } })}`);
  console.log(`  with a current version: ${await prisma.deliverableOutput.count({ where: { currentSubmissionId: { not: null } } })}`);
  console.log(`  approved:               ${await prisma.deliverableOutput.count({ where: { approvedAt: { not: null } } })}`);
  console.log(`  delivered to the client:${await prisma.deliverableOutput.count({ where: { deliveredAt: { not: null } } })}`);
  console.log(
    `review rounds: ${await prisma.reviewSubmission.count()} — linked ${await prisma.reviewSubmission.count({ where: { outputId: { not: null } } })}, ` +
      `left null on purpose (no deliverable) ${await prisma.reviewSubmission.count({ where: { deliverableId: null } })}`,
  );

  // ACCEPTANCE 2 — 893 S Matlack St: VIDEOx16, sixteen rows.
  const m = await prisma.project.findFirst({ where: { title: { contains: "893 S Matlack" } }, select: { id: true, title: true } });
  if (m) {
    const rows = await outputsForProject(m.id);
    console.log(`\n${m.title}: ${rows.filter((r) => r.state !== "removed" && r.state !== "waived").length} owed video rows (${rows.length} rows in all)`);
    for (const r of rows.slice(0, 20)) console.log(`  ${r.index}/${r.total} ${r.label} — ${r.detail}${r.ownerName ? ` · ${r.ownerName}` : ""}`);
  }

  // ACCEPTANCE 5 — approved and not sent is still owed work.
  const unsent = await prisma.deliverableOutput.findMany({
    where: { approvedAt: { not: null }, deliveredAt: null, removedFromOrderAt: null, waivedAt: null },
    select: { projectId: true, slot: true, category: true, approvedAt: true, deliverable: { select: { label: true } } },
  });
  console.log(`\napproved-but-not-sent videos: ${unsent.length}`);
  for (const u of unsent) {
    const p = await prisma.project.findUnique({ where: { id: u.projectId }, select: { title: true, status: true } });
    console.log(`  ${p?.title} [${p?.status}] slot ${u.slot} — approved ${u.approvedAt?.toISOString().slice(0, 16)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
