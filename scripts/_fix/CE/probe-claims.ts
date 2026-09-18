// READ-ONLY. Group CE / E3: the three over-claims, each checked against what
// the code and the database actually do.
//
// Run with:  NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/CE/probe-claims.ts
import { readFileSync } from "fs";
import { join } from "path";
import { prisma } from "../../../src/lib/prisma";
import { GENERATION_POLICY } from "../../../src/lib/contentPolicy/policy";
import { makeBlock, validateNewScript, type CanonicalScript } from "../../../src/lib/contentPolicy/scriptFormat";
import { STRUCTURAL_CODES } from "../../../src/lib/contentScripts";

const root = join(__dirname, "..", "..", "..");

function longScript(): CanonicalScript {
  const filler = "This is a sentence of about ten words to pad the length. ";
  const pt = (role: "re-hook" | "build-up" | "payoff", n: number) => ({
    ...makeBlock(filler.repeat(n)), index: 0, role, roleSource: "generated" as const,
  });
  return {
    title: "A long one", titleAsDelivered: null, number: null,
    pillarRef: { pillarId: "p1", pillarName: "Local Area Authority", categoryAsDelivered: "Local Area Authority", secondary: [] },
    hook: makeBlock("Nobody tells you what a pre-approval actually is."),
    points: [pt("re-hook", 6), pt("build-up", 6), pt("payoff", 6)],
    extraSpokenBlocks: [], close: makeBlock("Send me a message and I will walk you through it."), captionCta: null,
    clientId: null, internal: { goal: null, creativeDirection: null, filmingNotes: null, productionNotes: [], placeholders: [], speakerLabels: [], durationStated: null, props: null, otherBlocks: [], contentPillarCheck: null, sourceExcerpts: [], alternateHooks: [] },
    gaps: [], stamp: null, parseWarnings: [],
  };
}

async function main() {
  // --- 1. Pacing enforcement is still only a WARNING, and the question of
  //        whether it should ever hard-block is still open. The comment was
  //        restored; the BEHAVIOUR must be unchanged, which is the point.
  const v = validateNewScript(longScript(), { requirePillar: false });
  const timing = v.findings.find((f) => f.code === "timing.out-of-range");
  console.log("1. pacing enforcement");
  console.log(`   over-length script: ~${v.estimate.seconds}s -> finding ${timing?.code} severity="${timing?.severity}" · validation ok=${v.ok}`);
  console.log(`   STRUCTURAL_CODES (the unoverridable set) has timing.out-of-range: ${STRUCTURAL_CODES.has("timing.out-of-range")}`);
  console.log(`   STRUCTURAL_CODES = ${[...STRUCTURAL_CODES].join(", ")}`);

  // --- 2. "Every place that reads the target reads the constant" — it does not.
  const prompts = readFileSync(join(root, "src/lib/contentPolicy/prompts.ts"), "utf8").split("\n");
  const literals = prompts.map((l, i) => ({ n: i + 1, l })).filter((x) => /20[–-]30\s*s/.test(x.l));
  console.log("\n2. who spells the target out instead of reading it");
  const [lo, hi] = GENERATION_POLICY.timing.targetSec;
  console.log(`   GENERATION_POLICY.timing.targetSec = [${lo}, ${hi}]`);
  for (const x of literals) console.log(`   prompts.ts:${x.n}  ${x.l.trim().slice(0, 150)}`);
  console.log(`   hard-coded occurrences in prompts.ts: ${literals.length} (a change to targetSec would leave ${literals.length === 1 ? "it" : "them"} behind)`);

  // --- 3. An AI revision is written INTERNAL_REVIEW, never DRAFT.
  const gen = readFileSync(join(root, "src/lib/contentGeneration.ts"), "utf8").split("\n");
  console.log("\n3. what a revision is written as");
  const start = gen.findIndex((l) => /export async function reviseScript\b/.test(l));
  const statusIdx = gen.findIndex((l, i) => i > start && /status:\s*"[A-Z_]+"/.test(l));
  console.log(`   contentGeneration.ts:${start + 1}  ${gen[start].trim().slice(0, 120)}`);
  console.log(`   contentGeneration.ts:${statusIdx + 1}  ${/status:\s*"[A-Z_]+"/.exec(gen[statusIdx])?.[0]}   <- what the new version is created as`);
  console.log(`   the word "DRAFT" anywhere in reviseScript's body: ${gen.slice(start, statusIdx + 6).some((l) => /"DRAFT"/.test(l))}`);
  const rows = await prisma.contentScriptVersion.groupBy({ by: ["source", "status"], _count: { _all: true }, where: { source: { in: ["REVISION", "CLIENT_REQUEST"] } } });
  for (const r of rows) console.log(`   live rows: source=${r.source} status=${r.status} -> ${r._count._all} (statuses move on after approval/release; none is DRAFT)`);
  if (!rows.length) console.log("   live rows: none yet with source REVISION / CLIENT_REQUEST");
  await prisma.$disconnect();
}
main();
