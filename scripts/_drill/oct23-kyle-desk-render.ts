// Oct 23 2026: KYLE'S DESK, RENDERED. The real "/" page server-rendered to
// HTML for Kyle, for the owner previewing Kyle ("view as", read-only), for
// the owner himself and for the creative manager: Kyle gets the desk (the
// status line, freshness, Do next, the five tabs with counts that match
// their lists, a side panel holding the existing actions), phone-first; the
// owner's and the creative manager's dashboards are unchanged. Disposable
// PGlite; the video board is driven; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { OfficeDesk as Desk } from "../../src/lib/officeDesk";

installNextStubs();
type Props = Record<string, unknown>;
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }) : null));

type Lanes = Record<"late" | "today" | "review" | "upcoming" | "sending" | "held" | "finishing" | "delivered", VideoRow[]>;
let videoLanes: Lanes | null = null;
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  const fake = (l: Lanes) => ({ asOf: new Date().toISOString(), lanes: l, counts: {}, mode: "live", connected: true }) as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>>;
  return {
    ...m,
    videoDeliveryBoard: (o?: Parameters<typeof m.videoDeliveryBoard>[0]) => (videoLanes ? Promise.resolve(fake(videoLanes)) : m.videoDeliveryBoard(o)),
    videoSummary: (now?: Date) => (videoLanes ? Promise.resolve({ readyToSend: videoLanes.sending.length, late: 0, dueToday: 0 }) : m.videoSummary(now)),
  };
});

