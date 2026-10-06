// ---------------------------------------------------------------------------
// DRILL: THE UPLOAD PORTAL SHOWS EACH VIDEO'S BRIEF, AND THE PHOTOGRAPHER ADDS
// WHAT CHANGED ON SITE TO IT (unified handoff §7.5 / §6.8, Sep 28 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/upload-portal-briefs.ts
//
// Batch 4 gave every video its own brief (DeliverableOutput.briefJson) and it
// reached the editor's page, the printed brief and the shoot screen, but not
// the page the photographer fills after the shoot. What this proves, OLD first:
//
//   0. OLD (0950c1c): /upload/<id> hands the portal no brief at all, and the
//      portal it renders carries none of the office's words for either video.
//   1. NEW: the page hands the portal both videos' briefs (a reel the office
//      briefed, an MLS film going by the job's instructions), each with its
//      version and who saved it, money-scrubbed; the rendered portal shows
//      them with an "Add an on-site note" button, before and after the submit.
//   2. The photographer's note through the page's OWN server action (taken
//      off the element tree): added to "Changed on site" signed with their
//      name and the day, a new version saved by them, the office's sections
//      kept, one Activity line; the same note twice is one line; a second note
//      is added under the first.
//   3. The edit page reads the same brief: the office's page (the element
//      tree), the editor's scrubbed copy and the shoot screen carry the same
//      version line and the same words the portal was handed back.
//   4. Refused, and nothing written: a "view as" preview (and the page it
//      renders offers no note box), another photographer, an editor, another
//      job's video, a video no longer owed, an empty note, an over-long note,
//      and a section already full.
//   5. Never to a client, never money: the only files that read or write a
//      brief are the staff and creative surfaces; no client portal file does.
//      Missing work (a limitation raised off a brief, a gap the office wrote
//      with a price) reaches the photographer's page and the editor's page
//      with no figure in it; the office's pages keep the words (review, Sep 28).
//   6. Which videos the page shows: a one-video job only once it has a brief
//      of its own; a content session only the videos briefed one by one.
//   7. The stale "No script yet … Script Studio" warning: OLD ShootScreen shows
//      it on a content session; NEW shows it only on a listing job with no
//      script (and the portal's own Studio line is gone from a content session).
//
// ISOLATION. PGlite on 127.0.0.1:5991 (DRILL_PORT overrides) through the shared
// harness; production is never opened; every non-loopback call is fenced and
// must stay at zero. AUTH_ENFORCE is on so the real guards run on real
// sessions. Client components are rendered to HTML in a child process
// (react-dom/server, no react-server condition) with their server actions
// replaced by no-ops. THE CLOCK is pinned to Wed Sep 23 2026, 9:30 PM ET, the
// evening of the shoot.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5991);
const BASE = "0950c1c"; // the commit this change starts from — never HEAD
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
const NOW_ISO = "2026-09-24T01:30:00.000Z"; // Wed Sep 23 2026, 9:30 PM EDT
const SIM = RealDate.parse(NOW_ISO);
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
const et = (day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, 8, day, hour + 4, minute));

