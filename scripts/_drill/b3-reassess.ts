// ---------------------------------------------------------------------------
// DRILL: A25 — SESSION REASSESSMENT (unified handoff §6.6), Sep 25 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b3-reassess.ts
//
// OLD behaviour first: programMonths.ts at 810b29f (pinned — the tree batch 3
// starts from, never HEAD) is loaded for real. Moving the call a booked
// session was planned around raised nothing at all.
//
//   A. Call route, a snapshotted session Thu 3:00 PM (call Mon 2:00–2:30):
//      OLD: the call moves Mon → Wed and nothing is raised.
//      NEW: one reassessment + one Kyle task; the appointment, the request and
//      Aryeo are untouched (0 writes); three more passes (and the hourly sweep)
//      still one; the portal says "Kyle will confirm"; the staff banner shows
//      it. Moved back → resolved, task closed. Cancelled with no replacement →
//      ANCHOR_LOST. Rebooked → resolved. No-show → ANCHOR_LOST again.
//   B. The rule change never flags: a session booked under 48 hours (snapshot)
//      from a FRIDAY 2:30 PM call, filmed the Tuesday after the DST change —
//      72 now says Wednesday, the anchor did not move → nothing, three passes.
//      The call then moves half an hour later → flagged, judged by ITS 48.
//   C. A session booked outside the hub (no snapshot): first sight is a
//      baseline, never a task. The call moves later → flagged. A person closes
//      the task → ACKNOWLEDGED, never raised again for the same facts.
//   D. Written route + a strategy call ending 24 h before the shoot: ONE task
//      (the call-buffer task) with the reassessment linked to it.
//   E. Route switch WRITTEN → CALL: nothing cancelled, 0 writes, a task only
//      once the call lands inside the new window.
//   F. TEST clients make no owner work without PROGRAM_DESK_TASKS_FOR_TEST=1.
//   H. (batch-3 review) A COMPLETED stamp taken from a record whose record is
//      then ignored, or moved to another month: the stamp goes with it, filming
//      shuts, no CONFIRM_CALL_END, and the booked session is ANCHOR_LOST.
//   G. Address change pending: the confirmation text is HELD and the shoot
//      brief shows "Address change pending: NEW (not yet on the booking)";
//      SYNCED releases both.
//
// ISOLATION: PGlite on 127.0.0.1:5664; Aryeo is the stateful fake (only to
// COUNT writes — there must be none); OpenPhone answers its number list from a
// canned response; nothing is sent. THE CLOCK IS PINNED (Mon Oct 5 2026, ET),
// and moved only where a scenario says so.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5664);
const BASE = "810b29f"; // pinned: the tree batch 3 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
/** ET wall clock (EDT = UTC-4 until Sun Nov 1 2026 2 AM, EST = UTC-5 after). */
const et = (month: number, day: number, hour: number, minute = 0) => {
  const edt = month < 11 || (month === 11 && day === 1 && hour < 2);
  return new RealDate(RealDate.UTC(2026, month - 1, day, hour + (edt ? 4 : 5), minute));
};
let offset = et(10, 5, 9).getTime() - RealDate.now(); // Mon Oct 5 2026, 9:00 AM ET
const setClock = (d: Date) => { offset = d.getTime() - RealDate.now(); };
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

// ---- modules that cannot load under the react-server build of React --------
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();

