// ---------------------------------------------------------------------------
// DRILL: FIXED PAY FOR HARRISON AND JAMES (Oct 22 2026).
//
// Jordan, Oct 22 2026: "Oct 9 pay was the new pay structure." The Oct 9 payday
// paid the Sep 20 to Oct 3 period, so every pay period starting on or after
// Sep 20 2026 is fixed pay for them: the yearly service fee + vehicle ÷ 26 a
// period, no shoot pay, no mileage. Everyone else stays on per-shoot pay.
//
//   1. the terms (lib/payStructure.ts): one payment is $3,076.92 (James) and
//      $2,538.46 (Harrison) to the cent; a partial period by its days; nothing
//      before Sep 20; exact roster name on an active row, nobody else;
//   2. the engine (computePayroll), Sep 20 to Oct 3: James's shoots read
//      "fixed" ($0 shoot pay, $0 mileage, flagged) and James's total is one
//      payment + the adjustment; Harrison has no shoots and is still paid;
//      a near-namesake, Jordan, and the Sep 6 to 19 period stay per shoot;
//      no router call and no mileage row for a fixed day; the oldModel
//      opt-out reproduces the old numbers; creative passes carry no amount;
//   3. Finance → Payroll renders the fixed pay; the P&L sums person.total;
//   4. the statement: service fee, vehicle, shoots without amounts;
//   5. job profit spreads the fixed pay evenly over their jobs;
//   6. the savings view starts Sep 20 and its old side ignores fixed pay;
//   7. who sees it (Oct 27 2026): the owner everything; Harrison and James
//      their OWN fixed pay; the old-vs-new comparison stays the owner's.
//
// ISOLATION: PGlite on 127.0.0.1:7655 (DRILL_PORT overrides); production is
// never opened; every outbound call is fenced (must be 0). Pages and server
// actions are called for real, so it runs like the other page drills: without
// the react-server condition, server-only neutralised.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

