// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the program watch on screen (Oct 15 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-program-watch-render.ts
//
// The Project Tracker's "Program videos behind schedule": each video's level,
// why, its milestones (met, late, missed, ahead), the suggested cause, the
// recorded one, the control to record a cause (office only, and only once the
// database has the columns), the switches. The client's line under a video in
// production. No em dashes in anything the office or a client reads.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { WatchViewRow } from "@/components/tracker/ProgramVideoWatch";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/pipeline";
  nav.useSearchParams = () => new URLSearchParams();
}
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
// Tags become spaces; a space a tag left before punctuation is not the page's.
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ").replace(/ ([.,)])/g, "$1");
const DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7164) });
  const c = makeChecker();
  try {
    const { ProgramVideoWatch } = await import("@/components/tracker/ProgramVideoWatch");
    const { ExpectedLine } = await import("@/components/portal/ExpectedLine");
    const rows: WatchViewRow[] = [
      {
        outputId: "o2", projectId: "p1", enrollmentId: "e1", clientName: "Dana Rivers", monthWords: "October 2026", title: "Tip #2", level: "late",
        why: "past its promise (Mon, Oct 19, 5:00 PM ET), editing, no cut yet", promise: "Mon, Oct 19, 5:00 PM ET",
        milestones: [
          { label: "Footage in", by: "Tue, Oct 6, 5:00 PM ET", state: "met" },
          { label: "Editing started", by: "Thu, Oct 8, 5:00 PM ET", state: "met" },
          { label: "First cut in review", by: "Mon, Oct 12, 5:00 PM ET", state: "missed" },
          { label: "Final approved", by: "Thu, Oct 15, 5:00 PM ET", state: "missed" },
          { label: "On the client's portal", by: "Mon, Oct 19, 5:00 PM ET", state: "missed" },
        ],
        suggestion: { cause: "EDIT_CAPACITY", why: "the editor had the footage and the brief and no cut came in on time" },
        recorded: { cause: "EDIT_CAPACITY", note: "Kim had three months due", by: "Kyle Smith", at: "2026-10-12T17:00:00.000Z" },
      },
      {
        outputId: "o3", projectId: "p1", enrollmentId: "e1", clientName: "Dana Rivers", monthWords: "October 2026", title: "Tip #3", level: "risk",
        why: "editing should have started by Thu, Oct 8, 5:00 PM ET; now footage in, editing not started", promise: "Mon, Oct 19, 5:00 PM ET",
        milestones: [{ label: "Footage in", by: "Tue, Oct 6, 5:00 PM ET", state: "late" }, { label: "Editing started", by: "Thu, Oct 8, 5:00 PM ET", state: "missed" }, { label: "First cut in review", by: "Mon, Oct 12, 5:00 PM ET", state: "ahead" }],
        suggestion: { cause: "SLOW_HANDOFF", why: "the footage is in and no editor has been named" },
        recorded: null,
      },
    ];
    const rules = { alerts: true, chaseEscalation: true, portalExpectedBy: false, libraryRepoint: false };

    c.head("the tracker panel");
    const office = html(createElement(ProgramVideoWatch, { rows, rules, canEdit: true, causesAvailable: true }));
    const t = text(office);
    c.ok("the heading and the counts", /Program videos behind schedule/.test(t) && /1 past the promise · 1 behind a milestone/.test(t), t.slice(0, 200));
    c.ok("each video: its level, title, client and month, and why", /Past its promise/.test(t) && /Behind schedule/.test(t) && /Tip #2/.test(t) && /Dana Rivers · October 2026/.test(t) && /editing should have started by Thu, Oct 8/.test(t));
    c.ok("the milestones, marked met, late and missed", /Footage in by Tue, Oct 6, 5:00 PM ET ✓/.test(t) && /First cut in review by Mon, Oct 12, 5:00 PM ET \(missed\)/.test(t) && /Footage in by Tue, Oct 6, 5:00 PM ET \(late\)/.test(t));
    c.ok("the suggested cause with its evidence, and the recorded one with who", /Suggested cause: Slow handoff to the editor, because the footage is in and no editor has been named\./.test(t) && /Recorded: Editing capacity by Kyle Smith\. Kim had three months due/.test(t));
    c.ok("the office gets a cause picker, pre-filled from the record, else the suggestion", (office.match(/<select/g) ?? []).length === 2 && /<option value="EDIT_CAPACITY" selected="">/.test(office) && /<option value="SLOW_HANDOFF" selected="">Slow handoff to the editor \(suggested\)/.test(office), office.match(/<option[^>]*selected[^>]*>[^<]*/g)?.join(" | "));
    c.ok("…the seven causes and \"Not decided yet\"", (office.match(/<option /g) ?? []).length === 16);
    c.ok("links to the job, the client's videos and the draft list", /href="\/edit\/p1"/.test(office) && /href="\/content\/e1\?tab=production&amp;view=videos"/.test(office) && /href="\/tasks\?tab=comms#at-risk"/.test(office));
    c.ok("the switches, with plain words, the portal date and re-point off", /Show clients &quot;expected by&quot; dates on their portal|Show clients "expected by" dates on their portal/.test(office) && /id="pw-portalExpectedBy"/.test(office) && !/id="pw-portalExpectedBy"[^>]*checked/.test(office) && /id="pw-alerts"[^>]*checked/.test(office));
    c.ok("no em dashes", !DASH.test(t));
    const viewer = html(createElement(ProgramVideoWatch, { rows, rules, canEdit: false, causesAvailable: true }));
    c.ok("someone who is not the office sees the list, no picker, switches locked", !/<select/.test(viewer) && /Only the owner or the office can change these/.test(text(viewer)) && /disabled=""/.test(viewer));
    const noCols = html(createElement(ProgramVideoWatch, { rows, rules, canEdit: true, causesAvailable: false }));
    c.ok("before the database update: no picker, and it says when it turns on", !/<select/.test(noCols) && /Recording a cause turns on after tonight’s database update/.test(text(noCols)));
    const empty = text(html(createElement(ProgramVideoWatch, { rows: [], rules, canEdit: true, causesAvailable: true })));
    c.ok("nothing behind: one calm line", /none right now/.test(empty) && /Every program video is on schedule against its milestones/.test(empty));

    c.head("the client's line");
    const on = text(html(createElement(ExpectedLine, { e: { stage: "Being edited", line: "Expected by Mon, Oct 26", reason: null, movedFrom: null, late: false } })));
    c.ok("\"Being edited. Expected by Mon, Oct 26.\"", on.trim() === "Being edited. Expected by Mon, Oct 26.", on);
    const moved = text(html(createElement(ExpectedLine, { e: { stage: "Being edited", line: "Now expected by Wed, Oct 28", reason: "Our editing team needed a little more time than we planned.", movedFrom: "Mon, Oct 26", late: false } })));
    c.ok("moved: the new date, the old one, the reason", moved.trim() === "Being edited. Now expected by Wed, Oct 28 (was Mon, Oct 26). Our editing team needed a little more time than we planned.", moved);
    const behind = text(html(createElement(ExpectedLine, { e: { stage: "In our quality check", line: "Running a little behind. We'll confirm the new date with you.", reason: "We needed a little more time to get it right.", movedFrom: null, late: true } })));
    c.ok("behind: no date, no doubled full stop", behind.trim() === "In our quality check. Running a little behind. We'll confirm the new date with you. We needed a little more time to get it right.", behind);
    c.ok("no em dashes", !DASH.test(on + moved + behind));
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
