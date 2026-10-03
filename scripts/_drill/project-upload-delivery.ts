// @drill-run: engine=postgres needs=tools/realpg timeout=180
// Real isolated Postgres, actual grouped delivery and webhook handler. Only the
// provider listing read is fake. No client/provider mutations are permitted.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
installNextStubs();
const fence = fenceFetch(() => null);
async function main() {
  if (!(await portFree(5972))) throw new Error("Fixture port 5972 busy; existing process untouched");
  const db = await bootDrillDb({ port: 5972, engine: "postgres", pool: 5 }), c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const d = await import("@/lib/deliveryUploads"), p = await import("@/lib/projectDelivery");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    const fp = async (id: string) => sourceFingerprint((await loadCut(id))!)!;
    const shell = await buildContentMonth(prisma, { name: "Grouped delivery TEST", package: "Starter" });
    const projectId = shell.projectId!, listingId = "isolated-group-listing";
    await prisma.project.update({ where: { id: projectId }, data: { contentMonthId: null, aryeoListingId: listingId } });
    const createCut = async (slot: number, round = 1) => {
      const cut = await prisma.reviewSubmission.create({ data: { projectId, deliverableId: shell.deliverableId, slot, round, status: "APPROVED", assetPath: `/fixture/final-${slot}-v${round}.mp4`, source: "upload", decidedAt: new Date(), contentHash: `hash-${slot}-${round}` } });
      await prisma.deliverableOutput.upsert({ where: { deliverableId_slot: { deliverableId: shell.deliverableId!, slot } },
        create: { projectId, deliverableId: shell.deliverableId!, slot, category: "VIDEO", currentSubmissionId: cut.id, approvedSubmissionId: cut.id }, update: { currentSubmissionId: cut.id, approvedSubmissionId: cut.id, sentSubmissionId: null, deliveredAt: null } });
      return cut;
    };
    const first = await createCut(1), second = await createCut(2), third = await createCut(3);
    const actor = { id: null, name: "Kyle fixture" };
    for (const cut of [first, second]) await d.recordUploaded(cut.id, actor, await fp(cut.id));
    const targets = await Promise.all([first, second].map(async v => ({ submissionId: v.id, fingerprint: await fp(v.id) })));
    c.ok("wrong project refuses entire group before recording any send", !(await p.markUploadedGroupSent("other-project", targets, actor.name)).ok && await prisma.reviewSubmission.count({ where: { projectId, sentToClientAt: { not: null } } }) === 0);
    c.ok("duplicate membership is refused", !(await p.markUploadedGroupSent(projectId, [targets[0], targets[0]], actor.name)).ok);
    c.ok("one stale version refuses whole group before any send", !(await p.markUploadedGroupSent(projectId, [targets[0], { ...targets[1], fingerprint: "wrong-file" }], actor.name)).ok && await prisma.reviewSubmission.count({ where: { projectId, sentToClientAt: { not: null } } }) === 0);
    c.ok("unacknowledged video cannot sneak into group", !(await p.markUploadedGroupSent(projectId, [...targets, { submissionId: third.id, fingerprint: await fp(third.id) }], actor.name)).ok);
    const sent = await p.markUploadedGroupSent(projectId, targets, actor.name);
    const original = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.id } });
    c.ok("one group command records exactly its two uploaded versions", sent.ok && sent.completed.length === 2 && await prisma.reviewSubmission.count({ where: { projectId, sentToClientAt: { not: null } } }) === 2);
    c.ok("unspecified video remains owed", !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: third.id } })).sentToClientAt);
    c.ok("group command settles exact per-output bookkeeping", await prisma.deliverableOutput.count({ where: { projectId, sentSubmissionId: { in: targets.map(v => v.submissionId) }, deliveredAt: { not: null } } }) === 2);
    await p.markUploadedGroupSent(projectId, targets, "Another office fixture");
    const replayed = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.id } });
    c.ok("group retry preserves original actor and time", original.sentToClientBy === replayed.sentToClientBy && original.sentToClientAt?.getTime() === replayed.sentToClientAt?.getTime());
    const replacement = await createCut(1, 2);
    await p.markUploadedGroupSent(projectId, targets, actor.name);
    c.ok("stale group retry cannot deliver a newer replacement", !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: replacement.id } })).sentToClientAt);
    c.ok("old delivery repair cannot fill the newer output's delivery row", !(await prisma.deliverableOutput.findUniqueOrThrow({ where: { deliverableId_slot: { deliverableId: shell.deliverableId!, slot: 1 } } })).sentSubmissionId);
    const repairCut = await createCut(4); await d.recordUploaded(repairCut.id, actor, await fp(repairCut.id));
    const repairTarget = [{ submissionId: repairCut.id, fingerprint: await fp(repairCut.id) }];
    await prisma.deliverableOutput.deleteMany({ where: { deliverableId: shell.deliverableId!, slot: 4 } });
    // Simulate a post-claim bookkeeping failure, not a nonexistent precondition:
    // restore the output for validation then fail its first delivery update.
    await prisma.deliverableOutput.create({ data: { projectId, deliverableId: shell.deliverableId!, slot: 4, category: "VIDEO", currentSubmissionId: repairCut.id, approvedSubmissionId: repairCut.id } });
    const realUpdate = prisma.deliverableOutput.updateMany;
    let failOnce = true;
    prisma.deliverableOutput.updateMany = ((...args: Parameters<typeof realUpdate>) => {
      if (failOnce) { failOnce = false; throw new Error("isolated bookkeeping failure"); }
      return realUpdate.apply(prisma.deliverableOutput, args);
    }) as unknown as typeof realUpdate;
    const partial = await p.markUploadedGroupSent(projectId, repairTarget, actor.name);
    prisma.deliverableOutput.updateMany = realUpdate;
    const partialStamp = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: repairCut.id } });
    c.ok("partial bookkeeping keeps the group outstanding with an exact reason", !partial.ok && partial.completed.length === 0 && partial.message.includes("delivery row did not stamp") && !!partialStamp.sentToClientAt);
    const repaired = await p.markUploadedGroupSent(projectId, repairTarget, "Later office fixture");
    c.ok("explicit retry repairs bookkeeping without overwriting the original delivery", repaired.ok && (await prisma.deliverableOutput.findUniqueOrThrow({ where: { deliverableId_slot: { deliverableId: shell.deliverableId!, slot: 4 } } })).sentSubmissionId === repairCut.id && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: repairCut.id } })).sentToClientBy === partialStamp.sentToClientBy);
    for (const cut of [replacement, third]) await d.recordUploaded(cut.id, actor, await fp(cut.id));
    const delivered = { id: listingId, delivery_status: "DELIVERED", videos: [] };
    c.ok("cached DELIVERED without authenticated event settles nothing", (await p.acknowledgedDeliveryTargets(projectId, delivered)).length === 0);
    const integration = await import("@/lib/integrations/aryeo");
    const originalListing = integration.Aryeo.listing;
    integration.Aryeo.listing = async (id: string) => ({ ...delivered, id }) as Awaited<ReturnType<typeof originalListing>>;
    const { handleAryeoActivity, proveListingNow } = await import("@/lib/aryeoDelivery");
    const event = (id: string, at = new Date()) => ({ object: "ACTIVITY", id, resource: { object: "LISTING", id: listingId }, occurred_at: at.toISOString() });
    await handleAryeoActivity("LISTING_DELIVERED", event("unsigned"), { authenticated: false });
    c.ok("unsigned delivery event cannot settle acknowledged uploads", !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: third.id } })).sentToClientAt && await prisma.auditLog.count({ where: { action: "aryeo_listing_delivery_event" } }) === 0);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-" } } });
    await handleAryeoActivity("LISTING_DELIVERED", event("historical", new Date(Date.now() - 60_000)), { authenticated: true });
    c.ok("signed older delivery cannot settle later acknowledgements", !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: third.id } })).sentToClientAt);
    const live = event("fresh-signed");
    await handleAryeoActivity("LISTING_DELIVERED", live, { authenticated: true });
    const webhookSent = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: third.id } });
    c.ok("distinct authenticated delivery resolves acknowledged versions even inside the prior-event cooldown", !!webhookSent.sentToClientAt && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: replacement.id } })).sentToClientAt && webhookSent.sentToClientBy?.includes("after staff upload acknowledgement") === true);
    c.ok("webhook fills per-output delivery using the acknowledged version", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { deliverableId_slot: { deliverableId: shell.deliverableId!, slot: 1 } } })).sentSubmissionId === replacement.id);
    await handleAryeoActivity("LISTING_DELIVERED", live, { authenticated: true });
    c.ok("webhook replay preserves first saved attribution/time", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: third.id } })).sentToClientAt?.getTime() === webhookSent.sentToClientAt?.getTime());
    const newer = await createCut(3, 2); await d.recordUploaded(newer.id, actor, await fp(newer.id));
    c.ok("new upload after prior authenticated delivery stays unsent", (await p.acknowledgedDeliveryTargets(projectId, delivered)).length === 0);
    c.ok("undelivered/wrong listing cannot settle a group", (await p.acknowledgedDeliveryTargets(projectId, { ...delivered, delivery_status: "PROCESSING" })).length === 0 && (await p.acknowledgedDeliveryTargets(projectId, { ...delivered, id: "wrong-listing" })).length === 0);
    await prisma.auditLog.create({ data: { actor: "Aryeo authenticated webhook", action: "aryeo_listing_delivery_event", target: listingId, detail: JSON.stringify({ listingId, occurredAt: new Date().toISOString() }) } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-" } } });
    await proveListingNow(listingId, "isolated-hourly-recovery", delivered);
    c.ok("stored authenticated event can be recovered by existing proof pass", !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: newer.id } })).sentToClientAt);
    integration.Aryeo.listing = originalListing;
    c.ok("no provider calls, messages or final checks were fabricated", fence.blocked.length === 0 && await prisma.finalRenditionCheck.count() === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { await db.stop(); fence.restore(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
