// ---------------------------------------------------------------------------
// DRILL: EVERY DOOR OPENS, FOR EVERY ROLE AND EVERY PREVIEW (Oct 23 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-doors-and-previews.ts
//
// Jordan, Oct 23 2026: "When in james account I cant open video delivery It
// just takes me back to his dashboard. Do a full audit on all the changes
// lately and what could have broke and what we may have missed and fix it."
// That one was the Review Room's gate refusing a preview (3f9f53e). This
// drill hunts the whole class, the way a person meets it:
//   · each login (the owner, a second owner login, Kyle, James, Harrison,
//     Kim, John) and the owner previewing each of them ("view as");
//   · the real left menu (components/Sidebar) drawn for that login, and every
//     door on it opened as a page, plus every link on that login's dashboard
//     (its rendered HTML and the hrefs its panels carry);
//   · a door or a link may not send its reader back home, to the login page
//     or to another door, may not 404 or crash, and the proxy (the
//     middleware) must let a real login through to its own doors;
//   · a preview writes nothing: every table's row count and newest update are
//     the same before and after the owner opened every page of every preview.
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Module, { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const stubs = installNextStubs();
// A page that draws a map imports Leaflet's stylesheet; Next bundles it, a drill has nothing to do with it.
(Module as unknown as { _extensions: Record<string, (m: { exports: unknown }) => void> })._extensions[".css"] = (m) => { m.exports = {}; };
type Props = Record<string, unknown>;
const pending: Promise<unknown>[] = [];
interceptModule((r) => r === "next/server", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "after" ? (fn: () => unknown) => { pending.push(Promise.resolve().then(fn).catch(() => undefined)); } : t[k]),
}));
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }) : null));

class Redirect extends Error { constructor(readonly href: string) { super(`redirect ${href}`); } }
class NotFound extends Error { constructor() { super("not found"); } }
let pathnameNow = "/";
const navigation = createRequire(__filename)("next/navigation") as Record<string, unknown>;
navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
navigation.usePathname = () => pathnameNow;
navigation.useSearchParams = () => new URLSearchParams();
navigation.useParams = () => ({});
navigation.redirect = (href: string) => { throw new Redirect(href); };
navigation.permanentRedirect = (href: string) => { throw new Redirect(href); };
navigation.notFound = () => { throw new NotFound(); };

// ---- the app's routes, from the files -------------------------------------------------
const APP = path.resolve(__dirname, "../../src/app");
type Route = { segs: string[]; file: string; dynamic: number };
function walk(dir: string, segs: string[], out: Route[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "api" || e.name.startsWith("_")) continue;
      walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name], out);
    } else if (e.name === "page.tsx") {
      out.push({ segs, file: path.join(dir, e.name), dynamic: segs.filter((s) => s.startsWith("[")).length });
    }
  }
}
const ROUTES: Route[] = [];
walk(APP, [], ROUTES);
ROUTES.sort((a, b) => a.dynamic - b.dynamic);
function resolveRoute(pathname: string): { file: string; params: Record<string, string>; pattern: string } | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  for (const r of ROUTES) {
    if (r.segs.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    r.segs.forEach((s, i) => {
      if (s.startsWith("[")) params[s.replace(/^\[+\.*|\]+$/g, "")] = parts[i];
      else if (s !== parts[i]) ok = false;
    });
    if (ok) return { file: r.file, params, pattern: `/${r.segs.join("/")}` };
  }
  return null;
}

// ---- render helpers -------------------------------------------------------------------
async function settle(tree: unknown, depth = 0): Promise<unknown> {
  if (depth > 80) return tree;
  if (tree instanceof Promise) return settle(await tree, depth + 1);
  if (Array.isArray(tree)) return Promise.all(tree.map((t) => settle(t, depth + 1)));
  if (!isValidElement<Props>(tree)) return tree;
  const type = tree.type as unknown;
  if (typeof type === "function" && (type as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
    return settle(await (type as (p: Props) => Promise<unknown>)(tree.props), depth + 1);
  }
  const entries = await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, k === "children" || isValidElement(v) || Array.isArray(v) ? await settle(v, depth + 1) : v] as const));
  return { ...tree, props: Object.fromEntries(entries) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const LINK_KEY = /^(href|link|viewAll|myShootsHref|sourceHref|reviewHref|focusHref)$/;
function propLinks(v: unknown, out: Set<string>, depth = 0, key = ""): void {
  if (depth > 40 || v == null) return;
  if (typeof v === "string") { if (LINK_KEY.test(key) && /^\/[a-z]/.test(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) propLinks(x, out, depth + 1, key); return; }
  if (typeof v !== "object") return;
  if (isValidElement<Props>(v)) { propLinks(v.props, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) propLinks(x, out, depth + 1, k);
}
/** Every string a server component hands its client components (the browser receives them all, drawn or not). */
function propStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 40 || v == null) return;
  if (typeof v === "string") { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) propStrings(x, out, depth + 1); return; }
  if (typeof v !== "object") return;
  if (isValidElement<Props>(v)) { propStrings(v.props, out, depth + 1); return; }
  for (const x of Object.values(v as Record<string, unknown>)) propStrings(x, out, depth + 1);
}
const htmlLinks = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="(\/[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

