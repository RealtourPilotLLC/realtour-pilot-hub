// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Signed real Board SSR + durable output/context and source-read boundaries.
// No domain mutation action, message send or provider call is invoked.
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { taskRowAction } from "../../src/lib/taskRowPresentation";
import type { QueueTask } from "../../src/components/queue/TaskCard";

function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const own = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...own, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5893), env: { AUTH_ENFORCE: "true" } });
  installNextStubs();
  const fence = fenceFetch();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  try {
    const { BoardView } = await import("@/components/tasks/BoardView");
    const { TaskCard } = await import("@/components/queue/TaskCard");
    const { TaskCompactRow } = await import("@/components/queue/TaskCompactRow");
    const { TaskFullView } = await import("@/components/queue/TaskFullView");
    const { ModalDialog } = await import("@/components/ui/ModalDialog");
    const { getTaskConversation } = await import("@/app/queue/fullViewActions");
    const { setSession } = await import("@/lib/auth/session");
    const owner = await prisma.appUser.create({ data: { email: "row-owner@fixture.invalid", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "row-admin@fixture.invalid", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "row-editor@fixture.invalid", role: "EDITOR", editorKey: "kim", status: "ACTIVE", permissions: JSON.stringify({ tasks: true }) } });
    const client = await prisma.client.create({ data: { name: "Fixture task client", generalNotes: "Client context $640" } });
    const job = await prisma.project.create({ data: { title: "123 Bound Property", clientId: client.id, status: "EDITING" } });
    const otherJob = await prisma.project.create({ data: { title: "456 Other Property", clientId: client.id, status: "EDITING" } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: job.id, type: "VIDEO" } });
    const otherDeliverable = await prisma.deliverable.create({ data: { projectId: otherJob.id, type: "VIDEO" } });
    const output = await prisma.deliverableOutput.create({ data: { projectId: job.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO" } });
    const otherOutput = await prisma.deliverableOutput.create({ data: { projectId: otherJob.id, deliverableId: otherDeliverable.id, slot: 1, category: "VIDEO" } });
    const removedOutput = await prisma.deliverableOutput.create({ data: { projectId: job.id, deliverableId: deliverable.id, slot: 2, category: "VIDEO", removedFromOrderAt: new Date() } });
    const task = (title: string, options: { taskType?: string; assignedKey?: string; outputId?: string; status?: string } = {}) => prisma.smartTask.create({ data: {
      title, taskType: "todo", source: "manual", clientId: client.id, projectId: job.id, propertyAddress: "123 Bound Property", summary: "Exact summary $320", description: "Full source request mentions 456 Other Property but is bound to 123 Bound Property; $480 remains owner-only.",
      reasonCreated: "A person requested this work", dueAt: new Date("2026-10-03T16:00:00.000Z"), checklist: JSON.stringify([{ label: "Evidence step $75", done: true }, { label: "Next step", done: false }]), ...options,
    } });
    const unassigned = await task("Unassigned owner decision");
    const routine = await task("Routine defaults to Kyle", { taskType: "appointment_prep" });
    const revision = await task("Bound output revision $500", { taskType: "revision", assignedKey: "kyle", outputId: output.id });
    const badRevision = await task("Mismatched output stays in context", { taskType: "revision", assignedKey: "kyle", outputId: otherOutput.id });
    const removedRevision = await task("Removed output stays in context", { taskType: "revision", assignedKey: "kyle", outputId: removedOutput.id });
    const edit = await task("Kim exact edit", { taskType: "edit_video", assignedKey: "kim" });
    await task("Other editor invisible", { taskType: "edit_video", assignedKey: "remar" });
    const comm = await prisma.commLog.create({ data: { clientId: client.id, projectId: job.id, channel: "text", body: "Context source $910", source: "manual", occurredAt: new Date(), contactName: "Fixture sender" } });
    const snapshot = async () => JSON.stringify(await Promise.all([prisma.smartTask.findMany({ orderBy: { id: "asc" } }), prisma.commLog.findMany(), prisma.deliverableOutput.findMany(), prisma.editorWorkItem.findMany(), prisma.outboxMessage.findMany(), prisma.auditLog.findMany()]));
    const before = await snapshot();
    const signIn = (user: typeof owner) => setSession({ uid: user.id, email: user.email, role: user.role, permissions: user.permissions });
    const board = (sp: { who?: string; task?: string; source?: string; type?: string } = { who: "all" }) => BoardView({ sp, tabs: null });
    const rowsOf = (tree: unknown) => elements(tree, "GroupCard").flatMap((group) => group.items as QueueTask[]);
    await signIn(owner);
    const tree = await board();
    const rows = rowsOf(tree);
    const body = renderToStaticMarkup(tree);
    const rowHtml = [...body.matchAll(/<article\b[^>]*data-task-row[^>]*>[\s\S]*?<\/article>/g)].map((match) => match[0]);
    c.ok("real board renders one compact row per existing scoped task", rowHtml.length === rows.length && rows.length === 5);
    c.ok("all row anchors remain unique for old task and sibling links", rows.every((row) => (body.match(new RegExp(`id="task-${row.id}"`, "g")) ?? []).length === 1));
    c.ok("rows lead with work actions without an immediate Complete or Send action", rowHtml.every((row) => !/>Complete<|>Send<|>Send email<|>Reopen</.test(row)));
    c.ok("unassigned work leads with Assign while Kyle's routine retains Kyle", !!rowHtml.find((row) => row.includes(unassigned.id))?.includes(">Assign</button>") && !!rowHtml.find((row) => row.includes(routine.id))?.includes('value="kyle" selected'));
    c.ok("stored project/address remains primary despite another street in source text", rows.every((row) => row.projectId === job.id && row.propertyAddress === "123 Bound Property") && rowHtml.every((row) => !row.includes("456 Other Property")));
    c.ok("same-project active output gets its own brief route", rows.find((row) => row.id === revision.id)?.outputId === output.id && body.includes(`href="/edit/${job.id}#brief-${output.id}"`));
    c.ok("cross-project and removed output pointers never become promoted links", rows.find((row) => row.id === badRevision.id)?.outputId === null && rows.find((row) => row.id === removedRevision.id)?.outputId === null && !body.includes(`#brief-${otherOutput.id}`) && !body.includes(`#brief-${removedOutput.id}`));
    c.ok("owner keeps complete price-bearing source/checklist context inside retained card", body.includes("$500") && body.includes("$480") && body.includes("$75") && body.includes("Full source request"));
    c.ok("closed drawers retain the full TaskCard subtree without opening native dialog in SSR", (body.match(/<dialog\b/g) ?? []).length === rows.length && !/<dialog[^>]*\sopen(?:[\s=>])/.test(body) && body.includes("Full view") && body.includes("A person requested this work"));
    c.ok("row owner and action controls have 44px targets and names", rowHtml.every((row) => row.includes("min-h-11") && row.includes('aria-label="Owner for ')));
    const linked = await board({ task: revision.id, who: "all" });
    c.ok("legacy task query is passed only to the matching drawer via grouped row props", elements(linked, "GroupCard").every((group) => group.focusTaskId === revision.id) && rowsOf(linked).some((row) => row.id === revision.id));
    const filtered = rowsOf(await board({ who: "kyle", source: "manual", type: "revision" }));
    c.ok("named owner/source/type filters keep their existing exact subset", filtered.length === 3 && [revision, badRevision, removedRevision].every((task) => filtered.some((row) => row.id === task.id)));
    const originalOutputs = prisma.deliverableOutput.findMany;
    prisma.deliverableOutput.findMany = (async () => { throw new Error("fixture output read failed"); }) as unknown as typeof originalOutputs;
    try { c.ok("output-read failure preserves task context instead of inventing an output", rowsOf(await board()).length === 5 && rowsOf(await board()).every((row) => row.outputId === null)); }
    finally { prisma.deliverableOutput.findMany = originalOutputs; }
    await signIn(admin);
    const adminBody = renderToStaticMarkup(await board());
    c.ok("ADMIN money scrubbing covers both compact rows and mounted detail cards", ["$500", "$480", "$320", "$75"].every((money) => !adminBody.includes(money)) && adminBody.includes("Full source request"));
    const adminContext = await getTaskConversation(revision.id);
    c.ok("explicit source-context read retains the existing non-owner money boundary", adminContext.ok && adminContext.conversation?.length === 1 && !adminContext.conversation[0].body.includes("$910"));
    await signIn(editor);
    const editorTree = await board({ who: "all", task: revision.id });
    const editorRows = rowsOf(editorTree);
    const editorBody = renderToStaticMarkup(editorTree);
    c.ok("editor remains scoped to own assigned task even through another task deep link", editorRows.length === 1 && editorRows[0].id === edit.id && !editorBody.includes(revision.title));
    c.ok("editor's row opens exact job edit without Start, client/account or office routes", editorBody.includes(`href="/edit/${job.id}"`) && !editorBody.includes(`href="/projects/${job.id}"`) && !editorBody.includes(`href="/clients/${client.id}"`) && !editorBody.includes(">Start</button>"));
    const editorContext = await getTaskConversation(edit.id);
    c.ok("editor cannot load a client's privileged conversation", editorContext.ok && editorContext.canSeeConversation === false && !editorContext.conversation);

    const view = rows.find((row) => row.id === unassigned.id)!;
    let opened = ""; let assigned = "";
    const compact = TaskCompactRow({ task: view, assignees: [{ key: "kyle", name: "Kyle" }], busy: false, dueInfo: null, assignmentNote: null, onAssign: (key) => { assigned = key; }, onOpen: (focus) => { opened = focus; } });
    const assignButton = elements(compact, "button").find((props) => Array.isArray(props.children) && props.children.includes("Assign"));
    (assignButton?.onClick as (() => void))();
    c.ok("Assign primary action opens the owner control without assigning or completing", opened === "assign" && assigned === "");
    const draftChild = createElement("textarea", { defaultValue: "Exact unsent draft" });
    const parentProps = { label: "Retained draft fixture", open: false, onCancel() {}, children: draftChild };
    const parent = createElement(ModalDialog, parentProps);
    c.ok("closed controlled ModalDialog retains its child input in the render tree", renderToStaticMarkup(parent).includes("Exact unsent draft") && !renderToStaticMarkup(parent).includes('open=""'));
    const full = renderToStaticMarkup(createElement(TaskFullView, { task: view }));
    c.ok("source context is not requested or opened by initial row/card rendering", !body.includes("Context source") && !full.includes("Original conversation") && !full.includes("<dialog"));
    const reply: QueueTask = { ...view, id: "reply-fixture", assignedKey: "kyle", taskType: "client_reply", source: "gmail", sourceDetail: "gmail-thread:fixture@example.invalid:fake-thread" };
    c.ok("reply primary prepares review context and never invokes a send action", taskRowAction(reply).label === "Review reply" && taskRowAction(reply).focus === "draft" && !taskRowAction(reply).href);
    const replyHtml = renderToStaticMarkup(createElement(TaskCard, { task: reply, compact: true }));
    c.ok("reply details preserve the existing explicit Draft/source-context actions", replyHtml.includes("AI draft a reply") && replyHtml.includes("Full view") && !replyHtml.includes("Exact unsent draft"));
    c.ok("completed and unbound revision rows retain explicit evidence/context decisions", taskRowAction({ ...view, status: "COMPLETED" }).label === "View completion" && taskRowAction({ ...view, taskType: "revision", assignedKey: "kyle" }).label === "Review revision");
    c.ok("row rendering and explicit context reads leave task/source/output state byte-identical", await snapshot() === before && (await prisma.commLog.findUniqueOrThrow({ where: { id: comm.id } })).body === "Context source $910");
    c.ok("no provider, outbox, assignment, work-start or completion side effect occurred", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.editorWorkItem.count() === 0);
    c.summary();
  } finally {
    await prisma.$disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fence.restore();
    await drill.stop();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
