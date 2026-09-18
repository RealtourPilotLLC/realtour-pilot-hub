/**
 * READ-ONLY, production. DEFECT 4's population: how real is "a job with a
 * listing id and no usable statusEvidence"? The selection rule used to read
 * `expected` off that blob, so on every one of these it had nothing to examine.
 */
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { lanesExpectedFor } from "@/lib/deliveryExceptions";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

async function main() {
  const total = await prisma.project.count({ where: { status: { not: "CANCELLED" } } });
  const noBlob = await prisma.project.count({ where: { status: { not: "CANCELLED" }, statusEvidence: null } });
  const noBlobWithListing = await prisma.project.count({
    where: { status: { not: "CANCELLED" }, statusEvidence: null, aryeoListingId: { not: null } },
  });
  console.log(`non-cancelled projects:                                  ${total}`);
  console.log(`  ...carrying NO statusEvidence blob:                    ${noBlob}`);
  console.log(`  ...of those, with an Aryeo listing id to read:         ${noBlobWithListing}`);

  // Blob-less, but the ORDER still knows what was sold.
  const sample = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" }, statusEvidence: null, aryeoListingId: { not: null } },
    select: {
      id: true, title: true, status: true,
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
    },
    take: 8,
    orderBy: { createdAt: "desc" },
  });
  let withLanes = 0;
  console.log(`\n  the old rule examined NO lane on any of them. What the ORDER says (8 most recent):`);
  for (const p of sample) {
    const lanes = lanesExpectedFor(p.deliverables, parseEvidence(null));
    if (lanes.length) withLanes++;
    console.log(`     ${p.title.split(",")[0].padEnd(32)} ${p.status.padEnd(10)} order says: [${lanes.join(",") || "nothing this pass reads"}]`);
  }
  console.log(`\n  ${withLanes} of ${sample.length} would now be examined instead of read-and-ignored.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
