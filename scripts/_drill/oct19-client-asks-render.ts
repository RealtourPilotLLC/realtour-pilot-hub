// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: "Open client asks on this job" in the Review Room, and the rows on
// Kyle's Special requests and Scheduling screens (Oct 19 2026), rendered.
//
//   · the card: its title and count; the delivery line names what is held and
//     says approving is not blocked; each ask's one line, who, how, when,
//     what it holds; the client's own words folded under it; Confirmed and
//     Not needed on every ask, Done only on one that holds nothing;
//   · no asks: no card at all;
//   · no em dash anywhere in the new words.
// (The board rows Kyle's old Special requests and Scheduling screens used,
// components/asks/AskBoard, were deleted Oct 20 2026, audit H13: no screen
// rendered them after the requests moved onto the checklist and job cards.)
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { AskView } from "@/lib/clientAsks";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/review/x";
  nav.useSearchParams = () => new URLSearchParams();
}
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
const DASH = /[—–]|&mdash;|&ndash;/;

const ask = (p: Partial<AskView> & { id: string }): AskView => ({
  kind: "SPECIAL_REQUEST", clientId: "cl1", clientName: "Heather Barritt", projectId: "p1", street: "Barry Rd", medium: "photo",
  text: "Just like the pennfield output. It needs to have all 4 lots overlayed", summary: "Overlay all 4 lots with their numbers, like the Pennfield output",
  source: "text", sourceWords: "Text", askedBy: "Heather Barritt", askedAtISO: "2026-10-15T18:21:26Z", whenWords: "Thu, Oct 15, 2:21 PM", state: "OPEN",
  holdsDelivery: true, dueAtISO: "2026-10-16T16:00:00Z", dueWords: "Fri, Oct 16, 12:00 PM", behind: false, dueToday: false, closedWords: null, ...p,
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5839) });
  const c = makeChecker();
  try {
    const { OpenClientAsksCard } = await import("@/components/asks/OpenClientAsksCard");

    c.head("the Review Room card");
    const lots = ask({ id: "a1" });
    const video = ask({ id: "a2", medium: "video", summary: "Add the lot lines on the drone video where the whole map shows", text: "Can the lot lines be added on the drone video? In some spots where the entire map can be overlayed?", whenWords: "Thu, Oct 15, 2:02 PM" });
    const addon = ask({ id: "a3", medium: "both", source: "order_note", sourceWords: "Order note", holdsDelivery: false, summary: "Lot lines ordered: check it is on the finished work and correct", text: "Ordered: Lot Lines", askedBy: "Heather Barritt" });
    const h = html(createElement(OpenClientAsksCard, { asks: [lots, video, addon], deliverWhat: "video" }));
    const t = text(h);
    c.ok("titled 'Open client asks on this job' with the count", /Open client asks on this job · 3/.test(t), t.slice(0, 120));
    c.ok("the delivery line: check before it's sent, approving is not blocked", t.includes("Check this request on the video before it&#x27;s sent. Approving is not blocked.") || t.includes("Check this request on the video before it's sent. Approving is not blocked."), t.slice(0, 260));
    c.ok("each ask's one line, who, how and when", t.includes("Overlay all 4 lots with their numbers, like the Pennfield output") && t.includes("Heather Barritt · Text · Thu, Oct 15, 2:21 PM"));
    c.ok("what each holds, in words", t.includes("Holds the photos") && t.includes("Holds the video") && t.includes("To check"));
    c.ok("the client's own words, folded under the line", /<details[^>]*>\s*<summary[^>]*>The client’s words<\/summary>\s*<p[^>]*>Just like the pennfield output\. It needs to have all 4 lots overlayed<\/p>/.test(h.replace(/&rsquo;/g, "’")));
    const confirms = (h.match(/data-ask-confirm/g) ?? []).length;
    const nots = (h.match(/data-ask-not-needed/g) ?? []).length;
    const dones = (h.match(/data-ask-done/g) ?? []).length;
    c.ok("Confirmed and Not needed on every ask", confirms === 3 && nots === 3, `${confirms} ${nots}`);
    c.ok("Done only on the ask that holds nothing (the add-on)", dones === 1 && /data-ask-id="a3"[\s\S]*data-ask-done/.test(h) && !/data-ask-id="a1"[\s\S]*?data-ask-done[\s\S]*?data-ask-id="a2"/.test(h));
    c.ok("no checklist, no tick boxes", !/type="checkbox"/.test(h));
    c.ok("no em dash", !DASH.test(h));
    const two = text(html(createElement(OpenClientAsksCard, { asks: [lots, ask({ id: "a4", medium: "both" }), ask({ id: "a5", medium: "unclear" })], deliverWhat: "photo" })));
    c.ok("the photo page: 'these 3 requests'", two.includes("Check these 3 requests on the photos before it") , two.slice(0, 200));
    const none = text(html(createElement(OpenClientAsksCard, { asks: [addon], deliverWhat: "video" })));
    c.ok("nothing holding: what the client asked us to get right", none.includes("What the client asked us to get right. Check the work against these."));
    c.ok("no asks: no card at all", html(createElement(OpenClientAsksCard, { asks: [], deliverWhat: "video" })) === "");
    c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
