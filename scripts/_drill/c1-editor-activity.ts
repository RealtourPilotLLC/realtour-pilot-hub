// ---------------------------------------------------------------------------
// DRILL C1: "EDITORS TODAY" — what an editor did, shown as evidence (Sep 28).
//
//   cd <worktree> && PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/c1-editor-activity.ts
//
// Jordan, Sep 28: "It says Kim is not working on anything, but I believe he
// is!" Kim uploaded three versions of 107 E Old Baltimore Pike that morning
// (9:22, 11:40, 12:14 ET) and never pressed Start; at 12:34 the office panel
// read "Kim — Not on anything". Handoff §7.1 still holds — only the editor's
// Start says "working" — so the fix SHOWS the uploads as evidence instead:
//   "Last action 12:14pm — uploaded a version of 107 E Old Baltimore Pike ·
//    hasn't pressed Start today".
//
// Drives the SHIPPED code (lib/editorActivity, lib/editorWork, the /editing
// page) against an isolated PGlite on 127.0.0.1:DRILL_PORT (default 5831), and
// the old code pinned to a2f8484 beside it. The two client components are
// RENDERED with real React in a child process (no react-server condition), so
// the words asserted are the words on the screen. Production is never opened;
// every outbound call is fenced; nothing is sent to anybody.
//
// THE CLOCK IS PINNED to Monday Sep 28 2026, 16:34:00Z = 12:34pm ET, and runs
// forward from there.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module, { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5831);
const BASE = "a2f8484";
const REPO = path.resolve(__dirname, "../..");
const cjs = createRequire(__filename);

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 28, 16, 34, 0); // Mon Sep 28 2026 12:34pm ET
let clockOffsetMs = PARK - RealDate.now();
const drillNow = () => RealDate.now() + clockOffsetMs;
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
/** Move the clock to a UTC wall time today (Sep 28). */
const at = (h: number, m: number, s = 0) => new RealDate(RealDate.UTC(2026, 8, 28, h, m, s));
const clockTo = (d: Date) => { clockOffsetMs = d.getTime() - RealDate.now(); };

installNextStubs();
const fence = fenceFetch();
// lucide-react and next/link build React contexts at import time, which the
// react-server build of React does not have; the page's element tree is only
// WALKED here — the real rendering happens in the child process below.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    if (request === "next/link") return { __esModule: true, default: () => null };
    return prev.call(this, request, parent, isMain);
  };
}

