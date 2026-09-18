// READ ONLY. SERIOUS 2 — "every reader goes through livePromise". Prove it on
// production: take every pinned row, ask each reader what deadline it judges
// the job by, and count where they disagree.
//
//   board  — deliveryBoard.outstandingPromise (turnaround.pinnedPromise)
//   queue  — editOverrides.effectiveDue        (was the raw column)
//   fires  — queries.getStuckJobs              (was the raw column)
//   dial   — queries.ownerPulse / bonus.ts     (already guarded)
import { PrismaClient } from "@prisma/client";
import { effectiveDue } from "../../../src/lib/editOverrides";
import { pinnedPromise } from "../../../src/lib/turnaround";
import { getStuckJobs } from "../../../src/lib/queries";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { promisedDueAt: { not: null } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true,
      deliveryDue: true, promisedDueAt: true, dueOverrideAt: true,
    },
  });
  console.log(`pinned rows in production: ${rows.length}`);

  // The class of row the unguarded readers got wrong: a pin that precedes its
  // own shoot (a rebook).
  const stale = rows.filter((p) => p.shootDate && p.promisedDueAt! <= p.shootDate);
  console.log(`rows whose pin precedes its own shoot (the rebook class): ${stale.length}`);
  for (const p of stale) {
    console.log(`   ${p.title.slice(0, 40).padEnd(42)} ${p.status.padEnd(9)} delivered=${!!p.deliveredAt} shoot ${etDateTime(p.shootDate!)} pin ${etDateTime(p.promisedDueAt!)}`);
  }

  // effectiveDue, before and after. "Before" is the line that shipped:
  //   p.dueOverrideAt ?? p.promisedDueAt ?? computed
  let disagree = 0;
  for (const p of rows) {
    const before = p.dueOverrideAt ?? p.promisedDueAt ?? p.deliveryDue;
    const after = effectiveDue(p, p.deliveryDue);
    const board = p.dueOverrideAt ?? pinnedPromise(p) ?? p.deliveryDue;
    if ((after?.getTime() ?? null) !== (board?.getTime() ?? null)) {
      console.log(`   MISMATCH vs board: ${p.title}`);
      disagree++;
    }
    if ((before?.getTime() ?? null) !== (after?.getTime() ?? null)) {
      console.log(`   effectiveDue MOVED: ${p.title.slice(0, 40).padEnd(42)} ${before ? etDateTime(before) : "—"} -> ${after ? etDateTime(after) : "—"}`);
    }
  }
  console.log(`effectiveDue vs the board's reading — disagreements: ${disagree} of ${rows.length}`);

  // getStuckJobs, through the real query, and the old reading recomputed beside
  // it on the same rows.
  const now = new Date();
  const fires = await getStuckJobs();
  console.log(`\ngetStuckJobs(): ${fires.length} fire(s)`);
  for (const f of fires) console.log(`   ${f.title.slice(0, 40).padEnd(42)} ${f.reason.padEnd(28)} ${f.stage}`);
  const DAY = 86_400_000;
  const wouldHaveFired = rows.filter(
    (p) => !p.deliveredAt && p.shootDate && p.shootDate <= now && p.promisedDueAt! < now &&
      !["CANCELLED", "DELIVERED", "ON_HOLD", "BOOKED"].includes(p.status),
  );
  const nowJudged = wouldHaveFired.map((p) => {
    const promised = pinnedPromise(p) ?? p.deliveryDue;
    return { title: p.title, oldDays: Math.floor((now.getTime() - p.promisedDueAt!.getTime()) / DAY),
             newDays: promised && promised < now ? Math.floor((now.getTime() - promised.getTime()) / DAY) : null };
  });
  const changed = nowJudged.filter((r) => r.newDays !== r.oldDays);
  console.log(`rows the panel dates off a pin: ${wouldHaveFired.length}; rows whose "N days late" changes under the guard: ${changed.length}`);
  for (const r of changed) console.log(`   ${r.title.slice(0, 40).padEnd(42)} ${r.oldDays}d -> ${r.newDays === null ? "not late" : r.newDays + "d"}`);

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
