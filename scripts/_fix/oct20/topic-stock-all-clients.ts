// ---------------------------------------------------------------------------
// Oct 20 2026 — every client's pillars to 10-15 topics. Jordan: "For every
// client they should have 10-15 video topics per content pillar on their
// content strategy ... When creating video topics their content strategy must
// be followed."
//
// Most banks were stocked with ideas still WAITING on review (topic_auto_accept
// was switched on after their runs), which the client never sees and which
// count as stock, so no refill ran: Janice Pigga, John Collins and Joseph
// Sutow had pillars with 0 visible topics. For every live client (not a TEST
// account, not a self-planned or bulk program):
//
//   · an idea written from an OLDER strategy version is retired (SUPERSEDED):
//     the strategy in force is the one to follow (Kristin Ciarmella's 40);
//   · an idea written from the strategy in force is accepted into its pillar,
//     best-ranked first, until the pillar holds 15, unless it reads like a
//     topic already on file (the generator's own rule since today: title
//     similarity 0.7, or 0.6 in its own pillar), which is retired instead;
//     ideas past 15 stay waiting for staff;
//   · with --refill, every pillar still under 10 is topped up from the
//     strategy in force (one model call for a bank empty everywhere, else one
//     per short pillar asking for exactly what it lacks), accepted
//     automatically.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct20/topic-stock-all-clients.ts            # dry run
//   ... --apply    (accept / retire)
//   ... --refill   (after --apply)
// ---------------------------------------------------------------------------
import fs from "node:fs";

const BY = "auto:topic-bank";
const MAX = 15;
const SAME_PILLAR_NEAR = 0.6;
const BACKUP = "/Users/jordanspackman/RTP-backups/topic-stock-all-clients-2026-10-20.json";

async function main() {
  const apply = process.argv.includes("--apply");
  const refill = process.argv.includes("--refill");
  const { prisma } = await import("../../../src/lib/prisma");
  const { listPillars } = await import("../../../src/lib/contentPillars");
  const ct = await import("../../../src/lib/contentTopics");
  const { titleSimilarity, NEAR_DUPLICATE_THRESHOLD } = await import("../../../src/lib/contentPolicy");
  const { isTestClientName } = await import("../../../src/lib/testClients");

  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", clientSuppliesTopics: false, OR: [{ programKind: null }, { programKind: { not: "BULK" } }] }, select: { id: true, clientId: true } });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: live.map((e) => e.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const real = live.filter((e) => !isTestClientName(names.get(e.clientId)));

  if (refill) {
    for (const e of real) {
      const stock = await ct.bankStock(e.id);
      const short = stock.filter((p) => p.need > 0);
      if (!short.length) continue;
      const name = names.get(e.clientId);
      // A bank that is empty everywhere gets one whole-bank run (10 a pillar);
      // otherwise each short pillar gets exactly what it lacks, so none overshoots 15.
      if (short.length === stock.length && short.every((p) => p.need >= 8)) {
        const r = await ct.startTopicRefresh({ enrollmentId: e.id, kind: "REFRESH", requestedBy: BY });
        const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, changeSummary: true } });
        console.log(`${name}: whole bank → ${run?.status} · ${run?.changeSummary}`);
      } else {
        for (const p of short) {
          const r = await ct.startTopicRefresh({ enrollmentId: e.id, kind: "REFRESH", requestedBy: BY, pillarId: p.pillarId, keep: p.need });
          const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, changeSummary: true } });
          console.log(`${name} · ${p.pillarName}: ${p.need} → ${run?.status} · ${run?.changeSummary}`);
        }
      }
      console.log("   now: " + (await ct.bankStock(e.id)).map((p) => `${p.pillarName.slice(0, 26)} ${p.usable}`).join(" · "));
    }
    await prisma.$disconnect();
    return;
  }

  if (apply) {
    const all = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: { in: real.map((e) => e.id) }, disposition: "PENDING" } });
    fs.writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), suggestions: all }, null, 1));
    console.log(`backup of ${all.length} waiting ideas: ${BACKUP}`);
  }
  for (const e of real) {
    const name = names.get(e.clientId) ?? e.clientId;
    const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: e.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true } });
    const pillars = await listPillars(e.id);
    const pending = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: e.id, disposition: "PENDING", kind: "BANK" }, orderBy: [{ createdAt: "asc" }, { rank: "asc" }] });
    if (!approved || !pillars.length || !pending.length) { if (pending.length) console.log(`${name}: ${pending.length} waiting, no approved strategy or pillars; left alone`); continue; }
    const runs = await prisma.contentTopicRefreshRun.findMany({ where: { id: { in: [...new Set(pending.map((p) => p.refreshRunId))] } }, select: { id: true, strategyVersionId: true } });
    const strategyOf = new Map(runs.map((r) => [r.id, r.strategyVersionId]));
    const older = pending.filter((s) => strategyOf.get(s.refreshRunId) !== approved.id || !s.pillarId || !pillars.some((p) => p.id === s.pillarId));
    const current = pending.filter((s) => !older.includes(s));

    const topics = await prisma.contentTopic.findMany({ where: { enrollmentId: e.id }, select: { title: true, pillarId: true, status: true, approvalState: true, source: true, proposedState: true, clientDeclinedAt: true } });
    const onFile = topics.map((t) => ({ title: t.title, pillarId: t.pillarId }));
    const usable = new Map(pillars.map((p) => [p.id, topics.filter((t) => t.pillarId === p.id && ct.isUsableStock(t)).length]));
    const accept: string[] = [], dupes: { id: string; title: string; like: string }[] = [], over: string[] = [];
    for (const s of current) {
      const like = onFile.find((r) => { const sim = titleSimilarity(s.title, r.title); return sim >= NEAR_DUPLICATE_THRESHOLD || (r.pillarId === s.pillarId && sim >= SAME_PILLAR_NEAR); });
      if (like) { dupes.push({ id: s.id, title: s.title, like: like.title }); continue; }
      if ((usable.get(s.pillarId!) ?? 0) >= MAX) { over.push(s.id); continue; }
      accept.push(s.id);
      usable.set(s.pillarId!, (usable.get(s.pillarId!) ?? 0) + 1);
      onFile.push({ title: s.title, pillarId: s.pillarId });
    }
    console.log(`\n${name} (strategy v${approved.versionNo}): ${pending.length} waiting → accept ${accept.length}, retire ${older.length} from an older strategy, retire ${dupes.length} reworded, leave ${over.length} (pillar at ${MAX})`);
    for (const d of dupes) console.log(`   reworded: "${d.title}" ~ "${d.like}"`);
    console.log("   after: " + pillars.map((p) => `${p.name.slice(0, 26)} ${usable.get(p.id)}`).join(" · "));
    if (!apply) continue;
    if (older.length) await prisma.contentTopicSuggestion.updateMany({ where: { id: { in: older.map((s) => s.id) }, disposition: "PENDING" }, data: { disposition: "SUPERSEDED", dispositionBy: BY, dispositionAt: new Date() } });
    if (dupes.length) await prisma.contentTopicSuggestion.updateMany({ where: { id: { in: dupes.map((d) => d.id) }, disposition: "PENDING" }, data: { disposition: "SUPERSEDED", dispositionBy: `${BY}:reworded`, dispositionAt: new Date() } });
    for (let i = 0; i < accept.length; i += 100) {
      const r = await ct.acceptSuggestions(accept.slice(i, i + 100), BY);
      if (r.errors.length) console.log("   errors:", r.errors);
    }
  }
  if (!apply) console.log("\nDRY RUN. --apply to accept and retire as above.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
