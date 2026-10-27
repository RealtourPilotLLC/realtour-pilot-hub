// Oct 23 2026: KYLE'S DESK, RENDERED. The real "/" page server-rendered to
// HTML for Kyle, for the owner previewing Kyle ("view as", read-only), for
// the owner himself and for the creative manager: Kyle gets the desk (the
// status line, freshness, Do next, the five tabs with counts that match
// their lists, a side panel holding the existing actions), phone-first; the
// owner's and the creative manager's dashboards are unchanged. Revision 2
// (Jordan's mockup): the Daily checks, then four sections all visible. Disposable
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
    const { AddTaskButton } = await import("@/components/desk/DeskControls");
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
    await prisma.cronRun.create({ data: { job: "gmail", startedAt: at(-2 * 60_000), finishedAt: at(-60_000), ok: true, summary: JSON.stringify({ ms: { gmail: 100 } }) } });
    const erica = await prisma.client.create({ data: { name: "Erica Walker", phone: "2155550111" } });
    await prisma.smartTask.create({ data: { taskType: "program_message", source: "content_program", status: "OPEN", title: "Reply to Erica Walker's message", description: "A message is waiting.\n\n• Erica Walker: Can we swap the November topic?", dedupeKey: "program-message:enr-render", assignedKey: "kyle", clientId: erica.id, dueAt: at(5 * H) } });
    await prisma.programMessage.create({ data: { enrollmentId: "enr-render", clientId: erica.id, authorKind: "CLIENT", authorLabel: "Erica Walker", body: "Can we swap the November topic?", createdAt: at(-H) } });

    // =====================================================================
    c.head("§1 · Kyle's dashboard (revision 3): the Daily checks, four sections, the next business day, the closeout, completed today");
    // =====================================================================
    // Enough of Kyle's own tasks due today that a section has more rows than it shows.
    for (const n of [1, 2, 3, 4]) await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", title: `Due-today chore ${n}`, dueAt: etAt(etDayKey(T), 0, 5) } });
    await signIn(kyle);
    const kTree = await settle(await home({}));
    const kHtml = ssr(kTree);
    const kNames = namesOf(kTree);
    const kDesk = elements(kTree, "OfficeDesk")[0]?.desk as Desk | undefined;
    c.ok("Kyle's '/' renders the desk: Daily checks and the four sections, in the mockup's order", !kHtml.startsWith("RENDER FAILED") && !!kDesk && kHtml.includes("data-office-desk") && kHtml.includes("Daily checks") && ["Morning review", "Midday review", "End-of-day review"].every((w) => kHtml.includes(w))
      && /Review &amp; Deliver[\s\S]*Client Communications[\s\S]*Today&#x27;s Shoots[\s\S]*Requests &amp; Follow-Ups/.test(kHtml), kHtml.slice(0, 200));
    c.ok("the header: the greeting, 'Keep shoots prepared, clients informed, and media delivered.' and + Add task", kHtml.includes("Keep shoots prepared, clients informed, and media delivered.") && kHtml.includes("data-add-task") && />\s*Add task\s*</.test(kHtml.replace(/<svg[\s\S]*?<\/svg>/g, "")));
    c.ok("each daily check says where it stands under its label", (kHtml.match(/data-check-state/g) ?? []).length === 3 && kHtml.includes("Not yet completed"));
    c.ok("the new cards: Next business day (with Prepare), End-of-day closeout (Review & finish day), Completed today (logged automatically)", kHtml.includes(`Next business day · ${kDesk!.nextDay.dayName}`) && kHtml.includes(`Prepare ${kDesk!.nextDay.dayName}`) && kHtml.includes("Current visit instructions only") && kHtml.includes("End-of-day closeout") && kHtml.includes("Review &amp; finish day") && kHtml.includes("Completed today") && kHtml.includes("Completed actions are logged automatically."));
    c.ok("…the Next business day card spans the grid's width; the closeout and Completed today sit side by side", /data-desk-card="next-day"[^>]*lg:col-span-2|lg:col-span-2[^"]*"[^>]*data-desk-card="next-day"/.test(kHtml) || /id="next-day"[^>]*class="[^"]*lg:col-span-2/.test(kHtml));
    c.ok("no Do next list, no paragraph of counts, no tabs", !kHtml.includes("Do next") && !kHtml.includes("data-status-line") && !kHtml.includes('role="tablist"') && !/items? need you, \d+ late/.test(kHtml));
    c.ok("the old cards are gone from HIS view (no banner beside a card, no tiles, no shoots card, no 'Kyle's day', no problems board)", ["BehindLine", "HealthStrip", "TodaysShoots", "NeedsAttention", "KylesDayCard", "KylesDaySection", "CaughtProblems", "ShootsInProgress", "OwnerBusiness"].every((n) => !kNames.includes(n)) && !kHtml.includes("done today by the office"), kNames.filter((n) => ["BehindLine", "HealthStrip", "NeedsAttention", "KylesDayCard", "CaughtProblems"].includes(n)).join());
    c.ok("a wide two-column grid on a desktop, one column on a phone", /data-desk-grid[^>]*class="[^"]*grid[^"]*lg:grid-cols-2/.test(kHtml) || /class="[^"]*grid[^"]*lg:grid-cols-2[^"]*"[^>]*data-desk-grid/.test(kHtml));
    const sectionCounts = [...kHtml.matchAll(/data-desk-section="([a-z]+)" data-count="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    c.ok("#10 each section's count is the length of its rows, and its subtitle says that number", sectionCounts.length === 4 && !!kDesk && sectionCounts.every(([k, n]) => {
      const s = kDesk.sections.find((x) => x.key === k)!;
      return n === String(s.count) && s.count === s.now.length;
    }) && kHtml.includes(`${kDesk!.sections.find((s) => s.key === "comms")!.count} client`) && kHtml.includes(`${kDesk!.sections.find((s) => s.key === "followups")!.count} follow-ups due`), JSON.stringify(sectionCounts));
    const fu = kDesk!.sections.find((s) => s.key === "followups")!;
    c.ok("a few rows per section, 'View all N' for the rest", fu.now.length > 4 && (kHtml.match(/data-desk-item=/g) ?? []).length >= 4 && kHtml.includes(`View all ${fu.now.length}`));
    c.ok("each section has a clear empty state when nothing is there (no thumbnails of nothing)", kHtml.includes("data-empty") || kDesk!.sections.every((s) => s.now.length > 0));
    c.ok("freshness says only what is wrong, in words (a missing sync), never a zero", kHtml.includes("data-freshness") && /data-fresh="aryeo" data-state="unknown"/.test(kHtml) && kHtml.includes("no sync recorded"));
    // Oct 27 2026: three rows a card (the mockup), was four.
    c.ok("each row's one button opens the side panel (no navigation)", !!kDesk && kDesk.sections.flatMap((s) => s.now.filter((i) => i.section !== "shoots" || i.day === "today").slice(0, 3)).every((i) => kHtml.includes(`data-open-panel="${i.id}"`)) && !/<a[^>]*data-open-panel/.test(kHtml));
    c.ok("Review & Deliver groups photos, floor plans & tours apart from approved videos; the photo row carries its thumbnail", kHtml.includes("Photos, floor plans &amp; tours") && kHtml.includes("Approved videos") && kHtml.includes("Approved by James, ready to send"));
    c.ok("Client Communications: initials, channel and business time, the summary, Reply", kHtml.includes(">RA<") && /Text · (\d+ min|[0-9.]+ business (hours?|days?))/.test(kHtml) && kHtml.includes("[amount] invoice") && kHtml.includes(">Reply<") && kHtml.includes("Create follow-up") && kHtml.includes("Other conversations are up to date.") && kHtml.includes("Content Program"), (kHtml.match(/Text · [^<]{0,30}/) ?? [""])[0]);
    c.ok("Today's Shoots: the Today / Next business day switch, View schedule", kHtml.includes('data-day="today"') && kHtml.includes('data-day="next"') && kHtml.includes("View schedule"));
    c.ok("no figures for Kyle anywhere on the page", !/\$\d/.test(kHtml), (kHtml.match(/.{40}\$\d.{40}/) ?? [""])[0]);
    c.ok("no em dashes in the desk", !/—/.test(kHtml.slice(kHtml.indexOf("data-office-desk"))));
    c.ok("phone-first: thumb-sized taps, no link inside a link", (kHtml.match(/min-h-11/g) ?? []).length >= 8 && !nestedLink(kHtml));
    const eodManual = kDesk!.checks.groups.find((g) => g.key === "eod")!.lines.filter((l) => l.manual && l.auto !== true).length;
    c.ok("checkboxes only for the closeout's own manual reviews (never inside review)", (kHtml.match(/type="checkbox"/g) ?? []).length === eodManual && eodManual >= 1);
    c.ok("the desk is not read-only for Kyle himself", kHtml.includes('data-readonly="false"') && !kHtml.includes("Preview: read-only"));

    // =====================================================================
    c.head("§2 · the side panel (#11: the routine work, on the page)");
    // =====================================================================
    const panel = (desk: Desk, open: string) => ssr(createElement(OfficeDesk, { desk, initialOpen: open }));
    const jobHtml = panel(kDesk!, `media:${pReady.id}`);
    c.ok("a photo job opens in the panel: each asset's status, what the free check found (context), and Approve and deliver / upload", jobHtml.includes(`data-side-panel="media:${pReady.id}"`) && jobHtml.includes("Photos ready") && jobHtml.includes("What the free photo check found") && jobHtml.includes("Slight tilt in the bedroom") && jobHtml.includes("Approve and deliver") && jobHtml.includes("Approve and upload"), jobHtml.slice(jobHtml.indexOf("data-side-panel"), jobHtml.indexOf("data-side-panel") + 400));
    c.ok("…no checklist inside review", !/type="checkbox"/.test(jobHtml.slice(jobHtml.indexOf("data-side-panel"))));
    const videoHtml = panel(kDesk!, `video:${pVideo.id}`);
    c.ok("an approved video: 'Approved by James', Upload to Aryeo and send or Upload to Aryeo only, never an approval", videoHtml.includes("Approved by James, ready to send") && videoHtml.includes("Upload to Aryeo and send") && videoHtml.includes("Upload to Aryeo only") && !/>\s*Approve( it)?\s*</.test(videoHtml) && !videoHtml.includes("Send back"));
    const reply = kDesk!.sections.find((t) => t.key === "comms")!.now.find((i) => i.id.startsWith("reply:"))!;
    const replyHtml = panel(kDesk!, reply.id);
    c.ok("a client conversation: the messages, a text box (Messages' own send), Open in Messages, the dismiss, and Create a follow-up", !!reply && replyHtml.includes("Text back") && replyHtml.includes("Open in Messages") && replyHtml.includes("Create a follow-up") && replyHtml.includes("[amount] invoice") && !replyHtml.includes("$1,200"), reply?.id);
    const visitHtml = panel(kDesk!, `visit:${cliff2.id}`);
    c.ok("a visit: this visit only; the split order flagged; older notes and the other visit folded; the brief's state", visitHtml.includes("data-conflicts") && visitHtml.includes("cover all 2 visits") && visitHtml.includes("Other visits and older notes") && visitHtml.includes("No services listed for this visit") && visitHtml.includes("Brief switched off"));
    const taskItem = kDesk!.sections.find((t) => t.key === "followups")!.now.find((i) => i.title.startsWith("Apply"))!;
    const taskHtml = panel(kDesk!, taskItem.id);
    c.ok("a task: Done / Not needed / New date, and 'Waiting on someone' (James for creative, Jordan for business)", taskHtml.includes("Not needed") && taskHtml.includes("New date") && taskHtml.includes("Waiting on someone") && taskHtml.includes("James: a creative question") && taskHtml.includes("Jordan: a business or policy question"));
    const goneHtml = panel(kDesk!, "media:does-not-exist");
    c.ok("an item that left the list after an action says so in the panel (the page stays)", goneHtml.includes("it has left the list"));
    const eodHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialOpen: "special:finish" }));
    const finishPanel = eodHtml.slice(eodHtml.indexOf('data-side-panel="special:finish"'));
    c.ok("Review & finish day opens the closeout's checks, Finish the day held until they are done, and the day's summary", ["Client messages reviewed", "Due deliveries completed or exceptions noted", "Open requests have owners and follow-up times", "Next business day prepared"].every((w) => finishPanel.includes(w)) && /data-control="finish-day"[^>]*disabled|disabled[^>]*data-control="finish-day"/.test(finishPanel) && finishPanel.includes("You completed") && finishPanel.includes("Still open"));
    const prepHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialOpen: "special:prepare" }));
    const prepPanel = prepHtml.slice(prepHtml.indexOf('data-side-panel="special:prepare"'));
    c.ok("Prepare <Day> lists what is missing for the next business day, or says it is ready", prepPanel.includes(`Prepare ${kDesk!.nextDay.dayName}`) && (kDesk!.nextDay.missing.length ? kDesk!.nextDay.missing.every((m) => prepPanel.includes(`data-missing="${m.visitId}"`)) : prepPanel.includes("is ready") || prepPanel.includes("No shoots on")));
    const withBrief = { ...kDesk!, briefsPending: [{ visitId: `visit:${cliff2.id}`, day: "today" as const, street: "615 Cliff Ln", timeISO: at(3 * H).toISOString(), photographer: "Harrison Shoots", teamMemberId: harrison.id, dayKey: etDayKey(at(3 * H)), phone: "2155550199", state: "sent" as const }] };
    const briefsHtml = ssr(createElement(OfficeDesk, { desk: withBrief, initialOpen: "special:briefs" }));
    c.ok("Photographer briefs: Follow up resends the brief (Resend, since one went) or texts the photographer", briefsHtml.includes("Resend Harrison the brief") && briefsHtml.includes("Text back") && briefsHtml.includes("no Got it yet"));
    const progItem = kDesk!.sections.find((t) => t.key === "comms")!.now.find((i) => i.id.startsWith("program:"))!;
    const progHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialOpen: progItem?.id ?? "x", initialDrafts: { [progItem?.id ?? "x"]: "Yes, we can swap it. I will update the plan today." } }));
    c.ok("a Content Program message opens with its draft ready to send as is (or edit), on the program's own reply", !!progItem && progHtml.includes("Reply on Content Program") && progHtml.includes("Yes, we can swap it. I will update the plan today.") && progHtml.includes('data-mode="program"') && progHtml.includes("Can we swap the November topic?"));
    const draftHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialOpen: reply.id, initialDrafts: { [reply.id]: "Sending the invoice and floor plan now." } }));
    c.ok("a text conversation opens with the reply engine's draft in the box, Send and New draft beside it", draftHtml.includes("Sending the invoice and floor plan now.") && draftHtml.includes('data-mode="text"') && draftHtml.includes("New draft"));
    const followHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialOpen: reply.id }));
    c.ok("…and the panel offers Create a follow-up beside the reply", followHtml.includes("Create a follow-up"));
    const addHtml = ssr(createElement(AddTaskButton, { people: [{ key: "kyle", name: "Kyle Smith" }, { key: "james", name: "James Livingston" }], me: "kyle", initialOpen: true }));
    c.ok("+ Add task: for Kyle himself (his tasks) or someone else (assigned through delegation)", addHtml.includes("Me (Kyle Smith)") && addHtml.includes("James Livingston") && addHtml.includes("Add to my tasks"));
    const nextHtml = ssr(createElement(OfficeDesk, { desk: kDesk!, initialDay: "next" }));
    const shootRows = kDesk!.sections.find((s) => s.key === "shoots")!;
    const visits = [...shootRows.now, ...shootRows.waiting, ...shootRows.ok];
    c.ok("the Next business day view lists only that day's visits", nextHtml.includes("next business day") && visits.filter((v) => v.day === "next").every((v) => nextHtml.includes(`data-desk-item="${v.id}"`)) && visits.filter((v) => v.day === "today").every((v) => !nextHtml.includes(`data-desk-item="${v.id}"`)));

    // =====================================================================
    c.head("§3 · the owner's 'view as Kyle' is read-only");
    // =====================================================================
    await signIn(owner, kyle.id);
    const vTree = await settle(await home({}));
    const vHtml = ssr(vTree);
    const vDesk = elements(vTree, "OfficeDesk")[0]?.desk as Desk | undefined;
    c.ok("previewing Kyle shows his desk, marked read-only", !!vDesk && vDesk.readOnly && vHtml.includes('data-readonly="true"') && vHtml.includes("Preview: read-only"));
    const vPanel = panel(vDesk!, `media:${pReady.id}`);
    c.ok("…and its panel offers no actions", vPanel.includes("Actions are off") && !vPanel.includes("Approve and deliver"));

    // =====================================================================
    c.head("§4 · the owner's and the creative manager's homes are unchanged");
    // =====================================================================
    await signIn(owner);
    const oTree = await settle(await home({}));
    const oNames = namesOf(oTree);
    // Oct 23 2026: the owner's home is his own dashboard now (components/owner/
    // OwnerHome, held by oct23-owner-dashboard-render); what matters here is
    // that it is not Kyle's desk.
    c.ok("the owner keeps his own dashboard, no desk", oNames.includes("OwnerHome") && !oNames.includes("OfficeDesk"), oNames.filter((n) => /Owner|Office/.test(n)).join());
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
