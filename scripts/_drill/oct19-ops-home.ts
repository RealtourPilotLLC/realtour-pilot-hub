// Oct 19 2026 (night): ONE DASHBOARD at "/" for the owner and every office
// login (Jordan: "The home page should really be a dashboard to oversee
// everything going on … I don't want to overload the users of this hub with
// analysis paralysis"): the red line, four health tiles (each equal to its
// source), Today's shoots, Shoots in progress (the Shoots board's rows),
// Needs attention now (at most five, each with an owner and one action),
// Kyle's day ("Your list" for Kyle), shoot issues and the week and money for
// the owner only. Kyle's daily checklist is its own page (/ops/checklist);
// /ops redirects to the dashboard; /ops/requests, /ops/scheduling and
// /ops/old open the list's groups; the six-door menu (Dashboard, Shoots,
// Photos, Videos, Messages, Schedule, then More) for the owner and the
// office. Plus the old-item rules, the morning digest, New date and the
// shoot-note expiry (unchanged). Server-renders the real pages against
// disposable PGlite; the Shoots board, the video board and the behind state
// are driven through their contracts; Slack is faked; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { BehindState } from "../../src/lib/behindAlert";
import type { ShootIssue, ShootFlagGroup } from "../../src/lib/shootIssues";
import type { JobRow, JobsBoard } from "../../src/lib/jobsBoard";
import type { KyleChecklist, Dashboard, KyleDay, AttentionItem } from "../../src/lib/opsHome";
import type { OfficeDesk } from "../../src/lib/officeDesk";

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

// ---- the other lanes' contracts, overridable so the dashboard can be driven ---------
type Lanes = { late: VideoRow[]; today: VideoRow[]; sending: VideoRow[]; held: VideoRow[]; finishing: VideoRow[]; delivered: VideoRow[] };
let videoLanes: Lanes | null = null;
let behindOverride: BehindState | null = null;
let issuesOverride: { open: ShootIssue[]; byClient: ShootFlagGroup[] } | null = null;
let jobsOverride: JobsBoard | null = null;
const jobsCalls: { includeTest?: boolean }[] = [];
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  const fakeBoard = (l: Lanes) => ({ lanes: { review: [], upcoming: [], ...l }, counts: {} }) as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>>;
  return {
    ...m,
    videoDeliveryBoard: (o?: Parameters<typeof m.videoDeliveryBoard>[0]) => (videoLanes ? Promise.resolve(fakeBoard(videoLanes)) : m.videoDeliveryBoard(o)),
    videoSummary: (now?: Date) => videoLanes
      ? Promise.resolve({ readyToSend: videoLanes.sending.length, late: [...videoLanes.late, ...videoLanes.held, ...videoLanes.finishing, ...videoLanes.sending].filter((r) => r.late).length, dueToday: m.dueTodayRows(fakeBoard(videoLanes)).length })
      : m.videoSummary(now),
  };
});
interceptModule((r) => r === "@/lib/behindAlert" || /src[\\/]lib[\\/]behindAlert(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/behindAlert");
  return { ...m, behindState: (now?: Date) => (behindOverride ? Promise.resolve(behindOverride) : m.behindState(now)) };
});
interceptModule((r) => r === "@/lib/shootIssues" || /src[\\/]lib[\\/]shootIssues(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/shootIssues");
  return { ...m, ownerShootIssues: (now?: Date) => (issuesOverride ? Promise.resolve(issuesOverride) : m.ownerShootIssues(now)) };
});
// The Shoots board is J1's lane: driven here so the dashboard's table and
// tiles can be held against exactly what the board returned.
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: (now?: Date, o: { limit?: number; includeTest?: boolean } = {}) => { jobsCalls.push(o); return jobsOverride ? Promise.resolve(jobsOverride) : m.jobsBoard(now, o); } };
});

// ---- tree helpers ---------------------------------------------------------------------
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
function propValues(tree: unknown, key: string): unknown[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => propValues(part, key));
  if (!isValidElement<Props>(tree)) return [];
  return [...(key in tree.props ? [tree.props[key]] : []), ...Object.values(tree.props).flatMap((part) => propValues(part, key))];
}
const STREAMED = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "OfficeDeskSection",
  // Oct 23 2026: Jordan's own dashboard (components/owner/OwnerHome) and its streamed sections.
  "OwnerHome", "FinanceSection", "ProductionSection", "ClientIssuesSection", "TeamSection", "MeetingsSection", "CreativeSection", "EmailSectionView", "DelegatedSection", "WeeklySection", "TaskOpen"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
