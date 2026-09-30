// Isolated two-editor brand acknowledgment and attributed office override.
import { bootDrillDb, installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();

async function main() {
  const drill = await bootDrillDb({ port: 5583 });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const brand = await import("@/lib/brandProfile");
    const client = await prisma.client.create({ data: { name: "Two Editor Client" }, select: { id: true } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "Two Editor Project", status: "EDITING" }, select: { id: true } });
    const kimTask = await prisma.smartTask.create({ data: { clientId: client.id, projectId: project.id, taskType: "edit_video", title: "Kim edit", assignedKey: "kim" }, select: { id: true } });
    await prisma.smartTask.create({ data: { clientId: client.id, projectId: project.id, taskType: "edit_video", title: "John edit", assignedKey: "john" } });
    const change = async (value: string) => brand.recordBrandChange({ clientId: client.id, fieldKey: "brandColors", label: "Brand colors", kind: "SET", toText: value, source: "staff" });

    const firstId = await change("#123456");
    await brand.alertBrandChanges(client.id);
    const first = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: firstId }, include: { receipts: true } });
    c.ok("change/version has one required receipt for each assigned editor", first.receipts.length === 2 && first.receipts.some((r) => r.editorKey === "kim") && first.receipts.some((r) => r.editorKey === "john"));
    c.ok("both editors see the same unresolved change", (await brand.pendingBrandChanges(client.id, { editorKey: "kim" })).length === 1 && (await brand.pendingBrandChanges(client.id, { editorKey: "john" })).length === 1);
    const taskId = first.taskId!;

    const kim = await brand.acknowledgeBrandChanges(client.id, "kim");
    const middle = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: firstId }, include: { receipts: true } });
    const taskMiddle = await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } });
    c.ok("Kim's receipt leaves John's receipt pending and the change unresolved", kim.acked === 1 && !middle.ackAt && !!middle.receipts.find((r) => r.editorKey === "kim")?.ackAt && !middle.receipts.find((r) => r.editorKey === "john")?.ackAt);
    c.ok("Kyle's task remains open and names the remaining editor", taskMiddle.status === "OPEN" && /john/i.test(taskMiddle.summary ?? ""));
    const { setSmartTaskStatus } = await import("@/app/actions");
    const premature = await setSmartTaskStatus(taskId, "COMPLETED");
    c.ok("generic task completion cannot bypass the receipt/override rule", premature?.ok === false && (await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } })).status === "OPEN");
    c.ok("Kim's banner clears while John's remains", (await brand.pendingBrandChanges(client.id, { editorKey: "kim" })).length === 0 && (await brand.pendingBrandChanges(client.id, { editorKey: "john" })).length === 1);

    const john = await brand.acknowledgeBrandChanges(client.id, "john");
    c.ok("John's receipt settles the change and closes the task", john.acked === 1 && john.tasksClosed === 1 && !!(await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: firstId } })).ackAt && (await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } })).status === "COMPLETED");

    const secondId = await change("#654321");
    await brand.alertBrandChanges(client.id);
    const second = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: secondId }, include: { receipts: true } });
    c.ok("a newer value keeps a distinct change/version and new task", second.receipts.length === 2 && second.taskId !== taskId && !second.ackAt);
    const office = await brand.overrideBrandChanges(client.id, "Kyle", "John was reassigned; current brand kit was reviewed with Kim.");
    const overridden = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: secondId }, include: { receipts: true } });
    c.ok("office override is attributed with a reason, never an editor click", office.overridden === 2 && office.tasksClosed === 1 && overridden.receipts.every((r) => !r.ackAt && r.overrideBy === "Kyle" && /reassigned/.test(r.overrideReason ?? "")) && /office override by Kyle/.test(overridden.ackBy ?? ""));

    const thirdId = await change("#abcdef");
    await brand.alertBrandChanges(client.id);
    await prisma.smartTask.update({ where: { id: kimTask.id }, data: { assignedKey: "john" } });
    const third = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: thirdId } });
    c.ok("reassignment never erases the recipients on an existing change", (await prisma.clientBrandReceipt.count({ where: { changeId: thirdId } })) === 2 && !third.ackAt);
    c.ok("a repeat acknowledgment is idempotent", (await brand.acknowledgeBrandChanges(client.id, "john")).acked === 1 && (await brand.acknowledgeBrandChanges(client.id, "john")).acked === 0);
    c.ok("no provider was called", fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
