export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026). The automatic check on Erica's and Bernadette's
// nine redone drafts runs the v2.3 fix loop, which the independent review found
// swaps strong first-choice hooks away (Backyard's "My clients wanted to step
// from the kitchen straight out to the pool. Their lot said no." became "We'll
// pick the lot first…", which bends her story) and let the Scumbags skit grow
// to 123 words. Until v2.4 is live, the CURRENT version of each still being
// checked is marked finished-for-now (not_checked, attempts at the maximum),
// the same marker the sweep already skips (scriptJudge.sweepScriptChecks), with
// a note saying why. Every version stays in the script's history. Dry run by
// default; --apply writes. Re-run safe.
// ---------------------------------------------------------------------------
const ENROLLMENTS = ["cmt7h6b0300059kcj990r34x7", "cmt7h6b0u00069kcjdq8xi0le"];
const NOTE = "Paused on Oct 22 2026 (Jordan's redo): the automatic fix rounds were swapping strong hooks away. It restarts on the fixed writer (v2.4) from this script's first redo draft.";
async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const { readJudge } = await import("../../src/lib/scriptJudgeRecord");
  const ss = await prisma.contentScript.findMany({ where: { enrollmentId: { in: ENROLLMENTS }, sharedAt: null, historical: false, status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, updatedAt: { gte: new Date("2026-10-22T21:00:00Z") } }, select: { id: true, title: true, currentVersionId: true } });
  for (const s of ss) {
    if (!s.currentVersionId) continue;
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId }, select: { id: true, versionNo: true, validationJson: true } });
    const j = readJudge(v?.validationJson);
    const active = !!j && ["pending", "fixing", "trimming", "not_checked"].includes(j.state) && !(j.state === "not_checked" && (j.attempts ?? 0) >= 3);
    console.log(`${s.title.slice(0, 50).padEnd(50)} v${v?.versionNo} judge=${j?.state ?? "none"} ${active ? "→ pause" : "(leave)"}`);
    if (!apply || !active || !v) continue;
    let bag: Record<string, unknown> = {};
    try { bag = v.validationJson ? JSON.parse(v.validationJson) : {}; } catch { bag = {}; }
    await prisma.contentScriptVersion.update({ where: { id: v.id }, data: { validationJson: JSON.stringify({ ...bag, judge: { ...j, state: "not_checked", attempts: 3, error: NOTE, pausedFrom: j!.state } }) } });
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
