// Oct 19 2026: Kyle's simplified Home (five job tiles, the video banner, old
// items), Jordan's week, the daily checklist on /ops, client messages, old-item
// aging, the morning digest and the shoot-note auto-expire. Server-renders the
// real pages against disposable PGlite; Slack is faked; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoDeliveryCounts } from "../../src/lib/videoDelivery";

installNextStubs();
type Props = Record<string, unknown>;

// ---- Slack, faked: every post is recorded by channel --------------------------
const slack: { channel: string; text: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "chat.postMessage") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: "not_in_drill" });
});

// ---- the video contract, overridable so the banner thresholds can be driven ---
let videoOverride: VideoDeliveryCounts | null = null;
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return { ...m, videoDeliveryCounts: (now?: Date) => (videoOverride ? Promise.resolve(videoOverride) : m.videoDeliveryCounts(now)) };
});

// ---- tree helpers (the u4/c14 Home drills' own) ---------------------------------
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
function namesOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(namesOf);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [typeof type === "string" ? type : type.name ?? "", ...Object.values(tree.props).flatMap(namesOf)];
}
function findEl(tree: unknown, name: string): unknown {
  if (Array.isArray(tree)) return tree.map((t) => findEl(t, name)).find(Boolean) ?? null;
  if (!isValidElement<Props>(tree)) return null;
  const type = tree.type as string | { name?: string };
  if ((typeof type === "string" ? type : type.name) === name) return tree;
  return Object.values(tree.props).map((v) => findEl(v, name)).find(Boolean) ?? null;
}
function propValues(tree: unknown, key: string): unknown[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => propValues(part, key));
  if (!isValidElement<Props>(tree)) return [];
  return [...(key in tree.props ? [tree.props[key]] : []), ...Object.values(tree.props).flatMap((part) => propValues(part, key))];
}
const STREAMED = new Set(["HomeExceptions", "OwnerBusiness", "OwnerWeekSection", "OwnerBehindSection", "OwnerNewClients", "ChecklistExceptions", "ChecklistRadar"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
// Expand the presentational parts so their text and links can be read.
const EXPAND = new Set(["JobTiles", "VideoBehindBanner", "OldItemsCard", "OldItemRow", "BehindCard", "OwnerWeekCard", "ShootsTodayLine", "FlaggedBanner", "ChecklistLinks", "LoopRow"]);
function expand(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && EXPAND.has(tree.type.name)) return expand((tree.type as (p: Props) => unknown)(tree.props));
  return { ...tree, props: Object.fromEntries(Object.entries(tree.props).map(([k, v]) => [k, expand(v)])) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void } };
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });

