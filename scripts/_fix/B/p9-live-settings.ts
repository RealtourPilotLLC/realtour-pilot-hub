// READ ONLY. MINOR 4 — does making premiumVideoHours a floor move any real
// date TODAY? Only if the office has already typed something above 72.
import { turnaroundRules } from "../../../src/lib/settings";
import { PrismaClient } from "@prisma/client";
import { premiumDueFrom, premiumBusinessDays, businessDayEndHour, PREMIUM_FLOOR_HOURS } from "../../../src/lib/turnaround";
import { endOfBusinessDaysET, etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const r = await turnaroundRules();
  console.log(`live AppSetting "turnarounds": premiumVideoHours=${r.premiumVideoHours} standardVideoHours=${r.standardVideoHours} monthlyBusinessDays=${r.monthlyBusinessDays}`);
  console.log(`premium business days in force: ${premiumBusinessDays(r)}, day closes at ${businessDayEndHour(r)}:00 ET`);
  console.log(`default floor constant: ${PREMIUM_FLOOR_HOURS}h`);

  // Every anchor that could date a premium reel: the shoot date of every job.
  const rows = await prisma.project.findMany({ where: { shootDate: { not: null } }, select: { id: true, title: true, shootDate: true } });
  let moved = 0;
  const samples: string[] = [];
  for (const p of rows) {
    // What the code did before this change: business days only, no floor.
    const before = endOfBusinessDaysET(p.shootDate!, premiumBusinessDays(r), businessDayEndHour(r));
    const after = premiumDueFrom(p.shootDate!, r);
    if (before.getTime() !== after.getTime()) {
      moved++;
      if (samples.length < 6) samples.push(`   ${p.title.slice(0, 40).padEnd(42)} ${etDateTime(before)} -> ${etDateTime(after)}`);
    }
  }
  console.log(`\nshoot anchors in production: ${rows.length}`);
  console.log(`premium deadlines that move under the live settings: ${moved}`);
  console.log(samples.join("\n"));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
