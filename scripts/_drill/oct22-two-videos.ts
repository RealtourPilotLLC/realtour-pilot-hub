// ---------------------------------------------------------------------------
// DRILL: TWO VIDEOS ON ONE ORDER ARE TWO VIDEOS (Oct 22 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-two-videos.ts
//
// Jordan: "Joe's appointment yesterday had two videos. A standard highlight
// reel, and a Premium reel. Fix that. Add two videos to the brief, and a
// separate instructions area for the upload portal so instructions can be
// added for both videos, and make sure that doesn't happen again."
// (Corrected: the premium reel was set up; the standard highlight reel was not.)
//
// 538 Onward Ave's Aryeo order #1709 sells "Social Influencer" (its reel is the
// premium reel) and "Standard Video Highlight Reel" on its own line. Both map
// to SOCIAL_REEL and the order mapping kept one row per type, so the standard
// reel was dropped in silence.
//
// Isolated PGlite; nothing leaves the process.
//   1. The mapping: a standard reel plus a premium reel are two video rows with
//      the right tiers; a quantity of 2 is two videos; add-ons and upgrades
//      still ride along; a one-video order maps exactly as before.
//   2. The reconcile on a job like Joe's: the premium row (and the cut already
//      on it) stays, the standard reel is set up with its own slot and its own
//      (earlier) due date; running it again changes nothing.
//   3. The brief: two sections, each with its own tier, due date and
//      instructions; video 2 never shows video 1's words as its own.
//   4. The upload portal: two instruction areas; the submit asks for and saves
//      each; a one-video job's page is unchanged.
//   5. KPI and the morning-after nudge: a missing second set is incomplete; a
//      video the hub set up after the handoff is not the photographer's miss.
//   6. The guard: "2 videos ordered, 1 set up" on the job and the Shoots board.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6861);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));

// ---- the clock: Fri Oct 23 2026, 4:00 PM ET ----------------------------------------
const RealDate = Date;
const NOW_ISO = "2026-10-23T20:00:00.000Z";
const SIM = RealDate.parse(NOW_ISO);
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

