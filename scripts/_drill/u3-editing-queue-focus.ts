// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Signed page reads and actual SSR; no providers or workflow mutations.
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { QueueRow } from "../../src/components/editing/SimpleQueue";
import type { EditorsTodayView } from "../../src/lib/editorActivity";

installNextStubs();
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
let search = "";
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Redirect(href); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams(search);
}

function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5928), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-editing-focus" } });
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/editing/page");
    const { EditingWorkSummary } = await import("@/components/editing/EditingWorkSummary");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const now = new Date();
    const before = new Date(now.getTime() - 2 * 86_400_000);
    // This layout/assignment fixture belongs to the normal office scope. The
    // dedicated C14 drill covers explicit fixture visibility and creative work.
    const client = await prisma.client.create({ data: { name: "Editing focus Agent" } });
    const kimMember = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-focus@example.test", role: "EDITOR" } });
    const johnMember = await prisma.teamMember.create({ data: { name: "John Mark", email: "john-focus@example.test", role: "EDITOR" } });
    const shooter = await prisma.teamMember.create({ data: { name: "Photo Fixture", email: "photo-focus@example.test", role: "PHOTOGRAPHER" } });
    const user = (name: string, role: string, editorKey?: string, teamMemberId?: string) => prisma.appUser.create({ data: { name, email: `${name.replaceAll(" ", "-")}@example.test`, role, status: "ACTIVE", editorKey, teamMemberId } });
    const owner = await user("Queue Owner", "OWNER");
    const kim = await user("Kim Miguel", "EDITOR", "kim", kimMember.id);
    const unmapped = await user("Unmapped Fixture", "EDITOR");
    const photographer = await user("Photo Fixture", "PHOTOGRAPHER", undefined, shooter.id);
    const project = async (title: string, key: "kim" | "john" | null, assigned: boolean) => {
      const job = await prisma.project.create({ data: { title, clientId: client.id, status: "SHOT", shootDate: before, deliveryDue: before,
        photographerId: shooter.id, editorId: key === "kim" ? kimMember.id : key === "john" ? johnMember.id : null,
        statusEvidence: JSON.stringify({ dropbox: { rawVideo: 2 } }),
        deliverables: { create: { type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } },
      } });
      if (assigned) await prisma.smartTask.create({ data: { projectId: job.id, clientId: client.id, title: `Edit ${title}`, taskType: "edit_video", status: "OPEN", assignedKey: key, assignedManually: true } });
      return job;
    };
    const active = await project("10 Active Avenue", "kim", true);
    await project("20 Next Avenue", "kim", true);
    const johnJob = await project("30 Other Lane", "john", true);
    const predicted = await project("40 Routing Lane", null, false);
    const unassigned = await project("50 Unassigned Lane", null, true);
    await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "john", personalBranding: null }) } });
    await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: active.id, state: "ACTIVE", activeFor: "kim", firstStartedAt: before, activeSince: before, lastEventAt: before } });
    await prisma.mediaNote.create({ data: { projectId: johnJob.id, assetUrl: "/isolated/fixture.mp4", body: "Fixture editor note", authorKey: "editor:john", createdAt: now } });
    await prisma.capacityException.create({ data: { teamMemberId: kimMember.id, kind: "TRAINING", startsAt: before, endsAt: new Date(now.getTime() + 86_400_000), recordedBy: "Fixture owner" } });
    const signIn = (u: typeof owner) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    await clearSession();
    let anonymous = "";
    try { await page({}); } catch (error) {
      if (error instanceof Redirect) anonymous = error.href;
      else if (error instanceof Error && "digest" in error && typeof error.digest === "string" && error.digest.startsWith("NEXT_REDIRECT;")) anonymous = error.digest.split(";")[2];
      else throw error;
    }
    c.ok("anonymous editing page fails closed", anonymous.startsWith("/login"));
    await signIn(owner);
    const tree = await page({});
    const html = renderToStaticMarkup(tree);
    c.ok("signed owner sees summary and queue before collapsed diagnostics", html.indexOf('aria-label="Editors today"') < html.indexOf('id="editing-queue-heading"') && html.indexOf('id="editing-queue-heading"') < html.indexOf('id="editing-capacity"') && /<details[^>]*id="editing-capacity"[^>]*>/.test(html) && !/<details[^>]*id="editing-capacity"[^>]*open/.test(html));
    c.ok("manual add remains alongside queue and counts name their units", html.includes("Add a job to the queue") && html.includes("open projects") && html.includes("videos to edit") && html.includes("overdue projects"));
    c.ok("capacity exception remains visible on collapsed summary", html.includes("recorded availability") && html.includes("change") && html.includes("in force"));
    const summary = elements(tree, "EditingWorkSummary")[0].view as EditorsTodayView;
    const summaryHtml = renderToStaticMarkup(createElement(EditingWorkSummary, { view: summary }));
    c.ok("compact summary distinguishes explicit Start from a note", summaryHtml.includes("Pressed Start") && summaryHtml.includes("10 Active Avenue") && summaryHtml.includes("Last action") && summaryHtml.includes("wrote a note on") && summaryHtml.includes("hasn&#x27;t pressed Start today"));
    const queue = elements(tree, "SimpleQueue")[0];
    const rows = queue.notDone as QueueRow[];
    const actual = await buildEditorQueue();
    c.ok("queue keeps exact status, due and assignment from existing reader", rows.every((r) => { const original = actual.notDone.find((value) => value.id === r.id); return original?.status === r.status && original.dueISO === r.dueISO && original.assignmentState === r.assignmentState; }));
    c.ok("saved assignment, routing suggestion and explicit unassignment remain distinct", rows.find((r) => r.id === active.id)?.assignmentState === "assigned" && rows.find((r) => r.id === predicted.id)?.assignmentState === "predicted" && rows.find((r) => r.id === unassigned.id)?.assignmentState === "unassigned");
    const suggested = rows.find((r) => r.id === predicted.id)!;
    c.ok("predicted routing is displayed as Unassigned with a separate suggestion", html.includes(`Change editor for ${suggested.street}: Unassigned`) && html.includes(`Suggested: ${suggested.editor}`));
    c.ok("saved editor assignment uses floating menu instead of an inline select drawer", html.includes(`Change editor for ${rows.find((r) => r.id === active.id)!.street}: Kim`) && !html.includes('aria-label="Assign editor"'));
    c.ok("queue retains stacked mobile cards and office More menu", html.includes("lg:table-row") && html.includes("More actions") && html.includes("Open work") && html.includes("Completed"));
    search = "editor=kim&due=overdue";
    const filtered = renderToStaticMarkup(await page({}));
    c.ok("Kim overdue URL survives queue-to-brief links", filtered.includes(`href="/edit/${active.id}?queue=editor%3Dkim%26due%3Doverdue"`) && !filtered.includes(`href="/edit/${johnJob.id}?queue=`));
    search = "";
    await signIn(kim);
    const editorTree = await page({});
    const editorHtml = renderToStaticMarkup(editorTree);
    const own = elements(editorTree, "SimpleQueue")[0];
    c.ok("signed Kim retains scoped queue and explicit desk before it", own.hideEditor === true && (own.notDone as QueueRow[]).every((r) => r.editorKey === "kim") && elements(editorTree, "EditorDesk").length === 1 && !editorHtml.includes('id="editing-capacity"') && !editorHtml.includes("Add a job to the queue"));
    c.ok("editor first paint preserves manual Pause and no rare office controls", editorHtml.includes("Pause") && !editorHtml.includes("More actions"));
    await signIn(unmapped);
    const unmappedTree = await page({});
    const unmappedQueues = elements(unmappedTree, "SimpleQueue");
    c.ok("unmapped editor still receives no company rows", unmappedQueues.every((props) => ([...props.notDone as QueueRow[], ...props.upcoming as QueueRow[], ...props.done as QueueRow[]]).length === 0) && elements(unmappedTree, "EditingWorkSummary").length === 0);
    await signIn(photographer);
    const photoTree = await page({});
    c.ok("photographer retains own separate board and no office diagnostics", elements(photoTree, "PhotographerJobs").length === 1 && elements(photoTree, "SimpleQueue").length === 0 && elements(photoTree, "EditingWorkSummary").length === 0);
    const failed = renderToStaticMarkup(createElement(EditingWorkSummary, { view: { ok: false, readAt: now.toISOString(), error: "fixture failure" } }));
    const stale = renderToStaticMarkup(createElement(EditingWorkSummary, { view: { ok: true, readAt: before.toISOString(), lines: [] } }));
    c.ok("summary failed and stale reads are explicit, not idle claims", failed.includes("work state is unknown") && failed.includes('role="status"') && stale.includes("may be out of date"));
    c.ok("presentation creates no Start/Pause events, sends or provider calls", await prisma.editorWorkEvent.count() === 0 && await prisma.outboxMessage.count() === 0 && (await prisma.editorWorkItem.findFirstOrThrow()).state === "ACTIVE" && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
