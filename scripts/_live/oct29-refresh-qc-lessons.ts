// ---------------------------------------------------------------------------
// Works out again what the free photo check learned from the office's calls
// (houseRules.refreshLessons), right after the Oct 29 2026 tightening
// (Jordan: "review some of Kyle's notes on the QC checks, and let's tighten
// them up so we don't flag things we dont need to fix"), so a "barely visible"
// lesson on an always-flagged check (trash cans, cars) applies from the next
// check, not from Kyle's next decision. Writes the lessons row only
// (photo_delivery:learned_checks), the same row the settings page and every
// decision rewrite. Dry run by default (read-only connection, proven): prints
// what would be active; --apply saves it.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs \
//     scripts/_live/oct29-refresh-qc-lessons.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

(async () => {
  const prisma = await db();
  const house = await import("../../src/lib/photoDelivery/houseRules");
  const before = await house.learnedChecks();
  const { ALWAYS_FLAG } = await import("../../src/lib/photoDelivery/fixPolicy");
  const rows = await prisma.photoQcFinding.findMany({
    where: { decidedAt: { gte: new Date(Date.now() - house.LESSON_DAYS * 86_400_000) }, status: { in: ["IGNORED", "FALSE_POSITIVE"] }, source: { not: "ADDON" }, statusReason: { not: null } },
    select: { id: true, jobId: true, photoId: true, ruleId: true, statusReason: true, decidedBy: true, decidedAt: true, status: true },
    take: 5000,
  });
  const undone = (await prisma.appSetting.findUnique({ where: { key: "photo_delivery:learned_checks" } }).then((r) => (r ? (JSON.parse(r.value) as { undone?: { key: string; by: string; at: string }[] }).undone : []))) ?? [];
  const after = APPLY ? await house.refreshLessons(new Date(), "claude: for Jordan") : house.lessonsFrom(rows, undone, ALWAYS_FLAG);
  const was = new Set(before.filter((l) => l.active).map((l) => l.key));
  for (const l of after.filter((x) => x.active)) console.log(`${was.has(l.key) ? "  " : "+ "}${l.ruleId.padEnd(32)} ${house.lessonWords(l)} (${l.count} calls on ${l.jobs} jobs: "${l.reason.slice(0, 50)}")`);
  console.log(APPLY ? "saved." : "dry run: not saved.");
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
