// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: bulk sessions, Oct 27 2026 (Jordan, for Rick Schultz's 48 videos).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-bulk-add-later.ts
//
// "On the upload portal, I want photographers to be able to add videos to the
//  session if they end up getting more videos done. So like it has all the
//  videos for that session, but then a drop-down to add more videos from
//  future sessions (if applicable)." And: "organize the Dropbox folder names".
//
//   1. Every topic carries its plan number (planNo): a bulk plan's script
//      number, which never shifts as earlier videos are filmed at other
//      sessions (session 2's first video was foldered "01", not "09").
//      A monthly client's numbers are their place on the month's list.
//   2. The folder engine names by that number, and makes folders for videos
//      ADDED from later sessions (alsoTopicIds); the upload action that asks
//      for them checks access first.
//   3. The upload page (its real render, fake actions): this session's videos
//      with their numbers; a drop-down grouped by later session with an
//      "All N from Session X"; choosing one ticks it, lists it under "Added
//      from later sessions", asks for its folder and shows the folder; tapping
//      it takes it off and it goes back in the drop-down. The last session
//      has no drop-down. The old folded list is gone.
//
// ISOLATION: PGlite via the shared harness; production and Dropbox are never
// opened (the folder action is a fake here).
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PrismaClient } from "@prisma/client";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
  navigation.usePathname = () => "/";
}

