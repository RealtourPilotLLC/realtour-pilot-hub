// ---------------------------------------------------------------------------
// DRILL C2: THE EDITOR'S DESK — "who is working now", made obvious from the
// editor's side (Jordan, Sep 28: "the working on now button for the editors
// needs to be clearer … It says Kim is not working on anything, but I believe
// he is!").
//
//   cd <worktree> && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/c2-editor-desk.ts
//
// Drives the SHIPPED code (lib/editorDesk, lib/editorWork through the real
// server actions, the /editing page's element tree) against an isolated
// PGlite on 127.0.0.1:DRILL_PORT (default 5832). Production is never opened;
// every outbound call is fenced and counted. The three client components are
// RENDERED to HTML in a child process (react-dom/server, no react-server
// condition), with their server actions replaced by no-ops, so the words an
// editor actually reads are asserted — beside the same files at a2f8484.
//
//   §0  OLD (a2f8484): the desk drew NOTHING for an editor on nothing — Kim
//       had no Start button on his page; the bar's switch took two taps; the
//       uploader never asked; the clock was Eastern
//   §1  toDeskJobs: keep/drop and the note words for every status; claims
//   §2  deskClock: the editor's own timezone, the office's Eastern
//   §3  barWords: every sentence of the job-page bar
//   §4  stillWorkingRemaining
//   §5  the desk, rendered: the question + job buttons; one bar with Pause /
//       Switch; a failed read; nothing to edit; a preview; claims
//   §6  /editing as Kim, Jordan-as-Kim and Jordan (the element tree)
//   §7  the post-upload "Yes": Start stamped at the press, never back-dated,
//       the editor as actor, quiet, idempotent; a second Yes is a no-op; a
//       preview is refused; who may be asked at all
//   §8  switching pauses the previous job, in one transaction — and the
//       paused multi-video job STAYS on the desk while a video is owed
//   §9  never automatic (sources + a hand-in on a job never started)
//   §10 the Sep 28 review, one finding each: a resume keeps the picked video;
//       a hand-in never ends a Start pressed after it, and the browser's
//       finish settles the close before it answers; the prompt counts only
//       videos really owed; a desk Start only where the server takes it
//
// THE CLOCK IS PINNED to Mon Sep 28 2026 12:34pm ET (16:34Z) — the moment
// Jordan read "Kim — Not on anything" — and runs forward from there, except
// where §7 freezes it to prove a timestamp to the millisecond.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module, { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5832);
const BASE = "a2f8484";
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const DAY = 86_400_000;
const cjs = createRequire(__filename);

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 28, 16, 34, 0); // Mon Sep 28 2026 12:34pm ET
let clockOffsetMs = PARK - RealDate.now();
let frozenAt: number | null = null;
const drillNow = () => frozenAt ?? RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
/** Stop the clock at an instant (so a stamp can be compared exactly)… */
const freeze = (iso: string) => { frozenAt = RealDate.parse(iso); };
/** …and let it run on from there. */
const thaw = () => { if (frozenAt !== null) clockOffsetMs = frozenAt - RealDate.now(); frozenAt = null; };
const Z = (hhmm: string, day = 28) => `2026-09-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`;

installNextStubs();
const fence = fenceFetch();
// lucide-react and next/link build React contexts at import time, which the
// react-server build of React does not have; the element walk never renders.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    if (request === "next/link") return { __esModule: true, default: () => null };
    return prev.call(this, request, parent, isMain);
  };
}

// ---- the render harness (a child process, no react-server condition) -----
const CACHE = path.join(REPO, "node_modules/.cache", "c2-editor-desk");
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

