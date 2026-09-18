/**
 * R02 — the two new exported helpers, CALLED on real production rows.
 * READ-ONLY: findMany only, nothing is written.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/R02/helpers-on-prod.ts
 *
 * Answers three questions with numbers rather than reasoning:
 *   1. how wide the count hole is across the WHOLE table, not just the jobs the
 *      hourly sweep still carries;
 *   2. whether any delivery anywhere carries a human actor (officeConfirmedDelivery);
 *   3. what 893 S Matlack St — the job the finding names — reads as.
 */
import { prisma } from "../../../src/lib/prisma";
import { officeConfirmedDelivery, videoUnitTally, expectedCategories } from "../../../src/lib/projectStatus";
import { parseEvidence } from "../../../src/lib/statusEvidence";
import { OWED_DELIVERABLE_WHERE } from "../../../src/lib/tasks";

async function main() {
  const projects = await prisma.project.findMany({
    where: { source: "ARYEO", aryeoMissingAt: null },
    select: {
      id: true, title: true, status: true, statusEvidence: true,
      deliveredAt: true, deliveredBy: true, deliveredVia: true,
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, quantity: true } },
    },
  });
  const outputs = await prisma.deliverableOutput.findMany({
    where: { waivedAt: null, removedFromOrderAt: null },
    select: { projectId: true, deliverableId: true, slot: true, category: true, deliveredAt: true, approvedAt: true },
  });
  const byProject = new Map<string, typeof outputs>();
  for (const o of outputs) byProject.set(o.projectId, [...(byProject.get(o.projectId) ?? []), o]);

  let stamped = 0;
  let confirmed = 0;
  let multi = 0;
  let shortOnListing = 0;
  let shortAndDelivered = 0;
  const worst: string[] = [];

  for (const p of projects) {
    if (p.deliveredAt) stamped++;
    if (officeConfirmedDelivery(p)) confirmed++;
    const tally = videoUnitTally(p.deliverables, byProject.get(p.id) ?? []);
    if (!tally || tally.owed <= 1) continue;
    if (!expectedCategories(p.deliverables).has("VIDEO")) continue;
    multi++;
    const listing = parseEvidence(p.statusEvidence)?.aryeo?.videos ?? 0;
    const withClient = Math.max(listing, tally.withClient);
    if (withClient >= tally.owed) continue;
    shortOnListing++;
    if (p.status === "DELIVERED") shortAndDelivered++;
    if (worst.length < 12) {
      worst.push(
        `  ${(p.title ?? "").split(",")[0].trim().padEnd(30)} ${p.status.padEnd(10)} owed ${String(tally.owed).padStart(2)} · with client ${withClient} · finished ${tally.finished} · source ${tally.source}`,
      );
    }
  }

  console.log(`projects (Aryeo, not orphaned):        ${projects.length}`);
  console.log(`  carrying a deliveredAt stamp:        ${stamped}`);
  console.log(`  a PERSON on record (officeConfirmed): ${confirmed}`);
  console.log(`multi-output video jobs:               ${multi}`);
  console.log(`  …with fewer on the listing than owed:${shortOnListing}`);
  console.log(`  …of those, sitting at DELIVERED:     ${shortAndDelivered}`);
  console.log("\nthe widest gaps:");
  for (const w of worst) console.log(w);

  const matlack = projects.find((p) => (p.title ?? "").startsWith("893 S Matlack"));
  if (matlack) {
    const t = videoUnitTally(matlack.deliverables, byProject.get(matlack.id) ?? []);
    console.log("\n893 S Matlack St — the job the finding names:");
    console.log(`  status ${matlack.status} · deliveredAt ${matlack.deliveredAt?.toISOString() ?? "null"} · actor ${matlack.deliveredBy ?? matlack.deliveredVia ?? "none recorded"}`);
    console.log(`  officeConfirmedDelivery() = ${officeConfirmedDelivery(matlack)}`);
    console.log(`  videoUnitTally() = ${JSON.stringify({ ...t, outstandingKeys: `${t?.outstandingKeys?.length ?? 0} keys` })}`);
    console.log(`  cached listing videos = ${parseEvidence(matlack.statusEvidence)?.aryeo?.videos ?? "unknown"}`);
    console.log(`  cached Dropbox finalVideo = ${parseEvidence(matlack.statusEvidence)?.dropbox?.finalVideo ?? "unknown"}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
