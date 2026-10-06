// ---------------------------------------------------------------------------
// DRILL: THE LAST UNBLOCKED REMAINDERS (unified handoff, Sep 28 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/final-remainders.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:6130
// (DRILL_PORT overrides), a fake Aryeo behind the network fence, and the same
// files at 0950c1c (never HEAD) for the old behaviour. Production is never
// opened; the model is never called; no message is sent.
//
//   §A  "WAITING ON A FILE" on /edit/<id> (§10 J3). OLD: nothing in the UI
//       called either action, and the lib took any "who" as a key. NEW: the
//       card is on the page for a live owner/admin only (never an editor,
//       never a "view as" preview); recording through it makes the find-it
//       task (and the work-from-it task when asked) and a rerun makes
//       nothing; the id comes from the words and passes the server's slugOk;
//       attaching closes the finding only and releases the work-from-it
//       task; an editor or a preview calling either action is refused; the
//       editor's brief carries the sentence; nothing reaches the client.
//   §B  A19, NO TEN-A-DAY CAP. A day with 14 free starts offers 14 (OLD: 10,
//       the afternoon gone) — in programSlotDays, from its cache, and end to
//       end through portalSessionSlots; the picker wraps 16 chips into a
//       three-column grid split morning / afternoon, with nothing that can
//       push the page sideways.
//   §C  7.3 ONE SET OF WORDS FOR THE FOOTAGE. The upload page hands the
//       portal the ladder the edit tracker reads, and the portal prints it
//       rung for rung in the tracker's words: tick only, files found, a stale
//       read, an empty folder, a stale sighting, handed off with editing
//       started and a cut in; never "files found" on a tick alone. OLD printed
//       its own words ("ticked uploaded", "Dropbox shows 12 files").
//   §D  THE ZONE OF EACH TIME'S OWN DATE. OLD PortalScheduler labelled every
//       time with today's abbreviation ("EDT" on a November session); NEW
//       says EST for November, EDT for September, PST in Los Angeles.
//   §E  fences.
//
// THE CLOCK IS PINNED: Mon Oct 26 2026, 10:00 EDT (it runs forward from there).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 6130);
const BASE = "0950c1c"; // the commit this work starts from — never HEAD
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const CACHE = path.join(REPO, "node_modules/.cache", `final-remainders-${process.pid}`);

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
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

// ---- modules that cannot load under the react-server build of React -------
// The pages' element trees are WALKED here, never rendered: the icons and the
// link are inert, and the upload portal is a named stand-in (its props are
// what the page hands it). The real components render in the child below.
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  function UploadPortal() { return null; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    if (/components[\\/]upload[\\/]UploadPortal(\.tsx)?$/.test(request)) return { __esModule: true, UploadPortal };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
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
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://router.project-osrm.org/")) {
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 5000, duration: 300 }] }), { status: 200 });
  }
  return fake ? fake.handle(url, init) : null;
});

