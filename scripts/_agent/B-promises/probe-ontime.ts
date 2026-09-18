// READ-ONLY. Acceptance 1: the on-time percentage the owner dial and the
// photographer bonus read must be IDENTICAL whether it is computed off
// Project.deliveryDue (the old reading) or off the pinned promise (the new
// one). It is identical because the pin was copied from the column — this
// proves it on every delivered row rather than asserting it.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { deliveredAt: { not: null }, status: { not: "CANCELLED" } },
    select: { id: true, deliveredAt: true, deliveryDue: true, promisedDueAt: true, shootDate: true },
  });

  const pct = (ok: number, n: number) => (n ? ((ok / n) * 100).toFixed(2) : "n/a");

  // (a) the OLD reading — Project.deliveryDue only
  const oldJudged = rows.filter((p) => p.deliveryDue && (!p.shootDate || p.deliveredAt! > p.shootDate));
  const oldOn = oldJudged.filter((p) => p.deliveredAt! <= p.deliveryDue!).length;

  // (b) the NEW reading — promisedDueAt ?? deliveryDue (queries.ts + bonus.ts)
  const due = (p: { deliveryDue: Date | null; promisedDueAt: Date | null }) => p.promisedDueAt ?? p.deliveryDue;
  const newJudged = rows.filter((p) => due(p) && (!p.shootDate || p.deliveredAt! > p.shootDate));
  const newOn = newJudged.filter((p) => p.deliveredAt! <= due(p)!).length;

  console.log(`OLD (deliveryDue):        ${oldOn}/${oldJudged.length} = ${pct(oldOn, oldJudged.length)}%`);
  console.log(`NEW (promisedDueAt ?? …): ${newOn}/${newJudged.length} = ${pct(newOn, newJudged.length)}%`);
  console.log(`IDENTICAL: ${oldOn === newOn && oldJudged.length === newJudged.length}`);

  // Row-level: any project where the two readings disagree at all.
  const disagree = rows.filter((p) => {
    const a = p.deliveryDue ? p.deliveredAt! <= p.deliveryDue : null;
    const b = due(p) ? p.deliveredAt! <= due(p)! : null;
    return a !== b;
  });
  console.log(`rows where the verdict differs: ${disagree.length}`);

  // Bonus basis (shoot-window scope, no shootDate guard) — same comparison.
  const bOldJudged = rows.filter((p) => p.deliveryDue);
  const bOldOn = bOldJudged.filter((p) => p.deliveredAt! <= p.deliveryDue!).length;
  const bNewJudged = rows.filter((p) => due(p));
  const bNewOn = bNewJudged.filter((p) => p.deliveredAt! <= due(p)!).length;
  console.log(`bonus basis OLD ${bOldOn}/${bOldJudged.length} (${pct(bOldOn, bOldJudged.length)}%) · NEW ${bNewOn}/${bNewJudged.length} (${pct(bNewOn, bNewJudged.length)}%)`);

  const pinned = await prisma.project.count({ where: { promisedDueAt: { not: null } } });
  const mismatched = await prisma.project.count({
    where: { promisedDueAt: { not: null }, NOT: { promisedDueAt: { equals: prisma.project.fields.deliveryDue } } },
  });
  console.log(`pinned rows: ${pinned}; pins that differ from deliveryDue right now: ${mismatched}`);
  await prisma.$disconnect();
}
main();
