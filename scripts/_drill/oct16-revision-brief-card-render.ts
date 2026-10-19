// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: a client ask the hub has not split yet, on the editor's card
// (Oct 16 2026), rendered.
//
// Kim, Oct 14: "it didn't appear on my end and needed to go deeper in the
// notes." An unsplit brief used to open on nothing (the card starts shut, and
// with no items there was nothing to count). Now, until the split lands, the
// client's own words are item 1 ("Not split into items yet. The client's
// words:"), the card opens on them and the header says "1 ask". A failed
// reading says the hub will try again by itself. A split brief is unchanged.
// No em dashes in the new words.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { BriefView } from "@/lib/revisionBrief";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/edit/x";
  nav.useSearchParams = () => new URLSearchParams();
}
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5833) });
  const c = makeChecker();
  try {
    const { RevisionBriefCard } = await import("@/components/editing/RevisionBriefCard");
    const base: BriefView = {
      id: "b1", source: "openphone", sourceDetail: null, createdAtISO: "2026-10-14T19:31:00Z",
      originalText: "Hi guys, is it possible to not have the start of the video on this frame of my face? Can we rewind it a bit more",
      twoSided: false, headline: null, analyzed: false, analysisError: null, items: [], keep: [], references: [], questions: [], done: [],
      cutNames: {}, requestedBy: "Georgiana", requestedByKind: "TEXT", outputId: null, taskId: null, creativeReview: null,
    };
    const render = (b: BriefView, canReanalyze = false) => html(createElement(RevisionBriefCard, { briefs: [b], bounced: [], canTick: false, canReanalyze }));

    c.head("not split yet");
    const h1 = render(base);
    const t1 = text(h1);
    c.ok("the client's words are item 1, under the plain label", /data-unsplit-ask/.test(h1) && t1.includes("Not split into items yet. The client’s words:") && t1.includes("rewind it a bit more"), t1.slice(0, 300));
    c.ok("the card opens on them (no click needed) and the header says 1 ask", /1 ask/.test(t1) && /<ol[^>]*data-unsplit-ask/.test(h1));
    c.ok("numbered 1", /data-unsplit-ask[^>]*>\s*<li[^>]*>\s*<span[^>]*>1<\/span>/.test(h1));
    c.ok("with no failure yet, no 'try again' line", !/try again by itself/.test(t1));
    const h2 = render({ ...base, analysisError: "Try 2 of 3 failed: the model is down" }, true);
    const t2 = text(h2);
    c.ok("a failed reading: the words still item 1, and the hub will try again by itself", t2.includes("Not split into items yet") && /will try again by itself\. Or press Re-read below\./.test(t2), t2.slice(0, 400));
    c.ok("the raw error never reaches the editor", !/model is down|Try 2 of 3/.test(t2));
    const newWords = (h1.match(/data-unsplit-ask[\s\S]*?<\/ol>/)?.[0] ?? "") + (h2.match(/data-unsplit-ask[\s\S]*?<\/ol>/)?.[0] ?? "");
    c.ok("no em dash in the new words", newWords.length > 0 && !/[—–]|&mdash;/.test(newWords));

    c.head("split, and read-with-nothing-to-change");
    const split = render({ ...base, analyzed: true, headline: "Start the video earlier", items: [{ id: "i1", area: "Cuts & content", ask: "Start the video a little earlier", scope: "all" }, { id: "i2", area: "Pacing & movement", ask: "Crop in so her leg is out of frame", scope: "all" }] });
    const ts = text(split);
    c.ok("a split brief: no unsplit label, the count reads 0/2, the card starts shut as before", !/Not split into items yet/.test(ts) && /0\/2 complete/.test(ts) && !/1 ask/.test(ts) && !/data-unsplit-ask/.test(split));
    const question = render({ ...base, analyzed: true, headline: "No edit requests" });
    const tq = text(question);
    c.ok("read, and it held no change (a question): no 'not split' label, no 1 ask", !/Not split into items yet/.test(tq) && !/1 ask/.test(tq));
    c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    c.summary();
    await db.stop();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
