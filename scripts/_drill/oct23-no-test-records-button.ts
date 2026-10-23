// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: no "Show test records" button anywhere (Oct 23 2026).
//
//   DRILL_PORT=7101 node scripts/_drill/run-all.cjs scripts/_drill/oct23-no-test-records-button.ts
//
// Jordan: "I don't need the show test records button anymore." Every toggle
// or link that turned test records on or off is gone from the screens (the
// dashboard, the Shoots board, the Schedule, the Editing Room, Kyle's list,
// the Review Room, Messages, Tasks, Content, Quality). What stays: the rule
// that hides the synthetic (TEST) clients (syntheticClientIds) on every one
// of those screens, so a future test client stays hidden.
//
//   1 · static: no "Show/Hide test records" (or "Show/Hide tests") and no
//       link that adds ?test=1 as a toggle, in any page or component
//   2 · static: the screens still read syntheticClientIds (the hiding rule)
//   3 · rendered: the Schedule's view toggle has List and Map only
//
// No database; nothing leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const REPO = path.resolve(__dirname, "../..");

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(REPO, rel));
  return out;
}
/** The code without its comments (a comment may say why the button is gone). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\s*\}/g, "");

async function main() {
  const c = makeChecker();
  try {
    c.head("1 · no test-records toggle on any screen");
    const ui = [...filesUnder("src/app"), ...filesUnder("src/components")];
    const toggles = ui.filter((f) => /Show test records|Hide test records|Show tests|Hide tests/i.test(code(fs.readFileSync(f, "utf8")))).map((f) => path.relative(REPO, f));
    c.ok(`no "Show/Hide test records" in ${ui.length} page and component files`, ui.length > 100 && toggles.length === 0, toggles.join(", "));
    // A toggle is a link that ADDS test=1 when the view is not already test-scoped
    // (`includeTest ? "/x" : "/x?test=1"`, `test: !includeTest`, `showTest: !showTest`).
    const flips = ui.filter((f) => /(includeTest|showTest|sp\.test === "1")\s*\?\s*["'`][^"'`]*["'`]\s*:\s*["'`][^"'`]*test=1|test:\s*!includeTest|showTest:\s*!showTest|homeRecordHref\([^)]*,\s*true\)|scopeToggleHref|toggleHref|testToggle/.test(code(fs.readFileSync(f, "utf8")))).map((f) => path.relative(REPO, f));
    c.ok("no link flips the view into test records", flips.length === 0, flips.join(", "));

    c.head("2 · the hiding rule stays");
    const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
    const hiding = ["src/app/page.tsx", "src/app/schedule/page.tsx", "src/app/editing/page.tsx", "src/app/ops/checklist/page.tsx", "src/app/tasks/page.tsx"];
    const missing = hiding.filter((f) => !/syntheticClientIds\b/.test(read(f)));
    c.ok("the dashboard, Schedule, Editing Room, Kyle's list and Tasks still hide the synthetic clients", missing.length === 0, missing.join(", "));
    c.ok("…and Content's program overview too (isSyntheticClientRow unless a typed ?test=1)", /programOverview\(\{[^}]*includeTest/.test(read("src/app/content/page.tsx")) && /opts\.includeTest === false \? allEnrollments\.filter\(\(e\) => !syntheticIds\.has/.test(read("src/lib/programOverview.ts")));
    c.ok("syntheticClientIds is the one reader (lib/syntheticClients)", /export const syntheticClientIds = cache\(/.test(read("src/lib/syntheticClients.ts")));

    c.head("3 · rendered: the Schedule toggle is List and Map only");
    const { ScheduleViewToggle } = await import("@/components/schedule/ScheduleViewToggle");
    const normal = renderToStaticMarkup(createElement(ScheduleViewToggle, { view: "list" }));
    const typed = renderToStaticMarkup(createElement(ScheduleViewToggle, { view: "map", includeTest: true }));
    c.ok("List and Map, nothing about test records (normal view)", /List/.test(normal) && /Map/.test(normal) && !/test/i.test(normal));
    c.ok("…a hand-typed ?test=1 view keeps its scope on List and Map, still no toggle", typed.includes('href="/schedule?test=1"') && typed.includes('href="/schedule?view=map&amp;test=1"') && !/test records/i.test(typed));

    c.head("isolation");
    c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
