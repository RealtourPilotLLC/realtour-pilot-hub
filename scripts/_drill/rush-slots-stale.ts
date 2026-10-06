// ---------------------------------------------------------------------------
// DRILL: RUSH ON THE JOB PAGE, THE SLOT HORIZON, AND THE STALE-READ WARNING
// (unified handoff Sep 25 2026: §10 priority/rush + AU-24, A19, 7.1-refresh-stale).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/rush-slots-stale.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:DRILL_PORT
// (default 5993), a fake Aryeo behind the network fence, and the same files at
// 0950c1c (never HEAD) for the old behaviour. Production is never opened; the
// model is intercepted and must never be called; no message is sent.
//
//   §0  OLD (0950c1c): the portal asked Aryeo from tomorrow for 21 days
//       whatever the 72-hour gate said, so a call booked 25 days out offered
//       NOTHING; /edit/<id> had no Rush control and never showed an ask sent
//       to Jordan; the Editing Room's freshness rule was inline, untested
//   §1  A19, pure: which day the window starts on; when the 72 hours are the
//       reason the first day is later (and when they are not)
//   §2  A19, the Aryeo query itself: the window starts on the gate's ET day,
//       keeps its length, and the cache row names that day
//   §3  A19 end to end (portalSessionSlots): a booked call 25 days out, a
//       written month answered today, a call held last week; nothing before
//       the gate is offered, and the server still refuses one
//   §4  A19, the client's words: the line, no em dash
//   §5  §10 rush: the Rush button on /edit/<id> — the desk sees it (Jordan,
//       James, Kyle, an office login with no seat), an editor and a "view as"
//       preview do not; the server refuses both the same way
//   §6  §10 rush: what it pushes back, rendered before Save; the ask sent to
//       Jordan shows on the job; his save closes it and the button goes back;
//       and when the queue changes before he saves (nothing pushed back any
//       more), a save of the asked change, or a rush approver's decision,
//       still closes it (review, Sep 28)
//   §7  7.1-refresh-stale: readFreshness at the 3-minute line; the panel
//       rendered fresh, stale and failed; the editor desk's failed read;
//       AutoRefresh refreshes only a visible tab, every 60 s, and never asks
//       navigator.onLine
//   §8  fences
//
// THE CLOCK IS PINNED: Mon Oct 26 2026, 10:00 EDT (it runs forward from there).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5993);
const BASE = "0950c1c";
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const cjs = createRequire(__filename);
const CACHE = path.join(REPO, "node_modules/.cache", "rush-slots-stale");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 26, 14, 0, 0); // Mon Oct 26 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
/** An ET wall clock in 2026: EDT (UTC-4) through Oct 31, EST (UTC-5) from Nov 1. */
const et = (month: number, day: number, hour: number, minute = 0) =>
  new RealDate(RealDate.UTC(2026, month - 1, day, hour + (month > 10 ? 5 : 4), minute));

installNextStubs();
// lucide-react and next/link build React contexts at import time, which the
// react-server build of React does not have; the page's element walk never
// renders them (the c2-editor-desk stub). The child renders use the real ones.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    if (request === "next/link") return { __esModule: true, default: () => null };
    return prev.call(this, request, parent, isMain);
  };
}
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson" && k !== "aiText") return t[k];
      return async () => { aiCalls++; throw new Error("drill: the model is not available"); };
    },
  }),
);
let fake: ReturnType<typeof createFakeAryeo> | null = null;
let osrmCalls = 0;
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://router.project-osrm.org/")) {
    osrmCalls++;
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 5000, duration: 300 }] }), { status: 200 });
  }
  return fake ? fake.handle(url, init) : null;
});

