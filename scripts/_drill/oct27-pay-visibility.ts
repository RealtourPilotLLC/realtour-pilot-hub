// ---------------------------------------------------------------------------
// DRILL: JORDAN'S OCT 27 2026 PAY AND PRICE DECISIONS (#16, #17, #18, #20).
//
//   1. THE BONUS IS THE SCORECARD'S BANDS (#16). Harrison $1,000 / $600 /
//      $250 at 90+, 80 to 89, 70 to 79, nothing under 70; James "has a
//      different bonus amount": $1,500 / $900 / $375. The terms, the
//      scorecard and the Pay structure tab all use them; the old "bonus at
//      most" (each period's maximum spread over its days) is gone.
//   2. EACH PERSON SEES THEIR OWN PAY (#17). Jordan: "Only I see old pay and
//      new pay - Harrison and James should see their own pay schedule and
//      amount and bonuses." Their My Pay: every two weeks, the next payday,
//      each paycheck, the year, the vehicle, the bonus (scorecard) and the
//      bonuses paid. Never the other person's, never ?as=, never the
//      old-vs-new comparison; "view as" shows what they see; a shoot on fixed
//      pay says it is covered by the regular paycheck.
//   3. PRICES ARE NOT TEAM PAY (#18). Jordan: "Admins can see prices of
//      services and billing. I just dont want admin seeing what I pay other
//      team members." canSeePrices (OWNER, ADMIN) for service prices and
//      client billing; canSeeMoney (OWNER) for everything else, AR actions
//      included. By the previewed role, so "view as" still applies.
//   4. REMINDERS AT 7 PM OR 10 PM ONLY (#20): the choices, the refusal, and a
//      stored odd hour read as the nearest real one.
//
// ISOLATION: PGlite on 127.0.0.1:6527 (DRILL_PORT overrides); production is
// never opened; every outbound call is fenced (must be 0); nothing is sent.
// Pages are called for real (My Pay, Finance → Unpaid, Catalog), so it runs
// like the other page drills: without the react-server condition,
// server-only neutralised.
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
/** Source with comments removed, so a pin reads code, not the story about it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

// ---- a tiny server-tree reader ---------------------------------------------
type Props = Record<string, unknown>;
const typeName = (t: unknown) => (typeof t === "string" ? t : (t as { name?: string; displayName?: string } | null)?.name ?? "");
/** Expand the named plain server components (no hooks), awaiting async ones. */
async function expand(tree: unknown, names: Set<string>): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map((t) => expand(t, names)));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && names.has(tree.type.name)) return expand(await (tree.type as (p: Props) => unknown)(tree.props), names);
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await expand(v, names)] as const))) };
}
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((t) => elements(t, name));
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeName(tree.type) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((v) => elements(v, name))];
}
function rawText(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(rawText).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  const own = typeof tree.type === "string" ? [] : Object.entries(tree.props).filter(([k, v]) => k !== "className" && k !== "href" && typeof v === "string").map(([, v]) => v as string);
  return [...own, ...Object.entries(tree.props).filter(([k]) => k !== "className").map(([, v]) => rawText(v))].join(" ");
}
/** Every string a viewer could read, whitespace collapsed. */
const textOf = (tree: unknown) => rawText(tree).replace(/\s+/g, " ");
const DOLLARS = /\$\s?\d/;
const PAY_PARTS = new Set(["MyPerformance", "FixedPayPanel", "BonusesPaid"]);

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6527), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-pay-visibility" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { etAt } = await import("@/lib/datetime");
    const access = await import("@/lib/auth/access");
    const kpi = await import("@/lib/kpi");
    const ps = await import("@/lib/payStructure");
    const settings = await import("@/lib/settings");
    const own = await import("@/lib/ownPay");
    const savings = await import("@/lib/paySavings");
    const { shootEarnings } = await import("@/lib/shoot");
    const { default: MyPayPage } = await import("@/app/my-pay/page");

    // ---- the people ---------------------------------------------------------
    const tm = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, "-")}@oct27-pay.drill.invalid`, role: "PHOTOGRAPHER", ...extra }, select: { id: true, name: true } });
    const harrison = await tm("Harrison Wells", { payPercent: 0.35, payFloor: 100 });
    const james = await tm("James Livingston", { role: "MANAGER", creativeManager: true, payPercent: 0.3, payFloor: 75 });
    const pat = await tm("Pat Contractor", { payPercent: 0.4, payFloor: 100 });
    const kyleTm = await tm("Kyle Office", { role: "MANAGER", opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", { payPercent: 0.4 });
    const user = (email: string, name: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra }, select: { id: true, email: true, role: true } });
    const owner = await user("owner@oct27-pay.drill.invalid", "Jordan Spackman", "OWNER", { teamMemberId: jordanTm.id });
    const kyle = await user("kyle@oct27-pay.drill.invalid", "Kyle Office", "ADMIN", { teamMemberId: kyleTm.id, permissions: JSON.stringify({ sales: true }) });
    const hLogin = await user("harrison@oct27-pay.drill.invalid", "Harrison Wells", "PHOTOGRAPHER", { teamMemberId: harrison.id });
    const jLogin = await user("james@oct27-pay.drill.invalid", "James Livingston", "CREATIVE_MANAGER", { teamMemberId: james.id });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // =======================================================================
    c.head("1 · the bonus is the scorecard's bands, James's own for James (#16)");
    // =======================================================================
    const amounts = (bands: { amount: number }[]) => bands.map((b) => b.amount).join();
    const mins = (bands: { min: number }[]) => bands.map((b) => b.min).join();
    c.ok("Harrison's bands: 90+ $1,000, 80 to 89 $600, 70 to 79 $250, under 70 $0", amounts(kpi.BONUS_BANDS) === "1000,600,250,0" && mins(kpi.BONUS_BANDS) === "90,80,70,0");
    c.ok("James's bands: 90+ $1,500, 80 to 89 $900, 70 to 79 $375, under 70 $0", amounts(kpi.JAMES_BANDS) === "1500,900,375,0" && mins(kpi.JAMES_BANDS) === "90,80,70,0");
    const hTerms = kpi.agreedTerms("harrison"), jTerms = kpi.agreedTerms("james");
    c.ok("the agreed terms: Harrison capped at $1,000 on his bands, James at $1,500 on his", hTerms.cap === 1000 && hTerms.bands === kpi.BONUS_BANDS && jTerms.cap === 1500 && jTerms.bands === kpi.JAMES_BANDS);
    c.ok("…the same caps the pay terms carry (FIXED_PAY.bonusMax)", ps.FIXED_PAY.harrison.bonusMax === 1000 && ps.FIXED_PAY.james.bonusMax === 1500);
    const scores = [95, 90, 89.5, 89.4, 85, 80, 79, 72, 70, 69.4, 50];
    const hBand = scores.map((s) => kpi.bandFor(s, kpi.BONUS_BANDS)?.amount).join();
    const jBand = scores.map((s) => kpi.bandFor(s, kpi.JAMES_BANDS)?.amount).join();
    c.ok(`a score is banded as displayed (whole number): Harrison ${hBand}`, hBand === "1000,1000,1000,600,600,600,250,250,250,0,0");
    c.ok(`…James ${jBand}`, jBand === "1500,1500,1500,900,900,900,375,375,375,0,0");
    c.ok("…and no score is no band", kpi.bandFor(null, kpi.JAMES_BANDS) === null);
    const period = kpi.periodFor("2026-10-27");
    const [hT, jT, sT] = await Promise.all([
      kpi.termsFor({ name: "Harrison Wells", active: true }, period),
      kpi.termsFor({ name: "James Livingston", active: true }, period),
      kpi.termsFor({ name: "Pat Contractor", active: true }, period),
    ]);
    c.ok("the terms by roster name: James his, Harrison his, anyone else Harrison's", amounts(jT.bands) === "1500,900,375,0" && jT.cap === 1500 && amounts(hT.bands) === "1000,600,250,0" && hT.cap === 1000 && amounts(sT.bands) === "1000,600,250,0" && sT.cap === 1000);
    const [hCard, jCard] = [await kpi.scorePeriod({ memberId: harrison.id, period }), await kpi.scorePeriod({ memberId: james.id, period })];
    c.ok("each scorecard pays its own band for its own score, up to its own cap",
      hCard.possible === 1000 && jCard.possible === 1500 && hCard.bonus === (kpi.bandFor(hCard.score, hCard.terms.bands)?.amount ?? 0) && jCard.bonus === (kpi.bandFor(jCard.score, jCard.terms.bands)?.amount ?? 0),
      `${hCard.score}/${hCard.bonus} ${jCard.score}/${jCard.bonus}`);
    c.ok("the Pay button pays the scorecard's figure (server recompute through scorePeriod)", /scorePeriod\(/.test(code("src/app/sales/bonusActions.ts")) && !fs.existsSync(path.join(REPO, "src/lib/bonus.ts")));
    c.ok("the OTHER calculation is gone: the Pay structure tab no longer spreads each period's maximum",
      !/bonusAtMost|bonusMax\s*\/\s*bp\.days|\(t\.bonusMax \//.test(code("src/lib/paySavings.ts")) && /kpi\.scorePeriod\(/.test(code("src/lib/paySavings.ts")) && /KPI bonus, from the scorecard/.test(read("src/components/finance/PayStructureTab.tsx")) && !/Bonus at most/.test(read("src/components/finance/PayStructureTab.tsx")));

    // =======================================================================
    c.head("2 · each person sees their own pay, only the owner anyone else's (#17)");
    // =======================================================================
    const views = {
      owner: await settings.payViewFor({ role: "OWNER", realRole: "OWNER", teamMemberId: jordanTm.id }),
      harrison: await settings.payViewFor({ role: "PHOTOGRAPHER", teamMemberId: harrison.id }),
      james: await settings.payViewFor({ role: "CREATIVE_MANAGER", teamMemberId: james.id }),
      pat: await settings.payViewFor({ role: "PHOTOGRAPHER", teamMemberId: pat.id }),
      kyle: await settings.payViewFor({ role: "ADMIN", teamMemberId: kyleTm.id }),
      unlinked: await settings.payViewFor({ role: "EDITOR" }),
      nobody: await settings.payViewFor(null),
    };
    c.ok("the owner everything; Harrison and James their fixed pay; a per-shoot creative their own; Kyle, an unlinked login and nobody none",
      JSON.stringify(views) === JSON.stringify({ owner: "owner", harrison: "fixed", james: "fixed", pat: "per_shoot", kyle: "none", unlinked: "none", nobody: "none" }), JSON.stringify(views));

    // The figures, pure.
    const H = own.buildOwnFixedPay(ps.FIXED_PAY.harrison, [], "2026-10-27");
    const J = own.buildOwnFixedPay(ps.FIXED_PAY.james, [], "2026-10-27");
    c.ok("Harrison: $2,538.46 each paycheck ($2,238.46 service fee + $300 vehicle), $66,000 a year, bonus up to $1,000",
      H.perPaycheck.total === 2538.46 && H.perPaycheck.serviceFee === 2238.46 && H.perPaycheck.vehicle === 300 && H.annual.total === 66000 && H.annual.vehicle === 7800 && H.bonusMax === 1000, JSON.stringify(H.perPaycheck));
    c.ok("James: $3,076.92 each paycheck ($2,776.92 + $300), $80,000 a year, bonus up to $1,500",
      J.perPaycheck.total === 3076.92 && J.perPaycheck.serviceFee === 2776.92 && J.perPaycheck.vehicle === 300 && J.annual.total === 80000 && J.bonusMax === 1500, JSON.stringify(J.perPaycheck));
    c.ok("the schedule: every 14 days; on Oct 27 the next payday is Fri Nov 6 for Oct 18 to 31",
      H.periodDays === 14 && H.nextPayday.payoutKey === "2026-11-06" && H.nextPayday.startKey === "2026-10-18" && H.nextPayday.endKey === "2026-10-31");
    c.ok("…the paychecks since Sep 20, newest first: Oct 18 (this period), Oct 4 (paid Oct 23), Sep 20 (paid Oct 9)",
      H.paychecks.map((p) => `${p.startKey}:${p.state}:${p.payoutKey}`).join() === "2026-10-18:accruing:2026-11-06,2026-10-04:paid:2026-10-23,2026-09-20:paid:2026-10-09",
      H.paychecks.map((p) => `${p.startKey}:${p.state}`).join());
    const oct20 = own.buildOwnFixedPay(ps.FIXED_PAY.harrison, [], "2026-10-20");
    const oct23 = own.buildOwnFixedPay(ps.FIXED_PAY.harrison, [], "2026-10-23");
    const sep25 = own.buildOwnFixedPay(ps.FIXED_PAY.harrison, [], "2026-09-25");
    c.ok("a closed period waiting for its Friday is the next payday (Oct 20 → Oct 23), and on the day it pays today",
      oct20.nextPayday.payoutKey === "2026-10-23" && oct20.paychecks.find((p) => p.startKey === "2026-10-04")?.state === "upcoming" && oct23.nextPayday.payoutKey === "2026-10-23" && oct23.paychecks.find((p) => p.startKey === "2026-10-04")?.state === "today");
    c.ok("…but never the old-model period before Sep 20 (Sep 25 → next payday Oct 9, one paycheck)", sep25.nextPayday.payoutKey === "2026-10-09" && sep25.paychecks.length === 1);

    // Their own rows only.
    await prisma.payoutAdjustment.createMany({ data: [
      { teamMemberId: harrison.id, date: etAt("2026-10-11", 12), label: "Weekend premium, 12 Drill Ln", amount: 200 },
      { teamMemberId: harrison.id, date: etAt("2026-10-01", 12), label: "Quarterly bonus 2026-Q3", amount: 600 },
      { teamMemberId: james.id, date: etAt("2026-10-12", 12), label: "Weekend premium, 77 James Ct", amount: 200 },
      { teamMemberId: james.id, date: etAt("2026-08-14", 12), label: "Camera payback", amount: -50 },
    ] });
    const NOW = etAt("2026-10-27", 12);
    const hOwn = await own.ownFixedPayFor(harrison.id, ps.FIXED_PAY.harrison, NOW);
    const jOwn = await own.ownFixedPayFor(james.id, ps.FIXED_PAY.james, NOW);
    const hLabels = hOwn.paychecks.flatMap((p) => p.adjustments.map((a) => a.label));
    c.ok("Harrison's paychecks carry his own additions only: the Oct 11 premium on the Oct 4 paycheck ($2,738.46)",
      hLabels.join("|") === "Weekend premium, 12 Drill Ln|Quarterly bonus 2026-Q3" && hOwn.paychecks.find((p) => p.startKey === "2026-10-04")?.total === 2738.46, hLabels.join("|"));
    c.ok("…his bonuses paid: Q3, $600, on the Oct 9 paycheck", hOwn.bonusesPaid.length === 1 && hOwn.bonusesPaid[0].amount === 600 && hOwn.bonusesPaid[0].payoutKey === "2026-10-09");
    c.ok("James's: his premium, no bonus yet, and nothing from before fixed pay (Aug)", jOwn.paychecks.flatMap((p) => p.adjustments.map((a) => a.label)).join("|") === "Weekend premium, 77 James Ct" && jOwn.bonusesPaid.length === 0);

    // The page, as each of them.
    const page = async (sp: Record<string, string> = {}) => MyPayPage({ searchParams: Promise.resolve(sp) });
    const pageProps = (el: unknown) => (isValidElement<Props>(el) && typeName(el.type) === "MyPerformance" ? el.props : null);
    await signIn(hLogin);
    const hEl = await page();
    const hp = pageProps(hEl);
    c.ok("Harrison's My Pay: his own member id, with pay, as himself", hp?.memberId === harrison.id && hp.showPay === true && hp.preview === false);
    const hText = textOf(await expand(hEl, PAY_PARTS));
    c.ok("…reads My Pay with his paycheck, year, vehicle, next payday and schedule",
      /My Pay/.test(hText) && /Each paycheck \$2,538\.46/.test(hText) && /A year \$66,000/.test(hText) && /Vehicle \$7,800 a year/.test(hText) && /Next payday/.test(hText) && /Paid every two weeks/.test(hText), hText.slice(0, 240));
    c.ok("…his bonus paid and his additions", /Bonus for 2026-Q3/.test(hText) && /\$600\.00/.test(hText) && /Weekend premium, 12 Drill Ln/.test(hText));
    c.ok("…the scorecard beside it, as himself", elements(await expand(hEl, new Set(["MyPerformance"])), "QuarterScoreCard").some((x) => x.viewer === "self"));
    c.ok("…and nothing of James's: no $3,076.92, no $80,000, no James line", !/3,076|80,000|77 James Ct/.test(hText));
    const hAs = pageProps(await page({ as: james.id }));
    c.ok("Harrison asking for ?as=James gets his own page", hAs?.memberId === harrison.id);
    await signIn(jLogin);
    const jEl = await page({ as: harrison.id });
    const jp = pageProps(jEl);
    const jText = textOf(await expand(jEl, PAY_PARTS));
    c.ok("James (creative manager), even asking ?as=Harrison: his own page, $3,076.92, $80,000, up to $1,500",
      jp?.memberId === james.id && jp.showPay === true && /Each paycheck \$3,076\.92/.test(jText) && /A year \$80,000/.test(jText) && /up to \$1,500 a period/.test(jText) && !/2,538|66,000|12 Drill Ln/.test(jText), jText.slice(0, 200));
    await signIn(kyle);
    const kp = pageProps(await page());
    c.ok("Kyle (no pay structure): the scorecard page with no pay", kp?.showPay === false);
    await signIn(owner, hLogin.id);
    const prevH = pageProps(await page({ as: james.id }));
    c.ok("view as: the owner previewing Harrison sees Harrison's page, marked a preview (?as= ignored)", prevH?.memberId === harrison.id && prevH.showPay === true && prevH.preview === true);
    await signIn(owner, kyle.id);
    c.ok("view as: the owner previewing Kyle sees no pay", pageProps(await page())?.showPay === false);
    await signIn(owner);
    const ownerAs = pageProps(await page({ as: harrison.id }));
    c.ok("the owner's ?as=Harrison is Harrison's page, read as a preview", ownerAs?.memberId === harrison.id && ownerAs.showPay === true && ownerAs.preview === true);

    // The old-vs-new comparison stays the owner's.
    const refused = async () => { try { await savings.ownerPaySavings({ now: NOW }); return false; } catch (e) { return /Only the owner/.test((e as Error).message); } };
    const refusals: string[] = [];
    for (const [who, u, as] of [["Harrison", hLogin, undefined], ["James", jLogin, undefined], ["Kyle", kyle, undefined], ["the owner previewing Harrison", owner, hLogin.id]] as const) {
      await signIn(u, as);
      if (await refused()) refusals.push(who);
    }
    await signIn(owner);
    c.ok("old pay vs new pay: refused to Harrison, James, Kyle and the owner previewing Harrison; the owner's answers",
      refusals.join() === "Harrison,James,Kyle,the owner previewing Harrison" && !(await refused()), refusals.join());

    // A shoot on fixed pay.
    const client = await prisma.client.create({ data: { name: "Oct27 Pay Drill Client TEST" }, select: { id: true } });
    let n = 0;
    const shootOn = (who: string, day: string) => prisma.project.create({
      data: {
        clientId: client.id, title: `${++n} Fixed Pay Ln, Malvern, PA`, status: "DELIVERED", photographerId: who, shootDate: etAt(day, 10),
        appointments: { create: [{ aryeoId: `oct27-pay-${n}`, startAt: etAt(day, 10), status: "SCHEDULED", assignedToId: who }] },
      } as never,
      select: { id: true },
    });
    const hOct = await shootOn(harrison.id, "2026-10-10");
    const hSep = await shootOn(harrison.id, "2026-09-10");
    const eFixed = await shootEarnings(hOct.id, harrison.id);
    const eOld = await shootEarnings(hSep.id, harrison.id);
    const eOther = await shootEarnings(hOct.id, james.id);
    c.ok("Harrison's Oct 10 shoot is covered by his regular paycheck (no per-shoot figure)", eFixed?.state === "fixed" && eFixed.total === 0, eFixed?.state);
    c.ok("…his Sep 10 shoot (before fixed pay) is not", eOld?.state !== "fixed", eOld?.state);
    c.ok("…and James opening Harrison's shoot gets no fixed-pay card for it", eOther?.state !== "fixed", eOther?.state);
    c.ok("the card says so and points to My Pay", /Covered by your regular paycheck/.test(read("src/components/shoot/ShootPayCard.tsx")) && /state === "fixed"/.test(code("src/components/shoot/ShootPayCard.tsx")));
    c.ok("the upload pages hold no pay on submit for fixed pay (shootPayRidesOnSubmit)",
      ["src/app/upload/page.tsx", "src/app/upload/welcome/page.tsx", "src/app/upload/[id]/page.tsx"].every((f) => /!\(await shootPayRidesOnSubmit\(/.test(code(f))) &&
      !(await settings.shootPayRidesOnSubmit({ role: "PHOTOGRAPHER", teamMemberId: harrison.id })) && (await settings.shootPayRidesOnSubmit({ role: "PHOTOGRAPHER", teamMemberId: pat.id })));

    // =======================================================================
    c.head("3 · prices are not team pay (#18)");
    // =======================================================================
    const table = access.ROLES.map((r) => `${r}:${access.canSeePrices(r) ? "P" : "-"}${access.canSeeMoney(r) ? "M" : "-"}`).join(" ");
    c.ok(`prices for the owner and admins, money for the owner only: ${table}`, table === "OWNER:PM ADMIN:P- CREATIVE_MANAGER:-- EDITOR:-- PHOTOGRAPHER:--");
    c.ok("…no role, no prices", !access.canSeePrices(null) && !access.canSeePrices(undefined) && !access.canSeePrices(""));
    c.ok("…by the app role, never the content tier (the creative manager is content tier ADMIN, and sees no prices)", access.contentTier("CREATIVE_MANAGER") === "ADMIN" && !access.canSeePrices("CREATIVE_MANAGER"));
    c.ok("access.ts quotes the decision", /I just dont want admin seeing what I pay other team members/.test(read("src/lib/auth/access.ts").replace(/\n\s*\/\/\s*/g, " ")));
    const priceSites: [string, RegExp][] = [
      ["src/app/catalog/page.tsx", /canSeePrices\(me\.role\)/],
      ["src/app/settings/products/page.tsx", /canSeePrices\(me\.role\)/],
      ["src/app/sales/page.tsx", /<UnpaidTab show=\{show\} amounts=\{prices\} actions=\{money\} \/>/],
      ["src/app/projects/[id]/page.tsx", /const showPrices = viewer \? canSeePrices\(viewer\.role\)/],
      ["src/app/clients/[id]/page.tsx", /canSeePrices\(/],
      ["src/app/content/[id]/workspaceData.ts", /const dollarEyes = me \? canSeePrices\(me\.role\)/],
      ["src/app/projects/refreshActions.ts", /canSeePrices\(viewer\.role\)/],
      ["src/components/comms/viewerScrub.ts", /const seesPrices = me \? canSeePrices\(me\.role\)/],
    ];
    const missing = priceSites.filter(([f, re]) => !re.test(code(f))).map(([f]) => f);
    c.ok("every price and billing surface asks canSeePrices with the previewed role", missing.length === 0, missing.join(", "));
    c.ok("…while team pay keeps canSeeMoney: the comparison, Finance's owner tabs, the client's lifetime spend",
      /me\.realRole === "OWNER" && canSeeMoney\(me\.role\)/.test(code("src/lib/paySavings.ts")) && /const isOwner = me \? me\.role === "OWNER"/.test(code("src/app/sales/page.tsx")) && /canSeeMoney\(/.test(code("src/app/clients/[id]/page.tsx")));

    // "View as" applies: the previewed role decides.
    await signIn(owner, kyle.id);
    const asKyle = await getCurrentUser();
    await signIn(owner, hLogin.id);
    const asHarrison = await getCurrentUser();
    c.ok("view as Kyle: prices yes, money no; view as Harrison: neither", !!asKyle && access.canSeePrices(asKyle.role) && !access.canSeeMoney(asKyle.role) && !!asHarrison && !access.canSeePrices(asHarrison.role) && !access.canSeeMoney(asHarrison.role));

    // Finance → Unpaid, as Kyle and as the owner previewing Kyle.
    const D = 24 * 3_600_000;
    await prisma.project.create({
      data: {
        clientId: client.id, title: "88 Owed Lane, Malvern, PA", status: "DELIVERED", deliveredAt: new Date(Date.now() - 40 * D), orderedAt: new Date(Date.now() - 45 * D),
        balanceAmount: 8750, price: 425, paymentStatus: "UNPAID", invoiceUrl: "https://example.test/invoice/88", paymentUrl: "https://example.test/pay/88", aryeoOrderId: "oct27-pay-ar-88",
      } as never,
    });
    const { default: FinancePage } = await import("@/app/sales/page");
    const unpaid = async () => {
      const el = await FinancePage({ searchParams: Promise.resolve({ tab: "unpaid" }) });
      if (!isValidElement<Props>(el)) throw new Error("Finance did not render a tab");
      return expand(await (el.type as (p: Props) => unknown)(el.props), new Set(["BillingCard"]));
    };
    for (const [who, u, as] of [["Kyle", kyle, undefined], ["the owner previewing Kyle", owner, kyle.id]] as const) {
      await signIn(u, as);
      const tree = await unpaid();
      const text = textOf(tree);
      c.ok(`${who}: Unpaid shows what the job owes ($87.50) with its invoice link, and no chase, mark-paid, remove or restore`,
        /88 Owed Lane/.test(text) && /\$87\.50/.test(text) && ["NudgeActions", "RemoveFromAr", "RestoreToAr"].every((x) => elements(tree, x).length === 0), text.slice(0, 200));
    }
    await signIn(kyle);
    const bounced: string[] = [];
    for (const tab of ["payroll", "paystructure", "bonus"]) {
      try { await FinancePage({ searchParams: Promise.resolve({ tab }) }); } catch (e) { if (e instanceof Redirect) bounced.push(tab); }
    }
    c.ok("…and Kyle never reaches payroll, pay structure or bonus (what Jordan pays the team)", bounced.join() === "payroll,paystructure,bonus", bounced.join());
    const billing = await import("@/app/billing/actions");
    const ar = await prisma.project.findFirst({ where: { title: "88 Owed Lane, Malvern, PA" }, select: { id: true } });
    let markRefused = false;
    try { markRefused = (await billing.markArPaid(ar!.id, "drill")).ok === false; } catch { markRefused = true; }
    c.ok("…and cannot mark it paid (AR actions stay the owner's)", markRefused && !(await prisma.project.findUnique({ where: { id: ar!.id }, select: { paidMarkedAt: true } }))?.paidMarkedAt);

    // The Catalog: Kyle sees prices; the owner previewing Harrison does not.
    await prisma.product.create({ data: { aryeoId: "oct27-prod-1", title: "Listing Photos Oct27", type: "MAIN", tags: JSON.stringify(["Real Estate"]), minPrice: 19900, maxPrice: 29900, variants: JSON.stringify([{ title: "Under 2,500 sq ft", price_amount: 19900 }, { title: "2,500 sq ft and up", price_amount: 29900 }]) } });
    const { default: CatalogPage } = await import("@/app/catalog/page");
    const catalog = async () => { try { return textOf(await expand(await CatalogPage(), new Set(["ProductCard"]))); } catch (e) { return e instanceof Redirect ? `redirect ${e.href}` : String(e); } };
    await signIn(kyle);
    const kCat = await catalog();
    c.ok("Catalog, Kyle: the service prices", /Listing Photos Oct27/.test(kCat) && /\$199/.test(kCat) && /\$299/.test(kCat), kCat.slice(0, 160));
    await signIn(owner, hLogin.id);
    const hCat = await catalog();
    c.ok("Catalog, the owner previewing Harrison: no prices", !DOLLARS.test(hCat), hCat.slice(0, 160));

    // =======================================================================
    c.head("4 · photographer reminders at 7 PM or 10 PM only (#20)");
    // =======================================================================
    c.ok("the two hours", [...settings.EVENING_SEND_HOURS].join() === "19,22");
    const map = Object.fromEntries([18, 19, 20, 21, 22, 23, 0, 12].map((h) => [h, settings.eveningSendHour(h, -1)]));
    c.ok("an off-grid hour reads as the nearest (6 → 7, 8 → 7, 9 → 10, 11 → 10, midnight → 10, noon → 7)", JSON.stringify(map) === JSON.stringify({ 0: 22, 12: 19, 18: 19, 19: 19, 20: 19, 21: 22, 22: 22, 23: 22 }), JSON.stringify(map));
    await settings.putSetting("internal_alerts", { ...settings.DEFAULT_INTERNAL_ALERTS, uploadReminder: { enabled: true, hour: 21 }, uploadChaser: { enabled: true, hour: 23 } }, "drill");
    const before = (await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } }))?.value;
    const rules = await settings.internalAlertRules();
    c.ok("a stored 9 PM / 11 PM reads as 10 PM / 10 PM, and the row is not rewritten", rules.uploadReminder.hour === 22 && rules.uploadChaser.hour === 22 && (await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } }))?.value === before);
    const off = await settings.eveningHoursOffSchedule();
    c.ok("…and the card is told what was saved", off.uploadReminder === 21 && off.uploadChaser === 23);
    const { saveInternalAlerts } = await import("@/app/settings/actions");
    await signIn(owner);
    const base = await settings.internalAlertRules();
    const save = (rem: number, cha: number) => saveInternalAlerts({ ...base, uploadReminder: { enabled: true, hour: rem }, uploadChaser: { enabled: true, hour: cha } });
    const r20 = await save(20, 22), r21 = await save(19, 21), r18 = await save(18, 22);
    c.ok("the server refuses 8 PM, 9 PM and 6 PM, naming the two real times", [r20, r21, r18].every((r) => !r.ok && /7 PM or 10 PM/.test(r.message)), [r20, r21, r18].map((r) => r.message).join(" | "));
    const good = await save(19, 22);
    const stored = JSON.parse((await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } }))!.value) as { uploadReminder: { hour: number }; uploadChaser: { hour: number } };
    c.ok("7 PM and 10 PM save", good.ok && stored.uploadReminder.hour === 19 && stored.uploadChaser.hour === 22, good.message);
    c.ok("the picker offers exactly those two", /const EVENING_CHOICES = \[19, 22\] as const/.test(read("src/components/settings/OperatingRules.tsx")));

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
