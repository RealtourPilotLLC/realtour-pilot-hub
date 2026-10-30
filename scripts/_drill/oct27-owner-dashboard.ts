// Oct 27 2026: JORDAN'S DASHBOARD, every row with its action. Jordan, on the
// live page: "make sure everything has an action that can resolve it,
// escalate it, respond, or delegate", and to match his mockup more closely.
// Held here, through the libs and the real "/" page rendered as Jordan:
//   1  Financial Position is a compact strip of five figures; the rail table
//      and Stripe fold under a closed Details; the freshness line stays out.
//   2  Bottlenecks carry the right button per issue (a late edit: Request
//      update to the creative manager + Reassign on the job's Team section;
//      a missing upload: Remind photographer; no editor: Assign editor;
//      listing scripts: Review scripts), the owner is the real person (never
//      "The editor"), and a press is one keyed task (a second press is the
//      same task; once given, the row says who has it and nudges them).
//   3  Scripts & creative decisions drops stale months (Rick Schultz's
//      August "4 scripts to approve" in late October) and filmed scripts,
//      and lists Script Studio's nudges for Jordan with Done.
//   4  Team coverage and Delegated by me: a button on every row; Follow up
//      nudges the delegate.
//   5  Weekly performance: four headline tiles; the revision rate is a share
//      of jobs (never "7 / 2 (350%)"); too few reads "Not enough data".
//   6  Paired cards stretch to the same height; one column on a phone.
// The production boards are driven through their contracts (jobsBoard,
// videoDeliveryBoard, getReviewQueue, the exceptions board); the content
// program (the shared card's month rows, owners, scripts) is real. Disposable PGlite;
// Slack is a fake; nothing leaves; nothing is sent by a render.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { JobRow } from "../../src/lib/jobsBoard";
import type { Bottleneck } from "../../src/lib/ownerDashboard";
import type { PanelSpec } from "../../src/components/owner/panelTypes";

installNextStubs();
type Props = Record<string, unknown>;
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? (url.includes("conversations.open") ? json({ ok: true, channel: { id: "D-DRILL" } }) : json({ ok: true, ts: "1" })) : null));

// ---- the production boards, through their contracts ----
let jobRows: JobRow[] = [];
let videoLanes: Record<string, VideoRow[]> | null = null;
let reviewPending: unknown[] = [];
let exceptionRows: unknown[] = [];
const OWNER_EMAIL = "info@realtourpilot.com";
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: async () => ({ rows: jobRows, counts: { total: jobRows.length, late: jobRows.filter((j) => j.late).length, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } }) };
});
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return {
    ...m,
    videoDeliveryBoard: async () => ({ asOf: new Date().toISOString(), lanes: videoLanes ?? {}, counts: {}, mode: "live", connected: true, unavailable: !videoLanes }),
    videoSummary: async () => ({ readyToSend: 0, late: 0, dueToday: 0 }),
  };
});
interceptModule((r) => r === "@/lib/reviewRoom" || /src[\\/]lib[\\/]reviewRoom(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...m, getReviewQueue: async () => ({ pending: reviewPending, waitingOnCheck: [], waitingOnEditor: [], recentlyApproved: [], followUps: [] }) };
});
interceptModule((r) => r === "@/lib/opsExceptions" || /src[\\/]lib[\\/]opsExceptions(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/opsExceptions");
  return { ...m, opsExceptionsBoard: async () => ({ ...m.emptyExceptionBoard(), rows: exceptionRows }) };
});
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
const STREAMED = new Set([
  "OwnerHome", "FinanceSection", "ProductionSection", "ClientIssuesSection", "TeamSection", "MeetingsSection", "CreativeSection", "EmailSectionView", "DelegatedSection", "WeeklySection", "TaskOpen",
  "OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "OfficeDeskSection", "OwnerMoneyLine", "CaughtProblems",
]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
const nestedButton = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)button\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
/** The markup of one element, from its marker to its closing tag (same-tag nesting counted). */
function sliceOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return "";
  const open = html.lastIndexOf("<", at);
  const tag = /^<([a-z]+)/.exec(html.slice(open))?.[1] ?? "div";
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";

