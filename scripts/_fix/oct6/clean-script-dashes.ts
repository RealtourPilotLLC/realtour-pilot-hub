// Oct 12 2026 (Jordan: "Yes … clean the existing drafts"). For every live
// (non-historical, non-archived) script whose CURRENT version has a dash in its
// spoken words: write a new version with only the dashes replaced (the
// save choke point's sanitizer — contentScripts.editScriptVersion). Scripts
// already SHARED to a portal are skipped (only TEST clients). A script that was
// APPROVED but not shared gets its new version approved again as Jordan, since
// only punctuation changed. Imported historical scripts are kept as filmed.
// Pass --apply to write; without it, a dry run.
import { prisma } from "../../../src/lib/prisma";
const APPLY = process.argv.includes("--apply");
const BY = "info@realtourpilot.com";
(async () => {
  const { hasScriptDash } = await import("../../../src/lib/contentPolicy/scriptFormat");
  const cs = await import("../../../src/lib/contentScripts");
  const scripts = await prisma.contentScript.findMany({ where: { historical: false, status: { notIn: ["ARCHIVED"] } }, select: { id: true, title: true, clientId: true, currentVersionId: true, approvedVersionId: true, sharedVersionId: true } });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: scripts.map((s) => s.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  let done = 0, skipped = 0;
  for (const s of scripts) {
    if (!s.currentVersionId) continue;
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId } });
    if (!v) continue;
    const pts = cs.pointsFromJson(v.pointsJson);
    const alt = v.alternateHooksJson ? (JSON.parse(v.alternateHooksJson) as string[]) : [];
    const spoken = [v.title, v.hook, v.close, v.captionCta ?? "", ...pts.map((p) => p.text), ...alt].join("\n");
    if (!hasScriptDash(spoken)) continue;
    const who = names.get(s.clientId) ?? s.clientId;
    if (s.sharedVersionId) { skipped++; console.log("SKIP shared", who, "|", s.title.slice(0, 50)); continue; }
    const wasApproved = s.approvedVersionId === v.id;
    console.log(APPLY ? "CLEAN" : "would clean", who, wasApproved ? "(approved → re-approve)" : "", "|", s.title.slice(0, 60));
    if (!APPLY) { done++; continue; }
    const parts = {
      title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, secondaryPillarId: v.secondaryPillarId,
      hook: v.hook ?? "", points: pts, close: v.close ?? "", captionCta: v.captionCta,
      filmingNotes: v.filmingNotes, creativeDirection: v.creativeDirection, productionNotes: v.productionNotes ? v.productionNotes.split("\n") : [], goal: v.goal,
      alternateHooks: alt, placeholders: v.placeholdersJson ? JSON.parse(v.placeholdersJson) : [], speakerLabels: v.speakerLabelsJson ? JSON.parse(v.speakerLabelsJson) : [],
      sourceExcerpts: v.sourceExcerptsJson ? JSON.parse(v.sourceExcerptsJson) : [], dimensionsCheck: v.dimensionsCheckJson ? JSON.parse(v.dimensionsCheckJson) : null, timingNote: v.timingNote,
    };
    const r = await cs.editScriptVersion(s.id, parts as any, BY, "Em dashes removed (punctuation only, same words) — Jordan, Oct 12 2026");
    if (wasApproved) await cs.approveScriptVersion(r.versionId, { email: BY }, "Same words as the approved version; only em dashes replaced (Oct 12 2026).");
    const nv = await prisma.contentScriptVersion.findUnique({ where: { id: r.versionId }, select: { hook: true, pointsJson: true, close: true, title: true, captionCta: true } });
    const still = hasScriptDash([nv?.title, nv?.hook, nv?.close, nv?.captionCta ?? "", ...cs.pointsFromJson(nv?.pointsJson ?? "[]").map((p) => p.text)].join("\n"));
    console.log("   → v" + r.versionNo, still ? "STILL HAS A DASH" : "clean");
    done++;
  }
  console.log({ apply: APPLY, cleaned: done, skippedShared: skipped });
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
