// READ-ONLY. Exactly which LIVE CURRENT versions would newly fail a pillar
// membership check, and whether they already carry a resolved pillarId.
import { prisma } from "../../../src/lib/prisma";
import { normalizeTitle } from "../../../src/lib/contentPolicy";

async function main() {
  const scripts = await prisma.contentScript.findMany({ select: { id: true, title: true, historical: true, currentVersionId: true, enrollmentId: true, status: true } });
  const live = scripts.filter((s) => !s.historical && s.currentVersionId);
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: live.map((s) => s.currentVersionId!) } }, select: { id: true, scriptId: true, versionNo: true, status: true, categoryLabel: true, pillarId: true, enrollmentId: true, estimatedSeconds: true, validationJson: true } });
  const pillars = await prisma.contentPillar.findMany({ select: { id: true, name: true, status: true, enrollmentId: true } });
  const aliases = await prisma.contentPillarAlias.findMany({ select: { pillarId: true, name: true } });
  console.log(`live scripts with a current version = ${live.length}`);
  let unknown = 0, noLabel = 0, ok = 0, retired = 0;
  for (const v of versions) {
    const s = live.find((x) => x.currentVersionId === v.id)!;
    const mine = pillars.filter((p) => p.enrollmentId === v.enrollmentId);
    let hit = v.pillarId ? mine.find((p) => p.id === v.pillarId) ?? null : null;
    if (!hit && v.categoryLabel) {
      const bare = v.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0] ?? v.categoryLabel;
      const key = normalizeTitle(bare);
      hit = mine.find((p) => normalizeTitle(p.name) === key || aliases.some((a) => a.pillarId === p.id && normalizeTitle(a.name) === key)) ?? null;
    }
    const label = v.categoryLabel ?? null;
    if (!label && !v.pillarId) { noLabel++; console.log(`  NO PILLAR AT ALL  status=${v.status} ${s.title.slice(0, 50)}`); }
    else if (!hit) { unknown++; console.log(`  UNKNOWN LABEL     status=${v.status} label=${JSON.stringify(label)} pillarId=${v.pillarId ?? "-"} ${s.title.slice(0, 50)}`); }
    else if (hit.status !== "ACTIVE") { retired++; console.log(`  RETIRED PILLAR    status=${v.status} ${hit.name}`); }
    else ok++;
  }
  console.log(`\nsummary of live CURRENT versions: ok=${ok} unknownLabel=${unknown} retiredPillar=${retired} noPillarAtAll=${noLabel}`);
  const reviewable = versions.filter((v) => v.status === "DRAFT" || v.status === "INTERNAL_REVIEW");
  console.log(`of those, awaiting review (DRAFT/INTERNAL_REVIEW) = ${reviewable.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
