import { APPLY, db } from "./_oct22-guard";

// ---------------------------------------------------------------------------
// OUTBOX CONFIRMATIONS THAT NO LONGER MATCH THEIR SHOOT (Jordan, Oct 27 2026
// Loom, 39:18: "Hi Georgiana, confirming your upcoming shoot at 2031 Ruth ...
// This confirmation may be out of date. The appointment was rescheduled, so
// this notification should be rescheduled for whenever her new appointment
// was scheduled for, or at least a day before, two days before").
//
// The code fix (lib/clientTexts, lib/tasks) lists a confirmation only for a
// shoot that is ahead and no later than tomorrow, holds a dateless one, and
// re-times an open one when its shoot moves. This lines up the rows that are
// open right now:
//   · HELD    the job has no shoot date (postponed): dueAt cleared, the
//             summary says it is held (lib/tasks CONFIRMATION_HELD);
//   · RE-TIME the shoot is ahead but the row's dueAt is not the day before it
//             (off by an hour or more): the project's tasks re-synced, the way
//             the Aryeo webhook does (lib/tasks generateTasksForProject), so
//             the dueAt AND the drafted text follow the new date;
//   · PAST    the shoot has passed and the confirmation was never sent: the
//             same re-sync, which retires it (CANCELLED, never "sent").
// Never sends anything. Never deletes. Every row is printed.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-outbox-confirmations.ts [--apply]
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;

async function main() {
  const prisma = await db();
  const { CONFIRMATION_HELD } = await import("../../src/lib/tasks");
  const now = new Date();
  const rows = await prisma.smartTask.findMany({
    where: { taskType: "confirmation_text", status: { notIn: ["COMPLETED", "CANCELLED"] }, projectId: { not: null } },
    select: { id: true, title: true, dueAt: true, summary: true, projectId: true, project: { select: { id: true, title: true, status: true, shootDate: true } } },
    orderBy: { dueAt: { sort: "asc", nulls: "first" } },
  });
  console.log(`${rows.length} open confirmation texts`);
  const resync = new Set<string>();
  let held = 0;
  for (const t of rows) {
    const shoot = t.project?.shootDate ?? null;
    const head = `${t.id} · ${t.project?.title ?? t.title} · ${t.project?.status ?? "?"} · shoot ${shoot ? shoot.toISOString() : "none"} · due ${t.dueAt ? t.dueAt.toISOString() : "none"}`;
    if (!shoot) {
      if (!t.dueAt && t.summary === CONFIRMATION_HELD) { console.log(`${head}\n  already held`); continue; }
      console.log(`${head}\n  ${APPLY ? "held" : "would hold"} (no shoot date: dueAt cleared, summary "${CONFIRMATION_HELD}")`);
      if (APPLY) await prisma.smartTask.update({ where: { id: t.id }, data: { dueAt: null, summary: CONFIRMATION_HELD } });
      held++;
      continue;
    }
    if (shoot.getTime() <= now.getTime()) {
      console.log(`${head}\n  ${APPLY ? "re-syncing" : "would re-sync"} (the shoot has passed: the reconciler retires it)`);
      resync.add(t.projectId!);
      continue;
    }
    const want = shoot.getTime() - DAY;
    if (!t.dueAt || Math.abs(t.dueAt.getTime() - want) >= HOUR) {
      console.log(`${head}\n  ${APPLY ? "re-syncing" : "would re-sync"} (due should be ${new Date(want).toISOString()}, the day before the shoot)`);
      resync.add(t.projectId!);
      continue;
    }
    console.log(`${head}\n  fine`);
  }
  if (APPLY && resync.size) {
    const { generateTasksForProject } = await import("../../src/lib/tasks");
    for (const id of resync) {
      await generateTasksForProject(id);
      const after = await prisma.smartTask.findFirst({ where: { projectId: id, taskType: "confirmation_text" }, orderBy: { updatedAt: "desc" }, select: { id: true, status: true, dueAt: true } });
      console.log(`  ${id}: now ${after?.status ?? "?"} · due ${after?.dueAt ? after.dueAt.toISOString() : "none"}`);
    }
  }
  console.log(`${APPLY ? "done" : "dry run"}: ${held} held, ${resync.size} re-synced${APPLY ? "" : " (nothing written)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
