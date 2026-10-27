// ---------------------------------------------------------------------------
// DRILL: booking reminders go DAILY until the session is booked (Oct 27 2026).
//
//   DRILL_PORT=5611 node scripts/_drill/run-all.cjs scripts/_drill/oct27-daily-booking-reminders.ts
//
// Jordan: "I think we need to send daily reminders to clients to schedule
// their content session." The booking ask (BOOK_SESSION) went on the planning
// cadence: the 1st, then two follow-ups 72 weekday hours apart, then nothing
// but the 15th. Bernadette, Mike Ciunci and Marcee were each waiting three
// weekdays between emails on Oct 27.
//
//   1. OLD (HEAD before this change): after a booking email, the next waits 72
//      weekday hours, and the fourth is never sent.
//   2. NEW: a weekday after the last send, wall clock kept, weekends skipped;
//      the fourth, fifth… still go; Kyle is told once after three unanswered;
//      the cap stops it.
//   3. The planning asks keep their 72-hour spacing.
//   4. The copy: the first ask is v2 word for word; a follow-up is a short
//      nudge whose opening line turns over; no em dashes.
//   5. The policy: new keys validate; a stored policy without them gets the
//      defaults; the 15th's milestone still wins its day.
//
// ISOLATION: PGlite via the shared harness; nothing leaves; every "now" is
// passed explicitly.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5611);
const BASE = "696be0f5";
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
const fence = fenceFetch();

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-booking-base-"));
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
  const db = prisma as unknown as PrismaClient;
  const R = await import("@/lib/programReminders");
  const T = await import("@/lib/reminderTemplates");
  const oldR = await loadBase<typeof import("@/lib/programReminders")>("src/lib/programReminders.ts");
  const c = makeChecker();
  await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, payPercent: 0.35, payFloor: 100 } });

  // A month whose next step is booking filming: a self-planned client ("we
  // show up and shoot"), so nothing stands before the booking ask. November,
  // so the dates below sit clear of the 15th unless a check means it.
  let n = 0;
  const bookingMonth = async (name: string) => {
    const slug = `${name.split(" ")[0].toLowerCase()}${n++}`;
    const f = await buildContentMonth(db, { name, package: "Starter", videosPerMonth: 1, monthKey: "2026-11", project: false, strategy: false, owner: { email: `info+drill-${slug}@realtourpilot.com` } });
    await prisma.contentEnrollment.update({ where: { id: f.enrollmentId }, data: { clientSuppliesTopics: true, strategyCallRequired: false } });
    return f;
  };
  const sent = async (f: { enrollmentId: string; clientId: string; monthId: string }, at: Date, k: number) =>
    prisma.programReminder.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: "2026-11", action: "BOOK_SESSION",
        templateKey: "reminder.book_session.v2", state: "SENT", sentAt: at, attempt: k, channel: "email", dedupeKey: `${f.enrollmentId}:2026-11:BOOK_SESSION:${k}`,
      },
    });
  // "Not booked" is only trusted from a fresh appointment sync, so each read
  // stamps the Aryeo connection as synced at that moment.
  const lane = async (mod: typeof R, monthId: string, now: Date) => {
    await prisma.connection.upsert({ where: { provider: "aryeo" }, create: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: now }, update: { status: "CONNECTED", lastSyncedAt: now, lastError: null } });
    return (await mod.previewReminders(monthId, { now })).lanes.find((l) => l.lane === "PRIMARY")!;
  };

  const MON_NOV2_10 = et(2026, 11, 2, 10);
  const A = await bookingMonth("Ada Booking TEST");
  const first = await lane(R, A.monthId, MON_NOV2_10);
  c.ok("the fixture's next step is booking filming, and the 1st's email is due", first.candidate.action === "BOOK_SESSION" && first.candidate.decision === "send" && first.candidate.milestone === "MONTH_OPEN", `${first.candidate.action} ${first.candidate.decision} ${first.candidate.milestone} ${first.candidate.reason}`);
  await sent(A, MON_NOV2_10, 1);

  // =========================================================================
  c.head("1 · OLD: three weekdays between booking emails, and three in all");
  // =========================================================================
  const oldNext = (await lane(oldR, A.monthId, et(2026, 11, 2, 11))).candidate;
  c.ok("OLD: after Monday 10 AM, the next waits until Thursday 10 AM", oldNext.decision === "wait" && oldNext.nextEligibleAt?.getTime() === et(2026, 11, 5, 10).getTime(), `${oldNext.decision} ${wall(oldNext.nextEligibleAt)}`);

  // =========================================================================
  c.head("2 · NEW: every weekday until it's booked");
  // =========================================================================
  const next = (await lane(R, A.monthId, et(2026, 11, 2, 11))).candidate;
  c.ok("after Monday 10 AM, the next is Tuesday 10 AM", next.decision === "wait" && next.nextEligibleAt?.getTime() === et(2026, 11, 3, 10).getTime(), `${next.decision} ${wall(next.nextEligibleAt)}`);
  c.ok("…and says 24 weekday hours", /24 weekday hours after the last one actually sent/.test(next.reason), next.reason);
  const tue = (await lane(R, A.monthId, et(2026, 11, 3, 10))).candidate;
  c.ok("Tuesday 10 AM: follow-up 1 is due", tue.decision === "send" && tue.attempt === 2, `${tue.decision} ${tue.attempt} ${tue.reason}`);

  const F = await bookingMonth("Fay Friday TEST");
  await sent(F, et(2026, 11, 6, 14), 1);
  const fri = (await lane(R, F.monthId, et(2026, 11, 6, 15))).candidate;
  c.ok("Friday 2 PM → Monday 2 PM (the weekend is skipped)", fri.nextEligibleAt?.getTime() === et(2026, 11, 9, 14).getTime(), wall(fri.nextEligibleAt));

  const M = await bookingMonth("Max Many TEST");
  for (let k = 1; k <= 3; k++) await sent(M, et(2026, 11, 2 + k - 1, 10), k);
  const fourthOld = (await lane(oldR, M.monthId, et(2026, 11, 5, 10))).candidate;
  c.ok("OLD: with three sent, the fourth is never sent (escalate or nothing)", fourthOld.decision !== "send", `${fourthOld.decision} ${fourthOld.reason}`);
  const fourth = (await lane(R, M.monthId, et(2026, 11, 5, 10))).candidate;
  c.ok("NEW: with three sent, the fourth goes on Thursday", fourth.decision === "send" && fourth.attempt === 4, `${fourth.decision} ${fourth.attempt} ${fourth.reason}`);
  c.ok("…and Kyle is told now (three unanswered), alongside the email", fourth.escalation?.due === true && /3 reminder\(s\) sent, no response/.test(fourth.escalation.reason), fourth.escalation?.reason ?? "none");

  const Z = await bookingMonth("Zed Capped TEST");
  for (let k = 1; k <= 20; k++) await sent(Z, et(2026, 11, 2, 9, k), k);
  const capped = (await lane(R, Z.monthId, et(2026, 11, 3, 10))).candidate;
  c.ok("the cap (twenty) stops it", capped.decision !== "send" && /20 of 20 reminders already sent/.test(capped.reason), `${capped.decision} ${capped.reason}`);

  // =========================================================================
  c.head("3 · the planning asks keep their 72 hours");
  // =========================================================================
  const W = await buildContentMonth(db, { name: "Wes Written TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-11", project: false, owner: { email: "info+drill-wes@realtourpilot.com" }, topics: [{ title: "Wes topic", selection: "SELECTED" }] });
  await prisma.contentMonth.update({ where: { id: W.monthId }, data: { planningMode: "WRITTEN" } });
  await prisma.programReminder.create({ data: { enrollmentId: W.enrollmentId, clientId: W.clientId, monthId: W.monthId, monthKey: "2026-11", action: "COMPLETE_ANSWERS", templateKey: "drill", state: "SENT", sentAt: MON_NOV2_10, attempt: 1, channel: "email", dedupeKey: `${W.enrollmentId}:2026-11:COMPLETE_ANSWERS:1` } });
  const w = (await lane(R, W.monthId, et(2026, 11, 2, 11))).candidate;
  c.ok("answers still owed: next on Thursday 10 AM, 72 weekday hours", w.action === "COMPLETE_ANSWERS" && w.nextEligibleAt?.getTime() === et(2026, 11, 5, 10).getTime(), `${w.action} ${wall(w.nextEligibleAt)}`);

  // =========================================================================
  c.head("4 · the copy");
  // =========================================================================
  const v = { firstName: "Bernadette", month: "November", portalLink: "https://hub.example/portal/x", bookCallLink: "", noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, callUpcoming: null, sessionOrdinalWord: null, itemCount: 0, titles: [], updatedTitles: [], deadline: null } as unknown as import("@/lib/reminderTemplates").TemplateVars;
  const v3 = T.reminderTemplate("reminder.book_session.v3");
  const v2 = T.reminderTemplate("reminder.book_session.v2");
  c.ok("the default booking template is v3", T.templateForAction("BOOK_SESSION").id === "reminder.book_session.v3");
  c.ok("the first ask is v2 word for word", v3.render({ ...v, attempt: 1, followUp: false }) === v2.render(v));
  const n2 = v3.render({ ...v, attempt: 2, followUp: true });
  const n3 = v3.render({ ...v, attempt: 3, followUp: true });
  const n4 = v3.render({ ...v, attempt: 4, followUp: true });
  console.log(`\n--- follow-up 1 ---\n${n2}\n--- follow-up 2 ---\n${n3}\n--- follow-up 3 ---\n${n4}\n`);
  c.ok("a follow-up is a short nudge with the link", /^Hi Bernadette,\n\nA quick reminder: your filming session for November isn't booked yet\. It takes a minute to pick one in your portal, and we'll confirm it: https:\/\/hub\.example\/portal\/x/.test(n2), n2);
  c.ok("…its opening line turns over across three days", new Set([n2, n3, n4].map((b) => b.split("\n")[2].slice(0, 25))).size === 3);
  c.ok("…and comes round again on the fourth", v3.render({ ...v, attempt: 5, followUp: true }) === n2);
  const call = v3.render({ ...v, attempt: 2, followUp: true, callUpcoming: "Tuesday, November 10 at 2:00 PM ET", earliestSession: "Thursday, November 12 at 10:00 AM ET", sessionOrdinalWord: "second" });
  c.ok("a follow-up names the second session, says not to wait for the call, and quotes the earliest date", /your second filming session for November/.test(call) && /You don't need to wait for your strategy call on Tuesday, November 10 at 2:00 PM ET\./.test(call) && /The earliest we can film is Thursday, November 12 at 10:00 AM ET\./.test(call), call);
  c.ok("no em or en dashes in any of it", ![n2, n3, n4, call].some((b) => /[—–]/.test(b)));
  const live = await lane(R, A.monthId, et(2026, 11, 3, 10));
  c.ok("the evaluator's own follow-up renders the nudge", live.candidate.templateKey === "reminder.book_session.v3" && /^Hi .+,\n\nA quick reminder: your filming session for November isn't booked yet\./.test(live.body ?? ""), live.body ?? "none");
  const opener = await lane(R, (await bookingMonth("Ola Opener TEST")).monthId, MON_NOV2_10);
  c.ok("…and its first ask renders the full email", /Your November content is planned, so the next step is booking your filming session\./.test(opener.body ?? ""), opener.body ?? "none");

  // =========================================================================
  c.head("5 · the policy");
  // =========================================================================
  const ok = R.validateReminderPolicy({ ...R.REMINDER_DEFAULTS });
  c.ok("the defaults validate, with no unknown-key warning", ok.ok && !ok.warnings.some((x) => /session(FollowUp|MaxAttempts)/.test(x)), ok.ok ? ok.warnings.join(" | ") : ok.errors.join(" | "));
  const bad = R.validateReminderPolicy({ ...R.REMINDER_DEFAULTS, sessionFollowUpBusinessDays: 0 });
  c.ok("a zero spacing is refused", !bad.ok && bad.errors.some((x) => /sessionFollowUpBusinessDays/.test(x)));
  c.ok("defaults: one weekday apart, twenty at most", R.REMINDER_DEFAULTS.sessionFollowUpBusinessDays === 1 && R.REMINDER_DEFAULTS.sessionMaxAttempts === 20);
  // Production's stored policy is just {"testClientsOnly": false}: the live run reads the new defaults.
  await prisma.programAutomation.create({ data: { key: "reminders", enabled: true, configJson: JSON.stringify({ testClientsOnly: false }) } });
  const stored = (await lane(R, A.monthId, et(2026, 11, 2, 11))).candidate;
  c.ok("production's stored policy (no new keys) gets the daily spacing", stored.nextEligibleAt?.getTime() === et(2026, 11, 3, 10).getTime(), wall(stored.nextEligibleAt));
  const mid = (await lane(R, A.monthId, et(2026, 11, 16, 10))).candidate;
  c.ok("the 15th's milestone still wins its day (Mon Nov 16, the 15th being a Sunday)", mid.milestone === "MID_MONTH", `${mid.milestone} ${mid.decision} ${mid.reason}`);

  c.ok("nothing left this process", fence.blocked.length === 0, fence.blocked.join(" "));
  c.summary();
  quiet.restore();
  await stop();
  try { fs.unlinkSync(path.join(baseDir, "node_modules")); fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* harmless */ }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
