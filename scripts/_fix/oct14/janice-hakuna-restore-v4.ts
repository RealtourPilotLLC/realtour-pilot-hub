// ---------------------------------------------------------------------------
// FIX (Oct 14 2026): Janice Pigga, "Hakuna Matata". Jordan asked the AI for the
// B-roll / lip-sync version (v4), then pressed "Edit myself" to add a reference
// video link. The edit box still held v3 from when the page first loaded, so
// the save put v3 back on top (v5, v6) and dropped the filming notes; the AI
// "go back to the previous version" revision (v7) kept v3. What he meant: v4,
// with the reference link in the filming notes. This adds that as v8. Nothing
// is deleted (v1..v7 stay; any of them can be restored from the panel).
//
// Dry run by default; `--apply` to write. Refuses if v7 is no longer current
// (someone changed the script since), and never runs twice.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { editScriptVersion, partsFromVersionRow } from "@/lib/contentScripts";

const APPLY = process.argv.includes("--apply");
const SCRIPT = "cmv5g9lar000zl006i9kmkxqb";
const V4 = "cmv7kuqow0001lc06ntubckyg";
const V7 = "cmv7l2s2k0001l306fqfwbu0t";
const LINK = "https://www.instagram.com/reel/Dd3itODJqaf/";
const SUMMARY = "Restored from v4, with the reference video link in the filming notes (the Oct 13 hand edit had saved v3 back by mistake)";

async function main() {
  const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: SCRIPT }, select: { title: true, currentVersionId: true, approvedVersionId: true, sharedVersionId: true } });
  const done = await prisma.contentScriptVersion.findFirst({ where: { scriptId: SCRIPT, changeSummary: SUMMARY }, select: { versionNo: true } });
  if (done) { console.log(`Already done: v${done.versionNo}.`); return; }
  if (s.currentVersionId !== V7) throw new Error(`The current version is no longer v7 (${s.currentVersionId}); not touching it.`);
  const v4 = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: V4 } });
  if (v4.scriptId !== SCRIPT || v4.versionNo !== 4) throw new Error("v4 is not what this script expects.");
  const parts = partsFromVersionRow(v4);
  parts.filmingNotes = `${(v4.filmingNotes ?? "").trim()} Reference video: ${LINK}`.trim();
  console.log({ title: s.title, approved: s.approvedVersionId, shared: s.sharedVersionId, hook: parts.hook.slice(0, 90), filmingNotes: parts.filmingNotes, captionCta: parts.captionCta });
  if (!APPLY) { console.log("Dry run. Re-run with --apply to add v8."); return; }
  const r = await editScriptVersion(SCRIPT, parts, "info@realtourpilot.com", SUMMARY);
  const head = await prisma.contentScript.findUniqueOrThrow({ where: { id: SCRIPT }, select: { currentVersionId: true, status: true } });
  console.log(`Added v${r.versionNo} (${r.versionId}); current=${head.currentVersionId === r.versionId}; status=${head.status}`);
}
main().finally(() => prisma.$disconnect());
