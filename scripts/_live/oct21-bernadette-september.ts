// ---------------------------------------------------------------------------
// LIVE: Bernadette Rabel's Sep 14 2026 shoot (1142 Hamilton St) was filed on
// her AUGUST content month. Jordan, Oct 21 2026: "It was September's content."
// The same steps as the office's moveSessionToMonth (src/app/content/actions.ts):
// the job, its program video rows still on August, and its library rows move
// to September; both months are recalculated. DRY RUN by default; --apply.
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct21-bernadette-september.ts [--apply]
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
const PROJECT = "cmt00zb3p0006la04ks5kd0vv";
const TARGET = "2026-09";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const p = await prisma.project.findUniqueOrThrow({ where: { id: PROJECT }, select: { id: true, title: true, clientId: true, contentMonthId: true } });
  const from = await prisma.contentMonth.findUniqueOrThrow({ where: { id: p.contentMonthId! }, select: { id: true, enrollmentId: true, monthKey: true } });
  const target = await prisma.contentMonth.findUniqueOrThrow({ where: { enrollmentId_monthKey: { enrollmentId: from.enrollmentId, monthKey: TARGET } }, select: { id: true, monthKey: true } });
  const vids = await prisma.contentVideo.findMany({ where: { projectId: PROJECT, enrollmentId: from.enrollmentId, monthId: from.id }, select: { title: true, status: true } });
  const lib = await prisma.portalVideo.count({ where: { projectId: PROJECT } });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: "${p.title}" ${from.monthKey} → ${target.monthKey}`);
  console.log(`  ${vids.length} program videos move: ${vids.map((v) => `${v.title.replace(/\s+/g, " ")} (${v.status})`).join(", ")}`);
  console.log(`  ${lib} library rows follow`);
  if (!APPLY) { console.log("DRY RUN: nothing written."); await prisma.$disconnect(); return; }
  await prisma.$transaction([
    prisma.project.update({ where: { id: PROJECT }, data: { contentMonthId: target.id } }),
    prisma.contentVideo.updateMany({ where: { projectId: PROJECT, enrollmentId: from.enrollmentId, monthId: from.id }, data: { monthId: target.id, monthKey: TARGET } }),
    prisma.portalVideo.updateMany({ where: { projectId: PROJECT }, data: { monthId: target.id } }),
    prisma.activity.create({ data: { projectId: PROJECT, type: "SYSTEM", body: `Moved from the ${from.monthKey} content month to ${TARGET}, with its videos (Jordan, Oct 21 2026: it was September's content).` } }),
    prisma.auditLog.create({ data: { actor: "info@realtourpilot.com", action: "content_session_moved", target: p.clientId, detail: `${p.title} (${PROJECT}) moved ${from.monthKey} → ${TARGET} with ${vids.length} program videos and ${lib} library rows.` } }),
  ]);
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  await recalcProgramMonth(from.id).catch((e) => console.log("recalc from failed (hourly catches up):", String(e).slice(0, 120)));
  await recalcProgramMonth(target.id).catch((e) => console.log("recalc target failed (hourly catches up):", String(e).slice(0, 120)));
  const after = await prisma.contentVideo.groupBy({ by: ["monthKey"], where: { projectId: PROJECT }, _count: true });
  console.log("now:", after.map((a) => `${a.monthKey}=${a._count}`).join(" "));
  await prisma.$disconnect();
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : String(e)); process.exit(1); });