// ---- modules that cannot load under the react-server build -------------------------
// The upload page's element tree is walked, not rendered: the portal is a named
// stand-in carrying the props the page hands it. The REAL portal is rendered in
// a child process below.
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
const fence = fenceFetch();

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
const find = (tree: any, pred: (e: El) => boolean) => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
/** What a node prints, as one line (JSX children joined as rendered). */
const said = (n: any) => words(n).join("").replace(/\s+/g, " ").trim();
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isEl(n)) words(n.props.children, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- rendering the real portal (a child process, no react-server condition) ------
const CACHE = path.join(REPO, "node_modules/.cache", "oct22-two-videos");
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function render(cases: { name: string; props: Record<string, unknown> }[]): Record<string, string> {
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
for (const f of ["src/app/upload/actions.ts", "src/app/upload/draftActions.ts", "src/app/upload/sharedActions.ts", "src/app/shoot/actions.ts", "src/app/editing/actions.ts"]) put(path.join(root, f), actions());
`);
  const runner = path.join(CACHE, "render.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const RealDate = Date;
const NOW = RealDate.parse(process.env.TV_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const cases = JSON.parse(require("fs").readFileSync(process.env.TV_CASES as string, "utf8"));
const out: Record<string, string> = {};
for (const c of cases) {
  try { out[c.name] = renderToStaticMarkup(createElement(require(${JSON.stringify(path.join(REPO, "src/components/upload/UploadPortal.tsx"))}).UploadPortal, c.props)); }
  catch (e) { out[c.name] = "RENDER_ERROR: " + (e as Error).message; }
}
process.stdout.write("\\n@@TV@@" + JSON.stringify(out));
`);
  const casesFile = path.join(CACHE, `cases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  try {
    const res = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [runner], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "scripts/_drill/_client-drill-preload.cjs"))} --require ${JSON.stringify(seed)}`,
        TV_NOW: NOW_ISO, TV_CASES: casesFile,
      },
    });
    const at = res.lastIndexOf("@@TV@@");
    return at >= 0 ? (JSON.parse(res.slice(at + 6)) as Record<string, string>) : {};
  } finally {
    fs.rmSync(casesFile, { force: true });
  }
}
// Oct 23 2026 (the upload-page revamp): server-rendered slots do not cross
// the JSON hop either, and the video areas show once Video is ticked under
// "What did you capture?", as the photographer does (here through their draft).
const portalProps = (p: Record<string, unknown>) => {
  const { foldersSlot: _s, onBriefNote: _a, slots: _l, ...rest } = p;
  void _s; void _a; void _l;
  const draft = rest.draft ?? { revision: 1, savedAtISO: NOW_ISO, payload: { editorBrief: "", checks: { coverage: false, culling: false, quality: false, count: false }, removal: "", nothingToRemove: false, orderChoice: null, orderNotes: "", vidStyle: null, vidSections: {}, videosFilmed: "", filmedTopicIds: [], topicNotes: {}, extraRows: [], scriptChoice: null, scriptText: "", scriptNote: "", captured: ["photos", "video"] } };
  return JSON.parse(JSON.stringify({ ...rest, foldersSlot: null, slots: {}, draft }));
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const aryeo = await import("@/lib/integrations/aryeo");
    const { cutSlots } = await import("@/lib/reviewCuts");
    const { videoTier } = await import("@/lib/projectStatus");
    const dout = await import("@/lib/deliverableOutputs");
    const pv = await import("@/lib/perVideoInstructions");
    const vs = await import("@/lib/videoSetup");
    const { establishSession } = await import("@/lib/auth/session");
    void os;

    // The products as Settings → Products has them in production (read Oct 22).
    const products: [string, string[], string, string | null, string][] = [
      ["Social Influencer", ["PHOTOS", "SOCIAL_REEL", "DRONE_PHOTO", "FLOORPLAN"], "premium", "premium_social_reel", "MAIN"],
      ["Standard Video Highlight Reel", ["SOCIAL_REEL", "DRONE_PHOTO"], "standard", "standard_reel", "MAIN"],
      ["Premium Social Media Reel - Most Popular", ["SOCIAL_REEL", "DRONE_VIDEO"], "premium", "premium_social_reel", "MAIN"],
      ["Photography and Standard Reel w/ Agent intro", ["PHOTOS", "SOCIAL_REEL"], "standard", "standard_reel_agent_intro", "MAIN"],
      ["Standard Cinematic Video", ["VIDEO"], "standard", "standard_cinematic", "MAIN"],
      ["Community Photography", ["PHOTOS"], "standard", null, "ADDON"],
      ["Video Starter - 2HR Session", ["VIDEO"], "personal_branding", "personal_branding", "MAIN"],
    ];
    for (const [i, [title, types, tier, style, type]] of products.entries()) {
      await prisma.product.create({ data: { aryeoId: `tv-p${i}`, title, type, mediaTypes: JSON.stringify(types), videoTier: tier, videoStyle: style, serviceKind: "service", videoQuantity: 1 } });
    }
    await aryeo.loadManualProductMap(true);
    const warn = console.warn; console.warn = () => {};
    const line = (title: string, quantity = 1, i = 0) => ({ id: `line-${title}-${i}`, title, quantity, amount: 10000, is_canceled: false }) as never;
    const JOE = [line("Community Photography"), line("Standard Video Highlight Reel"), line("Zillow Showcase 3D Tour Add-on"), line("Social Influencer")];

    // =====================================================================
    c.head("1 · The mapping: two video products are two videos");
    // =====================================================================
    const joe = aryeo.orderDeliverables(JOE);
    const reels = joe.filter((d) => d.type === "SOCIAL_REEL");
    c.ok("Joe's order: two SOCIAL_REEL rows, the premium reel first", reels.length === 2 && reels[0].productTitle === "Social Influencer" && reels[1].productTitle === "Standard Video Highlight Reel", reels.map((r) => r.label).join(" | "));
    c.ok("…with the right tiers: premium (Social Influencer) and standard (the highlight reel)", videoTier([reels[0]]) === "premium" && videoTier([reels[1]]) === "standard" && reels[0].videoStyle === "premium_social_reel" && reels[1].videoStyle === "standard_reel", `${videoTier([reels[0]])}/${videoTier([reels[1]])}`);
    c.ok("…and every other type still one row (one PHOTOS, one DRONE, one FLOORPLAN, one ZILLOW_3D)", ["PHOTOS", "DRONE", "FLOORPLAN", "ZILLOW_3D"].every((t) => joe.filter((d) => d.type === t).length === 1), joe.map((d) => d.type).join(","));
    c.ok("OLD (one row per type, no line told apart): the standard reel vanished", aryeo.dedupeParsedDeliverables(JOE.flatMap(aryeo.itemToDeliverables)).filter((d) => d.type === "SOCIAL_REEL").length === 1);
    const qty2 = aryeo.orderDeliverables([line("Standard Video Highlight Reel", 2)]);
    c.ok("a quantity of 2 on one line: one row owing 2 videos", qty2.length === 1 && qty2[0].quantity === 2 && aryeo.orderedVideoCount(qty2) === 2, JSON.stringify(qty2.map((d) => [d.type, d.quantity])));
    const mixed = aryeo.orderDeliverables([line("Social Influencer"), line("Standard Video Highlight Reel", 2)]);
    c.ok("premium reel + standard reel ×2: two rows, three videos", mixed.filter((d) => d.type === "SOCIAL_REEL").length === 2 && aryeo.orderedVideoCount(mixed) === 3, JSON.stringify(mixed.filter((d) => d.type === "SOCIAL_REEL").map((d) => [d.label, d.quantity])));
    const twoSame = aryeo.orderDeliverables([line("Standard Video Highlight Reel", 1, 1), line("Standard Video Highlight Reel", 1, 2)]);
    c.ok("the same reel on two lines (Kyle's extra-reel line) is two videos, where max() used to make one", twoSame.length === 2 && aryeo.orderedVideoCount(twoSame) === 2);
    const addon = aryeo.orderDeliverables([line("Photography and Standard Reel w/ Agent intro"), line("Agent Outro Add-on (Standard Reel)")]);
    c.ok("an add-on still rides along with its reel (one reel)", addon.filter((d) => d.type === "SOCIAL_REEL").length === 1, addon.map((d) => d.label).join(" | "));
    const agentCam = aryeo.orderDeliverables([line("Standard Video Highlight Reel"), line("Agent on Camera Intro")]);
    c.ok("an Agent on Camera Intro add-on upgrades the reel it was bought for, not a second reel", agentCam.filter((d) => d.type === "SOCIAL_REEL").length === 1 && agentCam.find((d) => d.type === "SOCIAL_REEL")?.videoStyle === "standard_reel_agent_intro");
    const upgrade = aryeo.orderDeliverables([line("The Silver Bundle - Photos and Reel"), line("Premium Social Media Video Upgrade")]);
    c.ok("an upgrade rides along too (one reel, now premium)", upgrade.filter((d) => d.type === "SOCIAL_REEL").length === 1 && aryeo.orderedVideoCount(upgrade) === 1, upgrade.map((d) => d.label).join(" | "));
    const single = [line("Community Photography"), line("Social Influencer"), line("Zillow Showcase 3D Tour Add-on")];
    c.ok("a one-video order maps exactly as before", JSON.stringify(aryeo.orderDeliverables(single)) === JSON.stringify(aryeo.dedupeParsedDeliverables(single.flatMap(aryeo.itemToDeliverables), ["Community Photography", "Social Influencer", "Zillow Showcase 3D Tour Add-on"])));
    const plan = aryeo.orderDeliverables([line("Video Starter - 2HR Session", 1, 1), line("Video Starter - 2HR Session", 1, 2)]);
    c.ok("a monthly plan's lines never split: its batch stays on one row", plan.filter((d) => d.type === "VIDEO").length === 1, JSON.stringify(plan.map((d) => [d.type, d.label, d.quantity])));
    const film = aryeo.orderDeliverables([line("Standard Cinematic Video"), line("Premium Social Media Reel - Most Popular")]);
    c.ok("a video plus a reel (two types) is still one row each", film.filter((d) => d.type === "VIDEO").length === 1 && film.filter((d) => d.type === "SOCIAL_REEL").length === 1);
    console.warn = warn;

    // =====================================================================
    c.head("2 · The reconcile on a job like Joe's");
    // =====================================================================
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-tv@drill.invalid", role: "PHOTOGRAPHER", active: true } });
    const harrison = await prisma.appUser.create({ data: { email: "harrison-tv@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    await prisma.appSetting.create({ data: { key: "upload-ack-harrison-tv@drill.invalid", value: "true" } });
    const owner = await prisma.appUser.create({ data: { email: "jordan-tv@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const client = await prisma.client.create({ data: { name: "Joe Drill" } });
    const SHOT = new RealDate("2026-10-21T12:00:00.000Z"); // Wed Oct 21, 8:00 AM ET
    const PREMIUM_WORDS = "STYLE: Fast-Paced\n\nCOLOR PROFILE: S-Log3, D-LogM\n\nVISION FOR THE EDIT\nFollow the script and the inspo clips, the Happy Gilmore drive is the hook and the town tour closes it.";
    const joeJob = async (street: string, opts: { videoInstructions?: string | null; handedInAt?: Date | null; dueOverrideAt?: Date | null } = {}) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Phoenixville, PA 19460`, addressLine: street, clientId: client.id, status: "SHOT", shootDate: SHOT,
          photographerId: harrisonTm.id, aryeoOrderId: `order-${street}`, reelScript: "Happy Gilmore: The First Drive", scriptConfirmedAt: SHOT, scriptConfirmNote: "Delivered as written",
          videoInstructions: opts.videoInstructions === undefined ? PREMIUM_WORDS : opts.videoInstructions,
          debriefSubmittedAt: opts.handedInAt ?? null, videoHandoffAt: opts.handedInAt ?? null, uploadedAt: opts.handedInAt ?? null,
          dueOverrideAt: opts.dueOverrideAt ?? null,
          deliverables: {
            create: [
              { type: "PHOTOS", label: "Photos", productTitle: "Social Influencer", status: "UPLOADED" },
              { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel", status: "UPLOADED" },
              { type: "ZILLOW_3D", label: "Zillow 3D Tour", productTitle: "Zillow Showcase 3D Tour Add-on", status: "DONE" },
              { type: "DRONE", label: "Drone Photos", productTitle: "Social Influencer", status: "UPLOADED" },
              { type: "FLOORPLAN", label: "Floor Plan", productTitle: "Social Influencer", status: "DONE" },
            ],
          },
          orderItems: { create: ["Community Photography", "Standard Video Highlight Reel", "Zillow Showcase 3D Tour Add-on", "Social Influencer"].map((t, i) => ({ aryeoId: `oi-${street}-${i}`, title: t, quantity: 1, amount: 100 })) },
        },
        select: { id: true },
      });
      await dout.ensureOutputsForProject(p.id);
      return p.id;
    };
    const job = await joeJob("538 Onward Ave");
    const premiumRow = await prisma.deliverable.findFirstOrThrow({ where: { projectId: job, type: "SOCIAL_REEL" } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: job, deliverableId: premiumRow.id, slot: 1, status: "PENDING", source: "upload", fileName: "premium v1.mp4" } });
    c.ok("the guard before: \"2 videos ordered, 1 set up\"", (await vs.videoSetupGapFor(job))?.words === "2 videos ordered, 1 set up", JSON.stringify(await vs.videoSetupGapFor(job)));
    const order = { id: `order-538 Onward Ave`, number: 1709, items: JOE } as never;
    console.warn = () => {};
    const res = await aryeo.reconcileDeliverablesToOrder(job, order);
    console.warn = warn;
    c.ok("the reconcile adds the standard reel and nothing else", res.added.length === 1 && res.added[0] === "Standard Video Highlight Reel" && res.retired.length === 0 && res.relabeled.length === 0, JSON.stringify(res));
    const reelRows = await prisma.deliverable.findMany({ where: { projectId: job, type: "SOCIAL_REEL", removedFromOrderAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    c.ok("the premium row keeps its id, label and style", reelRows[0]?.id === premiumRow.id && reelRows[0].label === "Social Influencer" && reelRows[0].videoStyle === "premium_social_reel");
    c.ok("the standard reel is its own row: standard style, its own product, not hand-made", reelRows.length === 2 && reelRows[1].videoStyle === "standard_reel" && reelRows[1].productTitle === "Standard Video Highlight Reel" && !reelRows[1].manual);
    c.ok("the cut already uploaded stays on the premium reel", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } })).deliverableId === premiumRow.id);
    const slots = await cutSlots(job);
    c.ok("two cut slots, each named for its own video", slots.length === 2 && slots[0].deliverableId === premiumRow.id && /Premium/i.test(slots[0].label) && slots[1].label === "Standard Reel", slots.map((s) => s.label).join(" | "));
    const outs = await dout.outputsForProject(job);
    c.ok("each video has its own video row", outs.length === 2 && outs.every((o) => o.state !== "removed"));
    const [o1, o2] = outs;
    c.ok("each its own due date: the standard reel on the 48-hour turnaround, before the premium reel", !!o1.promisedAt && !!o2.promisedAt && o2.promisedAt.getTime() < o1.promisedAt.getTime() && o2.promisedAt.toISOString() === "2026-10-23T12:00:00.000Z", `${o1.promisedAt?.toISOString()} / ${o2.promisedAt?.toISOString()}`);
    console.warn = () => {};
    const again = await aryeo.reconcileDeliverablesToOrder(job, order);
    console.warn = warn;
    c.ok("running it again changes nothing", !again.added.length && !again.retired.length && !again.relabeled.length && (await prisma.deliverable.count({ where: { projectId: job, type: "SOCIAL_REEL" } })) === 2, JSON.stringify(again));
    c.ok("the guard after: no gap", (await vs.videoSetupGapFor(job)) === null);
    // The office's date for the job wins for both videos (Joe's real job).
    const officeJob = await joeJob("540 Onward Ave", { dueOverrideAt: new RealDate("2026-10-24T18:07:00.000Z") });
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(officeJob, { id: "order-540", number: 1710, items: JOE } as never);
    console.warn = warn;
    const officeOuts = await dout.outputsForProject(officeJob);
    c.ok("with the office's date on the job, both videos go by it", officeOuts.length === 2 && officeOuts.every((o) => o.promisedAt?.toISOString() === "2026-10-24T18:07:00.000Z"), officeOuts.map((o) => o.promisedAt?.toISOString()).join(" / "));
    // The premium line leaves the order: the PREMIUM row is retired, never the standard one relabelled.
    console.warn = () => {};
    const shrink = await aryeo.reconcileDeliverablesToOrder(officeJob, { id: "order-540", number: 1710, items: [line("Community Photography"), line("Standard Video Highlight Reel"), line("Zillow Showcase 3D Tour Add-on")] } as never);
    console.warn = warn;
    const after = await prisma.deliverable.findMany({ where: { projectId: officeJob, type: "SOCIAL_REEL" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    c.ok("a line leaving the order retires ITS row, matched by product, not the oldest", !!after[0].removedFromOrderAt && !after[1].removedFromOrderAt && after[1].productTitle === "Standard Video Highlight Reel" && shrink.relabeled.length === 0, JSON.stringify(shrink));

    // =====================================================================
    c.head("3 · The brief: two sections");
    // =====================================================================
    const rows = await dout.videoInstructionsFor(job);
    c.ok("two videos, in slot order: premium first", rows.length === 2 && rows[0].deliverableId === premiumRow.id && rows[0].style === "premium_social_reel" && rows[1].style === "standard_reel");
    c.ok("video 1 keeps the job's instructions as its own", rows[0].source === "own" && rows[0].own === PREMIUM_WORDS);
    c.ok("video 2 has none of its own yet: it reads video 1's, marked as the job's", rows[1].source === "job" && rows[1].own === null && rows[1].text === PREMIUM_WORDS);
    c.ok("its tier words: Premium, Standard", pv.tierWords(rows[0].style) === "Premium" && pv.tierWords(rows[1].style) === "Standard");
    await establishSession(owner.id);
    const EditPage = (await import("@/app/edit/[id]/page")).default;
    const editTree = await EditPage({ params: Promise.resolve({ id: job }), searchParams: Promise.resolve({}) } as never);
    const videosCard = find(editTree, (e) => e.props?.["data-brief-section"] === "videos")[0];
    const items = videosCard ? find(videosCard, (e) => typeof e.props?.["data-job-video"] === "number") : [];
    const cardWords = videosCard ? said(videosCard) : "";
    c.ok("the editor's brief lists the job's two videos, one row each", !!videosCard && items.length === 2 && /This job has 2 videos/.test(cardWords), cardWords.slice(0, 200));
    c.ok("…each with what it is, its tier and its due date", /Video 1: .*Premium.*Due/.test(said(items[0])) && /Video 2: Standard Reel.*Standard.*Due/.test(said(items[1])), `${said(items[0])} || ${said(items[1])}`);
    c.ok("…whether its own instructions are in, and where its cut stands", /Instructions in/.test(said(items[0])) && /No instructions of its own yet/.test(said(items[1])) && /Version 1 in review/.test(said(items[0])) && /No cut yet/.test(said(items[1])));
    const out2 = (await dout.outputsForProject(job))[1];
    const edit2 = await EditPage({ params: Promise.resolve({ id: job }), searchParams: Promise.resolve({ output: out2.id }) } as never);
    const instr2 = find(edit2, (e) => e.props?.["data-brief-section"] === "video-instructions")[0];
    const w2 = instr2 ? said(instr2) : "";
    c.ok("video 2's page: its own instructions section, saying it has none of its own yet", /Instructions for video 2: Standard Reel/.test(w2) && /has not written instructions for this video yet/.test(w2), w2.slice(0, 220));
    const shoot2 = find(edit2, (e) => e.props?.id === "video-footage")[0];
    c.ok("…and the footage card no longer prints video 1's notes as \"Video notes\" for it", !!shoot2 && !/Video notes:/.test(said(shoot2)));

    // =====================================================================
    c.head("4 · The upload portal: two instruction areas, each saved");
    // =====================================================================
    const fresh = await joeJob("550 Onward Ave", { videoInstructions: null });
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(fresh, { id: "order-550", number: 1711, items: JOE } as never);
    console.warn = warn;
    await establishSession(harrison.id);
    const UploadPage = (await import("@/app/upload/[id]/page")).default;
    const portalOf = async (id: string) => find(await UploadPage({ params: Promise.resolve({ id }) } as never), (e) => typeName(e.type) === "UploadPortal")[0];
    const portal = await portalOf(fresh);
    const videos = portal?.props.videos as { first: { label: string; total: number; tier: string }; later: { key: string; label: string; shape: string; tier: string; dueISO: string | null }[] } | null;
    c.ok("the page hands the portal both videos: video 1 named, video 2 its own area", !!videos && videos.first.total === 2 && videos.first.tier === "Premium" && videos.later.length === 1 && videos.later[0].label === "Standard Reel" && videos.later[0].shape === "minimal" && !!videos.later[0].dueISO, JSON.stringify(videos));
    const oneJob = await prisma.project.create({
      data: {
        title: "7 One Reel Rd, Testville", clientId: client.id, status: "SHOT", shootDate: SHOT, photographerId: harrisonTm.id,
        deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel" }] },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(oneJob.id);
    const onePortal = await portalOf(oneJob.id);
    c.ok("a one-video job's page hands no per-video areas", onePortal?.props.videos === null);
    const html = render([
      { name: "two", props: portalProps(portal!.props) },
      { name: "one", props: portalProps(onePortal!.props) },
    ]);
    const two = text(html.two ?? "");
    c.ok("the portal renders", !!html.two && !html.two.startsWith("RENDER_ERROR") && !!html.one && !html.one.startsWith("RENDER_ERROR"), `${(html.two ?? "").slice(0, 160)} | ${(html.one ?? "").slice(0, 160)}`);
    c.ok("two videos named up top, and which one the first answers are for", /This shoot has 2 videos, each with its own instructions/.test(two) && two.includes(`Video 1 of 2: ${videos!.first.label}. The answers right below are for this video`), two.slice(0, 300));
    c.ok("video 2's own area: its name, tier and due date, its own color profile and instructions", /Video 2 of 2: Standard Reel/.test(two) && /Standard · due /.test(two) && /Color profile you shot this video in/.test(two) && /Your instructions for this video/.test(two) && /Song request/.test(two));
    c.ok("two color-profile choices on the page, one per video", ((html.two ?? "").match(/aria-labelledby="(?:color-profile-label|later-color-\d+)"/g) ?? []).length === 2);
    const one = text(html.one ?? "");
    c.ok("a one-video job's page is unchanged: no video list, one color profile, the plain wording", !/This shoot has/.test(one) && !/Video 2 of/.test(one) && ((html.one ?? "").match(/aria-labelledby="(?:color-profile-label|later-color-\d+)"/g) ?? []).length === 1 && /Color profile you shot in/.test(one));

    const { finalizeUpload } = await import("@/app/upload/actions");
    const key2 = videos!.later[0].key;
    const ANSWERS = {
      editorBrief: "", force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" as const }, nothingToRemove: true, removalNotes: "",
      videoInstructions: PREMIUM_WORDS, scriptConfirm: { state: "as-written" as const }, sawScript: true,
    };
    const blocked = await finalizeUpload(fresh, { ...ANSWERS, laterVideoInstructions: { [key2]: "EDITING NOTES\nKeep it quick." } });
    c.ok("the submit refuses a second video with no color profile, naming it", /color profile you shot video 2 \(Standard Reel\)/.test(String(blocked.blocked)), String(blocked.blocked));
    const VIDEO2 = "COLOR PROFILE: iPhone\n\nEDITING NOTES\nFront door push-in, kitchen, the yard; quick cuts.\n\nSONG OR MUSIC\nUpbeat, something they can post this week.";
    const saved = await finalizeUpload(fresh, { ...ANSWERS, laterVideoInstructions: { [key2]: VIDEO2 } });
    c.ok("with both, the submit goes through", !saved.blocked && !saved.laterVideosNotSaved, JSON.stringify(saved).slice(0, 200));
    const after2 = await dout.videoInstructionsFor(fresh);
    c.ok("video 1's instructions saved to the job (as before)", after2[0].own === PREMIUM_WORDS && (await prisma.project.findUniqueOrThrow({ where: { id: fresh } })).videoInstructions === PREMIUM_WORDS);
    c.ok("video 2's saved on its own video row, as its own", after2[1].source === "own" && after2[1].own === VIDEO2);
    c.ok("the timeline says who saved which video's instructions", !!(await prisma.activity.findFirst({ where: { projectId: fresh, body: { startsWith: "Video instructions for video 2 (Standard Reel) saved by Harrison Drill" } } })));
    const reopen = await portalOf(fresh);
    c.ok("re-opened, the page hands back video 2's saved words", (reopen?.props.videos as { later: { own: string | null }[] } | null)?.later[0]?.own === VIDEO2);
    c.ok("an id from another job is never written", (await dout.saveLaterVideoInstructions(fresh, { [`${premiumRow.id}:1`]: "COLOR PROFILE: iPhone" }, "x")).length === 0);

    // =====================================================================
    c.head("5 · KPI and the morning-after nudge read each video");
    // =====================================================================
    // A Thursday shoot handed in Friday 8:30 AM ET: after the per-video rule
    // (PER_VIDEO_FROM). Both videos were set up before it; only video 1 got words.
    const SHOT_THU = new RealDate("2026-10-22T12:00:00.000Z");
    const handed = new RealDate("2026-10-23T12:30:00.000Z");
    const kpiJob = await prisma.project.create({
      data: {
        title: "600 Onward Ave, Phoenixville, PA", addressLine: "600 Onward Ave", clientId: client.id, status: "SHOT", shootDate: SHOT_THU, photographerId: harrisonTm.id,
        videoInstructions: PREMIUM_WORDS, reelScript: "Script", scriptConfirmedAt: SHOT, debriefSubmittedAt: handed, videoHandoffAt: handed, photosHandoffAt: handed, cullingConfirmedAt: handed, removalNotes: "Nothing", shotOrderNotes: "Shot front to back.",
        createdAt: new RealDate("2026-10-14T19:41:00Z"),
        deliverables: {
          create: [
            { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel", createdAt: new RealDate("2026-10-14T19:41:00Z") },
            { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: new RealDate("2026-10-14T19:41:01Z") },
          ],
        },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(kpiJob.id);
    // Joe's real case: the hub only set the second video up after the handoff.
    const lateJob = await prisma.project.create({
      data: {
        title: "602 Onward Ave, Phoenixville, PA", addressLine: "602 Onward Ave", clientId: client.id, status: "SHOT", shootDate: SHOT_THU, photographerId: harrisonTm.id,
        videoInstructions: PREMIUM_WORDS, reelScript: "Script", scriptConfirmedAt: SHOT, debriefSubmittedAt: handed, videoHandoffAt: handed,
        deliverables: {
          create: [
            { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel", createdAt: new RealDate("2026-10-14T19:41:00Z") },
            { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: new RealDate("2026-10-23T15:00:00Z") },
          ],
        },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(lateJob.id);
    const goodOne = await prisma.project.create({
      data: {
        title: "8 Single Video Ln, Phoenixville, PA", addressLine: "8 Single Video Ln", clientId: client.id, status: "SHOT", shootDate: SHOT_THU, photographerId: harrisonTm.id,
        videoInstructions: PREMIUM_WORDS, reelScript: "Script", scriptConfirmedAt: SHOT, debriefSubmittedAt: handed, videoHandoffAt: handed,
        deliverables: { create: [{ type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel" }] },
      },
      select: { id: true },
    });
    const ev = await import("@/lib/kpiEvidence");
    const evidence = await ev.loadEvidence(harrisonTm.id, { startKey: "2026-10-22", endKey: "2026-10-22", start: new RealDate("2026-10-22T04:00:00Z"), windowEnd: new RealDate(SIM) }, new RealDate(SIM));
    const entryFor = (id: string) => evidence.entries.find((e) => e.kind === "instructions" && e.projectId === id);
    const k1 = entryFor(kpiJob.id);
    c.ok("a two-video job with instructions for only one: \"Video instructions incomplete\", naming video 2", !!k1 && /incomplete/.test(k1.title) && k1.detail.some((d) => /the instructions for video 2 \(Standard Reel\)/.test(d)), JSON.stringify(k1));
    const k2 = entryFor(lateJob.id);
    c.ok("a second video the hub only set up after the handoff is not held against the photographer", !k2 || !k2.detail.some((d) => /video 2/.test(d)), JSON.stringify(k2));
    c.ok("a one-video job with good instructions: no entry (unchanged)", !entryFor(goodOne.id));
    // Joe's real job was handed in Wed night, before the page asked per video: never retro-flagged.
    const before = await prisma.project.create({
      data: {
        title: "604 Onward Ave, Phoenixville, PA", addressLine: "604 Onward Ave", clientId: client.id, status: "SHOT", shootDate: SHOT, photographerId: harrisonTm.id,
        videoInstructions: PREMIUM_WORDS, reelScript: "Script", scriptConfirmedAt: SHOT, debriefSubmittedAt: new RealDate("2026-10-22T03:01:00Z"), videoHandoffAt: new RealDate("2026-10-22T03:01:00Z"),
        deliverables: {
          create: [
            { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel", createdAt: new RealDate("2026-10-14T19:41:00Z") },
            { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", createdAt: new RealDate("2026-10-14T19:41:01Z") },
          ],
        },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(before.id);
    const wedEvidence = await ev.loadEvidence(harrisonTm.id, { startKey: "2026-10-21", endKey: "2026-10-21", start: new RealDate("2026-10-21T04:00:00Z"), windowEnd: new RealDate(SIM) }, new RealDate(SIM));
    const wed = wedEvidence.entries.find((e) => e.kind === "instructions" && e.projectId === before.id);
    const { handoffReadinessOf: hro } = await import("@/lib/tasks");
    const beforeRow = await prisma.project.findUniqueOrThrow({ where: { id: before.id }, include: { deliverables: true, orderItems: true, photographer: true } });
    const beforeReady = await hro({ ...beforeRow, photographer: beforeRow.photographer });
    c.ok("a video half handed in before the per-video page (Joe's, Wed night) is never retro-flagged: no KPI entry, no edit-card gap", !wed && !beforeReady.gaps.some((g) => /video 2/.test(g.label)), JSON.stringify({ wed, gaps: beforeReady.gaps }));
    const mi = await import("@/lib/missingInstructions");
    const nudgeJob = await prisma.project.create({
      data: {
        title: "610 Onward Ave, Phoenixville, PA", addressLine: "610 Onward Ave", clientId: client.id, status: "SHOT", shootDate: SHOT, photographerId: harrisonTm.id,
        videoInstructions: PREMIUM_WORDS, reelScript: "Script", scriptConfirmedAt: SHOT,
        deliverables: {
          create: [
            { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel" },
            { type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel" },
          ],
        },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(nudgeJob.id);
    const miss = await mi.missingInstructionsFor(nudgeJob.id);
    c.ok("the 10 AM nudge asks for the second video's instructions", !!miss?.video.includes("the instructions for video 2 (Standard Reel)"), JSON.stringify(miss));
    const { handoffReadinessOf } = await import("@/lib/tasks");
    const oneRow = await prisma.project.findUniqueOrThrow({ where: { id: goodOne.id }, include: { deliverables: true, orderItems: true, photographer: true } });
    const oneReady = await handoffReadinessOf({ ...oneRow, photographer: oneRow.photographer });
    c.ok("a one-video job's readiness carries no per-video gap", !oneReady.gaps.some((g) => /video \d/.test(g.label)), JSON.stringify(oneReady.gaps));

    // =====================================================================
    c.head("6 · The guard: more videos ordered than set up");
    // =====================================================================
    const gap = (o: Partial<Parameters<typeof vs.videoSetupGapOf>[0]>) => vs.videoSetupGapOf({ orderItems: [], videoRows: [], videosOwedOverride: null, monthly: false, ...o });
    c.ok("two video products, one row: \"2 videos ordered, 1 set up\"", gap({ orderItems: [{ title: "Social Influencer" }, { title: "Standard Video Highlight Reel" }], videoRows: [{ quantity: 1 }] })?.words === "2 videos ordered, 1 set up");
    c.ok("a quantity of 2 on a row of 1: \"2 videos ordered, 1 set up\"", gap({ orderItems: [{ title: "Standard Video Highlight Reel", quantity: 2 }], videoRows: [{ quantity: 1 }] })?.words === "2 videos ordered, 1 set up");
    c.ok("the office's number with no video row: \"3 videos owed, 0 set up\"", gap({ orderItems: [{ title: "Community Photography" }], videosOwedOverride: 3 })?.words === "3 videos owed, 0 set up");
    c.ok("the office's number over a row: set up as slots, no alarm", gap({ orderItems: [{ title: "Standard Video Highlight Reel" }], videoRows: [{ quantity: 1 }], videosOwedOverride: 3 }) === null);
    c.ok("everything set up: no alarm; monthly content and a merged-away job: never", gap({ orderItems: [{ title: "Social Influencer" }], videoRows: [{ quantity: 1 }] }) === null && gap({ orderItems: [{ title: "Social Influencer" }, { title: "Standard Video Highlight Reel" }], videoRows: [{ quantity: 1 }], monthly: true }) === null && gap({ orderItems: [{ title: "Social Influencer" }, { title: "Standard Video Highlight Reel" }], videoRows: [{ quantity: 1 }], mergedAway: true }) === null);
    const unset = await joeJob("700 Onward Ave");
    const gaps = await vs.videoSetupGaps([unset, job, oneJob.id]);
    c.ok("one read for many jobs: only the job missing a video is flagged", gaps.get(unset)?.words === "2 videos ordered, 1 set up" && !gaps.has(job) && !gaps.has(oneJob.id), JSON.stringify([...gaps]));
    const { VideoSetupNotice } = await import("@/components/jobs/VideoSetupNotice");
    const notice = await VideoSetupNotice({ projectId: unset });
    const nw = said(notice);
    c.ok("the job page says it at the top, names the products and the fix", /2 videos ordered, 1 set up/.test(nw) && /Social Influencer and Standard Video Highlight Reel/.test(nw) && /Refresh from Aryeo/.test(nw), nw);
    c.ok("…and says nothing once they agree", (await VideoSetupNotice({ projectId: job })) === null);
    const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
    c.ok("the Shoots board carries it on the row", /videoSetup: delivered \? null : setupGaps\.get\(j\.id\)\?\.words \?\? null/.test(read("src/lib/jobsBoard.ts")) && /r\.videoSetup && <div[^>]*data-video-setup/.test(read("src/components/jobs/ShootsList.tsx")));
    c.ok("the job page renders the notice", /<VideoSetupNotice projectId=\{project\.id\} \/>/.test(read("src/app/projects/[id]/page.tsx")));
    c.ok("no em dashes in the new words", ![read("src/components/jobs/VideoSetupNotice.tsx"), read("src/lib/videoSetup.ts")].some((s) => /—/.test(s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"))));
    c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
