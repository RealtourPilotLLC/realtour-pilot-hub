// ---------------------------------------------------------------------------
// DRILL: WHO SEES PAY (Oct 14 2026, reversed for their own pay Oct 27 2026).
// Oct 14 Jordan hid pay from Harrison and James ("It should just be their
// performance tracking page"); Oct 21 made it permanent and retired the "Team
// pay view" switch. Oct 27 Jordan: "Only I see old pay and new pay - Harrison
// and James should see their own pay schedule and amount and bonuses." So:
//   · the OWNER sees every number; Harrison and James (fixed pay, by roster
//     row) see THEIR OWN pay; a per-shoot creative sees their own; a login
//     with no pay structure, no linked member, or an inactive row sees none;
//     a missing viewer sees none;
//   · "view as" follows the previewed person: the owner previewing Harrison
//     sees Harrison's own page, previewing Kyle sees no pay;
//   · the old `pay_visibility` row is ignored, even one saying "not paused",
//     and nothing writes it: the switch, its card, its actions and its search
//     words are gone;
//   · the shoot pay card asks the same gate; the grouped menu renames the
//     door "My Performance" for a login with no pay (the role menus keep that
//     name for everyone); My Pay renders the scorecard for them, and
//     for Harrison and James their own fixed pay (never the per-shoot engine,
//     never anyone else's).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(REPO, rel));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5994) });
  const c = makeChecker();
  try {
    const settings = await import("@/lib/settings");
    const { payHiddenFor, putSetting } = settings;
    const { prisma } = await import("@/lib/prisma");

    c.head("1 · who sees pay: the owner everything, Harrison and James their own (Oct 27 2026)");
    const { payViewFor } = settings;
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison-view@drill.test", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 } as never });
    const james = await prisma.teamMember.create({ data: { name: "James Livingston", email: "james-view@drill.test", role: "PHOTOGRAPHER", payPercent: 0.3, payFloor: 75 } as never });
    const perShoot = await prisma.teamMember.create({ data: { name: "Pat Contractor", email: "pat-view@drill.test", role: "PHOTOGRAPHER", payPercent: 0.4, payFloor: 100 } as never });
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Office", email: "kyle-view@drill.test", role: "MANAGER" } as never });
    const gone = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison-old@drill.test", role: "PHOTOGRAPHER", payPercent: 0.35, active: false } as never });
    c.ok("Harrison (PHOTOGRAPHER, fixed pay) sees his own pay", (await payViewFor({ role: "PHOTOGRAPHER", teamMemberId: harrison.id })) === "fixed" && !(await payHiddenFor({ role: "PHOTOGRAPHER", teamMemberId: harrison.id })));
    c.ok("James (CREATIVE_MANAGER, fixed pay) sees his own pay", (await payViewFor({ role: "CREATIVE_MANAGER", teamMemberId: james.id })) === "fixed" && !(await payHiddenFor({ role: "CREATIVE_MANAGER", teamMemberId: james.id })));
    c.ok("a per-shoot creative sees their own per-shoot pay", (await payViewFor({ role: "PHOTOGRAPHER", teamMemberId: perShoot.id })) === "per_shoot");
    c.ok("an admin with no pay structure (Kyle) sees no pay", (await payViewFor({ role: "ADMIN", teamMemberId: kyle.id })) === "none" && await payHiddenFor({ role: "ADMIN", teamMemberId: kyle.id }));
    c.ok("a role with no linked team member sees no pay", await payHiddenFor({ role: "PHOTOGRAPHER" }) && await payHiddenFor({ role: "ADMIN" }) && await payHiddenFor({ role: "EDITOR" }));
    c.ok("an inactive roster row sees no pay (fixed pay needs the active row)", (await payViewFor({ role: "PHOTOGRAPHER", teamMemberId: gone.id })) === "none");
    c.ok("the owner sees every number", (await payViewFor({ role: "OWNER", realRole: "OWNER" })) === "owner" && !(await payHiddenFor({ role: "OWNER", realRole: "OWNER" })));
    c.ok("a missing viewer is hidden (fails closed)", await payHiddenFor(null) && await payHiddenFor({}));
    // "keep view as safe" (Oct 21 2026): a preview follows the previewed person.
    c.ok("view as: the owner previewing Harrison sees Harrison's own page", (await payViewFor({ role: "PHOTOGRAPHER", realRole: "OWNER", teamMemberId: harrison.id })) === "fixed");
    c.ok("view as: the owner previewing Kyle sees Kyle's page (no pay)", (await payViewFor({ role: "ADMIN", realRole: "OWNER", teamMemberId: kyle.id })) === "none");
    c.ok("view as: the owner previewing a role with nobody linked sees no pay", await payHiddenFor({ role: "PHOTOGRAPHER", realRole: "OWNER" }));
    c.ok("fixed pay rides no shoot's submit; per-shoot pay and the owner's do",
      !(await settings.shootPayRidesOnSubmit({ role: "PHOTOGRAPHER", teamMemberId: harrison.id }))
      && (await settings.shootPayRidesOnSubmit({ role: "PHOTOGRAPHER", teamMemberId: perShoot.id }))
      && (await settings.shootPayRidesOnSubmit({ role: "OWNER" }))
      && !(await settings.shootPayRidesOnSubmit({ role: "ADMIN", teamMemberId: kyle.id })));

    c.head("2 · the switch is gone, and its saved row no longer counts");
    // A saved row from the old switch that says "not paused" — the one setting
    // that used to put dollars back in front of Harrison and James.
    await putSetting("pay_visibility", { photographerPayPaused: false, pausedAt: null, pausedBy: null }, "drill");
    const rowBefore = await prisma.appSetting.findUnique({ where: { key: "pay_visibility" } });
    c.ok("an old 'not paused' row still shows no pay to a login with no pay structure", (await payHiddenFor({ role: "PHOTOGRAPHER" })) && (await payHiddenFor({ role: "ADMIN", teamMemberId: kyle.id })));
    c.ok("settings.ts no longer exports the switch's reader or default", !("payVisibilityRules" in settings) && !("DEFAULT_PAY_VISIBILITY" in settings));
    const actions = read("src/app/settings/actions.ts");
    c.ok("the settings actions no longer save or load it", !/export async function (savePayVisibility|loadPayVisibility)/.test(actions));
    c.ok("the Team pay view card is deleted", !exists("src/components/settings/PayVisibility.tsx"));
    const nav = read("src/lib/settingsNavigation.ts");
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    c.ok("no 'pay-view' card key, layout slot or search words remain", !/"pay-view"/.test(code(nav)) && !/Team pay view|Photographer pay view/.test(code(nav)));
    const page = read("src/app/settings/page.tsx");
    c.ok("the Settings page no longer renders the card or reads the row", !/PayVisibility|payVisibility|"pay-view"/.test(code(page)));
    const srcFiles = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) srcFiles(rel, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const readers = srcFiles("src").filter((f) => /pay_visibility/.test(code(read(f))));
    c.ok("no code in src reads or writes the pay_visibility row any more", readers.length === 0, readers.join(", "));
    const rowAfter = await prisma.appSetting.findUnique({ where: { key: "pay_visibility" } });
    c.ok("the row itself is left alone (no data writes)", JSON.stringify(rowAfter) === JSON.stringify(rowBefore));

    c.head("3 · the surfaces ask the one gate");
    const myPay = read("src/app/my-pay/page.tsx");
    c.ok("?as= (someone else's pay) is honoured for the owner only", /sp\.as && me\?\.realRole === "OWNER"/.test(myPay) && !/me\.role === "ADMIN"/.test(myPay));
    c.ok("a signed-out visitor is sent to login before the pay gate runs", myPay.indexOf('redirect("/login?next=/my-pay")') < myPay.indexOf("await payViewFor(me)"));
    c.ok("no pay structure: My Performance (scorecard only), before any payroll work",
      /if \(view === "none"\) return <MyPerformance[^\n]*showPay=\{false\}/.test(myPay) && myPay.indexOf('if (view === "none")') < myPay.indexOf("payHistoryFor(memberId)"));
    c.ok("Harrison and James: their OWN member id, with pay, before any payroll work",
      /if \(view === "fixed"\) return <MyPerformance memberId=\{me\?\.teamMemberId \?\? null\}[^\n]*showPay \/>/.test(myPay) && myPay.indexOf('if (view === "fixed")') < myPay.indexOf("payHistoryFor(memberId)"));
    const perf = myPay.slice(myPay.indexOf("async function MyPerformance"));
    c.ok("their page reads their own fixed pay and the scorecard, never the per-shoot engine",
      /QuarterScoreCard/.test(perf) && /ownFixedPayFor\(memberId, terms\)/.test(perf) && /showPay && terms \?/.test(perf) && !/payHistoryFor/.test(perf));
    c.ok("the team payroll link is the owner's only", /isOwner \? \(\s*<Link href="\/sales\?tab=payroll"/.test(myPay));
    const card = read("src/components/shoot/ShootPayCard.tsx");
    c.ok("the shoot screen's pay card asks the same gate", /payHiddenFor\(/.test(card) && /return null/.test(card));
    const sidebar = read("src/components/Sidebar.tsx");
    c.ok("the grouped menu renames the door My Performance for a login with no pay", /user\?\.payHidden\)[^\n]*label: "My Performance"/.test(sidebar));
    c.ok("the layout hands the flag to the menu", /payHidden/.test(read("src/app/layout.tsx")));
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.head("4 · the payday text goes only to someone who sees pay (Oct 21 2026)");
    {
      const { paydayPings } = await import("@/lib/payroll");
      const client = await prisma.client.create({ data: { name: "Payday Drill Client" } });
      const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-pay@drill.test", role: "PHOTOGRAPHER", payPercent: 0.4, payFloor: 0 } as never });
      const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison-pay@drill.test", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 } as never });
      const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", email: "james-pay@drill.test", role: "PHOTOGRAPHER", payPercent: 0.3, payFloor: 75 } as never });
      await prisma.appUser.create({ data: { email: "owner-pay@drill.test", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
      await prisma.appUser.create({ data: { email: "harrison-pay-login@drill.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
      await prisma.appUser.create({ data: { email: "james-pay-login@drill.test", role: "ADMIN", status: "ACTIVE", teamMemberId: jamesTm.id } });
      // A shoot each in the period Oct 4 to Oct 17, which pays Friday Oct 23.
      let n = 0;
      for (const tm of [jordanTm, harrisonTm, jamesTm]) {
        n++;
        await prisma.project.create({ data: { title: `${n} Payday Ln, Malvern, PA`, clientId: client.id, status: "DELIVERED", shootDate: new Date("2026-10-08T15:00:00Z"), payableInvoice: 500, appointments: { create: [{ aryeoId: `payday-appt-${n}`, startAt: new Date("2026-10-08T15:00:00Z"), status: "SCHEDULED", assignedToId: tm.id }] } } as never });
      }
      const r = await paydayPings(new Date("2026-10-23T12:00:00Z"));
      const lines = await prisma.pendingSms.findMany({ where: { line: { contains: "Payday:" } }, select: { teamMemberId: true } });
      c.ok("on payday: one text, to the owner only", JSON.stringify(r) === JSON.stringify({ pinged: 1 }) && lines.length === 1 && lines[0].teamMemberId === jordanTm.id, JSON.stringify({ r, lines }));
      c.ok("…Harrison and James get no pay figure", !lines.some((l) => l.teamMemberId === harrisonTm.id || l.teamMemberId === jamesTm.id));
      c.ok("…and the day is claimed once", JSON.stringify(await paydayPings(new Date("2026-10-23T13:00:00Z"))) === JSON.stringify({ skipped: "already pinged today" }));
      c.ok("not a payday: nothing", JSON.stringify(await paydayPings(new Date("2026-10-22T12:00:00Z"))) === JSON.stringify({ skipped: "not a payday" }));
    }

    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
