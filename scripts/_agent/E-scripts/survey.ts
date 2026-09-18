// READ-ONLY. Survey of script versions: how many carry validationJson, how many
// carry an estimate, and how the estimates sit against the 20-30s target.
import { prisma } from "../../../src/lib/prisma";

async function main() {
  const total = await prisma.contentScriptVersion.count();
  const withVal = await prisma.contentScriptVersion.count({ where: { validationJson: { not: null } } });
  const withEst = await prisma.contentScriptVersion.count({ where: { estimatedSeconds: { not: null } } });
  const rows = await prisma.contentScriptVersion.findMany({
    select: { id: true, versionNo: true, status: true, estimatedSeconds: true, spokenWordCount: true, validationJson: true, timingNote: true, pillarId: true, categoryLabel: true, enrollmentId: true, source: true },
  });
  const est = rows.filter((r) => r.estimatedSeconds != null);
  const over = est.filter((r) => (r.estimatedSeconds ?? 0) > 30);
  const under = est.filter((r) => (r.estimatedSeconds ?? 0) < 20);
  const inT = est.filter((r) => (r.estimatedSeconds ?? 0) >= 20 && (r.estimatedSeconds ?? 0) <= 30);
  console.log(`versions total=${total} withValidationJson=${withVal} withEstimate=${withEst}`);
  console.log(`estimates: under20=${under.length} inTarget=${inT.length} over30=${over.length}`);
  const overNoVal = over.filter((r) => !r.validationJson);
  console.log(`OVER-LENGTH rows with NO validationJson (findings box never renders) = ${overNoVal.length}`);
  console.log(`  seconds seen on those: ${[...new Set(overNoVal.map((r) => r.estimatedSeconds))].sort((a, b) => (a ?? 0) - (b ?? 0)).join(", ")}`);
  const maxSec = est.reduce((m, r) => Math.max(m, r.estimatedSeconds ?? 0), 0);
  console.log(`longest estimate = ${maxSec}s`);
  let timingFindings = 0, pillarMissing = 0, pillarUnmapped = 0;
  for (const r of rows) {
    if (!r.validationJson) continue;
    try {
      const v = JSON.parse(r.validationJson) as { findings: { code: string; severity: string }[] };
      for (const f of v.findings ?? []) {
        if (f.code === "timing.out-of-range") timingFindings++;
        if (f.code === "pillar.missing") pillarMissing++;
        if (f.code === "pillar.unmapped") pillarUnmapped++;
      }
    } catch { /* ignore */ }
  }
  console.log(`stored findings: timing.out-of-range=${timingFindings} pillar.missing=${pillarMissing} pillar.unmapped=${pillarUnmapped}`);
  const noPillarId = rows.filter((r) => !r.pillarId).length;
  const noPillarAtAll = rows.filter((r) => !r.pillarId && !r.categoryLabel).length;
  console.log(`versions with no pillarId=${noPillarId}; with neither pillarId nor categoryLabel=${noPillarAtAll}`);
  const pillars = await prisma.contentPillar.findMany({ select: { id: true, name: true, status: true, strategyVersionId: true, enrollmentId: true } });
  console.log(`pillars total=${pillars.length} retired=${pillars.filter((p) => p.status !== "ACTIVE").length} withStrategyVersionId=${pillars.filter((p) => p.strategyVersionId).length}`);
  const retiredIds = new Set(pillars.filter((p) => p.status !== "ACTIVE").map((p) => p.id));
  console.log(`versions pointing at a RETIRED pillar = ${rows.filter((r) => r.pillarId && retiredIds.has(r.pillarId)).length}`);
  const byId = new Map(pillars.map((p) => [p.id, p]));
  const foreign = rows.filter((r) => r.pillarId && byId.get(r.pillarId) && byId.get(r.pillarId)!.enrollmentId !== r.enrollmentId);
  console.log(`versions pointing at ANOTHER enrollment's pillar = ${foreign.length}`);
  const dangling = rows.filter((r) => r.pillarId && !byId.has(r.pillarId));
  console.log(`versions with a pillarId that no longer exists = ${dangling.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
