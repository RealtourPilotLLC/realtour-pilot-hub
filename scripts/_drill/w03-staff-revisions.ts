// W03: approved-cut staff request and team-chat conversion, isolated PGlite.
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();

const makeForm = (projectId: string, submissionId: string, words: string, sourceMessageId?: string) => {
  const d = new FormData();
  d.set("projectId", projectId); d.set("submissionId", submissionId);
  d.set("requestKey", crypto.randomUUID()); d.set("clientContact", "Sarah Client");
  d.set("confirmedClientWords", "yes"); d.set("originalText", words); d.set("timecode", "1:23");
  if (sourceMessageId) d.set("sourceMessageId", sourceMessageId);
  return d;
};

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5771), env: { AUTH_ENFORCE: "true", APP_SECRET: "w03-isolated-session-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { putSetting } = await import("@/lib/settings");
  const { requestApprovedCutRevision, approvedRevisionTargets } = await import("@/app/review/staffRevisionActions");
  const kyle = await prisma.appUser.create({ data: { name: "Kyle W03", email: "kyle-w03@example.test", role: "ADMIN", status: "ACTIVE" } });
  const owner = await prisma.appUser.create({ data: { name: "Jordan W03", email: "owner-w03@example.test", role: "OWNER", status: "ACTIVE" } });
  const jamesTeam = await prisma.teamMember.create({ data: { name: "James W03", email: "james-w03@example.test", role: "PHOTOGRAPHER" } });
  const james = await prisma.appUser.create({ data: { name: jamesTeam.name, email: jamesTeam.email!, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: jamesTeam.id } });
  const unseated = await prisma.appUser.create({ data: { name: "Other photographer", email: "other-w03@example.test", role: "PHOTOGRAPHER", status: "ACTIVE" } });
  const editor = await prisma.appUser.create({ data: { name: "Kim W03", email: "kim-login-w03@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
  await putSetting("review_room", { creativeApproverTeamMemberId: jamesTeam.id }, owner.email);
  const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
  await as(kyle);
  c.ok("Kyle resolves from a signed session with enforced auth", (await getCurrentUser())?.id === kyle.id && process.env.AUTH_ENFORCE === "true");
  const f = await buildContentMonth(prisma as never, { name: "W03 Request TEST", package: "Starter", videosPerMonth: 2, owner: false, project: { status: "DELIVERED" } });
  const projectId = f.projectId!, deliverableId = f.deliverableId!;
  const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-w03@example.com", role: "EDITOR" } });
  await prisma.project.update({ where: { id: projectId }, data: { editorId: kim.id, editorManual: true } });
  const sentAt = new Date("2026-09-20T14:00:00Z");
  const one = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "intro-v1.mp4", sentToClientAt: sentAt } });
  const two = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 2, status: "APPROVED", source: "upload", fileName: "tour-v2.mp4" } });
  const o1 = await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: one.id, approvedSubmissionId: one.id, deliveredAt: sentAt } });
  const o2 = await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 2, category: "SOCIAL_REEL", currentSubmissionId: two.id, approvedSubmissionId: two.id } });
  const targets = await approvedRevisionTargets(projectId);
  c.ok("two exact approved versions are choices", targets.length === 2 && targets.some((t) => t.submissionId === two.id && t.round === 2));

  const words = "  Please show the backyard at 1:23 and keep the spoken title.  ";
  const form = makeForm(projectId, one.id, words);
  const first = await requestApprovedCutRevision(form);
  const brief = first.briefId ? await prisma.revisionBrief.findUnique({ where: { id: first.briefId } }) : null;
  const issue = first.briefId ? await prisma.revisionIssue.findFirst({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${first.briefId}:` } } }) : null;
  const task = brief?.taskId ? await prisma.smartTask.findUnique({ where: { id: brief.taskId } }) : null;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const { revisionAskerLabel } = await import("@/lib/reviewAttribution");
  c.ok("staff request records original words and exact version", first.ok && brief?.originalText === words && brief.submissionId === one.id && brief.outputId === o1.id && brief.requestedByKind === "CLIENT_STAFF");
  c.ok("issue keeps output, version and timestamp, unclassified cause", issue?.outputId === o1.id && issue.raisedOnSubmissionId === one.id && issue.timeSec === 83 && issue.cause === "UNCLASSIFIED");
  c.ok("task and revision clock are created without changing approved cut", !!task && !!brief?.dueAt && project?.status === "REVISION" && (await prisma.reviewSubmission.findUnique({ where: { id: one.id } }))?.status === "APPROVED");
  c.ok("revision reaches the saved editor without silently starting work", task?.assignedKey === "kim" && await prisma.editorWorkItem.count({ where: { projectId } }) === 0);
  c.ok("delivered-cut request preserves the exact delivery and names the signed staff actor", (await prisma.reviewSubmission.findUnique({ where: { id: one.id } }))?.sentToClientAt?.getTime() === sentAt.getTime() && (await prisma.deliverableOutput.findUnique({ where: { id: o1.id } }))?.deliveredAt?.getTime() === sentAt.getTime() && brief?.requestedByUserId === kyle.id && brief.requestedBy === "Kyle W03 (on behalf of Sarah Client)");
  c.ok("staff attribution does not claim the client portal", !!brief && revisionAskerLabel({ askedAt: project?.revisionRequestedAt ?? null, client: f.clientName, bounces: [], briefs: [{ source: brief.source, createdAt: brief.createdAt, requestedBy: brief.requestedBy, requestedByKind: brief.requestedByKind }] })?.includes("in the Review Room") === true);
  const same = await requestApprovedCutRevision(form);
  c.ok("same request key returns one brief", same.ok && same.briefId === brief?.id && await prisma.revisionBrief.count({ where: { projectId } }) === 1);
  const { startCutUpload } = await import("@/app/review/actions");
  const unrelatedUpload = await startCutUpload({ projectId, deliverableId, slot: 2, fileName: "other-v3.mp4", sizeBytes: 100 });
  const requestedUpload = await startCutUpload({ projectId, deliverableId, slot: 1, fileName: "requested-v2.mp4", sizeBytes: 100 });
  c.ok("unrelated approved video still requires an explicit replacement reason", !unrelatedUpload.ok && unrelatedUpload.needsReason === true);
  c.ok("named approved video passes version gate into self-check", !requestedUpload.ok && requestedUpload.needsSelfCheck === true);

  const msg = await prisma.projectMessage.create({ data: { projectId, authorName: "Kyle", body: "Client said: change the music, leave the title card.\nUse her exact wording." } });
  await as(james);
  c.ok("James's named review seat opens choices on his photographer login", (await approvedRevisionTargets(projectId)).length === 2 && (await getCurrentUser())?.role === "PHOTOGRAPHER");
  const chat = await requestApprovedCutRevision(makeForm(projectId, two.id, "Tampered text", msg.id));
  const chatBrief = chat.briefId ? await prisma.revisionBrief.findUnique({ where: { id: chat.briefId } }) : null;
  c.ok("James's chat conversion re-reads immutable source and pins second video", chat.ok && chatBrief?.originalText === msg.body && chatBrief.outputId === o2.id && chatBrief.submissionId === two.id && chatBrief.requestedByUserId === james.id, chat.message);
  const foreign = await buildContentMonth(prisma as never, { name: "W03 Foreign TEST", project: false, owner: false });
  const other = await prisma.project.create({ data: { clientId: foreign.clientId, title: "Foreign TEST" } });
  const otherMsg = await prisma.projectMessage.create({ data: { projectId: other.id, body: "Wrong client" } });
  c.ok("foreign chat message is refused", !(await requestApprovedCutRevision(makeForm(projectId, two.id, "x", otherMsg.id))).ok);
  await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 3, status: "PENDING", source: "upload" } });
  c.ok("old approved version is refused after a newer cut appears", !(await requestApprovedCutRevision(makeForm(projectId, two.id, "New ask"))).ok);
  const beforeRefusals = await prisma.revisionBrief.count();
  await as(editor);
  c.ok("editor cannot create a staff client request", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok);
  await as(unseated);
  c.ok("an unseated photographer cannot create a staff client request", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok);
  await as(owner, james.id);
  c.ok("owner preview cannot act as James", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok && (await approvedRevisionTargets(projectId).catch(() => [])).length === 0);
  await clearSession();
  c.ok("signed-out request fails without creating a brief", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok && await prisma.revisionBrief.count() === beforeRefusals);
  await as(james);
  await putSetting("review_room", { creativeApproverTeamMemberId: null }, owner.email);
  c.ok("removing James's saved seat revokes the existing signed session immediately", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok && await prisma.revisionBrief.count() === beforeRefusals);

  await as(kyle);
  const parallelForm = makeForm(projectId, one.id, "Please lift the backyard shadows on this delivered cut.");
  const parallelKey = String(parallelForm.get("requestKey"));
  if (drill.engine === "postgres") {
    // The disposable database holds the winning insert briefly so Postgres
    // can report a real competing transaction waiting on the request lock.
    await drill.sql('CREATE FUNCTION w03_delay_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END; $$');
    await drill.sql('CREATE TRIGGER w03_delay_insert BEFORE INSERT ON "RevisionBrief" FOR EACH ROW EXECUTE FUNCTION w03_delay_insert()');
  }
  const waitsBefore = drill.lockWaits();
  const raced = await drill.backendsDuring(() => Promise.all([requestApprovedCutRevision(parallelForm), requestApprovedCutRevision(parallelForm)]));
  const parallel = raced.result;
  if (drill.engine === "postgres") {
    await drill.sql('DROP TRIGGER w03_delay_insert ON "RevisionBrief"');
    await drill.sql('DROP FUNCTION w03_delay_insert()');
    c.ok("Postgres observed competing request transactions and an actual lock wait", raced.distinctBackends >= 2 && drill.lockWaits() > waitsBefore, `${raced.distinctBackends} backends; ${drill.lockWaits() - waitsBefore} waits`);
  }
  const parallelBriefs = await prisma.revisionBrief.findMany({ where: { projectId, source: "review_room_staff", sourceDetail: `staff-cut:${one.id}:${parallelKey}` } });
  c.ok("concurrent identical submits return one exact-cut brief", parallel.every((r) => r.ok) && parallel[0].briefId === parallel[1].briefId && parallelBriefs.length === 1, JSON.stringify({ results: parallel, briefs: parallelBriefs.length }));
  const parallelIssues = await prisma.revisionIssue.findMany({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${parallelBriefs[0]?.id}:` } } });
  c.ok("concurrent receipt preserves exact words, actor, cut and one timed issue", parallelBriefs[0]?.originalText === parallelForm.get("originalText") && parallelBriefs[0]?.requestedByUserId === kyle.id && parallelBriefs[0]?.submissionId === one.id && parallelBriefs[0]?.outputId === o1.id && parallelIssues.length === 1 && parallelIssues[0].timeSec === 83 && parallelIssues[0].raisedOnSubmissionId === one.id);
  c.ok("concurrent same-cut submit keeps one revision task", await prisma.smartTask.count({ where: { projectId, taskType: "revision" } }) === 1);
  const { createRevisionBrief } = await import("@/lib/revisionBrief");
  const thread = { projectId, source: "gmail", sourceDetail: "same-email-thread" };
  const firstEmail = await createRevisionBrief({ ...thread, text: "Brighten the kitchen." });
  const secondEmail = await createRevisionBrief({ ...thread, text: "Also remove the opening shot." });
  c.ok("separate email asks on one thread still keep separate briefs", !!firstEmail && !!secondEmail && firstEmail !== secondEmail);
  c.ok("no external provider request escaped the fixture", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(await drill.evidence());
  c.summary(); quiet.restore(); await drill.stop(); process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
