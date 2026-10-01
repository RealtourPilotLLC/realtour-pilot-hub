// C14: office queue, diagnostics, schedule and return context use the Home record scope.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { QueueRow } from "../../src/components/editing/SimpleQueue";
import type { WorkingNow } from "../../src/lib/editorWork";
import type { ActivityToday } from "../../src/lib/editorActivity";

installNextStubs();
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
let search = "";
const load = createRequire(__filename);
// Next bundles this stylesheet. This Node fixture inspects Schedule's actual
// server-built pin props and does not render or accept browser map styling.
load.extensions[".css"] = () => { /* stylesheet loading belongs to Next */ };
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Redirect(href); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams(search);
}
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function hrefs(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(hrefs);
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeof tree.props.href === "string" ? [tree.props.href] : []), ...Object.values(tree.props).flatMap(hrefs)];
}
function queueRows(tree: unknown, key: "notDone" | "upcoming" | "done") {
  return elements(tree, "SimpleQueue")[0]?.[key] as QueueRow[] | undefined ?? [];
}
async function settleSchedule(tree: unknown): Promise<unknown> {
  if (isValidElement<Props>(tree) && typeof tree.type === "function" && ["ListView", "MapView"].includes(tree.type.name)) return (tree.type as (props: Props) => Promise<unknown>)(tree.props);
  return tree;
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5941), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-c14-queue-scope" } });
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: editing } = await import("@/app/editing/page");
    const { default: schedule } = await import("@/app/schedule/page");
    const { default: home } = await import("@/app/page");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const { workingNow } = await import("@/lib/editorWork");
    const { editorActivityToday } = await import("@/lib/editorActivity");
    const { getShootWindow, getOwnerDials } = await import("@/lib/queries");
    const { editingQueueHref, queueReturnHref } = await import("@/lib/editingQueueUrl");
    const { WeekStrip } = await import("@/components/dashboard/WeekStrip");
    const { QualityDials } = await import("@/components/dashboard/QualityDials");
    const { ScheduleViewToggle } = await import("@/components/schedule/ScheduleViewToggle");
    const { NEVER_SYNTHETIC_CLIENT_IDS } = await import("@/lib/testClients");
    const { queueRemovedKey } = await import("@/lib/queueRemoved");
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const kimMember = await prisma.teamMember.create({ data: { name: "Kim Miguel", role: "EDITOR", email: "c14-kim@example.test" } });
    const johnMember = await prisma.teamMember.create({ data: { name: "John Mark", role: "EDITOR", email: "c14-john@example.test" } });
    const shooter = await prisma.teamMember.create({ data: { name: "Photographer", role: "PHOTOGRAPHER", email: "c14-photo@example.test" } });
    const user = (name: string, role: string, editorKey?: string, teamMemberId?: string) => prisma.appUser.create({ data: { name, role, editorKey, teamMemberId, email: `${name.replaceAll(" ", "-")}@example.test`, status: "ACTIVE" } });
    const owner = await user("Scope Owner", "OWNER");
    const admin = await user("Scope Admin", "ADMIN");
    const kim = await user("Kim Miguel", "EDITOR", "kim", kimMember.id);
    const photographer = await user("Photographer", "PHOTOGRAPHER", undefined, shooter.id);
    const unmapped = await user("Unmapped editor", "EDITOR");
    await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "john", personalBranding: null }) } });
    const job = (clientId: string, title: string, status: "EDITING" | "SHOT" | "SCHEDULED" | "DELIVERED" | "CANCELLED", key: "kim" | "john", shootDate = at(-1), coordinates = true) => prisma.project.create({ data: {
      clientId, title, status, shootDate, deliveryDue: at(1), deliveredAt: status === "DELIVERED" ? at(-2) : null,
      editorId: key === "kim" ? kimMember.id : johnMember.id, photographerId: shooter.id,
      lat: coordinates ? 40.1 : null, lng: coordinates ? -75.1 : null,
      statusEvidence: JSON.stringify({ dropbox: { rawVideo: 2 } }),
      deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 1 } },
    } });
    const realActive = await job(real.id, "123 TEST Avenue", "EDITING", "kim");
    const fixtureActive = await job(fixture.id, "Fixture active job", "EDITING", "john");
    const fixtureKim = await job(fixture.id, "Fixture assigned to Kim", "SHOT", "kim");
    const realPaused = await job(real.id, "Real paused job", "EDITING", "kim");
    const fixtureClaim = await job(fixture.id, "Fixture unconfirmed start", "EDITING", "john");
    const realFuture = await job(real.id, "Real upcoming visit", "SCHEDULED", "kim", at(2));
    const fixtureFuture = await job(fixture.id, "Fixture upcoming visit", "SCHEDULED", "john", at(2));
    const protectedFuture = await job(protectedReal.id, "Protected TEST visit", "SCHEDULED", "kim", at(3));
    const longerFuture = await job(real.id, "Real visit after Home week", "SCHEDULED", "kim", at(20));
    const farFuture = await job(real.id, "Real visit after Schedule horizon", "SCHEDULED", "kim", at(100));
    const noCoordinates = await job(real.id, "Real visit without coordinates", "SCHEDULED", "kim", at(3), false);
    const delivered = await job(real.id, "Real delivered job", "DELIVERED", "kim");
    const cancelled = await job(real.id, "Real cancelled visit", "CANCELLED", "kim", at(2));
    const removedReal = await job(real.id, "Real removed job", "SHOT", "kim");
    const removedFixture = await job(fixture.id, "Fixture removed job", "SHOT", "john");
    for (const project of [realActive, fixtureActive, fixtureKim, realPaused, fixtureClaim]) await prisma.smartTask.create({ data: { projectId: project.id, clientId: project.clientId, taskType: "edit_video", title: `Edit ${project.title}`, assignedKey: project.editorId === kimMember.id ? "kim" : "john", assignedManually: true } });
    for (const [project, key, state] of [[realActive, "kim", "ACTIVE"], [fixtureActive, "john", "ACTIVE"], [realPaused, "kim", "PAUSED"]] as const) await prisma.editorWorkItem.create({ data: { projectId: project.id, editorKey: key, state, activeFor: state === "ACTIVE" ? key : null, firstStartedAt: at(-1), activeSince: state === "ACTIVE" ? at(-1) : null, pausedAt: state === "PAUSED" ? now : null, lastEventAt: now } });
    for (const project of [realFuture, fixtureFuture, protectedFuture, longerFuture, farFuture, noCoordinates, delivered, cancelled]) await prisma.appointment.create({ data: { aryeoId: `isolated-${project.id}`, projectId: project.id, status: "SCHEDULED", startAt: project.status === "DELIVERED" ? at(2) : project.shootDate, assignedToId: shooter.id } });
    for (const project of [removedReal, removedFixture]) await prisma.appSetting.create({ data: { key: queueRemovedKey(project.id), value: JSON.stringify({ by: "Fixture owner", at: now.toISOString(), note: "Isolated removal", task: null }) } });
    // More fixture rows than the Done cap: the old real delivery must survive
    // normal filtering before the database's 60-row display limit.
    await prisma.project.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ id: `isolated-fixture-done-${i}`, clientId: fixture.id, title: `Fixture delivery ${i}`, status: "DELIVERED" as const, shootDate: at(-1), deliveredAt: now, deliveryDue: now, editorId: johnMember.id })) });
    await prisma.deliverable.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ projectId: `isolated-fixture-done-${i}`, type: "VIDEO" as const, label: "Property video", quantity: 1 })) });
    await prisma.mediaNote.create({ data: { projectId: realActive.id, assetUrl: "/isolated/real.mp4", body: "Real editor note", authorKey: "editor:kim", createdAt: new Date(now.getTime() - 1000) } });
    await prisma.mediaNote.createMany({ data: Array.from({ length: 70 }, (_, i) => ({ projectId: fixtureKim.id, assetUrl: "/isolated/fixture.mp4", body: `Fixture editor note ${i}`, authorKey: "editor:kim", createdAt: now })) });
    const excluded = (await prisma.project.findMany({ where: { clientId: fixture.id }, select: { id: true } })).map((p) => p.id);
    const sourceSnapshot = async () => JSON.stringify({ projects: await prisma.project.findMany({ orderBy: { id: "asc" } }), tasks: await prisma.smartTask.findMany({ orderBy: { id: "asc" } }), work: await prisma.editorWorkItem.findMany({ orderBy: { id: "asc" } }), events: await prisma.editorWorkEvent.findMany({ orderBy: { id: "asc" } }), settings: await prisma.appSetting.findMany({ where: { OR: [{ key: "editor_routing" }, { key: { startsWith: "editing-removed:" } }] }, orderBy: { key: "asc" } }) });
    const before = await sourceSnapshot();
    const signIn = (u: typeof owner) => setSession({ uid: u.id, email: u.email, role: u.role });
    const edit = async (query = "") => { search = query; return editing({ searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(query))) }); };
    await clearSession();
    let anonymous = "";
    try { await edit("test=1"); } catch (error) { if (error instanceof Redirect) anonymous = error.href; else if (error instanceof Error && "digest" in error) anonymous = String(error.digest); else throw error; }
    c.ok("scope switch cannot bypass Editing authentication", anonymous.includes("login"));
    await signIn(owner);
    const normalTree = await edit();
    const fullTree = await edit("test=1");
    const normalReader = await buildEditorQueue({ excludeClientIds: [fixture.id] });
    const fullReader = await buildEditorQueue();
    const ids = (rows: QueueRow[]) => rows.map((r) => r.id).sort().join(",");
    c.ok("normal office rails use the same filtered reader and retain real TEST addresses", ids(queueRows(normalTree, "notDone")) === ids(normalReader.notDone) && queueRows(normalTree, "notDone").some((r) => r.id === realActive.id) && !queueRows(normalTree, "notDone").some((r) => excluded.includes(r.id)));
    c.ok("explicit office test view restores fixtures without changing row assignment or due", ids(queueRows(fullTree, "notDone")) === ids(fullReader.notDone) && queueRows(fullTree, "notDone").some((r) => r.id === fixtureKim.id) && queueRows(normalTree, "notDone").every((r) => { const all = fullReader.notDone.find((x) => x.id === r.id); return all?.editorKey === r.editorKey && all.dueISO === r.dueISO && all.status === r.status; }));
    c.ok("normal Done rail filters before 60-row cap, full cap contract unchanged", normalReader.done.some((r) => r.id === delivered.id) && normalReader.done.length === 1 && fullReader.done.length === 60 && !fullReader.done.some((r) => r.id === delivered.id));
    c.ok("normal future queue retains protected real identities and its unlimited horizon", queueRows(normalTree, "upcoming").some((r) => r.id === protectedFuture.id) && queueRows(normalTree, "upcoming").some((r) => r.id === farFuture.id) && !queueRows(normalTree, "upcoming").some((r) => r.id === fixtureFuture.id));
    const normalWork: WorkingNow = await workingNow({ excludeProjectIds: excluded });
    const fullWork = await workingNow();
    c.ok("office work diagnostic filters fixture Active and unconfirmed rows, preserving real Pause", normalWork.ok && fullWork.ok && normalWork.editors.some((e) => e.active?.projectId === realActive.id) && normalWork.editors.some((e) => e.paused.some((p) => p.projectId === realPaused.id)) && !normalWork.editors.some((e) => e.active?.projectId === fixtureActive.id || e.unconfirmed.some((p) => p.projectId === fixtureClaim.id)) && fullWork.editors.some((e) => e.active?.projectId === fixtureActive.id) && fullWork.editors.some((e) => e.unconfirmed.some((p) => p.projectId === fixtureClaim.id)));
    const normalActivity: ActivityToday = await editorActivityToday({ excludeProjectIds: excluded });
    const fullActivity = await editorActivityToday();
    c.ok("normal activity filters before per-editor item cap so real evidence survives", normalActivity.ok && fullActivity.ok && normalActivity.editors.kim.items.some((r) => r.projectId === realActive.id) && !normalActivity.editors.kim.items.some((r) => r.projectId === fixtureKim.id) && fullActivity.editors.kim.items.every((r) => r.projectId === fixtureKim.id));
    c.ok("normal and test removal undo views use the same office record scope", (elements(normalTree, "RecentlyRemoved")[0].rows as { projectId: string }[]).map((r) => r.projectId).join() === removedReal.id && (elements(fullTree, "RecentlyRemoved")[0].rows as { projectId: string }[]).some((r) => r.projectId === removedFixture.id));
    const safe = editingQueueHref(new URLSearchParams("view=upcoming&editor=kim&due=overdue&stage=editing&test=1&token=private&draft=private"));
    c.ok("office filters and safe queue return preserve only explicit test=1", safe === "/editing?view=upcoming&editor=kim&due=overdue&stage=editing&test=1" && queueReturnHref(safe.split("?")[1]) === safe && !editingQueueHref(new URLSearchParams("test=true")).includes("test") && !editingQueueHref(new URLSearchParams("test=1&editor=kim"), undefined, true).includes("test"));
    const filteredHtml = renderToStaticMarkup(await edit("editor=kim&stage=editing&test=1"));
    c.ok("actual queue-to-job context preserves test scope and exact project", filteredHtml.includes(`href="/edit/${realActive.id}?queue=editor%3Dkim%26stage%3Dediting%26test%3D1"`));
    await signIn(admin);
    c.ok("signed admin gets the same normal and explicit-test office rails", ids(queueRows(await edit(), "notDone")) === ids(normalReader.notDone) && ids(queueRows(await edit("test=1"), "notDone")) === ids(fullReader.notDone));
    await signIn(kim);
    const ownTree = await edit();
    const ownHtml = renderToStaticMarkup(ownTree);
    c.ok("creative assigned fixture work stays visible with original manual Pause", queueRows(ownTree, "notDone").some((r) => r.id === fixtureKim.id) && queueRows(ownTree, "notDone").every((r) => r.editorKey === "kim") && ownHtml.includes("Pause") && !ownHtml.includes("Show test records") && !ownHtml.includes("Add a job to the queue"));
    c.ok("creative test query neither broadens ownership nor changes their queue", ids(queueRows(await edit("test=1"), "notDone")) === ids(queueRows(ownTree, "notDone")) && !queueRows(ownTree, "notDone").some((r) => r.editorKey === "john"));
    await signIn(photographer);
    const photoTree = await edit("test=1");
    c.ok("photographer keeps their existing shoot board without office controls", elements(photoTree, "PhotographerJobs").length === 1 && elements(photoTree, "SimpleQueue").length === 0 && elements(photoTree, "EditingWorkSummary").length === 0);
    await signIn(unmapped);
    const unmappedTree = await edit("test=1");
    c.ok("unmapped editor remains unable to receive company rows", queueRows(unmappedTree, "notDone").length === 0 && elements(unmappedTree, "EditingWorkSummary").length === 0);
    await signIn(owner);
    const scheduleTree = async (view = "list", test?: string) => settleSchedule(await schedule({ searchParams: Promise.resolve({ view, test }) }));
    const listNormal = await scheduleTree();
    const listTest = await scheduleTree("list", "1");
    const normalHtml = renderToStaticMarkup(listNormal as Parameters<typeof renderToStaticMarkup>[0]);
    const testHtml = renderToStaticMarkup(listTest as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("normal Schedule List hides fixtures but keeps protected TEST and longer real visits", !normalHtml.includes("Fixture upcoming visit") && normalHtml.includes("Protected TEST visit") && normalHtml.includes("Real visit after Home week") && normalHtml.includes("Real visit without coordinates"), normalHtml);
    c.ok("Schedule List restores test scope without changing 60-day or status windows", testHtml.includes("Fixture upcoming visit") && !testHtml.includes("Real visit after Schedule horizon") && !testHtml.includes("Real delivered job") && !testHtml.includes("Real cancelled visit") && testHtml.includes("next 60 days"), testHtml);
    const mapNormal = await scheduleTree("map");
    const mapTest = await scheduleTree("map", "1");
    const normalPins = elements(mapNormal, "ProjectMap")[0].pins as { projectId: string }[];
    const fullPins = elements(mapTest, "ProjectMap")[0].pins as { projectId: string }[];
    c.ok("Schedule Map shares normal/test identity scope and preserves location/status rules", !normalPins.some((r) => r.projectId === fixtureFuture.id) && fullPins.some((r) => r.projectId === fixtureFuture.id) && normalPins.some((r) => r.projectId === protectedFuture.id) && normalPins.some((r) => r.projectId === delivered.id) && !fullPins.some((r) => [noCoordinates.id, cancelled.id, farFuture.id].includes(r.projectId)));
    const normalWeek = (await getShootWindow({ excludeClientIds: [fixture.id] })).week;
    const fullWeek = (await getShootWindow()).week;
    c.ok("Home week expands only the same scoped near-term appointments seen in Schedule", normalWeek.every((row) => normalHtml.includes(`href="/shoot/${row.id}"`)) && fullWeek.every((row) => testHtml.includes(`href="/shoot/${row.id}"`)) && !normalWeek.some((row) => row.id === longerFuture.id) && fullWeek.some((row) => row.id === fixtureFuture.id));
    const weekHtml = renderToStaticMarkup(createElement(WeekStrip, { week: fullWeek, includeTest: true }));
    const toggleHtml = renderToStaticMarkup(createElement(ScheduleViewToggle, { view: "map", includeTest: true }));
    c.ok("WeekStrip and Schedule view toggles carry scope while exact shoot URLs stay unchanged", weekHtml.includes('href="/schedule?test=1"') && weekHtml.includes(`href="/shoot/${fixtureFuture.id}"`) && toggleHtml.includes('href="/schedule?view=map&amp;test=1"') && toggleHtml.includes('href="/schedule?test=1"') && toggleHtml.includes('href="/schedule?view=map"'));
    const dials = await getOwnerDials({ excludeClientIds: [fixture.id] });
    const dialHtml = renderToStaticMarkup(createElement(QualityDials, { dials, includeTest: true }));
    c.ok("SLA dial labels its existing sample definition and links to matching explicit scope", dialHtml.includes("in the SLA sample") && dialHtml.includes('href="/editing?test=1"') && dialHtml.includes("also includes waiting and upcoming projects"));
    const homeTest = await home({ searchParams: Promise.resolve({ test: "1" }) });
    c.ok("Home composes explicit record scope through week and SLA presentations", elements(homeTest, "WeekStrip")[0].includeTest === true && elements(homeTest, "QualityDials")[0].includeTest === true && hrefs(homeTest).includes("/schedule?test=1"));
    c.ok("scope reads preserve assignments, manual work, source tasks, settings and client-send boundary", before === await sourceSnapshot() && await prisma.outboxMessage.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
