// W05: the delivery exit reads actual outbox states; a failed read is unknown,
// not an empty/all-clear notification lane. All mutations are in PGlite.
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) { return request === "server-only" ? {} : realLoad.call(this, request, parent, isMain); };
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5784) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { deliveryNoticeIncidents, deliveryNoticeFocus } = await import("@/lib/deliveryNoticeIncidents");
    const { readyToSend } = await import("@/lib/readyToSend");
    const client = await prisma.client.create({ data: { name: "W05 Delivery TEST" } });
    const failedProject = await prisma.project.create({ data: { clientId: client.id, title: "1 Failed St, TEST", status: "DELIVERED" } });
    const unknownProject = await prisma.project.create({ data: { clientId: client.id, title: "2 Unknown St, TEST", status: "DELIVERED" } });
    const unrelatedProject = await prisma.project.create({ data: { clientId: client.id, title: "3 Other St, TEST", status: "DELIVERED" } });
    const task = await prisma.smartTask.create({ data: { projectId: failedProject.id, taskType: "delivery_text", title: "Delivery text" } });
    const otherTask = await prisma.smartTask.create({ data: { projectId: unrelatedProject.id, taskType: "confirmation_text", title: "Confirmation" } });
    const failedText = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5550000001", body: "TEST delivery", projectId: failedProject.id, taskId: task.id, state: "failed", providerError: "rejected", dedupeKey: null } });
    const unknownText = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5550000002", body: "TEST delivery", projectId: unknownProject.id, state: "unknown", dedupeKey: `delivery:${unknownProject.id}` } });
    const unrelatedText = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5550000003", body: "TEST confirmation", projectId: unrelatedProject.id, taskId: otherTask.id, state: "failed", dedupeKey: null } });
    let incidents = await deliveryNoticeIncidents();
    c.ok("failed delivery task and unknown delivery identity appear", incidents.length === 2 && incidents.some((r) => r.projectId === failedProject.id && r.state === "failed" && r.taskId === task.id) && incidents.some((r) => r.projectId === unknownProject.id && r.state === "unknown"));
    c.ok("failed confirmation text is not mislabeled a delivery", !incidents.some((r) => r.projectId === unrelatedProject.id));
    c.ok("incident links carry opaque outbox ids", incidents.some((r) => r.outboxId === failedText.id) && incidents.some((r) => r.outboxId === unknownText.id));
    c.ok("focused communications read admits only delivery texts", !!(await deliveryNoticeFocus(unknownText.id)) && !!(await deliveryNoticeFocus(failedText.id)) && !(await deliveryNoticeFocus(unrelatedText.id)) && !(await deliveryNoticeFocus("bad")));
    c.ok("per-job read does not show another project's outcome", (await deliveryNoticeIncidents(failedProject.id)).length === 1);
    let board = await readyToSend({ includeNoticeIncidents: true });
    c.ok("shared delivery board carries incidents even with no unsent cuts", board.ready.length === 0 && board.noticeIncidents?.length === 2 && !!board.noticeIncidentCheck);
    await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5550000001", body: "TEST retry accepted", projectId: failedProject.id, taskId: task.id, state: "accepted", dedupeKey: `delivery:${failedProject.id}`, createdAt: new Date(Date.now() + 1000) } });
    incidents = await deliveryNoticeIncidents();
    c.ok("later accepted retry supersedes older failed row", incidents.length === 1 && incidents[0].projectId === unknownProject.id);
    await prisma.project.update({ where: { id: unknownProject.id }, data: { status: "CANCELLED" } });
    c.ok("cancelled project does not appear", (await deliveryNoticeIncidents()).length === 0);
    await prisma.$executeRawUnsafe('DROP TABLE "OutboxMessage"');
    board = await readyToSend({ includeNoticeIncidents: true });
    c.ok("outbox read failure is marked unavailable, not clear", board.noticeIncidentCheck === null && board.noticeIncidents?.length === 0 && board.followUpChecks?.notTold !== null);
    c.ok("no provider request escaped isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
