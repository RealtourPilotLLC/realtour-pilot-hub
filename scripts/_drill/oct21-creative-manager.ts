// ---------------------------------------------------------------------------
// DRILL: THE CREATIVE MANAGER LOGIN (Jordan, Oct 21 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-creative-manager.ts
//
// Jordan: "Please make sure the UI is updated for James so he sees everything
// he needs to see and only what he needs to see. He's now creative manager so
// he should see and oversee the whole creative process, but doesn't need the
// same tasks as Kyle. So instead of James being admin, create a creative
// manager user type and assign that to James instead of admin."
//
//   §1 the role: its label, its pages (yes and no), overrides both ways, its
//      home, its content tier, and no money anywhere
//   §2 the menu: the creative doors, no office desks, My Performance
//   §3 the guards, on a live session: creative writes accepted, office and
//      money refused, the Review Room desk, the field
//   §4 tasks: their own, never Kyle's list
//   §5 notifications: a creative bell reaches them, a billing one does not,
//      the money clamp, no second text through the office bridge
//   §6 the dashboard: the creative cut (no Kyle's day, no Clients waiting, no
//      problems board, no money), Needs attention narrowed
//   §7 a stale login claim: the proxy may pass an old ADMIN claim, every
//      page and action reads the live login
//   §8 the live switch script's plan and write, on fixtures
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced. Nothing is sent to anyone.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { Dashboard } from "../../src/lib/opsHome";

installNextStubs();
// Slack, faked: a DM a bell row bridges to is answered here and recorded.
const slack: string[] = [];
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  slack.push(url);
  return new Response(JSON.stringify({ ok: true, ts: String(slack.length), channel: { id: "D1" } }), { headers: { "content-type": "application/json" } });
});
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
type Props = Record<string, unknown>;

// ---- tree helpers (the oct19-ops-home shapes) ----------------------------------------
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
const STREAMED = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "CaughtProblems"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const EXPAND = new Set(["HealthStrip", "Tile", "ShootsInProgress", "NeedsAttention", "AttentionRow", "KylesDayCard", "BehindLine"]);
function expand(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && EXPAND.has(tree.type.name)) return expand((tree.type as (p: Props) => unknown)(tree.props));
  return { ...tree, props: Object.fromEntries(Object.entries(tree.props).map(([k, v]) => [k, expand(v)])) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void }; usePathname: () => string };
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });
navigation.usePathname = () => "/";
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) {
    if (e instanceof Redirect) return e.href;
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? "";
    throw e;
  }
}
async function throwsOf(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) { return (e as Error).message || "threw"; }
}

