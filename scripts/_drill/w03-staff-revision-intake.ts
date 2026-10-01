// W03 receipt-first failures. Providers are byte-preserving local fakes.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { PrismaClient } from "@prisma/client";

installNextStubs();
const fence = fenceFetch();
let failReceipt = false, failCore = false, failQc = false, failFileRecord = false;
let uploadOutcome: "ok" | "unknown_absent" | "unknown_saved" = "ok";
let definiteMissing = false;
let onAnalyze = async () => {};
let analyses = 0;
let uploads = 0, unsafeUpload = false;
const files = new Map<string, Buffer>();
const originals = new Map<string, Buffer>();
interceptModule((r) => r === "@/lib/integrations/dropbox", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(t, k) {
    if (k === "dropboxUpload") return async (path: string, bytes: Uint8Array, opts: { autorename?: boolean; overwrite?: boolean }) => {
      uploads++; unsafeUpload ||= opts.autorename !== false || opts.overwrite === true;
      originals.set(path, Buffer.from(bytes));
      if (uploadOutcome !== "unknown_absent") files.set(path, Buffer.from(bytes));
      if (uploadOutcome !== "ok") throw new Error("drill: response lost after upload attempt");
      return { pathDisplay: path };
    };
    if (k === "dropboxDownload") return async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) {
        if (definiteMissing) throw new (t.DropboxError as new (message: string, status: number) => Error)("Dropbox download failed: path/not_found/", 409);
        throw new Error("drill: unknown/missing attachment");
      }
      return bytes;
    };
    return t[k];
  },
}));
interceptModule((r) => r === "@/lib/integrations/ai", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(t, k) {
    if (k !== "aiJson") return t[k];
    return async () => { analyses++; await onAnalyze(); return { headline: "Analysis", items: [], keep: [], references: [{ what: "Model replacement", where: "not-the-client-file" }], questions: [] }; };
  },
}));
const clients = new WeakMap<object, unknown>();
interceptModule((r) => r === "@/lib/prisma", (loaded) => {
  const original = (loaded as { prisma: PrismaClient }).prisma;
  if (!clients.has(original)) clients.set(original, original.$extends({ query: {
    revisionBrief: { async create({ args, query }) { if (failReceipt) throw new Error("drill: receipt write unavailable"); return query(args); } },
    uploadedFile: { async create({ args, query }) { if (failFileRecord) throw new Error("drill: file record write unavailable"); return query(args); } },
    smartTask: {
      async createMany({ args, query }) { if (failCore) throw new Error("drill: task handoff interrupted"); return query(args); },
      async update({ args, query }) { if (failQc && args.data.checklist) throw new Error("drill: QC handoff interrupted"); return query(args); },
    },
  } }));
  return new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => k === "prisma" ? clients.get(original) : t[k] });
});

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5802), env: { AUTH_ENFORCE: "true", APP_SECRET: "w03-intake-isolated-secret" } });
  const quiet = quietPrismaErrors(), c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  const { requestApprovedCutRevision } = await import("@/app/review/staffRevisionActions");
  const { staffReceiptIntake, staffReceiptTime } = await import("@/lib/revisionBrief");
  const { ingestBriefItems } = await import("@/lib/revisionIssues");
  const user = await prisma.appUser.create({ data: { name: "Kyle Intake", email: "intake@example.test", role: "ADMIN", status: "ACTIVE" } });
  await setSession({ uid: user.id, email: user.email, role: user.role });
  const f = await buildContentMonth(prisma as never, { name: "W03 Durable Intake TEST", package: "Starter", videosPerMonth: 1, owner: false, project: { status: "DELIVERED" } });
  const projectId = f.projectId!, deliverableId = f.deliverableId!;
  const cut = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 1, status: "APPROVED", source: "upload", submittedByKey: "kim" } });
  const output = await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
  const qc = await prisma.smartTask.create({ data: { taskType: "media_qa", title: "Completed original QC", status: "COMPLETED", projectId, dedupeKey: `fixture-qc-${projectId}`, checklist: JSON.stringify([{ label: "Re-QC after revision", done: true }]) } });
  const qcRecord = await prisma.qcRecord.create({ data: { projectId, itemsChecked: "[]", completedBy: "james" } });
  const removalKey = `editing-removed:${projectId}`;
  await prisma.appSetting.create({ data: { key: removalKey, value: JSON.stringify({ by: "Jordan", at: new Date().toISOString(), note: "done", task: null }) } });
  const makeForm = (words: string, attachment = true) => {
    const form = new FormData(); form.set("projectId", projectId); form.set("submissionId", cut.id); form.set("requestKey", crypto.randomUUID());
    form.set("confirmedClientWords", "yes"); form.set("clientContact", "Sarah Client"); form.set("originalText", words); form.set("timecode", "1:23");
    if (attachment) form.set("attachment", new File(["original attachment bytes"], "reference.png", { type: "image/png" })); return form;
  };
  const receiptFor = (form: FormData) => prisma.revisionBrief.findFirst({ where: { projectId, sourceDetail: { endsWith: `:${form.get("requestKey")}` } } });
  const activityBefore = await prisma.activity.count({ where: { projectId } });
  const form = makeForm("  Please brighten the exact approved backyard cut.  ");
  failReceipt = true;
  c.ok("a failed initial receipt creates no upload or business mutation", !(await requestApprovedCutRevision(form)).ok && uploads === 0 && await prisma.revisionBrief.count({ where: { projectId } }) === 0 && await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 0 && (await prisma.project.findUnique({ where: { id: projectId } }))?.status === "DELIVERED");
  failReceipt = false; uploadOutcome = "unknown_absent";
  const unknown = await requestApprovedCutRevision(form), saved = await receiptFor(form);
  const manifest = staffReceiptIntake(saved?.itemsJson ?? null)?.attachment;
  c.ok("original evidence is durable before an uncertain provider upload", !unknown.ok && unknown.message.includes("not confirmed") && !!manifest && manifest.state === "UNKNOWN" && saved?.originalText === form.get("originalText") && saved?.requestedBy === "Kyle Intake (on behalf of Sarah Client)" && saved?.submissionId === cut.id && saved?.outputId === output.id && staffReceiptTime(saved.itemsJson)?.timeSec === 83 && saved?.taskId === null);
  c.ok("pending intake creates no task/QC/removal/project side effects", await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 0 && (await prisma.smartTask.findUnique({ where: { id: qc.id } }))?.status === "COMPLETED" && !(await prisma.qcRecord.findUnique({ where: { id: qcRecord.id } }))?.reopenedByRevisionAt && !JSON.parse((await prisma.appSetting.findUnique({ where: { key: removalKey } }))!.value).restoredAt && (await prisma.project.findUnique({ where: { id: projectId } }))?.status === "DELIVERED" && await prisma.activity.count({ where: { projectId } }) === activityBefore);
  c.ok("a reader cannot ingest a pending intake as editor work", await ingestBriefItems(saved!.id) === 0 && await prisma.revisionIssue.count({ where: { projectId } }) === 0);
  form.set("originalText", "Different later words"); form.set("clientContact", "Different contact"); form.set("timecode", "9:59");
  form.set("attachment", new File(["replacement bytes"], "replacement.png", { type: "image/png" }));
  const stillUnknown = await requestApprovedCutRevision(form);
  c.ok("unknown upload retry never uploads replacement bytes or duplicates a file", !stillUnknown.ok && uploads === 1 && (await receiptFor(form))?.originalText === saved?.originalText && await prisma.uploadedFile.count({ where: { projectId } }) === 0);
  files.set(manifest!.storedPath, Buffer.from("wrong stored bytes"));
  c.ok("different bytes at the saved path never confirm the original attachment", !(await requestApprovedCutRevision(form)).ok && uploads === 1 && await prisma.uploadedFile.count({ where: { projectId } }) === 0 && (await receiptFor(form))?.taskId === null);
  // The original provider write finishes later. A retry only checks its path.
  files.set(manifest!.storedPath, originals.get(manifest!.storedPath)!);
  failCore = true;
  const coreFailed = await requestApprovedCutRevision(form);
  c.ok("successful upload with failed task handoff retains one exact file receipt", !coreFailed.ok && uploads === 1 && await prisma.uploadedFile.count({ where: { projectId } }) === 1 && staffReceiptIntake((await receiptFor(form))?.itemsJson ?? null)?.attachment?.state === "CONFIRMED");
  c.ok("task failure rolls project/activity/QC/removal back with its pointer", (await receiptFor(form))?.taskId === null && (await prisma.project.findUnique({ where: { id: projectId } }))?.status === "DELIVERED" && await prisma.activity.count({ where: { projectId } }) === activityBefore && (await prisma.smartTask.findUnique({ where: { id: qc.id } }))?.status === "COMPLETED" && !JSON.parse((await prisma.appSetting.findUnique({ where: { key: removalKey } }))!.value).restoredAt);
  failCore = false; failQc = true;
  const qcFailed = await requestApprovedCutRevision(form);
  c.ok("QC failure also rolls back the task and project instead of half-handing off", !qcFailed.ok && (await receiptFor(form))?.taskId === null && await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 0 && (await prisma.project.findUnique({ where: { id: projectId } }))?.status === "DELIVERED" && !JSON.parse((await prisma.appSetting.findUnique({ where: { key: removalKey } }))!.value).restoredAt && !(await prisma.qcRecord.findUnique({ where: { id: qcRecord.id } }))?.reopenedByRevisionAt);
  failQc = false;
  const done = await requestApprovedCutRevision(form), receipt = await receiptFor(form);
  const task = await prisma.smartTask.findUnique({ where: { id: receipt!.taskId! } });
  c.ok("retry applies only original words/contact/version with the first clock", done.ok && receipt?.id === saved?.id && receipt?.originalText === saved?.originalText && receipt?.requestedBy === saved?.requestedBy && receipt?.createdAt.getTime() === saved?.createdAt.getTime() && receipt?.dueAt?.getTime() === saved?.dueAt?.getTime() && task?.description?.includes(saved!.originalText.trim()) === true && !task?.description?.includes("Different later words") && (await prisma.project.findUnique({ where: { id: projectId } }))?.revisionRequestedAt?.getTime() === saved?.createdAt.getTime());
  c.ok("one successful handoff restores Editing Room and reopens QC at original request time", (await prisma.project.findUnique({ where: { id: projectId } }))?.status === "REVISION" && (await prisma.smartTask.findUnique({ where: { id: qc.id } }))?.status === "OPEN" && (await prisma.qcRecord.findUnique({ where: { id: qcRecord.id } }))?.reopenedByRevisionAt?.getTime() === saved?.createdAt.getTime() && !!JSON.parse((await prisma.appSetting.findUnique({ where: { key: removalKey } }))!.value).restoredAt && await prisma.activity.count({ where: { projectId, type: "FLAG" } }) === 1);
  const notifications = await prisma.notification.count();
  await prisma.smartTask.update({ where: { id: task!.id }, data: { status: "COMPLETED" } });
  await prisma.smartTask.update({ where: { id: qc.id }, data: { status: "COMPLETED" } });
  const replay = await requestApprovedCutRevision(form);
  c.ok("completed replay does not reopen task/QC or duplicate notifications/files", replay.ok && (await prisma.smartTask.findUnique({ where: { id: task!.id } }))?.status === "COMPLETED" && (await prisma.smartTask.findUnique({ where: { id: qc.id } }))?.status === "COMPLETED" && await prisma.notification.count() === notifications && uploads === 1 && await prisma.uploadedFile.count({ where: { projectId } }) === 1);

  const fileRecordForm = makeForm("Please keep the closing title.");
  uploadOutcome = "ok"; failFileRecord = true;
  const fileRecordFailed = await requestApprovedCutRevision(fileRecordForm);
  const fileReceipt = await receiptFor(fileRecordForm);
  c.ok("uploaded bytes survive a failed file-record transaction with no task handoff", !fileRecordFailed.ok && fileReceipt?.taskId === null && staffReceiptIntake(fileReceipt?.itemsJson ?? null)?.attachment?.state === "UPLOADING" && uploads === 2 && await prisma.uploadedFile.count({ where: { projectId } }) === 1);
  failFileRecord = false; fileRecordForm.set("originalText", "replace old ask"); fileRecordForm.delete("attachment");
  const fileRecovered = await requestApprovedCutRevision(fileRecordForm);
  c.ok("file-record retry confirms existing bytes without requiring or resending a file", fileRecovered.ok && uploads === 2 && await prisma.uploadedFile.count({ where: { projectId } }) === 2 && (await receiptFor(fileRecordForm))?.originalText === "Please keep the closing title.");
  const lostResponseForm = makeForm("Please fix the opening title."); uploadOutcome = "unknown_saved";
  c.ok("a lost upload response is resolved by exact-byte readback", (await requestApprovedCutRevision(lostResponseForm)).ok && uploads === 3 && staffReceiptIntake((await receiptFor(lostResponseForm))?.itemsJson ?? null)?.attachment?.state === "CONFIRMED");
  c.ok("staff uploads never overwrite or autorename and no manual work is started", !unsafeUpload && await prisma.editorWorkItem.count({ where: { projectId } }) === 0);
  const absentForm = makeForm("Please keep the original camera move.");
  uploadOutcome = "unknown_absent"; definiteMissing = true;
  const uploadsBeforeAbsent = uploads;
  c.ok("a definite absent upload still keeps its original pending receipt", !(await requestApprovedCutRevision(absentForm)).ok && (await receiptFor(absentForm))?.taskId === null);
  const mismatchedRetry = new FormData(); for (const [key, value] of absentForm) mismatchedRetry.set(key, value);
  mismatchedRetry.set("attachment", new File(["different"], "reference.png", { type: "image/png" }));
  c.ok("known-absent recovery refuses changed bytes before a provider retry", !(await requestApprovedCutRevision(mismatchedRetry)).ok && uploads === uploadsBeforeAbsent + 1);
  uploadOutcome = "ok";
  const recoveredAbsent = await requestApprovedCutRevision(absentForm);
  c.ok("known absence is recoverable with identical bytes at one add-only path", recoveredAbsent.ok && uploads === uploadsBeforeAbsent + 2 && staffReceiptIntake((await receiptFor(absentForm))?.itemsJson ?? null)?.attachment?.state === "CONFIRMED" && (await prisma.uploadedFile.count({ where: { projectId, storedPath: staffReceiptIntake((await receiptFor(absentForm))?.itemsJson ?? null)?.attachment?.storedPath } })) === 1);

  const analysisForm = makeForm("Please leave the original closing shot.");
  uploadOutcome = "unknown_absent"; definiteMissing = false;
  await requestApprovedCutRevision(analysisForm);
  const beforeAnalysis = await receiptFor(analysisForm);
  const analysisAttachment = staffReceiptIntake(beforeAnalysis!.itemsJson)!.attachment!;
  files.set(analysisAttachment.storedPath, originals.get(analysisAttachment.storedPath)!);
  onAnalyze = async () => { if (!(await requestApprovedCutRevision(analysisForm)).ok) throw new Error("drill: concurrent handoff failed"); };
  const { analyzeBrief } = await import("@/lib/revisionBrief");
  const reread = await analyzeBrief(beforeAnalysis!.id);
  const afterAnalysis = await receiptFor(analysisForm), afterIntake = staffReceiptIntake(afterAnalysis!.itemsJson);
  c.ok("model reanalysis keeps attachment/effects advanced during the model call", reread && analyses === 1 && !!afterAnalysis?.taskId && afterIntake?.attachment?.state === "CONFIRMED" && !!afterIntake.effects && JSON.parse(afterAnalysis.itemsJson!).references.some((r: { what: string }) => r.what === "reference.png") && !JSON.parse(afterAnalysis.itemsJson!).references.some((r: { what: string }) => r.what === "Model replacement"));

  const { keepStaffRevisionDraft, clearStaffRevisionDraft, staffRevisionDraftKey, parseStaffRevisionDraft } = await import("@/lib/staffRevisionDraft");
  const browser = new Map<string, string>();
  const storage = { getItem: (key: string) => browser.get(key) ?? null, setItem: (key: string, value: string) => { browser.set(key, value); }, removeItem: (key: string) => { browser.delete(key); } };
  const browserReceipt = { version: 1 as const, requestKey: crypto.randomUUID(), submissionId: cut.id };
  const initialBrowser = keepStaffRevisionDraft(storage, projectId, browserReceipt);
  const afterReload = keepStaffRevisionDraft(storage, projectId, { version: 1, requestKey: crypto.randomUUID(), submissionId: "" });
  c.ok("reload with no selection resumes the same saved browser identity", initialBrowser.requestKey === afterReload.requestKey && afterReload.submissionId === cut.id && parseStaffRevisionDraft(storage.getItem(staffRevisionDraftKey(projectId)))?.requestKey === browserReceipt.requestKey);
  clearStaffRevisionDraft(storage, projectId, "another-request");
  c.ok("only confirmed completion of the same request clears browser recovery", browser.size === 1 && !storage.getItem(staffRevisionDraftKey(projectId))?.includes("originalText"));
  clearStaffRevisionDraft(storage, projectId, browserReceipt.requestKey);
  c.ok("successful completion releases the browser for a new request", browser.size === 0);

  const staleForm = makeForm("Please correct the new title.", false);
  const staleBrowser = keepStaffRevisionDraft(storage, projectId, { version: 1, requestKey: String(staleForm.get("requestKey")), submissionId: cut.id });
  const newer = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 2, status: "APPROVED", source: "upload", submittedByKey: "kim", outputId: output.id } });
  await prisma.deliverableOutput.update({ where: { id: output.id }, data: { currentSubmissionId: newer.id, approvedSubmissionId: newer.id } });
  const stale = await requestApprovedCutRevision(staleForm);
  c.ok("a stale first submit is refused without creating a receipt", !stale.ok && !(await receiptFor(staleForm)));
  const selectedAgain = keepStaffRevisionDraft(storage, projectId, { version: 1, requestKey: crypto.randomUUID(), submissionId: newer.id });
  staleForm.set("requestKey", selectedAgain.requestKey); staleForm.set("submissionId", selectedAgain.submissionId);
  const recoveredStale = await requestApprovedCutRevision(staleForm);
  c.ok("target reselection recovers no-receipt refusal under the same key", recoveredStale.ok && selectedAgain.requestKey === staleBrowser.requestKey && (await receiptFor(staleForm))?.submissionId === newer.id && await prisma.revisionBrief.count({ where: { projectId, sourceDetail: { endsWith: `:${staleBrowser.requestKey}` } } }) === 1);
  c.ok("no provider request escaped the isolated fake boundary", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(await drill.evidence()); c.summary(); quiet.restore(); await drill.stop(); process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
