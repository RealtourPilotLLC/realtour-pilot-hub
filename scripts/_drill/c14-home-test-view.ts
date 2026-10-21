// C14: explicit Home scope reaches the same operational lists and survives delivery return links.
// Oct 19 2026 (night): "/" is ONE dashboard for the owner and the office, and
// /ops redirects to it. The scope is checked on what replaced the old Homes:
// the dashboard (Today's shoots, the tiles, Needs attention), Kyle's list
// (/ops/checklist: the daily checklist), Messages
// (/communications, which /ops/messages now opens: the Outbox number on its
// tab, Oct 19 night) and the review seat's own line on the dashboard, all
// with the same ?test= flag. Changed on purpose that night: the new-clients
// card left with /ops; the ready-to-send number is the Video Review Room's
// own (videoSummary, which keeps test clients out in both views). The footer links Home used to repeat from the sidebar are
// no longer expected (Jordan's "too much on one screen").
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
// Expand only the Home's pure presentation functions. Client components retain
// their real props; the drill does not run hooks or invoke their actions.
const HOME_FUNCTIONS = new Set(["HealthStrip", "Tile", "ShootsInProgress", "JobLine", "NeedsAttention", "AttentionRow", "KylesDayCard", "BehindLine", "DailyChecklist", "GroupCard", "LineRow", "LineActions", "EarlierCard", "OldItemRow", "DoneToday", "DoneRow", "StillOpen"]);
function expand(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && HOME_FUNCTIONS.has(tree.type.name)) return expand((tree.type as (props: Props) => unknown)(tree.props));
  return { ...tree, props: Object.fromEntries(Object.entries(tree.props).map(([key, value]) => [key, expand(value)])) };
}
function hrefs(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(hrefs);
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeof tree.props.href === "string" ? [tree.props.href] : []), ...Object.values(tree.props).flatMap(hrefs)];
}
// Oct 5: Home streams its secondary sections (Suspense around async server
// components that await reads started with the page's own). Resolve those
// named components so the checks read the page as it finishes composing.
const STREAMED_HOME = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots"]);
async function settleHome(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settleHome));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED_HOME.has(tree.type.name)) return settleHome(await (tree.type as (props: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([key, value]) => [key, await settleHome(value)] as const))) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void } };
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5865), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-home-test-scope" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: home } = await import("@/app/page");
    const { default: listPage } = await import("@/app/ops/checklist/page");
    const { default: review } = await import("@/app/review/page");
    const { getReviewQueue } = await import("@/lib/reviewRoom");
    const { photoQcWhere } = await import("@/lib/taskBoard");
    const { clientTextWhere } = await import("@/lib/clientTexts");
    const { unansweredCommsBoard } = await import("@/lib/commsBoard");
    const { homeRecordHref } = await import("@/lib/homeRecordScope");
    const { ReadyToSendCard } = await import("@/components/ops/ReadyToSendCard");
    // (The Review Room's old delivery summary, components/review/DeliveryExitSummary,
    // was deleted Oct 20 2026, audit H13: no page rendered it.)
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const real = await prisma.client.create({ data: { name: "Real Agent", firstSeenAt: now } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", firstSeenAt: now } });
    const seat = await prisma.teamMember.create({ data: { name: "Creative Reviewer", email: "c14-creative@example.test", role: "MANAGER" } });
    const owner = await prisma.appUser.create({ data: { name: "Owner", email: "c14-owner@example.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Creative Reviewer", email: seat.email!, role: "ADMIN", teamMemberId: seat.id, status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Editor", email: "c14-editor@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    // The office's operations login (Kyle's Home: the summary box and the checklist).
    const ops = await prisma.appUser.create({ data: { name: "Ops Office", email: "c14-ops@example.test", role: "ADMIN", status: "ACTIVE" } });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: seat.id }) } });
    const jobs = [];
    for (const client of [real, fixture]) {
      const project = await prisma.project.create({ data: { clientId: client.id, title: client.id === real.id ? "123 TEST Avenue" : "Fixture-only property", status: "REVIEW", shootDate: now, deliveryDue: ago(1), deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 2 } } }, include: { deliverables: true } });
      const cut = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: project.deliverables[0].id, slot: 1, kind: "video", status: "PENDING", reviewerTeamMemberId: seat.id, submittedByKey: "kim", assetPath: `/isolated/${project.id}.mp4`, createdAt: ago(2) } });
      await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: project.deliverables[0].id, slot: 2, kind: "video", status: "APPROVED", fileName: "isolated-ready.mp4", blobUrl: "https://example.test/ready.mp4", decidedAt: ago(1) } });
      await prisma.appointment.create({ data: { aryeoId: `isolated-${project.id}`, projectId: project.id, startAt: now } });
      await prisma.smartTask.createMany({ data: [
        { clientId: client.id, projectId: project.id, title: "Unassigned office work", taskType: "todo", source: "manual", dueAt: ago(48) },
        { clientId: client.id, projectId: project.id, title: "Photo check", taskType: "media_qa", source: "manual" },
        { clientId: client.id, projectId: project.id, title: "Delivery draft", taskType: "delivery_text", source: "manual" },
        { clientId: client.id, title: "Slack instruction", taskType: "internal_instruction", source: "slack", dueAt: ago(1) },
      ] });
      await prisma.commLog.create({ data: { clientId: client.id, clientName: client.name, contactName: client.name, channel: "email", source: "gmail", direction: "in", body: "Can you check this delivery?", occurredAt: ago(1) } });
      jobs.push({ project, cut });
    }
    await prisma.stripeTransaction.create({ data: { id: "isolated-finance-charge", type: "charge", gross: 125, fee: 3, net: 122, projectId: jobs[1].project.id, createdAt: now } });
    const beforeTasks = await prisma.smartTask.findMany({ orderBy: { id: "asc" } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const render = async (test?: string | string[]) => settleHome(await home({ searchParams: Promise.resolve({ test }) }));
    const renderList = async (test?: string | string[]) => settleHome(await listPage({ searchParams: Promise.resolve({ test }) }));
    await clearSession();
    let anonymous = "";
    try { await render("1"); } catch (error) { if (error instanceof Redirect) anonymous = error.href; else throw error; }
    c.ok("test flag does not bypass anonymous Home auth", anonymous === "/login");
    await signIn(editor);
    let creative = "";
    try { await render("1"); } catch (error) { if (error instanceof Redirect) creative = error.href; else throw error; }
    c.ok("test flag does not grant editors the office Home", creative === "/editing");
    await signIn(owner);
    const normal = await render();
    const all = await render("1");
    await signIn(ops);
    const kNormal = await renderList();
    const kAll = await renderList("1");
    const { default: messages } = await import("@/app/communications/page");
    const { MessagesTabs } = await import("@/components/comms/MessagesTabs");
    // Messages' tab bar is a server part: expand it so its links can be read.
    const messagesLinks = (tree: unknown) => [...hrefs(tree), ...hrefs(MessagesTabs(elements(tree, "MessagesTabs")[0] as Parameters<typeof MessagesTabs>[0]))];
    const outboxCount = (tree: unknown) => ((elements(tree, "MessagesTabs")[0]?.counts as { outbox?: { n: number } } | undefined)?.outbox?.n ?? null);
    const { default: requests } = await import("@/app/ops/requests/page");
    const mNormal = await messages({ searchParams: Promise.resolve({}) });
    const mAll = await messages({ searchParams: Promise.resolve({ test: "1" }) });
    const listOf = (tree: unknown) => elements(tree, "DailyChecklist")[0].list as import("../../src/lib/opsHome").KyleChecklist;
    const kn = listOf(kNormal), ka = listOf(kAll);
    const normalScope = { excludeClientIds: [fixture.id] };
    const waiting = async (scope?: { excludeClientIds: string[] }) => (await unansweredCommsBoard("phone", now, scope)).length + (await unansweredCommsBoard("email", now, scope)).length;
    c.ok("normal and explicit-test photo/QC numbers share destination scope", kn.summary.photos?.olderQc === 1 && ka.summary.photos?.olderQc === 2 && kn.summary.photos?.olderQc === await prisma.smartTask.count({ where: photoQcWhere(normalScope) }) && ka.summary.photos?.olderQc === await prisma.smartTask.count({ where: photoQcWhere() }));
    c.ok("normal and explicit-test Outbox number (Messages' Outbox tab) share destination scope", outboxCount(mNormal) === 1 && outboxCount(mAll) === 2 && 1 === await prisma.smartTask.count({ where: clientTextWhere(now, normalScope) }) && 2 === await prisma.smartTask.count({ where: clientTextWhere(now) }));
    c.ok("the waiting-clients number and its checklist group restore fixture evidence together", kn.summary.messages?.waiting === await waiting(normalScope) && ka.summary.messages?.waiting === await waiting() && kn.summary.messages?.waiting === 1 && ka.summary.messages?.waiting === 2 && kn.groups[1].lines.length === 1 && ka.groups[1].lines.length === 2);
    const pile = (l: import("../../src/lib/opsHome").KyleChecklist) => [...l.groups.find((g) => g.key === "followups")!.lines.map((x) => x.key.slice(5)), ...l.earlier.items.map((i) => i.id)];
    c.ok("the shared ops pile on the checklist uses the explicit Home scope", pile(kn).length === 1 && pile(ka).length === 2);
    c.ok("today's shoot cards on the dashboard use the explicit scope", (elements(normal, "ShootList")[0].shoots as unknown[]).length === 1 && (elements(all, "ShootList")[0].shoots as unknown[]).length === 2);
    c.ok("test view names supported queue scopes and unchanged Finance definitions", textOf(all).includes("Showing real and test records on the dashboard") && textOf(all).includes("keep this view when opened") && textOf(all).includes("Finance’s existing definitions") && !textOf(normal).includes("Showing real and test records"));
    const normalLinks = [...hrefs(expand(normal)), ...hrefs(expand(kNormal)), ...messagesLinks(mNormal)];
    const allLinks = [...hrefs(expand(all)), ...hrefs(expand(kAll)), ...messagesLinks(mAll)];
    c.ok("normal Home links do not silently opt into test scope", !normalLinks.some((href) => /[?&]test=1/.test(href) && href !== "/?test=1" && href !== "/ops/checklist?test=1"));
    c.ok("test workload destinations preserve scope through the dashboard, the list and their screens", ["/review?test=1", "/communications?test=1", "/jobs?f=late&test=1", "/communications?tab=outbox&test=1", "/?test=1", "/ops/checklist?who=kyle&test=1"].every((href) => allLinks.includes(href)), allLinks.join("\n"));
    c.ok("a waiting email's Reply opens that thread on Messages, test scope kept", allLinks.some((href) => href.startsWith("/communications?tab=email&focus=") && href.endsWith("&test=1")) && normalLinks.some((href) => href.startsWith("/communications?tab=email&focus=") && !href.includes("test=1")));
    c.ok("a retired page keeps the test scope when it redirects to the list", await (async () => { try { await requests({ searchParams: Promise.resolve({ test: "1" }) }); return null; } catch (e) { return e instanceof Redirect ? e.href : null; } })() === "/ops/checklist?test=1#requests");
    const slackRows = allLinks.filter((h) => h.startsWith("/tasks?tab=slack&task="));
    c.ok("synthetic Slack task deep links retain task ID and scope", slackRows.length >= 2 && slackRows.every((h) => h.endsWith("&test=1")));
    c.ok("figures from the books and Finance routes retain their definitions", JSON.stringify(elements(normal, "MoneyStat")) === JSON.stringify(elements(all, "MoneyStat")) && allLinks.includes("/sales") && !allLinks.some((href) => href.startsWith("/sales?")));
    await signIn(ops);
    c.ok("only scalar test=1 enables the scope", listOf(await renderList("true")).summary.messages?.waiting === 1 && listOf(await renderList(["1", "1"])).summary.messages?.waiting === 1);
    await signIn(admin);
    const assigned = await render("1");
    const attentionOf = (tree: unknown) => elements(tree, "NeedsAttention")[0].attention as import("../../src/lib/opsHome").Dashboard["attention"];
    const healthOf = (tree: unknown) => elements(tree, "HealthStrip")[0].health as import("../../src/lib/opsHome").Dashboard["health"];
    const mine = attentionOf(assigned).items.find((i) => i.key === "review-mine");
    c.ok("exact-cut links retain recorded version without extra list flags", jobs.some((job) => hrefs(expand(assigned)).includes(`/review/${job.project.id}?cut=${job.cut.id}`)) && /^\/review\/[^?]+\?cut=[^&]+$/.test(mine?.action.href ?? ""));
    const assignedNormal = await render();
    const { videoSummary } = await import("@/lib/videoDelivery");
    c.ok("the cuts to review follow the explicit scope; ready to send is the Video Review Room's own number (test clients out in both views)", healthOf(assigned).qc?.toReview === 2 && healthOf(assignedNormal).qc?.toReview === 1 && healthOf(assigned).qc?.readyToSend === healthOf(assignedNormal).qc?.readyToSend && healthOf(assignedNormal).qc?.readyToSend === (await videoSummary()).readyToSend);
    c.ok("signed creative reviewer sees the same full assigned queue while retaining money gates", mine?.lead === `${(await getReviewQueue({ includeTest: true })).pending.filter((cut) => cut.reviewer?.id === seat.id).length} cuts` && mine?.lead === "2 cuts" && attentionOf(assignedNormal).items.find((i) => i.key === "review-mine")?.lead === "1 cut" && elements(assigned, "MoneyStat").length === 0 && elements(assigned, "QuickAdd").length === 0);
    const reviewTree = await review({ searchParams: Promise.resolve({ test: "1" }) });
    // The simplified Review Room no longer embeds the delivery summary. Check
    // its actual scoped cut rows; the summary's return-link contract follows.
    c.ok("Review Room retains both real and fixture cuts in explicit test view", jobs.every(job => elements(reviewTree, "CutRow").some(row => (row.s as { id: string }).id === job.cut.id)));
    const incident = { projectId: jobs[1].project.id, street: "Fixture-only property", state: "failed" as const, queuedAtISO: now.toISOString(), outboxId: "isolated-outbox", taskId: "isolated-task" };
    const incidentBoard = { ready: [], rendering: [], needsFinishing: [], notTold: [], noticeIncidents: [incident] };
    const card = renderToStaticMarkup(createElement(ReadyToSendCard, { board: incidentBoard, includeTest: true }));
    c.ok("the delivery card keeps the fixture incident task reachable", card.includes('href="/tasks?tab=other&amp;task=isolated-task&amp;test=1"') && card.includes('href="/communications?incident=isolated-outbox"'));
    c.ok("scope helper preserves filters/hash and supported queue scope while keeping exact external/detail routes", homeRecordHref("/tasks?tab=work&who=all&source=slack#task-1", true) === "/tasks?tab=work&who=all&source=slack&test=1#task-1" && homeRecordHref("/#video-review", true) === "/?test=1#video-review" && homeRecordHref("/editing", true) === "/editing?test=1" && homeRecordHref("/schedule", true) === "/schedule?test=1" && ["/communications?tab=replies", "/sales", "/review/project?cut=version", "https://example.test/tasks", "//example.test/tasks", "#shoots"].every((href) => homeRecordHref(href, true) === href));
    c.ok("Home scope reads leave source work, editing state and communications untouched", JSON.stringify(beforeTasks) === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.editorWorkEvent.count() === 0 && await prisma.outboxMessage.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
