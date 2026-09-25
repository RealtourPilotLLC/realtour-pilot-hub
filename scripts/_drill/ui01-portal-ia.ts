// ---------------------------------------------------------------------------
// DRILL: UI-01 — the client portal's information architecture (completion
// audit §6, Sep 24 2026): Home · My Plan · Content Library · Schedule · More,
// served as "v2" behind `portal_layout_v2`, with today's page ("v1") left as
// it was for every real client.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/ui01-portal-ia.ts
//
// OLD behaviour first, wherever it can be observed: the HEAD PortalPage.tsx
// (the commit this batch starts from) is loaded for real, its `@/` imports
// pointed at this tree, and rendered side by side with the new one.
//
//   1. The address map (pure): every old ?tab= key lands on its v2 home; every
//      v2 key degrades to a v1 tab; every link is query-only and token-free.
//   2. Layout selection: no switch row → a real client's link, a real
//      client's person and staff without ?layout=v2 all get v1; a TEST client
//      and a staff ?layout=v2 preview get v2; a client asking for v2 does not;
//      the switch on → everyone.
//   3. v1 untouched: for a real client, the new page's element tree is the
//      HEAD page's element tree on every old tab (and old aliases).
//   4. Home: ONE primary action — reviews first, the waiting script second;
//      approving the script (the shipped path, with the version the page
//      rendered) removes it; an ENDED program gets no action at all.
//   5. My Plan: the month / scripts / bank partition; every waiting script
//      carries the version id its decision must send (R1).
//   6. Content Library: the videos waiting on review are found wherever they
//      page; search is case-insensitive and never crosses clients; month-less
//      rows are Previous content.
//   7. More: Resources is listed only once a guide is PUBLISHED.
//   8. The frame: five 48px phone tabs, one [data-primary-action] on Home,
//      and no link carrying a path or the token.
//
// ISOLATION: PGlite on 127.0.0.1:5534 via the shared harness. Production is
// never opened; every outbound call is fenced and counted; nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import type { PortalViewer } from "@/lib/portal";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5534);
const REPO = path.resolve(__dirname, "../..");
const BASE = "7d0d5c9"; // the commit UI-01 starts from

// ---- modules that cannot load under the react-server build of React --------
// lucide-react builds its icons on React.createContext and next/link is a
// client module; the page is CALLED here and its element tree read, so both
// only have to exist. Icons keep their names so a tree still says which one.
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
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
const ISO = /(\d{4}-\d\d-\d\dT\d\d:\d\d):\d\d\.\d{3}Z/g;
/** A stable picture of a tree: element types by name, props by value, functions as "[fn]", times to the minute. */
function ser(n: any, seen = new WeakSet<object>()): any {
  if (n === null || n === undefined || typeof n === "boolean") return null;
  if (typeof n === "string") return n.replace(ISO, "$1");
  if (typeof n === "number") return n;
  if (typeof n === "function") return `[fn ${n.name || "anon"}]`;
  if (n instanceof Date) return n.toISOString().replace(ISO, "$1");
  if (n instanceof Map) return ser(Object.fromEntries(n), seen);
  if (n instanceof Set) return ser([...n], seen);
  if (Array.isArray(n)) return n.map((x) => ser(x, seen));
  if (typeof n === "object") {
    if (seen.has(n)) return "[cycle]";
    seen.add(n);
    if (isEl(n)) return { type: typeName(n.type), key: n.key, props: ser(n.props, seen) };
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, ser(v, seen)]));
  }
  return String(n);
}
/** Every element in a tree, expanding the named SERVER components (plain functions, no hooks) so their markup is searchable too. */
function walk(n: any, visit: (e: El) => void, expand: Set<string> = new Set()) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit, expand)); return; }
  if (!isEl(n)) return;
  visit(n);
  if (typeof n.type === "function" && expand.has(n.type.name)) walk(n.type(n.props), visit, expand);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit, expand);
}
const find = (tree: any, name: string, expand?: Set<string>) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }, expand); return out; };
/** Where two pictures first differ — so a failure names the prop, not just "different". */
function firstDiff(a: any, b: any, at = "root"): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  }
  return `${at}: ${JSON.stringify(a)?.slice(0, 140)} ≠ ${JSON.stringify(b)?.slice(0, 140)}`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** HEAD's PortalPage.tsx, runnable: its `@/` imports pointed at this tree. */
