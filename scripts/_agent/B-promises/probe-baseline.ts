// READ-ONLY. Baseline for the promise pin: what the office's turnaround
// settings actually say, how many projects carry a due date, and the on-time
// percentage the owner dial and the bonus read today.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const setting = await prisma.appSetting.findUnique({ where: { key: "turnarounds" } });
  console.log("AppSetting turnarounds:", setting ? setting.value : "(absent - defaults in force)");

  const total = await prisma.project.count();
  const withDue = await prisma.project.count({ where: { deliveryDue: { not: null } } });
  const pinned = await prisma.project.count({ where: { promisedDueAt: { not: null } } });
  const delivered = await prisma.project.count({ where: { deliveredAt: { not: null } } });
  console.log({ total, withDue, pinned, delivered });

  const judged = await prisma.project.findMany({
    where: { deliveredAt: { not: null }, deliveryDue: { not: null }, status: { not: "CANCELLED" } },
    select: { id: true, title: true, deliveredAt: true, deliveryDue: true, shootDate: true, promisedDueAt: true },
  });
  const onTime = judged.filter((p) => p.deliveredAt! <= p.deliveryDue!).length;
  console.log(`ALL-TIME on-time: ${onTime}/${judged.length} = ${((onTime / judged.length) * 100).toFixed(2)}%`);

  // The bonus/owner-dial reading (queries.ts adds the "delivered after the shoot" guard).
  const q = judged.filter((p) => !p.shootDate || p.deliveredAt! > p.shootDate!);
  const qOn = q.filter((p) => p.deliveredAt! <= p.deliveryDue!).length;
  console.log(`queries.ts basis: ${qOn}/${q.length} = ${((qOn / q.length) * 100).toFixed(2)}%`);

  // How many delivered jobs carry a premium video row (the 222 the reviewer measured).
  const premiumRe = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;
  const rows = await prisma.project.findMany({
    where: { deliveredAt: { not: null }, deliveryDue: { not: null }, status: { not: "CANCELLED" } },
    select: {
      id: true,
      title: true,
      shootDate: true,
      deliveredAt: true,
      deliveryDue: true,
      deliverables: { select: { type: true, label: true } },
    },
  });
  const premium = rows.filter((p) =>
    p.deliverables.some(
      (d) =>
        (d.type === "VIDEO" || d.type === "SOCIAL_REEL") &&
        d.label &&
        premiumRe.test(d.label) &&
        !/\bstandard\b/i.test(d.label),
    ),
  );
  const pOn = premium.filter((p) => p.deliveredAt! <= p.deliveryDue!).length;
  console.log(`premium delivered jobs: ${premium.length}, on-time ${pOn} (${premium.length - pOn} late)`);
  await prisma.$disconnect();
}
main();
