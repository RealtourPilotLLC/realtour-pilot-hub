// READ-ONLY PROOF of the four acceptance points for Group E (script length).
// Pure validator calls plus read-only reads of real rows. Writes nothing.
import { prisma } from "../../../src/lib/prisma";
import { validateNewScript, tightenInstruction, estimateSpokenSeconds, GENERATION_POLICY, type ApprovedPillar } from "../../../src/lib/contentPolicy";
import { canonicalFromParts, STRUCTURAL_CODES } from "../../../src/lib/contentScripts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const codes = (fs: { code: string; severity: string }[], sev?: string) => fs.filter((f) => !sev || f.severity === sev).map((f) => f.code);

// A well-formed script, then the same script padded far past 30 s.
const good = {
  title: "Why your list price is not your market value",
  categoryLabel: "Buyer Education & First Steps",
  hook: "Your list price is a guess until the market answers it.",
  points: [
    { role: "re-hook" as const, text: "Most sellers pick a number from a neighbour's sale that never closed at that number." },
    { role: "build-up" as const, text: "We price against what actually closed in the last sixty days, not what is still sitting." },
    { role: "payoff" as const, text: "Price it to the closings and you negotiate from strength instead of chasing the market down." },
  ],
  close: "Ask me what closed on your street this quarter.",
};
const filler = " Here is the thing that nobody tells you about pricing a home in this market and why it matters so much to your bottom line when the offers finally start coming in and you have to decide.";
const longScript = { ...good, points: good.points.map((p) => ({ ...p, text: p.text + filler + filler })) };

