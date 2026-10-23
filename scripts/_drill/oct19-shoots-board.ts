// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: SHOOTS (Oct 19 2026). The Shoots list (/jobs, lib/jobsBoard) and the
// job page's Photos and Video cards (components/jobs/JobDeliverables).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct19-shoots-board.ts
//
// Jordan: "I need to be able to track each job and where they are at, and
// special requests for either photo or video, and individual photos and
// videos." Request owners he approved: at the shoot → the creative; photo
// editing → Kyle; video editing → the job's editor; anything unclear "needs
// an owner" until someone picks.
//
//   1  the words and stages, pure: due words, the photo and video chips and
//      step bars, the furthest-behind video leading, requests counted, who
//      owns a request, when a shoot is over
//   2  jobsBoard on seeded jobs: photo only, video only, both, monthly, late,
//      a future shoot; delivered and test clients left out (and back in when
//      asked); late first then by due; the counts; limit; the dashboard's
//      contract shape
//   3  the /jobs page renders: the table, the Monthly content heading, each
//      row opens its job, the filters (Open, Late, Due today, This week,
//      Monthly, All), test records, mobile labels, no em dash
//   4  the job page's two cards: chips, step bars, the photo count and
//      flagged, each video with its version, the requests with their owners,
//      the needs-an-owner picker, one Checked per card, money scrubbed for
//      Kyle; the project page puts the cards first
//   5  the picker's action: guarded (view as, a photographer, bad input),
//      sets the medium with who and when, the owner follows
//   6  /pipeline redirects to /jobs (test records carried)
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7463). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

