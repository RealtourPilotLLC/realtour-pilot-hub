// ---------------------------------------------------------------------------
// DRILL: EVIDENCE, GAPS, FIELD FEEDBACK — unified handoff §7.3, §7.6, §7.8
// (Task B, Sep 28 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/evidence-gaps-feedback.ts
//
// OLD behaviour first wherever it can be observed: the modules as they stood
// at 0950c1c (git show, `@/` imports aimed at this tree) run on the same rows.
//
//   §1 §7.3 THE LADDER ON THE TRACKER AND THE SUMMARY. One read
//      (lib/handoffLadder) behind the edit tracker and the project summary;
//      one set of words (lib/handoff evidenceRungs) — evidenceLine is word for
//      word what it was. OLD: neither card said anything about the files. The
//      per-video rawInAt stamp: written by the REAL status sweep on a fresh
//      read that found footage, once, only when the job owes one video, and
//      only by the pass that FIRST sees it (a job whose raws the 0950c1c sweep
//      already confirmed stays unknown, never stamped late; review Sep 28);
//      OLD never wrote it.
//   §2 §7.6 MISSING WORK ON KYLE'S BOARD. An open gap is the blocker, in
//      plain words ("Missing work: <what> — <owner> by <due>"); OLD read a
//      not-completed reel as "Waiting on video", a delivered job as
//      "Delivered". A limitation on a video's brief becomes a gap in one press,
//      signed by who pressed it; the office's only; never a waiver; its words
//      money-safe from the start, and every gap money-safe for creatives.
//   §3 §7.8 FIELD FEEDBACK. The AI working profile reads only CONFIRMED field
//      reports; OLD fed it the photographer's raw flags and debrief notes.
//      A listing-only client's page lists its field reports; Confirm/Reject
//      are the office's.
//   §4 nothing left the building.
//
// ISOLATION. PGlite on 127.0.0.1:5992 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced:
// Dropbox and the model are FAKED in memory, everything else is blocked and
// counted. AUTH_ENFORCE is on.
//
// THE CLOCK is pinned to Monday Sep 28 2026, 14:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5992);
const BASE = "0950c1c"; // the commit this task starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");
const CACHE = path.join(REPO, "node_modules/.cache", `egf-drill-${process.pid}`);

