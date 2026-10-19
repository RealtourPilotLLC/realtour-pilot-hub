// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE VIDEO REVIEW ROOM (Jordan, Oct 19 2026). The REAL /review page
// rendered to HTML against seeded jobs, signed in as Kyle (ADMIN), and its
// buttons' server actions pressed for real (Aryeo is never reached: the hub's
// Aryeo login is deliberately not set up here, so a press shows the
// "cannot start" path).
//   1  the room renders: "Video Review Room", sections top to bottom with a
//      count in each heading: Ready to send, To review, Late, Due today, In
//      revision, Coming up, Monthly content; the counts are the board's
//   2  Ready to send: the button, the job's open client request (the press
//      asks first), Send all for the rows with none, the hand path folded
//      (open on a row the hub cannot send), never "the hub sends it"; the
//      delivery card's follow-up lanes under it (Needs a follow-up)
//   3  Late / Due today / In revision / Coming up: who holds each video and
//      the right button (Remind reviewer, Remind editor, none for not shot)
//   4  button only: rendering and the cron start nothing; a press with no
//      Aryeo login writes a FAILED run that says why; a press on a job with an
//      open request is refused until it is checked
//   5  Remind: recipient (editor / reviewer / nobody), the message (street, how
//      late, the link, "you"), the bell row, the team message, once every 4
//      hours, "Reminded 1m ago by you" on the row; view-as refused
//   6  the photo media checks moved to Photo Delivery; /ops/video-delivery
//      redirects here
//   7  copy: says "you", never "Kyle", no em or en dash in the new sections,
//      nothing says undefined or NaN
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7323). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import type { ReactElement } from "react";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1" }), { status: 200, headers: { "content-type": "application/json" } }) : null));
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
  nav.usePathname = () => "/review";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 7323);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LONG_DASH = /[–—]/;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
