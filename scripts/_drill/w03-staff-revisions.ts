// W03: approved-cut staff request and team-chat conversion, isolated PGlite.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

type Viewer = { id: string; email: string; name: string; role: string; permissions: null; status: string; teamMemberId: null; editorKey: string | null; notificationsSeenAt: null; impersonating: boolean; realRole: string; realName: string };
let viewer: Viewer = { id: "kyle", email: "kyle@example.com", name: "Kyle", role: "ADMIN", permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: "ADMIN", realName: "Kyle" };
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => viewer : t[k]; } }),
);
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
  const { stop } = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5771), env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { requestApprovedCutRevision, approvedRevisionTargets } = await import("@/app/review/staffRevisionActions");
  const f = await buildContentMonth(prisma as never, { name: "W03 Request TEST", package: "Starter", videosPerMonth: 2, owner: false, project: { status: "DELIVERED" } });
  const projectId = f.projectId!, deliverableId = f.deliverableId!;
  const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-w03@example.com", role: "EDITOR" } });
  await prisma.project.update({ where: { id: projectId }, data: { editorId: kim.id } });
  const one = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "intro-v1.mp4" } });
  const two = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 2, status: "APPROVED", source: "upload", fileName: "tour-v2.mp4" } });
  const o1 = await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: one.id, approvedSubmissionId: one.id } });
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
  c.ok("staff attribution does not claim the client portal", !!brief && revisionAskerLabel({ askedAt: project?.revisionRequestedAt ?? null, client: f.clientName, bounces: [], briefs: [{ source: brief.source, createdAt: brief.createdAt, requestedBy: brief.requestedBy, requestedByKind: brief.requestedByKind }] })?.includes("in the Review Room") === true);
  const same = await requestApprovedCutRevision(form);
  c.ok("same request key returns one brief", same.ok && same.briefId === brief?.id && await prisma.revisionBrief.count({ where: { projectId } }) === 1);
  const { startCutUpload } = await import("@/app/review/actions");
  const unrelatedUpload = await startCutUpload({ projectId, deliverableId, slot: 2, fileName: "other-v3.mp4", sizeBytes: 100 });
  const requestedUpload = await startCutUpload({ projectId, deliverableId, slot: 1, fileName: "requested-v2.mp4", sizeBytes: 100 });
  c.ok("unrelated approved video still requires an explicit replacement reason", !unrelatedUpload.ok && unrelatedUpload.needsReason === true);
  c.ok("named approved video passes version gate into self-check", !requestedUpload.ok && requestedUpload.needsSelfCheck === true);

  const msg = await prisma.projectMessage.create({ data: { projectId, authorName: "Kyle", body: "Client said: change the music, leave the title card.\nUse her exact wording." } });
  const chat = await requestApprovedCutRevision(makeForm(projectId, two.id, "Tampered text", msg.id));
  const chatBrief = chat.briefId ? await prisma.revisionBrief.findUnique({ where: { id: chat.briefId } }) : null;
  c.ok("chat conversion re-reads immutable source and pins second video", chat.ok && chatBrief?.originalText === msg.body && chatBrief.outputId === o2.id && chatBrief.submissionId === two.id);
  const foreign = await buildContentMonth(prisma as never, { name: "W03 Foreign TEST", project: false, owner: false });
  const other = await prisma.project.create({ data: { clientId: foreign.clientId, title: "Foreign TEST" } });
  const otherMsg = await prisma.projectMessage.create({ data: { projectId: other.id, body: "Wrong client" } });
  c.ok("foreign chat message is refused", !(await requestApprovedCutRevision(makeForm(projectId, two.id, "x", otherMsg.id))).ok);
  await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 3, status: "PENDING", source: "upload" } });
  c.ok("old approved version is refused after a newer cut appears", !(await requestApprovedCutRevision(makeForm(projectId, two.id, "New ask"))).ok);
  viewer = { ...viewer, id: "editor", name: "Editor", realName: "Editor", role: "EDITOR", realRole: "EDITOR", editorKey: "kim" };
  c.ok("editor cannot create a staff client request", !(await requestApprovedCutRevision(makeForm(projectId, one.id, "New ask"))).ok);
  c.ok("no external provider request escaped the fixture", fence.blocked.every((u) => !u.includes("realtourpilot.com")), fence.blocked.join(", "));
  c.summary(); quiet.restore(); await stop(); process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
