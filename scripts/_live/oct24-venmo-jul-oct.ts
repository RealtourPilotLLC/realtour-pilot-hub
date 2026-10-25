export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 24 2026). Jordan sent his Venmo statements for Jul–Oct
// 2026 ("I need to get the finances in order"). Since Jul 17 the bank feed's
// Venmo debits were booked "see Venmo rows" with no Venmo rows behind them.
// Imports each CSV through lib/venmoStatement (the same path as the hub's
// upload). Dry run by default; --apply writes. Paths are argv.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();
const APPLY = process.argv.includes("--apply");
async function main() {
  const { importVenmoStatement } = await import("../../src/lib/venmoStatement");
  for (const path of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    const r = await importVenmoStatement(readFileSync(path, "utf8"), { apply: APPLY });
    console.log(`\n=== ${path.split("/").pop()} — ${r.message}`);
    for (const l of r.lines) console.log(`  ${l.state.padEnd(12)} ${l.date} ${String(l.amount).padStart(9)} ${(l.kind ?? "-").padEnd(8)} ${(l.category ?? "").padEnd(30)} ${l.name.slice(0, 70)}`);
    console.log("  totals:", JSON.stringify(r.totals));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