const RealDate = Date;
let SIM = RealDate.parse("2026-09-28T14:00:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();

// ---- the fence: an in-memory Dropbox and a recorded model -------------------
/** folder path (lower-case) → how many files are in it, recursively. */
const FS = new Map<string, number>();
/** folder paths (lower-case) whose read FAILS (not a not-found — unreadable). */
const BROKEN = new Set<string>();
const prompts: string[] = [];
/** Every request that reached the (read-only) Aryeo fake: "METHOD /path". */
const aryeoCalls: string[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const PROFILE_REPLY = JSON.stringify({
  summary: "Drill profile.", touchLevel: "low", workingStyle: "", communication: "",
  revisions: { summary: "", commonTypes: [] }, brandStyle: "", shootNotes: [], aboutThem: [], dos: [], donts: [],
  editing: { summary: "", prefs: [], customerNotes: [], dos: [], donts: [] },
});
const fence = fenceFetch((url, init) => {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-access-not-real", expires_in: 14400 });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as { path?: string }) : {};
    if (ep === "users/get_current_account") return json({ root_info: {} });
    if (ep === "files/list_folder") {
      const p = String(arg.path ?? "").toLowerCase();
      if (BROKEN.has(p)) return json({ error_summary: "drill: unreadable/" }, 400);
      if (!FS.has(p)) return json({ error_summary: "path/not_found/.." }, 409);
      const n = FS.get(p) ?? 0;
      return json({ entries: Array.from({ length: n }, (_, i) => ({ ".tag": "file", name: `clip${i}.mp4`, path_display: `${arg.path}/clip${i}.mp4`, id: `id:${p}:${i}` })), has_more: false });
    }
    return json({ error_summary: `drill: unscripted ${ep}` }, 400);
  }
  // One read only: a listing with nothing on it yet, so the sweep can read
  // Aryeo while Dropbox fails and reach its carried-forward (stale) branch.
  if (url.startsWith("https://api.aryeo.com/v1/")) {
    const u = new URL(url);
    aryeoCalls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const m = /^\/v1\/listings\/([^/]+)$/.exec(u.pathname);
    if ((init?.method ?? "GET") === "GET" && m) return json({ data: { id: m[1], images: [], videos: [], floor_plans: [], interactive_content: [] } });
    return null;
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    prompts.push(body.messages?.[0]?.content ?? "");
    return json({ content: [{ type: "text", text: PROFILE_REPLY }] });
  }
  return null;
});

// ---- old code, pinned to BASE ----------------------------------------------
function baseline(rel: string, jsx = false): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`);
  // Outside the tsconfig's reach (node_modules/.cache) tsx compiles JSX with
  // the classic runtime, so an old component gets the React binding it assumes.
  fs.writeFileSync(out, `${jsx ? 'import * as React from "react";\n' : ""}${src.replace(/(["'])@\//g, `$1${REPO}/src/`)}`);
  return out;
}

// ---- rendering, in a child (react-dom/server, no react-server condition) ----
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
type RenderCase = { name: string; file: string; exp: string; props: Record<string, unknown> };
function render(cases: RenderCase[]): Record<string, string> {
  fs.mkdirSync(CACHE, { recursive: true });
  const seed = path.join(CACHE, "seed.cjs");
  fs.writeFileSync(seed, `/* eslint-disable */
const Module = require("module");
const path = require("path");
const root = ${JSON.stringify(REPO)};
const put = (file, exports) => { const m = new Module(file, null); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m; };
const React = require(require.resolve("react", { paths: [root] }));
put(require.resolve("next/navigation", { paths: [root] }), { useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams(), redirect() { throw new Error("redirect"); }, notFound() { throw new Error("notFound"); } });
put(require.resolve("next/link", { paths: [root] }), { __esModule: true, default: (p) => React.createElement("a", { href: p.href, className: p.className }, p.children) });
const noop = async () => ({ ok: true, message: "" });
put(path.join(root, "src/app/upload/actions.ts"), { __esModule: true, decideFieldReport: noop });
`);
  const runner = path.join(CACHE, "render.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const RealDate = Date;
const NOW = RealDate.parse(process.env.EGF_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const cases = JSON.parse(require("fs").readFileSync(process.env.EGF_CASES as string, "utf8"));
const out: Record<string, string> = {};
for (const c of cases) {
  try {
    out[c.name] = renderToStaticMarkup(createElement(require(c.file)[c.exp], c.props));
  } catch (e) {
    out[c.name] = "RENDER_ERROR: " + (e as Error).message;
  }
}
process.stdout.write("\\n@@EGF@@" + JSON.stringify(out));
`);
  const casesFile = path.join(CACHE, `cases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  const res = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [runner], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: {
      ...process.env,
      // Quoted: the repo folder name has spaces, and NODE_OPTIONS splits on them.
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "scripts/_drill/_client-drill-preload.cjs"))} --require ${JSON.stringify(seed)}`,
      EGF_NOW: new RealDate(SIM).toISOString(),
      EGF_CASES: casesFile,
    },
  });
  const at = res.lastIndexOf("@@EGF@@");
  return at >= 0 ? (JSON.parse(res.slice(at + 7)) as Record<string, string>) : {};
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({
    port: PORT,
    env: { AUTH_ENFORCE: "true", DROPBOX_APP_KEY: "drill-app-key", DROPBOX_APP_SECRET: "drill-app-secret" },
  });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const handoff = await import("@/lib/handoff");
  const ladder = await import("@/lib/handoffLadder");
  const gaps = await import("@/lib/productionGaps");
  const { deliveryBoard } = await import("@/lib/deliveryBoard");
  const { syncProjectStatuses } = await import("@/lib/projectStatus");
  const outputsLib = await import("@/lib/deliverableOutputs");
  const profile = await import("@/lib/clientProfile");
  const facts = await import("@/lib/clientFacts");
  const { raiseGapFromBriefAction } = await import("@/app/editing/gapActions");
  const { decideFieldReport } = await import("@/app/upload/actions");
  const { establishSession } = await import("@/lib/auth/session");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { etDateTime } = await import("@/lib/datetime");

  type Board = Awaited<ReturnType<typeof deliveryBoard>>;
  type Job = { id: string; blocker: string; blockerLabel: string; settled?: boolean };
  const oldHandoff = (await import(baseline("src/lib/handoff.ts"))) as typeof handoff;
  const oldBoard = (await import(baseline("src/lib/deliveryBoard.ts"))) as { deliveryBoard: () => Promise<Board> };
  const oldStatus = (await import(baseline("src/lib/projectStatus.ts"))) as { syncProjectStatuses: typeof syncProjectStatuses };
  const oldProfile = (await import(baseline("src/lib/clientProfile.ts"))) as { buildClientProfile: (id: string) => Promise<{ ok: boolean; error?: string }> };
  const oldGaps = (await import(baseline("src/lib/productionGaps.ts"))) as Record<string, unknown>;
  const OLD_TRACKER = baseline("src/components/editing/EditTracker.tsx", true);
  const OLD_BRIEF_CARD = baseline("src/components/project/ProjectBriefCard.tsx", true);
  const find = (b: Board, id: string): Job | undefined =>
    [...b.today, ...b.tomorrow, ...b.upcoming, ...b.delivered].find((j) => j.id === id) as Job | undefined;
  const findSettled = (b: Board, id: string) => b.delivered.some((j) => j.id === id);

  // ---- the world ---------------------------------------------------------
  await saveSecret("dropbox", ["drill", "refresh", "not", "real"].join("-"));
  await saveSecret("ai", ["sk", "ant", "drill", "not", "real"].join("-"));
  await saveSecret("aryeo", ["drill", "aryeo", "not", "real"].join("-"));
  const client = await prisma.client.create({ data: { name: "EGF Client TEST" }, select: { id: true } });
  const other = await prisma.client.create({ data: { name: "EGF Other TEST" }, select: { id: true } });
  const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-egf@drill.invalid", role: "PHOTOGRAPHER", active: true }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-egf@drill.invalid", role: "MANAGER", active: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Drill", email: "kim-egf@drill.invalid", role: "EDITOR", active: true }, select: { id: true } });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-egf@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id }, select: { id: true } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle-egf@drill.invalid", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const kim = await prisma.appUser.create({ data: { email: "kim-egf@drill.invalid", name: "Kim Drill", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimTm.id }, select: { id: true } });
  const asKyle = () => establishSession(kyle.id);
  const asKim = () => establishSession(kim.id);
  const asHarrison = () => establishSession(harrison.id);
  const SHOT = new Date("2026-09-26T10:00:00-04:00");
  const evidenceBlob = (rawPhotos: number, rawVideo: number, o: { stale?: boolean; at?: Date } = {}) =>
    JSON.stringify({
      expected: ["VIDEO"], present: [], missing: ["VIDEO"],
      dropbox: { rawPhotos, rawVideo, finalPhotos: 0, finalVideo: 0, at: (o.at ?? new Date()).toISOString(), ...(o.stale ? { stale: true } : {}) },
    });
  type Row = { type: "PHOTOS" | "VIDEO" | "SOCIAL_REEL"; label: string; uploadedAt?: Date | null; status?: "PENDING" | "UPLOADED" | "DONE"; notCompletedReason?: string };
  const job = async (street: string, rows: Row[], extra: Record<string, unknown> = {}, clientId = client.id) =>
    (await prisma.project.create({
      data: {
        title: `${street}, Emmaus, PA`, addressLine: street, clientId, status: "SHOT", shootDate: SHOT, photographerId: harrisonTm.id,
        deliverables: { create: rows.map((r) => ({ type: r.type, label: r.label, quantity: 1, uploadedAt: r.uploadedAt ?? null, status: r.status ?? "PENDING", notCompletedReason: r.notCompletedReason ?? null })) },
        ...extra,
      },
      select: { id: true },
    })).id;
  const fmt = (d: Date) => etDateTime(d);

  // =======================================================================
  c.head("§1 · §7.3 the ladder on the edit tracker and the project summary");
  // =======================================================================
  const tPh = new Date("2026-09-26T19:40:00-04:00");
  const tVi = new Date("2026-09-27T08:05:00-04:00");
  const tHandPh = new Date("2026-09-26T19:45:00-04:00");
  const tHandVi = new Date("2026-09-27T08:10:00-04:00");
  const tStart = new Date("2026-09-28T09:30:00-04:00");
  const j1 = await job(
    "1 Ladder Ln",
    [{ type: "PHOTOS", label: "Photos", uploadedAt: tPh, status: "UPLOADED" }, { type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }],
    { status: "EDITING", statusEvidence: evidenceBlob(212, 6), photosHandoffAt: tHandPh, videoHandoffAt: tHandVi, handoffReadyAt: tHandVi },
  );
  const reel1 = await prisma.deliverable.findFirstOrThrow({ where: { projectId: j1, type: "SOCIAL_REEL" }, select: { id: true } });
  await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: j1, state: "ACTIVE", activeFor: "kim", firstStartedAt: tStart, activeSince: tStart, lastEventAt: tStart } });
  // v1 sent back, v2 in review, a v3 still uploading: ONE cut handed in.
  await prisma.reviewSubmission.create({ data: { projectId: j1, deliverableId: reel1.id, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload" } });
  await prisma.reviewSubmission.create({ data: { projectId: j1, deliverableId: reel1.id, slot: 1, round: 2, status: "PENDING", source: "upload" } });
  await prisma.reviewSubmission.create({ data: { projectId: j1, deliverableId: reel1.id, slot: 1, round: 3, status: "UPLOADING", source: "upload" } });
  const ev1 = await ladder.handoffLadderFor(j1);
  const vid = ev1?.find((e) => e.category === "video");
  const pho = ev1?.find((e) => e.category === "photos");
  c.ok("one read gives both halves of the ladder", !!vid && !!pho);
  c.ok("the video half: reported, found (6), handed off, ready", !!vid && vid.uploadReported?.getTime() === tVi.getTime() && vid.filesDetected === "yes" && vid.fileCount === 6 && vid.handoffSubmitted?.getTime() === tHandVi.getTime() && !!vid.readyToEdit && "at" in vid.readyToEdit);
  c.ok("editing STARTED is the editor's own Start (EditorWorkItem), never the status", vid?.editingStarted?.getTime() === tStart.getTime());
  c.ok("cuts handed in counts the VIDEO once (v1+v2), never one still uploading", vid?.outputSubmitted === 1, String(vid?.outputSubmitted));
  c.ok("the photos half: its own tick, 212 found, its own handoff", pho?.uploadReported?.getTime() === tPh.getTime() && pho.fileCount === 212 && pho.handoffSubmitted?.getTime() === tHandPh.getTime());
  const rows1 = await ladder.handoffLadderRows(j1);
  const vRow = rows1.find((r) => r.category === "video")!;
  c.ok("the screen row IS evidenceLine — one set of words", !!vid && vRow.line === handoff.evidenceLine(vid, fmt) && vRow.line === `Video: ${vRow.rungs.map((r) => r.text).join(" · ")}`, vRow.line);
  c.ok("…and the words did not move: 0950c1c's evidenceLine says exactly the same", !!vid && !!pho && handoff.evidenceLine(vid, fmt) === oldHandoff.evidenceLine(vid, fmt) && handoff.evidenceLine(pho, fmt) === oldHandoff.evidenceLine(pho, fmt));
  c.ok("all six rungs, in order", vRow.rungs.map((r) => r.key).join(",") === "reported,found,handoff,ready,started,cuts", vRow.rungs.map((r) => r.key).join(","));
  const j2 = await job("2 Unknown Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }], {
    statusEvidence: evidenceBlob(0, 0, { stale: true }), handoffBlockedReason: "Waiting on the wrap-up on the upload page from Harrison Drill.",
  });
  const r2 = (await ladder.handoffLadderRows(j2))[0];
  const found2 = r2?.rungs.find((r) => r.key === "found");
  const ready2 = r2?.rungs.find((r) => r.key === "ready");
  c.ok("a stale zero reads 'Dropbox not confirmed' (unknown), never missing", found2?.text === "Dropbox not confirmed" && found2.tone === "unknown");
  c.ok("blocked reads 'not ready to edit', the blocker's sentence rides along", ready2?.text === "not ready to edit" && ready2.tone === "no" && /wrap-up/.test(ready2.detail ?? ""));
  c.ok("nobody started and nothing handed in: those rungs are absent, not 'no'", !r2?.rungs.some((r) => r.key === "started" || r.key === "cuts"));
  c.ok("a job that is not there has no ladder", (await ladder.handoffLadderFor("no-such-job")) === null);

  // The two cards, rendered — OLD first.
  const trackerProps = {
    stage: "editing", statusLine: "In the edit — footage is in", hadRevision: false, editType: "Standard Reel", dueISO: null,
    shootDateISO: SHOT.toISOString(), photographerName: "Harrison Drill", song: null, rounds: [], revisionAsks: [], revisionAtISO: null, showSubmitAnchor: false,
  };
  const brief = {
    projectId: j1, scope: ["Photos", "Standard Reel"], outputs: [], outputsDone: 0, outputsOwed: 0, currentVersion: null,
    promisedAt: null, promiseSource: null, promiseWords: null, reopened: false, reopenedUndated: false, targetAt: null, overdue: false,
    latestRequest: null, blocker: null, owner: { who: "Kim", whose: "editor" }, nextAction: "Finish the cut", tone: { headline: "In editing" },
    filming: null, assetNeeds: [],
  };
  const TRACKER = path.join(REPO, "src/components/editing/EditTracker.tsx");
  const BRIEF_CARD = path.join(REPO, "src/components/project/ProjectBriefCard.tsx");
  const html = render([
    { name: "oldTracker", file: OLD_TRACKER, exp: "EditTracker", props: trackerProps },
    { name: "oldBrief", file: OLD_BRIEF_CARD, exp: "ProjectBriefCard", props: { brief } },
    { name: "newTracker", file: TRACKER, exp: "EditTracker", props: { ...trackerProps, evidence: rows1.filter((r) => r.category === "video") } },
    { name: "newTrackerNone", file: TRACKER, exp: "EditTracker", props: { ...trackerProps, evidence: null } },
    { name: "newBrief", file: BRIEF_CARD, exp: "ProjectBriefCardView", props: { brief, evidence: rows1 } },
    { name: "newBriefUnknown", file: BRIEF_CARD, exp: "ProjectBriefCardView", props: { brief, evidence: await ladder.handoffLadderRows(j2) } },
  ]);
  for (const [k, v] of Object.entries(html)) if (v.startsWith("RENDER_ERROR")) c.ok(`render ${k}`, false, v);
  c.ok("OLD: the edit tracker said nothing about the files", !/Dropbox|handed off|upload reported/i.test(text(html.oldTracker ?? "")) && (html.oldTracker ?? "").length > 0);
  c.ok("OLD: neither did the project summary", !/Dropbox|handed off|upload reported/i.test(text(html.oldBrief ?? "")) && (html.oldBrief ?? "").length > 0);
  const ladderText = (h: string, cat: string) => {
    const m = new RegExp(`<li[^>]*data-ladder="${cat}"[^>]*>([\\s\\S]*?)</li>`).exec(h);
    return m ? text(m[1]) : "";
  };
  c.ok("NEW: the tracker prints the video half, word for word", ladderText(html.newTracker ?? "", "video").startsWith(vRow.line) && /The footage/.test(text(html.newTracker ?? "")), ladderText(html.newTracker ?? "", "video"));
  c.ok("…and only the video half (it is the video's tracker)", !/data-ladder="photos"/.test(html.newTracker ?? ""));
  c.ok("NEW: no ladder handed in → the tracker reads exactly as before", !/The footage/.test(text(html.newTrackerNone ?? "")));
  const pRow = rows1.find((r) => r.category === "photos")!;
  c.ok("NEW: the summary prints BOTH halves, in the same words as the tracker", ladderText(html.newBrief ?? "", "video").startsWith(vRow.line) && ladderText(html.newBrief ?? "", "photos") === pRow.line && /The files/.test(text(html.newBrief ?? "")));
  c.ok("NEW: an unreadable folder shows as not confirmed there too", /Dropbox not confirmed/.test(text(html.newBriefUnknown ?? "")) && !/no files found/.test(text(html.newBriefUnknown ?? "")));

  // rawInAt — the REAL sweep, with Dropbox faked in memory.
  const folder = (street: string) => `/AutoHDR/2026/Q3/September/${street} (EGF Client TEST)`;
  const rawJob = async (street: string, rows: Row[], extra: Record<string, unknown> = {}) => {
    const id = await job(street, rows, { dropboxFolder: folder(street), ...extra });
    await outputsLib.ensureOutputsForProject(id);
    return id;
  };
  const seedFolders = (street: string, rawVideo: number) => {
    const base = folder(street).toLowerCase();
    FS.set(`${base}/01-raw-photos`, 0);
    FS.set(`${base}/02-raw-video`, rawVideo);
    FS.set(`${base}/04-final-photos`, 0);
    FS.set(`${base}/05-final-video`, 0);
  };
  const outRow = async (projectId: string) =>
    prisma.deliverableOutput.findMany({ where: { projectId }, select: { id: true, rawInAt: true, evidenceSource: true, reviewReadyAt: true } });
  // THE DEPLOY-DAY CASE (review, Sep 28). The 0950c1c sweep had already found
  // this job's footage (and set uploadedAt); the first NEW pass a day later
  // must leave rawInAt unknown, never stamp it with its own (late) read time.
  const one = await rawJob("3 Raw Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }]);
  seedFolders("3 Raw Ln", 5);
  c.ok("the one-video job has exactly one output row", (await outRow(one)).length === 1);
  await oldStatus.syncProjectStatuses({ projectId: one });
  const oneUp = (await prisma.project.findUniqueOrThrow({ where: { id: one }, select: { uploadedAt: true } })).uploadedAt;
  c.ok("OLD (0950c1c sweep): footage found (uploadedAt set), rawInAt never written", (await outRow(one))[0]?.rawInAt === null && oneUp?.getTime() === SIM);
  SIM += 26 * 3600_000;
  await syncProjectStatuses({ projectId: one });
  c.ok("NEW, the first pass after the old one already confirmed the raws: rawInAt stays unknown, never the later read's time",
    (await outRow(one))[0]?.rawInAt === null && (await outRow(one))[0]?.evidenceSource === null, String((await outRow(one))[0]?.rawInAt?.toISOString()));
  SIM -= 26 * 3600_000;

  // The transition: a fresh read saw an EMPTY Raw Video folder, the next one finds footage.
  const arrive = await rawJob("3b Arrive Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }]);
  seedFolders("3b Arrive Ln", 0);
  await syncProjectStatuses({ projectId: arrive });
  c.ok("a fresh read of an empty Raw Video folder stamps nothing", (await outRow(arrive))[0]?.rawInAt === null);
  FS.set(`${folder("3b Arrive Ln").toLowerCase()}/02-raw-video`, 5);
  SIM += 3600_000;
  const firstRead = SIM;
  await syncProjectStatuses({ projectId: arrive });
  const o1 = (await outRow(arrive))[0];
  c.ok("NEW: the pass that FIRST sees the footage stamps rawInAt at its read", o1?.rawInAt?.getTime() === firstRead, String(o1?.rawInAt?.toISOString()));
  c.ok("…and records what proved it", o1?.evidenceSource === ladder.RAW_IN_SOURCE);
  SIM += 3 * 3600_000;
  await syncProjectStatuses({ projectId: arrive });
  c.ok("a later pass never moves it (the FIRST confirmation)", (await outRow(arrive))[0]?.rawInAt?.getTime() === firstRead);
  SIM -= 4 * 3600_000;

  // A job no pass has read yet, nothing detected on it: its first read IS the first sight.
  const fresh = await rawJob("3c Fresh Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }]);
  seedFolders("3c Fresh Ln", 4);
  await syncProjectStatuses({ projectId: fresh });
  c.ok("never read before and nothing detected: the first read that finds footage stamps it", (await outRow(fresh))[0]?.rawInAt?.getTime() === SIM);
  // No Dropbox reading on record, but raws WERE detected before (uploadedAt): unknown, not late.
  const known = await rawJob("3d Known Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }], { uploadedAt: new Date(SIM - 5 * 86400_000) });
  seedFolders("3d Known Ln", 4);
  await syncProjectStatuses({ projectId: known });
  c.ok("no reading on record but raws already detected five days ago: rawInAt stays unknown", (await outRow(known))[0]?.rawInAt === null);
  // Delivered yesterday, video still not on Aryeo: its raws were in before the delivery.
  const shipped = await rawJob("3e Shipped Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }], { status: "DELIVERED", deliveredAt: new Date(SIM - 86400_000) });
  seedFolders("3e Shipped Ln", 4);
  await syncProjectStatuses({ projectId: shipped });
  c.ok("a job already delivered is never stamped after its delivery", (await outRow(shipped))[0]?.rawInAt === null);
  c.ok("pure: first sight only when the last reading saw no raw video, or with no reading, nothing was ever detected",
    ladder.firstSightOfRawVideo({ rawVideo: 0 }, new Date()) &&
      !ladder.firstSightOfRawVideo({ rawVideo: 3 }, null) &&
      ladder.firstSightOfRawVideo(null, null) &&
      !ladder.firstSightOfRawVideo(null, new Date()) &&
      !ladder.firstSightOfRawVideo({}, new Date()));

  const two = await rawJob("4 Shared Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }, { type: "VIDEO", label: "Listing Video" }]);
  seedFolders("4 Shared Ln", 40);
  await syncProjectStatuses({ projectId: two });
  const o2 = await outRow(two);
  c.ok("two videos share one Raw Video folder: neither is stamped (no guessing whose)", o2.length === 2 && o2.every((o) => o.rawInAt === null));
  const staleJob = await rawJob("5 Stale Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }], {
    statusEvidence: evidenceBlob(0, 8, { at: new Date(SIM - 3600_000) }), aryeoListingId: "egf-listing-5",
  });
  seedFolders("5 Stale Ln", 8);
  BROKEN.add(`${folder("5 Stale Ln").toLowerCase()}/02-raw-video`);
  await syncProjectStatuses({ projectId: staleJob });
  const staleEv = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: staleJob }, select: { statusEvidence: true } })).statusEvidence ?? "{}") as { dropbox?: { stale?: boolean; rawVideo?: number } };
  c.ok("a failed read carries the last counts forward, marked stale", staleEv.dropbox?.stale === true && staleEv.dropbox.rawVideo === 8, JSON.stringify(staleEv.dropbox));
  c.ok("…and a stale count stamps nothing (it proves nothing new)", (await outRow(staleJob))[0]?.rawInAt === null);
  const lateJob = await rawJob("6 Late Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }]);
  seedFolders("6 Late Ln", 3);
  await prisma.deliverableOutput.updateMany({ where: { projectId: lateJob }, data: { reviewReadyAt: new Date(SIM - 86400_000) } });
  await syncProjectStatuses({ projectId: lateJob });
  c.ok("a video whose cut is already in is never back-stamped 'now'", (await outRow(lateJob))[0]?.rawInAt === null);
  const emptyJob = await rawJob("7 Empty Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel" }]);
  seedFolders("7 Empty Ln", 0);
  await syncProjectStatuses({ projectId: emptyJob });
  c.ok("an empty Raw Video folder stamps nothing", (await outRow(emptyJob))[0]?.rawInAt === null);
  c.ok("stampRawIn says why it declined", (await ladder.stampRawIn(two, new Date())).reason.startsWith("more than one video") && (await ladder.stampRawIn(arrive, new Date())).reason === "already stamped");

  // =======================================================================
  c.head("§2 · §7.6 missing work on Kyle's board, and raised off a brief");
  // =======================================================================
  const k1 = await job("10 Gap Ln", [
    { type: "PHOTOS", label: "Photos", uploadedAt: tPh, status: "UPLOADED" },
    { type: "SOCIAL_REEL", label: "Standard Reel", notCompletedReason: "The agent cancelled the on-camera intro" },
  ], { statusEvidence: evidenceBlob(120, 0) });
  const k1Reel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: k1, type: "SOCIAL_REEL" }, select: { id: true } });
  const g1 = await gaps.recordOutputGap({ projectId: k1, deliverableId: k1Reel.id, what: "Standard Reel", reason: "The agent cancelled the on-camera intro", raisedBy: "Harrison Drill" });
  const k2 = await job("11 Revision Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }], {
    status: "REVISION", revisionRequestedAt: new Date(SIM - 3600_000), statusEvidence: evidenceBlob(0, 9),
  });
  await gaps.recordShotGap({ projectId: k2, what: "Pool at dusk", reason: "The storm came in", raisedBy: "Harrison Drill" });
  const k4 = await job("13 Delivered Ln", [{ type: "PHOTOS", label: "Photos", uploadedAt: tPh, status: "DONE" }], {
    status: "DELIVERED", deliveredAt: new Date(SIM - 2 * 86400_000),
  });
  await gaps.recordShotGap({ projectId: k4, what: "Twilight exteriors", reason: "Clouds", raisedBy: "Harrison Drill" });
  const oldB = await oldBoard.deliveryBoard();
  const newB = await deliveryBoard();
  c.ok("OLD: a reel the photographer could not deliver read 'Waiting on video'", find(oldB, k1)?.blockerLabel === "Waiting on video", find(oldB, k1)?.blockerLabel);
  c.ok("NEW: it reads as missing work, with nobody owning it yet", find(newB, k1)?.blockerLabel === "Missing work: Standard Reel — no owner or date yet", find(newB, k1)?.blockerLabel);
  c.ok("…on the camera chip (work that has to come in)", find(newB, k1)?.blocker === "awaiting_upload");
  c.ok("OLD: changes requested hid the missed shot", find(oldB, k2)?.blockerLabel === "Changes requested");
  c.ok("NEW: changes requested keeps its word and carries the gap", find(newB, k2)?.blockerLabel === "Changes requested · Missing work: Pool at dusk — no owner or date yet" && find(newB, k2)?.blocker === "revision", find(newB, k2)?.blockerLabel);
  c.ok("OLD: a delivered job with a missed shot read 'Delivered'", find(oldB, k4)?.blockerLabel === "Delivered");
  c.ok("NEW: it says what is missing — and stays in the delivered column", find(newB, k4)?.blockerLabel === "Missing work: Twilight exteriors — no owner or date yet" && findSettled(newB, k4), find(newB, k4)?.blockerLabel);
  const plan = await gaps.planRecovery(
    g1.id,
    { recovery: "RESHOOT", ownerKey: "harrison", dueAt: new Date("2026-10-01T17:00:00-04:00"), shotList: [{ shot: "Agent intro at the front door" }], scopeNote: "Intro only; the B-roll stands." },
    "Kyle Drill",
  );
  c.ok("the office plans the recovery", plan.ok);
  c.ok("NEW: '<what> — <owner> by <due>', the owner's own name", find(await deliveryBoard(), k1)?.blockerLabel === "Missing work: Standard Reel — Harrison by Thu, Oct 1", find(await deliveryBoard(), k1)?.blockerLabel);
  const k1b = await job("10b Late Gap Ln", [{ type: "PHOTOS", label: "Photos", uploadedAt: tPh, status: "UPLOADED" }], { statusEvidence: evidenceBlob(90, 0) });
  const gLate = await gaps.recordShotGap({ projectId: k1b, what: "Kitchen detail shots", reason: "Missed", raisedBy: "Harrison Drill" });
  await gaps.planRecovery(gLate.id, { recovery: "USE_EXISTING", ownerKey: "kyle", dueAt: new Date("2026-09-25T17:00:00-04:00") }, "Kyle Drill");
  c.ok("past its date: 'was due', not 'by'", find(await deliveryBoard(), k1b)?.blockerLabel === "Missing work: Kitchen detail shots — Kyle, was due Fri, Sep 25", find(await deliveryBoard(), k1b)?.blockerLabel);
  await gaps.recordShotGap({ projectId: k1b, what: "Front porch wide", reason: "Missed", raisedBy: "Harrison Drill" });
  c.ok("two open gaps: the most pressing one, and how many more", find(await deliveryBoard(), k1b)?.blockerLabel === "Missing work: Kitchen detail shots — Kyle, was due Fri, Sep 25 (+1 more)", find(await deliveryBoard(), k1b)?.blockerLabel);
  c.ok("pure words: no owner/date, owner no date", gaps.gapBoardLine({ what: "X", ownerKey: null, dueAt: null, raisedAt: new Date() }, null) === "Missing work: X — no owner or date yet" && gaps.gapBoardLine({ what: "X", ownerKey: "kim", dueAt: null, raisedAt: new Date() }, "Kim") === "Missing work: X — Kim, no date yet");

  // A limitation on a video's brief, raised in one press.
  const k3 = await job("12 Brief Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }], { statusEvidence: evidenceBlob(0, 11) });
  await outputsLib.ensureOutputsForProject(k3);
  const k3Out = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: k3 }, select: { id: true } });
  c.ok("before: files in, nobody started — 'Ready for editing'", find(await deliveryBoard(), k3)?.blockerLabel === "Ready for editing", find(await deliveryBoard(), k3)?.blockerLabel);
  c.ok("OLD: there was no way to raise a gap from a brief", typeof oldGaps.raiseGapFromBrief === "undefined");
  await asKyle();
  const noLimit = await raiseGapFromBriefAction(k3, k3Out.id);
  c.ok("a brief with no limitation written down cannot raise one", !noLimit.ok && /no limitation/.test(noLimit.message), noLimit.message);
  const saved = await outputsLib.saveOutputBrief({ outputId: k3Out.id, projectId: k3, sections: { limitations: "No twilight exteriors, the storm rolled in" }, actor: "Kyle Drill" });
  c.ok("the brief carries the limitation (v1)", saved.ok && saved.changed && saved.version === 1);
  await asKim();
  const byEditor = await raiseGapFromBriefAction(k3, k3Out.id);
  await asHarrison();
  const byPhotog = await raiseGapFromBriefAction(k3, k3Out.id);
  c.ok("an editor or a photographer cannot raise it (the office's)", !byEditor.ok && !byPhotog.ok && (await prisma.productionGap.count({ where: { outputId: k3Out.id } })) === 0);
  await asKyle();
  const wrongJob = await raiseGapFromBriefAction(k1, k3Out.id);
  c.ok("the video must be one of THIS job's", !wrongJob.ok && /different job/.test(wrongJob.message));
  const raised = await raiseGapFromBriefAction(k3, k3Out.id);
  const g3 = await prisma.productionGap.findMany({ where: { outputId: k3Out.id } });
  c.ok("one press: one OPEN gap on THAT video", raised.ok && raised.created && g3.length === 1 && g3[0].state === "OPEN" && g3[0].projectId === k3 && g3[0].kind === "SHOT", raised.message);
  c.ok("…signed by who pressed it, in the limitation's own words", g3[0]?.raisedBy === "Kyle Drill" && g3[0].what === "No twilight exteriors, the storm rolled in (Standard Reel)" && /limitation on the brief for Standard Reel \(v1\)/.test(g3[0].reason), `${g3[0]?.raisedBy} / ${g3[0]?.what}`);
  c.ok("…and the job's timeline says so", (await prisma.activity.count({ where: { projectId: k3, body: { startsWith: "Missing work raised from the brief for Standard Reel by Kyle Drill" } } })) === 1);
  const again = await raiseGapFromBriefAction(k3, k3Out.id);
  c.ok("a second press adds nothing", again.ok && !again.created && (await prisma.productionGap.count({ where: { outputId: k3Out.id } })) === 1);
  c.ok("it is on Kyle's board", find(await deliveryBoard(), k3)?.blockerLabel === "Missing work: No twilight exteriors, the storm rolled in (Standard Reel) — no owner or date yet", find(await deliveryBoard(), k3)?.blockerLabel);
  const gv = (await gaps.gapsForProject(k3)).find((g) => g.id === g3[0]?.id);
  c.ok("the gap view names its video (the brief card reads it)", gv?.outputId === k3Out.id);
  c.ok("never a waiver: the deliverable and the video stay owed", (await prisma.deliverable.count({ where: { projectId: k3, waivedAt: { not: null } } })) === 0 && (await prisma.deliverableOutput.count({ where: { projectId: k3, waivedAt: { not: null } } })) === 0);
  const closed = await gaps.closeGap(g3[0].id, "RESOLVED", "Reshot on Tuesday", "Kyle Drill");
  c.ok("closed with its note → the board goes back to 'Ready for editing'", closed.ok && find(await deliveryBoard(), k3)?.blockerLabel === "Ready for editing", find(await deliveryBoard(), k3)?.blockerLabel);

  // MONEY IN A LIMITATION (review, Sep 28). The editor's brief drops the price;
  // the gap raised off it used to copy the raw words to the editor's and the
  // photographer's screens. Now the gap is built from the money-safe words.
  const k5 = await job("14 Money Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }], { statusEvidence: evidenceBlob(0, 7) });
  await outputsLib.ensureOutputsForProject(k5);
  const k5Out = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: k5 }, select: { id: true } });
  const LIMIT = "Drone was not ordered ($175 add-on). No aerials.";
  await outputsLib.saveOutputBrief({ outputId: k5Out.id, projectId: k5, sections: { limitations: LIMIT }, actor: "Kyle Drill" });
  const editorBrief = (await outputsLib.outputBriefsFor(k5, { scrub: true }))[0];
  c.ok("the editor's copy of the brief reads 'No aerials.' (the scrub the gap must match)", editorBrief?.sections.find((x) => x.key === "limitations")?.text === "No aerials.", JSON.stringify(editorBrief?.sections));
  await asKyle();
  const rm = await raiseGapFromBriefAction(k5, k5Out.id);
  const g5 = await prisma.productionGap.findFirstOrThrow({ where: { outputId: k5Out.id } });
  c.ok("raised: the gap's words are the brief's money-safe words", rm.ok && g5.what === "No aerials. (Standard Reel)", g5.what);
  c.ok("…the reason too, with no price in it", g5.reason === "Written as a limitation on the brief for Standard Reel (v1): No aerials." && !/\$|175/.test(g5.reason), g5.reason);
  const k5Line = await prisma.activity.findFirst({ where: { projectId: k5, body: { startsWith: "Missing work raised from the brief" } }, select: { body: true } });
  c.ok("…and the timeline line", k5Line?.body === "Missing work raised from the brief for Standard Reel by Kyle Drill: No aerials.", k5Line?.body);
  c.ok("the office still has the full words on the brief itself", (await outputsLib.outputBriefsFor(k5))[0]?.sections.find((x) => x.key === "limitations")?.text === LIMIT);
  c.ok("Kyle's board line carries no money", find(await deliveryBoard(), k5)?.blockerLabel === "Missing work: No aerials. (Standard Reel) — no owner or date yet", find(await deliveryBoard(), k5)?.blockerLabel);
  // All money: the words keep their meaning with the figure withheld, never blank, never the figure.
  const k6 = await job("15 Paid Ln", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }], { statusEvidence: evidenceBlob(0, 7) });
  await outputsLib.ensureOutputsForProject(k6);
  const k6Out = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: k6 }, select: { id: true } });
  await outputsLib.saveOutputBrief({ outputId: k6Out.id, projectId: k6, sections: { limitations: "The drone fee is 175, so it was not booked." }, actor: "Kyle Drill" });
  await raiseGapFromBriefAction(k6, k6Out.id);
  const g6 = await prisma.productionGap.findFirstOrThrow({ where: { outputId: k6Out.id } });
  c.ok("a figure with no $ sign (the brief's scrub misses it) is withheld from the gap", !/175/.test(g6.what) && !/175/.test(g6.reason) && /amount withheld/.test(g6.what), g6.what);
  // Every gap's words, as the editor and the photographer are handed them (the pages call this).
  const gm = await gaps.recordShotGap({ projectId: k5, what: "Twilight ($200 add-on)", reason: "The client owes $200 for the twilight. Clouds rolled in.", raisedBy: "Harrison Drill" });
  await gaps.planRecovery(gm.id, { recovery: "RESHOOT", ownerKey: "harrison", dueAt: new Date("2026-10-02T17:00:00-04:00"), shotList: [{ shot: "Twilight front", note: "billed at $200" }], scopeNote: "Front only. Invoice the client $200." }, "Kyle Drill");
  const rawViews = await gaps.gapsForProject(k5);
  const safeViews = await gaps.gapsForCreatives(rawViews);
  const wordsOf = (vs: typeof rawViews) => vs.map((g) => [g.what, g.reason, g.scopeNote, g.resolutionNote, ...g.shotList.flatMap((l) => [l.shot, l.note])].filter(Boolean).join(" | ")).join(" || ");
  c.ok("the rows as stored DO carry the office's figures (what the pages used to hand over)", /\$200/.test(wordsOf(rawViews)));
  const safeJson = wordsOf(safeViews);
  c.ok("gapsForCreatives: no figure anywhere (what, reason, shot list, scope)", !/\$|175|200/.test(safeJson), safeJson.slice(0, 400));
  const sv = safeViews.find((g) => g.id === gm.id);
  c.ok("…and the words survive: 'Clouds rolled in.', 'Front only.', the shot", !!sv && sv.reason === "Clouds rolled in." && sv.scopeNote === "Front only." && sv.shotList[0]?.shot === "Twilight front" && sv.shotList[0]?.note === "billed at [amount withheld]" && /^Twilight/.test(sv.what), JSON.stringify(sv));
  c.ok("…the same rows, in the same order, nothing dropped", safeViews.map((g) => g.id).join() === rawViews.map((g) => g.id).join() && safeViews.every((g, i) => g.state === rawViews[i].state && g.outputId === rawViews[i].outputId));

  // =======================================================================
  c.head("§3 · §7.8 the working profile reads only CONFIRMED field reports");
  // =======================================================================
  const fieldJob = await job("30 Field Rd", [{ type: "SOCIAL_REEL", label: "Standard Reel", uploadedAt: tVi, status: "UPLOADED" }]);
  const otherJob = await job("31 Other Rd", [{ type: "PHOTOS", label: "Photos" }], {}, other.id);
  await prisma.activity.createMany({
    data: [
      { projectId: fieldJob, type: "FLAG", body: "They probably prefer serif fonts on the endcard" },
      { projectId: fieldJob, type: "NOTE", body: "Shoot debrief — lockbox code is on the side door" },
      { projectId: fieldJob, type: "FLAG", body: "Revision requested (email, Olivia): please brighten the kitchen" },
      { projectId: fieldJob, type: "SPECIAL_REQUEST", body: "Client request (email): add the brokerage logo" },
    ],
  });
  const mk = (body: string, status: string, scope: string, extra: Record<string, unknown> = {}) =>
    prisma.clientFact.create({
      data: {
        clientId: client.id, category: "PRODUCTION_PREFERENCE", body, source: "field", sourceRef: facts.fieldSourceRef(fieldJob, "client_said"),
        scope, projectId: scope === "PROJECT" ? fieldJob : null, status, visibility: "INTERNAL", aiContext: status === "ACCEPTED" ? "ALLOWED" : "DENIED",
        dedupeHash: `egf-${body}`, speaker: "EGF Client TEST (reported by Harrison Drill)", ...extra,
      },
      select: { id: true },
    });
  const proposed = await mk("Wants the logo bottom-right on every reel", "PROPOSED", "PERMANENT");
  await mk("Always add captions in white", "ACCEPTED", "PERMANENT");
  await mk("Slow pans on this one", "ACCEPTED", "PROJECT");
  await mk("Hates drone shots", "REJECTED", "PERMANENT");
  await mk("Secret launch next month", "ACCEPTED", "PERMANENT", { confidential: true, aiContext: "DENIED" });
  await prisma.clientFact.create({ data: { clientId: other.id, category: "PRODUCTION_PREFERENCE", body: "Other client's report", source: "field", sourceRef: facts.fieldSourceRef(otherJob, "observation"), scope: "PERMANENT", status: "PROPOSED", visibility: "INTERNAL", aiContext: "DENIED", dedupeHash: "egf-other" } });

  const oldBuilt = await oldProfile.buildClientProfile(client.id);
  const oldPrompt = prompts[prompts.length - 1] ?? "";
  c.ok("OLD: the build ran (the model is faked)", oldBuilt.ok, oldBuilt.error);
  c.ok("OLD: a photographer's guess went straight into the profile prompt", oldPrompt.includes("serif fonts") && oldPrompt.includes("lockbox code"));
  const newBuilt = await profile.buildClientProfile(client.id);
  const newPrompt = prompts[prompts.length - 1] ?? "";
  c.ok("NEW: the build still runs", newBuilt.ok && prompts.length === 2, newBuilt.error);
  c.ok("NEW: no raw field flag or debrief note reaches it", !newPrompt.includes("serif fonts") && !newPrompt.includes("lockbox code"));
  c.ok("NEW: never a PROPOSED or REJECTED report", !newPrompt.includes("logo bottom-right") && !newPrompt.includes("drone shots"));
  c.ok("NEW: never a confidential one, never a one-job request", !newPrompt.includes("Secret launch") && !newPrompt.includes("Slow pans"));
  c.ok("NEW: the CONFIRMED client-wide report is there, labelled as confirmed", newPrompt.includes(`${profile.CONFIRMED_FIELD_PREFIX}Always add captions in white`));
  c.ok("NEW: the client's own words still reach it (their revision ask, their request)", newPrompt.includes("please brighten the kitchen") && newPrompt.includes("add the brokerage logo"));
  const input = await profile.clientProfileInput(client.id);
  c.ok("the input builder is the build's own (checked without the model)", !!input && input.activities.some((a) => a.includes("captions in white")) && !input.activities.some((a) => a.includes("serif")));

  // The client page's list.
  const listed = await facts.fieldReportsForClient(client.id);
  c.ok("the client's field reports, waiting ones first", listed.length === 5 && listed[0].status === "PROPOSED" && listed[0].id === proposed.id, listed.map((r) => r.status).join(","));
  c.ok("…each with the job it came off", listed.every((r) => r.projectId === fieldJob && r.projectTitle === "30 Field Rd"));
  c.ok("…and never another client's", !listed.some((r) => r.body === "Other client's report"));
  const cardRows = listed.map((r) => ({ id: r.id, body: r.body, status: r.status, scope: r.scope, basis: r.basis, speaker: r.speaker, createdAtISO: r.createdAt.toISOString(), projectId: r.projectId, projectTitle: r.projectTitle }));
  const CARD = path.join(REPO, "src/app/clients/[id]/FieldReportsCard.tsx");
  const cards = render([
    { name: "office", file: CARD, exp: "FieldReportsCard", props: { reports: cardRows, canDecide: true } },
    { name: "preview", file: CARD, exp: "FieldReportsCard", props: { reports: cardRows, canDecide: false } },
  ]);
  for (const [k, v] of Object.entries(cards)) if (v.startsWith("RENDER_ERROR")) c.ok(`render ${k}`, false, v);
  const office = text(cards.office ?? "");
  c.ok("the list: the waiting one says so, with Confirm / Reject for the office", (office.match(/Confirm/g) ?? []).length === 1 && /Reject/.test(office) && /1 to confirm/.test(office) && /waiting for the office/.test(office), office.slice(0, 200));
  c.ok("…where it came from and how far it reaches", /they asked for it/.test(office) && /going forward/.test(office) && /this job only/.test(office) && (cards.office ?? "").includes(`/projects/${fieldJob}`));
  c.ok("a preview (or anyone but the office) gets the list without the buttons", !/Confirm|Reject/.test(text(cards.preview ?? "")) && /Always add captions in white/.test(text(cards.preview ?? "")));
  await asKim();
  const kimTry = await decideFieldReport(proposed.id, "ACCEPT");
  c.ok("an editor cannot confirm one", !kimTry.ok && (await prisma.clientFact.findUniqueOrThrow({ where: { id: proposed.id } })).status === "PROPOSED");
  await asKyle();
  const kyleOk = await decideFieldReport(proposed.id, "ACCEPT");
  c.ok("the office confirms it from the list (the upload page's own action)", kyleOk.ok && (await prisma.clientFact.findUniqueOrThrow({ where: { id: proposed.id } })).status === "ACCEPTED");
  const after = await profile.clientProfileInput(client.id);
  c.ok("once confirmed, the next profile build reads it", !!after && after.activities.some((a) => a === `${profile.CONFIRMED_FIELD_PREFIX}Wants the logo bottom-right on every reel`));

  // =======================================================================
  c.head("§4 · nothing left the building");
  // =======================================================================
  c.ok("no Stripe, OpenPhone or Slack call was attempted", !fence.blocked.some((u) => /stripe|openphone|quo|slack/i.test(u)), fence.blocked.slice(0, 5).join(", "));
  c.ok("Aryeo: the one listing read and nothing else — no write of any kind", aryeoCalls.length > 0 && aryeoCalls.every((x) => x === "GET /v1/listings/egf-listing-5") && !fence.blocked.some((u) => /aryeo/i.test(u)), aryeoCalls.join(", "));
  c.ok("the only answered hosts were the in-memory Dropbox, that Aryeo read and the model", fence.faked.every((u) => /^https:\/\/api\.dropbox(api)?\.com\/|^https:\/\/api\.anthropic\.com\/|^https:\/\/api\.aryeo\.com\/v1\/listings\/egf-listing-5/.test(u)));
  c.ok("no client message was queued", (await prisma.outboxMessage.count()) === 0);

  quiet.restore();
  fence.restore();
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* harmless */ }
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* harmless */ }
  process.exit(1);
});
