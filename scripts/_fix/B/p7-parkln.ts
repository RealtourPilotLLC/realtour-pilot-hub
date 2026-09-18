// READ ONLY. The one production row in the rebook class, through the real
// readers — so "they now agree" is a measurement and not an assumption.
import { PrismaClient } from "@prisma/client";
import { effectiveDue } from "../../../src/lib/editOverrides";
import { pinnedPromise } from "../../../src/lib/turnaround";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();
const say = (d: Date | null | undefined) => (d ? etDateTime(d) : "—");

async function main() {
  const rows = await prisma.project.findMany({
    where: { promisedDueAt: { not: null }, shootDate: { not: null } },
    select: { title: true, status: true, shootDate: true, deliveredAt: true, deliveryDue: true, promisedDueAt: true, dueOverrideAt: true },
  });
  for (const p of rows.filter((r) => r.promisedDueAt! <= r.shootDate!)) {
    console.log(p.title);
    console.log(`   shoot (rebooked to)        ${say(p.shootDate)}`);
    console.log(`   promisedDueAt (the pin)    ${say(p.promisedDueAt)}   <- quoted for the visit before`);
    console.log(`   deliveryDue (today's rules)${say(p.deliveryDue)}`);
    console.log(`   old effectiveDue           ${say(p.dueOverrideAt ?? p.promisedDueAt ?? p.deliveryDue)}`);
    console.log(`   new effectiveDue           ${say(effectiveDue(p, p.deliveryDue))}`);
    console.log(`   board / dial / bonus       ${say(p.dueOverrideAt ?? pinnedPromise(p) ?? p.deliveryDue)}`);
    console.log(`   delivered at               ${say(p.deliveredAt)}  (on time against the new reading: ${p.deliveredAt && effectiveDue(p, p.deliveryDue) ? p.deliveredAt <= effectiveDue(p, p.deliveryDue)! : "n/a"})`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
