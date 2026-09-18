// READ-ONLY. How many LIVE jobs would show a different date on a surface that
// does not yet load Project.promisedDueAt (the project page's Status check
// card, the editor queue cell, the office override dialog). Each of those is
// one line in a select in a file this pass does not own; this is the number
// that says how much it matters.
import { PrismaClient } from "@prisma/client";
import { outstandingPromise } from "../../../src/lib/deliveryBoard";
import { turnaroundRules } from "../../../src/lib/settings";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const rules = await turnaroundRules();
  const rows = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, revisionRequestedAt: true,
      dueOverrideAt: true, tierOverride: true, packageName: true, statusEvidence: true,
      promisedDueAt: true, promisedTierKey: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, status: true, uploadedAt: true, label: true } },
      appointments: { select: { startAt: true, status: true }, orderBy: { startAt: "asc" } },
    },
  });

  let differ = 0;
  const examples: string[] = [];
  for (const p of rows) {
    const pinned = outstandingPromise(p, { turnarounds: rules });
    const unpinned = outstandingPromise({ ...p, promisedDueAt: null }, { turnarounds: rules });
    const a = pinned.at?.getTime() ?? null;
    const b = unpinned.at?.getTime() ?? null;
    if (a !== b) {
      differ++;
      if (examples.length < 10) {
        examples.push(`  ${p.title.slice(0, 40).padEnd(42)} ${p.status.padEnd(9)} sold ${etDateTime(pinned.at!)} · today's rules ${etDateTime(unpinned.at!)}`);
      }
    }
  }
  console.log(`live jobs: ${rows.length}; jobs whose date depends on the pin: ${differ}`);
  console.log(examples.join("\n"));
  await prisma.$disconnect();
}
main();
