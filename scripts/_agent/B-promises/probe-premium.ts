// READ-ONLY. Acceptance 2, 3 and 4 for the premium promise.
//   2. A Friday 9am premium shoot is due end of the following Thursday.
//   3. The internal target is three business days and never later than the
//      client deadline.
//   4. Kyle's board, the project card and the QC card print the SAME date for
//      the same real premium job — pinned (the promise it was sold under) and
//      unpinned (today's rules).
import { PrismaClient } from "@prisma/client";
import { dueAtFor, targetAtFor, tierFor, premiumDueFrom, premiumTargetFrom } from "../../../src/lib/turnaround";
import { outstandingPromise, boardItems } from "../../../src/lib/deliveryBoard";
import { pendingDuesByCategory, specsForProject, slaTierOf } from "../../../src/lib/tasks";
import { etDateTime, etDayKey, businessDaysBetweenET } from "../../../src/lib/datetime";
import { turnaroundRules } from "../../../src/lib/settings";

const prisma = new PrismaClient();
const say = (d: Date | null | undefined) => (d ? `${etDateTime(d)} ET  [${d.toISOString()}]` : "—");

async function main() {
  const rules = await turnaroundRules();

  // ---- 2 + 3: the arithmetic, on a Friday 9am ET shoot in September 2026.
  const friday = new Date("2026-09-11T13:00:00.000Z"); // Fri Sep 11 2026, 9:00 AM EDT
  const tier = tierFor("Premium Reel");
  const due = dueAtFor(tier, friday, rules);
  const target = targetAtFor(tier, friday, rules);
  const naive96h = new Date(friday.getTime() + 96 * 3_600_000);
  console.log("=== 2. Friday 9am premium shoot ===");
  console.log(`  tier               ${tier.key} (${tier.label})`);
  console.log(`  shoot              ${say(friday)}`);
  console.log(`  client deadline    ${say(due)}`);
  console.log(`  internal target    ${say(target)}`);
  console.log(`  96 elapsed hours   ${say(naive96h)}   <- what we do NOT do`);
  console.log(`  due day key        ${etDayKey(due)} (expect 2026-09-17, a Thursday)`);
  console.log(`  target <= due      ${target <= due}`);
  console.log(`  business days shoot->due   ${businessDaysBetweenET(friday, due)} (expect 4)`);
  console.log(`  business days shoot->aim   ${businessDaysBetweenET(friday, target)} (expect 3)`);

  // Every weekday anchor of a month: the deadline is always 4 business days
  // out, the target always 3, and the new date is never EARLIER than the 72
  // elapsed hours it replaces.
  let bad = 0;
  let earlier = 0;
  for (let d = 1; d <= 30; d++) {
    for (const h of [8, 13, 19]) {
      const anchor = new Date(Date.UTC(2026, 8, d, h, 0));
      const cd = premiumDueFrom(anchor, rules);
      const ct = premiumTargetFrom(anchor, rules);
      if (businessDaysBetweenET(anchor, cd) !== 4 || businessDaysBetweenET(anchor, ct) !== 3 || ct > cd) bad++;
      if (cd.getTime() < anchor.getTime() + (rules.premiumVideoHours ?? 72) * 3_600_000) earlier++;
    }
  }
  console.log(`  90 anchors checked: ${bad} wrong day-count, ${earlier} earlier than the old 72h promise`);

  // ---- 4: one real premium job, three surfaces.
  const rows = await prisma.project.findMany({
    where: {
      status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] },
      shootDate: { not: null },
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, label: { contains: "Premium" } } },
    },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, revisionRequestedAt: true,
      dueOverrideAt: true, tierOverride: true, packageName: true, statusEvidence: true,
      promisedDueAt: true, promisedTargetAt: true, promisedTierKey: true, promisedReason: true,
      deliveryDue: true, squareFeet: true, photoTarget: true,
      removalNotes: true, shotOrderNotes: true, debriefSubmittedAt: true, videoInstructions: true,
      client: { select: { name: true, segment: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, status: true, uploadedAt: true, label: true, productTitle: true } },
      appointments: { select: { startAt: true, status: true }, orderBy: { startAt: "asc" } },
    },
    take: 3,
  });

  for (const p of rows) {
    console.log(`\n=== 4. ${p.title} (${p.status}) ===`);
    console.log(`  shoot ${say(p.shootDate)}`);
    console.log(`  pinned promise     ${say(p.promisedDueAt)}  tier ${p.promisedTierKey ?? "—"}  aim ${say(p.promisedTargetAt)}`);
    console.log(`  stored deliveryDue ${say(p.deliveryDue)}`);

    for (const withPin of [true, false]) {
      const row = { ...p, promisedDueAt: withPin ? p.promisedDueAt : null };
      // KYLE'S BOARD + the project card's Status check card — literally the
      // same exported function, so they cannot drift.
      const promise = outstandingPromise(row, { turnarounds: rules });
      const items = boardItems(row, new Date(), rules);
      const video = items.find((i) => /reel|video/i.test(i.title));
      // THE QC CARD — per-category lines, and the card's own due.
      const dues = pendingDuesByCategory({
        shootDate: row.shootDate,
        deliverables: row.deliverables,
        orderItems: row.orderItems,
        statusEvidence: row.statusEvidence,
        turnarounds: rules,
        tier: slaTierOf(row),
        appointments: row.appointments,
        promisedDueAt: row.promisedDueAt,
      });
      const specs = specsForProject({
        turnarounds: rules,
        status: row.status,
        title: row.title,
        shootDate: row.shootDate,
        promisedDueAt: row.promisedDueAt,
        deliverables: row.deliverables,
        orderItems: row.orderItems,
        statusEvidence: row.statusEvidence,
        monthlyContent: false,
        squareFeet: row.squareFeet,
        photoTarget: row.photoTarget,
        clientSegment: row.client?.segment ?? null,
        removalNotes: row.removalNotes,
        shotOrderNotes: row.shotOrderNotes,
        debriefSubmittedAt: row.debriefSubmittedAt,
        videoInstructions: row.videoInstructions,
        appointments: row.appointments,
        clientName: row.client?.name ?? null,
        tier: slaTierOf(row),
      });
      const qc = specs.find((s) => s.taskType === "media_qa");
      console.log(`  --- ${withPin ? "as pinned (sold under)" : "on today's rules"} ---`);
      console.log(`    board / project card   ${say(promise.at)}  (${promise.label ?? "—"} · ${promise.tierLabel ?? "—"}${promise.pinned ? " · pinned" : ""})`);
      console.log(`    board's video item     ${say(video?.dueAt)}  (${video?.title ?? "no video line item"})`);
      console.log(`    QC card — Video line   ${say(dues.find((d) => d.category === "Video")?.at)}`);
      console.log(`    QC card — card due     ${say(qc?.dueAt)}`);
    }
  }
  await prisma.$disconnect();
}
main();
