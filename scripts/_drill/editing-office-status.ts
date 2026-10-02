// @drill-run: engine=postgres needs=tools/realpg timeout=180
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, portFree } from "./_harness";
import { EDIT_STATUS_LABELS } from "../../src/lib/editOverrideDefaults";
installNextStubs();

async function main() {
  if (!(await portFree(5993))) throw new Error("Fixture port 5993 busy; existing process untouched");
  const db = await bootDrillDb({ port: 5993, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-office-status" } });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { setQueueStatus } = await import("@/app/editing/actions");
    const { holdersFor, startEditing, pauseEditing } = await import("@/lib/editorWork");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const client = await prisma.client.create({ data: { name: "Isolated status client" } });
    const member = await prisma.teamMember.create({ data: { name: "Kim Miguel", role: "EDITOR", email: "kim-status@example.test" } });
    await prisma.teamMember.create({ data: { name: "John Mark", role: "EDITOR", email: "john-status@example.test" } });
    const owner = await prisma.appUser.create({ data: { name: "Status Owner", email: "owner-status@example.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Status Admin", email: "admin-status@example.test", role: "ADMIN", status: "ACTIVE" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim Miguel", email: "kim-status@example.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: member.id } });
    const signIn = (u: typeof owner) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    const project = (title: string, assigned = true) => prisma.project.create({ data: {
      title, clientId: client.id, status: "SHOT", shootDate: new Date(), editorId: assigned ? member.id : null, editorManual: assigned,
      deliverables: { create: { type: "VIDEO", label: "Standard cinematic", quantity: 1 } },
      statusEvidence: JSON.stringify({ dropbox: { rawVideo: 2, finalVideo: 0 }, missing: ["Video"] }),
    } });
    const saved = await project("Saved Kim without task");
    const routed = await project("Routing suggestion only", false);
    const automatic = await project("Automatic project routing without handoff");
    await prisma.project.update({ where: { id: automatic.id }, data: { editorManual: false } });
    const unassigned = await project("Explicit task unassignment");
    await prisma.smartTask.create({ data: { projectId: unassigned.id, taskType: "edit_video", title: "Unassigned", assignedKey: null, assignedManually: true } });
    const other = await project("Task reassigned to John");
    await prisma.smartTask.create({ data: { projectId: other.id, taskType: "edit_video", title: "John holds task", assignedKey: "john", assignedManually: true } });
    const holders = await holdersFor([saved.id, routed.id, automatic.id, unassigned.id, other.id]);
    c.ok("saved project Kim is a real holder without a task", holders.get(saved.id)?.has("kim") === true);
    c.ok("routing suggestion never grants Start ownership", !holders.has(routed.id));
    c.ok("automatic project routing still requires a real handoff", !holders.has(automatic.id));
    c.ok("explicit task unassignment overrides saved project Kim", !holders.has(unassigned.id));
    c.ok("task reassignment overrides old project Kim", holders.get(other.id)?.has("john") === true && !holders.get(other.id)?.has("kim"));
    await signIn(kim);
    c.ok("Kim can actually Start the saved project assignment", (await startEditing({ projectId: saved.id, requestId: "saved-kim-start" })).ok);
    c.ok("editor Start still records its own real actor", (await prisma.editorWorkEvent.findFirstOrThrow({ where: { projectId: saved.id, kind: "START" } })).actorName === "Kim Miguel");
    c.ok("Kim can Pause that real Start", (await pauseEditing({ projectId: saved.id, requestId: "saved-kim-pause" })).ok);
    const eventsBefore = await prisma.editorWorkEvent.count();
    const mapped = { Waiting: "SCHEDULED", "Ready for editing": "SHOT", "In editing": "EDITING", "Ready for review": "REVIEW", Revisions: "REVISION", Completed: "DELIVERED" };
    await signIn(owner);
    for (const label of EDIT_STATUS_LABELS) {
      const job = await project(`Owner can set ${label}`, false);
      const cut = await prisma.reviewSubmission.create({ data: { projectId: job.id, kind: "video", slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "isolated.mp4" } });
      const result = await setQueueStatus(job.id, label, `office-${label}`, true, "Ready for review");
      const after = await prisma.project.findUniqueOrThrow({ where: { id: job.id } });
      c.ok(`owner changes ${label} without assignment/file gates`, result.ok && after.status === mapped[label] && !!after.statusPinnedAt, result.message);
      c.ok(`${label} preserves exact cut decision and delivery evidence`, (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } })).status === "PENDING" && await prisma.auditLog.count({ where: { target: cut.id, action: { in: ["video_uploaded", "video_sent"] } } }) === 0);
      c.ok(`${label} records owner attribution`, after.overrideBy === "Status Owner" && await prisma.activity.count({ where: { projectId: job.id, body: { contains: "Override by Status Owner" } } }) === 1);
      c.ok(`${label} replay does not duplicate its override history`, (await setQueueStatus(job.id, label, `office-${label}`, true)).ok && await prisma.activity.count({ where: { projectId: job.id, body: { contains: "Override by Status Owner" } } }) === 1);
    }
    c.ok("office stage changes never invent Start/Pause events", await prisma.editorWorkEvent.count() === eventsBefore);
    const queue = await buildEditorQueue();
    const rows = [...queue.notDone, ...queue.upcoming, ...queue.done];
    c.ok("stage-only In editing remains explicitly unconfirmed", rows.find((r) => r.street === "Owner can set In editing")?.status === "In editing — not confirmed");
    c.ok("saved assignment displayed and Start permission agree", rows.find((r) => r.id === saved.id)?.savedEditorKey === "kim" && rows.find((r) => r.id === saved.id)?.startableBy?.includes("kim") === true);
    await signIn(kim);
    c.ok("editor cannot forge an office override", !(await setQueueStatus(saved.id, "Completed", "forged", true)).ok && (await prisma.project.findUniqueOrThrow({ where: { id: saved.id } })).status !== "DELIVERED");
    await clearSession();
    c.ok("anonymous status override fails closed", !(await setQueueStatus(saved.id, "Completed", "anonymous", true)).ok);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kim.id });
    c.ok("owner preview remains read-only even with override intent", !(await setQueueStatus(saved.id, "Completed", "preview", true)).ok);
    await signIn(admin);
    c.ok("existing admin override permission is retained", (await setQueueStatus(routed.id, "In editing", "admin-stage", true)).ok);
    c.ok("Pause cannot be fabricated as a stage", !(await setQueueStatus(routed.id, "Paused", "fake-pause", true)).ok);
    c.ok("no provider or client send calls", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
