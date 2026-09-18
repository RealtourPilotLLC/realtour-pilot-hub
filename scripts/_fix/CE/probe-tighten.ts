// READ-ONLY. Group CE / E2: what tightenScriptAI now says to the four live
// under-target versions, and proof that it wrote nothing.
//
// Run with:  NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/CE/probe-tighten.ts
//
// SAFETY: only rows the action REFUSES are touched — under-target and
// on-target. An over-target row would go on to call the generator and write a
// new version, so none is passed in. ensureScriptVersioned() only writes when a
// script has no currentVersionId, so rows without one are skipped as well; the
// version count is compared before and after either way.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Mod = require("module");
const load = Mod._load;
Mod._load = function (request: string, ...rest: unknown[]) {
  if (request === "next/navigation") return { redirect: () => { throw new Error("probe: redirect() is not expected on this path"); } };
  return load.call(this, request, ...rest);
};

import { prisma } from "../../../src/lib/prisma";
import { GENERATION_POLICY } from "../../../src/lib/contentPolicy/policy";

async function main() {
  const { tightenScriptAI } = (await import("../../../src/app/content/actions")) as any;
  const [LO, HI] = GENERATION_POLICY.timing.targetSec;
  const scripts = await prisma.contentScript.findMany({ where: { historical: false }, select: { id: true, title: true, currentVersionId: true } });
  const before = await prisma.contentScriptVersion.count();

  for (const s of scripts) {
    if (!s.currentVersionId) continue; // would make ensureScriptVersioned write
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId }, select: { versionNo: true, estimatedSeconds: true, spokenWordCount: true } });
    if (!v?.estimatedSeconds || v.estimatedSeconds > HI) continue; // never poke an overrun: that one really does revise
    const band = v.estimatedSeconds < LO ? "under" : "on";
    const r = await tightenScriptAI(s.id);
    console.log(`${band.padEnd(5)} ~${String(v.estimatedSeconds).padStart(3)}s/${String(v.spokenWordCount).padStart(3)}w  ${s.title.slice(0, 40).padEnd(42)} ok=${r.ok}`);
    console.log(`        ${r.message}`);
  }

  const after = await prisma.contentScriptVersion.count();
  console.log(`\nContentScriptVersion rows before ${before}, after ${after} — ${before === after ? "nothing was written" : "SOMETHING WAS WRITTEN"}`);
  if (before !== after) throw new Error("PROBE FAILED: a version row was created.");
  await prisma.$disconnect();
}
main();