// ---- element trees ----------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, name: string) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }); return out; };
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- the old code, from BASE (never HEAD) -----------------------------------
const show = (rel: string) => execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
function baseline(rel: string, withReact = false): string {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`);
  fs.writeFileSync(out, `${withReact ? 'import * as React from "react";\n' : ""}${show(rel).replace(/(["'])@\//g, `$1${REPO}/src/`)}`);
  return out;
}

// ---- the render harness (a child process, no react-server condition) -------
// Client components rendered to HTML with react-dom/server; every server-action
// file they import is a stand-in, so a render can never reach the server (and
// nothing is clicked). A case either renders a component or calls a pure export.
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
type Job = { name: string; file: string; exp: string; props?: Record<string, unknown>; args?: unknown[] };
function child(jobs: Job[]): Record<string, unknown> {
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
const actions = () => new Proxy({ __esModule: true }, { get: (_t, k) => (k === "__esModule" ? true : k === "then" ? undefined : noop) });
for (const f of ["src/app/upload/actions.ts", "src/app/upload/draftActions.ts", "src/app/shoot/actions.ts", "src/app/editing/actions.ts", "src/app/editing/workActions.ts", "src/app/portal/actions.ts"]) put(path.join(root, f), actions());
`);
  const runner = path.join(CACHE, "runner.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
const RealDate = Date;
const NOW = RealDate.parse(process.env.FR_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const jobs = JSON.parse(require("fs").readFileSync(process.env.FR_JOBS as string, "utf8"));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const out: Record<string, unknown> = {};
for (const j of jobs) {
  try {
    const mod = require(j.file);
    out[j.name] = j.args ? mod[j.exp](...j.args) : renderToStaticMarkup(createElement(mod[j.exp], j.props ?? {}));
  } catch (e) {
    out[j.name] = "RENDER_ERROR: " + (e as Error).message;
  }
}
process.stdout.write("\\n@@FR@@" + JSON.stringify(out));
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
        FR_NOW: new RealDate(PINNED).toISOString(),
        FR_JOBS: jobsFile,
      },
    });
    const at = res.lastIndexOf("@@FR@@");
    return at >= 0 ? (JSON.parse(res.slice(at + 6)) as Record<string, unknown>) : {};
  } finally {
    fs.rmSync(jobsFile, { force: true });
  }
}
/** The text of one half's row in an EvidenceLadder (the tracker's own markup). */
const ladderText = (html: string, cat: string) => {
  const m = new RegExp(`<li[^>]*data-ladder="${cat}"[^>]*>([\\s\\S]*?)</li>`).exec(html);
  return m ? text(m[1]) : "";
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { putSetting } = await import("@/lib/settings");
  const { setSession, establishSession } = await import("@/lib/auth/session");
  const { etDateTime } = await import("@/lib/datetime");
  const dout = await import("@/lib/deliverableOutputs");
  const deps = await import("@/lib/assetDependencies");
  const actions = await import("@/app/editing/actions");
  const EditPage = (await import("@/app/edit/[id]/page")).default;
  const UploadPage = (await import("@/app/upload/[id]/page")).default;
  const CARD = path.join(REPO, "src/components/editing/AssetDependencyCard.tsx");
  const { assetSlugFor } = (await import(CARD)) as typeof import("@/components/editing/AssetDependencyCard");

  // ---- the people ----------------------------------------------------------
  const tm = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER" | "EDITOR") => prisma.teamMember.create({ data: { name, email, role }, select: { id: true } });
  const kyleTm = await tm("Kyle Cabrera", "kyle-tm@drill.invalid", "MANAGER");
  const jordanTm = await tm("Jordan Spackman", "jordan-tm@drill.invalid", "PHOTOGRAPHER");
  const kimTm = await tm("Kim Miguel", "kim-tm@drill.invalid", "EDITOR");
  await tm("John Mark", "john-tm@drill.invalid", "EDITOR");
  const harrisonTm = await tm("Harrison Drill", "harrison-fr@drill.invalid", "PHOTOGRAPHER");
  await putSetting("review_room", { creativeApproverTeamMemberId: null, backupReviewerTeamMemberId: kyleTm.id, fallbackReviewerTeamMemberId: jordanTm.id });
  const mkUser = (email: string, name: string, role: string, teamMemberId: string | null, editorKey: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId, editorKey }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER", jordanTm.id);
  const kyle = await mkUser("kyle@drill.invalid", "Kyle Cabrera", "ADMIN", kyleTm.id);
  const kim = await mkUser("kim@drill.invalid", "Kim Miguel", "EDITOR", kimTm.id, "kim");
  const harrison = await mkUser("harrison-fr@drill.invalid", "Harrison Drill", "PHOTOGRAPHER", harrisonTm.id);
  // The one-time "new upload process" acknowledgement the upload page asks for first.
  await prisma.appSetting.create({ data: { key: `upload-ack-${harrison.email}`, value: "true" } });
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U, actingAs?: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs: actingAs.id } : {}) });
  const client = await prisma.client.create({ data: { name: "Remainders Agent" }, select: { id: true } });

  // =========================================================================
  // §A · WAITING ON A FILE, ON THE JOB PAGE
  // =========================================================================
  const job = await prisma.project.create({
    data: {
      title: "40 Asset Way, Royersford, PA", clientId: client.id, status: "SHOT", aryeoOrderId: "drill-fr-1",
      shootDate: et(10, 22, 10), photographerId: harrisonTm.id, editorId: kimTm.id, editorManual: true,
      deliveryDue: et(10, 30, 17), promisedDueAt: et(10, 30, 17),
      statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      deliverables: {
        create: [
          { type: "PHOTOS", label: "Photos", quantity: 1 },
          { type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1, status: "UPLOADED", uploadedAt: et(10, 22, 20) },
          { type: "VIDEO", label: "Video", productTitle: "Cinematic MLS Video", videoStyle: "standard_cinematic", quantity: 1, status: "UPLOADED", uploadedAt: et(10, 22, 20) },
        ],
      },
    },
    select: { id: true },
  });
  await dout.ensureOutputsForProject(job.id);
  const outs = await dout.outputBriefsFor(job.id);
  const [v1, v2] = outs;
  const assetTasks = () =>
    prisma.smartTask.findMany({
      where: { projectId: job.id, taskType: { in: [deps.RETRIEVAL_TASK, deps.INTERPRETATION_TASK] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, taskType: true, status: true, assignedKey: true, ownerId: true, outputId: true, blockedReason: true, sourceDetail: true, dedupeKey: true, source: true, description: true, title: true },
    });
  type CardProps = { projectId: string; open: { taskId: string; stage: string; sentence: string; scope: string }[]; videos: { outputId: string; label: string }[]; people: { key: string; name: string }[]; readFailed: boolean };
  const cardOf = async (u: U, actingAs?: U): Promise<{ n: number; props: CardProps | null; err: string }> => {
    await as(u, actingAs);
    try {
      const tree = await EditPage({ params: Promise.resolve({ id: job.id }), searchParams: Promise.resolve({}) });
      const cards = find(tree, "AssetDependencyCard");
      return { n: cards.length, props: (cards[0]?.props as CardProps) ?? null, err: "" };
    } catch (e) {
      return { n: 0, props: null, err: (e as Error).message.slice(0, 120) };
    }
  };

  c.head(`§A0 · OLD (${BASE}): nothing in the UI called either action; the lib took any "who" as a key`);
  {
    const oldPage = show("src/app/edit/[id]/page.tsx");
    c.ok("OLD /edit/<id> mounted no dependency card and read no open dependency", !/AssetDependencyCard|openAssetDependencies|recordAssetDependencyAction/.test(oldPage));
    const callers = execFileSync("git", ["grep", "-l", "-E", "recordAssetDependencyAction|attachAssetReferenceAction", BASE, "--", "src"], { cwd: REPO, encoding: "utf8" })
      .trim().split("\n").map((l) => l.replace(`${BASE}:`, ""));
    c.ok("OLD: the two actions existed and NOTHING called them (the only file naming them is the one defining them)", callers.length === 1 && callers[0] === "src/app/editing/actions.ts", callers.join(", "));
    const oldDeps = (await import(baseline("src/lib/assetDependencies.ts"))) as typeof deps;
    const r = await oldDeps.recordAssetDependency({ projectId: job.id, slug: "old-probe", need: "a probe file", interpretation: { what: "Read it", ownerKey: "somebody" }, by: "Drill" });
    const t = (await assetTasks()).find((x) => x.taskType === deps.INTERPRETATION_TASK);
    c.ok("OLD lib: a made-up \"who\" (\"somebody\") was written as the task's key, owned by nobody", r.ok && t?.assignedKey === "somebody" && t.ownerId === null, `${t?.assignedKey} / ${t?.ownerId}`);
    await prisma.smartTask.deleteMany({ where: { projectId: job.id } });
    await prisma.activity.deleteMany({ where: { projectId: job.id } });
  }

  c.head("§A1 · the card on /edit/<id>: a live owner/admin sees it; an editor and a preview do not");
  {
    const src = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
    c.ok("mounted under the strict desk gate (a LIVE owner/admin, never a preview), like the raise-gap form",
      /const assetDesk = strictOwnerAdmin && !viewer\?\.impersonating;/.test(src) && /\{assetDesk && \(\s*<AssetDependencyCard/.test(src));
    const jo = await cardOf(jordan);
    const ky = await cardOf(kyle);
    c.ok("Jordan (OWNER) and Kyle (ADMIN): one card each", jo.n === 1 && ky.n === 1, `${jo.n}/${ky.n} ${jo.err}${ky.err}`);
    c.ok("…nothing waiting yet, and the read did not fail", !!jo.props && jo.props.open.length === 0 && jo.props.readFailed === false);
    c.ok("…\"which video\" offers the job's two owed videos by name", JSON.stringify(jo.props?.videos) === JSON.stringify([{ outputId: v1.outputId, label: `Video 1: ${v1.label}` }, { outputId: v2.outputId, label: `Video 2: ${v2.label}` }]), JSON.stringify(jo.props?.videos));
    c.ok("…\"who\" offers exactly the lib's INTERPRETER_KEYS, Jordan first, by name",
      JSON.stringify(jo.props?.people) === JSON.stringify([{ key: "jordan", name: "Jordan" }, { key: "kyle", name: "Kyle" }, { key: "kim", name: "Kim" }, { key: "john", name: "John Mark" }]), JSON.stringify(jo.props?.people));
    const ki = await cardOf(kim);
    c.ok("Kim (EDITOR, her own job): the page renders, with no card", ki.n === 0 && !ki.err, ki.err || "rendered, no card");
    const pvKim = await cardOf(jordan, kim);
    const pvKyle = await cardOf(jordan, kyle);
    c.ok("Jordan previewing Kim, and Jordan previewing Kyle (an admin): no card", pvKim.n === 0 && pvKyle.n === 0, `${pvKim.n}/${pvKyle.n} ${pvKim.err}${pvKyle.err}`);
  }

  c.head("§A2 · the card's words, rendered (nothing waiting)");
  const cardBase = { projectId: job.id, videos: [{ outputId: v1.outputId, label: `Video 1: ${v1.label}` }, { outputId: v2.outputId, label: `Video 2: ${v2.label}` }], people: [{ key: "jordan", name: "Jordan" }, { key: "kyle", name: "Kyle" }, { key: "kim", name: "Kim" }, { key: "john", name: "John Mark" }] };
  {
    const out = child([
      { name: "empty", file: CARD, exp: "AssetDependencyCard", props: { ...cardBase, open: [], readFailed: false } },
      { name: "failed", file: CARD, exp: "AssetDependencyCard", props: { ...cardBase, open: [], readFailed: true } },
    ]);
    const empty = String(out.empty);
    const t = text(empty);
    c.ok("nothing waiting: ONE folded line (a closed <details>), quiet", /^<details[^>]*data-asset-deps="none"/.test(empty) && !/<details[^>]* open/.test(empty) && /Waiting on a file\? A plat or survey, the client’s logo…/.test(t), t.slice(0, 120));
    c.ok("…inside it: what is missing, which video (the whole job or either video), someone works from it, Record it",
      /What is missing/.test(t) && /Which video The whole job Video 1: .+ Video 2: .+/.test(t) && /Someone must work from it once it is in/.test(t) && /Record it/.test(t) && /Nothing is sent to the client/.test(t), t.slice(0, 400));
    c.ok("…and no attach field (nothing to attach to)", !/Attach the file/.test(t));
    c.ok("a failed read says so — never shown as \"nothing waiting\"", /Couldn’t read what this job is waiting on\. Refresh to try again\./.test(text(String(out.failed))), text(String(out.failed)).slice(0, 160));
  }

  c.head("§A3 · the id comes from the words, and passes the server's slugOk");
  {
    const cases: [string, string][] = [
      ["the client's logo file", "the-client-s-logo-file"],
      ["the recorded plat or survey for the lot lines", "the-recorded-plat-or-survey-for-the-lot-lines"],
      ["  HOA Map (2026)!  ", "hoa-map-2026"],
      ["Café résumé logo", "cafe-resume-logo"],
    ];
    c.ok("lowercase-hyphen from the words", cases.every(([w, s]) => assetSlugFor(w) === s), cases.map(([w]) => assetSlugFor(w)).join(" | "));
    const long = "the complete recorded subdivision plat, the boundary survey and the HOA's common area map for the whole development";
    const odd = ["-- leading", "trailing --", "a".repeat(200), long, "x-", "9 lot lines"];
    c.ok("every one passes slugOk, however long or odd (≤ 61, no leading/trailing hyphen)", [...cases.map(([w]) => w), ...odd].every((w) => deps.slugOk(assetSlugFor(w))), odd.map(assetSlugFor).join(" | "));
    c.ok("nothing to make an id from → \"\" (the card asks for words; the server would refuse it too)", assetSlugFor("—— !!") === "" && !deps.slugOk(""));
  }

  c.head("§A4 · recording through the office's action: the find-it task, the work-from-it task when asked; a rerun makes nothing");
  const LOGO = "the client's logo file";
  const PLAT = "the recorded plat or survey for the lot lines";
  {
    await as(kyle);
    const r1 = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: v2.outputId, slug: assetSlugFor(LOGO), need: LOGO, interpretation: { what: "Put the logo on the intro card", ownerKey: "kim" } });
    const t1 = await assetTasks();
    const ret = t1.find((x) => x.taskType === deps.RETRIEVAL_TASK);
    const int = t1.find((x) => x.taskType === deps.INTERPRETATION_TASK);
    c.ok(`Kyle records "${LOGO}" on video 2, Kim to put it on the intro card: "Recorded: ${LOGO}."`, r1.ok && r1.message === `Recorded: ${LOGO}.`, r1.message);
    c.ok("…the find-it task: OPEN, Kyle's, on video 2, signed by Kyle", ret?.status === "OPEN" && ret.assignedKey === "kyle" && ret.ownerId === kyleTm.id && ret.outputId === v2.outputId && ret.source === "manual");
    c.ok("…the work-from-it task: Kim's, BLOCKED naming the missing file, on video 2",
      int?.status === "BLOCKED" && int.assignedKey === "kim" && int.ownerId === kimTm.id && int.outputId === v2.outputId && int.blockedReason === `Waiting on ${LOGO}`, `${int?.status} ${int?.assignedKey} ${int?.blockedReason}`);
    const r2 = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: v2.outputId, slug: assetSlugFor(LOGO), need: LOGO, interpretation: { what: "Put the logo on the intro card", ownerKey: "kim" } });
    c.ok("the same words on the same video again: \"Already recorded.\", still two tasks", r2.ok && r2.message === "Already recorded." && (await assetTasks()).length === 2, r2.message);
    const r3 = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: null, slug: assetSlugFor(PLAT), need: PLAT, interpretation: null });
    const plat = (await assetTasks()).filter((x) => x.dedupeKey?.includes(assetSlugFor(PLAT)));
    c.ok("the plat for the whole job, nobody to work from it yet: ONE task (the find-it), on no single video",
      r3.ok && plat.length === 1 && plat[0].taskType === deps.RETRIEVAL_TASK && plat[0].outputId === null && plat[0].dedupeKey === `asset-dep:${job.id}:job:${assetSlugFor(PLAT)}`, `${r3.message} · ${plat.map((p) => p.dedupeKey).join(",")}`);
    const bad = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: null, slug: "hoa-map", need: "the HOA map", interpretation: { what: "Mark the common areas", ownerKey: "somebody" } });
    c.ok("NEW: a \"who\" outside INTERPRETER_KEYS is refused in words, and nothing is written (OLD wrote it — §A0)", !bad.ok && /Pick who works from the file/.test(bad.message) && (await assetTasks()).length === 3, bad.message);
    const blank = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: null, slug: "   ", need: "   " });
    c.ok("blank words are refused", !blank.ok && (await assetTasks()).length === 3, blank.message);
    const alien = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: "not-a-video-here", slug: "x-file", need: "the x file" });
    c.ok("a video from nowhere is refused (\"That video isn't on this job.\")", !alien.ok && /isn't on this job/.test(alien.message), alien.message);
  }

  c.head("§A5 · an editor, and a \"view as\" preview, calling the actions directly: refused, nothing written");
  {
    const before = JSON.stringify(await assetTasks());
    const retId = (await assetTasks()).find((x) => x.taskType === deps.RETRIEVAL_TASK)!.id;
    await as(kim);
    const kr = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: v1.outputId, slug: "brand-font", need: "the brand font" });
    const ka = await actions.attachAssetReferenceAction(retId, "https://www.dropbox.com/drill/kim.png");
    c.ok("Kim (EDITOR): \"Only the office can record…\" / \"Only the office can attach the file.\"",
      !kr.ok && kr.message === "Only the office can record what a job is waiting on." && !ka.ok && ka.message === "Only the office can attach the file.", `${kr.message} | ${ka.message}`);
    await as(jordan, kyle);
    const pr = await actions.recordAssetDependencyAction({ projectId: job.id, outputId: v1.outputId, slug: "brand-font", need: "the brand font" });
    const pa = await actions.attachAssetReferenceAction(retId, "https://www.dropbox.com/drill/preview.png");
    c.ok("Jordan previewing Kyle: both refused the same way (a preview is read-only)", !pr.ok && !pa.ok, `${pr.message} | ${pa.message}`);
    c.ok("…not one task changed", JSON.stringify(await assetTasks()) === before);
  }

  c.head("§A6 · the card now lists what is waiting, each with its video; the editor's brief carries the sentence");
  {
    const jo = await cardOf(jordan);
    const open = jo.props?.open ?? [];
    c.ok("two open rows, both find-it rows (the blocked work-from-it task is said by its find-it row)", open.length === 2 && open.every((d) => d.stage === "retrieval"), open.map((d) => d.stage).join(","));
    c.ok(`"Waiting on ${LOGO} (Kyle to find it)" — for Video 2`, open.some((d) => d.sentence === `Waiting on ${LOGO} (Kyle to find it)` && d.scope === `Video 2: ${v2.label}`), JSON.stringify(open[0]));
    c.ok(`"Waiting on ${PLAT} (Kyle to find it)" — for the whole job`, open.some((d) => d.sentence === `Waiting on ${PLAT} (Kyle to find it)` && d.scope === "The whole job"));
    const out = child([{ name: "two", file: CARD, exp: "AssetDependencyCard", props: { ...cardBase, open, readFailed: false } }]);
    const html = String(out.two);
    const t = text(html);
    c.ok("rendered: \"Waiting on a file\", both sentences with their video, an attach field on each", /^<section[^>]*data-asset-deps="2"/.test(html) && /Waiting on a file/.test(t) && t.includes(`Waiting on ${LOGO} (Kyle to find it) Video 2: ${v2.label}`) && t.includes(`Waiting on ${PLAT} (Kyle to find it) The whole job`) && (html.match(/placeholder="Dropbox link or file path"/g) ?? []).length === 2 && (t.match(/Attach the file/g) ?? []).length === 2, t.slice(0, 300));
    c.ok("…and \"Record another\" stays folded underneath", /<details[^>]*><summary[^>]*>Record another file this job is waiting on<\/summary>/.test(html));
    const { projectBrief } = await import("@/lib/projectBrief");
    const brief = await projectBrief(job.id);
    const forV2 = deps.dependenciesForOutput(brief?.assetNeeds ?? [], v2.outputId).map((d) => d.sentence);
    const forV1 = deps.dependenciesForOutput(brief?.assetNeeds ?? [], v1.outputId).map((d) => d.sentence);
    c.ok("the editor's brief (projectBrief): video 2 carries the logo and the plat; video 1 only the job-wide plat", forV2.length === 2 && forV1.length === 1 && forV1[0].includes("plat"), `${forV2.join(" | ")} // ${forV1.join(" | ")}`);
  }

  c.head("§A7 · attaching the file closes the finding only, and releases the work-from-it task");
  {
    await as(kyle);
    const logoRet = (await assetTasks()).find((x) => x.taskType === deps.RETRIEVAL_TASK && x.outputId === v2.outputId)!;
    const LINK = "https://www.dropbox.com/scl/fi/drill/remainders-logo.png";
    const empty = await actions.attachAssetReferenceAction(logoRet.id, "   ");
    c.ok("an empty link is refused (\"Paste the link or path to the file.\")", !empty.ok && /Paste the link/.test(empty.message), empty.message);
    const r = await actions.attachAssetReferenceAction(logoRet.id, LINK);
    const t = await assetTasks();
    const ret = t.find((x) => x.id === logoRet.id);
    const int = t.find((x) => x.taskType === deps.INTERPRETATION_TASK);
    const plat = t.find((x) => x.dedupeKey?.includes(assetSlugFor(PLAT)));
    c.ok("\"Attached — the next step can start from it.\" — the find-it task COMPLETED, the link kept", r.ok && r.message === "Attached — the next step can start from it." && ret?.status === "COMPLETED" && ret.sourceDetail === LINK, r.message);
    c.ok("…Kim's work-from-it task is OPEN now — released, NOT closed — and carries the file", int?.status === "OPEN" && int.blockedReason === null && int.sourceDetail === LINK);
    c.ok("…the plat is untouched (still waiting)", plat?.status === "OPEN");
    const again = await actions.attachAssetReferenceAction(logoRet.id, "https://www.dropbox.com/drill/other.png");
    c.ok("a second press: \"Already attached.\", the first link kept", again.ok && again.message === "Already attached." && (await prisma.smartTask.findUnique({ where: { id: logoRet.id } }))?.sourceDetail === LINK);
    const notOne = await actions.attachAssetReferenceAction(int!.id, LINK);
    c.ok("attaching to a work-from-it task is refused (\"That isn't a file to find.\")", !notOne.ok && /isn't a file to find/.test(notOne.message), notOne.message);
    const jo = await cardOf(jordan);
    const open = jo.props?.open ?? [];
    const intRow = open.find((d) => d.stage === "interpretation");
    c.ok("the card now shows Kim's work from the attached file — on video 2 — and the plat still to find",
      open.length === 2 && !!intRow && intRow.sentence === "Put the logo on the intro card (Kim) — from the attached file only" && intRow.scope === `Video 2: ${v2.label}` && open.some((d) => d.stage === "retrieval" && d.sentence.includes("plat")), JSON.stringify(open.map((d) => d.sentence)));
    const out = child([{ name: "after", file: CARD, exp: "AssetDependencyCard", props: { ...cardBase, open, readFailed: false } }]);
    const at = text(String(out.after));
    c.ok("rendered: the work-from-it row has no attach field (only the plat's does)", (at.match(/Attach the file/g) ?? []).length === 1 && at.includes("Put the logo on the intro card (Kim) — from the attached file only"), at.slice(0, 300));
  }

  c.head("§A8 · nothing client-facing");
  c.ok("no text queued, no bell about a file", (await prisma.pendingSms.count()) === 0 && (await prisma.notification.count({ where: { OR: [{ title: { contains: "logo" } }, { title: { contains: "plat" } }] } })) === 0);

  // =========================================================================
  // §B · A19: EVERY FREE START IS OFFERED
  // =========================================================================
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  const acc = ARYEO_CONTENT_PRODUCTS.Accelerator.productId;
  // 14 starts a day: 9:00 AM to 3:30 PM ET, every half hour.
  const HOURS14 = Array.from({ length: 14 }, (_, i) => 9 + i / 2);
  fake = createFakeAryeo({
    products: { [acc]: [DRILL_TEAM.james.tm], [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm], [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm] },
    hours: HOURS14,
    defaultCustomerEmail: "info@realtourpilot.com",
  });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
  await prisma.teamMember.create({ data: { name: DRILL_TEAM.james.name, email: "james-aryeo@drill.invalid", aryeoTeamMemberId: DRILL_TEAM.james.tm, aryeoUserId: DRILL_TEAM.james.user, isServiceProvider: true } });
  const portal = await import("@/lib/portal");
  const oldPortal = (await import(baseline("src/lib/portal.ts"))) as typeof portal;
  const clearSlotCache = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: "portal-aryeo-slots:" } } });
  const SCHED = path.join(REPO, "src/components/portal/PortalScheduler.tsx");

  c.head(`§B0 · OLD (${BASE}): ten starts a day, whatever Aryeo said`);
  const wed = "2026-10-28";
  const wedStarts = HOURS14.map((h) => iso(et(10, 28, Math.floor(h), (h % 1) * 60)));
  {
    await clearSlotCache();
    const old = await oldPortal.programSlotDays({ package: "Accelerator" });
    const d = old.find((x) => x.date === wed);
    c.ok("OLD: Aryeo had 14 free starts on Wed Oct 28; the client was offered 10", d?.slots.length === 10, `${d?.slots.length}`);
    c.ok("…9:00 AM to 1:30 PM — 2:00, 2:30, 3:00 and 3:30 PM were never offered", d?.slots[9] === iso(et(10, 28, 13, 30)) && !d.slots.includes(iso(et(10, 28, 14))) && !d.slots.includes(iso(et(10, 28, 15, 30))), d?.slots.slice(-2).join(", "));
    c.ok("…on EVERY day", old.length > 0 && old.every((x) => x.slots.length <= 10), old.map((x) => x.slots.length).join(","));
  }

  c.head("§B1 · NEW: a day with 14 free starts offers 14");
  {
    await clearSlotCache();
    const now = await portal.programSlotDays({ package: "Accelerator" });
    const d = now.find((x) => x.date === wed);
    c.ok("Wed Oct 28: 14 starts, 9:00 AM through 3:30 PM — exactly Aryeo's", d?.slots.length === 14 && JSON.stringify(d.slots) === JSON.stringify(wedStarts), `${d?.slots.length}: ${d?.slots[0]} … ${d?.slots[13]}`);
    c.ok("…every day of the window offers all 14", now.length > 0 && now.every((x) => x.slots.length === 14), now.map((x) => x.slots.length).join(","));
    c.ok("…each start still names who films it (James), so the adapter can tie it to a person", !!d && d.slots.every((s) => d.slotCreatives?.[s]?.[0]?.teamMemberId === DRILL_TEAM.james.tm));
    const reads = fake.reads.length;
    const cached = await portal.programSlotDays({ package: "Accelerator" });
    c.ok("served from the cache row: still 14, no new Aryeo read", fake.reads.length === reads && cached.find((x) => x.date === wed)?.slots.length === 14);
    const gated = await portal.programSlotDays({ package: "Accelerator", from: et(10, 28, 14, 30) });
    const g = gated.find((x) => x.date === wed);
    c.ok("a session gated to 2:30 PM that day gets 2:30, 3:00 and 3:30 (the cap and the gate no longer fight)", g?.slots.length === 3 && g.slots[0] === iso(et(10, 28, 14, 30)), g?.slots.join(", "));
    const src = fs.readFileSync(path.join(REPO, "src/lib/portal.ts"), "utf8").replace(/\/\/.*$/gm, "");
    c.ok("portal.ts slices no day's starts any more", !/slots[^;\n]*\.slice\(0,\s*10\)/.test(src));
  }

  c.head("§B2 · end to end: portalSessionSlots gives the client all 14");
  {
    const f = await buildContentMonth(db, { name: "Remainders Slots TEST", package: "Accelerator", monthKey: "2026-10", project: false, owner: { email: "remainders-slots@realtourpilot.com" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: f.monthId, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 19, 13, 30), scheduledEnd: et(10, 19, 14), transcriptState: "ANALYZED" } });
    await prisma.programSessionPlan.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, sessionIndex: 1,
        streetNumber: "117", streetName: "Kyle Lane", city: "West Chester", stateCode: "PA", postalCode: "19382",
        latitude: 39.9607, longitude: -75.6055, geocodeSource: "drill", addressValidatedAt: new Date(), addressVersion: 1, lastStep: "ADDRESS",
      },
    });
    const pa = await import("@/app/portal/actions");
    const r = await pa.portalSessionSlots({ token: f.portalToken }, f.monthId, 1, {});
    const d = r.days.find((x) => x.date === wed);
    c.ok("the client's own calendar: Wed Oct 28 offers all 14 starts, each with its drive checked", r.ok && d?.slots.length === 14 && d.slots.every((s) => d.slotTravel[s] === "HUB_DRIVE"), `${r.ok} ${d?.slots.length} ${r.message}`);
    // The clock runs forward from 10:00, so the 24-hour floor lands a moment
    // after Tue 10:00 AM and that start is (rightly) a phone call.
    const tue = r.days[0];
    c.ok("…tomorrow (Tue Oct 27): every start from the next-day floor through 3:30 PM — the afternoon kept, nothing before the floor",
      tue?.date === "2026-10-27" && tue.slots.length >= 11 && tue.slots[tue.slots.length - 1] === iso(et(10, 27, 15, 30)) && tue.slots.every((s) => new RealDate(s).getTime() >= et(10, 27, 10).getTime()),
      `${tue?.date} ${tue?.slots.length}: ${tue?.slots[0]} … ${tue?.slots[tue.slots.length - 1]}`);
  }

  c.head("§B3 · the picker lays out a 16-start day cleanly at phone width");
  {
    const sixteen = Array.from({ length: 16 }, (_, i) => iso(et(10, 28, 9 + Math.floor(i / 2), (i % 2) * 30)));
    const day16 = {
      date: wed, slots: sixteen, fitsMinutes: 240, creatives: ["James Drill"],
      slotCreatives: Object.fromEntries(sixteen.map((s) => [s, [{ teamMemberId: "t1", name: "Christopherson Longname" }]])),
      slotTravel: Object.fromEntries(sixteen.map((s, i) => [s, i === 15 ? "UNCHECKED" : "HUB_DRIVE"])),
      slotCreativeTravel: {},
    };
    const day6 = { ...day16, slots: sixteen.slice(0, 6) };
    const out = child([
      { name: "d16", file: SCHED, exp: "SlotTimes", props: { day: day16, slot: sixteen[10], tz: "America/New_York", onPick: null } },
      { name: "d6", file: SCHED, exp: "SlotTimes", props: { day: day6, slot: null, tz: "America/New_York", onPick: null } },
    ]);
    const h16 = String(out.d16);
    const t16 = text(h16);
    const buttons = h16.match(/<button[^>]*>/g) ?? [];
    c.ok("16 starts → 16 chips, 9:00 AM through 4:30 PM", buttons.length === 16 && /9:00\sAM/.test(t16) && /4:30\sPM/.test(t16), `${buttons.length} · ${t16.slice(0, 80)}`);
    c.ok("…split \"Morning\" (6) and \"Afternoon\" (10), each a three-column grid that wraps DOWN (four from 640px)",
      /Morning.*Afternoon/.test(t16) && (h16.match(/class="grid grid-cols-3 gap-2 sm:grid-cols-4"/g) ?? []).length === 2 && (h16.split("Afternoon")[0].match(/<button/g) ?? []).length === 6, t16.slice(0, 60));
    c.ok("…every chip may shrink (min-w-0), a long name truncates instead of widening its column", buttons.every((b) => /min-w-0/.test(b)) && /class="block truncate text-\[10px\][^"]*">Christopherson</.test(h16));
    c.ok("…nothing in it has a fixed width, refuses to wrap, or scrolls sideways", !/w-\[|min-w-\[|whitespace-nowrap|overflow-x|flex-nowrap/.test(h16));
    c.ok("…the picked start is marked, and \"Kyle confirms\" rides on the one unchecked start", /border-brand bg-brand-soft/.test(buttons[10] ?? "") && (t16.match(/Kyle confirms/g) ?? []).length === 1);
    const h6 = String(out.d6);
    c.ok("a 6-start day: one plain grid, no morning/afternoon labels", (h6.match(/<button/g) ?? []).length === 6 && !/Morning|Afternoon/.test(h6) && (h6.match(/grid-cols-3/g) ?? []).length === 1);
    const sched = fs.readFileSync(SCHED, "utf8");
    // Oct 5 2026: the call also passes disabled={busy} now — the times stand
    // still while the booking request is in flight (the scheduler's own
    // useTransition), so a second tap cannot ask for a second slot. Still the
    // ONE way the day is drawn.
    c.ok("PortalScheduler draws the day through SlotTimes (held while a request is in flight)",
      /<SlotTimes day=\{activeDay\} slot=\{slot\} tz=\{tz\} onPick=\{pickSlot\} disabled=\{busy\} \/>/.test(sched) && (sched.match(/<SlotTimes /g) ?? []).length === 1);
  }

  // =========================================================================
  // §C · 7.3: THE UPLOAD PORTAL PRINTS THE TRACKER'S WORDS
  // =========================================================================
  const ladder = await import("@/lib/handoffLadder");
  const PORTAL = path.join(REPO, "src/components/upload/UploadPortal.tsx");
  // OLD evidenceText, lifted out of 0950c1c's portal and run as it was.
  const oldEvidenceText = (() => {
    const src = show("src/components/upload/UploadPortal.tsx");
    const start = src.indexOf("function evidenceText(");
    const end = src.indexOf("\n}\n", start) + 3;
    const esbuild = (Module.createRequire(__filename))("esbuild") as { transformSync: (c: string, o: { loader: string }) => { code: string } };
    const js = esbuild.transformSync(src.slice(start, end), { loader: "ts" }).code;
    return new Function("etDateTime", `${js}\nreturn evidenceText;`)(etDateTime) as (e: unknown, halfAt: unknown) => string;
  })();
  const blob = (rawPhotos: number, rawVideo: number, o: { stale?: boolean } = {}) =>
    JSON.stringify({ expected: ["VIDEO"], present: [], missing: ["VIDEO"], dropbox: { rawPhotos, rawVideo, finalPhotos: 0, finalVideo: 0, at: new Date().toISOString(), ...(o.stale ? { stale: true } : {}) } });
  const tPh = et(10, 24, 19, 40);
  const tVi = et(10, 25, 8, 5);
  let n = 0;
  const shoot = async (street: string, extra: Record<string, unknown>, ticked = true) =>
    (await prisma.project.create({
      data: {
        title: `${street}, Emmaus, PA`, addressLine: street, clientId: client.id, status: "SHOT", shootDate: et(10, 24, 10), photographerId: harrisonTm.id, aryeoOrderId: `drill-fr-c${++n}`,
        deliverables: {
          create: [
            { type: "PHOTOS", label: "Photos", quantity: 1, uploadedAt: ticked ? tPh : null, status: ticked ? "UPLOADED" : "PENDING" },
            { type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, uploadedAt: ticked ? tVi : null, status: ticked ? "UPLOADED" : "PENDING" },
          ],
        },
        ...extra,
      },
      select: { id: true },
    })).id;
  type PortalProps = { evidence: import("@/lib/handoff").EvidenceView[]; project: { photosHandoffAt: string | null; videoHandoffAt: string | null } };
  const portalOf = async (id: string): Promise<PortalProps> => {
    await establishSession(harrison.id);
    const tree = await UploadPage({ params: Promise.resolve({ id }) });
    const found = find(tree, "UploadPortal");
    if (found.length !== 1) throw new Error(`expected one UploadPortal on /upload/${id}, found ${found.length}`);
    return found[0].props as PortalProps;
  };

  const cases: { key: string; label: string; id: string }[] = [];
  cases.push({ key: "tick", label: "tick only (nobody has read the folder)", id: await shoot("1 Tick Ln", {}) });
  cases.push({ key: "found", label: "files found on a fresh read", id: await shoot("2 Found Ln", { statusEvidence: blob(40, 12) }) });
  cases.push({ key: "stale", label: "a stale zero (the read failed; carried forward)", id: await shoot("3 Stale Ln", { statusEvidence: blob(0, 0, { stale: true }), handoffBlockedReason: "Waiting on the wrap-up on the upload page from Harrison Drill." }) });
  cases.push({ key: "empty", label: "a fresh read that found nothing", id: await shoot("4 Empty Ln", { statusEvidence: blob(0, 0) }) });
  cases.push({ key: "staleSeen", label: "a stale read that HAD seen files", id: await shoot("5 Seen Ln", { statusEvidence: blob(40, 12, { stale: true }) }) });
  const handedId = await shoot("6 Handed Ln", { status: "EDITING", statusEvidence: blob(212, 6), photosHandoffAt: et(10, 24, 19, 45), videoHandoffAt: et(10, 25, 8, 10), handoffReadyAt: et(10, 25, 8, 10) });
  cases.push({ key: "handed", label: "handed off, ready, editing started, one cut in", id: handedId });
  {
    const reel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: handedId, type: "SOCIAL_REEL" }, select: { id: true } });
    const started = et(10, 26, 9, 30);
    await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: handedId, state: "ACTIVE", activeFor: "kim", firstStartedAt: started, activeSince: started, lastEventAt: started } });
    await prisma.reviewSubmission.create({ data: { projectId: handedId, deliverableId: reel.id, slot: 1, round: 1, status: "PENDING", source: "upload" } });
  }

  c.head(`§C0 · OLD (${BASE}): the portal had its own words for the files`);
  const oldPortalSrc = show("src/components/upload/UploadPortal.tsx");
  // Code only: the new doc comment quotes the old words to say they are gone.
  const newPortalSrc = fs.readFileSync(PORTAL, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  c.ok("OLD UploadPortal printed its own evidenceText (\"ticked uploaded\", \"Dropbox shows N files\")", /ticked uploaded/.test(oldPortalSrc) && /Dropbox shows/.test(oldPortalSrc));
  c.ok("NEW: those words are gone; the portal draws lib/handoff's ladderRows through the tracker's EvidenceLadder",
    !/ticked uploaded|Dropbox shows|function evidenceText/.test(newPortalSrc) && /ladderRows\(evidence\.map\(\(v\) => evidenceFromView\(/.test(newPortalSrc) && /import \{ EvidenceLadder \} from "@\/components\/editing\/EditTracker"/.test(newPortalSrc));
  const uploadSrc = fs.readFileSync(path.join(REPO, "src/app/upload/[id]/page.tsx"), "utf8");
  c.ok("the upload page reads the tracker's own reader (handoffLadderFor), the pure reader only as its fallback", /m\.handoffLadderFor\(project\.id\)/.test(uploadSrc) && /\.map\(evidenceView\)/.test(uploadSrc));

  c.head("§C1 · the portal prints the tracker's words, rung for rung — never \"files found\" on a tick alone");
  {
    const views: Record<string, PortalProps> = {};
    const rows: Record<string, import("@/lib/handoff").LadderRow[]> = {};
    for (const k of cases) {
      views[k.key] = await portalOf(k.id);
      rows[k.key] = await ladder.handoffLadderRows(k.id);
    }
    const halfAtOf = (p: PortalProps) => ({ photos: p.project.photosHandoffAt, video: p.project.videoHandoffAt });
    const out = child([
      ...cases.map((k) => ({ name: k.key, file: PORTAL, exp: "PortalEvidence", props: { evidence: views[k.key].evidence, halfAt: halfAtOf(views[k.key]) } })),
      // The photographer just submitted the VIDEO half on this page: it says so before any reload.
      { name: "justSubmitted", file: PORTAL, exp: "PortalEvidence", props: { evidence: views.tick.evidence, halfAt: { photos: null, video: et(10, 26, 9, 55).toISOString() } } },
    ]);
    for (const k of cases) {
      const html = String(out[k.key]);
      const tr = rows[k.key];
      const same = tr.length === 2 && tr.every((r) => ladderText(html, r.category).startsWith(r.line));
      c.ok(`${k.label}: portal = tracker, both halves`, same, `${ladderText(html, "video")}  ‖  tracker: ${tr.find((r) => r.category === "video")?.line}`);
    }
    const said = (k: string, cat: string) => ladderText(String(out[k]), cat);
    c.ok("tick only: \"upload reported … · Dropbox not confirmed · not handed off yet\" — no \"files found\"",
      /^Video: upload reported .+ · Dropbox not confirmed · not handed off yet$/.test(said("tick", "video")) && !/files found/.test(String(out.tick)), said("tick", "video"));
    c.ok("files seen on a fresh read: \"files found in Dropbox (12)\" / \"(40)\"", /files found in Dropbox \(12\)/.test(said("found", "video")) && /files found in Dropbox \(40\)/.test(said("found", "photos")));
    c.ok("a stale zero: \"Dropbox not confirmed\" — never \"no files found\", never \"found\"; the blocker's sentence rides under it",
      /Dropbox not confirmed/.test(said("stale", "video")) && !/no files found|files found/.test(said("stale", "video")) && /not ready to edit Waiting on the wrap-up on the upload page from Harrison Drill\./.test(said("stale", "video")), said("stale", "video"));
    c.ok("a fresh empty read: \"no files found in Dropbox\"", /no files found in Dropbox/.test(said("empty", "video")));
    c.ok("a stale read that HAD seen files keeps the sighting (lib/handoff: a stale count > 0 is still real): \"files found in Dropbox (12)\"", /files found in Dropbox \(12\)/.test(said("staleSeen", "video")));
    c.ok("handed off: all six rungs — reported, found (6), handed off, ready to edit, editing started, 1 cut handed in",
      /^Video: upload reported .+ · files found in Dropbox \(6\) · handed off .+ · ready to edit · editing started .+ · 1 cut handed in$/.test(said("handed", "video")), said("handed", "video"));
    c.ok("…each time in Eastern, as the tracker prints it", said("handed", "video").includes(`handed off ${etDateTime(et(10, 25, 8, 10))}`) && said("handed", "video").includes(`editing started ${etDateTime(et(10, 26, 9, 30))}`));
    const js = said("justSubmitted", "video");
    c.ok("the portal's own submit shows at once: video \"handed off 9:55\", photos still \"not handed off yet\"",
      js.includes(`handed off ${etDateTime(et(10, 26, 9, 55))}`) && /not handed off yet/.test(said("justSubmitted", "photos")), js);
    c.ok("the portal's rows keep the tone the tracker gives them (the \"not confirmed\" rung reads muted, the empty folder amber)",
      /<span class="italic text-muted"[^>]*>Dropbox not confirmed<\/span>/.test(String(out.stale)) && /<span class="text-warning"[^>]*>no files found in Dropbox<\/span>/.test(String(out.empty)));
    const oldTick = oldEvidenceText(views.tick.evidence.find((e) => e.category === "video"), halfAtOf(views.tick));
    const oldFound = oldEvidenceText(views.found.evidence.find((e) => e.category === "video"), halfAtOf(views.found));
    c.ok(`OLD words on the same rows: "${oldTick.slice(0, 48)}…", "${oldFound.split("·")[1]?.trim()}" — neither what the tracker says`,
      /ticked uploaded/.test(oldTick) && /Dropbox shows 12 files/.test(oldFound) && oldTick !== rows.tick.find((r) => r.category === "video")?.line, `${oldTick} | ${oldFound}`);
  }

  // =========================================================================
  // §D · THE ZONE OF EACH TIME'S OWN DATE
  // =========================================================================
  c.head("§D · each time on the scheduler carries its own date's zone");
  {
    const ET = "America/New_York";
    const NOV = et(11, 20, 10).toISOString(); // Fri Nov 20, 10:00 AM EST
    const SEP = et(9, 30, 10).toISOString(); // Wed Sep 30, 10:00 AM EDT
    const month = {
      monthId: "m-fr", monthKey: "2026-11", locked: false, reason: "", earliestISO: null,
      callStatus: "SCHEDULED", callAtISO: et(11, 5, 14).toISOString(), planningMode: "CALL",
      capacity: { allowed: 2, used: 2, remaining: 0 },
      requests: [
        { id: "r-nov", status: "REQUESTED", bookingState: "NONE", creativeName: "James Drill", canChange: false, label: "Requested, awaiting confirmation", slotStartISO: NOV, slotEndISO: null, locationText: null, notes: null, createdAtISO: new RealDate(PINNED).toISOString() },
        { id: "r-sep", status: "REQUESTED", bookingState: "NONE", creativeName: null, canChange: false, label: "Requested, awaiting confirmation", slotStartISO: SEP, slotEndISO: null, locationText: null, notes: null, createdAtISO: new RealDate(PINNED).toISOString() },
      ],
      bookedShootISO: null,
      sessions: [{ key: "s1", sessionIndex: 1, startISO: et(11, 24, 10).toISOString(), state: "BOOKED", label: "Booked", area: null, addressNeeded: false, addressNote: null }],
      sessionsRequired: 2, sessionsMissing: 1, bookingMode: "DESK", sessionIndex: 2, sessionGates: [], takenIndexes: [1], deferredAtISO: null,
    };
    const OLD_SCHED = baseline("src/components/portal/PortalScheduler.tsx", true);
    const props = { months: [month], bookingUrl: "#", readOnly: true, timezone: ET };
    const out = child([
      { name: "nov", file: SCHED, exp: "whenWithZone", args: [NOV, ET] },
      { name: "sep", file: SCHED, exp: "whenWithZone", args: [SEP, ET] },
      { name: "la", file: SCHED, exp: "whenWithZone", args: [NOV, "America/Los_Angeles"] },
      { name: "prep", file: SCHED, exp: "preparationLine", args: [{ earliestISO: et(11, 25, 14, 30).toISOString(), windowHours: 72, after: "CALL" }, ET] },
      { name: "newCard", file: SCHED, exp: "PortalScheduler", props },
      { name: "oldCard", file: OLD_SCHED, exp: "PortalScheduler", props },
    ]);
    c.ok("a November time reads EST: \"Friday, November 20 … 10:00 AM EST\" (the child's clock says Oct 26, EDT)", /^Friday, November 20.*10:00\sAM EST$/.test(String(out.nov)), String(out.nov));
    c.ok("a September time reads EDT: \"Wednesday, September 30 … 10:00 AM EDT\"", /^Wednesday, September 30.*10:00\sAM EDT$/.test(String(out.sep)), String(out.sep));
    c.ok("the client's own zone: 7:00 AM PST in Los Angeles", /7:00\sAM PST$/.test(String(out.la)), String(out.la));
    c.ok("the 72-hour line still reads its day's zone (\"…2:30 PM EST.\")", /2:30\sPM EST\.$/.test(String(out.prep)), String(out.prep));
    const nt = text(String(out.newCard));
    const ot = text(String(out.oldCard));
    c.ok("NEW card: the November call, the November request and the November session all say EST; the September request EDT",
      /Strategy call booked for Thursday, November 5.*2:00\sPM EST/.test(nt) && /November 20.*10:00\sAM EST/.test(nt) && /September 30.*10:00\sAM EDT/.test(nt) && /November 24.*10:00\sAM EST/.test(nt) && !/November \d+[^·]*EDT/.test(nt), nt.slice(0, 400));
    c.ok("OLD card (0950c1c) on the same month: every one said today's EDT — the November times an hour wrong",
      /November 20.*10:00\sAM EDT/.test(ot) && /November 24.*10:00\sAM EDT/.test(ot) && /Strategy call booked for Thursday, November 5.*2:00\sPM EDT/.test(ot) && !/EST/.test(ot), ot.slice(0, 400));
    const sched = fs.readFileSync(SCHED, "utf8");
    c.ok("the today's-zone helper is gone from PortalScheduler", !/const tzName|tzName\(/.test(sched));
    // The same bug lived in three more portal files (found by this build, fixed
    // Sep 28): the Home and Schedule tabs labelled every time with tzShort(tz)
    // — today's zone — and the call picker said "Times in EDT" for a November
    // week. Each now asks the zone of the time it prints.
    const readSrc = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    const tabs = ["src/components/portal/tabs/HomeTab.tsx", "src/components/portal/tabs/ScheduleTab.tsx"].map((f) => [f, readSrc(f)] as const);
    c.ok("Home and Schedule tabs: no label from today's zone; every time asks its own (zoneOf(iso))",
      tabs.every(([, src]) => !/tzShort\(tz\)/.test(src) && !/\{tzName\}/.test(src) && /zoneOf\(/.test(src)), tabs.map(([f]) => path.basename(f)).join(", "));
    const picker = readSrc("src/components/portal/PortalCallPicker.tsx");
    c.ok("the call picker's \"Times in …\" comes from the times on the page, not new Date()",
      /page\.slots\.map\(\(s\) => new Date\(s\.startISO\)\)/.test(picker) && !/new Date\(\)\.toLocaleTimeString\("en-US", \{ timeZone: tz, timeZoneName/.test(picker));
    const { tzShort } = await import("@/components/portal/ui");
    c.ok("tzShort with the time's own date: Nov 20 reads EST and Sep 30 EDT (America/New_York)",
      tzShort("America/New_York", new Date("2026-11-20T15:00:00Z")) === "EST" && tzShort("America/New_York", new Date("2026-09-30T14:00:00Z")) === "EDT");
  }

  // =========================================================================
  c.head("§E · fences");
  // =========================================================================
  c.ok("no Aryeo write (the slot reads are GETs to the fake)", fake.writes.length === 0, `${fake.writes.length} writes`);
  c.ok("the model was never called", aiCalls === 0);
  c.ok("nothing left the machine: every outbound call was a fake or blocked, and none was Aryeo or OSRM", fence.blocked.every((u) => !/aryeo|osrm/.test(u)), fence.blocked.slice(0, 5).join(" · "));

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
