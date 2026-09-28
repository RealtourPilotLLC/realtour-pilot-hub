// ---------------------------------------------------------------------------
// DRILL: MONTHLY PROGRAM REMINDERS — the 72-hour follow-up and Kyle's 15th for
// real clients (A50 / AU-08, unified handoff batch 5, Sep 26 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/reminder-cadence.ts
//
// §6.7: "initial first-of-month action email; follow-up after 72 hours" — and
// §3 defines 72 as elapsed WEEKDAY hours in ET (Mon 2:30 PM → Thu 2:30 PM,
// Fri 2 PM → Wed 2 PM). Isolated PGlite; nothing leaves; every "now" is
// passed explicitly. OLD behaviour first: src/lib/programReminders.ts at
// 17df024 (pinned — never HEAD), run on the same rows.
//
//   1. OLD: a Monday 3 PM send was followed up from Thursday 00:00 (sent 9 AM,
//      66 weekday hours later).
//   2. NEW: Mon 3 PM → Thu 3 PM; Fri 2 PM → Wed 2 PM; across the Nov 1 clock
//      change, Fri 2 PM EDT → Wed 2 PM EST.
//   3. An ENDED enrollment is suppressed.
//   4. Kyle's 15th for a REAL client before launch: off by default (nothing);
//      with staffFollowUpsForRealClients on, one Kyle task, the client written
//      to never, no ledger row, no outbox row.
// (Route-awareness, the single 15th across an action change, the durable
// cancellation stamp and "Schedule later" are held by b2-planning, b3-gates
// and pro-two-sessions, which this batch re-ran.)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5785);
const BASE = "17df024";
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
const wall = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "null");

