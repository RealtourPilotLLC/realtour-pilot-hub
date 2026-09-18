// READ-ONLY. Is there a version that IS linked to a pillar but has no category
// label? canonicalFromParts builds pillarRef from the LABEL, so such a row would
// be reported "not linked to an approved content pillar" while carrying an id.
import { prisma } from "../../../src/lib/prisma";

async function main() {
  const n = await prisma.contentScriptVersion.count({ where: { pillarId: { not: null }, OR: [{ categoryLabel: null }, { categoryLabel: "" }] } });
  const withId = await prisma.contentScriptVersion.count({ where: { pillarId: { not: null } } });
  console.log(`versions with a pillarId = ${withId}; of those with NO category label = ${n}`);
  if (n) {
    const rows = await prisma.contentScriptVersion.findMany({ where: { pillarId: { not: null }, OR: [{ categoryLabel: null }, { categoryLabel: "" }] }, select: { id: true, versionNo: true, status: true, title: true }, take: 10 });
    for (const r of rows) console.log(`  v${r.versionNo} ${r.status} ${r.title.slice(0, 50)}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
