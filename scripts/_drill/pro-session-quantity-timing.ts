// @drill-run: engine=postgres timeout=180
// Named writer/reader gap only: real flex/near-slot reconciliation retains the
// asked time while the confirmed appointment is the current booking identity.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
installNextStubs();

async function main() {
  if (!await portFree(5604)) throw new Error("Disposable DB5604 is occupied; no process stopped.");
  const db = await bootDrillDb({ port: 5604, engine: "postgres" }), fence = fenceFetch(), c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    const { cutSlots, videoStatesFor } = await import("@/lib/reviewCuts");
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    for (const kind of ["flex", "near-slot"] as const) {
      const f = await buildContentMonth(prisma, { name: `Pro ${kind} quantity TEST`, package: "Pro", project: false, owner: false, portalToken: false });
      const actualStart = new Date("2026-10-06T15:00:00Z"), requestedStart = kind === "flex" ? null : new Date(actualStart.getTime() - 3_600_000);
      const project = await prisma.project.create({ data: { clientId: f.clientId, contentMonthId: f.monthId, title: `${kind} session TEST`, packageName: "Video Pro", status: "EDITING", statusPinnedAt: new Date(), shootDate: actualStart } });
      const row = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Video Pro", quantity: 4 } });
      const appointment = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: `pro-timing-${kind}`, startAt: actualStart, endAt: new Date(actualStart.getTime() + 4 * 3_600_000), durationMin: 240, status: "SCHEDULED" } });
      const request = await prisma.programSessionRequest.create({ data: { clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, kind: "CONTENT_SESSION", sessionIndex: 1, status: "REQUESTED", slotStart: requestedStart } });
      await reconcileSessionRequests();
      const confirmed = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: request.id } });
      c.ok(`${kind}: actual reconciliation names the current appointment without rewriting the asked time`, confirmed.status === "CONFIRMED" && confirmed.matchState === "MONTH_LINK" && confirmed.projectId === project.id && confirmed.aryeoAppointmentId === appointment.aryeoId && (confirmed.slotStart?.getTime() ?? null) === (requestedStart?.getTime() ?? null));
      c.ok(`${kind}: single and batched readers use the confirmed session's four-video allocation`, (await cutSlots(project.id)).length === 4 && (await videoStatesFor([project.id])).get(project.id)?.owed === 4);
      await syncProjectStatuses({ projectId: project.id });
      c.ok(`${kind}: actual status sweep preserves four and the unchanged confirmed request`, (await prisma.deliverable.findUniqueOrThrow({ where: { id: row.id } })).quantity === 4 && (await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: request.id } })).aryeoAppointmentId === appointment.aryeoId);
    }
    c.ok("timing acceptance uses no providers, sends, bookings or editor Start", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.editorWorkItem.count() === 0);
    console.log(await db.evidence()); c.summary();
  } finally { try { await db.stop(); } finally { fence.restore(); } }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