const H = 3_600_000;
const D = 24 * H;
const prevMonth = (k: string) => { const [y, m] = k.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5944), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-owner-dashboard" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const od = await import("@/lib/ownerDashboard");
    const ow = await import("@/lib/ownerWork");
    const A = await import("@/app/delegation/actions");
    const { setSmartTaskStatus } = await import("@/app/actions");
    const { default: home } = await import("@/app/page");
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const { etMonthKey } = await import("@/lib/datetime");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const T = new Date();

    // ---- the team ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@oct27.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true, slackId: "UKYLE" });
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true, slackId: "UJAMES" });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER", { slackId: "UHARRISON" });
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", OWNER_EMAIL, "OWNER", jordanTm.id);
    await user("Kyle Smith", "kyle@oct27.invalid", "ADMIN", kyleTm.id);
    await user("James Livingston", "james@oct27.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await signIn(owner);
    const client = await prisma.client.create({ data: { name: "Real Agent", email: "agent@client.example", phone: "2155550101" } });

    // ---- production: one of each problem ----
    const p = (title: string, extra: Record<string, unknown> = {}) => prisma.project.create({ data: { clientId: client.id, title, status: "EDITING", ...extra } });
    const pNoShooter = await p("10 Shoot Ave, Town", { status: "SCHEDULED" });
    await prisma.appointment.create({ data: { aryeoId: "ap-27-1", projectId: pNoShooter.id, startAt: new Date(T.getTime() + 3 * H), endAt: new Date(T.getTime() + 5 * H), status: "SCHEDULED" } });
    const pRaw = await p("20 Raw St, Town", { shootDate: new Date(T.getTime() - D), photographerId: harrisonTm.id });
    const pRawNobody = await p("21 Lost Card Ln, Town", { shootDate: new Date(T.getTime() - D) });
    const pLateJohn = await p("30 Late Rd, Town");
    const pLateCard = await p("31 Card Ct, Town");
    const pLateNobody = await p("32 Quiet Way, Town");
    const pReview = await p("40 Review Way, Town");
    const pSend = await p("50 Send Blvd, Town");
    const pNoEditor = await p("60 Nobody Ln, Town");
    const pPhotos = await p("70 Photo Pl, Town");
    await prisma.photoJob.create({ data: { projectId: pPhotos.id, stage: "EDITING", slaDueAt: new Date(T.getTime() - 2 * H) } });
    // The outside edit card names the editor when the board's chip can't.
    await prisma.smartTask.create({ data: { taskType: "edit_video", source: "system", status: "OPEN", title: "Edit the listing video", projectId: pLateCard.id, assignedKey: "john" } });
    const job = (pid: string, street: string, extra: Partial<JobRow>): JobRow => ({ projectId: pid, street, client: "Real Agent", dueISO: new Date(T.getTime() - 2 * H).toISOString(), dueWords: "late", late: true, dueToday: false, photos: null, video: null, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, href: `/projects/${pid}`, ...extra });
    jobRows = [
      job(pRaw.id, "20 Raw St", { photos: { label: "Not uploaded", tone: "waiting" } as JobRow["photos"] }),
      job(pRawNobody.id, "21 Lost Card Ln", { photos: { label: "Not uploaded", tone: "waiting" } as JobRow["photos"] }),
      job(pLateJohn.id, "30 Late Rd", { video: { label: "Changes · Jhon", tone: "late" } as JobRow["video"] }),
    ];
    const vrow = (o: Partial<VideoRow> & { key: string; projectId: string; street: string; lane: VideoRow["lane"] }) => ({ submissionId: null, clientName: "Real Agent", label: "Listing video", round: 2, stage: "Editing", cutStatus: null, sinceISO: new Date(T.getTime() - 40 * H).toISOString(), promiseISO: null, promiseWords: "", late: false, dueToday: false, lateHours: null, approvedAtISO: null, deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, reviewHref: null, aryeoUrl: null, waitingSinceISO: null, send: null, heldRender: null, ...o }) as VideoRow;
    const lateBy = (h: number) => ({ promiseISO: new Date(T.getTime() - h * H).toISOString(), late: true, lateHours: h });
    videoLanes = {
      late: [
        vrow({ key: "v-john", projectId: pLateJohn.id, street: "30 Late Rd", lane: "late", cutStatus: "CHANGES_REQUESTED", ...lateBy(30) }),
        vrow({ key: "v-card", projectId: pLateCard.id, street: "31 Card Ct", lane: "late", ...lateBy(20) }),
        vrow({ key: "v-nobody", projectId: pLateNobody.id, street: "32 Quiet Way", lane: "late", ...lateBy(10) }),
      ],
      today: [], upcoming: [], held: [], finishing: [], delivered: [],
      review: [vrow({ key: "v-review", projectId: pReview.id, street: "40 Review Way", lane: "review", cutStatus: "PENDING", ...lateBy(4) })],
      sending: [vrow({ key: "v-send", projectId: pSend.id, street: "50 Send Blvd", lane: "sending", cutStatus: "APPROVED", approvedAtISO: new Date(T.getTime() - 9 * H).toISOString(), waitingSinceISO: new Date(T.getTime() - 9 * H).toISOString(), ...lateBy(6) })],
    };
    reviewPending = [{ id: "cut-27", projectId: pReview.id, street: "40 Review Way", clientName: "Real Agent", round: 1, fileName: "v1.mp4", editorName: "Jhon Mark", createdAt: new Date(T.getTime() - 26 * H).toISOString(), reviewer: { id: jamesTm.id, name: "James Livingston" } }];
    exceptionRows = [{ id: "ex-27", kind: "unassigned", severity: "high", title: "60 Nobody Ln", why: "A video is owed and no editor holds it", owner: "Kyle", nextAction: "Assign an editor", href: `/projects/${pNoEditor.id}`, ageDays: 2 }];
    // A premium reel shooting within the day with no script: Jordan's listing script.
    const premium = (pid: string) => prisma.deliverable.create({ data: { projectId: pid, type: "SOCIAL_REEL", label: "Premium Social Media Reel", productTitle: "Social Influencer", videoStyle: "premium_social_reel" } as never });
    const pScript = await p("80 Script St, Town", { status: "SCHEDULED", shootDate: new Date(T.getTime() + 20 * H) });
    await premium(pScript.id);

    // =====================================================================
    c.head("§2 · Bottlenecks: the right button per issue, the real person (Jordan's mockup)");
    // =====================================================================
    let h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    const b = (pid: string, stage?: string) => h.bottlenecks.find((x) => x.assign.projectId === pid && (!stage || x.id.startsWith(`${stage}:`)));
    const labels = (x: Bottleneck | undefined) => (x?.actions ?? []).map((a) => a.label).join("|");
    const ask = (x: Bottleneck | undefined) => x?.actions.find((a) => a.kind === "ask") as Extract<Bottleneck["actions"][number], { kind: "ask" }> | undefined;
    const link = (x: Bottleneck | undefined, label: string) => (x?.actions.find((a) => a.kind === "link" && a.label === label) as { href: string } | undefined)?.href;
    const john = b(pLateJohn.id, "editing");
    c.ok("a late edit: Request update (to James, the creative manager, for a recovery plan) and Reassign (the job's Team section)", labels(john) === "Request update|Reassign" && ask(john)?.seed.assigneeKey === "james" && link(john, "Reassign") === `/projects/${pLateJohn.id}#team` && john?.nextStep === "Recovery plan and new ETA", `${labels(john)} · ${ask(john)?.seed.assigneeKey} · ${link(john, "Reassign")}`);
    c.ok("…the owner is the editor by name (the board's chip): Jhon", john?.owner === "Jhon", john?.owner);
    c.ok("…no chip, but an open edit card: the editor it names (Jhon), never 'The editor'", b(pLateCard.id, "editing")?.owner === "Jhon", b(pLateCard.id, "editing")?.owner);
    c.ok("…nobody named at all: the creative manager answers for it (James), never 'The editor'", b(pLateNobody.id, "editing")?.owner === "James", b(pLateNobody.id, "editing")?.owner);
    const raw = b(pRaw.id, "capture");
    c.ok("a missing upload: Remind photographer, to Harrison (his job), owner Harrison", labels(raw) === "Remind photographer" && ask(raw)?.seed.assigneeKey === "harrison" && raw?.owner === "Harrison" && /Upload the photos: 20 Raw St/.test(ask(raw)?.seed.title ?? ""), `${labels(raw)} · ${raw?.owner} · ${ask(raw)?.seed.assigneeKey}`);
    const rawNobody = b(pRawNobody.id, "capture");
    c.ok("…no photographer on the job: the office (Kyle) is asked, the row says Request update, never 'The photographer'", labels(rawNobody) === "Request update" && ask(rawNobody)?.seed.assigneeKey === "kyle" && rawNobody?.owner === "Kyle", `${labels(rawNobody)} · ${rawNobody?.owner}`);
    const noEd = b(pNoEditor.id, "editing");
    c.ok("no editor: Assign editor (the job's Team section) and Delegate (to the office)", labels(noEd) === "Assign editor|Delegate" && link(noEd, "Assign editor") === `/projects/${pNoEditor.id}#team` && (noEd?.actions[1] as { seed?: { assigneeKey?: string } }).seed?.assigneeKey === "kyle" && noEd?.nextStep === "Assign an editor", labels(noEd));
    const rev = b(pReview.id, "review");
    c.ok("a cut late for review: Request update to its reviewer (James) and Open review", labels(rev) === "Request update|Open review" && ask(rev)?.seed.assigneeKey === "james" && rev?.owner === "James", `${labels(rev)} · ${ask(rev)?.seed.assigneeKey}`);
    const send = b(pSend.id, "delivery");
    c.ok("an approved video late to send: Request update to the office (Kyle) and Open", labels(send) === "Request update|Open" && ask(send)?.seed.assigneeKey === "kyle" && send?.nextStep === "Send it", `${labels(send)} · ${send?.nextStep}`);
    const photos = h.bottlenecks.find((x) => x.id.startsWith("editing:photos:"));
    c.ok("late photos at AutoHDR: the office is the person on the row (Kyle), asked for an update", photos?.owner === "Kyle" && labels(photos) === "Request update|Open" && ask(photos)?.seed.assigneeKey === "kyle", `${photos?.owner} · ${labels(photos)}`);
    const shoot = b(pNoShooter.id, "pre");
    c.ok("a shoot with no photographer: Assign, to the office (Aryeo holds the booking)", labels(shoot) === "Assign" && (shoot?.actions[0] as { seed?: { assigneeKey?: string } }).seed?.assigneeKey === "kyle" && shoot?.nextStep === "Assign a photographer");
    const scripts = h.bottlenecks.find((x) => x.id === "scripts:listing");
    // Jordan's Loom, Oct 27 2026, 3:51: "James can approve them ... he's the content manager." The row is James's; Jordan asks, he doesn't approve.
    c.ok("a premium reel shooting within the day with no script: one row, James's, 'Approve today', Request update to James and Open the job", !!scripts && scripts.owner === "James" && scripts.nextStep === "Approve today" && labels(scripts) === "Request update|Open" && ask(scripts)?.seed.assigneeKey === "james" && ask(scripts)?.seed.sourceHref === `/projects/${pScript.id}` && link(scripts, "Open") === `/projects/${pScript.id}` && scripts.tone === "bad" && /80 Script St: no script yet, shoot /.test(scripts.issue), JSON.stringify(scripts && [scripts.issue, scripts.owner, labels(scripts)]));
    c.ok("unowned work still leads (no editor, no photographer), the scripts row next", h.bottlenecks.slice(0, 2).map((x) => x.nextStep).sort().join(",") === "Assign a photographer,Assign an editor" && h.bottlenecks.findIndex((x) => x.id === "scripts:listing") === 2, h.bottlenecks.map((x) => x.id).join(" | "));
    c.ok("nobody reads 'The editor', 'The photographer' or 'Nobody (the office)'", h.bottlenecks.every((x) => !/^The (editor|photographer)$|^Nobody \(the office\)$/.test(x.owner)) && h.stages.every((s) => s.items.every((i) => !/^The (editor|photographer)$|^Nobody \(the office\)$/.test(i.owner))), h.bottlenecks.map((x) => x.owner).join(", "));
    c.ok("every bottleneck has at least one button, at most two", h.bottlenecks.every((x) => x.actions.length >= 1 && x.actions.length <= 2), h.bottlenecks.map((x) => `${x.id}=${labels(x)}`).join(" | "));

    // A press is one keyed task: Request update on the late edit.
    const before = await prisma.smartTask.count();
    const asked = await A.assignTaskAction({ ...ask(john)!.seed, assigneeKey: ask(john)!.seed.assigneeKey!, dueAt: ask(john)!.seed.dueAt ?? undefined, outcome: ask(john)!.seed.outcome ?? undefined, sourceHref: ask(john)!.seed.sourceHref ?? undefined, projectId: ask(john)!.seed.projectId ?? undefined });
    c.ok("pressing Request update hands James one task, keyed to the job", asked.ok && /James/.test(asked.message) && (await prisma.smartTask.count()) === before + 1, asked.message);
    const again = await A.assignTaskAction({ ...ask(john)!.seed, assigneeKey: "james", sourceHref: ask(john)!.seed.sourceHref ?? undefined, dueAt: undefined, outcome: undefined, projectId: undefined });
    c.ok("…a second press is the same task: 'Already with James', nothing new sent", again.ok && /Already with James/.test(again.message) && (await prisma.smartTask.count()) === before + 1, again.message);
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    const handled = b(pLateJohn.id, "editing");
    c.ok("…the row now says James has it, and its buttons nudge him (Request update) or move it (Reassign, its panel)", /James has it · assigned/.test(handled?.handledBy?.words ?? "") && handled?.owner === "James" && handled?.actions.map((a) => a.kind).join(",") === "nudge,task" && labels(handled) === "Request update|Reassign", `${handled?.handledBy?.words} · ${handled?.actions.map((a) => a.kind)}`);
    const nudged = await A.requestUpdateAction((handled!.actions[0] as { taskId: string }).taskId);
    c.ok("…and the nudge is the delegation's own Request update (it goes to James)", nudged.ok, nudged.message);

    // Two shoots lacking scripts: one row, to the Scripts card.
    const pScript2 = await p("81 Draft Dr, Town", { status: "SCHEDULED", shootDate: new Date(T.getTime() + 22 * H), scriptingId: "studio-81", scriptingDraftVersion: 1 });
    await premium(pScript2.id);
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    const two = h.bottlenecks.find((x) => x.id === "scripts:listing");
    c.ok("two shoots lacking approved scripts: one row ('2 shoots lack approved scripts'), Request update to James and Open to the Scripts card", /^2 shoots lack approved scripts/.test(two?.issue ?? "") && labels(two) === "Request update|Open" && link(two, "Open") === "#creative" && ask(two)?.seed.sourceHref === "/#creative", two?.issue);
    // The Loom, 0:22: the same work as topics (a count and what it is), the records inside.
    const topic = (k: string) => h.topics.find((t) => t.key === k);
    c.ok("topics: one per family, each a count with what it is (\"Videos past due: N projects, oldest X late\")", /^\d+ projects?, oldest \d+ (days?|hours?) late$/.test(topic("videos-late")?.summary ?? "") && topic("videos-late")!.title === "Videos past due" && /^\d+ shoots?, oldest/.test(topic("photos-not-uploaded")?.summary ?? "") && topic("scripts")?.owner === "James", h.topics.map((t) => `${t.title}: ${t.summary}`).join(" | "));
    c.ok("…every bottleneck record is in exactly one topic (the count is its list)", h.bottlenecks.every((x) => h.topics.filter((t) => t.items.some((i) => i.id === x.id)).length === 1), h.bottlenecks.filter((x) => !h.topics.some((t) => t.items.some((i) => i.id === x.id))).map((x) => x.id).join(", "));
    c.ok("…a record keeps its own button inside the topic (Remind photographer on the missing upload)", topic("photos-not-uploaded")?.items.some((i) => i.action?.label === "Remind photographer") === true);
    c.ok("…a topic's Delegate is keyed to the topic, to the right desk (late videos: James)", topic("videos-late")?.delegate.sourceHref === "/#topic-videos-late" && topic("videos-late")?.delegate.assigneeKey === "james");

    // =====================================================================
    c.head("§3 · Scripts & creative decisions: stale months gone, Studio's nudges listed");
    // =====================================================================
    const thisMonth = etMonthKey(T), lastMonth = prevMonth(thisMonth), oldMonth = prevMonth(lastMonth);
    const rick = await prisma.client.create({ data: { name: "Rick Schultz" } });
    const erica = await prisma.client.create({ data: { name: "Erica Walker" } });
    const enroll = (clientId: string) => prisma.contentEnrollment.create({ data: { clientId, package: "Pro", videosPerMonth: 8, sessionsPerMonth: 1, sessionHours: 4 } as never });
    const eRick = await enroll(rick.id), eErica = await enroll(erica.id);
    const month = (e: { id: string; clientId: string }, monthKey: string) => prisma.contentMonth.create({ data: { enrollmentId: e.id, clientId: e.clientId, monthKey, videosOwed: 8 } as never });
    const mOld = await month(eRick, oldMonth), mLast = await month(eRick, lastMonth), mNow = await month(eRick, thisMonth), mErica = await month(eErica, lastMonth);
    let n = 0;
    const waiting = async (m: { id: string; enrollmentId: string; clientId: string }, filmed: boolean) => {
      n++;
      const s = await prisma.contentScript.create({ data: { enrollmentId: m.enrollmentId, clientId: m.clientId, monthId: m.id, title: `Script ${n}`, body: "Words" } });
      const v = await prisma.contentScriptVersion.create({ data: { scriptId: s.id, enrollmentId: m.enrollmentId, clientId: m.clientId, versionNo: 1, title: `Script ${n}`, hook: "Hook", pointsJson: "[]", close: "Close", body: "Words", source: "AI", status: "DRAFT", createdBy: "james@oct27.invalid" } as never });
      await prisma.contentScript.update({ where: { id: s.id }, data: { currentVersionId: v.id } });
      if (filmed) await prisma.contentVideo.create({ data: { enrollmentId: m.enrollmentId, clientId: m.clientId, scriptId: s.id, status: "FILMED" } as never });
    };
    for (let i = 0; i < 4; i++) await waiting(mOld, false); // Rick's "August": four never approved, never filmed
    for (let i = 0; i < 2; i++) await waiting(mLast, true); // last month: both filmed already
    await waiting(mNow, true); await waiting(mNow, false); await waiting(mNow, false); // this month: one of three filmed
    await waiting(mErica, false); // Erica's last month: a late session still to come
    // The shared card (lib/contentActions, untouched) still reaches six months back for waiting approvals.
    const { monthlyContentActions } = await import("@/lib/contentActions");
    const shared = await monthlyContentActions({ now: T, excludeClientIds: [] });
    c.ok("the shared content card still lists Rick's month before last (its own six-month rule, unchanged)", shared.rows.some((r) => r.key === `${eRick.id}:${oldMonth}` && r.items.some((i) => i.key === "approve")), shared.rows.map((r) => `${r.key.split(":")[1]}=${r.items.map((i) => i.words).join("+")}`).join(" | "));
    // Script Studio's nudges, routed to Jordan: one on a job shooting in 10 days, one on the draft job above.
    const pStudio = await p("12 Studio St, Town", { status: "SCHEDULED", shootDate: new Date(T.getTime() + 10 * D), scriptingId: "studio-12" });
    const studioTask = await prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "system", status: "OPEN", title: "Client wants script changes — 12 Studio St", projectId: pStudio.id, clientId: client.id, assignedKey: "jordan", ownerId: jordanTm.id, dedupeKey: `scripting-client-${pStudio.id}` } });
    const draftTask = await prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "system", status: "OPEN", title: "Script ready — 81 Draft Dr", projectId: pScript2.id, clientId: client.id, assignedKey: "jordan", ownerId: jordanTm.id, dedupeKey: `scripting-script-${pScript2.id}` } });
    let cd = await ow.creativeDecisions({ now: T, ownerEmail: OWNER_EMAIL, excludeClientIds: [] });
    const mrow = (e: { id: string }, k: string) => cd.rows.find((r) => r.id === `month:${e.id}:${k}`);
    c.ok("Rick's month before last ('4 scripts to approve' from months ago) is not on the list: a past month", !mrow(eRick, oldMonth), cd.rows.map((r) => `${r.id}=${r.what}`).join(" | "));
    c.ok("last month's scripts that are filmed already: not a decision any more, the row is gone", !mrow(eRick, lastMonth));
    c.ok("this month: the filmed one drops out of the count ('2 scripts to approve', not 3)", /\b2 scripts to approve\b/.test(mrow(eRick, thisMonth)?.what ?? "") && !/\b3 scripts to approve\b/.test(mrow(eRick, thisMonth)?.what ?? ""), mrow(eRick, thisMonth)?.what);
    c.ok("…last month with a script still to film (a late session): it stays", /\b1 script to approve\b/.test(mrow(eErica, lastMonth)?.what ?? ""), mrow(eErica, lastMonth)?.what);
    const mActs = mrow(eRick, thisMonth)?.actions ?? [];
    c.ok("…a month row's buttons: its page (link) and Delegate; drafted by James, so 'Others draft'", mActs.length === 2 && mActs[0].kind === "link" && mActs[1].label === "Delegate" && mrow(eRick, thisMonth)?.mode === "drafted" && cd.othersDraft >= 1, `${mActs.map((a) => a.label)} · ${mrow(eRick, thisMonth)?.writer}`);
    // Since the Loom (Oct 27 2026, 3:51) listing scripts are James's: they leave Jordan's rows for one quiet line whose Open lists them.
    const fyi = (id: string) => cd.listingFyi?.rows.filter((r) => r.id === id) ?? [];
    c.ok("a Script Studio nudge on a job shooting later: in the quiet line's list (James's), never a row of Jordan's", fyi(`listing:${pStudio.id}`).length === 1 && /The client asked for changes in Script Studio/.test(fyi(`listing:${pStudio.id}`)[0].title) && fyi(`listing:${pStudio.id}`)[0].href === `/projects/${pStudio.id}#script` && !cd.rows.some((r) => r.kind === "listing"), JSON.stringify(cd.listingFyi));
    c.ok("…a nudge on a job already listed joins its row (one row)", fyi(`listing:${pScript2.id}`).length === 1 && /Draft v1 waiting for approval/.test(fyi(`listing:${pScript2.id}`)[0].title), JSON.stringify(fyi(`listing:${pScript2.id}`)));
    c.ok("…a job with no script at all: listed too, and the line says James writes or approves", fyi(`listing:${pScript.id}`).length === 1 && /^James has \d+ listing scripts to write or approve$/.test(cd.listingFyi?.words ?? ""), cd.listingFyi?.words);
    c.ok("no em dash leaks from a Studio task title", !/—/.test(JSON.stringify([cd.rows, cd.listingFyi])), (JSON.stringify(cd.listingFyi).match(/.{30}—.{30}/) ?? [""])[0]);
    void draftTask;
    const done = await setSmartTaskStatus(studioTask.id, "COMPLETED");
    cd = await ow.creativeDecisions({ now: T, ownerEmail: OWNER_EMAIL, excludeClientIds: [] });
    c.ok("closing the Studio nudge (James's Done) takes it off the line's list", (done === undefined || done.ok) && (await prisma.smartTask.findUnique({ where: { id: studioTask.id } }))?.status === "COMPLETED" && !fyi(`listing:${pStudio.id}`).length, JSON.stringify(done));

    // =====================================================================
    c.head("§4 · Team coverage and Delegated by me: a button on every row");
    // =====================================================================
    const team = await od.teamCoverage({ now: T, includeTest: true, production: h });
    const trow = (k: string) => team.rows.find((r) => r.key === k);
    c.ok("every coverage row has a button", team.rows.length >= 4 && team.rows.every((r) => !!r.action?.label), team.rows.map((r) => `${r.key}=${r.action?.label}`).join(" | "));
    c.ok("the office row (a video late to send): Request update to Kyle, keyed to the Shoots board", trow("office")?.action.kind === "ask" && (trow("office")!.action as { seed: { assigneeKey?: string | null; sourceHref?: string | null } }).seed.assigneeKey === "kyle" && (trow("office")!.action as { seed: { sourceHref?: string | null } }).seed.sourceHref === "/jobs" && /1 late to send/.test(trow("office")!.status), `${trow("office")?.status} · ${trow("office")?.action.label}`);
    c.ok("the creative row (a cut late for review): Request update to James", trow("creative")?.action.kind === "ask" && (trow("creative")!.action as { seed: { assigneeKey?: string | null } }).seed.assigneeKey === "james" && /1 cut to review/.test(trow("creative")!.status), `${trow("creative")?.status} · ${trow("creative")?.action.label}`);
    c.ok("the editors row (one job with no editor): Assign editor, straight to that job's Team section", trow("editors")?.action.kind === "link" && trow("editors")!.action.label === "Assign editor" && (trow("editors")!.action as { href: string }).href === `/projects/${pNoEditor.id}#team`, JSON.stringify(trow("editors")?.action));
    c.ok("the field row (uploads owed): Review, to the Shoots board", trow("field")?.action.kind === "link" && (trow("field")!.action as { href: string }).href === "/jobs", JSON.stringify(trow("field")?.action));
    await A.assignTaskAction({ title: "Prepare the strategy brief", outcome: "A one-page brief", assigneeKey: "james", dueAt: new Date(T.getTime() - H).toISOString() });
    await A.assignTaskAction({ title: "Confirm the reshoot", assigneeKey: "kyle", dueAt: new Date(T.getTime() + 2 * D).toISOString() });

    // =====================================================================
    c.head("§5 · Weekly performance: four headlines; the revision rate is a share of jobs");
    // =====================================================================
    const delivered = async (title: string) => {
      const pj = await p(title, { status: "DELIVERED", deliveredAt: new Date(T.getTime() - 3 * D) });
      const dl = await prisma.deliverable.create({ data: { projectId: pj.id, type: "VIDEO", label: "Listing video" } as never });
      await prisma.deliverableOutput.create({ data: { deliverableId: dl.id, projectId: pj.id, slot: 1, category: "VIDEO", deliveredAt: new Date(T.getTime() - 3 * D) } as never });
      return pj;
    };
    const d1 = await delivered("90 Done Dr, Town");
    await delivered("91 Done Dr, Town");
    await prisma.revisionBrief.create({ data: { projectId: d1.id, source: "text", originalText: "Make the music calmer", requestedByKind: "CLIENT", createdAt: new Date(T.getTime() - 2 * D) } });
    await prisma.revisionBrief.create({ data: { projectId: d1.id, source: "text", originalText: "And swap the opening", requestedByKind: "CLIENT", createdAt: new Date(T.getTime() - D) } });
    let w = await od.weeklyPerformance({ now: T, excludeClientIds: [] });
    let rate = w.measures.find((m) => m.key === "revisions");
    c.ok("two jobs delivered: the revision rate says 'Not enough data', never '50%'", rate?.label === "Revision rate" && rate.value === "Not enough data" && /1 of 2 jobs with a video delivered had a client revision ask/.test(rate.detail), `${rate?.value} · ${rate?.detail}`);
    const d3 = await delivered("92 Done Dr, Town");
    await delivered("93 Done Dr, Town");
    await prisma.revisionBrief.create({ data: { projectId: d3.id, source: "manual", originalText: "Office note: check the logo", requestedByKind: "OFFICE" } });
    w = await od.weeklyPerformance({ now: T, excludeClientIds: [] });
    rate = w.measures.find((m) => m.key === "revisions");
    c.ok("four jobs, one with client asks (two asks on it), one with only an office note: 25%, of jobs, never asks over videos", rate?.value === "25%" && /1 of 4 jobs/.test(rate.detail) && !/\d+ \/ \d+/.test(rate.value) && rate.period === "Last 30 days", `${rate?.value} · ${rate?.detail}`);
    const replies = w.measures.find((m) => m.key === "replies");
    c.ok("replies read 'Client replies within 1 hour', and with no texts 'None yet' (no percent)", replies?.label === "Client replies within 1 hour" && replies.value === "None yet", `${replies?.label}=${replies?.value}`);
    c.ok("every measure still states its period and source (View metric definitions)", w.measures.every((m) => !!m.period && !!m.source));

    // =====================================================================
    c.head("§1, §6 · the page as Jordan sees it");
    // =====================================================================
    const tasksBefore = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));
    const outboxBefore = await prisma.outboxMessage.count();
    const tree = await settle(await home({}));
    const html = ssr(tree);
    c.ok("renders as the owner dashboard", !html.startsWith("RENDER FAILED") && html.includes("data-owner-dashboard"), html.slice(0, 300));
    const strip = sliceOf(html, "data-finance-strip");
    const detailsTag = /<details[^>]*data-finance-details[^>]*>/.exec(html)?.[0] ?? "";
    const detailsAt = html.indexOf("data-finance-details");
    c.ok("Financial Position: a compact strip of the five figures", (strip.match(/data-figure="/g) ?? []).length === 5 && ["cash", "obligations", "collections", "forecast", "profit"].every((k) => strip.includes(`data-figure="${k}"`)), String((strip.match(/data-figure="/g) ?? []).length));
    c.ok("…the rail table and Stripe sit under Details, closed", !!detailsTag && !/\sopen(=|\s|>)/.test(detailsTag) && html.indexOf("data-revenue-month") > detailsAt && html.indexOf("data-stripe-card") > detailsAt && html.indexOf("data-revenue-month") < html.indexOf('data-section="production"'), detailsTag);
    c.ok("…the freshness line stays out, small, above the fold", html.indexOf("data-freshness") > 0 && html.indexOf("data-freshness") < detailsAt && /text-\[11px\][^>]*data-freshness/.test(html));
    // Since the Loom (Oct 27 2026, 0:22): topics, not records; each opens its panel with the records and their buttons.
    const topicSpecs = (elements(tree, "PanelButton") as { spec: PanelSpec }[]).map((x) => x.spec).filter((x): x is Extract<PanelSpec, { kind: "topic" }> => x.kind === "topic");
    c.ok("Bottlenecks requiring action: one row per topic (at most six), each opening its panel; no record rows on the card", (html.match(/data-topic="[^"]+"/g) ?? []).length >= 3 && (html.match(/data-topic="[^"]+"/g) ?? []).length <= 6 && !/data-bottleneck="/.test(html) && topicSpecs.length >= 3, String((html.match(/data-topic="[^"]+"/g) ?? []).length));
    const tPanel = (k: string) => { const s = topicSpecs.find((x) => x.topic.key === k); return s ? ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }, { key: "james", name: "James" }], readOnly: false, initial: s }, null)) : ""; };
    const capPanel = tPanel("photos-not-uploaded");
    c.ok("a topic panel: the summary, the records with their own buttons, then Review, Delegate, Make it my task, Mark handled, Snooze 7 days", capPanel.includes("data-topic-panel") && /data-row-action="ask"[^>]*>Remind photographer</.test(capPanel) && ["data-topic-review", "data-topic-delegate", "data-topic-mine", "data-topic-handled", "data-topic-snooze"].every((a) => capPanel.includes(a)) && !nestedButton(capPanel), capPanel.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
    // The handled late edit sits below the fold: its row in View all carries the nudge.
    const listSpec = (elements(tree, "ViewAll") as { spec: PanelSpec }[]).map((x) => x.spec).find((x): x is Extract<PanelSpec, { kind: "list" }> => x.kind === "list" && x.title === "Bottlenecks requiring action");
    const lJohn = listSpec?.rows.find((r) => r.id === "editing:video:v-john");
    c.ok("View all: the handled late edit's row carries Request update, the one-press nudge", lJohn?.action?.kind === "nudge" && lJohn.action.label === "Request update" && /James has it/.test(lJohn.sub ?? ""), JSON.stringify(lJohn ?? listSpec?.rows.map((r) => [r.id, r.action?.label]) ?? "no list"));
    const listHtml = ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }, { key: "james", name: "James" }], readOnly: false, initial: listSpec ?? null }, null));
    c.ok("…the list panel renders it as a button (data-row-action=\"nudge\"), and Assign only where nothing else fits", /data-row-action="nudge"[^>]*>Request update</.test(listHtml) && /data-row-action="ask"[^>]*>Remind photographer</.test(listHtml), listHtml.slice(listHtml.indexOf("data-panel-list"), listHtml.indexOf("data-panel-list") + 200));
    void pRaw;
    const bNoEd = tPanel("unowned");
    c.ok("…the work-nobody-is-on topic: no editor's record links Assign editor to the job's Team section", bNoEd.includes(`href="/projects/${pNoEditor.id}#team"`) && />Assign editor</.test(bNoEd));
    const team0 = sliceOf(html, 'data-coverage-row="editors"');
    c.ok("Team coverage: each row has its button (editors: Assign editor to the job)", (html.match(/data-coverage-row=/g) ?? []).length >= 4 && team0.includes(`href="/projects/${pNoEditor.id}#team"`), team0.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200));
    const delegated = sliceOf(html, 'data-section="delegated"');
    c.ok("Delegated by me: every open row has Follow up, a one-press nudge to the person who has it", (delegated.match(/data-delegated-row=/g) ?? []).length >= 2 && (delegated.match(/data-row-action="nudge"/g) ?? []).length >= 2 && />Follow up</.test(delegated), String((delegated.match(/data-row-action="nudge"/g) ?? []).length));
    const creative = sliceOf(html, 'data-section="creative"');
    c.ok("Scripts & creative decisions: the chips stay; listing scripts are one quiet line (James's) with Open; three rows shown", creative.includes("Jordan owns") && creative.includes("Others draft") && /data-listing-fyi="\d+"/.test(creative) && /James has \d+ listing scripts? to/.test(creative) && !/data-creative-actions="Review script\|Done"/.test(creative) && (creative.match(/data-creative-row=/g) ?? []).length <= 3, String((creative.match(/data-creative-row=/g) ?? []).length));
    const weekly = sliceOf(html, 'data-section="weekly"');
    const tiles = [...weekly.matchAll(/data-tile="([a-z]+)"/g)].map((m) => m[1]);
    c.ok("Weekly performance: four headline tiles (on-time delivery, revision rate, client replies, upcoming shoots covered)", tiles.join(",") === "ontime,revisions,replies,shoots", tiles.join(","));
    const ontime = sliceOf(weekly, 'data-tile="ontime"');
    c.ok("…on-time delivery holds photos and listing videos side by side, never one average", ontime.includes('data-measure="photos"') && ontime.includes('data-measure="videos"'));
    c.ok("…the revision tile reads a percent of jobs, and 'View metric definitions' stays", /data-measure="revisions"[\s\S]*?25%/.test(weekly) && weekly.includes("View metric definitions") && !/\d+ \/ \d+ \(\d+%\)/.test(weekly));
    c.ok("§6 paired cards stretch to the same height (three pairs), one column on a phone", (html.match(/class="grid items-stretch gap-5 lg:grid-cols-2"/g) ?? []).length === 3 && (html.match(/data-section="[a-z-]+"[^>]*/g) ?? []).length >= 9 && /flex min-w-0 scroll-mt-20 flex-col/.test(html));
    c.ok("§6 no link inside a link, no button inside a button", !nestedLink(html) && !nestedButton(html));
    c.ok("no em dashes on his dashboard", !/—/.test(html.slice(html.indexOf("data-owner-dashboard"))), (html.match(/.{40}—.{40}/) ?? [""])[0]);
    c.ok("the render writes no task and sends nothing (every button needs a press)", tasksBefore === JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) && (await prisma.outboxMessage.count()) === outboxBefore);
    c.ok("the RowActionButton is the shell's: no panel or button runs on render", elements(tree, "RowActionButton").length >= 8, String(elements(tree, "RowActionButton").length));
    c.ok("nothing left the box but the Slack fake", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