async function main() {
  console.log("=== 1. An over-length script is FLAGGED but not REJECTED ===");
  const longCanon = canonicalFromParts(longScript);
  const longEst = estimateSpokenSeconds(longCanon);
  const longVal = validateNewScript(longCanon);
  check("estimate is genuinely over the target", longEst.seconds > GENERATION_POLICY.timing.targetSec[1], `${longEst.seconds}s / ${longEst.words}w vs ${GENERATION_POLICY.timing.targetSec.join("-")}s`);
  check("timing.out-of-range is raised", codes(longVal.findings).includes("timing.out-of-range"));
  check("...at severity warn, never block", longVal.findings.find((f) => f.code === "timing.out-of-range")?.severity === "warn");
  check("validation is OK overall (word count alone is not a rejection)", longVal.ok, `blocking=${JSON.stringify(codes(longVal.findings, "block"))}`);
  check("timing is NOT in STRUCTURAL_CODES (a note can pass it)", !STRUCTURAL_CODES.has("timing.out-of-range"));

  console.log("\n=== 2. The tighten instruction is built from the measured numbers ===");
  const instr = tightenInstruction(longEst);
  check("instruction quotes the measured seconds", instr.includes(`${longEst.seconds} seconds`), instr.slice(0, 80) + "...");
  check("instruction quotes the measured word count", instr.includes(`${longEst.words} spoken words`));
  check("instruction quotes the 20-30s target", instr.includes(`${GENERATION_POLICY.timing.targetSec[0]}–${GENERATION_POLICY.timing.targetSec[1]} second`));
  check("instruction asks for CUTS, not a faster read", /Cut roughly \d+ spoken words/.test(instr) && /not by writing for a faster read/.test(instr));
  check("instruction defends the shape it must not break", /exactly three talking points/.test(instr) && /Keep the hook/.test(instr) && /the close/.test(instr));
  console.log(`  >> ${instr}`);

  // The same builder over a REAL over-length live version's stored numbers.
  const scripts = await prisma.contentScript.findMany({ where: { historical: false }, select: { id: true, title: true, currentVersionId: true } });
  const vs = await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId).filter(Boolean) as string[] }, estimatedSeconds: { gt: GENERATION_POLICY.timing.targetSec[1] } }, select: { id: true, versionNo: true, estimatedSeconds: true, spokenWordCount: true, scriptId: true }, orderBy: { estimatedSeconds: "desc" }, take: 1 });
  if (vs.length) {
    const v = vs[0];
    const real = tightenInstruction({ seconds: v.estimatedSeconds!, words: v.spokenWordCount!, wordsPerSec: GENERATION_POLICY.timing.wordsPerSec, target: GENERATION_POLICY.timing.targetSec });
    check("built from a REAL production row's stored numbers", real.includes(`${v.estimatedSeconds} seconds`) && real.includes(`${v.spokenWordCount} spoken words`), `"${scripts.find((s) => s.id === v.scriptId)?.title.slice(0, 40)}" v${v.versionNo} = ${v.estimatedSeconds}s/${v.spokenWordCount}w`);
  } else check("a real over-length live version exists to build from", false);

  console.log("\n=== 3. Shape failures still cannot be approved AT ALL ===");
  const fourPoints = canonicalFromParts({ ...good, points: [...good.points, { role: null, text: "And one more thing about inspections." }] });
  const noHook = canonicalFromParts({ ...good, hook: "" });
  const noClose = canonicalFromParts({ ...good, close: "" });
  for (const [name, c] of [["four-point script", fourPoints], ["missing hook", noHook], ["missing close", noClose]] as const) {
    const val = validateNewScript(c);
    const blocking = codes(val.findings, "block");
    const unoverridable = blocking.filter((x) => STRUCTURAL_CODES.has(x));
    check(`${name}: blocks`, !val.ok, `blocking=${JSON.stringify(blocking)}`);
    check(`${name}: at least one blocking code is UNOVERRIDABLE (no note can pass it)`, unoverridable.length > 0, `unoverridable=${JSON.stringify(unoverridable)}`);
  }

  console.log("\n=== 4. Pillar membership is checked against the strategy's pillars ===");
  const known: ApprovedPillar[] = [{ id: "p1", name: "Buyer Education & First Steps", status: "ACTIVE", aliases: ["Buyer Education"] }, { id: "p2", name: "Old Pillar", status: "RETIRED", aliases: [] }];
  const stranger = canonicalFromParts({ ...good, categoryLabel: "Commission Transparency" });
  const retired = canonicalFromParts({ ...good, categoryLabel: "Old Pillar" });
  const viaAlias = canonicalFromParts({ ...good, categoryLabel: "Buyer Education / Trust" });
  check("unknown label blocks when the client HAS pillars", codes(validateNewScript(stranger, { approvedPillars: known }).findings, "block").includes("pillar.unknown"));
  check("retired pillar blocks", codes(validateNewScript(retired, { approvedPillars: known }).findings, "block").includes("pillar.retired"));
  check("an alias resolves clean", !codes(validateNewScript(viaAlias, { approvedPillars: known }).findings, "block").length, JSON.stringify(codes(validateNewScript(viaAlias, { approvedPillars: known }).findings)));
  const noPillars = validateNewScript(stranger, { approvedPillars: [] });
  check("client with NO pillars: warns, does not block", noPillars.ok && codes(noPillars.findings, "warn").includes("pillar.no-approved-pillars"), JSON.stringify(codes(noPillars.findings)));
  check("omitting the list keeps the old behaviour", !codes(validateNewScript(stranger).findings, "block").length && codes(validateNewScript(stranger).findings).includes("pillar.unmapped"));
  check("no category at all still blocks as before", codes(validateNewScript(canonicalFromParts({ ...good, categoryLabel: null }), { approvedPillars: known }).findings, "block").includes("pillar.missing"));
  check("pillar codes are OUTSIDE STRUCTURAL_CODES (overridable with a written reason)", !["pillar.missing", "pillar.unknown", "pillar.retired"].some((c) => STRUCTURAL_CODES.has(c)));

  console.log("\n=== 5. What this changes for the live queue ===");
  const pillars = await prisma.contentPillar.findMany({ select: { id: true, name: true, status: true, enrollmentId: true } });
  const aliasRows = await prisma.contentPillarAlias.findMany({ select: { pillarId: true, name: true } });
  const allVs = await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId).filter(Boolean) as string[] } }, select: { id: true, categoryLabel: true, pillarId: true, enrollmentId: true, estimatedSeconds: true, status: true } });
  let nowBlocks = 0, warnsOnly = 0, over = 0;
  for (const v of allVs) {
    const mine: ApprovedPillar[] = pillars.filter((p) => p.enrollmentId === v.enrollmentId).map((p) => ({ id: p.id, name: p.name, status: p.status, aliases: aliasRows.filter((a) => a.pillarId === p.id).map((a) => a.name) }));
    const c = canonicalFromParts({ ...good, categoryLabel: v.categoryLabel, pillarId: v.pillarId });
    const f = validateNewScript(c, { approvedPillars: mine }).findings;
    if (codes(f, "block").some((x) => x.startsWith("pillar."))) nowBlocks++;
    if (codes(f, "warn").includes("pillar.no-approved-pillars")) warnsOnly++;
    if ((v.estimatedSeconds ?? 0) > GENERATION_POLICY.timing.targetSec[1]) over++;
  }
  console.log(`  live current versions=${allVs.length}: pillar-blocking now=${nowBlocks}, warned (client has no pillars)=${warnsOnly}, over-length=${over}`);
  check("no live script is newly hard-blocked by a setup gap it cannot fix", nowBlocks === 0, `${nowBlocks} would block`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
