// ---------------------------------------------------------------------------
// DRILL oct25-bank-available (Oct 25 2026, Jordan on Connections → Banks: "I
// have a lot more cash in my bank than it says. It says the correct total 4k
// something but showing 799").
//   §1 the rule (lib/bankBalance): a checking/savings account counts its
//      AVAILABLE balance, as the bank's own app leads with it; the posted
//      balance is said beside it when they differ; a card keeps what is owed
//   §2 the dashboard's Cash available and Finance's cash position count it
//   §3 every money read and the Connections card go through the one rule
// Disposable PGlite; nothing leaves the machine.
// @drill-run: conditions=react-server
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5971), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-bank-available" } });
  const c = makeChecker();
  try {
    c.head("§1 · which balance is cash");
    const { cashBalanceOf, postedBesideCash } = await import("@/lib/bankBalance");
    const checking = { type: "depository", currentBalance: 798.69, availableBalance: 4105.02 };
    c.ok("checking counts the available balance (Jordan's ··0942: $4,105.02, not $798.69)", cashBalanceOf(checking) === 4105.02);
    c.ok("…and says the posted balance beside it", postedBesideCash(checking) === 798.69);
    c.ok("no available balance from the bank: the posted one", cashBalanceOf({ type: "depository", currentBalance: 9000, availableBalance: null }) === 9000);
    c.ok("the two within a dollar: nothing said beside it", postedBesideCash({ type: "depository", currentBalance: 500.4, availableBalance: 500 }) === null);
    c.ok("a card keeps what is owed, never its credit line", cashBalanceOf({ type: "credit", currentBalance: 107.96, availableBalance: 2000 }) === 107.96 && postedBesideCash({ type: "credit", currentBalance: 107.96, availableBalance: 2000 }) === null);
    c.ok("no balance at all stays unknown", cashBalanceOf({ type: "depository", currentBalance: null, availableBalance: null }) === null);

    c.head("§2 · the dashboard and Finance count it");
    const { prisma } = await import("@/lib/prisma");
    const now = new Date();
    const item = await prisma.plaidItem.create({ data: { itemId: "isolated-bank", accessTokenEncrypted: "not-a-provider-token", lastSyncedAt: now } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "biz", name: "Jordan", mask: "0942", type: "depository", subtype: "checking", isBusiness: true, currentBalance: 798.69, availableBalance: 4105.02 } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "old", name: "Payroll", mask: "3002", type: "depository", subtype: "checking", isBusiness: true, currentBalance: 0, availableBalance: 0 } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "card", name: "QuicksilverOne", mask: "1686", type: "credit", isBusiness: false, currentBalance: 107.96, availableBalance: 2000 } });
    const od = await import("@/lib/ownerDashboard");
    const f = await od.financialPosition({ now });
    const cash = f.figures.find((x) => x.key === "cash")!;
    c.ok("Cash available is $4,105, the bank's available balance", cash.value === 4105.02 && cash.display === "$4,105", `${cash.value} ${cash.display}`);
    c.ok("…and its line says the posted balance", /\$799 posted/.test(cash.sub ?? ""), cash.sub ?? "");
    const { getCashPosition } = await import("@/lib/finance");
    const pos = await getCashPosition();
    c.ok("Finance's cash position reads the same $4,105.02", pos.bankBalance === 4105.02 && pos.bankLive, String(pos.bankBalance));
    c.ok("…account by account", pos.bankAccounts.some((a) => /0942/.test(a.label) && a.balance === 4105.02), JSON.stringify(pos.bankAccounts));

    c.head("§3 · one rule everywhere");
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of ["src/lib/ownerDashboard.ts", "src/lib/finance.ts", "src/lib/ownerPulse.ts", "src/lib/financeTools.ts", "src/components/connections/PlaidConnect.tsx"]) {
      const src = read(rel);
      c.ok(`${rel} counts cash through cashBalanceOf`, /cashBalanceOf\(/.test(src) && !/reduce\(\(s, \w+\) => s \+ \(\w+\.currentBalance \?\? 0\)/.test(src.replace(/postedValue[^;]+;/, "")));
    }
    c.ok("the Connections card leads with the cash balance", /money\(cashBalanceOf\(a\)\)/.test(read("src/components/connections/PlaidConnect.tsx")));
    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
