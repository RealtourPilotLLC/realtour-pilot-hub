// READ-ONLY. What the pin is PROTECTING: how many delivered jobs would change
// verdict if the on-time readers recomputed the deadline under the new
// premium rule instead of reading the frozen promise.
import { PrismaClient } from "@prisma/client";
import { standardDeliveryDue, slaTierOf } from "../../../src/lib/tasks";
import { isMonthlyContentJob } from "../../../src/lib/pipeline";
import { turnaroundRules } from "../../../src/lib/settings";

const prisma = new PrismaClient();

async function main() {
  await turnaroundRules(); // settings are read by the engine through its own path
  const rows = await prisma.project.findMany({
    where: { deliveredAt: { not: null }, deliveryDue: { not: null }, status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, shootDate: true, deliveredAt: true, deliveryDue: true,
      promisedDueAt: true, promisedTierKey: true, packageName: true, tierOverride: true,
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, productTitle: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true, isCanceled: true } },
    },
  });

  let judged = 0;
  let flippedToOnTime = 0;
  let flippedToLate = 0;
  let premiumJudged = 0;
  let premiumFlipped = 0;
  for (const p of rows) {
    if (!p.shootDate || !p.deliveredAt || !p.deliveryDue) continue;
    judged++;
    const recomputed = standardDeliveryDue(
      p.shootDate,
      p.deliverables,
      isMonthlyContentJob(p.deliverables, p.packageName),
      p.orderItems,
      { tier: slaTierOf(p) },
    );
    const wasOnTime = p.deliveredAt <= p.deliveryDue;
    const wouldBeOnTime = p.deliveredAt <= recomputed;
    const premium = p.promisedTierKey === "premium_reel";
    if (premium) premiumJudged++;
    if (wasOnTime !== wouldBeOnTime) {
      if (wouldBeOnTime) flippedToOnTime++;
      else flippedToLate++;
      if (premium) premiumFlipped++;
    }
  }
  console.log(`delivered rows with a due date and a shoot: ${judged}`);
  console.log(`  would flip late -> on time if history were recomputed: ${flippedToOnTime}`);
  console.log(`  would flip on time -> late:                            ${flippedToLate}`);
  console.log(`  of those, jobs pinned as premium_reel: ${premiumFlipped} (premium rows judged: ${premiumJudged})`);
  console.log("The pin is why none of this reaches the on-time dial or the bonus.");
  await prisma.$disconnect();
}
main();
