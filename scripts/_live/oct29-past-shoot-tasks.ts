// ---------------------------------------------------------------------------
// TO-DOS THAT OUTLIVED THEIR SHOOT (Oct 29 2026, Jordan on 6344 Reedland St),
// by "claude: for Jordan". The list for Jordan's go, and the levers after it.
//
//   (no flags)            dry run, read-only (the guard proves it): every task
//                         the rule clears, and the old-looking ones it keeps, with why
//   --apply               close what it clears now (needs Jordan's go)
//   --undo [--apply]      put cleared rows back as they were
//   --switch-on --apply   let the daily cron clear them itself (tasks:past_shoot_sweep)
//   --switch-off --apply  back to counting only
//
// Run: npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-past-shoot-tasks.ts
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const ACTOR = "claude: for Jordan";

(async () => {
  const prisma = await db();
  const { clearPastShootTasks, undoPastShootTasks, SWEEP_SWITCH_KEY, pastShootSweepOn } = await import("../../src/lib/pastShootTasks");
  const { etDate } = await import("../../src/lib/datetime");
  const day = (iso: string | null) => (iso ? etDate(iso).replace(/^\w+, /, "") : "not delivered");

  if (process.argv.includes("--switch-on") || process.argv.includes("--switch-off")) {
    const on = process.argv.includes("--switch-on");
    console.log(`switch ${SWEEP_SWITCH_KEY}: now ${await pastShootSweepOn() ? "ON" : "OFF"}, set to ${on ? "ON" : "OFF"}${APPLY ? "" : " (dry run: not written)"}`);
    if (APPLY) {
      const { putSetting } = await import("../../src/lib/settings");
      await putSetting(SWEEP_SWITCH_KEY, { on }, ACTOR);
    }
    return prisma.$disconnect();
  }

  if (process.argv.includes("--undo")) {
    const r = await undoPastShootTasks({ apply: APPLY, actor: ACTOR });
    console.log(`${r.eligible.length} cleared rows can go back${APPLY ? `; reopened ${r.reopened}` : ""}`);
    for (const e of r.eligible) console.log(`  ${e.id}  ${e.title}`);
    return prisma.$disconnect();
  }

  const r = await clearPastShootTasks(new Date(), { apply: APPLY, actor: ACTOR });
  console.log(`switch is ${await pastShootSweepOn() ? "ON" : "OFF"}`);
  console.log(`open tasks tied to a job whose shoot is past: ${r.rows.length} (by job id ${r.rows.filter((x) => x.link === "id").length}, by the address in the words ${r.rows.filter((x) => x.link === "address").length})`);
  console.log(`\nWOULD CLEAR (${r.clear.length})${APPLY ? `: closed ${r.closed}` : ""}`);
  for (const c of r.clear) {
    console.log(`  ${c.id} | ${c.title} | ${c.personKey ?? "nobody"} | ${c.street} (${c.link}) | shot ${day(c.shootISO)} | delivered ${day(c.deliveredISO)} | ${c.verdict.clear ? c.verdict.rule : ""}: ${c.verdict.why}`);
  }
  const kept = r.rows.filter((x) => !x.verdict.clear);
  const tally = new Map<string, number>();
  for (const k of kept) { const why = k.verdict.why.replace(/ \(.*\)$|"[^"]*"|\b[A-Z0-9][\w.-]* (?:St|Rd|Ave|Ln|Dr|Way|Ct|Pike)\b.*$/g, "").trim(); tally.set(why, (tally.get(why) ?? 0) + 1); }
  console.log(`\nKEPT (${kept.length}), by reason:`);
  for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${why}`);
  console.log(`\nKEPT, each (title | who | job | shot | delivered | why):`);
  for (const k of kept) console.log(`  ${k.id} | ${k.title} | ${k.personKey ?? "nobody"} | ${k.street} (${k.link}, ${k.jobStatus}) | shot ${day(k.shootISO)} | delivered ${day(k.deliveredISO)} | ${k.verdict.why}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
