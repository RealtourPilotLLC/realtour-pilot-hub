// ---------------------------------------------------------------------------
// First sort of working preferences for clients with a job shot in the last 30
// days or booked in the next 14 (Jordan, Oct 29 2026: "Working preferences
// should be summarized and organized and shown in full ... the editor brief
// should only be editing related"). The same sweep the nightly client run
// does (lib/workingPrefs refreshSortedWorkingPrefs), run once now so the
// briefs and client pages read a sort today. Display cache only: it writes
// AppSetting "working_prefs:<clientId>" rows and nothing else; no note, no
// Aryeo, no message. Dry run by default (read-only connection, proven);
// --apply sorts.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs \
//     scripts/_live/oct29-sort-working-prefs.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

(async () => {
  const prisma = await db();
  const now = Date.now();
  const recent = await prisma.project.findMany({
    where: { shootDate: { gte: new Date(now - 30 * 86_400_000), lte: new Date(now + 14 * 86_400_000) }, status: { not: "CANCELLED" } },
    select: { clientId: true },
    distinct: ["clientId"],
    take: 200,
  });
  const { sortedWorkingPrefs, refreshSortedWorkingPrefs } = await import("../../src/lib/workingPrefs");
  const states: Record<string, number> = {};
  for (const { clientId } of recent) {
    const r = await sortedWorkingPrefs(clientId);
    states[r.state] = (states[r.state] ?? 0) + 1;
  }
  console.log(`${recent.length} clients with a recent or upcoming job:`, JSON.stringify(states));
  if (!APPLY) { console.log("dry run: nothing sorted."); await prisma.$disconnect(); return; }
  const r = await refreshSortedWorkingPrefs(80, 900_000);
  console.log(`sorted ${r.sorted}${r.ranOut ? " (ran out of time; the nightly run finishes the rest)" : ""}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
