// READ-ONLY. How big is each candidate rule? The pass buys one live Aryeo read
// per candidate, so the scope has to be measured before it is chosen.
import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";

async function main() {
  const ps = await prisma.project.findMany({
    where: { status: { notIn: ["CANCELLED"] } },
    select: {
      id: true, title: true, status: true, deliveredAt: true, aryeoListingId: true, aryeoMissingAt: true,
      statusEvidence: true, deliveryExceptionAt: true,
      reviewSubmissions: { select: { status: true, sentToClientAt: true } },
    },
    take: 4000,
  });
  let ruleB = 0, ruleC = 0, ruleD = 0, both = 0, noListing = 0;
  const cSample: string[] = [];
  for (const p of ps) {
    const e = parseEvidence(p.statusEvidence);
    const b = !!(e && e.aryeo && e.dropbox &&
      ((e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video")) ||
       (e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos"))));
    const c = p.reviewSubmissions.some((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const d = !!(e && e.awaitingSend.length > 0);
    if (b) ruleB++;
    if (c) { ruleC++; if (cSample.length < 14) cSample.push(`${p.status.padEnd(10)} ${p.title.slice(0, 44)}`); }
    if (d) ruleD++;
    if (b && c) both++;
    if ((b || c || d) && !p.aryeoListingId) noListing++;
  }
  const union = ps.filter((p) => {
    const e = parseEvidence(p.statusEvidence);
    const b = !!(e && e.aryeo && e.dropbox &&
      ((e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video")) ||
       (e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos"))));
    const c = p.reviewSubmissions.some((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const d = !!(e && e.awaitingSend.length > 0);
    return b || c || d || !!p.deliveryExceptionAt;
  });
  console.log(`projects scanned: ${ps.length}`);
  console.log(`rule B (finished in Dropbox, absent from the cached listing): ${ruleB}`);
  console.log(`rule C (an APPROVED cut nobody has marked sent):              ${ruleC}`);
  console.log(`rule D (evidence blob says something is awaiting send):       ${ruleD}`);
  console.log(`B and C together: ${both}   ·  union: ${union.length}   ·  of those with no listing id: ${noListing}`);
  console.log(`\nrule C sample:`);
  for (const s of cSample) console.log(`   ${s}`);
  const delivered = ps.filter((p) => p.status === "DELIVERED").length;
  console.log(`\nfor scale: ${delivered} DELIVERED projects, ${ps.length - delivered} not`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
