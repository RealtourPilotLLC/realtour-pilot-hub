// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual queue SSR and desk event handlers; all action exports are fake.
// No database, Start/Pause writer, provider, browser or clipboard is invoked.
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { QueueRow } from "../../src/components/editing/SimpleQueue";
import type { DeskJob } from "../../src/lib/editorDesk";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function words(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join("");
  return isValidElement<Props>(tree) ? words(tree.props.children) : "";
}
const contains = (tree: unknown, text: string) => words(tree).includes(text);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function until(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!test()) throw new Error("Desk fixture did not settle");
}
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return { render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { return render(); } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } } };
}

function row(id: string, editorKey = "kim"): QueueRow {
  const dueISO = "2026-09-28T21:00:00.000Z";
  return {
    id, url: `https://hub.example.test/edit/${id}`, street: `${id} Long Project Avenue`, client: "Long Client Name", clientAvatarUrl: null,
    tier: "branding", typeDetail: "Four approved personal branding videos", status: "Revisions", held: false,
    videoBreakdown: "1 ready for review · 3 more to edit", videosToEdit: 3, startableBy: [editorKey],
    editor: editorKey === "kim" ? "Kim" : "John Mark", editorKey, savedEditorKey: editorKey, assignmentState: "assigned", auto: false,
    dueISO, late: true, priority: "NORMAL", videos: 4, hasScript: true, comments: 2,
    rawUrl: "https://dropbox.example.test/raw-exact", finalUrl: "https://dropbox.example.test/final-exact", rawCount: 8, finalCount: 1,
    shootISO: "2026-09-27T14:00:00.000Z", photographer: null, openRevisions: 1,
    overrides: { statusPinned: false, dueAt: null, videosOwed: null, tier: null, typeDetail: null, priority: null, by: null, at: null, note: null },
    computed: { dueAt: dueISO, videosOwed: 4, tier: "branding", typeDetail: "Four approved personal branding videos", priority: "NORMAL" },
    work: { active: [], paused: [] }, workChip: null, blocker: "Exact unfilmed topic remains owed",
    lastAction: { name: "Kim", words: "uploaded a version", at: "12:14pm" },
  };
}

