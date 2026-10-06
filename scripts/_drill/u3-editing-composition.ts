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
  // Oct 5 2026: EditorDesk draws what was pressed before the server answers
  // (useOptimistic). As in React: the optimistic value stands only while a
  // transition is in flight, and falls back to the passed-in value when the
  // last one settles — so a press that the server refuses shows nothing stale.
  let inFlight = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; inFlight++; void callback().finally(() => { cells[slot] = false; inFlight--; }); }]; },
    useOptimistic(passthrough: unknown, reducer?: (state: unknown, action: unknown) => unknown) {
      const slot = index++;
      if (!(slot in cells)) cells[slot] = { set: false, value: undefined };
      const cell = cells[slot] as { set: boolean; value: unknown };
      if (inFlight === 0) cell.set = false;
      const shown = cell.set ? cell.value : passthrough;
      return [shown, (action: unknown) => { cell.value = reducer ? reducer(cell.set ? cell.value : passthrough, action) : action; cell.set = true; }];
    },
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
  const pushes: string[] = [];
  for (const navigation of [req("next/navigation"), req("./_next-navigation-stub.cjs")]) {
    navigation.useSearchParams = () => new URLSearchParams(search);
    navigation.useRouter = () => ({ refresh: () => { refreshes++; }, push: (href: string) => { pushes.push(href); }, replace() {}, prefetch() {} });
  }
  // Oct 5 2026: the row's rarer actions (project chat, copy link, and the
  // office's override / remove) moved into a floating menu (ActionMenu) that a
  // static render draws closed. The real menu still renders; this records the
  // items each one was given, so the drill can press them exactly as a click
  // would — the chat item's navigation and the copy item's clipboard write.
  type MenuItem = { id: string; text: string; onSelect: () => void };
  const menus: { label: string; items: MenuItem[] }[] = [];
  const realMenu = req("../../src/components/ui/ActionMenu.tsx") as typeof import("../../src/components/ui/ActionMenu");
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });
  const writes: { kind: string; input: { projectId: string | null; requestId: string } }[] = [];
  let response = deferred<{ ok: boolean; message: string }>();
  const fake = (kind: string) => async (input: { projectId: string | null; requestId: string }) => { writes.push({ kind, input }); return response.promise; };
  const stub = (file: string, exports: unknown) => { const id = req.resolve(file); req.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule; };
  stub("../../src/app/editing/workActions.ts", { startEditingAction: fake("start"), pauseEditingAction: fake("pause"), confirmCurrentWorkAction: fake("confirm") });
  stub("../../src/app/editing/actions.ts", new Proxy({}, { get: () => async () => { throw new Error("Queue mutation forbidden in composition fixture"); } }));
  stub("../../src/components/ui/ActionMenu.tsx", { ...realMenu, ActionMenu: (props: Parameters<typeof realMenu.ActionMenu>[0]) => { menus.push({ label: props.label, items: props.items as MenuItem[] }); return createElement(realMenu.ActionMenu, props); } });
  try {
    const { SimpleQueue } = await import("../../src/components/editing/SimpleQueue");
    const { EditorDesk } = await import("../../src/components/editing/EditorDesk");
    const kim = row("kim-exact"), john = row("john-hidden", "john");
    const html = renderToStaticMarkup(createElement(SimpleQueue, { notDone: [kim, john], upcoming: [], done: [] }));
    const briefHref = "/edit/kim-exact?queue=editor%3Dkim%26due%3Doverdue%26stage%3Dchanges%26test%3D1";
    // Oct 5 2026 — the queue was simplified (e0b5a5a / a3133a5, Oct 2): the
    // visible brief action reads "Open" (titled "Open editing brief"); Raw and
    // Final sit on the row as folder links; chat and copy moved into the
    // row's "…" menu; today's activity sits under the row with a title saying
    // it is not a Start. Each check below asserts the same promise on the new
    // shape — the same five columns, the same exact links, the same
    // separation of activity from Start, and the same editor/office split.
    const headers = [...html.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    const openLinks = html.split(`title="Open editing brief"`).length - 1;
    c.ok("office queue has five clear columns and one visible brief action", JSON.stringify(headers) === JSON.stringify(["Project", "Progress", "Due", "Editor", "Action"]) && openLinks === 1 && new RegExp(`<a title="Open editing brief"[^>]*href="${briefHref.replace(/[?]/g, "\\?")}">Open</a>`).test(html) && !html.includes(">Video type</th>") && !html.includes("john-hidden Long Project Avenue"), headers.join(" | "));
    c.ok("identity includes exact video labels and units while blocker and mixed stages remain visible", html.includes(kim.typeDetail) && html.includes("4 videos") && html.includes(kim.videoBreakdown!) && html.includes(kim.blocker!) && html.includes("Long Client Name"));
    c.ok("brief keeps all validated queue dimensions", html.split(`href="${briefHref}"`).length - 1 === 2 && html.includes("Filter by project stage") && html.includes("Filter by editor") && html.includes("Filter by due date"));
    const officeMenu = menus.find((m) => m.label === `More actions for ${kim.street}`);
    const item = (m: typeof officeMenu, id: string) => m?.items.find((x) => x.id === id);
    const pushed0 = pushes.length;
    item(officeMenu, "chat")?.onSelect();
    c.ok("chat opens the actual messages anchor with exact retained queue context", !!item(officeMenu, "chat") && pushes.length === pushed0 + 1 && pushes.at(-1) === `${briefHref}#messages`, pushes.at(-1));
    item(officeMenu, "copy")?.onSelect();
    await until(() => copied.length > 0);
    c.ok("exact folder URLs on the row, and the canonical link copied from its menu",
      html.includes(`<a href="${kim.rawUrl}" target="_blank" rel="noopener noreferrer" title="RAW footage folder — 8 files uploaded"`) &&
      html.includes(`<a href="${kim.finalUrl}" target="_blank" rel="noopener noreferrer" title="Final footage folder — 1 file in"`) &&
      JSON.stringify(copied) === JSON.stringify([kim.url]), copied.join(" | "));
    c.ok("office More and assignment controls survive; activity remains separate from Start",
      html.includes(`aria-label="More actions for ${kim.street}"`) && html.includes(`aria-label="Change editor for ${kim.street}: Kim"`) &&
      ["override", "remove"].every((id) => !!item(officeMenu, id)) &&
      html.includes("Kim uploaded a version · 12:14pm") && html.includes("not a Start. Only Start and Pause say someone is working."));
    search = "due=overdue&stage=changes";
    const own = renderToStaticMarkup(createElement(SimpleQueue, { notDone: [kim], upcoming: [], done: [], hideEditor: true }));
    const editorMenu = menus.filter((m) => m.label === `Files and chat for ${kim.street}`).at(-1);
    c.ok("editor queue retains four columns and no office reassignment or More controls",
      JSON.stringify([...own.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])) === JSON.stringify(["Project", "Progress", "Due", "Action"]) &&
      /title="Open editing brief"[^>]*>Fix revisions<\/a>/.test(own) && !own.includes("More actions") && !own.includes("Change editor") && !own.includes("uploaded a version") &&
      JSON.stringify(editorMenu?.items.map((x) => x.id)) === JSON.stringify(["chat", "copy"]), JSON.stringify(editorMenu?.items.map((x) => x.id)));

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
    // Oct 5 2026 (Jordan: every action must feel instant): the chooser folds at
    // the press and the desk names Job 0 as the current job at once
    // (useOptimistic), before the server answers. The pending lock is still
    // asserted: reopened through "Switch job", every other choice is disabled
    // until the answer lands, and so is Pause.
    c.ok("the pressed job shows as the current one at once, before the server answers", contains(tree(), `You’re on ${jobs[0].street}`) && !contains(tree(), "Exact fake Start confirmed.") && writes.length === 1, words(tree()).slice(0, 160));
    click("Switch job");
    c.ok("only explicit choice invokes the exact existing Start payload and locks pending choices", writes.length === 1 && writes[0].kind === "start" && writes[0].input.projectId === "job-0" && !!writes[0].input.requestId && button("Resume · Job 1").disabled === true && button("Pause").disabled === true);
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
