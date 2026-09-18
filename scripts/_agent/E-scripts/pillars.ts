// READ-ONLY. What the 9 validated versions actually say, the historical split on
// the over-length rows, and whether a category label on a LIVE script resolves
// to one of the client's approved pillars.
import { prisma } from "../../../src/lib/prisma";
import { normalizeTitle } from "../../../src/lib/contentPolicy";

async function main() {
  const rows = await prisma.contentScriptVersion.findMany({
    select: { id: true, scriptId: true, versionNo: true, status: true, estimatedSeconds: true, spokenWordCount: true, validationJson: true, pillarId: true, categoryLabel: true, enrollmentId: true, strategyVersionId: true, source: true },
  });
  const scripts = await prisma.contentScript.findMany({ select: { id: true, historical: true, currentVersionId: true, enrollmentId: true } });
  const hist = new Map(scripts.map((s) => [s.id, s.historical]));
  const live = rows.filter((r) => !hist.get(r.scriptId));
  const liveOver = live.filter((r) => (r.estimatedSeconds ?? 0) > 30);
  console.log(`live (non-historical) versions=${live.length}; of those over 30s=${liveOver.length}, under 20s=${live.filter((r) => (r.estimatedSeconds ?? 0) < 20).length}`);
  console.log(`live over-30 rows with NO validationJson = ${liveOver.filter((r) => !r.validationJson).length}`);
  const currentIds = new Set(scripts.map((s) => s.currentVersionId).filter(Boolean) as string[]);
  const liveCurrent = live.filter((r) => currentIds.has(r.id));
  console.log(`live CURRENT versions=${liveCurrent.length}; over 30s=${liveCurrent.filter((r) => (r.estimatedSeconds ?? 0) > 30).length}; with validationJson=${liveCurrent.filter((r) => r.validationJson).length}`);

  console.log("\n--- the 9 rows that carry validationJson ---");
  for (const r of rows.filter((x) => x.validationJson)) {
    const v = JSON.parse(r.validationJson!) as { ok: boolean; findings: { code: string; severity: string }[] };
    console.log(`  v${r.versionNo} ${r.source} est=${r.estimatedSeconds}s/${r.spokenWordCount}w historical=${hist.get(r.scriptId)} ok=${v.ok} pillarId=${r.pillarId ?? "-"} label=${JSON.stringify(r.categoryLabel)} findings=${v.findings.map((f) => `${f.code}(${f.severity})`).join(",")}`);
  }

  console.log("\n--- do LIVE category labels resolve to a client pillar? ---");
  const pillars = await prisma.contentPillar.findMany({ select: { id: true, name: true, status: true, enrollmentId: true, strategyVersionId: true } });
  const aliases = await prisma.contentPillarAlias.findMany({ select: { pillarId: true, name: true, kind: true } });
  const labels = new Map<string, { n: number; enrollmentId: string; resolves: string | null }>();
  for (const r of live) {
    if (!r.categoryLabel) continue;
    const bare = r.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0] ?? r.categoryLabel;
    const key = normalizeTitle(bare);
    const mine = pillars.filter((p) => p.enrollmentId === r.enrollmentId);
    let hit: string | null = null;
    for (const p of mine) {
      if (normalizeTitle(p.name) === key) { hit = p.name; break; }
      if (aliases.some((a) => a.pillarId === p.id && normalizeTitle(a.name) === key)) { hit = `${p.name} (via alias)`; break; }
    }
    const k = `${r.enrollmentId}::${bare}`;
    const cur = labels.get(k);
    if (cur) cur.n++; else labels.set(k, { n: 1, enrollmentId: r.enrollmentId, resolves: hit });
  }
  for (const [k, v] of [...labels.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.n.toString().padStart(3)}x ${JSON.stringify(k.split("::")[1])} -> ${v.resolves ?? "*** NO PILLAR ON THIS CLIENT ***"}`);
  }

  console.log("\n--- pillars per enrollment ---");
  for (const p of pillars) console.log(`  ${p.enrollmentId} ${p.status} strategyVersionId=${p.strategyVersionId ?? "-"} ${JSON.stringify(p.name)}`);
  const svs = await prisma.contentStrategyVersion.findMany({ select: { id: true, enrollmentId: true, versionNo: true, status: true } });
  console.log("\n--- strategy versions ---");
  for (const s of svs) console.log(`  ${s.enrollmentId} v${s.versionNo} ${s.status} id=${s.id}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
