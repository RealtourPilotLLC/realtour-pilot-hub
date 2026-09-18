// READ ONLY. SERIOUS 1 through the REAL function: outstandingPromise() on the
// three live pinned jobs that have no shoot date, plus tomorrow's answer for
// the same rows. If the pin is honoured the date is fixed; if it is discarded
// the date walks forward one day per day.
import { PrismaClient } from "@prisma/client";
import { outstandingPromise } from "../../../src/lib/deliveryBoard";
import { turnaroundRules } from "../../../src/lib/settings";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { promisedDueAt: { not: null }, deliveredAt: null, shootDate: null, status: { notIn: ["CANCELLED", "DELIVERED"] } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, revisionRequestedAt: true,
      deliveryDue: true, dueOverrideAt: true, tierOverride: true, promisedDueAt: true, promisedReason: true,
      packageName: true, statusEvidence: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { select: { type: true, status: true, uploadedAt: true, label: true } },
      appointments: { select: { startAt: true, status: true } },
    },
  });
  const turnarounds = await turnaroundRules();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  console.log(`live pinned jobs with no shoot date: ${rows.length}\n`);
  for (const p of rows) {
    const a = outstandingPromise(p, { now, turnarounds });
    const b = outstandingPromise(p, { now: tomorrow, turnarounds });
    console.log(`${p.title.slice(0, 44)}`);
    console.log(`   pin            ${etDateTime(p.promisedDueAt!)}`);
    console.log(`   board today    ${a.at ? etDateTime(a.at) : "—"}   pinned=${!!a.pinned} tier=${a.tierLabel ?? "—"}`);
    console.log(`   board tomorrow ${b.at ? etDateTime(b.at) : "—"}   pinned=${!!b.pinned} tier=${b.tierLabel ?? "—"}`);
    console.log(`   DRIFTS         ${a.at && b.at && a.at.getTime() !== b.at.getTime() ? "YES — the date walks with the calendar" : "no"}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
