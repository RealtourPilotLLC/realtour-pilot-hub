// ---------------------------------------------------------------------------
// DRILL: PAY HIDDEN, PERFORMANCE SHOWN (Oct 14 2026). Jordan: "shut down the
// my pay for both Harrison and James. They should not be seeing their pay
// anymore on the shoot page or on the my pay page. It should just be their
// performance tracking page. And tracking their bonus."
//   · with the pause on, a PHOTOGRAPHER and an ADMIN (James's role) are hidden;
//     the OWNER, and an owner previewing with view-as, are not;
//   · with the pause off, nothing is hidden;
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

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5994) });
  const c = makeChecker();
  try {
    const { payHiddenFor, putSetting, DEFAULT_PAY_VISIBILITY } = await import("@/lib/settings");
    // Oct 20 2026 (audit G6): the gate fails CLOSED. No saved row (and a failed
    // read, which returns the same default) means hidden, and so does a viewer
    // the page could not resolve. This drill used to assert the opposite for a
    // missing user.
    c.ok("no saved row or a failed read: pay is hidden (the default)", DEFAULT_PAY_VISIBILITY.photographerPayPaused === true);
    c.ok("a fresh database hides pay from a photographer before anyone saves the switch", await payHiddenFor({ role: "PHOTOGRAPHER" }));
    // putSetting, as the Settings card does, so the in-process settings cache is cleared.
    const set = (on: boolean) => putSetting("pay_visibility", { photographerPayPaused: on, pausedAt: null, pausedBy: null }, "drill");
    await set(true);
    c.ok("paused: a photographer (Harrison) does not see pay", await payHiddenFor({ role: "PHOTOGRAPHER" }));
    c.ok("paused: an admin with his own pay view (James) does not see pay", await payHiddenFor({ role: "ADMIN" }));
    c.ok("paused: the owner still sees every number", !(await payHiddenFor({ role: "OWNER" })));
    c.ok("paused: the owner previewing as a photographer still sees it", !(await payHiddenFor({ role: "PHOTOGRAPHER", realRole: "OWNER" })));
    c.ok("paused: a missing user is hidden (fails closed)", await payHiddenFor(null));
    await set(false);
    c.ok("not paused: the photographer and admin see their pay again", !(await payHiddenFor({ role: "PHOTOGRAPHER" })) && !(await payHiddenFor({ role: "ADMIN" })));
    c.ok("not paused: a missing user is still hidden", await payHiddenFor(null));
    const myPay = read("src/app/my-pay/page.tsx");
    c.ok("?as= (someone else's pay) is honoured for the owner only", /sp\.as && \(me \? me\.realRole === "OWNER"/.test(myPay) && !/me\.role === "ADMIN"/.test(myPay));
    c.ok("a signed-out visitor is sent to login before the pay gate runs", myPay.indexOf('redirect("/login?next=/my-pay")') < myPay.indexOf("await payHiddenFor(me)"));
    const card = read("src/components/shoot/ShootPayCard.tsx");
    c.ok("the shoot screen's pay card asks the same gate", /payHiddenFor\(/.test(card) && /return null/.test(card));
    const page = read("src/app/my-pay/page.tsx");
    c.ok("the page renders My Performance (scorecard) when hidden, before any payroll work", /if \(await payHiddenFor\(me\)\) return <MyPerformance/.test(page) && page.indexOf("return <MyPerformance") < page.indexOf("payHistoryFor(memberId)"));
    const perf = page.slice(page.indexOf("async function MyPerformance"));
    c.ok("My Performance shows the quarterly scorecard and never the pay engine", /QuarterScoreCard/.test(perf) && !/payHistoryFor|usd\(/.test(perf));
    const nav = read("src/components/Sidebar.tsx");
    c.ok("the menu calls it My Performance while pay is hidden", /user\?\.payHidden\)[^\n]*label: "My Performance"/.test(nav));
    c.ok("the layout hands the flag to the menu", /payHidden/.test(read("src/app/layout.tsx")));
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
