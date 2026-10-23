// U4 Home role orientation, reader parity and preserved delivery/checklist anchors.
// Oct 19 2026 (night): "/" is ONE dashboard for the owner and every office
// login (Jordan: "The home page should really be a dashboard to oversee
// everything going on"); the review seat's desk and Kyle's checklist left
// Home (the list is its own page, /ops/checklist, and every old block anchor
// lives inside one of its groups). Expectations changed only where that was
// the point: the review seat's assigned cuts are a "Needs attention" line,
// the coverage count is the QC & review tile, a failed review read greys
// that tile, and the owner's private list lives on My Day.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
let failReviewRead = false;
interceptModule((request) => request === "@/lib/reviewRoom" || /src[\/]lib[\/]reviewRoom(?:\.ts)?$/.test(request), (loaded) => {
  const original = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...original, getReviewQueue: (...args: Parameters<typeof original.getReviewQueue>) => failReviewRead ? Promise.reject(new Error("Isolated read failure")) : original.getReviewQueue(...args) };
});
function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
// Oct 5: Home streams its secondary sections (Suspense around async server
// components that await reads started with the page's own). Resolve those
// named components so the checks read the page as it finishes composing.
const STREAMED_HOME = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "OfficeDeskSection", "OwnerHome", "FinanceSection", "ProductionSection", "ClientIssuesSection", "TeamSection", "MeetingsSection", "CreativeSection", "EmailSectionView", "DelegatedSection", "WeeklySection", "TaskOpen"]);
async function settleHome(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settleHome));
  if (!isValidElement<Record<string, unknown>>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED_HOME.has(tree.type.name)) return settleHome(await (tree.type as (props: Record<string, unknown>) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([key, value]) => [key, await settleHome(value)] as const))) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