type El = { type: any; props: Record<string, any> };
function walk(n: any, visit: (e: El) => void) {
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isValidElement(n)) return;
  visit(n as unknown as El);
  for (const v of Object.values((n as unknown as El).props)) walk(v, visit);
}
const findBy = (tree: any, pred: (e: El) => boolean): El[] => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isValidElement(n)) words((n as unknown as El).props.children, out);
  return out;
}
// JSX splits "#{n}" and "({n} left)" into separate children; the page reads them as one.
const textOf = (n: any) => words(n).join(" ").replace(/\s+/g, " ").replace(/#\s+(\d)/g, "#$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

// The upload-portal-recovery-ui hooks harness: the real component, its real
// state and handlers, no DOM.
function mountHooks(render: () => unknown) {
  const react = load("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { effect(); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return {
    render() {
      index = 0;
      const internals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const before = internals.H;
      internals.H = dispatcher;
      try { const tree = render(); effects.splice(0).forEach((e) => e()); return tree; } finally { internals.H = before; }
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5843) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const lib = await import("@/lib/bulkPlan");
    const ft = await import("@/lib/filmedTopics");
    const CUR = etMonthKey();

    // ==================================================================
    c.head("1 · plan numbers");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Bulk Add TEST", package: "Accelerator", monthKey: CUR, project: false, enrollmentStatus: "PAUSED" });
    const staff = { email: "jordan@test", appUserId: null, name: "Jordan" };
    const start = new Date(Date.now() + 2 * 864e5);
    const { planId, monthId } = await lib.createBulkPlan({ enrollmentId: f.enrollmentId, totalVideos: 12, perSession: 4, cadenceDays: 7, startsOn: start, monthKey: CUR }, staff);
    const scripts = Array.from({ length: 12 }, (_, i) => ({ title: `Plan Video ${i + 1}`, hook: `Hook ${i + 1}.`, lines: [{ text: "Beat." }, { text: "Payoff." }], close: "Call first." }));
    await lib.importBulkScripts(planId, scripts, staff, { release: true });
    const sels = await prisma.contentTopicSelection.findMany({ where: { monthId }, orderBy: { rank: "asc" }, select: { id: true, rank: true, topicId: true } });
    const t = (rank: number) => sels[rank - 1].topicId;
    const mk = async (days: number) => {
      const p = await prisma.project.create({ data: { clientId: f.clientId, title: `Bulk shoot +${days}`, status: "SCHEDULED", shootDate: new Date(start.getTime() + days * 864e5), contentMonthId: monthId }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Full Day Content Shoot", productTitle: "Full Day Content Shoot", quantity: 1 } });
      return p.id;
    };
    const pA = await mk(0), pB = await mk(7);
    const sA = await ft.topicsForSession(pA);
    c.ok("every topic carries its plan number, the selection's rank (later sessions too)", (sA?.topics ?? []).length === 12 && (sA?.topics ?? []).every((x) => x.planNo === sels.find((s) => s.topicId === x.topicId)?.rank), (sA?.topics ?? []).map((x) => x.planNo).join(","));
    // Session 1 films 1-3 and pulls 6 ahead (like Rick's 9-30 and 32).
    const prep = await ft.prepareFilmingReport(pA, { filmedTopicIds: [t(1), t(2), t(3), t(6)] }, { name: "James", email: "james@test" });
    await prisma.contentFilmingReport.createMany({ data: [prep!.row], skipDuplicates: true });
    const rep = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId: pA, payloadHash: prep!.payloadHash } } });
    await ft.applyFilmingReport(rep.id);
    const sB = await ft.topicsForSession(pB);
    const nowB = (sB?.topics ?? []).filter((x) => !x.laterSession);
    c.ok("session 2's list starts at plan number 4 (carried) — not renumbered from 1", nowB[0]?.topicId === t(4) && nowB[0]?.planNo === 4, nowB.map((x) => `${x.planNo}`).join(","));
    c.ok("…and its numbers skip the one filmed early (5, 7, 8 — no 6)", nowB.map((x) => x.planNo).join(",") === "4,5,7,8", nowB.map((x) => x.planNo).join(","));
    const plain = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Monthly Plain TEST", package: "Accelerator", monthKey: CUR, project: true, topics: [{ title: "First topic", selection: "SELECTED" }, { title: "Second topic", selection: "SELECTED" }] });
    const sP = await ft.topicsForSession(plain.projectId!);
    c.ok("a monthly client's numbers are their place on the month's list (1, 2)", (sP?.topics ?? []).map((x) => x.planNo).join(",") === "1,2", (sP?.topics ?? []).map((x) => x.planNo).join(","));

    // ==================================================================
    c.head("2 · folder names and folders for added videos");
    const { topicFolderName } = await import("@/lib/dropboxFolders");
    c.ok("a folder is named by the plan number", topicFolderName(31, "Start With This Call, Not a Listing", "cmabcdefghijklmnopqrstuv") === "31 Start With This Call, Not a Listing [opqrstuv]");
    const folderSrc = fs.readFileSync(load.resolve("../../src/lib/dropboxFolders.ts"), "utf8");
    c.ok("the folder engine names by planNo, falling back to the list position", /rank: t\.planNo \?\? i \+ 1/.test(folderSrc));
    c.ok("…and a later session's video ADDED here gets its folder (alsoTopicIds)", /later: !!t\.laterSession && t\.confirmedOnProjectId !== projectId && !also\.has\(t\.topicId\)/.test(folderSrc));
    const actSrc = fs.readFileSync(load.resolve("../../src/app/upload/actions.ts"), "utf8");
    const act = actSrc.slice(actSrc.indexOf("export async function makeAddedTopicFolders"), actSrc.indexOf("export async function markDeliverableUploaded"));
    c.ok("the folder action checks upload access before anything else", /\{\s*await requireUploadAccess\(projectId\);/.test(act) && act.indexOf("requireUploadAccess") < act.indexOf("ensureTopicFolders"));
    c.ok("…and only passes id-shaped values, at most 60", /\/\^\[a-z0-9\]\{10,40\}\$\/i/.test(act) && /\.slice\(0, 60\)/.test(act));

    // ==================================================================
    c.head("3 · the upload page: the drop-down");
    const uploadActions = load.resolve("../../src/app/upload/actions.ts");
    const draftActions = load.resolve("../../src/app/upload/draftActions.ts");
    const calls: { name: string; args: any[] }[] = [];
    const fake = (impl: Record<string, (...a: any[]) => Promise<any>>) => new Proxy({ __esModule: true } as Record<string, unknown>, {
      get: (_t, k) => (k === "__esModule" ? true : k === "then" ? undefined : typeof k === "string"
        ? (...a: any[]) => { calls.push({ name: k, args: a }); return (impl[k] ?? (async () => ({ ok: true, message: "" })))(...a); }
        : undefined),
    });
    const put = (file: string, exports: unknown) => { load.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
    put(uploadActions, fake({
      makeAddedTopicFolders: async (_pid: string, ids: string[]) => ({ ok: true, folders: Object.fromEntries(ids.map((id) => [id, { label: `NN Folder ${id.slice(-4)}`, url: `https://www.dropbox.com/home/x/${id}` }])) }),
    }));
    put(draftActions, fake({}));
    const storage = new Map<string, string>();
    const local = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } };
    const g = globalThis as any;
    Object.defineProperty(g, "localStorage", { configurable: true, value: local });
    Object.defineProperty(g, "window", { configurable: true, value: { localStorage: local, scrollTo() {}, addEventListener() {}, removeEventListener() {}, confirm: () => true, location: { reload() {} } } });
    Object.defineProperty(g, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
    const { UploadPortal } = await import("@/components/upload/UploadPortal");
    const { videoStepSpec } = await import("@/lib/pipeline");
    const { submittedFieldsHash } = await import("@/lib/uploadDraft");

    const topic = (n: number, sessionNo: number, later: boolean) => ({
      topicId: `topicdrill${String(n).padStart(4, "0")}`, title: `Plan Video ${n}`, pillarName: null, scriptTitle: `Plan Video ${n}`, clientApproved: true,
      filmedConfirmedAtISO: null, filmedConfirmedBy: null, confirmedOnProjectId: null, overflow: false, note: null,
      folder: later ? null : { label: `${String(n).padStart(2, "0")} Plan Video ${n} [x]`, url: "https://www.dropbox.com/home/y" },
      sessionNo, laterSession: later, planNo: n,
    });
    const id = (n: number) => `topicdrill${String(n).padStart(4, "0")}`;
    const project: any = { id: "bulk-upload-drill", title: "1 Bulk Way, Testville", addressLine: "1 Bulk Way", city: null, state: null, zip: null, packageName: "Full Day Content Shoot", shootDate: new Date().toISOString(), status: "SCHEDULED", editorBrief: null, uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Bulk Client TEST", clientAvatarUrl: null, customerNote: null, photographerName: "James Drill", cullingConfirmedAt: null, shotOrderNotes: null, removalNotes: null, videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
    const draftPayload = { editorBrief: "", checks: { coverage: false, culling: false, quality: false, count: false }, removal: "", nothingToRemove: false, orderChoice: null, orderNotes: "", vidStyle: null, vidSections: {}, videosFilmed: "", filmedTopicIds: [], topicNotes: {}, extraRows: [], scriptChoice: null, scriptText: "", scriptNote: "", captured: ["video"] };
    const propsFor = (topics: any[], bulk: any) => ({
      project, deliverables: [{ id: "full-day", type: "VIDEO", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null }],
      specialRequests: [], flags: [],
      policy: { photosOrdered: false, videoOrdered: true, photoTarget: 0, range: { low: 0, high: 0, upper: null }, rangeMode: "sop", squareFeet: null, squareFeetBand: null, videoSpec: videoStepSpec(["Full Day Content Shoot"], { hasFullVideo: false, isMonthly: true }), videoStyle: "personal_branding", isPremium: false },
      script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] },
      viewerIsOffice: false, payGateFromMs: 0, sessionTopics: { owed: 12, bulk, topics, pending: null }, topicsUnavailable: false,
      draft: { revision: 1, payload: draftPayload, savedAtISO: new Date().toISOString(), baseHash: null }, draftRevision: 1, canSaveDraft: true,
      baseHash: submittedFieldsHash({ editorBrief: null, videoInstructions: null, removalNotes: null, shotOrderNotes: null, reelScript: null, scriptConfirmNote: null, videosFilmed: null }),
      evidence: [], gaps: [], fieldReports: [], nowMs: Date.now(),
    });
    // Session 2 of 3: 4, 5, 7, 8 today; 9-12 in session 3.
    const props: any = propsFor([topic(4, 2, false), topic(5, 2, false), topic(7, 2, false), topic(8, 2, false), topic(9, 3, true), topic(10, 3, true), topic(11, 3, true), topic(12, 3, true)], { sessionNo: 2, perSession: 4, sessions: 3 });
    const portal = mountHooks(() => (UploadPortal as any)(props));
    let tree = portal.render();
    await tick();
    tree = portal.render();
    const select = () => findBy(tree, (e) => e.type === "select" && /^add-later-/.test(e.props.id ?? ""))[0];
    const html = () => renderToStaticMarkup(createElement((UploadPortal as any), props));
    const all = textOf(tree);
    c.ok("this session's videos are listed with their plan numbers", /#4 Plan Video 4/.test(all) && /#8 Plan Video 8/.test(all) && /Session 2 of 3 · 4 planned for today/.test(all), all.slice(all.indexOf("Session 2 of"), all.indexOf("Session 2 of") + 80));
    c.ok("later sessions' videos are NOT in the list until added", !findBy(tree, (e) => e.type === "button" && /Plan Video 9\b/.test(textOf(e.props.children))).length);
    c.ok("the old folded list is gone", !/Filmed one from a later session/.test(all) && !/Filmed one from a later session/.test(html()));
    const opts = () => findBy(select(), (e) => e.type === "option").map((o) => ({ value: o.props.value, label: textOf(o.props.children) }));
    const groups = findBy(select(), (e) => e.type === "optgroup").map((o) => o.props.label);
    c.ok("a drop-down to add more, grouped by session, with an 'All 4 from Session 3'", !!select() && /Got more videos done\? Add them from later sessions/.test(all) && groups.join(",") === "Session 3" && opts().some((o) => o.value === "session:3" && o.label === "All 4 from Session 3"), JSON.stringify(opts()));
    c.ok("…each option is the video's number and title", opts().some((o) => o.value === id(9) && o.label === "#9 Plan Video 9") && opts()[0].label === "Choose a video to add (4 left)", JSON.stringify(opts().slice(0, 3)));

    select().props.onChange({ target: { value: id(9) } });
    await tick();
    tree = portal.render();
    const folderCall = calls.find((x) => x.name === "makeAddedTopicFolders");
    c.ok("choosing one asks for its Dropbox folder right away", !!folderCall && folderCall.args[0] === project.id && JSON.stringify(folderCall.args[1]) === JSON.stringify([id(9)]), JSON.stringify(folderCall?.args));
    const added = textOf(tree);
    c.ok("…it is listed under 'Added from later sessions', ticked, with its number and session", /Added from later sessions/.test(added) && /#9 Plan Video 9/.test(added) && /from Session 3/.test(added) && /Session 2 of 3 · 4 planned for today · 1 added/.test(added));
    const btn9 = () => findBy(tree, (e) => e.type === "button" && /Plan Video 9\b/.test(textOf(e.props.children)))[0];
    c.ok("…ticked (pressed), with the folder the action made", btn9()?.props["aria-pressed"] === true && findBy(tree, (e) => e.type === "a" && e.props.href === `https://www.dropbox.com/home/x/${id(9)}`).length === 1);
    c.ok("…and the drop-down no longer offers it (3 left)", !opts().some((o) => o.value === id(9)) && opts()[0].label === "Choose a video to add (3 left)");

    select().props.onChange({ target: { value: "session:3" } });
    await tick();
    tree = portal.render();
    c.ok("'All from Session 3' adds the rest in one go — and the drop-down goes when nothing is left", [10, 11, 12].every((n) => findBy(tree, (e) => e.type === "button" && e.props["aria-pressed"] === true && new RegExp(`Plan Video ${n}\\b`).test(textOf(e.props.children))).length === 1) && !select(), JSON.stringify(calls.filter((x) => x.name === "makeAddedTopicFolders").map((x) => x.args[1])));
    btn9().props.onClick();
    tree = portal.render();
    c.ok("tapping an added one takes it off — back in the drop-down", !btn9() && !!select() && opts().some((o) => o.value === id(9)));

    const last = mountHooks(() => (UploadPortal as any)(propsFor([topic(9, 3, false), topic(10, 3, false)], { sessionNo: 3, perSession: 4, sessions: 3 })));
    let lt = last.render();
    await tick();
    lt = last.render();
    c.ok("the last session has no drop-down (nothing later to add)", !findBy(lt, (e) => e.type === "select" && /^add-later-/.test(e.props.id ?? "")).length && /#9 Plan Video 9/.test(textOf(lt)));

    c.ok("nothing left the building", fence.faked.length === 0 && fence.blocked.length === 0, fence.blocked.slice(0, 3).join(" | "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