// ---- modules that cannot load under the react-server build of React -------
// The page's element tree is walked, never rendered, here: the portal itself
// is a named stand-in (its props are what the page hands it), and the icons
// and the link are inert. The REAL portal is rendered in the child below.
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
const find = (tree: any, pred: (e: El) => boolean) => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
/** Every string and number under a node, in order — the words it would print. */
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isEl(n)) words(n.props.children, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- the old code, runnable ------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upload-portal-briefs-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
const point = (src: string, rel: Record<string, string> = {}) =>
  src
    .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)
    .replace(/(["'])\.\/([A-Za-z]+)\1/g, (m, q: string, p: string) => (rel[p] ? `${q}${rel[p]}${q}` : m));
/** 0950c1c's /upload/<id> page, its imports aimed at this tree (JSX needs React in scope out here). */
function oldUploadPage(): string {
  const dir = path.join(REPO, "src/app/upload/[id]");
  const file = path.join(tmp, "upload-page.base.tsx");
  fs.writeFileSync(file, `import * as React from "react";\n${point(show("src/app/upload/[id]/page.tsx"), { AddedAtShoot: path.join(dir, "AddedAtShoot"), AdditionalShoot: path.join(dir, "AdditionalShoot") })}`);
  return file;
}

// ---- the render harness (a child process, no react-server condition) -------
const CACHE = path.join(REPO, "node_modules/.cache", "upload-portal-briefs");
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function baselineFile(rel: string): string {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`);
  fs.writeFileSync(out, `import * as React from "react";\n${point(show(rel))}`);
  return out;
}
type RenderCase = { name: string; file: string; exp: string; props: Record<string, unknown>; fns?: string[] };
function render(cases: RenderCase[]): Record<string, string> {
  fs.mkdirSync(CACHE, { recursive: true });
  const seed = path.join(CACHE, "seed.cjs");
  // Seeds the module cache (the _client-drill-preload pattern): the router,
  // the link and every server-action file the two screens import are
  // stand-ins, so a render can never reach the server — nothing is clicked.
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
for (const f of ["src/app/upload/actions.ts", "src/app/upload/draftActions.ts", "src/app/shoot/actions.ts", "src/app/editing/actions.ts"]) put(path.join(root, f), actions());
`);
  const runner = path.join(CACHE, "render.ts");
  fs.writeFileSync(runner, `/* eslint-disable */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const RealDate = Date;
const NOW = RealDate.parse(process.env.UPB_NOW as string);
globalThis.Date = new Proxy(RealDate, {
  construct(t, a: unknown[]) { return a.length ? Reflect.construct(t, a) : new t(NOW); },
  get(t, p, r) { return p === "now" ? () => NOW : Reflect.get(t, p, r); },
}) as DateConstructor;
const cases = JSON.parse(require("fs").readFileSync(process.env.UPB_CASES as string, "utf8"));
const out: Record<string, string> = {};
for (const c of cases) {
  try {
    const props = { ...c.props };
    for (const k of c.fns ?? []) props[k] = async () => ({ ok: true, changed: false, message: "", brief: null });
    out[c.name] = renderToStaticMarkup(createElement(require(c.file)[c.exp], props));
  } catch (e) {
    out[c.name] = "RENDER_ERROR: " + (e as Error).message;
  }
}
process.stdout.write("\\n@@UPB@@" + JSON.stringify(out));
`);
  const casesFile = path.join(CACHE, `cases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  try {
    const res = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [runner], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: {
        ...process.env,
        // Quoted: the repo folder name has spaces, and NODE_OPTIONS splits on
        // them unless a path is double-quoted.
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, "scripts/_drill/_client-drill-preload.cjs"))} --require ${JSON.stringify(seed)}`,
        UPB_NOW: NOW_ISO,
        UPB_CASES: casesFile,
      },
    });
    const at = res.lastIndexOf("@@UPB@@");
    return at >= 0 ? (JSON.parse(res.slice(at + 7)) as Record<string, string>) : {};
  } finally {
    fs.rmSync(casesFile, { force: true });
  }
}

