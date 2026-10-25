// Oct 24 2026: THE BOOKS AUDIT + VENMO STATEMENTS + STRIPE AT A GLANCE.
// Jordan sent his Jul–Oct Venmo statements, asked to see Stripe's balances
// (incoming, balance, month gross and net) and asked for the year-to-date
// books audited with action items in the hub "now and in the future".
//   §1 Venmo statements, pure: the quote-aware CSV, who each row paid, the
//      balance tie-out, fees
//   §2 Venmo import: writes locked rows, re-importing is safe, the Jan–Jul
//      position-keyed rows are recognised, someone else's statement is refused
//   §3 Stripe month math and the audit's groups
//   §4 audit tasks: open once, money-free, close themselves, reopen if marked
//      done while the problem is still there, never reopen a cancelled one
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=react-server
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);

const CSV = [
  'Account Statement - (@Jordan-Spackman-1) ,,,,,,,,,,,,,,,,,,,,,',
  'Account Activity,,,,,,,,,,,,,,,,,,,,,',
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer',
  ',,,,,,,,,,,,,,,,$0.00,,,,,',
  ',1001,2026-08-03T13:55:06,Payment,Complete,"Shoots, mileage",Jordan Spackman,Harrison Wells,"- $1,500.00",,0,,0,,Visa *2279,,,,,Venmo,,',
  ',1002,2026-08-03T17:20:00,Charge,Complete,"5841 Montrose Pics $275\n5919 N Hutchinson",Jordan Spackman,Stephen Kennedy,+ $550.00,,0,,0,,,Venmo balance,,,,Venmo,,',
  ',1003,2026-08-03T17:21:00,Instant Transfer,Complete,,,,- $550.00,,0,- $9.62,0,,,Visa *2279,,,,Venmo,,',
  ',1004,2026-08-07T21:26:00,Payment,Complete,Kiddos,Jordan Spackman,Katie MacIntyre,- $700.00,,0,,0,,Visa *2279,,,,,Venmo,,',
  ',1005,2026-08-22T22:14:00,Payment,Complete,🍕,Ryan Rosenthal,Jordan Spackman,+ $25.53,,0,,0,,,Venmo balance,,,,Venmo,,',
  ',1006,2026-08-23T01:00:00,Instant Transfer,Complete,,,,- $25.53,,0,- $0.45,0,,,Visa *2279,,,,Venmo,,',
  ',1007,2026-08-24T10:00:00,Payment,Complete,Thanks,Jordan Spackman,Somebody New,- $80.00,,0,,0,,Visa *2279,,,,,Venmo,,',
  ',9DU5X,2026-08-25T21:03:24,Instant Add Funds,Complete,,,,+ $300.00,,0,,0,,Visa *2279,,,,,Venmo,,',
  ',9DU5Y,2026-08-25T21:04:00,Payment,Complete,Payment 2/2,Jordan Spackman,James Livingston,- $300.00,,0,,0,,,,,,,Venmo,,',
  ',,,,,,,,,,,,,,,,,$0.00,$10.07,,$10.07,"In case of errors, call us"',
].join("\n");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5963), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct24-books-audit" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/venmoStatementCore");
    const { prisma } = await import("@/lib/prisma");

    // =====================================================================
    c.head("§1 · Venmo statements, pure");
    // =====================================================================
    const st = core.readStatement(CSV);
    c.ok("reads whose statement it is and every row (a note with a comma and a newline stays one row; letter ids count)", st.owner?.accountId === "venmo-jordan" && st.rows.length === 9 && st.rows[1].note === "5841 Montrose Pics $275 5919 N Hutchinson" && st.rows.some((r) => r.venmoId === "9DU5Y"), `${st.rows.length} rows`);
    c.ok("the statement ties: $0 start, balance-funded rows only, $0 end", core.balanceCheck(st).ok, core.balanceCheck(st).words);
    const known = { clients: new Set(["stephen kennedy"]), creatives: new Set(["harrison wells", "james livingston"]) };
    const d = (id: string) => core.decideRow(st.rows.find((r) => r.venmoId === id)!, st.owner!, known);
    c.ok("Harrison and James: business, creative specialist pay (money out is positive)", d("1001").kind === "BUSINESS" && d("1001").category === "Creative specialist pay" && d("1001").amount === 1500 && d("9DU5Y").kind === "BUSINESS");
    c.ok("Stephen Kennedy's charge: client revenue (money in is negative)", d("1002").kind === "INCOME" && d("1002").category === "Venmo revenue (client)" && d("1002").amount === -550);
    c.ok("Katie: personal, childcare; a friend paying back: not spend", d("1004").category === "Childcare / nanny" && d("1005").kind === "EXCLUDE");
    c.ok("someone the hub doesn't know: REVIEW, never guessed", d("1007").kind === "REVIEW");
    c.ok("a transfer to the bank isn't imported (the bank's deposit carries it); add-funds is a self-transfer", d("1003").kind === null && d("9DU5X").kind === "EXCLUDE");
    const fee = core.feeDecision(st.rows.find((r) => r.venmoId === "1003")!, true);
    const feeFriends = core.feeDecision(st.rows.find((r) => r.venmoId === "1006")!, false);
    c.ok("the transfer fee: business when it moved client money, personal otherwise", fee?.kind === "BUSINESS" && fee.category === "Venmo transfer fees" && feeFriends?.kind === "PERSONAL");
    c.ok("money parsing: '- $1,500.00' → −1500, '+ $25.53' → 25.53", core.money("- $1,500.00") === -1500 && core.money("+ $25.53") === 25.53 && core.money("") === 0);

    // =====================================================================
    c.head("§2 · Venmo import");
    // =====================================================================
    const item = await prisma.plaidItem.create({ data: { itemId: "stmt-venmo", accessTokenEncrypted: "STATEMENT_IMPORT" } as never });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "venmo-jordan", name: "Venmo", mask: "venmo", type: "venmo" } });
    await prisma.client.create({ data: { name: "Stephen Kennedy" } });
    await prisma.teamMember.create({ data: { name: "Harrison Wells", role: "PHOTOGRAPHER" as never, email: "h@audit.invalid" } });
    await prisma.teamMember.create({ data: { name: "James Livingston", role: "MANAGER" as never, email: "j@audit.invalid", creativeManager: true } });
    await prisma.teamMember.create({ data: { name: "Jordan Spackman", role: "PHOTOGRAPHER" as never, email: "o@audit.invalid" } });
    // A July-style row keyed by file position: the same payment must not be added twice.
    await prisma.plaidTransaction.create({ data: { id: "venmo-VenmoStatement_August_2026.csv-4", accountId: "venmo-jordan", amount: 1500, date: new Date("2026-08-03T12:00:00Z"), name: "Venmo → Harrison Wells: Shoots, mileage", financeKind: "BUSINESS", financeCategory: "Creative specialist pay", financeLocked: true } });
    const { importVenmoStatement } = await import("@/lib/venmoStatement");
    const dry = await importVenmoStatement(CSV);
    c.ok("a dry run writes nothing and names what it would add", dry.ok && dry.added === 0 && (await prisma.plaidTransaction.count()) === 1 && /to add/.test(dry.message), dry.message);
    const first = await importVenmoStatement(CSV, { apply: true });
    const rows = await prisma.plaidTransaction.findMany({ where: { accountId: "venmo-jordan" } });
    c.ok("apply: every row it decided is written, locked; the old position-keyed Harrison row is recognised (not doubled)", first.added === rows.length - 1 && rows.every((r) => r.financeLocked) && rows.filter((r) => r.name?.includes("Harrison")).length === 1, `${first.message} · ${rows.length} rows`);
    c.ok("…the fees are their own rows; the unknown payee waits in REVIEW", rows.filter((r) => /fee/.test(r.name ?? "")).length === 2 && rows.some((r) => r.financeKind === "REVIEW" && /Somebody New/.test(r.name ?? "")));
    const again = await importVenmoStatement(CSV, { apply: true });
    c.ok("importing the same month again adds nothing", again.added === 0 && (await prisma.plaidTransaction.count({ where: { accountId: "venmo-jordan" } })) === rows.length, again.message);
    const other = await importVenmoStatement(CSV.replace("@Jordan-Spackman-1", "@someone-else"), { apply: true });
    c.ok("someone else's statement is refused", !other.ok && /someone-else/.test(other.message));
    c.ok("a file that isn't a statement is refused", !(await importVenmoStatement("hello,world")).ok);

    // =====================================================================
    c.head("§3 · Stripe month math and the audit's groups");
    // =====================================================================
    const { summarizeStripeMonth } = await import("@/lib/integrations/stripe");
    const m = summarizeStripeMonth([
      { type: "charge", gross: 1000, fee: 30, net: 970 },
      { type: "payment", gross: 500, fee: 15, net: 485 },
      { type: "refund", gross: -100, fee: 0, net: -100 },
      { type: "financing_paydown", gross: -73.2, fee: 0, net: -73.2 },
      { type: "stripe_fee", gross: -10, fee: 0.6, net: -10.6 },
      { type: "payout", gross: -1200, fee: 12, net: -1212 },
      { type: "advance", gross: 300, fee: 0, net: 300 },
    ]);
    c.ok("gross = charges + payments; net = after fees and refunds; Capital withholding and payouts kept apart", m.gross === 1500 && m.net === 1355 && m.fees === 45 && m.refunds === 100 && m.capitalWithheld === 73.2 && m.paidOut === 1200 && m.billingFees === 10.6 && m.charges === 2, JSON.stringify(m));
    const { groupTotals } = await import("@/lib/financeAuditCore");
    const g = groupTotals({ businessTotal: 500, business: [{ category: "Video editing", sum: 500, count: 2 }], personal: [{ category: "Car payment", sum: 300, count: 1 }, { category: "Groceries", sum: 200, count: 4 }, { category: "Personal taxes", sum: 100, count: 1 }] }, 50, []);
    const by = (k: string) => g.find((x) => x.key === k)!;
    c.ok("groups: car loans and Stripe Capital are debt, taxes are taxes, the rest of personal is living", by("debt").total === 350 && by("taxes").total === 100 && by("living").total === 200 && by("business").total === 500 && by("savings").total === 0);

    // =====================================================================
    c.head("§4 · audit tasks");
    // =====================================================================
    const owner = await prisma.teamMember.findFirst({ where: { name: "Jordan Spackman" } });
    await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: "OWNER", status: "ACTIVE", teamMemberId: owner!.id } });
    const { syncAuditTasks, moneyFree } = await import("@/lib/financeAuditTasks");
    const A = (key: string, title: string) => ({ key, title, why: "why $1,234 matters", how: "Do the thing.", when: "now" as const, dueDays: 3, amount: 1234 });
    const T0 = new Date();
    const s1 = await syncAuditTasks([A("qbp-unrecorded", "Record $4,297 of QuickBooks payments in QuickBooks"), A("tilt", "Upload the Tilt card statements since July")], T0);
    const tasks = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: "finance-audit:" } } });
    c.ok("each action becomes one open task for the owner", s1.opened === 2 && tasks.length === 2 && tasks.every((t) => t.assignedKey === "jordan" && t.status === "OPEN" && t.ownerId === owner!.id && !!t.dueAt));
    c.ok("task text carries no dollar amount (Kyle can see task lists)", tasks.every((t) => !/\$\d/.test(`${t.title} ${t.summary} ${t.description}`)) && tasks.some((t) => t.title === "Record QuickBooks payments in QuickBooks"), tasks.map((t) => t.title).join(" | "));
    c.ok("moneyFree tidies a colon title", moneyFree("Catch QuickBooks up: $160,808 of spending isn't entered") === "Catch QuickBooks up: spending isn't entered");
    const s2 = await syncAuditTasks([A("qbp-unrecorded", "Record $4,297 of QuickBooks payments in QuickBooks"), A("tilt", "Upload the Tilt card statements since July")], T0);
    c.ok("running again opens nothing new", s2.opened === 0 && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "finance-audit:" } } })) === 2);
    const tilt = tasks.find((t) => t.dedupeKey === "finance-audit:tilt")!;
    await prisma.smartTask.update({ where: { id: tilt.id }, data: { status: "COMPLETED", completedAt: new Date(T0.getTime() - 2 * 86_400_000) } });
    const qbp = tasks.find((t) => t.dedupeKey === "finance-audit:qbp-unrecorded")!;
    const s3 = await syncAuditTasks([A("tilt", "Upload the Tilt card statements since July")], T0);
    const after = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: "finance-audit:" } } });
    c.ok("a problem that's gone closes its task by itself, saying so", s3.closed === 1 && after.find((t) => t.id === qbp.id)?.status === "COMPLETED" && /no longer sees/.test(after.find((t) => t.id === qbp.id)?.summary ?? ""));
    c.ok("marked done but still there a day later: reopened", s3.reopened === 1 && after.find((t) => t.id === tilt.id)?.status === "OPEN");
    await prisma.smartTask.update({ where: { id: tilt.id }, data: { status: "CANCELLED" } });
    const s4 = await syncAuditTasks([A("tilt", "Upload the Tilt card statements since July")], T0);
    c.ok("a task you cancelled stays cancelled (that was a decision)", s4.reopened === 0 && s4.opened === 0 && (await prisma.smartTask.findUnique({ where: { id: tilt.id } }))?.status === "CANCELLED");
    c.ok("nothing left the box", fence.blocked.length === 0, JSON.stringify(fence.blocked));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
