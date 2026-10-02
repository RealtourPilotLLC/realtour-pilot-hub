// @drill-run: engine=postgres timeout=240
// Exact field-only repair preparation/CAS, fake providers, disposable Postgres.
import { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch(), c = makeChecker();
async function main() {
  if (!await portFree(5974)) throw new Error("Disposable port5974 occupied; no existing process stopped.");
  const db = await bootDrillDb({ port: 5974, engine: "postgres", pool: 5 });
  try {
    const { prisma } = await import("@/lib/prisma");
    const { planHistoricalOutputLinks, applyHistoricalOutputLinks, repairHash, OUTPUT_LINK_UNLOCK } = await import("../_repair/historical-output-links-core");
    const { readOnlyUrl, proveReadOnly, applyArguments } = await import("../_repair/historical-output-links");
    const actor = await prisma.appUser.create({ data: { email: "named-repair-admin@example.test", name: "Declared repair reviewer", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "named-repair-editor@example.test", role: "EDITOR", status: "ACTIVE" } });
    let serial = 0;
    const make = async () => {
      const f = await buildContentMonth(prisma, { name: `Named output ${++serial} TEST`, monthKey: "2026-09", enrollmentStatus: "ENDED", videosPerMonth: 5, owner: false, portalToken: false, project: { status: "DELIVERED" }, topics: [{ title: "Exact existing filmed topic" }] });
      await prisma.project.update({ where: { id: f.projectId! }, data: { videosFilmed: 3, videosOwedOverride: 5, overrideBy: "Jordan", editorManual: true } });
      const script = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: f.topicIds[0], title: "Exact existing script", body: "Immutable filmed words", status: "INTERNAL_REVIEW", clientVisible: false } });
      const version = await prisma.contentScriptVersion.create({ data: { scriptId: script.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, title: script.title, hook: "Existing hook", pointsJson: '[{"text":"One"},{"text":"Two"},{"text":"Three"}]', close: "Existing close", body: script.body, source: "MANUAL" } });
      await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: version.id } });
      const output = await prisma.deliverableOutput.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, category: "SOCIAL_REEL", ownerKey: "kim", source: "override" } });
      const cut1 = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, outputId: output.id, slot: 1, round: 1, fileName: "Original name.mp4", status: "CHANGES_REQUESTED", contentHash: "frozen-v1" } });
      const cut2 = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, outputId: output.id, slot: 1, round: 2, fileName: "Original name v2.mp4", status: "APPROVED", contentHash: "frozen-v2", sentToClientAt: new Date(), clientNoticeAt: new Date(), clientNoticeVia: "phone" } });
      const video = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, currentSubmissionId: cut2.id, finalSubmissionId: cut2.id, status: "DELIVERED", topicId: f.topicIds[0], scriptId: script.id, scriptVersionId: version.id, source: "review", deliveredAt: cut2.sentToClientAt, finalFileRef: "/isolated/frozen-original.mp4" } });
      await prisma.reviewSubmission.updateMany({ where: { id: { in: [cut1.id, cut2.id] } }, data: { videoId: video.id } });
      await prisma.deliverableOutput.update({ where: { id: output.id }, data: { currentSubmissionId: cut2.id, approvedSubmissionId: cut2.id, sentSubmissionId: cut2.id, deliveredAt: cut2.sentToClientAt, deliveredBy: "Kyle", deliveredVia: "office-hand" } });
      await prisma.contentVideoSource.createMany({ data: [cut1, cut2].map((s) => ({ videoId: video.id, kind: "REVIEW_CUT", ref: s.id, submissionId: s.id, round: s.round, isFinal: s.id === cut2.id })) });
      await prisma.clientDecision.create({ data: { videoId: video.id, submissionId: cut1.id, projectId: f.projectId!, enrollmentId: f.enrollmentId, clientId: f.clientId, round: 1, contentHash: "frozen-v1", decision: "REQUEST_CHANGES", actorLabel: "Existing client decision", note: "Existing exact version note" } });
      return { videoId: video.id, outputId: output.id, cutId: cut2.id, projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId };
    };
    const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };
    const first = await make(), allowed = [first];
    const snapshot = async () => {
      const videos = await prisma.contentVideo.findMany({ orderBy: { id: "asc" } });
      return repairHash({ videos: videos.map((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !["outputId", "updatedAt"].includes(k)))), outputs: await prisma.deliverableOutput.findMany({ orderBy: { id: "asc" } }), cuts: await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } }), sources: await prisma.contentVideoSource.findMany({ orderBy: { id: "asc" } }), decisions: await prisma.clientDecision.findMany({ orderBy: { id: "asc" } }), scripts: await prisma.contentScript.findMany({ orderBy: { id: "asc" } }), versions: await prisma.contentScriptVersion.findMany({ orderBy: { id: "asc" } }), enrollments: await prisma.contentEnrollment.findMany({ orderBy: { id: "asc" } }), months: await prisma.contentMonth.findMany({ orderBy: { id: "asc" } }), projects: await prisma.project.findMany({ orderBy: { id: "asc" } }), deliverables: await prisma.deliverable.findMany({ orderBy: { id: "asc" } }) });
    };
    const before = await snapshot();
    const readonly = new PrismaClient({ datasourceUrl: readOnlyUrl(process.env.DATABASE_URL!), log: [] });
    let plan;
    try { await proveReadOnly(readonly); plan = await planHistoricalOutputLinks(readonly, allowed); }
    finally { await readonly.$disconnect(); }
    c.ok("default inspection is SQLSTATE25006 read-only and changes no business row", before === await snapshot() && (await prisma.contentVideo.findUniqueOrThrow({ where: { id: first.videoId } })).outputId === null);
    c.ok("exact existing identity is ready without reactivating ended enrollment", plan.rows[0].disposition === "ready" && plan.rows[0].proof?.enrollmentStatus === "ENDED");
    c.ok("private plan contains hashes/IDs without source words, paths or script text", !JSON.stringify(plan).includes("Immutable filmed words") && !JSON.stringify(plan).includes("/isolated/") && !JSON.stringify(plan).includes("Existing exact version note"));
    c.ok("CLI defaults to dry-run and rejects missing/incorrect mutation locks", applyArguments([]) === null && await refused(async () => applyArguments(["--apply"])) && await refused(async () => applyArguments(["--write"])));
    const apply = (p = plan, scope = allowed, by = actor.id, unlock = OUTPUT_LINK_UNLOCK, expected = repairHash(p)) => applyHistoricalOutputLinks(prisma, p, scope, { actorUserId: by, unlock, expectedPlanHash: expected });
    c.ok("core refuses missing unlock or wrong reviewed hash before mutation", await refused(() => apply(plan, allowed, actor.id, "locked")) && await refused(() => apply(plan, allowed, actor.id, OUTPUT_LINK_UNLOCK, "0".repeat(64))) && await prisma.contentVideoCorrection.count() === 0);
    c.ok("creative/editor actor cannot apply historical staff repair", await refused(() => apply(plan, allowed, editor.id)) && await prisma.contentVideoCorrection.count() === 0);
    c.ok("extra/missing identities outside reviewed allowlist are refused", await refused(() => apply(plan, [])));
    const result = await apply();
    c.ok("apply changes only the one exact pointer with attributed correction and audit", result.changed === 1 && (await prisma.contentVideo.findUniqueOrThrow({ where: { id: first.videoId } })).outputId === first.outputId && await prisma.contentVideoCorrection.count({ where: { videoId: first.videoId, field: "outputId", fromValue: null, toValue: first.outputId, by: actor.email } }) === 1 && await prisma.auditLog.count({ where: { action: "historical_output_link", target: first.videoId, actor: actor.email } }) === 1);
    c.ok("all script/cut versions, verdicts, source rows, output scope/stamps and ended access are preserved", before === await snapshot());
    const again = await apply();
    c.ok("same reviewed plan is idempotent without another correction", again.changed === 0 && again.already === 1 && await prisma.contentVideoCorrection.count() === 1 && await prisma.auditLog.count({ where: { action: "historical_output_link" } }) === 1);
    c.ok("fresh read sees already linked identity without marking topic identity confirmed", (await planHistoricalOutputLinks(prisma, allowed)).rows[0].disposition === "already" && !(await prisma.contentVideo.findUniqueOrThrow({ where: { id: first.videoId } })).identityConfirmedAt);

    const competition = await make();
    await prisma.contentVideo.create({ data: { enrollmentId: competition.enrollmentId, clientId: competition.clientId, outputId: competition.outputId, status: "ARCHIVED" } });
    const held = await planHistoricalOutputLinks(prisma, [competition]);
    c.ok("archived competing output ownership stays held without merge", held.rows[0].disposition === "held" && await refused(() => apply(held, [competition])));
    const duplicate = await make();
    await prisma.contentVideo.create({ data: { enrollmentId: duplicate.enrollmentId, clientId: duplicate.clientId, projectId: duplicate.projectId, deliverableId: duplicate.deliverableId, slot: duplicate.slot, status: "ARCHIVED" } });
    c.ok("duplicate exact coordinate identity is held even without an output pointer", (await planHistoricalOutputLinks(prisma, [duplicate])).rows[0].disposition === "held");
    const drift = await make(), driftPlan = await planHistoricalOutputLinks(prisma, [drift]);
    await prisma.contentVideo.update({ where: { id: drift.videoId }, data: { title: "An operator changed this after review" } });
    c.ok("concurrent saved video change invalidates reviewed snapshot", await refused(() => apply(driftPlan, [drift])) && !(await prisma.contentVideo.findUniqueOrThrow({ where: { id: drift.videoId } })).outputId);
    const moved = await make(), movedPlan = await planHistoricalOutputLinks(prisma, [moved]);
    await prisma.deliverableOutput.update({ where: { id: moved.outputId }, data: { currentSubmissionId: "newer-unreviewed-cut" } });
    c.ok("new current output cut is refused instead of relinking a stale round", await refused(() => apply(movedPlan, [moved])));
    const scoped = await make();
    const foreignClient = await prisma.client.create({ data: { name: "Outside named repair TEST" } });
    await prisma.project.update({ where: { id: scoped.projectId }, data: { clientId: foreignClient.id } });
    c.ok("cross-client project/month identity cannot be repaired", (await planHistoricalOutputLinks(prisma, [scoped])).rows[0].disposition === "held");
    const batchA = await make(), batchB = await make(), batch = [batchA, batchB], batchPlan = await planHistoricalOutputLinks(prisma, batch);
    await prisma.contentVideo.update({ where: { id: batchB.videoId }, data: { notes: "Saved during operator review" } });
    c.ok("later batch drift rolls back earlier pointer/audit atomically", await refused(() => apply(batchPlan, batch)) && (await prisma.contentVideo.findMany({ where: { id: { in: batch.map((v) => v.videoId) } } })).every((v) => v.outputId === null) && await prisma.contentVideoCorrection.count({ where: { videoId: { in: batch.map((v) => v.videoId) } } }) === 0);
    const ledgerFailure = await make(), ledgerPlan = await planHistoricalOutputLinks(prisma, [ledgerFailure]);
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ADD CONSTRAINT "isolated_refuse_repair_audit" CHECK (action <> \'historical_output_link\') NOT VALID');
    c.ok("audit insertion failure rolls back pointer and correction together", await refused(() => apply(ledgerPlan, [ledgerFailure])) && !(await prisma.contentVideo.findUniqueOrThrow({ where: { id: ledgerFailure.videoId } })).outputId && await prisma.contentVideoCorrection.count({ where: { videoId: ledgerFailure.videoId } }) === 0);
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT "isolated_refuse_repair_audit"');
    const race = await make(), racePlan = await planHistoricalOutputLinks(prisma, [race]);
    const raceResults = await Promise.allSettled([apply(racePlan, [race]), apply(racePlan, [race])]);
    c.ok("concurrent same repair makes one attributed correction at most", raceResults.some((r) => r.status === "fulfilled" && r.value.changed === 1) && await prisma.contentVideoCorrection.count({ where: { videoId: race.videoId } }) === 1 && await prisma.auditLog.count({ where: { target: race.videoId, action: "historical_output_link" } }) === 1);
    c.ok("nothing contacts clients, enables automation, creates work or changes appointments", await prisma.outboxMessage.count() === 0 && await prisma.programAutomation.count() === 0 && await prisma.smartTask.count() === 0 && await prisma.editorWorkItem.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    console.log(await db.evidence()); c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
