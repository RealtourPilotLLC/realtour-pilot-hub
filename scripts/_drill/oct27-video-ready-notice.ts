// ---------------------------------------------------------------------------
// DRILL: a client hears the day a video reaches their portal, by email AND
// text (Oct 27 2026).
//
//   DRILL_PORT=5611 node scripts/_drill/run-all.cjs scripts/_drill/oct27-video-ready-notice.ts
//
// Jordan: "Email Joe and tell every client as soon as the video hits their
// portal. They should get a text too." Joe Sutow's Video 2 reached his portal
// at 7:59 PM on Oct 26 and the hub's first email about it was set for Wed Oct
// 28 9 AM: the review lane waited two business days after a release, while
// the client's four-business-day clock was already running. Nothing texted.
//
//   1. OLD (HEAD before this change): a cut released Monday 10 AM is first
//      emailed Wednesday.
//   2. NEW: emailed and texted at once; the text carries the email's own link,
//      lands in the client's text thread as the hub's words, and the window
//      reads "client told".
//   3. The follow-up comes two business days later, by email only.
//   4. An evening release waits for the 9 AM window; another program email
//      already sent that day does not hold the new video back.
//   5. A second video released while the first is mid-cadence is told at once.
//   6. No mobile number: the email still goes, the text row says why.
//   7. The policy and the copy.
//   8. Oct 30 (Mike Ciunci): a video on last month's job is still told, with
//      its own deadline; a stale version beside it is neither quoted nor
//      marked told; a past month with only an expired one sends nothing.
//   9. Oct 30: a snoozed month still hears about a new video; its own asks
//      stay snoozed.
//
// ISOLATION: PGlite via the shared harness; Gmail and OpenPhone are faked at
// the fetch fence; every "now" is passed explicitly.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { reviewWorldKit } from "../_fixtures/reviewWorld";

const PORT = Number(process.env.DRILL_PORT ?? 5611);
const BASE = "815dfb38";
const REPO = path.resolve(__dirname, "../..");

const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}
const wall = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "null");

installNextStubs();

