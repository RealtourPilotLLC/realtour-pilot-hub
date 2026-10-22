// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026): the one-time cleanup of the client facts waiting
// for review (about 870), approved by Jordan with decision 3 of the scripting
// plan: "it should leave out anything that doesn't need to be heard by a seller
// or buyer."
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_live/oct22-fact-cleanup.ts [--apply] [--client <clientId>] [--out <dir>]
//
// Every PROPOSED fact (field reports excepted) is sorted by AI, on the script
// writer's model path (claude-opus-5-5, medium effort, one call per 40 facts
// of one client; roughly $2 to $3 for all of them), into
//   SCRIPT  a buyer or seller should hear it   → accepted, AI context on
//   TEAM    useful to us, not for an audience  → accepted, AI context unchanged
//   DROP    duplicate, stale, wrong, conflict  → left waiting, reason as a note
// (src/lib/scriptWriter/factCleanup.ts has the rules and what changes for the
// other AI features; the report repeats them.)
//
// DRY RUN by default: the model is called (the classification IS the dry run's
// work) and the report and the classifications are written to the output
// folder; the database is only read. Read the report, then run again with
// --apply: it applies exactly the classifications in the folder (no second
// model call for an unchanged fact), one row at a time, compare-and-set, and
// lists any fact somebody changed in between. Safe to stop and run again.
//
// Never run from a builder agent, a drill or a sweep: Jordan (or Claude at his
// word) runs it by hand.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { runFactCleanup, aiClassifier } from "@/lib/scriptWriter/factCleanup";

const SCRATCH = "/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/8965ab24-8365-44d5-af17-c1b185a8a42d/scratchpad";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const outDir = arg("--out") ?? path.join(fs.existsSync(SCRATCH) ? SCRATCH : os.tmpdir(), "fact-cleanup-oct22");
  console.log(`${apply ? "APPLY" : "DRY RUN (nothing in the database changes)"} · output: ${outDir}`);
  const r = await runFactCleanup({
    db: prisma, classify: aiClassifier("ai-cleanup-oct22 (scripts/_live/oct22-fact-cleanup.ts)"), apply, outDir,
    onlyClientId: arg("--client"), log: (s) => console.log(s),
  });
  console.log(`read ${r.total} · sorted ${r.classified} (SCRIPT ${r.counts.SCRIPT}, TEAM ${r.counts.TEAM}, DROP ${r.counts.DROP}) · not sorted ${r.unsorted}`);
  if (apply) console.log(`applied SCRIPT ${r.applied.SCRIPT}, TEAM ${r.applied.TEAM}, DROP notes ${r.applied.DROP}; skipped (changed since sorted) ${r.skippedChanged.length}`);
  console.log(`report: ${r.reportPath}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
