// ---------------------------------------------------------------------------
// DRILL: OLD PAY vs NEW PAY, WHAT THE NEW STRUCTURE SAVES (Oct 21 2026).
//
// Jordan: "I want to be able to track how much I am saving monthly with this
// new pay structure ... branding sessions even though they say $0 in aryeo,
// those are tracked on the old payroll at the prices that clients are
// currently paying for the 3 different tiers."
//
//   1. the calendar: company holidays, one premium per appointment, bonus periods;
//   2. session prices: their rate (month to month, contract, paid in full,
//      trial), the list price when no terms, bulk and self-planned labelled;
//   3. a month of normal shoots: the old side is the payroll engine's own pay,
//      mileage included, and the page never calls the router or writes a day;
//      content sessions repriced at their rate / list price, a session the
//      sweep has not linked yet still found, a non-enrolled branding shoot not;
//   4. cleared rates fall back to the rates they had before fixed pay;
//   5. the new side: September from Sep 20 only (Oct 22 2026: the first
//      fixed-pay period, paid Oct 9; it was Sep 25), regular pay as Payroll
//      pays it (1/26 a period, a split period by its days), a
//      weekend premium per appointment, commissions $0, the bonus at most;
//   6. savings: old minus new, both signs, running total, this month so far;
//   7. the guard: only the owner, never Kyle, James, Harrison, an editor, a
//      creative, or the owner previewing someone else; page and loader both.
//
// ISOLATION: PGlite on 127.0.0.1:7647 (DRILL_PORT overrides); production is
// never opened; every outbound call is fenced (must be 0). Finance is rendered
// for real, so it runs like the other page drills: without the react-server
// condition, server-only neutralised.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

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
function hrefs(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(hrefs);
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeof tree.props.href === "string" ? [tree.props.href] : []), ...Object.values(tree.props).flatMap(hrefs)];
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7647), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-pay-savings" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const ps = await import("@/lib/paySavings");
    const { computePayroll, periodBounds } = await import("@/lib/payroll");
    const { etAt } = await import("@/lib/datetime");
    const { default: FinancePage } = await import("@/app/sales/page");

    // =======================================================================
    c.head("1 · the calendar");
    // =======================================================================
    const h = ps.companyHolidayName;
    c.ok("the six company holidays land on their days (2026-27)",
      h("2027-01-01") === "New Year's Day" && h("2027-05-31") === "Memorial Day" && h("2026-07-04") === "Independence Day" &&
      h("2026-09-07") === "Labor Day" && h("2026-11-26") === "Thanksgiving" && h("2026-12-25") === "Christmas");
    c.ok("other days are not holidays (Columbus Day, the day after Thanksgiving)", h("2026-10-12") === null && h("2026-11-27") === null);
    c.ok("a weekend day earns the premium, a weekday does not", ps.premiumReason("2026-10-10") === "Saturday" && ps.premiumReason("2026-09-27") === "Sunday" && ps.premiumReason("2026-10-13") === null);
    c.ok("a holiday on a weekend is ONE reason, so one premium (Christmas 2027 is a Saturday)", ps.premiumReason("2027-12-25") === "Christmas");
    const p0 = ps.bonusPeriodFor("2026-10-05"), q1 = ps.bonusPeriodFor("2027-02-10"), q4 = ps.bonusPeriodFor("2027-11-03");
    c.ok("bonus periods: Sep 25 to Dec 31 2026 (98 days), then calendar quarters", p0.startKey === "2026-09-25" && p0.endKey === "2026-12-31" && p0.days === 98 && q1.label === "Q1 2027" && q1.days === 90 && q4.days === 92, `${p0.days} / ${q1.label} ${q1.days} / ${q4.days}`);

    // =======================================================================
    c.head("2 · what one content session is worth");
    // =======================================================================
    c.ok("list prices are today's month-to-month prices: Starter $1,299, Accelerator $1,699, Pro $3,500",
      ps.TIER_LIST_PRICE.Starter === 1299 && ps.TIER_LIST_PRICE.Accelerator === 1699 && ps.TIER_LIST_PRICE.Pro === 3500, JSON.stringify(ps.TIER_LIST_PRICE));
    const base = { programKind: null, clientSuppliesTopics: false, billingMonths: null };
    const m2m = ps.sessionPriceFor({ ...base, package: "Accelerator", sessionsPerMonth: 1, billingType: "MONTH_TO_MONTH", billingRate: 1599 });
    c.ok("month to month: their $1,599 a month ÷ 1 session", m2m.source === "their rate" && m2m.perSession === 1599);
    const full = ps.sessionPriceFor({ ...base, package: "Pro", sessionsPerMonth: 2, billingType: "PAID_IN_FULL", billingRate: 30846, billingMonths: 12 });
    c.ok("paid in full: $30,846 over 12 months, ÷ 2 sessions = $1,285.25", full.source === "their rate" && full.monthly === 2570.5 && full.perSession === 1285.25, `${full.monthly} / ${full.perSession}`);
    const trial = ps.sessionPriceFor({ ...base, package: "Accelerator", sessionsPerMonth: 1, billingType: "TRIAL", billingRate: 997 });
    c.ok("trial: the one-month price", trial.perSession === 997 && trial.source === "their rate");
    const bulk = ps.sessionPriceFor({ ...base, package: "Pro", sessionsPerMonth: 2, billingType: null, billingRate: null, programKind: "BULK" });
    c.ok("a bulk plan with no billing terms: Pro list price ÷ 2 sessions, labelled list price and bulk plan", bulk.source === "list price" && bulk.perSession === 1750 && bulk.notes.includes("bulk plan"));
    const self = ps.sessionPriceFor({ ...base, package: "Starter", sessionsPerMonth: 1, billingType: "MONTHLY_CONTRACT", billingRate: 1199, billingMonths: 12, clientSuppliesTopics: true });
    c.ok("a self-planned client with terms: their rate, labelled self-planned", self.source === "their rate" && self.perSession === 1199 && self.notes.includes("self-planned"));

    // =======================================================================
    c.head("3 · the fixture: James and Harrison, Sep 20 to Oct 22 2026");
    // =======================================================================
    const HOME = { lat: 40.6, lng: -75.4 };
    const tm = (name: string, extra: Record<string, unknown>) =>
      prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@oct21-savings.drill.invalid`, role: "PHOTOGRAPHER", homeLat: HOME.lat, homeLng: HOME.lng, ...extra }, select: { id: true, name: true } });
    // James keeps the old rates on file; Harrison's percent and floor were cleared after Sep 25.
    const james = await tm("James Livingston", { role: "MANAGER", creativeManager: true, payPercent: 0.3, payFloor: 75, mileageRate: 0.65, homeRadiusMi: 35 });
    const harrison = await tm("Harrison Wells", { payPercent: null, payFloor: null, mileageRate: 0.67, homeRadiusMi: 35 });
    const jordanTm = await tm("Jordan Drill", { payPercent: 0.4, payFloor: 100 });

    const client = (name: string, extra: Record<string, unknown> = {}) => prisma.client.create({ data: { name, ...extra }, select: { id: true, name: true } });
    const agent = await client("Agent One TEST");
    const paidBrand = await client("Paid Brand TEST");
    const enroll = async (name: string, e: Record<string, unknown>, monthKey: string | null) => {
      const cl = await client(name, { socialClient: true, socialPlan: e.package });
      const en = await prisma.contentEnrollment.create({ data: { clientId: cl.id, videosPerMonth: 4, sessionHours: 4, ...e } as never, select: { id: true } });
      const month = monthKey ? await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: cl.id, monthKey, videosOwed: 4 }, select: { id: true } }) : null;
      return { client: cl, monthId: month?.id ?? null };
    };
    const brandRate = await enroll("Brand Rate TEST", { package: "Accelerator", sessionsPerMonth: 1, billingType: "MONTH_TO_MONTH", billingRate: 1599 }, "2026-10");
    const brandFull = await enroll("Brand Full TEST", { package: "Pro", sessionsPerMonth: 2, billingType: "PAID_IN_FULL", billingRate: 30846, billingMonths: 12 }, "2026-10");
    const brandList = await enroll("Brand List TEST", { package: "Starter", sessionsPerMonth: 1 }, "2026-10");
    const brandLate = await enroll("Brand Late TEST", { package: "Accelerator", sessionsPerMonth: 1, billingType: "MONTHLY_CONTRACT", billingRate: 1499, billingMonths: 12 }, null);

    let seq = 0;
    const shots: { memberId: string; dayKey: string; lat: number; lng: number }[] = [];
    const shoot = async (who: string, dayKey: string, hour: number, o: { clientId: string; invoice: number; monthId?: string | null; label?: string }) => {
      const at = etAt(dayKey, hour);
      seq++;
      const lat = HOME.lat + seq * 0.01, lng = HOME.lng - seq * 0.01;
      const p = await prisma.project.create({
        data: {
          clientId: o.clientId, title: `${seq} Drill Lane, Emmaus, PA`, status: "DELIVERED", photographerId: who, shootDate: at,
          lat, lng, payableInvoice: o.invoice, price: o.invoice, contentMonthId: o.monthId ?? null, debriefSubmittedAt: new Date(at.getTime() + 3_600_000),
          ...(o.label ? { deliverables: { create: [{ type: "SOCIAL_REEL", label: o.label }] } } : {}),
        },
        select: { id: true },
      });
      await prisma.appointment.create({ data: { aryeoId: `oct21-savings-${seq}`, projectId: p.id, startAt: at, status: "SCHEDULED", assignedToId: who } });
      shots.push({ memberId: who, dayKey, lat, lng });
      return p.id;
    };
    // James
    await shoot(james.id, "2026-09-20", 10, { clientId: agent.id, invoice: 500 }); //            Sunday, first fixed-pay day: $150 old, $200 premium
    await shoot(james.id, "2026-09-27", 10, { clientId: agent.id, invoice: 300 }); //            Sunday: $90 old, $200 premium
    await shoot(james.id, "2026-10-06", 10, { clientId: agent.id, invoice: 400 }); //            $120
    await shoot(james.id, "2026-10-06", 14, { clientId: agent.id, invoice: 200 }); //            $75 floor
    await shoot(james.id, "2026-10-10", 10, { clientId: agent.id, invoice: 500 }); //            Saturday: $150, $200 premium
    const jRate = await shoot(james.id, "2026-10-13", 10, { clientId: brandRate.client.id, invoice: 0, monthId: brandRate.monthId });
    const jFull = await shoot(james.id, "2026-10-15", 10, { clientId: brandFull.client.id, invoice: 0, monthId: brandFull.monthId });
    await shoot(james.id, "2026-10-16", 10, { clientId: agent.id, invoice: 18000 }); //          $5,400
    await shoot(james.id, "2026-10-22", 10, { clientId: agent.id, invoice: 1000 }); //           tomorrow: not yet
    // Harrison
    const hList = await shoot(harrison.id, "2026-10-07", 10, { clientId: brandList.client.id, invoice: 0, monthId: brandList.monthId });
    await shoot(harrison.id, "2026-10-12", 10, { clientId: agent.id, invoice: 300 }); //         no miles worked out
    const hLate = await shoot(harrison.id, "2026-10-14", 10, { clientId: brandLate.client.id, invoice: 0, label: "Video Accelerator" });
    const hPaid = await shoot(harrison.id, "2026-10-17", 10, { clientId: paidBrand.id, invoice: 800, label: "Branding Shoot" }); // Saturday
    // Jordan shoots too; never in this comparison.
    await shoot(jordanTm.id, "2026-10-08", 10, { clientId: agent.id, invoice: 900 });

    // The miles Payroll already worked out, under the engine's own route
    // signature so /payouts would read them from the cache too.
    const miles: Record<string, number> = {
      [`${james.id}|2026-09-20`]: 80, [`${james.id}|2026-09-27`]: 60, [`${james.id}|2026-10-06`]: 150, [`${james.id}|2026-10-10`]: 60, [`${james.id}|2026-10-13`]: 110,
      [`${james.id}|2026-10-15`]: 70, [`${james.id}|2026-10-16`]: 200,
      [`${harrison.id}|2026-10-07`]: 100, [`${harrison.id}|2026-10-14`]: 70, [`${harrison.id}|2026-10-17`]: 90,
    };
    for (const [key, mi] of Object.entries(miles)) {
      const [memberId, dayKey] = key.split("|");
      const stops = shots.filter((s) => s.memberId === memberId && s.dayKey === dayKey).map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).sort();
      const sig = [`h:${HOME.lat.toFixed(5)},${HOME.lng.toFixed(5)}`, ...stops].join("|");
      await prisma.mileageDay.create({ data: { teamMemberId: memberId, dayKey, miles: mi, stops: stops.length, sig } });
    }
    const rowsBefore = await prisma.mileageDay.count();

    const NOW = etAt("2026-10-21", 16);
    const before = fence.blocked.length;
    const s = await ps.computePaySavings({ now: NOW });
    const routerCalls = fence.blocked.length - before;
    const sep = s.months.find((m) => m.monthKey === "2026-09")!;
    const oct = s.months.find((m) => m.monthKey === "2026-10")!;
    const J = (m: typeof oct) => m.people.find((p) => p.key === "james")!;
    const H = (m: typeof oct) => m.people.find((p) => p.key === "harrison")!;

    // =======================================================================
    c.head("3 · the old side is the payroll engine's own pay");
    // =======================================================================
    c.ok("two months, September and October, October is this month", s.months.map((m) => m.monthKey).join() === "2026-09,2026-10" && s.currentMonth?.monthKey === "2026-10");
    c.ok("only James and Harrison, found on the roster by name", s.people.map((p) => p.name).join() === "James Livingston,Harrison Wells" && s.missing.length === 0);
    // The engine's own OLD-model pass over October, router and all (every day
    // is cached under its real signature). Oct 22 2026: /payouts now pays James
    // fixed pay, so the old side is compared with the oldModel pass.
    const { start: oStart, end: oEnd } = periodBounds({ startKey: "2026-10-01", endKey: "2026-10-21" });
    const engine = (await computePayroll(oStart, oEnd, { memberId: james.id, oldModel: true })).find((p) => p.member.id === james.id)!;
    const fixedEngine = (await computePayroll(oStart, oEnd, { memberId: james.id })).find((p) => p.member.id === james.id)!;
    const jo = J(oct).old;
    const atAryeo = r2(jo.sessions.reduce((n, x) => n + x.atAryeoPrice, 0));
    c.ok("James, October: shoot pay + mileage + the sessions at Aryeo's $0 equals the old-model engine for the same days",
      near(r2(jo.shootPay + jo.mileage + atAryeo), engine.total) && near(jo.mileage, engine.mileageTotal), `${r2(jo.shootPay + jo.mileage + atAryeo)} vs ${engine.total}`);
    c.ok("…shoot pay $5,745 on 4 shoots (120 + 75 floor + 150 + 5,400), mileage $162.50 (80, 40 and 130 miles past the radius at $0.65)", jo.shootPay === 5745 && jo.shoots === 4 && jo.mileage === 162.5, `${jo.shootPay} / ${jo.shoots} / ${jo.mileage}`);
    c.ok("the page never calls the router", routerCalls === 0, String(routerCalls));
    c.ok("…and never writes a mileage day (Harrison's Oct 12 stays unworked)", (await prisma.mileageDay.count()) === rowsBefore && (await prisma.mileageDay.count({ where: { teamMemberId: harrison.id, dayKey: "2026-10-12" } })) === 0);
    c.ok("the old-model engine is unchanged: its days carry no not-computed flag", engine.days.every((d) => !("notComputed" in d)));
    c.ok("…while /payouts' own pass pays James fixed pay for those days (no shoot pay, no mileage)", fixedEngine.fixed != null && fixedEngine.shootPayTotal === 0 && fixedEngine.mileageTotal === 0 && fixedEngine.days.length === 0 && fixedEngine.total === fixedEngine.fixed.total, JSON.stringify(fixedEngine.fixed));

    c.head("3b · content sessions at the tier price");
    const sRate = jo.sessions.find((x) => x.projectId === jRate)!;
    c.ok("Accelerator month to month: priced at their $1,599, James's 30% = $479.70 (Aryeo's $0 would have paid the $75 floor)",
      sRate?.source === "their rate" && sRate.priceUsed === 1599 && sRate.oldPay === 479.7 && sRate.aryeoInvoice === 0 && sRate.atAryeoPrice === 75, JSON.stringify(sRate));
    const sFull = jo.sessions.find((x) => x.projectId === jFull)!;
    c.ok("Pro paid in full: $1,285.25 a session, 30% of it", sFull?.source === "their rate" && sFull.priceUsed === 1285.25 && sFull.oldPay === r2(1285.25 * 0.3) && /paid in full/.test(sFull.terms), JSON.stringify(sFull));
    c.ok("James's branding total is the two sessions", jo.branding === r2(479.7 + r2(1285.25 * 0.3)) && jo.total === r2(jo.shootPay + jo.branding + jo.mileage));
    const ho = H(oct).old;
    const sList = ho.sessions.find((x) => x.projectId === hList)!;
    c.ok("Starter with no billing terms: the $1,299 list price, marked list price, 35% = $454.65", sList?.source === "list price" && sList.priceUsed === 1299 && sList.oldPay === 454.65 && /list price/.test(sList.terms), JSON.stringify(sList));
    const sLate = ho.sessions.find((x) => x.projectId === hLate)!;
    c.ok("a session the sweep has not linked to a month yet is still found, at their $1,499 contract rate", sLate?.source === "their rate" && sLate.priceUsed === 1499 && sLate.oldPay === 524.65 && sLate.notes.includes("not linked to a program month yet"), JSON.stringify(sLate));
    c.ok("a branding shoot for someone not enrolled keeps its Aryeo invoice ($800 → $280), not a session", !ho.sessions.some((x) => x.projectId === hPaid) && ho.shootPay === r2(105 + 280) && ho.shoots === 2, `${ho.shootPay} / ${ho.shoots}`);

    c.head("4 · cleared rates fall back to the rates they had before fixed pay");
    const hr = s.people.find((p) => p.key === "harrison")!.rates;
    const jr = s.people.find((p) => p.key === "james")!.rates;
    c.ok("Harrison's cleared percent and floor read as 35% / $100, and say so", hr.payPercent === 0.35 && hr.payFloor === 100 && !hr.fromProfile && hr.fellBack.join() === "percent,floor" && hr.mileageRate === 0.67);
    c.ok("James's rates come from their team profile", jr.fromProfile && jr.payPercent === 0.3 && jr.payFloor === 75);
    c.ok("Harrison's mileage: $20.10 + $13.40, and 1 day not computed (counted 0)", ho.mileage === 33.5 && ho.notComputedDays === 1 && s.notComputedDays === 1, `${ho.mileage} / ${ho.notComputedDays}`);

    // =======================================================================
    c.head("5 · the new side");
    // =======================================================================
    const js = J(sep);
    // Oct 22 2026: both sides start with the first fixed-pay period, Sep 20 (was Sep 25).
    c.ok("September counts from Sep 20: 11 days, the Sep 20 shoot counted ($150 + $90)", sep.fromKey === "2026-09-20" && sep.toKey === "2026-09-30" && sep.days === 11 && js.old.shoots === 2 && js.old.shootPay === 240, `${sep.fromKey} ${sep.days} ${js.old.shoots} ${js.old.shootPay}`);
    // One payment = the yearly amount ÷ 26 to the cent; Sep 20 to 30 is 11 of the period's 14 days.
    const reg = (annualPart: number, days: number) => r2((r2(annualPart / 26) * days) / 14);
    c.ok("James, September: regular pay = 11/14 of one payment ($2,776.92 + $300.00)", js.new.regular.serviceFee === reg(72200, 11) && js.new.regular.vehicle === reg(7800, 11) && js.new.regular.total === r2(reg(72200, 11) + reg(7800, 11)), JSON.stringify(js.new.regular));
    c.ok("…two Sunday appointments add $200 each (assumed approved)", js.new.premiums.count === 2 && js.new.premiums.total === 400 && js.new.premiums.appointments.every((a) => a.why === "Sunday"));
    c.ok("…bonus at most = $1,500 ÷ 98 × 6: Sep 20 to 24 are before the first bonus period", js.new.bonusAtMost.total === r2((1500 / 98) * 6) && js.new.bonusAtMost.periodDays === 98 && js.new.bonusAtMost.max === 1500 && js.new.bonusAtMost.days === 6);
    c.ok("…commissions $0, not tracked", js.new.commissions.total === 0 && js.new.commissions.tracked === false);
    c.ok("October counts through today: 21 days, tomorrow's shoot not in", oct.days === 21 && oct.toKey === "2026-10-21" && J(oct).old.shoots === 4);
    c.ok("James, October: one Saturday appointment, $200", J(oct).new.premiums.count === 1 && J(oct).new.premiums.appointments[0]?.dayKey === "2026-10-10");
    c.ok("Harrison, October: one Saturday appointment, $200; bonus at most $1,000 ÷ 98 × 21",
      H(oct).new.premiums.count === 1 && H(oct).new.premiums.total === 200 && H(oct).new.bonusAtMost.total === r2((1000 / 98) * 21));
    c.ok("Harrison, September: regular pay and the bonus ceiling with no shoots", H(sep).old.total === 0 && H(sep).new.total === r2(reg(58200, 11) + reg(7800, 11) + r2((1000 / 98) * 6)), String(H(sep).new.total));
    const octReg = (annualPart: number) => r2(reg(annualPart, 3) + r2(annualPart / 26) + reg(annualPart, 4));
    c.ok("James, October: 3 days of the Sep 20 period + the whole Oct 4 period + 4 days of the Oct 18 period", J(oct).new.regular.serviceFee === octReg(72200) && J(oct).new.regular.vehicle === octReg(7800), JSON.stringify(J(oct).new.regular));
    c.ok("no mileage on the new side: its parts are regular + premiums + commissions + bonus", s.months.every((m) => m.people.every((p) => near(p.new.total, p.new.regular.total + p.new.premiums.total + p.new.commissions.total + p.new.bonusAtMost.total))));

    // =======================================================================
    c.head("6 · savings");
    // =======================================================================
    c.ok("savings = old - new for every person and month", s.months.every((m) => m.people.every((p) => p.savings === r2(p.old.total - p.new.total)) && m.savings === r2(m.old - m.new)));
    c.ok("September cost more on the new pay (James did two small shoots): negative savings", js.savings < 0 && sep.savings < 0, `${js.savings} / ${sep.savings}`);
    c.ok("October, James saved (the $18,000 job alone was $5,400 of old pay)", J(oct).savings > 0, String(J(oct).savings));
    c.ok("the running total ends at the total since Sep 20", oct.runningSavings === s.totals.savings && sep.runningSavings === sep.savings && s.totals.savings === r2(s.totals.old - s.totals.new));
    c.ok("per person totals add up to the month totals", near(s.people.reduce((n, p) => n + p.old, 0), s.totals.old) && near(s.people.reduce((n, p) => n + p.new, 0), s.totals.new));
    console.log(`\n  since Sep 20: old ${s.totals.old}, new ${s.totals.new}, saved ${s.totals.savings}; October so far ${oct.savings}\n`);

    // =======================================================================
    c.head("7 · only the owner");
    // =======================================================================
    const user = (email: string, name: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra }, select: { id: true, email: true, role: true } });
    const owner = await user("owner@oct21-savings.drill.invalid", "Jordan Drill", "OWNER", { teamMemberId: jordanTm.id });
    const kyle = await user("kyle@oct21-savings.drill.invalid", "Kyle Drill", "ADMIN", { permissions: JSON.stringify({ sales: true }) });
    const jamesLogin = await user("james@oct21-savings.drill.invalid", "James Livingston", "ADMIN", { teamMemberId: james.id, permissions: JSON.stringify({ sales: true, "my-pay": true }) });
    const harrisonLogin = await user("harrison@oct21-savings.drill.invalid", "Harrison Wells", "PHOTOGRAPHER", { teamMemberId: harrison.id });
    const editor = await user("editor@oct21-savings.drill.invalid", "Editor Drill", "EDITOR");
    const creative = await user("creative@oct21-savings.drill.invalid", "Creative Drill", "CREATIVE");
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const loaderRefuses = async () => { try { await ps.ownerPaySavings({ now: NOW }); return false; } catch (e) { return /Only the owner/.test((e as Error).message); } };
    const pageRefuses = async () => {
      try {
        const el = await FinancePage({ searchParams: Promise.resolve({ tab: "paystructure" }) });
        if (isValidElement<Props>(el) && typeof el.type === "function") await (el.type as (p: Props) => unknown)(el.props);
        return { refused: false, where: "rendered" };
      } catch (e) {
        return e instanceof Redirect ? { refused: !/paystructure/.test(e.href), where: e.href } : { refused: /Only the owner/.test((e as Error).message), where: (e as Error).message };
      }
    };
    for (const [label, u] of [["Kyle (ADMIN, with a Finance grant)", kyle], ["James (ADMIN, with Finance and My Pay grants)", jamesLogin], ["Harrison (PHOTOGRAPHER)", harrisonLogin], ["an EDITOR", editor], ["a CREATIVE", creative]] as const) {
      await signIn(u);
      const page = await pageRefuses();
      c.ok(`${label}: the page refuses (${page.where}) and so does the loader`, page.refused && (await loaderRefuses()));
    }
    await clearSession();
    c.ok("signed out (auth on): the loader refuses, and the page sends them to sign in", (await loaderRefuses()) && /\/login/.test((await pageRefuses()).where));
    await signIn(owner, harrisonLogin.id);
    const preview = await pageRefuses();
    c.ok("the owner previewing Harrison sees what Harrison sees: refused, page and loader", preview.refused && (await loaderRefuses()), preview.where);
    await signIn(kyle);
    const kyleUnpaid = await FinancePage({ searchParams: Promise.resolve({ tab: "unpaid" }) });
    const kyleTree = isValidElement<Props>(kyleUnpaid) ? await expand(await (kyleUnpaid.type as (p: Props) => unknown)(kyleUnpaid.props), new Set(["FinanceTabs"])) : null;
    c.ok("Kyle's Finance tab bar has no Pay structure link", !hrefs(kyleTree).includes("/sales?tab=paystructure") && !/Pay structure/.test(textOf(kyleTree)));

    await signIn(owner);
    c.ok("the owner's loader answers", !(await loaderRefuses()));
    const el = await FinancePage({ searchParams: Promise.resolve({ tab: "paystructure" }) });
    const ownerTree = isValidElement<Props>(el)
      ? await expand(await (el.type as (p: Props) => unknown)(el.props), new Set(["PageHeader", "FinanceTabs", "Section", "Stat", "MonthDetails", "PersonCard", "Line", "Assumptions"]))
      : null;
    const text = textOf(ownerTree);
    c.ok("the owner sees the Pay structure tab, linked from the tab bar", typeName(isValidElement(el) ? el.type : null) === "PayStructureTab" && hrefs(ownerTree).includes("/sales?tab=paystructure") && /Pay structure/.test(text));
    c.ok("…the monthly table with both people and a total", /Month by month/.test(text) && /September 2026/.test(text) && /October 2026/.test(text) && /Total since Sep 20/.test(text) && /since the Sep 20 pay period, paid Oct 9/.test(text) && /James Livingston/.test(text) && /Harrison Wells/.test(text));
    c.ok("…every part labelled: sessions at tier price, their rate / list price, assumed approved, commissions not tracked yet, bonus at most",
      /Content sessions at tier price/.test(text) && /their rate/.test(text) && /list price/.test(text) && /assumed approved/.test(text) && /commissions not tracked yet/.test(text) && /Bonus at most/.test(text), "");
    c.ok("…the mileage gap and Harrison's fallback rates are said on the page", /mileage not computed for 1 day/i.test(text) && /no longer has a percent, floor/.test(text), "");
    c.ok("no em dash anywhere on the tab or in its copy", !/—/.test(text) && !/—/.test(read("src/components/finance/PayStructureTab.tsx")) && !/["`'][^"`'\n]*—[^"`'\n]*["`']/.test(read("src/lib/paySavings.ts")));
    c.ok("no he/she copy", !/\b(he|she|his|her|him)\b/i.test(text));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
const typeName = (t: unknown) => (typeof t === "string" ? t : (t as { name?: string } | null)?.name ?? "");
main().catch((error) => { console.error(error); process.exit(1); });
