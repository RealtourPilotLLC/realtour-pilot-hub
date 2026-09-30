// The same five assignment states must agree across the queue, Home and brief.
import { bootDrillDb, installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();

async function main() {
  const drill = await bootDrillDb({ port: 5584 });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
    const { projectBrief } = await import("@/lib/projectBrief");
    const client = await prisma.client.create({ data: { name: "Assignment Truth Client" }, select: { id: true } });
    const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim@example.invalid" }, select: { id: true } });
    const make = async (name: string, fields: { editorId?: string; editorManual?: boolean; editorVendorKey?: string } = {}) => {
      const p = await prisma.project.create({ data: {
        clientId: client.id, title: `${name} Lane`, status: "EDITING",
        shootDate: new Date(Date.now() - 86_400_000), deliveryDue: new Date(Date.now() + 86_400_000),
        videoInstructions: "Use the provided footage and standard pacing.", videoHandoffAt: new Date(), ...fields,
      }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Standard reel" } });
      return p.id;
    };
    const ids = {
      predicted: await make("Predicted"),
      task: await make("Task"),
      project: await make("Project", { editorId: kim.id, editorManual: true }),
      manual: await make("Manual", { editorManual: true }),
      vendor: await make("Vendor", { editorManual: true, editorVendorKey: "external_agency" }),
    };
    await prisma.smartTask.create({ data: { projectId: ids.task, clientId: client.id, taskType: "edit_video", title: "Task override", assignedKey: "kim" } });
    const queue = await buildEditorQueue();
    const rows = [...queue.notDone, ...queue.upcoming, ...queue.done];
    const row = (id: string) => rows.find((r) => r.id === id);
    c.ok("routing is a suggestion, not a saved dropdown assignment", row(ids.predicted)?.assignmentState === "predicted" && row(ids.predicted)?.editorKey === "john" && row(ids.predicted)?.savedEditorKey === null);
    c.ok("open task overrides routing on the queue", row(ids.task)?.assignmentState === "assigned" && row(ids.task)?.editorKey === "kim");
    c.ok("project editor remains a saved assignment", row(ids.project)?.assignmentState === "assigned" && row(ids.project)?.editorKey === "kim");
    c.ok("manual unassignment stops prediction", row(ids.manual)?.assignmentState === "unassigned" && row(ids.manual)?.editorKey === null);
    c.ok("outside vendor remains assigned outside the in-house queue", row(ids.vendor)?.assignmentState === "assigned" && row(ids.vendor)?.editorKey === "external_agency");
    const home = await opsExceptionsBoard();
    const gap = (id: string) => home.rows.find((r) => r.id === `unassigned:${id}`);
    c.ok("Home explains a routing suggestion instead of claiming an owner", /Routing suggests John Mark/.test(gap(ids.predicted)?.why ?? "") && gap(ids.predicted)?.owner === "Kyle");
    c.ok("Home does not ask to assign a saved task, project editor or vendor", !gap(ids.task) && !gap(ids.project) && !gap(ids.vendor));
    c.ok("Home still lists a deliberate manual unassignment", !!gap(ids.manual));
    const predictedBrief = await projectBrief(ids.predicted);
    const taskBrief = await projectBrief(ids.task);
    c.ok("brief calls prediction an office confirmation, not editor acceptance", predictedBrief?.owner.who === "Kyle" && /Confirm or change/.test(predictedBrief.nextAction), JSON.stringify({ owner: predictedBrief?.owner, nextAction: predictedBrief?.nextAction }));
    c.ok("brief names the task-assigned editor", taskBrief?.owner.who === "Kim" && taskBrief.owner.whose === "editor", JSON.stringify({ owner: taskBrief?.owner, nextAction: taskBrief?.nextAction }));
    c.ok("no provider was called", fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
