// Held transcript wording and existing next-action priority, isolated only.
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { programCallEvidence } from "../../src/lib/programCallEvidence";

installNextStubs();
const NOW = new Date("2026-10-10T14:00:00.000Z");
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5929), env: { AUTH_ENFORCE: "true" } });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { programOverview } = await import("@/lib/programOverview");
    const { monthProgressMany, progressKey } = await import("@/lib/monthProgress");
    const f = await buildContentMonth(prisma, { name: "Held Evidence TEST", monthKey: "2026-10", package: "Starter", videosPerMonth: 1, project: false, owner: false });
    await prisma.contentEnrollment.update({ where: { id: f.enrollmentId }, data: { callMode: "REQUIRED", clientSuppliesTopics: true } });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { strategyCallStatus: "COMPLETED", strategyCallAt: new Date("2026-10-08T14:00:00Z") } });
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", transcriptState: "CONFIRMED", scheduledStart: new Date("2026-10-08T14:00:00Z"), scheduledEnd: new Date("2026-10-08T14:30:00Z") } });
    const read = async (progress?: NonNullable<Parameters<typeof programOverview>[0]>["progress"]) => {
      const result = await programOverview({ monthKey: f.monthKey, enrollmentIds: [f.enrollmentId], includeTest: true, now: NOW, progress });
      const row = result.rows.find((r) => r.monthId === f.monthId);
      if (!row) throw new Error("Fixture overview row missing");
      return row;
    };
    let row = await read();
    c.ok("confirmed held transcript is awaiting analysis, never absent", row.strategyCall.evidence === "transcript held, not analysed yet" && row.strategyCall.problem?.includes("awaiting analysis") === true && !row.nextAction.text.includes("no transcript") && row.nextAction.cta === "Review transcript processing");
    const job = await prisma.programTranscriptJob.create({ data: { callRecordId: call.id, enrollmentId: f.enrollmentId, kind: "ANALYZE", state: "QUEUED", dedupeKey: `${call.id}:ANALYZE` } });
    row = await read();
    c.ok("missing processor switch reports queued and off without completing preparation", row.strategyCall.processing === "transcript queued — processing is off" && row.nextAction.text.includes("confirmed transcript is queued") && row.nextAction.text.includes("call processing is off") && row.planning.preparationWord.includes("queued") && row.priority === 20 && !row.flags.includes("ready_to_film"));
    await prisma.programAutomation.create({ data: { key: "transcript_jobs", enabled: true, configJson: JSON.stringify({ onlyQueuedAfter: "2026-10-11T00:00:00Z" }) } });
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { lastError: "waiting: queued Oct 1, before the call processor was first switched on — include older jobs in Settings → Calendly & calls to run it" } });
    const beforeQueue = JSON.stringify(await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: job.id } }));
    const beforeSwitch = JSON.stringify(await prisma.programAutomation.findUniqueOrThrow({ where: { key: "transcript_jobs" } }));
    row = await read();
    c.ok("queued backlog holds are named as recorded notes without promising execution", row.nextAction.text.includes("Last queue note: waiting: queued") && row.nextAction.text.includes("backlog and rollout holds") && !/next (hourly )?run/.test(row.nextAction.text));
    c.ok("overview leaves switch, cutoff, attempts and queue state untouched", beforeQueue === JSON.stringify(await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: job.id } })) && beforeSwitch === JSON.stringify(await prisma.programAutomation.findUniqueOrThrow({ where: { key: "transcript_jobs" } })));
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { state: "RUNNING", lastError: null } });
    row = await read();
    c.ok("running transcript says processing rather than missing", row.strategyCall.processing === "transcript processing" && row.nextAction.text.includes("being processed") && !row.planning.preparationWord.includes("did not land"));
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { state: "FAILED", lastError: "fixture analysis failure" } });
    row = await read();
    c.ok("failed analysis with held evidence names processing failure", row.strategyCall.evidence === "transcript held, not analysed yet" && row.nextAction.text.includes("transcript processing failed") && !row.nextAction.text.includes("no transcript"));
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "FAILED", lastError: "fixture import failure" } });
    row = await read();
    c.ok("explicit import failure stays a hard problem", row.nextAction.text.includes("transcript import failed") && row.priority === 20 && row.nextAction.cta === "Fix the transcript");
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "NEEDS_REVIEW", lastError: null } });
    row = await read();
    c.ok("explicit needs-review evidence keeps human recovery", row.nextAction.text.includes("needs a person") && row.priority === 20);
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { state: "CANCELLED", lastError: null } });
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "NONE" } });
    row = await read();
    c.ok("genuinely absent evidence still says no transcript or notes", row.nextAction.text === "Call was held — no transcript or notes came back from it" && row.strategyCall.evidence === "no transcript" && row.strategyCall.processing === "transcript jobs cancelled");
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "ANALYZED" } });
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { state: "SUCCEEDED" } });
    await prisma.programTranscriptJob.create({ data: { callRecordId: call.id, enrollmentId: f.enrollmentId, kind: "SCRIPT_DRAFT", state: "FAILED", lastError: "fixture downstream draft failure" } });
    row = await read();
    c.ok("analysed evidence survives an unrelated script-drafting failure", row.strategyCall.problem === null && row.strategyCall.evidence === "transcript analysed" && row.strategyCall.processing === "transcript processed" && !row.nextAction.text.includes("transcript"));
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "CONFIRMED" } });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { transcriptText: "Fixture manual call notes." } });
    row = await read();
    c.ok("manual notes remain usable without a missing-evidence claim", row.strategyCall.evidence === "transcript pasted by hand" && row.strategyCall.problem === null && !row.nextAction.text.includes("transcript"));
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { transcriptText: null } });
    await prisma.programTranscriptJob.update({ where: { id: job.id }, data: { state: "QUEUED" } });
    const script = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, title: "Fixture draft", body: "Fixture script", status: "INTERNAL_REVIEW", source: "manual" } });
    row = await read();
    c.ok("soft queued transcript does not displace existing script approval", row.nextAction.ownerDuty === "script approval" && row.work.scriptsReviewNeeded === 1 && row.strategyCall.problem?.includes("queued") === true);
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "FAILED" } });
    row = await read();
    c.ok("hard import failure still outranks script approval", row.nextAction.ownerDuty === "strategy" && row.nextAction.text.includes("import failed") && row.priority === 20);
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { transcriptState: "CONFIRMED" } });
    const key = progressKey(f.enrollmentId, f.monthId, f.monthKey);
    const supplied = await monthProgressMany([{ enrollmentId: f.enrollmentId, monthId: f.monthId, monthKey: f.monthKey }], { now: NOW });
    const progress = supplied.get(key);
    if (!progress) throw new Error("Fixture progress missing");
    // Exercise the existing next-action precedence with an explicit supplied
    // release fact. Entitlement computation is already covered elsewhere.
    supplied.set(key, { ...progress, portalApprover: true, production: { ...progress.production, awaitingClient: 1 } });
    row = await read(supplied);
    c.ok("downstream released-client decision keeps priority over queued evidence", row.nextAction.blocked === "client" && row.nextAction.text.includes("released and awaiting") && row.work.scriptsReviewNeeded === 1);
    const unknown = programCallEvidence({ held: true, call: { transcriptState: "CONFIRMED", lastError: null }, manualText: false, processed: false, jobs: [{ kind: "ANALYZE", state: "QUEUED", lastError: null, reviewReason: null }], processorEnabled: null });
    c.ok("unreadable processor state is unknown, never implicitly enabled", unknown.processing?.includes("processor state unavailable") === true && !unknown.problem?.includes("next run"));
    const imported = programCallEvidence({ held: true, call: { transcriptState: "CONFIRMED", lastError: null }, manualText: false, processed: false, jobs: [{ kind: "INGEST", state: "SUCCEEDED", lastError: null, reviewReason: null }], processorEnabled: false });
    c.ok("successful import alone does not claim completed analysis", imported.processing === "transcript imported" && imported.problem?.includes("awaiting analysis") === true);
    c.ok("read-only overview creates no attempts, messages or processing side effects", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: job.id } })).attempts === 0 && await prisma.outboxMessage.count() === 0 && await prisma.contentScript.count() === 1 && (await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } })).status === "INTERNAL_REVIEW" && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
