// ---------------------------------------------------------------------------
// DRILL: the books after ··3002 closed (Oct 21 2026, Jordan: "QuickBooks
// should still pull and be categorized … I still have 0942, which I am
// currently using as a business account").
//
//   1. the cutover lives in one place (AppSetting, else 2026-09-06);
//   2. classifyRow, line by line: ··0942 before and after the cutover — Stripe
//      payout and QuickBooks Payments deposits, a transfer to ··4284, a round
//      trip, Stripe payroll funding, a contractor paid by Zelle, an ambiguous
//      charge and an ambiguous deposit staying REVIEW, a loan advance, and
//      ··3002's history unchanged;
//   3. the planner: refunds still follow their merchant;
//   4. scripts/_fix/oct21/reclassify-books.ts on a drill database: the dry
//      run writes nothing and shows the diff, --apply writes only the changed
//      rows under a guard (a row tagged mid-run is left alone), a locked row
//      is never touched, a second run has nothing to do, and the daily
//      categorizer agrees with the script;
//   5. the P&L: ··0942's business spending counts from the cutover, once;
//      owner draws never do; deposits never become revenue;
//   6. how current the books are (railFreshness);
//   7. QuickBooks: one caller at a time, one token refresh per pull, a
//      rotated token never written over a reconnect;
//   8. the QuickBooks ledger's own classifier after the cutover;
//   9. the daily cron pulls and re-sorts QuickBooks again.
//
// ISOLATION: PGlite via the shared harness; Intuit is answered by a faker
// inside the fence, nothing else may leave.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7021);
installNextStubs();

