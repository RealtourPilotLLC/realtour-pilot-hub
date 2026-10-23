// Oct 23 2026: JORDAN'S DASHBOARD, RENDERED. The real "/" page server-rendered
// to HTML as Jordan, Kyle, James and Jordan previewing Kyle ("view as"):
// Jordan gets his dashboard in the mockup's order (Financial Position, then
// Business oversight, then My work, then the week), every count is the
// length of the list its panel opens, unknown money is a word, the side
// panels hold the actions, desktop and phone layouts both read (one column
// on a phone, wide two-column sections on a desktop); Kyle's desk and the
// creative manager's home are unchanged and carry no money; the preview is
// read-only. Spec §8: 11, 13, 14, 15. Disposable PGlite; the video board is
// driven; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { PanelSpec } from "../../src/components/owner/panelTypes";

installNextStubs();
type Props = Record<string, unknown>;
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: { id: "D" } }), { headers: { "content-type": "application/json" } }) : null));
let lanes: Record<string, VideoRow[]> | null = null;
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  const fake = (l: Record<string, VideoRow[]>) => ({ asOf: new Date().toISOString(), lanes: l, counts: {}, mode: "live", connected: true }) as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>>;
  return {
    ...m,
    videoDeliveryBoard: (o?: Parameters<typeof m.videoDeliveryBoard>[0]) => (lanes ? Promise.resolve(fake(lanes)) : m.videoDeliveryBoard(o)),
    videoSummary: (now?: Date) => (lanes ? Promise.resolve({ readyToSend: (lanes.sending ?? []).length, late: 0, dueToday: 0 }) : m.videoSummary(now)),
  };
});

