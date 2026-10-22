export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, content audit M2): close the program desk tasks
// whose condition no longer holds, with a plain note, by the same pass the
// hourly cron runs from now on (lib/programTaskCloser.closeResolvedProgramTasks).
//
// The audit named six to check:
//   cmvfduquz009wle08pwolqnvp  Erica Walker, "still needs a content session booking" (she is booked)
//   cmv7emwbc00ayjk064uzujb27  Erica Walker, "still needs a planning path"
//   cmv7emwyw00b4jk06dezaikih  Bernadette Rabel, "still needs a planning path"
//   cmv7emx3b00b7jk061w0fjmve  Marcee McMullen, "still needs a planning path"
//   cmvflixcj0001jo077w286wv2  Marcee McMullen, answer-gap follow-up (her script is approved)
//   cmud1igq900qgjs04lykmulln  Joe Sutow, discovery booking (open since Sep 22)
// The dry run prints every open escalation, answer-gap and discovery task with
// its verdict and the evidence; --apply closes the ones whose condition no
// longer holds (the six above and any other the pass finds), nothing else.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-close-stale-tasks.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-close-stale-tasks.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const NAMED = new Set([
  "cmvfduquz009wle08pwolqnvp", "cmv7emwbc00ayjk064uzujb27", "cmv7emwyw00b4jk06dezaikih",
  "cmv7emx3b00b7jk061w0fjmve", "cmvflixcj0001jo077w286wv2", "cmud1igq900qgjs04lykmulln",
]);

async function main() {
  await db();
  const { programTaskVerdicts, closeResolvedProgramTasks, closingNote } = await import("../../src/lib/programTaskCloser");
  const now = new Date();
  const { verdicts } = await programTaskVerdicts({ now });
  console.log(`${verdicts.length} open program tasks checked`);
  for (const v of verdicts) {
    console.log(`${v.holds ? "KEEP " : "CLOSE"} ${NAMED.has(v.taskId) ? "*" : " "} ${v.taskId} [${v.kind}] ${v.title}`);
    console.log(`        ${v.holds ? "still holds: " : closingNote(v.evidence, now)}${v.holds ? v.evidence : ""}`);
  }
  for (const id of NAMED) if (!verdicts.some((v) => v.taskId === id)) console.log(`  * ${id}: not open any more (already closed), nothing to do`);
  const toClose = verdicts.filter((v) => !v.holds);
  console.log(`would close ${toClose.length}, keep ${verdicts.length - toClose.length}`);
  if (!APPLY) process.exit(0);
  const r = await closeResolvedProgramTasks({ now, taskIds: toClose.map((v) => v.taskId) });
  console.log(`closed ${r.closed} (re-checked ${r.checked}; ${r.kept} held on the re-check and were left open)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
