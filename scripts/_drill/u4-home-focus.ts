// U4 Home role orientation, reader parity and preserved delivery/checklist anchors.
// Oct 19 2026 (evening): Kyle's Home is the summary box and ONE simplified
// daily checklist (Jordan: "The home screen should have the daily checklist,
// but with a box up top that summarizes the photo delivery, video delivery,
// and comms needing responses"); the ten time blocks are gone and every old
// block anchor lives inside a checklist group on his Home. Expectations
// changed only where that was the point.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
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
function namesOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(namesOf);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [typeof type === "string" ? type : type.name ?? "", ...Object.values(tree.props).flatMap(namesOf)];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
// Oct 5: Home streams its secondary sections (Suspense around async server
// components that await reads started with the page's own). Resolve those
// named components so the checks read the page as it finishes composing.
const STREAMED_HOME = new Set(["HomeExceptions", "OwnerBusiness", "OwnerWeekSection", "OwnerBehindSection", "OwnerShootIssues", "OwnerKylesDay", "OpsExceptions", "OpsRadar"]);
async function settleHome(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settleHome));
  if (!isValidElement<Record<string, unknown>>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED_HOME.has(tree.type.name)) return settleHome(await (tree.type as (props: Record<string, unknown>) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([key, value]) => [key, await settleHome(value)] as const))) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
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
    await signIn(james);
    const reviewTree = await page({});
    c.ok("creative orientation derives from saved primary seat, without name matching", textOf(reviewTree).includes("Your creative review desk"));
    const reviewNeeds = elements(reviewTree, "NeedsToday")[0]?.needs as { key: string; count: number; href: string; detail?: string }[];
    const actualQueue = await getReviewQueue({ includeTest: false });
    c.ok("assigned cut count equals the authoritative normal Review Room source", reviewNeeds.find((n) => n.key === "review-mine")?.count === actualQueue.pending.filter((r) => r.reviewer?.id === jamesTm.id).length && reviewNeeds.find((n) => n.key === "review-mine")?.count === 1);
    c.ok("primary review action opens the exact assigned version and keeps age", reviewNeeds[0].href === `/review/${realJob.id}?cut=${mine.id}` && reviewNeeds[0].detail?.includes("1h") === true);
    c.ok("other review owners remain explicit coverage rather than personal assignment", reviewNeeds.find((n) => n.key === "review-coverage")?.count === 1 && !reviewNeeds.some((n) => n.key === "cuts"));
    c.ok("creative lead receives no owner financial or private-task sections", elements(reviewTree, "MoneyStat").length === 0 && elements(reviewTree, "QuickAdd").length === 0 && elements(reviewTree, "PulseStrip").length === 0);
    failReviewRead = true;
    const failedQueueTree = await page({});
    failReviewRead = false;
    const failedNeeds = elements(failedQueueTree, "NeedsToday")[0]?.needs as { key: string; count: number }[];
    c.ok("failed assigned-review read retains known general queue and explicit warning", textOf(failedQueueTree).includes("The review queue could not be loaded") && failedNeeds.some((n) => n.key === "cuts" && n.count === 2));
    await signIn(kyle);
    const opsTree = await page({});
    // Oct 19 2026 (evening): Kyle's operations Home is the summary box and the daily checklist.
    c.ok("backup reviewer retains the operations first screen", elements(opsTree, "SummaryBox").length === 1 && elements(opsTree, "DailyChecklist").length === 1 && !textOf(opsTree).includes("Your creative review desk"));
    c.ok("the old ten time blocks are on no Home; the review desk carries no checklist",
      [opsTree, reviewTree].every((t) => elements(t, "HomeRoutine").length === 0 && elements(t, "Block").length === 0) && elements(reviewTree, "DailyChecklist").length === 0);
    const list = elements(opsTree, "DailyChecklist")[0]?.list as import("../../src/lib/opsHome").KyleChecklist;
    const { GROUP_ALIASES } = await import("@/lib/homeAnchors");
    // Oct 13 2026 (Jordan's audit) kept every block the old anchors link to;
    // Oct 19 each of those ids is an anchor inside the group holding its work.
    c.ok("every anchor the old blocks used lands inside a checklist group", list.groups.map((g) => g.key).join() === "deliveries,messages,requests,scheduling,followups" && ["tower", "video-review", "comms-1", "qc-am", "loops", "closeout"].every((id) => Object.values(GROUP_ALIASES).some((a) => a.includes(id))));
    c.ok("Kyle's summary box comes before the checklist", namesOf(opsTree).indexOf("SummaryBox") < namesOf(opsTree).indexOf("DailyChecklist"));
    // The delivery evidence and actions live with the video (Video Review
    // Room); Kyle's Videos number opens it and each video line opens its cut.
    c.ok("delivery evidence/actions stay one tap away: the Videos number opens the Video Review Room", (await import("@/lib/opsHome")).SUMMARY_HREF.videos === "/review" && list.groups[0].lines.filter((l) => l.key.startsWith("video:")).every((l) => l.href.startsWith("/review/")));
    await signIn(owner);
    const ownerTree = await page({});
    c.ok("owner Home carries no checklist (Kyle's day is read from his)", elements(ownerTree, "HomeRoutine").length === 0 && elements(ownerTree, "Block").length === 0 && elements(ownerTree, "DailyChecklist").length === 0 && elements(ownerTree, "KylesDay").length === 1);
    c.ok("owner view preserves this week, what is behind, his private list and the money", elements(ownerTree, "OwnerWeekCard").length === 1 && elements(ownerTree, "BehindCard").length === 1 && elements(ownerTree, "QuickAdd").length === 1 && elements(ownerTree, "PulseStrip").length === 1);
    c.ok("Home presentation never completes tasks or starts editing", (await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } })).status === "OPEN" && await prisma.editorWorkEvent.count() === 0);
    c.ok("Home checks reach no providers and send no client communication", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
