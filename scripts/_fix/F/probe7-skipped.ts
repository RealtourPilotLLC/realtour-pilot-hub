/**
 * READ-ONLY, production. WHO DOES THE NEW LANE GATE DROP? A gate that saves a
 * read is only acceptable if what it drops is genuinely unreadable, so this
 * mirrors reconcileDeliveries' candidate filter exactly and prints every job
 * the gate removes, with its whole order.
 */
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { lanesExpectedFor } from "@/lib/deliveryExceptions";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { isTestClientName } from "@/lib/testClients";

async function main() {
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, deliveredAt: true, aryeoListingId: true, statusEvidence: true,
      deliveryExceptionAt: true,
      client: { select: { name: true } },
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
      reviewSubmissions: { select: { status: true, sentToClientAt: true } },
    },
  });
  let reasoned = 0;
  let gated = 0;
  let test = 0;
  for (const p of projects) {
    const e = parseEvidence(p.statusEvidence);
    const finishedButAbsent = !!(
      e && e.aryeo && e.dropbox &&
      ((e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video")) ||
        (e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos")))
    );
    const approvedUnsent = p.reviewSubmissions.some((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const awaitingSend = !!(e && e.awaitingSend.length > 0);
    if (p.deliveryExceptionAt) { reasoned++; continue; }
    if (!(finishedButAbsent || approvedUnsent || awaitingSend)) continue;
    reasoned++;
    const lanes = lanesExpectedFor(p.deliverables, e);
    if (lanes.length > 0) continue;
    gated++;
    if (isTestClientName(p.client?.name) || isTestClientName(p.title)) test++;
    const all = await prisma.deliverable.findMany({
      where: { projectId: p.id },
      select: { type: true, label: true, productTitle: true, quantity: true, waivedAt: true, removedFromOrderAt: true },
    });
    console.log(`\nDROPPED BY THE LANE GATE — ${p.title}`);
    console.log(`   ${p.id}  status ${p.status}  listing id ${p.aryeoListingId ? "yes" : "no"}  client "${p.client?.name ?? "-"}"`);
    console.log(`   reason it was a candidate: ${[finishedButAbsent && "finished-but-absent", approvedUnsent && "approved+unsent cut", awaitingSend && "blob awaitingSend"].filter(Boolean).join(", ")}`);
    console.log(`   blob expected: ${JSON.stringify(e?.expected ?? null)}`);
    console.log(`   EVERY deliverable row on the job (${all.length}):`);
    for (const d of all) {
      console.log(`      ${d.type.padEnd(16)} q=${d.quantity} waived=${d.waivedAt ? "YES" : "no"} removed=${d.removedFromOrderAt ? "YES" : "no"}  "${d.productTitle ?? d.label ?? ""}"`);
    }
  }
  console.log(`\njobs with a reason to doubt: ${reasoned}   dropped by the lane gate: ${gated}   (of which synthetic TEST: ${test})`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