const YES = ["dashboard", "tasks", "review", "pipeline", "schedule", "shoot", "mypay", "clients", "content", "upload", "editing", "resources", "training", "assistant", "feedback"] as const;
const NO = ["communications", "ops", "users", "settings", "catalog", "sales", "trends", "day", "connections"] as const;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7251), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-creative-manager" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const access = await import("@/lib/auth/access");
    const guards = await import("@/lib/auth/guards");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { setSession } = await import("@/lib/auth/session");
    const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const { payHiddenFor } = await import("@/lib/settings");
    const nav = await import("@/lib/sidebarNavigation");
    const guide = await import("@/app/resources/guide/content");

    // =====================================================================
    c.head("§1 · the role, its pages, its home, no money");
    // =====================================================================
    const CM = { role: "CREATIVE_MANAGER", permissions: null };
    c.ok("a real role with a plain label", access.ROLES.includes("CREATIVE_MANAGER") && access.ROLE_LABEL.CREATIVE_MANAGER === "Creative manager");
    const yesMiss = YES.filter((k) => !access.canAccess(CM, k));
    c.ok("opens every creative page: dashboard, tasks, Videos, Shoots, schedule, My Shoots, My Performance, clients, content, upload, editing, the shelf", yesMiss.length === 0, yesMiss.join(", "));
    const noLeak = NO.filter((k) => access.canAccess(CM, k));
    c.ok("closed: the client inbox, Kyle's desks (ops), People, Settings, the price list, Finance, Trends, My Day, Connections", noLeak.length === 0, noLeak.join(", "));
    c.ok("an override opens a page (the inbox) and closes one (Videos), both ways", access.canAccess({ role: "CREATIVE_MANAGER", permissions: JSON.stringify({ communications: true }) }, "communications") && !access.canAccess({ role: "CREATIVE_MANAGER", permissions: JSON.stringify({ review: false }) }, "review"));
    c.ok("…and never an owner-only page", !access.canAccess({ role: "CREATIVE_MANAGER", permissions: JSON.stringify({ day: true, connections: true }) }, "day") && !access.canAccess({ role: "CREATIVE_MANAGER", permissions: JSON.stringify({ connections: true }) }, "connections"));
    c.ok("home is the dashboard, which they can open", access.homeFor("CREATIVE_MANAGER") === "/" && access.canAccess(CM, "dashboard"));
    c.ok("content tier ADMIN (money-free), never OWNER", access.contentTier("CREATIVE_MANAGER") === "ADMIN");
    c.ok("never a money viewer, never pay", !access.canSeeMoney("CREATIVE_MANAGER") && await payHiddenFor({ role: "CREATIVE_MANAGER", realRole: "CREATIVE_MANAGER" }));
    c.ok("isCreativeLead yes, isOffice no; Kyle is both; an editor neither", access.isCreativeLead("CREATIVE_MANAGER") && !access.isOffice("CREATIVE_MANAGER") && access.isOffice("ADMIN") && access.isCreativeLead("ADMIN") && !access.isCreativeLead("EDITOR") && !access.isCreativeLead("PHOTOGRAPHER"));
    c.ok("the Kyle defaults did not move (ADMIN keeps the inbox, ops, settings; no money)", ["communications", "ops", "settings", "users"].every((k) => access.roleHasByDefault("ADMIN", k as never)) && !access.roleHasByDefault("ADMIN", "sales"));
    c.ok("the role guide is a creative one, never the owner's (money)", guide.guideForRole("CREATIVE_MANAGER") === "photographer" && !guide.canOpenGuide("CREATIVE_MANAGER", "owner") && guide.canOpenGuide("CREATIVE_MANAGER", "editor"));

    // =====================================================================
    c.head("§2 · the menu: creative doors, no office desks");
    // =====================================================================
    const { Sidebar } = await import("@/components/Sidebar");
    const menu = (u: { name: string; email: string; role: string; permissions?: string | null }) => renderToStaticMarkup(createElement(Sidebar, { user: { name: u.name, email: u.email, role: u.role, permissions: u.permissions ?? null, payHidden: u.role !== "OWNER" } }));
    const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
    const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-sidebar-group="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
    const jamesMenu = menu({ name: "James Livingston", email: "james@cm.invalid", role: "CREATIVE_MANAGER" });
    c.ok("six doors: Dashboard, Shoots, Videos, Editing Room, Content, Schedule", hrefs(section(jamesMenu, "work")).join() === "/,/jobs,/review,/editing,/content,/schedule", hrefs(section(jamesMenu, "work")).join());
    const all = hrefs(jamesMenu);
    c.ok("no client inbox, no Photo delivery, no Your list, no People, no Settings, no Finance, no Trends", !["/communications", "/ops/photo-delivery", "/ops/checklist", "/users", "/settings", "/sales", "/trends", "/day", "/connections", "/coaching", "/catalog"].some((h) => all.includes(h)), all.join(" "));
    c.ok("under More: Tasks, Clients, Client activity, My Shoots, Upload Portal, Team feedback, Training, Ask the Hub, Report a hub problem", ["/tasks", "/clients", "/content/activity", "/shoot", "/upload", "/quality", "/training", "/assistant", "/feedback"].every((h) => all.includes(h)), all.join(" "));
    c.ok("My Pay reads My Performance (pay stays hidden)", jamesMenu.includes('href="/my-pay"') && jamesMenu.includes("My Performance") && !jamesMenu.includes(">My Pay<"));
    c.ok("an override shows its door (the inbox) and hides one (Videos)", hrefs(menu({ name: "J", email: "j@x", role: "CREATIVE_MANAGER", permissions: JSON.stringify({ communications: true }) })).includes("/communications") && !hrefs(menu({ name: "J", email: "j@x", role: "CREATIVE_MANAGER", permissions: JSON.stringify({ review: false }) })).includes("/review"));
    c.ok("…an ops override still shows no Photos door (its pages admit the office only)", !hrefs(menu({ name: "J", email: "j@x", role: "CREATIVE_MANAGER", permissions: JSON.stringify({ ops: true }) })).some((h) => h.startsWith("/ops/")));
    const kyleMenu = menu({ name: "Kyle", email: "kyle@cm.invalid", role: "ADMIN" });
    c.ok("Kyle's six doors are unchanged (Photos and Messages)", hrefs(section(kyleMenu, "work")).join() === "/,/jobs,/ops/photo-delivery,/review,/communications,/schedule");
    c.ok("the role shows its label in the menu", jamesMenu.includes("Creative manager"));
    c.ok("the creative menu is a list of its own, the office's untouched", nav.CREATIVE_MENU.map((d) => d.href).join() === "/,/jobs,/review,/editing,/content,/schedule" && nav.usesOfficeMenu("CREATIVE_MANAGER") && nav.OFFICE_MENU.map((d) => d.href).join() === "/,/jobs,/ops/photo-delivery,/review,/communications,/schedule");

    // =====================================================================
    c.head("§3 · the guards, on a live session");
    // =====================================================================
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@cm.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true, slackId: "U-JAMES" });
    const harrisonTm = await tm("Harrison Reed", "PHOTOGRAPHER");
    const login = (name: string, email: string, role: string, teamMemberId: string | null, permissions: string | null = null) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", permissions } });
    const owner = await login("Jordan Spackman", "jordan@cm.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@cm.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@cm.invalid", "CREATIVE_MANAGER", jamesTm.id);
    await login("Harrison Reed", "harrison@cm.invalid", "PHOTOGRAPHER", harrisonTm.id);
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id }) } });
    const client = await prisma.client.create({ data: { name: "Real Agent" } });
    const job = await prisma.project.create({ data: { clientId: client.id, title: "12 Oak St, Philadelphia, PA", status: "EDITING", photographerId: harrisonTm.id, shootDate: new Date(Date.now() - 2 * 86_400_000) } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    await signIn(james);
    const me = await getCurrentUser();
    c.ok("the session reads the live login: CREATIVE_MANAGER", me?.role === "CREATIVE_MANAGER" && me.realRole === "CREATIVE_MANAGER");
    c.ok("requireCreativeLead accepts them", (await throwsOf(() => guards.requireCreativeLead())) === null);
    c.ok("requireAdmin (the office) refuses them", (await throwsOf(() => guards.requireAdmin())) === "You don't have access to do that.");
    c.ok("requireOwner refuses them", (await throwsOf(() => guards.requireOwner())) !== null);
    c.ok("they see every job's material (canViewProject)", await guards.canViewProject(job.id));
    c.ok("they act on any shoot's field side (requireShootAccess), as the office did", (await throwsOf(() => guards.requireShootAccess(job.id))) === null);
    const { canRuleOnCuts } = await import("@/lib/reviewerAssignment");
    const rule = await canRuleOnCuts(me);
    c.ok("they rule on cuts by role (the Review Room desk)", rule.ok && rule.as === "CREATIVE_MANAGER", JSON.stringify(rule));
    const { isCreativeApprover } = await import("@/lib/reviewChecklist");
    c.ok("they are the creative approver by role", await isCreativeApprover(me, { authEnforced: true }));
    c.ok("…but never through a preview: the owner viewing as them rules nothing", !(await canRuleOnCuts({ ...me!, impersonating: true })).ok);

    // A creative write, through the real server action.
    const { addNote } = await import("@/app/actions");
    await addNote(job.id, "Shoot the kitchen wide first next time");
    c.ok("a creative action is accepted: a note on the job", (await prisma.activity.count({ where: { projectId: job.id, body: "Shoot the kitchen wide first next time" } })) === 1);
    // Office and money writes, through the real server actions.
    const { sendVideoToAryeoAction } = await import("@/app/review/videoSendActions");
    const send = await sendVideoToAryeoAction("abcdefghij");
    c.ok("an office action is refused: Upload to Aryeo and send", !send.ok && /access/i.test(send.message), send.message);
    const { setTaskDeadline } = await import("@/app/actions");
    const dl = await setTaskDeadline("abcdefghij", "2026-11-01", null).catch((e: Error) => ({ ok: false, message: e.message }));
    c.ok("an office action is refused: a task deadline", !(dl as { ok: boolean }).ok);
    const { addReworkCostAction } = await import("@/app/projects/reworkActions");
    c.ok("a money action is refused: a rework cost", (await throwsOf(() => addReworkCostAction({ projectId: job.id, amount: 10, reason: "x" } as never))) !== null);
    const { decideRevisionFeeAction, approveScript } = await import("@/app/content/actions");
    const fee = await decideRevisionFeeAction("abcdefghij", "WAIVE");
    c.ok("the revision fee (money) stays the office's", !fee.ok && /access/i.test(fee.message ?? ""), fee.message);
    void approveScript;
    const contentSrc = read("src/app/content/actions.ts");
    const guardOf = (fn: string) => contentSrc.slice(contentSrc.indexOf(`export async function ${fn}(`)).match(/require(Admin|CreativeLead|Owner)\(\)/)?.[1] ?? "?";
    c.ok("content program: scripts, topics, strategy edits, script requests are creative writes", ["approveScript", "saveScriptText", "addTopic", "editStrategySection", "replyToScriptRequestAction", "applyEditedScriptRequest", "generateMonthScripts"].every((f) => guardOf(f) === "CreativeLead"));
    c.ok("content program: package, status, fees, catch-ups, late sessions stay the office's; strategy release stays the owner's", ["staffChangePackageAction", "staffSetEnrollmentStatusAction", "decideRevisionFeeAction", "catchUpMonthAction", "lateSessionAction", "holdReviewWindowAction"].every((f) => guardOf(f) === "Admin") && guardOf("releaseStrategy") === "Owner");
    // The edit desk: James keeps the rush desk Jordan gave him (rushAuthority's PRIMARY seat).
    const { rushAuthority } = await import("@/lib/editorWorkload");
    const ra = await rushAuthority(me, { authEnforced: true });
    c.ok("the rush desk: they approve a displacing rush from the PRIMARY seat", ra.may && ra.as === "PRIMARY", JSON.stringify(ra));

    // =====================================================================
    c.head("§4 · tasks: their own, never Kyle's list");
    // =====================================================================
    const task = (title: string, assignedKey: string) => prisma.smartTask.create({ data: { title, taskType: "todo", source: "manual", status: "OPEN", assignedKey } });
    const kTask = await task("Call the client back about Thursday", "kyle");
    const jTask = await task("Coach Harrison on twilight exteriors", "james");
    const scope = await guards.taskScopeOf(me);
    c.ok("their task scope is their own key", scope === "james", String(scope));
    const { boardWhere } = await import("@/lib/taskBoard");
    const board = await prisma.smartTask.findMany({ where: boardWhere(scope, {}), select: { id: true } });
    c.ok("the board shows their task and not Kyle's", board.some((t) => t.id === jTask.id) && !board.some((t) => t.id === kTask.id), board.map((t) => t.id).join());
    c.ok("they may act on their own task", (await throwsOf(() => guards.requireTaskAccess(jTask.id))) === null);
    c.ok("…and not on Kyle's", (await throwsOf(() => guards.requireTaskAccess(kTask.id))) !== null);
    c.ok("an editor's scope is unchanged, and the office has none", guards.editorScopeOf({ role: "EDITOR", editorKey: "kim" }) === "kim" && guards.editorScopeOf(me) === null);
    const tasksPage = read("src/app/tasks/page.tsx");
    c.ok("the Tasks page is board-only for them (no Today, Done, Revisions or Slack tabs over the whole team)", /const boardOnly = me\?\.role === "EDITOR" \|\| me\?\.role === "CREATIVE_MANAGER"/.test(tasksPage));
    await signIn(kyle);
    c.ok("Kyle still sees the whole office list (no scope)", (await guards.taskScopeOf(await getCurrentUser())) === null);

    // =====================================================================
    c.head("§5 · notifications");
    // =====================================================================
    const { notifyInApp } = await import("@/lib/notify");
    const { GET } = await import("@/app/api/notifications/route");
    const { NextRequest } = await import("next/server");
    const bell = async () => ((await (await GET(new NextRequest("http://localhost/api/notifications"))).json()) as { items: { kind: string; title: string; body: string | null; href: string }[] }).items;
    await notifyInApp({ kind: "script_change_request", title: "Script change asked — Real Agent", body: "Make the hook shorter", href: "/content", targets: [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }] });
    await notifyInApp({ kind: "revision_fee", title: "Extra revision round — Real Agent", body: "Charge $75 or waive", href: "/content", targets: [{ roles: ["OWNER", "ADMIN"] }] });
    await notifyInApp({ kind: "cut_change_ask", title: "Change asked — 12 Oak St", body: "The client said the $450 package had twilight", href: "/review", targets: [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }] });
    await notifyInApp({ kind: "system", title: "Payroll export failed", body: "Run total $3,200", href: "/sales?tab=payroll", targets: [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }] });
    await notifyInApp({ kind: "mention", title: "Jordan tagged you", body: "Bill them $90 for the rush", href: "/billing", targets: [{ roles: ["OWNER", "ADMIN"], userKey: `tm:${jamesTm.id}` }] });
    await notifyInApp({ kind: "review_reassigned", title: "Kyle has 12 Oak St now", body: "Version 2, covered. Quote was $300", href: `/review/${job.id}`, targets: [{ roles: ["OWNER", "ADMIN"], userKey: `tm:${jamesTm.id}` }] });
    await signIn(james);
    const jBell = await bell();
    c.ok("a creative bell reaches them (script change request)", jBell.some((n) => n.kind === "script_change_request"));
    c.ok("a billing bell does not (revision fee)", !jBell.some((n) => n.kind === "revision_fee"));
    const ask = jBell.find((n) => n.kind === "cut_change_ask");
    c.ok("their creative row keeps its words with the figure taken out", !!ask && !!ask.body && !/\$\d/.test(ask.body) && /package/.test(ask.body), ask?.body ?? "missing");
    c.ok("a row pointing at Finance collapses to the owner: not in their bell", !jBell.some((n) => n.href.startsWith("/sales")));
    const audience = await prisma.notification.findFirst({ where: { kind: "system", title: "Payroll export failed" }, select: { audience: true } });
    c.ok("…and was written owner-only", audience?.audience === JSON.stringify(["OWNER"]), audience?.audience);
    c.ok("a row addressed to them by name pointing at a money screen is never written", !jBell.some((n) => n.href.startsWith("/billing")) && (await prisma.notification.count({ where: { userKey: `tm:${jamesTm.id}`, href: { startsWith: "/billing" } } })) === 0);
    const named = jBell.find((n) => n.kind === "review_reassigned");
    c.ok("a row addressed to them by name keeps its words, figures out", !!named && !/\$\d/.test(named.body ?? "") && /covered/.test(named.body ?? ""), named?.body ?? "missing");
    c.ok("no money anywhere in their bell", jBell.every((n) => !/\$\d/.test(`${n.title} ${n.body ?? ""}`)), jBell.map((n) => n.body).join(" | "));
    await signIn(kyle);
    const kBell = await bell();
    c.ok("Kyle still gets the creative bell and the billing one (with its figure, as before)", kBell.some((n) => n.kind === "script_change_request") && kBell.some((n) => n.kind === "revision_fee" && /\$75/.test(n.body ?? "")));
    const { officeTeamMemberIds, ownerTeamMemberIds } = await import("@/lib/smsPrefs");
    const office = await officeTeamMemberIds();
    c.ok("the office text bridge (the 'video in review' broadcast) never addresses them: no second text", !office.includes(jamesTm.id) && !(await ownerTeamMemberIds()).includes(jamesTm.id) && office.includes(kyleTm.id), office.join());
    const src = (rel: string) => read(rel);
    const creativeEmitters: [string, RegExp][] = [
      ["src/lib/scriptDecisions.ts", /kind: "script_change_request"[\s\S]{0,800}"CREATIVE_MANAGER"/],
      ["src/lib/scriptEdits.ts", /kind: "script_edited"[\s\S]{0,800}"CREATIVE_MANAGER"/],
      ["src/lib/comms.ts", /const targets: NotifyTarget\[\] = \[\{ roles: \["OWNER", "ADMIN", "CREATIVE_MANAGER"\] \}\];[\s\S]{0,1600}revision_raised/],
      ["src/lib/cutReopen.ts", /kind: "cut_uploaded"[\s\S]{0,400}"CREATIVE_MANAGER"/],
      ["src/lib/behindAlert.ts", /kind === "video"[\s\S]{0,600}"CREATIVE_MANAGER"/],
      ["src/lib/fieldIssues.ts", /"OWNER", "ADMIN", "CREATIVE_MANAGER"/],
      ["src/lib/selfCheckStore.ts", /"OWNER", "ADMIN", "CREATIVE_MANAGER"\], href/],
      ["src/lib/reviewCuts.ts", /roles: \["OWNER", "ADMIN", "CREATIVE_MANAGER"\],\s*ownerSms/],
      ["src/app/review/actions.ts", /"OWNER", "ADMIN", "CREATIVE_MANAGER"\], href: `\/review\/\$\{input\.projectId\}\?cut=/],
      ["src/app/api/portal/upload/route.ts", /kind: "portal_asset"[\s\S]{0,400}"CREATIVE_MANAGER"/],
    ];
    const missing = creativeEmitters.filter(([f, re]) => !re.test(src(f))).map(([f]) => f);
    c.ok("creative emitters ring them: script requests and edits, revisions, a replaced video, the video behind alert, field flags, editor checks, cut in review (no seat), change asks, brand assets", missing.length === 0, missing.join(", "));
    const officeKinds: [string, RegExp][] = [
      ["src/lib/clientDecisions.ts", /kind: "revision_fee"[\s\S]{0,300}roles: \["OWNER", "ADMIN"\] \}/],
      ["src/lib/deliveryWatch.ts", /roles: \["OWNER", "ADMIN"\] \}/],
      ["src/lib/integrations/google.ts", /kind: "new_lead"[\s\S]{0,300}roles: \["OWNER", "ADMIN"\] \}/],
      ["src/lib/programMessages.ts", /targets\.push\(\{ roles: \["OWNER", "ADMIN"\] \}\)/],
      ["src/lib/sessionRequests.ts", /kind: "portal_session"[\s\S]{0,300}roles: \["OWNER", "ADMIN"\] \}/],
    ];
    const leaked = officeKinds.filter(([f, re]) => !re.test(src(f))).map(([f]) => f);
    c.ok("office and money emitters do not: the revision fee, photos not delivered, new leads, program messages, session requests", leaked.length === 0, leaked.join(", "));
    const behind = src("src/lib/behindAlert.ts");
    c.ok("the PHOTO behind alert stays Jordan's and Kyle's only", /roles: \["OWNER"\] \}, \.\.\.people[\s\S]{0,200}roles: \["ADMIN" as const\]/.test(behind) && !/photo[\s\S]{0,80}CREATIVE_MANAGER/i.test(behind.slice(behind.indexOf("async function ringBells"), behind.indexOf("async function ringBells") + 3000).split('kind === "video"')[1]?.split("} else")[1] ?? ""));

    // =====================================================================
    c.head("§6 · the dashboard: the creative cut");
    // =====================================================================
    const { default: home } = await import("@/app/page");
    // Two cuts waiting on a verdict: one assigned to James, one to Kyle.
    const cutJob = await prisma.project.create({ data: { clientId: client.id, title: "60 Review Rd, Town", status: "REVIEW", shootDate: new Date(Date.now() - 2 * 86_400_000), deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 2 } } } });
    const cutDeliverable = await prisma.deliverable.findFirstOrThrow({ where: { projectId: cutJob.id } });
    const cut = (slot: number, reviewer: string, hoursAgo: number) => prisma.reviewSubmission.create({ data: { projectId: cutJob.id, deliverableId: cutDeliverable.id, slot, source: "folder", kind: "video", status: "PENDING", reviewerTeamMemberId: reviewer, submittedByKey: "kim", assetPath: `/isolated/${cutJob.id}-${slot}.mp4`, createdAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
    const mineCut = await cut(1, jamesTm.id, 3);
    const kylesCut = await cut(2, kyleTm.id, 30);
    await signIn(james);
    const jDash = await settle(await home({}));
    const jHtml = renderToStaticMarkup(expand(jDash) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("they land on the dashboard (no redirect)", elements(jDash, "HealthStrip").length === 1);
    c.ok("no Kyle's day, no problems board, no week, no money", ["KylesDayCard", "KylesDaySection", "CaughtProblems", "OwnerWeekCard", "MoneyStat", "OwnerBusiness", "ShootIssuesCard"].every((n) => elements(jDash, n).length === 0) && !jHtml.includes("Kyle’s day") && !/\$\d/.test(jHtml));
    c.ok("no Clients waiting tile; Shoots on time, Special requests and QC & review stay", !jHtml.includes("Clients waiting") && jHtml.includes("Shoots on time") && jHtml.includes("Special requests") && jHtml.includes("QC &amp; review"));
    c.ok("the monthly content card is theirs (Jordan's and the creative manager's)", jHtml.includes("data-content-actions") || elements(jDash, "ContentActionsCard").length === 1);
    const att = elements(jDash, "NeedsAttention")[0]?.attention as Dashboard["attention"] | undefined;
    c.ok("Needs attention keeps the creative lines only (no clients waiting, no sending, no owners to give)", !!att && att.items.every((i) => !/^(clients|send:|needs-owner|requests-no-job|old-ops|todos)/.test(i.key)) && !att.unavailable.includes("client messages"), JSON.stringify(att?.items.map((i) => i.key)));
    const item = (key: string) => att?.items.find((i) => i.key === key);
    c.ok("…their own cut to review, opening that version", item("review-mine")?.lead === "1 cut" && item("review-mine")?.action.href === `/review/${cutJob.id}?cut=${mineCut.id}`, JSON.stringify(item("review-mine")));
    c.ok("…and the rest of the room's cuts waiting, oldest first (Kyle's, 30h, red)", item("review-waiting")?.lead === "1 cut" && item("review-waiting")?.text === "more waiting on review" && item("review-waiting")?.tone === "bad" && item("review-waiting")?.action.href === `/review/${cutJob.id}?cut=${kylesCut.id}`, JSON.stringify(item("review-waiting")));
    const opsHome = await import("@/lib/opsHome");
    const creativeDash = await opsHome.buildDashboard({ now: new Date(), excludeClientIds: [], viewer: { role: "CREATIVE_MANAGER", key: "james", teamMemberId: jamesTm.id }, ops: { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" }, scrub: true, focus: "creative" });
    c.ok("buildDashboard(focus: creative) reads no client inbox", creativeDash.health.clients === null && !creativeDash.attention.unavailable.includes("client messages"));
    await signIn(kyle);
    const kHtml = renderToStaticMarkup(expand(await settle(await home({}))) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("Kyle's dashboard is unchanged: Clients waiting and his list", kHtml.includes("Clients waiting") && kHtml.includes("Your list"));

    // =====================================================================
    c.head("§7 · a stale ADMIN claim grants nothing");
    // =====================================================================
    const { proxy } = await import("@/proxy");
    const viaProxy = async (pathname: string, claim: { uid: string; email: string; role: string; permissions?: string | null }) => {
      const token = await signSession(claim);
      const req = new NextRequest(`http://localhost${pathname}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
      const res = await proxy(req);
      return res.headers.get("location");
    };
    // The old login claim James carries until he signs in again.
    const staleClaim = { uid: james.id, email: james.email, role: "ADMIN", permissions: JSON.stringify({ mypay: true, sales: false, trends: false, communications: true, clients: true }) };
    c.ok("the proxy passes the old claim through to the inbox (it only re-reads on a deny)", (await viaProxy("/communications", staleClaim)) === null);
    await setSession(staleClaim);
    c.ok("…but the session resolves the LIVE login: CREATIVE_MANAGER", (await getCurrentUser())?.role === "CREATIVE_MANAGER");
    c.ok("…so the inbox page sends them home", (await redirectOf(() => guards.requirePageAccess("communications"))) === "/");
    c.ok("…and an office action still refuses them", (await throwsOf(() => guards.requireAdmin())) !== null);
    const { default: settingsPage } = await import("@/app/settings/page");
    c.ok("…and Settings sends them home", (await redirectOf(() => settingsPage({ searchParams: Promise.resolve({}) } as never))) === "/");
    c.ok("a fresh CREATIVE_MANAGER claim is turned away at the proxy from Settings, to the dashboard", new URL((await viaProxy("/settings", { uid: james.id, email: james.email, role: "CREATIVE_MANAGER" })) ?? "http://x/none").pathname === "/");
    c.ok("…and passes to Videos and the Content Program", (await viaProxy("/review", { uid: james.id, email: james.email, role: "CREATIVE_MANAGER" })) === null && (await viaProxy("/content", { uid: james.id, email: james.email, role: "CREATIVE_MANAGER" })) === null);

    // =====================================================================
    c.head("§8 · the live switch script (dry run logic, on fixtures)");
    // =====================================================================
    const live = await import("../_live/oct21-james-creative-manager");
    await prisma.appUser.update({ where: { id: james.id }, data: { role: "ADMIN", permissions: staleClaim.permissions } });
    const plan = await live.planSwitch(prisma);
    c.ok("it finds James by the creative-manager roster row and his login", plan.ok && plan.user.id === james.id && plan.teamMemberId === jamesTm.id, JSON.stringify(plan));
    c.ok("…and plans ADMIN → CREATIVE_MANAGER with no overrides", plan.ok && plan.user.role === "ADMIN" && plan.after.role === "CREATIVE_MANAGER" && plan.after.permissions === null && !plan.noChange);
    c.ok("the plan writes nothing", (await prisma.appUser.findUnique({ where: { id: james.id }, select: { role: true } }))?.role === "ADMIN");
    if (plan.ok) {
      await prisma.appUser.update({ where: { id: james.id }, data: { permissions: JSON.stringify({ mypay: true }) } });
      const stale = await live.applySwitch(prisma, plan);
      c.ok("a login that changed since the read is not written (compare and set)", !stale.ok && (await prisma.appUser.findUnique({ where: { id: james.id }, select: { role: true } }))?.role === "ADMIN");
      const fresh = await live.planSwitch(prisma);
      const r = fresh.ok ? await live.applySwitch(prisma, fresh) : { ok: false, message: "no plan" };
      const after = await prisma.appUser.findUnique({ where: { id: james.id }, select: { role: true, permissions: true } });
      c.ok("--apply: role CREATIVE_MANAGER, permissions null, one audit row", r.ok && after?.role === "CREATIVE_MANAGER" && after.permissions === null && (await prisma.auditLog.count({ where: { action: "role_change", target: james.email } })) === 1, JSON.stringify(after));
      const again = await live.planSwitch(prisma);
      c.ok("run again: nothing to do", again.ok && again.noChange);
    }
    await prisma.teamMember.create({ data: { name: "James Livingston", role: "PHOTOGRAPHER" as never, email: "james2@cm.invalid", creativeManager: true } });
    const twice = await live.planSwitch(prisma);
    c.ok("two roster rows named James with the flag: stop", !twice.ok);
    c.ok("the script runs only as a script (a drill import ran nothing)", /if \(\/oct21-james-creative-manager\\\.ts\$\/\.test\(process\.argv\[1\]/.test(read("scripts/_live/oct21-james-creative-manager.ts")));

    // =====================================================================
    c.head("§9 · the go-dark watch knows the role");
    // =====================================================================
    const { checkOpsGoDark } = await import("@/lib/usage");
    await checkOpsGoDark();
    c.ok("James on the creative manager login is not reported as 'can't open ops'", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `ops-role-${jamesTm.id}` } } })) === 0);
    void owner;

    c.ok("nothing left the box", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
