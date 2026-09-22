// READ-ONLY (no database at all). Group CE / E1: render the REAL ScriptsPanel
// and read back what it says about a version's length, for each band.
//
// Run with:  npx tsx scripts/_fix/CE/probe-panel.tsx      (no react-server
// condition — this is the client build, which is what the browser runs).
// The panel is imported DYNAMICALLY, after the one stub below is installed:
// static imports are hoisted above it, and the "use server" actions module the
// panel imports for its buttons drags the whole server tree in. Nothing here
// clicks a button.
/* eslint-disable @typescript-eslint/no-require-imports */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScriptUi, VersionUi } from "../../../src/components/content/ScriptsPanel";

const Mod = require("module");
const load = Mod._load;
const noop = async () => ({ ok: false, message: "probe: no action is invoked here" });
Mod._load = function (request: string, ...rest: unknown[]) {
  // tsx rewrites the "@/…" alias to an absolute path before this hook sees it,
  // so match either spelling.
  if (request === "@/app/content/actions" || /[/\\]src[/\\]app[/\\]content[/\\]actions(\.ts)?$/.test(request)) {
    return { approveScriptVersionAction: noop, releaseScriptAction: noop, returnScriptAction: noop, reviseScriptAI: noop, saveScriptText: noop, tightenScriptAI: noop };
  }
  return load.call(this, request, ...rest);
};

const version = (over: Partial<VersionUi>): VersionUi => ({
  id: "v1", versionNo: 1, status: "DRAFT", source: "AI", body: "HOOK\nSomething.\nTALKING POINT 1\nMore.\nCLOSE\nDone.",
  createdBy: "jordan@realtourpilot.com", createdAt: new Date().toISOString(), changeSummary: null, approvedBy: null, approvedAt: null, sharedAt: null,
  estimatedSeconds: null, spokenWordCount: null, pointCount: 3, findings: [], gaps: [], strategyVersionNo: null, policyVersionNo: null,
  answerCount: 0, path: "call", basedOnVersionNo: null, regeneratedSections: [], ...over,
});

const script = (title: string, v: VersionUi): ScriptUi => ({
  id: title, title, status: "DRAFT", historical: false, releaseState: null, monthKey: "2026-09", pillarName: "Local Area Authority",
  currentVersionId: v.id, approvedVersionId: null, sharedVersionId: null, approvedBy: null, approvedAt: null, sharedAt: null, versions: [v], sourceFile: null, clientVerdict: null, clientVerdictAt: null,
});

async function main() {
  const { ScriptsPanel } = await import("../../../src/components/content/ScriptsPanel");

  // The scenario the reviewer demonstrated: a short draft with NO stored
  // findings, and the same draft carrying the timing finding the filter drops.
  const cases: { name: string; s: ScriptUi }[] = [
    { name: "under, no stored findings (14 s / 31 w)", s: script("Under, bare", version({ estimatedSeconds: 14, spokenWordCount: 31 })) },
    {
      name: "under, WITH the stored timing finding the filter drops",
      s: script("Under, validated", version({
        estimatedSeconds: 14, spokenWordCount: 31,
        findings: [{ severity: "warn", code: "timing.out-of-range", message: "Spoken estimate ~14 s (31 words at 2.2 w/s) is under the 20-30 s target. It may read as thin on camera; add substance rather than padding." }],
      })),
    },
    { name: "under, the live shape (19 s / 41 w)", s: script("Under, live shape", version({ estimatedSeconds: 19, spokenWordCount: 41 })) },
    { name: "on target (25 s / 55 w)", s: script("On target", version({ estimatedSeconds: 25, spokenWordCount: 55 })) },
    { name: "over (47 s / 103 w)", s: script("Over", version({ estimatedSeconds: 47, spokenWordCount: 103 })) },
    { name: "historical import, 126 s (never paced)", s: { ...script("Archive", version({ estimatedSeconds: 126, spokenWordCount: 277 })), historical: true } },
  ];

  for (const c of cases) {
    const html = renderToStaticMarkup(React.createElement(ScriptsPanel, { scripts: [c.s], queueCount: 1, scriptOwner: "Jordan" }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, "'").replace(/\s+/g, " ").trim();
    const at = text.indexOf("Length:");
    const tail = at < 0 ? "" : text.slice(at, at + 400);
    const end = tail.indexOf(" HOOK ");
    const lengthLine = at < 0 ? "(NO length line at all)" : (end > 0 ? tail.slice(0, end) : tail);
    console.log(`${c.name}`);
    console.log(`   chip: ${/v1 . call.{0,50}/.exec(text)?.[0] ?? "?"}`);
    console.log(`   box:  ${lengthLine}`);
    console.log(`   tighten button: ${/Tighten to/.test(text)}\n`);
  }
}
main();