/** The text between two section headings (h2). */
const between = (h: string, from: string, to: string | null) => {
  const t = text(h);
  const a = t.indexOf(` ${from} `);
  const b = to ? t.indexOf(` ${to} `, a + 1) : t.length;
  return a >= 0 && b > a ? t.slice(a, b) : "";
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "oct19-video-review-room" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret, disconnect } = await import("@/lib/integrations/connections");
    // The hub's Aryeo login is set up (so the room offers the button); section 4 takes it away before pressing.
    await saveSecret("aryeo_web", "drill-hub-password", { accountLabel: "hub@drill.test", metadata: { email: "hub@drill.test" } });
    const { putSetting } = await import("@/lib/settings");
    const T = Date.now();

    // ---- the people ----
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const jordan = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@drill.test", role: "OWNER", status: "ACTIVE" } });
    const kim = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.test", role: "EDITOR", slackId: "UKIM" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Rivera", email: "james@drill.test", role: "ADMIN" } });
    await prisma.appUser.create({ data: { name: "James Rivera", email: "james@drill.test", role: "ADMIN", status: "ACTIVE", teamMemberId: jamesTm.id } });
    await putSetting("review_room", { creativeApproverTeamMemberId: jamesTm.id }, "drill");
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    await as(kyle);

    // ---- the jobs ----
    const client = await prisma.client.create({ data: { name: "Room Agent Realty" } });
    let n = 0;
    const mk = async (street: string, opts: { status?: string; pin?: Date; shoot?: Date } = {}) => {
      const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: (opts.status ?? "REVIEW") as never, aryeoListingId: `L-${++n}`, aryeoOrderId: `O-${n}`, shootDate: opts.shoot ?? new Date(T - 2 * DAY), promisedDueAt: opts.pin ?? null } });
      await prisma.orderItem.create({ data: { projectId: p.id, title: "Cinematic Video", amount: 150 } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", quantity: 1, productTitle: "Cinematic Video" } });
      await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: 1, category: "VIDEO" } });
      return { p, d };
    };
    const approve = async (j: { p: { id: string }; d: { id: string } }, street: string, opts: { topaz?: "done" | "failed" } = {}) => {
      const sub = await prisma.reviewSubmission.create({ data: { projectId: j.p.id, deliverableId: j.d.id, slot: 1, round: 1, status: "APPROVED", fileName: `${street}.mp4`, blobUrl: `https://drill.invalid/${encodeURIComponent(street)}.mp4`, sizeBytes: 1000, decidedAt: new Date(T - HOUR), decidedBy: "James Rivera" } });
      await prisma.topazJob.create({ data: { submissionId: sub.id, projectId: j.p.id, state: opts.topaz ?? "done", fileName: sub.fileName, sourceDurationSec: 60, sourceSizeBytes: 113_000_000, savedAt: opts.topaz === "failed" ? null : new Date(T - 30 * 60_000), finalPath: opts.topaz === "failed" ? null : `/Listings/${street}/05-Final-Video/${street} - FINAL (Topaz).mp4`, outputCheck: opts.topaz === "failed" ? null : "verified", error: opts.topaz === "failed" ? "Topaz could not read the file." : null } });
      return sub.id;
    };
    const R1 = await mk("1 Request Rd", { pin: new Date(T - 3 * HOUR) });
    const r1 = await approve(R1, "1 Request Rd");
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: R1.p.id, kind: "SPECIAL_REQUEST", medium: "video", text: "Please show the new deck first.", summary: "Show the new deck first", source: "text", askedBy: "Agent", askedAt: new Date(T - 5 * HOUR), state: "OPEN", holdsDelivery: true } });
    const R2 = await mk("2 Ready Ave");
    const r2 = await approve(R2, "2 Ready Ave");
    const R3 = await mk("3 Ready Ct");
    const r3 = await approve(R3, "3 Ready Ct");
    const R4 = await mk("4 Editor File Ln");
    await approve(R4, "4 Editor File Ln", { topaz: "failed" });
    const L5 = await mk("5 Late Review St", { status: "REVIEW", pin: new Date(T - 26 * HOUR) });
    const l5 = await prisma.reviewSubmission.create({ data: { projectId: L5.p.id, deliverableId: L5.d.id, slot: 1, round: 1, status: "PENDING", fileName: "late-review.mp4", blobUrl: "https://drill.invalid/l5.mp4", assetUrl: "https://drill.invalid/l5.mp4", sizeBytes: 1000, submittedByKey: "kim", reviewerTeamMemberId: jamesTm.id } });
    const L6 = await mk("6 Late Edit Way", { status: "EDITING", pin: new Date(T - 50 * HOUR), shoot: new Date(T - 5 * DAY) });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit 6 Late Edit Way", projectId: L6.p.id, assignedKey: "kim", status: "OPEN" } });
    await mk("7 Not Shot Rd", { status: "SCHEDULED", pin: new Date(T - 2 * HOUR), shoot: new Date(T - 3 * DAY) });
    const { etDayKey, etAt } = await import("@/lib/datetime");
    const tonight = etAt(etDayKey(new Date()), 23, 0);
    const canTestToday = tonight.getTime() - Date.now() > 30 * 60_000;
    if (canTestToday) await mk("8 Today Terrace", { status: "EDITING", pin: new Date(Math.min(tonight.getTime() - 5 * 60_000, Date.now() + 20 * 60_000)) });
    const V9 = await mk("9 Revision Pl", { status: "REVISION" });
    const v9 = await prisma.reviewSubmission.create({ data: { projectId: V9.p.id, deliverableId: V9.d.id, slot: 1, round: 2, status: "CHANGES_REQUESTED", fileName: "revision-v2.mp4", blobUrl: "https://drill.invalid/v9.mp4", assetUrl: "https://drill.invalid/v9.mp4", sizeBytes: 1000, submittedByKey: "kim", decidedAt: new Date(T - 2 * DAY), decidedBy: "James Rivera" } });
    await prisma.smartTask.create({ data: { taskType: "revision", title: "Revision 9 Revision Pl", projectId: V9.p.id, assignedKey: "kim", status: "OPEN" } });
    await mk("10 Future Blvd", { status: "SCHEDULED", shoot: new Date(T + 2 * DAY) });
    // Kyle's photo media check (moves to Photo Delivery).
    const qcJob = await prisma.project.create({ data: { title: "11 Photo Check Rd, Media, PA", clientId: client.id, status: "REVIEW" } });
    await prisma.smartTask.create({ data: { projectId: qcJob.id, taskType: "media_qa", title: "Check 11 Photo Check Rd", assignedKey: "kyle" } });

    // A delivery text whose outcome is unknown (the delivery card's follow-up lane, now in the room).
    const notice = await prisma.outboxMessage.create({ data: { projectId: R3.p.id, channel: "sms", toRef: "2025550190", body: "Isolated receipt", dedupeKey: `delivery:${R3.p.id}`, state: "unknown" } });
    const { default: Page } = await import("@/app/review/page");
    const render = async () => html(await Page({ searchParams: Promise.resolve({}) }));
    const runs = () => prisma.appSetting.count({ where: { key: { startsWith: "video_aryeo_push:" } } });

    // ======================================================================
    c.head("1 · the room renders, sections in order, a count in each heading");
    let h = "";
    try {
      h = await render();
      c.ok("the Video Review Room renders for Kyle", h.length > 2000, `${h.length} chars`);
    } catch (e) {
      c.ok("the Video Review Room renders for Kyle", false, String((e as Error)?.stack ?? e).slice(0, 800));
    }
    const t = text(h);
    c.ok("the header says Video Review Room", /Video Review Room/.test(t) && !/>Review Room</.test(h.replace(/Video Review Room/g, "")), t.slice(0, 200));
    const order = ["Ready to send", "To review", "Late", "Due today", "In revision", "Coming up", "Monthly content"];
    const at = order.map((s) => h.indexOf(`>${s}</h2>`));
    c.ok("sections top to bottom: Ready to send, To review, Late, Due today, In revision, Coming up, Monthly content", at.every((x) => x > 0) && at.every((x, i) => i === 0 || x > at[i - 1]), JSON.stringify(at));
    const { videoDeliveryBoard, dueTodayRows } = await import("@/lib/videoDelivery");
    const board = await videoDeliveryBoard({ fresh: true });
    const countOf = (title: string) => Number((new RegExp(`>${title}</h2><span[^>]*>(\\d+)<`).exec(h) ?? [])[1] ?? NaN);
    c.ok("Ready to send's count is the ready rows (approved, file ready)", countOf("Ready to send") === board.lanes.sending.length && board.lanes.sending.length === 4, `${countOf("Ready to send")} / ${board.lanes.sending.length}`);
    c.ok("Late's count is the late lane", countOf("Late") === board.lanes.late.length && board.lanes.late.length === 3, `${countOf("Late")} / ${board.lanes.late.map((r) => r.street)}`);
    c.ok("Due today's count is every video due by tonight, the late ones included", countOf("Due today") === dueTodayRows(board).length && countOf("Due today") === board.counts.dueToday && countOf("Due today") >= board.lanes.late.length + 1, `${countOf("Due today")} / ${board.counts.dueToday}`);
    c.ok("In revision and Coming up counted", countOf("In revision") === 1 && countOf("Coming up") >= 1 && countOf("To review") === 1, `${countOf("In revision")} ${countOf("Coming up")} ${countOf("To review")}`);
    c.ok("the subtitle sums it up with Home's numbers (late = every listing video past its promise, the approved ones too)", new RegExp(`${board.lanes.sending.length} ready to send · ${board.counts.lateListing} late · ${board.counts.dueToday} due today`).test(t) && board.counts.lateListing === board.lanes.late.length + 1, t.slice(0, 200));
    c.ok("Late points at the approved late one under Ready to send", /Also late, already approved: 1 Request Rd\. It is under Ready to send\./.test(t));

    // ======================================================================
    c.head("2 · Ready to send, and Needs a follow-up under it");
    const fuAt = h.indexOf(">Needs a follow-up</h2>");
    c.ok("Needs a follow-up sits between Ready to send and To review, with the delivery card's own rows (the unknown delivery text, its conversation link)", fuAt > h.indexOf(">Ready to send</h2>") && fuAt < h.indexOf(">To review</h2>") && /Delivery texts needing a check/.test(h) && h.includes(`incident=${encodeURIComponent(notice.id)}`) && countOf("Needs a follow-up") === 1, String(fuAt));
    const ready = between(h, "Ready to send", "To review");
    c.ok("each ready row has Upload to Aryeo and send", (ready.match(/Upload to Aryeo and send/g) ?? []).length === 3, ready.slice(0, 400));
    c.ok("the hand path is folded under each row (Done it by hand?), open on the row the hub cannot send", (ready.match(/Done it by hand\?/g) ?? []).length === 4 && /4 Editor File Ln/.test(ready) && /editor's own file/.test(ready) && /<details[^>]*open=""[^>]*>\s*<summary[^>]*>Done it by hand\?/.test(h));
    c.ok("Send all, for the rows with no open request (2 and 3, not 1)", /Send all \(2\)/.test(ready));
    c.ok("approver and when, and late ones marked", /Approved .* by James Rivera/.test(ready) && /1 Request Rd .*Late/.test(ready));
    c.ok("never says the hub sends a video nobody pressed", !/hub sends|next pass|by itself to Aryeo/i.test(ready));

    // ======================================================================
    c.head("3 · who holds each waiting video, and the right button");
    const late = between(h, "Late", "Due today");
    c.ok("a version waiting on review: Waiting on James Rivera's review, Remind reviewer", /5 Late Review St.*Waiting on James Rivera's review\..*Remind reviewer/.test(late), late.slice(0, 600));
    c.ok("a video with the editor: With Kim, Remind editor", /6 Late Edit Way.*With Kim\..*Remind editor/.test(late));
    c.ok("not shot yet: says so, no button", /7 Not Shot Rd.*Not shot yet\./.test(late) && (late.match(/Remind (editor|reviewer)/g) ?? []).length === 2);
    const due = between(h, "Due today", "In revision");
    c.ok("Due today lists the late ones too, marked Late, the late ones first", /5 Late Review St/.test(due) && /6 Late Edit Way/.test(due) && /Late/.test(due) && (!canTestToday || (/8 Today Terrace/.test(due) && due.indexOf("8 Today Terrace") > due.indexOf("6 Late Edit Way"))));
    const rev = between(h, "In revision", "Coming up");
    c.ok("In revision: the sent-back version, how long ago and by whom, who has it, Remind editor (over a day)", /revision-v2\.mp4/.test(rev) && /Sent back by James/.test(rev) && /With Kim\./.test(rev) && /Remind editor/.test(rev) && new RegExp(`cut=${v9.id}`).test(h), rev.slice(0, 500));
    const coming = between(h, "Coming up", "Monthly content");
    c.ok("Coming up: the future job", /10 Future Blvd/.test(coming) && !/9 Revision Pl/.test(coming));
    c.ok("Monthly content: only the late ones (none here)", /No monthly video is late/.test(between(h, "Monthly content", null)));

    // ======================================================================
    c.head("4 · button only");
    c.ok("rendering the room started nothing", (await runs()) === 0);
    const V = await import("@/lib/videoAryeoPush");
    await V.driveVideoPushes({ budgetMs: 20_000 });
    c.ok("a cron pass started nothing", (await runs()) === 0);
    const { sendVideoToAryeoAction, sendAllVideosAction, remindVideoAction } = await import("@/app/review/videoSendActions");
    await disconnect("aryeo_web");
    const p2 = await sendVideoToAryeoAction(r2);
    const run2 = await V.videoPushRun(r2);
    c.ok("a press with no Aryeo login: a FAILED run that says why (nothing sent)", !p2.ok && run2?.state === "FAILED" && /Aryeo login is not set up/.test(run2.note ?? "") && run2.by === "Kyle Smith", `${p2.message} · ${run2?.state}`);
    const h2 = await render();
    const ready2 = between(h2, "Ready to send", "To review");
    c.ok("…the row shows it with Try again", /2 Ready Ave/.test(ready2) && /Aryeo login is not set up/.test(ready2) && /Try again/.test(ready2), ready2.slice(0, 300));
    const p1plain = await sendVideoToAryeoAction(r1);
    const run1plain = await V.videoPushRun(r1);
    c.ok("a press on a job with an open request that was not checked never uploads it", !p1plain.ok && (!run1plain || run1plain.state === "FAILED" || (run1plain.state === "HELD" && run1plain.hold?.gate === "asks")) && !run1plain?.mediaId, `${p1plain.message} · ${run1plain?.state}`);
    const p1 = await sendVideoToAryeoAction(r1, { checkedRequests: true });
    const askAfter = await prisma.clientAsk.findFirst({ where: { projectId: R1.p.id } });
    const refusedByConfirm = /could not be marked checked/.test(p1.message);
    c.ok("'Checked, upload and send' goes through the job box's confirm first, then the press (here: no login, so it stops and says why)", !p1.ok && (refusedByConfirm ? askAfter?.state === "OPEN" : askAfter?.state !== "OPEN" && /Aryeo login is not set up/.test(p1.message)), `${p1.message} · ask ${askAfter?.state}`);
    const all = await sendAllVideosAction([r3]);
    c.ok("Send all presses each one (here: refused the same honest way, no login)", !all.ok && /could not start/.test(all.message) && (await V.videoPushRun(r3))?.state === "FAILED", all.message);
    await as(jordan, kyle.id);
    const viewAs = await sendVideoToAryeoAction(r3);
    c.ok("view-as cannot press it", !viewAs.ok && /previewing another user/.test(viewAs.message), viewAs.message);
    await as(kyle);

    // ======================================================================
    c.head("5 · Remind editor / Remind reviewer");
    const lateRow = board.lanes.late.find((r) => r.street === "6 Late Edit Way")!;
    const rem = await remindVideoAction({ key: lateRow.key, projectId: lateRow.projectId, submissionId: null });
    c.ok("Remind editor reaches Kim", rem.ok && rem.to === "Kim" && /^Reminded Kim/.test(rem.message), rem.message);
    const bell = await prisma.notification.findFirst({ where: { userKey: "editor:kim" }, orderBy: { createdAt: "desc" } });
    c.ok("her bell row: the street, how late, first job today", !!bell && /^6 Late Edit Way's video is 2 days late: please do it first today$/.test(bell.title) && bell.href === `/edit/${L6.p.id}`, bell?.title);
    const msg = await prisma.projectMessage.findFirst({ where: { projectId: L6.p.id }, orderBy: { createdAt: "desc" } });
    c.ok("a note in the job's team messages, on the record (and on the editor brief)", !!msg && msg.authorName === "Kyle Smith" && msg.authorId === kyleTm.id && /6 Late Edit Way's video is 2 days late for the client\. Please make it your first job today and upload it as soon as it's ready\. If something is in the way, reply in the job's team messages\./.test(msg.body) && msg.body.includes(`/edit/${L6.p.id}`) && JSON.parse(msg.mentions ?? "[]").includes(kim.id), msg?.body);
    c.ok("the message has no em or en dash", !LONG_DASH.test(msg?.body ?? "—") && !LONG_DASH.test(bell?.title ?? "—"));
    const again = await remindVideoAction({ key: lateRow.key, projectId: lateRow.projectId, submissionId: null });
    c.ok("a second press within 4 hours is refused, saying when and by whom (you)", !again.ok && /^Kim was reminded \d+m ago by you\. You can remind them again after/.test(again.message) && (await prisma.projectMessage.count({ where: { projectId: L6.p.id } })) === 1, again.message);
    const h3 = await render();
    c.ok("the row says 'Reminded …ago by you.' and the button is gone", /6 Late Edit Way.*With Kim\. Reminded \d+m ago by you\./.test(between(h3, "Late", "Due today")) && (between(h3, "Late", "Due today").match(/Remind editor/g) ?? []).length === 0);
    await prisma.appSetting.update({ where: { key: `video_remind:${lateRow.key}` }, data: { value: JSON.stringify({ at: new Date(Date.now() - 4 * HOUR - 60_000).toISOString(), by: "Kyle Smith", to: "Kim", kind: "editor" }) } });
    const later = await remindVideoAction({ key: lateRow.key, projectId: lateRow.projectId, submissionId: null });
    c.ok("after 4 hours it can go again", later.ok, later.message);
    const revRem = await remindVideoAction({ key: v9.id, projectId: V9.p.id, submissionId: v9.id });
    const revMsg = await prisma.projectMessage.findFirst({ where: { projectId: V9.p.id }, orderBy: { createdAt: "desc" } });
    c.ok("In revision: Remind editor says how long it has been back with them", revRem.ok && /9 Revision Pl's video has been back with you for changes for 2 days\./.test(revMsg?.body ?? ""), `${revRem.message} · ${revMsg?.body}`);
    const l5Row = board.lanes.late.find((r) => r.street === "5 Late Review St")!;
    const revw = await remindVideoAction({ key: l5Row.key, projectId: l5Row.projectId, submissionId: l5.id });
    const jamesBell = await prisma.notification.findFirst({ where: { userKey: `tm:${jamesTm.id}` }, orderBy: { createdAt: "desc" } });
    c.ok("Remind reviewer reaches the reviewer who holds it (James), on the cut", revw.ok && revw.to === "James Rivera" && /please review it first today$/.test(jamesBell?.title ?? "") && jamesBell?.href === `/review/${L5.p.id}?cut=${l5.id}`, `${revw.message} · ${jamesBell?.title}`);
    const notShot = board.lanes.late.find((r) => r.street === "7 Not Shot Rd")!;
    const ns = await remindVideoAction({ key: notShot.key, projectId: notShot.projectId, submissionId: null });
    c.ok("a video not shot yet: nobody to remind, it says so", !ns.ok && /Not shot yet/.test(ns.message), ns.message);
    const forged = await remindVideoAction({ key: lateRow.key, projectId: L5.p.id, submissionId: null });
    c.ok("a key that is not that job's video is refused", !forged.ok, forged.message);
    await as(jordan, kyle.id);
    const va = await remindVideoAction({ key: notShot.key, projectId: notShot.projectId, submissionId: null });
    c.ok("view-as cannot remind", !va.ok && /previewing another user/.test(va.message));
    await as(kyle);
    // The holder rules, one by one (lib/remindEditor).
    const { remindStatesFor, remindMessage } = await import("@/lib/remindEditor");
    const st = await remindStatesFor([{ key: l5.id, projectId: L5.p.id, submissionId: l5.id, street: "5 Late Review St", promiseISO: null, late: true, dueToday: true }], { viewerTeamMemberId: jamesTm.id });
    c.ok("the reviewer looking at their own waiting cut is not offered a button ('Waiting on your review.')", st.get(l5.id)?.target.kind === "none" && /Waiting on your review/.test((st.get(l5.id)!.target as { waitsOn: string }).waitsOn));
    const m3h = remindMessage({ street: "1 A St", promiseISO: new Date(Date.now() - 3 * HOUR).toISOString(), late: true, dueToday: true, kind: "editor", link: "https://hub/edit/x", now: new Date() });
    c.ok("hours under a day read as hours", /^1 A St's video is 3 hours late for the client\./.test(m3h.sentence), m3h.sentence);

    // ======================================================================
    c.head("6 · the photo media checks moved; the old screen redirects");
    const h4 = await render();
    c.ok("the room no longer carries the photo media checks", !/Media checks to finish/.test(h4) && !/11 Photo Check Rd/.test(h4) && !/Delivery checks/.test(h4));
    const { default: PhotoPage } = await import("@/app/ops/photo-delivery/page");
    let ph = "";
    try {
      ph = html(await PhotoPage({ searchParams: Promise.resolve({}) }));
    } catch (e) {
      ph = `ERROR ${String((e as Error)?.stack ?? e).slice(0, 400)}`;
    }
    c.ok("Photo Delivery shows them (Media checks to finish, the job)", /Media checks to finish/.test(ph) && /11 Photo Check Rd/.test(ph), ph.slice(0, 300));
    const { default: Old } = await import("@/app/ops/video-delivery/page");
    let to = "";
    try {
      Old();
    } catch (e) {
      to = e instanceof Redirect ? e.href : String(e);
    }
    c.ok("/ops/video-delivery redirects to /review", to === "/review", to);

    // ======================================================================
    c.head("7 · copy");
    const delivery = ["Ready to send", "Late", "Due today", "Coming up", "Monthly content"].map((s, i, a) => between(h4, s, a[i + 1] ?? null)).join(" ");
    c.ok("the delivery sections say 'you', never 'Kyle'", !/\bKyle\b/.test(delivery.replace(/Kyle Smith pressed/g, "")), (delivery.match(/.{40}\bKyle\b.{40}/) ?? [""])[0]);
    c.ok("no em or en dash in the new sections", !LONG_DASH.test(delivery), (delivery.match(/.{40}[–—].{40}/) ?? [""])[0]);
    c.ok("nothing rendered says undefined or NaN", !/\b(undefined|NaN)\b/.test(text(h4)));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
