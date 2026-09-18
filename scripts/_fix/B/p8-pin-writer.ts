// READ ONLY — NOTHING IS WRITTEN. SERIOUS 3: what the sweep's new pin write
// would do on the next pass, and proof that splitting standardDeliveryDue into
// deliveryPromiseFor did not move a single date.
import { PrismaClient } from "@prisma/client";
import { standardDeliveryDue, deliveryPromiseFor, slaTierOf, videoAnchorFor, OWED_DELIVERABLE_WHERE } from "../../../src/lib/tasks";
import { isMonthlyContentJob } from "../../../src/lib/pipeline";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, packageName: true,
      deliveryDue: true, promisedDueAt: true, promisedTierKey: true, tierOverride: true,
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
      appointments: { select: { status: true, startAt: true } },
    },
  });
  const shot = rows.filter((p) => p.shootDate);
  console.log(`projects: ${rows.length}; with a shoot date (a computable promise): ${shot.length}`);

  // 1. REFACTOR SAFETY — the split must be a pure factoring.
  let moved = 0;
  for (const p of shot) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const opts = { tier: slaTierOf(p), videoAnchor: videoAnchorFor({ shootDate: p.shootDate, appointments: p.appointments }) };
    const before = standardDeliveryDue(p.shootDate!, p.deliverables, monthly, null, opts);
    const after = deliveryPromiseFor(p.shootDate!, p.deliverables, monthly, null, opts).at;
    if (before.getTime() !== after.getTime()) { moved++; console.log(`   DATE MOVED: ${p.title}`); }
  }
  console.log(`standardDeliveryDue vs deliveryPromiseFor().at — rows whose date moves: ${moved} of ${shot.length}`);

  // 2. TIER AGREEMENT — the 538 rows pin-promises reconstructed by hand, read
  //    by the ladder the sweep will now use. (The DATE is expected to differ on
  //    premium rows: the pin froze the old 72-hour clock on purpose.)
  const pinned = shot.filter((p) => p.promisedDueAt && p.promisedTierKey);
  const tierMatch = new Map<string, number>();
  let tierSame = 0;
  for (const p of pinned) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const k = deliveryPromiseFor(p.shootDate!, p.deliverables, monthly, null, {
      tier: slaTierOf(p),
      videoAnchor: videoAnchorFor({ shootDate: p.shootDate, appointments: p.appointments }),
    }).tierKey;
    if (k === p.promisedTierKey) tierSame++;
    else tierMatch.set(`${p.promisedTierKey} -> ${k}`, (tierMatch.get(`${p.promisedTierKey} -> ${k}`) ?? 0) + 1);
  }
  console.log(`\npinned rows with a tier label: ${pinned.length}; the sweep's ladder agrees on ${tierSame}`);
  for (const [k, n] of [...tierMatch.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`);

  // 3. WHAT THE NEXT SWEEP WOULD PIN. The sweep loads live work plus deliveries
  //    from the last 7 days; a pin needs a shoot date and no existing pin.
  const LIVE = ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"];
  const sweepSet = rows.filter(
    (p) => LIVE.includes(p.status) ||
      (p.status === "DELIVERED" && p.deliveredAt && p.deliveredAt >= new Date(Date.now() - 7 * 86_400_000)),
  );
  //    The real guards, verbatim: a date, a shoot that has HAPPENED, something
  //    owed, and no pin already.
  const now = new Date();
  const started = (p: { shootDate: Date | null }) => !!p.shootDate && p.shootDate <= now;
  const unpinned = sweepSet.filter((p) => !p.promisedDueAt);
  const wouldPin = unpinned.filter((p) => started(p) && p.deliverables.length > 0);
  const guarded = sweepSet.length - unpinned.length;
  const noDate = unpinned.filter((p) => !p.shootDate).length;
  const notYetShot = unpinned.filter((p) => p.shootDate && !started(p)).length;
  const nothingOwed = unpinned.filter((p) => started(p) && p.deliverables.length === 0).length;
  console.log(`\nrows the sweep loads: ${sweepSet.length}`);
  console.log(`   already pinned — the guard refuses them  : ${guarded}`);
  console.log(`   no shoot date  — no promise to freeze    : ${noDate}`);
  console.log(`   shoot still ahead — clock not started    : ${notYetShot}`);
  console.log(`   nothing owed — no promise about anything : ${nothingOwed}`);
  console.log(`   WOULD BE PINNED on the next pass         : ${wouldPin.length}`);
  for (const p of wouldPin.slice(0, 15)) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const pr = deliveryPromiseFor(p.shootDate!, p.deliverables, monthly, null, {
      tier: slaTierOf(p),
      videoAnchor: videoAnchorFor({ shootDate: p.shootDate, appointments: p.appointments }),
    });
    const sameAsColumn = p.deliveryDue && Math.abs(p.deliveryDue.getTime() - pr.at.getTime()) < 60_000;
    console.log(`   ${p.title.slice(0, 36).padEnd(38)} ${p.status.padEnd(9)} pin ${etDateTime(pr.at).padEnd(22)} ${pr.tierKey.padEnd(15)} aim ${etDateTime(pr.targetAt).padEnd(22)} ${sameAsColumn ? "= deliveryDue" : `deliveryDue ${p.deliveryDue ? etDateTime(p.deliveryDue) : "—"}`}`);
  }
  // The aim must never fall after the deadline.
  let badAim = 0;
  for (const p of shot) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const pr = deliveryPromiseFor(p.shootDate!, p.deliverables, monthly, null, { tier: slaTierOf(p) });
    if (pr.targetAt > pr.at) badAim++;
  }
  console.log(`\npins whose internal aim would fall AFTER the client deadline: ${badAim}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