async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  installNextStubs();
  let search = "editor=kim&due=overdue&stage=changes&test=1";
  let refreshes = 0;
  for (const navigation of [req("next/navigation"), req("./_next-navigation-stub.cjs")]) {
    navigation.useSearchParams = () => new URLSearchParams(search);
    navigation.useRouter = () => ({ refresh: () => { refreshes++; }, push() {}, replace() {}, prefetch() {} });
  }
  const writes: { kind: string; input: { projectId: string | null; requestId: string } }[] = [];
  let response = deferred<{ ok: boolean; message: string }>();
  const fake = (kind: string) => async (input: { projectId: string | null; requestId: string }) => { writes.push({ kind, input }); return response.promise; };
  const stub = (file: string, exports: unknown) => { const id = req.resolve(file); req.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule; };
  stub("../../src/app/editing/workActions.ts", { startEditingAction: fake("start"), pauseEditingAction: fake("pause"), confirmCurrentWorkAction: fake("confirm") });
  stub("../../src/app/editing/actions.ts", new Proxy({}, { get: () => async () => { throw new Error("Queue mutation forbidden in composition fixture"); } }));
  try {
    const { SimpleQueue } = await import("../../src/components/editing/SimpleQueue");
    const { EditorDesk } = await import("../../src/components/editing/EditorDesk");
    const kim = row("kim-exact"), john = row("john-hidden", "john");
    const html = renderToStaticMarkup(createElement(SimpleQueue, { notDone: [kim, john], upcoming: [], done: [] }));
    const briefHref = "/edit/kim-exact?queue=editor%3Dkim%26due%3Doverdue%26stage%3Dchanges%26test%3D1";
    c.ok("office queue has five clear columns and one visible brief action", (html.match(/<th\b/g)?.length ?? 0) === 5 && html.includes("Open brief") && !html.includes(">Video type</th>") && !html.includes("john-hidden Long Project Avenue"));
    c.ok("identity includes exact video labels and units while blocker and mixed stages remain visible", html.includes(kim.typeDetail) && html.includes("4 videos") && html.includes(kim.videoBreakdown!) && html.includes(kim.blocker!) && html.includes("Long Client Name"));
    c.ok("brief keeps all validated queue dimensions", html.split(`href="${briefHref}"`).length - 1 === 2 && html.includes("Filter by project stage") && html.includes("Filter by editor") && html.includes("Filter by due date"));
    c.ok("chat opens the actual messages anchor with exact retained queue context", html.includes(`href="${briefHref}#messages"`) && html.split(`href="${briefHref}#messages"`).length - 1 === 1);
    c.ok("exact folder URLs and canonical copy remain in closed support disclosure", /<details[^>]*>[\s\S]*?Files and chat · 2[\s\S]*?raw-exact[\s\S]*?final-exact/.test(html) && html.includes("Copy link") && html.includes(kim.url) && !html.includes("Files and chat · 2</summary><div open"));
    c.ok("office More and assignment controls survive; activity remains separate from Start", html.includes("More actions") && html.includes("Latest activity") && html.includes("Activity alone does not mean they pressed Start") && html.includes("Assign editor"));
    search = "due=overdue&stage=changes";
    const own = renderToStaticMarkup(createElement(SimpleQueue, { notDone: [kim], upcoming: [], done: [], hideEditor: true }));
    c.ok("editor queue retains four columns and no office reassignment or More controls", (own.match(/<th\b/g)?.length ?? 0) === 4 && own.includes("Open brief") && !own.includes("More actions") && !own.includes("Assign editor") && !own.includes("Latest activity"));

    const jobs: DeskJob[] = Array.from({ length: 6 }, (_, index) => ({ projectId: `job-${index}`, street: `Job ${index} Exact Street`, dueISO: kim.dueISO, late: true, note: index === 0 ? "Revisions to do" : null, pausedSinceISO: index === 1 ? "2026-09-28T14:00:00.000Z" : null, claim: false, startable: true }));
    type Desk = Parameters<typeof EditorDesk>[0];
    let props: Desk = { desk: { active: null, unconfirmed: [] }, jobs, tz: "Asia/Manila" };
    let card = mountHooks(() => EditorDesk(props));
    const tree = () => card.render();
    const button = (label: string) => elements(tree(), "button").find((value) => contains(value.children, label))!;
    const click = (label: string) => (button(label).onClick as () => unknown)();
    c.ok("idle desk is compact without repeated startable project rows or automatic work", contains(tree(), "Start a job") && !contains(tree(), jobs[0].street) && writes.length === 0);
    click("Start a job");
    c.ok("opening chooser makes existing Start and Resume explicit without writing", contains(tree(), "Start · Job 0") && contains(tree(), "Resume · Job 1") && !contains(tree(), jobs[5].street) && writes.length === 0);
    click("Show all 6");
    c.ok("all later jobs remain reachable and cancelling never writes", contains(tree(), jobs[5].street) && (click("Cancel"), !contains(tree(), jobs[0].street)) && writes.length === 0);
    click("Start a job"); click("Start · Job 0");
    c.ok("only explicit choice invokes the exact existing Start payload and locks pending choices", writes.length === 1 && writes[0].kind === "start" && writes[0].input.projectId === "job-0" && !!writes[0].input.requestId && button("Resume · Job 1").disabled === true);
    response.resolve({ ok: true, message: "Exact fake Start confirmed." }); await until(() => contains(tree(), "Exact fake Start confirmed."));
    c.ok("known success folds chooser and refreshes without marking any other job", !contains(tree(), jobs[0].street) && refreshes === 1 && writes.length === 1);
    props = { ...props, jobs: [{ ...jobs[0], claim: true }], desk: { active: null, unconfirmed: [] } }; card = mountHooks(() => EditorDesk(props));
    response = deferred(); click("Choose current job"); click("Confirm · Job 0");
    c.ok("legacy claim still uses exact confirmation instead of a new Start", writes.at(-1)?.kind === "confirm" && writes.at(-1)?.input.projectId === "job-0");
    response.resolve({ ok: true, message: "Exact fake claim confirmed." }); await until(() => contains(tree(), "Exact fake claim confirmed."));
    props = { ...props, jobs, desk: { active: { projectId: "job-0", street: jobs[0].street, sinceISO: "2026-09-28T14:00:00.000Z", outputTitle: "Video 2 exact title" }, unconfirmed: [] } }; card = mountHooks(() => EditorDesk(props));
    const beforeSwitch = writes.length; click("Switch job");
    c.ok("active desk names exact output and opening switch never starts or pauses", contains(tree(), "Video 2 exact title") && contains(tree(), "will be paused when you start another job") && writes.length === beforeSwitch && !contains(button("Resume · Job 1"), jobs[0].street));
    response = deferred(); click("Resume · Job 1");
    c.ok("explicit Resume uses existing Start action with selected project", writes.at(-1)?.kind === "start" && writes.at(-1)?.input.projectId === "job-1");
    response.resolve({ ok: true, message: "Exact fake resume confirmed." }); await until(() => contains(tree(), "Exact fake resume confirmed."));
    response = deferred(); click("Pause");
    c.ok("explicit Pause remains bound to current job", writes.at(-1)?.kind === "pause" && writes.at(-1)?.input.projectId === "job-0");
    response.resolve({ ok: true, message: "Exact fake Pause confirmed." }); await until(() => contains(tree(), "Exact fake Pause confirmed."));
    props = { ...props, readOnly: true }; card = mountHooks(() => EditorDesk(props));
    c.ok("preview disables manual mutations and failed desk never claims idle work", button("Pause").disabled === true && renderToStaticMarkup(createElement(EditorDesk, { desk: null, jobs: [], tz: props.tz })).includes("current job is unavailable") && !renderToStaticMarkup(createElement(EditorDesk, { desk: null, jobs: [], tz: props.tz })).includes("Nothing to edit right now"));
    const deskHtml = renderToStaticMarkup(tree() as ReactNode);
    c.ok("readable native controls retain 44px targets/focus and no external work", deskHtml.includes("min-h-11") && deskHtml.includes("focus-visible:outline") && fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