installNextStubs();
const fence = fenceFetch();

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-cadence-base-"));
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
  const oldR = await loadBase<typeof import("@/lib/programReminders")>("src/lib/programReminders.ts");
  const c = makeChecker();

  /** A written-route month still owed its answers, with ONE reminder already
   *  sent at `sentAt` — the follow-up is what is being measured. */
  const monthWithSend = async (name: string, monthKey: string, sentAt: Date) => {
    const f = await buildContentMonth(db, { name, package: "Starter", videosPerMonth: 1, monthKey, project: false, owner: { email: `drill-${name.split(" ")[0].toLowerCase()}@realtourpilot.com` }, topics: [{ title: `${name} topic`, selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { planningMode: "WRITTEN" } });
    await prisma.programReminder.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey, action: "COMPLETE_ANSWERS",
        templateKey: "drill", state: "SENT", sentAt, attempt: 1, channel: "email", dedupeKey: `${f.enrollmentId}:${monthKey}:COMPLETE_ANSWERS:1`,
      },
    });
    return f;
  };
  const primary = async (mod: typeof R, monthId: string, now: Date) => (await mod.previewReminders(monthId, { now })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;

  // =========================================================================
  c.head("1 · OLD (17df024): a Monday 3 PM send, followed up from Thursday midnight");
  // =========================================================================
  const MON_1500 = et(2026, 10, 5, 15);
  const A = await monthWithSend("Ada Monday TEST", "2026-10", MON_1500);
  const oldA = await primary(oldR, A.monthId, et(2026, 10, 5, 16));
  c.ok("OLD: the follow-up opened Thu Oct 8, 12:00 AM (66 weekday hours by the 9 AM send, not 72)", oldA.action === "COMPLETE_ANSWERS" && oldA.decision === "wait" && oldA.nextEligibleAt?.getTime() === et(2026, 10, 8, 0).getTime(), `${oldA.action} ${oldA.decision} ${wall(oldA.nextEligibleAt)}`);

  // =========================================================================
  c.head("2 · NEW: 72 weekday hours, wall clock kept");
  // =========================================================================
  const newA = await primary(R, A.monthId, et(2026, 10, 5, 16));
  c.ok("Mon Oct 5, 3:00 PM → Thu Oct 8, 3:00 PM", newA.decision === "wait" && newA.nextEligibleAt?.getTime() === et(2026, 10, 8, 15).getTime(), wall(newA.nextEligibleAt));
  c.ok("…and it says weekday hours", /72 weekday hours after the last one actually sent/.test(newA.reason), newA.reason);
  const beforeA = await primary(R, A.monthId, et(2026, 10, 8, 14, 59));
  c.ok("Thu 2:59 PM: still waiting", beforeA.decision === "wait", `${beforeA.decision} ${beforeA.reason}`);
  const dueA = await primary(R, A.monthId, et(2026, 10, 8, 15));
  c.ok("Thu 3:00 PM: follow-up 1 is due", dueA.decision === "send" && dueA.milestone === "FOLLOW_UP_1", `${dueA.decision} ${dueA.milestone} ${dueA.reason}`);
  const F = await monthWithSend("Fay Friday TEST", "2026-10", et(2026, 10, 9, 14));
  const newF = await primary(R, F.monthId, et(2026, 10, 9, 15));
  c.ok("Fri Oct 9, 2:00 PM → Wed Oct 14, 2:00 PM (the weekend does not count)", newF.nextEligibleAt?.getTime() === et(2026, 10, 14, 14).getTime(), wall(newF.nextEligibleAt));
  // November's month, so the 15th of October (a milestone of its own) is not
  // what the evaluator is answering about on Oct 30.
  const D = await monthWithSend("Dee Clockchange TEST", "2026-11", et(2026, 10, 30, 14));
  const newD = await primary(R, D.monthId, et(2026, 10, 30, 15));
  c.ok("across the Nov 1 clock change: Fri Oct 30, 2:00 PM EDT → Wed Nov 4, 2:00 PM EST", newD.nextEligibleAt?.getTime() === et(2026, 11, 4, 14).getTime(), wall(newD.nextEligibleAt));

  // =========================================================================
  c.head("3 · An ENDED enrollment");
  // =========================================================================
  const E = await buildContentMonth(db, { name: "Eli Ended TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", enrollmentStatus: "ENDED", project: false, owner: { email: "drill-eli@realtourpilot.com" }, topics: [{ title: "Ended topic", selection: "SELECTED" }] });
  await prisma.contentMonth.update({ where: { id: E.monthId }, data: { planningMode: "WRITTEN" } });
  const ended = await primary(R, E.monthId, et(2026, 10, 6, 10));
  c.ok("suppressed: ended", ended.decision === "suppressed" && ended.suppressionReason === "ended", `${ended.decision} ${ended.suppressionReason}`);

  // =========================================================================
  c.head("4 · Kyle's 15th for a REAL client, before launch");
  // =========================================================================
  await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, payPercent: 0.35, payFloor: 100 } });
  const Rl = await buildContentMonth(db, { name: "Olivia Real TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, owner: { email: "drill-olivia@realtourpilot.com" }, topics: [{ title: "Real topic", selection: "SELECTED" }] });
  await prisma.contentMonth.update({ where: { id: Rl.monthId }, data: { planningMode: "WRITTEN" } });
  await prisma.client.update({ where: { id: Rl.clientId }, data: { name: "Olivia Hart" } }); // a real client now: no TEST in the name
  const FIFTEENTH = et(2026, 10, 15, 10);
  const midTask = () => prisma.smartTask.findUnique({ where: { dedupeKey: `program-reminder-midmonth:${Rl.monthId}` } });
  const ledger = () => prisma.programReminder.count({ where: { enrollmentId: Rl.enrollmentId } });
  await prisma.programAutomation.create({ data: { key: "reminders", enabled: true, configJson: JSON.stringify({}) } });
  const off = await R.evaluateReminders({ dryRun: false, now: FIFTEENTH, enrollmentIds: [Rl.enrollmentId] });
  const offC = off.candidates.find((x) => x.monthId === Rl.monthId && x.lane === "PRIMARY");
  c.ok("default (flag off): suppressed launch_not_authorised and NO Kyle task — today's behaviour", offC?.suppressionReason === "launch_not_authorised" && !(await midTask()), `${offC?.decision} ${offC?.suppressionReason}`);
  await prisma.programAutomation.update({ where: { key: "reminders" }, data: { configJson: JSON.stringify({ staffFollowUpsForRealClients: true }) } });
  const v = R.validateReminderPolicy({ staffFollowUpsForRealClients: true });
  c.ok("the policy accepts the new flag (no 'unknown key' warning)", v.ok && !v.warnings.some((w) => /staffFollowUpsForRealClients/.test(w)), v.ok ? v.warnings.join(" | ") : v.errors.join(" | "));
  for (let i = 0; i < 3; i++) await R.evaluateReminders({ dryRun: false, now: new Date(FIFTEENTH.getTime() + i * 3_600_000), enrollmentIds: [Rl.enrollmentId] });
  const t = await midTask();
  c.ok("flag on: ONE Kyle task for the month, across three runs", !!t && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "program-reminder-midmonth:" } } })) === 1, t?.title ?? "none");
  c.ok("…the client was written to never: no ledger row", (await ledger()) === 0, `${await ledger()}`);
  c.ok("…and no outbox row", (await prisma.outboxMessage.count()) === 0);
  const before15 = await R.previewReminders(Rl.monthId, { now: et(2026, 10, 14, 10) });
  c.ok("before the 15th nothing is raised for her (the lock alone)", before15.lanes.find((l) => l.lane === "PRIMARY")?.candidate.kyleFollowUp === null);

  c.ok("nothing left this process", fence.blocked.length === 0, fence.blocked.join(" "));
  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