// ---- fake Gmail + OpenPhone -------------------------------------------------
const mails: { to: string }[] = [];
const texts: { to: string; body: string }[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const head = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split("\r\n\r\n")[0];
    mails.push({ to: (/^To: (.+)$/m.exec(head)?.[1] ?? "").trim().toLowerCase() });
    return json({ id: `gm-${mails.length}` });
  }
  if (u.hostname === "api.openphone.com" && u.pathname.startsWith("/v1/phone-numbers")) return json({ data: [{ id: "PNdrill", number: "+12156454889", name: "Office" }] });
  if (u.hostname === "api.openphone.com" && u.pathname === "/v1/messages") {
    const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; content?: string };
    texts.push({ to: (b.to ?? []).join(","), body: b.content ?? "" });
    return json({ data: { id: `AC${texts.length}` } }, 202);
  }
  return null;
});

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-ready-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const R = await import("@/lib/programReminders");
  const T = await import("@/lib/reminderTemplates");
  const { JORDAN_TEST_PHONE_DIGITS } = await import("@/lib/testClients");
  const rw = await import("@/lib/reviewWindows");
  const oldR = await loadBase<typeof import("@/lib/programReminders")>("src/lib/programReminders.ts");
  const c = makeChecker();

  const staff = await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
  await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, payPercent: 0.35, payFloor: 100 } });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": ["drill", "refresh", "token"].join("-") }));
  await saveSecret("openphone", ["drill", "key", "not", "real"].join("-"));
  await prisma.programAutomation.upsert({ where: { key: "reminders" }, create: { key: "reminders", enabled: true, enabledBy: "drill", enabledAt: et(2026, 9, 1, 9) }, update: { enabled: true } });
  // Review deadlines on, as in production: the emails and texts quote them.
  await prisma.programAutomation.upsert({ where: { key: "revision_policy" }, create: { key: "revision_policy", enabled: true, enabledBy: "drill", enabledAt: et(2026, 9, 1, 9) }, update: { enabled: true } });

  const { world, mkCut } = await reviewWorldKit({ staffUserId: staff.id });
  const mk = async (name: string, phone: string | null = JORDAN_TEST_PHONE_DIGITS) => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const w = await world(name, { owner: { email: `info+drill-${slug}@realtourpilot.com`, name } });
    await prisma.client.update({ where: { id: w.f.clientId }, data: { phone } });
    return w;
  };
  type W = Awaited<ReturnType<typeof mk>>;
  const releaseAt = async (w: W, slot: number, at: Date) => {
    const s = await mkCut(w, slot, 1);
    await prisma.reviewSubmission.update({ where: { id: s }, data: { status: "APPROVED", decidedAt: at, decidedBy: "Jordan" } });
    return (await rw.openReviewWindow(s, { at }))!;
  };
  const review = async (mod: typeof R, w: W, now: Date) => (await mod.previewReminders(w.f.monthId, { now })).lanes.find((l) => l.lane === "REVIEW")!.candidate;
  const run = (w: W, now: Date) => R.evaluateReminders({ dryRun: false, enrollmentIds: [w.f.enrollmentId], reviewOnly: true, requestedBy: "portal-publication", now });
  const rows = (w: W) => prisma.programReminder.findMany({ where: { enrollmentId: w.f.enrollmentId }, orderBy: { createdAt: "asc" } });

  const MON_10 = et(2026, 10, 5, 10);
  const MON_1005 = et(2026, 10, 5, 10, 5);

  // =========================================================================
  c.head("1 · OLD: a Monday 10 AM release is first emailed on Wednesday");
  // =========================================================================
  const A = await mk("Ada Ready");
  const aw = await releaseAt(A, 1, MON_10);
  c.ok("the release opened a window with a 4-business-day deadline (Fri 5 PM)", aw.state === "OPEN" && aw.deadlineAt.getTime() === et(2026, 10, 9, 17).getTime(), `${aw.state} ${wall(aw.deadlineAt)}`);
  const oldA = await review(oldR, A, MON_1005);
  c.ok("OLD: five minutes later the review email waits until Wednesday", oldA.decision === "wait" && oldA.nextEligibleAt?.getTime() === et(2026, 10, 7, 0).getTime(), `${oldA.decision} ${wall(oldA.nextEligibleAt)} ${oldA.reason}`);

  // =========================================================================
  c.head("2 · NEW: emailed and texted at once");
  // =========================================================================
  const newA = await review(R, A, MON_1005);
  c.ok("NEW: five minutes later the review email is due", newA.decision === "send" && newA.action === "REVIEW_WORK" && newA.attempt === 1, `${newA.decision} ${newA.attempt} ${newA.reason}`);
  const m0 = mails.length, t0 = texts.length;
  const out = await run(A, MON_1005);
  c.ok("the review-only run sent exactly one email and one text", mails.length === m0 + 1 && texts.length === t0 + 1, `${mails.length - m0} email(s), ${texts.length - t0} text(s); ${JSON.stringify(out.sent)}`);
  c.ok("…the email to the seat, the text to the client's phone", mails[m0]?.to === "info+drill-adaready@realtourpilot.com" && texts[t0]?.to.endsWith(JORDAN_TEST_PHONE_DIGITS), `${mails[m0]?.to} / ${texts[t0]?.to}`);
  const aRows = await rows(A);
  c.ok("the ledger: REVIEW_WORK email SENT, then REVIEW_TEXT sms SENT, nothing else", aRows.map((r) => `${r.action}/${r.channel}/${r.state}`).join(" ") === "REVIEW_WORK/email/SENT REVIEW_TEXT/sms/SENT", aRows.map((r) => `${r.action}/${r.channel}/${r.state}`).join(" "));
  const emailBody = (await prisma.outboxMessage.findFirst({ where: { clientId: A.f.clientId, channel: "email" } }))?.body ?? "";
  const textBody = (await prisma.outboxMessage.findFirst({ where: { clientId: A.f.clientId, channel: "sms" } }))?.body ?? "";
  const textLink = /(https?:\/\/\S+)$/.exec(textBody)?.[1] ?? "";
  // The deadline is quoted only where the email quotes one (review deadlines on).
  const quoted = /Please review by (.+?) \(review windows/.exec(emailBody)?.[1] ?? null;
  c.ok("the email quotes the deadline (review deadlines are on)", quoted === "Fri, Oct 9, 5:00 PM ET", String(quoted));
  c.ok("the text's copy, quoting the email's deadline", textBody === `Hi Ada! Your new video is ready to review in your portal. Approve it or tell us what to change${quoted ? ` by ${quoted}` : ""}: ${textLink}`, textBody);
  c.ok("…its link is the email's own link (no second sign-in link minted)", !!textLink && emailBody.includes(textLink), `${textLink} in email: ${emailBody.includes(textLink)}`);
  c.ok("…and no em or en dashes", !/[–—]/.test(textBody));
  c.ok("the text reached OpenPhone with those words", texts[t0]?.body === textBody);
  const win = await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: aw.submissionId } });
  c.ok("the window now reads 'client told' at the send", win.clientNotifiedAt?.getTime() === MON_1005.getTime(), wall(win.clientNotifiedAt));
  const log = await prisma.commLog.findFirst({ where: { clientId: A.f.clientId, channel: "text" } });
  c.ok("the client's text thread shows it, as the hub's own words", log?.direction === "out" && log.source === "auto-video-ready" && log.body === textBody && log.externalId === "op-AC1", `${log?.direction} ${log?.source} ${log?.externalId}`);
  const again = await run(A, et(2026, 10, 5, 10, 30));
  c.ok("a second run that morning sends nothing more", mails.length === m0 + 1 && texts.length === t0 + 1, JSON.stringify(again.sent));

  // =========================================================================
  c.head("3 · the follow-up: two business days later, email only");
  // =========================================================================
  const fu = await review(R, A, et(2026, 10, 5, 11));
  c.ok("after Monday's notice, the next is Wednesday", fu.decision === "wait" && fu.nextEligibleAt?.getTime() === et(2026, 10, 7, 0).getTime(), `${fu.decision} ${wall(fu.nextEligibleAt)}`);
  c.ok("…and says 2 weekdays after the last one sent", /2 weekdays after the last one actually sent/.test(fu.reason), fu.reason);
  const m1 = mails.length, t1 = texts.length;
  await run(A, et(2026, 10, 7, 9, 5));
  c.ok("Wednesday 9:05: the follow-up email goes, with no text", mails.length === m1 + 1 && texts.length === t1, `${mails.length - m1} email(s), ${texts.length - t1} text(s)`);
  c.ok("…still one REVIEW_TEXT row", (await prisma.programReminder.count({ where: { enrollmentId: A.f.enrollmentId, action: "REVIEW_TEXT" } })) === 1);
  const third = await review(R, A, et(2026, 10, 7, 10));
  c.ok("the third (and last) is due Friday, deadline day", third.nextEligibleAt?.getTime() === et(2026, 10, 9, 0).getTime(), `${third.decision} ${wall(third.nextEligibleAt)} ${third.reason}`);

  // =========================================================================
  c.head("4 · an evening release waits for 9 AM; an earlier email does not hold it");
  // =========================================================================
  const B = await mk("Bea Evening");
  await releaseAt(B, 1, et(2026, 10, 5, 19, 59));
  const eve = await review(R, B, et(2026, 10, 5, 20, 5));
  c.ok("Monday 8:05 PM: waits for Tuesday 9 AM", eve.decision === "wait" && eve.nextEligibleAt?.getTime() === et(2026, 10, 6, 9).getTime(), `${eve.decision} ${wall(eve.nextEligibleAt)} ${eve.reason}`);
  const m2 = mails.length, t2 = texts.length;
  await run(B, et(2026, 10, 5, 20, 5));
  c.ok("…and the evening run sends nothing", mails.length === m2 && texts.length === t2);
  await run(B, et(2026, 10, 6, 9, 1));
  c.ok("Tuesday 9:01: email and text", mails.length === m2 + 1 && texts.length === t2 + 1, `${mails.length - m2} / ${texts.length - t2}`);

  const C = await mk("Cal Busy");
  await prisma.programReminder.create({ data: { enrollmentId: C.f.enrollmentId, clientId: C.f.clientId, monthId: C.f.monthId, monthKey: "2026-10", action: "BOOK_SESSION", templateKey: "reminder.book_session.v3", state: "SENT", sentAt: et(2026, 10, 5, 9, 1), attempt: 1, channel: "email", dedupeKey: `${C.f.enrollmentId}:2026-10:BOOK_SESSION:1` } });
  await releaseAt(C, 1, MON_10);
  const busy = await review(R, C, MON_1005);
  c.ok("a booking email went at 9:01; the 10 AM video is still told at once", busy.decision === "send", `${busy.decision} ${busy.reason}`);
  await prisma.programReminder.create({ data: { enrollmentId: C.f.enrollmentId, clientId: C.f.clientId, monthId: C.f.monthId, monthKey: "2026-10", action: "REVIEW_WORK", templateKey: "reminder.review_work.v2", state: "SENT", sentAt: MON_1005, attempt: 1, channel: "email", dedupeKey: `${C.f.enrollmentId}:2026-10:REVIEW_WORK:r20261005:1` } });
  const capFollow = await review(R, C, et(2026, 10, 7, 9, 5));
  c.ok("…while a follow-up still keeps the one-a-day rule (a second program email that day waits)", capFollow.decision === "send", `${capFollow.decision} ${capFollow.reason}`);

  // =========================================================================
  c.head("5 · a second video mid-cadence is told at once");
  // =========================================================================
  const D = await mk("Dee Double");
  await releaseAt(D, 1, MON_10);
  await run(D, MON_1005);
  const d2 = await releaseAt(D, 2, et(2026, 10, 6, 10));
  const oldD = await review(oldR, D, et(2026, 10, 6, 10, 5));
  c.ok("OLD: Tuesday's video waits for Monday's follow-up", oldD.decision !== "send", `${oldD.decision} ${wall(oldD.nextEligibleAt)} ${oldD.reason}`);
  const newD = await review(R, D, et(2026, 10, 6, 10, 5));
  c.ok("NEW: Tuesday's video is told at once, under its own release day", newD.decision === "send" && /:REVIEW_WORK:r20261006:/.test(newD.dedupeKey ?? ""), `${newD.decision} ${newD.dedupeKey} ${newD.reason}`);
  const m3 = mails.length, t3 = texts.length;
  await run(D, et(2026, 10, 6, 10, 5));
  c.ok("…by email and text", mails.length === m3 + 1 && texts.length === t3 + 1, `${mails.length - m3} / ${texts.length - t3}`);
  c.ok("…and the second window reads 'client told'", !!(await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: d2.submissionId } })).clientNotifiedAt);
  const dText = (await prisma.outboxMessage.findFirst({ where: { clientId: D.f.clientId, channel: "sms" }, orderBy: { createdAt: "desc" } }))?.body ?? "";
  c.ok("…naming both videos still waiting", dText.startsWith("Hi Dee! 2 new videos are ready to review in your portal. Approve them"), dText);

  // =========================================================================
  c.head("6 · no mobile number: the email still goes");
  // =========================================================================
  const E = await mk("Eve Nophone", null);
  await releaseAt(E, 1, MON_10);
  const m4 = mails.length, t4 = texts.length;
  await run(E, MON_1005);
  const eText = await prisma.programReminder.findFirst({ where: { enrollmentId: E.f.enrollmentId, action: "REVIEW_TEXT" } });
  c.ok("the email went, no text", mails.length === m4 + 1 && texts.length === t4);
  c.ok("…and the text row says why", eText?.state === "SUPPRESSED" && eText.suppressionReason === "no_recipient", `${eText?.state} ${eText?.suppressionReason}`);

  // =========================================================================
  c.head("8 · Mike Ciunci (Oct 30): a video on LAST month's job is still told");
  // =========================================================================
  // His revised Video 2 reached his portal Oct 27; its job sits in his
  // September month, and only this month and later were in view, so nothing
  // went. Here: October's job, a version released Fri Oct 30, read Mon Nov 2.
  const NOV2_905 = et(2026, 11, 2, 9, 5);
  const F = await mk("Fay Lastmonth");
  const fw = await releaseAt(F, 1, et(2026, 10, 30, 15));
  const oldF = await oldR.evaluateReminders({ dryRun: true, enrollmentIds: [F.f.enrollmentId], reviewOnly: true, now: NOV2_905 });
  c.ok("OLD: on Nov 2 the October job's video is out of view (no review candidate at all)", !oldF.candidates.some((x) => x.lane === "REVIEW" && x.action), JSON.stringify(oldF.candidates.map((x) => [x.lane, x.monthKey, x.decision])));
  const m5 = mails.length, t5 = texts.length;
  await run(F, NOV2_905);
  const fEmail = (await prisma.outboxMessage.findFirst({ where: { clientId: F.f.clientId, channel: "email" } }))?.body ?? "";
  c.ok("NEW: Nov 2 9:05, the client is emailed and texted", mails.length === m5 + 1 && texts.length === t5 + 1, `${mails.length - m5} / ${texts.length - t5}`);
  c.ok("…quoting that version's own deadline (Thu Nov 5)", /Please review by Thu, Nov 5, 5:00 PM ET/.test(fEmail), /Please review by [^(]+/.exec(fEmail)?.[0] ?? "(none)");
  c.ok("…the window reads 'client told'", (await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: fw.submissionId } })).clientNotifiedAt?.getTime() === NOV2_905.getTime());
  c.ok("…and only the review lane ran for that past month (no booking, planning or brand-kit row)", (await rows(F)).every((r) => r.action === "REVIEW_WORK" || r.action === "REVIEW_TEXT"), (await rows(F)).map((r) => r.action).join(" "));

  const G = await mk("Gus Stale");
  const gOld = await releaseAt(G, 1, MON_10); // Oct 5: deadline Oct 9, never told
  const gNew = await releaseAt(G, 2, et(2026, 10, 30, 15));
  await run(G, NOV2_905);
  const gEmail = (await prisma.outboxMessage.findFirst({ where: { clientId: G.f.clientId, channel: "email" } }))?.body ?? "";
  const gText = (await prisma.outboxMessage.findFirst({ where: { clientId: G.f.clientId, channel: "sms" } }))?.body ?? "";
  c.ok("a stale version beside it (deadline Oct 9) is not what the email is about: it quotes Nov 5", /Please review by Thu, Nov 5, 5:00 PM ET/.test(gEmail) && !/Oct 9/.test(gEmail), /Please review by [^(]+/.exec(gEmail)?.[0] ?? "(none)");
  c.ok("…the text names one new video", gText.startsWith("Hi Gus! Your new video is ready to review"), gText.slice(0, 80));
  const [gOldW, gNewW] = await Promise.all([gOld, gNew].map((w) => prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: w.submissionId } })));
  c.ok("…and the stale one is NOT marked told (it would then be approved automatically for a client who never heard of it)", !gOldW.clientNotifiedAt && !!gNewW.clientNotifiedAt, `${wall(gOldW.clientNotifiedAt)} / ${wall(gNewW.clientNotifiedAt)}`);

  const H = await mk("Hal Expired");
  await releaseAt(H, 1, MON_10);
  const m6 = mails.length;
  await run(H, NOV2_905);
  c.ok("a past month holding only an expired version sends nothing (the office settles it)", mails.length === m6 && (await rows(H)).length === 0, `${mails.length - m6} email(s)`);

  // =========================================================================
  c.head("9 · a snoozed month still hears about a new video (Oct 30)");
  // =========================================================================
  // Mike Ciunci's October was snoozed to stop booking emails for a session he
  // had filmed; the snooze also held back "your video is ready".
  const S = await mk("Sue Snoozed");
  await prisma.contentMonth.update({ where: { id: S.f.monthId }, data: { remindersSnoozedUntil: et(2026, 11, 1, 0), remindersSnoozedBy: "drill", remindersSnoozeReason: "session already filmed" } });
  await releaseAt(S, 1, et(2026, 10, 12, 10));
  const SNZ = et(2026, 10, 12, 10, 5);
  const oldS = await review(oldR, S, SNZ);
  c.ok("OLD: the review email is suppressed as snoozed", oldS.decision === "suppressed" && oldS.suppressionReason === "snoozed", `${oldS.decision} ${oldS.suppressionReason}`);
  const newS = await review(R, S, SNZ);
  c.ok("NEW: it is due", newS.decision === "send", `${newS.decision} ${newS.reason}`);
  const sPrimary = (await R.previewReminders(S.f.monthId, { now: SNZ })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
  c.ok("…while the month's own asks stay snoozed", sPrimary.decision === "suppressed" && sPrimary.suppressionReason === "snoozed", `${sPrimary.decision} ${sPrimary.suppressionReason}`);
  const m7 = mails.length, t7 = texts.length;
  await run(S, SNZ);
  c.ok("…and the run sends the email and the text", mails.length === m7 + 1 && texts.length === t7 + 1, `${mails.length - m7} / ${texts.length - t7}`);
  c.ok("the snooze button says so", /a video ready for review is still announced/.test(fs.readFileSync(path.join(REPO, "src/components/settings/RemindersPanel.tsx"), "utf8")));

  // =========================================================================
  c.head("7 · the policy and the copy");
  // =========================================================================
  const d = R.REMINDER_DEFAULTS;
  c.ok("defaults: first email at release, follow-ups two business days apart, three in all", d.reviewWorkAfterBusinessDays === 0 && d.reviewFollowUpBusinessDays === 2 && d.reviewMaxAttempts === 3);
  c.ok("the defaults validate", R.validateReminderPolicy(d).ok);
  const one = T.reviewReadyText({ firstName: "Joseph", itemCount: 1, portalLink: "https://x.test/p", reviewDeadline: null });
  c.ok("no deadline: the text simply asks", one === "Hi Joseph! Your new video is ready to review in your portal. Approve it or tell us what to change: https://x.test/p", one);
  c.ok("no stray drill traffic left the fence", fence.blocked.length === 0, fence.blocked.join(" "));
  c.summary();
  quiet.restore();
  await stop();
  try { fs.unlinkSync(path.join(baseDir, "node_modules")); fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* harmless */ }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
