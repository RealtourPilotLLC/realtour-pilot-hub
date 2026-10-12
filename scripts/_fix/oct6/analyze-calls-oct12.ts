// Oct 12 2026 (Jordan): "I had a call with Janice Pigga and a call with John
// Collins last week, but I don't see that they came through." Runs the call
// analysis for John P. Collins (Oct 6), Janice Pigga (Oct 8) and Joe Sutow
// (Sep 24) as an ATTENDED run — exactly what the "Analyze the call" button does
// (src/lib/callAnalysis.ts: startCallAnalysis claims the call's ANALYZE job,
// runClaimedCallAnalysis runs contentGeneration.analyzeTranscriptText over the
// call's confirmed Drive transcript). It writes PROPOSALS for staff review only:
// PROPOSED topic selections on October, bank ideas, PROPOSED facts, strategy
// proposals, priorities and to-dos on the month; the call → ANALYZED with its
// analysisRunId; the job → SUCCEEDED. Nothing is sent, approved or released.
// About $0.05–$0.12 of AI per call (Sonnet 4.6). A call the hourly processor
// already analysed is skipped (pass --force to analyse it again).
//   set -a; source .env; set +a; NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/analyze-calls-oct12.ts
import { prisma } from "../../../src/lib/prisma";
const CALLS = { "John P. Collins (Oct 6)": "cmuy9eifx00089k0hpsun7y0o", "Janice Pigga (Oct 8)": "cmuscdcvx00tdl5047p2tjmrg", "Joe Sutow (Sep 24)": "cmuy9egvw00059k0hszxmfeho" };
const BY = "info@realtourpilot.com";
(async () => {
  const force = process.argv.includes("--force");
  const { startCallAnalysis, runClaimedCallAnalysis, loadCallTranscripts } = await import("../../../src/lib/callAnalysis");
  for (const [who, id] of Object.entries(CALLS)) {
    const rec = await prisma.programCallRecord.findUnique({ where: { id }, select: { transcriptState: true } });
    if (rec?.transcriptState === "ANALYZED" && !force) { console.log(who, "— already analyzed (skipped; --force to re-run)"); continue; }
    const claim = await startCallAnalysis(id, BY);
    if (!claim.ok) { console.log(who, "— not started:", claim.message); continue; }
    const r = await runClaimedCallAnalysis({ jobId: claim.jobId, callRecordId: id, by: BY, prior: claim.prior });
    const [line] = await loadCallTranscripts({ callRecordIds: [id] });
    const run = r.ok ? await prisma.programAiRun.findUnique({ where: { id: r.runId }, select: { costCents: true, inputTokens: true, outputTokens: true } }) : null;
    console.log(who, "—", r.ok ? `${line?.resultLine} · run ${r.runId} · ${run?.inputTokens} in / ${run?.outputTokens} out · ~${run?.costCents}¢` : `FAILED: ${r.message}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