type Opened = { kind: "ok" | "redirect" | "notfound" | "crash" | "renderfail" | "noroute"; to?: string; why?: string; html?: string; tree?: unknown };
async function open(href: string): Promise<Opened> {
  const u = new URL(href, "http://hub.invalid");
  const r = resolveRoute(u.pathname);
  if (!r) return { kind: "noroute" };
  const mod = (await import(r.file)) as { default: (p: Props) => unknown };
  pathnameNow = u.pathname;
  try {
    const tree = await settle(await mod.default({ params: Promise.resolve(r.params), searchParams: Promise.resolve(Object.fromEntries(u.searchParams)) }));
    const html = ssr(tree);
    return html.startsWith("RENDER FAILED") ? { kind: "renderfail", why: html.slice(0, 220), tree } : { kind: "ok", html, tree };
  } catch (e) {
    if (e instanceof Redirect) return { kind: "redirect", to: e.href };
    if (e instanceof NotFound) return { kind: "notfound" };
    return { kind: "crash", why: `${(e as Error)?.message ?? e}`.slice(0, 220) };
  }
}

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7351), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-doors-and-previews" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { homeFor } = await import("@/lib/auth/access");
    const { Sidebar } = await import("@/components/Sidebar");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);

    // ---- the hub's real cast (prod logins, Oct 23 2026), in a disposable database ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@doors.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER", { opsAlerts: true });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const kimTm = await tm("Kim Miguel", "MANAGER");
    const johnTm = await tm("John Mark", "MANAGER");
    const login = (name: string, email: string, role: string, teamMemberId: string | null, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", ...extra } });
    const owner = await login("Jordan Spackman", "jordan@doors.invalid", "OWNER", jordanTm.id);
    const owner2 = await login("Lauren Spackman", "jordan.personal@doors.invalid", "OWNER", null);
    const kyle = await login("Kyle Smith", "kyle@doors.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@doors.invalid", "CREATIVE_MANAGER", jamesTm.id);
    // Harrison's real grants (People → Logins): Monthly Content, Photo Delivery, Schedule.
    const harrison = await login("Harrison Wells", "harrison@doors.invalid", "PHOTOGRAPHER", harrisonTm.id, { permissions: JSON.stringify({ content: true, photos: true, schedule: true }) });
    const kim = await login("Kim Miguel", "kim@doors.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    const john = await login("John Mark", "john@doors.invalid", "EDITOR", johnTm.id, { editorKey: "john" });
    // The live Review Room seats: James approves, Kyle backs up, Jordan last.
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, fallbackReviewerTeamMemberId: jordanTm.id, coverOfferHours: 9 }) } });
    // The upload page's one-time welcome is behind every photographer already.
    for (const u of [harrison, james]) await prisma.appSetting.create({ data: { key: `upload-ack-${u.email.toLowerCase()}`, value: JSON.stringify({ at: T.toISOString() }) } });

    // ---- a small, busy day so every dashboard draws links ----
    const client = await prisma.client.create({ data: { name: "Real Agent", email: "agent@doors.invalid", phone: "2155550101" } });
    const desc = ["Customer:", "Name: Real Agent", "Phone: (215) 555-0101", "", "Order Questions:", "- Lock Box / Door Code: 4321"].join("\n");
    const tomorrow = etDayKey(at(D));
    const pJames = await prisma.project.create({ data: { clientId: client.id, title: "11 Upcoming Rd, Town", addressLine: "11 Upcoming Rd", status: "SCHEDULED", photographerId: jamesTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Premium Reel", videoStyle: "premium_social_reel" }] } } });
    await prisma.appointment.create({ data: { aryeoId: "d1", projectId: pJames.id, startAt: etAt(tomorrow, 10), endAt: etAt(tomorrow, 12), status: "SCHEDULED", assignedToId: jamesTm.id, description: desc, rawJson: JSON.stringify({ items: [{ title: "Photos" }, { title: "Premium Reel" }] }) } });
    const pHarrison = await prisma.project.create({ data: { clientId: client.id, title: "22 Past Ln, Town", addressLine: "22 Past Ln", status: "SHOT", shootDate: at(-D), photographerId: harrisonTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "VIDEO", label: "Listing Reel" }] } } });
    await prisma.appointment.create({ data: { aryeoId: "d2", projectId: pHarrison.id, startAt: at(-D), endAt: at(-D + 2 * H), status: "SCHEDULED", assignedToId: harrisonTm.id, description: desc } });
    await prisma.photoJob.create({ data: { projectId: pHarrison.id, stage: "READY", slaDueAt: at(-H) } });
    const pToday = await prisma.project.create({ data: { clientId: client.id, title: "33 Today Ct, Town", addressLine: "33 Today Ct", status: "SCHEDULED", photographerId: harrisonTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } } });
    await prisma.appointment.create({ data: { aryeoId: "d3", projectId: pToday.id, startAt: at(3 * H), endAt: at(5 * H), status: "SCHEDULED", assignedToId: harrisonTm.id, description: desc } });
    const cutJob = await prisma.project.create({ data: { clientId: client.id, title: "60 Review Rd, Town", status: "REVIEW", promisedTargetAt: at(6 * H), editorVendorKey: "kim", deliverables: { create: { type: "VIDEO", label: "Listing Reel" } } } });
    const dv = await prisma.deliverable.findFirstOrThrow({ where: { projectId: cutJob.id } });
    await prisma.reviewSubmission.create({ data: { projectId: cutJob.id, deliverableId: dv.id, slot: 1, round: 2, kind: "video", source: "upload", status: "PENDING", fileName: "v2.mp4", submittedByKey: "kim", submittedByName: "Kim Miguel", reviewerTeamMemberId: jamesTm.id, createdAt: at(-2 * H) } });
    await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Call the agent about the lockbox", assignedKey: "kyle", projectId: pToday.id, clientId: client.id, dueAt: at(2 * H) } });
    await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Plan the premium reel", assignedKey: "james", projectId: pJames.id, dueAt: at(D) } });
    await prisma.commLog.create({ data: { clientId: client.id, clientName: client.name, contactName: client.name, channel: "text", source: "openphone", direction: "in", body: "Can you move the shoot to Friday? Happy to pay the $150 fee.", occurredAt: at(-5 * H), fromPhone: "2155550101" } });
    // Money in words a person typed: only the owner may ever read the figure.
    for (const key of ["kyle", "james", "harrison"]) await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: `Send the $300 quote to Real Agent (${key})`, assignedKey: key, clientId: client.id, dueAt: at(4 * H) } });

    const viewers: { name: string; real: { id: string; email: string; role: string }; as?: { id: string; role: string } }[] = [
      { name: "the owner", real: owner },
      { name: "the owner's second login", real: owner2 },
      { name: "Kyle", real: kyle },
      { name: "James", real: james },
      { name: "Harrison", real: harrison },
      { name: "Kim", real: kim },
      { name: "John", real: john },
      { name: "the owner as Kyle", real: owner, as: kyle },
      { name: "the owner as James", real: owner, as: james },
      { name: "the owner as Harrison", real: owner, as: harrison },
      { name: "the owner as Kim", real: owner, as: kim },
      { name: "the owner as John", real: owner, as: john },
    ];
    const signIn = (v: (typeof viewers)[number]) => setSession({ uid: v.real.id, email: v.real.email, role: v.real.role, ...(v.as ? { actingAs: v.as.id } : {}) });

    // A door's page may lead deeper into its own area (the upload page's first-time welcome); never back out.
    const sameArea = (door: string, to: string) => { const a = door.split(/[?#]/)[0]; const b = to.split(/[?#]/)[0]; return b !== "/" && a !== "/" && (b === a || b.startsWith(`${a}/`)); };
    const doorRows: string[] = [];
    const linkRows: string[] = [];

    async function walkViewer(v: (typeof viewers)[number]): Promise<void> {
      await signIn(v);
      const me = await getCurrentUser();
      const role = me?.role ?? "?";
      c.ok(`${v.name}: signed in as ${v.as ? "a read-only preview of " : ""}${role}`, !!me && (!!v.as === !!me.impersonating) && (!v.as || me.role === v.as.role));
      const shell = me ? { name: me.name, email: me.email, role: me.role, permissions: me.permissions, impersonating: me.impersonating, realName: me.realName, payHidden: me.role !== "OWNER" } : null;
      pathnameNow = "/";
      const menuHtml = renderToStaticMarkup(createElement(Sidebar, { user: shell, scriptingUrl: null }));
      const doors = [...new Set(htmlLinks(menuHtml).map((h) => h.split("#")[0]))];
      c.ok(`${v.name}: the menu draws doors`, doors.length >= 3, doors.join(" "));
      const token = (stubs.cookies as unknown as { get: (n: string) => { value: string } | undefined }).get(SESSION_COOKIE)?.value;
      const bad: string[] = [];
      for (const door of doors) {
        // The proxy (the middleware) decides on the session's own role: a real login must pass to its doors.
        if (token) {
          const res = await proxy(new NextRequest(new URL(door, "http://127.0.0.1:3000"), { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
          const loc = res.headers.get("location");
          if (loc) bad.push(`${door} → proxy ${new URL(loc).pathname}`);
        }
        const r = await open(door);
        doorRows.push(`${v.name.padEnd(26)} ${door.padEnd(28)} ${r.kind}${r.to ? ` → ${r.to}` : ""}${r.why ? ` (${r.why.slice(0, 120)})` : ""}`);
        if (r.kind === "redirect" && !sameArea(door, r.to!)) bad.push(`${door} → ${r.to}`);
        if (r.kind === "notfound" || r.kind === "noroute" || r.kind === "crash") bad.push(`${door} ${r.kind}${r.why ? `: ${r.why}` : ""}`);
      }
      c.ok(`${v.name}: every door on the menu opens its page (no bounce home, no 404, no crash)`, bad.length === 0, bad.join(" | "));

      // Every link on this login's dashboard (its home page).
      const home = homeFor(role);
      const h = await open(home);
      c.ok(`${v.name}: the home (${home}) renders`, h.kind === "ok" || h.kind === "renderfail", `${h.kind} ${h.to ?? ""} ${h.why ?? ""}`);
      // Whose home it is: Jordan's dashboard, Kyle's desk, James's creative desk (a preview reads as the person).
      const want = role === "OWNER" ? 'data-section="finance"' : role === "ADMIN" ? "data-office-desk" : role === "CREATIVE_MANAGER" ? "data-creative-desk" : null;
      if (want) c.ok(`${v.name}: the home is ${role === "OWNER" ? "the owner's dashboard" : role === "ADMIN" ? "Kyle's desk" : "the creative manager's desk"}${v.as ? ", read-only" : ""}`, !!h.html?.includes(want) && (!v.as || /data-readonly="true"/.test(h.html ?? "")));
      if (role !== "OWNER") {
        const money = (h.html ?? "").replace(/<[^>]+>/g, " ").match(/\$\s?\d[\d,]*/g);
        const strings: string[] = [];
        propStrings(h.tree, strings);
        const handed = strings.filter((s) => /\$\s?\d/.test(s));
        c.ok(`${v.name}: no dollar figure anywhere on the home, drawn or handed to the page (side panels included)`, !money && handed.length === 0, [...(money ?? []), ...handed.map((s) => s.slice(0, 80))].join(" | "));
        // …and the check bites: their own "$300 quote" task is on that home, its
        // figure withheld (a photographer's card drops the whole sentence: "Task for you").
        if (["ADMIN", "CREATIVE_MANAGER", "PHOTOGRAPHER"].includes(role)) c.ok(`${v.name}: …their own task with a figure in it is there, the figure withheld`, strings.some((s) => (role === "PHOTOGRAPHER" ? /^Task for you$/ : /Send the \[amount\] quote to Real Agent/).test(s)), strings.filter((s) => /quote|Task for you/.test(s)).slice(0, 3).join(" | "));
      }
      const links = new Set<string>([...(h.html ? htmlLinks(h.html) : []).map((x) => x.split("#")[0])]);
      if (h.tree) { const extra = new Set<string>(); propLinks(h.tree, extra); for (const x of extra) links.add(x.split("#")[0]); }
      const seen = new Set<string>();
      const badLinks: string[] = [];
      for (const link of links) {
        const rr = resolveRoute(new URL(link, "http://hub.invalid").pathname);
        const key = `${rr?.pattern ?? link}?${[...new URL(link, "http://hub.invalid").searchParams.keys()].sort().join("&")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (doors.includes(link)) continue; // already opened as a door
        const r = await open(link);
        linkRows.push(`${v.name.padEnd(26)} ${link.padEnd(48)} ${r.kind}${r.to ? ` → ${r.to}` : ""}${r.why ? ` (${r.why.slice(0, 120)})` : ""}`);
        if (r.kind === "redirect" && !sameArea(link, r.to!)) badLinks.push(`${link} → ${r.to}`);
        if (r.kind === "noroute" || r.kind === "crash") badLinks.push(`${link} ${r.kind}${r.why ? `: ${r.why}` : ""}`);
      }
      c.ok(`${v.name}: every link on the dashboard opens (${seen.size} distinct)`, badLinks.length === 0, badLinks.join(" | "));
    }

    // =====================================================================
    c.head("§1 · the owner's previews first: every door and dashboard link opens, and nothing is written");
    // =====================================================================
    const snapshot = async () => {
      const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '_prisma_migrations'`);
      const withUpdated = new Set((await prisma.$queryRawUnsafe<{ table_name: string }[]>(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'updatedAt'`)).map((r) => r.table_name));
      const out: Record<string, string> = {};
      for (const { table_name: t } of tables) {
        const [row] = await prisma.$queryRawUnsafe<{ n: number; u: Date | null }[]>(`select count(*)::int as n, ${withUpdated.has(t) ? `max("updatedAt")` : "null"} as u from "${t}"`);
        out[t] = `${row.n}/${row.u ? new Date(row.u).toISOString() : "-"}`;
      }
      return out;
    };
    const before = await snapshot();
    for (const v of viewers.filter((x) => x.as)) await walkViewer(v);
    await Promise.all(pending.splice(0));
    const after = await snapshot();
    // One known exception, reported and not this area's file: the Video
    // Delivery page (/review, videoDeliveryBoard followUps) stamps its
    // follow-up check's heartbeat (DeliveryFollowUpHealth.lastSuccessAt) on
    // every read, a preview's included. A system timestamp, nobody's record.
    const HEARTBEAT = new Set(["DeliveryFollowUpHealth"]);
    const changed = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t] && !HEARTBEAT.has(t)).map((t) => `${t}: ${before[t]} → ${after[t]}`);
    c.ok("a preview writes nothing: every table's rows and newest update are unchanged after the owner opened every page of every preview", changed.length === 0, changed.join(" | "));

    // =====================================================================
    c.head("§1b · a preview shows the page its login sees (not the owner's)");
    // =====================================================================
    // Kim's desk links "Offline or stuck?" (/people/capacity). It read the real
    // login's role, so "view as Kim" drew the office's whole register.
    await signIn(viewers.find((v) => v.name === "the owner as Kim")!);
    const capKim = await open("/people/capacity");
    c.ok("view as Kim: Offline or stuck? is Kim's own page (record that you're offline), not the office's register", capKim.kind === "ok" && /Tell the office when you(&#x27;|')re offline or stuck/.test(capKim.html ?? "") && !(capKim.html ?? "").includes("Who is out, now and this week"), capKim.kind);
    await signIn(viewers.find((v) => v.name === "the owner as Harrison")!);
    const capH = await open("/people/capacity");
    c.ok("view as Harrison: the page sends him home, as it does Harrison", capH.kind === "redirect" && capH.to === "/shoot", `${capH.kind} ${capH.to ?? ""}`);
    await signIn(viewers.find((v) => v.name === "the owner as James")!);
    const qJ = await open("/quality");
    c.ok("view as James: Team feedback opens on his two tabs (photographers, editors), as it does for James", qJ.kind === "ok" && /photographers/i.test(qJ.html ?? ""), `${qJ.kind} ${qJ.to ?? ""}`);

    // =====================================================================
    c.head("§2 · every real login: every door and dashboard link opens");
    // =====================================================================
    for (const v of viewers.filter((x) => !x.as)) await walkViewer(v);

    // Every open that did not simply render, for the log (a section that could not draw in a drill is listed, not failed).
    console.log(`\n  (${doorRows.length} door opens, ${linkRows.length} dashboard links; the ones that did not simply render:)`);
    for (const r of [...doorRows, ...linkRows].filter((x) => !/ ok$/.test(x))) console.log(`    ${r}`);
    if (process.env.DOORS_ALL) for (const r of [...doorRows, ...linkRows]) console.log(`    ${r}`);
  } finally { quiet.restore(); fence.restore(); await db.stop(); }
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