type Props = Record<string, unknown>;
async function expand(tree: unknown, names: Set<string>): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map((t) => expand(t, names)));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && names.has(tree.type.name)) return expand(await (tree.type as (p: Props) => unknown)(tree.props), names);
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await expand(v, names)] as const))) };
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  const own = typeof tree.type === "string" ? [] : Object.entries(tree.props).filter(([k, v]) => k !== "className" && k !== "href" && typeof v === "string").map(([, v]) => v as string);
  return [...own, ...Object.entries(tree.props).filter(([k]) => k !== "className").map(([, v]) => textOf(v))].join(" ");
}
function propsOf(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((t) => propsOf(t, name));
  if (!isValidElement<Props>(tree)) return [];
  const mine = typeof tree.type === "function" && tree.type.name === name ? [tree.props] : [];
  return [...mine, ...Object.values(tree.props).flatMap((v) => propsOf(v, name))];
}
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7655), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-fixed-pay" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const ps = await import("@/lib/payStructure");
    const { computePayroll, periodBounds, payPeriodFor, shootPay } = await import("@/lib/payroll");
    const { etAt } = await import("@/lib/datetime");

    // =======================================================================
    c.head("1 · the terms");
    // =======================================================================
    const J = ps.FIXED_PAY.james, H = ps.FIXED_PAY.harrison;
    const jFull = ps.fixedPayInRange(J, "2026-09-20", "2026-10-03");
    const hFull = ps.fixedPayInRange(H, "2026-09-20", "2026-10-03");
    c.ok("James, one whole period: $2,776.92 service fee + $300.00 vehicle = $3,076.92", jFull.serviceFee === 2776.92 && jFull.vehicle === 300 && jFull.total === 3076.92 && jFull.periods.length === 1 && jFull.periods[0].days === 14, JSON.stringify(jFull));
    c.ok("Harrison, one whole period: $2,238.46 + $300.00 = $2,538.46", hFull.serviceFee === 2238.46 && hFull.vehicle === 300 && hFull.total === 2538.46, JSON.stringify(hFull));
    c.ok("…labelled as that pay period", jFull.periodsLabel === "Sep 20 to Oct 3 pay period", jFull.periodsLabel);
    const part = ps.fixedPayInRange(J, "2026-09-20", "2026-09-30");
    c.ok("a partial overlap pays the payment × days ÷ 14 (Sep 20 to 30 = 11 days: $2,181.87 + $235.71)", part.serviceFee === r2((2776.92 * 11) / 14) && part.vehicle === r2((300 * 11) / 14) && part.periods[0].days === 11, JSON.stringify(part));
    const straddle = ps.fixedPayInRange(J, "2026-09-27", "2026-10-10");
    c.ok("a range across two periods takes 7 days of each: one payment in all", straddle.periods.length === 2 && straddle.serviceFee === 2776.92 && straddle.vehicle === 300, JSON.stringify(straddle));
    const before = ps.fixedPayInRange(J, "2026-09-06", "2026-09-19");
    c.ok("a range before Sep 20 (the Sep 6 to 19 period) pays nothing", before.total === 0 && before.periods.length === 0);
    const across = ps.fixedPayInRange(J, "2026-09-01", "2026-09-25");
    c.ok("a range that starts before Sep 20 counts only the fixed-pay days (Sep 20 to 25)", across.periods.length === 1 && across.periods[0].startKey === "2026-09-20" && across.periods[0].days === 6, JSON.stringify(across.periods));
    const year = ps.fixedPayInRange(J, "2026-09-20", "2027-09-18");
    c.ok("26 periods (Sep 20 2026 to Sep 18 2027) = 26 payments", year.periods.length === 26 && year.periods.every((x) => x.days === 14) && year.total === r2(3076.92 * 26), `${year.periods.length} / ${year.total}`);
    console.log(`  (26 payments: James $${year.total} against $80,000 a year, Harrison $${ps.fixedPayInRange(H, "2026-09-20", "2027-09-18").total} against $66,000: cent rounding)`);
    c.ok("the first fixed-pay period is Sep 20, a real pay period start, paid Oct 9", ps.FIXED_PAY_FROM === "2026-09-20" && payPeriodFor("2026-09-20").startKey === "2026-09-20" && payPeriodFor("2026-09-20").payoutKey === "2026-10-09");
    let agree = true;
    for (let i = -60; i < 400; i++) {
      const key = new Date(Date.parse("2026-09-20T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      if (ps.payPeriodStartOf(key) !== payPeriodFor(key).startKey) agree = false;
    }
    c.ok("payStructure's period walk agrees with payroll's payPeriodFor on every day for a year", agree);
    c.ok("fixed-pay days start Sep 20", !ps.isFixedPayDay("2026-09-19") && ps.isFixedPayDay("2026-09-20") && ps.isFixedPayDay("2027-03-01"));
    c.ok("the roster match: exact name, any case and spacing, active rows only",
      ps.fixedPayFor({ name: "James Livingston", active: true })?.key === "james" &&
      ps.fixedPayFor({ name: "  harrison   WELLS ", active: true })?.key === "harrison" &&
      ps.fixedPayFor({ name: "James Livingston", active: false }) === null &&
      ps.fixedPayFor({ name: "James Livingstone", active: true }) === null &&
      ps.fixedPayFor({ name: "James", active: true }) === null &&
      ps.fixedPayFor({ name: "Jordan Spackman", active: true }) === null);
    c.ok("bonus maximums and the first bonus period are in the terms (James $1,500, Harrison $1,000; Sep 25 to Dec 31 2026)", J.bonusMax === 1500 && H.bonusMax === 1000 && ps.FIRST_BONUS_PERIOD.startKey === "2026-09-25" && ps.FIRST_BONUS_PERIOD.endKey === "2026-12-31");
    c.ok("one copy of the terms: paySavings no longer carries its own", !/serviceFee: 72_200|PAY_STRUCTURE/.test(read("src/lib/paySavings.ts")) && /from "@\/lib\/payStructure"/.test(read("src/lib/paySavings.ts")));

    // =======================================================================
    c.head("2 · the engine, Sep 20 to Oct 3 2026 (paid Oct 9)");
    // =======================================================================
    const HOME = { lat: 40.6, lng: -75.4 };
    const tm = (name: string, extra: Record<string, unknown>) =>
      prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${Math.random().toString(36).slice(2, 6)}@oct22-fixed.drill.invalid`, role: "PHOTOGRAPHER", homeLat: HOME.lat, homeLng: HOME.lng, ...extra }, select: { id: true, name: true } });
    const james = await tm("James Livingston", { role: "MANAGER", creativeManager: true, payPercent: 0.3, payFloor: 75, mileageRate: 0.65, homeRadiusMi: 35 });
    const harrison = await tm("Harrison Wells", { payPercent: 0.35, payFloor: 100, mileageRate: 0.67, homeRadiusMi: 35 });
    // An old, deactivated duplicate of Harrison: never fixed pay, never a second payment.
    const oldHarrison = await tm("harrison wells", { active: false, payPercent: 0.35, payFloor: 100 });
    const jordan = await tm("Jordan Spackman", { payPercent: 0.4, payFloor: 0, mileageRate: 0.65, homeRadiusMi: 35 });
    const namesake = await tm("James Livingstone", { payPercent: 0.3, payFloor: 75, mileageRate: 0.65, homeRadiusMi: 35 });
    const agent = await prisma.client.create({ data: { name: "Agent Fixed TEST" }, select: { id: true } });

    let seq = 0;
    const shots: { memberId: string; dayKey: string; lat: number; lng: number }[] = [];
    const shoot = async (who: string, dayKey: string, hour: number, invoice: number) => {
      const at = etAt(dayKey, hour);
      seq++;
      const lat = HOME.lat + seq * 0.01, lng = HOME.lng - seq * 0.01;
      const p = await prisma.project.create({
        data: { clientId: agent.id, title: `${seq} Fixed Lane, Emmaus, PA`, status: "DELIVERED", photographerId: who, shootDate: at, lat, lng, payableInvoice: invoice, price: invoice, debriefSubmittedAt: new Date(at.getTime() + 3_600_000) },
        select: { id: true },
      });
      await prisma.appointment.create({ data: { aryeoId: `oct22-fixed-${seq}`, projectId: p.id, startAt: at, status: "SCHEDULED", assignedToId: who } });
      shots.push({ memberId: who, dayKey, lat, lng });
      return p.id;
    };
    const cacheMiles = async (memberId: string, dayKey: string, miles: number) => {
      const stops = shots.filter((s) => s.memberId === memberId && s.dayKey === dayKey).map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).sort();
      const sig = [`h:${HOME.lat.toFixed(5)},${HOME.lng.toFixed(5)}`, ...stops].join("|");
      await prisma.mileageDay.create({ data: { teamMemberId: memberId, dayKey, miles, stops: stops.length, sig } });
    };
    const hSep15 = await shoot(harrison.id, "2026-09-15", 10, 600); //   period Sep 6 to 19: 35% = $210
    const jSep21 = await shoot(james.id, "2026-09-21", 10, 1000); //      fixed (old: $300 + 80 mi past the radius)
    const jSep23 = await shoot(james.id, "2026-09-23", 10, 200); //       fixed, a day nobody ever routed (old: $75 floor)
    const jordanSep22 = await shoot(jordan.id, "2026-09-22", 10, 500); // 40% = $200
    const nsSep24 = await shoot(namesake.id, "2026-09-24", 10, 300); //   not James: 30% = $90
    await cacheMiles(harrison.id, "2026-09-15", 60);
    await cacheMiles(james.id, "2026-09-21", 150);
    await cacheMiles(jordan.id, "2026-09-22", 50);
    await cacheMiles(namesake.id, "2026-09-24", 40);
    // A mileage correction the owner left on one of James's fixed days: pays nothing, shows nothing.
    await prisma.mileageDay.create({ data: { teamMemberId: james.id, dayKey: "2026-09-25", miles: 0, stops: 0, sig: null, overrideMiles: 120, overrideNote: "old habit" } });
    // A weekend premium Jordan paid as an adjustment, the way it is paid today.
    await prisma.payoutAdjustment.create({ data: { teamMemberId: james.id, label: "Weekend premium", amount: 200, date: etAt("2026-09-27", 12) } });

    const p920 = payPeriodFor("2026-09-20");
    const { start: s920, end: e920 } = periodBounds(p920);
    const rowsBefore = await prisma.mileageDay.count();
    const blockedBefore = fence.blocked.length;
    const people = await computePayroll(s920, e920);
    const routerCalls = fence.blocked.length - blockedBefore;
    const of = (id: string) => people.find((p) => p.member.id === id);
    const jp = of(james.id)!, hp = of(harrison.id), jo = of(jordan.id)!, ns = of(namesake.id)!;

    c.ok("James's two shoots are listed, flagged fixed pay, $0 shoot pay and $0 mileage", jp?.jobs.length === 2 && jp.jobs.every((j) => j.fixedPay === true && j.shootPay === 0 && j.baseShootPay === 0 && j.mileageShare === 0 && j.jobTotal === 0), JSON.stringify(jp?.jobs.map((j) => [j.title, j.fixedPay, j.shootPay, j.mileageShare])));
    c.ok("…the shoots are still the right ones (the owner sees the work)", jp.jobs.map((j) => j.projectId).sort().join() === [jSep21, jSep23].sort().join());
    c.ok("James's fixed block: $2,776.92 + $300.00 = $3,076.92 for the Sep 20 to Oct 3 pay period", jp.fixed?.serviceFee === 2776.92 && jp.fixed.vehicle === 300 && jp.fixed.total === 3076.92 && jp.fixed.periodsLabel === "Sep 20 to Oct 3 pay period" && jp.fixed.annual.total === 80000, JSON.stringify(jp.fixed));
    c.ok("James's total = $3,076.92 + the $200 adjustment = $3,276.92", jp.total === 3276.92 && jp.adjustmentTotal === 200 && jp.shootPayTotal === 0 && jp.mileageTotal === 0, String(jp.total));
    c.ok("no mileage days on James's card (the vehicle amount replaces mileage), not even the leftover correction", jp.days.length === 0, JSON.stringify(jp.days));
    c.ok("no per-shoot warnings on a fixed card (rates, home, map, $0 invoice)", !jp.issues.some((i) => /Pay rates|home address|map location|eligible invoice|Mileage adjustment/.test(i.message)), JSON.stringify(jp.issues));
    c.ok("no router call for the fixed days (the network is fenced)", routerCalls === 0, `${routerCalls}: ${fence.blocked.slice(blockedBefore).join(", ")}`);
    c.ok("…and no mileage day was written for them (Sep 23 stays unrouted)", (await prisma.mileageDay.count()) === rowsBefore && (await prisma.mileageDay.count({ where: { teamMemberId: james.id, dayKey: "2026-09-23" } })) === 0);
    c.ok("Harrison shot nothing this period and is still paid: $2,538.46", hp != null && hp.jobs.length === 0 && hp.fixed?.total === 2538.46 && hp.total === 2538.46, JSON.stringify(hp?.fixed));
    c.ok("…once: the deactivated duplicate row gets no card", people.filter((p) => /harrison/i.test(p.member.name)).length === 1 && !of(oldHarrison.id));
    c.ok("Jordan's own shoot still pays 40% ($200 of $500), no fixed block", jo.fixed === null && jo.jobs.length === 1 && jo.jobs[0].projectId === jordanSep22 && jo.jobs[0].shootPay === 200 && !jo.jobs[0].fixedPay && jo.total === 200, JSON.stringify(jo.jobs[0]));
    c.ok("a near-namesake (James Livingstone) stays per shoot: 30% of $300 = $90", ns.fixed === null && ns.jobs[0]?.projectId === nsSep24 && ns.jobs[0].shootPay === 90 && !ns.jobs[0].fixedPay);
    c.ok("the period total is everyone's total: fixed pay counts in it", r2(people.reduce((s, p) => s + p.total, 0)) === r2(3276.92 + 2538.46 + 200 + 90), String(r2(people.reduce((s, p) => s + p.total, 0))));

    const p906 = payPeriodFor("2026-09-15");
    const { start: s906, end: e906 } = periodBounds(p906);
    const sep6 = await computePayroll(s906, e906);
    const hOld = sep6.find((p) => p.member.id === harrison.id);
    c.ok("the Sep 6 to 19 period is per shoot: Harrison's Sep 15 shoot pays 35% of $600 = $210, no fixed block", p906.startKey === "2026-09-06" && hOld?.fixed === null && hOld.jobs[0]?.projectId === hSep15 && hOld.jobs[0].shootPay === 210 && !hOld.jobs[0].fixedPay, JSON.stringify(hOld?.jobs[0]));
    c.ok("…and James, with no shoots that period, gets no card and no fixed pay", !sep6.some((p) => p.member.id === james.id));

    // The opt-out: the old per-shoot model for the same period (mileage from the cache, so no router).
    const old = await computePayroll(s920, e920, { oldModel: true, cachedMileageOnly: true });
    const jOld = old.find((p) => p.member.id === james.id)!;
    const l21 = jOld.jobs.find((j) => j.projectId === jSep21)!, l23 = jOld.jobs.find((j) => j.projectId === jSep23)!;
    c.ok("oldModel: James is per shoot again, no fixed block, no flags", jOld.fixed === null && jOld.jobs.every((j) => !j.fixedPay));
    c.ok("…30% of $1,000 = $300 and the $75 floor on $200, exactly the per-shoot formula", l21.shootPay === shootPay(1000, 0.3, 75) && l21.shootPay === 300 && l23.shootPay === 75);
    c.ok("…Sep 21 mileage from the cache: (150 - 70) × $0.65 = $52.00; Sep 23 never worked out counts 0", l21.mileageShare === 52 && l23.mileageShare === 0 && jOld.days.find((d) => d.dayKey === "2026-09-23")?.notComputed === true);
    c.ok("…total $300 + $75 + $52 + $200 adjustment = $627", jOld.total === 627, String(jOld.total));
    c.ok("…Harrison (no shoots, no adjustments) has no card on the old model", !old.some((p) => p.member.id === harrison.id));
    c.ok("…Jordan and the namesake are the same on both models", old.find((p) => p.member.id === jordan.id)?.total === 200 && old.find((p) => p.member.id === namesake.id)?.total === 90);

    // Creative passes (My Pay, the shoot pay card) never carry a fixed amount.
    const creative = await computePayroll(s920, e920, { memberId: james.id, forCreativeEyes: true });
    const jc = creative.find((p) => p.member.id === james.id)!;
    c.ok("a creative-eyes pass has no fixed block and no dollar on a fixed shoot", jc.fixed === null && jc.jobs.every((j) => j.fixedPay && j.jobTotal === 0) && jc.total === 200, JSON.stringify({ fixed: jc.fixed, total: jc.total }));
    const hc = await computePayroll(s920, e920, { memberId: harrison.id, forCreativeEyes: true });
    c.ok("…and Harrison, with no shoots, gets no card at all there", hc.length === 0);
    const hOwner = await computePayroll(s920, e920, { memberId: harrison.id });
    c.ok("the owner's pass scoped to Harrison still carries the payment", hOwner.length === 1 && hOwner[0].fixed?.total === 2538.46);
    c.ok("provider fence still closed after the engine passes", fence.blocked.length === 0, fence.blocked.join(", "));

    // =======================================================================
    c.head("3 · Finance → Payroll and the P&L");
    // =======================================================================
    const owner = await prisma.appUser.create({ data: { email: "owner@oct22-fixed.drill.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id }, select: { id: true, email: true, role: true } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const { PayrollTab } = await import("@/components/finance/PayrollTab");
    const tabEl = await PayrollTab({ show: ["payroll"], start: "2026-09-20" });
    const tab = await expand(tabEl, new Set(["PageHeader", "Stat"]));
    const tabText = textOf(tab);
    const cards = propsOf(tab, "PayoutCard") as { person: { member: { id: string }; fixed: { total: number } | null; total: number } }[];
    c.ok("the Payroll tab hands each card its person, fixed block included", cards.length === 4 && cards.find((x) => x.person.member.id === james.id)?.person.fixed?.total === 3076.92 && cards.find((x) => x.person.member.id === harrison.id)?.person.total === 2538.46, String(cards.length));
    c.ok("…shows 'Fixed pay in total' $5,615.38 and the period total $6,105.38", /Fixed pay in total/.test(tabText) && tabText.includes("$5,615.38") && tabText.includes("$6,105.38"), "");
    const card = read("src/components/payouts/PayoutCard.tsx");
    c.ok("the card: 'Fixed pay' with service fee and vehicle, shoots as 'fixed pay', no Edit or Add a shoot for them", /Fixed pay ·/.test(card) && /Service fee/.test(card) && /Vehicle \(replaces mileage\)/.test(card) && /function FixedJobRow/.test(card) && /\{!fixed && \(\s*<div[^>]*>\s*<AddShoot/.test(card));
    c.ok("the salary table stays on the server: the client card never imports payStructure", !/from "@\/lib\/payStructure"/.test(card) &&/^import "server-only";/.test(read("src/lib/payStructure.ts")));
    const finance = read("src/lib/finance.ts");
    c.ok("the P&L's accrued photographer pay sums person.total, so it carries fixed pay", /people\.reduce\(\(s, x\) => s \+ x\.total, 0\)/.test(finance));

    // =======================================================================
    c.head("4 · the statement");
    // =======================================================================
    const { creativeStatementHtml } = await import("@/app/payouts/actions");
    const js = await creativeStatementHtml(james.id, "2026-09-20");
    const html = js.html ?? "";
    const body = html.replace(/<title>[\s\S]*?<\/title>/, "");
    c.ok("James's statement: regular pay with the service fee $2,776.92 and the vehicle $300.00", js.ok && /Regular pay, Sep 20 to Oct 3 pay period/.test(html) && /Service fee<\/td><td class="num">\$2,776\.92/.test(html) && /Vehicle<\/td><td class="num">\$300\.00/.test(html), js.message ?? "");
    c.ok("…the shoots listed without amounts, the adjustment, and the total $3,276.92", /1? ?\d+ Fixed Lane/.test(html) && (html.match(/>Fixed pay</g) ?? []).length === 2 && /Weekend premium/.test(html) && /Total payout<\/span><span>\$3,276\.92/.test(html));
    c.ok("…no shoot pay or mileage rows (the vehicle replaces mileage)", !/<span>Mileage<\/span>/.test(html) && !/<span>Shoot pay<\/span>/.test(html) && !/<th class="num">Mileage/.test(html));
    c.ok("…no em dash in the statement body", !/—/.test(body));
    const hs = await creativeStatementHtml(harrison.id, "2026-09-20");
    c.ok("Harrison's statement with no shoots: regular pay and 'No shoots this period.', total $2,538.46", hs.ok && /\$2,238\.46/.test(hs.html ?? "") && /No shoots this period\./.test(hs.html ?? "") && /Total payout<\/span><span>\$2,538\.46/.test(hs.html ?? ""), hs.message ?? "");
    const jos = await creativeStatementHtml(jordan.id, "2026-09-20");
    c.ok("Jordan's statement keeps the per-shoot table, shoot pay and mileage rows", jos.ok && /<th class="num">Mileage/.test(jos.html ?? "") && /<span>Shoot pay<\/span><span>\$200\.00/.test(jos.html ?? "") && !/Regular pay/.test(jos.html ?? ""));

    // =======================================================================
    c.head("5 · job profit");
    // =======================================================================
    const { jobProfitability } = await import("@/lib/jobProfit");
    const jpf = await jobProfitability(s920, e920);
    const cost = (id: string) => jpf.jobs.find((j) => j.id === id)?.photographerCost;
    c.ok("James's $3,076.92 is spread evenly over their two jobs: $1,538.46 each", cost(jSep21) === 1538.46 && cost(jSep23) === 1538.46, `${cost(jSep21)} / ${cost(jSep23)}`);
    c.ok("…Jordan's and the namesake's jobs keep their own pay ($200, $90)", cost(jordanSep22) === 200 && cost(nsSep24) === 90);
    c.ok("…the window's photographer cost = $3,076.92 + $200 + $90 (Harrison shot nothing here, so that pay has no job to land on)", r2(jpf.photographerCost) === r2(3076.92 + 200 + 90), String(jpf.photographerCost));
    c.ok("…and the page gets its one-line note", jpf.fixedPayNote === "Fixed-pay creatives: their pay is spread evenly across their shoots.");
    const odd = await jobProfitability(etAt("2026-09-21", 0), etAt("2026-09-21", 23));
    c.ok("a one-day window: James's pay for that day (1/14 of a payment) lands on that day's one job", odd.jobs.find((j) => j.id === jSep21)?.photographerCost === r2(r2(2776.92 / 14) + r2(300 / 14)), String(odd.jobs.find((j) => j.id === jSep21)?.photographerCost));

    // =======================================================================
    c.head("6 · the savings view");
    // =======================================================================
    const sv = await import("@/lib/paySavings");
    const s = await sv.computePaySavings({ now: etAt("2026-10-21", 16) });
    const sep = s.months.find((m) => m.monthKey === "2026-09")!;
    const jsv = sep.people.find((p) => p.key === "james")!;
    c.ok("it starts Sep 20, on both sides", s.effectiveKey === "2026-09-20" && sep.fromKey === "2026-09-20" && jsv.new.regular.serviceFee === ps.fixedPayInRange(J, "2026-09-20", "2026-09-30").serviceFee);
    c.ok("its old side is the old model, unchanged by fixed pay: $300 + $75 + $52 for James's September", jsv.old.shootPay === 375 && jsv.old.mileage === 52 && jsv.old.total === 427 && jsv.old.shoots === 2, JSON.stringify({ shootPay: jsv.old.shootPay, mileage: jsv.old.mileage, total: jsv.old.total }));
    c.ok("…and Harrison's Sep 15 shoot (before Sep 20) is on neither side", !s.months.some((m) => m.people.some((p) => p.key === "harrison" && p.old.shoots > 0)));
    c.ok("the page says where it starts", /since the Sep 20 pay period, paid Oct 9/.test(read("src/components/finance/PayStructureTab.tsx")));

    // =======================================================================
    c.head("7 · who sees it (Oct 27 2026)");
    // =======================================================================
    // Jordan, Oct 27 2026: "Only I see old pay and new pay - Harrison and James
    // should see their own pay schedule and amount and bonuses."
    const { payViewFor, payHiddenFor } = await import("@/lib/settings");
    c.ok("Harrison and James see their own fixed pay; the owner everything; a login with nobody linked nothing",
      (await payViewFor({ role: "PHOTOGRAPHER", teamMemberId: harrison.id })) === "fixed"
      && (await payViewFor({ role: "CREATIVE_MANAGER", teamMemberId: james.id })) === "fixed"
      && (await payViewFor({ role: "OWNER", realRole: "OWNER" })) === "owner"
      && (await payHiddenFor({ role: "CREATIVE_MANAGER" })) && (await payHiddenFor({ role: "ADMIN" })));
    c.ok("the deactivated duplicate Harrison row sees none", (await payViewFor({ role: "PHOTOGRAPHER", teamMemberId: oldHarrison.id })) === "none");
    c.ok("the creative surfaces ask the gate first: My Pay, and the shoot pay card",
      /const view = await payViewFor\(me\)/.test(read("src/app/my-pay/page.tsx")) && /if \(await payHiddenFor\(await getCurrentUser\(\)/.test(read("src/components/shoot/ShootPayCard.tsx")));
    c.ok("the old-vs-new comparison (Pay structure tab) stays the owner's", /export async function canSeePaySavings[\s\S]{0,200}me\.realRole === "OWNER" && canSeeMoney\(me\.role\)/.test(read("src/lib/paySavings.ts")) && /if \(!\(await canSeePaySavings\(\)\)\) throw/.test(read("src/lib/paySavings.ts")));
    c.ok("the statement action is owner-only", /export async function creativeStatementHtml[\s\S]{0,200}await requireOwner\(\)/.test(read("src/app/payouts/actions.ts")));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
