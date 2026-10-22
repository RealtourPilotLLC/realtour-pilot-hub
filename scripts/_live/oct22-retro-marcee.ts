// ---------------------------------------------------------------------------
// LIVE, READ-ONLY EXCEPT AI RUN ROWS (Oct 22 2026): phase 3 of the scripting
// plan, the go / no-go test for the new writer. Marcee McMullen's three
// October scripts are drafted again by the new writer (scriptWriter
// draftOffline), each AS OF the moment its original first draft was made, so
// nothing written after (her later facts, Jordan's edits, her rewrites) can
// leak in. No script, version, portal row or message is written: only the AI
// run records (scope offline). Jordan's finals are read for the side by side
// and never passed to the writer.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_live/oct22-retro-marcee.ts
//
// Writes scratchpad/scripting/${process.env.RETEST_TAG ?? "retro"}-marcee.json for the comparison page.
// ---------------------------------------------------------------------------
import fs from "node:fs";

const OUT = `/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/8965ab24-8365-44d5-af17-c1b185a8a42d/scratchpad/scripting/${process.env.RETEST_TAG ?? "retro"}-marcee.json`;
const CALL = "cmv8f2o7y0096jn068o14hja9"; // the Oct 15 strategy call
const SCRIPTS = [
  { key: "seniors", scriptId: "cmv9qzk720003kw06dj1it0k3" },
  { key: "not2022", scriptId: "cmv9rikuy00mbjy06wrxnmncr" },
  { key: "repairs", scriptId: "cmv9r2gie000jkw06y1atxyrm" },
];

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { draftOffline, partsOfVersion } = await import("../../src/lib/scriptWriter/pipeline");
  const { spokenTextOf } = await import("../../src/lib/scriptWriter/rules");
  const words = (t: string) => t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const out: unknown[] = [];
  for (const s of SCRIPTS) {
    const script = await prisma.contentScript.findUnique({ where: { id: s.scriptId }, select: { id: true, title: true, topicId: true, monthId: true, sharedVersionId: true, currentVersionId: true } });
    if (!script?.topicId) { console.log(s.key, "no script/topic"); continue; }
    const v1 = await prisma.contentScriptVersion.findFirst({ where: { scriptId: script.id }, orderBy: { versionNo: "asc" }, select: { versionNo: true, hook: true, pointsJson: true, close: true, createdAt: true, source: true } });
    const finalId = script.sharedVersionId ?? script.currentVersionId;
    const fin = finalId ? await prisma.contentScriptVersion.findUnique({ where: { id: finalId }, select: { versionNo: true, hook: true, pointsJson: true, close: true, createdAt: true } }) : null;
    if (!v1) continue;
    const asOf = v1.createdAt;
    console.log(`${s.key}: drafting as of ${asOf.toISOString()} ...`);
    const r = await draftOffline({ topicId: script.topicId, monthId: script.monthId, asOf, requestedBy: "claude:retro-oct22", callRecordId: CALL });
    const oldText = spokenTextOf(partsOfVersion(v1));
    const newText = spokenTextOf(r.final.parts);
    const finText = fin ? spokenTextOf(partsOfVersion(fin)) : "";
    out.push({
      key: s.key,
      title: script.title,
      asOf: asOf.toISOString(),
      original: { versionNo: v1.versionNo, parts: partsOfVersion(v1), words: words(oldText) },
      newDraft: { parts: r.final.parts, words: r.final.words, seconds: r.final.seconds, closeType: r.final.closeType, state: r.state, attempts: r.attempts.map((a) => ({ label: a.label, words: a.words, mustFails: a.review?.mustFails ?? [], passed: a.review ? a.review.checks.filter((c) => c.pass).length : null, total: a.review?.checks.length ?? null })), review: r.final.review },
      brief: r.record.brief,
      hooks: (r.prepared as unknown as { hooks?: unknown }).hooks ?? null,
      final: fin ? { versionNo: fin.versionNo, parts: partsOfVersion(fin), words: words(finText) } : null,
    });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`${s.key}: ${r.state}, ${r.final.words} words (original ${words(oldText)}, final ${words(finText)})`);
  }
  console.log("wrote", OUT);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
