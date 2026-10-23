export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Bernadette Rabel (Mix, 2 skits a month) has no
// unscripted skit ideas: the Oct 22 skit-only refresh came back with
// "Pillar 3: Personal Brand & Trust Builder" and was refused as an unknown
// pillar (fixed: contentPolicy.pillarKey). Jordan's Oct 21 call notes: "Update
// her topic bank. Add a skits category" before Monday's 3:30 PM call. One
// skit-only refresh through the hub's own path (contentTopics.startTopicRefresh,
// keep 4). One AI call. --apply runs it; without it, prints the plan.
// ---------------------------------------------------------------------------
import { installNextStubs } from "../_drill/_harness";
installNextStubs();
const B = "cmt7h6b0u00069kcjdq8xi0le";
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  if (!process.argv.includes("--apply")) { console.log("DRY RUN: would start one skit-only refresh for Bernadette Rabel, keeping 4 ideas. Add --apply."); process.exit(0); }
  const { startTopicRefresh } = await import("../../src/lib/contentTopics");
  const r = await startTopicRefresh({ enrollmentId: B, kind: "REFRESH", skitsOnly: true, keep: 4, requestedBy: "info@realtourpilot.com", unattended: false });
  const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, lastError: true, missingContextJson: true } });
  console.log(JSON.stringify({ ...r, status: run?.status, lastError: run?.lastError, missing: (run?.missingContextJson ?? "").slice(0, 400) }));
  const sugg = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: B, createdAt: { gte: new Date(Date.now() - 3_600_000) } }, select: { title: true } });
  for (const s of sugg) console.log(`  · ${s.title}`);
  process.exit(0);
}
if (!process.argv.includes("--fix-typo")) main().catch((e) => { console.error(e); process.exit(1); });

// Oct 23 2026, after the run: one idea came back titled "Things My Husband Has
// Overhead Me Say…"; `--fix-typo` corrects it through updateTopicFields.
if (process.argv.includes("--fix-typo")) {
  (async () => {
    const { prisma } = await import("../../src/lib/prisma");
    const { updateTopicFields } = await import("../../src/lib/contentTopics");
    const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true } });
    const t = await prisma.contentTopic.findFirst({ where: { enrollmentId: B, title: { startsWith: "Things My Husband Has Overhead" } }, select: { id: true, title: true } });
    if (!t) { console.log("no topic with the typo"); process.exit(0); }
    await updateTopicFields(t.id, { title: t.title.replace("Has Overhead Me", "Has Overheard Me") }, { kind: "STAFF", staffUserId: owner.id } as never);
    console.log(`renamed: ${t.title} -> ${t.title.replace("Has Overhead Me", "Has Overheard Me")}`);
    process.exit(0);
  })();
}