const H = 3_600_000;
const D = 24 * H;
const EM_DASH = /—/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5919), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct19-ops-home" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { default: home } = await import("@/app/page");
    const { default: opsPage } = await import("@/app/ops/page");
    const { default: messagesPage } = await import("@/app/ops/messages/page");
    const { default: oldPage } = await import("@/app/ops/old/page");
    const { pushOldItem } = await import("@/app/ops/old/actions");
    const opsHome = await import("@/lib/opsHome");
    const aging = await import("@/lib/taskAging");
    const { loadQueue } = await import("@/app/ops/photo-delivery/data");
    const { askBoardCounts } = await import("@/lib/clientAsks");
    const { videoDeliveryCounts } = await import("@/lib/videoDelivery");
    const { buildOpsDay } = await import("@/lib/opsDay");
    const { forwardedHref, opsAnchor } = await import("@/lib/homeAnchors");
    const { etAt, etDayKey, etDayStartUtc, etAddDays, etEndOfDay } = await import("@/lib/datetime");
    const { saveSchedule } = await import("@/lib/notifySchedule");
    const { DISMISSED_PREFIX } = await import("@/lib/triage");

    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const ahead = (ms: number) => new Date(now.getTime() + ms);
    const endToday = new Date(etDayStartUtc(etAddDays(new Date(etDayStartUtc(now).getTime() + 12 * H), 1)).getTime());
    const laterToday = new Date(Math.min(now.getTime() + H, endToday.getTime() - 60_000));

    // =====================================================================
    c.head("§1 · the rules, as pure functions");
    // =====================================================================
    const vc = (late: number, oldest: number | null): VideoDeliveryCounts => ({ open: late + 2, dueToday: 1, behind: late, oldestHours: 30, lateListing: late, oldestLateHours: oldest, lateMonthly: 0 });
    c.ok("no late listing video, no banner", opsHome.videoAlert(vc(0, null)) === null && opsHome.videoAlert(null) === null);
    c.ok("one or two late (under 48 h) is amber", opsHome.videoAlert(vc(1, 10))?.level === "amber" && opsHome.videoAlert(vc(2, 47.9))?.level === "amber");
    c.ok("three late is red even when each is only hours late", opsHome.videoAlert(vc(3, 5))?.level === "red");
    c.ok("one video 48 h past its promise is red", opsHome.videoAlert(vc(1, 48))?.level === "red" && opsHome.videoAlert(vc(2, 65))?.level === "red");
    const red = opsHome.videoAlert(vc(3, 2.7 * 24))!;
    c.ok("red wording: count, oldest in days, deliver first, vendor editor", red.headline === "We're behind on videos: 3 late, the oldest 2.7 days." && red.detail === "Deliver these first. If this keeps up, bring in a vendor editor to take the load off." && red.href === "/ops/video-delivery", `${red.headline} / ${red.detail}`);
    c.ok("thresholds live in one place", opsHome.VIDEO_VERY_BEHIND_COUNT === 3 && opsHome.VIDEO_VERY_BEHIND_HOURS === 48 && aging.OLD_AFTER_DAYS === 3 && aging.WEEK_OLD_DAYS === 7 && aging.PUSHES_BEFORE_FLAG === 3);
    const t = (over: Partial<{ status: string; dueAt: Date | null; followUpAt: Date | null; assignedKey: string | null; ownerId: string | null }>) =>
      ({ status: "OPEN", dueAt: null, followUpAt: null, assignedKey: "kyle", ownerId: null, ...over });
    c.ok("old = open, names a person, 3+ days past its date", aging.isOldTask(t({ dueAt: ago(3 * D) }), now) && !aging.isOldTask(t({ dueAt: ago(2.9 * D) }), now));
    c.ok("a person filed by the routers (ownerId) counts as assigned", aging.isOldTask(t({ assignedKey: null, ownerId: "tm", dueAt: ago(4 * D) }), now));
    c.ok("nobody's name on it, or closed: never old", !aging.isOldTask(t({ assignedKey: null, dueAt: ago(9 * D) }), now) && !aging.isOldTask(t({ status: "COMPLETED", dueAt: ago(9 * D) }), now) && !aging.isOldTask(t({ status: "CANCELLED", dueAt: ago(9 * D) }), now));
    c.ok("a new date (chase date) ahead of us takes it off the list; the later date counts", !aging.isOldTask(t({ dueAt: ago(9 * D), followUpAt: ahead(2 * D) }), now) && aging.isOldTask(t({ dueAt: ago(9 * D), followUpAt: ago(4 * D) }), now) && aging.daysPast(t({ dueAt: ago(9 * D), followUpAt: ago(4 * D) }), now) === 4);
    c.ok("no date at all is never old; a chase date alone can be", !aging.isOldTask(t({}), now) && aging.isOldTask(t({ followUpAt: ago(5 * D) }), now));
    const note = (title: string, over: Partial<Parameters<typeof aging.shootNoteExpires>[0]> = {}, project: { status: string; shootDate: Date | null } | null = { status: "DELIVERED", shootDate: ago(3 * D) }) =>
      aging.shootNoteExpires({ taskType: "todo", source: "openphone", status: "OPEN", reasonCreated: "Inbound message from client (OpenPhone)", title, flaggedAt: null, assignedManually: false, project, ...over }, now);
    c.ok("shoot notes expire once the shoot has happened", note("Note basement to be photographed at 22 White Birch Dr shoot") && note("Log access codes for 3024 N 8th St shoot today") && note("Update lockbox code to 1636 for 1861 E Westmoreland St") && note("Keep today's shoot tight; Eric and Paul both need to leave early", {}, { status: "SHOT", shootDate: ago(4 * D) }));
    c.ok("actions are not notes", !note("Investigate why Order 1671 payment was not applied from credits") && !note("Add courtyard outline to Church St deliverables") && !note("Prepare for strategy call with Marcee tomorrow at 10am"));
    c.ok("an edit-side note waits for delivery", !note("Log song request for 2645 N 8th St cinematic video", {}, { status: "EDITING", shootDate: ago(3 * D) }) && note("Log USP and lifestyle brief for 99 W Bridge St video", {}, { status: "DELIVERED", shootDate: ago(30 * D) }));
    c.ok("not before the shoot day is over, not while still scheduled, not without a job", !note("Note vacant property for 308 W Upsal St shoot team", {}, { status: "SHOT", shootDate: laterToday }) && !note("Note lockbox for 7 Late Ave", {}, { status: "SCHEDULED", shootDate: ago(3 * D) }) && !note("Note lockbox for 7 Late Ave", {}, null));
    c.ok("only the brain's to-dos from a client message; never one a person flagged or assigned", !note("Note x for y shoot", { source: "manual" }) && !note("Note x for y shoot", { reasonCreated: "Photographer flagged a pay line" }) && !note("Note x for y shoot", { taskType: "client_reply" }) && !note("Note x for y shoot", { flaggedAt: now }) && !note("Note x for y shoot", { assignedManually: true }));
    c.ok("old Home anchors forward to the checklist; Home's own stay", forwardedHref("/", "", "#video-review") === "/ops#video-review" && forwardedHref("/", "?test=1", "#loops") === "/ops?test=1#loops" && forwardedHref("/", "", "#my-list") === null && forwardedHref("/ops", "", "#loops") === null && forwardedHref("/", "", "#%E0") === null && forwardedHref("/", "", "#shoots") === "/ops#shoots");
    c.ok("in-page links Home renders point at the checklist", opsAnchor("#comms-1") === "/ops#comms-1" && opsAnchor("#needs-you") === "#needs-you" && opsAnchor("/tasks") === "/tasks");
    c.ok("lateness in words", opsHome.lateWords(9.4) === "9 hours" && opsHome.lateWords(24) === "1 day" && opsHome.lateWords(65) === "2.7 days");

    // =====================================================================
    c.head("§2 · the world");
    // =====================================================================
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", role: "MANAGER", email: "kyle@oct19.invalid", slackId: "U-KYLE" } });
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", role: "PHOTOGRAPHER", email: "jordan@oct19.invalid", slackId: "U-JORDAN" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", role: "MANAGER", email: "james@oct19.invalid", slackId: "U-JAMES" } });
    const user = (name: string, email: string, role: string, teamMemberId?: string, permissions?: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", permissions } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    const james = await user("James Livingston", jamesTm.email!, "ADMIN", jamesTm.id);
    const revoked = await user("No Home", "nohome@oct19.invalid", "ADMIN", undefined, JSON.stringify({ dashboard: false }));
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id }) } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // Projects, with a registry so the week's expected numbers are computed
    // from the fixtures themselves, not from the code under test.
    const projects: { id: string; shootDate: Date | null; status: string; synthetic: boolean }[] = [];
    const project = async (title: string, status: string, shootDate: Date | null, extra: Record<string, unknown> = {}, clientId = real.id) => {
      const p = await prisma.project.create({ data: { clientId, title, status: status as never, shootDate, ...extra } });
      projects.push({ id: p.id, shootDate, status, synthetic: clientId === fixture.id });
      return p;
    };
    const pShot = await project("1 Elm St, Town", "DELIVERED", ago(3 * D));
    const pEdit = await project("2 Pine Rd, Town", "EDITING", ago(2 * D));
    const pToday = await project("9 Today St, Town", "SCHEDULED", laterToday, { deliverables: { create: { type: "PHOTOS", label: "Same Day Photo Delivery", productTitle: "Same Day Photo Delivery" } } });
    const pSched = await project("7 Late Ave, Town", "SCHEDULED", ago(3 * D));
    // Photo jobs: one behind, one due later today, one later, one delivered.
    const pp = [] as { id: string }[];
    for (const [i, stage, sla, delivered] of [[1, "QC_REVIEW", ago(2 * H), null], [2, "READY", laterToday, null], [3, "EDITING", ahead(2 * D), null], [4, "DELIVERED", ahead(H), ago(H)]] as const) {
      const p = await project(`${20 + i} Photo Ln, Town`, i === 4 ? "DELIVERED" : "SHOT", ago(D + i * 60_000));
      await prisma.photoJob.create({ data: { projectId: p.id, stage, slaDueAt: sla, deliveredAt: delivered } });
      pp.push(p);
    }

    // Kyle's tasks.
    const task = (data: Record<string, unknown>) => prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", ...data } as never });
    const k1 = await task({ title: "Apply $750 credit for 12 Oak St", assignedKey: "kyle", dueAt: ago(10 * D), clientId: real.id });
    const k2 = await task({ taskType: "internal_instruction", source: "slack", title: "Call the stager about 5 Birch Ln", ownerId: kyleTm.id, dueAt: ago(12 * D), followUpAt: ago(4 * D) });
    await prisma.auditLog.createMany({ data: [1, 2].map(() => ({ actor: "kyle@oct19.invalid", action: aging.PUSH_ACTION, target: k2.id, detail: "{}" })) });
    await task({ title: "Not old yet", assignedKey: "kyle", dueAt: ago(2 * D) });
    await task({ title: "Pushed to later", assignedKey: "kyle", dueAt: ago(9 * D), followUpAt: ahead(2 * D) });
    await task({ title: "Nobody's", dueAt: ago(8 * D) });
    await task({ title: "Synthetic client chore", assignedKey: "kyle", dueAt: ago(8 * D), clientId: fixture.id });
    await task({ title: "Long done", assignedKey: "kyle", dueAt: ago(20 * D), status: "COMPLETED", completedAt: ago(19 * D) });
    const k7 = await task({ taskType: "lead", source: "openphone", title: "New lead: Pat Doe wants a listing shoot", ownerId: kyleTm.id, dueAt: ago(5 * D), createdAt: ago(5 * D) });
    await task({ taskType: "lead", source: "website", title: "New lead: Sam Roe", dueAt: laterToday, createdAt: ago(H) });
    const fu = await task({ taskType: "comms_followup", source: "system", title: "Chase Real Agent about the floor plan", assignedKey: "kyle", followUpAt: ago(4 * D) });
    const j1 = await task({ title: "Sign the vendor agreement", assignedKey: "jordan", dueAt: ago(8 * D) });
    const jm1 = await task({ title: "Reshoot plan for 3 Bay St", assignedKey: "james", dueAt: ago(3.5 * D) });
    await prisma.auditLog.createMany({ data: [1, 2, 3].map(() => ({ actor: "james@oct19.invalid", action: aging.PUSH_ACTION, target: jm1.id, detail: "{}" })) });
    // The brain's shoot notes.
    const brain = (title: string, projectId: string, over: Record<string, unknown> = {}) => task({ source: "openphone", reasonCreated: "Inbound message from client (OpenPhone)", ownerId: kyleTm.id, projectId, clientId: real.id, title, summary: "Client wrote in.", ...over });
    const n1 = await brain("Note basement to be photographed at 1 Elm St shoot", pShot.id, { dueAt: ago(4 * D), createdAt: ago(20 * D) });
    // Oct 19 audit: a note written AFTER its shoot is a real ask and stays open.
    const nAfter = await brain("Note client wants the trash cans removed at 1 Elm St", pShot.id, { dueAt: ago(1 * D) });
    const n2 = await brain("Investigate why Order 1671 payment was not applied", pShot.id, { dueAt: ago(8 * D) });
    const n3 = await brain("Log song request for 2 Pine Rd video", pEdit.id, { source: "gmail", reasonCreated: "Inbound message from client (Gmail)" });
    const n4 = await brain("Note gate code for 1 Elm St shoot", pShot.id, { assignedKey: "kyle", flaggedAt: ago(H), flaggedBy: "Jordan Spackman", dueAt: ahead(D) });
    const n5 = await brain("Log access codes for 9 Today St shoot today", pToday.id);
    const n6 = await brain("Note lockbox 4321 for 7 Late Ave", pSched.id);

    // Comms: a text waiting 30 h, an email waiting 2 h.
    await prisma.commLog.create({ data: { clientId: real.id, clientName: real.name, contactName: real.name, channel: "text", source: "openphone", direction: "in", body: "Any update on 12 Oak St?", occurredAt: ago(30 * H) } });
    await prisma.commLog.create({ data: { clientId: real.id, clientName: real.name, contactName: real.name, channel: "email", source: "gmail", direction: "in", subject: "Floor plan", body: "Can you check the floor plan?", occurredAt: ago(2 * H) } });

    // The week: listing videos (one on time, one late), a monthly one, a
    // revision asked for (and an office note that is not one), a fast reply.
    const { etWeekStart } = opsHome;
    const weekStart = etWeekStart(now);
    const span = now.getTime() - weekStart.getTime();
    const tw = (f: number) => new Date(weekStart.getTime() + f * span);
    const lastStart = etWeekStart(new Date(weekStart.getTime() - 3 * D));
    const lw = (f: number) => new Date(lastStart.getTime() + f * span);
    const weekOk = span > 2 * H;
    const output = async (title: string, deliveredAt: Date, promisedDueAt: Date | null, extra: Record<string, unknown> = {}) => {
      const p = await project(title, "DELIVERED", null, { promisedDueAt, ...extra });
      const dv = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Property video" } });
      await prisma.deliverableOutput.create({ data: { deliverableId: dv.id, projectId: p.id, slot: 1, category: "VIDEO", deliveredAt } });
      return p;
    };
    const texts: { dir: "in" | "out"; at: Date }[] = [{ dir: "in", at: ago(30 * H) }];
    if (weekOk) {
      await output("31 Video Ct", tw(0.4), tw(0.5));
      const late = await output("32 Video Ct", tw(0.6), tw(0.2));
      await output("33 Monthly Ct", tw(0.5), null, { contentMonthId: "drill-month" });
      await output("34 Last Week Ct", lw(0.5), lw(0.4));
      await prisma.revisionBrief.create({ data: { projectId: late.id, source: "review_room", originalText: "Shorter intro please", requestedByKind: "CLIENT", createdAt: tw(0.7) } });
      await prisma.revisionBrief.create({ data: { projectId: late.id, source: "manual", originalText: "Office note", requestedByKind: "OFFICE", createdAt: tw(0.7) } });
      const gap = Math.min(20 * 60_000, span * 0.05);
      for (const m of [{ dir: "in" as const, at: tw(0.3) }, { dir: "out" as const, at: new Date(tw(0.3).getTime() + gap) }, { dir: "in" as const, at: tw(0.8) }]) {
        await prisma.commLog.create({ data: { clientId: real.id, clientName: real.name, channel: "text", source: "openphone", direction: m.dir, body: m.dir === "in" ? "Question" : "Answer", occurredAt: m.at } });
        texts.push(m);
      }
    }
    c.ok("the world is built", true);

    // =====================================================================
    c.head("§3 · Kyle's Home (operations)");
    // =====================================================================
    await signIn(kyle);
    const healthBefore = await prisma.deliveryFollowUpHealth.count();
    const tasksBefore = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    const kyleTree = await settle(await home({}));
    // Measured straight after the render: the drill's own buildOpsDay call
    // below (for the shoots comparison) records the health rows itself.
    const healthAfter = await prisma.deliveryFollowUpHealth.count();
    const tasksAfter = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    const kyleText = textOf(expand(kyleTree));
    const tiles = elements(kyleTree, "JobTiles")[0]?.tiles as import("../../src/lib/opsHome").JobTile[] | undefined;
    c.ok("five job tiles, in Jordan's order, each opening its own screen", tiles?.map((x) => `${x.key}:${x.href}`).join() === "photos:/ops/photo-delivery,videos:/ops/video-delivery,messages:/ops/messages,requests:/ops/requests,scheduling:/ops/scheduling", tiles?.map((x) => x.key).join());
    const tile = (k: string) => tiles!.find((x) => x.key === k)!;
    const same = (a: unknown, b: { open: number; dueToday: number; behind: number } | null | undefined) => !!a && !!b && (["open", "dueToday", "behind"] as const).every((f) => (a as Record<string, number>)[f] === b[f]);
    const photoScreen = opsHome.photoCountsFromQueue(await loadQueue(), now);
    c.ok("Photos tile = the photo delivery queue's own cards", same(tile("photos").counts, photoScreen) && photoScreen.open === 3 && photoScreen.behind === 1 && (laterToday.getTime() <= now.getTime() + 2 * H ? photoScreen.dueToday === 1 : true) && photoScreen.readyForReview === 1, JSON.stringify(photoScreen));
    c.ok("Photos tile says what to do", /past due\. Deliver these first\./.test(tile("photos").status) && /ready for you to approve/.test(tile("photos").status), tile("photos").status);
    const videoScreen = await videoDeliveryCounts(now).catch(() => null);
    c.ok("Videos tile = videoDeliveryCounts (the video delivery screen's contract)", videoScreen ? same(tile("videos").counts, videoScreen) : tile("videos").counts === null, JSON.stringify(videoScreen));
    const kyleViewer = { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id };
    const msgScreen = await opsHome.messagesBoard({ now, excludeClientIds: [fixture.id], viewer: kyleViewer });
    c.ok("Messages tile = messagesBoard (the /ops/messages screen's own read)", same(tile("messages").counts, msgScreen.counts) && msgScreen.counts.open === msgScreen.waiting.length + msgScreen.loops.length + msgScreen.leads.length, JSON.stringify(msgScreen.counts));
    c.ok("messages: the 2-day-old lead and the Slack instruction are follow-ups owed; the unassigned lead is Kyle's to call too", msgScreen.leads.some((l) => l.id === k7.id && l.behind) && msgScreen.loops.some((l) => l.taskId === k2.id) && msgScreen.leads.length === 2);
    c.ok("messages: a lead or reply already on the waiting list is not counted twice", new Set([...msgScreen.loops.map((l) => l.taskId), ...msgScreen.leads.map((l) => l.id), ...msgScreen.waiting.map((w) => w.group.openTaskId).filter(Boolean)]).size === msgScreen.loops.length + msgScreen.leads.length + msgScreen.waiting.filter((w) => w.group.openTaskId).length);
    const asks = await askBoardCounts(now).catch(() => null);
    c.ok("Requests and Scheduling tiles = askBoardCounts (their screens' contract)", asks ? same(tile("requests").counts, asks.special) && same(tile("scheduling").counts, asks.scheduling) : tile("requests").counts === null && tile("scheduling").counts === null, JSON.stringify(asks));
    const oldKyle = await aging.listOldItems(new Date(), { personKey: "kyle", excludeClientIds: [fixture.id], scrub: true });
    const card = elements(kyleTree, "OldItemsCard")[0] as { items: import("../../src/lib/taskAging").OldItem[]; total: number } | undefined;
    c.ok("Old items: the count is Kyle's own list (assigned or filed to him, 3+ days, test clients out)", card?.total === oldKyle.items.length && oldKyle.items.length === 6 && [k1.id, k2.id, k7.id, n1.id, n2.id, fu.id].every((id) => oldKyle.items.some((i) => i.id === id)), `${card?.total} / ${oldKyle.items.map((i) => i.title).join(" | ")}`);
    c.ok("Old items: the oldest four, oldest first, figures scrubbed", card!.items.length === aging.OLD_ITEMS_ON_HOME && card!.items[0].id === k1.id && card!.items.every((i, n, a) => n === 0 || Date.parse(a[n - 1].chaseISO) <= Date.parse(i.chaseISO)) && !kyleText.includes("$750") && kyleText.includes("[amount]"));
    c.ok("Old items: pushes show, and the next push warns that Jordan is told", oldKyle.items.find((i) => i.id === k2.id)?.pushes === 2 && kyleText.includes("pushed 2 times") && kyleText.includes("one more tells Jordan"));
    const shootsLine = elements(kyleTree, "ShootsTodayLine")[0];
    const day = await buildOpsDay({ excludeClientIds: [fixture.id] });
    c.ok("today's shoots line = the checklist's own today list, linking to it", shootsLine?.count === day.todayShoots.length && shootsLine?.count === 1 && shootsLine?.href === "/ops#shoots" && shootsLine?.rush === 1, JSON.stringify({ line: shootsLine?.count, day: day.todayShoots.length, rush: shootsLine?.rush }));
    c.ok("flagged-for-you banner stays first", (elements(kyleTree, "FlaggedBanner")[0]?.flagged as { taskId: string }[]).some((f) => f.taskId === n4.id));
    const gone = ["Block", "HomeRoutine", "NeedsToday", "StuckJobs", "NewClientCard", "ProactiveFlags", "MoneyStat", "DeliveryBoardView", "OwnerWeekCard"];
    c.ok("everything else moved off Kyle's Home (checklist, needs list, stuck jobs, radar, money)", gone.every((n) => elements(kyleTree, n).length === 0), gone.filter((n) => elements(kyleTree, n).length > 0).join());
    c.ok("office-wide 'running late' and 'to assign' rows and the footer links are gone", !kyleText.includes("running late on the board") && !kyleText.includes("with nobody's name") && !kyleText.includes("All tasks") && !kyleText.includes("Client months"));
    const { ChecklistLinks } = await import("@/components/home/OpsHomeParts");
    c.ok("one line to the checklist, exceptions and stuck jobs", elements(kyleTree, "ChecklistLinks").length === 1 && (propValues(ChecklistLinks({ includeTest: false }), "href") as string[]).join() === "/ops,/ops#exceptions,/ops#stuck");
    c.ok("old '/#block' links are forwarded from Home", elements(kyleTree, "HomeAnchorForward").length === 1);
    c.ok("Kyle's Home render writes nothing (follow-up health moved off Home)", healthAfter === healthBefore && tasksAfter === tasksBefore && await prisma.outboxMessage.count() === 0, `health ${healthBefore}→${healthAfter} · tasks ${tasksAfter === tasksBefore ? "same" : "changed"}`);
    c.ok("no em dashes in the new Home copy Kyle reads", !EM_DASH.test(tiles!.map((x) => x.status).join(" ")) && !EM_DASH.test(textOf(expand(findEl(kyleTree, "OldItemsCard")))) && !EM_DASH.test(textOf(expand(findEl(kyleTree, "JobTiles")))));

    // The banner, driven through the video contract.
    const banner = async (v: VideoDeliveryCounts | null) => { videoOverride = v; const tree = await settle(await home({})); videoOverride = null; return elements(tree, "VideoBehindBanner")[0]?.alert as import("../../src/lib/opsHome").VideoAlert | null; };
    const r1 = await banner(vc(3, 20));
    const r2 = await banner(vc(1, 50));
    const a1 = await banner(vc(2, 30));
    const none = await banner(vc(0, null));
    c.ok("Home banner: red at 3+ late or 48 h+, amber at 1 to 2, none when on time", r1?.level === "red" && r2?.level === "red" && a1?.level === "amber" && none === null);
    c.ok("the red banner says it in Jordan's words and opens video delivery", r1?.headline.startsWith("We're behind on videos: 3 late") === true && r1?.detail.includes("bring in a vendor editor") === true && r1?.href === "/ops/video-delivery");

    // =====================================================================
    c.head("§4 · Jordan's Home (owner)");
    // =====================================================================
    await signIn(owner);
    const ownerTree = await settle(await home({}));
    const week = elements(ownerTree, "OwnerWeekCard")[0]?.week as import("../../src/lib/opsHome").OwnerWeek | null;
    const inWeek = (d: Date | null) => !!d && d >= weekStart && d < now;
    const expectShoots = projects.filter((p) => !p.synthetic && p.status !== "CANCELLED" && inWeek(p.shootDate)).length;
    c.ok("This week: shoots done since Monday", week?.thisWeek.shoots === expectShoots, `${week?.thisWeek.shoots} vs ${expectShoots}`);
    c.ok("This week: photo jobs delivered and on time", week?.thisWeek.photos.delivered === (inWeek(ago(H)) ? 1 : 0) && (inWeek(ago(H)) ? week?.thisWeek.photos.onTimePct === 100 : true), JSON.stringify(week?.thisWeek.photos));
    if (weekOk) {
      c.ok("This week: listing videos delivered, % on time against the promise", week?.thisWeek.listingVideos.delivered === 2 && week?.thisWeek.listingVideos.onTimePct === 50, JSON.stringify(week?.thisWeek.listingVideos));
      c.ok("This week: monthly videos counted apart", week?.thisWeek.monthlyVideos === 1);
      const inbound = texts.filter((m) => m.dir === "in" && inWeek(m.at)).length;
      c.ok("This week: client texts answered within an hour", week?.thisWeek.replies.inbound === inbound && week?.thisWeek.replies.fast === 1, JSON.stringify(week?.thisWeek.replies));
      c.ok("This week: revisions asked for (client asks, not office notes)", week?.thisWeek.revisions === 1);
      c.ok("Last week to the same point, for the small text", week?.lastWeek.listingVideos.delivered === 1 && week?.lastWeek.listingVideos.onTimePct === 0, JSON.stringify(week?.lastWeek.listingVideos));
    } else {
      c.ok("(Monday just after midnight: the week's fixtures are skipped)", true);
    }
    const behind = elements(ownerTree, "BehindCard")[0] as { tiles: import("../../src/lib/opsHome").JobTile[]; people: import("../../src/lib/taskAging").OldPerson[]; oldTotal: number } | undefined;
    const teamMsgs = await opsHome.messagesBoard({ now, excludeClientIds: [fixture.id], team: true });
    c.ok("What we're behind on: the same five jobs, team-wide", behind?.tiles.map((x) => x.key).join() === "photos,videos,messages,requests,scheduling" && same(behind!.tiles[2].counts, teamMsgs.counts) && same(behind!.tiles[0].counts, photoScreen));
    const team = await aging.listOldItems(new Date(), { excludeClientIds: [fixture.id] });
    const kylePerson = behind?.people.find((p) => p.key === "kyle");
    c.ok("What we're behind on: everyone's old items, Kyle's week-old count, pushed 3+ times", behind?.oldTotal === team.items.length && kylePerson?.total === 6 && kylePerson?.weekOld === 2 && behind!.people.find((p) => p.key === "james")?.pushedOften === 1, JSON.stringify(behind?.people));
    const ownerText = textOf(expand(ownerTree));
    c.ok("owner Home keeps his own list and the money; trends fold under it", elements(ownerTree, "QuickAdd").length === 1 && elements(ownerTree, "MoneyStat").length > 0 && elements(ownerTree, "PulseStrip").length <= 1);
    c.ok("owner Home no longer carries the checklist, the needs wall or stuck jobs", ["Block", "HomeRoutine", "NeedsToday", "StuckJobs", "JobTiles"].every((n) => elements(ownerTree, n).length === 0));
    const order = namesOf(ownerTree);
    c.ok("This week comes first, then what is behind, then his list, then money", order.indexOf("OwnerWeekCard") >= 0 && order.indexOf("OwnerWeekCard") < order.indexOf("BehindCard") && order.indexOf("BehindCard") < order.indexOf("QuickAdd") && order.indexOf("QuickAdd") < order.indexOf("MoneyStat") && ownerText.includes("This week"), order.filter((n) => ["OwnerWeekCard", "BehindCard", "QuickAdd", "MoneyStat"].includes(n)).join(","));

    // =====================================================================
    c.head("§5 · James's Home (review seat) keeps working");
    // =====================================================================
    await signIn(james);
    const jamesTree = await settle(await home({}));
    const needs = elements(jamesTree, "NeedsToday")[0]?.needs as { key: string; href: string }[] | undefined;
    c.ok("the review desk renders with its own rows", textOf(jamesTree).includes("Your creative review desk") && !!needs && elements(jamesTree, "JobTiles").length === 0);
    c.ok("its anchors open the checklist screen, not a block that left Home", (needs ?? []).every((n) => !/^#(?!needs-you)/.test(n.href)) && (needs ?? []).some((n) => n.href.startsWith("/ops#")), (needs ?? []).map((n) => n.href).join(" "));

    // =====================================================================
    c.head("§6 · /ops: the daily checklist");
    // =====================================================================
    await signIn(kyle);
    await prisma.deliveryFollowUpHealth.deleteMany({});
    const opsTree = await settle(await opsPage({}));
    const keys = elements(opsTree, "Block").map((b) => (b.def as { key: string }).key);
    c.ok("every block id the old Home anchors pointed at is on /ops", ["tower", "qc-am", "overdue", "comms-1", "prep", "loops", "video-review", "pipeline", "monthly", "closeout"].every((k) => keys.includes(k)) && new Set(keys).size === keys.length, keys.join(","));
    const ids = propValues(opsTree, "id").filter((x): x is string => typeof x === "string");
    c.ok("…and so are #shoots, #stuck, #exceptions and #operating-routine", ["shoots", "stuck", "exceptions", "operating-routine"].every((id) => ids.includes(id)), ids.join(","));
    c.ok("the checklist reads the delivery follow-up lanes (and records their health) here", await prisma.deliveryFollowUpHealth.count() >= 1);
    c.ok("no money for Kyle on the checklist either", !textOf(opsTree).includes("$750"));
    await signIn(revoked);
    const revokedTree = await settle(await opsPage({}));
    c.ok("someone with ops but Home revoked is told, not shown the day (guard kept)", textOf(revokedTree).includes("The daily checklist goes with the Home screen") && elements(revokedTree, "Block").length === 0);

    // =====================================================================
    c.head("§7 · /ops/messages and /ops/old");
    // =====================================================================
    await signIn(kyle);
    const mTree = await messagesPage({ searchParams: Promise.resolve({}) });
    const sub = String(elements(mTree, "PageHeader")[0]?.subtitle ?? "");
    c.ok("Client messages screen states the tile's numbers", sub.startsWith(`${msgScreen.counts.open} to handle · ${msgScreen.counts.behind} behind · ${msgScreen.counts.dueToday} due today`), sub);
    c.ok("…and lists texts, email, follow-ups and leads in one place", elements(mTree, "HandledButton").length === msgScreen.waiting.length && elements(mTree, "LoopRow").length === msgScreen.loops.length && elements(mTree, "LoopActions").length === msgScreen.leads.length);
    const oTree = await oldPage({ searchParams: Promise.resolve({}) });
    c.ok("/ops/old lists exactly Kyle's old items, each with the three actions", elements(oTree, "OldItemRow").length === oldKyle.items.length);
    await signIn(owner);
    const oTeam = await oldPage({ searchParams: Promise.resolve({}) });
    c.ok("/ops/old opens on the whole team for Jordan", elements(oTeam, "OldItemRow").length === team.items.length && elements(oTeam, "OldItemRow").every((r) => r.showPerson === true));

    // =====================================================================
    c.head("§8 · the morning digest (one bell + one DM each, Jordan's quiet time kept)");
    // =====================================================================
    const morning = etAt(etDayKey(new Date()), 8, 30);
    c.ok("idle outside 8 to 10 AM ET", (await aging.oldItemsMorning(etAt(etDayKey(new Date()), 11, 0))).window === false);
    // Jordan is quiet all of today, the way his Saturday preset holds him.
    const dow = new Date(`${etDayKey(new Date())}T12:00:00Z`).getUTCDay();
    await saveSchedule(jordanTm.id, [{ day: dow, from: 0, to: 24 * 60 - 1 }], "drill");
    const firstRun = await aging.oldItemsMorning(morning);
    const bells = await prisma.notification.findMany({ where: { kind: "old_items" } });
    c.ok("one bell for each person with old items (and Jordan)", bells.length === 3 && [kyleTm.id, jordanTm.id, jamesTm.id].every((id) => bells.filter((b) => b.userKey === `tm:${id}`).length === 1), JSON.stringify(firstRun));
    c.ok("Kyle gets no second DM: his lines ride the morning digest", slack.filter((m) => m.channel === "U-KYLE").length === 0 && firstRun.people.some((p) => p.name === "Kyle Smith" && p.dm === "in the morning digest"));
    const jamesDm = slack.filter((m) => m.channel === "U-JAMES");
    c.ok("James gets one DM with his list and the three choices", jamesDm.length === 1 && jamesDm[0].text.includes("Old items to clear (1)") && jamesDm[0].text.includes("Done, Not needed or a new date") && jamesDm[0].text.includes("/ops/old") && !EM_DASH.test(jamesDm[0].text), jamesDm[0]?.text);
    const held = await prisma.appSetting.findMany({ where: { key: { startsWith: "held-dm:" } } });
    const heldText = held.map((h) => String((JSON.parse(h.value) as { text?: string }).text ?? "")).join("\n");
    c.ok("Jordan's DM is held for his quiet time, not sent", slack.filter((m) => m.channel === "U-JORDAN").length === 0 && held.length === 1);
    c.ok("Jordan's DM: his own item plus 'Kyle has N items over a week old'", heldText.includes("Sign the vendor agreement") && heldText.includes("Kyle has 2 items over a week old") && heldText.includes("/ops/old?who=all"), heldText);
    await aging.oldItemsMorning(morning);
    c.ok("a second tick the same morning sends nothing more", (await prisma.notification.count({ where: { kind: "old_items" } })) === 3 && slack.filter((m) => m.channel === "U-JAMES").length === 1);
    const kyleLines = await aging.kyleOldItemLines("https://hub.example");
    c.ok("Kyle's digest lines: his count, the oldest first, no figures, no em dashes", kyleLines.count === 6 && kyleLines.lines[0].includes("Old items to clear (6)") && kyleLines.lines.join("\n").includes("[amount]") && !kyleLines.lines.join("\n").includes("$750") && !EM_DASH.test(kyleLines.lines.join("\n")) && kyleLines.lines.at(-1) === "https://hub.example/ops/old");

    // =====================================================================
    c.head("§9 · New date: picked, counted, and the third tells Jordan");
    // =====================================================================
    await signIn(kyle);
    const today = etDayKey(new Date());
    const d1 = etDayKey(etAddDays(new Date(), 1));
    const d2 = etDayKey(etAddDays(new Date(), 2));
    const d3 = etDayKey(etAddDays(new Date(), 3));
    c.ok("no date, today, or too far out is refused", !(await pushOldItem(k1.id, "")).ok && !(await pushOldItem(k1.id, today)).ok && !(await pushOldItem(k1.id, etDayKey(etAddDays(new Date(), 90)))).ok);
    const p1 = await pushOldItem(k1.id, d1);
    const after1 = await prisma.smartTask.findUniqueOrThrow({ where: { id: k1.id } });
    c.ok("a new date moves the chase date, never the promise", p1.ok && after1.followUpAt?.getTime() === etEndOfDay(d1).getTime() && after1.dueAt?.getTime() === k1.dueAt!.getTime(), p1.message);
    c.ok("…and takes it off the old list", !(await aging.listOldItems(new Date(), { personKey: "kyle", excludeClientIds: [fixture.id] })).items.some((i) => i.id === k1.id));
    await pushOldItem(k1.id, d2);
    c.ok("two pushes do not tell Jordan", (await prisma.notification.count({ where: { kind: "old_item_pushed" } })) === 0);
    const p3 = await pushOldItem(k1.id, d3);
    const flag = await prisma.notification.findMany({ where: { kind: "old_item_pushed" } });
    c.ok("the third push flags Jordan (one owner bell) and says so", p3.ok && p3.pushes === 3 && p3.message.includes("Jordan is told") && flag.length === 1 && JSON.parse(flag[0].audience).includes("OWNER") && flag[0].href === "/ops/old?who=all", JSON.stringify(flag));
    c.ok("every push is on the record", (await prisma.auditLog.count({ where: { action: aging.PUSH_ACTION, target: k1.id } })) === 3);

    // =====================================================================
    c.head("§10 · shoot notes close themselves, reversibly");
    // =====================================================================
    const dry = await aging.expireShootNotes(new Date(), { apply: false });
    c.ok("the dry run finds exactly the shoot note whose shoot happened", dry.candidates.map((x) => x.id).join() === n1.id && dry.closed === 0, dry.candidates.map((x) => x.title).join(" | "));
    c.ok("a note written after the shoot is not a candidate", !dry.candidates.some((x) => x.id === nAfter.id));
    c.ok("…and wrote nothing", (await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } })).status === "OPEN");
    const applied = await aging.expireShootNotes(new Date(), { apply: true, actor: "drill" });
    const closed = await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } });
    c.ok("closed as a dismissal that says why, with the old summary kept under it", applied.closed === 1 && closed.status === "CANCELLED" && closed.completedAt === null && (closed.summary ?? "").startsWith(`${DISMISSED_PREFIX}the hub — shoot note, the shoot happened`) && (closed.summary ?? "").includes("Client wrote in."));
    c.ok("one AuditLog row with what it was", (await prisma.auditLog.count({ where: { action: aging.EXPIRE_ACTION, target: n1.id } })) === 1);
    c.ok("actions, edit notes, today's shoot, a still-scheduled job and a flagged note are untouched", (await prisma.smartTask.findMany({ where: { id: { in: [n2.id, n3.id, n4.id, n5.id, n6.id] } } })).every((x) => x.status === "OPEN"));
    c.ok("a second pass finds nothing more", (await aging.expireShootNotes(new Date(), { apply: true })).closed === 0);
    const undo = await aging.undoExpiredShootNotes({ apply: true, actor: "drill" });
    const back = await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } });
    c.ok("undo puts it back exactly as it was", undo.reopened === 1 && back.status === "OPEN" && back.summary === "Client wrote in.");

    // =====================================================================
    c.head("§11 · the screens render to HTML (phone-first markup, no nested links)");
    // =====================================================================
    const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
    // A link inside a link is invalid HTML and breaks taps on a phone.
    const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
    await signIn(kyle);
    const kyleHtml = ssr(await settle(await home({})));
    c.ok("Kyle's Home renders", !kyleHtml.startsWith("RENDER FAILED") && kyleHtml.includes("Your five jobs") && kyleHtml.includes("Old items to clear"), kyleHtml.slice(0, 200));
    c.ok("…with no link nested in a link", !nestedLink(kyleHtml));
    await signIn(owner);
    const ownerHtml = ssr(await settle(await home({})));
    c.ok("Jordan's Home renders (this week, behind, list, money)", !ownerHtml.startsWith("RENDER FAILED") && ownerHtml.includes("This week") && ownerHtml.includes("behind on") && !nestedLink(ownerHtml), ownerHtml.slice(0, 200));
    await signIn(kyle);
    for (const [label, tree] of [
      ["/ops", await settle(await opsPage({}))],
      ["/ops/messages", await messagesPage({ searchParams: Promise.resolve({}) })],
      ["/ops/old", await oldPage({ searchParams: Promise.resolve({}) })],
    ] as const) {
      const html = ssr(tree);
      c.ok(`${label} renders, no nested links`, !html.startsWith("RENDER FAILED") && !nestedLink(html), html.slice(0, 200));
    }

    c.ok("nothing left the box but faked Slack posts; no client message queued", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://slack.com/api/")) && await prisma.outboxMessage.count() === 0, fence.blocked.join(", "));
    void j1;
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