let fake: ReturnType<typeof createFakeAryeo>;
const sent: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://api.openphone.com/v1/phone-numbers")) {
    return new Response(JSON.stringify({ data: [{ id: "PNdrill", number: "+12156454889", name: "Office" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://api.openphone.com/")) { sent.push(`${init?.method ?? "GET"} ${url}`); return new Response(JSON.stringify({ data: {} }), { status: 202 }); }
  return fake ? fake.handle(url, init) : null;
});

// ---- the old code, runnable ------------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-reassess-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
async function loadBase<T>(rel: string): Promise<T> {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  fake = createFakeAryeo({ products: {} });
  const pm = await import("@/lib/programMonths");
  const rs = await import("@/lib/sessionReassess");
  const { REASSESS_TASK_PREFIX } = rs;

  let evt = 0;
  const call = (f: ContentMonthFixture, start: Date, end: Date, extra: Record<string, unknown> = {}) =>
    prisma.programCallRecord.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, callType: "MONTHLY_STRATEGY", matchState: "MATCHED",
        status: "SCHEDULED", scheduledStart: start, scheduledEnd: end, calendlyEventUri: `https://api.calendly.com/scheduled_events/drill-${++evt}`, ...extra,
      },
    });
  /** A Calendly reschedule: the old record goes RESCHEDULED, a new one points back at it. */
  const reschedule = async (f: ContentMonthFixture, fromId: string, start: Date, end: Date) => {
    await prisma.programCallRecord.update({ where: { id: fromId }, data: { status: "RESCHEDULED" } });
    return call(f, start, end, { rescheduledFromId: fromId });
  };
  const apptOf = async (f: ContentMonthFixture) => prisma.appointment.findFirstOrThrow({ where: { projectId: f.projectId! }, orderBy: { startAt: "asc" } });
  /** A CONFIRMED request carrying the gate it was offered under. */
  const snapshot = async (f: ContentMonthFixture, g: { route: string; anchorRef: string | null; anchorAt: Date | null; windowHours: number; earliestAt: Date | null }) => {
    const a = await apptOf(f);
    return prisma.programSessionRequest.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: a.startAt, slotEnd: a.endAt, status: "CONFIRMED", confirmedAt: new Date(),
        projectId: f.projectId, aryeoAppointmentId: a.aryeoId, sessionIndex: 1, dedupeKey: `${f.enrollmentId}:${f.monthId}:${a.startAt!.toISOString()}`,
        gateRoute: g.route, gateAnchorRef: g.anchorRef, gateAnchorAt: g.anchorAt, gateWindowHours: g.windowHours, gateEarliestAt: g.earliestAt,
      },
    });
  };
  const rows = (f: ContentMonthFixture, where: Record<string, unknown> = {}) => prisma.programSessionReassessment.findMany({ where: { monthId: f.monthId, kind: { not: "BASELINE" }, ...where }, orderBy: { createdAt: "asc" } });
  const tasks = (f: ContentMonthFixture) => prisma.smartTask.findMany({ where: { clientId: f.clientId, dedupeKey: { startsWith: REASSESS_TASK_PREFIX } }, orderBy: { createdAt: "asc" } });
  const openTasks = async (f: ContentMonthFixture) => (await tasks(f)).filter((t) => t.status === "OPEN");
  const recalc = (f: ContentMonthFixture) => pm.recalcProgramMonth(f.monthId, { now: new Date() });
  const writes0 = () => fake.writes.length;

  // ======================================================================
  c.head("A · call route: the call moves, is cancelled, is a no-show");
  const A = await buildContentMonth(db, { name: "Avery Call TEST", package: "Accelerator", monthKey: "2026-10", appointments: [{ startAt: et(10, 8, 15), durationMin: 240 }] });
  await prisma.contentMonth.update({ where: { id: A.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
  const r1 = await call(A, et(10, 5, 14), et(10, 5, 14, 30));
  const gateA = pm.preparationGate((await pm.recalcProgramMonth(A.monthId, { now: new Date(), dryRun: true }))!.after, 1);
  c.ok("the gate: 72 weekday hours after the call's END — Mon 2:30 PM → Thu 2:30 PM", gateA.earliest?.getTime() === et(10, 8, 14, 30).getTime() && gateA.anchor?.ref === `CALL_END:${r1.id}:${et(10, 5, 14, 30).getTime()}`, `${gateA.earliest?.toISOString()} ${gateA.anchor?.ref}`);
  const reqA = await snapshot(A, { route: "CALL", anchorRef: gateA.anchor!.ref, anchorAt: gateA.anchor!.at, windowHours: 72, earliestAt: gateA.earliest });
  const apptA = await apptOf(A);
  await recalc(A);
  c.ok("booked inside the rules: nothing raised", (await rows(A)).length === 0 && (await tasks(A)).length === 0);

  // OLD first: the same move, the pinned code.
  const r2 = await reschedule(A, r1.id, et(10, 7, 14), et(10, 7, 14, 30));
  {
    const old = await loadBase<typeof import("@/lib/programMonths")>("src/lib/programMonths.ts");
    await old.recalcProgramMonth(A.monthId, { now: new Date() });
    c.ok("OLD (810b29f): the call moved Mon → Wed and NOTHING was raised", (await prisma.programSessionReassessment.count()) === 0 && (await tasks(A)).length === 0);
  }
  const w0 = writes0();
  await recalc(A);
  let rA = await rows(A);
  let tA = await tasks(A);
  c.ok("NEW: the move raises ONE reassessment (ANCHOR_MOVED) and ONE task", rA.length === 1 && rA[0].kind === "ANCHOR_MOVED" && rA[0].state === "OPEN" && tA.length === 1 && tA[0].status === "OPEN", `${rA.map((r) => `${r.kind}/${r.state}`).join(",")} · ${tA.length} task(s)`);
  c.ok("…keyed on the NEW anchor (the Wednesday call's end)", rA[0]?.anchorRef === `CALL_END:${r2.id}:${et(10, 7, 14, 30).getTime()}`);
  c.ok("…the reason says when it now ends and the new earliest (Mon 2:30 PM)", /now ends Wed, Oct 7, 2:30 PM ET/.test(rA[0]?.reason ?? "") && /Mon, Oct 12, 2:30 PM ET or later/.test(rA[0]?.reason ?? ""), rA[0]?.reason);
  c.ok("…the task is Kyle's (the scheduling owner), links the row, and says nothing was moved", tA[0]?.assignedKey === "kyle" && rA[0]?.taskId === tA[0]?.id && /Nothing has been moved or cancelled/.test(tA[0]?.description ?? ""));
  const apptA2 = await apptOf(A);
  const reqA2 = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: reqA.id } });
  c.ok("the appointment is untouched", apptA2.startAt?.getTime() === apptA.startAt?.getTime() && apptA2.status === apptA.status && apptA2.updatedAt.getTime() === apptA.updatedAt.getTime());
  c.ok("the request is untouched (still CONFIRMED, same slot)", reqA2.status === "CONFIRMED" && reqA2.slotStart?.getTime() === reqA.slotStart?.getTime() && reqA2.updatedAt.getTime() === reqA.updatedAt.getTime());
  c.ok("zero writes reached Aryeo", writes0() === w0 && fence.blocked.length === 0);
  await recalc(A); await recalc(A);
  const sweep = await rs.reassessOpenMonths({ now: new Date() });
  c.ok("three more passes and the hourly sweep: still one row, one task", (await rows(A)).length === 1 && (await tasks(A)).length === 1 && sweep.raised === 0, JSON.stringify(sweep));
  {
    const portal = await import("@/lib/portal");
    const m = (await portal.portalScheduleMonths({ id: A.enrollmentId, clientId: A.clientId })).find((x) => x.monthId === A.monthId);
    c.ok("the portal session says Kyle will confirm the filming time", m?.sessions.length === 1 && m.sessions[0].kyleConfirming === true, JSON.stringify(m?.sessions.map((s) => s.kyleConfirming)));
    const { ReassessmentBanner } = await import("@/components/content/ReassessmentBanner");
    const el = await ReassessmentBanner({ monthId: A.monthId });
    c.ok("the staff Sessions banner shows it", !!el && JSON.stringify(el).includes("needs a second look") && JSON.stringify(el).includes("Preparation time changed"));
  }

  const r3 = await reschedule(A, r2.id, et(10, 5, 14), et(10, 5, 14, 30));
  await recalc(A);
  rA = await rows(A); tA = await tasks(A);
  c.ok("moved back to Monday: resolved and the task closed itself", rA.length === 1 && rA[0].state === "RESOLVED" && tA[0].status === "COMPLETED", `${rA[0]?.state} · ${tA[0]?.status}`);
  {
    const portal = await import("@/lib/portal");
    const m = (await portal.portalScheduleMonths({ id: A.enrollmentId, clientId: A.clientId })).find((x) => x.monthId === A.monthId);
    const { ReassessmentBanner } = await import("@/components/content/ReassessmentBanner");
    c.ok("…the portal line and the banner are gone", m?.sessions[0]?.kyleConfirming === false && (await ReassessmentBanner({ monthId: A.monthId })) === null);
  }

  await prisma.programCallRecord.update({ where: { id: r3.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await recalc(A);
  const lost = await rows(A, { kind: "ANCHOR_LOST" });
  c.ok("cancelled with no replacement: ANCHOR_LOST + a task", lost.length === 1 && lost[0].state === "OPEN" && /was cancelled, and no new call is booked for 2026-10/.test(lost[0].reason) && (await openTasks(A)).length === 1, lost[0]?.reason);
  c.ok("…keyed on the call that is gone", lost[0]?.anchorRef.startsWith(`CALL_END:${r3.id}:`));
  const r4 = await call(A, et(10, 5, 14), et(10, 5, 14, 30));
  await recalc(A);
  c.ok("rebooked in time: resolved, nothing open", (await rows(A, { state: "OPEN" })).length === 0 && (await openTasks(A)).length === 0);
  setClock(et(10, 5, 15));
  await prisma.programCallRecord.update({ where: { id: r4.id }, data: { status: "NO_SHOW" } });
  await recalc(A);
  const noShow = (await rows(A, { kind: "ANCHOR_LOST", state: "OPEN" }))[0];
  c.ok("a no-show: ANCHOR_LOST again, as its own row and task", !!noShow && /was marked a no-show/.test(noShow.reason) && noShow.anchorRef.startsWith(`CALL_END:${r4.id}:`) && (await openTasks(A)).length === 1, noShow?.reason);
  c.ok("across all of it: zero Aryeo writes, the appointment never moved", writes0() === w0 && (await apptOf(A)).startAt?.getTime() === apptA.startAt?.getTime());
  setClock(et(10, 5, 9));

  // ======================================================================
  c.head("B · a 48-hour booking is never flagged by the 72-hour rule alone (Friday call, weekend, DST)");
  const B = await buildContentMonth(db, { name: "Blair Friday TEST", package: "Accelerator", monthKey: "2026-11", appointments: [{ startAt: et(11, 3, 15), durationMin: 240 }] });
  await prisma.contentMonth.update({ where: { id: B.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
  const rb = await call(B, et(10, 30, 14), et(10, 30, 14, 30)); // Fri Oct 30, 2:00–2:30 PM EDT
  const dB = (await pm.recalcProgramMonth(B.monthId, { now: new Date(), dryRun: true }))!.after;
  const gB = pm.preparationGate(dB, 1);
  c.ok("the rule today: Fri 2:30 PM EDT + 72 weekday hours = Wed Nov 4 2:30 PM EST (weekend and DST crossed)", dB.windowHours === 72 && gB.earliest?.getTime() === et(11, 4, 14, 30).getTime(), gB.earliest?.toISOString());
  const old48 = pm.addWeekdayHoursET(et(10, 30, 14, 30), 48);
  c.ok("…the rule it was booked under: + 48 = Tue Nov 3 2:30 PM EST", old48.getTime() === et(11, 3, 14, 30).getTime(), old48.toISOString());
  await snapshot(B, { route: "CALL", anchorRef: gB.anchor!.ref, anchorAt: gB.anchor!.at, windowHours: 48, earliestAt: old48 });
  c.ok("the Tue 3:00 PM EST session is inside 72 but outside 48", et(11, 3, 15) < gB.earliest! && et(11, 3, 15) >= old48);
  await recalc(B); await recalc(B); await recalc(B);
  c.ok("anchor unchanged, rule changed: three passes raise nothing", (await rows(B)).length === 0 && (await tasks(B)).length === 0);
  await prisma.programCallRecord.update({ where: { id: rb.id }, data: { scheduledStart: et(10, 30, 15), scheduledEnd: et(10, 30, 15, 30) } });
  await recalc(B); await recalc(B);
  const rB = await rows(B);
  c.ok("the call moves 30 min later: flagged once, judged by the 48 hours it was booked under", rB.length === 1 && rB[0].kind === "ANCHOR_MOVED" && /inside the 48 weekday hours/.test(rB[0].reason) && /Tue, Nov 3, 3:30 PM ET or later/.test(rB[0].reason) && (await tasks(B)).length === 1, rB[0]?.reason);

  // ======================================================================
  c.head("C · booked outside the hub: a baseline on first sight, then a real move");
  const C = await buildContentMonth(db, { name: "Casey Handbooked TEST", package: "Starter", monthKey: "2026-10", appointments: [{ startAt: et(10, 12, 10), durationMin: 120 }] });
  await prisma.contentMonth.update({ where: { id: C.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
  const rc = await call(C, et(10, 6, 10), et(10, 6, 10, 30)); // Tue → earliest Fri 10:30
  await recalc(C); await recalc(C);
  const base = await prisma.programSessionReassessment.findMany({ where: { monthId: C.monthId, kind: "BASELINE" } });
  c.ok("first sight: one BASELINE row (resolved, no task), nothing to reassess", base.length === 1 && base[0].state === "RESOLVED" && base[0].anchorRef.startsWith(`CALL_END:${rc.id}:`) && (await rows(C)).length === 0 && (await tasks(C)).length === 0, base.map((b) => b.anchorRef).join());
  await reschedule(C, rc.id, et(10, 9, 10), et(10, 9, 10, 30)); // Fri → earliest Wed Oct 14
  await recalc(C);
  let rC = await rows(C);
  c.ok("the call moves to Friday: the Monday session is flagged against the baseline", rC.length === 1 && rC[0].kind === "ANCHOR_MOVED" && rC[0].state === "OPEN" && (await openTasks(C)).length === 1, rC[0]?.reason);
  await prisma.smartTask.updateMany({ where: { id: rC[0].taskId! }, data: { status: "COMPLETED", completedAt: new Date() } });
  await recalc(C); await recalc(C);
  rC = await rows(C);
  c.ok("Kyle closes the task (the session stays): ACKNOWLEDGED, not raised again", rC.length === 1 && rC[0].state === "ACKNOWLEDGED" && (await openTasks(C)).length === 0, rC.map((r) => r.state).join());
  {
    const portal = await import("@/lib/portal");
    const m = (await portal.portalScheduleMonths({ id: C.enrollmentId, clientId: C.clientId })).find((x) => x.monthId === C.monthId);
    c.ok("…and the portal no longer says Kyle will confirm", m?.sessions[0]?.kyleConfirming === false);
  }

  // ======================================================================
  c.head("D · written route + a strategy call ending 24 hours before the shoot: ONE task");
  const D = await buildContentMonth(db, { name: "Devon Written TEST", package: "Starter", monthKey: "2026-10", appointments: [{ startAt: et(10, 15, 10), durationMin: 120 }] });
  await prisma.contentMonth.update({ where: { id: D.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
  await recalc(D);
  c.ok("no call: nothing", (await rows(D)).length === 0);
  await call(D, et(10, 14, 10), et(10, 14, 10, 30)); // ends Wed 10:30, shoot Thu 10:00
  await recalc(D); await recalc(D);
  const rD = await rows(D);
  const bufferTasks = await prisma.smartTask.findMany({ where: { clientId: D.clientId, dedupeKey: { startsWith: "program-call-buffer:" } } });
  c.ok("one CALL_BUFFER reassessment, linked to the existing buffer task", rD.length === 1 && rD[0].kind === "CALL_BUFFER" && bufferTasks.length === 1 && rD[0].taskId === bufferTasks[0].id, `${rD.map((r) => r.kind).join()} · ${bufferTasks.length} buffer task(s)`);
  c.ok("…and no second task of our own for the same conflict", (await tasks(D)).length === 0);

  // ======================================================================
  c.head("E · route switch WRITTEN → CALL: nothing cancelled; a task only once the call conflicts");
  const E = await buildContentMonth(db, { name: "Emery Switch TEST", package: "Starter", monthKey: "2026-10", appointments: [{ startAt: et(10, 16, 10), durationMin: 120 }] });
  await prisma.contentMonth.update({ where: { id: E.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
  const reqE = await snapshot(E, { route: "WRITTEN", anchorRef: `SUBMISSION:month:${et(10, 2, 9).getTime()}`, anchorAt: et(10, 2, 9), windowHours: 72, earliestAt: et(10, 7, 9) });
  const re = await call(E, et(10, 5, 16), et(10, 5, 16, 30)); // Mon → earliest Thu Oct 8 4:30 PM
  const wE = writes0();
  await pm.setPlanningMode(E.monthId, "CALL", "drill");
  c.ok("switched to the call route with the call well before the shoot: no task", (await rows(E)).length === 0 && (await tasks(E)).length === 0);
  await reschedule(E, re.id, et(10, 15, 10), et(10, 15, 10, 30)); // Thu → earliest Tue Oct 20
  await recalc(E);
  const rE = await rows(E);
  c.ok("the call moves to the day before the shoot: flagged", rE.length === 1 && rE[0].kind === "ANCHOR_MOVED" && (await openTasks(E)).length === 1, rE[0]?.reason);
  const reqE2 = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: reqE.id } });
  c.ok("the switch cancelled nothing and wrote nothing to Aryeo", reqE2.status === "CONFIRMED" && (await prisma.programSessionRequest.count({ where: { monthId: E.monthId } })) === 1 && writes0() === wE);

  // ======================================================================
  c.head("F · TEST clients make no owner work without PROGRAM_DESK_TASKS_FOR_TEST=1");
  {
    delete process.env.PROGRAM_DESK_TASKS_FOR_TEST;
    const r = await rs.reassessMonthSessions(E.monthId, { now: new Date() });
    c.ok("with the flag off a TEST month is skipped entirely", r.skipped === "TEST client" && r.raised === 0 && r.resolved === 0);
    process.env.PROGRAM_DESK_TASKS_FOR_TEST = "1";
  }

  // ======================================================================
  c.head("G · an address change pending holds the confirmation text; the brief says so");
  {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("openphone", "drill-key-not-a-real-one");
    setClock(et(10, 5, 11)); // Mon 11:00 AM ET — inside the client-text window
    const G = await buildContentMonth(db, { name: "Gray Address TEST", package: "Starter", monthKey: "2026-10", appointments: [{ startAt: et(10, 6, 10), durationMin: 120 }] });
    await prisma.client.update({ where: { id: G.clientId }, data: { phone: "215-534-8650" } });
    await prisma.project.update({ where: { id: G.projectId! }, data: { addressLine: "October 2026 Social Content", city: "West Chester", state: "PA", zip: "19380" } });
    const task = await prisma.smartTask.create({ data: { title: "Confirm Tuesday's shoot", taskType: "confirmation_text", status: "OPEN", projectId: G.projectId, clientId: G.clientId, dedupeKey: `drill-confirm-${G.projectId}` } });
    const a = await apptOf(G);
    const row = await prisma.programSessionAddress.create({
      data: {
        sessionKey: `appt:${a.aryeoId}`, enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, projectId: G.projectId, aryeoAppointmentId: a.aryeoId, shootStartAt: a.startAt,
        streetNumber: "117", streetName: "Kyle Ln", city: "West Chester", stateCode: "PA", postalCode: "19380", submittedAt: new Date(), submittedBy: "client", version: 1, syncState: "PENDING",
      },
    });
    const { sweepConfirmationTexts } = await import("@/lib/clientTextSweeps");
    const { getShoot } = await import("@/lib/shoot");
    const outbox0 = await prisma.outboxMessage.count();
    const held = await sweepConfirmationTexts(new Set());
    const tRow = await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } });
    c.ok("PENDING: the confirmation is held with the reason", held.notes.some((n) => /address change pending — confirmation held/.test(n)) && held.sent === 0, held.notes.join(" | "));
    c.ok("…the reason is on Kyle's task", /On hold: address change pending/.test(tRow.summary ?? "") && tRow.status === "OPEN");
    c.ok("…nothing queued or sent", (await prisma.outboxMessage.count()) === outbox0 && sent.length === 0);
    const brief = await getShoot(G.projectId!);
    c.ok("the shoot brief shows the pending line with the NEW address", brief?.project.addressChangePending === "Address change pending: 117 Kyle Ln, West Chester, PA 19380 (not yet on the booking)", brief?.project.addressChangePending ?? "null");
    for (const state of ["DESK", "FAILED"]) {
      await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: state } });
      const r = await sweepConfirmationTexts(new Set());
      c.ok(`${state}: still held`, r.notes.some((n) => /address change pending/.test(n)));
    }
    await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "SYNCED", syncedAt: new Date() } });
    // Released: the sweep goes past the hold to its own "already sent" marker
    // (stamped here so the drill never reaches a send).
    const at = a.startAt!;
    const day = at.toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
    const hhmm = at.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).replace(":", "");
    await prisma.appSetting.create({ data: { key: `auto-confirm-${G.projectId}-${day}-${hhmm}`, value: "drill" } });
    const released = await sweepConfirmationTexts(new Set());
    c.ok("SYNCED releases it: no hold (the sweep reaches its own sent-marker instead)", !released.notes.some((n) => /address change pending/.test(n)) && released.skipped >= 1, released.notes.join(" | "));
    c.ok("…and the brief drops the pending line", (await getShoot(G.projectId!))?.project.addressChangePending === null);
    setClock(et(10, 5, 9));
  }

  // ======================================================================
  // Batch-3 review (Sep 25 2026): a COMPLETED the recalc took FROM a record
  // outlived the record. Ignored or moved to another month, the record left
  // the month's input, the stamp read as legacy truth, and filming opened 72
  // weekday hours after a call this client never had (with a CONFIRM_CALL_END
  // task claiming the month "has no call record"). That code was this batch's
  // own, so the rule is asserted directly.
  c.head("H · a COMPLETED taken from a record: the record is ignored, or moved to another month");
  {
    const ccr = await import("@/lib/contentCallRecords");
    const endTasks = (f: ContentMonthFixture) => prisma.smartTask.count({ where: { dedupeKey: { startsWith: `program-call-end:${f.monthId}:` }, status: "OPEN" } });
    for (const how of ["ignored", "moved to November"] as const) {
      setClock(et(10, 5, 16)); // Mon 4 PM: the 2:00–2:30 call is over
      const H = await buildContentMonth(db, { name: `Hana ${how === "ignored" ? "Ignored" : "Moved"} TEST`, package: "Accelerator", monthKey: "2026-10", appointments: [{ startAt: et(10, 13, 15), durationMin: 240 }] });
      await prisma.contentMonth.update({ where: { id: H.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
      const rec = await call(H, et(10, 5, 14), et(10, 5, 14, 30), { status: "COMPLETED" });
      await recalc(H);
      const m1 = await prisma.contentMonth.findUniqueOrThrow({ where: { id: H.monthId }, select: { strategyCallStatus: true, strategyCallAt: true } });
      const g1 = pm.preparationGate((await pm.recalcProgramMonth(H.monthId, { now: new Date(), dryRun: true }))!.after, 1);
      c.ok(`(${how}) the held record stamped the month COMPLETED at its start; filming opened from its end`, m1.strategyCallStatus === "COMPLETED" && m1.strategyCallAt?.getTime() === et(10, 5, 14).getTime() && !g1.locked, `${m1.strategyCallStatus} ${g1.reason}`);
      await snapshot(H, { route: "CALL", anchorRef: g1.anchor!.ref, anchorAt: g1.anchor!.at, windowHours: 72, earliestAt: g1.earliest });
      await recalc(H);
      const w0 = writes0();
      if (how === "ignored") await ccr.ignoreCallRecord(rec.id, "drill", "not this client's call");
      else await ccr.setCallRecordTargetMonth(rec.id, "2026-11", "drill");
      const m2 = await prisma.contentMonth.findUniqueOrThrow({ where: { id: H.monthId }, select: { strategyCallStatus: true, strategyCallAt: true } });
      const d2 = (await pm.recalcProgramMonth(H.monthId, { now: new Date(), dryRun: true }))!.after;
      const g2 = pm.preparationGate(d2, 1);
      c.ok(`(${how}) October lets the record's stamp go: NOT_SCHEDULED, no time`, m2.strategyCallStatus === "NOT_SCHEDULED" && m2.strategyCallAt === null, `${m2.strategyCallStatus} ${m2.strategyCallAt?.toISOString()}`);
      c.ok(`(${how}) filming shuts ('book your call'): no legacy anchor, no CONFIRM_CALL_END`, g2.locked && g2.lock === "BOOK_CALL" && !d2.followUps.some((f) => f.kind === "CONFIRM_CALL_END") && (await endTasks(H)) === 0, `${g2.lock} ${g2.anchor?.ref ?? "no anchor"}`);
      const lostH = await rows(H, { kind: "ANCHOR_LOST", state: "OPEN" });
      c.ok(`(${how}) the booked session is reassessed: ANCHOR_LOST + one task, nothing moved, zero writes`, lostH.length === 1 && /no longer on file for 2026-10/.test(lostH[0].reason) && (await openTasks(H)).length === 1 && writes0() === w0, lostH[0]?.reason ?? "none");
    }
    setClock(et(10, 5, 9));
  }

  c.ok("fence: nothing left the machine", fence.blocked.length === 0 && sent.length === 0, [...fence.blocked, ...sent].slice(0, 3).join(", "));
  c.summary();
  quiet.restore();
  fence.restore();
  fs.rmSync(baseDir, { recursive: true, force: true });
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(baseDir, { recursive: true, force: true });
  process.exit(1);
});

void DRILL_TEAM;
