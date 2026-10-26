export {};
// ---------------------------------------------------------------------------
// LIVE TEST (Oct 26 2026): Jordan's two-step workflow, run by the hub on real
// months, for comparison with what his ChatGPT + Scripting GPT produced.
//   1. buildMonthBriefs: the per-topic summaries of what the agent said
//      (WRITES ContentTopicBrief rows: the office reads them; nothing else does
//      while the brief writer is switched off).
//   2. runBriefDraft per chosen topic: the script from its summary. The
//      scripts are written to the scratchpad file only: NO script version is
//      created, nothing is shared, no existing script is touched.
// Spends AI (about $0.25 a month's summaries, $0.10 a script on Opus 5.5).
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-brief-eval.ts --apply <out.json> "Erica Walker:2026-10" ["Bernadette Rabel:2026-10"]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
import fs from "node:fs";
installNextStubs();

async function main() {
  if (!APPLY) { console.log("This test spends AI and saves summaries: run it with --apply."); return; }
  const args = process.argv.slice(2).filter((a) => a !== "--apply");
  const outPath = args.shift()!;
  const prisma = await db();
  const tb = await import("../../src/lib/scriptWriter/topicBrief");
  const bw = await import("../../src/lib/scriptWriter/briefWriter");
  const { monthBriefText } = await import("../../src/lib/scriptWriter/briefFormat");
  const { releaseRunKey } = await import("../../src/lib/aiRuns");
  const { topicFormatOf, resolvedTopicFormat, asVideoStyle, videoStyleFromOverrides } = await import("../../src/lib/contentPolicy/videoFormat");
  const out: Record<string, unknown>[] = [];
  for (const spec of args) {
    const [name, monthKey] = spec.split(":");
    const client = await prisma.client.findFirst({ where: { name }, select: { id: true } });
    const month = client ? await prisma.contentMonth.findFirst({ where: { clientId: client.id, monthKey } }) : null;
    if (!client || !month) { console.log(`skip ${spec}: not found`); continue; }
    const enr = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { overridesJson: true } });
    const style = asVideoStyle(videoStyleFromOverrides(enr?.overridesJson ?? null));
    const t0 = Date.now();
    const built = await tb.buildMonthBriefs(month.id, { requestedBy: "claude:oct26-brief-eval", unattended: false });
    const cur = await tb.currentBriefs(month.id);
    const chosen = await tb.monthChosenTopics(month.id);
    console.log(`\n== ${name} ${monthKey}: ${built.written} summaries written in ${Math.round((Date.now() - t0) / 1000)} s (run ${built.runId})`);
    const scripts: Record<string, unknown>[] = [];
    for (const t of chosen.topics) {
      const b = cur.byTopic.get(t.id);
      const row = await prisma.contentTopic.findUnique({ where: { id: t.id }, select: { scoresJson: true, pillar: true } });
      const skit = resolvedTopicFormat(topicFormatOf(row?.scoresJson ?? null), style) === "SKIT";
      try {
        const r = await bw.runBriefDraft({ topicId: t.id, monthId: month.id, enrollmentId: month.enrollmentId, clientId: client.id, title: t.title, category: t.pillar, skit,
          requestedBy: "claude:oct26-brief-eval", unattended: false, claimedRun: null, dedupeKey: `eval:brief:${t.id}:${Date.now()}`, scope: { topicId: t.id, monthId: month.id, eval: true }, deadline: null });
        await releaseRunKey(r.runId);
        const o = r.output;
        const words = bw.briefSpokenWords(o, skit);
        console.log(`  ✓ ${t.title} (${skit ? "skit" : "direct"}): ${words} words${r.fit ? ` (first draft ${r.fit.from}, ${r.fit.runIds.length} length pass${r.fit.runIds.length === 1 ? "" : "es"})` : ""}`);
        scripts.push({ topicId: t.id, topic: t.title, skit, words, fit: r.fit, script: o, runId: r.runId });
      } catch (e) {
        console.log(`  - ${t.title}: ${String((e as Error).message).slice(0, 200)}`);
        scripts.push({ topicId: t.id, topic: t.title, skit, error: String((e as Error).message) });
      }
      void b;
    }
    const after = await tb.currentBriefs(month.id);
    out.push({
      client: name, monthKey, monthBriefText: monthBriefText({ opening: after.header?.header?.opening ?? "", mainRequest: after.header?.header?.mainRequest ?? null, held: after.header?.header?.held ?? [], topics: chosen.topics.map((t) => after.byTopic.get(t.id)?.brief).filter((x): x is NonNullable<typeof x> => !!x) }),
      briefs: chosen.topics.map((t) => ({ topicId: t.id, title: t.title, text: after.byTopic.get(t.id)?.text ?? null })), scripts,
    });
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  const runs = await prisma.programAiRun.findMany({ where: { requestedBy: "claude:oct26-brief-eval" }, select: { costCents: true, kind: true } });
  console.log(`\nwritten ${outPath}; AI spend so far by this test: $${(runs.reduce((n, r) => n + (r.costCents ?? 0), 0) / 100).toFixed(2)} over ${runs.length} runs`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
