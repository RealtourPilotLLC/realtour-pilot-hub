// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Retained task input under delayed AI/note receipts. Actions below are pure
// fakes; no database, messages, provider sends or recipient mutation is used.
import { isValidElement } from "react";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { finishTaskNoteReceipt, finishTaskReplyDraft } from "../../src/lib/taskTextReceipt";
import type { QueueTask } from "../../src/components/queue/TaskCard";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  return isValidElement<Props>(tree) && contains(tree.props.children, text);
}
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void, deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(effect); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return () => {
    index = 0;
    const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
  };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!test()) throw new Error("fixture receipt did not settle"); }

installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  let draftResult = deferred<{ text?: string; error?: string }>();
  let noteResult = deferred<{ ok: boolean; message: string }>();
  const draftCalls: string[] = [], notes: { taskId: string; text: string }[] = [];
  let sendCalls = 0;
  const actionFile = req.resolve("../../src/app/actions.ts"), messageFile = req.resolve("../../src/app/projects/messageActions.ts"), emailFile = req.resolve("../../src/app/emailActions.ts");
  const originals = [actionFile, messageFile, emailFile].map((file) => req.cache[file]);
  const stub = (file: string, exports: unknown) => { req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  stub(actionFile, {
    draftTaskReply: async (id: string) => { draftCalls.push(id); return draftResult.promise; },
    setSmartTaskStatus: async () => { throw new Error("not a text receipt action"); }, setTaskAssignee: async () => { throw new Error("not a text receipt action"); },
    editCardWork: async () => [], toggleTaskChecklistItem: async () => { throw new Error("not a text receipt action"); },
    sendDeliveryText: async () => { sendCalls++; throw new Error("fixture refuses sends"); }, sendConfirmationText: async () => { sendCalls++; throw new Error("fixture refuses sends"); },
  });
  stub(messageFile, { addTaskNote: async (taskId: string, text: string) => { notes.push({ taskId, text }); return noteResult.promise; } });
  stub(emailFile, { resolveEmailRecipient: async () => { throw new Error("non-email fixture must not resolve recipient"); }, sendEmailReply: async () => { sendCalls++; throw new Error("fixture refuses sends"); } });
  try {
    const { TaskCard } = await import("@/components/queue/TaskCard");
    const task: QueueTask = { id: "retained-text-fixture", title: "Review the exact request", taskType: "lead", status: "OPEN", priority: "MEDIUM", dueAt: null, createdAt: null, reasonCreated: "Fixture request", summary: "Exact context", description: "Original context stays", deliverables: [], source: "openphone", sourceDetail: "phone:6105550100", assignedKey: "kyle", projectId: "fixture-job", clientId: "fixture-client", clientName: "Fixture client", contactName: null, propertyAddress: "123 Exact Fixture" };
    const card = mountHooks(() => TaskCard({ task, compact: true }));
    const button = (tree: unknown, label: string) => elements(tree, "button").find((props) => contains(props.children, label))!;
    const textarea = (tree: unknown, label: string) => elements(tree, "AutoTextarea").find((props) => props["aria-label"] === label)!;
    const click = (label: string) => (button(card(), label).onClick as () => void)();
    const type = (label: string, value: string) => (textarea(card(), label).onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    click("Draft");
    draftResult.resolve({ text: "Initial suggested reply" });
    await until(() => contains(card(), "Suggested reply"));
    c.ok("initial AI suggestion populates only the requested task's unchanged draft", draftCalls.join() === task.id && textarea(card(), "Reply draft").value === "Initial suggested reply");
    type("Reply draft", "Exact typed reply\n Keep  spacing. ");
    draftResult = deferred();
    click("Draft");
    type("Reply draft", "Newer typed reply\n Preserve  exact words. ");
    const pending = card();
    c.ok("AI regeneration keeps the existing editable draft and original source context", textarea(pending, "Reply draft").value === "Newer typed reply\n Preserve  exact words. " && contains(pending, "Original context stays") && button(pending, "Draft").disabled === true);
    draftResult.resolve({ text: "New regenerated suggestion\nA separate proposal." });
    await until(() => contains(card(), "A new AI suggestion is ready"));
    const lateDraft = card();
    c.ok("late AI receipt keeps newer exact text instead of applying the suggestion", textarea(lateDraft, "Reply draft").value === "Newer typed reply\n Preserve  exact words. " && contains(lateDraft, "Your newer reply text is kept"));
    c.ok("returned AI suggestion remains accessible read-only without recipient or send changes", contains(lateDraft, "New AI suggestion") && contains(lateDraft, "New regenerated suggestion\nA separate proposal.") && !contains(lateDraft, "Replying to") && sendCalls === 0);
    draftResult = deferred(); click("Draft"); draftResult.reject(new Error("fixture model read failed"));
    await until(() => contains(card(), "A new draft could not be loaded"));
    c.ok("failed regeneration preserves latest reply text and gives an explicit error", textarea(card(), "Reply draft").value === "Newer typed reply\n Preserve  exact words. " && contains(card(), "Any text you already entered is still here"));
    draftResult = deferred(); click("Draft"); draftResult.resolve({ text: "Accepted unchanged-snapshot suggestion" });
    await until(() => textarea(card(), "Reply draft").value === "Accepted unchanged-snapshot suggestion");
    c.ok("regeneration may replace an unchanged request-start draft as before", textarea(card(), "Reply draft").value === "Accepted unchanged-snapshot suggestion" && !contains(card(), "New AI suggestion"));
    click("Note"); type("Project note", "Submitted note\n Keep  whitespace. "); click("Add to project messages");
    type("Project note", "Newer unsent note\n Keep  punctuation! ");
    c.ok("note request captures only the exact submitted snapshot while typing continues", notes.length === 1 && notes[0].taskId === task.id && notes[0].text === "Submitted note\n Keep  whitespace. " && textarea(card(), "Project note").value === "Newer unsent note\n Keep  punctuation! ");
    noteResult.resolve({ ok: true, message: "Note posted." });
    await until(() => contains(card(), "Your newer note is still unsaved"));
    c.ok("successful older note receipt keeps newer input and its composer open", textarea(card(), "Project note").value === "Newer unsent note\n Keep  punctuation! " && contains(card(), "Note posted. Your newer note is still unsaved."));
    noteResult = deferred(); click("Add to project messages"); noteResult.resolve({ ok: false, message: "Fixture task no longer exists." });
    await until(() => contains(card(), "Fixture task no longer exists"));
    c.ok("known note refusal preserves current exact input with an alert", textarea(card(), "Project note").value === "Newer unsent note\n Keep  punctuation! " && elements(card(), "p").some((props) => props.role === "alert" && contains(props.children, "Fixture task no longer exists")));
    noteResult = deferred(); click("Add to project messages"); type("Project note", "Even newer note during lost response\n "); noteResult.reject(new Error("fixture response lost"));
    await until(() => contains(card(), "The note was not confirmed"));
    c.ok("lost note response retains later input and existing check-thread guidance", textarea(card(), "Project note").value === "Even newer note during lost response\n " && contains(card(), "check project messages before trying again"));
    noteResult = deferred(); click("Add to project messages"); noteResult.resolve({ ok: true, message: "Latest note posted." });
    await until(() => !textarea(card(), "Project note"));
    c.ok("success on unchanged submitted note clears and closes only that composer", !textarea(card(), "Project note") && contains(card(), "Latest note posted."));
    click("Note");
    c.ok("reopened note composer contains no already-saved snapshot", textarea(card(), "Project note").value === "");
    type("Project note", "Snapshot posted while Cancel clears local input");
    noteResult = deferred(); click("Add to project messages"); click("Cancel");
    noteResult.resolve({ ok: true, message: "Submitted snapshot posted." });
    await until(() => contains(card(), "Submitted snapshot posted."));
    c.ok("a posted receipt after Cancel does not invent an empty newer unsaved note", !textarea(card(), "Project note") && contains(card(), "Submitted snapshot posted.") && !contains(card(), "Your newer note is still unsaved"));
    click("Note");
    c.ok("cancelled local input remains empty after the older posted receipt", textarea(card(), "Project note").value === "");
    const edited = finishTaskReplyDraft("same?\n", "same?", "model");
    const noteWhitespace = finishTaskNoteReceipt("exact\n", "exact", { ok: true, message: "Saved." });
    c.ok("receipt identity compares whitespace exactly without normalization", edited.keptNewer && edited.value === "same?\n" && !noteWhitespace.close && noteWhitespace.value === "exact\n");
    c.ok("text receipt handlers never invoke client sends, recipient reads or provider calls", sendCalls === 0 && fence.blocked.length === 0 && notes.length === 5 && draftCalls.length === 4);
    c.summary();
  } finally { [actionFile, messageFile, emailFile].forEach((file, i) => { if (originals[i]) req.cache[file] = originals[i]; else delete req.cache[file]; }); fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