// ---- old code, pinned to BASE --------------------------------------------
const BASE_DIR = path.join(REPO, "node_modules/.cache", `c1-baseline-${BASE}-${process.pid}`);
function baseline(rel: string, opts: { classicJsx?: boolean } = {}): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const out = path.join(BASE_DIR, rel.replace(/[/[\]]/g, "_"));
  let body = src.replace(/(["'])@\//g, `$1${REPO}/src/`);
  // A copy under node_modules is compiled without the repo's tsconfig, i.e.
  // with the classic JSX transform — which needs React in scope to render.
  if (opts.classicJsx) body = body.replace(/^("use client";\n)?/, (m) => `${m}import React from "react";\n`);
  fs.writeFileSync(out, body);
  return out;
}

// ---- the child renderer ---------------------------------------------------
type RenderCase = { id: string; module: string; exportName: string; props: unknown; nowISO: string };
const RENDER_SCRIPT = `/* eslint-disable */
const Module = require("module");
const fs = require("fs");
const [repo, inputFile] = process.argv.slice(2);
// useRouter needs a mounted app router; a render-only stub stands in.
const navFile = require.resolve("next/navigation", { paths: [repo] });
const nav = new Module(navFile, null);
nav.filename = navFile; nav.loaded = true;
nav.exports = { useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/editing", useSearchParams: () => new URLSearchParams(), useParams: () => ({}), redirect() { throw new Error("redirect"); }, notFound() { throw new Error("notFound"); } };
require.cache[navFile] = nav;
const RealDate = Date;
let pinned = RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(t, a) { return a.length ? Reflect.construct(t, a) : new t(pinned); },
  get(t, p, r) { return p === "now" ? () => pinned : Reflect.get(t, p, r); },
});
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const out = {};
for (const c of JSON.parse(fs.readFileSync(inputFile, "utf8"))) {
  pinned = RealDate.parse(c.nowISO);
  try {
    const mod = require(c.module);
    out[c.id] = { html: renderToStaticMarkup(createElement(mod[c.exportName], c.props)) };
  } catch (e) {
    out[c.id] = { error: String((e && e.stack) || e).slice(0, 600) };
  }
}
process.stdout.write(JSON.stringify(out));
`;
function renderAll(cases: RenderCase[]): Record<string, { html?: string; error?: string }> {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const script = path.join(BASE_DIR, "render.ts");
  const input = path.join(BASE_DIR, "render-input.json");
  fs.writeFileSync(script, RENDER_SCRIPT);
  fs.writeFileSync(input, JSON.stringify(cases));
  const stdout = execFileSync("npx", ["tsx", script, REPO, input], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    // Real React, not the react-server build; server-only neutralised because
    // SimpleQueue's module graph reaches its server actions (never called).
    env: { ...process.env, NODE_OPTIONS: "--require ./scripts/_drill/_client-drill-preload.cjs" },
  });
  return JSON.parse(stdout);
}
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const FORBIDDEN = /^On |\b(working|active|In editing)\b/i;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const work = await import("@/lib/editorWork");
  const ea = await import("@/lib/editorActivity");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { setSession } = await import("@/lib/auth/session");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const oldWork = (await import(baseline("src/lib/editorWork.ts"))) as typeof import("@/lib/editorWork");
  const oldPanelFile = baseline("src/components/editing/WorkingNowPanel.tsx", { classicJsx: true });

  type Line = import("@/lib/editorActivity").EditorLine;
  const allLines: { label: string; line: Line }[] = [];
  const seen = (label: string, v: import("@/lib/editorActivity").EditorsTodayView) => {
    if (v.ok) for (const l of v.lines) allLines.push({ label, line: l });
    return v;
  };
  const view = async (label: string) => {
    const now = new Date();
    const [wn, act] = await Promise.all([work.workingNow({ now }), ea.editorActivityToday({ now })]);
    return { wn, act, now, v: seen(label, ea.editorLines(wn, act, now)) };
  };
  const lineOf = (v: import("@/lib/editorActivity").EditorsTodayView, key: string) => (v.ok ? v.lines.find((l) => l.key === key) ?? null : null);
  const itemsOf = (act: import("@/lib/editorActivity").ActivityToday, key: string) => (act.ok ? act.editors[key]?.items ?? [] : []);

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  // A lookalike: "Kim" is inside her name. The chat rungs are exact, so her
  // messages must never be Kim's.
  const kimberly = await prisma.teamMember.create({ data: { name: "Kimberly Vance", email: "kimberly@drill.invalid", role: "VA" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, editorKey: string | null = null, teamMemberId: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey, teamMemberId }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER");
  const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", "kim", kimTm.id);
  const john = await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", "john", johnTm.id);
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });

  let seq = 0;
  type Job = { id: string; street: string; deliverableId: string };
  const mkJob = async (o: { street: string; editor: "kim" | "john" | "external_agency"; videos?: number; label?: string }): Promise<Job> => {
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Media, PA`, clientId: client.id, status: "SHOT", aryeoOrderId: `drill-c1-${++seq}`,
        shootDate: new Date(Date.now() - 2 * 86_400_000), photographerId: harrison.id,
        editorId: o.editor === "kim" ? kimTm.id : o.editor === "john" ? johnTm.id : null,
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: o.label ?? "Standard Reel", quantity: o.videos ?? 1 }, select: { id: true } });
    await prisma.smartTask.create({
      data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: "OPEN", assignedKey: o.editor, assignedManually: true, projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` },
    });
    await ensureOutputsForProject(p.id);
    return { id: p.id, street: o.street, deliverableId: d.id };
  };
  /** A version row as startCutUpload writes it (source "upload", the key only
   *  for an EDITOR session), with the check that rides it. */
  const upload = async (j: Job, o: { slot: number; round: number; when: Date; key: string | null; status?: string; source?: string; officeFor?: string | null }) => {
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: j.id, kind: "video", deliverableId: j.deliverableId, slot: o.slot, round: o.round, status: o.status ?? "PENDING",
        source: o.source ?? "upload", fileName: `c1-s${o.slot}-v${o.round}.mp4`, submittedByKey: o.key,
        submittedByName: o.key ? "Kim Miguel" : "Jordan Spackman", createdAt: o.when,
      },
      select: { id: true },
    });
    const office = o.key === null || o.officeFor !== undefined;
    const check = await prisma.cutSelfCheck.create({
      data: {
        submissionId: row.id, projectId: j.id, deliverableId: j.deliverableId, slot: o.slot, round: o.round,
        editorKey: office ? (o.officeFor ?? null) : o.key, actorUserId: office ? jordan.id : kim.id, actorName: office ? "Jordan Spackman" : "Kim Miguel",
        onBehalfOf: office ? (o.officeFor ?? "vendor") : null, checklistKey: "reel@v1", itemsJson: "[]", state: "VALID", createdAt: o.when,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { selfCheckId: check.id } });
    return { id: row.id, checkId: check.id };
  };
  const dropRow = async (r: { id: string; checkId?: string }) => {
    await prisma.cutSelfCheck.deleteMany({ where: { submissionId: r.id } });
    await prisma.reviewSubmission.delete({ where: { id: r.id } });
  };

  // 107 E Old Baltimore Pike: four videos, Kim's card, three uploads today.
  const P = await mkJob({ street: "107 E Old Baltimore Pike", editor: "kim", videos: 4, label: "Premium Reel" });
  await upload(P, { slot: 1, round: 1, when: at(13, 22), key: "kim" });
  await upload(P, { slot: 2, round: 1, when: at(15, 40), key: "kim" });
  await upload(P, { slot: 3, round: 1, when: at(16, 14), key: "kim" });
  // John: START → SUBMIT twice on Sep 26, nothing today.
  const Jn = await mkJob({ street: "22 Hilltop Rd", editor: "john" });
  {
    const d26 = (h: number, m: number) => new RealDate(RealDate.UTC(2026, 8, 26, h, m));
    const it = await prisma.editorWorkItem.create({
      data: { editorKey: "john", projectId: Jn.id, state: "CLOSED", closeReason: "SUBMITTED", closedAt: d26(17, 5), firstStartedAt: d26(15, 0), lastEventAt: d26(17, 5) },
      select: { id: true },
    });
    const ev = (kind: string, when: Date) =>
      prisma.editorWorkEvent.create({ data: { itemId: it.id, editorKey: "john", projectId: Jn.id, kind, at: when, actorUserId: john.id, actorName: "John Mark", actorRole: "EDITOR", onBehalf: false, reason: kind === "SUBMIT" ? "SUBMITTED" : null } });
    await ev("START", d26(15, 0));
    await ev("SUBMIT", d26(15, 25));
    await ev("START", d26(16, 41));
    await ev("SUBMIT", d26(17, 5));
  }
  clockTo(at(16, 34));

  const renders: RenderCase[] = [];
  const NEW_PANEL = path.join(REPO, "src/components/editing/WorkingNowPanel.tsx");
  const QUEUE = path.join(REPO, "src/components/editing/SimpleQueue.tsx");
  const LOAD = path.join(REPO, "src/components/editing/WorkloadPanel.tsx");

  // =========================================================================
  c.head(`1 · OLD (${BASE}): the complaint, reproduced`);
  // =========================================================================
  const oldWn = await oldWork.workingNow();
  const oldKim = oldWn.ok ? oldWn.editors.find((e) => e.key === "kim") : null;
  const kimUploads = await prisma.reviewSubmission.count({ where: { submittedByKey: "kim", source: "upload", createdAt: { gte: at(4, 0) } } });
  c.ok("old workingNow: Kim active null (nothing paused, nothing claimed) while her three uploads today exist",
    !!oldKim && oldKim.active === null && oldKim.paused.length === 0 && oldKim.unconfirmed.length === 0 && kimUploads === 3,
    `active=${oldKim?.active ? oldKim.active.street : "null"} · ${kimUploads} uploads`);
  renders.push({ id: "old-panel", module: oldPanelFile, exportName: "WorkingNowPanel", props: { data: oldWn }, nowISO: at(16, 34, 30).toISOString() });

  // =========================================================================
  c.head("2 · editorActivityToday — what each editor did today");
  // =========================================================================
  const s2 = await view("2");
  const k2 = itemsOf(s2.act, "kim");
  c.ok("Kim: 3 upload items, newest first (12:14, 11:40, 9:22 ET) — each upload's own check is not a second item",
    s2.act.ok && k2.length === 3 && k2.every((i) => i.kind === "upload" && i.projectId === P.id && i.street === P.street) &&
      k2[0].atISO === at(16, 14).toISOString() && k2[1].atISO === at(15, 40).toISOString() && k2[2].atISO === at(13, 22).toISOString(),
    k2.map((i) => `${i.kind}@${i.atISO.slice(11, 16)}`).join(", "));
  c.ok("Kim: startsToday is empty (she never pressed Start)", s2.act.ok && s2.act.editors.kim.startsToday.length === 0);
  c.ok("John: no items and no starts today (his Sep 26 START/SUBMIT pairs are outside the window)",
    s2.act.ok && s2.act.editors.john.items.length === 0 && s2.act.editors.john.startsToday.length === 0);
  c.ok("the window is today from 12:00am Eastern (04:00Z in EDT)", s2.act.ok && s2.act.since === at(4, 0).toISOString(), s2.act.ok ? s2.act.since : "");

  // =========================================================================
  c.head("3 · editorLines — Kim's line is evidence, labelled as evidence");
  // =========================================================================
  const KIM_1234 = "Last action 12:14pm — uploaded a version of 107 E Old Baltimore Pike · hasn't pressed Start today";
  const kl3 = lineOf(s2.v, "kim");
  c.ok("Kim: tone evidence, text EXACTLY the spec sentence", kl3?.tone === "evidence" && kl3.text === KIM_1234, kl3?.text);
  c.ok("…the street links to the job", kl3?.job?.street === P.street && kl3.job.href === `/edit/${P.id}`);
  c.ok("…details start with \"12:14pm uploaded v…\" and list all three uploads, newest first",
    !!kl3 && kl3.details[0]?.startsWith("12:14pm uploaded v") && kl3.details[1]?.startsWith("11:40am uploaded v") && kl3.details[2]?.startsWith("9:22am uploaded v"),
    kl3?.details.slice(0, 3).join(" | "));

  // =========================================================================
  c.head("4 · John, with nothing today");
  // =========================================================================
  const jl4 = lineOf(s2.v, "john");
  c.ok("John: \"Nothing in the hub today\" (tone idle) — what the HUB saw, never \"No activity today\" (Sep 28 review: editing in Premiere leaves nothing here)",
    jl4?.tone === "idle" && jl4.text === "Nothing in the hub today" && !/No activity/.test(jl4.text), jl4?.text);
  c.ok("the lines come in the desk order (Kim, John) and only for desk editors", s2.v.ok && s2.v.lines.map((l) => l.key).join(",") === "kim,john");

  // =========================================================================
  c.head("15a · rowEvidence on the backlog row");
  // =========================================================================
  const q15 = await buildEditorQueue();
  const row107 = q15.notDone.find((r) => r.id === P.id);
  const ev15 = row107 ? ea.rowEvidence(row107, s2.act, s2.now) : null;
  c.ok("107 E's row: { name: \"Kim\", words: \"uploaded a version\", at: \"12:14pm\" }",
    ev15?.name === "Kim" && ev15.words === "uploaded a version" && ev15.at === "12:14pm", JSON.stringify(ev15));
  c.ok("…and it is only evidence: the row's own word and work chip are untouched (nobody pressed Start)",
    !!row107 && row107.workChip === null && row107.work.active.length === 0 && !/In editing/.test(row107.status), `${row107?.status} · chip=${row107?.workChip}`);

  // =========================================================================
  c.head("16 · /editing as Jordan — the page hands the panel and the table these");
  // =========================================================================
  {
    // requirePageAccess reaches next/navigation through a dynamic import the
    // preload never sees; seed the real file's cache slot with the same stub.
    {
      const realNav = path.join(REPO, "node_modules/next/navigation.js");
      const M = Module as unknown as { new (id: string): { filename: string; loaded: boolean; exports: unknown }; _cache: Record<string, unknown> };
      const m = new M(realNav);
      m.filename = realNav;
      m.loaded = true;
      m.exports = cjs(path.join(__dirname, "_next-navigation-stub.cjs"));
      M._cache[realNav] = m;
    }
    let page: (() => Promise<unknown>) | null = null;
    let why = "";
    // The office's read at 12:34pm, as Jordan saw it.
    clockTo(at(16, 34));
    try {
      page = (cjs(path.join(REPO, "src/app/editing/page.tsx")) as { default: () => Promise<unknown> }).default;
    } catch (e) {
      why = (e as Error).message.slice(0, 160);
    }
    const { WorkingNowPanel } = cjs(NEW_PANEL) as typeof import("@/components/editing/WorkingNowPanel");
    const { SimpleQueue } = cjs(QUEUE) as typeof import("@/components/editing/SimpleQueue");
    const { WorkloadPanel } = cjs(LOAD) as typeof import("@/components/editing/WorkloadPanel");
    const { EditorDesk } = cjs(path.join(REPO, "src/components/editing/EditorDesk.tsx")) as { EditorDesk: unknown };
    const { EditorQualityCard } = cjs(path.join(REPO, "src/components/editing/EditorQualityCard.tsx")) as { EditorQualityCard: unknown };
    type El = { type?: unknown; props?: Record<string, unknown> };
    const find = (node: unknown, type: unknown, out: El[] = []): El[] => {
      if (Array.isArray(node)) { for (const n of node) find(n, type, out); return out; }
      if (!node || typeof node !== "object") return out;
      const el = node as El;
      if (el.type === type) out.push(el);
      if (el.props) for (const v of Object.values(el.props)) if (v && typeof v === "object") find(v, type, out);
      return out;
    };
    if (!page) {
      c.ok("the /editing page could be loaded in the drill", false, why);
    } else {
      await as(jordan);
      const tree = await page();
      const panels = find(tree, WorkingNowPanel);
      const pv = panels[0]?.props?.view as import("@/lib/editorActivity").EditorsTodayView | undefined;
      const pk = pv ? lineOf(pv, "kim") : null;
      c.ok("one WorkingNowPanel, fed `view` (not the old `data`), and Kim's line is check 3's sentence",
        panels.length === 1 && !!pv && pk?.text === KIM_1234 && !("data" in (panels[0]?.props ?? {})), pk?.text);
      const queues = find(tree, SimpleQueue);
      const nd = (queues[0]?.props?.notDone ?? []) as import("@/components/editing/SimpleQueue").QueueRow[];
      const r107 = nd.find((r) => r.id === P.id);
      c.ok("the backlog row for 107 E carries lastAction = Kim uploaded a version · 12:14pm",
        queues.length === 1 && r107?.lastAction?.name === "Kim" && r107.lastAction.words === "uploaded a version" && r107.lastAction.at === "12:14pm",
        JSON.stringify(r107?.lastAction));
      c.ok("no EditorDesk and no EditorQualityCard in the office tree", find(tree, EditorDesk).length === 0 && find(tree, EditorQualityCard).length === 0);
      const loads = find(tree, WorkloadPanel);
      c.ok("\"Who is holding what\" is still there (office, not `mine`)", loads.length === 1 && !loads[0].props?.mine);
      // For the real render below.
      if (pv) {
        renders.push({ id: "panel-fresh", module: NEW_PANEL, exportName: "WorkingNowPanel", props: { view: pv }, nowISO: at(16, 35).toISOString() });
        renders.push({ id: "panel-stale", module: NEW_PANEL, exportName: "WorkingNowPanel", props: { view: pv }, nowISO: at(16, 38).toISOString() });
      }
      renders.push({ id: "queue-office", module: QUEUE, exportName: "SimpleQueue", props: { notDone: nd, upcoming: [], done: [] }, nowISO: at(16, 35).toISOString() });
      renders.push({ id: "queue-editor", module: QUEUE, exportName: "SimpleQueue", props: { notDone: nd, upcoming: [], done: [], hideEditor: true }, nowISO: at(16, 35).toISOString() });
      if (loads[0]) renders.push({ id: "workload", module: LOAD, exportName: "WorkloadPanel", props: { view: loads[0].props?.view }, nowISO: at(16, 35).toISOString() });
    }
  }

  // =========================================================================
  c.head("17 · Luma Visuals: no login, no line, no evidence");
  // =========================================================================
  const Lu = await mkJob({ street: "3 Luma Ln", editor: "external_agency" });
  await upload(Lu, { slot: 1, round: 1, when: at(16, 20), key: null, officeFor: null }); // the office's upload: onBehalfOf "vendor"
  {
    const s17 = await view("17");
    const everywhere = s17.act.ok ? Object.values(s17.act.editors).flatMap((e) => e.items) : [];
    const lumaRow = (await buildEditorQueue()).notDone.find((r) => r.id === Lu.id);
    c.ok("no line for the outside shop", s17.v.ok && !s17.v.lines.some((l) => l.key === "external_agency" || l.key === "luma"));
    c.ok("no evidence anywhere for its job, and no editor slot for it in the read",
      everywhere.every((i) => i.projectId !== Lu.id) && s17.act.ok && !("external_agency" in s17.act.editors) && !("luma" in s17.act.editors));
    c.ok("its backlog row exists and carries no evidence", !!lumaRow && ea.rowEvidence(lumaRow, s17.act, s17.now) === null, lumaRow?.status);
    c.ok("…and Kim's line did not move", lineOf(s17.v, "kim")?.text === KIM_1234);
  }

  // =========================================================================
  c.head("5 · EXCLUDED — none of these is Kim doing something");
  // =========================================================================
  const kimItems = async () => JSON.stringify(itemsOf(await ea.editorActivityToday(), "kim"));
  const base5 = await kimItems();
  const unchanged = async (label: string, arrange: () => Promise<(() => Promise<unknown>) | void>) => {
    const undo = await arrange();
    const after = await kimItems();
    c.ok(`${label} — Kim's items unchanged`, after === base5, after === base5 ? "" : after.slice(0, 200));
    if (undo) await undo();
  };
  await unchanged("a folder-sweep row with key kim (source \"folder\")", async () => {
    const r = await prisma.reviewSubmission.create({ data: { projectId: P.id, kind: "video", round: 1, status: "PENDING", source: "folder", assetPath: "/Drill/sweep.mp4", fileName: "sweep.mp4", submittedByKey: "kim", createdAt: at(16, 30) }, select: { id: true } });
    return () => prisma.reviewSubmission.delete({ where: { id: r.id } });
  });
  await unchanged("an office \"upload\" row (key null) with its on-behalf check for Kim", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(16, 30), key: null, officeFor: "kim" });
    return () => dropRow(r);
  });
  await unchanged("an office \"button\" send (key kim) whose check is onBehalfOf \"kim\"", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(16, 30), key: "kim", source: "button", officeFor: "kim" });
    return () => dropRow(r);
  });
  const ownerNote = await prisma.mediaNote.create({
    data: { projectId: P.id, assetUrl: "https://drill.invalid/cut.mp4", assetType: "video", body: "Trim the intro", authorKey: "owner", authorName: "Jordan Spackman", authorUserId: jordan.id, createdAt: at(16, 25) },
    select: { id: true },
  });
  await unchanged("an owner MediaNote", async () => undefined);
  await unchanged("a ThreadRead upsert for Kim (reading the chat)", async () => {
    await prisma.threadRead.upsert({ where: { userKey_projectId: { userKey: kim.id, projectId: P.id } }, create: { userKey: kim.id, projectId: P.id, seenAt: at(16, 31) }, update: { seenAt: at(16, 31) } });
  });
  await unchanged("a FIXED flip on Jordan's note, made in Kim's name (free text, not an identity)", async () => {
    await prisma.mediaNote.update({ where: { id: ownerNote.id }, data: { status: "FIXED", statusBy: "Kim Miguel", statusAt: at(16, 31) } });
  });
  await unchanged("the Activity row \"Kim started editing.\"", async () => {
    await prisma.activity.create({ data: { projectId: P.id, type: "SYSTEM", body: "Kim started editing.", createdAt: at(16, 31) } });
  });
  await unchanged("a chat message by the lookalike \"Kimberly Vance\" (the rungs are exact, never `contains`)", async () => {
    const m = await prisma.projectMessage.create({ data: { projectId: P.id, authorId: kimberly.id, authorName: "Kimberly Vance", body: "hi", createdAt: at(16, 31) }, select: { id: true } });
    return () => prisma.projectMessage.delete({ where: { id: m.id } });
  });
  await unchanged("a Kim upload at 03:59:59Z today (11:59pm ET yesterday)", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(3, 59, 59), key: "kim" });
    return () => dropRow(r);
  });
  await unchanged("opening /editing as Kim, then as Jordan (a page view is not an action)", async () => {
    const pg = (cjs(path.join(REPO, "src/app/editing/page.tsx")) as { default: () => Promise<unknown> }).default;
    await as(kim);
    await pg().catch(() => null);
    await as(jordan);
    await pg().catch(() => null);
  });
  {
    const r = await upload(P, { slot: 4, round: 1, when: at(4, 0, 0), key: "kim" });
    const items = itemsOf(await ea.editorActivityToday(), "kim");
    c.ok("boundary: a Kim upload at 04:00:00Z (12:00am ET today) IS included", items.length === 4 && items[3].atISO === at(4, 0).toISOString(), `${items.length} items`);
    await dropRow(r);
  }

  // =========================================================================
  c.head("6 · INCLUDED — one at a time, with the exact lead words");
  // =========================================================================
  const included = async (label: string, want: string, arrange: () => Promise<() => Promise<unknown>>, who = "kim", growBy = 1) => {
    const before = itemsOf(await ea.editorActivityToday(), who).length;
    const undo = await arrange();
    const s = await view(`6 ${label}`);
    const l = lineOf(s.v, who);
    const grew = itemsOf(s.act, who).length - before;
    c.ok(`${label} → "${want}"`, l?.tone === "evidence" && l.lead === `Last action 12:20pm — ${want}` && l.job?.street === P.street && grew === growBy, `${l?.text} (+${grew})`);
    await undo();
  };
  await included("a Kim reply MediaNote (editor:kim, parentId)", "replied to a note on", async () => {
    const n = await prisma.mediaNote.create({ data: { projectId: P.id, assetUrl: "https://drill.invalid/cut.mp4", assetType: "video", body: "Done — trimmed", authorKey: "editor:kim", authorName: "Kim Miguel", authorUserId: kim.id, parentId: ownerNote.id, lane: "EDIT", createdAt: at(16, 20) }, select: { id: true } });
    return () => prisma.mediaNote.delete({ where: { id: n.id } });
  });
  await included("a Kim note (no parent)", "wrote a note on", async () => {
    const n = await prisma.mediaNote.create({ data: { projectId: P.id, assetUrl: "https://drill.invalid/cut.mp4", assetType: "video", body: "Question on the music", authorKey: "editor:kim", authorName: "Kim Miguel", authorUserId: kim.id, lane: "EDIT", createdAt: at(16, 20) }, select: { id: true } });
    return () => prisma.mediaNote.delete({ where: { id: n.id } });
  });
  await included("a ProjectMessage by Kim's TeamMember", "posted in the chat on", async () => {
    const m = await prisma.projectMessage.create({ data: { projectId: P.id, authorId: kimTm.id, authorName: "Kim Miguel", body: "Uploading v3 now", createdAt: at(16, 20) }, select: { id: true } });
    return () => prisma.projectMessage.delete({ where: { id: m.id } });
  });
  await included("an UPLOADING row", "started uploading a version of", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(16, 20), key: "kim", status: "UPLOADING" });
    return () => dropRow(r);
  });
  await included("an UPLOAD_FAILED row", "tried to upload a version of", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(16, 20), key: "kim", status: "UPLOAD_FAILED" });
    return () => dropRow(r);
  });
  await included("a held-cut check (VALID, onBehalfOf null, actorUserId Kim, a folder row)", "did the review check on", async () => {
    const f = await prisma.reviewSubmission.create({ data: { projectId: P.id, kind: "video", round: 1, status: "PENDING", source: "folder", assetPath: "/Drill/held.mp4", fileName: "held.mp4", submittedByKey: "kim", createdAt: at(15, 0) }, select: { id: true } });
    await prisma.cutSelfCheck.create({ data: { submissionId: f.id, projectId: P.id, round: 1, slot: 1, editorKey: "kim", actorUserId: kim.id, actorName: "Kim Miguel", onBehalfOf: null, checklistKey: "reel@v1", itemsJson: "[]", state: "VALID", createdAt: at(16, 20) } });
    return () => dropRow(f);
  });
  await included("Kim's own \"button\" send (her check, onBehalfOf null) — one item, not two", "sent a version to review from", async () => {
    const r = await upload(P, { slot: 4, round: 1, when: at(16, 20), key: "kim", source: "button" });
    return () => dropRow(r);
  });
  await included("John's message through the NAME rung (login not linked; exact roster name)", "posted in the chat on", async () => {
    await prisma.appUser.update({ where: { id: john.id }, data: { teamMemberId: null } });
    const m = await prisma.projectMessage.create({ data: { projectId: P.id, authorId: johnTm.id, authorName: "John Mark", body: "Can take video 4", createdAt: at(16, 20) }, select: { id: true } });
    return async () => {
      await prisma.projectMessage.delete({ where: { id: m.id } });
      await prisma.appUser.update({ where: { id: john.id }, data: { teamMemberId: johnTm.id } });
    };
  }, "john");
  const s6 = await view("6 after");
  c.ok("…and after each copy is removed, Kim is back to check 3's line", lineOf(s6.v, "kim")?.text === KIM_1234);
  const wn0 = s6.wn; // the 12:34 state, for check 11

  // =========================================================================
  c.head("7 · Kim presses Start at 12:40pm");
  // =========================================================================
  clockTo(at(16, 40));
  await as(kim);
  const st7 = await work.startEditing({ projectId: P.id, requestId: "c1-kim-107-start" });
  const s7 = await view("7");
  const kl7 = lineOf(s7.v, "kim");
  c.ok("Kim: tone on, \"On 107 E Old Baltimore Pike since 12:40pm\"", st7.ok && kl7?.tone === "on" && kl7.text === "On 107 E Old Baltimore Pike since 12:40pm", `${st7.message} → ${kl7?.text}`);
  c.ok("startsToday has length 1", s7.act.ok && s7.act.editors.kim.startsToday.length === 1);
  {
    const row = (await buildEditorQueue()).notDone.find((r) => r.id === P.id);
    c.ok("15b · rowEvidence(107 E) is null while Kim is ACTIVE on that row (her Start chip says it)", !!row && row.work.active.some((a) => a.key === "kim") && ea.rowEvidence(row, s7.act, s7.now) === null, row?.workChip ?? "");
  }

  // =========================================================================
  c.head("8 · Jordan's \"Start for Kim\" on another job — labelled as the office");
  // =========================================================================
  const J9 = await mkJob({ street: "9 Office Ln", editor: "kim" });
  clockTo(at(16, 42));
  await as(jordan);
  const st8 = await work.startEditing({ projectId: J9.id, forEditorKey: "kim", requestId: "c1-office-9" });
  const s8 = await view("8");
  const kl8 = lineOf(s8.v, "kim");
  c.ok("\"On 9 Office Ln since 12:42pm · started by Jordan Spackman (office)\"",
    st8.ok && kl8?.tone === "on" && kl8.text === "On 9 Office Ln since 12:42pm · started by Jordan Spackman (office)", kl8?.text);
  c.ok("the office's press is not Kim's: startsToday still 1", s8.act.ok && s8.act.editors.kim.startsToday.length === 1);
  c.ok("details carry the office's auto-pause of 107 E, with the real actor",
    !!kl8?.details.includes("Paused: 107 E Old Baltimore Pike — 12:42pm (by Jordan Spackman, office)"), kl8?.details.join(" | "));

  // =========================================================================
  c.head("9 · Kim pauses at 12:45pm");
  // =========================================================================
  clockTo(at(16, 45));
  await as(kim);
  const p9 = await work.pauseEditing({ projectId: J9.id, requestId: "c1-kim-9-pause" });
  const s9 = await view("9");
  const kl9 = lineOf(s9.v, "kim");
  c.ok("\"Paused 9 Office Ln at 12:45pm\" (tone paused — her own pause, so no office tag)",
    p9.ok && kl9?.tone === "paused" && kl9.text === "Paused 9 Office Ln at 12:45pm", kl9?.text);
  c.ok("the older pause (107 E, by the office) is in the details, not on the line",
    !!kl9?.details.some((d) => d.startsWith("Paused: 107 E Old Baltimore Pike — 12:42pm (by Jordan Spackman, office)")));
  const wn9 = s9.wn;

  // =========================================================================
  c.head("10 · Start, then a hand-in: the upload ends the Start");
  // =========================================================================
  clockTo(at(16, 48));
  await as(kim);
  const st10 = await work.startEditing({ projectId: P.id, requestId: "c1-kim-107-resume" });
  clockTo(at(16, 50));
  await upload(P, { slot: 4, round: 1, when: at(16, 50), key: "kim" });
  await work.closeActiveWork(P.id, { editorKey: "kim", reason: "SUBMITTED", actor: { userId: kim.id, name: "Kim Miguel", role: "EDITOR" } });
  const s10 = await view("10");
  const kl10 = lineOf(s10.v, "kim");
  c.ok("\"Last action 12:50pm — uploaded a version of 107 E Old Baltimore Pike · hasn't pressed Start since\"",
    st10.ok && kl10?.tone === "evidence" && kl10.text === "Last action 12:50pm — uploaded a version of 107 E Old Baltimore Pike · hasn't pressed Start since", kl10?.text);
  c.ok("…her Start and Resume today are both counted (2), the office's is not", s10.act.ok && s10.act.editors.kim.startsToday.length === 2);
  c.ok("…the 12:45 pause is older than the upload, so it sits in the details", !!kl10?.details.some((d) => d.startsWith("Paused: 9 Office Ln — 12:45pm")));
  // A Start AFTER the last action, closed by somebody else: the tail names it
  // rather than say "hasn't pressed Start since" (which would be false).
  clockTo(at(16, 52));
  await work.startEditing({ projectId: J9.id, requestId: "c1-kim-9-resume" });
  await work.closeActiveWork(J9.id, { editorKey: "kim", reason: "REASSIGNED" });
  const s10b = await view("10b");
  const kl10b = lineOf(s10b.v, "kim");
  c.ok("a later Start that the hub closed reads \"· last pressed Start 12:52pm\", never \"hasn't pressed Start since\"",
    kl10b?.tone === "evidence" && kl10b.text === "Last action 12:50pm — uploaded a version of 107 E Old Baltimore Pike · last pressed Start 12:52pm", kl10b?.text);

  // =========================================================================
  c.head("11 · the activity read fails — uncertainty, never \"Nothing in the hub today\"");
  // =========================================================================
  const failedSynthetic = { ok: false as const, readAt: new Date().toISOString(), error: "Couldn't read today's activity." as const };
  const v11 = seen("11 synthetic", ea.editorLines(wn0, failedSynthetic, new Date()));
  const kl11 = lineOf(v11, "kim");
  c.ok("Kim (not active, nothing paused today) → unknown, \"Not on anything · couldn't read today's activity\"",
    kl11?.tone === "unknown" && kl11.text === "Not on anything · couldn't read today's activity", kl11?.text);
  c.ok("John too — never \"Nothing in the hub today\" off a failed read", lineOf(v11, "john")?.tone === "unknown");
  const v11p = seen("11 paused", ea.editorLines(wn9, failedSynthetic, new Date()));
  c.ok("a pause made today still reads Paused when the activity read failed", lineOf(v11p, "kim")?.text === "Paused 9 Office Ln at 12:45pm", lineOf(v11p, "kim")?.text);
  await prisma.$executeRawUnsafe(`ALTER TABLE "MediaNote" RENAME TO "MediaNote_away"`);
  let realFail: import("@/lib/editorActivity").ActivityToday | null = null;
  let threw = "";
  try { realFail = await ea.editorActivityToday(); } catch (e) { threw = (e as Error).message; }
  await prisma.$executeRawUnsafe(`ALTER TABLE "MediaNote_away" RENAME TO "MediaNote"`);
  c.ok("a REAL failed read (a table unreadable) comes back ok:false — it does not throw",
    !threw && !!realFail && !realFail.ok && realFail.error === "Couldn't read today's activity.", threw || JSON.stringify(realFail).slice(0, 120));
  if (realFail) {
    const vr = seen("11 real", ea.editorLines(s10b.wn, realFail, new Date()));
    c.ok("…and Kim's line off it is the unknown one", lineOf(vr, "kim")?.tone === "unknown", lineOf(vr, "kim")?.text);
  }

  // =========================================================================
  c.head("12 · the Start/Pause read fails — the whole panel says so");
  // =========================================================================
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem" RENAME TO "EditorWorkItem_away"`);
  const wnFail = await work.workingNow();
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem_away" RENAME TO "EditorWorkItem"`);
  const v12 = ea.editorLines(wnFail, s10b.act, new Date());
  c.ok("workingNow ok:false → the view is ok:false with its reason", !wnFail.ok && !v12.ok && "error" in v12 && /Couldn't read who is working/.test(v12.error), v12.ok ? "ok:true" : v12.error);
  renders.push({ id: "panel-failed", module: NEW_PANEL, exportName: "WorkingNowPanel", props: { view: v12 }, nowISO: new Date().toISOString() });

  // =========================================================================
  c.head("15c · two editors on one job");
  // =========================================================================
  {
    const S = await mkJob({ street: "5 Shared Ln", editor: "kim", videos: 2 });
    // John carries video 2 — how two editors share one job (holdersFor).
    await prisma.deliverableOutput.updateMany({ where: { projectId: S.id, slot: 2 }, data: { ownerKey: "john", ownerName: "John Mark" } });
    clockTo(at(16, 54));
    await as(john);
    const js = await work.startEditing({ projectId: S.id, requestId: "c1-john-shared" });
    clockTo(at(16, 55));
    await upload(S, { slot: 1, round: 1, when: at(16, 55), key: "kim" });
    const s15 = await view("15c");
    const row = (await buildEditorQueue()).notDone.find((r) => r.id === S.id);
    const ev = row ? ea.rowEvidence(row, s15.act, s15.now) : null;
    c.ok("John ACTIVE on the row, and rowEvidence returns KIM's action (she is not on it)",
      js.ok && !!row && row.work.active.some((a) => a.key === "john") && ev?.name === "Kim" && ev.words === "uploaded a version" && ev.at === "12:55pm",
      `${js.message} · ${JSON.stringify(ev)}`);
    c.ok("each editor has their own line: John green on 5 Shared Ln, Kim amber on it",
      lineOf(s15.v, "john")?.text === "On 5 Shared Ln since 12:54pm" && !!lineOf(s15.v, "kim")?.text.startsWith("Last action 12:55pm — uploaded a version of 5 Shared Ln"),
      `${lineOf(s15.v, "john")?.text} / ${lineOf(s15.v, "kim")?.text}`);
  }

  // =========================================================================
  c.head("14 · read-only");
  // =========================================================================
  {
    const counts = async () => JSON.stringify(await Promise.all([
      prisma.editorWorkItem.count(), prisma.editorWorkEvent.count(), prisma.activity.count(), prisma.smartTask.count(), prisma.notification.count(),
    ]));
    const before = await counts();
    for (let i = 0; i < 10; i++) {
      const now = new Date();
      const [wn, act] = await Promise.all([work.workingNow({ now }), ea.editorActivityToday({ now })]);
      ea.editorLines(wn, act, now);
      for (const r of (await buildEditorQueue()).notDone) ea.rowEvidence(r, act, now);
    }
    const after = await counts();
    c.ok("EditorWorkItem / EditorWorkEvent / Activity / SmartTask / Notification counts unchanged across 10 reads", before === after, `${before} → ${after}`);
    const src = fs.readFileSync(path.join(REPO, "src/lib/editorActivity.ts"), "utf8");
    const writes = src.match(/\.create\(|\.update\(|\.upsert\(|\.delete\(|deleteMany|updateMany|\$executeRaw/g);
    c.ok("editorActivity.ts has no write call in its source", !writes, writes?.join(", "));
  }

  // =========================================================================
  c.head("R · rendered with real React (child process): the panel, the table, the workload");
  // =========================================================================
  const html = renderAll(renders);
  const get = (id: string) => html[id]?.html ?? "";
  for (const [id, r] of Object.entries(html)) if (r.error) c.ok(`render ${id}`, false, r.error);
  {
    const t = textOf(get("old-panel"));
    c.ok(`1 · OLD panel (${BASE}) rendered with that data: "Kim Not on anything … Nobody has pressed Start on anything right now." — the screen Jordan read`,
      /Working now/.test(t) && /Kim Not on anything/.test(t) && /John Mark Not on anything/.test(t) && t.includes("Nobody has pressed Start on anything right now.") && !/upload/i.test(t),
      t.slice(0, 160));
  }
  {
    const fresh = get("panel-fresh");
    const stale = get("panel-stale");
    const tf = textOf(fresh);
    c.ok("new panel: \"Editors today · as of 12:34pm\", Kim's evidence sentence, John \"Nothing in the hub today\"",
      tf.includes("Editors today") && tf.includes("as of 12:34pm") && tf.includes(`Kim ${KIM_1234}`) && tf.includes("John Mark Nothing in the hub today") && !/No activity/.test(tf), tf.slice(0, 220));
    c.ok("…and \"Not on anything\" is gone from it", !/Not on anything/.test(tf));
    c.ok("…the street is a link to the job, and the amber tail is text-warning",
      fresh.includes(`href="/edit/${P.id}"`) && /text-warning">· hasn&#x27;t pressed Start today</.test(fresh));
    c.ok("…details are a native <details> under the line (12:14pm, 11:40am, 9:22am)",
      /<summary[^>]*>details<\/summary><ul[^>]*><li>12:14pm uploaded v1 \(video 3\) of 107 E Old Baltimore Pike<\/li><li>11:40am uploaded v1 \(video 2\) of 107 E Old Baltimore Pike<\/li><li>9:22am uploaded v1 of 107 E Old Baltimore Pike<\/li>/.test(fresh));
    c.ok("…the legend and the \"How this works\" lines are in the footer",
      tf.includes("pressed Start · did something in the hub today, no Start · nothing in the hub today") && tf.includes("Green means the editor pressed Start. Only Start says someone is working.") && tf.includes("Today = since 12am Eastern. Opening a page never counts.") &&
      tf.includes("Editing on their own computer (Premiere, Dropbox) doesn’t show here until they upload or press Start — “nothing in the hub” is not “not working”."));
    const ts = textOf(stale);
    const linesOf = (h: string) => h.slice(h.indexOf('<div class="divide-y'), h.indexOf('<div class="space-y-1 border-t'));
    c.ok("stale (4 minutes later): the header says \"may be out of date — read 12:34pm\"; the lines are byte-identical",
      ts.includes("may be out of date — read 12:34pm") && !ts.includes("as of 12:34pm") && linesOf(stale) === linesOf(fresh) && linesOf(fresh).length > 100);
    const tx = textOf(get("panel-failed"));
    c.ok("failed read: \"Couldn't read who is working — last attempt … This is not “nobody is working”; refresh to try again.\"",
      /Couldn[’']t read who is working — last attempt \d/.test(tx) && tx.includes("This is not “nobody is working”; refresh to try again.") && !/Nothing in the hub today/.test(tx), tx.slice(0, 160));
  }
  {
    const qo = get("queue-office");
    const tq = textOf(qo);
    const ths = (h: string) => (h.match(/<th /g) ?? []).length;
    c.ok("backlog (office): 7 columns, no \"Videos\" header, min-w 700", ths(qo) === 7 && !/>Videos</.test(qo) && qo.includes("min-w-[700px]"), `${ths(qo)} th`);
    c.ok("…107 E's type pill reads \"<tier> · 4 videos\"", /(Standard|Premium|Personal Branding) · 4 videos/.test(tq), tq.match(/(Standard|Premium|Personal Branding)[^A-Z]{0,12}/)?.[0]);
    c.ok("…the evidence line \"Kim uploaded a version · 12:14pm\" with its not-a-Start title",
      tq.includes("Kim uploaded a version · 12:14pm") && qo.includes('title="Today&#x27;s activity — not a Start. Only Start and Pause say someone is working."'));
    c.ok("…no \"auto\" chip, no \"Script\" chip; the routing note is on the select's title",
      !/>auto</.test(qo) && !/>Script</.test(qo) && !/Script/.test(tq));
    c.ok("…the row still reads its own word (nobody pressed Start), not \"In editing\"", !/In editing/.test(tq));
    const qe = get("queue-editor");
    c.ok("backlog (editor's own view): 6 columns and no evidence line", ths(qe) === 6 && !textOf(qe).includes("uploaded a version"), `${ths(qe)} th`);
  }
  {
    const w = get("workload");
    const tw = textOf(w);
    c.ok("Who is holding what: one line per editor — \"Kim · N to edit\" / \"nothing to edit\"", /Who is holding what/.test(tw) && /Kim · (\d+ to edit|nothing to edit)/.test(tw) && /John Mark · (\d+ to edit|nothing to edit)/.test(tw), tw.slice(0, 200));
    const how = w.indexOf(">How these numbers work</summary>");
    c.ok("…\"Work owed, not work happening now — who is on what is in Editors today, above.\" is inside \"How these numbers work\"",
      how > 0 && w.indexOf("Work owed, not work happening now — who is on what is in Editors today, above.") > how);
    // Everything outside the <details> blocks is what the line itself shows.
    const onTheLine = textOf(w.replace(/<details[\s\S]*?<\/details>/g, ""));
    c.ok("…the lane chips, the rate and the method notes are all behind \"details\" — the line carries none of them",
      tw.includes("Owed to the editor") && /in the sample/.test(tw) &&
        !/Owed to the editor|Waiting on a verdict|in the sample|a week \(|far more than|Work owed, not work happening now/.test(onTheLine),
      onTheLine.slice(0, 200));
  }

  // =========================================================================
  c.head("13 · §7.1 guard over every line produced above");
  // =========================================================================
  {
    const bad = allLines.filter(({ line }) => line.tone !== "on" && FORBIDDEN.test(line.text));
    const onOk = allLines.filter(({ line }) => line.tone === "on").every(({ line }) => line.text.startsWith("On "));
    const claimsOnlyInDetails = allLines.every(({ line }) => !line.text.includes("Marked"));
    c.ok(`no non-green line starts "On " or says working / active / In editing (${allLines.length} lines checked)`, bad.length === 0, bad.map((b) => `${b.label}: ${b.line.text}`).join(" | "));
    c.ok("every green line starts \"On \"; old \"In editing\" marks live only in details", onOk && claimsOnlyInDetails);
    c.ok("evidence says \"Last action\", never \"Last active\"", allLines.every(({ line }) => !/Last active/i.test(line.text)));
  }

  // ---- close ---------------------------------------------------------------
  c.ok("nothing left the building: every outbound call was blocked, none attempted", fence.blocked.length === 0 && fence.faked.length === 0, `${fence.blocked.length} blocked`);
  quiet.restore();
  c.summary();
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
