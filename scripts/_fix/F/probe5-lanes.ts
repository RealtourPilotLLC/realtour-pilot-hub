/**
 * READ-ONLY, production. DEFECT 4 measured: how many jobs with an internal
 * reason to doubt their delivery would have been selected on the OLD rule
 * (`expected` off the cached evidence blob) and examined ZERO lanes — each one
 * a live Aryeo read spent on a question the pass could not then ask.
 *
 * No Aryeo calls here: this is the selection arithmetic only.
 */
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { lanesExpectedFor } from "@/lib/deliveryExceptions";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { isTestClientName } from "@/lib/testClients";

const LANE_OF_EXPECTED: Record<string, string> = {
  Video: "VIDEO",
  Photos: "PHOTOS",
  "Floor plan": "FLOORPLAN",
  "3D tour": "THREED",
};

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

  let candidates = 0;
  const blind: { title: string; status: string; listing: boolean; blob: string; now: string }[] = [];
  for (const p of projects) {
    if (isTestClientName(p.client?.name) || isTestClientName(p.title)) continue;
    const e = parseEvidence(p.statusEvidence);
    const finishedButAbsent = !!(
      e && e.aryeo && e.dropbox &&
      ((e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video")) ||
        (e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos")))
    );
    const approvedUnsent = p.reviewSubmissions.some((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const awaitingSend = !!(e && e.awaitingSend.length > 0);
    if (!(p.deliveryExceptionAt || finishedButAbsent || approvedUnsent || awaitingSend)) continue;
    candidates++;
    // THE OLD RULE: lanes straight off the blob's own words.
    const oldLanes = (e?.expected ?? []).map((w) => LANE_OF_EXPECTED[w]).filter(Boolean);
    const newLanes = lanesExpectedFor(p.deliverables, e);
    if (oldLanes.length === 0) {
      blind.push({
        title: p.title.split(",")[0],
        status: p.status,
        listing: !!p.aryeoListingId,
        blob: p.statusEvidence === null ? "no statusEvidence at all" : `expected ${JSON.stringify(e?.expected ?? [])}`,
        now: newLanes.length ? newLanes.join(",") : "(still nothing — no read will be bought)",
      });
    }
  }

  console.log(`candidates on the old selection rule: ${candidates}`);
  console.log(`of those, examined ZERO lanes and still spent a live Aryeo read: ${blind.length}\n`);
  for (const b of blind) {
    console.log(`   ${b.title.padEnd(34)} ${b.status.padEnd(10)} listing id: ${b.listing ? "yes" : "no "}   ${b.blob}`);
    console.log(`   ${" ".repeat(34)} now examines: ${b.now}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
