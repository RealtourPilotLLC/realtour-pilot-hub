// READ-ONLY QuickBooks probe: monthly cash-basis P&L income, 2025-01 .. 2026-07
import fs from "node:fs";
import { companyInfo, profitAndLoss, quickbooksEnv } from "@/lib/integrations/quickbooks";

const OUT = "/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/95b4d60d-bf2f-468b-a14f-fa55d05415af/scratchpad/finq_pnl_monthly.json";

function monthEnd(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function main() {
  const info = await companyInfo();
  console.log("ENV:", quickbooksEnv(), "COMPANY:", JSON.stringify(info));

  const months: { key: string; start: string; end: string }[] = [];
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 7) break;
      months.push({
        key: `${y}-${String(m).padStart(2, "0")}`,
        start: `${y}-${String(m).padStart(2, "0")}-01`,
        end: monthEnd(y, m),
      });
    }
  }

  const out: any[] = [];
  for (const mo of months) {
    try {
      const pnl = await profitAndLoss(mo.start, mo.end);
      const incomeLines = pnl.lines.filter((l) => /income|revenue/i.test(l.group));
      out.push({
        month: mo.key,
        income: pnl.income,
        expenses: pnl.expenses,
        net: pnl.netIncome,
        lines: pnl.lines,
        incomeLineCount: incomeLines.length,
      });
      console.log(mo.key, "income", pnl.income, "exp", pnl.expenses, "net", pnl.netIncome);
    } catch (e: any) {
      console.log(mo.key, "ERROR", e?.message);
      out.push({ month: mo.key, error: String(e?.message ?? e) });
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ company: info, env: quickbooksEnv(), months: out }, null, 2));
  console.log("WROTE", OUT);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
