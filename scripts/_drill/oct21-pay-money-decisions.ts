// ---------------------------------------------------------------------------
// DRILL: JORDAN'S OCT 21 2026 PAY AND MONEY DECISIONS.
//
//   1. ONE BONUS ENGINE: the scorecard bands (kpi.ts, $1,000 / $600 / $250).
//      Finance → Bonus, the Pay button's server recompute (payQuarterlyBonus)
//      and My Performance all show and pay the same figure. The retired
//      lib/bonus.ts (a profit pool split by a different score) is run here
//      from 1e33905, on the same fixture, so the before/after numbers print.
//   2. Only Jordan sees pay: driven in oct14-pay-hidden.ts; here only the
//      My Performance card's bonus figure, which item 1 needs.
//   3. A PAGE-ACCESS OVERRIDE NEVER GRANTS MONEY: an admin holding a `sales`
//      grant sees Finance → Unpaid without a dollar figure or a chase button,
//      and every AR action refuses them (the 1e33905 actions let them mark a
//      job paid); the Catalog and Settings → Products show an admin no prices.
//   4. REMINDER HOURS TELL THE TRUTH: vercel.json's evening firings reach
//      7 PM and 10 PM Eastern in every season and no other hour; Settings
//      offers exactly those two, refuses anything else, and a stored odd hour
//      is read (and shown) as the nearest real one.
//
// ISOLATION: PGlite on 127.0.0.1:6021 (DRILL_PORT overrides); production is
// never opened; every outbound call is fenced (must be 0); nothing is sent.
// Pages are called for real (Finance, My Pay, Catalog, Settings → Products),
// so it runs like the other page drills: without the react-server condition,
// server-only neutralised.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const BASE = "1e33905"; // the live production commit these decisions start from
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