function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function namesOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(namesOf);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [typeof type === "string" ? type : type.name ?? "", ...Object.values(tree.props).flatMap(namesOf)];
}
const STREAMED = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "OfficeDeskSection", "OwnerMoneyLine", "CaughtProblems"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5932), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-kyle-desk-render" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: home } = await import("@/app/page");
    const { OfficeDesk } = await import("@/components/desk/OfficeDesk");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);

    // ---- a small world ----
    const realC = await prisma.client.create({ data: { name: "Real Agent", phone: "2155550101" } });
    const alex = await prisma.client.create({ data: { name: "Alex Agent", phone: "2155550102" } });
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@render.invalid`, ...extra } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    const harrison = await tm("Harrison Shoots", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    const james = await user("James Livingston", jamesTm.email!, "ADMIN", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    const pReady = await prisma.project.create({ data: { clientId: realC.id, title: "11 Ready Rd, Town", status: "SHOT", shootDate: at(-D) } });
    const jReady = await prisma.photoJob.create({ data: { projectId: pReady.id, stage: "READY", slaDueAt: at(-H) } });
    const run = await prisma.photoQcRun.create({ data: { jobId: jReady.id, trigger: "INITIAL", status: "DONE", rulesVersion: "drill" } });
    await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: jReady.id, ruleId: "R1", groupKey: "g1", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Slight tilt in the bedroom", explanation: "x", severity: "MINOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT" } });
    await prisma.commLog.create({ data: { clientId: realC.id, clientName: realC.name, contactName: realC.name, channel: "text", source: "openphone", direction: "in", body: "Can you send the $1,200 invoice and the floor plan?", occurredAt: at(-30 * H), fromPhone: "2155550101" } });
    const pCliff = await prisma.project.create({ data: { clientId: alex.id, title: "615 Cliff Ln, Malvern", addressLine: "615 Cliff Ln", status: "EDITING", shootDate: at(3 * H), photographerId: harrison.id } });
    const brief = ["Customer:", "Name: Alex Agent", "Phone: (215) 555-0102", "Notes: n/a", "", "Order Questions:", "- Lock Box / Door Code: 4321", "- Special Instructions for the photographer (for this property only): Split appointment! Exteriors only."].join("\n");
    const raw = (items: string[]) => JSON.stringify({ items: items.map((title) => ({ title, is_canceled: false })) });
    await prisma.appointment.create({ data: { aryeoId: "r-cliff-1", projectId: pCliff.id, startAt: at(-10 * D), endAt: at(-10 * D + 2 * H), status: "SCHEDULED", description: brief, rawJson: raw(["Social Influencer"]), assignedToId: harrison.id } });
    const cliff2 = await prisma.appointment.create({ data: { aryeoId: "r-cliff-2", projectId: pCliff.id, startAt: at(3 * H), endAt: at(5 * H), status: "SCHEDULED", description: brief, rawJson: raw([]), assignedToId: harrison.id } });
    const pVideo = await prisma.project.create({ data: { clientId: realC.id, title: "20 Video Ave, Town", status: "REVIEW", shootDate: at(-3 * D) } });
    await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", title: "Apply $750 credit for 12 Oak St", dueAt: at(-3 * D) } });
    const vrow = { key: "v-send", submissionId: "sub-v-send", projectId: pVideo.id, street: "20 Video Ave", clientName: "Real Agent", label: "Listing video", round: 1, lane: "sending", stage: "Approved", cutStatus: "APPROVED", sinceISO: null, heldRender: null, promiseISO: at(D).toISOString(), promiseWords: "Tomorrow", late: false, dueToday: false, lateHours: null, approvedAtISO: at(-H).toISOString(), deliveredAtISO: null, deliveredBy: null, heldWhy: null, reviewHref: `/review/${pVideo.id}`, aryeoUrl: null, waitingSinceISO: null,
      push: { mode: "live", state: null, says: "Not started", tone: "info", handledByHub: false, waitingForKyle: false, canStart: true, progress: null, canRetry: false, canDeliverNow: false, canRelease: false, canHold: false, updatedAtISO: null },
      send: { approvedBy: "James Livingston", fileSource: "cut", fileName: "v1.mp4", fileSays: "the approved cut", downloadHref: "/x", watchHref: "/x", uploadFingerprint: null, uploaded: null, listingMissing: false, listingWarning: null, openAsks: [], asksUnknown: false, byHandWhy: null, pushUnknown: false } } as unknown as VideoRow;
    videoLanes = { late: [], today: [], review: [], upcoming: [], sending: [vrow], held: [], finishing: [], delivered: [] };
    void etAt; void etDayKey;

    // =====================================================================
    c.head("§1 · Kyle's dashboard is his desk");
    // =====================================================================
    await signIn(kyle);
    const kTree = await settle(await home({}));
    const kHtml = ssr(kTree);
    const kNames = namesOf(kTree);
    const kDesk = elements(kTree, "OfficeDesk")[0]?.desk as Desk | undefined;
    c.ok("Kyle's '/' renders the desk", !kHtml.startsWith("RENDER FAILED") && !!kDesk && kHtml.includes("data-office-desk") && kHtml.includes("data-status-line") && kHtml.includes("Do next"), kHtml.slice(0, 200));
    c.ok("the old cards are gone from HIS view (no banner beside a card, no tiles, no shoots card, no 'Kyle's day', no problems board)", ["BehindLine", "HealthStrip", "TodaysShoots", "NeedsAttention", "KylesDayCard", "KylesDaySection", "CaughtProblems", "ShootsInProgress", "OwnerBusiness"].every((n) => !kNames.includes(n)) && !kHtml.includes("done today by the office"), kNames.filter((n) => ["BehindLine", "HealthStrip", "NeedsAttention", "KylesDayCard", "CaughtProblems"].includes(n)).join());
    const tabCounts = [...kHtml.matchAll(/data-desk-tab="([a-z]+)" data-count="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    c.ok("#10 the five tabs show their counts, each the length of the list it opens", tabCounts.length === 5 && !!kDesk && tabCounts.every(([k, n]) => {
      const t = kDesk.tabs.find((x) => x.key === k)!;
      return n === String(t.count) && (k === "closeout" ? t.count === kDesk.closeout.lines.filter((l) => !l.done).length : t.count === t.now.length);
    }), JSON.stringify(tabCounts));
    c.ok("the date and freshness are on top; a failed or missing sync is said in words", kHtml.includes("data-freshness") && /data-fresh="aryeo" data-state="unknown"/.test(kHtml) && kHtml.includes("no sync recorded"));
    c.ok("Do next: each line has a reason, a due time and one button that opens the side panel (no navigation)", !!kDesk && kDesk.doNext.length >= 1 && kDesk.doNext.length <= 5 && kDesk.doNext.every((i) => kHtml.includes(`data-open-panel="${i.id}"`)) && !/<a[^>]*data-open-panel/.test(kHtml));
    c.ok("no figures for Kyle anywhere on the page", !/\$\d/.test(kHtml), (kHtml.match(/.{40}\$\d.{40}/) ?? [""])[0]);
    c.ok("no em dashes in the desk", !/—/.test(kHtml.slice(kHtml.indexOf("data-office-desk"))));
    c.ok("phone-first: the tabs are one scrollable strip, taps are thumb-sized, no link inside a link", /role="tablist"[^>]*class="[^"]*overflow-x-auto/.test(kHtml) && (kHtml.match(/min-h-11/g) ?? []).length >= 8 && !nestedLink(kHtml));
    c.ok("no checkboxes outside the closeout list (no reviewer checklists)", !/type="checkbox"/.test(kHtml));
    c.ok("the desk is not read-only for Kyle himself", kHtml.includes('data-readonly="false"') && !kHtml.includes("Preview: read-only"));

    // =====================================================================
    c.head("§2 · the side panel (#11: the routine work, on the page)");
    // =====================================================================
    const panel = (desk: Desk, open: string, tab?: string) => ssr(createElement(OfficeDesk, { desk, initialOpen: open, initialTab: tab as never }));
    const jobHtml = panel(kDesk!, `job:${pReady.id}`);
    c.ok("a photo job opens in the panel: each asset's status, what the free check found (context), and Approve and deliver / upload", jobHtml.includes(`data-side-panel="job:${pReady.id}"`) && jobHtml.includes("Ready for your review") && jobHtml.includes("What the free photo check found") && jobHtml.includes("Slight tilt in the bedroom") && jobHtml.includes("Approve and deliver") && jobHtml.includes("Approve and upload"), jobHtml.slice(jobHtml.indexOf("data-side-panel"), jobHtml.indexOf("data-side-panel") + 400));
    c.ok("…no checklist inside review", !/type="checkbox"/.test(jobHtml.slice(jobHtml.indexOf("data-side-panel"))));
    const videoHtml = panel(kDesk!, `job:${pVideo.id}`);
    c.ok("an approved video: 'Approved by James Livingston', and Kyle's control is the send, never an approval", videoHtml.includes("Approved by James Livingston, ready to send") && videoHtml.includes("Upload to Aryeo and send") && !/>\s*Approve( it)?\s*</.test(videoHtml) && !videoHtml.includes("Send back"));
    const reply = kDesk!.tabs.find((t) => t.key === "replies")!.now[0];
    const replyHtml = panel(kDesk!, reply.id);
    c.ok("a client conversation: the messages, a text box (Messages' own send), Open in Messages, and the dismiss", !!reply && replyHtml.includes("Text back") && replyHtml.includes("Open in Messages") && replyHtml.includes("[amount] invoice") && !replyHtml.includes("$1,200"), reply?.id);
    const visitHtml = panel(kDesk!, `visit:${cliff2.id}`);
    c.ok("a visit: this visit only; the split order flagged; older notes and the other visit folded", visitHtml.includes("data-conflicts") && visitHtml.includes("cover all 2 visits") && visitHtml.includes("Other visits and older notes") && visitHtml.includes("No services listed for this visit") && visitHtml.includes("Photographer brief switched off"));
    const taskItem = kDesk!.tabs.find((t) => t.key === "followups")!.now.find((i) => i.title.startsWith("Apply"))!;
    const taskHtml = panel(kDesk!, taskItem.id);
    c.ok("a task: Done / Not needed / New date, and 'Waiting on someone' (James for creative, Jordan for business)", taskHtml.includes("Not needed") && taskHtml.includes("New date") && taskHtml.includes("Waiting on someone") && taskHtml.includes("James: a creative question") && taskHtml.includes("Jordan: a business or policy question"));
    const goneHtml = panel(kDesk!, "job:does-not-exist");
    c.ok("an item that left the list after an action says so in the panel (the page stays)", goneHtml.includes("it has left the list"));
    const closeHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialTab: "closeout" }));
    c.ok("Closeout: the five checks (manual ones are checkboxes), Finish the day held until they are done, and the day's summary", ["Communications reviewed", "Due deliveries done, or exceptions noted", "Every promise has an owner and a follow-up", "Next business day prepared", "Blockers escalated"].every((w) => closeHtml.includes(w)) && /type="checkbox"/.test(closeHtml) && /data-control="finish-day"[^>]*disabled|disabled[^>]*data-control="finish-day"/.test(closeHtml) && closeHtml.includes("You completed") && closeHtml.includes("Still pending") && closeHtml.includes("Next business day"));

    // =====================================================================
    c.head("§3 · the owner's 'view as Kyle' is read-only");
    // =====================================================================
    await signIn(owner, kyle.id);
    const vTree = await settle(await home({}));
    const vHtml = ssr(vTree);
    const vDesk = elements(vTree, "OfficeDesk")[0]?.desk as Desk | undefined;
    c.ok("previewing Kyle shows his desk, marked read-only", !!vDesk && vDesk.readOnly && vHtml.includes('data-readonly="true"') && vHtml.includes("Preview: read-only"));
    const vPanel = panel(vDesk!, `job:${pReady.id}`);
    c.ok("…and its panel offers no actions", vPanel.includes("Actions are off") && !vPanel.includes("Approve and deliver"));

    // =====================================================================
    c.head("§4 · the owner's and the creative manager's homes are unchanged");
    // =====================================================================
    await signIn(owner);
    const oTree = await settle(await home({}));
    const oNames = namesOf(oTree);
    c.ok("the owner keeps his dashboard (tiles, needs attention, Kyle's day, the problems board, money), no desk", ["HealthStrip", "NeedsAttention", "KylesDayCard"].every((n) => oNames.includes(n)) && !oNames.includes("OfficeDesk"), oNames.filter((n) => /Health|Needs|Kyles|Office|Caught/.test(n)).join());
    await signIn(james);
    const jTree = await settle(await home({}));
    const jNames = namesOf(jTree);
    c.ok("the creative manager keeps his dashboard, no desk", jNames.includes("HealthStrip") && !jNames.includes("OfficeDesk"));

    c.ok("nothing left the box; nothing written by rendering", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0 && await prisma.appSetting.count({ where: { key: { startsWith: "office_" } } }) === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
