// READ-ONLY QuickBooks probe: raw transaction pull 2025-01-01 .. 2026-07-31
import fs from "node:fs";
import { qboQuery } from "@/lib/integrations/quickbooks";

const DIR = "/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/95b4d60d-bf2f-468b-a14f-fa55d05415af/scratchpad";

async function pageAll(entity: string, where: string): Promise<any[]> {
  const all: any[] = [];
  for (let pos = 1; pos < 20000; pos += 1000) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${pos} maxresults 1000`;
    const { rows } = await qboQuery<any>(sql);
    all.push(...rows);
    console.log(`  ${entity} page@${pos}: ${rows.length}`);
    if (rows.length < 1000) break;
  }
  return all;
}

async function main() {
  const W = `TxnDate >= '2025-01-01' and TxnDate <= '2026-07-31'`;

  const out: Record<string, any[]> = {};
  for (const [entity, where] of [
    ["Deposit", W],
    ["Payment", W],
    ["SalesReceipt", W],
    ["Invoice", W],
    ["JournalEntry", W],
    ["Item", ""],
    ["Account", ""],
    ["Customer", ""],
  ] as [string, string][]) {
    console.log("== " + entity);
    try {
      out[entity] = await pageAll(entity, where);
      console.log(`  TOTAL ${entity}: ${out[entity].length}`);
    } catch (e: any) {
      console.log(`  ERROR ${entity}: ${e?.message}`);
      out[entity] = [];
    }
  }

  for (const [k, v] of Object.entries(out)) {
    fs.writeFileSync(`${DIR}/finq_${k}.json`, JSON.stringify(v, null, 1));
  }
  console.log("WROTE files to", DIR);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
