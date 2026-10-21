// ---------------------------------------------------------------------------
// DRILL: PAY HIDDEN, PERFORMANCE SHOWN (Oct 14 2026, permanent Oct 21 2026).
// Jordan, Oct 14: "shut down the my pay for both Harrison and James. They
// should not be seeing their pay anymore on the shoot page or on the my pay
// page. It should just be their performance tracking page. And tracking their
// bonus." Oct 21: only Jordan sees pay, permanently; the "Team pay view"
// switch is retired.
//   · a PHOTOGRAPHER, an ADMIN (James's role) and an EDITOR are hidden; the
//     OWNER is not; a missing viewer is hidden;
//   · "view as" follows the previewed person: the owner previewing a
//     photographer sees what the photographer sees (hidden);
//   · the old `pay_visibility` row is ignored, even one saying "not paused",
//     and nothing writes it: the switch, its card, its actions and its search
//     words are gone;
//   · the shoot pay card asks the same gate; the menu calls the page
//     "My Performance"; the page renders the scorecard, never the pay engine.
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

    c.head("1 · who sees pay: the owner, and nobody else");
    c.ok("a photographer (Harrison) does not see pay", await payHiddenFor({ role: "PHOTOGRAPHER" }));
    c.ok("an admin with a My Pay grant (James) does not see pay", await payHiddenFor({ role: "ADMIN" }));
    c.ok("an editor does not see pay", await payHiddenFor({ role: "EDITOR" }));
    c.ok("the owner sees every number", !(await payHiddenFor({ role: "OWNER", realRole: "OWNER" })));
    c.ok("a missing viewer is hidden (fails closed)", await payHiddenFor(null) && await payHiddenFor({}));
    // Oct 21 2026: "keep view as safe" — a preview follows the previewed person.
    // This used to read realRole first, so the owner previewing Harrison saw
    // Harrison's dollars on screens where Harrison never sees them.
    c.ok("view as: the owner previewing a photographer sees the photographer's page (hidden)", await payHiddenFor({ role: "PHOTOGRAPHER", realRole: "OWNER" }));
    c.ok("view as: the owner previewing an admin sees the admin's page (hidden)", await payHiddenFor({ role: "ADMIN", realRole: "OWNER" }));

    c.head("2 · the switch is gone, and its saved row no longer counts");
    // A saved row from the old switch that says "not paused" — the one setting
    // that used to put dollars back in front of Harrison and James.
    await putSetting("pay_visibility", { photographerPayPaused: false, pausedAt: null, pausedBy: null }, "drill");
    const rowBefore = await prisma.appSetting.findUnique({ where: { key: "pay_visibility" } });
    c.ok("an old 'not paused' row still hides pay from the photographer and the admin", (await payHiddenFor({ role: "PHOTOGRAPHER" })) && (await payHiddenFor({ role: "ADMIN" })));
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
    c.ok("a signed-out visitor is sent to login before the pay gate runs", myPay.indexOf('redirect("/login?next=/my-pay")') < myPay.indexOf("await payHiddenFor(me)"));
    c.ok("the page renders My Performance (scorecard) when hidden, before any payroll work", /if \(await payHiddenFor\(me\)\) return <MyPerformance/.test(myPay) && myPay.indexOf("return <MyPerformance") < myPay.indexOf("payHistoryFor(memberId)"));
    const perf = myPay.slice(myPay.indexOf("async function MyPerformance"));
    c.ok("My Performance shows the quarterly scorecard and never the pay engine", /QuarterScoreCard/.test(perf) && !/payHistoryFor|usd\(/.test(perf));
    const card = read("src/components/shoot/ShootPayCard.tsx");
    c.ok("the shoot screen's pay card asks the same gate", /payHiddenFor\(/.test(card) && /return null/.test(card));
    const sidebar = read("src/components/Sidebar.tsx");
    c.ok("the menu calls it My Performance while pay is hidden", /user\?\.payHidden\)[^\n]*label: "My Performance"/.test(sidebar));
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