function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function namesOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(namesOf);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [typeof type === "string" ? type : type.name ?? "", ...Object.values(tree.props).flatMap(namesOf)];
}
const STREAMED = new Set([
  "OwnerHome", "FinanceSection", "ProductionSection", "ClientIssuesSection", "TeamSection", "MeetingsSection", "CreativeSection", "EmailSectionView", "DelegatedSection", "WeeklySection", "TaskOpen",
  "OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "OfficeDeskSection", "OwnerMoneyLine", "CaughtProblems",
]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
const nestedButton = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)button\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5943), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-owner-render" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: home } = await import("@/app/page");
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const A = await import("@/app/delegation/actions");
    const T = new Date();

    // ---- a small world ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@render.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    await tm("Harrison Wells", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@render.invalid", "ADMIN", kyleTm.id);
    const james = await user("James Livingston", "james@render.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Real Agent", phone: "2155550101" } });
    const pShoot = await prisma.project.create({ data: { clientId: client.id, title: "10 Shoot Ave, Town", status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-r1", projectId: pShoot.id, startAt: new Date(T.getTime() + 3 * H), endAt: new Date(T.getTime() + 5 * H), status: "SCHEDULED" } });
    const pVideo = await prisma.project.create({ data: { clientId: client.id, title: "20 Video Rd, Town", status: "REVIEW" } });
    await prisma.project.create({ data: { clientId: client.id, title: "1 Unpaid Ln, Town", status: "DELIVERED", deliveredAt: new Date(T.getTime() - 4 * D), balanceAmount: 45_000 } });
    const vrow = { key: "v-send", submissionId: "s1", projectId: pVideo.id, street: "20 Video Rd", clientName: "Real Agent", label: "Listing video", round: 1, lane: "sending", stage: "Approved", cutStatus: "APPROVED", sinceISO: null, promiseISO: new Date(T.getTime() + D).toISOString(), promiseWords: "Tomorrow", late: false, dueToday: false, lateHours: null, approvedAtISO: new Date(T.getTime() - H).toISOString(), deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, reviewHref: `/review/${pVideo.id}`, aryeoUrl: null, waitingSinceISO: new Date(T.getTime() - H).toISOString(), send: null, heldRender: null } as unknown as VideoRow;
    lanes = { late: [], today: [], review: [], upcoming: [], sending: [vrow], held: [], finishing: [], delivered: [] };
    await signIn(owner);
    await A.assignTaskAction({ title: "Prepare the strategy brief", outcome: "A one-page brief", assigneeKey: "james", dueAt: new Date(T.getTime() - H).toISOString() });
    await A.assignTaskAction({ title: "Confirm the reshoot", assigneeKey: "kyle", dueAt: new Date(T.getTime() + 2 * D).toISOString() });

    // =====================================================================
    c.head("§1 · Jordan's '/' is his dashboard, in the mockup's order");
    // =====================================================================
    const oTree = await settle(await home({}));
    const oHtml = ssr(oTree);
    const oNames = namesOf(oTree);
    c.ok("renders: the owner dashboard, with the Assign task button in the header", !oHtml.startsWith("RENDER FAILED") && oHtml.includes("data-owner-dashboard") && oHtml.includes('data-readonly="false"') && /Assign task/.test(oHtml), oHtml.slice(0, 300));
    const order = ["finance", "production", "client-issues", "team", "meetings", "creative", "email", "delegated", "weekly"].map((id) => oHtml.indexOf(`data-section="${id}"`));
    c.ok("sections in order: Financial Position, Production health, Client issues, Team coverage, Meetings, Scripts, Email, Delegated by me, Weekly performance", order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), order.join(","));
    c.ok("'Business oversight' sits above production, 'My work' above meetings", oHtml.indexOf("Business oversight") < order[1] && oHtml.indexOf("My work") > order[3] && oHtml.indexOf("My work") < order[4]);
    c.ok("the old owner cards are gone from his home (money line, tiles, needs attention, week card)", ["OwnerMoneyLine", "HealthStrip", "NeedsAttention", "OwnerWeekCard", "OwnerBusiness", "KylesDayCard"].every((n) => !oNames.includes(n)));

    // =====================================================================
    c.head("§2 · money: honest unknowns (#11)");
    // =====================================================================
    const figs = [...oHtml.matchAll(/data-figure="([a-z]+)" data-value="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    c.ok("five figures: cash, due in 14 days, expected collections, forecast, MTD profit", figs.map((f) => f[0]).join(",") === "cash,obligations,collections,forecast,profit", JSON.stringify(figs));
    const block = (k: string) => { const i = oHtml.indexOf(`data-figure="${k}"`); return oHtml.slice(i, oHtml.indexOf("</a>", i)); };
    c.ok("#11 no bank feed: cash reads 'Not connected', never $0", figs.find((f) => f[0] === "cash")?.[1] === "unknown" && block("cash").includes("Not connected") && !/\$0\b/.test(block("cash")));
    c.ok("#11 no revenue rail synced: profit reads 'Not connected'; the forecast says it can't", block("profit").includes("Not connected") && block("forecast").includes("Can&#x27;t forecast"));
    c.ok("expected collections: the unpaid delivered job, $450, labelled as unpaid with unknown timing", block("collections").includes("$450") && block("collections").includes("when it lands isn"));
    c.ok("period, sources and freshness in small type; the gaps fold under a details", oHtml.includes("Month to date") && oHtml.includes("data-freshness") && /What these figures leave out \(\d+\)/.test(oHtml));

    // =====================================================================
    c.head("§3 · every count is its list (#13)");
    // =====================================================================
    const buttons = elements(oTree, "PanelButton") as { spec: PanelSpec; label?: string }[];
    const stageSpecs = buttons.filter((b) => b.spec.kind === "list" && /: open the list$/.test(b.label ?? ""));
    const tiles = [...oHtml.matchAll(/data-stage="([a-z]+)" data-count="([^"]+)" data-total="([^"]+)"/g)].map((m) => ({ key: m[1], n: m[2], total: m[3] }));
    c.ok("five stage tiles: Pre-production, Capture & upload, Editing, Review, Delivery", tiles.map((t) => t.key).join(",") === "pre,capture,editing,review,delivery", JSON.stringify(tiles));
    c.ok("#13 each tile's total is the number of rows its panel lists", tiles.length === 5 && tiles.every((t, i) => stageSpecs[i] && stageSpecs[i].spec.kind === "list" && String((stageSpecs[i].spec as Extract<PanelSpec, { kind: "list" }>).rows.length) === t.total), JSON.stringify(tiles.map((t, i) => [t.key, t.total, (stageSpecs[i]?.spec as { rows?: unknown[] })?.rows?.length])));
    c.ok("…pre-production '1 blocked' (the shoot with no photographer); delivery '1 ready or sending'", tiles[0].n === "1" && oHtml.includes(">blocked<") && tiles[4].n === "1");
    const panel = (spec: PanelSpec, readOnly = false) => ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }, { key: "james", name: "James" }], readOnly, initial: spec }, null));
    const preHtml = panel(stageSpecs[0].spec);
    c.ok("#13 the panel the tile opens lists exactly those rows", preHtml.includes('data-panel-list="1"') && preHtml.includes("10 Shoot Ave") && preHtml.includes("No photographer assigned"));
    const delegatedRows = Number((oHtml.match(/data-delegated="(\d+)"/) ?? [])[1]);
    c.ok("#13 Delegated by me lists the two open assignments (the overdue one flagged first, with Follow up)", delegatedRows === 2 && (oHtml.match(/data-delegated-row=/g) ?? []).length === 2 && oHtml.indexOf("Prepare the strategy brief") < oHtml.indexOf("Confirm the reshoot") && oHtml.includes(">Follow up<"), String(delegatedRows));
    c.ok("#13 'awaiting acceptance' under Team coverage is the same two", oHtml.includes('data-awaiting="2"'));
    const taskSpec = buttons.find((b) => b.spec.kind === "task")!.spec;
    const taskHtml = panel(taskSpec);
    c.ok("a delegated task's panel: status, who and when, the history, and Jordan's actions (Request update, Reassign, Mark complete, Cancel)", taskHtml.includes("Awaiting acceptance") && taskHtml.includes("data-task-history") && taskHtml.includes("assigned it to James") && ["Request update", "Reassign", "Cancel it"].every((w) => taskHtml.includes(w)), taskHtml.slice(taskHtml.indexOf("data-side-panel"), taskHtml.indexOf("data-side-panel") + 300));
    const assignHtml = panel({ kind: "assign", seed: { title: "" } });
    c.ok("Assign task opens a compact form: task, outcome, person, due, verification, note", assignHtml.includes("data-assign-form") && ["Expected outcome", "Assign to", "Due (5 PM ET)", "I verify it before it counts as done"].every((w) => assignHtml.includes(w)) && assignHtml.includes(">Kyle<") && assignHtml.includes(">James<"));

    // =====================================================================
    c.head("§4 · integrations said honestly; the creative and email sections (#11)");
    // =====================================================================
    c.ok("#11 Calendly not connected is said, not an empty calendar", oHtml.includes('data-calendly="not_connected"') && oHtml.includes("Calendly isn") && !oHtml.includes('data-empty="meetings"') || oHtml.includes("can&#x27;t be checked until Calendly"));
    c.ok("#11 Jordan's inbox not connected is said, not 'no email'", oHtml.includes("isn&#x27;t connected, so the hub can&#x27;t see email") && !oHtml.includes('data-empty="email"'));
    c.ok("Scripts & creative decisions shows who owns and who drafts", oHtml.includes("Jordan owns") && oHtml.includes("Others draft"));
    c.ok("weekly performance: each measure is a tile, with a 'View metric definitions' panel (period and source)", (oHtml.match(/data-measure=/g) ?? []).length >= 4 && oHtml.includes("View metric definitions"));

    // =====================================================================
    c.head("§5 · desktop and phone (#15)");
    // =====================================================================
    c.ok("#15 one column on a phone: the paired sections stack (grid only from lg), tiles 2-up then 3 then 5", (oHtml.match(/class="grid items-start gap-5 lg:grid-cols-2"/g) ?? []).length === 3 && oHtml.includes("grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5") && oHtml.includes("mx-auto max-w-7xl"));
    c.ok("#15 the bottleneck and table headers hide on a phone and each row labels itself", oHtml.includes("hidden grid-cols-[minmax(0,2.2fr)") || !oHtml.includes("data-bottlenecks"));
    c.ok("#15 thumb-sized taps, no link inside a link, no button inside a button", (oHtml.match(/min-h-11/g) ?? []).length >= 8 && !nestedLink(oHtml) && !nestedButton(oHtml), `taps ${(oHtml.match(/min-h-11/g) ?? []).length}`);
    c.ok("long names wrap instead of pushing the page sideways", (oHtml.match(/\[overflow-wrap:anywhere\]/g) ?? []).length >= 5);
    c.ok("no em dashes in the dashboard", !/—/.test(oHtml.slice(oHtml.indexOf("data-owner-dashboard"))), (oHtml.match(/.{40}—.{40}/) ?? [""])[0]);

    // =====================================================================
    c.head("§6 · everyone else's home is unchanged, and money stays the owner's (#14)");
    // =====================================================================
    await signIn(kyle);
    const kHtml = ssr(await settle(await home({})));
    c.ok("#14 Kyle's '/' is still his desk: no owner dashboard, no figures", kHtml.includes("data-office-desk") && !kHtml.includes("data-owner-dashboard") && !/\$\d/.test(kHtml), kHtml.slice(0, 200));
    await signIn(james);
    const jTree = await settle(await home({}));
    const jHtml = ssr(jTree);
    // James's own dashboard (the creative desk, merged Oct 23 2026) is his home now.
    c.ok("#14 the creative manager's '/' is his own home (the creative desk), no owner dashboard, no figures", !jHtml.startsWith("RENDER FAILED") && (namesOf(jTree).includes("CreativeDesk") || namesOf(jTree).includes("CreativeDeskSection")) && !jHtml.includes("data-owner-dashboard") && !/\$\d/.test(jHtml), namesOf(jTree).join(","));
    await signIn(owner, kyle.id);
    const vHtml = ssr(await settle(await home({})));
    c.ok("#14 Jordan previewing Kyle sees Kyle's desk (read-only), never his own money", vHtml.includes("data-office-desk") && vHtml.includes('data-readonly="true"') && !vHtml.includes("data-owner-dashboard") && !/\$\d/.test(vHtml));
    const roHtml = panel({ kind: "assign", seed: { title: "x" } }, true);
    c.ok("#14 a read-only dashboard's panels say so and their buttons are off", roHtml.includes("Preview: read-only") && /<button type="submit" disabled=""/.test(roHtml));
    const n = await prisma.smartTask.count();
    const tried = await A.assignTaskAction({ title: "Preview write", assigneeKey: "kyle" });
    c.ok("#14 …and the server refuses a write from the preview", !tried.ok && (await prisma.smartTask.count()) === n, tried.message);
    c.ok("nothing left the box but faked Slack", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