function writeBasePage(): { dir: string; file: string; src: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui01-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/components/portal/PortalPage.tsx`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, "PortalPage.base.tsx");
  // Outside the repo tsconfig's "jsx": "react-jsx" does not reach the copy; the
  // pragma gives it the same automatic runtime, so the two trees are comparable.
  fs.writeFileSync(file, `/** @jsxRuntime automatic */\n/** @jsxImportSource react */\n${src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)}`);
  return { dir, file, src };
}
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const base = writeBasePage();
  const { prisma } = await import("@/lib/prisma");
  const nav = await import("@/lib/portalNav");
  const home = await import("@/lib/portalHome");
  const { portalLayoutDecision } = await import("@/lib/portalLayout");
  const portal = await import("@/lib/portal");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const { portalVideoList } = await import("@/lib/contentVideos");
  const { libraryRows } = await import("@/lib/portalLayout");
  const { PortalPage } = await import("@/components/portal/PortalPage");
  const OldPage = (await import(base.file)) as { PortalPage: (p: Record<string, unknown>) => Promise<unknown> };
  const monthKey = etMonthKey();

  try {
    // =======================================================================
    c.head("0 · OLD (HEAD): six tabs, no plan, no single next step");
    // =======================================================================
    const legacySrc = /const LEGACY_TABS: Record<string, PortalTab> = (\{[^}]+\});/.exec(base.src)?.[1] ?? "{}";
    const HEAD_LEGACY = JSON.parse(legacySrc.replace(/(\w+):/g, '"$1":')) as Record<string, string>;
    const headTabOf = (raw: string | undefined) => HEAD_LEGACY[raw ?? ""] ?? "home";
    c.ok("OLD: the address map knew no plan, library-as-destination, brand or more", !("plan" in HEAD_LEGACY) && !("brand" in HEAD_LEGACY) && !("more" in HEAD_LEGACY), Object.keys(HEAD_LEGACY).join(","));
    c.ok("OLD: the phone bar had no Schedule (booking hid behind More)", /const PHONE_BAR: PortalTab\[\] = \["home", "videos", "topics", "strategy"\];/.test(base.src));
    c.ok("OLD: Resources was a primary tab whether or not a guide existed", /\{ key: "resources", label: "Resources"/.test(base.src));
    const headHome = show("src/components/portal/tabs/HomeTab.tsx");
    c.ok("OLD: Home's 'Next up' had no script-approval step and up to five equal rows", !/script/i.test(headHome.slice(headHome.indexOf("const actions"), headHome.indexOf("return ("))) && /actions\.slice\(0, 5\)/.test(headHome));
    c.ok("OLD: the portal had no portal_layout_v2 switch", !show("src/lib/programAutomation.ts").includes("portal_layout_v2"));

    // =======================================================================
    c.head("1 · the address map (pure)");
    // =======================================================================
    const expect: Record<string, [string, string | null]> = {
      home: ["home", null], videos: ["library", null], library: ["library", null], topics: ["plan", "bank"], ideas: ["plan", "bank"],
      strategy: ["plan", "strategy"], schedule: ["schedule", null], resources: ["resources", null], messages: ["messages", null],
      profile: ["brand", null], settings: ["team", null], team: ["team", null], terms: ["terms", null], garbage: ["home", null], "": ["home", null],
      plan: ["plan", "month"], brand: ["brand", null], more: ["more", null],
    };
    const wrong = Object.entries(expect).filter(([k, [d, pv]]) => { const r = nav.resolvePortalRoute({ tab: k || undefined }); return r.dest !== d || r.planView !== pv; });
    c.ok("every old and new ?tab= key lands on its v2 destination (unknown → Home)", wrong.length === 0, wrong.map(([k]) => k).join(",") || `${Object.keys(expect).length} keys`);
    c.ok("undefined → Home", nav.resolvePortalRoute({}).dest === "home");
    c.ok("?tab=plan&pv=scripts / bank / strategy pick the subview; a bad pv is the month", nav.resolvePortalRoute({ tab: "plan", pv: "scripts" }).planView === "scripts" && nav.resolvePortalRoute({ tab: "plan", pv: "strategy" }).v1Tab === "strategy" && nav.resolvePortalRoute({ tab: "plan", pv: "../x" }).planView === "month");
    const oldKeys = [...Object.keys(HEAD_LEGACY), "garbage", undefined];
    const v1Drift = oldKeys.filter((k) => nav.resolvePortalRoute({ tab: k }).v1Tab !== headTabOf(k));
    c.ok("v1: every key HEAD knew still opens the SAME v1 tab (and garbage still Home)", v1Drift.length === 0, v1Drift.join(",") || `${oldKeys.length} keys`);
    const v1Tabs = new Set(["home", "videos", "topics", "strategy", "schedule", "resources", "messages", "profile", "settings", "terms"]);
    const degrade = { plan: "topics", library: "videos", brand: "profile", team: "settings", more: "home", messages: "messages" } as Record<string, string>;
    c.ok("v1: the new keys degrade to the nearest old tab (plan→topics, brand→profile, more→home …)", Object.entries(degrade).every(([k, t]) => nav.resolvePortalRoute({ tab: k }).v1Tab === t) && nav.resolvePortalRoute({ tab: "plan", pv: "strategy" }).v1Tab === "strategy");
    c.ok("every v2 destination has a valid v1 tab", nav.PORTAL_DESTS.every((d) => v1Tabs.has(nav.resolvePortalRoute({ tab: d }).v1Tab)));
    const hrefs = [
      ...nav.PORTAL_DESTS.flatMap((d) => [nav.portalHref("", d), nav.portalHref("e=ckenroll0001", d), nav.portalHref("e=ckenroll0001&layout=v2", d, "v=abc")]),
      ...["topics", "videos", "strategy", "profile", "settings", "home"].flatMap((t) => [nav.v2HrefFor("")(t), nav.v2HrefFor("e=ckenroll0001")(t, "iv=ivabc123456")]),
    ];
    c.ok("every href is query-only: starts with '?', no path segment", hrefs.every((h) => h.startsWith("?") && !h.includes("/")), hrefs.find((h) => !h.startsWith("?") || h.includes("/")) ?? `${hrefs.length} hrefs`);
    c.ok("extras survive: v2HrefFor('topics','iv=…') keeps the interview id and names the bank", nav.v2HrefFor("e=x1")("topics", "iv=ivabc123456") === "?e=x1&tab=plan&pv=bank&iv=ivabc123456");
    c.ok("the search form repeats e= and layout=, never tab", JSON.stringify(nav.baseQueryPairs("e=x1&layout=v2&tab=home")) === JSON.stringify([["e", "x1"], ["layout", "v2"]]));

    // ---- fixtures ----------------------------------------------------------
    // A REAL-named client (the fixture builder refuses names without TEST,
    // on purpose, so this one is made by hand — on PGlite only).
    const realClient = await prisma.client.create({ data: { name: "Harper Lane Realty", socialClient: true, socialPlan: "Accelerator" }, select: { id: true } });
    const realToken = "ui01RealClientToken_abcdefghijklmnop";
    const realE = await prisma.contentEnrollment.create({ data: { clientId: realClient.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-08-01T04:00:00Z"), portalToken: realToken, portalTokenIssuedAt: new Date() }, select: { id: true } });
    const realMonth = await prisma.contentMonth.create({ data: { enrollmentId: realE.id, clientId: realClient.id, monthKey, videosOwed: 4, status: "OPEN" }, select: { id: true } });
    await prisma.contentTopic.create({ data: { enrollmentId: realE.id, clientId: realClient.id, title: "Why Harper prices homes to sell", source: "staff", status: "IDEA" } });
    await prisma.contentVideo.create({ data: { enrollmentId: realE.id, clientId: realClient.id, monthId: realMonth.id, monthKey, title: "Kitchen reveal cut", status: "CLIENT_REVIEW", currentSubmissionId: "sub-real-kitchen-1" } });
    const realR = await portal.resolvePortalViewer({ token: realToken });
    if (!realR.ok) throw new Error("real client viewer did not resolve");
    const realTokenViewer = realR.viewer;
    const staffOf = (v: PortalViewer): PortalViewer => ({ ...v, actor: { kind: "STAFF", staffUserId: "staff-drill-1", staffName: "Kyle Drill", staffRole: "ADMIN" }, via: "STAFF" });
    const clientOf = (v: PortalViewer, membershipId = "m-real-1"): PortalViewer => ({ ...v, actor: { kind: "CLIENT", clientUserId: "cu-real-1", email: "owner@example.com", name: "Harper Lane", membershipId, membershipRole: "OWNER" }, via: "LOGIN" });

    const T = await buildContentMonth(prisma as never, { name: "Ada Vance TEST", package: "Accelerator", monthKey, project: false, topics: [{ title: "Kitchen reveal walkthrough", selection: "SELECTED" }, { title: "Market update for October", selection: "SELECTED" }, { title: "Staging on a budget" }] });
    const testR = await portal.resolvePortalViewer({ token: T.portalToken! });
    if (!testR.ok) throw new Error("TEST client viewer did not resolve");
    const testTokenViewer = testR.viewer;
    const testOwner: PortalViewer = { ...testTokenViewer, actor: { kind: "CLIENT", clientUserId: T.clientUserId!, email: "owner@example.com", name: "Ada Vance", membershipId: T.membershipId!, membershipRole: "OWNER" }, via: "LOGIN" };

    // =======================================================================
    c.head("2 · which layout a visit gets (no switch row = OFF)");
    // =======================================================================
    c.ok("no portal_layout_v2 row exists (nothing seeded it)", (await prisma.programAutomation.count({ where: { key: "portal_layout_v2" } })) === 0);
    const L = (v: PortalViewer, name: string, layout?: string) => portalLayoutDecision(v, name, { layout });
    c.ok("a real client's link → v1", (await L(realTokenViewer, "Harper Lane Realty")).layout === "v1");
    c.ok("a real client's signed-in person asking ?layout=v2 → still v1 (clients cannot opt in)", (await L(clientOf(realTokenViewer), "Harper Lane Realty", "v2")).layout === "v1");
    c.ok("staff looking at a real client without ?layout=v2 → v1 (they see what the client sees)", (await L(staffOf(realTokenViewer), "Harper Lane Realty")).layout === "v1");
    const pv = await L(staffOf(realTokenViewer), "Harper Lane Realty", "v2");
    c.ok("staff with ?layout=v2 → v2, as a preview", pv.layout === "v2" && pv.why === "STAFF_PREVIEW");
    const tv = await L(testTokenViewer, "Ada Vance TEST");
    c.ok("a TEST client → v2 always", tv.layout === "v2" && tv.why === "TEST_CLIENT");

    // =======================================================================
    c.head("3 · v1 untouched: a real client's page is HEAD's page, tab for tab");
    // =======================================================================
    const tabs = ["home", "videos", "topics", "strategy", "schedule", "resources", "messages", "profile", "settings", "terms", "library", "ideas", "team", "garbage"];
    const drift: string[] = [];
    for (const t of tabs) {
      const query = { tab: t };
      const oldTree = await OldPage.PortalPage({ viewer: realTokenViewer, tab: headTabOf(t), path: "/portal/[token]", query });
      const newTree = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query });
      const d = firstDiff(ser(oldTree), ser(newTree));
      if (d) drift.push(`${t} → ${d}`);
    }
    c.ok(`the element tree is identical to HEAD on all ${tabs.length} tabs and aliases`, drift.length === 0, drift[0] ?? "");
    for (const extra of drift.slice(1, 4)) console.log(`     also: ${extra}`);
    const v1Home = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "home" } });
    c.ok("…and it is the v1 frame, not PortalShell", isEl(v1Home) && v1Home.type === "div" && find(v1Home, "PortalShell").length === 0 && find(v1Home, "HomeTab").length === 1);
    // v2 keys on v1 open the nearest old tab.
    const v1Plan = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "plan", pv: "strategy" } });
    const v1Lib = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "library" } });
    const v1Brand = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "brand" } });
    c.ok("v1: ?tab=plan&pv=strategy → My Strategy, ?tab=library → My Videos, ?tab=brand → the brand profile", find(v1Plan, "StrategyTab").length === 1 && find(v1Lib, "VideosList").length === 1 && find(v1Brand, "PortalProfile").length === 1);
    const staffV1 = await PortalPage({ viewer: staffOf(realTokenViewer), path: "/portal/[token]", query: { tab: "home" } });
    const previewLinks: string[] = [];
    walk(staffV1, (e) => { if (typeName(e.type) === "Link" && typeof e.props.href === "string" && e.props.href.includes("layout=v2")) previewLinks.push(e.props.href); });
    c.ok("staff on v1 get one way into the preview (…&layout=v2); the client's own page has none", previewLinks.length === 1 && previewLinks[0] === "?tab=home&layout=v2" && JSON.stringify(ser(v1Home)).indexOf("layout=v2") === -1, previewLinks.join(" "));
    const staffV2 = await PortalPage({ viewer: staffOf(realTokenViewer), path: "/portal/[token]", query: { tab: "library", layout: "v2" } });
    const navHrefs = isEl(staffV2) ? (staffV2.props.nav.primary as { href: string }[]).map((i) => i.href) : [];
    c.ok("a staff preview is PortalShell and its links keep layout=v2", isEl(staffV2) && typeName(staffV2.type) === "PortalShell" && navHrefs.length === 5 && navHrefs.every((h) => h.includes("layout=v2")), navHrefs[1]);

    // The switch, then back off (update, never a second create: 23505 would end the socket).
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
    const on = await L(realTokenViewer, "Harper Lane Realty");
    c.ok("switch ON → the real client's link gets v2", on.layout === "v2" && on.why === "SWITCH_ON");
    const onPage = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "home" } });
    const onNav = isEl(onPage) ? (onPage.props.nav.primary as { href: string }[]).map((i) => i.href) : [];
    c.ok("…and its links carry no layout=v2 (nothing in the address is needed)", onNav.length === 5 && onNav.every((h) => !h.includes("layout")), onNav.join(" "));
    await prisma.programAutomation.update({ where: { key: "portal_layout_v2" }, data: { enabled: false } });
    c.ok("switch OFF (enabled=false) → v1 again", (await L(realTokenViewer, "Harper Lane Realty")).layout === "v1");

    // =======================================================================
    c.head("4 · Home: one next step, in priority order");
    // =======================================================================
    // A script shared with the TEST client, undecided; a video waiting on review.
    const topic0 = T.topicIds[0];
    const script = await prisma.contentScript.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, monthId: T.monthId, topicId: topic0, title: "Kitchen reveal walkthrough", body: "v1 body", status: "APPROVED", releaseState: "released" }, select: { id: true } });
    const ver = await prisma.contentScriptVersion.create({ data: { scriptId: script.id, enrollmentId: T.enrollmentId, clientId: T.clientId, versionNo: 1, title: "Kitchen reveal walkthrough", hook: "Three things buyers see first", pointsJson: "[]", close: "Call me before you list.", body: "v1 body", source: "AI", status: "SHARED" }, select: { id: true } });
    await prisma.contentScript.update({ where: { id: script.id }, data: { sharedVersionId: ver.id, approvedVersionId: ver.id, sharedAt: new Date() } });
    const reviewVideo = await prisma.contentVideo.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, monthId: T.monthId, monthKey, title: "Market update cut", status: "CLIENT_REVIEW", currentSubmissionId: "sub-test-market-1" }, select: { id: true } });

    const homeOf = async (v: PortalViewer) => {
      const tree = await PortalPage({ viewer: v, path: "/portal/[token]", query: { tab: "home" } });
      const hv = find(tree, "HomeV2")[0];
      return { tree, hv, actions: hv?.props.actions as { primary: { kind: string; count: number; href: string } | null; more: { kind: string; count: number }[] } | undefined };
    };
    const h1 = await homeOf(testOwner);
    c.ok("the TEST client's Home is v2 (HomeV2 inside PortalShell)", !!h1.hv && isEl(h1.tree) && typeName(h1.tree.type) === "PortalShell");
    c.ok("primary = REVIEW_VIDEOS (the one item with a clock), straight to that video", h1.actions?.primary?.kind === "REVIEW_VIDEOS" && h1.actions.primary.href === `?tab=library&v=${reviewVideo.id}`, `${h1.actions?.primary?.kind} ${h1.actions?.primary?.href}`);
    const ap = h1.actions?.more.find((a) => a.kind === "APPROVE_SCRIPTS");
    c.ok("…and 'Also waiting' holds APPROVE_SCRIPTS, count 1", ap?.count === 1, h1.actions?.more.map((a) => a.kind).join(","));
    c.ok("the order is HOME_PRIORITY's", (() => { const ks = [h1.actions?.primary?.kind, ...(h1.actions?.more ?? []).map((a) => a.kind)].filter(Boolean) as string[]; const r = ks.map((k) => home.HOME_PRIORITY.indexOf(k as never)); return r.every((x, i) => i === 0 || x > r[i - 1]); })());
    const expanded = new Set(["HomeV2", "PortalShell", "MonthCardV2"]);
    const primaries: El[] = [];
    walk(h1.hv, (e) => { if (e.props["data-primary-action"] !== undefined) primaries.push(e); }, expanded);
    c.ok("Home renders exactly one [data-primary-action]", primaries.length === 1, String(primaries.length));

    const { clientApproveScript } = await import("@/lib/scriptDecisions");
    const topicsBefore = await portal.portalTopics(testOwner.enrollment);
    const waitingScript = home.planModel(topicsBefore, monthKey).scripts[0];
    const approved = await clientApproveScript(testOwner, waitingScript.script!.id, waitingScript.script!.sharedVersionId!);
    c.ok("the shipped approval, sent with the version the page rendered, is accepted", approved.ok, approved.message);
    const h2 = await homeOf(testOwner);
    c.ok("after it, APPROVE_SCRIPTS is gone from Home", !!h2.actions && ![h2.actions.primary, ...h2.actions.more].some((a) => a?.kind === "APPROVE_SCRIPTS"), [h2.actions?.primary?.kind, ...(h2.actions?.more ?? []).map((a) => a.kind)].join(","));

    // Pure: the rule a paused/ended program follows.
    const blankInput = { status: "ENDED", readOnly: true, perms: { session: true, suggest: true, request: true, approve: true, profile: true }, review: { count: 2, single: null, soonestDeadlineLabel: null }, scripts: [{ topicId: "t", title: "x" }], unread: 0, planning: { planningMode: "CALL", callStatus: "NOT_SCHEDULED" }, month: { monthKey, label: "x", owed: 4, selected: 1 }, toAnswer: [], session: { offerBooking: true, required: 1, missing: 1 }, addressNeeded: 1, setup: { complete: false, remaining: 3 }, ready: { count: 1, withFile: true, single: null } };
    const ended = home.homeActions(blankInput);
    c.ok("ENDED (pure): {primary: null, more: []} whatever else is true", ended.primary === null && ended.more.length === 0);
    // A call month and a written month are the two planning paths: BOOK_CALL
    // belongs to one, ANSWER_QUESTIONS to the other, never both.
    const active = home.homeActions({ ...blankInput, status: "ACTIVE", readOnly: false, unread: 2 });
    const kinds = (r: ReturnType<typeof home.homeActions>) => [r.primary!, ...r.more].map((a) => a.kind).join(",");
    c.ok("ACTIVE, call month, everything true: every kind in HOME_PRIORITY order", kinds(active) === home.HOME_PRIORITY.filter((k) => k !== "ANSWER_QUESTIONS").join(","), kinds(active));
    const written = home.homeActions({ ...blankInput, status: "ACTIVE", readOnly: false, planning: { planningMode: "WRITTEN", callStatus: "NOT_REQUIRED" }, toAnswer: [{ title: "Kitchen" }] });
    c.ok("…a written month asks for the answers instead of the call", kinds(written) === home.HOME_PRIORITY.filter((k) => k !== "BOOK_CALL" && k !== "READ_REPLY").join(","), kinds(written));
    const viewerSeat = home.homeActions({ ...blankInput, status: "ACTIVE", readOnly: false, perms: { session: false, suggest: false, request: false, approve: false, profile: false } });
    c.ok("a view-only seat is never asked to review, approve, book or set up — only to download", [viewerSeat.primary, ...viewerSeat.more].filter(Boolean).map((a) => a!.kind).join(",") === "DOWNLOAD");
    await prisma.contentEnrollment.update({ where: { id: T.enrollmentId }, data: { status: "ENDED" } });
    const endedR = await portal.resolvePortalViewer({ token: T.portalToken! });
    const h3 = endedR.ok ? await homeOf(endedR.viewer) : null;
    c.ok("ENDED through the page: no primary, nothing else waiting", !!h3?.actions && h3.actions.primary === null && h3.actions.more.length === 0);
    await prisma.contentEnrollment.update({ where: { id: T.enrollmentId }, data: { status: "ACTIVE" } });

    // =======================================================================
    c.head("5 · My Plan: month / scripts / bank");
    // =======================================================================
    // A second shared, undecided script — on the bank topic — so the scripts view has one to show.
    const topic2 = T.topicIds[2];
    const s2 = await prisma.contentScript.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, topicId: topic2, title: "Staging on a budget", body: "b", status: "APPROVED", releaseState: "released" }, select: { id: true } });
    const v2row = await prisma.contentScriptVersion.create({ data: { scriptId: s2.id, enrollmentId: T.enrollmentId, clientId: T.clientId, versionNo: 1, title: "Staging on a budget", hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "SHARED" }, select: { id: true } });
    await prisma.contentScript.update({ where: { id: s2.id }, data: { sharedVersionId: v2row.id, sharedAt: new Date() } });
    const pm = home.planModel(await portal.portalTopics(testOwner.enrollment), monthKey);
    c.ok("month = this month's selections only", pm.monthTopics.length === 2 && pm.monthTopics.every((t) => t.selection?.monthId === T.monthId), pm.monthTopics.map((t) => t.title).join(" | "));
    c.ok("scripts = shared, undecided, readable — the approved one has left", pm.scripts.length === 1 && pm.scripts[0].id === topic2);
    c.ok("R1: every waiting script carries the version its decision must send", pm.scripts.every((t) => !!t.script?.sharedVersionId) && pm.scripts[0].script?.sharedVersionId === v2row.id);
    c.ok("decided scripts are kept apart (the one they approved)", pm.decidedScripts.length === 1 && pm.decidedScripts[0].id === topic0);
    c.ok("bank = not on an open month's plan", pm.bank.length === 1 && pm.bank[0].id === topic2);
    const card = read("src/components/portal/ScriptApprovalCard.tsx");
    c.ok("the decision is sent in ONE place, with script.sharedVersionId, for both answers", /portalApproveScript\(portalAuthFromLocation\(\), script\.id, script\.sharedVersionId \?\? ""\)/.test(card) && /portalRequestScriptChanges\(portalAuthFromLocation\(\), script\.id, changeNote, script\.sharedVersionId \?\? ""\)/.test(card) && !/portalApproveScript|portalRequestScriptChanges/.test(read("src/components/portal/TopicBank.tsx")));
    const planPage = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "plan", pv: "scripts" } });
    const planTab = find(planPage, "PlanTab")[0];
    c.ok("?tab=plan&pv=scripts renders My Plan's Scripts view", planTab?.props.d.view === "scripts" && planTab.props.d.hrefs.bank === "?tab=plan&pv=bank");
    const oldTopics = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "topics", filter: "SELECTED" } });
    const ot = find(oldTopics, "PlanTab")[0];
    c.ok("an old ?tab=topics link lands on the bank, its filter kept", ot?.props.d.view === "bank" && ot.props.d.filter === "SELECTED");
    const iv = await prisma.contentInterview.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, topicId: T.topicIds[1], monthId: T.monthId, status: "NOT_STARTED" }, select: { id: true } }).catch(() => null);
    if (iv) {
      const ivPage = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "topics", iv: iv.id } });
      const ivTab = find(ivPage, "PlanTab")[0];
      c.ok("an old ?tab=topics&iv=<id> reminder link opens those questions inside My Plan", !!ivTab?.props.d.interview && ivTab.props.d.interview.interviewId === iv.id && ivTab.props.d.hrefs.month === "?tab=plan", ivTab?.props.d.interviewFailed ? "interview failed to load" : "");
    } else c.ok("(interview fixture could not be created — schema changed?)", false);

    // =======================================================================
    c.head("6 · Content Library: review first, search, Previous content");
    // =======================================================================
    // 30 videos over three months, newest first; the three waiting on review
    // are in the OLDEST month, so a 24-row first page cannot show them.
    const months = [monthKey, prevKey(monthKey, 1), prevKey(monthKey, 2)];
    const monthIds: string[] = [T.monthId];
    for (const k of months.slice(1)) monthIds.push((await prisma.contentMonth.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, monthKey: k, videosOwed: 4, status: "CLOSED" }, select: { id: true } })).id);
    await prisma.contentVideo.update({ where: { id: reviewVideo.id }, data: { status: "APPROVED", approvedSubmissionId: "sub-test-market-1" } });
    const lateIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const m = i < 12 ? 0 : i < 24 ? 1 : 2;
      const review = i >= 27;
      const row = await prisma.contentVideo.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, monthId: monthIds[m], monthKey: months[m], title: review ? `KITCHEN refresh ${i}` : `Listing tour ${i}`, status: review ? "CLIENT_REVIEW" : "DELIVERED", deliveredAt: review ? null : new Date(Date.now() - i * 3_600_000), currentSubmissionId: review ? `sub-late-${i}` : null }, select: { id: true } });
      if (review) lateIds.push(row.id);
    }
    const prevRow = await prisma.contentVideo.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, monthKey: null, title: "Old kitchen teaser", status: "DELIVERED", deliveredAt: new Date("2025-03-01T15:00:00Z") }, select: { id: true } });
    const page1 = await portalVideoList(testOwner.enrollment, { page: 1, perPage: 24 });
    c.ok("OLD: the paged list's first page holds none of the three waiting videos", page1.rows.filter((r) => lateIds.includes(r.id)).length === 0 && page1.pages > 1, `page 1 of ${page1.pages}`);
    const all = await libraryRows(testOwner.enrollment);
    const lv = home.libraryView(all.rows, {});
    c.ok("NEW: review-first finds all three, whatever page they sit on", lv.review.length === 3 && lv.review.every((r) => lateIds.includes(r.id)));
    const libPage = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "videos" } });
    const lib = find(libPage, "LibraryV2")[0];
    c.ok("…and the page's Library shows them in its 'Needs your review' section", (lib?.props.d?.view.review ?? []).length === 3);
    c.ok("state filter st=review returns exactly those three", home.libraryView(all.rows, { st: "review" }).matched === 3);
    const kq = home.libraryView(all.rows, { q: "kitchen" });
    c.ok("q=kitchen is case-insensitive (KITCHEN refresh …, Old kitchen teaser)", kq.matched === 4 && kq.review.length === 3, String(kq.matched));
    c.ok("another client's identically named video never appears", !all.rows.some((r) => r.title === "Kitchen reveal cut"));
    const prev = home.libraryView(all.rows, { perPage: 200 });
    c.ok("a month-less row is Previous content, not under a month", prev.rows.find((r) => r.id === prevRow.id)?.section === "PREVIOUS");
    const searched = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "library", q: "Kitchen", st: "review" } });
    const sv = find(searched, "LibraryV2")[0]?.props.d;
    c.ok("?tab=library&q=Kitchen&st=review reaches the view, and the form repeats nothing but its own fields", sv?.view.q === "Kitchen" && sv.view.st === "review" && sv.view.matched === 3 && JSON.stringify(sv.hidden) === "[]");

    // =======================================================================
    c.head("7 · More: Resources only when a guide is published");
    // =======================================================================
    c.ok("pure: 0 published → no Resources; 1 → listed", !nav.portalNav({ publishedResources: 0 }).more.some((i) => i.dest === "resources") && nav.portalNav({ publishedResources: 1 }).more.some((i) => i.dest === "resources"));
    const moreDests = async () => {
      const t = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "more" } });
      const items = (find(t, "MoreTab")[0]?.props.d.items ?? []) as { dest: string }[];
      const shellMore = (isEl(t) ? t.props.nav.more : []) as { dest: string }[];
      return { items: items.map((i) => i.dest), rail: shellMore.map((i) => i.dest) };
    };
    const m0 = await moreDests();
    c.ok("no guide at all → More and the rail list Brand, Messages, Settings & Team, Terms — no Resources", m0.items.join(",") === "brand,messages,team,terms" && m0.rail.join(",") === m0.items.join(","), m0.items.join(","));
    await prisma.portalResource.create({ data: { slug: "ui01-draft", groupKey: "YOUR_MONTH", title: "How your month works", body: "Draft", published: false } });
    c.ok("a DRAFT guide does not bring it back", !(await moreDests()).items.includes("resources"));
    await prisma.portalResource.create({ data: { slug: "ui01-live", groupKey: "YOUR_MONTH", title: "Reviewing a cut", body: "Pause, note, approve.", published: true } });
    c.ok("one PUBLISHED guide → Resources is listed", (await moreDests()).items.includes("resources"));

    // =======================================================================
    c.head("8 · the frame: phone bar, links, token");
    // =======================================================================
    const homeTree = (await homeOf(testOwner)).tree;
    const shell = isEl(homeTree) ? homeTree : null;
    const expandedShell = shell ? shell.type(shell.props) : null;
    const bars: El[] = [];
    walk(expandedShell, (e) => { if (e.type === "nav" && typeof e.props.className === "string" && e.props.className.includes("bottom-0")) bars.push(e); });
    const barLinks = bars.length ? find(bars[0], "Link") : [];
    c.ok("the phone bar: five items — Home, Plan, Library, Schedule, More", barLinks.length === 5 && barLinks.map((l) => l.props.href).join(",") === "?tab=home,?tab=plan,?tab=library,?tab=schedule,?tab=more", barLinks.map((l) => l.props.href).join(","));
    c.ok("…each at least 48px tall (min-h-12) with a visible focus ring", barLinks.every((l) => /\bmin-h-12\b/.test(l.props.className) && /focus-visible:outline-2/.test(l.props.className)));
    const allHrefs: string[] = [];
    for (const q of [{ tab: "home" }, { tab: "plan" }, { tab: "plan", pv: "scripts" }, { tab: "library" }, { tab: "schedule" }, { tab: "more" }, { tab: "brand" }, { tab: "team" }, { tab: "terms" }, { tab: "messages" }, { tab: "resources" }]) {
      const t = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: q });
      walk(t, (e) => { if (typeof e.props.href === "string") allHrefs.push(e.props.href); }, new Set(["PortalShell", "HomeV2", "MoreTab", "LibraryV2", "PlanTab", "MonthCardV2", "RailLink", "TermsCard", "AppointmentCards", "ScriptsView"]));
    }
    const odd = allHrefs.filter((h) => !(h.startsWith("?") || h.startsWith("#") || h === "/portal/login" || /^https:\/\//.test(h) || /^(tel|sms):\+1\d{10}$/.test(h)));
    c.ok(`every link on eleven v2 pages is query-only (or login / external / tel: / sms:) — ${allHrefs.length} links`, odd.length === 0 && allHrefs.length > 40, odd.slice(0, 3).join(" "));
    c.ok("no link carries the enrollment token", !allHrefs.some((h) => h.includes(T.portalToken!)));

    // ======================================================================
    c.head("9 · the review's portal findings (Sep 24)");
    // ======================================================================
    // Finding 6 — a repeated ?q= (Next hands it over as string[]).
    c.ok("firstQueryValues: the first of a repeated key, strings only", JSON.stringify(nav.firstQueryValues({ q: ["a", "b"], tab: "library", st: undefined, n: 3 })) === JSON.stringify({ q: "a", tab: "library" }));
    const twice = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "library", q: ["Kitchen", "x"] as unknown as string } }).then((t) => ({ t, err: null as string | null }), (e: unknown) => ({ t: null, err: String(e) }));
    const tv2 = twice.t ? find(twice.t, "LibraryV2")[0]?.props.d : null;
    c.ok("?tab=library&q=Kitchen&q=x renders the Library (it threw 'trim is not a function') and searches the first q", !twice.err && tv2?.view.q === "Kitchen" && tv2.view.matched === 4, twice.err ?? `${tv2?.view.q} ${tv2?.view.matched}`);
    c.ok("libraryView itself survives an array (a library function, not only the page)", home.libraryView(all.rows, { q: ["kitchen"] as unknown as string }).matched === 4);

    // Finding 9 — "Try again" only for a send that never got an answer, on the same version.
    c.ok("ScriptApprovalCard: retry is offered only for transport failures, bound to the version on screen", /setRetry\(!r\.ok && r\.transport \? \{ fn: again, versionId: script\.sharedVersionId \?\? null \} : null\)/.test(card) && /retry\.versionId === \(script\.sharedVersionId \?\? null\)/.test(card) && !/setRetry\(r\.ok \? null : \(\) => again\)/.test(card));
    c.ok("OLD: HEAD had no ScriptApprovalCard (the retry arrived with UI-01) — nothing to compare, the rule is asserted on the source", (() => { try { execFileSync("git", ["cat-file", "-e", `${BASE}:src/components/portal/ScriptApprovalCard.tsx`], { cwd: REPO, stdio: "ignore" }); return false; } catch { return true; } })());

    // Finding 10 — the card the client just acted on stays; a just-answered script stays a card.
    const tb = read("src/components/portal/TopicBank.tsx");
    c.ok("TopicBank keeps the card the client just acted on (v2), until the filter or month changes", /const justActed = \(t: PortalTopic\) => v2 && !!msg\?\.topicId && msg\.topicId === t\.id;/.test(tb) && /!t\.scriptedNotFilmed && \(justActed\(t\) \|\|/.test(tb) && /setFilterTouched\(true\); setMsg\(null\);/.test(tb));
    const tNow = await portal.portalTopics(testOwner.enrollment);
    const pmNow = home.planModel(tNow, monthKey);
    const pmLater = home.planModel(tNow, monthKey, new Date(Date.now() + home.JUST_DECIDED_MS + 60_000));
    c.ok("planModel.justDecided: the script approved minutes ago (section 4) — and not once the window has passed", pmNow.justDecided.some((t) => t.id === topic0) && !pmLater.justDecided.some((t) => t.id === topic0), `${pmNow.justDecided.length} / ${pmLater.justDecided.length}`);
    c.ok("…and My Plan's Scripts view renders those as cards in the same keyed list", /plan\.justDecided/.test(read("src/components/portal/tabs/PlanTab.tsx")) && /cards\.map\(\(t\) =>/.test(read("src/components/portal/tabs/PlanTab.tsx")));

    // Finding 15 — the bank's chips are the bank's.
    c.ok("the v2 bank offers All · Suggested · Filmed only, and counts only what is in the bank", /BANK_FILTER_KEYS: readonly \(PortalTopicState \| "ALL"\)\[\] = \["ALL", "SUGGESTED", "FILMED"\]/.test(tb) && /if \(view === "bank" && \(t\.scriptedNotFilmed \|\| !inBank\(t, openIds\)\)\) continue;/.test(tb) && /chosenThisMonth/.test(tb));

    // Findings 13 / 16 — the v2 pages' words and weight.
    const sched = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "schedule" } });
    c.ok("v2 Schedule names 'your plan', not a 'Video Topics' page that is not in the nav", find(sched, "ScheduleTab")[0]?.props.topicsLabel === "your plan");
    const oldSchedV1 = await PortalPage({ viewer: realTokenViewer, path: "/portal/[token]", query: { tab: "schedule" } });
    c.ok("…while v1's Schedule still says Video Topics (no prop passed, its tree is HEAD's)", find(oldSchedV1, "ScheduleTab")[0]?.props.topicsLabel === undefined);
    const hv2 = find((await homeOf(testOwner)).tree, "AppointmentCards", new Set(["HomeV2"]))[0];
    c.ok("v2 Home's appointment cards are quiet (links, not two more orange buttons) and point at the plan", hv2?.props.quiet === true && hv2.props.plan?.label === "Open my plan" && hv2.props.plan?.href === "?tab=plan");
    c.ok("the video-change hint names no page (v1 'My Videos' / v2 'Content Library')", !/My Videos|Content Library/.test((await import("@/lib/programMessages")).VIDEO_CHANGES_HINT));
    const team = await PortalPage({ viewer: testOwner, path: "/portal/[token]", query: { tab: "team" } });
    const st = find(team, "SettingsTab")[0]?.props.d;
    c.ok("v2 Settings & Team links 'Brand Profile' (the nav's word) with Kyle's line, not 'text us'", st?.profileLabel === "Brand Profile" && /Kyle at \(215\) 645-4889/.test(st?.contactLine ?? ""), JSON.stringify({ l: st?.profileLabel, c: st?.contactLine }));
    c.ok("v2 video page calls the pillar a Pillar", /<span>Pillar: \{d\.video\.pillarName\}<\/span>/.test(read("src/components/portal/tabs/VideosTab.tsx")) && !/Topic: \{d\.video\.pillarName\}/.test(read("src/components/portal/tabs/VideosTab.tsx")));

    // Finding 20 — the month card marks extras.
    const hm = read("src/components/portal/tabs/HomeTab.tsx");
    c.ok("Home's month card: '+N waiting' in the heading and each extra tagged", /month\.overflow > 0 \? ` · \+\$\{month\.overflow\} waiting` : ""/.test(hm) && /t\.selection\?\.overflow && <span/.test(hm));

    // Finding 21 — Kyle's line, not "text us".
    const words = await import("@/lib/portalWords");
    const ct = await import("@/components/portal/ContactTeam");
    const { URGENT_CONTACT } = await import("@/lib/reviewWindows");
    c.ok("TEXT_KYLE agrees with the contact card's default and the review window's urgent line", words.TEXT_KYLE.includes(ct.DEFAULT_PORTAL_CONTACT.name) && words.TEXT_KYLE.includes(ct.DEFAULT_PORTAL_CONTACT.display) && words.TEXT_KYLE.endsWith(URGENT_CONTACT) && words.TEXT_KYLE_START.toLowerCase() === words.TEXT_KYLE.toLowerCase());
    const noTextUs = ["src/lib/clientDecisions.ts", "src/lib/brandProfile.ts", "src/lib/portalTeam.ts", "src/lib/scriptDecisions.ts", "src/lib/sessionRequests.ts", "src/lib/postingKit.ts", "src/lib/cutEntitlement.ts", "src/lib/portal.ts", "src/app/api/portal/upload/route.ts", "src/components/portal/tabs/SettingsTab.tsx", "src/components/portal/TopicBank.tsx"];
    const oldHits = noTextUs.filter((f) => { try { return /["`][^"`\n]*\btext us\b/i.test(show(f)); } catch { return false; } });
    const newHits = noTextUs.filter((f) => /["`][^"`\n]*\btext us\b/i.test(read(f).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
    c.ok(`OLD: client-facing 'text us' in ${oldHits.length} of these files`, oldHits.length >= 9, oldHits.join(", "));
    c.ok("NEW: none left in any of them", newHits.length === 0, newHits.join(", "));
    c.ok("the paused/ended banner names Kyle's number", portal.readOnlyNotice("PAUSED").body.includes("(215) 645-4889") && !/text us/i.test(portal.readOnlyNotice("ENDED").body));

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    fs.rmSync(base.dir, { recursive: true, force: true });
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

function prevKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
