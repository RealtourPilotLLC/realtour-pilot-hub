// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the "Before you send" job box, rendered (Oct 19 2026,
// components/jobs/BeforeYouSend). The data side is oct19-job-box.ts.
//
//   · titled "Before you send · the video / the photos";
//   · in this order, only what exists: Flagged at the shoot (words, who,
//     when), Client requests (line, who, when, medium; the client's words
//     folded when they differ; ONE Checked), Notes (label: line);
//   · the Checked button only for who may press it; anyone else reads "Kyle
//     checks these before the video goes out";
//   · hideNotes (the editor brief) leaves the notes out; after a Checked, the
//     box says who checked the requests; nothing at all renders nothing;
//   · compact (the Ready to send rows): notes one line each, no folded words;
//   · no em dash anywhere.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { JobChecks } from "@/lib/jobChecks";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery/x";
  nav.useSearchParams = () => new URLSearchParams();
}
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
const DASH = /[—–]|&mdash;|&ndash;/;

const data: JobChecks = {
  projectId: "p-oak-88",
  flags: [
    { id: "f1", text: "Drone footage is shaky on the second pass", by: "Harrison Lee", atISO: "2026-10-19T15:10:00Z", about: "video" },
    { id: "f2", text: "Upload stalled, the files may be missing a few", by: "Harrison Lee", atISO: "2026-10-19T15:40:00Z", about: "delivery" },
  ],
  requests: [
    { id: "r1", summary: "Use the upbeat song", text: "Use the upbeat song", askedBy: "Heather Barritt", askedAtISO: "2026-10-19T14:00:00Z", medium: "video" },
    { id: "r2", summary: "Lot lines on photos and video", text: "Lot lines on everything please, like the Pennfield output", askedBy: "Heather Barritt", askedAtISO: "2026-10-19T14:10:00Z", medium: "both" },
  ],
  notes: [
    { label: "On the order", text: "Please feature the new kitchen." },
    { label: "Add-on ordered", text: "Lot Lines: check it is on the finished work and correct." },
    { label: "Video notes", text: "Keep it under a minute." },
  ],
  openRequests: 2,
  checked: null,
};

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5873) });
  const c = makeChecker();
  try {
    const { BeforeYouSendView } = await import("@/components/jobs/BeforeYouSend");
    const box = (over: Partial<Parameters<typeof BeforeYouSendView>[0]> = {}) => html(createElement(BeforeYouSendView, { data, medium: "video", canCheck: true, ...over }));

    c.head("the box");
    const h = box();
    const t = text(h);
    c.ok("titled 'Before you send · the video'", /Before you send · the video/.test(t), t.slice(0, 120));
    c.ok("in order: Flagged at the shoot, Client requests, Notes", t.indexOf("Flagged at the shoot") > 0 && t.indexOf("Flagged at the shoot") < t.indexOf("Client requests") && t.indexOf("Client requests") < t.indexOf("Notes"));
    c.ok("each flag: the creative's words, who and when", t.includes("Drone footage is shaky on the second pass") && /Harrison Lee · Mon, Oct 19, 11:10 AM/.test(t), t);
    c.ok("each request: the line, who, when, the medium", t.includes("Use the upbeat song") && /Heather Barritt · Mon, Oct 19, 10:00 AM · video/.test(t) && /photos and video/.test(t));
    c.ok("the client's words folded only where they differ from the line", (h.match(/<details/g) ?? []).length === 1 && /The client’s words[\s\S]*like the Pennfield output/.test(h.replace(/&rsquo;/g, "’")));
    c.ok("ONE Checked for all of them", (h.match(/data-job-checked/g) ?? []).length === 1 && t.includes("Check these on the video, then press Checked once.") && t.includes("Client requests · 2"));
    c.ok("notes: label and line", t.includes("On the order: Please feature the new kitchen.") && t.includes("Video notes: Keep it under a minute."));
    c.ok("no tick boxes", !/type="checkbox"/.test(h));

    c.head("who may press it, and the editor brief");
    const noBtn = text(box({ canCheck: false }));
    c.ok("someone who may not press it: no button, 'Kyle checks these before the video goes out.'", !/data-job-checked/.test(box({ canCheck: false })) && noBtn.includes("Kyle checks these before the video goes out."));
    const photo = text(box({ medium: "photo", canCheck: false, data: { ...data, requests: [data.requests[1]], openRequests: 1 } }));
    c.ok("…on the photos: 'Kyle checks this before the photos go out.'", photo.includes("Before you send · the photos") && photo.includes("Kyle checks this before the photos go out."));
    const brief = text(box({ hideNotes: true, canCheck: false }));
    c.ok("hideNotes (the editor brief): flags and requests, no Notes", brief.includes("Flagged at the shoot") && brief.includes("Client requests") && !brief.includes("Notes") && !brief.includes("Keep it under a minute"));
    const onlyNotes = box({ hideNotes: true, data: { ...data, flags: [], requests: [], openRequests: 0 } });
    c.ok("…and with nothing but notes there, nothing renders", onlyNotes === "");

    c.head("after Checked, compact, nothing");
    const after = text(box({ data: { ...data, requests: [], openRequests: 0, checked: { by: "Kyle Smith", atISO: "2026-10-19T19:02:00Z", count: 2 } } }));
    c.ok("no requests left: 'Client requests checked by Kyle Smith, Mon, Oct 19, 3:02 PM.'", after.includes("Client requests checked by Kyle Smith, Mon, Oct 19, 3:02 PM.") && !after.includes("Client requests ·"));
    const compact = box({ compact: true });
    c.ok("compact: notes one line each, no folded words, the one button", /line-clamp-1/.test(compact) && !/<details/.test(compact) && /data-job-checked/.test(compact));
    c.ok("nothing to show: nothing renders", box({ data: { projectId: "p", flags: [], requests: [], notes: [], openRequests: 0 } }) === "");
    c.ok("no em dash anywhere", !DASH.test(h) && !DASH.test(compact) && !DASH.test(box({ canCheck: false })));
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