// Expand the server-rendered parts (never a client component) so their text,
// ids and links can be read.
const EXPAND = new Set([
  "HealthStrip", "Tile", "ShootsInProgress", "JobLine", "StageChip", "RequestsChip", "NeedsAttention", "AttentionRow", "KylesDayCard",
  "BehindLine", "DailyChecklist", "GroupCard", "LineRow", "LineActions", "Aliases", "EarlierCard", "OldItemRow",
  "DoneToday", "DoneRow", "StillOpen", "ShootIssuesCard", "OwnerWeekCard", "WeekStat", "FlaggedBanner",
]);
function expand(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && EXPAND.has(tree.type.name)) return expand((tree.type as (p: Props) => unknown)(tree.props));
  return { ...tree, props: Object.fromEntries(Object.entries(tree.props).map(([k, v]) => [k, expand(v)])) };
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void }; usePathname: () => string };
let pathname = "/";
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });
navigation.usePathname = () => pathname;
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) {
    if (e instanceof Redirect) return e.href;
    // A guard that reaches Next's own redirect (requirePageAccess) throws its digest.
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? "";
    throw e;
  }
}

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
    const { default: listPage } = await import("@/app/ops/checklist/page");
    // Oct 20 2026 (audit H18): /ops is a next.config redirect now, not a page.
    const { configRedirect } = await import("./_configRedirect");
    const { default: oldPage } = await import("@/app/ops/old/page");
    const { default: requestsPage } = await import("@/app/ops/requests/page");
    const { default: schedulingPage } = await import("@/app/ops/scheduling/page");
    const { pushOldItem } = await import("@/app/ops/old/actions");
    const opsHome = await import("@/lib/opsHome");
    const aging = await import("@/lib/taskAging");
    const { loadQueue } = await import("@/app/ops/photo-delivery/data");
    // Through require, so the drill reads the same (driven) contract the dashboard does.
    const { videoSummary } = createRequire(__filename)("../../src/lib/videoDelivery") as typeof import("../../src/lib/videoDelivery");
    const { unansweredCommsBoard } = await import("@/lib/commsBoard");
    const { getReviewQueue } = await import("@/lib/reviewRoom");
    const { forwardedHref, GROUP_ALIASES, CHECKLIST_PATH } = await import("@/lib/homeAnchors");
    const { homeRecordHref } = await import("@/lib/homeRecordScope");
    const { Sidebar } = await import("@/components/Sidebar");
    const { etAt, etDayKey, etDayStartUtc, etAddDays, etEndOfDay } = await import("@/lib/datetime");
    const { saveSchedule } = await import("@/lib/notifySchedule");
    const { DISMISSED_PREFIX } = await import("@/lib/triage");

    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const ahead = (ms: number) => new Date(now.getTime() + ms);
    const startToday = etDayStartUtc(now);
    const endToday = etDayStartUtc(new Date(startToday.getTime() + 36 * H));
    const startTomorrow = endToday;
    const laterToday = new Date(Math.min(now.getTime() + H, endToday.getTime() - 60_000));
    const isToday = (d: Date) => etDayKey(d) === etDayKey(now);

    // =====================================================================
    c.head("§1 · the rules, as pure functions");
    // =====================================================================
    c.ok("thresholds live in one place", opsHome.ON_TIME_MIN_JOBS === 3 && opsHome.MESSAGE_BEHIND_HOURS === 24 && aging.OLD_AFTER_DAYS === 3 && aging.WEEK_OLD_DAYS === 7 && aging.PUSHES_BEFORE_FLAG === 3);
    c.ok("on-time % is hidden under 3 jobs judged ('too few to judge'), shown from 3", opsHome.onTimeWords({ judged: 2, onTimePct: 50 }) === "too few to judge" && opsHome.onTimeWords({ judged: 0, onTimePct: null }) === "too few to judge" && opsHome.onTimeWords({ judged: 3, onTimePct: 67 }) === "67% on time");
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
    // Old links: every old block id is an anchor inside a checklist group, and the list is its own page now.
    const OLD_BLOCKS = ["tower", "qc-am", "overdue", "comms-1", "prep", "loops", "video-review", "pipeline", "monthly", "closeout", "operating-routine", "old-items"];
    c.ok("every old block id has a home inside a checklist group", OLD_BLOCKS.every((id) => Object.values(GROUP_ALIASES).some((a) => a.includes(id))) && GROUP_ALIASES.followups.includes("loops") && GROUP_ALIASES.deliveries.includes("video-review") && GROUP_ALIASES.messages.includes("comms-1"));
    c.ok("the list's own page is /ops/checklist", CHECKLIST_PATH === "/ops/checklist");
    c.ok("forwarding: an old checklist anchor on the dashboard goes to the list (test scope kept), the old video queue to Video Delivery's Ready to send (Oct 23 2026: the Topaz bells' held file and Run Topaz are there, not on the list); the dashboard's own anchors stay; the owner's old list goes to My Day",
      forwardedHref("/", "", "#loops") === "/ops/checklist#loops" && forwardedHref("/", "?test=1", "#requests") === "/ops/checklist?test=1#requests" && forwardedHref("/", "", "#video-review") === "/review#ready-to-send" && forwardedHref("/", "?test=1", "#video-review") === "/review?test=1#ready-to-send"
      && ["#shoots", "#stuck", "#exceptions", "#kyles-day", "#behind", "#needs-you", "#needs-attention"].every((h) => forwardedHref("/", "", h) === null)
      && forwardedHref("/", "", "#my-list") === "/day" && forwardedHref("/ops/checklist", "", "#loops") === null && forwardedHref("/", "", "#%E0") === null);
    c.ok("an old 'answer clients' anchor opens Messages (its Waiting on us view), test scope kept", forwardedHref("/", "", "#comms-1") === "/communications" && forwardedHref("/", "?test=1", "#comms-1") === "/communications?test=1" && forwardedHref("/", "", "#messages") === "/communications");
    c.ok("retired pages' doors open the list's group (everyone's tasks for the pushed bell)", opsHome.checklistDoor("requests") === "/ops/checklist#requests" && opsHome.checklistDoor("scheduling") === "/ops/checklist#scheduling" && opsHome.checklistDoor("earlier") === "/ops/checklist#earlier" && opsHome.checklistDoor("earlier", { everyone: true }) === "/tasks?tab=work&who=all");
    c.ok("test scope reaches the list and the Shoots board", homeRecordHref("/ops/checklist#earlier", true) === "/ops/checklist?test=1#earlier" && homeRecordHref("/jobs?f=late", true) === "/jobs?f=late&test=1");
    c.ok("lateness in words", opsHome.lateWords(9.4) === "9 hours" && opsHome.lateWords(24) === "1 day" && opsHome.lateWords(65) === "2.7 days");
    c.ok("On time is green with nothing late, amber for one or two, red from three or one two days late", opsHome.onTimeTone({ late: 0, oldestLateDays: null }) === "ok" && opsHome.onTimeTone({ late: 2, oldestLateDays: 1 }) === "warn" && opsHome.onTimeTone({ late: 3, oldestLateDays: 1 }) === "bad" && opsHome.onTimeTone({ late: 1, oldestLateDays: 2 }) === "bad");
    c.ok("who holds a video is read off the Shoots board's chip ('Changes · John'), never invented", opsHome.chipPerson("Changes · John") === "John" && opsHome.chipPerson("Not cut · John Mark") === "John Mark" && opsHome.chipPerson("Editing · outside") === null && opsHome.chipPerson("Editing") === null && opsHome.chipPerson(null) === null);
    c.ok("at most five lines need attention; ten shoots on the dashboard", opsHome.ATTENTION_MAX === 5 && opsHome.DASHBOARD_ROWS === 10);

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
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id }) } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

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
    const photoJobs = [] as { id: string }[];
    for (const [i, stage, sla, delivered] of [[1, "QC_REVIEW", ago(2 * H), null], [2, "READY", laterToday, null], [3, "EDITING", ahead(2 * D), null], [4, "DELIVERED", ahead(H), ago(H)]] as const) {
      const p = await project(`${20 + i} Photo Ln, Town`, i === 4 ? "DELIVERED" : "SHOT", ago(D + i * 60_000));
      photoJobs.push(await prisma.photoJob.create({ data: { projectId: p.id, stage, slaDueAt: sla, deliveredAt: delivered } }));
      pp.push(p);
    }
    // Tomorrow's shoots: one never confirmed, one confirmed.
    const tomorrowAt = new Date(startTomorrow.getTime() + 15 * H);
    const pTomorrow = await project("40 Tomorrow Way, Town", "SCHEDULED", tomorrowAt);
    const pTomorrowOk = await project("41 Confirmed Ct, Town", "SCHEDULED", tomorrowAt);
    await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "COMPLETED", completedAt: ago(H), title: "Confirm 41 Confirmed Ct", projectId: pTomorrowOk.id, clientId: real.id } });

    // Kyle's tasks.
    const task = (data: Record<string, unknown>) => prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", ...data } as never });
    const k1 = await task({ title: "Apply $750 credit for 12 Oak St", assignedKey: "kyle", dueAt: ago(10 * D), clientId: real.id });
    const k2 = await task({ taskType: "internal_instruction", source: "slack", title: "Call the stager about 5 Birch Ln", ownerId: kyleTm.id, dueAt: ago(12 * D), followUpAt: ago(4 * D) });
    await prisma.auditLog.createMany({ data: [1, 2].map(() => ({ actor: "kyle@oct19.invalid", action: aging.PUSH_ACTION, target: k2.id, detail: "{}" })) });
    const kYoung = await task({ title: "Not old yet", assignedKey: "kyle", dueAt: ago(2 * D) });
    await task({ title: "Pushed to later", assignedKey: "kyle", dueAt: ago(9 * D), followUpAt: ahead(2 * D) });
    await task({ title: "Nobody's", dueAt: ago(8 * D) });
    await task({ title: "Synthetic client chore", assignedKey: "kyle", dueAt: ago(8 * D), clientId: fixture.id });
    await task({ title: "Long done", assignedKey: "kyle", dueAt: ago(20 * D), status: "COMPLETED", completedAt: ago(19 * D) });
    const k7 = await task({ taskType: "lead", source: "openphone", title: "New lead: Pat Doe wants a listing shoot", ownerId: kyleTm.id, dueAt: ago(5 * D), createdAt: ago(5 * D) });
    const leadToday = await task({ taskType: "lead", source: "website", title: "New lead: Sam Roe", dueAt: laterToday, createdAt: ago(H) });
    const fu = await task({ taskType: "comms_followup", source: "system", title: "Chase Real Agent about the floor plan", assignedKey: "kyle", followUpAt: ago(4 * D) });
    const j1 = await task({ title: "Sign the vendor agreement", assignedKey: "jordan", dueAt: ago(8 * D) });
    // 3.5 days old at the 8:30 AM digest (§9) as well as now: "ago(3.5 days)"
    // alone was under three days old at 8:30 AM once the drill ran after 8:30 PM.
    const jm1 = await task({ title: "Reshoot plan for 3 Bay St", assignedKey: "james", dueAt: new Date(Math.min(ago(3.5 * D).getTime(), etAt(etDayKey(now), 8, 30).getTime() - 3.5 * D)) });
    await prisma.auditLog.createMany({ data: [1, 2, 3].map(() => ({ actor: "james@oct19.invalid", action: aging.PUSH_ACTION, target: jm1.id, detail: "{}" })) });
    // Due today: Kyle's instruction, a to-do moved to today, Jordan's (not Kyle's), a drafted text (the Outbox's).
    const kToday = await task({ taskType: "internal_instruction", source: "slack", title: "Send Real Agent the $200 invoice note", assignedKey: "kyle", dueAt: laterToday });
    const kMoved = await task({ title: "Order lockbox keys", assignedKey: "kyle", dueAt: ago(6 * D), followUpAt: laterToday });
    const jToday = await task({ title: "Jordan's own call", assignedKey: "jordan", dueAt: laterToday });
    const draft = await task({ taskType: "confirmation_text", source: "system", title: "Confirm 9 Today St", assignedKey: "kyle", dueAt: laterToday, projectId: pToday.id, clientId: real.id });
    // The shared ops pile: an unnamed instruction from yesterday.
    const pile = await task({ taskType: "internal_instruction", source: "slack", title: "Someone check the drone batteries", dueAt: ago(1.2 * D) });
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
    // Closed today: done by Kyle, dismissed by Kyle, answered a client, and one the hub closed itself.
    const doneTask = await task({ title: "Called the stager", assignedKey: "kyle", dueAt: ago(D), status: "COMPLETED", completedAt: ago(60_000) });
    const dismissed = await task({ title: "Duplicate floor plan ask", assignedKey: "kyle", dueAt: ago(D), status: "CANCELLED", summary: `${DISMISSED_PREFIX}Kyle Smith — not needed.` });
    const hubClosed = await task({ title: "Note lockbox for 3 Old Rd", assignedKey: "kyle", status: "CANCELLED", summary: `${DISMISSED_PREFIX}the hub — shoot note, the shoot happened Mon.` });
    const replied = await task({ taskType: "client_reply", source: "openphone", title: "Reply to Real Agent", clientId: real.id, status: "COMPLETED", completedAt: ago(30_000) });

    // Client asks: a request on a job going out today, one on a job a week out,
    // a test client's, one checked today; a scheduling ask; a move seen in Aryeo.
    const pSoon = await project("50 Soon St, Town", "EDITING", ago(D), { promisedDueAt: laterToday });
    const pLater = await project("51 Later Ln, Town", "EDITING", ago(D), { promisedDueAt: ahead(7 * D) });
    const pTest = await project("52 Test Rd, Town", "EDITING", ago(D), { promisedDueAt: laterToday }, fixture.id);
    const ask = (data: Record<string, unknown>) => prisma.clientAsk.create({ data: { clientId: real.id, kind: "SPECIAL_REQUEST", medium: "photo", source: "text", askedAt: ago(H), ...data } as never });
    const askSoon = await ask({ projectId: pSoon.id, text: "Please show the lot lines", summary: "Show the lot lines on the aerial", holdsDelivery: true });
    const askLater = await ask({ projectId: pLater.id, text: "Use the upbeat song", summary: "Upbeat song on the video", medium: "video" });
    await ask({ clientId: fixture.id, projectId: pTest.id, text: "Test client ask", summary: "Test client ask" });
    const askChecked = await ask({ projectId: pSoon.id, text: "Remove the trash cans", summary: "Trash cans out of the front shot", state: "CONFIRMED", confirmedAt: ago(10 * 60_000), confirmedBy: "Kyle Smith" });
    const schedAsk = await ask({ kind: "SCHEDULING", medium: null, text: "Can we move Thursday to Friday?", summary: "Move Thursday's shoot to Friday", projectId: pTomorrow.id });
    const aryeoAsk = await ask({ kind: "SCHEDULING", medium: null, source: "aryeo", text: "Appointment moved in Aryeo", summary: "Shoot moved to 3 PM in Aryeo", projectId: pSched.id });

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
    const editor = await user("Kim Miguel", "kim@oct19.invalid", "EDITOR");
    // A cut waiting on James's review (his seat's own line on the dashboard).
    const cutJob = await project("60 Review Rd, Town", "REVIEW", ago(2 * D), { deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 1 } } });
    const cutDeliverable = await prisma.deliverable.findFirstOrThrow({ where: { projectId: cutJob.id } });
    const jamesCut = await prisma.reviewSubmission.create({ data: { projectId: cutJob.id, deliverableId: cutDeliverable.id, slot: 1, source: "folder", kind: "video", status: "PENDING", reviewerTeamMemberId: jamesTm.id, submittedByKey: "kim", assetPath: `/isolated/${cutJob.id}.mp4`, createdAt: ago(3 * H) } });

    // The Shoots board, driven: what J1's board would return.
    const stage = (label: string, tone: "done" | "active" | "waiting" | "late" | "none") => ({ label, tone });
    const jobRow = (projectId: string, street: string, over: Partial<JobRow> = {}): JobRow => ({
      projectId, street, client: "Real Agent", dueISO: ahead(3 * D).toISOString(), dueWords: "Thu 5 PM", late: false, dueToday: false,
      photos: stage("Editing", "active"), video: null, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, href: `/projects/${projectId}`, ...over,
    });
    const boardRows: JobRow[] = [
      jobRow(pEdit.id, "2 Pine Rd", { late: true, dueISO: ago(3 * D).toISOString(), dueWords: "3 days late", photos: stage("Delivered", "done"), video: stage("Changes · John", "late"), requests: { open: 1, photo: 0, video: 1, needsOwner: 0 } }),
      jobRow(pSoon.id, "50 Soon St", { late: true, dueISO: ago(1 * D).toISOString(), dueWords: "1 day late", photos: stage("In QC", "active"), requests: { open: 2, photo: 2, video: 0, needsOwner: 2 } }),
      jobRow(pLater.id, "51 Later Ln", { dueISO: ahead(7 * D).toISOString(), dueWords: "Next Mon", video: stage("Editing · Kim", "active"), photos: null, requests: { open: 1, photo: 0, video: 1, needsOwner: 0 } }),
      jobRow(pToday.id, "9 Today St", { dueISO: laterToday.toISOString(), dueWords: "Today 5 PM", dueToday: true, photos: stage("Not shot yet", "waiting") }),
      ...Array.from({ length: 8 }, (_, i) => jobRow(`fake-job-${i}`, `${100 + i} Filler Ave`, { dueISO: ahead((4 + i) * D).toISOString(), dueWords: `In ${4 + i} days` })),
      jobRow("fake-monthly-late", "1033 Preserve Ln", { monthly: true, late: true, dueISO: ago(5 * D).toISOString(), dueWords: "5 days late", photos: null, video: stage("Changes asked", "late") }),
      jobRow("fake-monthly", "99 Bridge St", { monthly: true, dueISO: ahead(2 * D).toISOString(), dueWords: "Wed", photos: null, video: stage("Editing", "active") }),
    ];
    const board: JobsBoard = { rows: boardRows, counts: { total: boardRows.length, late: 3, dueToday: 1, dueTomorrow: 2, oldestLateDays: 5 } };
    jobsOverride = board;
    c.ok("the world is built", true);

    // The video screen's rows, driven (V's board is its own drill's business).
    const vrow = (key: string, lane: VideoRow["lane"], over: Partial<VideoRow> = {}): VideoRow => ({
      key, submissionId: null, projectId: pEdit.id, street: `${key} Video Ave`, clientName: "Real Agent", label: "Listing video", round: 1, lane, stage: "Editing", cutStatus: null, sinceISO: null, send: null, heldRender: null,
      promiseISO: laterToday.toISOString(), promiseWords: "Due today", late: false, dueToday: true, lateHours: null, approvedAtISO: null, deliveredAtISO: null,
      deliveredBy: null, push: null, heldWhy: null, reviewHref: `/review/${pEdit.id}?cut=${key}`, aryeoUrl: null, waitingSinceISO: null, ...over,
    } as VideoRow);
    // The board's lanes as of Oct 19 evening: sending = approved and ready to
    // send (open client requests ride on send.openAsks), finishing = the 1080p
    // pass, held = the sound check, a held run or a person's hold.
    const lanes: Lanes = {
      late: [vrow("v-late", "late", { stage: "Changes asked, version 2", cutStatus: "CHANGES_REQUESTED", late: true, dueToday: true, lateHours: 30, promiseISO: ago(30 * H).toISOString() })],
      today: [vrow("v-today", "today", { stage: "In review, version 1", cutStatus: "PENDING" })],
      sending: [vrow("v-send", "sending", { stage: "Approved, ready to send", cutStatus: "APPROVED", dueToday: false, promiseISO: ahead(2 * D).toISOString(), send: { openAsks: [{ summary: "Upbeat song", askedBy: "Real Agent" }] } as unknown as VideoRow["send"] })],
      held: [vrow("v-held", "held", { stage: "1080p file held", cutStatus: "APPROVED", heldWhy: "The sound check held the 1080p file: Kyle has the next step ($50 credit).", late: true, lateHours: 5, dueToday: true, promiseISO: ago(5 * H).toISOString() }), vrow("v-held-later", "held", { cutStatus: "APPROVED", dueToday: false, promiseISO: ahead(3 * D).toISOString() })],
      finishing: [vrow("v-fin", "finishing", { stage: "In the 1080p pass", cutStatus: "APPROVED" })],
      delivered: [vrow("v-sent", "delivered", { stage: "Delivered", deliveredAtISO: ago(20 * 60_000).toISOString(), deliveredBy: "Kyle Smith", dueToday: false }), vrow("v-old", "delivered", { stage: "Delivered", deliveredAtISO: ago(3 * D).toISOString(), dueToday: false })],
    };


    // =====================================================================
    c.head("§3 · Kyle's list (/ops/checklist): the daily checklist, unchanged in content, on its own page");
    // =====================================================================
    await signIn(kyle);
    const tasksBefore = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    videoLanes = lanes;
    const kyleTree = await settle(await listPage({}));
    const tasksAfter = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    const kyleText = textOf(expand(kyleTree));
    const kHeader = elements(kyleTree, "PageHeader")[0] as { title?: string; eyebrow?: string } | undefined;
    c.ok("Kyle's list is 'Your list', the red line slot, then the checklist; no summary box (the dashboard's tiles say it)", kHeader?.title === "Your list" && elements(kyleTree, "DailyChecklist").length === 1 && elements(kyleTree, "SummaryBox").length === 0 && namesOf(kyleTree).indexOf("BehindLine") < namesOf(kyleTree).indexOf("DailyChecklist"), kHeader?.title);
    const waitingNow = [...await unansweredCommsBoard("phone", now, { excludeClientIds: [fixture.id] }), ...await unansweredCommsBoard("email", now, { excludeClientIds: [fixture.id] })];
    const list = elements(kyleTree, "DailyChecklist")[0]?.list as KyleChecklist;
    const group = (k: string) => list.groups.find((g) => g.key === k)!;
    const keysOf = (k: string) => group(k).lines.map((l) => l.key);
    c.ok("one list in five groups, in Jordan's order", list.groups.map((g) => g.key).join() === "deliveries,messages,requests,scheduling,followups" && list.groups.map((g) => g.title).join(" | ") === "Deliveries | Messages to answer | Special requests to check | Scheduling to handle | Follow-ups due");
    const del = keysOf("deliveries");
    c.ok("Deliveries: the late and due-today photo jobs, not the one due later", del.includes(`photo:${photoJobs[0].id}`) && del.includes(`photo:${photoJobs[1].id}`) && !del.includes(`photo:${photoJobs[2].id}`) && !del.includes(`photo:${photoJobs[3].id}`), del.join(","));
    c.ok("Deliveries: every listing video due today or late (any lane), and every one ready to send; a held one not due waits; late first", ["video:v-late", "video:v-today", "video:v-fin", "video:v-held", "video:v-send"].every((k) => del.includes(k)) && !del.includes("video:v-held-later") && group("deliveries").lines.slice(0, 3).every((l) => l.late), del.join(","));
    const line = (g: string, k: string) => group(g).lines.find((l) => l.key === k)!;
    c.ok("each delivery says what is needed", line("deliveries", "video:v-send").need === "Ready to send" && line("deliveries", "video:v-send").detail?.includes("1 client request to check first") === true && line("deliveries", "video:v-late").need === "Waiting on editor" && line("deliveries", "video:v-today").need === "Waiting on review" && line("deliveries", "video:v-fin").need === "In the Topaz pass" && line("deliveries", "video:v-held").need === "Held" && line("deliveries", `photo:${photoJobs[1].id}`).need === "Ready to review and send" && line("deliveries", `photo:${photoJobs[0].id}`).need === "Needs your decision");
    c.ok("a delivery opens its own screen (the photo job, the exact cut)", line("deliveries", `photo:${photoJobs[0].id}`).href === `/ops/photo-delivery/${photoJobs[0].id}` && line("deliveries", "video:v-late").href === `/review/${pEdit.id}?cut=v-late` && line("deliveries", "video:v-send").action.kind === "open");
    const msgs = group("messages").lines;
    const { waitingRowReplyHref } = await import("@/components/comms/WaitingOnUs");
    const waitingRows = (await opsHome.messagesBoard({ now, excludeClientIds: [fixture.id], team: true })).waiting;
    c.ok("Messages to answer: one line per waiting client, with Reply (that exact thread on Messages, as its Waiting on us row) and Handled", msgs.length === waitingNow.length && msgs.every((l) => {
      const w = waitingRows.find((x) => l.key === `msg:${x.family}:${x.group.groupKey}`);
      return l.action.kind === "reply" && !!w && l.href === waitingRowReplyHref(w, false) && (l.action as { href: string }).href === l.href && l.href.startsWith("/communications");
    }), msgs.map((l) => l.href).join(" "));
    const longest = [...waitingNow].sort((a, b) => b.oldestHours - a.oldestHours)[0];
    c.ok("…the longest wait first, over a day is late", msgs[0].key.endsWith(`:${longest.groupKey}`) && msgs[0].late === longest.oldestHours >= 24 && msgs.every((l) => l.when?.startsWith("Waiting ")), `${msgs[0].key} ${msgs[0].when}`);
    const req = group("requests");
    c.ok("Special requests: the open request on a job going out soon, with Checked; a later job's folds; a test client's never shows", req.lines.map((l) => l.key).join() === `ask:${askSoon.id}` && req.later.map((l) => l.key).join() === `ask:${askLater.id}` && req.lines[0].action.kind === "ask" && (req.lines[0].action as { askKind: string }).askKind === "SPECIAL_REQUEST" && req.lines[0].detail?.includes("holds delivery") === true);
    const addForms = elements(expand(kyleTree), "AddAskForm");
    const addJobs = (addForms[0]?.jobs ?? []) as { id: string; label: string }[];
    c.ok("…and a request can be added by hand right under the group (the form /ops/requests had), on jobs in flight, never a test client's", addForms.length === 1 && list.requestJobs?.length === addJobs.length && [pSoon.id, pLater.id].every((id) => addJobs.some((j) => j.id === id)) && !addJobs.some((j) => j.id === pTest.id), addJobs.map((j) => j.label).join(" | "));
    const sch = keysOf("scheduling");
    c.ok("Scheduling: the client's ask (with Done) and tomorrow's shoot with no confirmation sent (not the confirmed one; an Aryeo move is no ask any more)", sch.includes(`ask:${schedAsk.id}`) && (line("scheduling", `ask:${schedAsk.id}`).action as { askKind?: string }).askKind === "SCHEDULING" && sch.includes(`confirm:${pTomorrow.id}`) && !sch.includes(`confirm:${pTomorrowOk.id}`) && !sch.includes(`ask:${aryeoAsk.id}`) && line("scheduling", `confirm:${pTomorrow.id}`).need === "Confirmation text not sent", sch.join(","));
    const fol = keysOf("followups");
    c.ok("Follow-ups due: Kyle's tasks dated today (a moved date counts), the unassigned lead due today", [kToday.id, kMoved.id, leadToday.id].every((id) => fol.includes(`task:${id}`)), fol.join(","));
    c.ok("…never Jordan's own, never a drafted client text (the Outbox sends those)", !fol.includes(`task:${jToday.id}`) && !fol.includes(`task:${draft.id}`));
    c.ok("…each with Done / Not needed", group("followups").lines.every((l) => l.action.kind === "task"));
    const earlier = list.earlier.items;
    const expectEarlier = [k1, n2, k7, k2, fu, kYoung, nAfter, pile].map((x) => x.id);
    c.ok("From earlier days: Kyle's past-due tasks (and the shared pile), any age, oldest first", earlier.length === expectEarlier.length && expectEarlier.every((id) => earlier.some((i) => i.id === id)) && earlier.every((i, n, a) => n === 0 || Date.parse(a[n - 1].chaseISO) <= Date.parse(i.chaseISO)) && earlier[0].id === k1.id, earlier.map((i) => i.title).join(" | "));
    c.ok("…leaves out the shoot note that closes itself, a date moved ahead, a test client's, and other people's", !earlier.some((i) => [n1.id, j1.id, jm1.id].includes(i.id)) && !earlier.some((i) => i.title === "Pushed to later" || i.title === "Synthetic client chore" || i.title === "Nobody's"));
    c.ok("…with the age and the push count (one more tells Jordan), figures scrubbed", kyleText.includes("10 days past its date") && kyleText.includes("pushed 2 times") && kyleText.includes("one more tells Jordan") && !kyleText.includes("$750") && kyleText.includes("[amount]") && !kyleText.includes("$200"));
    const oldRows = elements(expand(kyleTree), "OldItemActions");
    c.ok("…each earlier item has Done / Not needed / New date; follow-ups have no New date", oldRows.filter((p) => p.allowNewDate === false).length === group("followups").lines.length && oldRows.filter((p) => p.allowNewDate !== false).length === earlier.length && oldRows.filter((p) => p.allowNewDate !== false).every((p) => !!p.minDay && !!p.maxDay));
    c.ok(`…the oldest ${aging.EARLIER_SHOWN} show, the rest fold under "Show N more"`, Number(kyleText.match(/Show\s+(\d+)\s+more/)?.[1]) === earlier.length - aging.EARLIER_SHOWN);
    const done = list.done.map((d) => d.key);
    const expectDone = [`task:${doneTask.id}`, `task:${dismissed.id}`, `reply:${replied.id}`, `ask:${askChecked.id}`, "video:v-sent", ...(isToday(ago(H)) ? [`photo:${photoJobs[3].id}`] : [])];
    c.ok("Done today: what anyone closed today on these lists (a task done, one not needed, a client answered, a request checked, a video sent, photos delivered)", expectDone.every((k) => done.includes(k)) && done.length === expectDone.length, done.join(","));
    c.ok("…but not what the hub closed by itself, nor what was done another day", !done.includes(`task:${hubClosed.id}`) && !done.includes("video:v-old") && !done.some((k) => k.includes("Long done")));
    c.ok("…a request checked today can be undone from there", list.done.find((d) => d.key === `ask:${askChecked.id}`)?.reopenAskId === askChecked.id && elements(expand(kyleTree), "ReopenAskButton").length === 1);
    const openTotal = list.groups.reduce((n, g) => n + g.lines.length, 0) + earlier.length;
    c.ok("Still open = every line still on today's list plus the earlier items", list.stillOpen.total === openTotal && list.stillOpen.parts.reduce((n, p) => n + p.count, 0) === openTotal , `${list.stillOpen.total} vs ${openTotal}`);
    const ids = propValues(expand(kyleTree), "id").filter((x): x is string => typeof x === "string");
    c.ok("the groups carry anchors, and every old block anchor lands inside one", ["checklist", "deliveries", "messages", "requests", "scheduling", "followups", "earlier", "done-today", "still-open"].every((id) => ids.includes(id)) && OLD_BLOCKS.every((id) => ids.includes(id)), OLD_BLOCKS.filter((id) => !ids.includes(id)).join(","));
    const gone = ["JobTiles", "OldItemsCard", "VideoBehindBanner", "Block", "NeedsToday", "StuckJobs", "ExceptionsCard", "ProactiveFlags", "NewClientCard", "MoneyStat", "ChecklistLinks", "OwnerWeekCard", "ShootsTodayLine", "SummaryBox", "HealthStrip"];
    c.ok("the list page is the list only: no tiles, no old-items card, no blocks, no exceptions, no money", gone.every((n) => elements(kyleTree, n).length === 0), gone.filter((n) => elements(kyleTree, n).length > 0).join());
    c.ok("Kyle's list render writes nothing", tasksAfter === tasksBefore && await prisma.outboxMessage.count() === 0);
    const lineWords = list.groups.flatMap((g) => [...g.lines, ...g.later].map((l) => `${l.need} ${l.when ?? ""} ${l.detail ?? ""}`)).join(" ");
    c.ok("no em dashes in the checklist's own words", !EM_DASH.test(lineWords) && !EM_DASH.test(textOf(expand(kyleTree)).replace(/In editing — not confirmed/g, "")), lineWords.slice(0, 200));
    const heldLine = line("deliveries", "video:v-held");
    c.ok("Kyle's list speaks to him: the hub's 'Kyle has the next step' reads 'you have', figures scrubbed", heldLine.detail?.includes("you have the next step") === true && !/\bKyle\b/.test(lineWords) && !lineWords.includes("$50"), heldLine.detail ?? "");
    c.ok("the list is Kyle's own checklist (the dashboard's 'Kyle's day' reads the same one)", JSON.stringify(list.groups.map((g) => g.lines.map((l) => l.key))) === JSON.stringify((await opsHome.kyleChecklist({ now: new Date(), excludeClientIds: [fixture.id], person: { key: "kyle", teamMemberId: kyleTm.id }, scrub: true })).groups.map((g) => g.lines.map((l) => l.key))));

    // Whose list: the owner sees Kyle's (with figures), James his own unless he asks for Kyle's.
    await signIn(owner);
    const ownerListTree = await settle(await listPage({}));
    const ownerList = elements(ownerListTree, "DailyChecklist")[0]?.list as KyleChecklist;
    c.ok("the owner opens Kyle's list: 'Kyle's list', Kyle's follow-ups and earlier items, figures shown", (elements(ownerListTree, "PageHeader")[0] as { title?: string }).title === "Kyle’s list" && ownerList.earlier.items.map((i) => i.id).join() === list.earlier.items.map((i) => i.id).join() && textOf(expand(ownerListTree)).includes("$750"));
    await signIn(james);
    const jamesListTree = await settle(await listPage({}));
    const jamesList = elements(jamesListTree, "DailyChecklist")[0]?.list as KyleChecklist;
    const jamesKyleTree = await settle(await listPage({ searchParams: Promise.resolve({ who: "kyle" }) }));
    const jamesKyleList = elements(jamesKyleTree, "DailyChecklist")[0]?.list as KyleChecklist;
    c.ok("James's list is his own ('Your list', none of Kyle's follow-ups); ?who=kyle opens Kyle's", (elements(jamesListTree, "PageHeader")[0] as { title?: string }).title === "Your list" && !jamesList.earlier.items.some((i) => i.id === k1.id) && jamesList.earlier.items.some((i) => i.id === jm1.id) && (elements(jamesKyleTree, "PageHeader")[0] as { title?: string }).title === "Kyle’s list" && jamesKyleList.earlier.items.map((i) => i.id).join() === list.earlier.items.map((i) => i.id).join());
    c.ok("…and no figures for James on either", !textOf(expand(jamesListTree)).includes("$750") && !textOf(expand(jamesKyleTree)).includes("$750"));
    await signIn(kyle);

    // The red line, driven through the behind contract.
    behindOverride = { level: "very_behind", videosLate: 5, photosLate: 1, oldestLateHours: 72, headline: "5 videos late, the oldest 3 days." };
    const redList = await settle(await listPage({}));
    // Oct 23 2026: Kyle's home is his desk, with no red line beside a card
    // (the "4 late" banner against the "3 late" card): its status line says
    // "N late" once, from its own lists. The shared dashboard (the review
    // seat's home) keeps the line; the owner's own dashboard says it stage by
    // stage (Production health), held in §4b.
    const redKyle = await settle(await home({}));
    await signIn(james);
    const redDash = await settle(await home({}));
    behindOverride = { level: "ok", videosLate: 0, photosLate: 0, oldestLateHours: null, headline: null };
    const calmDash = await settle(await home({}));
    behindOverride = null;
    await signIn(kyle);
    c.ok("Kyle's desk carries no red line beside a card: its late count is said once, from its own lists", namesOf(redKyle).indexOf("BehindLine") === -1 && namesOf(redKyle).indexOf("HealthStrip") === -1 && elements(redKyle, "OfficeDesk").length === 1);
    c.ok("the red line shows the behind headline when we are behind, and nothing when we are not", textOf(expand(redList)).includes("5 videos late, the oldest 3 days.") && textOf(expand(redDash)).includes("5 videos late, the oldest 3 days.") && !textOf(expand(calmDash)).includes("videos late, the oldest"));
    c.ok("…on the dashboard it sits above the health strip and opens the late shoots", namesOf(redDash).indexOf("BehindLine") >= 0 && namesOf(redDash).indexOf("BehindLine") < namesOf(redDash).indexOf("HealthStrip") && elements(redDash, "BehindLine")[0]?.href === "/jobs?f=late");

    // =====================================================================
    c.head("§4 · the shared dashboard (the review seat's home, as the owner's was until Oct 23)");
    // =====================================================================
    // Oct 23 2026: Jordan's "/" is his own dashboard (§4b below). The shared
    // dashboard these checks were written for is the review seat's home now
    // (James in this world: an office login holding the review seat), so the
    // tiles, shoots in progress, needs attention and Kyle's day are held there.
    await signIn(james);
    videoLanes = lanes;
    issuesOverride = { open: [{ id: "si1", client: "Real Agent", street: "1 Elm St", text: "Lockbox code didn't work", by: "Harrison", atISO: ago(H).toISOString(), href: `/projects/${pShot.id}` }], byClient: [{ client: "Real Agent", clientId: null, count: 3, items: [] }, { client: "Other", clientId: null, count: 1, items: [] }] };
    const dashBefore = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    jobsCalls.length = 0;
    const ownerTree = await settle(await home({}));
    const ownerText = textOf(expand(ownerTree));
    const health = elements(ownerTree, "HealthStrip")[0]?.health as Dashboard["health"];
    c.ok("the dashboard reads the Shoots board without test records by default", jobsCalls.length >= 1 && jobsCalls.every((o) => o.includeTest === false));
    // ---- the four tiles, each equal to its source ----
    c.ok("On time = the Shoots board's counts (late, due today, due tomorrow, oldest)", JSON.stringify({ ...health.onTime, tone: undefined }) === JSON.stringify({ ...board.counts, tone: undefined }) && health.onTime?.tone === "bad", JSON.stringify(health.onTime));
    const emailWaiting = (await unansweredCommsBoard("email", now, { excludeClientIds: [fixture.id] })).length;
    c.ok("Clients waiting = the clients waiting on a reply (text + email), by channel", health.clients?.waiting === waitingNow.length && waitingNow.length >= 1 && health.clients?.email === emailWaiting && health.clients?.text === waitingNow.length - emailWaiting && health.clients?.oldestHours === Math.max(...waitingNow.map((g) => g.oldestHours)), JSON.stringify(health.clients));
    c.ok("…its tone is red when anyone has waited a day", health.clients?.tone === (waitingNow.some((g) => g.oldestHours >= opsHome.MESSAGE_BEHIND_HOURS) ? "bad" : "warn"));
    // Oct 20 2026 (audit A10): counted off the Shoots rows the tile opens (/jobs?f=requests), not every open ask.
    c.ok("Special requests = the open requests on the Shoots board's rows, on N shoots and M needing an owner; none on no job", health.requests?.open === boardRows.reduce((n, r) => n + r.requests.open, 0) && health.requests?.open === 4 && health.requests?.shoots === boardRows.filter((r) => r.requests.open > 0).length && health.requests?.needOwner === boardRows.reduce((n, r) => n + r.requests.needsOwner, 0) && health.requests?.needOwner === 2 && health.requests?.notOnJob === 0, JSON.stringify(health.requests));
    const reviewNow = await getReviewQueue({ includeTest: false });
    const queueNow = await loadQueue();
    const inQc = queueNow.columns.filter((col) => ["qc", "decision", "ready"].includes(col.key)).flatMap((col) => col.cards);
    const vsNow = await videoSummary(now);
    c.ok("QC & review = cuts to review (Video Review Room), videos ready to send (videoSummary), photo sets in QC (the photo queue)", health.qc?.toReview === reviewNow.pending.length && reviewNow.pending.some((p) => p.id === jamesCut.id) && health.qc?.readyToSend === vsNow.readyToSend && vsNow.readyToSend === 1 && health.qc?.photosInQc === inQc.length && inQc.length === 2, JSON.stringify(health.qc));
    c.ok("…a photo set past its date in QC makes it red, and it opens the Video Review Room while videos wait", health.qc?.late === 1 && health.qc?.tone === "bad" && health.qc?.href === "/review");
    const dashHtml = renderToStaticMarkup(expand(ownerTree) as Parameters<typeof renderToStaticMarkup>[0]);
    const tileHref = (name: string) => dashHtml.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*data-health="${name}"`))?.[1] ?? dashHtml.match(new RegExp(`<a[^>]*data-health="${name}"[^>]*href="([^"]+)"`))?.[1];
    c.ok("each tile is a link: On time → late shoots, Clients waiting → Messages, Special requests → Shoots with requests, QC & review → Videos", tileHref("on-time") === "/jobs?f=late" && tileHref("clients") === "/communications" && tileHref("requests") === "/jobs?f=requests" && tileHref("qc") === "/review", [tileHref("on-time"), tileHref("clients"), tileHref("requests"), tileHref("qc")].join(" "));
    c.ok("…each with its state colour (red: late shoots and a QC item late; the others by their own rule)", dashHtml.includes('data-health="on-time" data-tone="bad"') && dashHtml.includes(`data-health="clients" data-tone="${health.clients?.tone}"`) && dashHtml.includes(`data-health="requests" data-tone="${health.requests?.tone}"`) && dashHtml.includes('data-health="qc" data-tone="bad"'));
    c.ok("…and the words: '3 late', due today and tomorrow, oldest 5 days; '2 need an owner'; '1 ready' (said once: not again under it)", ["3 late", "1 due today · 2 due tomorrow · oldest 5 days", "2 need an owner", "1 ready", "2 photo sets in QC"].every((w) => dashHtml.includes(w)) && !dashHtml.includes("1 video ready to send"), dashHtml.slice(dashHtml.indexOf("data-health-strip"), dashHtml.indexOf("data-health-strip") + 1500));

    // ---- shoots in progress ----
    // Oct 23 2026: Shoots in progress is a card on the shared dashboard (the
    // office's desk has none, the owner and the CREATIVE_MANAGER login each
    // have their own home), which an office login flagged creative manager on
    // the roster still gets, so it is read from that home.
    const caraTm = await prisma.teamMember.create({ data: { name: "Cara Creative", role: "MANAGER", email: "cara@oct19.invalid", creativeManager: true } });
    const cara = await user("Cara Creative", caraTm.email!, "ADMIN", caraTm.id);
    await signIn(cara);
    const cTree = await settle(await home({}));
    const cHtml = renderToStaticMarkup(expand(cTree) as Parameters<typeof renderToStaticMarkup>[0]);
    const cText = textOf(expand(cTree));
    await signIn(james);
    // Oct 23 2026: every home that showed Shoots in progress has its own now
    // (the owner's dashboard, the creative manager's desk, Kyle's desk), so
    // the shared dashboard's card is shown to nobody; the Shoots board (/jobs)
    // is where the shoots in progress are.
    c.ok("Shoots in progress is retired from the shared dashboard (the Shoots board holds it)", elements(cTree, "ShootsInProgress").length === 0 && !cHtml.includes('aria-labelledby="in-progress-title"') && typeof cText === "string");

    // ---- needs attention now ----
    const att = elements(ownerTree, "NeedsAttention")[0]?.attention as Dashboard["attention"];
    const item = (key: string) => att.items.find((i) => i.key.startsWith(key)) as AttentionItem | undefined;
    c.ok("Needs attention: at most five, red first, each with an owner and one action", att.items.length === opsHome.ATTENTION_MAX && att.items.every((i) => !!i.owner && !!i.action.label && !!i.action.href) && att.items.every((i, n, a) => n === 0 || !(a[n - 1].tone === "warn" && i.tone === "bad")), att.items.map((i) => `${i.tone}:${i.key}`).join(" "));
    // Oct 20 2026 (audit A6): "Open in Videos", not "Remind John": the button only ever opened the room.
    // Oct 23 2026: named as its menu door, "Open in Video Delivery".
    c.ok("…the late video with its editor (from the board's chip) and Open in Video Delivery", item("late:")?.lead === "v-late Video Ave:" && item("late:")?.text.includes("1.3 days late") === true && item("late:")?.owner.startsWith("John") === true && item("late:")?.action.label === "Open in Video Delivery" && item("late:")?.action.href === "/review", JSON.stringify(item("late:")));
    c.ok("…clients waiting, owned by Kyle, oldest first", item("clients")?.lead === `${waitingNow.length} client${waitingNow.length === 1 ? "" : "s"}` && item("clients")?.owner.startsWith("Kyle · oldest") === true && item("clients")?.action.href === "/communications", JSON.stringify(item("clients")));
    c.ok("…the requests nobody owns, on the one shoot (late, so red), opening that shoot", item("needs-owner")?.lead === "50 Soon St:" && item("needs-owner")?.text === "2 client requests with no owner yet" && item("needs-owner")?.tone === "bad" && item("needs-owner")?.action.href === `/projects/${pSoon.id}`, JSON.stringify(item("needs-owner")));
    c.ok("…the video ready to send with a client request to check, Kyle's to send", item("send:")?.lead === "v-send Video Ave video:" && item("send:")?.text.startsWith("check the client's request, then send it") === true && item("send:")?.owner === "Kyle · 1 client request" && item("send:")?.action.label === "Check & send" && item("send:")?.action.href === `/review/${pEdit.id}?cut=v-send`, JSON.stringify(item("send:")));
    const oldTeam = await aging.listOldItems(new Date(), { excludeClientIds: [fixture.id] });
    const jordanWeekOld = oldTeam.people.find((p) => p.key === "jordan")?.weekOld ?? 0;
    c.ok("…the reader's own week-old items are theirs to open; Kyle's old items are never on another office login's list (the owner's view, below)", jordanWeekOld === 1 && (!item("old-mine") || item("old-mine")?.action.href === "/ops/checklist#earlier") && !item("old-ops"), `${att.items.map((i) => i.key).join(",")} more=${att.more}`);
    const kylesWeekOld = oldTeam.people.find((p) => p.key === "kyle")?.weekOld ?? 0;
    // With the videos, shoots and requests quiet, the owner's list has room for Kyle's old items.
    const savedJobs = jobsOverride;
    videoLanes = { late: [], today: [], sending: [], held: [], finishing: [], delivered: [] };
    jobsOverride = { rows: [], counts: { total: 0, late: 0, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } };
    const quietDash = await opsHome.buildDashboard({ now: new Date(), excludeClientIds: [fixture.id], viewer: { role: "OWNER", key: "jordan", teamMemberId: jordanTm.id }, ops: { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" } });
    jobsOverride = savedJobs;
    videoLanes = lanes;
    const quietOps = quietDash.attention.items.find((i) => i.key === "old-ops");
    c.ok("…with room, Kyle's week-old items are on the owner's list ('N of Kyle's items', his list)", kylesWeekOld > 0 && quietOps?.lead === `${kylesWeekOld} of Kyle's items` && quietOps.owner === "Kyle · their list" && quietOps.action.href === "/ops/checklist#earlier" && quietDash.health.onTime?.tone === "ok" && quietDash.jobs.rows.length === 0, JSON.stringify(quietDash.attention.items.map((i) => i.key)));
    c.ok("…and a quiet board says so: no shoots in progress, nothing late", quietDash.health.onTime?.late === 0 && quietDash.attention.items.every((i) => !i.key.startsWith("late:") && !i.key.startsWith("send:")));

    // ---- Kyle's day, shoot issues, today's shoots, week, money ----
    const day = elements(ownerTree, "KylesDayCard")[0]?.day as KyleDay | null;
    const kylesOwn = await opsHome.kyleChecklist({ now: new Date(), excludeClientIds: [fixture.id], person: { key: "kyle", teamMemberId: kyleTm.id } });
    c.ok("Kyle's day: done today and still open, from Kyle's own checklist, opening his list", day?.name === "Kyle" && day.you === false && day.done === kylesOwn.done.length && day.open === kylesOwn.stillOpen.total && day.href === "/ops/checklist?who=kyle" && ownerText.includes("Kyle’s day"), JSON.stringify(day));
    c.ok("…shown as a number and a bar, never sent to Jordan as a message", ownerText.includes("done today") && ownerText.includes("still open") && slack.length === 0 && await prisma.notification.count() === 0);
    const dashIds = propValues(ownerTree, "id").filter((x): x is string => typeof x === "string");
    c.ok("Today's shoots is the shoot card (#shoots), with today's shoot on it", dashIds.includes("shoots") && (elements(ownerTree, "ShootList")[0]?.shoots as unknown[] | undefined)?.length === 1, dashIds.join(","));
    const sorder = namesOf(ownerTree);
    const sat = (n: string) => sorder.indexOf(n);
    c.ok("the shared dashboard's order: the tiles, needs attention, Kyle's day; no money anywhere on it", sat("FlaggedBanner") === -1 && sat("HealthStrip") >= 0 && sat("HealthStrip") < sat("NeedsAttention") && sat("NeedsAttention") < sat("KylesDayCard") && ["OwnerMoneyLine", "MoneyStat", "OwnerWeekCard", "ShootIssuesCard"].every((n) => sat(n) === -1), sorder.filter((n) => ["FlaggedBanner", "BehindLine", "OwnerMoneyLine", "HealthStrip", "NeedsAttention", "KylesDayCard", "OwnerWeekCard", "MoneyStat"].includes(n)).join(","));
    c.ok("the old Home's duplicates are gone: no checklist, summary box, behind card, his list, needs wall, exceptions, stuck jobs", ["DailyChecklist", "SummaryBox", "BehindCard", "KylesDay", "QuickAdd", "NeedsToday", "ExceptionsCard", "StuckJobs", "NewClientCard", "ChecklistLinks"].every((n) => elements(ownerTree, n).length === 0) && elements(ownerTree, "PulseStrip").length <= 1);
    c.ok("the dashboard render writes nothing", dashBefore === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.outboxMessage.count() === 0);

    // =====================================================================
    c.head("§4b · Jordan's own dashboard (Oct 23 2026): what the owner-only cards said, in its sections");
    // =====================================================================
    await signIn(owner);
    jobsCalls.length = 0;
    const jordanBefore = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    const jordanTree = await settle(await home({}));
    issuesOverride = null;
    const jordanHtml = renderToStaticMarkup(jordanTree as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("his dashboard reads the Shoots board without test records by default", jobsCalls.length >= 1 && jobsCalls.every((o) => o.includeTest === false));
    // Oct 27 2026 Loom: bottlenecks show as topics; the flag itself opens in the topic's panel.
    c.ok("shoot issues (owner only): the open one is a bottleneck topic for him to decide; what keeps happening by client (2+) is a client-issue pattern", /data-topic="shoot-flags" data-topic-count="1"/.test(jordanHtml) && jordanHtml.includes("Shoot issues flagged to you") && jordanHtml.includes("Real Agent · Shoot issues keep coming up") && !jordanHtml.includes("Other · Shoot issues keep coming up"), JSON.stringify({ topic: /data-topic="shoot-flags"[^>]*/.exec(jordanHtml)?.[0], pattern: jordanHtml.includes("Real Agent · Shoot issues keep coming up") }));
    const weekTiles = [...jordanHtml.matchAll(/data-measure="([a-z]+)"/g)].map((m) => m[1]);
    c.ok("this week (owner only) is Weekly performance: photos and listing videos on time apart, revisions, replies, shoots covered", ["photos", "videos", "revisions", "replies", "shoots"].every((k) => weekTiles.includes(k)), weekTiles.join(","));
    if (weekOk) {
      const vid = jordanHtml.slice(jordanHtml.indexOf('data-measure="videos"'), jordanHtml.indexOf('data-measure="videos"') + 900);
      c.ok("…with 2 listing videos the measure says 'Not enough data' (Oct 27 2026), never '50%' (1 of 2 on time)", vid.includes("Not enough data") && vid.includes("1 of 2 on time") && !vid.includes(">50%<"), vid.replace(/<[^>]+>/g, " ").slice(0, 200));
    } else {
      c.ok("(Monday just after midnight: the week's fixtures are skipped)", true);
    }
    const sections = ["finance", "production", "client-issues", "team", "meetings", "creative", "email", "delegated", "weekly"].map((id) => jordanHtml.indexOf(`data-section="${id}"`));
    c.ok("owner order (Oct 23 2026, his mockup): money, production, client issues, team, meetings, scripts, email, delegated, the week", sections.every((i, k) => i > 0 && (k === 0 || i > sections[k - 1])), sections.join(","));
    c.ok("…none of the shared cards on his (no tiles, needs attention, Kyle's day card, old money strip)", ["HealthStrip", "NeedsAttention", "KylesDayCard", "OwnerMoneyLine", "MoneyStat", "OwnerWeekCard"].every((n) => elements(jordanTree, n).length === 0));
    c.ok("his dashboard render writes no task and sends nothing", jordanBefore === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && await prisma.outboxMessage.count() === 0);

    // =====================================================================
    c.head("§5 · Kyle's home is his desk (Oct 23 2026, Jordan's spec): his work, no money");
    // =====================================================================
    await signIn(kyle);
    const kDash = await settle(await home({}));
    const kHtml = renderToStaticMarkup(expand(kDash) as Parameters<typeof renderToStaticMarkup>[0]);
    const kDesk = elements(kDash, "OfficeDesk")[0]?.desk as OfficeDesk;
    const kSec = (k: string) => kDesk.sections.find((t) => t.key === k)!;
    c.ok("Kyle's '/' is his desk: none of the old cards (tiles, Needs attention, Kyle's day, the shoots card)", !!kDesk && ["HealthStrip", "NeedsAttention", "KylesDayCard", "TodaysShoots", "ShootsInProgress", "BehindLine"].every((n) => elements(kDash, n).length === 0), namesOf(kDash).filter((n) => ["HealthStrip", "NeedsAttention", "KylesDayCard", "TodaysShoots"].includes(n)).join());
    c.ok("every count on it is the length of the rows it labels (four sections, revision 2)", kDesk.sections.map((t) => t.key).join() === "deliver,comms,shoots,followups" && kDesk.sections.every((t) => t.count === t.now.length), JSON.stringify(kDesk.sections.map((t) => [t.key, t.count, t.now.length])));
    c.ok("the clients waiting are his Client Communications (Messages' own waiting list)", kSec("comms").now.filter((i) => i.id.startsWith("reply:")).length === waitingNow.length && waitingNow.length >= 1);
    const kJob = kSec("deliver").now.find((i) => i.id === `video:${pEdit.id}`);
    const kSend = kJob?.panel.kind === "job" ? kJob.panel.assets.find((a) => a.id === "video:v-send") : undefined;
    c.ok("the approved video with a client request to check is his to send, the request named", kSend?.tone === "now" && kSend.status.includes("ready to send") && kSend.status.includes("1 client request"), kSend?.status);
    c.ok("his task ten days past its date is backlog (one link, never re-dated or closed); every row on the desk has an action", !kSec("followups").now.some((i) => i.id === `task:${k1.id}`) && kDesk.backlog.count >= 1 && kDesk.sections.flatMap((t) => t.now).every((i) => !!i.primary));
    c.ok("no 'done today by the office': the day's summary is his own work", !kHtml.includes("done today by the office") && Array.isArray(kDesk.checks.summary.completed));
    c.ok("no money for Kyle: no week, no money, no shoot issues, no figure anywhere on the page", ["OwnerWeekCard", "MoneyStat", "ShootIssuesCard", "OwnerBusiness", "PulseStrip"].every((n) => elements(kDash, n).length === 0) && !/\$\d/.test(kHtml), (kHtml.match(/.{40}\$\d.{40}/) ?? [""])[0]);
    // Jordan, Oct 19 2026: "we don't need this at the top of the screen. Only flagged issues should show up on the shoot itself."
    c.ok("no flagged banner on the dashboard (flags show on the shoot itself)", elements(kDash, "FlaggedBanner").length === 0);

    // =====================================================================
    c.head("§6 · the same dashboard, as James (office, the review seat)");
    // =====================================================================
    await signIn(james);
    const jDash = await settle(await home({}));
    const jHtml = renderToStaticMarkup(expand(jDash) as Parameters<typeof renderToStaticMarkup>[0]);
    const jAtt = elements(jDash, "NeedsAttention")[0]?.attention as Dashboard["attention"];
    const jItem = (key: string) => jAtt.items.find((i) => i.key.startsWith(key));
    c.ok("James gets the dashboard, not the old review desk", elements(jDash, "HealthStrip").length === 1 && elements(jDash, "NeedsToday").length === 0 && !textOf(jDash).includes("Your creative review desk"));
    c.ok("…his assigned cut is a line of its own, opening that exact version", jItem("review-mine")?.lead === "1 cut" && jItem("review-mine")?.text === "assigned to you to review" && jItem("review-mine")?.owner.startsWith("You · oldest 3h") === true && jItem("review-mine")?.action.href === `/review/${cutJob.id}?cut=${jamesCut.id}`, JSON.stringify(jItem("review-mine")));
    c.ok("…Kyle's work stays Kyle's on James's screen", jItem("clients")?.owner.startsWith("Kyle") === true && jAtt.items.length <= opsHome.ATTENTION_MAX && jAtt.items.every((i) => !!i.owner && !!i.action.href));
    const jDay = elements(jDash, "KylesDayCard")[0]?.day as KyleDay | null;
    c.ok("…'Kyle's day' with Kyle's numbers, opening Kyle's list", jDay?.you === false && jDay.done === day?.done && jDay.open === day?.open && jDay.href === "/ops/checklist?who=kyle" && jHtml.includes("Kyle’s day"));
    c.ok("…and no money for James either", ["OwnerWeekCard", "MoneyStat", "ShootIssuesCard"].every((n) => elements(jDash, n).length === 0) && !/\$\d/.test(jHtml));

    // ---- the test-records view ----
    await signIn(owner);
    jobsCalls.length = 0;
    const ownerTest = renderToStaticMarkup(await settle(await home({ searchParams: Promise.resolve({ test: "1" }) })) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("Show test records on the owner's dashboard: the Shoots board is read with them, and it says so", jobsCalls.some((o) => o.includeTest === true) && ownerTest.includes("Showing real and test records on the dashboard"));
    // The shared dashboard's doors (Shoots in progress's "All shoots" among
    // them) are the creative manager's; the clients-waiting number the review
    // seat's.
    await signIn(cara);
    jobsCalls.length = 0;
    const testHtml = renderToStaticMarkup(expand(await settle(await home({ searchParams: Promise.resolve({ test: "1" }) }))) as Parameters<typeof renderToStaticMarkup>[0]);
    const testDash = await settle(await home({ searchParams: Promise.resolve({ test: "1" }) }));
    await signIn(james);
    c.ok("Show test records: the Shoots board is read with them, and the doors keep the view", jobsCalls.some((o) => o.includeTest === true) && testHtml.includes('href="/jobs?f=late&amp;test=1"') && testHtml.includes("Showing real and test records on the dashboard") && typeof pEdit.id === "string");
    const testClients = (elements(testDash, "HealthStrip")[0]?.health as Dashboard["health"]).clients;
    const allWaiting = (await unansweredCommsBoard("phone", now)).length + (await unansweredCommsBoard("email", now)).length;
    c.ok("…the clients-waiting number counts the test clients too", testClients?.waiting === allWaiting, `${testClients?.waiting} vs ${allWaiting}`);

    // =====================================================================
    c.head("§7 · /ops goes to the dashboard; the retired pages open the list's groups");
    // =====================================================================
    await signIn(kyle);
    c.ok("/ops redirects to the dashboard (test scope kept)", await configRedirect("/ops") === "/" && await configRedirect("/ops", { test: "1" }) === "/?test=1");
    c.ok("/ops/requests → the list's Special requests, /ops/scheduling → Scheduling, /ops/old → From earlier days", await redirectOf(() => requestsPage({})) === "/ops/checklist#requests" && await redirectOf(() => schedulingPage({})) === "/ops/checklist#scheduling" && await redirectOf(() => oldPage({})) === "/ops/checklist#earlier");
    c.ok("…test scope rides along", await redirectOf(() => requestsPage({ searchParams: Promise.resolve({ test: "1" }) })) === "/ops/checklist?test=1#requests");
    await signIn(owner);
    c.ok("the owner lands on the same groups (Kyle's list); the pushed bell (?who=all) opens everyone's tasks", await redirectOf(() => requestsPage({})) === "/ops/checklist#requests" && await redirectOf(() => schedulingPage({})) === "/ops/checklist#scheduling" && await redirectOf(() => oldPage({ searchParams: Promise.resolve({ who: "all" }) })) === "/tasks?tab=work&who=all");
    await signIn(james);
    c.ok("James lands on his own list's groups", await redirectOf(() => requestsPage({})) === "/ops/checklist#requests" && await redirectOf(() => schedulingPage({})) === "/ops/checklist#scheduling");
    await signIn(editor);
    c.ok("an editor opening the list or a door goes to their own home", await redirectOf(() => listPage({})) !== null && await redirectOf(() => home({})) === "/editing");
    await signIn(kyle);
    const msgBoard = await opsHome.messagesBoard({ now, excludeClientIds: [fixture.id], viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    c.ok("messagesBoard (the dashboard's clients waiting and the Messages screen): the clients waiting and the new leads", msgBoard.waiting.length === waitingNow.length && msgBoard.counts.open === msgBoard.waiting.length + msgBoard.leads.length && msgBoard.leads.some((l) => l.id === k7.id && l.behind) && msgBoard.leads.some((l) => l.id === leadToday.id) && msgBoard.leads.length === 2);

    // =====================================================================
    c.head("§8 · the menu (Oct 22 2026, Jordan's approved role menus): each role's own doors, everything else under More");
    // =====================================================================
    const menu = (u: { name: string; email: string; role: string; permissions?: string | null }) => renderToStaticMarkup(createElement(Sidebar, { user: { name: u.name, email: u.email, role: u.role, permissions: u.permissions ?? null } }));
    const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
    const labels = (html: string) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]);
    const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-sidebar-group="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
    const ROLE_DOORS = [
      // Oct 27 2026 (Jordan's Loom): the /jobs door reads "Projects" (it read "Shoots"), and the rest sits under its
      // plain group headings with no "More" title (the section keeps data-sidebar-group="more").
      // Oct 23 2026 (Jordan): Photo Delivery and Video Delivery; Kyle's "Ready to send" door is Video Delivery too.
      // Oct 23 2026: the media library's one door, Media, is under More for all three (never a role door).
      ["Jordan (owner)", { name: "Jordan", email: owner.email, role: "OWNER" }, "/,/review,/editing,/content,/ops/photo-delivery,/communications,/jobs", "Dashboard,Video Delivery,Editing Room,Monthly Content,Photo Delivery,Messages,Projects", ["/tasks", "/clients", "/upload", "/settings", "/schedule", "/sales", "/media"]],
      ["Kyle (office)", { name: "Kyle Smith", email: kyle.email, role: "ADMIN" }, "/,/ops/checklist,/communications,/ops/photo-delivery,/review#ready-to-send,/editing,/jobs", "Dashboard,Your list,Messages,Photo Delivery,Video Delivery,Editing Room,Projects", ["/tasks", "/clients", "/content", "/upload", "/settings", "/schedule", "/media"]],
      // Oct 22 2026: Photo Delivery, the view-only photo desk, joins James's doors.
      ["James (creative manager)", { name: "James", email: james.email, role: "CREATIVE_MANAGER" }, "/,/review,/editing,/content,/ops/photo-delivery,/upload,/jobs,/my-pay", "Dashboard,Video Delivery,Editing Room,Monthly Content,Photo Delivery,Uploads,Projects,My Pay", ["/tasks", "/clients", "/shoot", "/schedule", "/media"]],
    ] as const;
    for (const [who, u, doors, doorLabels, more] of ROLE_DOORS) {
      const html = menu(u);
      c.ok(`${who}: their doors in order, labelled ${doorLabels}`, hrefs(section(html, "work")).join() === doors && labels(section(html, "work")).join() === doorLabels && !section(html, "work").includes("<details"), `${hrefs(section(html, "work")).join()} / ${labels(section(html, "work")).join()}`);
      c.ok(`${who}: everything else under More, open (Jordan, Oct 23 2026), nothing removed (${more.join(", ")})`, !section(html, "more").includes("<details") && more.every((h) => hrefs(section(html, "more")).includes(h)) && hrefs(html).length === new Set(hrefs(html)).size, hrefs(section(html, "more")).join());
      c.ok(`${who}: the retired screens are no menu entry (/ops, /ops/messages, video delivery, requests, scheduling, old items)`, !["/ops", "/ops/messages", "/ops/video-delivery", "/ops/requests", "/ops/scheduling", "/ops/old"].some((h) => hrefs(html).includes(h)));
    }
    const ownerMenu = menu({ name: "Jordan", email: owner.email, role: "OWNER" });
    const kyleMenu = menu({ name: "Kyle Smith", email: kyle.email, role: "ADMIN" });
    const listsOf = (html: string) => html.match(/data-sidebar-subgroup="lists"[^>]*>([\s\S]*?)<\/div><\/div>/)?.[1] ?? "";
    const groupIds = (html: string) => [...section(html, "more").matchAll(/data-sidebar-subgroup="([^"]+)"/g)].map((m) => m[1]);
    c.ok("Your list is a door of Kyle's own; the owner's checklist reads Daily checklist under More → Lists & schedule", hrefs(section(kyleMenu, "work"))[1] === "/ops/checklist" && hrefs(listsOf(ownerMenu))[0] === "/ops/checklist" && labels(listsOf(ownerMenu))[0] === "Daily checklist", `${labels(listsOf(ownerMenu)).join()}`);
    c.ok("money stays the owner's and leads his More (Finance, Trends); My Day too", groupIds(ownerMenu)[0] === "money" && ["/sales", "/trends", "/day"].every((h) => hrefs(section(ownerMenu, "more")).includes(h)) && !["/sales", "/trends", "/day"].some((h) => hrefs(kyleMenu).includes(h)), groupIds(ownerMenu).join());
    c.ok("Kyle's menu has no Style Guide or Communication coaching (still reachable by URL)", !hrefs(kyleMenu).includes("/resources/video-styles") && !hrefs(kyleMenu).includes("/coaching"));
    c.ok("reporting a hub issue stays one click away outside the fold", section(kyleMenu, "more").indexOf('href="/feedback"') > section(kyleMenu, "more").indexOf("</details>"));
    const editorMenu = menu({ name: "Kim", email: "kim@oct19.invalid", role: "EDITOR" });
    const photographerMenu = menu({ name: "Harrison", email: "harrison@oct19.invalid", role: "PHOTOGRAPHER" });
    c.ok("editors keep their groups (no dashboard, no doors)", !editorMenu.includes('data-sidebar-group="work"') && !editorMenu.includes('data-sidebar-group="more"') && !hrefs(editorMenu).includes("/") && !hrefs(editorMenu).includes("/jobs") && hrefs(editorMenu).includes("/editing") && !hrefs(editorMenu).includes("/ops/checklist"));
    c.ok("photographers get the field doors (My Shoots, Upload, My Videos, My Pay, Help) and no Editing Room, no office screens", hrefs(section(photographerMenu, "work")).join() === "/shoot,/upload,/review,/my-pay,/resources" && labels(section(photographerMenu, "work")).join() === "My Shoots,Upload,My Videos,My Pay,Help" && !hrefs(photographerMenu).includes("/editing") && !hrefs(photographerMenu).includes("/") && !hrefs(photographerMenu).includes("/jobs") && !hrefs(photographerMenu).includes("/ops/checklist") && !hrefs(photographerMenu).includes("/media") && !hrefs(editorMenu).includes("/media"), `${hrefs(section(photographerMenu, "work")).join()} / ${labels(section(photographerMenu, "work")).join()}`);
    pathname = "/ops/checklist";
    // Oct 21 2026 (Jordan, audit A9): Your list has its own door under More → Lists.
    const onList = menu({ name: "Kyle Smith", email: kyle.email, role: "ADMIN" });
    c.ok("on Kyle's list the Your list door is lit, and only it", (onList.match(/aria-current="page"/g) ?? []).length === 1 && /<a[^>]*href="\/ops\/checklist"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/ops\/checklist"/.test(onList));
    pathname = "/jobs/abc";
    c.ok("on a Projects page (/jobs) the Projects door is lit", /<a[^>]*href="\/jobs"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/jobs"/.test(menu({ name: "Kyle Smith", email: kyle.email, role: "ADMIN" })));
    pathname = "/";

    // =====================================================================
    c.head("§9 · the morning digest (one bell + one DM each, Jordan's quiet time kept)");
    // =====================================================================
    // §3's fixtures that are not old items for the digest (done/dismissed) do not change it.
    const morning = etAt(etDayKey(new Date()), 8, 30);
    c.ok("idle outside 8 to 10 AM ET", (await aging.oldItemsMorning(etAt(etDayKey(new Date()), 11, 0))).window === false);
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
    c.ok("Jordan's DM: his own item plus 'Kyle has N items over a week old'", heldText.includes("Sign the vendor agreement") && /Kyle has \d+ items over a week old/.test(heldText) && heldText.includes("/ops/old?who=all"), heldText);
    await aging.oldItemsMorning(morning);
    c.ok("a second tick the same morning sends nothing more", (await prisma.notification.count({ where: { kind: "old_items" } })) === 3 && slack.filter((m) => m.channel === "U-JAMES").length === 1);
    const kyleLines = await aging.kyleOldItemLines("https://hub.example");
    const kyleOld = await aging.listOldItems(new Date(), { personKey: "kyle", excludeClientIds: [fixture.id], scrub: true });
    c.ok("Kyle's digest lines: his count, the oldest first, no figures, no em dashes, and the link lands on his checklist via /ops/old", kyleLines.count === kyleOld.items.length && kyleLines.lines[0].includes(`Old items to clear (${kyleOld.items.length})`) && kyleLines.lines.join("\n").includes("[amount]") && !kyleLines.lines.join("\n").includes("$750") && !EM_DASH.test(kyleLines.lines.join("\n")) && kyleLines.lines.at(-1) === "https://hub.example/ops/old");

    // =====================================================================
    c.head("§10 · New date: picked, counted, and the third tells Jordan");
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
    const afterList = await aging.checklistTasks(new Date(), { person: { key: "kyle", teamMemberId: kyleTm.id }, excludeClientIds: [fixture.id] });
    c.ok("…and takes it off today's checklist (earlier days and today's follow-ups)", !afterList.earlier.some((i) => i.id === k1.id) && !afterList.dueToday.some((i) => i.id === k1.id));
    await pushOldItem(k1.id, d2);
    c.ok("two pushes do not tell Jordan", (await prisma.notification.count({ where: { kind: "old_item_pushed" } })) === 0);
    const p3 = await pushOldItem(k1.id, d3);
    const flag = await prisma.notification.findMany({ where: { kind: "old_item_pushed" } });
    c.ok("the third push flags Jordan (one owner bell) and says so", p3.ok && p3.pushes === 3 && p3.message.includes("Jordan is told") && flag.length === 1 && JSON.parse(flag[0].audience).includes("OWNER") && flag[0].href === "/ops/old?who=all", JSON.stringify(flag));
    c.ok("every push is on the record", (await prisma.auditLog.count({ where: { action: aging.PUSH_ACTION, target: k1.id } })) === 3);

    // =====================================================================
    c.head("§11 · shoot notes close themselves, reversibly");
    // =====================================================================
    const dry = await aging.expireShootNotes(new Date(), { apply: false });
    c.ok("the dry run finds exactly the shoot note whose shoot happened", dry.candidates.map((x) => x.id).join() === n1.id && dry.closed === 0, dry.candidates.map((x) => x.title).join(" | "));
    c.ok("a note written after the shoot is not a candidate", !dry.candidates.some((x) => x.id === nAfter.id));
    c.ok("…and wrote nothing", (await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } })).status === "OPEN");
    const applied = await aging.expireShootNotes(new Date(), { apply: true, actor: "drill" });
    const closed = await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } });
    c.ok("closed as a dismissal that says why, with the old summary kept under it", applied.closed === 1 && closed.status === "CANCELLED" && closed.completedAt === null && (closed.summary ?? "").startsWith(`${DISMISSED_PREFIX}the hub — shoot note, the shoot happened`) && (closed.summary ?? "").includes("Client wrote in."));
    c.ok("one AuditLog row with what it was", (await prisma.auditLog.count({ where: { action: aging.EXPIRE_ACTION, target: n1.id } })) === 1);
    const closedToday = await aging.checklistTasksClosedToday(new Date(), { person: { key: "kyle", teamMemberId: kyleTm.id }, excludeClientIds: [fixture.id] });
    c.ok("…and the hub's own close is not in anybody's Done today", !closedToday.some((x) => x.id === n1.id));
    c.ok("actions, edit notes, today's shoot, a still-scheduled job and a flagged note are untouched", (await prisma.smartTask.findMany({ where: { id: { in: [n2.id, n3.id, n4.id, n5.id, n6.id] } } })).every((x) => x.status === "OPEN"));
    c.ok("a second pass finds nothing more", (await aging.expireShootNotes(new Date(), { apply: true })).closed === 0);
    const undo = await aging.undoExpiredShootNotes({ apply: true, actor: "drill" });
    const back = await prisma.smartTask.findUniqueOrThrow({ where: { id: n1.id } });
    c.ok("undo puts it back exactly as it was", undo.reopened === 1 && back.status === "OPEN" && back.summary === "Client wrote in.");

    // =====================================================================
    c.head("§12 · the screens render to HTML (phone-first markup, no nested links)");
    // =====================================================================
    const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
    // A link inside a link is invalid HTML and breaks taps on a phone.
    const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
    videoLanes = lanes;
    // James is the creative manager (TeamMember.creativeManager), as in production.
    await prisma.teamMember.update({ where: { id: jamesTm.id }, data: { creativeManager: true } });
    for (const [who, u] of [["Jordan", owner], ["Kyle", kyle], ["James", james]] as const) {
      await signIn(u);
      const html = ssr(await settle(await home({})));
      // Oct 23 2026: Jordan's monthly content is his Scripts & creative decisions section.
      c.ok(`${who}'s dashboard: Monthly content ${who === "Kyle" ? "is not on it" : "is on it"} (Oct 20 2026: Jordan's and the creative manager's)`, who === "Kyle" ? !html.includes("data-content-actions") : who === "Jordan" ? html.includes('data-section="creative"') : html.includes("data-content-actions"));
      // Oct 22 2026: the office's QC tile reads "Photos &amp; videos to send", and
      // its dashboard has no Shoots in progress card.
      // Oct 23 2026: Kyle's home is his desk (the five tabs and Do next).
      const words = who === "Kyle" ? ["Daily checks", "Review &amp; Deliver", "Client Communications", "Today&#x27;s Shoots", "Requests &amp; Follow-Ups"] : who === "Jordan" ? ["Financial Position", "Production health", "Bottlenecks requiring action", "Client issues", "Team coverage", "Meetings &amp; preparation", "Scripts &amp; creative decisions", "Email needing my reply", "Delegated by me", "Weekly performance"] : ["Shoots on time", "Clients waiting", "Special requests", "Photos &amp; videos to send", "Needs attention now"];
      c.ok(`${who}'s dashboard renders (tiles, needs attention, the list card; shoots in progress for the owner), no nested links, thumb-sized taps`, !html.startsWith("RENDER FAILED") && words.every((w) => html.includes(w)) && !nestedLink(html) && (html.match(/min-h-11/g) ?? []).length > (who === "Jordan" ? 8 : 5), `missing: ${words.filter((w) => !html.includes(w)).join(", ") || "none"} · nested ${nestedLink(html)} · taps ${(html.match(/min-h-11/g) ?? []).length}`);
      c.ok(`${who}'s dashboard: money only for the owner`, who === "Jordan" ? html.includes("MTD profit") && html.includes("Weekly performance") : !html.includes("Profit this month") && !html.includes("MTD profit") && !html.includes("This week") && !/\$\d/.test(html));
    }
    await signIn(kyle);
    const kyleHtml = ssr(await settle(await listPage({})));
    const kList = elements(await settle(await listPage({})), "DailyChecklist")[0]?.list as KyleChecklist;
    c.ok("Kyle's list renders (checklist, done today N, still open M)", !kyleHtml.startsWith("RENDER FAILED") && kyleHtml.includes("Your list") && kyleHtml.includes("s checklist") && kyleHtml.includes(`Done today (${kList.done.length})`) && kyleHtml.includes(`Still open (${kList.stillOpen.total})`) && kyleHtml.includes(`Show ${Math.max(0, kList.earlier.items.length - aging.EARLIER_SHOWN)} more`), kyleHtml.slice(0, 200));
    c.ok("…with no link nested in a link, buttons a thumb can hit, no figures", !nestedLink(kyleHtml) && (kyleHtml.match(/min-h-11/g) ?? []).length > 10 && !kyleHtml.includes("$750"));
    videoLanes = null;

    c.ok("nothing left the box but faked Slack posts; no client message queued", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://slack.com/api/")) && await prisma.outboxMessage.count() === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
