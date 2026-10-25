export {};
// LIVE ONE-OFF (Oct 24 2026): the first run of the books audit's task sync, so
// Jordan's action items are on his list tonight rather than at tomorrow's cron.
// Same function as the daily step and the Audit tab's button. --apply writes.
import { installNextStubs } from "../_drill/_harness";
installNextStubs();
async function main() {
  const { financeAuditYtd } = await import("../../src/lib/financeAudit");
  const a = await financeAuditYtd();
  for (const x of a.actions) console.log(`- (${x.when}) ${x.title}`);
  if (!process.argv.includes("--apply")) process.exit(0);
  const { syncAuditTasks } = await import("../../src/lib/financeAuditTasks");
  console.log(JSON.stringify(await syncAuditTasks(a.actions)));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