type RenderCase = { name: string; file: string; exp: string; props: Record<string, unknown>; fns?: string[]; openChooser?: boolean };
function baselineFile(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`);
  // Outside the tsconfig's reach (node_modules/.cache) tsx compiles JSX with
  // the classic runtime, so the old file gets the React binding it assumes.
  fs.writeFileSync(out, `import * as React from "react";\n${src.replace(/(["'])@\//g, `$1${REPO}/src/`)}`);
  return out;
}
function render(cases: RenderCase[], nowISO: string): Record<string, string> {
  fs.mkdirSync(CACHE, { recursive: true });
  const seed = path.join(CACHE, "seed.cjs");
  // Seeds the module cache (the _client-drill-preload pattern): the router,
  // the link and the three work actions are stand-ins, so a render can never
  // reach a server action. Expanded cases initialize the chooser hook only,
  // preserving the default render alongside the requested chooser render.
  fs.writeFileSync(seed, `/* eslint-disable */
const Module = require("module");
const path = require("path");
const root = ${JSON.stringify(REPO)};
const put = (file, exports) => { const m = new Module(file, null); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m; };
const React = require(require.resolve("react", { paths: [root] }));
put(require.resolve("next/navigation", { paths: [root] }), { useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams(), redirect() { throw new Error("redirect"); }, notFound() { throw new Error("notFound"); } });
put(require.resolve("next/link", { paths: [root] }), { __esModule: true, default: (p) => React.createElement("a", { href: p.href, className: p.className }, p.children) });
const originalState = React.useState;
React.useState = (initial) => { const index = globalThis.C2_STATE_INDEX++; return originalState(globalThis.C2_OPEN_CHOOSER && index === 2 ? true : initial); };
const noop = async () => ({ ok: true, message: "" });
put(path.join(root, "src/app/editing/workActions.ts"), { __esModule: true, startEditingAction: noop, pauseEditingAction: noop, confirmCurrentWorkAction: noop });
`);
  const runner = path.join(CACHE, "render.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const RealDate = Date;
const NOW = RealDate.parse(process.env.C2_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const cases = JSON.parse(require("fs").readFileSync(process.env.C2_CASES as string, "utf8"));
const out: Record<string, string> = {};
for (const c of [...cases, ...cases.filter((c) => c.exp === "EditorDesk").map((c) => ({ ...c, name: c.name + "Open", openChooser: true }))]) {
  globalThis.C2_STATE_INDEX = 0; globalThis.C2_OPEN_CHOOSER = !!c.openChooser;
  try {
    const props = { ...c.props };
    for (const k of c.fns ?? []) props[k] = () => {};
    out[c.name] = renderToStaticMarkup(createElement(require(c.file)[c.exp], props));
  } catch (e) {
    out[c.name] = "RENDER_ERROR: " + (e as Error).message;
  }
}
process.stdout.write("\\n@@C2@@" + JSON.stringify(out));
`);
  const casesFile = path.join(CACHE, `cases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  const res = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [runner], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: {
      ...process.env,
      // Quoted: the repo folder name has spaces ("Realtour Pilot POT Dashboard"),
      // and NODE_OPTIONS splits on them unless a path is double-quoted.
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "scripts/_drill/_client-drill-preload.cjs"))} --require ${JSON.stringify(seed)}`,
      C2_NOW: nowISO,
      C2_CASES: casesFile,
    },
  });
  const at = res.lastIndexOf("@@C2@@");
  return at >= 0 ? (JSON.parse(res.slice(at + 6)) as Record<string, string>) : {};
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const desk = await import("@/lib/editorDesk");
  const work = await import("@/lib/editorWork");
  const workActions = await import("@/app/editing/workActions");
  const queue = await import("@/lib/editorQueue");
  const { setSession } = await import("@/lib/auth/session");
  type WorkBar = import("@/lib/editorWork").WorkBar;
  type WorkPerson = import("@/lib/editorWork").WorkPerson;
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
  const EDITOR_DESK = path.join(REPO, "src/components/editing/EditorDesk.tsx");
  const WORK_BAR = path.join(REPO, "src/components/editing/WorkStateBar.tsx");
  const PROMPT = path.join(REPO, "src/components/editing/StillWorkingPrompt.tsx");

  // =========================================================================
  c.head(`§0 · the OLD desk, bar and uploader, from ${BASE}`);
  // =========================================================================
  const oldDesk = baselineFile("src/components/editing/EditorDesk.tsx");
  const oldBar = baselineFile("src/components/editing/WorkStateBar.tsx");
  const personKim = (sinceISO: string | null, extra: Partial<WorkPerson> = {}): WorkPerson => ({
    editorKey: "kim", name: "Kim", outputId: null, outputTitle: null, sinceISO, firstStartedISO: sinceISO,
    lastEventISO: sinceISO ?? Z("16:00"), lastEventKind: "START", onBehalfBy: null, ...extra,
  });
  const bar = (o: Partial<WorkBar>): WorkBar => ({
    projectId: "p107", street: "107 E Old Baltimore Pike", mode: "editor",
    mine: { state: null, sinceISO: null, outputId: null }, elsewhere: null, people: { active: [], paused: [] },
    canStart: true, blocked: null, assignee: null, outputs: [], stageWork: null, ...o,
  });
  const old = render(
    [
      { name: "deskIdle", file: oldDesk, exp: "EditorDesk", props: { active: null, unconfirmed: [] } },
      { name: "barIdle", file: oldBar, exp: "WorkStateBar", props: { bar: bar({}) } },
      { name: "barActive", file: oldBar, exp: "WorkStateBar", props: { bar: bar({ mine: { state: "ACTIVE", sinceISO: Z("16:40"), outputId: null } }) } },
    ],
    Z("16:45"),
  );
  c.ok("old: an editor on nothing got an EMPTY desk — no Start button anywhere on Kim's Editing Room", old.deskIdle === "", JSON.stringify(old.deskIdle).slice(0, 80));
  c.ok("old: the job-page bar said \"Not started — press Start editing when you begin\" plus the fine print",
    text(old.barIdle ?? "").includes("Not started — press Start editing when you begin") && text(old.barIdle ?? "").includes("not a timer"), text(old.barIdle ?? "").slice(0, 120));
  c.ok("old: Kim's own Start read in EASTERN time — \"since 12:40pm\" for a press at 12:40am in Manila",
    text(old.barActive ?? "").includes("since 12:40pm"), text(old.barActive ?? "").slice(0, 80));
  const oldBarSrc = execFileSync("git", ["show", `${BASE}:src/components/editing/WorkStateBar.tsx`], { cwd: REPO, encoding: "utf8" });
  c.ok("old: switching jobs from the bar took two taps (\"Pause it and start this\")", oldBarSrc.includes("Pause it and start this"));
  const oldUploader = execFileSync("git", ["show", `${BASE}:src/components/editing/CutUploader.tsx`], { cwd: REPO, encoding: "utf8" });
  c.ok("old: an upload never asked whether the editor was still on the job", !/StillWorking|stillWorking/.test(oldUploader));

  // =========================================================================
  c.head("§1 · toDeskJobs: which jobs go on the desk, and what each one says");
  // =========================================================================
  {
    const wp = (key: string, name: string, sinceISO: string | null) => ({ key, name, sinceISO, outputTitle: null, onBehalfBy: null });
    type R = Parameters<typeof desk.toDeskJobs>[0][number];
    const row = (id: string, status: string, extra: Partial<R> = {}): R => ({
      id, street: `${id} St`, dueISO: Z("21:00", 29), late: false, status, held: false, videoBreakdown: null, videosToEdit: 0, startableBy: null,
      work: { active: [], paused: [] }, ...extra,
    });
    const rows: R[] = [
      row("wait", "Waiting"),
      row("instr", "Waiting on instructions", { videosToEdit: 2, work: { active: [], paused: [wp("kim", "Kim", Z("05:30"))] } }),
      // 107 E's shape (Sep 28 review): video 3 waits on a verdict, video 4 is
      // still Kim's to make — the pill reads the loudest state.
      row("rfr", "Ready for review", { videoBreakdown: "1 ready for review · 3 more to edit", videosToEdit: 3 }),
      row("rfrDone", "Ready for review", { videoBreakdown: "1 ready for review · 3 approved", videosToEdit: 0 }),
      row("appr", "Approved"),
      row("done", "Completed"),
      row("ready", "Ready for editing", { videoBreakdown: "2 approved · 2 more to edit", videosToEdit: 2, startableBy: ["kim"] }),
      row("ready1", "Ready for editing", { late: true, dueISO: Z("21:00", 27) }),
      row("inedit", "In editing", { work: { active: [wp("john", "John Mark", Z("15:00"))], paused: [] } }),
      row("pausedMine", "Paused", { work: { active: [], paused: [wp("kim", "Kim", Z("02:10"))] }, videoBreakdown: "1 approved · 1 more to edit" }),
      row("pausedJohn", "Paused", { work: { active: [], paused: [wp("john", "John Mark", Z("03:00"))] }, videoBreakdown: "1 approved · 1 more to edit" }),
      row("rev", "Revisions", { videoBreakdown: "1 in revisions · 1 approved" }),
      row("check", "Check needed"),
      row("extra", "Extra video owed"),
      row("unconf", "In editing — not confirmed"),
      row("held", "Ready for editing", { held: true }),
      row("revPausedMine", "Revisions", { work: { active: [], paused: [wp("kim", "Kim", Z("04:00"))] } }),
      row("rfr1", "Ready for review", { videoBreakdown: "2 approved · 1 ready for review · 1 more to edit", videosToEdit: 1 }),
      row("apprPausedMine", "Approved", { work: { active: [], paused: [wp("kim", "Kim", Z("05:00"))] } }),
      row("rfrPausedJohn", "Ready for review", { work: { active: [], paused: [wp("john", "John Mark", Z("05:10"))] } }),
      // Finding 6's shape: an extra video filed on a delivered job — no edit
      // card, no revision, no owner — routed to Kim by Project.editor.
      row("extraNoHolder", "Extra video owed", { startableBy: [] }),
      row("revJohnsTask", "Revisions", { startableBy: ["john"] }),
    ];
    const claims = [
      { projectId: "unconf", street: "unconf St", claimedAt: null },
      { projectId: "legacy", street: "77 Legacy Rd", claimedAt: Z("12:00", 20) },
    ];
    const jobs = desk.toDeskJobs(rows, "kim", claims);
    const ids = jobs.map((j) => j.projectId);
    c.ok("dropped: Waiting, Waiting on instructions (even paused), a Ready for review / Approved with nothing left for Kim, Completed and a held row; the rest kept IN ORDER, the legacy claim appended",
      JSON.stringify(ids) === JSON.stringify(["rfr", "ready", "ready1", "inedit", "pausedMine", "pausedJohn", "rev", "check", "extra", "unconf", "revPausedMine", "rfr1", "apprPausedMine", "extraNoHolder", "revJohnsTask", "legacy"]), ids.join(","));
    const by = new Map(jobs.map((j) => [j.projectId, j]));
    const note = (id: string) => by.get(id)?.note ?? null;
    c.ok("notes: \"Revisions to do\", \"Finish the review check\", \"Extra video\", \"Marked In editing — not confirmed\"",
      note("rev") === "Revisions to do" && note("check") === "Finish the review check" && note("extra") === "Extra video" && note("unconf") === "Marked In editing — not confirmed");
    c.ok("anything else says its per-video line, or nothing", note("ready") === "2 approved · 2 more to edit" && note("ready1") === null && note("inedit") === null && note("pausedJohn") === "1 approved · 1 more to edit");
    c.ok("a Paused row that is MINE has no note (its button says \"Paused {time}\") and carries my pause time",
      note("pausedMine") === null && by.get("pausedMine")?.pausedSinceISO === Z("02:10"));
    c.ok("somebody else's pause is not mine", by.get("pausedJohn")?.pausedSinceISO === null);
    c.ok("my pause on a Revisions row still rides along, with the row's own words", by.get("revPausedMine")?.pausedSinceISO === Z("04:00") && note("revPausedMine") === "Revisions to do");
    c.ok("a claim on a row is flagged on that row; an off-list claim is appended with no date and the not-confirmed words",
      by.get("unconf")?.claim === true && by.get("ready")?.claim === false &&
      JSON.stringify(by.get("legacy")) === JSON.stringify({ projectId: "legacy", street: "77 Legacy Rd", dueISO: null, late: false, note: "Marked In editing — not confirmed", pausedSinceISO: null, claim: true, startable: true }));
    c.ok("due and late ride through untouched", by.get("ready1")?.late === true && by.get("ready1")?.dueISO === Z("21:00", 27));
    c.ok("REVIEW F1/F9: a job whose cut waits on review STAYS while videos are still Kim's — \"3 more videos to edit\" / \"1 more video to edit\", from the NUMBER (not the words)",
      note("rfr") === "3 more videos to edit" && note("rfr1") === "1 more video to edit" && by.get("rfr")?.startable === true);
    c.ok("…and one Kim PAUSED stays even with nothing left to make (his own Pause is never hidden); John's pause keeps nothing on Kim's desk",
      by.get("apprPausedMine")?.pausedSinceISO === Z("05:00") && note("apprPausedMine") === null && !by.has("rfrPausedJohn") && !by.has("rfrDone"));
    c.ok("REVIEW F6: a row startEditing would refuse is on the list but NOT startable (no edit card / revision / video of Kim's; John's revision)",
      by.get("extraNoHolder")?.startable === false && by.get("revJohnsTask")?.startable === false &&
      by.get("ready")?.startable === true && by.get("ready1")?.startable === true /* null = not read → left to the server */ && by.get("legacy")?.startable === true);
    c.ok("deskHeader counts what Kim can START, with the late ones: 14 startable of 16 on the desk, 1 late",
      desk.deskHeader(jobs) === "14 projects to edit · 1 late", desk.deskHeader(jobs));
    const only107 = desk.toDeskJobs([row("a107", "Ready for review", { videoBreakdown: "2 approved · 1 ready for review · 1 more to edit", videosToEdit: 1, startableBy: ["kim"] })], "kim", []);
    c.ok("REVIEW F1 case 2: 107 E as his ONLY job, video 3 in review, video 4 owed → one desk button and a header of \"1 to edit\", never \"Nothing to edit right now\"",
      only107.length === 1 && only107[0].note === "1 more video to edit" && desk.deskHeader(only107) === "1 project to edit", desk.deskHeader(only107));
    c.ok("…nothing startable → \"Nothing to edit right now\" (an empty desk, or only jobs not handed over yet)",
      desk.deskHeader([]) === "Nothing to edit right now" && desk.deskHeader(desk.toDeskJobs([row("x", "Extra video owed", { startableBy: [] })], "kim", [])) === "Nothing to edit right now");
    const fromQueue = new Set([...queue.WAITING_ON_OFFICE, queue.WAITING_ON_FOOTAGE, queue.WAITING_ON_INSTRUCTIONS, "Completed"]);
    const ours = new Set<string>(desk.DESK_EXCLUDED);
    c.ok("DESK_EXCLUDED is exactly editorQueue's WAITING_ON_OFFICE ∪ {WAITING_ON_FOOTAGE, WAITING_ON_INSTRUCTIONS} ∪ {Completed}",
      fromQueue.size === ours.size && [...fromQueue].every((s) => ours.has(s)), [...ours].join(" | "));
  }

  // =========================================================================
  c.head("§2 · deskClock: the editor's own timezone");
  // =========================================================================
  const now1645 = new RealDate(Z("16:45"));
  c.ok("16:40Z in Manila, read at 16:45Z → \"12:40am\" (the same Manila day)", desk.deskClock(Z("16:40"), "Asia/Manila", now1645) === "12:40am", desk.deskClock(Z("16:40"), "Asia/Manila", now1645));
  c.ok("the day before → \"Sep 28 12:40am\"", desk.deskClock(Z("16:40", 27), "Asia/Manila", now1645) === "Sep 28 12:40am", desk.deskClock(Z("16:40", 27), "Asia/Manila", now1645));
  c.ok("the office's Eastern → \"12:40pm\"", desk.deskClock(Z("16:40"), "America/New_York", now1645) === "12:40pm");
  c.ok("…the same words editorWork.workClock prints for the office", desk.deskClock(Z("16:40"), desk.OFFICE_TZ, now1645) === work.workClock(Z("16:40"), now1645) && desk.deskClock(Z("16:40", 26), desk.OFFICE_TZ, now1645) === work.workClock(Z("16:40", 26), now1645));
  c.ok("nothing → \"\"", desk.deskClock(null, "Asia/Manila", now1645) === "");
  c.ok("REVIEW F2/F10: yourClock SAYS whose clock it is — \"12:40am your time\" in Manila; Eastern needs no label; nothing → \"\"",
    desk.yourClock(Z("16:40"), "Asia/Manila", now1645) === "12:40am your time" && desk.yourClock(Z("16:40"), desk.OFFICE_TZ, now1645) === "12:40pm" && desk.yourClock(null, "Asia/Manila", now1645) === "",
    desk.yourClock(Z("16:40"), "Asia/Manila", now1645));

  // =========================================================================
  c.head("§3 · barWords: every sentence on the job page's bar");
  // =========================================================================
  {
    const W = (b: WorkBar, tz = "Asia/Manila") => desk.barWords(b, tz, now1645);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const a1 = W(bar({ mine: { state: "ACTIVE", sinceISO: Z("16:40"), outputId: null } }));
    c.ok("editor ACTIVE → \"You're on this job since 12:40am your time\" (Manila, labelled) + Pause", same(a1, { state: "You're on this job since 12:40am your time", sub: null, button: "pause" }), JSON.stringify(a1));
    c.ok("…with no start time on record → \"You're on this job\"", W(bar({ mine: { state: "ACTIVE", sinceISO: null, outputId: null } })).state === "You're on this job");
    const e1 = W(bar({ elsewhere: { projectId: "p22", street: "22 Switch Ave" } }));
    c.ok("on another job → \"You're on 22 Switch Ave now.\" / \"Switching pauses 22 Switch Ave.\" + Switch",
      same(e1, { state: "You're on 22 Switch Ave now.", sub: "Switching pauses 22 Switch Ave.", button: "switch" }), JSON.stringify(e1));
    const e2 = W(bar({ elsewhere: { projectId: "p22", street: "22 Switch Ave" }, mine: { state: "PAUSED", sinceISO: Z("16:10"), outputId: null } }));
    c.ok("…and this one paused → the sub starts \"This job is paused. \"", e2.sub === "This job is paused. Switching pauses 22 Switch Ave." && e2.button === "switch");
    const p1 = W(bar({ mine: { state: "PAUSED", sinceISO: Z("16:40"), outputId: null } }));
    c.ok("editor PAUSED → \"Paused at 12:40am your time.\" / \"Everything on it is where you left it.\" + Resume",
      same(p1, { state: "Paused at 12:40am your time.", sub: "Everything on it is where you left it.", button: "resume" }), JSON.stringify(p1));
    c.ok("idle and startable → \"Working on this job now?\" + Start", same(W(bar({})), { state: "Working on this job now?", sub: null, button: "start" }));
    c.ok("blocked → the server's reason, no button", same(W(bar({ canStart: false, blocked: "Assigned to John Mark — not yours to start." })), { state: "Assigned to John Mark — not yours to start.", sub: null, button: null }));
    c.ok("blocked with no reason → \"Not yours to start.\"", same(W(bar({ canStart: false })), { state: "Not yours to start.", sub: null, button: null }));
    c.ok("a blocked editor is never offered Switch, even while on another job",
      W(bar({ canStart: false, blocked: "Held in Waiting by the office — it can't be started until the footage is in.", elsewhere: { projectId: "p22", street: "22 Switch Ave" } })).button === null);
    const off = (people: WorkBar["people"], mode: WorkBar["mode"] = "office") => W(bar({ mode, people, canStart: mode === "office" }), "Asia/Manila");
    c.ok("office, one on it → \"Kim on this job since 12:40pm\" — ET whatever tz is passed", same(off({ active: [personKim(Z("16:40"))], paused: [] }), { state: "Kim on this job since 12:40pm", sub: null, button: null }));
    c.ok("office, two on it → \"Kim, John Mark on this job\"",
      off({ active: [personKim(Z("16:40")), { ...personKim(Z("16:20")), editorKey: "john", name: "John Mark" }], paused: [] }).state === "Kim, John Mark on this job");
    c.ok("office, paused → \"Paused — Kim at 12:40pm\"", off({ active: [], paused: [personKim(Z("16:40"))] }).state === "Paused — Kim at 12:40pm");
    c.ok("office, nobody → \"Nobody has pressed Start on this job\"", off({ active: [], paused: [] }).state === "Nobody has pressed Start on this job");
    c.ok("a read-only view never gets a button", off({ active: [], paused: [] }, "view").button === null && off({ active: [personKim(Z("16:40"))], paused: [] }, "view").button === null);
  }

  // =========================================================================
  c.head("§4 · stillWorkingRemaining");
  // =========================================================================
  c.ok("three open, one just sent → 2", desk.stillWorkingRemaining(["d:1", "d:2", "d:3"], "d:3") === 2);
  c.ok("the only open one just sent → 0 (no prompt)", desk.stillWorkingRemaining(["d:3"], "d:3") === 0);
  {
    const sl = (n: number, status: string | null, o: Partial<import("@/lib/editorDesk").SlotForAsk> = {}) =>
      ({ key: `d:${n}`, status, held: false, approvedAtISO: status === "APPROVED" ? Z("12:00", 26) : null, ...o });
    const afterApproval = new Map([["d:2", Z("09:00", 27)]]);
    const fix = desk.openSlotKeys([sl(1, "APPROVED"), sl(2, "PENDING"), sl(3, "APPROVED"), sl(4, "APPROVED")], afterApproval);
    c.ok("REVIEW F11: 4 approved, the client asks again about video 2, Kim uploads its fix → NOTHING owed (the old rule said 3)",
      fix.length === 0 && desk.stillWorkingRemaining(fix, "d:2") === 0, JSON.stringify(fix));
    const v4 = desk.openSlotKeys([sl(1, "APPROVED"), sl(2, "APPROVED"), sl(3, "APPROVED"), sl(4, "PENDING")], new Map([["d:1", Z("09:00", 27)]]));
    c.ok("…videos 1-3 approved, an ask about video 1, Kim sends video 4 → 1 more (video 1), not 3", desk.stillWorkingRemaining(v4, "d:4") === 1 && v4[0] === "d:1", JSON.stringify(v4));
    c.ok("…an ask raised BEFORE the approval (the fix was approved, the task not closed yet) owes nothing",
      desk.openSlotKeys([sl(1, "APPROVED")], new Map([["d:1", Z("09:00", 25)]])).length === 0);
    c.ok("…empty, sent back, withdrawn and held-for-check are open; a PENDING in review is not",
      JSON.stringify(desk.openSlotKeys([sl(1, null), sl(2, "CHANGES_REQUESTED"), sl(3, "WITHDRAWN"), sl(4, "PENDING", { held: true }), sl(5, "PENDING")], new Map())) === JSON.stringify(["d:1", "d:2", "d:3", "d:4"]));
  }

  // =========================================================================
  c.head("§5 · the desk, the bar and the prompt, RENDERED (what the editor reads)");
  // =========================================================================
  {
    const dj = (id: string, street: string, o: Partial<import("@/lib/editorDesk").DeskJob> = {}) => ({
      projectId: id, street, dueISO: Z("21:00", 29), late: false, note: null, pausedSinceISO: null, claim: false, startable: true, ...o,
    });
    const jobs = [
      dj("p107", "107 E Old Baltimore Pike", { note: "2 approved · 2 more to edit" }),
      dj("p22", "22 Switch Ave", { late: true, dueISO: Z("21:00", 27) }),
      dj("p3", "3 Paused Pl", { pausedSinceISO: Z("16:10"), dueISO: null }),
      dj("p4", "4 Four St"), dj("p5", "5 Five St"), dj("p6", "6 Six St"), dj("p7", "7 Seven St"),
    ];
    const activeWork = { projectId: "p107", street: "107 E Old Baltimore Pike", sinceISO: Z("16:40"), outputTitle: null };
    const r = render(
      [
        { name: "idle", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs, tz: "Asia/Manila" } },
        { name: "active", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: activeWork, unconfirmed: [] }, jobs, tz: "Asia/Manila" } },
        { name: "failed", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: null, jobs: jobs.slice(0, 2), tz: "Asia/Manila" } },
        { name: "empty", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [], tz: "Asia/Manila" } },
        { name: "preview", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: jobs.slice(0, 2), tz: "Asia/Manila", readOnly: true } },
        { name: "previewActive", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: activeWork, unconfirmed: [] }, jobs, tz: "Asia/Manila", readOnly: true } },
        { name: "claims", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [dj("pc", "33 Legacy Rd", { claim: true, note: "Marked In editing — not confirmed" })], tz: "Asia/Manila" } },
        { name: "barIdle", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ outputs: [{ id: "o1", title: "Video 1" }, { id: "o2", title: "Video 2" }] }), tz: "Asia/Manila" } },
        { name: "barActive", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ mine: { state: "ACTIVE", sinceISO: Z("16:40"), outputId: null } }), tz: "Asia/Manila" } },
        { name: "barSwitch", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ elsewhere: { projectId: "p22", street: "22 Switch Ave" } }), tz: "Asia/Manila" } },
        { name: "barOffice", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ mode: "office", assignee: { key: "kim", name: "Kim" }, people: { active: [personKim(Z("16:40"), { onBehalfBy: "Jordan Spackman" })], paused: [] } }), tz: "America/New_York" } },
        { name: "barView", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ mode: "view", canStart: false }), tz: "America/New_York" } },
        { name: "prompt1", file: PROMPT, exp: "StillWorkingPrompt", props: { projectId: "p107", remaining: 1, elsewhereStreet: null }, fns: ["onClose"] },
        { name: "prompt3", file: PROMPT, exp: "StillWorkingPrompt", props: { projectId: "p107", remaining: 3, elsewhereStreet: "22 Switch Ave" }, fns: ["onClose"] },
        // The Sep 28 review's shapes.
        { name: "activeClaims", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: activeWork, unconfirmed: [] }, jobs: [jobs[0], dj("pc", "33 Legacy Rd", { claim: true, note: "Marked In editing — not confirmed" })], tz: "Asia/Manila" } },
        { name: "notYours", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [jobs[1], dj("px", "40 Handover Ct", { startable: false, note: "Extra video" })], tz: "Asia/Manila" } },
        { name: "onlyNotYours", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [dj("px", "40 Handover Ct", { startable: false })], tz: "Asia/Manila" } },
        { name: "pausedOwed", file: EDITOR_DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [dj("p107", "107 E Old Baltimore Pike", { pausedSinceISO: Z("16:45"), note: "1 more video to edit" })], tz: "Asia/Manila" } },
        { name: "barPaused", file: WORK_BAR, exp: "WorkStateBar", props: { bar: bar({ mine: { state: "PAUSED", sinceISO: Z("16:40"), outputId: null } }), tz: "Asia/Manila" } },
      ],
      Z("16:45"),
    );
    const errs = Object.entries(r).filter(([, h]) => h.startsWith("RENDER_ERROR"));
    c.ok("every case rendered", Object.keys(r).length === 30 && errs.length === 0, errs.map(([k, h]) => `${k}: ${h.slice(0, 140)}`).join(" | "));
    const t = (k: string) => text(r[k] ?? "");
    const jobButtons = (k: string) => [...(r[k] ?? "").matchAll(/<button[^>]*class="[^"]*w-full[^"]*"[^>]*>/g)].length;
    const buttons = (k: string) => [...(r[k] ?? "").matchAll(/<button[^>]*>/g)].map((m) => decode(m[0]));
    const buttonWords = (k: string) => [...(r[k] ?? "").matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));

    c.ok("idle desk shows current work and opens the job chooser only on request",
      t("idle").includes("Current work") && t("idle").includes("No job started in the hub.") && buttonWords("idle").includes("Start a job") && jobButtons("idle") === 0, t("idle").slice(0, 120));
    c.ok("…one big button per job, the first 5, then \"Show all 7\"", jobButtons("idleOpen") === 5 && t("idleOpen").includes("Show all 7"), `${jobButtons("idle")} job buttons`);
    c.ok("…107 E first, with its due day and its per-video line",
      t("idleOpen").indexOf("107 E Old Baltimore Pike") < t("idleOpen").indexOf("22 Switch Ave") && t("idleOpen").includes("Due Sep 29") && t("idleOpen").includes("2 approved · 2 more to edit"));
    c.ok("…a late job says \"Late · was due Sep 27\" in red", t("idleOpen").includes("Late · was due Sep 27") && /text-danger[^>]*>Late · was due Sep 27/.test(r.idleOpen ?? ""));
    c.ok("…a job they paused says \"Paused 12:10am your time\" and one with no date \"No due date\"", t("idleOpen").includes("Paused 12:10am your time") && t("idleOpen").includes("No due date"));
    c.ok("…no Pause button while on nothing", !buttonWords("idle").some((w) => /\bPause\b/.test(w)), buttonWords("idle").join(" | "));
    c.ok("…footer: \"Not editing right now? You don't need to press anything.\", How this works (4 lines), the office link",
      t("idle").includes("Not editing right now? You don’t need to press anything.") && t("idle").includes("How Start and Pause work") &&
      desk.HOW_START_WORKS.every((l) => t("idle").includes(l)) && /href="\/people\/capacity"[^>]*>Offline or stuck\? Tell the office →/.test(r.idle ?? ""));
    c.ok("on a job: ONE bar — \"You're on 107 E Old Baltimore Pike since 12:40am your time\" (Manila, labelled), street links to the job",
      t("active").includes("You’re on 107 E Old Baltimore Pike since 12:40am your time") && /href="\/edit\/p107"/.test(r.active ?? "") && !t("active").includes("What are you working on now?"), t("active").slice(0, 100));
    c.ok("REVIEW F3: on a job the footer says \"Stopped for now? Tap Pause.\" — never \"You don't need to press anything\" (a closed tab would leave the office an \"On …\" line all night)",
      t("active").includes("Stopped for now? Tap Pause.") && !/need to press anything/.test(t("active")) && !/need to press anything/.test(t("previewActive")) && !/need to press anything/.test(t("activeClaims")),
      t("active").slice(-200));
    c.ok("…and on nothing it still says you needn't press anything (true there), never \"Tap Pause\"",
      t("idle").includes("Not editing right now? You don’t need to press anything.") && !t("idle").includes("Stopped for now?"));
    c.ok("…with exactly [Pause] and [Switch job], and no job list until Switch is pressed",
      JSON.stringify(buttonWords("active")) === JSON.stringify(["Pause", "Switch job"]) && jobButtons("active") === 0, buttonWords("active").join(" | "));
    c.ok("a failed read says so in amber, and the list is still there to press",
      t("failed").includes("Couldn’t load what you’re on right now — refresh the page. Starting a job below is still safe.") && jobButtons("failedOpen") === 2 && t("failed").includes("Current job unavailable.") && /text-warning/.test(r.failed ?? ""));
    c.ok("nothing to edit and on nothing → the one line \"Nothing to edit right now.\" and no buttons",
      t("empty").includes("Nothing to edit right now.") && buttons("empty").length === 0 && !t("empty").includes("What are you working on now?"));
    const disabledAll = (k: string) =>
      buttons(k).length > 0 && buttons(k).every((b) => /disabled=""/.test(b) && b.includes('title="You\'re previewing — exit the preview to press this."'));
    c.ok("a preview (view as): every job button and Pause / Switch is disabled with the preview title",
      disabledAll("preview") && disabledAll("previewActive") && buttons("previewActive").length === 2, `${buttons("preview").length} + ${buttons("previewActive").length} buttons`);
    c.ok("legacy claims: the sentence says what a tap on a MARKED job does — and only that — + \"I'm not on any of them\"",
      t("claims").includes("A previous In editing mark needs your confirmation.") && t("claimsOpen").includes("Confirming a previous “In editing” mark pauses the other marked jobs.") && t("claimsOpen").includes("I'm not on any of them"), t("claims").slice(0, 260));
    c.ok("REVIEW F5: while ON a job, no claims sentence and no \"not on any of them\" — Switch job never answers for the other marked jobs",
      !t("activeClaimsOpen").includes("pauses the other marked jobs") && !t("activeClaimsOpen").includes("not on any of them"));
    c.ok("REVIEW F6: a job not handed over is ONE line — \"Not assigned to you yet — ask the office: 40 Handover Ct\" — never a Start button",
      jobButtons("notYoursOpen") === 1 && t("notYours").includes("1 job not assigned to you yet") && t("notYours").includes("Ask the office: 40 Handover Ct") && !buttonWords("notYoursOpen").some((w) => w.includes("40 Handover Ct")),
      `${jobButtons("notYours")} buttons · ${buttonWords("notYours").join(" | ")}`);
    c.ok("…and when that is all there is: \"Nothing to edit right now.\" + the line, no buttons",
      t("onlyNotYours").includes("Nothing to edit right now.") && t("onlyNotYours").includes("1 job not assigned to you yet") && t("onlyNotYours").includes("Ask the office: 40 Handover Ct") && buttons("onlyNotYours").length === 0);
    c.ok("REVIEW F1: his paused multi-video job's button says both — \"Paused 12:45am your time · 1 more video to edit\"",
      jobButtons("pausedOwedOpen") === 1 && t("pausedOwedOpen").includes("Paused 12:45am your time · 1 more video to edit"), t("pausedOwed").slice(0, 160));

    c.ok("job bar, idle: \"Working on this job now?\" and one button, \"Start\"",
      t("barIdle").includes("Working on this job now?") && JSON.stringify(buttonWords("barIdle")) === JSON.stringify(["Start"]), buttonWords("barIdle").join(" | "));
    c.ok("…the video picker is folded under details, relabelled \"Which video? (optional)\", with \"Any / not sure\"",
      /<details[\s\S]*Which video\? \(optional\)[\s\S]*Any \/ not sure[\s\S]*<\/details>/.test(r.barIdle ?? ""));
    c.ok("…the fine print (\"not a timer\") lives only inside details now",
      !text((r.barIdle ?? "").replace(/<details[\s\S]*<\/details>/, "")).includes("not a timer") && t("barIdle").includes("It's not a timer, and it's not used for pay."));
    c.ok("job bar, on it: \"You're on this job since 12:40am your time\" + Pause", t("barActive").includes("You're on this job since 12:40am your time") && JSON.stringify(buttonWords("barActive")) === JSON.stringify(["Pause"]));
    c.ok("job bar, paused: \"Paused at 12:40am your time.\" + Resume — labelled, beside the tracker's Eastern stamps",
      t("barPaused").includes("Paused at 12:40am your time.") && JSON.stringify(buttonWords("barPaused")) === JSON.stringify(["Resume"]));
    c.ok("REVIEW F12: \"How this works\" promises nothing the Dropbox send breaks — \"After you send a version for review, press Start again if you're still working on the job.\"",
      t("barIdle").includes("After you send a version for review, press Start again if you're still working on the job.") && !/We.ll ask/.test(t("barIdle")) && !/We.ll ask/.test(t("idle")));
    c.ok("job bar, on another job: \"You're on 22 Switch Ave now.\" + ONE tap, \"Switch to this job\" (no two-step confirm)",
      t("barSwitch").includes("You're on 22 Switch Ave now.") && t("barSwitch").includes("Switching pauses 22 Switch Ave.") &&
      JSON.stringify(buttonWords("barSwitch")) === JSON.stringify(["Switch to this job"]) && !t("barSwitch").includes("Pause it and start this"));
    c.ok("office: \"Kim on this job since 12:40pm\", the labelled correction, and who made the last change",
      t("barOffice").includes("Kim on this job since 12:40pm") && JSON.stringify(buttonWords("barOffice")) === JSON.stringify(["Pause for Kim"]) && t("barOffice").includes("office correction") &&
      t("barOffice").includes("Last change made by Jordan Spackman for Kim (office correction)."));
    c.ok("a read-only view: the words, no button", t("barView").includes("Nobody has pressed Start on this job") && buttons("barView").length === 0);
    c.ok("the prompt: \"Sent. Are you still working on this job?\" / \"1 more video to make here.\" / Yes / No",
      t("prompt1").includes("Sent. Are you still working on this job?") && t("prompt1").includes("1 more video to make here.") &&
      t("prompt1").includes("Yes, I’m on it") && t("prompt1").includes("No, done for now") && !t("prompt1").includes("Yes pauses"));
    c.ok("…plural, and \"Yes pauses 22 Switch Ave.\" when they're on another job", t("prompt3").includes("3 more videos to make here.") && t("prompt3").includes("Yes pauses 22 Switch Ave."));
  }

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, editorKey: string | null = null, teamMemberId: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey, teamMemberId }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER");
  const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", "kim", kimTm.id);
  const john = await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", "john", johnTm.id);
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U, actingAs?: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs: actingAs.id } : {}) });

  let seq = 0;
  const mkJob = async (o: { street: string; status: "BOOKED" | "SHOT" | "EDITING" | "REVIEW"; editor: "kim" | "john"; videos?: number; dueISO?: string; shotDaysAgo?: number }) => {
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Media, PA`, clientId: client.id, status: o.status, aryeoOrderId: `drill-c2-${++seq}`,
        shootDate: new Date(Date.now() - (o.shotDaysAgo ?? 3) * DAY), photographerId: harrison.id, payableInvoice: 400, price: 400,
        editorId: o.editor === "kim" ? kimTm.id : johnTm.id,
        deliveryDue: o.dueISO ? new Date(o.dueISO) : null,
        statusEvidence: o.status === "BOOKED" ? null : JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Social Reel", quantity: o.videos ?? 1 }, select: { id: true } });
    await prisma.smartTask.create({
      data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: "OPEN", assignedKey: o.editor, assignedManually: true, projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` },
    });
    return { id: p.id, street: o.street, deliverableId: d.id };
  };
  const cut = (projectId: string, deliverableId: string, slot: number, status: string, at: string, o: { key?: string | null; round?: number } = {}) =>
    prisma.reviewSubmission.create({
      data: {
        projectId, deliverableId, slot, round: o.round ?? 1, status, source: "upload", fileName: `v${o.round ?? 1}-slot${slot}.mp4`,
        submittedByKey: o.key === undefined ? "kim" : o.key, submittedByName: o.key === null ? "Jordan Spackman" : "Kim Miguel", createdAt: new Date(at),
        ...(status === "APPROVED" ? { decidedAt: new Date(at), decidedBy: "Jordan Spackman", completedAt: new Date(at) } : {}),
      },
    });

  // 107 E: four videos, two approved, two still to make — "Ready for editing ·
  // 2 approved · 2 more to edit", as the office read it at 12:34.
  const A = await mkJob({ street: "107 E Old Baltimore Pike", status: "SHOT", editor: "kim", videos: 4, dueISO: "2026-09-29T21:00:00Z" });
  await cut(A.id, A.deliverableId, 1, "APPROVED", Z("13:22"));
  await cut(A.id, A.deliverableId, 2, "APPROVED", Z("15:40"));
  const B = await mkJob({ street: "22 Switch Ave", status: "SHOT", editor: "kim", dueISO: "2026-10-01T21:00:00Z" });
  const W = await mkJob({ street: "5 Waiting Way", status: "BOOKED", editor: "kim", shotDaysAgo: 1 });
  const RV = await mkJob({ street: "9 Review Rd", status: "REVIEW", editor: "kim", dueISO: "2026-09-28T21:00:00Z" });
  await cut(RV.id, RV.deliverableId, 1, "PENDING", Z("12:00"));
  const J = await mkJob({ street: "30 John St", status: "SHOT", editor: "john", dueISO: "2026-09-28T21:00:00Z" });
  const N = await mkJob({ street: "31 Never Started Ln", status: "SHOT", editor: "kim", dueISO: "2026-10-03T21:00:00Z" });
  // On Kim's list by Project.editor, but no edit card of his — startEditing
  // refuses it (REVIEW F6). Its card is closed, as the janitor leaves one.
  const H = await mkJob({ street: "40 Handover Ct", status: "SHOT", editor: "kim", dueISO: "2026-10-04T21:00:00Z" });
  await prisma.smartTask.updateMany({ where: { projectId: H.id }, data: { status: "COMPLETED" } });

  const counts = async () => ({
    items: await prisma.editorWorkItem.count(),
    events: await prisma.editorWorkEvent.count(),
    activity: await prisma.activity.count(),
    bells: await prisma.notification.count(),
  });
  const bells = () => prisma.notification.count({ where: { kind: "edit_started" } });

  // =========================================================================
  c.head("§6 · /editing as Kim, as Jordan previewing Kim, and as Jordan");
  // =========================================================================
  type El = { type?: unknown; props?: Record<string, unknown> };
  const walk = (node: unknown, type: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) { for (const n of node) walk(n, type, out); return out; }
    if (!node || typeof node !== "object") return out;
    const el = node as El;
    if (el.type === type) out.push(el);
    if (el.props) for (const v of Object.values(el.props)) if (v && typeof v === "object") walk(v, type, out);
    return out;
  };
  let page: (() => Promise<unknown>) | null = null;
  let why = "";
  {
    // requirePageAccess does `await import("next/navigation")`, which the
    // preload's CJS redirect never sees — fill the real file's cache slot with
    // the same stub (the b1-remainders §7 pattern).
    const realNav = path.join(REPO, "node_modules/next/navigation.js");
    const M = Module as unknown as { new (id: string): { filename: string; loaded: boolean; exports: unknown }; _cache: Record<string, unknown> };
    const m = new M(realNav);
    m.filename = realNav;
    m.loaded = true;
    m.exports = cjs(path.join(__dirname, "_next-navigation-stub.cjs"));
    M._cache[realNav] = m;
    try {
      page = (cjs(path.join(REPO, "src/app/editing/page.tsx")) as { default: () => Promise<unknown> }).default;
    } catch (e) {
      why = (e as Error).message.slice(0, 160);
    }
  }
  const { EditorDesk } = cjs(EDITOR_DESK) as typeof import("@/components/editing/EditorDesk");
  const { WorkloadPanel } = cjs(path.join(REPO, "src/components/editing/WorkloadPanel.tsx")) as typeof import("@/components/editing/WorkloadPanel");
  const { EditorQualityCard } = cjs(path.join(REPO, "src/components/editing/EditorQualityCard.tsx")) as typeof import("@/components/editing/EditorQualityCard");
  const { PageHeader } = cjs(path.join(REPO, "src/components/PageHeader.tsx")) as typeof import("@/components/PageHeader");
  type DeskProps = { desk: { active: { projectId: string } | null } | null; jobs: { projectId: string; note: string | null; pausedSinceISO: string | null; startable: boolean }[]; tz: string; readOnly?: boolean };
  const headerOf = (tree: unknown) => (walk(tree, PageHeader)[0]?.props as { subtitle?: unknown } | undefined)?.subtitle;
  const deskOf = async (u: U, actingAs?: U) => {
    await as(u, actingAs);
    const tree = await page!();
    const d = walk(tree, EditorDesk);
    return { tree, desk: d[0]?.props as DeskProps | undefined, n: d.length };
  };
  if (!page) {
    c.ok("the /editing page could be loaded in the drill", false, why);
  } else {
    const before = await counts();
    const k = await deskOf(kim);
    const ids = k.desk?.jobs.filter((j) => j.startable).map((j) => j.projectId) ?? [];
    c.ok("Kim, on nothing: the desk is drawn (never null) with desk.active null — the question and its job buttons",
      k.n === 1 && !!k.desk?.desk && k.desk.desk.active === null && ids.length > 0);
    c.ok("…the jobs he can start are 107 E then 22 Switch Ave then 31 Never Started Ln — not the Waiting job, not the one in review, not John's",
      JSON.stringify(ids) === JSON.stringify([A.id, B.id, N.id]) && ![W.id, RV.id, J.id].some((x) => ids.includes(x)), ids.map((x) => [A, B, N, W, RV, J, H].find((j) => j.id === x)?.street ?? x).join(" · "));
    const hJob = k.desk?.jobs.find((j) => j.projectId === H.id);
    c.ok("REVIEW F6 on the real page: 40 Handover Ct (his by Project.editor, no card of his) is on the desk as NOT startable — the server would refuse it",
      !!hJob && hJob.startable === false, JSON.stringify(hJob));
    await as(kim);
    const refused = await workActions.startEditingAction({ projectId: H.id, requestId: "c2-h-start" });
    c.ok("…and the server does refuse it — the desk and startEditing now ask the same question", !refused.ok && /isn't assigned to you/.test(refused.message), refused.message);
    c.ok("…107 E's button carries \"2 approved · 2 more to edit\"", k.desk?.jobs[0]?.note === "2 approved · 2 more to edit", String(k.desk?.jobs[0]?.note));
    c.ok("…in HIS timezone (Asia/Manila), pressable (not a preview)", k.desk?.tz === "Asia/Manila" && k.desk?.readOnly === false);
    c.ok("…no \"Your workload\" panel any more; his own review card stays",
      walk(k.tree, WorkloadPanel).length === 0 && walk(k.tree, EditorQualityCard).length === 1);
    c.ok("…the header says only what he can start: \"3 to edit\"", headerOf(k.tree) === "3 projects to edit", JSON.stringify(headerOf(k.tree)));
    const pv = await deskOf(jordan, kim);
    c.ok("Jordan previewing Kim: the same desk, every button off (readOnly)", pv.n === 1 && pv.desk?.readOnly === true && pv.desk?.tz === "Asia/Manila");
    try {
      const o = await deskOf(jordan);
      c.ok("Jordan's own office view has no editor desk", o.n === 0);
    } catch (e) {
      c.ok("Jordan's own office view renders (the office branch is the other builder's)", false, (e as Error).message.slice(0, 160));
    }
    const after = await counts();
    c.ok("opening /editing three times wrote nothing to the work layer, the timeline or the bell", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }

  // =========================================================================
  c.head("§7 · \"Sent. Are you still working on this job?\" — Yes, No, twice, previewed");
  // =========================================================================
  const kimViewer = { role: "EDITOR", realRole: "EDITOR", editorKey: "kim", impersonating: false };
  const asksAfterUpload = (b: WorkBar | null) => !!(b && b.mode === "editor" && b.canStart && b.mine.state !== "ACTIVE");
  // T0: Kim presses Start on 107 E (the ordinary Start — it rings once).
  await as(kim);
  freeze(Z("16:06"));
  const r0 = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-start-0", outputId: null });
  thaw();
  c.ok("T0 (16:06Z): Kim's own Start on 107 E", r0.ok && r0.message === "Started 107 E Old Baltimore Pike.", r0.message);
  const bells0 = await bells();
  c.ok("…which rang the office once (a first Start is news)", bells0 === 1, `${bells0}`);
  const barWhileOn = await work.workBarFor(A.id, kimViewer);
  c.ok("while he is ON the job, an upload would not ask (mine ACTIVE)", !asksAfterUpload(barWhileOn));

  // T0+30m: a version lands — the upload finalize's own hand-in (reviewCuts.uploadCutEntered).
  freeze(Z("16:36"));
  await cut(A.id, A.deliverableId, 3, "PENDING", Z("16:36"));
  await prisma.project.update({ where: { id: A.id }, data: { status: "REVIEW" } });
  const closed = await work.closeActiveWork(A.id, { editorKey: "kim", forOutputId: null, reason: "SUBMITTED", actor: { userId: null, name: "Kim Miguel", role: "EDITOR" } });
  thaw();
  c.ok("T0+30m: the upload ended his Start (SUBMIT)", closed === 1 && (await prisma.editorWorkEvent.findFirst({ where: { editorKey: "kim" }, orderBy: { at: "desc" } }))?.kind === "SUBMIT");
  const deskAfterUpload = await work.myDesk("kim");
  c.ok("…and nothing started it again by itself — his desk reads on nothing", deskAfterUpload.active === null);
  const barAfterUpload = await work.workBarFor(A.id, kimViewer);
  c.ok("…so the page ASKS him: editor mode, startable, not on it", asksAfterUpload(barAfterUpload) && barAfterUpload?.elsewhere === null);
  if (page) {
    // REVIEW F1/F9 on the real page: video 3 waits on a verdict, so the row
    // reads "Ready for review" — and video 4 is still his. Before this fix the
    // desk dropped 107 E here ("No, done for now" left no button to press).
    const kU = await deskOf(kim);
    const aU = kU.desk?.jobs.find((j) => j.projectId === A.id);
    const rowA = (await queue.buildEditorQueue()).notDone.find((r) => r.id === A.id);
    c.ok("REVIEW F1: after the upload 107 E's row reads Ready for review (video 3 with the office) and counts 1 video still his",
      rowA?.status === "Ready for review" && rowA.videosToEdit === 1 && JSON.stringify(rowA.startableBy) === JSON.stringify(["kim"]), `${rowA?.status} · ${rowA?.videoBreakdown} · toEdit ${rowA?.videosToEdit}`);
    c.ok("…and it STAYS on his desk — a Start button saying \"1 more video to edit\" — whether he answers Yes or No",
      !!aU && aU.startable && aU.note === "1 more video to edit" && aU.pausedSinceISO === null, JSON.stringify(aU));
    c.ok("…the header still counts it: \"3 to edit\", never \"Nothing to edit right now\" while a video is owed", headerOf(kU.tree) === "3 projects to edit", JSON.stringify(headerOf(kU.tree)));
  }
  await as(jordan);
  const jb = await work.workBarFor(A.id, { role: "OWNER", realRole: "OWNER", editorKey: null, impersonating: false });
  const pvb = await work.workBarFor(A.id, { role: "EDITOR", realRole: "OWNER", editorKey: "kim", impersonating: true });
  const johnb = await work.workBarFor(A.id, { role: "EDITOR", realRole: "EDITOR", editorKey: "john", impersonating: false });
  c.ok("…never the office, never a preview, never an editor the job isn't theirs (John on Kim's job)",
    !asksAfterUpload(jb) && jb?.mode === "office" && !asksAfterUpload(pvb) && pvb?.mode === "view" && !asksAfterUpload(johnb) && johnb?.canStart === false);

  // A preview presses Yes: refused, nothing written. So is John pressing it
  // on Kim's job (a stale tab, a shared link).
  const cPv0 = await counts();
  await as(john);
  const rJohn = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-john-yes", outputId: null });
  c.ok("Yes pressed by John on Kim's job is refused and writes nothing", !rJohn.ok && /isn't assigned to you/.test(rJohn.message) && JSON.stringify(await counts()) === JSON.stringify(cPv0), rJohn.message);
  await as(jordan, kim);
  const rPv = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-preview-yes", outputId: null });
  c.ok("Yes pressed from a preview is refused and writes nothing", !rPv.ok && /previewing/.test(rPv.message) && JSON.stringify(await counts()) === JSON.stringify(cPv0), rPv.message);

  // T0+34m: Kim presses Yes.
  await as(kim);
  const cYes0 = await counts();
  freeze(Z("16:40"));
  const r1 = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-yes-1", outputId: null });
  thaw();
  const itemA = await prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: A.id } } });
  const evYes = await prisma.editorWorkEvent.findFirst({ where: { requestId: "c2-yes-1" } });
  c.ok("Yes → \"Started 107 E Old Baltimore Pike.\" and he is ACTIVE on it", r1.ok && r1.message === "Started 107 E Old Baltimore Pike." && itemA?.state === "ACTIVE", r1.message);
  c.ok("…activeSince is the PRESS, 16:40:00.000Z exactly — not the upload (16:36), not the first Start (16:06)",
    itemA?.activeSince?.toISOString() === Z("16:40") && itemA?.firstStartedAt?.toISOString() === Z("16:06"), `${itemA?.activeSince?.toISOString()} · first ${itemA?.firstStartedAt?.toISOString()}`);
  c.ok("…logged as HIS Start: START, actor role EDITOR, his login, not on anyone's behalf, at the press",
    evYes?.kind === "START" && evYes.actorRole === "EDITOR" && evYes.actorUserId === kim.id && evYes.onBehalf === false && evYes.at.toISOString() === Z("16:40"),
    `${evYes?.kind} · ${evYes?.actorRole} · onBehalf ${evYes?.onBehalf}`);
  c.ok("…the newest event on the job is that START", (await prisma.editorWorkEvent.findFirst({ where: { projectId: A.id }, orderBy: { at: "desc" } }))?.id === evYes?.id);
  c.ok("…a restart after a hand-in rings no bell (quiet start)", (await bells()) === bells0);
  const cYes1 = await counts();
  c.ok("…one event and one timeline line, nothing else", cYes1.events === cYes0.events + 1 && cYes1.items === cYes0.items && cYes1.activity === cYes0.activity + 1);
  const rReplay = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-yes-1", outputId: null });
  c.ok("the same Yes retried (same request id) → \"Already recorded.\" — still one event", rReplay.ok && rReplay.message === "Already recorded." &&
    (await prisma.editorWorkEvent.count({ where: { requestId: "c2-yes-1" } })) === 1 && JSON.stringify(await counts()) === JSON.stringify(cYes1), rReplay.message);
  const rAgain = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-yes-2", outputId: null });
  c.ok("a second Yes (a new press) → \"You're already on 107 E Old Baltimore Pike.\" — writes nothing",
    rAgain.ok && rAgain.message === "You're already on 107 E Old Baltimore Pike." && JSON.stringify(await counts()) === JSON.stringify(cYes1) &&
    (await prisma.editorWorkItem.findUnique({ where: { id: itemA!.id } }))?.activeSince?.toISOString() === Z("16:40"), rAgain.message);
  const promptSrc = read("src/components/editing/StillWorkingPrompt.tsx");
  c.ok("No closes the card and calls nothing: its handler is onClose() alone, and the file's ONLY action call is inside Yes",
    /const no = \(\) => onClose\(\);/.test(promptSrc) && (promptSrc.match(/startEditingAction\(/g) ?? []).length === 1 &&
    /const yes = \(\) => \{[\s\S]*startEditingAction\([\s\S]*\n  \};/.test(promptSrc) && !/pauseEditingAction|confirmCurrentWorkAction/.test(promptSrc));
  const wn = await work.workingNow();
  const kimLine = wn.ok ? wn.editors.find((e) => e.key === "kim") : null;
  c.ok("the office's reader now has Kim ON 107 E since 12:40pm ET", kimLine?.active?.projectId === A.id && work.workClock(kimLine.active.sinceISO) === "12:40pm");
  const barKim = await work.workBarFor(A.id, kimViewer);
  c.ok("…and his own bar reads \"You're on this job since 12:40am your time\" (Manila, labelled)", !!barKim && desk.barWords(barKim, "Asia/Manila", new RealDate(Z("16:41"))).state === "You're on this job since 12:40am your time");

  // =========================================================================
  c.head("§8 · switching pauses the job he was on — one press, one transaction");
  // =========================================================================
  const barB = await work.workBarFor(B.id, kimViewer);
  c.ok("on 22 Switch Ave's page, the bar offers \"Switch to this job\" and names what pauses",
    !!barB && desk.barWords(barB, "Asia/Manila", new RealDate(Z("16:44"))).button === "switch" && barB.elsewhere?.street === "107 E Old Baltimore Pike");
  c.ok("…and an upload there would ask with \"Yes pauses 107 E Old Baltimore Pike.\"", asksAfterUpload(barB) && barB?.elsewhere?.street === "107 E Old Baltimore Pike");
  freeze(Z("16:45"));
  const rSw = await workActions.startEditingAction({ projectId: B.id, requestId: "c2-yes-B", outputId: null });
  thaw();
  const aAfter = await prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: A.id } } });
  const bAfter = await prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: B.id } } });
  const auto = await prisma.editorWorkEvent.findFirst({ where: { projectId: A.id, kind: "AUTO_PAUSE" }, orderBy: { at: "desc" } });
  c.ok("Yes on B → \"Started 22 Switch Ave. 107 E Old Baltimore Pike is paused.\"", rSw.ok && rSw.message === "Started 22 Switch Ave. 107 E Old Baltimore Pike is paused.", rSw.message);
  c.ok("…A is PAUSED at the press with an AUTO_PAUSE naming B, by Kim; B is ACTIVE; one ACTIVE row for Kim",
    aAfter?.state === "PAUSED" && aAfter.pausedAt?.toISOString() === Z("16:45") && auto?.switchedTo === B.id && auto.actorRole === "EDITOR" && auto.onBehalf === false &&
    bAfter?.state === "ACTIVE" && bAfter.activeSince?.toISOString() === Z("16:45") && (await prisma.editorWorkItem.count({ where: { editorKey: "kim", state: "ACTIVE" } })) === 1);
  if (page) {
    const k2 = await deskOf(kim);
    c.ok("his desk now shows ONE bar: desk.active is 22 Switch Ave (Pause / Switch job)", k2.desk?.desk?.active?.projectId === B.id);
    const aOnDesk = k2.desk?.jobs.find((j) => j.projectId === A.id);
    // REVIEW F1/F9 (this was a printed NOTE — "no — he resumes it from the
    // job page" — before the fix): the job he just paused by switching stays
    // on the desk, so Switch job can take him straight back to it.
    c.ok("REVIEW F9: 107 E, paused by the switch, is on his desk with its pause time and \"1 more video to edit\" — one tap to go back",
      !!aOnDesk && aOnDesk.startable && aOnDesk.pausedSinceISO === Z("16:45") && aOnDesk.note === "1 more video to edit", JSON.stringify(aOnDesk));
    c.ok("…and the header counts it too (\"3 to edit\")", headerOf(k2.tree) === "3 projects to edit", JSON.stringify(headerOf(k2.tree)));
  }

  // =========================================================================
  c.head("§9 · never automatic");
  // =========================================================================
  const deskSrc = read("src/components/editing/EditorDesk.tsx");
  const barSrc = read("src/components/editing/WorkStateBar.tsx");
  const upSrc = read("src/components/editing/CutUploader.tsx");
  const EFFECT = /\buse(Layout|Insertion)?Effect\b|setTimeout|setInterval/;
  c.ok("no effect or timer in EditorDesk, StillWorkingPrompt or WorkStateBar — every action call sits in a click",
    !EFFECT.test(deskSrc) && !EFFECT.test(promptSrc) && !EFFECT.test(barSrc));
  const callers = execFileSync("git", ["grep", "--untracked", "-l", "-E", "startEditingAction|pauseEditingAction|confirmCurrentWorkAction", "--", "src"], { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).sort();
  c.ok("the work actions are called only from EditorDesk, WorkStateBar and StillWorkingPrompt (and defined in workActions)",
    JSON.stringify(callers) === JSON.stringify(["src/app/editing/workActions.ts", "src/components/editing/EditorDesk.tsx", "src/components/editing/StillWorkingPrompt.tsx", "src/components/editing/WorkStateBar.tsx"]), callers.join(", "));
  c.ok("CutUploader calls none of them (it only draws the prompt)", !/workActions|startEditing|pauseEditing|confirmCurrentWork/.test(upSrc));
  c.ok("setSent(key) appears exactly once — after the finalize said ok, after the message save, right before the refresh",
    (upSrc.match(/setSent\(key\)/g) ?? []).length === 1 &&
    /if \(!done\.ok\) throw new Error\(done\.message\);[\s\S]*saveCutMessage\(started\.submissionId[\s\S]*setSent\(key\);\s*router\.refresh\(\);\s*\} catch/.test(upSrc));
  const heldBranch = upSrc.slice(upSrc.indexOf("if (!done.ok && done.held) {"), upSrc.indexOf("if (!done.ok) throw new Error(done.message);"));
  const abandonAt = upSrc.indexOf("} catch (e) {\n      await abandonCutUpload");
  c.ok("…never on a held upload, a failure or an abandon; every other setSent clears it",
    heldBranch.length > 0 && !heldBranch.includes("setSent") && (upSrc.match(/setSent\(/g) ?? []).length === (upSrc.match(/setSent\((null|key)\)/g) ?? []).length &&
    abandonAt > upSrc.indexOf("setSent(key)") && !upSrc.slice(abandonAt, abandonAt + 400).includes("setSent(key)"));
  c.ok("the store line is byte-identical to a2f8484 (store-cutover)",
    oldUploader.includes('const CUT_STORE_ACCESS = process.env.NEXT_PUBLIC_REVIEW_CUT_ACCESS === "private" ? "private" : "public";') &&
    upSrc.includes('const CUT_STORE_ACCESS = process.env.NEXT_PUBLIC_REVIEW_CUT_ACCESS === "private" ? "private" : "public";') && upSrc.includes("access: started.access ?? CUT_STORE_ACCESS,"));
  const editPage = read("src/app/edit/[id]/page.tsx");
  c.ok("the job page asks from the FULL slot list, and only an editor who could press Start and isn't on the job",
    /const openSlotKeys = openSlotKeysFor\(\s*\n?\s*cutRows\.map/.test(editPage) &&
    /workBar && workBar\.mode === "editor" && workBar\.canStart && workBar\.mine\.state !== "ACTIVE"/.test(editPage) && /stillWorking=\{stillWorking\}/.test(editPage));
  c.ok("REVIEW F11: …with approved videos counted only through the per-video asks (videoAsks.slotsAskedAgain), never the job-level revisionOpen flag",
    /slotsAskedAgain\(id, videoRevisionTasks, submissions\)/.test(editPage) && !/APPROVED" && revisionOpen/.test(editPage) &&
    /paused: workBar\.mine\.state === "PAUSED"/.test(editPage));
  c.ok("REVIEW F4: the desk sends NO video on a Start or a resume (omitted, the server keeps the one picked on the job page); only the prompt's fresh start after a hand-in names none",
    !/outputId/.test(deskSrc) && /startEditingAction\(\{ projectId: j\.projectId, requestId \}\)/.test(deskSrc) &&
    /startEditingAction\(\{ projectId, requestId: id, \.\.\.\(resumes \? \{\} : \{ outputId: null \}\) \}\)/.test(promptSrc) && /resumes=\{stillWorking\.paused\}/.test(upSrc));
  c.ok("REVIEW F5: a claim tap confirms (and pauses the other claims) ONLY from the on-nothing list; from Switch job it is the plain Start",
    /const confirms = \(j: DeskJob\) => j\.claim && !active;/.test(deskSrc) && /const hasClaims = !active && /.test(deskSrc));
  const cutsSrc = read("src/lib/reviewCuts.ts");
  const actionsSrc = read("src/app/review/actions.ts");
  c.ok("REVIEW F7: the upload's hand-in closes only stretches begun by the entry's own stamp, and the browser's finish settles that close before it answers (both paths)",
    /startedBefore: enteredAt/.test(cutsSrc) && /closeUploadersStretch\(sub, entered\?\.selfCheckedAt \?\? null\)/.test(cutsSrc) &&
    (actionsSrc.match(/settleUploadHandIn\(input\.submissionId\)/g) ?? []).length === 2 &&
    /if \(row\.status !== "UPLOADING" && !awaitingBytes\) \{[\s\S]{0,200}settleUploadHandIn\(input\.submissionId\);\s*return \{ ok: true, message: "Already in review\." \};/.test(actionsSrc));
  // A hand-in on a job he never started: the closer finds nothing, starts nothing.
  const c9 = await counts();
  await cut(N.id, N.deliverableId, 1, "PENDING", Z("17:00"));
  const n9 = await work.closeActiveWork(N.id, { editorKey: "kim", forOutputId: null, reason: "SUBMITTED", actor: { userId: null, name: "Kim Miguel", role: "EDITOR" } });
  c.ok("a Kim upload + the hand-in on a job he never started leaves ZERO work rows for it", n9 === 0 && (await prisma.editorWorkItem.count({ where: { projectId: N.id } })) === 0 &&
    (await counts()).items === c9.items && (await counts()).events === c9.events);

  // =========================================================================
  c.head("§10 · the Sep 28 review, against the database");
  // =========================================================================
  {
    const mkOut = (slot: number) =>
      prisma.deliverableOutput.create({ data: { deliverableId: A.deliverableId, projectId: A.id, slot, category: "SOCIAL_REEL" }, select: { id: true } });
    const outs = [await mkOut(1), await mkOut(2), await mkOut(3), await mkOut(4)];
    const itemOf = (projectId: string) => prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId } } });
    await as(kim);

    // F4 — Kim points his Start at Video 4 on the job page, switches to 22
    // Switch Ave from the desk, then taps 107 E on the desk to go back.
    freeze(Z("17:00"));
    const s1 = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-f4-a", outputId: outs[3].id });
    thaw();
    freeze(Z("17:05"));
    const s2 = await workActions.startEditingAction({ projectId: B.id, requestId: "c2-f4-b" }); // the desk's Switch: no video sent
    thaw();
    const aPaused = await itemOf(A.id);
    freeze(Z("17:10"));
    const s3 = await workActions.startEditingAction({ projectId: A.id, requestId: "c2-f4-a2" }); // the desk's tap: no video sent
    thaw();
    const aBack = await itemOf(A.id);
    const wnF4 = await work.workingNow();
    const kimF4 = wnF4.ok ? wnF4.editors.find((e) => e.key === "kim") : null;
    c.ok("REVIEW F4: Start on Video 4 → Switch from the desk → tap 107 E on the desk: RESUMED, still on Video 4 (\"· Video 4\" for the office too)",
      s1.ok && s2.ok && s3.ok && aPaused?.state === "PAUSED" && aPaused.outputId === outs[3].id &&
      aBack?.state === "ACTIVE" && aBack.outputId === outs[3].id && kimF4?.active?.outputTitle === "Video 4",
      `${s3.message} · ${aBack?.outputId === outs[3].id ? "Video 4 kept" : `outputId ${aBack?.outputId}`} · office "${kimF4?.active?.outputTitle}"`);
    const evResume = await prisma.editorWorkEvent.findFirst({ where: { requestId: "c2-f4-a2" } });
    c.ok("…logged as his RESUME of Video 4", evResume?.kind === "RESUME" && evResume.outputId === outs[3].id && evResume.actorRole === "EDITOR");
    // What the old desk sent (outputId: null) — shown on a copy of the same
    // moves so the contrast is measured, not asserted from memory.
    freeze(Z("17:12"));
    await workActions.startEditingAction({ projectId: B.id, requestId: "c2-f4-b2" });
    await workActions.startEditingAction({ projectId: A.id, requestId: "c2-f4-a3", outputId: null });
    thaw();
    c.ok("…the old desk's explicit outputId:null would have wiped it (measured: the same resume with null → no video)", (await itemOf(A.id))?.outputId === null);

    // F7 — the race. 12 Race Rd: Kim is on it; the store's callback files his
    // upload and claims the entry at 17:20, and is still short of its close
    // when the browser's finish asks.
    const R = await mkJob({ street: "12 Race Rd", status: "SHOT", editor: "kim", videos: 2, dueISO: "2026-10-02T21:00:00Z" });
    freeze(Z("17:15"));
    const onR = await workActions.startEditingAction({ projectId: R.id, requestId: "c2-f7-start" });
    thaw();
    const blobUrl = `https://drill.public.blob.vercel-storage.com/review-cuts/${R.id}/race/v1.mp4`;
    const sub = await prisma.reviewSubmission.create({
      data: {
        projectId: R.id, deliverableId: R.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "v1.mp4",
        submittedByKey: "kim", submittedByName: "Kim Miguel", createdAt: new Date(Z("17:16")),
        blobUrl, blobPathname: `review-cuts/${R.id}/race/v1.mp4`, selfCheckId: "c2-race-check", selfCheckedAt: new Date(Z("17:20")),
      },
      select: { id: true },
    });
    await prisma.project.update({ where: { id: R.id }, data: { status: "REVIEW" } });
    const { finishCutUpload } = await import("@/app/review/actions");
    freeze(Z("17:21"));
    const fin = await finishCutUpload({ submissionId: sub.id, url: blobUrl, pathname: `review-cuts/${R.id}/race/v1.mp4` });
    thaw();
    const rAfterFinish = await itemOf(R.id);
    const barR = await work.workBarFor(R.id, kimViewer);
    c.ok("REVIEW F7(b): the callback won the entry; the browser's finish answers \"Already in review.\" only AFTER closing his Start — so the refresh asks him",
      onR.ok && fin.ok && fin.message === "Already in review." && rAfterFinish?.state === "CLOSED" && rAfterFinish.closeReason === "SUBMITTED" && asksAfterUpload(barR),
      `${fin.message} · item ${rAfterFinish?.state}/${rAfterFinish?.closeReason}`);
    const submits = await prisma.editorWorkEvent.count({ where: { projectId: R.id, kind: "SUBMIT" } });
    freeze(Z("17:22"));
    const yes = await workActions.startEditingAction({ projectId: R.id, requestId: "c2-f7-yes", outputId: null });
    thaw();
    const wouldOld = await prisma.editorWorkItem.count({ where: { projectId: R.id, editorKey: "kim", state: { not: "CLOSED" } } });
    // …and now the callback's own close finally runs, with the entry's stamp.
    const late = await work.closeActiveWork(R.id, {
      editorKey: "kim", forOutputId: null, startedBefore: new Date(Z("17:20")), reason: "SUBMITTED",
      actor: { userId: null, name: "Kim Miguel", role: "EDITOR" }, detail: "version 1 submitted",
    });
    const { settleUploadHandIn } = await import("@/lib/reviewCuts");
    await settleUploadHandIn(sub.id);
    const rAfterYes = await itemOf(R.id);
    c.ok("REVIEW F7(a): his Yes at 17:22 survives the callback's late close and a second settle — a hand-in never ends a Start pressed after it",
      yes.ok && late === 0 && rAfterYes?.state === "ACTIVE" && rAfterYes.activeSince?.toISOString() === Z("17:22") &&
      (await prisma.editorWorkEvent.count({ where: { projectId: R.id, kind: "SUBMIT" } })) === submits,
      `late close ${late} · item ${rAfterYes?.state} since ${rAfterYes?.activeSince?.toISOString()}`);
    c.ok("…where the old close (no cut-off) would have ended it: his Yes was an open item the old filter selects", wouldOld === 1);
    const officeUpload = await prisma.reviewSubmission.create({
      data: { projectId: R.id, deliverableId: R.deliverableId, slot: 2, round: 1, status: "PENDING", source: "upload", fileName: "o.mp4", submittedByKey: null, submittedByName: "Jordan Spackman", selfCheckId: "c2-office", selfCheckedAt: new Date(Z("17:23")) },
      select: { id: true },
    });
    await settleUploadHandIn(officeUpload.id);
    c.ok("…an office upload (no editor key) closes nothing", (await itemOf(R.id))?.state === "ACTIVE");

    // F11 — which approved videos the client asked about again.
    const v1 = await prisma.reviewSubmission.findFirst({ where: { projectId: A.id, slot: 1 }, select: { id: true } });
    const task = await prisma.smartTask.create({
      data: { taskType: "revision", title: "Video revision — 107 E Old Baltimore Pike", status: "OPEN", assignedKey: "kim", projectId: A.id, clientId: client.id, outputId: outs[1].id, createdAt: new Date(Z("17:30")) },
      select: { id: true, outputId: true, createdAt: true },
    });
    await prisma.revisionBrief.create({ data: { projectId: A.id, taskId: task.id, source: "review_room", originalText: "Swap the song on the first one", submissionId: v1!.id, createdAt: new Date(Z("17:31")) } });
    await prisma.revisionBrief.create({ data: { projectId: A.id, taskId: task.id, source: "manual", originalText: "Can everything be a bit brighter?", createdAt: new Date(Z("17:32")) } });
    const rounds = await prisma.reviewSubmission.findMany({ where: { projectId: A.id }, select: { id: true, deliverableId: true, slot: true } });
    const { slotsAskedAgain } = await import("@/lib/videoAsks");
    const asked = await slotsAskedAgain(A.id, [task], rounds);
    const k = (n: number) => `${A.deliverableId}:${n}`;
    c.ok("REVIEW F11: slotsAskedAgain names video 2 (the task's own video) and video 1 (an ask pinned to its cut) — and not the ask that names no video",
      asked.size === 2 && asked.get(k(2))?.toISOString() === Z("17:30") && asked.get(k(1))?.toISOString() === Z("17:31"),
      JSON.stringify([...asked].map(([key, at]) => [key.slice(-2), at.toISOString()])));
    const slotsA = [1, 2, 3, 4].map((n) => ({ key: k(n), status: n <= 2 ? "APPROVED" : n === 3 ? "PENDING" : null, held: false, approvedAtISO: n === 1 ? Z("13:22") : n === 2 ? Z("15:40") : null }));
    c.ok("…so on 107 E the prompt would count videos 1 and 2 (asked about after approval) and video 4 (never made) — not video 3 in review",
      JSON.stringify(desk.openSlotKeys(slotsA, asked)) === JSON.stringify([k(1), k(2), k(4)]));
  }

  // ---- close ---------------------------------------------------------------
  c.ok("nothing left the building: every non-loopback call was blocked, none answered", fence.faked.length === 0, `${fence.blocked.length} blocked attempt(s)`);
  quiet.restore();
  c.summary();
  fs.rmSync(CACHE, { recursive: true, force: true });
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
