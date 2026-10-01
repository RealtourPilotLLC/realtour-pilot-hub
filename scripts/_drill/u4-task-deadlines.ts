// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Signed real actions on an isolated database; exact-row CAS/audit failures and
// retained client form state with fake delayed/lost responses. No providers.
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { canEditTaskDeadline, parseTaskDeadlineDate, reconcileTaskDeadline } from "../../src/lib/taskDeadline";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}

// Exercise real component handlers with React's hook dispatcher in Node. This
// is state/receipt evidence, not a claim about browser focus or native layout.
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial;
      return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }];
    },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void, deps: unknown[]) {
      const slot = index++, old = cells[slot] as unknown[] | undefined;
      if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(effect); }
    },
    useTransition() { index++; return [false, (callback: () => unknown) => { void callback(); }]; },
  };
  return () => {
    index = 0;
    const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
  };
}

async function until(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!test()) throw new Error("fixture action did not settle");
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5945), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-u4-deadlines" } });
  installNextStubs();
  const c = makeChecker(), fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const actions = await import("@/app/actions");
    const { taskToView } = await import("@/lib/taskView");
    const { TaskCard } = await import("@/components/queue/TaskCard");
    const { TaskCompactRow } = await import("@/components/queue/TaskCompactRow");
    const { BoardView } = await import("@/components/tasks/BoardView");
    const { canAccess } = await import("@/lib/auth/access");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
    const { resolvePortalViewer } = await import("@/lib/portal");
    const req = createRequire(__filename);
    const cookieStore = await (req("next/headers") as typeof import("next/headers")).cookies();
    const user = (role: string) => prisma.appUser.create({ data: { email: `deadline-${role.toLowerCase()}@fixture.invalid`, name: `Fixture ${role}`, role, editorKey: role === "EDITOR" ? "kim" : null, status: "ACTIVE" } });
    const owner = await user("OWNER"), admin = await user("ADMIN"), editor = await user("EDITOR"), photo = await user("PHOTOGRAPHER");
    const client = await prisma.client.create({ data: { name: "Deadline Fixture TEST" } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 1 } });
    const clientUser = await prisma.clientUser.create({ data: { email: "deadline-client@fixture.invalid", name: "Fixture client", status: "ACTIVE" } });
    await prisma.clientMembership.create({ data: { clientUserId: clientUser.id, clientId: client.id, enrollmentId: enrollment.id, role: "OWNER", acceptedAt: new Date() } });
    const clientCookie = await signClientSession({ cu: clientUser.id, email: clientUser.email });
    const viewer = await resolvePortalViewer({ enrollmentId: enrollment.id, cookies: { get: (name) => name === CLIENT_COOKIE ? clientCookie : undefined } });
    c.ok("portal client has a real signed seat on an isolated program", viewer.ok && viewer.viewer.actor.kind === "CLIENT");
    const signIn = async (u: typeof owner) => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: u.id, email: u.email, role: u.role }); };
    const project = await prisma.project.create({ data: { clientId: client.id, title: "123 Task Fixture", status: "EDITING", promisedDueAt: new Date("2026-10-01T18:00:00Z"), dueOverrideAt: new Date("2026-10-01T16:00:00Z") } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO" } });
    const output = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO", promisedAt: new Date("2026-10-02T18:00:00Z") } });
    const initial = new Date("2026-09-30T21:00:00Z");
    const make = (title: string, extra: { taskType?: string; source?: string; dedupeKey?: string; status?: string } = {}) => prisma.smartTask.create({ data: {
      title, taskType: "todo", source: "manual", status: "OPEN", priority: "HIGH", assignedKey: "kim", assignedManually: true,
      clientId: client.id, projectId: project.id, outputId: output.id, description: "Private source body $750", summary: "Exact request", checklist: "[]", dueAt: initial,
      followUpAt: new Date("2026-10-01T18:00:00Z"), ...extra,
    } });
    const manual = await make("Manual ad hoc task");
    const assistant = await make("Requested assistant task", { taskType: "internal_instruction", source: "assistant" });
    const preserved = (row: typeof manual) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !["dueAt", "updatedAt"].includes(key))));
    const nonTaskBefore = JSON.stringify(await Promise.all([prisma.project.findMany(), prisma.deliverableOutput.findMany(), prisma.editorWorkItem.findMany(), prisma.editorWorkEvent.findMany(), prisma.appSetting.findMany()]));
    await signIn(admin);
    const saved = await actions.setTaskDeadline(manual.id, "2026-10-05", initial.toISOString());
    const after = await prisma.smartTask.findUniqueOrThrow({ where: { id: manual.id } });
    c.ok("signed ADMIN saves a manual ad hoc date using existing 5pm ET convention", saved.ok && after.dueAt?.toISOString() === "2026-10-05T21:00:00.000Z");
    c.ok("deadline save preserves all task identity, priority, owner, asks and follow-up fields", preserved(after) === preserved(manual));
    const audit = await prisma.auditLog.findFirst({ where: { target: manual.id, action: "task_deadline_change" } });
    c.ok("same transaction records only attributed exact before/after dates", audit?.actor === admin.email && audit.detail === JSON.stringify({ from: initial.toISOString(), to: saved.dueAt }) && !audit.detail.includes("Private"));
    await signIn(owner);
    const ownerSave = await actions.setTaskDeadline(assistant.id, "2026-11-01", initial.toISOString());
    c.ok("signed OWNER changes human-requested assistant task at DST-correct 5pm ET", ownerSave.ok && ownerSave.dueAt === "2026-11-01T22:00:00.000Z");
    const noopBefore = await prisma.smartTask.findUniqueOrThrow({ where: { id: assistant.id } });
    const nAudit = await prisma.auditLog.count();
    const noop = await actions.setTaskDeadline(assistant.id, "2026-11-01", ownerSave.dueAt!);
    c.ok("confirmed repeated date is a true no-op without an extra audit or updatedAt", noop.ok && JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: assistant.id } })) === JSON.stringify(noopBefore) && await prisma.auditLog.count() === nAudit);
    const cleared = await actions.setTaskDeadline(assistant.id, "", ownerSave.dueAt!);
    c.ok("office can clear the ad hoc task date without clearing its follow-up", cleared.ok && cleared.dueAt === null && (await prisma.smartTask.findUniqueOrThrow({ where: { id: assistant.id } })).followUpAt?.toISOString() === assistant.followUpAt?.toISOString());
    const resave = await actions.setTaskDeadline(assistant.id, "2026-03-08", null);
    c.ok("empty-date CAS can save a spring-transition date at 5pm ET", resave.ok && resave.dueAt === "2026-03-08T21:00:00.000Z");
    const staleBefore = JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: manual.id } }));
    const staleAudit = await prisma.auditLog.count();
    const stale = await actions.setTaskDeadline(manual.id, "2026-10-06", initial.toISOString());
    c.ok("stale date CAS refuses and requires a read before retry without any write", !stale.ok && stale.needsRefresh === true && JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: manual.id } })) === staleBefore && await prisma.auditLog.count() === staleAudit);
    const refreshed = await actions.readTaskDeadline(manual.id);
    c.ok("exact-row office refresh returns the saved current date and eligibility", refreshed.ok && refreshed.editable && refreshed.dueAt === saved.dueAt);
    c.ok("unknown dedupe evidence fails closed in presentation", !canEditTaskDeadline({ taskType: "todo", source: "manual", status: "OPEN" }) && !taskToView({ ...manual, dedupeKey: undefined, client: null }).canEditDeadline);
    for (const [label, extra] of [
      ["field flag", { taskType: "internal_instruction", source: "manual", dedupeKey: "field-flag-fixture" }],
      ["legacy field flag", { taskType: "internal_instruction", source: "manual" }],
      ["manual edit", { taskType: "edit_video", source: "manual" }],
      ["revision", { taskType: "revision", source: "manual" }],
      ["QC", { taskType: "media_qa", source: "manual" }],
      ["confirmation", { taskType: "confirmation_text", source: "manual" }],
      ["generated todo", { taskType: "todo", source: "content_program" }],
      ["keyed assistant watchdog", { taskType: "internal_instruction", source: "assistant", dedupeKey: "watchdog-fixture" }],
      ["completed task", { status: "COMPLETED" }], ["cancelled task", { status: "CANCELLED" }],
    ] as const) {
      const task = await make(label, extra);
      const before = JSON.stringify(task), auditCount = await prisma.auditLog.count();
      const receipt = await actions.setTaskDeadline(task.id, "2026-10-06", initial.toISOString());
      c.ok(`${label} date is refused server-side and absent from editable presentation`, !receipt.ok && !taskToView({ ...task, client: null }).canEditDeadline && JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } })) === before && await prisma.auditLog.count() === auditCount);
    }
    const deniedActors = [
      { label: "assigned editor", signIn: () => signIn(editor) },
      { label: "photographer", signIn: () => signIn(photo) },
      { label: "signed portal client", signIn: async () => { await clearSession(); cookieStore.set(CLIENT_COOKIE, clientCookie); } },
      { label: "owner preview", signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: admin.id }); } },
      { label: "anonymous", signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await clearSession(); } },
    ];
    for (const actor of deniedActors) {
      await actor.signIn();
      const before = JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: manual.id } })), auditCount = await prisma.auditLog.count();
      const changed = await actions.setTaskDeadline(manual.id, "2026-10-06", saved.dueAt!);
      const read = await actions.readTaskDeadline(manual.id);
      c.ok(`${actor.label} cannot change or refresh an office task date`, !changed.ok && !read.ok && JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: manual.id } })) === before && await prisma.auditLog.count() === auditCount);
    }
    await signIn(admin);
    c.ok("strict calendar validation rejects impossible, malformed and missing values", ["2026-02-31", "2026-13-01", "tomorrow", "2026-03-08T17:00", undefined].every((value) => !parseTaskDeadlineDate(value).ok));
    const invalid = await actions.setTaskDeadline(manual.id, "2026-02-31", saved.dueAt!);
    c.ok("invalid date refuses without normalizing to another day", !invalid.ok && !invalid.needsRefresh && (await actions.readTaskDeadline(manual.id)).ok);

    // Inject only the isolated transaction facade: this proves the SQL CAS
    // repeats state/source predicates after its first read, without pretending
    // PGlite can run two simultaneous backend transactions.
    const originalTx = prisma.$transaction;
    for (const [label, data] of [["closed", { status: "COMPLETED" }], ["transformed", { taskType: "edit_video" }], ["newer date", { dueAt: new Date("2026-10-08T21:00:00Z") }]] as const) {
      const row = await make(`Between-read ${label}`);
      prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) => originalTx.call(prisma, async (tx) => {
        const update = tx.smartTask.updateMany.bind(tx.smartTask);
        return callback({ ...tx, smartTask: { ...tx.smartTask, updateMany: async (args: unknown) => { await tx.smartTask.update({ where: { id: row.id }, data }); return update(args as Parameters<typeof update>[0]); } } });
      })) as typeof originalTx;
      try {
        const beforeAudit = await prisma.auditLog.count();
        const result = await actions.setTaskDeadline(row.id, "2026-10-06", initial.toISOString());
        const final = await prisma.smartTask.findUniqueOrThrow({ where: { id: row.id } });
        c.ok(`CAS refuses a ${label} task after its initial read`, !result.ok && result.needsRefresh === true && final.dueAt?.toISOString() === (label === "newer date" ? "2026-10-08T21:00:00.000Z" : initial.toISOString()) && await prisma.auditLog.count() === beforeAudit);
      } finally { prisma.$transaction = originalTx; }
    }
    const rollback = await make("Atomic audit rollback");
    prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) => originalTx.call(prisma, async (tx) => callback({ ...tx, auditLog: { ...tx.auditLog, create: async () => { throw new Error("fixture audit failure"); } } }))) as typeof originalTx;
    try {
      let threw = false;
      try { await actions.setTaskDeadline(rollback.id, "2026-10-06", initial.toISOString()); } catch { threw = true; }
      c.ok("failed audit insert rolls the real isolated date write back atomically", threw && JSON.stringify(await prisma.smartTask.findUniqueOrThrow({ where: { id: rollback.id } })) === JSON.stringify(rollback) && await prisma.auditLog.count({ where: { target: rollback.id } }) === 0);
    } finally { prisma.$transaction = originalTx; }
    c.ok("project/output deadlines, work clocks and saved settings remain byte-identical", JSON.stringify(await Promise.all([prisma.project.findMany(), prisma.deliverableOutput.findMany(), prisma.editorWorkItem.findMany(), prisma.editorWorkEvent.findMany(), prisma.appSetting.findMany()])) === nonTaskBefore);

    const view = taskToView({ ...after, client: null });
    const office = renderToStaticMarkup(createElement(TaskCard, { task: view, compact: true, deadlineOffice: true }));
    const creative = renderToStaticMarkup(createElement(TaskCard, { task: view, compact: true, editorView: true, deadlineOffice: true }));
    c.ok("compact office row opens one retained labelled editor without losing detail drafts", office.includes("Edit due date") && office.includes("Due date for Manual ad hoc task") && office.includes('type="date"') && (office.match(/<section\b[^>]*\bdata-task-deadline=/g) ?? []).length === 1 && office.includes("Closing keeps your unsent draft"));
    c.ok("creative task UI has no office deadline controls", !creative.includes("Edit due date") && !creative.includes("Save task date"));
    const unknownRole = renderToStaticMarkup(createElement(TaskCard, { task: view, compact: true }));
    c.ok("missing explicit office evidence hides due controls", !unknownRole.includes("Edit due date") && !unknownRole.includes("Save task date"));
    const adminBoard = renderToStaticMarkup(await BoardView({ sp: { who: "all" }, tabs: null, showTest: true }));
    c.ok("real ADMIN board composes office date controls without exposing money in task source", adminBoard.includes("Edit due date") && !adminBoard.includes("$750"));
    await prisma.appUser.update({ where: { id: photo.id }, data: { permissions: JSON.stringify({ tasks: true }) } });
    await signIn(photo);
    const photoBoard = renderToStaticMarkup(await BoardView({ sp: { who: "all" }, tabs: null, showTest: true }));
    c.ok("photographer Tasks override preserves access while first paint hides office dates", canAccess({ role: "PHOTOGRAPHER", permissions: JSON.stringify({ tasks: true }) }, "tasks") && photoBoard.includes(manual.title) && !photoBoard.includes("Edit due date") && !photoBoard.includes("Save task date") && !photoBoard.includes("$750"));
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: admin.id });
    const previewBoard = renderToStaticMarkup(await BoardView({ sp: { who: "all" }, tabs: null, showTest: true }));
    c.ok("owner preview first paint is read-only for task deadlines", !previewBoard.includes("Edit due date") && !previewBoard.includes("Save task date"));
    await signIn(admin);
    let focus = "";
    const row = TaskCompactRow({ task: view, assignees: [], deadlineOffice: true, busy: false, dueInfo: null, assignmentNote: null, onAssign() {}, onOpen: (value) => { focus = value; } });
    (elements(row, "button").find((props) => props.children === "Edit due date")?.onClick as (() => void))();
    c.ok("quick due action opens the deadline field without any date mutation", focus === "deadline");
    c.ok("refresh classification compares exact instant rather than date text alone", reconcileTaskDeadline({ dueAt: "2026-11-01T22:00:00.000Z", editable: true }, "2026-11-01").matches && !reconcileTaskDeadline({ dueAt: "2026-11-01T21:00:00.000Z", editable: true }, "2026-11-01").matches);

    const { TaskDeadlineEditor } = await import("@/components/queue/TaskDeadlineEditor");
    const uiTask = await make("Lost date response fixture");
    let current = initial.toISOString() as string | null, allowed = true, formBusy = false;
    const form = mountHooks(() => TaskDeadlineEditor({ taskId: uiTask.id, title: uiTask.title, dueAt: current, editable: allowed, disabled: false,
      onBusyChange: (value) => { formBusy = value; }, onConfirmed: (value) => { current = value; },
    }));
    const field = (tree: unknown) => elements(tree, "TextField")[0];
    const button = (tree: unknown, label: string) => elements(tree, "Button").find((props) => props.children === label)!;
    const choose = (value: string) => (field(form()).onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    const click = (label: string) => (button(form(), label).onClick as () => void)();
    choose("2026-10-09");
    let release!: () => void, attempted = 0;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    prisma.$transaction = (async (...args: Parameters<typeof originalTx>) => { attempted++; await delayed; const receipt = await originalTx.apply(prisma, args); throw new Error(`fixture lost response after receipt ${!!receipt}`); }) as unknown as typeof originalTx;
    try {
      click("Save task date");
      await until(() => attempted === 1);
      const waiting = form();
      choose("2026-10-10"); click("Save task date");
      c.ok("pending date freezes the exact submitted input and duplicate save", formBusy && field(waiting).disabled === true && field(form()).value === "2026-10-09" && attempted === 1 && button(waiting, "Save task date").disabled === true);
      release(); await until(() => !formBusy);
      const lost = form();
      click("Save task date");
      c.ok("lost successful response retains chosen date and refuses blind retry", field(lost).value === "2026-10-09" && field(lost).disabled === true && button(lost, "Save task date").disabled === true && attempted === 1 && !!button(lost, "Check current task date") && elements(lost, "SaveStatus")[0].state === "error");
    } finally { prisma.$transaction = originalTx; }
    click("Check current task date"); await until(() => !formBusy);
    const reconciled = form();
    c.ok("exact read reconciles a committed lost response without discarding task draft", current === "2026-10-09T21:00:00.000Z" && field(reconciled).value === "2026-10-09" && elements(reconciled, "SaveStatus")[0].message === "The current task date matches your submitted change." && button(reconciled, "Save task date").disabled === true);
    choose("2026-10-10");
    await prisma.smartTask.update({ where: { id: uiTask.id }, data: { status: "COMPLETED" } });
    click("Save task date"); await until(() => !formBusy);
    allowed = false;
    const changedEligibility = form();
    c.ok("eligibility change preserves chosen date and required reconciliation receipt", field(changedEligibility).value === "2026-10-10" && field(changedEligibility).disabled === true && !!button(changedEligibility, "Check current task date"));
    click("Check current task date"); await until(() => !formBusy);
    c.ok("closed-task exact read retains chosen date but cannot reopen editing", field(form()).value === "2026-10-10" && field(form()).disabled === true && button(form(), "Save task date").disabled === true && (await prisma.smartTask.findUniqueOrThrow({ where: { id: uiTask.id } })).dueAt?.toISOString() === current);
    let parentTask = { ...view }, statusAttempts = 0;
    const parent = mountHooks(() => TaskCard({ task: parentTask, compact: true, deadlineOffice: true }));
    const initialParent = parent();
    const deadlineProps = elements(initialParent, "TaskDeadlineEditor")[0];
    (deadlineProps.onBusyChange as (value: boolean) => void)(true);
    const busyParent = parent();
    const complete = elements(busyParent, "button").find((props) => Array.isArray(props.children) && props.children.includes("Complete"))!;
    const status = elements(busyParent, "select").find((props) => props["aria-label"] === "Task status")!;
    // A second same-tick event sees the ref even before disabled re-paints.
    const initialComplete = elements(initialParent, "button").find((props) => Array.isArray(props.children) && props.children.includes("Complete"))!;
    const txForStatus = prisma.smartTask.updateMany;
    prisma.smartTask.updateMany = (async (...args: Parameters<typeof txForStatus>) => { statusAttempts++; return txForStatus.apply(prisma.smartTask, args); }) as unknown as typeof txForStatus;
    try { (initialComplete.onClick as () => void)(); await new Promise((resolve) => setTimeout(resolve, 10)); }
    finally { prisma.smartTask.updateMany = txForStatus; }
    c.ok("same-card status controls refuse pending date work including a same-tick event", complete.disabled === true && status.disabled === true && statusAttempts === 0);
    (deadlineProps.onBusyChange as (value: boolean) => void)(false);
    parentTask = { ...view, canEditDeadline: false, status: "COMPLETED" };
    const kept = elements(parent(), "TaskDeadlineEditor");
    c.ok("retained drawer keeps the same deadline editor through eligibility changes", kept.length === 1 && kept[0].taskId === view.id && kept[0].editable === false);
    c.ok("no provider/outbox/sends/start operations were invoked", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.editorWorkEvent.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
