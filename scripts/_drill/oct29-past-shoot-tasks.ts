// ---------------------------------------------------------------------------
// DRILL: TO-DOS THAT OUTLIVED THEIR SHOOT (Oct 29 2026, Jordan: "the 6344
// Reedland St booking happened a while ago and was delivered. Things like that
// referencing old shoots should automatically be cleared … but we don't want to
// clear important things, so how do we distinguish?").
//   1  the pure rule: street keys, and each keep reason on its own
//   2  the sweep against a database: it clears the booking step, the late access
//      note and the delivered job's script prep; it keeps money, a complaint, a
//      fix, From Jordan, delegated, a new date, a "waiting on", a new ask after
//      the shoot, an upcoming or cancelled shoot, the video before delivery, a
//      visit still to come, an engine's own row, work in progress, a merged
//      message about an upcoming shoot and an address with no job
//   3  the switch: off counts and writes nothing; on clears; a second pass
//      finds nothing; undo puts every row back exactly as it was
//   4  the daily cron runs it
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6995). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const PORT = Number(process.env.DRILL_PORT ?? 6995);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const T = (s: string) => new Date(s);

// Thu Oct 29 2026, 1:15 PM ET: the day Jordan asked.
const NOW = T("2026-10-29T17:15:00Z");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/pastShootTasksCore");
    const sweep = await import("@/lib/pastShootTasks");
    const { PUSH_ACTION } = await import("@/lib/taskAging");
    const { putSetting } = await import("@/lib/settings");

    // =====================================================================
    c.head("1 · the rule, pure");
    // =====================================================================
    c.ok("a street reads the same however it is written", core.streetKeys("5457-Cedar-Ave-19143  code 1382").join() === "5457 cedar" && core.streetKeys("Mark 6344 Reedland St booking").join() === "6344 reedland" && core.streetKeys("89 E. Old Baltimore Pike, Media").join() === "89 old", core.streetKeys("89 E. Old Baltimore Pike").join());
    const base = {
      task: { taskType: "todo", source: "openphone", status: "OPEN", title: "Mark 6344 Reedland St booking confirmed", summary: null, description: null, reasonCreated: "Inbound message from client (OpenPhone)", createdAt: T("2026-10-11T13:00:00Z"), delegatedBy: null, flaggedBy: null, flaggedAt: null, assignedManually: false },
      job: { title: "6344 Reedland St, Philadelphia, PA", status: "DELIVERED", shootDate: T("2026-10-21T19:30:00Z"), deliveredAt: T("2026-10-22T14:00:00Z") },
      touchedAfterShoot: null, others: [], todayKey: "2026-10-29", shootKey: "2026-10-21", createdKey: "2026-10-11", deliveredKey: "2026-10-22",
    } satisfies Parameters<typeof core.classifyPastShootTask>[0];
    const v = (over: (b: typeof base) => Parameters<typeof core.classifyPastShootTask>[0]) => core.classifyPastShootTask(over(structuredClone(base)));
    c.ok("a booking step on a delivered job clears", v((b) => b).clear === true);
    const keeps: [string, (b: typeof base) => Parameters<typeof core.classifyPastShootTask>[0], RegExp][] = [
      ["money", (b) => ({ ...b, task: { ...b.task, title: "Invoice question about the 6344 Reedland St booking" } }), /after-the-shoot/],
      ["a complaint", (b) => ({ ...b, task: { ...b.task, summary: "Stephen is unhappy with how the booking went" } }), /after-the-shoot/],
      ["a retake", (b) => ({ ...b, task: { ...b.task, title: "Book the retake at 6344 Reedland St" } }), /after-the-shoot/],
      ["Showcase", (b) => ({ ...b, task: { ...b.task, title: "Confirm the Showcase booking at 6344 Reedland St" } }), /after-the-shoot/],
      ["from Jordan", (b) => ({ ...b, task: { ...b.task, reasonCreated: "Jordan asked for this" } }), /Jordan/],
      ["delegated", (b) => ({ ...b, task: { ...b.task, delegatedBy: "info@realtourpilot.com" } }), /handed/],
      ["flagged", (b) => ({ ...b, task: { ...b.task, flaggedBy: "Jordan", flaggedAt: T("2026-10-20T12:00:00Z") } }), /flagged/],
      ["a person's new date", (b) => ({ ...b, touchedAfterShoot: "kyle gave it a new date on Tue, Oct 27" }), /new date/],
      ["a manual task", (b) => ({ ...b, task: { ...b.task, source: "manual" } }), /a person made it/],
      ["in progress", (b) => ({ ...b, task: { ...b.task, status: "IN_PROGRESS" } }), /in progress/],
      ["an upcoming shoot", (b) => ({ ...b, shootKey: "2026-10-30", job: { ...b.job, status: "SCHEDULED" } }), /not happened/],
      ["a cancelled job", (b) => ({ ...b, job: { ...b.job, status: "CANCELLED" } }), /cancelled/],
      ["the video before delivery", (b) => ({ ...b, task: { ...b.task, title: "Prep the video scripts for the shoot" }, job: { ...b.job, status: "REVIEW" } }), /not delivered/],
      ["a visit still to come", (b) => ({ ...b, task: { ...b.task, description: "Script 1 gets another part filmed at Carolannes Way at a later date." } }), /still to come/],
      ["a new ask after the shoot", (b) => ({ ...b, createdKey: "2026-10-23", task: { ...b.task, title: "Schedule a time at 6344 Reedland St" } }), /after the shoot/],
      ["not a before-the-shoot step", (b) => ({ ...b, task: { ...b.task, title: "Prep for strategy call with Janice" } }), /not a before-the-shoot/],
      ["an engine's own row", (b) => ({ ...b, task: { ...b.task, taskType: "edit_video", source: "system" } }), /engine/],
      ["a merged message about today's shoot", (b) => ({ ...b, others: [{ street: "5457 Cedar Ave", job: { title: "5457 Cedar Ave", status: "SCHEDULED", shootDate: T("2026-10-29T16:00:00Z"), deliveredAt: null }, shootKey: "2026-10-29" }] }), /5457 Cedar Ave/],
      ["an address with no job", (b) => ({ ...b, others: [{ street: "89 E. Old Baltimore Pike", job: null, shootKey: null }] }), /no job/],
    ];
    for (const [name, over, why] of keeps) {
      const r = v(over);
      c.ok(`keeps ${name}`, r.clear === false && why.test(r.why), r.why);
    }
    c.ok("an access note after the shoot clears only on a delivered job, never with a booking word", v((b) => ({ ...b, createdKey: "2026-10-23", task: { ...b.task, title: "Log access code 9-26 for 6344 Reedland St" } })).clear === true && v((b) => ({ ...b, createdKey: "2026-10-23", task: { ...b.task, title: "Log access code 9-26 for 6344 Reedland St" }, job: { ...b.job, status: "REVISION" } })).clear === false);

    // =====================================================================
    c.head("2 · the sweep, against a database");
    // =====================================================================
    const client = await prisma.client.create({ data: { name: "Drill Investor" } });
    const other = await prisma.client.create({ data: { name: "Drill Broker" } });
    const job = async (title: string, status: string, shoot: string, delivered: string | null, clientId = client.id) =>
      prisma.project.create({ data: { title, clientId, status: status as never, shootDate: T(shoot), deliveredAt: delivered ? T(delivered) : null } });
    const reed = await job("6344 Reedland St, Philadelphia, PA 19142", "DELIVERED", "2026-10-21T19:30:00Z", "2026-10-22T14:00:00Z");
    const reed2 = await job("6200 Reedland St, Philadelphia, PA 19142", "DELIVERED", "2026-10-21T15:00:00Z", "2026-10-22T14:00:00Z");
    await job("5457 Cedar Ave, Philadelphia, PA 19143", "SCHEDULED", "2026-10-29T16:00:00Z", null);
    const godfrey = await job("1934 W Godfrey Ave, Philadelphia, PA 19141", "DELIVERED", "2026-10-14T16:30:00Z", "2026-10-15T13:30:00Z");
    const oak = await job("34 Oakland Rd, Malvern, PA 19355", "REVIEW", "2026-10-19T14:00:00Z", null);
    const n21 = await job("7261 N 21st St, Philadelphia, PA 19138", "DELIVERED", "2026-10-16T14:00:00Z", "2026-10-20T14:00:00Z");
    const pine = await job("12 Pine St, Media, PA 19063", "SCHEDULED", "2026-11-03T14:00:00Z", null);
    const maple = await job("40 Maple Ave, Media, PA 19063", "CANCELLED", "2026-10-10T14:00:00Z", null);
    const pike = await job("107 E Old Baltimore Pike, Media, PA 19063", "DELIVERED", "2026-09-16T14:00:00Z", "2026-10-17T15:00:00Z", other.id);

    const msg = { taskType: "todo", source: "openphone", status: "OPEN", reasonCreated: "Inbound message from client (OpenPhone)", clientId: client.id, assignedKey: "kyle" };
    const mk = (data: Record<string, unknown>) => prisma.smartTask.create({ data: { ...msg, createdAt: T("2026-10-11T13:00:00Z"), ...data } as never });
    const t = {
      booking: await mk({ title: "Mark 6344 Reedland St booking confirmed with Alonzo Clegg", summary: "Tenants will let you in." }),
      merged: await mk({ title: "Mark 6200 Reedland St booking confirmed", summary: "Stephen: 2 messages waiting, latest: 5457-Cedar-Ave-19143 code 1382 ready tomorrow.", description: "Tenants will let you in.\n\nUpdate: 5457-Cedar-Ave-19143  code 1382 ready tomorrow." }),
      lateAccess: await mk({ title: "Log access code 9-26 for 1934 W Godfrey Ave", projectId: godfrey.id, createdAt: T("2026-10-15T16:44:00Z") }),
      prep: await mk({ title: "Add target audience detail to intro script prep", summary: "The top selling point completes the brief for the agent intro video script.", projectId: n21.id, createdAt: T("2026-10-15T20:57:00Z") }),
      money: await mk({ title: "Investigate why the 6344 Reedland St payment was not applied", projectId: reed.id }),
      complaint: await mk({ title: "Stephen is unhappy about the 6344 Reedland St booking", projectId: reed.id }),
      fix: await mk({ title: "Fix the booking notes for 6344 Reedland St", projectId: reed.id }),
      jordan: await mk({ title: "Confirm the 6344 Reedland St booking time", projectId: reed.id, reasonCreated: "Jordan asked for this" }),
      delegated: await mk({ title: "Confirm the 6344 Reedland St booking", projectId: reed.id, delegatedBy: "info@realtourpilot.com" }),
      pushed: await mk({ title: "Confirm the 6344 Reedland St appointment", projectId: reed.id }),
      waiting: await mk({ title: "Confirm the appointment time at 6344 Reedland St", projectId: reed.id }),
      newAsk: await mk({ title: "Schedule a key drop at 1934 W Godfrey Ave", projectId: godfrey.id, createdAt: T("2026-10-16T13:00:00Z") }),
      upcoming: await mk({ title: "Confirm the booking at 12 Pine St", projectId: pine.id }),
      cancelled: await mk({ title: "Confirm the booking at 40 Maple Ave", projectId: maple.id }),
      video: await mk({ title: "Prep the video scripts for the shoot", projectId: oak.id }),
      later: await mk({ title: "Review and prep 4 scripts for Monday shoot", projectId: n21.id, description: "Script 1 gets another part filmed at Carolannes Way at a later date." }),
      engine: await mk({ title: "Edit — 34 Oakland Rd", taskType: "edit_video", source: "system", reasonCreated: "Raws landed", projectId: oak.id }),
      inProgress: await mk({ title: "Confirm the booking time at 6344 Reedland St", projectId: reed.id, status: "IN_PROGRESS" }),
      noJob: await mk({ title: "Note shoot at 107 E Old Baltimore Pike is agent promo videos only", projectId: pike.id, clientId: other.id, summary: "Rick: latest is the draft hooks email.", description: "We are just doing Agent promo videos\n\n— 2:00 PM: Additional draft hooks. Schultz Real Estate Group, 89 E. Old Baltimore Pike, Media, PA 19063" }),
    };
    await prisma.auditLog.create({ data: { actor: "kyle@realtourpilot.com", action: PUSH_ACTION, target: t.pushed.id, detail: "{}", createdAt: T("2026-10-27T14:00:00Z") } });
    await prisma.auditLog.create({ data: { actor: "cron:daily", action: "task_auto_expired", target: t.booking.id, detail: "{}", createdAt: T("2026-10-22T08:00:00Z") } });
    await prisma.appSetting.create({ data: { key: `office_waiting:${t.waiting.id}`, value: JSON.stringify({ who: "Stephen", followUpAt: "2026-10-30T13:00:00Z" }) } });

    const shouldClear = [t.booking.id, t.lateAccess.id, t.prep.id].sort().join();
    const rows = await sweep.findPastShootTasks(NOW);
    const cleared = rows.filter((r) => r.verdict.clear).map((r) => r.id).sort().join();
    c.ok("it clears exactly the booking step, the late access note and the delivered job's script prep", cleared === shouldClear, rows.filter((r) => r.verdict.clear).map((r) => r.title).join(" | "));
    const why = (id: string) => rows.find((r) => r.id === id)?.verdict.why ?? "(not listed: its shoot is not past)";
    c.ok("the booking was tied by the address in its words", rows.find((r) => r.id === t.booking.id)?.link === "address");
    c.ok("a system actor's close is not a person's new date", rows.find((r) => r.id === t.booking.id)?.verdict.clear === true);
    for (const [name, id, re] of [
      ["money", t.money.id, /after-the-shoot/], ["a complaint", t.complaint.id, /after-the-shoot/], ["a fix", t.fix.id, /after-the-shoot/],
      ["From Jordan", t.jordan.id, /Jordan/], ["delegated", t.delegated.id, /handed/], ["a person's new date", t.pushed.id, /kyle gave it a new date/],
      ["a waiting-on note", t.waiting.id, /waiting/], ["a new ask after the shoot", t.newAsk.id, /after the shoot/],
      ["the video before delivery", t.video.id, /not delivered/], ["a visit still to come", t.later.id, /still to come/],
      ["an engine's row", t.engine.id, /engine/], ["work in progress", t.inProgress.id, /in progress/],
      ["the merged message about today's Cedar Ave shoot", t.merged.id, /5457 Cedar Ave/], ["the office address in a signature", t.noJob.id, /no job/],
    ] as [string, string, RegExp][]) c.ok(`keeps ${name}`, re.test(why(id)), why(id));
    c.ok("upcoming and cancelled shoots are not even listed", !rows.some((r) => r.id === t.upcoming.id || r.id === t.cancelled.id));

    // =====================================================================
    c.head("3 · off counts, on clears, undo restores");
    // =====================================================================
    const off = await sweep.runPastShootSweep(NOW, { actor: "drill" });
    c.ok("switched off (the default), it only counts", off.on === false && off.wouldClear === 3 && off.closed === 0);
    c.ok("…and wrote nothing", (await prisma.smartTask.count({ where: { status: "CANCELLED" } })) === 0 && (await prisma.auditLog.count({ where: { action: sweep.CLEAR_ACTION } })) === 0);
    await putSetting(sweep.SWEEP_SWITCH_KEY, { on: true }, "drill");
    const on = await sweep.runPastShootSweep(NOW, { actor: "drill" });
    const closed = await prisma.smartTask.findUniqueOrThrow({ where: { id: t.booking.id } });
    c.ok("switched on, it clears the three", on.on === true && on.closed === 3);
    c.ok("as a dismissal that says why, the old summary kept under it", closed.status === "CANCELLED" && closed.completedAt === null && (closed.summary ?? "").startsWith(sweep.CLEARED_STAMP) && (closed.summary ?? "").includes("the shoot at 6344 Reedland St was on Oct 21 and delivered Oct 22") && (closed.summary ?? "").endsWith("Tenants will let you in."), closed.summary ?? "");
    c.ok("one AuditLog row each, with what it was", (await prisma.auditLog.count({ where: { action: sweep.CLEAR_ACTION } })) === 3);
    const keptIds = Object.values(t).map((x) => x.id).filter((id) => !shouldClear.includes(id));
    c.ok("every kept row is untouched", (await prisma.smartTask.findMany({ where: { id: { in: keptIds } } })).every((x) => x.status === "OPEN" || x.status === "IN_PROGRESS"));
    c.ok("a second pass finds nothing more", (await sweep.runPastShootSweep(NOW, { actor: "drill" })).closed === 0);
    const undo = await sweep.undoPastShootTasks({ apply: true, actor: "drill" });
    const back = await prisma.smartTask.findUniqueOrThrow({ where: { id: t.booking.id } });
    c.ok("undo puts all three back exactly as they were", undo.reopened === 3 && back.status === "OPEN" && back.summary === "Tenants will let you in.");
    c.ok("…and records it", (await prisma.auditLog.count({ where: { action: sweep.CLEAR_UNDO_ACTION } })) === 3);

    // =====================================================================
    c.head("4 · the daily cron");
    // =====================================================================
    const cron = read("src/app/api/cron/daily/route.ts");
    c.ok("the daily cron runs the sweep after the shoot-note expiry", cron.indexOf('step("pastShootTasks"') > cron.indexOf('step("expireShootNotes"') && /runPastShootSweep/.test(cron));
    c.ok("it ships switched off", /\{ on: false \}/.test(read("src/lib/pastShootTasks.ts")));

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