// ---- old code, from BASE (never HEAD) ----------------------------------------
const show = (rel: string) => execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
function baseline(rel: string, withReact = false): string {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`);
  fs.writeFileSync(out, `${withReact ? 'import * as React from "react";\n' : ""}${show(rel).replace(/(["'])@\//g, `$1${REPO}/src/`)}`);
  return out;
}

// ---- the render harness (a child process, no react-server condition) -------
// The c2-editor-desk pattern: client components are rendered to HTML with
// react-dom/server in a child, with their server actions replaced by stand-ins
// so nothing can reach a server action (and nothing is clicked anyway). A job
// either renders a component or calls a pure export.
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
type Job = { name: string; file: string; exp: string; props?: Record<string, unknown>; args?: unknown[]; nowISO?: string };
function child(jobs: Job[], mode: "render" | "autorefresh" = "render"): Record<string, unknown> {
  fs.mkdirSync(CACHE, { recursive: true });
  const seed = path.join(CACHE, "seed.cjs");
  fs.writeFileSync(seed, `/* eslint-disable */
const Module = require("module");
const path = require("path");
const root = ${JSON.stringify(REPO)};
const put = (file, exports) => { const m = new Module(file, null); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m; };
const noop = async () => ({ ok: true, message: "" });
const refreshes = (globalThis.__refreshes = []);
put(require.resolve("next/navigation", { paths: [root] }), { useRouter: () => ({ refresh() { refreshes.push(Date.now()); }, push() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams(), redirect() { throw new Error("redirect"); }, notFound() { throw new Error("notFound"); } });
if (process.env.RSS_MODE === "autorefresh") {
  // AutoRefresh alone, its effect run by hand: a React whose useEffect runs at once.
  globalThis.__cleanups = [];
  put(require.resolve("react", { paths: [root] }), { useEffect: (fn) => { const c = fn(); if (c) globalThis.__cleanups.push(c); } });
} else {
  const React = require(require.resolve("react", { paths: [root] }));
  put(require.resolve("next/link", { paths: [root] }), { __esModule: true, default: (p) => React.createElement("a", { href: p.href, className: p.className }, p.children) });
}
put(path.join(root, "src/app/editing/actions.ts"), { __esModule: true, escalateRushToJordan: noop, previewPriorityImpact: noop, saveEditOverrides: noop });
put(path.join(root, "src/app/editing/workActions.ts"), { __esModule: true, startEditingAction: noop, pauseEditingAction: noop, confirmCurrentWorkAction: noop });
put(path.join(root, "src/app/portal/actions.ts"), { __esModule: true, portalRequestSession: noop, portalRescheduleSession: noop, portalSaveSessionPlanAddress: noop, portalSessionSlots: noop, portalSubmitSessionAddress: noop, portalCancelSessionRequest: noop, portalPlanWithCall: noop, portalPlanWithoutCall: noop, portalScheduleLater: noop });
`);
  const runner = path.join(CACHE, "runner.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
const RealDate = Date;
let NOW = RealDate.parse(process.env.RSS_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const jobs = JSON.parse(require("fs").readFileSync(process.env.RSS_JOBS as string, "utf8"));
const out: Record<string, unknown> = {};
if (process.env.RSS_MODE === "autorefresh") {
  const g = globalThis as any;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const cleared: number[] = [];
  g.setInterval = (fn: () => void, ms: number) => { const id = timers.length + 1; timers.push({ fn, ms, id }); return id; };
  g.clearInterval = (id: number) => { cleared.push(id); };
  let onLineReads = 0;
  g.navigator = new Proxy({}, { get(_t, k) { if (k === "onLine") onLineReads++; return undefined; } });
  g.document = { visibilityState: "visible" };
  const { AutoRefresh } = require(jobs[0].file);
  const rendered = AutoRefresh({ seconds: 60 });
  const tick = () => timers.forEach((t) => t.fn());
  tick();
  const afterVisible = g.__refreshes.length;
  g.document.visibilityState = "hidden";
  tick(); tick();
  const afterHidden = g.__refreshes.length;
  g.document.visibilityState = "visible";
  tick();
  const afterBack = g.__refreshes.length;
  g.__cleanups.forEach((c: () => void) => c());
  out.autorefresh = { rendered, timers: timers.map((t) => t.ms), afterVisible, afterHidden, afterBack, cleared: cleared.length, onLineReads };
} else {
  const { createElement } = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  for (const j of jobs) {
    NOW = RealDate.parse(j.nowISO ?? process.env.RSS_NOW);
    try {
      const mod = require(j.file);
      if (j.args) {
        const args = j.args.map((a: unknown) => (a && typeof a === "object" && "__date" in (a as any) ? new RealDate((a as any).__date) : a));
        out[j.name] = mod[j.exp](...args);
      } else {
        out[j.name] = renderToStaticMarkup(createElement(mod[j.exp], j.props ?? {}));
      }
    } catch (e) {
      out[j.name] = "RENDER_ERROR: " + (e as Error).message;
    }
  }
}
process.stdout.write("\\n@@RSS@@" + JSON.stringify(out));
`);
  const jobsFile = path.join(CACHE, `jobs-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  try {
    const res = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [runner], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: {
        ...process.env,
        // Quoted: the repo folder name has spaces, and NODE_OPTIONS splits on them.
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "scripts/_drill/_client-drill-preload.cjs"))} --require ${JSON.stringify(seed)}`,
        RSS_NOW: new RealDate(PINNED).toISOString(),
        RSS_JOBS: jobsFile,
        RSS_MODE: mode,
      },
    });
    const at = res.lastIndexOf("@@RSS@@");
    return at >= 0 ? (JSON.parse(res.slice(at + 7)) as Record<string, unknown>) : {};
  } finally {
    fs.rmSync(jobsFile, { force: true });
  }
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  const products: Record<string, string[]> = {
    [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm],
    [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm],
    [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm],
  };
  // Starts 9:00–16:00 ET every half hour, so a gate at 2:30 PM leaves real starts on its own day.
  const HOURS = Array.from({ length: 15 }, (_, i) => 9 + i / 2);
  fake = createFakeAryeo({ products, hours: HOURS, defaultCustomerEmail: "info@realtourpilot.com" });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  await prisma.teamMember.create({ data: { name: DRILL_TEAM.james.name, email: "james-aryeo@drill.invalid", aryeoTeamMemberId: DRILL_TEAM.james.tm, aryeoUserId: DRILL_TEAM.james.user, isServiceProvider: true } });

  const aryeo = await import("@/lib/integrations/aryeo");
  const st = await import("@/lib/sessionTravel");
  const portal = await import("@/lib/portal");
  const pa = await import("@/app/portal/actions");
  const oldSt = (await import(baseline("src/lib/sessionTravel.ts"))) as typeof st;
  const clearSlotCache = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: "portal-aryeo-slots:" } } });
  const slotKeys = async () => (await prisma.appSetting.findMany({ where: { key: { startsWith: "portal-aryeo-slots:" } }, select: { key: true } })).map((r) => r.key).sort();
  const datesReads = () => fake!.reads.filter((r) => r.startsWith("/scheduling/available-dates"));
  const param = (read: string, k: string) => new URLSearchParams(read.slice(read.indexOf("?") + 1)).get(k);

  let n = 0;
  const planRow = (f: ContentMonthFixture, sessionIndex = 1) =>
    prisma.programSessionPlan.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, sessionIndex,
        streetNumber: "117", streetName: "Kyle Lane", city: "West Chester", stateCode: "PA", postalCode: "19382",
        latitude: 39.9607, longitude: -75.6055, geocodeSource: "drill", addressValidatedAt: new Date(), addressVersion: 1, lastStep: "ADDRESS",
      },
    });
  /** A TEST client's Accelerator month on the call route, with one strategy call record. */
  const callMonth = async (monthKey: string, start: Date, end: Date, status: "SCHEDULED" | "COMPLETED") => {
    const f = await buildContentMonth(db, { name: `Horizon Drill ${++n} TEST`, package: "Accelerator", monthKey, project: false, owner: { email: `horizon${n}@realtourpilot.com` } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: f.monthId, status, matchState: "MATCHED", scheduledStart: start, scheduledEnd: end, transcriptState: status === "COMPLETED" ? "ANALYZED" : "NONE" } });
    await planRow(f);
    return f;
  };
  /** The written route, every topic answered at `at`. */
  const writtenMonth = async (monthKey: string, at: Date) => {
    const f = await buildContentMonth(db, { name: `Horizon Drill ${++n} TEST`, package: "Accelerator", monthKey, project: false, owner: { email: `horizon${n}@realtourpilot.com` }, topics: ["W1", "W2", "W3", "W4"].map((title) => ({ title, selection: "SELECTED" as const })) });
    await prisma.contentEnrollment.update({ where: { id: f.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
    for (const id of f.topicIds) {
      await prisma.contentInterview.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: id, status: "SUBMITTED", submittedAt: at, sufficiencyJson: JSON.stringify({ sufficient: true, missing: [] }) } });
    }
    await planRow(f);
    return f;
  };
  const auth = (f: ContentMonthFixture) => ({ token: f.portalToken });
  const allStarts = (days: { slots: string[] }[]) => days.flatMap((d) => d.slots);

  // The three months every A19 section reads.
  const FAR = await callMonth("2026-11", et(11, 20, 14), et(11, 20, 14, 30), "SCHEDULED"); // a call booked 25 days out
  const WRITTEN = await writtenMonth("2026-10", et(10, 26, 9)); // answers sent this morning
  const HELD = await callMonth("2026-10", et(10, 19, 13, 30), et(10, 19, 14), "COMPLETED"); // a call held last week

  // =========================================================================
  c.head(`§0 · OLD (${BASE}): tomorrow + 21 days whatever the gate said; no Rush on the job page; an inline freshness rule`);
  // =========================================================================
  {
    await clearSlotCache();
    const oldR = await oldSt.sessionSlotsFor({ enrollmentId: FAR.enrollmentId, monthId: FAR.monthId, sessionIndex: 1, package: "Accelerator" });
    const reads = datesReads();
    c.ok("OLD: a strategy call booked for Fri Nov 20 (2:00–2:30 PM) opens the calendar (the gate is Wed Nov 25, 2:30 PM)…",
      oldR.ok && !oldR.locked && oldR.earliestISO === et(11, 25, 14, 30).toISOString(), `${oldR.ok} ${oldR.earliestISO}`);
    c.ok("…but Aryeo was asked from TOMORROW (Tue Oct 27), and the window ended before the gate",
      reads.length === 1 && /^2026-10-27T14:00:\d\dZ$/.test(param(reads[0], "filter[start_at]") ?? ""), reads[0] ?? "(none)");
    c.ok("…so it offered NOTHING: the client got \"No open times fit right now\" and a free-text box (the dead end)",
      oldR.days.length === 0 && /No open times fit right now/.test(oldR.message), `${oldR.days.length} days · ${oldR.message}`);
    c.ok("OLD sessionTravel never passed the gate to the Aryeo query", !/from: gate\.earliest/.test(show("src/lib/sessionTravel.ts")) && !/from\?: Date/.test(show("src/lib/integrations/aryeo.ts")));
    c.ok("OLD PortalScheduler said nothing about the 72 hours (only \"Sessions start on or after …\" in the free-text box)",
      !/weekday hours/.test(show("src/components/portal/PortalScheduler.tsx")) && /Sessions start on or after/.test(show("src/components/portal/PortalScheduler.tsx")));
    const oldPage = show("src/app/edit/[id]/page.tsx");
    c.ok("OLD /edit/<id>: no Rush control; the rush preview was reachable only inside Override's due-date field",
      !/RushButton/.test(oldPage) && /<EditOverridesButton/.test(oldPage) && /RushPanel/.test(show("src/components/editing/EditOverridesDialog.tsx")));
    c.ok("OLD /edit/<id>: an ask sent to Jordan (rush_approval) was never read on the job page", !/rush_approval/.test(oldPage));
    const oldPanel = show("src/components/editing/WorkingNowPanel.tsx");
    c.ok("OLD WorkingNowPanel: the 3-minute rule was inline in the render (no pure reading a drill could pin)",
      /const stale = now\.getTime\(\) - readAt\.getTime\(\) > STALE_MS/.test(oldPanel) && !/export function readFreshness/.test(oldPanel));
  }

  // =========================================================================
  c.head("§1 · A19, pure: the window's first day, and when the 72 hours are the reason");
  // =========================================================================
  {
    const now = Date.now(); // the pinned clock
    c.ok("no gate → null (the window starts tomorrow, as it always has)", aryeo.availabilityFromDay(null, now) === null && aryeo.availabilityFromDay(undefined, now) === null);
    c.ok("a gate later today or tomorrow → null (tomorrow already covers it)", aryeo.availabilityFromDay(et(10, 26, 18), now) === null && aryeo.availabilityFromDay(et(10, 27, 16), now) === null);
    c.ok("a gate on Wed Nov 25 → \"2026-11-25\" (an ET day, across the DST change)", aryeo.availabilityFromDay(et(11, 25, 14, 30), now) === "2026-11-25");
    c.ok("a gate at 11 PM ET on Thu Oct 29 is Oct 29 (a Friday in UTC) — the client's calendar, not the server's", aryeo.availabilityFromDay(et(10, 29, 23), now) === "2026-10-29");
    c.ok("an invalid date → null", aryeo.availabilityFromDay(new RealDate(NaN), now) === null);
    const nowD = new Date();
    const anchor = (kind: "SUBMISSION" | "CALL_END") => ({ kind });
    const g = (earliest: Date | null, kind: "SUBMISSION" | "CALL_END" | null, windowWaived = false, windowHours = 72) =>
      st.preparationHold({ earliest, anchor: kind ? anchor(kind) : null, windowHours, windowWaived }, nowD);
    const far = g(et(11, 25, 14, 30), "CALL_END");
    c.ok("gate Wed Nov 25 after a call → held: CALL, 72 hours, that instant", far?.after === "CALL" && far.windowHours === 72 && far.earliestISO === et(11, 25, 14, 30).toISOString(), JSON.stringify(far));
    c.ok("answers → ANSWERS; a 96-hour client window says 96", g(et(10, 29, 9), "SUBMISSION")?.after === "ANSWERS" && g(et(10, 30, 9), "SUBMISSION", false, 96)?.windowHours === 96);
    c.ok("a gate on tomorrow's day → null (the next-day floor, not the 72 hours, is what the client meets)", g(et(10, 27, 16), "CALL_END") === null);
    c.ok("a waived window → null (the 72 hours are not the reason); no anchor → null; shut → null",
      g(et(11, 25, 14, 30), "CALL_END", true) === null && g(et(11, 25, 14, 30), null) === null && g(null, "CALL_END") === null);
    c.ok("preparationHold reads the gate it is handed — it never calls addWeekdayHoursET (one reader: programMonths.preparationGate)",
      !/addWeekdayHoursET|earliestFilmingStart/.test(fs.readFileSync(path.join(REPO, "src/lib/sessionTravel.ts"), "utf8")));
  }

  // =========================================================================
  c.head("§2 · A19, the Aryeo query: from the gate's day, the same length, its own cache row");
  // =========================================================================
  {
    await clearSlotCache();
    const r0 = datesReads().length;
    const acc = ARYEO_CONTENT_PRODUCTS.Accelerator.productId;
    const dflt = await aryeo.productAvailability({ productId: acc, durationMin: 240, days: 21 });
    const withFrom = await aryeo.productAvailability({ productId: acc, durationMin: 240, days: 21, from: et(11, 25, 14, 30) });
    const [a, b] = datesReads().slice(r0);
    c.ok("no `from`: start = now + 24 h (Tue Oct 27, 10:00 EDT), end = now + 21 days — byte for byte the old query",
      /^2026-10-27T14:00:\d\dZ$/.test(param(a, "filter[start_at]") ?? "") && /^2026-11-16T14:00:\d\dZ$/.test(param(a, "filter[end_at]") ?? ""), `${param(a, "filter[start_at]")} → ${param(a, "filter[end_at]")}`);
    c.ok("from Wed Nov 25 2:30 PM: start = the ET start of that day (05:00Z, EST), end = 20 days on — the same length",
      param(b, "filter[start_at]") === "2026-11-25T05:00:00Z" && param(b, "filter[end_at]") === "2026-12-15T05:00:00Z", `${param(b, "filter[start_at]")} → ${param(b, "filter[end_at]")}`);
    c.ok("the default read offers Oct 27 onward; the moved read starts Nov 25 and has 2:30 PM on it",
      dflt?.days[0]?.date === "2026-10-27" && withFrom?.days[0]?.date === "2026-11-25" && !!withFrom?.days[0]?.slots.includes(et(11, 25, 14, 30).toISOString().replace(".000Z", "Z")),
      `${dflt?.days[0]?.date} / ${withFrom?.days[0]?.date}`);
    c.ok("weekends are still removed from the moved window", !!withFrom && withFrom.days.every((d) => ![0, 6].includes(new RealDate(`${d.date}T12:00:00Z`).getUTCDay())));
    await clearSlotCache();
    await portal.programSlotDays({ package: "Accelerator" });
    await portal.programSlotDays({ package: "Accelerator", from: et(11, 25, 14, 30) });
    await portal.programSlotDays({ package: "Accelerator", from: et(10, 27, 16) }); // tomorrow: the shared row
    const keys = await slotKeys();
    c.ok("programSlotDays: the shared row keeps its old key; a moved window gets its own row ending \":from:2026-11-25\"; tomorrow reuses the shared one",
      keys.length === 2 && keys.some((k) => k === `portal-aryeo-slots:v4:${acc}:240:21`) && keys.some((k) => k === `portal-aryeo-slots:v4:${acc}:240:21:from:2026-11-25`), keys.join(" · "));
    const cached = datesReads().length;
    await portal.programSlotDays({ package: "Accelerator", from: et(11, 25, 9) });
    c.ok("a second session gated to the same day (another hour) is served from that row — no new Aryeo read", datesReads().length === cached);
  }

  // =========================================================================
  c.head("§3 · A19 end to end: portalSessionSlots, three months");
  // =========================================================================
  {
    await clearSlotCache();
    const far = await pa.portalSessionSlots(auth(FAR), FAR.monthId, 1, {});
    const starts = allStarts(far.days);
    c.ok("a call booked for Fri Nov 20: times ARE offered now (was none)", far.ok && far.days.length > 0, `${far.days.length} days · ${far.message}`);
    c.ok("…the first day is the gate's day, Wed Nov 25, and its first start is 2:30 PM — nothing earlier",
      far.days[0]?.date === "2026-11-25" && starts[0] === et(11, 25, 14, 30).toISOString().replace(".000Z", "Z") && starts.every((s) => new RealDate(s).getTime() >= et(11, 25, 14, 30).getTime()),
      `${far.days[0]?.date} ${starts[0]}`);
    c.ok("…and the window runs its full length past the gate (the fake's 21 days from Nov 25: last weekday Tue Dec 15)",
      far.days[far.days.length - 1]?.date === "2026-12-15", far.days[far.days.length - 1]?.date);
    c.ok("…the result says why: preparation = { after: CALL, 72 hours, Wed Nov 25 2:30 PM }",
      far.preparation?.after === "CALL" && far.preparation.windowHours === 72 && far.preparation.earliestISO === et(11, 25, 14, 30).toISOString(), JSON.stringify(far.preparation));
    const early = await pa.portalRequestSession(auth(FAR), { monthId: FAR.monthId, slotISO: et(11, 24, 10).toISOString(), planId: far.planId ?? null, addressVersion: far.addressVersion ?? null, sessionIndex: 1, creativeTeamMemberId: DRILL_TEAM.james.tm });
    c.ok("a slot before the gate is still refused by the server (Tue Nov 24, 10:00) — never offered, never taken", !early.ok, early.message);
    c.ok("…nothing written for it", (await prisma.programSessionRequest.count({ where: { monthId: FAR.monthId } })) === 0);

    const w = await pa.portalSessionSlots(auth(WRITTEN), WRITTEN.monthId, 1, {});
    const oldW = await oldSt.sessionSlotsFor({ enrollmentId: WRITTEN.enrollmentId, monthId: WRITTEN.monthId, sessionIndex: 1, package: "Accelerator" });
    c.ok("answers sent Mon 9:00 AM: the first day is Thu Oct 29 (72 weekday hours), first start 9:00 AM",
      w.ok && w.days[0]?.date === "2026-10-29" && allStarts(w.days)[0] === et(10, 29, 9).toISOString().replace(".000Z", "Z"), `${w.days[0]?.date} ${allStarts(w.days)[0]}`);
    c.ok("…preparation = { after: ANSWERS, 72 }", w.preparation?.after === "ANSWERS" && w.preparation.windowHours === 72, JSON.stringify(w.preparation));
    c.ok("…OLD offered the same first day but its window stopped two days short (Nov 16 vs Nov 18): the gate ate the front of it",
      oldW.days[0]?.date === "2026-10-29" && oldW.days[oldW.days.length - 1]?.date === "2026-11-16" && w.days[w.days.length - 1]?.date === "2026-11-18",
      `old ${oldW.days[oldW.days.length - 1]?.date} · new ${w.days[w.days.length - 1]?.date}`);

    const h = await pa.portalSessionSlots(auth(HELD), HELD.monthId, 1, {});
    c.ok("a call held last week: tomorrow is the first day (Tue Oct 27, from 10:00 — the next-day floor) and there is NO 72-hour line",
      h.ok && h.days[0]?.date === "2026-10-27" && allStarts(h.days).every((s) => new RealDate(s).getTime() >= et(10, 27, 10).getTime()) && (h.preparation ?? null) === null,
      `${h.days[0]?.date} ${JSON.stringify(h.preparation)}`);
    const noAddr = await buildContentMonth(db, { name: `Horizon Drill ${++n} TEST`, package: "Accelerator", monthKey: "2026-11", project: false, owner: { email: `horizon${n}@realtourpilot.com` } });
    await prisma.programCallRecord.create({ data: { enrollmentId: noAddr.enrollmentId, clientId: noAddr.clientId, callType: "MONTHLY_STRATEGY", monthId: noAddr.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(11, 20, 14), scheduledEnd: et(11, 20, 14, 30), transcriptState: "NONE" } });
    const na = await pa.portalSessionSlots(auth(noAddr), noAddr.monthId, 1, {});
    c.ok("no address yet: the address step still comes first, and it carries the same preparation facts", !na.ok && !!na.needsAddress && na.preparation?.after === "CALL", `${na.message} · ${JSON.stringify(na.preparation)}`);
    c.ok("the portal's sessionGate is untouched: it is still the only reader of the 72 hours (programMonths.preparationGate)",
      /preparationHold\(gate\.preparation, now\)/.test(fs.readFileSync(path.join(REPO, "src/lib/sessionTravel.ts"), "utf8")));
  }

  // =========================================================================
  c.head("§4 · A19, the client's words");
  // =========================================================================
  const SCHED = path.join(REPO, "src/components/portal/PortalScheduler.tsx");
  {
    const out = child([
      { name: "call", file: SCHED, exp: "preparationLine", args: [{ earliestISO: et(11, 25, 14, 30).toISOString(), windowHours: 72, after: "CALL" }, "America/New_York"] },
      { name: "answers", file: SCHED, exp: "preparationLine", args: [{ earliestISO: et(10, 29, 9).toISOString(), windowHours: 72, after: "ANSWERS" }, "America/New_York"] },
      { name: "pacific", file: SCHED, exp: "preparationLine", args: [{ earliestISO: et(10, 29, 9).toISOString(), windowHours: 96, after: "ANSWERS" }, "America/Los_Angeles"] },
    ]);
    const call = String(out.call);
    c.ok("after a call: \"We need 72 weekday hours after your strategy call to prepare, so the first time we can film is Wednesday, November 25 … 2:30 PM EST.\"",
      /^We need 72 weekday hours after your strategy call to prepare, so the first time we can film is Wednesday, November 25.*2:30\sPM EST\.$/.test(call), call);
    c.ok("after answers: \"…after you sent us your planning answers…\" Thursday, October 29, 9:00 AM EDT", /after you sent us your planning answers to prepare, so the first time we can film is Thursday, October 29.*9:00\sAM EDT\.$/.test(String(out.answers)), String(out.answers));
    c.ok("the client's own zone and window: 96 hours, 6:00 AM PDT", /We need 96 weekday hours/.test(String(out.pacific)) && /6:00\sAM PDT\.$/.test(String(out.pacific)), String(out.pacific));
    c.ok("no em dash, no en dash, in any of them", [out.call, out.answers, out.pacific].every((s) => !/[—–]/.test(String(s))));
    const sched = fs.readFileSync(SCHED, "utf8");
    c.ok("the line is drawn at step 2 only when the server sent `preparation`, and the free-text box drops its bare date then",
      /!needsAddress && res\.preparation && \(/.test(sched) && /\{preparationLine\(res\.preparation, tz\)\}/.test(sched) && /!res\.preparation && \(res\.earliestISO \?\? month\.earliestISO\)/.test(sched));
  }

  // =========================================================================
  // §5–§6 · THE RUSH ON THE JOB PAGE
  // =========================================================================
  const { putSetting } = await import("@/lib/settings");
  const { setSession } = await import("@/lib/auth/session");
  const { etAt } = await import("@/lib/datetime");
  const actions = await import("@/app/editing/actions");
  const etd = (month: number, day: number, hour: number, minute = 0) => etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const jamesTm = await prisma.teamMember.create({ data: { name: "James Porter", email: "james-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const tessTm = await prisma.teamMember.create({ data: { name: "Tess Office", email: "tess-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, teamMemberId: string | null, editorKey: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId, editorKey }, select: { id: true, email: true, name: true, role: true } });
  // Production's logins (docs/handoff.md): James ADMIN, Kyle ADMIN, Jordan OWNER, Kim EDITOR.
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER", jordanTm.id);
  const kyle = await mkUser("kyle@drill.invalid", "Kyle Cabrera", "ADMIN", kyleTm.id);
  const james = await mkUser("james@drill.invalid", "James Porter", "ADMIN", jamesTm.id);
  const tess = await mkUser("tess@drill.invalid", "Tess Office", "ADMIN", tessTm.id);
  const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", kimTm.id, "kim");
  // Oct 5 2026: John is the editor ON these jobs (editorId below); since the
  // /edit/<id> route was scoped (c01-edit-route-access), he is the editor who
  // can open this page at all — Kim, on none of them, now gets a 404.
  const john = await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", johnTm.id, "john");
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U, actingAs?: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs: actingAs.id } : {}) });
  await putSetting("review_room", { creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, fallbackReviewerTeamMemberId: jordanTm.id });

  let seq = 0;
  const mkJob = async (street: string, due: Date) => {
    const p = await prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "SHOT", aryeoOrderId: `drill-rss-${++seq}`,
        shootDate: etd(10, 22, 10), photographerId: harrison.id, editorId: johnTm.id, editorManual: true,
        deliveryDue: due, promisedDueAt: due, promisedPinnedAt: etd(10, 22, 12),
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { projectId: p.id, title: "Standard Social Reel" } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, status: "UPLOADED", uploadedAt: new Date() } });
    return { id: p.id, street };
  };
  // John's desk: A due tomorrow 9 AM (inside a day), B Wednesday, C Friday.
  const A = await mkJob("1 Ash St", etd(10, 27, 9));
  const B = await mkJob("2 Birch St", etd(10, 28, 12));
  const C = await mkJob("3 Cedar St", etd(10, 30, 17));
  const pullC = { dueAt: etd(10, 27, 8).toISOString() }; // Friday → tomorrow 8 AM: ahead of A and B

  // The page itself, as each login gets it (the c2-editor-desk element-tree pattern).
  type El = { type?: unknown; props?: Record<string, unknown> };
  const walk = (node: unknown, type: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) { for (const x of node) walk(x, type, out); return out; }
    if (!node || typeof node !== "object") return out;
    const el = node as El;
    if (el.type === type) out.push(el);
    if (el.props) for (const v of Object.values(el.props)) if (v && typeof v === "object") walk(v, type, out);
    return out;
  };
  let page: ((a: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>) | null = null;
  let pageWhy = "";
  {
    const realNav = path.join(REPO, "node_modules/next/navigation.js");
    const M = Module as unknown as { new (id: string): { filename: string; loaded: boolean; exports: unknown }; _cache: Record<string, unknown> };
    const m = new M(realNav);
    m.filename = realNav;
    m.loaded = true;
    m.exports = cjs(path.join(__dirname, "_next-navigation-stub.cjs"));
    M._cache[realNav] = m;
    try {
      page = (cjs(path.join(REPO, "src/app/edit/[id]/page.tsx")) as { default: typeof page }).default;
    } catch (e) {
      pageWhy = (e as Error).message.slice(0, 200);
    }
  }
  const DIALOG = path.join(REPO, "src/components/editing/EditOverridesDialog.tsx");
  const dialogMod = cjs(DIALOG) as typeof import("@/components/editing/EditOverridesDialog");
  const { RushButton, EditOverridesButton } = dialogMod;
  type RushProps = { job: { projectId: string; street: string }; ask?: { by: string | null; atISO: string | null; words: string } | null };
  const rushOf = async (u: U, actingAs?: U, id = C.id) => {
    await as(u, actingAs);
    const tree = await page!({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
    const r = walk(tree, RushButton);
    return { n: r.length, props: r[0]?.props as RushProps | undefined, overrides: walk(tree, EditOverridesButton).length };
  };

  c.head("§5 · the Rush button on /edit/<id>: the desk sees it; an editor and a preview do not");
  {
    const src = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
    c.ok("mounted under the same gate as Override and the server actions: owner/admin, never a preview, a video job",
      /const rushDesk = isOwnerAdmin && !viewer\?\.impersonating && showTracker;/.test(src) && /\{rushDesk && \(\s*<RushButton/.test(src));
    if (!page) {
      c.ok("the /edit/<id> page could be loaded in the drill", false, pageWhy);
    } else {
      const jo = await rushOf(jordan);
      c.ok("Jordan (owner): one Rush button, beside Override, for 3 Cedar St", jo.n === 1 && jo.overrides === 1 && jo.props?.job.projectId === C.id && jo.props.job.street === "3 Cedar St", `${jo.n} rush · ${jo.overrides} override`);
      c.ok("…no ask waiting yet", (jo.props?.ask ?? null) === null);
      const ja = await rushOf(james);
      const ky = await rushOf(kyle);
      const te = await rushOf(tess);
      c.ok("James (creative manager seat, ADMIN login) and Kyle (backup seat, ADMIN) see it", ja.n === 1 && ky.n === 1);
      c.ok("an office login with no seat (Tess) sees it too — she can look, and send it to Jordan; approving is the server's rushAuthority", te.n === 1);
      // Oct 5 2026 — this was "Kim (EDITOR): no Rush button", rendered on a job
      // that is not Kim's. Since the route was scoped, an editor who holds
      // nothing on the job gets no page at all (notFound) — stronger than "no
      // button" — and the editor-sees-no-Rush check moves to John, the job's
      // own editor, for whom the page renders. The previews follow the same
      // rule: previewing Kim is refused like Kim; previewing John or Kyle
      // renders, with no Rush and no Override.
      const refused = async (u: U, actingAs?: U) => { try { await rushOf(u, actingAs); return ""; } catch (e) { return (e as Error).message; } };
      const kimWhy = await refused(kim);
      c.ok("Kim (EDITOR, not on this job): the page is refused outright — so no Rush button", /notFound/.test(kimWhy), kimWhy || "rendered!");
      const jn = await rushOf(john);
      c.ok("John (EDITOR, the job's own editor): the page renders, with no Rush button and no Override", jn.n === 0 && jn.overrides === 0, `${jn.n} rush · ${jn.overrides} override`);
      const pvKimWhy = await refused(jordan, kim);
      const pv = await rushOf(jordan, john);
      const pvAdmin = await rushOf(jordan, kyle);
      c.ok("Jordan previewing Kim is refused like Kim; previewing John, and previewing Kyle (an admin): no Rush button, no Override",
        /notFound/.test(pvKimWhy) && pv.n === 0 && pv.overrides === 0 && pvAdmin.n === 0 && pvAdmin.overrides === 0, `${pvKimWhy ? "refused" : "rendered"} · ${pv.n}/${pvAdmin.n}`);
    }
    // The server says the same thing to anybody the page leaves the button off for.
    await as(kim);
    const kp = await actions.previewPriorityImpact(C.id, pullC);
    const ks = await actions.saveEditOverrides(C.id, pullC, { seen: [A.id, B.id], reason: "editor tries" });
    const ke = await actions.escalateRushToJordan(C.id, pullC, "editor tries");
    c.ok("an editor calling the actions directly is refused by all three: preview, save, send to Jordan",
      !kp.ok && !ks.ok && !ke.ok && [kp.message, ks.message, ke.message].every((m) => m === "Only the office can override a job."), [kp.message, ks.message, ke.message].join(" | "));
    await as(jordan, kyle);
    const vp = await actions.previewPriorityImpact(C.id, pullC);
    const vs = await actions.saveEditOverrides(C.id, pullC, { seen: [A.id, B.id], reason: "preview tries" });
    c.ok("a \"view as\" preview is refused the same way (read-only)", !vp.ok && !vs.ok);
    const untouched = await prisma.project.findUniqueOrThrow({ where: { id: C.id }, select: { dueOverrideAt: true } });
    c.ok("…and 3 Cedar St is untouched", untouched.dueOverrideAt === null);
  }

  c.head("§6 · what the rush pushes back, before Save; the ask to Jordan shows on the job");
  {
    await as(kyle);
    const pk = await actions.previewPriorityImpact(C.id, pullC);
    const gate = pk.gate!;
    c.ok("Kyle's preview (the dialog's own read): 2 of John's jobs pushed back, Kyle may approve as BACKUP",
      pk.ok && gate.impact.displaced.map((d) => d.street).join(",") === "1 Ash St,2 Birch St" && gate.authority.may && gate.authority.as === "BACKUP", JSON.stringify({ d: gate?.impact.displaced.map((d) => d.street), a: gate?.authority.as }));
    await as(tess);
    const tp = await actions.previewPriorityImpact(C.id, pullC);
    const out = child([
      { name: "kyle", file: DIALOG, exp: "RushPanel", props: { gate, loading: false, ack: false, onAck: null, reason: "", onReason: null, onEscalate: null, escalating: false } },
      { name: "tess", file: DIALOG, exp: "RushPanel", props: { gate: tp.gate, loading: false, ack: false, onAck: null, reason: "", onReason: null, onEscalate: null, escalating: false } },
      { name: "button", file: DIALOG, exp: "RushButton", props: { job: { projectId: C.id, street: "3 Cedar St" }, ask: null } },
      { name: "asked", file: DIALOG, exp: "RushButton", props: { job: { projectId: C.id, street: "3 Cedar St" }, ask: { by: "Tess Office", atISO: new RealDate(PINNED).toISOString(), words: "x" } } },
    ]);
    const kyleTxt = text(String(out.kyle));
    c.ok("rendered for Kyle: \"This pushes back 2 of John's jobs\", each with its street, client and promise", /This pushes back 2 of John's jobs/.test(kyleTxt) && /1 Ash St · Drill Agent/.test(kyleTxt) && /2 Birch St/.test(kyleTxt) && /promised Tue, Oct 27, 9:00 AM ET/.test(kyleTxt), kyleTxt.slice(0, 260));
    c.ok("…1 Ash St flagged \"due inside a day\"; the tick box and a \"why\" before Save; \"Send to Jordan instead\"",
      /1 Ash St · Drill Agent promised Tue, Oct 27, 9:00 AM ET · due inside a day/.test(kyleTxt) && /I’ve looked at these 2 jobs and approve moving this ahead of them/.test(kyleTxt) && /Send to Jordan instead/.test(kyleTxt), kyleTxt.slice(0, 400));
    const tessTxt = text(String(out.tess));
    c.ok("rendered for Tess (no seat): the same list, the refusal in words, no tick box, and \"Send to Jordan instead\"",
      /This pushes back 2 of John's jobs/.test(tessTxt) && /Only James or Kyle can approve moving this ahead of other jobs/.test(tessTxt) && !/I’ve looked at/.test(tessTxt) && /Send to Jordan instead/.test(tessTxt), tessTxt.slice(0, 300));
    c.ok("the closed button reads \"Rush\"; with an ask waiting it reads \"Rush asked\"", /Rush<\/button>/.test(String(out.button)) && !/Rush asked/.test(String(out.button)) && /Rush asked/.test(String(out.asked)), `${text(String(out.button))} / ${text(String(out.asked))}`);

    // Tess sends it to Jordan: nothing on the job changes, and the job page carries the ask.
    const esc = await actions.escalateRushToJordan(C.id, pullC, "the agent's open house moved to Wednesday");
    const card = await prisma.smartTask.findFirst({ where: { projectId: C.id, taskType: "rush_approval" }, select: { status: true, flaggedBy: true, summary: true } });
    c.ok("Tess's ask becomes Jordan's card; the job's date is untouched", esc.ok && card?.status === "OPEN" && (await prisma.project.findUniqueOrThrow({ where: { id: C.id }, select: { dueOverrideAt: true } })).dueOverrideAt === null, esc.message);
    if (page) {
      const jo = await rushOf(jordan);
      const ask = jo.props?.ask;
      c.ok("the job page now hands the Rush button that ask: sent by Tess Office, with her reason and the two jobs",
        !!ask && ask.by === "Tess Office" && /Why: “the agent's open house moved to Wednesday”/.test(ask.words) && /1 Ash St/.test(ask.words) && /2 Birch St/.test(ask.words), JSON.stringify(ask));
      c.ok("…without the card's \"Approve by saving … in the job's Override\" tail (the dialog says how, in its own words)", !!ask && !/Approve by saving/.test(ask.words) && ask.words.length > 0);
      const kimView = await (async () => { try { return await rushOf(kim); } catch { return null; } })();
      c.ok("an editor still gets no button, so never the ask", !kimView || kimView.n === 0);
      // Jordan approves by saving the same change — the same action the dialog's Save calls.
      await as(jordan);
      const save = await actions.saveEditOverrides(C.id, pullC, { seen: [A.id, B.id], reason: "approved — open house" });
      const after = await prisma.smartTask.findFirst({ where: { projectId: C.id, taskType: "rush_approval" }, select: { status: true } });
      const line = await prisma.activity.findFirst({ where: { projectId: C.id, body: { contains: "rush approved" } }, select: { body: true } });
      c.ok("Jordan's save lands, closes the card, and the timeline says who approved it and what it pushed back",
        save.ok && after?.status === "COMPLETED" && !!line && /rush approved by Jordan Spackman/.test(line.body) && /1 Ash St/.test(line.body), `${save.message} · ${line?.body.slice(0, 160)}`);
      const back = await rushOf(jordan);
      c.ok("…and the button is plain \"Rush\" again (no ask waiting)", back.n === 1 && (back.props?.ask ?? null) === null);
      const promise = await prisma.project.findUniqueOrThrow({ where: { id: C.id }, select: { promisedDueAt: true, dueOverrideAt: true } });
      c.ok("the client's promise is never re-pinned by a rush (promisedDueAt still Fri Oct 30, 5 PM)", promise.promisedDueAt?.getTime() === etd(10, 30, 17).getTime() && promise.dueOverrideAt?.getTime() === etd(10, 27, 8).getTime());

      // THE QUEUE CHANGES BETWEEN THE ASK AND THE SAVE (review, Sep 28). The
      // job the rush pushed back hands its cut in, so the save pushes nobody
      // back, needs no approval and wrote no "rush approved" line — and the
      // card used to stay open, the job page reading "Waiting on approval"
      // for a date the job already had, with Save answering "Nothing changed".
      const { readRushAsk } = await import("@/lib/editorWorkload");
      const handIn = (id: string) =>
        prisma.project.update({ where: { id }, data: { status: "REVIEW", statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 1 } }) } });
      const askCard = (id: string) => prisma.smartTask.findFirst({ where: { projectId: id, taskType: "rush_approval" }, select: { status: true, sourceDetail: true } });
      const lastLine = async (id: string) => (await prisma.activity.findFirst({ where: { projectId: id, body: { startsWith: "Override by" } }, orderBy: { createdAt: "desc" }, select: { body: true } }))?.body ?? "";

      // 1. Jordan saves exactly what was asked, after the queue changed.
      const D = await mkJob("4 Dogwood St", etd(10, 29, 12));
      const E = await mkJob("5 Elm St", etd(10, 31, 17));
      const pullE = { dueAt: etd(10, 29, 10).toISOString() };
      await as(tess);
      const eAsk = await actions.escalateRushToJordan(E.id, pullE, "the listing goes live Thursday");
      const eCard = await askCard(E.id);
      c.ok("the ask pushes back 4 Dogwood St, and the card carries what was asked as data", eAsk.ok && eCard?.status === "OPEN" && readRushAsk(eCard.sourceDetail)?.dueAt === pullE.dueAt && /4 Dogwood St/.test(eAsk.message + ((await prisma.smartTask.findFirst({ where: { projectId: E.id, taskType: "rush_approval" }, select: { summary: true } }))?.summary ?? "")), eAsk.message);
      await handIn(D.id);
      await as(jordan);
      const eGate = (await actions.previewPriorityImpact(E.id, pullE)).gate;
      c.ok("4 Dogwood St handed its cut in: the same change now pushes nobody back", !!eGate && eGate.impact.displaced.length === 0, JSON.stringify(eGate?.impact.displaced.map((d) => d.street)));
      const eSave = await actions.saveEditOverrides(E.id, pullE);
      const eLine = await lastLine(E.id);
      c.ok("Jordan saves the asked date: it lands, and the card is closed (OLD: it stayed open)", eSave.ok && (await askCard(E.id))?.status === "COMPLETED", eSave.message);
      c.ok("…the timeline says which ask it answered, and why no approval was needed", /this is the rush Tess Office asked for; it no longer pushes any other job back, so it needed no approval/.test(eLine) && !/rush approved/.test(eLine), eLine);
      const eBack = await rushOf(jordan, undefined, E.id);
      c.ok("…and the job page's button is plain \"Rush\" again, no \"Waiting on approval\"", eBack.n === 1 && (eBack.props?.ask ?? null) === null);

      // 2. Somebody with no seat moves the date elsewhere: the ask stays Jordan's.
      const G = await mkJob("6 Gum St", etd(11, 3, 12));
      const H = await mkJob("7 Hazel St", etd(11, 5, 17));
      const pullH = { dueAt: etd(11, 3, 10).toISOString() };
      await as(tess);
      const hAsk = await actions.escalateRushToJordan(H.id, pullH, "the agent's open house");
      const hOther = await actions.saveEditOverrides(H.id, { dueAt: etd(11, 4, 12).toISOString() });
      c.ok("Tess sends it to Jordan, then moves the date somewhere that pushes nobody back: saved, the ask stays open", hAsk.ok && hOther.ok && (await askCard(H.id))?.status === "OPEN", hOther.message);
      const hStill = await rushOf(jordan, undefined, H.id);
      c.ok("…and the job page still shows it waiting (Jordan has not answered it)", !!hStill.props?.ask && hStill.props.ask.by === "Tess Office");
      // 3. …then the queue changes and she saves exactly what she asked: nothing left to approve.
      await handIn(G.id);
      await as(tess);
      const hAsked = await actions.saveEditOverrides(H.id, pullH);
      c.ok("once 6 Gum St is in review, Tess saving her own ask lands with no approval, and closes the card", hAsked.ok && (await askCard(H.id))?.status === "COMPLETED" && /this is the rush Tess Office asked for/.test(await lastLine(H.id)), hAsked.message);

      // 4. James (the creative manager seat) decides on a different date: that is the answer.
      const J = await mkJob("8 Juniper St", etd(11, 10, 12));
      const K = await mkJob("9 Kapok St", etd(11, 12, 17));
      await as(tess);
      await actions.escalateRushToJordan(K.id, { dueAt: etd(11, 10, 10).toISOString() }, "the seller asked");
      await handIn(J.id);
      await as(james);
      const kSave = await actions.saveEditOverrides(K.id, { dueAt: etd(11, 11, 9).toISOString() });
      c.ok("James saves a different date: his decision settles the ask, and the timeline says so", kSave.ok && (await askCard(K.id))?.status === "COMPLETED" && /this settles the rush Tess Office asked for/.test(await lastLine(K.id)), `${kSave.message} · ${await lastLine(K.id)}`);
    }
    const dialogSrc = fs.readFileSync(DIALOG, "utf8");
    c.ok("the Rush dialog is the Override dialog in \"rush\" mode — the same save, preview and escalation, only due and priority drawn",
      /<OverridesDialog job=\{job\} mode="rush" ask=\{ask\}/.test(dialogSrc) && /\{!rushOnly && <Field\s+label="Status"/.test(dialogSrc) && /\{!rushOnly && <Field label="Editor"/.test(dialogSrc) && /\{!rushOnly && <Field\s+label="Videos owed"/.test(dialogSrc));
  }

  // =========================================================================
  c.head("§7 · 7.1-refresh-stale: the warning when a refresh stops landing");
  // =========================================================================
  {
    const PANEL = path.join(REPO, "src/components/editing/WorkingNowPanel.tsx");
    const DESK = path.join(REPO, "src/components/editing/EditorDesk.tsx");
    const READ_AT = et(10, 26, 10, 4).toISOString(); // 10:04 AM ET
    const at = (min: number, sec = 0) => ({ __date: RealDate.parse(READ_AT) + min * 60_000 + sec * 1000 });
    const okView = {
      ok: true, readAt: READ_AT,
      lines: [{ key: "kim", name: "Kim", tone: "on", lead: "On", job: { href: "/edit/x", street: "107 E Old Baltimore Pike" }, tail: "since 9:40am", details: [] }],
    };
    const failed = { ok: false, readAt: READ_AT, error: "the read failed" };
    const out = child([
      { name: "f259", file: PANEL, exp: "readFreshness", args: [okView, at(2, 59)] },
      { name: "f300", file: PANEL, exp: "readFreshness", args: [okView, at(3, 0)] },
      { name: "f301", file: PANEL, exp: "readFreshness", args: [okView, at(3, 1)] },
      { name: "f60", file: PANEL, exp: "readFreshness", args: [okView, at(60)] },
      { name: "fail", file: PANEL, exp: "readFreshness", args: [failed, at(0, 30)] },
      { name: "future", file: PANEL, exp: "readFreshness", args: [okView, at(-1)] },
      { name: "rFresh", file: PANEL, exp: "WorkingNowPanel", props: { view: okView }, nowISO: new RealDate(RealDate.parse(READ_AT) + 60_000).toISOString() },
      { name: "rStale", file: PANEL, exp: "WorkingNowPanel", props: { view: okView }, nowISO: new RealDate(RealDate.parse(READ_AT) + 4 * 60_000).toISOString() },
      { name: "rFail", file: PANEL, exp: "WorkingNowPanel", props: { view: failed }, nowISO: new RealDate(RealDate.parse(READ_AT) + 30_000).toISOString() },
      { name: "deskNull", file: DESK, exp: "EditorDesk", props: { desk: null, jobs: [], tz: "Asia/Manila" } },
      { name: "deskOk", file: DESK, exp: "EditorDesk", props: { desk: { active: null, unconfirmed: [] }, jobs: [], tz: "Asia/Manila" } },
    ]);
    type F = { state: string; words: string };
    const f = (k: string) => out[k] as F;
    c.ok("2:59 after the read: fresh, \"as of 10:04am\"", f("f259")?.state === "fresh" && f("f259").words === "as of 10:04am", JSON.stringify(out.f259));
    c.ok("exactly 3:00: still fresh (the rule is MORE than three minutes)", f("f300")?.state === "fresh", JSON.stringify(out.f300));
    c.ok("3:01: stale, \"may be out of date — read 10:04am\"", f("f301")?.state === "stale" && f("f301").words === "may be out of date — read 10:04am", JSON.stringify(out.f301));
    c.ok("an hour on: still stale, still naming 10:04am (never re-dated to now)", f("f60")?.state === "stale" && /read 10:04am$/.test(f("f60").words), JSON.stringify(out.f60));
    c.ok("a FAILED read: \"Couldn't read who is working — last attempt 10:04am.\" (never \"nobody\")", f("fail")?.state === "failed" && f("fail").words === "Couldn’t read who is working — last attempt 10:04am." && !/nobody/i.test(f("fail").words), JSON.stringify(out.fail));
    c.ok("a read stamped a minute AHEAD of the tab's clock (a fresh page, a slow clock) is fresh, not stale", f("future")?.state === "fresh");
    const fresh = text(String(out.rFresh));
    const stale = text(String(out.rStale));
    const fail = text(String(out.rFail));
    c.ok("rendered a minute after the read: the header says \"as of 10:04am\" and the line is there", /Editors today/.test(fresh) && /as of 10:04am/.test(fresh) && !/may be out of date/.test(fresh) && /107 E Old Baltimore Pike/.test(fresh), fresh.slice(0, 160));
    c.ok("rendered four minutes after (the refresh stopped landing): \"may be out of date — read 10:04am\", and the SAME line stays", /may be out of date — read 10:04am/.test(stale) && /107 E Old Baltimore Pike/.test(stale), stale.slice(0, 160));
    c.ok("…the stale header wears the warning tone; the fresh one does not", /warning/.test(String(out.rStale).slice(0, 600)) && !/warning/.test(String(out.rFresh).slice(0, 600)));
    c.ok("rendered after a FAILED read: the can't-read sentence and \"This is not “nobody is working”\"; no editor lines", /Couldn’t read who is working — last attempt 10:04am\. This is not “nobody is working”; refresh to try again\./.test(fail) && !/107 E/.test(fail), fail);
    const dn = text(String(out.deskNull));
    const dk = text(String(out.deskOk));
    c.ok("the editor's desk after a failed read: \"Couldn't load what you're on right now — refresh the page\" (starting stays safe)", /Couldn’t load what you’re on right now — refresh the page\. Starting a job below is still safe\./.test(dn), dn.slice(0, 200));
    c.ok("…and after a good read, no such line", !/Couldn’t load/.test(dk) && !/RENDER_ERROR/.test(dk), dk.slice(0, 120));

    const ar = child([{ name: "ar", file: path.join(REPO, "src/components/ops/AutoRefresh.tsx"), exp: "AutoRefresh" }], "autorefresh").autorefresh as {
      rendered: unknown; timers: number[]; afterVisible: number; afterHidden: number; afterBack: number; cleared: number; onLineReads: number;
    } | undefined;
    c.ok("AutoRefresh (seconds=60): one 60-second timer; renders nothing", !!ar && ar.rendered === null && JSON.stringify(ar.timers) === "[60000]", JSON.stringify(ar));
    c.ok("…a visible tab is refreshed on the tick; a hidden one is not (two ticks, nothing); visible again → refreshed", !!ar && ar.afterVisible === 1 && ar.afterHidden === 1 && ar.afterBack === 2);
    c.ok("…the timer is cleared on unmount, and navigator.onLine is never read", !!ar && ar.cleared === 1 && ar.onLineReads === 0);
    const editingPage = fs.readFileSync(path.join(REPO, "src/app/editing/page.tsx"), "utf8");
    // Oct 5 2026: the Editing Room leads with a compact "editors today"
    // summary (EditingWorkSummary — the same read, judged by the same
    // readFreshness) and the full WorkingNowPanel moved into the workload
    // fold. The minute re-read now sits beside the summary that is on screen.
    const summarySrc = fs.readFileSync(path.join(REPO, "src/components/editing/EditingWorkSummary.tsx"), "utf8");
    c.ok("the office Editing Room mounts <AutoRefresh seconds={60} /> beside the editors-today summary, which judges freshness the panel's way",
      /<AutoRefresh seconds=\{60\} \/>\s*<EditingWorkSummary view=\{today\} \/>/.test(editingPage) && /<WorkingNowPanel view=\{today\} \/>/.test(editingPage) &&
      /readFreshness\(view, now\)/.test(summarySrc) && !/navigator\.onLine/.test(summarySrc));
    const panelSrc = fs.readFileSync(PANEL, "utf8");
    c.ok("the panel judges freshness from the read's own time only — no navigator.onLine, no presence", !/navigator\.onLine|visibilityState|presence/i.test(panelSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")) && /readFreshness\(view, now\)/.test(panelSrc));
  }

  // =========================================================================
  c.head("§8 · fences");
  // =========================================================================
  c.ok("no Aryeo write (the slot reads are GETs to the fake)", fake.writes.length === 0, `${fake.writes.length} writes`);
  c.ok("the model was never called", aiCalls === 0);
  c.ok("nothing left the machine: every outbound call was a fake or blocked", fence.blocked.every((u) => !/aryeo|osrm/.test(u)), fence.blocked.slice(0, 5).join(" · "));
  void osrmCalls;

  c.summary();
  quiet.restore();
  await stop();
  fs.rmSync(CACHE, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(CACHE, { recursive: true, force: true });
  process.exit(1);
});
