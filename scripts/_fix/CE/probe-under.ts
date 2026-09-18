// READ-ONLY. Group CE / E1 + E2: how many live script versions estimate UNDER
// the 20-30 s target, and what the Scripts tab renders for them.
//
// Simulates the panel's own gate and filter exactly as they are written in
// src/components/content/ScriptsPanel.tsx so the output is about the shipped
// code, not about a paraphrase of it.
import { prisma } from "../../../src/lib/prisma";
import { GENERATION_POLICY } from "../../../src/lib/contentPolicy/policy";

type F = { severity: string; message: string; code?: string };

const [LO, HI] = GENERATION_POLICY.timing.targetSec;

// Verbatim from ScriptsPanel.tsx (the lines under test).
const band = (s: number | null) => (s == null ? null : s > HI ? "over" : s < LO ? "under" : "on");
const keptByOldFilter = (f: F) => f.severity !== "info" && f.code !== "timing.out-of-range" && !/^Spoken estimate /.test(f.message);

async function main() {
  const scripts = await prisma.contentScript.findMany({ select: { id: true, title: true, historical: true, currentVersionId: true } });
  const versions = await prisma.contentScriptVersion.findMany({
    select: { id: true, scriptId: true, versionNo: true, status: true, estimatedSeconds: true, spokenWordCount: true, validationJson: true, gapsJson: true },
    orderBy: { versionNo: "desc" },
  });
  const byScript = new Map<string, typeof versions>();
  for (const v of versions) byScript.set(v.scriptId, [...(byScript.get(v.scriptId) ?? []), v]);

  let live = 0, under = 0, over = 0, on = 0, noEstimate = 0, underShowingNothing = 0;
  const rows: string[] = [];
  for (const s of scripts) {
    if (s.historical) continue; // the panel never paces an import
    const cur = (byScript.get(s.id) ?? [])[0];
    if (!cur) continue;
    live++;
    const pace = band(cur.estimatedSeconds);
    if (pace == null) { noEstimate++; continue; }
    if (pace === "over") over++;
    if (pace === "on") on++;
    if (pace !== "under") continue;
    under++;
    let findings: F[] = [];
    try { if (cur.validationJson) findings = (JSON.parse(cur.validationJson) as { findings: F[] }).findings ?? []; } catch { /* none */ }
    let gaps: unknown[] = [];
    try { if (cur.gapsJson) gaps = JSON.parse(cur.gapsJson) as unknown[]; } catch { /* none */ }
    // The SHIPPED gate: findings.length > 0 || gaps.length > 0 || pace === "over"
    const boxRenders = findings.length > 0 || gaps.length > 0;
    const linesInBox = findings.filter(keptByOldFilter).length + gaps.length; // the "over" row cannot fire here
    const timingFinding = findings.find((f) => f.code === "timing.out-of-range" || /^Spoken estimate /.test(f.message));
    if (!boxRenders || linesInBox === 0) underShowingNothing++;
    rows.push(
      `  v${cur.versionNo} ${cur.status.padEnd(16)} ~${String(cur.estimatedSeconds).padStart(3)}s/${String(cur.spokenWordCount).padStart(3)}w  ` +
      `stored findings=${findings.length} (timing: ${timingFinding ? "yes -> DROPPED by the filter" : "none"}) gaps=${gaps.length} ` +
      `-> panel renders ${linesInBox === 0 || !boxRenders ? "NOTHING" : `${linesInBox} line(s)`}  . ${s.title.slice(0, 48)}`,
    );
  }
  console.log(`target ${LO}-${HI}s . live (non-historical) scripts with a version: ${live}`);
  console.log(`  under: ${under} . on: ${on} . over: ${over} . no estimate: ${noEstimate}`);
  console.log(`  UNDER-target rows where the Scripts tab shows nothing at all about the length: ${underShowingNothing}`);
  for (const r of rows) console.log(r);

  // E2: what tightenScriptAI's early exit asserts about each of those rows.
  console.log("\ntightenScriptAI early-exit message, as shipped, for each under-target row:");
  for (const s of scripts) {
    if (s.historical) continue;
    const cur = (byScript.get(s.id) ?? [])[0];
    if (!cur || cur.estimatedSeconds == null || cur.estimatedSeconds >= LO) continue;
    console.log(`  "Version ${cur.versionNo} already estimates at ~${cur.estimatedSeconds} s, inside the ${LO}-${HI} s target - nothing to tighten."  <- ${cur.estimatedSeconds} s is NOT inside ${LO}-${HI}`);
  }
  await prisma.$disconnect();
}
main();
