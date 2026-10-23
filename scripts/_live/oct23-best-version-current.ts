export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026): THE BEST VERSION CURRENT. DRY RUN BY DEFAULT.
//
// Until today every automatic fix round became the script's current version,
// better or not: Bernadette's "My Actual Saturday in the Lehigh Valley" went
// v10 → v11 → v12 and its hook got weaker. The loop now keeps a fix round in
// the history unless it is better (scriptJudge.ts). This looks back at what
// is already there: for every unshared, unapproved monthly script, its current
// version is compared with the other versions the automatic check reviewed,
// by the same rule (scriptJudgeRecord.betterEarlierVersion → rules.
// isBetterAttempt: fewer must-fix failures, then the craft total with the
// hook counted twice, then the length rule; a tie keeps the current one).
// Where an earlier version is better, it PROPOSES restoring it as current
// through the app's restore path (contentScripts.restoreScriptVersion: a copy
// on top, nothing deleted). Every script is printed, Bernadette's included.
//
// NEVER TOUCHED: a script shared with the client, approved, or approved by the
// client; a historical import; a script whose current version is a person's
// edit (no review of its own); a version the Oct 22 pause set aside.
//
//   dry run (read-only connection, writes refused by Postgres):
//     npx tsx scripts/_live/oct23-best-version-current.ts
//   apply (only after Jordan says yes; compare-and-set per script):
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct23-best-version-current.ts --apply
// ---------------------------------------------------------------------------

const BY = "info@realtourpilot.com (via Claude: best version current, Oct 23 2026)";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    // The dry run cannot write: every transaction on this connection is read-only.
    // (tsx does not load .env; Prisma would, but only after this line has to read it.)
    if (!process.env.DATABASE_URL) { try { (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env"); } catch { /* checked below */ } }
    const u = process.env.DATABASE_URL ?? "";
    if (!u) throw new Error("DATABASE_URL is not set.");
    process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
  }
  const { prisma } = await import("../../src/lib/prisma");
  const { readJudge, betterEarlierVersion } = await import("../../src/lib/scriptJudgeRecord");
  const { readWriter } = await import("../../src/lib/scriptWriter/record");
  const { craftRankTotal } = await import("../../src/lib/scriptWriter/rules");

  const scripts = await prisma.contentScript.findMany({
    where: { historical: false, monthId: { not: null }, currentVersionId: { not: null }, sharedVersionId: null, approvedVersionId: null, sharedAt: null, approvedAt: null, clientApprovedAt: null },
    select: { id: true, title: true, clientId: true, currentVersionId: true, enrollmentId: true },
    orderBy: [{ enrollmentId: "asc" }, { createdAt: "asc" }],
  });
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(scripts.map((s) => s.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const fmtScore = (s: { mustFix: number; craft?: unknown; words: number }) => `${s.mustFix} must-fix, craft ${craftRankTotal(s.craft as never) || "-"}, ${s.words} words`;
  const proposals: { scriptId: string; label: string; fromId: string; fromNo: number; curId: string; curNo: number }[] = [];
  let looked = 0, best = 0, skipped = 0;
  for (const s of scripts) {
    const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId: s.id }, orderBy: { versionNo: "asc" }, select: { id: true, versionNo: true, status: true, validationJson: true, spokenWordCount: true, hook: true } });
    const cur = vs.find((v) => v.id === s.currentVersionId);
    const label = `${(clients.get(s.clientId) ?? "?").padEnd(22).slice(0, 22)} ${s.title.slice(0, 52).padEnd(52)}`;
    if (!cur) { skipped++; console.log(`${label} skip: no current version row`); continue; }
    // Defensive: any version approved or shared means a person already decided; never touched.
    if (vs.some((v) => v.status === "APPROVED" || v.status === "SHARED") || (cur.status !== "DRAFT" && cur.status !== "INTERNAL_REVIEW")) { skipped++; console.log(`${label} skip: a version is approved or shared`); continue; }
    const j = readJudge(cur.validationJson);
    if (!j) { skipped++; console.log(`${label} v${cur.versionNo} left alone: a person's version (no automatic review)`); continue; }
    looked++;
    const story = (readWriter(cur.validationJson) ?? vs.map((v) => readWriter(v.validationJson)).filter(Boolean).at(-1))?.brief.videoType === "story";
    const pick = betterEarlierVersion(cur, vs, story);
    if (!pick) {
      best++;
      console.log(`${label} v${cur.versionNo} stays (${j.state}${j.writer === 2 ? ", creative review" : ", old judge"}): it is the best reviewed version`);
      continue;
    }
    const from = vs.find((v) => v.id === pick.pick.id)!;
    proposals.push({ scriptId: s.id, label, fromId: from.id, fromNo: from.versionNo, curId: cur.id, curNo: cur.versionNo });
    console.log(`${label} PROPOSE restore v${from.versionNo} as current (now v${cur.versionNo})`);
    console.log(`${" ".repeat(76)}current v${cur.versionNo}: ${fmtScore(pick.currentScore)} · hook "${cur.hook.slice(0, 70)}"`);
    console.log(`${" ".repeat(76)}better  v${from.versionNo}: ${fmtScore(pick.score)} · hook "${from.hook.slice(0, 70)}"`);
  }
  console.log(`\n${scripts.length} unshared, unapproved monthly scripts · ${looked} with an automatic review on the current version · ${best} already current at their best · ${proposals.length} proposals · ${skipped} left alone`);
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply (NODE_OPTIONS=--conditions=react-server) after Jordan says yes."); await prisma.$disconnect(); return; }

  const { restoreScriptVersion } = await import("../../src/lib/contentScripts");
  for (const p of proposals) {
    // Compare-and-set: still unshared, unapproved and on the same current version as when it was read.
    const s = await prisma.contentScript.findUnique({ where: { id: p.scriptId }, select: { currentVersionId: true, sharedVersionId: true, approvedVersionId: true, sharedAt: true, approvedAt: true, clientApprovedAt: true, historical: true } });
    if (!s || s.historical || s.sharedVersionId || s.approvedVersionId || s.sharedAt || s.approvedAt || s.clientApprovedAt || s.currentVersionId !== p.curId) { console.log(`${p.label} changed since the dry run: left alone`); continue; }
    const r = await restoreScriptVersion(p.scriptId, p.fromId, BY, { baseVersionId: p.curId });
    // The copy keeps the writer's brief (the card's Writer's notes); it carries no review, so nothing automatic runs on it.
    const from = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: p.fromId }, select: { validationJson: true } });
    const nv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: r.versionId }, select: { validationJson: true } });
    let bag: Record<string, unknown> = {}, src: Record<string, unknown> = {};
    try { bag = nv.validationJson ? JSON.parse(nv.validationJson) : {}; } catch { bag = {}; }
    try { src = from.validationJson ? JSON.parse(from.validationJson) : {}; } catch { src = {}; }
    if (src.writer) await prisma.contentScriptVersion.update({ where: { id: r.versionId }, data: { validationJson: JSON.stringify({ ...bag, writer: src.writer, ...(src.closeType ? { closeType: src.closeType } : {}) }) } });
    console.log(`${p.label} restored v${p.fromNo} as v${r.versionNo}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