// ---- old code, pinned to BASE (never HEAD) ---------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "oct21-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
function baseline(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = path.join(baseDir, rel.replace(/[/[\]]/g, "_"));
  fs.writeFileSync(out, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return out;
}

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
/** Every string a viewer could read: text children and the string props of components (title, subtitle…). */
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
const DOLLARS = /\$\s?\d/;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6021), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-pay-money" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const kpi = await import("@/lib/kpi");
    // Oct 22 2026: Q3 2026 began before the compensation terms, so it is the
    // frozen seven-area scorecard (lib/kpiLegacy) that scores and pays it.
    const legacy = await import("@/lib/kpiLegacy");
    const { payQuarterlyBonus } = await import("@/app/sales/bonusActions");
    const { default: FinancePage } = await import("@/app/sales/page");
    const { default: MyPayPage } = await import("@/app/my-pay/page");
    const oldBonus = (await import(baseline("src/lib/bonus.ts"))) as {
      quarterFromKey: (k: string) => unknown;
      quarterBonus: (q: unknown) => Promise<{ pool: { pool: number; surplus: number; why: string }; cards: { memberId: string; name: string; score: number | null; basis: string }[]; split: Record<string, number> }>;
    };

    // ---- the people ---------------------------------------------------------
    const tm = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, "-")}@oct21.drill.invalid`, role: "PHOTOGRAPHER", payPercent: 0.35, ...extra }, select: { id: true, name: true } });
    const harrison = await tm("Harrison Drill");
    const james = await tm("James Drill", { creativeManager: true });
    const jordanTm = await tm("Jordan Drill", { payPercent: 0.4 });
    const former = await tm("Remar Drill", { active: false });
    await tm("Kyle Drill", { role: "MANAGER", payPercent: null, opsAlerts: true });
    const user = (email: string, name: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra }, select: { id: true, email: true, role: true } });
    const owner = await user("owner@oct21.drill.invalid", "Jordan Drill", "OWNER", { teamMemberId: jordanTm.id });
    // Kyle, holding a per-person Finance grant: a page grant, never a money grant.
    const kyle = await user("kyle@oct21.drill.invalid", "Kyle Drill", "ADMIN", { permissions: JSON.stringify({ sales: true }) });
    const harrisonLogin = await user("harrison@oct21.drill.invalid", "Harrison Drill", "PHOTOGRAPHER", { teamMemberId: harrison.id });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // ---- the quarter: Q3 2026 (closed), Q2 2026 for the like-for-like ------
    const client = await prisma.client.create({ data: { name: "Oct21 Drill Client TEST" }, select: { id: true } });
    const H = 3_600_000, D = 24 * H;
    let seq = 0;
    const shoot = async (who: string, shootDate: Date, o: { lateRaws?: boolean; overBudget?: boolean; revised?: boolean; lateDelivery?: boolean } = {}) =>
      prisma.project.create({
        data: {
          clientId: client.id, title: `${++seq} Drill Lane, Emmaus, PA`, status: "DELIVERED", photographerId: who, shootDate,
          uploadedAt: new Date(shootDate.getTime() + (o.lateRaws ? 3 * D : 3 * H)),
          debriefSubmittedAt: new Date(shootDate.getTime() + 4 * H),
          photoTarget: 30, rawPhotoCount: o.overBudget ? 300 : 30,
          revisionRequestedAt: o.revised ? new Date(shootDate.getTime() + 5 * D) : null,
          deliveryDue: new Date(shootDate.getTime() + 2 * D),
          deliveredAt: new Date(shootDate.getTime() + (o.lateDelivery ? 3 * D : 1 * D)),
        },
      });
    const q3Day = (i: number, offset: number) => new Date(Date.parse("2026-07-06T14:00:00-04:00") + (7 * i + offset) * D);
    const q2Day = (i: number, offset: number) => new Date(Date.parse("2026-04-06T14:00:00-04:00") + (7 * i + offset) * D);
    // Harrison: 12 shoots; 3 raws late, 1 revised, 1 late delivery; 10 last quarter.
    for (let i = 0; i < 12; i++) await shoot(harrison.id, q3Day(i, 0), { lateRaws: [2, 5, 8].includes(i), revised: i === 4, lateDelivery: i === 10 });
    for (let i = 0; i < 10; i++) await shoot(harrison.id, q2Day(i, 0));
    // James: 10 shoots; 3 over the raw budget, 2 raws late, 3 revised, 4 late deliveries; 8 last quarter.
    for (let i = 0; i < 10; i++) await shoot(james.id, q3Day(i, 1), { overBudget: [0, 3, 6].includes(i), lateRaws: [1, 4].includes(i), revised: [2, 5, 7].includes(i), lateDelivery: i < 4 });
    for (let i = 0; i < 8; i++) await shoot(james.id, q2Day(i, 1));
    // Jordan shoots too (never in his own bonus), and a former teammate's work.
    for (let i = 0; i < 6; i++) await shoot(jordanTm.id, q3Day(i, 2));
    for (let i = 0; i < 6; i++) await shoot(former.id, q3Day(i, 3));
    // The quarter's money, for the retired pool: $60,000 of Stripe charges.
    await prisma.stripeTransaction.create({ data: { id: "oct21-drill-q3-charge", type: "charge", gross: 60_000, fee: 0, net: 60_000, createdAt: new Date("2026-08-14T15:00:00-04:00") } });

    // =======================================================================
    c.head("1 · one bonus engine: what each person sees is what Finance pays");
    // =======================================================================
    const Q3 = kpi.quarterFromKey("2026-Q3")!;
    const before = await oldBonus.quarterBonus(oldBonus.quarterFromKey("2026-Q3"));
    const roster = await legacy.scoreQuarterRoster(Q3);
    const after = Object.fromEntries(roster.map((r) => [r.memberId, r]));
    console.log("\n  Q3 2026, same fixture, BEFORE (retired lib/bonus.ts at 1e33905) vs AFTER (kpi.ts scorecard bands):");
    console.log(`    retired pool: ${usd(before.pool.pool)} (${before.pool.why})`);
    for (const m of [harrison, james]) {
      const old = before.cards.find((x) => x.memberId === m.id);
      const now = after[m.id];
      console.log(`    ${m.name.padEnd(15)} before: score ${old?.score == null ? "none" : Math.round(old.score)} (${old?.basis}) → ${usd(before.split[m.id] ?? 0)}   after: score ${now?.score == null ? "none" : Math.round(now.score)} → ${usd(now?.bonus ?? 0)}`);
    }
    console.log("");
    c.ok("BEFORE: the retired engine paid out of a profit pool, split by a different score than the scorecard", before.pool.pool > 0 && (before.split[harrison.id] ?? 0) !== (after[harrison.id]?.bonus ?? 0));
    c.ok("the bonus roster is the two active creatives: not the owner, not a former teammate, not Kyle", roster.map((r) => r.name).sort().join(",") === "Harrison Drill,James Drill", roster.map((r) => r.name).join(","));
    c.ok("AFTER: every amount is the scorecard's band for its whole-number score", roster.every((r) => r.bonus === (kpi.bandFor(r.score)?.amount ?? 0)));
    c.ok("AFTER: Harrison scores in the 80s and earns $600; James scores under 70 and earns nothing", after[harrison.id]?.bonus === 600 && after[james.id]?.bonus === 0, `${after[harrison.id]?.score} / ${after[james.id]?.score}`);
    const kpiSrc = read("src/lib/kpi.ts");
    c.ok("lib/bonus.ts is gone and nothing imports it", !fs.existsSync(path.join(REPO, "src/lib/bonus.ts")) && !/@\/lib\/bonus["']/.test(read("src/components/finance/BonusTab.tsx") + read("src/app/sales/bonusActions.ts")) && /THE ONLY BONUS ENGINE/.test(kpiSrc));

    // Finance → Bonus, rendered through the Finance page as the owner.
    await signIn(owner);
    const cur = kpi.quarterFor();
    const back = Number(cur.key.slice(0, 4)) * 4 + Number(cur.key.slice(-1)) - (2026 * 4 + 3);
    const finance = async (sp: Record<string, string>) => {
      const el = await FinancePage({ searchParams: Promise.resolve(sp) });
      if (!isValidElement<Props>(el)) throw new Error("Finance did not render a tab");
      return expand(await (el.type as (p: Props) => unknown)(el.props), new Set(["BillingCard", "LegacyPeriod", "ContractPeriod", "PersonCard", "JamesTerms"]));
    };
    const bonusTab = await finance({ tab: "bonus", back: String(back) });
    const payButtons = elements(bonusTab, "PayBonusButton");
    c.ok("Finance → Bonus offers one Pay button: Harrison's, for the scorecard's $600 in 2026-Q3", payButtons.length === 1 && payButtons[0].memberId === harrison.id && payButtons[0].amount === 600 && payButtons[0].quarter === "2026-Q3", JSON.stringify(payButtons.map((b) => [b.memberId === harrison.id ? "H" : b.memberId, b.amount, b.quarter])));
    c.ok("…and it prints the bands and no profit pool", /\$1,000/.test(textOf(bonusTab)) && /\$600/.test(textOf(bonusTab)) && !/pool|profit/i.test(textOf(bonusTab)));

    // My Performance: the same card, the same figure.
    await signIn(harrisonLogin);
    const perfEl = await MyPayPage({ searchParams: Promise.resolve({}) });
    const perf = isValidElement<Props>(perfEl) ? await (perfEl.type as (p: Props) => unknown)(perfEl.props) : null;
    const cards = elements(perf, "QuarterScoreCard");
    const lastQ = cards[0]?.previous as { key: string; bonus: number } | null | undefined;
    const prevPeriod = kpi.periodFor(undefined, 1);
    const lastQExpected = prevPeriod.legacy
      ? (await legacy.scoreQuarter({ memberId: harrison.id, quarter: legacy.quarterFromKey(prevPeriod.key) ?? undefined })).bonus
      : (await kpi.scorePeriod({ memberId: harrison.id, period: prevPeriod })).bonus;
    c.ok("My Performance (not My Pay) shows Harrison the scorecard Finance pays from: last quarter's card is the same figure (Q3 2026: $600)",
      typeName(isValidElement(perfEl) ? perfEl.type : null) === "MyPerformance" && lastQ != null && lastQ.bonus === lastQExpected && (lastQ.key !== "2026-Q3" || lastQ.bonus === 600),
      lastQ ? `${lastQ.key} ${lastQ.bonus}` : "no previous card");

    // The Pay button's server-side recompute, and every refusal it keeps.
    await signIn(kyle);
    c.ok("an admin cannot pay a bonus", !(await payQuarterlyBonus(harrison.id, "2026-Q3", 600)).ok);
    await signIn(owner);
    const stale = await payQuarterlyBonus(harrison.id, "2026-Q3", Math.round((before.split[harrison.id] ?? 0) * 100) / 100);
    c.ok("a screen still showing the retired engine's figure is refused, naming the real one", !stale.ok && /\$600\.00/.test(stale.message), stale.message);
    c.ok("the running quarter is refused", /still running/.test((await payQuarterlyBonus(harrison.id, cur.key, 600)).message));
    c.ok("the owner's own roster row is refused", /isn't covered/.test((await payQuarterlyBonus(jordanTm.id, "2026-Q3", 0)).message));
    c.ok("a former teammate is refused", /isn't covered/.test((await payQuarterlyBonus(former.id, "2026-Q3", 0)).message));
    c.ok("a score under 70 has nothing to pay", /Nothing to pay/.test((await payQuarterlyBonus(james.id, "2026-Q3", 0)).message));
    const paid = await payQuarterlyBonus(harrison.id, "2026-Q3", 600);
    const line = await prisma.payoutAdjustment.findFirst({ where: { teamMemberId: harrison.id, label: "Quarterly bonus 2026-Q3" } });
    c.ok("paying writes the scorecard's $600 as Harrison's payout line", paid.ok && line?.amount === 600, paid.message);
    c.ok("a second press is refused", /Already paid/.test((await payQuarterlyBonus(harrison.id, "2026-Q3", 600)).message));
    const afterPay = await finance({ tab: "bonus", back: String(back) });
    c.ok("the tab then shows it paid, with no button", elements(afterPay, "PayBonusButton").length === 0 && /paid\s+\$600/.test(textOf(afterPay)));

    // =======================================================================
    c.head("3 · a page grant is never a money grant");
    // =======================================================================
    const ar = (title: string, extra: Record<string, unknown> = {}) => prisma.project.create({
      data: {
        clientId: client.id, title, status: "DELIVERED", deliveredAt: new Date(Date.now() - 40 * D), orderedAt: new Date(Date.now() - 45 * D),
        balanceAmount: 8750, price: 425, paymentStatus: "UNPAID", invoiceUrl: "https://example.test/invoice/1", paymentUrl: "https://example.test/pay/1", aryeoOrderId: `oct21-${title}`, ...extra,
      },
      select: { id: true },
    });
    const owed = await ar("77 Owed Road, Emmaus, PA");
    await ar("78 Cleared Road, Emmaus, PA", { paidMarkedAt: new Date(), paidMarkedNote: "Paid $87.50 by Venmo — Jordan Drill" });
    const oldPaidJob = await ar("79 Before Road, Emmaus, PA");

    await signIn(kyle);
    const kyleUnpaid = await finance({ tab: "unpaid" });
    const kyleText = textOf(kyleUnpaid);
    c.ok("Kyle (sales grant) still reaches Finance → Unpaid and sees the unpaid jobs", /77 Owed Road/.test(kyleText) && /Unpaid for/.test(kyleText));
    c.ok("…with no dollar figure anywhere on the tab", !DOLLARS.test(kyleText), (kyleText.match(/.{0,30}\$\s?\d.{0,20}/g) ?? []).slice(0, 3).join(" | "));
    c.ok("…no chase, mark-paid, remove or restore button", ["NudgeActions", "RemoveFromAr", "RestoreToAr"].every((n) => elements(kyleUnpaid, n).length === 0));
    c.ok("…and no invoice or payment link (both print the balance)", !hrefs(kyleUnpaid).some((h) => /example\.test\/(invoice|pay)/.test(h)));
    await signIn(owner);
    const ownerUnpaid = await finance({ tab: "unpaid" });
    c.ok("the owner's Unpaid tab keeps every amount and button", /\$87\.50/.test(textOf(ownerUnpaid)) && elements(ownerUnpaid, "NudgeActions").length > 0 && elements(ownerUnpaid, "RestoreToAr").length > 0);

    const billing = await import("@/app/billing/actions");
    const oldBilling = (await import(baseline("src/app/billing/actions.ts"))) as typeof billing;
    await signIn(kyle);
    const oldMark = await oldBilling.markArPaid(oldPaidJob.id, "drill");
    c.ok("BEFORE (1e33905): Kyle's sales grant let him mark a job paid", oldMark.ok, oldMark.message);
    const refused = async (f: () => Promise<{ ok: boolean } | unknown>) => { try { const r = await f(); return (r as { ok?: boolean }).ok === false; } catch { return true; } };
    const results = {
      markArPaid: await refused(() => billing.markArPaid(owed.id, "drill")),
      removeFromAr: await refused(() => billing.removeFromAr(owed.id, "drill")),
      restoreToAr: await refused(() => billing.restoreToAr(oldPaidJob.id)),
      markBillingNudged: await refused(() => billing.markBillingNudged(owed.id)),
      draftPaymentNudge: await refused(() => billing.draftPaymentNudge(owed.id)),
      sendPaymentNudge: await refused(() => billing.sendPaymentNudge(owed.id, "hello")),
    };
    const still = await prisma.project.findUnique({ where: { id: owed.id }, select: { paidMarkedAt: true, arRemovedAt: true, lastNudgedAt: true } });
    c.ok("AFTER: every AR action refuses Kyle, and the job is untouched", Object.values(results).every(Boolean) && !still?.paidMarkedAt && !still?.arRemovedAt && !still?.lastNudgedAt, JSON.stringify(results));
    await signIn(owner);
    c.ok("the owner still marks a job paid", (await billing.markArPaid(owed.id, "drill")).ok);

    // The Catalog and Settings → Products: Kyle still works there, without prices.
    await prisma.product.create({ data: { aryeoId: "oct21-prod-1", title: "Listing Photos Drill", type: "MAIN", tags: JSON.stringify(["Real Estate"]), minPrice: 19900, maxPrice: 29900, variants: JSON.stringify([{ title: "Under 2,500 sq ft", price_amount: 19900 }, { title: "2,500 sq ft and up", price_amount: 29900 }]) } });
    const { default: CatalogPage } = await import("@/app/catalog/page");
    const { default: ProductsPage } = await import("@/app/settings/products/page");
    const catalog = async () => expand(await CatalogPage(), new Set(["ProductCard"]));
    await signIn(kyle);
    const kyleCatalog = textOf(await catalog());
    c.ok("Catalog, admin: the product and its tier names, no prices", /Listing Photos Drill/.test(kyleCatalog) && /Under 2,500 sq ft/.test(kyleCatalog) && !DOLLARS.test(kyleCatalog), (kyleCatalog.match(/.{0,20}\$\s?\d.{0,10}/g) ?? []).join(" | "));
    const kyleProducts = elements(await ProductsPage(), "ProductMappingCard").map((p) => p.card as { title: string; priceRange: string | null });
    c.ok("Settings → Products, admin: every card still there to map, no price range sent to the browser", kyleProducts.some((p) => p.title === "Listing Photos Drill") && kyleProducts.every((p) => p.priceRange === null));
    await signIn(owner);
    c.ok("Catalog, owner: prices shown", /\$199/.test(textOf(await catalog())) && /\$299/.test(textOf(await catalog())));
    c.ok("Settings → Products, owner: the price range shown", elements(await ProductsPage(), "ProductMappingCard").some((p) => (p.card as { priceRange: string | null }).priceRange === "$199–$299"));

    // =======================================================================
    c.head("4 · the reminder hours are the hours the cron really fires");
    // =======================================================================
    const settings = await import("@/lib/settings");
    const { etHour } = await import("@/lib/datetime");
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const utcHours = vercel.crons.filter((x) => x.path === "/api/cron/evening").map((x) => Number(x.schedule.split(" ")[1]));
    const etHoursOn = (day: string) => new Set(utcHours.map((h) => etHour(new Date(`${day}T${String(h).padStart(2, "0")}:00:30Z`))));
    const summer = etHoursOn("2026-07-15"), winter = etHoursOn("2027-01-15");
    const everySeason = [...summer].filter((h) => winter.has(h)).sort((a, b) => a - b);
    c.ok(`vercel.json fires the evening route at ${[...summer].sort().join("/")} ET in summer and ${[...winter].sort().join("/")} in winter: only 19 and 22 are reached all year`, everySeason.join() === "19,22" && [...settings.EVENING_SEND_HOURS].join() === "19,22", everySeason.join());
    const route = read("src/app/api/cron/evening/route.ts");
    c.ok("the route still acts only when the ET hour equals the setting", /hour === alerts\.uploadReminder\.hour/.test(route) && /hour === alerts\.uploadChaser\.hour/.test(route));
    const map = Object.fromEntries([18, 19, 20, 21, 22, 23, 0, 3, 12].map((h) => [h, settings.eveningSendHour(h, -1)]));
    c.ok("any other hour reads as the nearest real one (8 PM → 7, 9 PM → 10, midnight → 10, noon → 7)", map[19] === 19 && map[22] === 22 && map[20] === 19 && map[21] === 22 && map[23] === 22 && map[18] === 19 && map[0] === 22 && map[12] === 19 && settings.eveningSendHour(25, 19) === 19, JSON.stringify(map));

    await settings.putSetting("internal_alerts", { ...settings.DEFAULT_INTERNAL_ALERTS, uploadReminder: { enabled: true, hour: 20 }, uploadChaser: { enabled: true, hour: 23 } }, "drill");
    const oldSettings = (await import(baseline("src/lib/settings.ts"))) as typeof settings;
    const oldRules = await oldSettings.internalAlertRules();
    const rules = await settings.internalAlertRules();
    console.log(`\n  a stored 8 PM reminder / 11 PM chaser — BEFORE reads ${oldRules.uploadReminder.hour}/${oldRules.uploadChaser.hour} (sent only in summer), AFTER reads ${rules.uploadReminder.hour}/${rules.uploadChaser.hour} (every night)\n`);
    c.ok("BEFORE: the stored 20 and 23 were read as-is (they fire in summer only)", oldRules.uploadReminder.hour === 20 && oldRules.uploadChaser.hour === 23);
    c.ok("AFTER: they are read as 7 PM and 10 PM, for the cron and the split notice alike", rules.uploadReminder.hour === 19 && rules.uploadChaser.hour === 22);
    const off = await settings.eveningHoursOffSchedule();
    c.ok("…and the card is told what was saved, so it can say so", off.uploadReminder === 20 && off.uploadChaser === 23);

    const { saveInternalAlerts } = await import("@/app/settings/actions");
    await signIn(owner);
    const base = await settings.internalAlertRules();
    const save = (rem: number, cha: number, chaserOn = true) => saveInternalAlerts({ ...base, uploadReminder: { enabled: true, hour: rem }, uploadChaser: { enabled: chaserOn, hour: cha } });
    const r20 = await save(20, 22);
    c.ok("Settings refuses 8 PM for the reminder, naming the two real times", !r20.ok && /7 PM or 10 PM/.test(r20.message), r20.message);
    c.ok("…and 3 AM for the chaser", !(await save(19, 3)).ok);
    const same = await save(19, 19);
    c.ok("both on at the same hour is refused (only the reminder would go out)", !same.ok && /same hour/.test(same.message), same.message);
    c.ok("the same hour is fine when the chaser is off", (await save(22, 22, false)).ok);
    const good = await save(19, 22);
    const stored = JSON.parse((await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } }))!.value) as { uploadReminder: Props; uploadChaser: Props };
    c.ok("7 PM and 10 PM save, as exactly { enabled, hour }", good.ok && Object.keys(stored.uploadReminder).join() === "enabled,hour" && stored.uploadReminder.hour === 19 && stored.uploadChaser.hour === 22, good.message);
    const after2 = await settings.eveningHoursOffSchedule();
    c.ok("…after which there is nothing odd left to note", after2.uploadReminder === null && after2.uploadChaser === null);
    const ui = read("src/components/settings/OperatingRules.tsx");
    c.ok("the card offers exactly 7 PM and 10 PM, no 0-23 box", /const EVENING_CHOICES = \[19, 22\] as const/.test(ui) && !/label="Upload (reminder|chaser) hour"/.test(ui) && /savedAs=\{offSchedule\.uploadReminder\}/.test(ui));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