/** The portal's props as the child can take them: the server-rendered folder card and the action are not data. */
function portalProps(p: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { foldersSlot: _slot, onBriefNote: _act, ...rest } = p;
  void _slot; void _act;
  return JSON.parse(JSON.stringify({ ...rest, foldersSlot: null, ...over }));
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const dout = await import("@/lib/deliverableOutputs");
  const { establishSession, setSession } = await import("@/lib/auth/session");
  const { saveVideoBrief } = await import("@/app/editing/actions");
  const { getShoot } = await import("@/lib/shoot");
  const UploadPage = (await import("@/app/upload/[id]/page")).default;
  const EditPage = (await import("@/app/edit/[id]/page")).default;
  const OldUploadPage = ((await import(oldUploadPage())) as { default: typeof UploadPage }).default;
  const PORTAL = path.join(REPO, "src/components/upload/UploadPortal.tsx");
  const SHOOT = path.join(REPO, "src/components/shoot/ShootScreen.tsx");
  const OLD_PORTAL = baselineFile("src/components/upload/UploadPortal.tsx");
  const OLD_SHOOT = baselineFile("src/components/shoot/ShootScreen.tsx");

  // ---- the world -----------------------------------------------------------
  const person = async (name: string, role: "PHOTOGRAPHER" | "OWNER" | "ADMIN" | "EDITOR", extra: { editorKey?: string } = {}) => {
    const email = `${name.split(" ")[0].toLowerCase()}-upb@drill.invalid`;
    if (role === "PHOTOGRAPHER") await prisma.teamMember.create({ data: { name, email, role: "PHOTOGRAPHER" } });
    const u = await prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra }, select: { id: true, email: true } });
    // The one-time "new upload process" acknowledgement the page asks for first.
    if (role === "PHOTOGRAPHER") await prisma.appSetting.create({ data: { key: `upload-ack-${email}`, value: "true" } });
    return u;
  };
  const harrison = await person("Harrison Drill", "PHOTOGRAPHER");
  const james = await person("James Drill", "PHOTOGRAPHER");
  const owner = await person("Jordan Drill", "OWNER");
  const kyle = await person("Kyle Drill", "ADMIN");
  const kim = await person("Kim Drill", "EDITOR", { editorKey: "kim" });
  const asHarrison = () => establishSession(harrison.id);
  const harrisonTm = (await prisma.teamMember.findFirstOrThrow({ where: { email: harrison.email }, select: { id: true } })).id;

  const client = await prisma.client.create({ data: { name: "Portal Briefs TEST" }, select: { id: true } });
  const listing = async (title: string, types: ("SOCIAL_REEL" | "VIDEO")[]) => {
    const p = await prisma.project.create({
      data: {
        clientId: client.id, title, status: "SCHEDULED", shootDate: et(23, 10), photographerId: harrisonTm,
        videoInstructions: "VISION FOR THE EDIT\nBright and airy, the whole house.",
        deliverables: {
          create: [
            { type: "PHOTOS", label: "Photos", quantity: 1 },
            ...types.map((t) => t === "SOCIAL_REEL"
              ? { type: t, label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1 }
              : { type: t, label: "Video", productTitle: "Cinematic MLS Video", videoStyle: "standard_cinematic", quantity: 1 }),
          ],
        },
      },
      select: { id: true },
    });
    await dout.ensureOutputsForProject(p.id);
    return { id: p.id, outs: await dout.outputsForProject(p.id) };
  };
  const two = await listing("40 Portal Brief Way, Testville", ["SOCIAL_REEL", "VIDEO"]);
  const [reel, mls] = two.outs;
  const other = await listing("9 Other Job Ct, Testville", ["SOCIAL_REEL", "VIDEO"]);
  const one = await listing("7 One Reel Rd, Testville", ["SOCIAL_REEL"]);
  c.ok("fixtures: the listing job owes a reel and an MLS film, one row each", two.outs.length === 2 && !!reel && !!mls, two.outs.map((o) => o.label).join(" | "));

  // The office briefs the reel through its own action (as Kyle), with money in it.
  await establishSession(kyle.id);
  const r1 = await saveVideoBrief(two.id, reel.id, { purpose: "Instagram teaser for the coming-soon post. The client paid a $150 rush fee.", mustShow: "The pool at dusk" }, null);
  c.ok("the office's reel brief is v1, saved by Kyle Drill", r1.ok && r1.version === 1, r1.message);

  type PortalEl = { props: Record<string, unknown> };
  const portalOf = async (Page: typeof UploadPage, id: string): Promise<PortalEl> => {
    const tree = await Page({ params: Promise.resolve({ id }) });
    const found = find(tree, (e) => typeName(e.type) === "UploadPortal");
    if (found.length !== 1) throw new Error(`expected one UploadPortal on /upload/${id}, found ${found.length}`);
    return found[0] as PortalEl;
  };
  type Brief = import("@/components/upload/UploadPortal").PortalOutputBrief;
  type NoteResult = import("@/components/upload/UploadPortal").BriefNoteResult;
  type NoteAction = (projectId: string, outputId: string, note: string) => Promise<NoteResult>;
  const briefsOf = (p: PortalEl) => (p.props.outputBriefs ?? null) as Brief[] | null;

  // =========================================================================
  c.head(`0 · OLD (${BASE}): the upload page carries no brief`);
  // =========================================================================
  await asHarrison();
  const oldP = await portalOf(OldUploadPage, two.id);
  c.ok("OLD: /upload/<id> hands the portal no per-video brief at all", !("outputBriefs" in oldP.props) && !("onBriefNote" in oldP.props), Object.keys(oldP.props).join(","));

  // =========================================================================
  c.head("1 · NEW: each video's brief, with its version and who saved it");
  // =========================================================================
  const newP = await portalOf(UploadPage, two.id);
  const nb = briefsOf(newP) ?? [];
  const nReel = nb.find((b) => b.outputId === reel.id);
  const nMls = nb.find((b) => b.outputId === mls.id);
  c.ok("NEW: both videos, in the job's order", nb.length === 2 && nb[0]?.outputId === reel.id && nb[1]?.outputId === mls.id, nb.map((b) => `${b.index}. ${b.label}`).join(" | "));
  c.ok("the reel: the office's brief, v1, saved by Kyle Drill", nReel?.version === 1 && /^Brief v1 · saved by Kyle Drill, /.test(nReel.versionLabel) && nReel.updatedBy === "Kyle Drill", nReel?.versionLabel);
  c.ok("the MLS film: no brief of its own, and it says what it goes by",
    nMls?.version === null && nMls.directionSource === "job" && nMls.versionLabel === "No brief of its own; goes by the job's instructions, shared by all 2 videos", nMls?.versionLabel);
  c.ok("money-scrubbed: the fee sentence is gone, the direction is not",
    JSON.stringify(nb).includes("Instagram teaser for the coming-soon post") && !JSON.stringify(nb).includes("$150") && JSON.stringify(nb).includes("The pool at dusk"));
  c.ok("the page hands the portal its note action, with nothing blocking it", typeof newP.props.onBriefNote === "function" && newP.props.briefNoteBlocked === null && newP.props.briefNoteCap === dout.ON_SITE_NOTE_CAP);
  const act = newP.props.onBriefNote as NoteAction;

  const collapsedISO = et(23, 20).toISOString();
  const html = render([
    { name: "old", file: OLD_PORTAL, exp: "UploadPortal", props: portalProps(oldP.props) },
    { name: "new", file: PORTAL, exp: "UploadPortal", props: portalProps(newP.props), fns: ["onBriefNote"] },
    { name: "newSubmitted", file: PORTAL, exp: "UploadPortal", props: portalProps(newP.props, { project: { ...(newP.props.project as object), debriefSubmittedAt: collapsedISO } }), fns: ["onBriefNote"] },
  ]);
  const oldHtml = text(html.old ?? "");
  const newHtml = text(html.new ?? "");
  const subHtml = text(html.newSubmitted ?? "");
  c.ok("the portals rendered", !!oldHtml && !!newHtml && !!subHtml && ![html.old, html.new, html.newSubmitted].some((h) => !h || h.startsWith("RENDER_ERROR")), [html.old, html.new, html.newSubmitted].filter((h) => !h || h.startsWith("RENDER_ERROR")).join(" / ").slice(0, 300));
  c.ok("OLD portal: none of the office's words, no version, no brief", oldHtml.includes("Video") && !oldHtml.includes("Instagram teaser") && !oldHtml.includes("Brief v1") && !oldHtml.includes("Each video's brief"));
  c.ok("NEW portal: \"Each video's brief\", both videos, the version line and the words",
    newHtml.includes("Each video's brief") && newHtml.includes("Brief v1 · saved by Kyle Drill") && newHtml.includes("Instagram teaser for the coming-soon post") &&
      newHtml.includes("No brief of its own; goes by the job's instructions, shared by all 2 videos"));
  c.ok("NEW portal: a note button on each video, and no money anywhere on the page",
    (newHtml.match(/Add an on-site note/g) ?? []).length === 2 && !newHtml.includes("$150"));
  c.ok("…and after the submit the briefs are still there, still open to a note",
    subHtml.includes("Need to change something?") && subHtml.includes("Brief v1 · saved by Kyle Drill") && (subHtml.match(/Add an on-site note/g) ?? []).length === 2);

  // =========================================================================
  c.head("2 · the photographer's note lands on the brief, with their name, as a new version");
  // =========================================================================
  const stored = async (id: string) => {
    const r = await prisma.deliverableOutput.findUniqueOrThrow({ where: { id }, select: { briefJson: true, briefUpdatedBy: true } });
    return { brief: dout.readOutputBrief(r.briefJson), by: r.briefUpdatedBy };
  };
  const acts = (who: string) => prisma.activity.count({ where: { projectId: two.id, body: { contains: `by ${who}.` } } });
  const n1 = await act(two.id, reel.id, "The agent asked us to skip the garage.");
  const s1 = await stored(reel.id);
  const LINE1 = "Harrison Drill, Sep 23: The agent asked us to skip the garage.";
  c.ok("the note is saved: v2, saved by Harrison Drill", n1.ok && n1.changed && s1.brief?.version === 2 && s1.by === "Harrison Drill", n1.message);
  c.ok("…added to \"Changed on site\", signed with the name and the day", s1.brief?.sections.onSite === LINE1, s1.brief?.sections.onSite);
  c.ok("…and the office's own sections are untouched (the office still reads its money)",
    s1.brief?.sections.purpose === "Instagram teaser for the coming-soon post. The client paid a $150 rush fee." && s1.brief?.sections.mustShow === "The pool at dusk");
  c.ok("the portal is handed the brief as it now reads: v2, by Harrison, the note on it, no money",
    !!n1.brief && /^Brief v2 · saved by Harrison Drill, /.test(n1.brief.versionLabel) && n1.brief.sections.some((x) => x.key === "onSite" && x.label === "Changed on site" && x.text === LINE1) && !JSON.stringify(n1.brief).includes("$150"),
    n1.brief?.versionLabel);
  c.ok("the job's history says who saved it", (await acts("Harrison Drill")) === 1);
  const again = await act(two.id, reel.id, "The agent asked us to skip the garage.");
  c.ok("the same note again is not a second line or a new version", again.ok && !again.changed && (await stored(reel.id)).brief?.version === 2 && (await acts("Harrison Drill")) === 1, again.message);
  const n2 = await act(two.id, reel.id, "  Use the second take of the pool pass.\r\n");
  const s2 = await stored(reel.id);
  const LINE2 = "Harrison Drill, Sep 23: Use the second take of the pool pass.";
  c.ok("a second note goes under the first: v3", n2.ok && n2.changed && s2.brief?.version === 3 && s2.brief?.sections.onSite === `${LINE1}\n${LINE2}`, s2.brief?.sections.onSite);
  const n3 = await act(two.id, mls.id, "No twilight: the agent is rebooking it.");
  const s3 = await stored(mls.id);
  c.ok("a note on the MLS film starts that video's own brief: v1, by Harrison", n3.ok && s3.brief?.version === 1 && s3.by === "Harrison Drill" && s3.brief.sections.onSite === "Harrison Drill, Sep 23: No twilight: the agent is rebooking it.", n3.message);

  // =========================================================================
  c.head("3 · the edit page reads the same brief");
  // =========================================================================
  const office = await dout.outputBriefsFor(two.id);
  const editorCopy = await dout.outputBriefsFor(two.id, { scrub: true });
  const oReel = office.find((o) => o.outputId === reel.id)!;
  c.ok("the office's read: v3 by Harrison, both notes, and the office's words", /^Brief v3 · saved by Harrison Drill, /.test(oReel.versionLabel) && oReel.sections.find((x) => x.key === "onSite")?.text === `${LINE1}\n${LINE2}` && JSON.stringify(oReel.sections).includes("$150"), oReel.versionLabel);
  c.ok("the portal was handed exactly that version line and those words", n2.brief?.versionLabel === oReel.versionLabel && n2.brief?.sections.find((x) => x.key === "onSite")?.text === `${LINE1}\n${LINE2}`);
  c.ok("the editor's copy: the same notes, no money", JSON.stringify(editorCopy.find((o) => o.outputId === reel.id)?.sections).includes(LINE2) && !JSON.stringify(editorCopy).includes("$150"));
  await establishSession(kyle.id);
  // Oct 5 fixture fix: /edit/<id> shows ONE selected video (?output=<id>,
  // a60424b); each card is read on its own video's page.
  const card = async (id: string) => words(find(await EditPage({ params: Promise.resolve({ id: two.id }), searchParams: Promise.resolve({ output: id }) }), (e) => e.props?.id === `brief-${id}`)[0]).join(" ");
  const reelCard = await card(reel.id);
  const mlsCard = await card(mls.id);
  c.ok("/edit/<id> (the office's page): the reel's card prints v3 by Harrison and both notes", reelCard.includes("Brief v3 · saved by Harrison Drill") && reelCard.includes(LINE1) && reelCard.includes(LINE2), reelCard.slice(0, 240));
  c.ok("/edit/<id>: the MLS film's card prints Harrison's note as its v1", mlsCard.includes("Brief v1 · saved by Harrison Drill") && mlsCard.includes("No twilight: the agent is rebooking it."), mlsCard.slice(0, 200));
  const shootTwo = (await getShoot(two.id))!;
  c.ok("the shoot screen carries the same version and notes", shootTwo.outputBriefs.some((o) => o.outputId === reel.id && o.versionLabel === oReel.versionLabel && o.sections.some((x) => x.text === `${LINE1}\n${LINE2}`)));

  // =========================================================================
  c.head("4 · refused, and nothing written");
  // =========================================================================
  const v = async () => ({ reel: (await stored(reel.id)).brief?.version, mls: (await stored(mls.id)).brief?.version });
  const before = await v();
  await setSession({ uid: owner.id, email: owner.email, role: "OWNER", actingAs: harrison.id });
  const preview = await act(two.id, reel.id, "From a preview");
  c.ok("an owner's 'view as' preview is refused", !preview.ok && /previewing/i.test(preview.message), preview.message);
  const previewP = await portalOf(UploadPage, two.id);
  c.ok("…and the page it renders says so instead of offering a note box", typeof previewP.props.briefNoteBlocked === "string" && /previewing/i.test(previewP.props.briefNoteBlocked as string));
  const previewHtml = text(render([{ name: "p", file: PORTAL, exp: "UploadPortal", props: portalProps(previewP.props), fns: ["onBriefNote"] }]).p ?? "");
  c.ok("…the rendered preview shows the briefs and no note button", previewHtml.includes("Brief v3 · saved by Harrison Drill") && !previewHtml.includes("Add an on-site note") && previewHtml.includes("notes can't be added from here"));
  await establishSession(james.id);
  const foreign = await act(two.id, reel.id, "Not my shoot");
  c.ok("another photographer is refused", !foreign.ok && /access/i.test(foreign.message), foreign.message);
  await establishSession(kim.id);
  const editor = await act(two.id, reel.id, "An editor's note");
  c.ok("an editor is refused", !editor.ok && /access/i.test(editor.message), editor.message);
  await asHarrison();
  const wrong = await act(two.id, other.outs[0].id, "Wrong job");
  c.ok("another job's video is refused", !wrong.ok && /different job/i.test(wrong.message), wrong.message);
  await prisma.deliverableOutput.update({ where: { id: other.outs[1].id }, data: { waivedAt: et(23, 12) } });
  const waived = await act(other.id, other.outs[1].id, "Not owed");
  c.ok("a video no longer owed is refused", !waived.ok && /no longer owed/i.test(waived.message), waived.message);
  const empty = await act(two.id, reel.id, "   ");
  c.ok("an empty note is refused", !empty.ok && /write the note/i.test(empty.message), empty.message);
  const long = await act(two.id, reel.id, "x".repeat(dout.ON_SITE_NOTE_CAP + 1));
  c.ok("a note over the limit is refused", !long.ok && long.message.includes(`${dout.ON_SITE_NOTE_CAP} characters`), long.message);
  c.ok("none of those wrote anything", JSON.stringify(await v()) === JSON.stringify(before) && (await stored(other.outs[0].id)).brief === null && (await stored(other.outs[1].id)).brief === null, JSON.stringify(await v()));
  await dout.saveOutputBrief({ outputId: other.outs[0].id, projectId: other.id, sections: { onSite: "y".repeat(dout.OUTPUT_BRIEF_FIELD_CAP - 20) }, actor: "Kyle Drill" });
  const full = await act(other.id, other.outs[0].id, "One more thing the agent said on the way out.");
  c.ok("a section already full is refused in plain words, and stays v1", !full.ok && /notes are full/i.test(full.message) && (await stored(other.outs[0].id)).brief?.version === 1, full.message);

  // =========================================================================
  c.head("5 · never a client's, never money");
  // =========================================================================
  const readers = execFileSync("git", ["grep", "--untracked", "-l", "-E", "briefJson|briefUpdatedBy|outputBriefsFor|saveOutputBrief|addOnSiteNote|onBriefNote", "--", "src"], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter(Boolean);
  // A client reads the portal (/portal/<token>) and nothing else: its routes,
  // its components and the lib/portal* readers behind them.
  const clientFacing = (f: string) => /^src\/(app|components)\/portal\//.test(f) || /^src\/app\/api\/portal\//.test(f) || /^src\/lib\/portal[^/]*\.ts$/.test(f);
  c.ok("the files that read or write a brief are staff and creative surfaces only; no client portal file", readers.length > 0 && !readers.some(clientFacing), readers.join(", "));
  c.ok("the upload page is among them (the reader this change adds)", readers.includes("src/app/upload/[id]/page.tsx"));
  const dollar = newHtml.indexOf("$");
  c.ok("the photographer's rendered page never showed the fee", !newHtml.includes("$150") && !subHtml.includes("$150") && !previewHtml.includes("$150"), dollar >= 0 ? newHtml.slice(Math.max(0, dollar - 80), dollar + 40) : "no $ at all");

  // MISSING WORK, NEVER MONEY (review, Sep 28). A limitation on a brief raised
  // as missing work, and a gap the office wrote with a price in it: the
  // photographer's page and the editor's page are handed the words without
  // the figures; the office's page keeps them (its Plan form saves them back).
  const gapJob = await listing("5 Gap Money Way, Testville", ["SOCIAL_REEL", "VIDEO"]);
  const [gReel, gMls] = gapJob.outs;
  // Oct 5 fixture fix: the editor reading this job below is Kim, so the job is
  // HERS — the project's editor is her roster row. Standard reels route to
  // John Mark by default, and /edit/<id> rightly refuses Kim on his job (it
  // answered notFound, which is what these checks used to trip on).
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Drill", email: "kim-roster-upb@drill.invalid", role: "EDITOR" }, select: { id: true } });
  await prisma.project.update({ where: { id: gapJob.id }, data: { editorId: kimTm.id } });
  await dout.saveOutputBrief({ outputId: gReel.id, projectId: gapJob.id, sections: { limitations: "Drone was not ordered ($175 add-on). No aerials." }, actor: "Kyle Drill" });
  const { raiseGapFromBrief } = await import("@/lib/productionGaps");
  const raisedGap = await raiseGapFromBrief({ outputId: gReel.id, projectId: gapJob.id, actor: "Kyle Drill" });
  // Written by hand with the price in it, on the MLS film (the /edit card reads a gap by its video).
  await dout.saveOutputBrief({ outputId: gMls.id, projectId: gapJob.id, sections: { limitations: "No twilight." }, actor: "Kyle Drill" });
  await prisma.productionGap.create({
    data: { projectId: gapJob.id, outputId: gMls.id, kind: "SHOT", what: "Twilight exteriors ($200 add-on)", reason: "The client owes $200 for the twilight. The sky clouded over.", raisedBy: "Kyle Drill", scopeNote: "Front only. Invoice the client $200.", shotListJson: JSON.stringify([{ shot: "Front at dusk", note: "billed at $200" }]) },
  });
  const gapWords = (p: PortalEl) => JSON.stringify((p.props.gaps as { what: string; reason: string; scopeNote: string | null; shotList: unknown[] }[]).map((g) => [g.what, g.reason, g.scopeNote, g.shotList]));
  await asHarrison();
  const hGap = await portalOf(UploadPage, gapJob.id);
  const hWords = gapWords(hGap);
  c.ok("the brief's limitation raised as missing work", raisedGap.ok && (hGap.props.gaps as unknown[]).length === 2);
  c.ok("the photographer's page is handed both gaps with no figure in any word", !/\$|175|200/.test(hWords) && hWords.includes("No aerials.") && hWords.includes("The sky clouded over.") && hWords.includes("Front only.") && hWords.includes("Front at dusk"), hWords);
  const gapHtml = text(render([{ name: "g", file: PORTAL, exp: "UploadPortal", props: portalProps(hGap.props), fns: ["onBriefNote"] }]).g ?? "");
  // The missing-work list alone (the page's own copy elsewhere mentions a $1 production charge).
  const mwAt = gapHtml.indexOf("Missing work No aerials.");
  const mwList = mwAt >= 0 ? gapHtml.slice(mwAt, gapHtml.indexOf("Scope: Front only.", mwAt) + 40) : "";
  c.ok("…and the rendered list shows the missing work, no price", mwList.includes("No aerials.") && mwList.includes("Twilight exteriors") && mwList.includes("The sky clouded over.") && !/\$|175|200/.test(mwList), mwList || gapHtml.slice(0, 300));
  c.ok("…nowhere on the page either", !gapHtml.includes("$175") && !gapHtml.includes("$200") && !gapHtml.includes("Invoice the client"));
  await establishSession(kyle.id);
  const kGap = await portalOf(UploadPage, gapJob.id);
  c.ok("the office's upload page keeps its own words (the Plan form is filled from them)", gapWords(kGap).includes("$200") && gapWords(kGap).includes("Invoice the client $200."));
  const cardWords = async (outputId: string) => {
    try {
      const tree = await EditPage({ params: Promise.resolve({ id: gapJob.id }), searchParams: Promise.resolve({ output: outputId }) });
      return words(find(tree, (e) => e.props?.id === `brief-${outputId}`)[0]).join(" ").replace(/\s+/g, " ");
    } catch (e) {
      return `PAGE_ERROR ${(e as Error).message}`;
    }
  };
  const kyleMls = await cardWords(gMls.id);
  c.ok("the office's /edit/<id> card: the gap as written", kyleMls.includes("Missing work raised by Kyle Drill : Twilight exteriors ($200 add-on)"), kyleMls.slice(0, 300));
  await establishSession(kim.id);
  const kimReel = await cardWords(gReel.id);
  const kimMls = await cardWords(gMls.id);
  c.ok("the editor's /edit/<id>: the reel's card says the missing work, without the price", kimReel.includes("Missing work raised by Kyle Drill : No aerials. (Standard Reel)") && !/\$|175/.test(kimReel), kimReel.slice(0, 300));
  c.ok("…and a gap written with a price in it reaches the editor with the figure withheld", kimMls.includes("Missing work raised by Kyle Drill : Twilight exteriors ([amount withheld] add-on)") && !/\$|200/.test(kimMls), kimMls.slice(0, 300));

  // =========================================================================
  c.head("6 · which videos the page shows");
  // =========================================================================
  await asHarrison();
  const oneP = await portalOf(UploadPage, one.id);
  c.ok("a one-video job with no brief of its own: none (the instructions box is its brief)", Array.isArray(briefsOf(oneP)) && briefsOf(oneP)!.length === 0);
  await dout.saveOutputBrief({ outputId: one.outs[0].id, projectId: one.id, sections: { purpose: "Just-listed teaser" }, actor: "Kyle Drill" });
  const oneP2 = await portalOf(UploadPage, one.id);
  c.ok("…once the office briefs it, it shows", briefsOf(oneP2)?.length === 1 && briefsOf(oneP2)![0].sections.some((x) => x.text === "Just-listed teaser"));

  const f = await buildContentMonth(prisma as never, {
    name: "Portal Briefs Session TEST",
    package: "Starter",
    videosPerMonth: 3,
    owner: false,
    project: { title: "Content session, Portal Briefs TEST", status: "SCHEDULED", shootDate: et(23, 10) },
    appointments: [{ startAt: et(23, 10) }],
    topics: [
      { title: "The market update nobody gives you", selection: "SELECTED" },
      { title: "Staging on a budget", selection: "SELECTED" },
    ],
  });
  const sid = f.projectId!;
  await prisma.project.update({ where: { id: sid }, data: { photographerId: harrisonTm } });
  await dout.ensureOutputsForProject(sid);
  const sOuts = await dout.outputsForProject(sid);
  const sP = await portalOf(UploadPage, sid);
  c.ok("a content session with nothing briefed one by one: no brief block (the topic list directs it)", sOuts.length >= 2 && Array.isArray(briefsOf(sP)) && briefsOf(sP)!.length === 0, `${sOuts.length} videos owed`);
  await dout.saveOutputBrief({ outputId: sOuts[0].id, projectId: sid, sections: { direction: "Open on the skyline" }, actor: "Kyle Drill" });
  const sP2 = await portalOf(UploadPage, sid);
  c.ok("…the one video the office briefed shows, alone", briefsOf(sP2)?.length === 1 && briefsOf(sP2)![0].outputId === sOuts[0].id);

  // =========================================================================
  c.head("7 · the stale Script Studio warning is a listing job's alone");
  // =========================================================================
  const sessionView = (await getShoot(sid))!;
  const listingView = (await getShoot(two.id))!;
  c.ok("the shoot reader: the content session has a session brief, the listing job none", !!sessionView.session && listingView.session === null);
  const oldSP = await portalOf(OldUploadPage, sid);
  const shootProps = (view: unknown) => JSON.parse(JSON.stringify({ view, pay: null, map: null, media: null, chat: null, whenText: "Today, 10:00 AM", timing: "today" }));
  const sh = render([
    { name: "oldSession", file: OLD_SHOOT, exp: "ShootScreen", props: shootProps(sessionView) },
    { name: "newSession", file: SHOOT, exp: "ShootScreen", props: shootProps(sessionView) },
    { name: "newListing", file: SHOOT, exp: "ShootScreen", props: shootProps(listingView) },
    { name: "oldPortalSession", file: OLD_PORTAL, exp: "UploadPortal", props: portalProps(oldSP.props) },
    { name: "newPortalSession", file: PORTAL, exp: "UploadPortal", props: portalProps(sP2.props), fns: ["onBriefNote"] },
  ]);
  const bad = Object.entries(sh).filter(([, h]) => !h || h.startsWith("RENDER_ERROR"));
  c.ok("the screens rendered", Object.keys(sh).length === 5 && bad.length === 0, bad.map(([k, h]) => `${k}: ${h.slice(0, 200)}`).join(" / "));
  // The warning's own words, apostrophes aside (the screen prints a curly one).
  const warns = (h: string | undefined) => /No script yet\. This reel.s script is written in Script Studio/.test(text(h ?? ""));
  c.ok("OLD ShootScreen: a content session is told its script is coming from Script Studio", warns(sh.oldSession));
  c.ok("NEW ShootScreen: not on a content session", !warns(sh.newSession) && !text(sh.newSession ?? "").includes("No script yet"));
  c.ok("NEW ShootScreen: still on a listing job with no script", warns(sh.newListing));
  c.ok("the portal's own Studio line: OLD said it on a content session, NEW does not",
    text(sh.oldPortalSession ?? "").includes("No script found in Script Studio") && !text(sh.newPortalSession ?? "").includes("No script found in Script Studio"));
  c.ok("…and the session's portal shows the video the office briefed", text(sh.newPortalSession ?? "").includes("Open on the skyline"));
  c.ok("a listing job's portal keeps the Studio line", newHtml.includes("No script found in Script Studio"));

  // =========================================================================
  c.head("8 · isolation");
  // =========================================================================
  c.ok("no call left this machine", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  cleanUp();
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

/** The old copies: the symlink FIRST (never follow it into the repo's node_modules), then the folders. */
function cleanUp() {
  try { fs.unlinkSync(path.join(tmp, "node_modules")); } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* best effort */ }
}

main().catch((e) => {
  console.error(e);
  cleanUp();
  process.exit(1);
});