type Me = { id: string; email: string; name: string | null; role: string; permissions: null; status: string; teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: null; impersonating: boolean; realRole: string; realName: string | null } | null;
let me: Me = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
class Redirect extends Error {
  constructor(readonly href: string) {
    super(`redirect ${href}`);
  }
}
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.redirect = (href: string) => {
    throw new Redirect(href);
  };
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/jobs";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 7463);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DASH = /[—–]|&mdash;|&ndash;/;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
const user = (role: string, extra: Partial<NonNullable<Me>> = {}): NonNullable<Me> => ({ id: `u-${role}`, email: `${role.toLowerCase()}@x.test`, name: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", ...extra });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct19-shoots-board" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const jb = await import("@/lib/jobsBoard");
    const ca = await import("@/lib/clientAsks");

    // =========================================================================
    c.head("1 · words and stages (pure)");
    // =========================================================================
    const now0 = new Date("2026-10-19T18:00:00Z"); // Mon 2 PM ET
    c.ok("due words: '41 h late', '4 days late', 'Today 5 PM', 'Tue 5 PM', 'Oct 30', 'No date yet'",
      jb.dueWordsFor(new Date(now0.getTime() - 41 * HOUR), now0) === "41 h late" &&
      jb.dueWordsFor(new Date(now0.getTime() - 4 * DAY), now0) === "4 days late" &&
      jb.dueWordsFor(new Date("2026-10-19T21:00:00Z"), now0) === "Today 5 PM" &&
      jb.dueWordsFor(new Date("2026-10-20T21:00:00Z"), now0) === "Tue 5 PM" &&
      jb.dueWordsFor(new Date("2026-10-30T21:00:00Z"), now0) === "Oct 30" &&
      jb.dueWordsFor(null, now0) === "No date yet",
      [jb.dueWordsFor(new Date("2026-10-20T21:30:00Z"), now0), jb.dueWordsFor(new Date("2026-10-19T21:00:00Z"), now0)].join(" / "));
    c.ok("…minutes kept when they matter ('Tue 5:30 PM'); the job page's line 'Due Oct 15, 4 days late'",
      jb.dueWordsFor(new Date("2026-10-20T21:30:00Z"), now0) === "Tue 5:30 PM" && jb.dueLineFor(new Date(now0.getTime() - 4 * DAY), now0) === "Due Oct 15, 4 days late");
    const ph = (o: Partial<Parameters<typeof jb.photoStageOf>[0]>) => jb.photoStageOf({ jobStage: null, shootOver: true, rawsIn: true, liveOnAryeo: false, late: false, ...o });
    c.ok("photos: Not shot yet, Not uploaded, Editing, In QC, Ready to review, Revisions, Delivered",
      ph({ shootOver: false, rawsIn: false }).label === "Not shot yet" && ph({ rawsIn: false }).label === "Not uploaded" && ph({}).label === "Editing" &&
      ph({ jobStage: "EDITING" }).label === "Editing" && ph({ jobStage: "QC_RUNNING" }).label === "In QC" && ph({ jobStage: "QC_REVIEW" }).label === "In QC" &&
      ph({ jobStage: "READY" }).label === "Ready to review" && ph({ jobStage: "REVISION_REQUESTED" }).label === "Revisions" && ph({ jobStage: "DELIVERED" }).label === "Delivered" &&
      ph({ liveOnAryeo: true }).label === "Delivered" && ph({ liveOnAryeo: true, reopened: true }).label === "Revisions");
    c.ok("…late turns anything short of delivered red; delivered stays green", ph({ jobStage: "READY", late: true }).tone === "late" && ph({ jobStage: "DELIVERED", late: true }).tone === "done");
    const steps = (s: { label: string; state: string }[]) => s.map((x) => `${x.label}:${x.state}`).join(",");
    c.ok("photo step bar: Shot, Edited, QC, Delivered; Revisions shows only while in revisions",
      steps(jb.photoStepsOf({ jobStage: "QC_RUNNING", shootOver: true, rawsIn: true, liveOnAryeo: false, late: false })) === "Shot:done,Edited:done,QC:now,Delivered:todo" &&
      steps(jb.photoStepsOf({ jobStage: "REVISION_REQUESTED", shootOver: true, rawsIn: true, liveOnAryeo: true, late: false })) === "Shot:done,Edited:done,QC:done,Revisions:now,Delivered:todo" &&
      steps(jb.photoStepsOf({ jobStage: null, shootOver: false, rawsIn: false, liveOnAryeo: false, late: false })) === "Shot:now,Edited:todo,QC:todo,Delivered:todo");
    const vf = (...p: [string, boolean?][]) => p.map(([phase, late]) => ({ phase: phase as Parameters<typeof jb.videoStageOf>[0][number]["phase"], late: !!late }));
    c.ok("video: the furthest-behind video leads ('Not cut · John' over 'Ready to send'), with the editor",
      jb.videoStageOf(vf(["ready"], ["not_cut"]), "John")?.label === "Not cut · John" && jb.videoStageOf(vf(["changes", true]), "John")?.label === "Changes · John" &&
      jb.videoStageOf(vf(["editing"]), "outside")?.label === "Editing · outside" && jb.videoStageOf(vf(["review"], ["sent"]), null)?.label === "In review" &&
      jb.videoStageOf(vf(["ready", true]), null)?.label === "Ready to send" && jb.videoStageOf(vf(["sent"]), null)?.label === "Sent" && jb.videoStageOf([], null) === null);
    c.ok("…no editor: 'Not cut yet', 'Changes asked'; late only short of approved (Ready to send stays green)",
      jb.videoStageOf(vf(["not_cut"]), null)?.label === "Not cut yet" && jb.videoStageOf(vf(["changes"]), null)?.label === "Changes asked" &&
      jb.videoStageOf(vf(["not_cut", true]), "John")?.tone === "late" && jb.videoStageOf(vf(["ready", true]), null)?.tone === "done");
    c.ok("video step bar: Shot, Edited, Reviewed, Ready, Sent; monthly skips Ready",
      steps(jb.videoStepsOf(vf(["ready"]), false)) === "Shot:done,Edited:done,Reviewed:done,Ready:now,Sent:todo" &&
      steps(jb.videoStepsOf(vf(["review"]), false)) === "Shot:done,Edited:done,Reviewed:now,Ready:todo,Sent:todo" &&
      steps(jb.videoStepsOf(vf(["approved"]), true)) === "Shot:done,Edited:done,Reviewed:done,Sent:now" &&
      steps(jb.videoStepsOf(vf(["sent"]), false)) === "Shot:done,Edited:done,Reviewed:done,Ready:done,Sent:done");
    c.ok("a Review Room row as a phase: sending → ready, delivered → sent, a cut in review, the room's 'Not shot yet'",
      jb.phaseOfVideoRow({ lane: "sending", cutStatus: "APPROVED", stage: "" }) === "ready" && jb.phaseOfVideoRow({ lane: "delivered", cutStatus: "APPROVED", stage: "" }) === "sent" &&
      jb.phaseOfVideoRow({ lane: "late", cutStatus: "PENDING", stage: "" }) === "review" && jb.phaseOfVideoRow({ lane: "upcoming", cutStatus: null, stage: "Not shot yet" }) === "not_shot" &&
      jb.phaseOfVideoRow({ lane: "today", cutStatus: null, stage: "Ready to edit" }) === "not_cut");
    const rq = jb.countRequests([{ medium: "photo" }, { medium: "video" }, { medium: "both" }, { medium: "unclear" }, { medium: null }], true);
    c.ok("requests: both counts for photos and video; unclear needs an owner once the shoot is over",
      rq.open === 5 && rq.photo === 2 && rq.video === 2 && rq.needsOwner === 2 && jb.countRequests([{ medium: "unclear" }], false).needsOwner === 0, JSON.stringify(rq));
    const own = (medium: string | null, ctx: Partial<Parameters<typeof ca.requestOwner>[1]> = {}, kind = "SPECIAL_REQUEST") => ca.requestOwner({ kind, medium }, { shootOver: true, creative: "Harrison Wells", editor: "John Mark", ...ctx }).label;
    c.ok("owners: before the shoot the creative, then Kyle for photos, the editor for video, both per card, unclear needs an owner",
      own("video", { shootOver: false }) === "Harrison · at the shoot" && own("unclear", { shootOver: false }) === "Harrison · at the shoot" &&
      own("photo") === "Kyle · photo editing" && own("video") === "John · video editing" && own("both", { card: "photo" }) === "Kyle · photo editing" &&
      own("both", { card: "video" }) === "John · video editing" && own("unclear") === "Needs an owner" && own(null) === "Needs an owner" &&
      own("video", { editor: null }) === "Video editor not assigned" && own("photo", { shootOver: false, creative: null }) === "Creative not assigned · at the shoot" &&
      own(null, {}, "SCHEDULING") === "Kyle · scheduling");
    c.ok("the shoot is over: a stage past it, or the appointment's end (start + 2 h when no end)",
      ca.shootIsOver({ status: "EDITING", shootDate: null }) && !ca.shootIsOver({ status: "SCHEDULED", shootDate: new Date(Date.now() - HOUR) }) &&
      ca.shootIsOver({ status: "SCHEDULED", shootDate: new Date(Date.now() - 3 * HOUR) }) && ca.shootIsOver({ status: "SCHEDULED", shootDate: new Date(Date.now() - 2 * HOUR), endAt: new Date(Date.now() - HOUR) }) &&
      !ca.shootIsOver({ status: "BOOKED", shootDate: null }));

    // =========================================================================
    c.head("2 · jobsBoard on seeded jobs");
    // =========================================================================
    const T = Date.now();
    const heather = await prisma.client.create({ data: { name: "Heather Barritt" } });
    const bobby = await prisma.client.create({ data: { name: "Bobby TEST" } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.test", role: "PHOTOGRAPHER" } as never });
    type Del = { type: string; status?: string; label?: string; quantity?: number };
    const mk = async (street: string, o: { status: string; shoot: Date | null; items: string[]; dels: Del[]; client?: string; packageName?: string; deliveredAt?: Date; appt?: boolean }) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Malvern, PA`, clientId: o.client ?? heather.id, status: o.status as never, shootDate: o.shoot, packageName: o.packageName ?? null, deliveredAt: o.deliveredAt ?? null,
          photographerId: harrison.id,
          orderItems: { create: o.items.map((title) => ({ title, amount: 10000 })) },
          deliverables: { create: o.dels.map((d) => ({ type: d.type as never, status: (d.status ?? "PENDING") as never, label: d.label ?? null, quantity: d.quantity ?? 1, productTitle: d.label ?? null })) },
          ...(o.appt && o.shoot ? { appointments: { create: [{ aryeoId: `appt-${street}`, startAt: o.shoot, endAt: new Date(o.shoot.getTime() + HOUR), assignedToId: harrison.id, status: "CONFIRMED" }] } } : {}),
        } as never,
        select: { id: true },
      });
      return p.id;
    };
    const A = await mk("10 Photo Ln", { status: "EDITING", shoot: new Date(T - DAY), items: ["HDR Photos"], dels: [{ type: "PHOTOS", status: "UPLOADED" }] });
    const B = await mk("20 Video Ct", { status: "EDITING", shoot: new Date(T - DAY), items: ["Cinematic Video"], dels: [{ type: "VIDEO", status: "UPLOADED" }] });
    // A 48-hour video five days after the shoot: late on its own promise whatever the weekday.
    const C = await mk("30 Both Rd", { status: "SHOT", shoot: new Date(T - 5 * DAY), items: ["HDR Photos", "Standard Listing Video"], dels: [{ type: "PHOTOS", status: "DONE" }, { type: "VIDEO", status: "UPLOADED" }] });
    const D = await mk("40 Monthly Way", { status: "SHOT", shoot: new Date(T - 2 * DAY), packageName: "Monthly Social Media Content", items: ["Monthly Social Media Content"], dels: [{ type: "VIDEO", status: "UPLOADED", label: "Monthly Social Media Content", quantity: 4 }], appt: true });
    const E = await mk("50 Late St", { status: "REVIEW", shoot: new Date(T - 6 * DAY), items: ["HDR Photos"], dels: [{ type: "PHOTOS", status: "UPLOADED" }] });
    const F = await mk("60 Done Dr", { status: "DELIVERED", shoot: new Date(T - 3 * DAY), deliveredAt: new Date(T - DAY), items: ["HDR Photos"], dels: [{ type: "PHOTOS", status: "DONE" }] });
    const G = await mk("70 Test Ave", { status: "EDITING", shoot: new Date(T - DAY), client: bobby.id, items: ["HDR Photos"], dels: [{ type: "PHOTOS", status: "UPLOADED" }] });
    const H = await mk("80 Future Pl", { status: "SCHEDULED", shoot: new Date(T + 2 * DAY), items: ["HDR Photos", "Cinematic Video"], dels: [{ type: "PHOTOS" }, { type: "VIDEO" }], appt: true });
    const I = await mk("90 Ready Rd", { status: "REVIEW", shoot: new Date(T - DAY), items: ["Cinematic Video"], dels: [{ type: "VIDEO", status: "UPLOADED" }] });

    // The photo pipeline.
    const pjA = await prisma.photoJob.create({ data: { projectId: A, stage: "QC_RUNNING" } });
    const assets = await Promise.all([1, 2, 3].map((n) => prisma.photoAsset.create({ data: { jobId: pjA.id, name: `IMG_${n}.jpg`, sequence: n } as never })));
    await prisma.photoQcFinding.create({ data: { qcRunId: "run-a", jobId: pjA.id, photoId: assets[0].id, ruleId: "PREP_PERSONAL_DOCUMENTS", groupKey: "PREP_PERSONAL_DOCUMENTS", pass: "P1_PHOTO", source: "P1", specificIssue: "papers on the fridge", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "ADMIN", fixStrategy: "HUMAN_REVIEW", status: "OPEN" } as never });
    await prisma.photoQcFinding.create({ data: { qcRunId: "run-a", jobId: pjA.id, photoId: assets[1].id, ruleId: "PREP_PERSONAL_DOCUMENTS", groupKey: "low", pass: "P1_PHOTO", source: "P1", specificIssue: "maybe", explanation: "x", severity: "MINOR", confidence: 0.1, responsibility: "ADMIN", fixStrategy: "HUMAN_REVIEW", status: "OPEN" } as never });
    await prisma.photoJob.create({ data: { projectId: C, stage: "DELIVERED", deliveredAt: new Date(T - 2 * DAY) } });
    await prisma.photoJob.create({ data: { projectId: E, stage: "READY" } });
    // The videos: B has version 2 in review, I an approved first version; John edits B and C.
    const vidOf = async (pid: string) => (await prisma.deliverable.findFirstOrThrow({ where: { projectId: pid, type: "VIDEO" } })).id;
    await prisma.reviewSubmission.create({ data: { projectId: B, deliverableId: await vidOf(B), slot: 1, round: 1, status: "CHANGES_REQUESTED", fileName: "b1.mp4", decidedAt: new Date(T - 5 * HOUR), createdAt: new Date(T - 8 * HOUR) } as never });
    await prisma.reviewSubmission.create({ data: { projectId: B, deliverableId: await vidOf(B), slot: 1, round: 2, status: "PENDING", fileName: "b2.mp4", createdAt: new Date(T - HOUR) } as never });
    const iCut = await prisma.reviewSubmission.create({ data: { projectId: I, deliverableId: await vidOf(I), slot: 1, round: 1, status: "APPROVED", fileName: "i1.mp4", decidedAt: new Date(T - HOUR), createdAt: new Date(T - 3 * HOUR) } as never });
    for (const pid of [B, C]) await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", status: "OPEN", assignedKey: "john", projectId: pid, clientId: heather.id, dedupeKey: `edit-video-${pid}` } as never });
    // The client's requests.
    const ask = (projectId: string, medium: string, words: string, extra: Record<string, unknown> = {}) =>
      ca.createAsk({ clientId: heather.id, projectId, kind: "SPECIAL_REQUEST", source: "text", medium, text: words, summary: words, askedBy: "Heather Barritt", askedAt: new Date(T - 3 * HOUR), ...extra });
    const cPhoto = await ask(C, "photo", "Brighten the kitchen photos");
    const cVideo = await ask(C, "video", "Use the upbeat song");
    const cBoth = await ask(C, "both", "Lot lines on everything, it is listed at $350k");
    const cUnclear = await ask(C, "unclear", "Make the backyard pop");
    await ask(C, "both", "Ordered: Lot Lines", { source: "order_note", holdsDelivery: false });
    await ca.createAsk({ clientId: heather.id, projectId: C, kind: "SCHEDULING", source: "text", text: "Can we move the next shoot?" });
    const hUnclear = await ask(H, "unclear", "Get the park down the street");
    await ask(H, "photo", "A photo of the community sign");
    await ask(G, "photo", "Test client request");

    const now = new Date();
    const board = await jb.jobsBoard(now);
    const row = (id: string) => board.rows.find((r) => r.projectId === id);
    c.ok("the contract: rows and counts (total, late, dueToday, dueTomorrow, oldestLateDays)",
      Array.isArray(board.rows) && ["total", "late", "dueToday", "dueTomorrow", "oldestLateDays"].every((k) => k in board.counts), JSON.stringify(board.counts));
    c.ok("live jobs only: delivered (60 Done Dr) and the test client (70 Test Ave) are left out",
      !row(F) && !row(G) && [A, B, C, D, E, H, I].every((id) => !!row(id)) && board.counts.total === 7, board.rows.map((r) => r.street).join(", "));
    c.ok("photo only: photos 'In QC', no video", row(A)?.photos?.label === "In QC" && ["active", "late"].includes(row(A)!.photos!.tone) && row(A)?.video === null, JSON.stringify(row(A)));
    c.ok("video only: 'In review' (version 2 waiting), no photos", row(B)?.video?.label === "In review" && row(B)?.photos === null, JSON.stringify(row(B)?.video));
    c.ok("both: photos 'Delivered' (green), video 'Not cut · John' (late on its own promise, red)",
      row(C)?.photos?.label === "Delivered" && row(C)?.photos?.tone === "done" && row(C)?.video?.label === "Not cut · John" && row(C)?.video?.tone === "late", JSON.stringify([row(C)?.photos, row(C)?.video]));
    c.ok("…its requests: 4 open, 2 photo, 2 video, 1 needs an owner (the order note and the scheduling ask are not counted)",
      JSON.stringify(row(C)?.requests) === JSON.stringify({ open: 4, photo: 2, video: 2, needsOwner: 1 }), JSON.stringify(row(C)?.requests));
    c.ok("monthly content is marked monthly (no photos ordered)", row(D)?.monthly === true && row(D)?.photos === null && !!row(D)?.video && !row(C)?.monthly);
    c.ok("late: '50 Late St' is late with 'N days late' and photos 'Ready to review' in red",
      row(E)?.late === true && /\d+ (days|h) late/.test(row(E)!.dueWords) && row(E)?.photos?.label === "Ready to review" && row(E)?.photos?.tone === "late", JSON.stringify(row(E)));
    c.ok("a future shoot: both 'Not shot yet', its unclear request has the creative (no 'needs an owner')",
      row(H)?.photos?.label === "Not shot yet" && row(H)?.video?.label === "Not shot yet" && JSON.stringify(row(H)?.requests) === JSON.stringify({ open: 2, photo: 1, video: 0, needsOwner: 0 }) && !row(H)?.late && /^(Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun) |^[A-Z][a-z]{2} \d+$/.test(row(H)!.dueWords), JSON.stringify(row(H)));
    c.ok("an approved listing video: 'Ready to send'", row(I)?.video?.label === "Ready to send", JSON.stringify(row(I)?.video));
    const order = board.rows.map((r) => r.projectId);
    const lateIdx = board.rows.map((r, i) => (r.late ? i : -1)).filter((i) => i >= 0);
    c.ok("sorted late first (the most late first), then by due",
      lateIdx.every((i, n) => i === n) && order.indexOf(E) < order.indexOf(C) &&
      board.rows.filter((r) => !r.late && r.dueISO).every((r, i, a) => i === 0 || Date.parse(a[i - 1].dueISO!) <= Date.parse(r.dueISO!)), board.rows.map((r) => `${r.street}:${r.dueWords}`).join(" | "));
    c.ok("the counts agree with the rows; the oldest late in days", board.counts.late === board.rows.filter((r) => r.late).length && board.counts.late >= 2 && (board.counts.oldestLateDays ?? 0) >= 4 && board.counts.dueToday === board.rows.filter((r) => r.dueToday).length);
    c.ok("each row opens the job page", board.rows.every((r) => r.href === `/projects/${r.projectId}`));
    const two = await jb.jobsBoard(now, { limit: 2 });
    c.ok("limit: two rows, the counts still over every job", two.rows.length === 2 && two.counts.total === 7 && two.rows[0].projectId === board.rows[0].projectId);
    const withTest = await jb.jobsBoard(now, { includeTest: true });
    c.ok("includeTest: the test client's job comes back", withTest.rows.some((r) => r.projectId === G) && withTest.counts.total === 8);
    const all = await jb.shootsBoard(now, { includeDelivered: true });
    const fRow = all.rows.find((r) => r.projectId === F);
    c.ok("the page's All: the delivered job, last, saying 'Delivered <date>'", !!fRow?.delivered && /^Delivered [A-Z][a-z]{2} \d+$/.test(fRow.dueWords) && all.rows[all.rows.length - 1].projectId === F && all.counts.total === 7, fRow?.dueWords);
    c.ok("nothing in the rows says undefined, NaN or an em dash", !/undefined|NaN/.test(JSON.stringify(board.rows)) && !DASH.test(JSON.stringify(board.rows)));

    // =========================================================================
    c.head("3 · the /jobs page");
    // =========================================================================
    const { default: ShootsPage } = await import("@/app/jobs/page");
    const page = async (sp: Record<string, string> = {}) => html(await ShootsPage({ searchParams: Promise.resolve(sp) }));
    const h = await page();
    const t = text(h);
    const has = (hh: string, street: string) => hh.includes(`>${street}<`);
    c.ok("titled Shoots; the header counts late, due today, due tomorrow", /Shoots/.test(t) && new RegExp(`${board.counts.late} late · ${board.counts.dueToday} due today · ${board.counts.dueTomorrow} due tomorrow · 7 in progress`).test(t), t.slice(0, 300));
    c.ok("the table: Shoot, Due, Photos, Video, Requests", /Shoot Due Photos Video Requests/.test(t));
    c.ok("Open (the default) lists every live shoot, not the delivered or the test one",
      ["10 Photo Ln", "20 Video Ct", "30 Both Rd", "40 Monthly Way", "50 Late St", "80 Future Pl", "90 Ready Rd"].every((s) => has(h, s)) && !has(h, "60 Done Dr") && !has(h, "70 Test Ave"));
    c.ok("…each row opens its job page; the chips and the requests chip ('4 open', '1 needs an owner', '1 photo', 'none')",
      [A, C, E, I].every((id) => h.includes(`href="/projects/${id}"`)) && t.includes("Not cut · John") && t.includes("Ready to review") && t.includes("4 open") && t.includes("1 needs an owner") && t.includes("2 open") && /none/.test(t));
    c.ok("monthly content under its own heading, after the listing shoots", h.indexOf("data-monthly-heading") > h.indexOf(">90 Ready Rd<") && h.indexOf(">40 Monthly Way<") > h.indexOf("data-monthly-heading") && /n\/a/.test(t));
    c.ok("filter chips: Open (current), Late, Due today, This week, Monthly, All",
      ["open", "late", "today", "week", "monthly", "all"].every((k) => h.includes(`data-filter="${k}"`)) && /aria-current="page"[^>]*data-filter="open"|data-filter="open"[^>]*aria-current="page"/.test(h.replace(/href="[^"]*"/g, "")) && h.includes('href="/jobs?f=late"'));
    c.ok("mobile: each row stacks with its own labels (Photos, Video, Asks)", (h.match(/sm:hidden">Photos</g) ?? []).length === 7 && (h.match(/sm:hidden">Asks</g) ?? []).length === 7);
    const late = await page({ f: "late" });
    c.ok("Late: only late shoots (50 Late St and 30 Both Rd in, the future one out)", has(late, "50 Late St") && has(late, "30 Both Rd") && !has(late, "80 Future Pl") && /aria-current="page"/.test(late));
    const today = await page({ f: "today" });
    c.ok("Due today: the late ones too (Jordan's rule)", has(today, "50 Late St") && !has(today, "80 Future Pl") && text(today).includes("Due today, with the late ones first."));
    const week = await page({ f: "week" });
    c.ok("This week: due in the next 7 days, late included", has(week, "80 Future Pl") && has(week, "50 Late St"));
    const monthly = await page({ f: "monthly" });
    c.ok("Monthly: the monthly job only", has(monthly, "40 Monthly Way") && !has(monthly, "30 Both Rd"));
    c.ok("the program videos' milestones (from the old tracker) sit under the list on Open and Monthly, where the alerts' link lands",
      h.includes('id="program-watch"') && monthly.includes('id="program-watch"') && !late.includes('id="program-watch"') && h.indexOf('id="program-watch"') > h.indexOf("data-shoots-list"));
    const allPage = await page({ f: "all" });
    c.ok("All: the delivered job too, dimmed", has(allPage, "60 Done Dr") && /opacity-70/.test(allPage));
    const testPage = await page({ test: "1" });
    // Oct 23 2026 (Jordan: "I don't need the show test records button anymore"): no toggle either way; a typed ?test=1 still reads them.
    c.ok("test records: no toggle; hidden normally, a typed ?test=1 shows them and says so", has(testPage, "70 Test Ave") && !has(h, "70 Test Ave") && !/Show test records|Hide test records/.test(text(testPage) + text(h)) && text(testPage).includes("test records shown"));
    const listOnly = (hh: string) => hh.slice(hh.indexOf("data-shoots-list"));
    c.ok("no em dash and no undefined in the list", !DASH.test(listOnly(h)) && !/undefined|NaN/.test(text(h)));

    // =========================================================================
    c.head("4 · the job page's Photos and Video cards");
    // =========================================================================
    const { loadJobDeliverables, JobDeliverablesView } = await import("@/components/jobs/JobDeliverables");
    me = user("OWNER");
    const dC = (await loadJobDeliverables(C))!;
    const hC = html(createElement(JobDeliverablesView, dC));
    const tC = text(hC);
    const card = (hh: string, which: "photos" | "video") => {
      const a = hh.indexOf(`data-card="${which}"`);
      const b = which === "photos" ? hh.indexOf('data-card="video"') : hh.length;
      return hh.slice(a, b);
    };
    c.ok("two cards side by side (stacked on a phone): Photos and Video", /data-card="photos"/.test(hC) && /data-card="video"/.test(hC) && /grid-cols-1[^"]*md:grid-cols-2/.test(hC));
    c.ok("…the job's due line, the board's own", /Due [A-Z][a-z]{2} \d+, \d+ (days|h) late/.test(tC) && dC.data.due.late, dC.data.due.line ?? "");
    c.ok("Photos: 'Delivered', the step bar all done", text(card(hC, "photos")).includes("Delivered") && (card(hC, "photos").match(/data-step="done"/g) ?? []).length === 4 && !/data-step="now"/.test(card(hC, "photos")));
    c.ok("Video: 'Not cut · John', the bar at Edited, the video listed 'Not cut yet · John'",
      text(card(hC, "video")).includes("Not cut · John") && /aria-current="step"[^>]*data-step="now"[^>]*>[\s\S]*?Edited/.test(card(hC, "video")) && text(card(hC, "video")).includes("Not cut yet · John"));
    const pc = text(card(hC, "photos"));
    const vc = text(card(hC, "video"));
    c.ok("photo requests with their owners: the photo and the both one 'Kyle · photo editing', the unclear one 'Needs an owner'",
      pc.includes("Brighten the kitchen photos") && pc.includes("Lot lines on everything") && (pc.match(/Kyle · photo editing/g) ?? []).length === 2 && pc.includes("Make the backyard pop") && pc.includes("Needs an owner") && !pc.includes("Use the upbeat song"), pc);
    c.ok("video requests with their owners: 'John · video editing' twice, the unclear one 'Needs an owner'",
      vc.includes("Use the upbeat song") && (vc.match(/John · video editing/g) ?? []).length === 2 && vc.includes("Needs an owner") && !vc.includes("Brighten the kitchen"), vc);
    c.ok("the picker on the unclear request (Photos, Video, Both), one Checked per card",
      (hC.match(new RegExp(`data-owner-picker="${cUnclear!.id}"`, "g")) ?? []).length === 2 && /Photos<\/button>[\s\S]*Video<\/button>[\s\S]*Both<\/button>/.test(hC) && (hC.match(/data-job-checked/g) ?? []).length === 2);
    c.ok("the order note and the scheduling ask are not requests here; the owner sees the amount", !/Ordered: Lot Lines/.test(tC) && !/move the next shoot/.test(tC) && /\$350k/.test(tC));
    const dCnoCheck = html(createElement(JobDeliverablesView, { ...dC, canCheck: false }));
    c.ok("someone who may not press: no picker, no button, 'Kyle checks these before the photos go out.'",
      !/data-owner-picker/.test(dCnoCheck) && !/data-job-checked/.test(dCnoCheck) && text(dCnoCheck).includes("Kyle checks these before the photos go out.") && text(dCnoCheck).includes("Kyle checks these before the video goes out."));
    me = user("ADMIN");
    const kyleC = html(createElement(JobDeliverablesView, (await loadJobDeliverables(C))!));
    c.ok("Kyle sees no amount ('under [amount]' style)", !/\$/.test(text(kyleC)) && /\[amount\]/.test(text(kyleC)));
    me = user("OWNER");
    const hH = html(createElement(JobDeliverablesView, (await loadJobDeliverables(H))!));
    c.ok("before the shoot: every request is the creative's ('Harrison · at the shoot'), the note says so",
      (text(hH).match(/Harrison · at the shoot/g) ?? []).length >= 3 && !/Needs an owner/.test(text(hH)) && text(hH).includes("Requests go to Harrison at the shoot, then to editing.") && /data-step="now"[^>]*>[\s\S]*?Shot/.test(hH));
    c.ok("…the unclear one can still be placed ahead of time (the picker)", hH.includes(`data-owner-picker="${hUnclear!.id}"`));
    const dA = (await loadJobDeliverables(A))!;
    const hA = html(createElement(JobDeliverablesView, dA));
    c.ok("photo only: '3 photos · 1 flagged' (a low-confidence one left out), opening the photo job; the video card says none",
      text(hA).includes("3 photos · 1 flagged") && hA.includes(`href="/ops/photo-delivery/${pjA.id}"`) && text(card(hA, "video")).includes("No video on this job.") && text(card(hA, "video")).includes("Not ordered"), text(hA).slice(0, 400));
    const hB = html(createElement(JobDeliverablesView, (await loadJobDeliverables(B))!));
    c.ok("video only: 'In review', the video with its version ('Version 2 in review') and the player's link",
      text(card(hB, "video")).includes("In review") && text(hB).includes("Version 2 in review") && /href="\/review\/[^"?]+\?cut=[^"]+"/.test(hB) && text(card(hB, "photos")).includes("No photos on this job."));
    const dI = (await loadJobDeliverables(I))!;
    const hI = html(createElement(JobDeliverablesView, dI));
    c.ok("ready to send: 'Version 1 approved, ready to send', the room's button or the way to the room",
      text(hI).includes("Version 1 approved, ready to send") && (/data-send-in-room/.test(hI) || /Upload to Aryeo and send/.test(hI)) && hI.includes(`?cut=${iCut.id}`) && /Ready:now|aria-current="step"[^>]*data-step="now"[^>]*>[\s\S]*?Ready/.test(hI));
    const hD = html(createElement(JobDeliverablesView, (await loadJobDeliverables(D))!));
    c.ok("monthly: the bar skips Ready, the photos say n/a, 'approved videos go to the client's portal'",
      !/>Ready</.test(card(hD, "video")) && /data-step="[a-z]+"[^>]*>[\s\S]*?Sent/.test(card(hD, "video")) && text(card(hD, "photos")).includes("n/a") && text(hD).includes("approved videos go to the client's portal"));
    c.ok("no em dash, undefined or NaN on any card", [hC, hH, hA, hB, hI, hD].every((x) => !DASH.test(x) && !/undefined|NaN/.test(text(x))));
    const projectSrc = fs.readFileSync("src/app/projects/[id]/page.tsx", "utf8");
    c.ok("the project page puts the two cards first, above the Client section, and keeps the rest",
      /<JobDeliverablesSection projectId=\{project\.id\} \/>/.test(projectSrc) && projectSrc.indexOf("<JobDeliverablesSection") < projectSrc.indexOf('title="Client"') &&
      ["Ordered deliverables", "Open tasks", "Billing", "Checklist", "Activity & notes", "Special requests", "Order & schedule", "Linked jobs"].every((s) => projectSrc.includes(s)));

    // =========================================================================
    c.head("5 · the needs-an-owner picker");
    // =========================================================================
    const { setJobRequestMedium, confirmJobRequests } = await import("@/app/jobs/actions");
    process.env.AUTH_ENFORCE = "true";
    me = user("OWNER", { impersonating: true, role: "ADMIN" });
    const refused = await setJobRequestMedium(cUnclear!.id, "video");
    c.ok("view as: refused, nothing changed", !refused.ok && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: cUnclear!.id } })).medium === "unclear", refused.message);
    me = user("PHOTOGRAPHER", { name: "Harrison Wells", realName: "Harrison Wells" });
    c.ok("a photographer with no review seat: refused", !(await setJobRequestMedium(cUnclear!.id, "video")).ok);
    me = user("ADMIN");
    c.ok("a bad id or medium: refused in plain words", !(await setJobRequestMedium("x", "video")).ok && !(await setJobRequestMedium(cUnclear!.id, "audio" as never)).ok && /Pick photos, video or both/.test((await setJobRequestMedium(cUnclear!.id, "unclear" as never)).message));
    const set = await setJobRequestMedium(cUnclear!.id, "video");
    const row1 = await prisma.clientAsk.findUniqueOrThrow({ where: { id: cUnclear!.id } });
    c.ok("set: it is about the video now, with who and when on its history and one timeline line",
      set.ok && /the video/.test(set.message) && row1.medium === "video" && /Kyle Smith/.test(row1.historyJson ?? "") && /set to the video/.test(row1.historyJson ?? "") &&
      (await prisma.activity.count({ where: { projectId: C, body: { startsWith: "Client request put on the video by Kyle Smith" } } })) === 1, set.message);
    c.ok("…pressed again: nothing changed", /Nothing changed/.test((await setJobRequestMedium(cUnclear!.id, "video")).message));
    const after = (await loadJobDeliverables(C))!;
    const hAfter = html(createElement(JobDeliverablesView, after));
    c.ok("the owner follows: on the video card as 'John · video editing', gone from the photos, no picker left",
      after.video.requests.some((r) => r.id === cUnclear!.id && r.owner?.label === "John · video editing") && !after.photo.requests.some((r) => r.id === cUnclear!.id) && !hAfter.includes(`data-owner-picker="${cUnclear!.id}"`));
    c.ok("…and the Shoots row: nothing needs an owner, 3 on the video", JSON.stringify((await jb.jobsBoard(new Date())).rows.find((r) => r.projectId === C)?.requests) === JSON.stringify({ open: 4, photo: 2, video: 3, needsOwner: 0 }));
    const closedPress = await confirmJobRequests(C, "photo");
    c.ok("Checked (kept) still confirms the photo card's requests", closedPress.ok && /Checked 2 requests/.test(closedPress.message), closedPress.message);
    c.ok("a closed request cannot be moved", /already closed/.test((await setJobRequestMedium(cPhoto!.id, "video")).message) && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: cBoth!.id } })).medium === "both");
    void cVideo;
    delete process.env.AUTH_ENFORCE;

    // =========================================================================
    c.head("6 · /pipeline redirects to /jobs");
    // =========================================================================
    // Oct 20 2026 (audit H18): a next.config redirect now, not a page.
    const { configRedirect } = await import("./_configRedirect");
    c.ok("/pipeline → /jobs, and /pipeline?test=1 → /jobs?test=1", (await configRedirect("/pipeline")) === "/jobs" && (await configRedirect("/pipeline", { test: "1" })) === "/jobs?test=1");
    c.ok("…and no page is left at /pipeline to render instead", !fs.existsSync("src/app/pipeline/page.tsx"));
    c.ok("the program watch actions stay where the Monthly view calls them", fs.existsSync("src/app/pipeline/actions.ts") && /from "@\/app\/pipeline\/actions"/.test(fs.readFileSync("src/components/tracker/ProgramVideoWatch.tsx", "utf8")));
    c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
