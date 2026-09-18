// READ ONLY. MINOR 5 — what the monthly window's move to 5pm ET actually did.
//
// OLD (tasks.ts addBusinessDays, retired Sep 18): step the anchor forward by
// 86.4m ms at a time, skip Sat/Sun by UTC weekday, keep the anchor's clock time.
// NEW (endOfBusinessDaysET): walk ET day keys, land at 5pm ET.
// turnaround.ts dueAtFor ALREADY closed the monthly window at 5pm ET before
// Sep 18 (etAt(etDayKey(end), 17)) — so this measures tasks.ts against the
// board it was disagreeing with.
import { PrismaClient } from "@prisma/client";
import { endOfBusinessDaysET, etDateTime } from "../../../src/lib/datetime";
import { isMonthlyContentJob } from "../../../src/lib/pipeline";

const prisma = new PrismaClient();

/** tasks.ts addBusinessDays, verbatim as it stood before Sep 18. */
function oldAddBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

async function main() {
  const rows = await prisma.project.findMany({
    select: {
      id: true, title: true, status: true, shootDate: true, createdAt: true, deliveredAt: true,
      packageName: true, deliverables: { select: { type: true, label: true } },
    },
  });
  const monthly = rows.filter((p) => isMonthlyContentJob(p.deliverables, p.packageName));
  let earlier = 0, later = 0, same = 0;
  let worstEarlierH = 0, worstLaterH = 0;
  let worstEarlierRow = "", worstLaterRow = "";
  const dayMoves: string[] = [];
  for (const p of monthly) {
    const anchor = p.shootDate ?? p.createdAt;
    const o = oldAddBusinessDays(anchor, 10);
    const n = endOfBusinessDaysET(anchor, 10, 17);
    const dh = (n.getTime() - o.getTime()) / 3_600_000;
    if (Math.abs(dh) < 1 / 60) same++;
    else if (dh < 0) {
      earlier++;
      if (-dh > worstEarlierH) { worstEarlierH = -dh; worstEarlierRow = p.title; }
    } else {
      later++;
      if (dh > worstLaterH) { worstLaterH = dh; worstLaterRow = p.title; }
    }
    // A move that crosses a DAY boundary is the one a human would notice.
    const od = o.toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const nd = n.toLocaleDateString("en-US", { timeZone: "America/New_York" });
    if (od !== nd && dayMoves.length < 12) {
      dayMoves.push(`   ${p.title.slice(0, 38).padEnd(40)} anchor ${etDateTime(anchor)}  old ${etDateTime(o)} -> new ${etDateTime(n)}`);
    }
  }
  console.log(`monthly-content projects: ${monthly.length}`);
  console.log(`  promise unchanged : ${same}`);
  console.log(`  promise EARLIER   : ${earlier}  (worst ${worstEarlierH.toFixed(1)}h — ${worstEarlierRow.slice(0, 40)})`);
  console.log(`  promise LATER     : ${later}  (worst ${worstLaterH.toFixed(1)}h — ${worstLaterRow.slice(0, 40)})`);
  console.log(`  rows whose DUE DAY changes at all: ${dayMoves.length >= 12 ? "12+" : dayMoves.length}`);
  console.log(dayMoves.join("\n"));

  // Of the ones that moved earlier, how many are LIVE (a tightened promise on
  // work still in flight is the only way this can bite anybody)?
  const live = monthly.filter((p) => !p.deliveredAt && !["CANCELLED", "DELIVERED"].includes(p.status));
  const liveEarlier = live.filter((p) => {
    const anchor = p.shootDate ?? p.createdAt;
    return endOfBusinessDaysET(anchor, 10, 17).getTime() < oldAddBusinessDays(anchor, 10).getTime() - 60_000;
  });
  console.log(`\nlive monthly jobs: ${live.length}; of those the new rule dates EARLIER: ${liveEarlier.length}`);
  for (const p of liveEarlier.slice(0, 10)) {
    const anchor = p.shootDate ?? p.createdAt;
    console.log(`   ${p.title.slice(0, 38).padEnd(40)} old ${etDateTime(oldAddBusinessDays(anchor, 10))} -> new ${etDateTime(endOfBusinessDaysET(anchor, 10, 17))}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
