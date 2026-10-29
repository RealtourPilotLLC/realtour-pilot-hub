// ---------------------------------------------------------------------------
// Photo jobs delivered in the last 7 days whose deadline was set by the old
// photo hours (Kyle, Oct 29 2026: "Why are these showing late if they're from
// yesterday?"). The fix (99f04cd8) re-dates OPEN jobs on the next sync pass;
// a delivered job keeps the deadline it was delivered against, so a job
// delivered before that pass (512 Firethorn Rd, delivered 1:48 PM, re-dated
// pass 1:58 PM) still reads as late against a 10 AM deadline it never had.
// This puts the corrected deadline on those jobs only: the visit's photos
// turnaround (photoDueFor, today's Settings), never a job with the office's
// own due date or a client revision clock, and never an earlier deadline.
// Each change is written in the job's activity. Dry run by default
// (read-only connection, proven); --apply writes.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs \
//     scripts/_live/oct29-photo-deadlines-delivered.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

(async () => {
  const prisma = await db();
  const { photoDueFor, photoVisitFor, sameDayPhotos } = await import("../../src/lib/photoDelivery/jobs");
  const { turnaroundRules } = await import("../../src/lib/settings");
  const { etDateTime } = await import("../../src/lib/datetime");
  const { logJobEvent } = await import("../../src/lib/photoDelivery/jobState");
  const rules = await turnaroundRules();
  const jobs = await prisma.photoJob.findMany({
    where: { stage: "DELIVERED", deliveredAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, slaDueAt: { not: null } },
    select: { id: true, projectId: true, slaDueAt: true, deliveredAt: true },
  });
  let n = 0;
  for (const j of jobs) {
    const p = await prisma.project.findUnique({ where: { id: j.projectId }, select: { title: true, shootDate: true, dueOverrideAt: true, appointments: { select: { startAt: true, status: true } } } });
    if (!p || p.dueOverrideAt) continue;
    const revised = await prisma.photoJobEvent.count({ where: { jobId: j.id, action: { contains: "revision turnaround" } } });
    if (revised) continue;
    const visit = await photoVisitFor(j.projectId, p.appointments, p.shootDate, j.deliveredAt!);
    const due = photoDueFor(visit, await sameDayPhotos(j.projectId), rules);
    if (!due || due.getTime() <= j.slaDueAt!.getTime()) continue;
    n++;
    const late = (d: Date) => (j.deliveredAt!.getTime() > d.getTime() ? "late" : "on time");
    console.log(`${p.title.slice(0, 44).padEnd(44)} delivered ${etDateTime(j.deliveredAt!)}  due ${etDateTime(j.slaDueAt!)} (${late(j.slaDueAt!)}) -> ${etDateTime(due)} (${late(due)})`);
    if (APPLY) {
      await prisma.photoJob.update({ where: { id: j.id }, data: { slaDueAt: due } });
      await logJobEvent(j.id, "claude", `photo deadline corrected to ${etDateTime(due)} ET (was ${etDateTime(j.slaDueAt!)}): the photos turnaround from the ${etDateTime(visit)} visit, under the Oct 29 fix (a deadline closes at 5 PM, the Settings hours)`);
    }
  }
  console.log(`${jobs.length} delivered in the last 7 days; ${n} ${APPLY ? "corrected" : "to correct"}.`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
