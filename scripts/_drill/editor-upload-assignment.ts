// @drill-run: engine=postgres needs=tools/realpg timeout=180
// Real signed server actions and callback races. Disposable Postgres only;
// byte-store calls are declared fakes, all other outbound traffic is fenced.
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, portFree } from "./_harness";
installNextStubs();
const deleted: string[] = [];
async function main() {
  if (!await portFree(5994)) throw new Error("Fixture port busy; existing process preserved.");
  const db = await bootDrillDb({ port: 5994, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-upload-assignment", BLOB_READ_WRITE_TOKEN: ["vercel", "blob", "rw", "drillstore", "fixture"].join("_") } });
  const fence = fenceFetch(), c = makeChecker();
  const undici = createRequire(import.meta.url)("undici") as typeof import("undici");
  const dispatcher = undici.getGlobalDispatcher(), mock = new undici.MockAgent();
  mock.disableNetConnect();
  mock.get("https://vercel.com").intercept({ path: /\/api\/blob\/?\?/, method: "GET" }).reply(200, (opts) => {
    const url = new URL(opts.path, "https://vercel.com").searchParams.get("url")!;
    return JSON.stringify({ url, pathname: new URL(url).pathname.slice(1), size: 77, uploadedAt: new Date().toISOString(), contentType: "video/mp4" });
  }).persist();
  mock.get("https://vercel.com").intercept({ path: "/api/blob/delete", method: "POST" }).reply(200, (opts) => {
    deleted.push(...JSON.parse(String(opts.body)).urls); return "{}";
  }).persist();
  undici.setGlobalDispatcher(mock);
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/review/actions");
    const rc = await import("@/lib/reviewCuts");
    const sc = await import("@/lib/selfCheck");
    const scs = await import("@/lib/selfCheckStore");
    const { submitSelfCheck } = await import("@/app/review/selfCheckActions");
    const { saveCutMessage } = await import("@/components/editing/cutMessage.actions");
    const client = await prisma.client.create({ data: { name: "Isolated upload client" } });
    const kimMember = await prisma.teamMember.create({ data: { name: "Kim Miguel", role: "EDITOR", email: "kim-upload@example.test" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim Miguel", email: "kim-upload@example.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimMember.id } });
    const john = await prisma.appUser.create({ data: { name: "John Mark", email: "john-upload@example.test", role: "EDITOR", status: "ACTIVE", editorKey: "john" } });
    const unmapped = await prisma.appUser.create({ data: { name: "Kim Miguel", email: "unmapped-upload@example.test", role: "EDITOR", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { name: "Upload owner", email: "owner-upload@example.test", role: "OWNER", status: "ACTIVE" } });
    const signIn = (u: typeof kim) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    const job = async (title: string, manual = true, quantity = 4) => {
      const p = await prisma.project.create({ data: { title, clientId: client.id, status: "EDITING", editorId: kimMember.id, editorManual: manual, videosOwedOverride: quantity } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Personal Branding Reel", videoStyle: "personal_branding", quantity } });
      return { projectId: p.id, deliverableId: d.id };
    };
    const check = async (j: Awaited<ReturnType<typeof job>>, slot = 1) => {
      const ctx = await scs.checkContextForSlot(j.projectId, { deliverableId: j.deliverableId, slot }, { round: 1 });
      return { checklistKey: ctx.profile.checklistKey, answers: Object.fromEntries(sc.itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map(i => i.id) }).map(i => [i.key, { answer: "YES" as const }])), issues: { addressed: ctx.issues.map(i => i.id), notAddressed: {} }, watchedFile: { name: "fixture.mp4", size: 77 } };
    };
    const start = async (j: Awaited<ReturnType<typeof job>>, slot = 1) => actions.startCutUpload({ ...j, slot, fileName: "fixture.mp4", sizeBytes: 77, width: 1080, height: 1920, selfCheck: await check(j, slot) });
    const reserve = async (j: Awaited<ReturnType<typeof job>>, slot = 1) => { const r = await start(j, slot); if (!r.ok) throw new Error(r.message); return r; };
    const blob = (j: Awaited<ReturnType<typeof job>>, id: string) => { const pathname = `review-cuts/${j.projectId}/${id}/fixture-Ab12Cd.mp4`; return { url: `https://drillstore.public.blob.vercel-storage.com/${pathname}`, pathname, size: 77 }; };
    const saved = await job("Newburg manual Kim no task"), automatic = await job("Routing prediction only", false), unassigned = await job("Explicit task unassignment"), reassigned = await job("Task reassigned to John");
    await prisma.smartTask.create({ data: { projectId: unassigned.projectId, taskType: "edit_video", title: "Explicitly unassigned", assignedManually: true } });
    await prisma.smartTask.create({ data: { projectId: reassigned.projectId, taskType: "edit_video", title: "John now holds it", assignedKey: "john", assignedManually: true } });
    await signIn(kim);
    const first = await reserve(saved), bytes = blob(saved, first.submissionId);
    c.ok("manual Kim assignment without a task actually reserves the checked video", !!first.submissionId && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.submissionId } })).submittedByKey === "kim");
    c.ok("reservation does not fabricate a task or manual Start", await prisma.smartTask.count({ where: { projectId: saved.projectId } }) === 0 && await prisma.editorWorkEvent.count() === 0);
    c.ok("automatic routing cannot reserve a cut", !(await start(automatic)).ok);
    c.ok("explicit unassignment overrides old project Kim", !(await start(unassigned)).ok);
    c.ok("reassignment overrides old project Kim", !(await start(reassigned)).ok);
    await signIn(john);
    c.ok("unassigned second editor cannot upload on Kim's project", !(await start(saved, 2)).ok);
    c.ok("other editor cannot finish Kim's exact reservation", !(await actions.finishCutUpload({ submissionId: first.submissionId, ...bytes })).ok);
    const shared = await job("Shared task still cannot hijack Kim's reserved bytes");
    await signIn(kim);
    const sharedReservation = await reserve(shared), sharedBytes = blob(shared, sharedReservation.submissionId);
    await prisma.smartTask.create({ data: { projectId: shared.projectId, taskType: "edit_video", title: "Reassigned to John", assignedKey: "john", assignedManually: true } });
    await signIn(john);
    c.ok("new task holder cannot finish another editor's reservation", !(await actions.finishCutUpload({ submissionId: sharedReservation.submissionId, ...sharedBytes })).ok);
    await actions.abandonCutUpload(sharedReservation.submissionId, sharedBytes.url);
    c.ok("new task holder cannot cancel another editor's reservation", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sharedReservation.submissionId } })).status === "UPLOADING" && !deleted.includes(sharedBytes.url));
    await signIn(unmapped);
    c.ok("a matching free-text name never grants editor ownership", !(await start(saved, 2)).ok);
    await clearSession();
    c.ok("anonymous upload is refused", !(await start(saved, 2)).ok);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kim.id });
    c.ok("owner preview remains read-only", !(await start(saved, 2)).ok);
    await signIn(kim);
    const finished = await actions.finishCutUpload({ submissionId: first.submissionId, ...bytes });
    c.ok("actual finish files the reserved checked version", finished.ok && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.submissionId } })).status === "PENDING", finished.message);
    c.ok("assigned editor can save review context after hand-in", (await saveCutMessage(first.submissionId, "Use the corrected intro.")).ok);
    const ownAfterCallback = await job("Callback closes one-video task", false, 1);
    await prisma.smartTask.create({ data: { projectId: ownAfterCallback.projectId, taskType: "edit_video", title: "Kim task", assignedKey: "kim", assignedManually: true } });
    const callback = await reserve(ownAfterCallback), callbackBytes = blob(ownAfterCallback, callback.submissionId);
    const callbackResult = await rc.finalizeCutUpload(callback.submissionId, callbackBytes);
    c.ok("callback really closes the one-video task", (await prisma.smartTask.findFirstOrThrow({ where: { projectId: ownAfterCallback.projectId, taskType: "edit_video" } })).status === "COMPLETED", JSON.stringify({ callbackResult, owed: (await rc.cutSlots(ownAfterCallback.projectId)).length }));
    c.ok("browser finish still confirms its own reservation after callback closes task", (await actions.finishCutUpload({ submissionId: callback.submissionId, ...callbackBytes })).ok);
    const racing = await reserve(saved, 2), raceBytes = blob(saved, racing.submissionId);
    const realUpdate = prisma.reviewSubmission.updateMany.bind(prisma.reviewSubmission);
    let racingOnce = true;
    prisma.reviewSubmission.updateMany = (async (args: Parameters<typeof realUpdate>[0]) => {
      if (racingOnce && args.where?.id === racing.submissionId && args.data.status === "UPLOAD_FAILED") { racingOnce = false; await rc.finalizeCutUpload(racing.submissionId, raceBytes); }
      return realUpdate(args);
    }) as unknown as typeof prisma.reviewSubmission.updateMany;
    try { await actions.abandonCutUpload(racing.submissionId, raceBytes.url); } finally { prisma.reviewSubmission.updateMany = realUpdate; }
    c.ok("lost finish response/callback race retains the committed cut and bytes", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: racing.submissionId } })).blobUrl === raceBytes.url && !deleted.includes(raceBytes.url));
    await actions.abandonCutUpload(first.submissionId, bytes.url);
    c.ok("abandon replay never deletes an already filed cut", !deleted.includes(bytes.url));
    const cancel = await reserve(saved, 3), cancelBytes = blob(saved, cancel.submissionId);
    await actions.abandonCutUpload(cancel.submissionId, cancelBytes.url);
    c.ok("real cancellation claims only the pending reservation and releases its own bytes", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cancel.submissionId } })).status === "UPLOAD_FAILED" && deleted.includes(cancelBytes.url));
    c.ok("cancelled reservation cannot falsely answer Already in review", !(await actions.finishCutUpload({ submissionId: cancel.submissionId, ...cancelBytes })).ok);
    c.ok("late store callback never resurrects a cancelled version", !(await rc.finalizeCutUpload(cancel.submissionId, cancelBytes)).ok && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cancel.submissionId } })).status === "UPLOAD_FAILED");
    const foreign = await reserve(saved, 3);
    await actions.abandonCutUpload(foreign.submissionId, bytes.url);
    c.ok("an abandoned reservation cannot delete another cut's object", !deleted.includes(bytes.url));
    const databaseFailure = await reserve(saved, 3), databaseFailureBytes = blob(saved, databaseFailure.submissionId);
    prisma.reviewSubmission.updateMany = (async (args: Parameters<typeof realUpdate>[0]) => {
      if (args.where?.id === databaseFailure.submissionId && args.data.status === "UPLOAD_FAILED") throw new Error("Declared failed cleanup transaction");
      return realUpdate(args);
    }) as unknown as typeof prisma.reviewSubmission.updateMany;
    try { await actions.abandonCutUpload(databaseFailure.submissionId, databaseFailureBytes.url).catch(() => {}); } finally { prisma.reviewSubmission.updateMany = realUpdate; }
    c.ok("failed cleanup transaction never deletes an unclaimed reservation's bytes", !deleted.includes(databaseFailureBytes.url) && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: databaseFailure.submissionId } })).status === "UPLOADING");
    const held = await prisma.reviewSubmission.create({ data: { projectId: saved.projectId, deliverableId: saved.deliverableId, slot: 4, round: 1, status: "PENDING", source: "upload", fileName: "fixture.mp4", sizeBytes: 77, blobUrl: blob(saved, "unclaimed-held").url } });
    await scs.holdForSelfCheck(held.id, "Declared unclaimed held upload");
    const attested = await submitSelfCheck(held.id, await check(saved, 4));
    c.ok("assigned Kim can attest an unclaimed held upload without an open task", attested.ok && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: held.id } })).selfCheckedAt, attested.message);
    c.ok("upload actions never fabricate Start or call external providers", await prisma.editorWorkEvent.count({ where: { kind: "START" } }) === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { undici.setGlobalDispatcher(dispatcher); await mock.close(); fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch(e => { console.error(e); process.exit(1); });
