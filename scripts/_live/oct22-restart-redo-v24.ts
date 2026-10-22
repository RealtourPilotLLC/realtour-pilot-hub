export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026), after writer v2.4 deployed. Erica's and
// Bernadette's redone drafts were paused (oct22-pause-redo-checks.ts) because
// the v2.3 fix loop swapped their strong first-choice hooks away. For each
// paused script (and Backyard, whose finished v7 carries the weaker hook):
// restore its FIRST redo draft as a new version (contentScripts.
// restoreScriptVersion, nothing is lost), then run the v2.4 automatic check on
// it now (scriptJudge.autoCheckScript: hook locked unless the hook itself
// fails, trim before review). A skit (the new writer does not write skits)
// is restored and left for Jordan's review, unchecked. Approved / shared /
// client-approved scripts are never touched. Dry run by default; --apply.
// ---------------------------------------------------------------------------
const ENROLLMENTS = ["cmt7h6b0300059kcj990r34x7", "cmt7h6b0u00069kcjdq8xi0le"];
const SINCE = new Date("2026-10-22T21:00:00Z");
async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const { readJudge } = await import("../../src/lib/scriptJudgeRecord");
  const ss = await prisma.contentScript.findMany({ where: { enrollmentId: { in: ENROLLMENTS }, historical: false, sharedAt: null, approvedAt: null, clientApprovedAt: null, status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, updatedAt: { gte: SINCE } }, select: { id: true, title: true, currentVersionId: true } });
  for (const s of ss) {
    const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: s.id, createdAt: { gte: SINCE } }, orderBy: { versionNo: "asc" }, select: { id: true, versionNo: true, validationJson: true, speakerLabelsJson: true, hook: true, spokenWordCount: true } });
    const first = vs[0], cur = vs.find((v) => v.id === s.currentVersionId);
    const j = readJudge(cur?.validationJson);
    const paused = j?.state === "not_checked" && /Paused on Oct 22/.test(String((j as { error?: string }).error ?? ""));
    const backyardFlagged = /Backyard/.test(s.title) && j?.state === "flagged";
    if (!first || !cur || (!paused && !backyardFlagged)) { console.log(`skip ${s.title.slice(0, 50)} (judge ${j?.state})`); continue; }
    const skit = !!first.speakerLabelsJson && first.speakerLabelsJson !== "[]" || /\[|BERNADETTE/.test(first.hook);
    console.log(`${s.title.slice(0, 50).padEnd(50)} v${cur.versionNo} → restore v${first.versionNo} (${first.spokenWordCount}w) "${first.hook.slice(0, 70)}" ${skit ? "[skit: restore only]" : "[then v2.4 check]"}`);
    if (!apply) continue;
    const { restoreScriptVersion } = await import("../../src/lib/contentScripts");
    const r = first.id === cur.id ? { versionId: cur.id, versionNo: cur.versionNo } : await restoreScriptVersion(s.id, first.id, "info@realtourpilot.com (via Claude: v2.4 restart)");
    const nv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: r.versionId }, select: { validationJson: true } });
    let bag: Record<string, unknown> = {}; try { bag = nv.validationJson ? JSON.parse(nv.validationJson) : {}; } catch { bag = {}; }
    const judge = skit
      ? { state: "not_checked", fixRounds: 0, criteria: [], attempts: 3, error: "Restored to the first skit draft for Jordan's review (Oct 22 2026); skits are not on the new writer." }
      : { state: "pending", fixRounds: 0, criteria: [], attempts: 0 };
    await prisma.contentScriptVersion.update({ where: { id: r.versionId }, data: { validationJson: JSON.stringify({ ...bag, judge }) } });
    if (skit) { console.log(`   restored as v${r.versionNo}`); continue; }
    const { autoCheckScript } = await import("../../src/lib/scriptJudge");
    const res = await autoCheckScript(s.id, { requestedBy: "info@realtourpilot.com", unattended: false }).catch((e) => ({ state: "error", reason: String(e).slice(0, 160) } as never));
    const curId = (await prisma.contentScript.findUniqueOrThrow({ where: { id: s.id }, select: { currentVersionId: true } })).currentVersionId;
    const after = curId ? await prisma.contentScriptVersion.findUnique({ where: { id: curId }, select: { versionNo: true, spokenWordCount: true, hook: true } }) : null;
    console.log(`   restored as v${r.versionNo}; v2.4 check: ${(res as { state: string }).state}; now v${after?.versionNo} ${after?.spokenWordCount}w "${after?.hook.slice(0, 70)}"`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
