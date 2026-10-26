export {};
// ---------------------------------------------------------------------------
// ONE-OFF (Oct 26 2026): Bernadette hit "this client's daily AI limit (40/day)"
// before Jordan's call with her. 38 of her 45 runs that day were Claude's own
// one-offs (skit-bank refills, skit trims, the brief-writer test), requested as
// "staff:oct26-..." instead of the "claude:" prefix that keeps a developer's
// runs off the client's cap (aiRuns.isOfflineRun, Oct 22 2026). This relabels
// those rows "claude:oct26-..." so the cap counts only real use. Nothing else
// on the rows changes; the spend still counts program-wide.
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-relabel-my-runs.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

async function main() {
  const prisma = await db();
  const since = new Date("2026-10-26T00:00:00Z");
  const rows = await prisma.programAiRun.findMany({ where: { startedAt: { gte: since }, requestedBy: { startsWith: "staff:oct26-" } }, select: { id: true, requestedBy: true, enrollmentId: true } });
  const by = new Map<string, number>();
  for (const r of rows) by.set(`${r.requestedBy} @ ${r.enrollmentId}`, (by.get(`${r.requestedBy} @ ${r.enrollmentId}`) ?? 0) + 1);
  for (const [k, n] of by) console.log(String(n).padStart(3), k);
  console.log(`${rows.length} rows to relabel`);
  if (!APPLY) { console.log("dry run: --apply to relabel"); return; }
  let n = 0;
  for (const r of rows) {
    await prisma.programAiRun.update({ where: { id: r.id }, data: { requestedBy: r.requestedBy!.replace(/^staff:/, "claude:") } });
    n++;
  }
  console.log(`relabeled ${n}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
