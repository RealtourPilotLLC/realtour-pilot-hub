/** R02 — the exact counts the comments in projectStatus.ts quote. READ-ONLY. */
import { prisma } from "../../../src/lib/prisma";

async function main() {
  const [stamped, withBy, withVia, outputs, jobsWithOutputs] = await Promise.all([
    prisma.project.count({ where: { deliveredAt: { not: null } } }),
    prisma.project.count({ where: { deliveredAt: { not: null }, deliveredBy: { not: null } } }),
    prisma.project.count({ where: { deliveredAt: { not: null }, deliveredVia: { not: null } } }),
    prisma.deliverableOutput.count(),
    prisma.deliverableOutput.findMany({ select: { projectId: true }, distinct: ["projectId"] }),
  ]);
  console.log(`Project.deliveredAt set:            ${stamped}`);
  console.log(`  …with a deliveredBy:              ${withBy}`);
  console.log(`  …with a deliveredVia:             ${withVia}`);
  console.log(`DeliverableOutput rows:             ${outputs}`);
  console.log(`  …across projects:                 ${jobsWithOutputs.length}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
