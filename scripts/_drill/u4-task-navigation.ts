// Ownership-first Tasks navigation: real signed route + board, isolated rows.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();
function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = ((typeof type === "string" ? type : type.name) === name || (name === "Link" && typeof tree.props.href === "string")) ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5841), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-u4-tasks-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/tasks/page");
    const { BoardView, boardNavigationCounts, boardOpenCount } = await import("@/components/tasks/BoardView");
    const { TasksTabs } = await import("@/components/tasks/TasksTabs");
    const { taskWorkHref } = await import("@/lib/taskNavigation");
    const real = await prisma.client.create({ data: { name: "Real content client" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const job = await prisma.project.create({ data: { clientId: real.id, title: "123 TEST Avenue", status: "EDITING" } });
    const fixtureJob = await prisma.project.create({ data: { clientId: fixture.id, title: "Fixture job", status: "EDITING" } });
    const roster = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "u4-kyle@example.test", role: "MANAGER" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Smith", email: roster.email!, teamMemberId: roster.id, role: "ADMIN", status: "ACTIVE" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim Miguel", email: "u4-kim@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE", permissions: JSON.stringify({ tasks: true }) } });
    const task = (title: string, data: { assignedKey?: string; taskType?: string; source?: string; clientId?: string; projectId?: string; status?: string } = {}) => prisma.smartTask.create({ data: { title, taskType: "todo", source: "manual", ...data } });
    const mine = await task("Kyle exact job context", { assignedKey: "kyle", projectId: job.id });
    const routine = await task("Kyle routine without stored assignment", { taskType: "appointment_prep" });
    const unassigned = await task("Needs an owner", { projectId: job.id });
    const james = await task("James review follow-through", { assignedKey: "james", source: "review" });
    const protectedTask = await task("Protected real record", { assignedKey: "kyle", clientId: protectedReal.id });
    const testTask = await task("Fixture direct client", { assignedKey: "kyle", clientId: fixture.id });
    const projectFixture = await task("Fixture through project", { projectId: fixtureJob.id });
    const slack = await task("Slack linked ask", { source: "slack", assignedKey: "kyle" });
    const reply = await task("Reply belongs in composer", { taskType: "client_reply", assignedKey: "kyle" });
    const editing = await task("Kim's exact edit", { taskType: "edit_video", assignedKey: "kim", projectId: job.id });
    await task("Another editor", { taskType: "edit_video", assignedKey: "remar", projectId: job.id });
    await task("Completed evidence", { assignedKey: "kyle", status: "COMPLETED" });
    const before = await prisma.smartTask.findMany({ orderBy: { id: "asc" } });
    const signIn = (user: { id: string; email: string; role: string }) => setSession({ uid: user.id, email: user.email, role: user.role });
    const open = (params: { tab?: string; who?: string; task?: string } & { test?: string; source?: string; type?: string; via?: string } = {}) => page({ searchParams: Promise.resolve(params) });
    const boardRows = async (params: Parameters<typeof open>[0]) => {
      const tree = await open(params);
      const props = elements(tree, "BoardView")[0] as Parameters<typeof BoardView>[0] | undefined;
      if (!props) throw new Error("Expected BoardView");
      const board = await BoardView(props);
      return { tree, props, board, rows: elements(board, "GroupCard").flatMap((group) => group.items as { id: string; projectId: string | null }[]) };
    };
    await clearSession();
    let anonymous = "";
    try { await open(); } catch (e) { if (e instanceof Redirect) anonymous = e.href; else throw e; }
    c.ok("anonymous Tasks still redirects before its data loads", anonymous === "/login?next=/tasks");
    await signIn(kyle);
    const defaultView = await boardRows({});
    c.ok("signed default is My work using real owner resolution and Kyle routine", defaultView.props.sp.who === "me" && defaultView.rows.length === 3 && [mine, routine, protectedTask].every((t) => defaultView.rows.some((r) => r.id === t.id)));
    const counts = await boardNavigationCounts({ excludeClientIds: [fixture.id] });
    c.ok("ownership badges equal rendered lists and shared normal board predicate", counts.mine === 3 && counts.needsAssignment === 1 && counts.all === 5 && counts.all === await boardOpenCount({ excludeClientIds: [fixture.id] }));
    const needs = await boardRows({ tab: "work", who: "needs-assigning" });
    c.ok("Needs assignment contains delegatable work, without reassigning routine work", needs.rows.length === 1 && needs.rows[0].id === unassigned.id && elements(needs.board, "GroupCard")[0].assignPrompt === true);
    const all = await boardRows({ tab: "work", who: "all" });
    c.ok("All work keeps operational scope and durable real/project identity", all.rows.length === counts.all && all.rows.some((r) => r.id === mine.id && r.projectId === job.id) && ![testTask, projectFixture, slack, reply, editing].some((t) => all.rows.some((r) => r.id === t.id)));
    for (const tab of ["other", "board"]) {
      const legacy = await boardRows({ tab });
      c.ok(`legacy ${tab} retains the full operational list`, legacy.props.sp.who === "all" && legacy.rows.length === all.rows.length);
    }
    const filtered = await boardRows({ tab: "other", who: "james", source: "review", type: "todo" });
    c.ok("shareable named-owner/source/type filters retain exact matching row", filtered.rows.length === 1 && filtered.rows[0].id === james.id);
    const noMatch = await boardRows({ tab: "work", who: "me", source: "retired-source" });
    c.ok("unmatched saved filter stays visible and can be cleared", noMatch.rows.length === 0 && elements(noMatch.board, "option").some((p) => p.value === "retired-source") && textOf(noMatch.board).includes("Clear filters"));
    const testView = await boardRows({ tab: "work", who: "all", test: "1" });
    c.ok("explicit test view retains both direct-client and project-linked fixture tasks", [testTask, projectFixture].every((t) => testView.rows.some((r) => r.id === t.id)) && testView.rows.length === 7);
    c.ok("test toggle and owner filters retain current source/type scope", elements(filtered.board, "Link").some((p) => p.href === taskWorkHref({ who: "james", source: "review", type: "todo", showTest: true })));
    const linked = await boardRows({ task: james.id });
    c.ok("bare task deep link does not disappear behind new My work default", linked.props.sp.who === "all" && linked.rows.some((r) => r.id === james.id));
    const slackLink = await open({ tab: "other", task: slack.id });
    c.ok("old Slack task link still opens exact specialist row", elements(slackLink, "SlackView")[0]?.focusTaskId === slack.id);
    c.ok("legacy today and explicit specialist/completed tabs retain their actual views", elements(await open({ tab: "today", via: "email" }), "CommsView")[0]?.channel === "email" && elements(await open({ tab: "revisions" }), "RevisionsView").length === 1 && elements(await open({ tab: "done" }), "DoneView").length === 1);
    const tabs = elements(defaultView.tree, "TasksTabs")[0] as Parameters<typeof TasksTabs>[0];
    const nav = TasksTabs(tabs);
    c.ok("navigation leads with ownership and exposes named specialist queues", textOf(nav).indexOf("My work") < textOf(nav).indexOf("Replies") && ["Needs assignment", "All work", "Completed", "Replies", "Revisions", "Slack"].every((label) => textOf(nav).includes(label)) && elements(nav, "nav").length === 2);
    c.ok("current My work is announced for assistive technology", elements(nav, "Link").filter((p) => p["aria-current"] === "page").length === 1 && elements(nav, "Link").find((p) => p["aria-current"] === "page")?.href === taskWorkHref({ who: "me" }));
    const namedTabs = TasksTabs({ ...tabs, who: "james" });
    c.ok("named-owner subset does not falsely announce All work as current", elements(namedTabs, "Link").every((p) => p["aria-current"] !== "page"));
    c.ok("legacy case-insensitive My work matches its active tab", (await boardRows({ tab: "other", who: "ME" })).props.sp.who === "me");
    await signIn(kim);
    const editor = await boardRows({ tab: "done", who: "all", test: "1" });
    c.ok("editor URL cannot broaden ownership or expose history/navigation", editor.props.tabs === null && editor.rows.length === 1 && editor.rows[0].id === editing.id);
    c.ok("loading/filtering tasks never closes, assigns or changes stored work", JSON.stringify(before) === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })));
    c.ok("navigation checks create no provider, outbox or work-start effects", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.editorWorkItem.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
