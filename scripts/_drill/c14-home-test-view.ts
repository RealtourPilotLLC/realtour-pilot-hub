// C14: explicit Home scope reaches the same operational lists and survives delivery return links.
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
const HOME_FUNCTIONS = new Set(["Block", "BlockBody", "QcDueToday", "LoopsCard", "LoopRow", "VideoReviewCard", "VideoGroup", "Pill", "NeedsToday", "NeedRow"]);
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
    const { default: review } = await import("@/app/review/page");
    const { getReviewQueue } = await import("@/lib/reviewRoom");
    const { boardWhere, photoQcWhere } = await import("@/lib/taskBoard");
    const { clientTextWhere } = await import("@/lib/clientTexts");
    const { unansweredCommsBoard } = await import("@/lib/commsBoard");
    const { homeRecordHref } = await import("@/lib/homeRecordScope");
    const { ReadyToSendCard } = await import("@/components/ops/ReadyToSendCard");
    const { DeliveryExitSummary } = await import("@/components/review/DeliveryExitSummary");
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const real = await prisma.client.create({ data: { name: "Real Agent", firstSeenAt: now } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", firstSeenAt: now } });
    const seat = await prisma.teamMember.create({ data: { name: "Creative Reviewer", email: "c14-creative@example.test", role: "MANAGER" } });
    const owner = await prisma.appUser.create({ data: { name: "Owner", email: "c14-owner@example.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Creative Reviewer", email: seat.email!, role: "ADMIN", teamMemberId: seat.id, status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Editor", email: "c14-editor@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
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
    const render = (test?: string | string[]) => home({ searchParams: Promise.resolve({ test }) });
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
    const normalBlock = elements(normal, "Block")[0];
    const allBlock = elements(all, "Block")[0];
    const normalCounts = normalBlock.counts as { boardOpen: number; qc: number; textsToSend: number; emailsWaiting: number };
    const allCounts = allBlock.counts as typeof normalCounts;
    const normalDay = normalBlock.d as import("../../src/lib/opsDay").OpsDay;
    const allDay = allBlock.d as typeof normalDay;
    const normalScope = { excludeClientIds: [fixture.id] };
    c.ok("normal Home task badge keeps destination membership", normalCounts.boardOpen === 1 && normalCounts.boardOpen === await prisma.smartTask.count({ where: boardWhere(null, normalScope) }));
    c.ok("explicit Home test task badge equals the full destination list", allCounts.boardOpen === 2 && allCounts.boardOpen === await prisma.smartTask.count({ where: boardWhere(null) }));
    c.ok("normal and explicit-test photo/QC badges share destination scope", normalCounts.qc === 1 && allCounts.qc === 2 && normalCounts.qc === await prisma.smartTask.count({ where: photoQcWhere(normalScope) }) && allCounts.qc === await prisma.smartTask.count({ where: photoQcWhere() }));
    c.ok("normal and explicit-test Outbox badges share destination scope", normalCounts.textsToSend === 1 && allCounts.textsToSend === 2 && normalCounts.textsToSend === await prisma.smartTask.count({ where: clientTextWhere(now, normalScope) }) && allCounts.textsToSend === await prisma.smartTask.count({ where: clientTextWhere(now) }));
    c.ok("email badge and operating-day waiting clients restore fixture evidence together", normalCounts.emailsWaiting === (await unansweredCommsBoard("email", now, normalScope)).length && allCounts.emailsWaiting === (await unansweredCommsBoard("email", now)).length && normalCounts.emailsWaiting === 1 && allCounts.emailsWaiting === 2 && normalDay.unanswered.count === 1 && allDay.unanswered.count === 2);
    c.ok("appointment, review and ready-delivery rows use the explicit Home scope", normalDay.todayShoots.length === 1 && allDay.todayShoots.length === 2 && normalDay.videoReview.waiting.length === 1 && allDay.videoReview.waiting.length === 2 && normalDay.readySend.ready.length === 1 && allDay.readySend.ready.length === 2);
    c.ok("new client card restores only the fixture excluded by normal view", (elements(normal, "NewClientCard")[0].clients as { id: string }[]).length === 1 && (elements(all, "NewClientCard")[0].clients as { id: string }[]).length === 2);
    c.ok("test view names supported queue scopes and unchanged Finance definitions", textOf(all).includes("Showing real and test records in Home workloads") && textOf(all).includes("Editing Room, Schedule and delivery lists keep this view") && textOf(all).includes("Finance’s existing definitions") && !textOf(normal).includes("Showing real and test records"));
    const normalLinks = hrefs(expand(normal));
    const allLinks = hrefs(expand(all));
    c.ok("normal Home links do not silently opt into test scope", !normalLinks.some((href) => /[?&]test=1/.test(href) && href !== "/?test=1"));
    c.ok("test workload destinations preserve scope through nested Home blocks", ["/review?test=1", "/content?test=1", "/tasks?tab=work&who=me&test=1", "/communications?tab=outbox&test=1", "/tasks?tab=comms&via=email&test=1", "/tasks?tab=other&test=1", "/tasks?tab=slack&test=1"].every((href) => allLinks.includes(href)), allLinks.join("\n"));
    const fullQc = elements(expand(all), "LoopActions");
    c.ok("synthetic Slack loop deep links retain task ID and scope", fullQc.length === 2 && fullQc.every((p) => String(p.viewHref).includes("tab=slack&task=") && String(p.viewHref).endsWith("&test=1")));
    c.ok("exact-cut links retain recorded version without extra list flags", allLinks.includes(`/review/${jobs[1].project.id}?cut=${jobs[1].cut.id}`));
    c.ok("figures from the books and Finance routes retain their definitions", JSON.stringify(elements(normal, "MoneyStat")) === JSON.stringify(elements(all, "MoneyStat")) && allLinks.includes("/sales") && !allLinks.some((href) => href.startsWith("/sales?")));
    c.ok("only scalar test=1 enables the scope", (elements(await render("true"), "Block")[0].counts as typeof normalCounts).boardOpen === 1 && (elements(await render(["1", "1"]), "Block")[0].counts as typeof normalCounts).boardOpen === 1);
    await signIn(admin);
    const assigned = await render("1");
    const needs = elements(assigned, "NeedsToday")[0].needs as { key: string; count: number; href: string }[];
    c.ok("signed creative reviewer sees the same full assigned queue while retaining money gates", needs.find((n) => n.key === "review-mine")?.count === (await getReviewQueue({ includeTest: true })).pending.filter((cut) => cut.reviewer?.id === seat.id).length && needs.find((n) => n.key === "review-mine")?.count === 2 && elements(assigned, "MoneyStat").length === 0 && elements(assigned, "QuickAdd").length === 0);
    const reviewTree = await review({ searchParams: Promise.resolve({ test: "1" }) });
    c.ok("Review Room carries its existing scope into the delivery-return presentation", elements(reviewTree, "DeliveryExitSummary")[0].includeTest === true);
    const summary = renderToStaticMarkup(createElement(DeliveryExitSummary, { board: allDay.readySend, includeTest: true }));
    c.ok("test delivery return opens Home test view at its original anchor", summary.includes('href="/?test=1#video-review"') && !summary.includes('href="/#video-review"'));
    const incident = { projectId: jobs[1].project.id, street: "Fixture-only property", state: "failed" as const, queuedAtISO: now.toISOString(), outboxId: "isolated-outbox", taskId: "isolated-task" };
    const incidentBoard = { ready: [], rendering: [], needsFinishing: [], notTold: [], noticeIncidents: [incident] };
    const card = renderToStaticMarkup(createElement(ReadyToSendCard, { board: incidentBoard, includeTest: true }));
    const incidentSummary = renderToStaticMarkup(createElement(DeliveryExitSummary, { board: incidentBoard, includeTest: true }));
    c.ok("both delivery surfaces keep the fixture incident task reachable", [card, incidentSummary].every((html) => html.includes('href="/tasks?tab=other&amp;task=isolated-task&amp;test=1"')) && card.includes('href="/communications?incident=isolated-outbox"'));
    c.ok("scope helper preserves filters/hash and supported queue scope while keeping exact external/detail routes", homeRecordHref("/tasks?tab=work&who=all&source=slack#task-1", true) === "/tasks?tab=work&who=all&source=slack&test=1#task-1" && homeRecordHref("/#video-review", true) === "/?test=1#video-review" && homeRecordHref("/editing", true) === "/editing?test=1" && homeRecordHref("/schedule", true) === "/schedule?test=1" && ["/communications?tab=replies", "/sales", "/review/project?cut=version", "https://example.test/tasks", "//example.test/tasks", "#shoots"].every((href) => homeRecordHref(href, true) === href));
    c.ok("Home scope reads leave source work, editing state and communications untouched", JSON.stringify(beforeTasks) === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.editorWorkEvent.count() === 0 && await prisma.outboxMessage.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
