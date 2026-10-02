// @drill-run: engine=postgres timeout=240
// Actual status sweep against declared confirmed Pro sessions; no provider keys.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
installNextStubs();
const fence = fenceFetch();

async function main() {
  if (!await portFree(5604)) throw new Error("Owned disposable DB5604 is occupied; no process stopped.");
  const db = await bootDrillDb({ port: 5604, engine: "postgres" });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    const { cutSlots, videoStatesFor } = await import("@/lib/reviewCuts");
    const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
    const f = await buildContentMonth(prisma, { name: "Pro quantity TEST", package: "Pro", project: false, owner: false, portalToken: false });
    let serial = 0;
    const job = async (name: string, opts: { index?: number; quantity?: number; label?: string; confirmed?: boolean; monthId?: string; videosFilmed?: number | null; override?: number | null } = {}) => {
      const n = ++serial, at = new Date("2026-10-06T15:00:00Z");
      const project = await prisma.project.create({ data: {
        clientId: f.clientId, contentMonthId: opts.monthId ?? f.monthId,
        title: `${name} TEST`, packageName: opts.label ?? "Video Pro", status: "EDITING",
        statusPinnedAt: new Date(), shootDate: at, videosFilmed: opts.videosFilmed === undefined ? 4 : opts.videosFilmed,
        videosOwedOverride: opts.override ?? null, aryeoOrderId: `quantity-order-${n}`,
      } });
      const row = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: opts.label ?? "Video Pro", quantity: opts.quantity ?? 4 } });
      const appointment = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: `quantity-appointment-${n}`, status: "SCHEDULED", startAt: at, endAt: new Date(at.getTime() + 4 * 3_600_000), durationMin: 240 } });
      const request = await prisma.programSessionRequest.create({ data: {
        clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: opts.monthId ?? f.monthId,
        projectId: project.id, sessionIndex: opts.index ?? 1, kind: "CONTENT_SESSION",
        status: opts.confirmed === false ? "REQUESTED" : "CONFIRMED", confirmedAt: opts.confirmed === false ? null : new Date(),
        matchState: "CONTENT_EVIDENCE", aryeoAppointmentId: appointment.aryeoId,
        aryeoOrderId: project.aryeoOrderId, slotStart: at, slotEnd: appointment.endAt,
      } });
      // The real filming handoff materializes outputs before its status pass.
      await ensureOutputsForProject(project.id);
      return { project, row, appointment, request };
    };
    const run = async (j: Awaited<ReturnType<typeof job>>) => {
      await syncProjectStatuses({ projectId: j.project.id });
      return prisma.deliverable.findUniqueOrThrow({ where: { id: j.row.id } });
    };
    c.head("Confirmed per-session quota versus whole-month legacy floor");
    const first = await job("first"), second = await job("second", { index: 2 });
    c.ok("first confirmed Pro session stays four after the actual status sweep", (await run(first)).quantity === 4);
    c.ok("second confirmed Pro session independently stays four", (await run(second)).quantity === 4);
    const firstOutputs = await prisma.deliverableOutput.findMany({ where: { projectId: first.project.id, removedFromOrderAt: null } });
    c.ok("first session has four active outputs and no manual editor Start", firstOutputs.length === 4 && await prisma.editorWorkItem.count({ where: { projectId: first.project.id } }) === 0);
    const preserved = firstOutputs[0];
    await prisma.deliverableOutput.update({ where: { id: preserved.id }, data: { filmingNote: "Exact historical note", ownerKey: "kim", targetAt: new Date("2026-10-14T15:00:00Z") } });
    await run(first);
    const after = await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: preserved.id } });
    c.ok("repeat sweep preserves output identity, owner, note and manual target", after.ownerKey === "kim" && after.filmingNote === "Exact historical note" && after.targetAt?.toISOString() === "2026-10-14T15:00:00.000Z" && await prisma.deliverableOutput.count({ where: { projectId: first.project.id } }) === 4);
    const planned = await job("before filming", { videosFilmed: null });
    c.ok("before filming, both single and batched cut readers owe this session four", (await cutSlots(planned.project.id)).length === 4 && (await videoStatesFor([planned.project.id])).get(planned.project.id)?.owed === 4);
    c.ok("pre-filming status sweep does not inflate the declared session quantity", (await run(planned)).quantity === 4);
    const legacy = await job("unconfirmed", { confirmed: false });
    c.ok("unconfirmed legacy Pro still receives existing eight-video floor", (await run(legacy)).quantity === 8);
    const custom = await job("custom", { label: "Video Pro Custom 16 Videos Total" });
    c.ok("stated custom sixteen-video product still outranks session allocation", (await run(custom)).quantity === 16);
    const larger = await job("larger existing", { quantity: 6 });
    c.ok("existing larger purchased quantity is never lowered", (await run(larger)).quantity === 6);
    const overridden = await job("office override", { override: 7 });
    await run(overridden);
    c.ok("office videos-owed override is unchanged and still sizes seven outputs", (await prisma.project.findUniqueOrThrow({ where: { id: overridden.project.id } })).videosOwedOverride === 7 && await prisma.deliverableOutput.count({ where: { projectId: overridden.project.id, removedFromOrderAt: null } }) === 7);
    const ambiguous = await job("ambiguous");
    await prisma.programSessionRequest.create({ data: { ...ambiguous.request, id: undefined, sessionIndex: 2 } });
    c.ok("ambiguous multiple session bindings keep the legacy floor", (await run(ambiguous)).quantity === 8);
    const stale = await job("cancelled appointment");
    await prisma.appointment.update({ where: { id: stale.appointment.id }, data: { status: "CANCELLED" } });
    c.ok("cancelled appointment cannot establish session scope", (await run(stale)).quantity === 8);
    const cancelled = await job("cancelled request");
    await prisma.programSessionRequest.update({ where: { id: cancelled.request.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    c.ok("cancelled request cannot establish session scope", (await run(cancelled)).quantity === 8);
    const superseded = await job("superseded request");
    await prisma.programSessionRequest.create({ data: { clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, sessionIndex: 1, supersedesId: superseded.request.id, status: "REQUESTED" } });
    c.ok("a pending replacement prevents use of the superseded appointment binding", (await run(superseded)).quantity === 8);
    const invalidIndex = await job("out of range session", { index: 3 });
    c.ok("a session index outside the package allocation cannot lower the floor", (await run(invalidIndex)).quantity === 8);
    const foreign = await job("wrong month binding");
    await prisma.programSessionRequest.update({ where: { id: foreign.request.id }, data: { monthId: "unrelated-month" } });
    c.ok("request from another month cannot reduce the project quota", (await run(foreign)).quantity === 8);
    const smallMonth = await prisma.contentMonth.create({ data: { clientId: f.clientId, enrollmentId: f.enrollmentId, monthKey: "2026-11", videosOwed: 5 } });
    const three = await job("five total first", { monthId: smallMonth.id, quantity: 1, videosFilmed: 3 }), two = await job("five total second", { monthId: smallMonth.id, index: 2, quantity: 1, videosFilmed: 2 });
    c.ok("existing five-video month allocation remains three plus two", (await run(three)).quantity === 3 && (await run(two)).quantity === 2);
    const unavailable = await job("failed proof read", { videosFilmed: null });
    const readRequests = prisma.programSessionRequest.findMany;
    prisma.programSessionRequest.findMany = (() => { throw new Error("Declared session evidence read unavailable"); }) as typeof readRequests;
    try {
      let singleRefused = false, batchRefused = false;
      try { await cutSlots(unavailable.project.id); } catch { singleRefused = true; }
      try { await videoStatesFor([unavailable.project.id]); } catch { batchRefused = true; }
      c.ok("failed scope evidence never serves a guessed single or batched quota", singleRefused && batchRefused);
      try { await run(unavailable); } catch { /* an unavailable status pass may abort, but must not lift quota */ }
      c.ok("failed scope evidence cannot mutate the session into a whole-month batch", (await prisma.deliverable.findUniqueOrThrow({ where: { id: unavailable.row.id } })).quantity === 4);
    } finally { prisma.programSessionRequest.findMany = readRequests; }
    c.ok("no provider, message, booking or editor activation was invoked", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.editorWorkItem.count() === 0);
    console.log(await db.evidence()); c.summary();
  } finally { try { await db.stop(); } finally { fence.restore(); } }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