navigation.redirect = (href) => { throw new Redirect(href); };

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5843), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-home-focus" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: home } = await import("@/app/page");
    const page = async (props: Parameters<typeof home>[0]) => settleHome(await home(props));
    const { getReviewQueue } = await import("@/lib/reviewRoom");
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "Creative Lead", role: "MANAGER", email: "home-creative@example.test" } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Ops Lead", role: "MANAGER", email: "home-ops@example.test" } });
    const user = (name: string, email: string, role: string, teamMemberId?: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const james = await user("Creative Lead", jamesTm.email!, "ADMIN", jamesTm.id);
    const kyle = await user("Ops Lead", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Owner", "home-owner@example.test", "OWNER");
    const editor = await user("Kim", "home-kim@example.test", "EDITOR");
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id }) } });
    const now = new Date();
    const project = async (clientId: string, title: string) => prisma.project.create({ data: { clientId, title, status: "REVIEW", deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 1 } } }, include: { deliverables: true } });
    const realJob = await project(real.id, "123 TEST Avenue");
    const otherJob = await project(real.id, "456 Main Street");
    const fixtureJob = await project(fixture.id, "Fixture-only property");
    const cut = (p: typeof realJob, reviewerTeamMemberId: string) => prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: p.deliverables[0].id, slot: 1, source: "folder", kind: "video", status: "PENDING", reviewerTeamMemberId, submittedByKey: "kim", assetPath: `/isolated/${p.id}.mp4`, createdAt: new Date(now.getTime() - 3_600_000) } });
    const mine = await cut(realJob, jamesTm.id);
    await cut(otherJob, kyleTm.id);
    await cut(fixtureJob, jamesTm.id);
    const task = await prisma.smartTask.create({ data: { title: "Assign this operational work", taskType: "todo", source: "manual", dueAt: new Date(now.getTime() - 2 * 86_400_000), projectId: realJob.id } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await clearSession();
    let anonymous = "";
    try { await page({}); } catch (e) { if (e instanceof Redirect) anonymous = e.href; else throw e; }
    c.ok("anonymous Home still fails closed", anonymous === "/login");
    await signIn(editor);
    let creative = "";
    try { await page({}); } catch (e) { if (e instanceof Redirect) creative = e.href; else throw e; }
    c.ok("editor still reaches own editing surface instead of office Home", creative === "/editing");
    // Oct 19 2026 (night): ONE DASHBOARD for the owner and every office
    // login. The review seat's desk is gone; his assigned cuts are his own
    // line in "Needs attention now", from the same Review Room source.
    await signIn(james);
    const reviewTree = await page({});
    const attentionOf = (tree: unknown) => elements(tree, "NeedsAttention")[0]?.attention as import("../../src/lib/opsHome").Dashboard["attention"];
    const healthOf = (tree: unknown) => elements(tree, "HealthStrip")[0]?.health as import("../../src/lib/opsHome").Dashboard["health"];
    c.ok("the review seat gets the dashboard (no separate desk)", elements(reviewTree, "HealthStrip").length === 1 && elements(reviewTree, "NeedsToday").length === 0 && !textOf(reviewTree).includes("Your creative review desk"));
    const mineLine = attentionOf(reviewTree).items.find((i) => i.key === "review-mine");
    const actualQueue = await getReviewQueue({ includeTest: false });
    c.ok("assigned cut count equals the authoritative normal Review Room source", mineLine?.lead === `${actualQueue.pending.filter((r) => r.reviewer?.id === jamesTm.id).length} cut` && actualQueue.pending.filter((r) => r.reviewer?.id === jamesTm.id).length === 1, JSON.stringify(mineLine));
    c.ok("primary review action opens the exact assigned version and keeps age", mineLine?.action.href === `/review/${realJob.id}?cut=${mine.id}` && mineLine?.owner.includes("1h") === true);
    c.ok("everyone's waiting cuts are the QC & review tile's number, not a personal assignment", healthOf(reviewTree).qc?.toReview === actualQueue.pending.length && actualQueue.pending.length === 2);
    c.ok("creative lead receives no owner financial or private-task sections", elements(reviewTree, "MoneyStat").length === 0 && elements(reviewTree, "QuickAdd").length === 0 && elements(reviewTree, "PulseStrip").length === 0 && elements(reviewTree, "OwnerWeekCard").length === 0);
    failReviewRead = true;
    const failedQueueTree = await page({});
    failReviewRead = false;
    c.ok("failed review read says so (never a reassuring zero) and keeps the rest of the dashboard", healthOf(failedQueueTree).qc?.toReview === null && attentionOf(failedQueueTree).unavailable.includes("the review queue") && !attentionOf(failedQueueTree).items.some((i) => i.key === "review-mine") && elements(failedQueueTree, "HealthStrip").length === 1 && elements(failedQueueTree, "NeedsAttention").length === 1);
    await signIn(kyle);
    const opsTree = await page({});
    // Oct 23 2026: the office's home is Kyle's desk (lib/officeDesk); the review seat keeps the dashboard above.
    const opsDesk = elements(opsTree, "OfficeDesk")[0]?.desk as import("../../src/lib/officeDesk").OfficeDesk | undefined;
    c.ok("the backup reviewer (the office) gets his desk, with the list one tap away (no review desk, no creative review)", !!opsDesk && elements(opsTree, "HealthStrip").length === 0 && elements(opsTree, "KylesDayCard").length === 0 && elements(opsTree, "DailyChecklist").length === 0 && !textOf(opsTree).includes("Your creative review desk"));
    c.ok("the old ten time blocks are on no Home; the checklist is on its own page", [opsTree, reviewTree].every((t) => elements(t, "HomeRoutine").length === 0 && elements(t, "Block").length === 0 && elements(t, "DailyChecklist").length === 0));
    const { GROUP_ALIASES, forwardedHref } = await import("@/lib/homeAnchors");
    // Oct 13 2026 (Jordan's audit) kept every block the old anchors link to;
    // Oct 19 each of those ids is an anchor inside the list group holding its
    // work, and the dashboard forwards it there (Messages for the comms one).
    c.ok("every anchor the old blocks used lands inside a list group, forwarded from the dashboard", ["tower", "video-review", "comms-1", "qc-am", "loops", "closeout"].every((id) => Object.values(GROUP_ALIASES).some((a) => a.includes(id))) && ["tower", "video-review", "qc-am", "loops", "closeout"].every((id) => forwardedHref("/", "", `#${id}`) === `/ops/checklist#${id}`) && forwardedHref("/", "", "#comms-1") === "/communications");
    const { default: listPage } = await import("@/app/ops/checklist/page");
    const list = elements(await listPage({}), "DailyChecklist")[0]?.list as import("../../src/lib/opsHome").KyleChecklist;
    // The delivery evidence and actions live with the video (Video Review
    // Room); the dashboard's QC tile opens it and each video line its cut.
    const deliveryRows = opsDesk?.sections.find((s) => s.key === "deliver");
    c.ok("delivery evidence/actions stay one tap away: every Review & Deliver row opens its job, every list video line its cut", !!deliveryRows && [...deliveryRows.now, ...deliveryRows.waiting].every((i) => !!i.href) && list.groups[0].lines.filter((l) => l.key.startsWith("video:")).every((l) => l.href.startsWith("/review/")));
    // Oct 23 2026: the owner's "/" is his own dashboard (components/owner/
    // OwnerHome): the office shows as a row of Team coverage, the week and the
    // money as their own sections.
    await signIn(owner);
    const ownerTree = await page({});
    const ownerHtml = renderToStaticMarkup(ownerTree as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("owner dashboard carries no checklist (the office is a row of Team coverage)", elements(ownerTree, "HomeRoutine").length === 0 && elements(ownerTree, "Block").length === 0 && elements(ownerTree, "DailyChecklist").length === 0 && ownerHtml.includes(`data-section="team"`) && ownerHtml.includes("data-coverage="));
    c.ok("owner view keeps the week and the money (his private list lives on My Day)", ownerHtml.includes('data-section="weekly"') && (ownerHtml.match(/data-figure=/g) ?? []).length === 5 && elements(ownerTree, "QuickAdd").length === 0);
    c.ok("Home presentation never completes tasks or starts editing", (await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } })).status === "OPEN" && await prisma.editorWorkEvent.count() === 0);
    c.ok("Home checks reach no providers and send no client communication", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