// ---- a fake Intuit, inside the fence ---------------------------------------
const intuit = {
  tokenCalls: 0,
  queryCalls: 0,
  infoCalls: 0,
  /** Held open while set: the token answer waits for it. */
  gate: null as Promise<void> | null,
  /** Runs before the token answer (a reconnect landing mid-refresh). */
  onToken: null as null | (() => Promise<void>),
  invoiceOnce: true,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fence = fenceFetch(async (url) => {
  if (url.startsWith("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer")) {
    intuit.tokenCalls++;
    const n = intuit.tokenCalls;
    if (intuit.gate) await intuit.gate;
    if (intuit.onToken) await intuit.onToken();
    return json({ access_token: `AT-${n}`, refresh_token: `RT-${n}`, expires_in: 3600 });
  }
  if (url.startsWith("https://quickbooks.api.intuit.com/v3/company/drill-realm/companyinfo/")) {
    intuit.infoCalls++;
    return json({ CompanyInfo: { CompanyName: "Drill Books LLC", Id: "1" } });
  }
  if (url.startsWith("https://quickbooks.api.intuit.com/v3/company/drill-realm/query")) {
    intuit.queryCalls++;
    const q = new URL(url).searchParams.get("query") ?? "";
    if (/from Invoice/.test(q) && intuit.invoiceOnce) {
      intuit.invoiceOnce = false;
      return json({ QueryResponse: { Invoice: [{ Id: "inv-1", TotalAmt: 1200, Balance: 0, TxnDate: "2026-10-12", CustomerRef: { name: "Drill Client" }, DocNumber: "1001" }] } });
    }
    return json({ QueryResponse: {} });
  }
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const fc = await import("@/lib/financeCategories");
  const bk = await import("@/lib/bookkeeping");
  const qb = await import("@/lib/integrations/quickbooks");
  const conns = await import("@/lib/integrations/connections");
  const { encryptSecret } = await import("@/lib/integrations/crypto");
  const { etDayKey } = await import("@/lib/datetime");
  const { reclassifyBooks } = await import("../_fix/oct21/reclassify-books");
  try {
    // =======================================================================
    c.head("1 · the cutover, in one place");
    {
      c.ok("the default is the day after ··3002's last line (2026-09-05)", fc.OPERATING_CUTOVER_DEFAULT === "2026-09-06");
      c.ok("parse: a bare date, a JSON-quoted date, {date}", fc.parseOperatingCutover("2026-09-10") === "2026-09-10" && fc.parseOperatingCutover('"2026-09-11"') === "2026-09-11" && fc.parseOperatingCutover('{"date":"2026-09-12"}') === "2026-09-12");
      c.ok("parse: anything that is not a real date falls back to the default", [null, "", "soon", "2026-13-40", "2026-02-30", "{}"].every((v) => fc.parseOperatingCutover(v) === "2026-09-06"));
      c.ok("no setting: operatingCutover() answers the default", (await fc.operatingCutover()) === "2026-09-06");
      await prisma.appSetting.create({ data: { key: fc.OPERATING_CUTOVER_SETTING, value: JSON.stringify("2026-09-10"), updatedBy: "drill" } });
      c.ok("a stored setting wins", (await fc.operatingCutover()) === "2026-09-10");
      await prisma.appSetting.delete({ where: { key: fc.OPERATING_CUTOVER_SETTING } });
      c.ok("isOperatingLine: only ··0942, only from the cutover", fc.isOperatingLine("0942", "2026-09-06") && !fc.isOperatingLine("0942", "2026-09-05") && !fc.isOperatingLine("3002", "2026-10-01") && !fc.isOperatingLine("4284", "2026-10-01") && !fc.isOperatingLine("0942", null));
    }

    // =======================================================================
    c.head("2 · classifyRow: ··0942 before and after the cutover");
    {
      const AFTER = "2026-10-02", BEFORE = "2026-08-20";
      const cases: [string, string, number, string, string, string | null, string, string][] = [
        // label, bank text, amount (+ out / − in), mask, day, plaid detail, kind, category
        ["Stripe payout deposit (cash-in only, never revenue)", "STRIPE TRANSFER ST-X1Y2Z3 REALTOURPILO", -2500, "0942", AFTER, null, "INCOME", "Stripe payout (revenue)"],
        ["QuickBooks Payments settlement", "INTUIT DEPOSIT 7712 QUICKBOOKS", -9000, "0942", AFTER, null, "INCOME", "QuickBooks Payments (revenue)"],
        ["transfer to ··4284 (owner draw: household)", "ONLINE TRANSFER TO XXXXX4284 REF #IB0Q", 1200, "0942", AFTER, null, "EXCLUDE", "Transfer to wife (household)"],
        ["money back from ··4284", "ONLINE TRANSFER FROM XXXXX4284 REF #IB0R", -300, "0942", AFTER, null, "EXCLUDE", "Transfer to wife (household)"],
        ["round trip, out", "ONLINE TRANSFER TO XXXXX7731 REF #IB1A", 2000, "0942", AFTER, null, "EXCLUDE", "Self-transfer (own accounts)"],
        ["round trip, back", "ONLINE TRANSFER FROM XXXXX7731 REF #IB1B", -2000, "0942", AFTER, null, "EXCLUDE", "Self-transfer (own accounts)"],
        ["Stripe payroll funding (counted once, at the Stripe transfer)", "REALTOUR PILOT STRIPE TOPUP", 8000, "0942", AFTER, null, "EXCLUDE", "Stripe funding / top-up"],
        ["Stripe funding, the old descriptor", "WEB PMTS REALTOURPILO PAYROLL", 6000, "0942", AFTER, null, "EXCLUDE", "Stripe funding / top-up"],
        ["contractor paid by Zelle", "ZELLE TO HARRISON WELLS ON 10/02 REF #PP0X", 650, "0942", AFTER, null, "BUSINESS", "Creative specialist pay"],
        ["…the bank's truncated surname", "ZEL TO JAMES LIVINGSTO 10/02", 400, "0942", AFTER, null, "BUSINESS", "Creative specialist pay"],
        ["…the same Zelle BEFORE the cutover stays as it was", "ZELLE TO HARRISON WELLS ON 08/20 REF #PP0Y", 650, "0942", BEFORE, null, "REVIEW", "Other / uncategorized"],
        ["contractor via Venmo stays with the Venmo statement", "VENMO *HARRISON WELLS VISA DIRECT", 650, "0942", AFTER, null, "EXCLUDE", "Venmo (see Venmo rows)"],
        ["nanny by Zelle is personal", "ZELLE TO KATIE MACINTYRE", 450, "0942", AFTER, null, "PERSONAL", "Childcare / nanny"],
        ["Lauren by Zelle is household money moving", "ZELLE TO LAUREN SPACKMAN", 300, "0942", AFTER, null, "EXCLUDE", "Transfer to wife (household)"],
        ["business merchant: the same category ··3002 produced", "LUMA VISUALS INC", 299, "0942", AFTER, null, "BUSINESS", "Video editing"],
        ["…on ··3002 before it closed", "LUMA VISUALS INC", 299, "3002", "2026-08-15", null, "BUSINESS", "Video editing"],
        ["software", "OPENAI *CHATGPT SUBSCR", 20, "0942", AFTER, null, "BUSINESS", "Software & subscriptions"],
        ["personal merchant (owner draw)", "DOORDASH*CHIPOTLE", 45, "0942", AFTER, null, "PERSONAL", "Restaurants & food delivery"],
        ["ambiguous charge stays REVIEW", "POS PURCHASE ACME SUPPLY 1234", 210, "0942", AFTER, null, "REVIEW", "Other / uncategorized"],
        ["…even with a Plaid category: the fallback never mints a business cost", "POS PURCHASE ACME SUPPLY 1234", 210, "0942", AFTER, "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE", "REVIEW", "Other / uncategorized"],
        ["…a Plaid restaurant code is still personal", "SQ *CORNER BISTRO", 30, "0942", AFTER, "FOOD_AND_DRINK_RESTAURANT", "PERSONAL", "Restaurants & food delivery"],
        ["ambiguous deposit stays REVIEW (never guessed as income)", "MOBILE DEPOSIT REF 55190", -1500, "0942", AFTER, null, "REVIEW", fc.DEPOSIT_TO_IDENTIFY],
        ["a Zelle in stays REVIEW", "ZELLE FROM JOHN DOE", -400, "0942", AFTER, null, "REVIEW", fc.DEPOSIT_TO_IDENTIFY],
        ["…the same deposit BEFORE the cutover stays as it was", "MOBILE DEPOSIT REF 55100", -1500, "0942", BEFORE, null, "INCOME", "Deposit / income"],
        ["a loan advance is not income", "STRIPE CAPITAL LOAN ADVANCE", -15533.56, "0942", AFTER, null, "EXCLUDE", "Loan proceeds (not income)"],
        ["…before the cutover it stays as it was", "STRIPE CAPITAL LOAN ADVANCE", -15533.56, "0942", BEFORE, null, "INCOME", "Stripe payout (revenue)"],
        ["a merchant refund nets against its category", "AMAZON.COM REFUND", -25, "0942", AFTER, null, "PERSONAL", "Shopping & household"],
        ["··3002's history: a deposit there is unchanged", "MOBILE DEPOSIT REF 44001", -900, "3002", "2026-08-25", null, "INCOME", "Deposit / income"],
        ["··4284 (Lauren's) is unchanged after the cutover", "MOBILE DEPOSIT REF 44002", -90, "4284", AFTER, null, "INCOME", "Deposit / income"],
        ["with no date a line is read as it always was", "MOBILE DEPOSIT REF 44003", -90, "0942", "", null, "INCOME", "Deposit / income"],
      ];
      for (const [label, name, amount, mask, day, detail, kind, category] of cases) {
        const got = fc.classifyRow(name, amount, mask, detail, { dateKey: day || null, cutoverKey: "2026-09-06" });
        c.ok(`${label}: ${kind} / ${category}`, got.kind === kind && got.category === category, `${got.kind} / ${got.category}`);
      }
      // No BUSINESS verdict anywhere here came from Plaid's own category.
      const fallbackKinds = ["FOOD_AND_DRINK_RESTAURANT", "GENERAL_SERVICES_OTHER", "GENERAL_MERCHANDISE_ELECTRONICS", "ENTERTAINMENT_TV_AND_MOVIES", "TRANSFER_OUT_ACCOUNT_TRANSFER"]
        .map((d) => fc.classifyRow("UNKNOWN MERCHANT 99", 100, "0942", d, { dateKey: "2026-10-02" }).kind);
      c.ok("PLAID_FALLBACK still never produces BUSINESS on the business account", !fallbackKinds.includes("BUSINESS"), fallbackKinds.join(","));
    }

    // =======================================================================
    c.head("3 · the planner: refunds still follow their merchant");
    {
      const base = { categoryDetail: null, merchantName: null, financeKind: null, financeCategory: null, financeLocked: false };
      const at = (k: string) => new Date(`${k}T12:00:00Z`);
      const plan = fc.planPlaidCategories([
        { ...base, id: "p1", name: "CARDINAL CAMERA SUPPLY", amount: 500, date: at("2026-10-01"), mask: "0942" },
        { ...base, id: "p2", name: "CARDINAL CAMERA SUPPLY POS RETURN", amount: -80, date: at("2026-10-03"), mask: "0942" },
        { ...base, id: "p3", name: "BEENVERIFIED POS RETURN", amount: -20, date: at("2026-10-03"), mask: "0942" },
        { ...base, id: "p4", name: "BEENVERIFIED POS RETURN", amount: -20, date: at("2026-08-03"), mask: "3002" },
        // The T-Mobile story: the rules call the phone personal, the owner
        // locked the charge to the business, and the refund follows the owner.
        { ...base, id: "p5", name: "VERIZON WIRELESS PAYMENT", amount: 70, date: at("2026-10-03"), mask: "0942", financeLocked: true, financeKind: "BUSINESS", financeCategory: "Phone (business)" },
        { ...base, id: "p6", name: "VERIZON WIRELESS REFUND", amount: -30, date: at("2026-10-04"), mask: "0942" },
      ], "2026-09-06");
      c.ok("a return from a business vendor nets in that vendor's business category", plan.get("p2")?.kind === "BUSINESS" && plan.get("p2")?.category === "Gear & equipment", JSON.stringify(plan.get("p2")));
      c.ok("a POS return with no matching charge waits in REVIEW in the business account", plan.get("p3")?.kind === "REVIEW" && plan.get("p3")?.category === fc.DEPOSIT_TO_IDENTIFY, JSON.stringify(plan.get("p3")));
      c.ok("…and stays income on ··3002, as before", plan.get("p4")?.kind === "INCOME" && plan.get("p4")?.category === "Deposit / income", JSON.stringify(plan.get("p4")));
      c.ok("an owner-locked charge sets the tag its refund adopts", plan.get("p6")?.kind === "BUSINESS" && plan.get("p6")?.category === "Phone (business)", JSON.stringify(plan.get("p6")));
      c.ok("a locked row is never planned", !plan.has("p5"));
    }

    // =======================================================================
    c.head("4 · the re-classification script on a drill database");
    const ids: Record<string, string> = {};
    {
      const item = await prisma.plaidItem.create({ data: { itemId: "drill-pnc", accessTokenEncrypted: "x", institutionName: "PNC", lastSyncedAt: new Date() } });
      const wifeItem = await prisma.plaidItem.create({ data: { itemId: "drill-pnc-l", accessTokenEncrypted: "x", institutionName: "PNC", lastSyncedAt: new Date() } });
      const stmt = await prisma.plaidItem.create({ data: { itemId: "stmt-venmo-jordan", accessTokenEncrypted: "STATEMENT_IMPORT", institutionName: "Venmo (statements)" } });
      await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "a-0942", mask: "0942", name: "Jordan", type: "depository", isBusiness: true, currentBalance: 1500 } });
      await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "a-3002", mask: "3002", name: "Payroll", type: "depository", isBusiness: true, currentBalance: 0 } });
      await prisma.plaidAccount.create({ data: { plaidItemId: wifeItem.id, accountId: "a-4284", mask: "4284", name: "Spend", type: "depository", isBusiness: false } });
      await prisma.plaidAccount.create({ data: { plaidItemId: stmt.id, accountId: "venmo-jordan", mask: "venmo", name: "Venmo" } });
      const today = etDayKey(new Date());
      let n = 0;
      // stored = what the OLD rules left on the row.
      const line = async (key: string, account: string, day: string, name: string, amount: number, kind: string | null, category: string | null, locked = false) => {
        const id = `drill-${key}-${++n}`;
        ids[key] = id;
        await prisma.plaidTransaction.create({ data: { id, accountId: account, date: new Date(`${day}T12:00:00Z`), name, amount, financeKind: kind, financeCategory: category, financeLocked: locked } });
        return id;
      };
      await line("T1", "a-0942", "2026-09-20", "MOBILE DEPOSIT REF 55190", -1500, "INCOME", "Deposit / income");
      await line("T2", "a-0942", "2026-09-22", "STRIPE TRANSFER ST-X1Y2Z3 REALTOURPILO", -2500, "INCOME", "Stripe payout (revenue)");
      await line("T3", "a-0942", "2026-09-25", "INTUIT DEPOSIT 7712 QUICKBOOKS", -9000, "INCOME", "QuickBooks Payments (revenue)");
      await line("T4", "a-0942", "2026-10-02", "ONLINE TRANSFER TO XXXXX4284 REF #IB0Q", 1200, "EXCLUDE", "Transfer to wife (household)");
      await line("T5", "a-0942", "2026-10-02", "ONLINE TRANSFER TO XXXXX7731 REF #IB1A", 2000, "EXCLUDE", "Self-transfer (own accounts)");
      await line("T6", "a-0942", "2026-10-03", "ONLINE TRANSFER FROM XXXXX7731 REF #IB1B", -2000, "EXCLUDE", "Self-transfer (own accounts)");
      await line("T7", "a-0942", "2026-10-03", "REALTOUR PILOT STRIPE TOPUP", 8000, "REVIEW", "Other / uncategorized");
      await line("T8", "a-0942", "2026-10-04", "ZELLE TO HARRISON WELLS ON 10/04 REF #PP0X", 650, "REVIEW", "Other / uncategorized");
      await line("T9", "a-0942", "2026-10-05", "POS PURCHASE ACME SUPPLY 1234", 210, "REVIEW", "Other / uncategorized");
      await line("T10", "a-0942", "2026-10-06", "LUMA VISUALS INC", 299, "BUSINESS", "Video editing");
      await line("T11", "a-0942", "2026-08-20", "MOBILE DEPOSIT REF 55100", -700, "INCOME", "Deposit / income");
      await line("T12", "a-0942", "2026-08-21", "ZELLE TO HARRISON WELLS ON 08/21 REF #PP0Y", 100, "REVIEW", "Other / uncategorized");
      await line("T13", "a-3002", "2026-08-25", "MOBILE DEPOSIT REF 44001", -900, "INCOME", "Deposit / income");
      await line("T14", "a-0942", "2026-10-07", "MOBILE DEPOSIT REF 55333", -333, "INCOME", "Client check (owner said)", true);
      await line("T15", "a-0942", "2026-10-08", "STRIPE CAPITAL LOAN ADVANCE", -15533.56, "INCOME", "Stripe payout (revenue)");
      await line("T16", "a-0942", "2026-10-09", "DOORDASH*CHIPOTLE", 45, "PERSONAL", "Restaurants & food delivery");
      await line("T17", "a-0942", "2026-10-10", "ZELLE FROM JANE ROE", -250, "INCOME", "Deposit / income");
      await line("T18", "a-0942", "2026-10-11", "LUMA VISUALS INC", 299, null, null);
      await line("T19", "a-0942", today, "ZEL TO JAMES LIVINGSTO", 400, "REVIEW", "Other / uncategorized");
      await line("T20", "a-4284", "2026-10-02", "ONLINE TRANSFER FROM XXXXX0942 REF #IB0Q", -1200, "EXCLUDE", "Self-transfer (own accounts)");
      await line("T21", "a-4284", "2026-10-05", "TARGET 00012", 80, "PERSONAL", "Shopping & household");
      await line("V1", "venmo-jordan", "2026-07-17", "Venmo → Harrison Wells: shoot", 300, "BUSINESS", "Creative specialist pay", true);
      // Card paid from ··0942, before and after it became the business account.
      await line("C1", "a-0942", "2026-08-10", "CAPITAL ONE CRCARDPMT", 300, "EXCLUDE", "Credit-card paydown");
      await line("C2", "a-0942", "2026-10-01", "CAPITAL ONE CRCARDPMT", 200, "EXCLUDE", "Credit-card paydown");
      // Enough of one transition to prove the 15-sample cap.
      for (let i = 0; i < 17; i++) await line(`M${i}`, "a-0942", `2026-10-${String(12 + (i % 8)).padStart(2, "0")}`, `MOBILE DEPOSIT REF 6${String(i).padStart(4, "0")}`, -10, "INCOME", "Deposit / income");

      const snapshot = async () => new Map((await prisma.plaidTransaction.findMany({ select: { id: true, financeKind: true, financeCategory: true, financeLocked: true } })).map((r) => [r.id, `${r.financeKind}|${r.financeCategory}|${r.financeLocked}`]));
      const before = await snapshot();
      const dry = await reclassifyBooks(prisma as unknown as PrismaClient, { apply: false });
      const afterDry = await snapshot();
      c.ok("dry run: writes nothing", dry.wrote === 0 && [...before].every(([id, v]) => afterDry.get(id) === v));
      c.ok("…reads every line, and counts the owner-locked ones apart", dry.scanned === before.size && dry.locked === 2, `${dry.scanned} scanned, ${dry.locked} locked`);
      const tr = (from: string, to: string) => dry.transitions.get(`${from}  →  ${to}`);
      const inTr = (key: string) => [...dry.transitions.values()].some((t) => t.samples.some((s) => s.id === ids[key]));
      const unknownIn = tr("INCOME / Deposit / income", `REVIEW / ${fc.DEPOSIT_TO_IDENTIFY}`);
      c.ok("an unnamed deposit after the cutover: income → REVIEW (T1, T17 and the 17 small ones)", unknownIn?.count === 19, String(unknownIn?.count));
      c.ok("…with at most 15 samples per transition", (unknownIn?.samples.length ?? 0) === 15, String(unknownIn?.samples.length));
      c.ok("Stripe payroll funding: REVIEW → money movement (T7)", tr("REVIEW / Other / uncategorized", "EXCLUDE / Stripe funding / top-up")?.count === 1 && inTr("T7"));
      c.ok("contractors paid by Zelle after the cutover: REVIEW → Creative specialist pay (T8, T19)", tr("REVIEW / Other / uncategorized", "BUSINESS / Creative specialist pay")?.count === 2);
      c.ok("a loan advance: income → not income (T15)", tr("INCOME / Stripe payout (revenue)", "EXCLUDE / Loan proceeds (not income)")?.count === 1 && inTr("T15"));
      c.ok("a never-sorted line gets its merchant's category (T18)", tr("(none) / (none)", "BUSINESS / Video editing")?.count === 1 && inTr("T18"));
      const unchanged = ["T2", "T3", "T4", "T5", "T6", "T9", "T10", "T11", "T12", "T13", "T16", "T20", "T21", "C1", "C2"];
      c.ok("unchanged: payout and QuickBooks deposits, ··4284 transfers, round trips, the ambiguous charge, everything before the cutover, ··3002, ··4284", unchanged.every((k) => !inTr(k)), unchanged.filter(inTr).join(","));
      c.ok("the locked lines are never planned (T14, the Venmo statement row)", !inTr("T14") && !inTr("V1"));
      c.ok("only ··0942 has changes", [...dry.byAccount.keys()].length === 1 && [...dry.byAccount.keys()][0].startsWith("··0942"), [...dry.byAccount.keys()].join(" | "));
      c.ok("net effect: BUSINESS money out +$1,349 (two Zelle contractors, one Luma line); INCOME money in −$17,453.56 (the unnamed deposits and the loan)",
        dry.netByKind.BUSINESS?.out === 1349 && dry.netByKind.BUSINESS?.in === 0 && dry.netByKind.INCOME?.in === -17453.56 && dry.netByKind.REVIEW?.in === 1920, JSON.stringify(dry.netByKind));
      c.ok("5 transitions, 24 changes", dry.transitions.size === 5 && dry.changes === 24, `${dry.transitions.size} / ${dry.changes}`);

      // --apply, with the owner tagging T17 between the plan and the write.
      const run = await reclassifyBooks(prisma as unknown as PrismaClient, {
        apply: true,
        beforeApply: async () => { await prisma.plaidTransaction.update({ where: { id: ids.T17 }, data: { financeKind: "INCOME", financeCategory: "Client payment (owner said)", financeLocked: true } }); },
      });
      const t17 = await prisma.plaidTransaction.findUniqueOrThrow({ where: { id: ids.T17 } });
      c.ok("--apply: a line the owner tagged mid-run is left alone and reported", run.raced.length === 1 && run.raced[0] === ids.T17 && t17.financeCategory === "Client payment (owner said)" && t17.financeLocked, JSON.stringify(run.raced));
      c.ok("…every other planned change is written", run.wrote === 23, String(run.wrote));
      const t14 = await prisma.plaidTransaction.findUniqueOrThrow({ where: { id: ids.T14 } });
      c.ok("…the locked line is untouched", t14.financeKind === "INCOME" && t14.financeCategory === "Client check (owner said)" && t14.financeLocked);
      const t8 = await prisma.plaidTransaction.findUniqueOrThrow({ where: { id: ids.T8 } });
      c.ok("…and the writes do not lock anything (the rules may revisit them)", t8.financeKind === "BUSINESS" && !t8.financeLocked);
      const again = await reclassifyBooks(prisma as unknown as PrismaClient, { apply: true });
      c.ok("a second run has nothing to do", again.changes === 0 && again.wrote === 0, String(again.changes));
      const settled = await snapshot();
      const daily = await fc.categorizeAllPlaid();
      const afterDaily = await snapshot();
      c.ok("the daily categorizer agrees with the script: it changes nothing more", [...settled].every(([id, v]) => afterDaily.get(id) === v), `updated ${daily.updated}`);

      // The daily categorizer on a fresh copy of the old tags lands on the same answer.
      await prisma.plaidTransaction.update({ where: { id: ids.T8 }, data: { financeKind: "REVIEW", financeCategory: "Other / uncategorized" } });
      await prisma.plaidTransaction.update({ where: { id: ids.T1 }, data: { financeKind: "INCOME", financeCategory: "Deposit / income" } });
      await fc.categorizeAllPlaid();
      const daily2 = await snapshot();
      c.ok("…and on its own (the nightly path) it writes the same tags the script did", daily2.get(ids.T8) === settled.get(ids.T8) && daily2.get(ids.T1) === settled.get(ids.T1), `${daily2.get(ids.T8)} · ${daily2.get(ids.T1)}`);
    }

    // =======================================================================
    c.head("5 · the P&L: ··0942's business spending counts from the cutover, once");
    {
      // The Stripe side: a sale, its fee, and the Connect transfer that pays James.
      await prisma.stripeTransaction.create({ data: { id: "txn_drill_charge", type: "charge", gross: 5000, fee: 150, net: 4850, createdAt: new Date("2026-10-03T16:00:00Z") } });
      await prisma.stripeTransaction.create({ data: { id: "txn_drill_transfer", type: "transfer", gross: -400, fee: 0, net: -400, createdAt: new Date("2026-10-04T16:00:00Z"), destination: "acct_1TKG7cRqstgTY1BH" } });
      await prisma.stripeTransaction.create({ data: { id: "txn_drill_payout", type: "payout", gross: -2500, fee: 0, net: -2500, createdAt: new Date("2026-09-21T16:00:00Z") } });
      // QuickBooks Payments: a $9,000 payment, the ledger pulled today.
      await prisma.qboTransaction.create({ data: { qboId: "pay-1", type: "Payment", txnDate: new Date("2026-09-24T12:00:00Z"), amount: 9000, customerName: "Drill Client" } });
      await prisma.connection.create({ data: { provider: "quickbooks", status: "CONNECTED", lastSyncedAt: new Date(), secretEncrypted: encryptSecret("RT-0"), metadata: JSON.stringify({ realmId: "drill-realm", env: "production" }) } });

      const W = ["2026-09-06", "2026-10-20"] as const;
      const cats = await fc.categoryBreakdown(...W);
      const sumOf = (rows: { category: string; sum: number }[], cat: string) => rows.find((r) => r.category === cat)?.sum ?? 0;
      c.ok("business cost = the Zelle contractor + two Luma lines + the Stripe transfer + the Stripe fee = $1,798", Math.abs(cats.businessTotal - 1798) < 0.005, String(cats.businessTotal));
      c.ok("Creative specialist pay = Harrison by Zelle $650 + James by Stripe $400 (the $8,000 funding is not counted again)", Math.abs(sumOf(cats.business, "Creative specialist pay") - 1050) < 0.005, String(sumOf(cats.business, "Creative specialist pay")));
      c.ok("the funding, the transfer to ··4284 and the round trip sit in Excluded", sumOf(cats.excluded, "Stripe funding / top-up") === 8000 && sumOf(cats.excluded, "Transfer to wife (household)") === 1200 && sumOf(cats.excluded, "Self-transfer (own accounts)") === 2000, JSON.stringify(cats.excluded));
      c.ok("personal spending (owner draws) never reaches the business total", cats.personalTotal === 125 && !cats.business.some((r) => r.category === "Restaurants & food delivery"), `${cats.personalTotal}`);
      c.ok("deposits to identify are listed apart, as money in, and never net the spend still to tag", cats.reviewIncoming.length === 1 && Math.abs(cats.reviewIncomingTotal - 1670) < 0.005 && Math.abs(cats.reviewTotal - 210) < 0.005, `${cats.reviewIncomingTotal} in · ${cats.reviewTotal} out`);

      const rev = await bk.revenueByProcessor(...W);
      c.ok("revenue = QuickBooks Payments $9,000 + Stripe $5,000, counted at the processor", rev.total === 14000 && rev.quickbooks === 9000 && rev.stripe === 5000 && rev.quickbooksNote === "", JSON.stringify({ t: rev.total, q: rev.quickbooks, s: rev.stripe, note: rev.quickbooksNote }));
      await prisma.plaidTransaction.create({ data: { id: "drill-extra-payout", accountId: "a-0942", date: new Date("2026-10-06T12:00:00Z"), name: "STRIPE TRANSFER ST-Q9 REALTOURPILO", amount: -3100, financeKind: "INCOME", financeCategory: "Stripe payout (revenue)" } });
      const rev2 = await bk.revenueByProcessor(...W);
      c.ok("another Stripe payout landing in ··0942 changes revenue by $0 (no double count)", rev2.total === rev.total, `${rev.total} → ${rev2.total}`);
      const profit = rev.total - cats.businessTotal;
      c.ok("profit = $14,000 − $1,798", Math.abs(profit - 12202) < 0.005, String(profit));

      const { ownerPulse } = await import("@/lib/ownerPulse");
      const pulse = await ownerPulse();
      const todayKey = etDayKey(new Date());
      const monthCats = await fc.categoryBreakdown(`${todayKey.slice(0, 7)}-01`, todayKey);
      const monthRev = await bk.revenueByProcessor(`${todayKey.slice(0, 7)}-01`, todayKey);
      c.ok("the owner pulse spends exactly what Finance does this month (today's Zelle to James included)", pulse.spendMonth === Math.round(monthCats.businessTotal) && pulse.revenueMonth === Math.round(monthRev.total) && monthCats.business.some((r) => r.category === "Creative specialist pay"), `${pulse.spendMonth} / ${Math.round(monthCats.businessTotal)}`);

      const cards = await fc.cardPaydowns("2026-01-01", "2026-12-31");
      c.ok("a card paid from ··0942 counts as business money only from the cutover", cards.fromBusiness === 200 && cards.fromPersonal === 300, `${cards.fromBusiness} / ${cards.fromPersonal}`);
    }

    // =======================================================================
    c.head("6 · how current the books are");
    {
      const f = await fc.railFreshness();
      const waiting = await prisma.plaidTransaction.count({ where: { date: { gte: new Date(`${f.review.since}T00:00:00Z`) }, OR: [{ financeKind: "REVIEW" }, { financeKind: null }] } });
      c.ok("lines waiting = every REVIEW or unsorted line this year", f.review.lines === waiting && f.review.deposits > 0 && f.review.out > 0, JSON.stringify(f.review));
      c.ok("the bank feed reaches today's line; statement imports are not counted as the feed", f.bank.newest != null && etDayKey(f.bank.newest) === etDayKey(new Date()) && f.bank.erroredItems === 0, f.bank.newest?.toISOString() ?? "null");
      const venmo = f.manual.find((m) => m.mask === "venmo");
      c.ok("the business Venmo statement shows its last date (Jul 17) and how far behind it is", venmo?.newest != null && etDayKey(venmo.newest) === "2026-07-17" && (venmo.daysBehind ?? 0) >= 21, JSON.stringify(venmo));
      c.ok("QuickBooks: entries through Sep 24, pulled today, connected", f.quickbooks != null && etDayKey(f.quickbooks) === "2026-09-24" && f.quickbooksPulledAt != null && f.quickbooksStatus === "CONNECTED");
    }

    // =======================================================================
    c.head("7 · QuickBooks: one caller at a time");
    {
      const lease = () => prisma.appSetting.findUnique({ where: { key: "quickbooks:api-lease" } });
      const secret = () => conns.getSecret("quickbooks");
      let release!: () => void;
      intuit.gate = new Promise<void>((r) => { release = r; });
      const A = qb.syncQuickBooks({ sinceKey: "2026-09-01", by: "drill run A" });
      for (let i = 0; i < 100 && intuit.tokenCalls === 0; i++) await sleep(20);
      c.ok("run A is mid-refresh holding the lease", intuit.tokenCalls === 1 && (await lease()) != null);
      const B = await qb.syncQuickBooks({ sinceKey: "2026-09-01", by: "drill run B" });
      c.ok("run B is refused at once, naming who holds it, and sends nothing", !!B.skipped && /drill run A/.test(B.skipped) && intuit.tokenCalls === 1 && intuit.queryCalls === 0, JSON.stringify(B));
      release();
      intuit.gate = null;
      const a = await A;
      c.ok("run A finishes: one token refresh for all five ledger queries", !a.skipped && a.invoices === 1 && intuit.tokenCalls === 1 && intuit.queryCalls === 5, `${intuit.tokenCalls} token, ${intuit.queryCalls} queries`);
      c.ok("…saves the rotated refresh token", (await secret()) === "RT-1");
      const conn = await prisma.connection.findUniqueOrThrow({ where: { provider: "quickbooks" } });
      c.ok("…releases the lease, stays CONNECTED (B's refusal marked no error)", (await lease()) == null && conn.status === "CONNECTED" && !conn.lastError, `${conn.status} ${conn.lastError ?? ""}`);

      // A reconnect landing while a pull refreshes: the consent screen's token stays.
      intuit.onToken = async () => { await conns.saveSecret("quickbooks", "RT-reconnected", { metadata: { realmId: "drill-realm", env: "production" } }); };
      const r2 = await qb.syncQuickBooks({ sinceKey: "2026-09-01", by: "drill run C" });
      intuit.onToken = null;
      c.ok("a rotated token is never written over a reconnect that landed mid-pull", !r2.skipped && (await secret()) === "RT-reconnected", (await secret()) ?? "null");

      // A lease another caller holds (still live) refuses; an expired one is taken.
      const tokensBefore = intuit.tokenCalls;
      await prisma.appSetting.create({ data: { key: "quickbooks:api-lease", value: JSON.stringify({ owner: "ghost:1", by: "a ghost run", until: new Date(Date.now() + 60_000).toISOString() }) } });
      const g = await qb.syncQuickBooks({ by: "drill run D" });
      c.ok("a live lease held by another caller refuses, with nothing sent", !!g.skipped && /a ghost run/.test(g.skipped) && intuit.tokenCalls === tokensBefore, JSON.stringify(g));
      await prisma.appSetting.update({ where: { key: "quickbooks:api-lease" }, data: { value: JSON.stringify({ owner: "ghost:1", by: "a ghost run", until: new Date(Date.now() - 1000).toISOString() }) } });
      const e = await qb.syncQuickBooks({ sinceKey: "2026-09-01", by: "drill run E" });
      c.ok("an expired lease (a run that died) is taken over", !e.skipped && intuit.tokenCalls === tokensBefore + 1 && (await lease()) == null, JSON.stringify(e));

      // A bare read outside any pull takes a lease of its own, then lets it go.
      const info = await qb.companyInfo();
      c.ok("a bare read (company info) runs inside its own lease and releases it", info?.CompanyName === "Drill Books LLC" && (await lease()) == null && intuit.infoCalls === 1);
      await prisma.appSetting.create({ data: { key: "quickbooks:api-lease", value: JSON.stringify({ owner: "ghost:2", by: "a ghost run", until: new Date(Date.now() + 60_000).toISOString() }) } });
      let busy = false;
      try { await qb.companyInfo(); } catch (err) { busy = err instanceof qb.QuickBooksBusyError; }
      c.ok("…and is refused (QuickBooksBusyError) while another caller holds it", busy && intuit.infoCalls === 1);
      await prisma.appSetting.delete({ where: { key: "quickbooks:api-lease" } });

      const discon = await prisma.connection.update({ where: { provider: "quickbooks" }, data: { status: "DISCONNECTED" } });
      const off = await qb.syncQuickBooks({ by: "drill run F" });
      c.ok("a disconnected QuickBooks is skipped, not an error", !!off.skipped && /not connected/.test(off.skipped) && discon.status === "DISCONNECTED");
      await prisma.connection.update({ where: { provider: "quickbooks" }, data: { status: "CONNECTED" } });
    }

    // =======================================================================
    c.head("8 · the QuickBooks ledger's own classifier after the cutover");
    {
      const row = (type: string, day: string, memo: string, accountName: string | null = null, amount = 500) =>
        ({ qboId: `q-${day}-${memo.length}`, type, txnDate: new Date(`${day}T12:00:00Z`), amount, memo, accountName, customerName: null, linkedCount: 0 });
      const v = (r: ReturnType<typeof row>) => bk.classify(r, [], [], { cutoverKey: "2026-09-06" });
      const toWifeAfter = v(row("Purchase", "2026-10-01", "ONLINE TRANSFER TO XXXXX4284 REF #IB0Q"));
      const toWifeBefore = v(row("Purchase", "2026-08-01", "ONLINE TRANSFER TO XXXXX4284 REF #IB0Q"));
      c.ok("a transfer to ··4284 from the business account is an owner draw, not flagged", toWifeAfter.category === "OWNER_DRAW" && !toWifeAfter.needsReview && toWifeAfter.personal === true, JSON.stringify(toWifeAfter));
      c.ok("…before the cutover it keeps its old treatment (a transfer to confirm)", toWifeBefore.category === "TRANSFER" && toWifeBefore.needsReview, JSON.stringify(toWifeBefore));
      const editAfter = v(row("Purchase", "2026-10-01", "DEBIT CARD PURCHASE XXXXX0942 FRAMEWORK", "Supplies"));
      const editBefore = v(row("Purchase", "2026-08-01", "DEBIT CARD PURCHASE XXXXX0942 FRAMEWORK", "Supplies"));
      c.ok("a purchase mentioning 0942 is a business cost after the cutover", editAfter.category === "OPERATING" && !editAfter.personal, JSON.stringify(editAfter));
      c.ok("…and an owner draw before it, as always", editBefore.category === "OWNER_DRAW", JSON.stringify(editBefore));
      const payout = v(row("Deposit", "2026-10-01", "STRIPE TRANSFER XXXXX0942 ST-Q9"));
      c.ok("a Stripe payout into ··0942 is already counted (no personal detour after the cutover)", payout.category === "ALREADY_COUNTED" && !payout.personal, JSON.stringify(payout));
      const back = v(row("Deposit", "2026-10-01", "ONLINE TRANSFER FROM XXXXX4284 REF #IB0R"));
      c.ok("money back from ··4284 is an owner contribution, not revenue", back.category === "OWNER_CONTRIBUTION" && !back.needsReview, JSON.stringify(back));
      c.ok("a ··0942 deposit before the cutover keeps its detour review", v(row("Deposit", "2026-08-01", "ONLINE TRANSFER FROM XXXXX0942")).category === "TRANSFER");
    }

    // =======================================================================
    c.head("9 · the daily cron pulls and re-sorts QuickBooks again");
    {
      const daily = fs.readFileSync(path.join(process.cwd(), "src/app/api/cron/daily/route.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
      c.ok("booksSync pulls the last 45 days through the lease", /step\("booksSync"[\s\S]*?syncQuickBooks\(\{ sinceKey, by: /.test(daily) && /45 \* 864e5/.test(daily));
      c.ok("booksClassify re-sorts only after a clean pull", /step\("booksClassify"[\s\S]*?categoriseBooks\([\s\S]*?after: "booksSync"/.test(daily));
      c.ok("the bank lines are still sorted after the bank sync", /step\("plaidCategorize"[\s\S]*?after: "plaidSync"/.test(daily));
    }

    c.ok("nothing left the drill (Intuit was answered inside the fence)", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
