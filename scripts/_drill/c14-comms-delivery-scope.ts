// C14: fixture traffic cannot crowd real work out of Comms, Outbox or delivery.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { isSyntheticClientRow, NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5816) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { unansweredCommsBoard } = await import("@/lib/commsBoard");
    const { findUnansweredInbound } = await import("@/lib/commsSla");
    const { getEmailThreads } = await import("@/components/comms/emailThreads");
    const { clientTextWhere } = await import("@/lib/clientTexts");
    const { getClientTextTasks } = await import("@/lib/queries");
    const { listDraftedTexts } = await import("@/app/tasks/sendAllActions");
    const { readyToSend } = await import("@/lib/readyToSend");
    const { reviewDeliveryBoard } = await import("@/lib/reviewDelivery");
    const now = new Date();
    const day = 86_400_000;
    const real = await prisma.client.create({ data: { name: "Real Agent", phone: "2025550101" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", phone: "2025550102" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST", phone: "2025550103" } });
    const realJob = await prisma.project.create({ data: { clientId: real.id, title: "123 TEST Avenue", status: "REVIEW" } });
    const fixtureJob = await prisma.project.create({ data: { clientId: fixture.id, title: "456 Fixture Avenue", status: "REVIEW" } });
    const protectedJob = await prisma.project.create({ data: { clientId: protectedReal.id, title: "789 TEST Road", status: "REVIEW" } });
    const scope = { excludeClientIds: (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((r) => r.id) };
    for (const client of [real, protectedReal]) await prisma.commLog.create({ data: { clientId: client.id, clientName: client.name, contactName: client.name, channel: "email", source: "gmail", direction: "in", subject: `Delivery for ${client.name}`, body: "Can you confirm when the video will be ready?", occurredAt: new Date(now.getTime() - 3_600_000) } });
    await prisma.commLog.createMany({ data: Array.from({ length: 3005 }, (_, i) => ({ clientId: fixture.id, clientName: fixture.name, contactName: fixture.name, channel: "email", source: "gmail", direction: "in", subject: "Synthetic question", body: `Can you send the fixture video ${i}?`, occurredAt: new Date(now.getTime() - i) })) });
    const comms = await unansweredCommsBoard("email", now, scope);
    c.ok("real email waits survive synthetic traffic above the source cap", comms.length === 2 && comms.some((r) => r.clientId === real.id) && comms.some((r) => r.clientId === protectedReal.id));
    c.ok("Home email/SLA reader shares the same real queue", (await findUnansweredInbound(now, { ...scope, families: ["email"] })).length === comms.length);
    c.ok("full email queue retains fixture traffic", (await unansweredCommsBoard("email", now)).some((r) => r.clientId === fixture.id));
    const emails = await getEmailThreads(scope);
    c.ok("Email archive filters before its 800-message cap", emails.threads.length === 2 && emails.threads.every((t) => !t.counterpart.includes("Avery")));

    const ledgerReal = await prisma.client.create({ data: { name: "Older Real Agent" } });
    await prisma.commLog.create({ data: { clientId: ledgerReal.id, clientName: ledgerReal.name, contactName: ledgerReal.name, channel: "email", source: "gmail", direction: "in", body: "Can you check the video delivery?", occurredAt: new Date(now.getTime() - 60 * day) } });
    for (const client of [ledgerReal, fixture]) await prisma.smartTask.create({ data: { clientId: client.id, title: "Reply to the old email", taskType: "client_reply", source: "gmail", contactName: client.name, description: "Can you check the video delivery?", createdAt: new Date(now.getTime() - 60 * day) } });
    const withLedger = await unansweredCommsBoard("email", now, scope);
    c.ok("scope keeps real obligations older than the message window", withLedger.some((r) => r.clientId === ledgerReal.id && r.fromLedger) && !withLedger.some((r) => r.clientId === fixture.id));
    await prisma.teamMember.create({ data: { name: "Kyle Staff", email: "kyle@example.test", role: "VA", phone: "2025550199" } });
    await prisma.commLog.create({ data: { clientId: real.id, contactName: "Kyle Staff", fromPhone: "2025550199", channel: "text", source: "openphone", direction: "in", body: "Can someone review my upload?", occurredAt: now } });
    c.ok("client work queue still excludes recognized team traffic", (await unansweredCommsBoard("phone", now, scope)).length === 0);

    for (const [client, project] of [[real, realJob], [fixture, fixtureJob], [protectedReal, protectedJob]] as const) {
      await prisma.smartTask.create({ data: { clientId: client.id, projectId: project.id, title: `Delivery text for ${project.title}`, taskType: "delivery_text" } });
    }
    const drafts = await getClientTextTasks(scope);
    const batch = await listDraftedTexts();
    c.ok("normal Outbox badge, panel and review batch contain the same drafts", drafts.length === 2 && await prisma.smartTask.count({ where: clientTextWhere(now, scope) }) === 2 && batch.ok && batch.rows?.length === 2 && batch.rows.every((r) => drafts.some((d) => d.id === r.taskId)));
    c.ok("explicit Outbox test view restores fixture drafts", (await getClientTextTasks()).length === 3 && (await listDraftedTexts({ includeTest: true })).rows?.length === 3);

    const readyIds: string[] = [];
    const renderingIds: string[] = [];
    for (const project of [realJob, fixtureJob, protectedJob]) {
      const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 3 } });
      const ready = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, kind: "video", status: "APPROVED", fileName: "ready.mp4", blobUrl: "https://example.test/ready.mp4", decidedAt: now } });
      const rendering = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 2, kind: "video", status: "APPROVED", fileName: "rendering.mp4", blobUrl: "https://example.test/rendering.mp4", decidedAt: now } });
      await prisma.topazJob.create({ data: { projectId: project.id, submissionId: rendering.id, state: "processing" } });
      if (project.id !== fixtureJob.id) { readyIds.push(ready.id); renderingIds.push(rendering.id); }
      await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 3, kind: "video", status: "APPROVED", sentToClientAt: new Date(now.getTime() - day), clientNoticeVia: "not-yet" } });
      if (project.id === fixtureJob.id) {
        await prisma.reviewSubmission.createMany({ data: Array.from({ length: 140 }, (_, i) => ({ projectId: project.id, deliverableId: deliverable.id, slot: 10 + i, kind: "video", status: "APPROVED", sentToClientAt: new Date(now.getTime() - (i < 70 ? 2 * day : 1000)), clientNoticeVia: "not-yet" })) });
      }
      await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "2025550190", body: "Isolated delivery notice", projectId: project.id, dedupeKey: `delivery:${project.id}`, state: "unknown" } });
    }
    const board = await readyToSend({ ...scope, includeNoticeIncidents: true, recordFollowUpHealth: true });
    c.ok("normal delivery candidates keep exact real approved and rendering versions", board.ready.length === 2 && board.ready.every((r) => readyIds.includes(r.submissionId)) && board.rendering.length === 2 && board.rendering.every((r) => renderingIds.includes(r.submissionId)));
    c.ok("real follow-up lanes survive synthetic rows above both caps", board.needsFinishing.length === 2 && board.notTold?.length === 2 && board.needsFinishing.every((r) => r.projectId !== fixtureJob.id) && board.notTold.every((r) => r.projectId !== fixtureJob.id));
    c.ok("normal delivery incidents exclude fixture messages", board.noticeIncidents?.length === 2 && board.noticeIncidents.every((r) => r.projectId !== fixtureJob.id));
    const review = await reviewDeliveryBoard({ includeTest: false });
    c.ok("Review Room and Home share the same filtered follow-up lanes", review.ready.length === board.ready.length && review.needsFinishing.length === board.needsFinishing.length && review.notTold?.length === board.notTold?.length);
    const full = await readyToSend({ includeNoticeIncidents: true });
    c.ok("full delivery reader retains fixture candidates and follow-ups", full.ready.length === 3 && full.rendering.length === 3 && full.needsFinishing.some((r) => r.projectId === fixtureJob.id) && !!full.notTold?.some((r) => r.projectId === fixtureJob.id) && full.noticeIncidents?.length === 3);
    const health = await prisma.deliveryFollowUpHealth.findMany({ orderBy: { lane: "asc" } });
    await readyToSend({ projectId: realJob.id, recordFollowUpHealth: true });
    const projectHealth = await prisma.deliveryFollowUpHealth.findMany({ orderBy: { lane: "asc" } });
    c.ok("office health still records success; project reads cannot overwrite it", health.length === 2 && JSON.stringify(health) === JSON.stringify(projectHealth));
    c.ok("no provider traffic or messages sent", fence.blocked.length === 0 && await prisma.outboxMessage.count({ where: { state: "accepted" } }) === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
