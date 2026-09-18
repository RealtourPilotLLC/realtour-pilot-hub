// READ ONLY. The row the reviewer demonstrated SERIOUS 1 against, plus the
// population that shares its shape.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const say = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "—";

async function main() {
  const p = await prisma.project.findUnique({
    where: { id: "cmt21itvn00tijs04fsnpfi40" },
    select: {
      id: true, title: true, status: true, shootDate: true, createdAt: true, deliveredAt: true,
      deliveryDue: true, promisedDueAt: true, promisedTierKey: true, promisedTargetAt: true,
      packageName: true, dueOverrideAt: true,
      deliverables: { select: { type: true, label: true, status: true } },
      appointments: { select: { startAt: true, status: true } },
    },
  });
  console.log("== 80 W Lancaster Ave Floor 2 ==");
  console.log(JSON.stringify({
    title: p?.title, status: p?.status,
    shootDate: p?.shootDate?.toISOString() ?? null,
    createdAt: p?.createdAt?.toISOString(),
    deliveredAt: p?.deliveredAt?.toISOString() ?? null,
    deliveryDue: p?.deliveryDue?.toISOString() ?? null,
    promisedDueAt: p?.promisedDueAt?.toISOString() ?? null,
    promisedDueAtET: say(p?.promisedDueAt),
    promisedTierKey: p?.promisedTierKey,
    packageName: p?.packageName,
    dueOverrideAt: p?.dueOverrideAt?.toISOString() ?? null,
    appointments: p?.appointments.map((a) => `${a.status}@${a.startAt?.toISOString() ?? "null"}`),
    deliverables: p?.deliverables.map((d) => `${d.type}/${d.label}/${d.status}`),
  }, null, 2));

  // How many pinned, live jobs have NO shoot date at all — the shape where the
  // current guard throws the pin away on every render.
  const live = await prisma.project.findMany({
    where: { promisedDueAt: { not: null }, deliveredAt: null, status: { notIn: ["CANCELLED", "DELIVERED"] } },
    select: {
      id: true, title: true, status: true, shootDate: true, promisedDueAt: true, deliveryDue: true,
      packageName: true, deliverables: { select: { type: true, label: true } },
    },
  });
  const noShoot = live.filter((r) => !r.shootDate);
  const shootAfter = live.filter((r) => r.shootDate && r.promisedDueAt! <= r.shootDate);
  console.log(`\nlive pinned jobs: ${live.length}`);
  console.log(`  no shoot date at all      : ${noShoot.length}  <- pin discarded today by clockStart=now`);
  console.log(`  shoot date >= the pin     : ${shootAfter.length}  <- the genuine rebook shape`);
  for (const r of noShoot.slice(0, 12)) {
    console.log(`   · ${r.title.slice(0, 40).padEnd(42)} ${r.status.padEnd(9)} pin ${say(r.promisedDueAt)}  due ${say(r.deliveryDue)}  pkg=${r.packageName ?? "—"}`);
  }
  for (const r of shootAfter.slice(0, 12)) {
    console.log(`   R ${r.title.slice(0, 40).padEnd(42)} ${r.status.padEnd(9)} pin ${say(r.promisedDueAt)}  shoot ${say(r.shootDate)}  pkg=${r.packageName ?? "—"}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
