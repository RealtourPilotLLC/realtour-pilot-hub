// Saved W03 receipts must finish after an interrupted issue/timecode write.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { PrismaClient } from "@prisma/client";

installNextStubs();
const fence = fenceFetch();
let failIngestion = false;
let failTimeWrite = false;
let failSecondItem = false;
let uploads = 0;
interceptModule((r) => r === "@/lib/storage", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(t, k) {
    if (k !== "saveUpload") return t[k];
    return async (projectId: string, file: File) => ({ originalName: file.name, storedPath: `/RealTour Pilot/Hub/projects/${projectId}/uploads/fake-${++uploads}.png`, size: file.size, mimeType: file.type });
  },
}));
const clients = new WeakMap<object, unknown>();
interceptModule((r) => r === "@/lib/prisma", (loaded) => {
  const original = (loaded as { prisma: PrismaClient }).prisma;
  if (!clients.has(original)) clients.set(original, original.$extends({ query: { revisionIssue: {
    async create({ args, query }) {
      if (failIngestion) throw new Error("drill: issue ingestion interrupted");
      if (failSecondItem && args.data.sourceId.includes(":i2:")) throw new Error("drill: second issue write interrupted");
      return query(args);
    },
    async updateMany({ args, query }) {
      if (failTimeWrite && Object.hasOwn(args.data, "timeSec")) throw new Error("drill: timestamp write interrupted");
      return query(args);
    },
  } } }));
  return new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => k === "prisma" ? clients.get(original) : t[k] });
});

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5801), env: { AUTH_ENFORCE: "true", APP_SECRET: "w03-retry-isolated-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const { requestApprovedCutRevision } = await import("@/app/review/staffRevisionActions");
  const user = await prisma.appUser.create({ data: { name: "Kyle Retry", email: "retry@example.test", role: "ADMIN", status: "ACTIVE" } });
  await setSession({ uid: user.id, email: user.email, role: user.role });
  const f = await buildContentMonth(prisma as never, { name: "W03 Retry TEST", package: "Starter", videosPerMonth: 1, owner: false, project: { status: "DELIVERED" } });
  const projectId = f.projectId!, deliverableId = f.deliverableId!;
  const cut = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 1, status: "APPROVED", source: "upload", submittedByKey: "kim" } });
  const output = await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
  const form = new FormData();
  form.set("projectId", projectId); form.set("submissionId", cut.id); form.set("requestKey", crypto.randomUUID());
  form.set("confirmedClientWords", "yes"); form.set("clientContact", "Sarah Client");
  form.set("originalText", "  Please brighten the backyard.  "); form.set("timecode", "1:23");
  form.set("attachment", new File(["fake original bytes"], "original.png", { type: "image/png" }));
  failIngestion = true;
  const failed = await requestApprovedCutRevision(form);
  const saved = await prisma.revisionBrief.findFirst({ where: { projectId } });
  c.ok("failure leaves an exact saved receipt and one task, without reporting completion", !failed.ok && !!saved && saved.submissionId === cut.id && saved.outputId === output.id && await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 1);
  const beforeTask = await prisma.smartTask.findUnique({ where: { id: saved!.taskId! } });
  const beforeProject = await prisma.project.findUnique({ where: { id: projectId } });
  const beforeActivities = await prisma.activity.count({ where: { projectId } });
  failIngestion = false;
  const newer = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 2, status: "APPROVED", source: "upload", submittedByKey: "remar", outputId: output.id } });
  await prisma.deliverableOutput.update({ where: { id: output.id }, data: { currentSubmissionId: newer.id } });
  // A retry may arrive with changed form fields. None replace the first receipt.
  form.set("originalText", "Different request"); form.set("clientContact", "Other Contact"); form.set("timecode", "9:59");
  form.set("submissionId", newer.id); form.set("sourceMessageId", "not-an-existing-message");
  form.set("attachment", new File(["replacement bytes"], "replacement.png", { type: "image/png" }));
  const retry = await requestApprovedCutRevision(form);
  const issues = saved ? await prisma.revisionIssue.findMany({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${saved.id}:` } } }) : [];
  c.ok("retry finishes the saved receipt's issue and timestamp", retry.ok && retry.briefId === saved?.id && issues.length === 1 && issues[0].timeSec === 83);
  c.ok("late retry preserves the old exact cut, output and its author", issues[0]?.raisedOnSubmissionId === cut.id && issues[0]?.outputId === output.id && issues[0]?.versionEditorKey === "kim");
  const after = await prisma.revisionBrief.findUnique({ where: { id: saved!.id } });
  c.ok("changed retry cannot replace words, contact, pins, clock or attachment receipt", after?.originalText === saved?.originalText && after?.requestedBy === saved?.requestedBy && after?.submissionId === cut.id && after?.outputId === output.id && after?.createdAt.getTime() === saved?.createdAt.getTime() && after?.dueAt?.getTime() === saved?.dueAt?.getTime() && after?.itemsJson === saved?.itemsJson && uploads === 1 && await prisma.uploadedFile.count({ where: { projectId } }) === 1);
  c.ok("replay neither duplicates nor re-raises the task or project", await prisma.revisionBrief.count({ where: { projectId } }) === 1 && await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 1 && (await prisma.smartTask.findUnique({ where: { id: saved!.taskId! } }))?.description === beforeTask?.description && (await prisma.project.findUnique({ where: { id: projectId } }))?.revisionRequestedAt?.getTime() === beforeProject?.revisionRequestedAt?.getTime() && await prisma.activity.count({ where: { projectId } }) === beforeActivities);

  const fresh = (text: string, time: string) => {
    const d = new FormData(); d.set("projectId", projectId); d.set("submissionId", newer.id); d.set("requestKey", crypto.randomUUID());
    d.set("confirmedClientWords", "yes"); d.set("clientContact", "Sarah Client"); d.set("originalText", text); d.set("timecode", time); return d;
  };
  const timed = fresh("Please change the music.", "0:00");
  failTimeWrite = true;
  const timeFailed = await requestApprovedCutRevision(timed);
  const timeBrief = await prisma.revisionBrief.findFirst({ where: { projectId, sourceDetail: { endsWith: `:${timed.get("requestKey")}` } } });
  c.ok("timestamp failure is reported after the receipt and issue exist", !timeFailed.ok && !!timeBrief && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${timeBrief.id}:` } } }) === 1);
  failTimeWrite = false; timed.set("timecode", "4:00");
  c.ok("timestamp retry restores saved zero, not the changed retry value", (await requestApprovedCutRevision(timed)).ok && (await prisma.revisionIssue.findFirst({ where: { sourceId: { startsWith: `${timeBrief!.id}:` } } }))?.timeSec === 0);

  const blank = fresh("Please keep the title.", "");
  failIngestion = true; await requestApprovedCutRevision(blank); failIngestion = false;
  blank.set("timecode", "1:10");
  const blankResult = await requestApprovedCutRevision(blank);
  c.ok("an intentional blank timestamp survives a changed retry", blankResult.ok && (await prisma.revisionIssue.findFirst({ where: { sourceId: { startsWith: `${blankResult.briefId}:` } } }))?.timeSec === null);

  const multiple = fresh("• Brighten the kitchen.\n• Remove the opening shot.", "1:01");
  failSecondItem = true;
  const partial = await requestApprovedCutRevision(multiple);
  const multipleBrief = await prisma.revisionBrief.findFirst({ where: { projectId, sourceDetail: { endsWith: `:${multiple.get("requestKey")}` } } });
  c.ok("one saved item cannot masquerade as a completed multi-item request", !partial.ok && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${multipleBrief!.id}:` } } }) === 1);
  failSecondItem = false;
  const repaired = await requestApprovedCutRevision(multiple);
  const repairedItems = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${multipleBrief!.id}:` } } });
  c.ok("partial item retry fills the missing item once and timestamps both", repaired.ok && repairedItems.length === 2 && repairedItems.every((i) => i.timeSec === 61));

  const oldData = JSON.parse(saved!.itemsJson!); delete oldData.staffReceipt;
  await prisma.revisionBrief.update({ where: { id: saved!.id }, data: { itemsJson: JSON.stringify(oldData) } });
  const legacy = await requestApprovedCutRevision(form);
  c.ok("legacy missing timestamp evidence requires review and keeps existing timing", !legacy.ok && legacy.message.includes("older request") && (await prisma.revisionIssue.findFirst({ where: { sourceId: { startsWith: `${saved!.id}:` } } }))?.timeSec === 83);

  const missing = fresh("Please fix the final title.", "0:05");
  failIngestion = true; await requestApprovedCutRevision(missing); failIngestion = false;
  const missingBrief = await prisma.revisionBrief.findFirst({ where: { projectId, sourceDetail: { endsWith: `:${missing.get("requestKey")}` } } });
  await prisma.smartTask.update({ where: { id: missingBrief!.taskId! }, data: { status: "COMPLETED" } });
  const closed = await requestApprovedCutRevision(missing);
  c.ok("replay never reopens closed work to create missing issues", !closed.ok && closed.message.includes("already closed") && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${missingBrief!.id}:` } } }) === 0 && (await prisma.smartTask.findUnique({ where: { id: missingBrief!.taskId! } }))?.status === "COMPLETED");
  for (const status of ["DONE", "CLOSED"]) {
    await prisma.smartTask.update({ where: { id: missingBrief!.taskId! }, data: { status } });
    const legacyClosed = await requestApprovedCutRevision(missing);
    c.ok(`legacy ${status} work also stays closed on replay`, !legacyClosed.ok && legacyClosed.message.includes("already closed") && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${missingBrief!.id}:` } } }) === 0 && (await prisma.smartTask.findUnique({ where: { id: missingBrief!.taskId! } }))?.status === status);
  }
  await prisma.smartTask.update({ where: { id: missingBrief!.taskId! }, data: { status: "OPEN" } });
  const foreign = await prisma.project.create({ data: { clientId: f.clientId, title: "Foreign retry TEST" } });
  await prisma.reviewSubmission.update({ where: { id: newer.id }, data: { projectId: foreign.id } });
  const moved = await requestApprovedCutRevision(missing);
  c.ok("a saved pin moved to another project is refused without new issues", !moved.ok && moved.message.includes("no longer belongs") && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${missingBrief!.id}:` } } }) === 0);
  const { ingestBriefItems } = await import("@/lib/revisionIssues");
  c.ok("the shared ingester also refuses a foreign saved version", await ingestBriefItems(missingBrief!.id) === 0 && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${missingBrief!.id}:` } } }) === 0);

  const race = await buildContentMonth(prisma as never, { name: "W03 Competing Receipt TEST", package: "Starter", videosPerMonth: 2, owner: false, project: { status: "DELIVERED" } });
  const raceKey = crypto.randomUUID();
  const candidates: { cut: { id: string; slot: number | null }; output: { id: string }; form: FormData }[] = [];
  for (const slot of [1, 2]) {
    const candidate = await prisma.reviewSubmission.create({ data: { projectId: race.projectId!, deliverableId: race.deliverableId!, slot, round: slot, status: "APPROVED", source: "upload", submittedByKey: "kim" } });
    const candidateOutput = await prisma.deliverableOutput.create({ data: { projectId: race.projectId!, deliverableId: race.deliverableId!, slot, category: "SOCIAL_REEL", currentSubmissionId: candidate.id } });
    const d = fresh(`Original competing request for video ${slot}.`, `0:0${slot}`);
    d.set("projectId", race.projectId!); d.set("submissionId", candidate.id); d.set("requestKey", raceKey); d.set("clientContact", `Contact ${slot}`);
    candidates.push({ cut: candidate, output: candidateOutput, form: d });
  }
  if (drill.engine === "postgres") {
    await drill.sql('CREATE FUNCTION w03_retry_delay_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END; $$');
    await drill.sql('CREATE TRIGGER w03_retry_delay_insert BEFORE INSERT ON "RevisionBrief" FOR EACH ROW EXECUTE FUNCTION w03_retry_delay_insert()');
  }
  const waitsBefore = drill.lockWaits();
  const competing = await drill.backendsDuring(() => Promise.all(candidates.map((candidate) => requestApprovedCutRevision(candidate.form))));
  if (drill.engine === "postgres") {
    await drill.sql('DROP TRIGGER w03_retry_delay_insert ON "RevisionBrief"'); await drill.sql('DROP FUNCTION w03_retry_delay_insert()');
    c.ok("different-cut retries actually contend on the same Postgres receipt lock", competing.distinctBackends >= 2 && drill.lockWaits() > waitsBefore);
  }
  const raceBriefs = await prisma.revisionBrief.findMany({ where: { projectId: race.projectId!, source: "review_room_staff" } });
  const winner = candidates.find((candidate) => candidate.cut.id === raceBriefs[0]?.submissionId);
  const raceIssues = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${raceBriefs[0]?.id}:` } } });
  c.ok("same key on different approved cuts produces one winning exact receipt", competing.result.every((r) => r.ok && r.briefId === raceBriefs[0]?.id) && raceBriefs.length === 1 && !!winner && raceBriefs[0].originalText === winner.form.get("originalText") && raceBriefs[0].requestedBy === `Kyle Retry (on behalf of ${winner.form.get("clientContact")})` && raceBriefs[0].outputId === winner.output.id);
  c.ok("competing cut retry keeps one issue with the winner's time and one task", raceIssues.length === 1 && raceIssues[0].raisedOnSubmissionId === winner?.cut.id && raceIssues[0].timeSec === winner?.cut.slot && await prisma.smartTask.count({ where: { projectId: race.projectId!, taskType: "revision" } }) === 1);
  await clearSession();
  c.ok("saved receipt replay still requires an authenticated reviewer", !(await requestApprovedCutRevision(timed)).ok);
  // The established W03 drill separately covers owner preview and editor guards.
  c.ok("retry creates no editor Start/Pause work", await prisma.editorWorkItem.count({ where: { projectId } }) === 0);
  c.ok("no provider request escaped the fixture", fence.blocked.length === 0);
  console.log(await drill.evidence()); c.summary(); quiet.restore(); await drill.stop(); process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
