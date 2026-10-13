// Oct 13 2026 (Jordan, "both"): topics agreed on a strategy call are confirmed —
// no "needs reconciling" step. Confirms the ones already waiting (John Collins's
// four from his Oct 12 call, and any others on open current/future months) with
// the same write as a person's Keep (contentTopics.reconcileSelection). Their
// scripts then draft in the 15-minute AI job. Nothing reaches a client.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct13/confirm-call-topics.ts [--apply]
import { prisma } from "@/lib/prisma";
async function main() {
  const apply = process.argv.includes("--apply");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const { reconcileSelection } = await import("@/lib/contentTopics");
  const months = await prisma.contentMonth.findMany({ where: { status: "OPEN", historical: false, monthKey: { gte: etMonthKey() } }, select: { id: true, monthKey: true, clientId: true } });
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: { in: months.map((m) => m.id) }, status: "PROPOSED", source: "call" }, select: { topicId: true, monthId: true } });
  const me = await prisma.appUser.findFirst({ where: { email: "info@realtourpilot.com" }, select: { id: true } });
  let n = 0;
  for (const s of sels) {
    const m = months.find((x) => x.id === s.monthId)!;
    const [c, t] = await Promise.all([prisma.client.findUnique({ where: { id: m.clientId }, select: { name: true } }), prisma.contentTopic.findUnique({ where: { id: s.topicId }, select: { title: true, status: true, approvalState: true } })]);
    if (!t || t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED") { console.log(`skip ${c?.name} ${m.monthKey}: ${t?.title}`); continue; }
    console.log(`${c?.name} · ${m.monthKey} · ${t.title}`);
    if (apply) { await reconcileSelection(s.topicId, s.monthId, true, { kind: "STAFF", staffUserId: me?.id ?? "info@realtourpilot.com" }); n++; }
  }
  if (apply) {
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    for (const id of new Set(sels.map((s) => s.monthId))) await recalcProgramMonth(id).catch(() => null);
  }
  console.log(apply ? `confirmed ${n}` : `DRY RUN: ${sels.length} waiting`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
