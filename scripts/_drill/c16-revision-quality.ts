// C16: reviewer-confirmed causes, exact issue identities and normal-client metrics.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { Prisma } from "@prisma/client";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5821) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { revisionQuality } = await import("@/lib/revisionQuality");
    const { editorQuality, editorsWithWork } = await import("@/lib/editorQuality");
    const { unclassifiedIssues, classifyIssue } = await import("@/lib/revisionIssues");
    const now = new Date();
    const createdAt = new Date(now.getTime() - 60_000);
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const test = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const makeJob = (clientId: string, title: string) => prisma.project.create({ data: { clientId, title } });
    const realJob = await makeJob(real.id, "123 TEST Avenue");
    const testJob = await makeJob(test.id, "Fixture job");
    const protectedJob = await makeJob(protectedReal.id, "Protected job");
    const cut = (projectId: string, key = "kim", slot = 1) => prisma.reviewSubmission.create({ data: { projectId, kind: "video", slot, status: "CHANGES_REQUESTED", source: "upload", submittedByKey: key, createdAt, decidedAt: now, decidedBy: "James" } });
    const version = await cut(realJob.id);
    const unknownVersion = await cut(realJob.id, "kim", 2);
    const protectedVersion = await cut(protectedJob.id);
    const testVersion = await cut(testJob.id, "john");
    let sequence = 0;
    const issue = (extra: Partial<Prisma.RevisionIssueUncheckedCreateInput> = {}) => prisma.revisionIssue.create({ data: {
      projectId: realJob.id, raisedOnSubmissionId: version.id, sourceKind: "MANUAL", sourceId: `isolated-${sequence++}`,
      originalText: "Exact original request", versionEditorKey: "kim", cause: "EDITOR_ERROR", causeConfirmedBy: "James", causeConfirmedAt: now,
      createdAt, ...extra,
    } });
    const root = await issue();
    await issue({ state: "DUPLICATE", duplicateOfId: root.id });
    await issue({ state: "NOT_APPLICABLE" });
    const unconfirmed = await issue({ raisedOnSubmissionId: unknownVersion.id, causeConfirmedAt: null, causeConfirmedBy: null });
    for (const cause of ["CLIENT_CHANGE", "NEW_SCOPE", "BRIEF_GAP", "CAPTURE", "PROCESSING"]) await issue({ cause });
    await issue({ versionEditorKey: null, raisedOnSubmissionId: null });
    await issue({ projectId: protectedJob.id, raisedOnSubmissionId: protectedVersion.id });
    await issue({ projectId: testJob.id, raisedOnSubmissionId: testVersion.id, versionEditorKey: "john" });
    await issue({ projectId: "removed-historical-job", raisedOnSubmissionId: null, versionEditorKey: null });
    // Unticked optional checklist records are entirely separate from issue proof.
    await prisma.qcRecord.create({ data: { projectId: realJob.id, itemsChecked: JSON.stringify([{ label: "Optional check", done: false }]), missCount: 999 } });
    const normal = await revisionQuality(30, { includeTest: false, now });
    c.ok("normal summary counts applicable root issues, never optional unchecked boxes", normal.applicableIssues === 9 && normal.confirmedIssues === 8 && normal.awaitingClassification === 1, JSON.stringify(normal));
    c.ok("duplicates and N/A are excluded from the applicable denominator", normal.duplicates === 1 && normal.notApplicable === 1);
    c.ok("client scope, brief, footage and processing causes stay separate from editor attribution", normal.attributedEditorIssues === 2 && normal.editorIssuesWithoutAttribution === 1 && normal.byCause.find((x) => x.cause === "CLIENT_CHANGE")?.count === 1 && normal.byCause.find((x) => x.cause === "EDITOR_ERROR")?.count === 3);
    c.ok("same-version issues do not inflate affected-version count; unlinked history stays visible", normal.affectedVersions === 2 && normal.versionsNotRecorded === 1 && normal.unlinkedHistory === 1);
    const all = await revisionQuality(30, { includeTest: true, now });
    c.ok("explicit test view restores only synthetic issue scope", all.confirmedIssues === 9 && all.affectedVersions === 3 && all.includeTest);
    await prisma.revisionIssue.update({ where: { id: root.id }, data: { state: "VERIFIED", verifiedBy: "James", verifiedAt: now } });
    const verified = await revisionQuality(30, { includeTest: false, now });
    await prisma.revisionIssue.update({ where: { id: root.id }, data: { state: "REOPENED" } });
    c.ok("verification/reopening does not count the same issue or version twice", verified.confirmedIssues === normal.confirmedIssues && (await revisionQuality(30, { includeTest: false, now })).confirmedIssues === normal.confirmedIssues);
    const scope = { excludeClientIds: [test.id] };
    const from = new Date(now.getTime() - 86_400_000);
    const report = await editorQuality({ ...scope, editorKey: "kim", from, to: now, now });
    c.ok("first-review denominator holds unconfirmed legacy labels for classification", report.firstReview.reviewed === 2 && report.firstReview.pendingClassification === 1 && report.firstReview.passed === 0, JSON.stringify(report.firstReview));
    c.ok("recurring editor KPI requires confirmation and version-editor attribution", report.recurring.n === 2 && (await editorQuality({ ...scope, from, to: now, now })).recurring.n === 2);
    c.ok("normal editor roster excludes synthetic-only work; full reader retains it", (await editorsWithWork(from, now, scope)).length === 1 && (await editorsWithWork(from, now)).length === 2);
    c.ok("unconfirmed stored cause is actionable in the classification queue", (await unclassifiedIssues(40, scope)).some((x) => x.id === unconfirmed.id));
    await classifyIssue(unconfirmed.id, { cause: "CLIENT_CHANGE" }, { name: "James" });
    const reclassified = await editorQuality({ ...scope, editorKey: "kim", from, to: now, now });
    c.ok("actual reviewer classification settles first review without creating an editor fault", reclassified.firstReview.passed === 1 && reclassified.firstReview.reviewed === 3 && reclassified.recurring.n === 2 && await prisma.revisionIssueEvent.count({ where: { issueId: unconfirmed.id, kind: "CLASSIFIED" } }) === 1);
    await prisma.revisionIssue.createMany({ data: Array.from({ length: 45 }, (_, i) => ({ projectId: testJob.id, sourceKind: "MANUAL", sourceId: `new-test-${i}`, originalText: "Synthetic unclassified", cause: "UNCLASSIFIED", createdAt: now })) });
    const olderUnknown = await issue({ cause: "UNCLASSIFIED", causeConfirmedAt: null, causeConfirmedBy: null });
    c.ok("normal classification queue scopes before its cap", (await unclassifiedIssues(40, scope)).some((x) => x.id === olderUnknown.id) && !(await unclassifiedIssues(40)).some((x) => x.id === olderUnknown.id));
    const whitespace = await issue({ causeConfirmedBy: "  \n " });
    const invalidCause = await issue({ cause: "OLD_IMPORTED_LABEL" });
    c.ok("every unconfirmed stored classification has a review-queue destination", (await unclassifiedIssues(40, scope)).some((x) => x.id === whitespace.id) && (await unclassifiedIssues(40, scope)).some((x) => x.id === invalidCause.id));
    const moved = await cut(realJob.id, "moved-editor");
    await prisma.reviewSubmission.update({ where: { id: moved.id }, data: { status: "APPROVED" } });
    const foreign = await issue({ projectId: testJob.id, raisedOnSubmissionId: moved.id, missedInSubmissionId: moved.id, addressedInSubmissionId: moved.id, versionEditorKey: "john" });
    await prisma.revisionIssueEvent.create({ data: { issueId: foreign.id, kind: "NOT_ADDRESSED", submissionId: moved.id, actorName: "John", note: "Old project ask" } });
    const movedReport = await editorQuality({ ...scope, editorKey: "moved-editor", from, to: now, now });
    c.ok("a moved cut cannot inherit the former project's issue attribution or correction history", movedReport.firstReview.passed === 1 && movedReport.missed.count === 0 && movedReport.missed.asked === 0 && movedReport.declaredNotDone.count === 0, JSON.stringify(movedReport.firstReview));
    const office = await cut(realJob.id, "temporary-key");
    await prisma.reviewSubmission.update({ where: { id: office.id }, data: { submittedByKey: null, status: "APPROVED" } });
    await prisma.cutSelfCheck.create({ data: { submissionId: office.id, projectId: realJob.id, round: 1, editorKey: "remar", actorName: "Kyle", checklistKey: "default", itemsJson: "[]", state: "VALID", createdAt } });
    c.ok("office-upload attribution appears in both the roster and that editor's report", (await editorsWithWork(from, now, scope)).some((r) => r.key === "remar") && (await editorQuality({ ...scope, editorKey: "remar", from, to: now, now })).firstReview.reviewed === 1);
    await prisma.editorWorkEvent.create({ data: { itemId: "isolated-pause", editorKey: "kim", projectId: realJob.id, kind: "PAUSE", reason: "Waiting on files", at: createdAt, actorName: "Kim", actorRole: "EDITOR" } });
    const empty = await editorQuality({ ...scope, editorKey: "nobody", from, to: now, now });
    const emptyWindow = await editorQuality({ ...scope, from: new Date(now.getTime() - 30_000), to: now, now });
    c.ok("empty editor or period scope cannot inherit somebody else's paused work", empty.turnaround.waitingOnAssetsHours === null && emptyWindow.turnaround.waitingOnAssetsHours === null);
    c.ok("reports make no provider, client-send, work-event or financial writes", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.editorWorkEvent.count() === 1 && await prisma.stripeTransaction.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
