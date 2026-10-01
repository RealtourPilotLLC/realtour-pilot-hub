// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Existing work-view addresses and first-paint stage evidence only; no writes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { resolveStaffTab } from "@/lib/contentNav";
import type { JourneyInput } from "@/lib/contentStatus";

installNextStubs();
async function main() {
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { MonthJourney, VideoMeter, monthJourneyLinks } = await import("@/components/content/MonthJourney");
    const row = { enrollmentId: "fixture-enrollment", monthId: "fixture-month", monthKey: "2026-09", planning: { callStatus: "COMPLETED" } } as Parameters<typeof monthJourneyLinks>[0];
    const input: JourneyInput = { callStatus: "COMPLETED", topicsSelected: 2, scriptsReady: 1, scriptsAwaiting: 1, videosOwed: 2, sessionsRequired: 2, sessionsConfirmed: 1, sessionsFilmedConfirmed: 0, delivered: 0, inReview: 1, unknown: { shoot: "Exact fixture appointment could not be checked" } };
    const expect = { call: ["plan", "calls"], topics: ["plan", "topics"], scripts: ["plan", "scripts"], shoot: ["production", "sessions"] };
    for (const monthKey of ["2026-09", "2026-10", "2025-12", "2027-01"]) {
      const links = monthJourneyLinks({ ...row, monthKey });
      c.ok(`${monthKey} milestones keep the exact enrollment/month and canonical work view`, Object.entries(links).length === 4 && Object.entries(links).every(([key, target]) => {
        const u = new URL(target, "http://fixture.invalid");
        const [tab, view] = expect[key as keyof typeof expect];
        const resolved = resolveStaffTab(u.searchParams.get("tab"), u.searchParams.get("view"));
        return u.pathname === "/content/fixture-enrollment" && u.searchParams.get("month") === monthKey && resolved.tab === tab && resolved.view === view && !resolved.redirect;
      }));
    }
    c.ok("a written route's unneeded call stays information, with three real month-work destinations", !monthJourneyLinks({ ...row, planning: { ...row.planning, callStatus: "NOT_REQUIRED" } }).call && Object.keys(monthJourneyLinks({ ...row, planning: { ...row.planning, callStatus: "NOT_REQUIRED" } })).length === 3);
    c.ok("Delivered cannot pretend the existing all-month library is month-specific", !monthJourneyLinks(row).delivered);
    c.ok("no month workspace cannot invent a destination to another month", Object.keys(monthJourneyLinks({ ...row, monthId: null })).length === 0);
    c.ok("malformed month evidence stays informational", ["", "2026-13", "2026-0", "2026-09&other=1"].every((monthKey) => Object.keys(monthJourneyLinks({ ...row, monthKey })).length === 0));
    const links = monthJourneyLinks(row);
    const html = renderToStaticMarkup(createElement(MonthJourney, { input, hrefs: links, contextLabel: "Fixture Client, September 2026" }));
    c.ok("four actual month-work destinations render as native links without nested controls", (html.match(/<a /g) ?? []).length === 4 && !/<a[^>]*>[^]*?<button/.test(html));
    c.ok("stage links name the client, selected month, recorded stage and action", (html.match(/aria-label="Fixture Client, September 2026:/g) ?? []).length === 4 && html.includes("Scripts: 1 to review. Open scripts."));
    const text = html.replace(/<[^>]*>/g, " ");
    c.ok("unknown stage evidence is visible in text, not confined to hover", text.includes("Shoot: Exact fixture appointment could not be checked") && text.includes("unknown"));
    const informational = renderToStaticMarkup(createElement(MonthJourney, { input }));
    c.ok("without supplied destinations all stages remain informational", !informational.includes("<a ") && !informational.includes("<button") && informational.includes("Exact fixture appointment could not be checked"));
    const meter = renderToStaticMarkup(createElement(VideoMeter, { delivered: 1, owed: 2, inReview: 1, unknown: "Fixture library read unavailable" }));
    c.ok("unknown delivery count has an explicit visible cause with retained recorded figures", meter.replace(/<[^>]*>/g, " ").includes("Delivery count could not be confirmed: Fixture library read unavailable.") && meter.includes("count unknown") && meter.includes("1 in review"));
    c.ok("stage presentation performs no provider requests", fence.blocked.length === 0);
    console.log("Boundary: pure addresses and initial server markup. Normal-role browser, keyboard, card widths and month-return acceptance remain open.");
    c.summary();
  } finally { fence.restore(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
