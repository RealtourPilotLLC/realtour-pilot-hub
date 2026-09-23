// ---------------------------------------------------------------------------
// DRILL: TWO DISTINCT CONFIRMED SESSIONS (§18 A23 / A24, batch 2, Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/pro-two-sessions.ts
//
// Jordan, Sep 21: "Video Pro is two separate four-hour sessions. Book the
// existing four-hour Video Pro product in Aryeo twice. The month is fully
// scheduled only when two distinct, confirmed sessions are linked to that
// client and month. One booking should still show one session remaining."
//
// There is exactly ONE Pro enrollment on the roster, it is PAUSED, and Aryeo has
// never carried a single Pro order — so the two-session path cannot be exercised
// from production data at all. The rule therefore has to be held to account as a
// PURE function with a Pro month put in front of it, which is section 2 below.
// Sections 4 and 5 then replay the change over every live month and every live
// enrollment to prove that nothing real moves.
//
// READ-ONLY, STRUCTURALLY. The connection refuses writes and this file proves it
// with a refused UPDATE before it reads anything.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../.env")]) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`   ok   ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`   FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const D = (iso: string) => new Date(iso);
const NOW = D("2026-10-05T15:00:00Z"); // a Monday inside a live-looking October

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  const { countDistinctSessions, sessionShortfall, deriveMonthState } = await import("../../src/lib/programMonths");
  const { sessionGap, midMonthExemption, monthlyCalendar, REMINDER_DEFAULTS, validateReminderPolicy, secondSessionParagraph, MID_MONTH_PARAGRAPH, withExtraParagraph } = await import("../../src/lib/programReminders");

  // =========================================================================
  console.log("\n1. A23 — ONE PRO BOOKING STILL SHOWS ONE SESSION REMAINING");
  // =========================================================================
  const proPlan = { videosPerMonth: 8, sessionsPerMonth: 2 };
  const leg = (id: string, start: string, end: string, project = "order-1") =>
    ({ appointmentId: id, projectId: project, startAt: D(start), endAt: D(end), cancelled: false });

  const none = countDistinctSessions({ now: NOW, appointments: [], projects: [], confirmedRequests: [] });
  check("no bookings: 0 sessions", sessionShortfall(2, none).accountedFor === 0 && sessionShortfall(2, none).missing === 2);
  check("no bookings: the ask is session 1", sessionGap({ sessionsRequired: 2, sessionsBooked: none.booked, sessionsFilmed: none.filmed, pendingSessionRequests: 0 }).ordinal === 1);

  const one = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z")],
    projects: [{ projectId: "order-1", shootDate: D("2026-10-14T14:00:00Z") }],
    confirmedRequests: [],
  });
  const oneShort = sessionShortfall(2, one);
  check("ONE four-hour booking: exactly one session", oneShort.accountedFor === 1, `booked=${one.booked} filmed=${one.filmed}`);
  check("ONE booking: one session remaining", oneShort.missing === 1 && oneShort.fullyScheduled === false);
  const gap1 = sessionGap({ sessionsRequired: 2, sessionsBooked: one.booked, sessionsFilmed: one.filmed, pendingSessionRequests: 0 });
  check("ONE booking does NOT silence the reminder", gap1.action === "BOOK_SESSION", `ordinal=${gap1.ordinal}`);
  check("the reminder names the MISSING session (2)", gap1.ordinal === 2);

  // THE SHAPE JORDAN SPECIFIED: the same four-hour product booked twice, which
  // is two appointments on ONE Aryeo order and therefore ONE Project here.
  const two = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z"), leg("A2", "2026-10-21T14:00:00Z", "2026-10-21T18:00:00Z")],
    projects: [{ projectId: "order-1", shootDate: D("2026-10-14T14:00:00Z") }],
    confirmedRequests: [],
  });
  const twoShort = sessionShortfall(2, two);
  check("the product booked TWICE on one order = TWO sessions", twoShort.accountedFor === 2, two.sessions.map((x) => x.key).join(" + "));
  check("two bookings: fully scheduled, nothing remaining", twoShort.missing === 0 && twoShort.fullyScheduled === true);
  check("two bookings: the reminder stops", sessionGap({ sessionsRequired: 2, sessionsBooked: two.booked, sessionsFilmed: two.filmed, pendingSessionRequests: 0 }).action === null);
  // The count this replaces: one project with a shoot date = one session.
  check("THE DEFECT: project-counting would have said 1 of 2", new Set(two.sessions.map((x) => x.projectId)).size === 1);

  // An Accelerator (one session) is unaffected by any of it.
  const acc = countDistinctSessions({ now: NOW, appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z")], projects: [{ projectId: "o", shootDate: D("2026-10-14T14:00:00Z") }], confirmedRequests: [] });
  check("Accelerator: one booking is a full month", sessionShortfall(1, acc).fullyScheduled === true);

  // =========================================================================
  console.log("\n2. A23/A24 — DISTINCTNESS: TWO RECORDS, ONE SESSION");
  // =========================================================================
  const sameAppt = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z")],
    projects: [{ projectId: "order-1", shootDate: D("2026-10-14T14:00:00Z") }],
    confirmedRequests: [
      { requestId: "r1", projectId: "order-1", appointmentId: "A1", slotStart: D("2026-10-14T14:00:00Z") },
      { requestId: "r2", projectId: "order-1", appointmentId: "A1", slotStart: D("2026-10-14T15:00:00Z") },
    ],
  });
  check("two confirmed requests on ONE appointment are ONE session", sameAppt.accountedFor === 1, `folded ${sameAppt.duplicatesFolded}`);
  check("a Pro month there is still one session short", sessionShortfall(2, sameAppt).missing === 1);
  check("the evidence names every record that folded in", sameAppt.sessions[0].evidence.length === 3, sameAppt.sessions[0].evidence.join(" / "));
  check("the project row did not become a fourth session on top of its own leg", sameAppt.sessions.length === 1);

  const twoRequestsTwoAppts = countDistinctSessions({
    now: NOW, appointments: [],
    projects: [],
    confirmedRequests: [
      { requestId: "r1", projectId: null, appointmentId: "A1", slotStart: D("2026-10-14T14:00:00Z") },
      { requestId: "r2", projectId: null, appointmentId: "A2", slotStart: D("2026-10-21T14:00:00Z") },
    ],
  });
  check("two requests on two DIFFERENT appointments are two sessions", twoRequestsTwoAppts.accountedFor === 2);

  const noStart = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z"), { appointmentId: "A2", projectId: "order-1", startAt: null, endAt: null, cancelled: false }],
    projects: [{ projectId: "order-1", shootDate: D("2026-10-14T14:00:00Z") }], confirmedRequests: [],
  });
  check("an UNSCHEDULED leg with no start is NOT a booked session", sessionShortfall(2, noStart).accountedFor === 1, "Jordan: never invent a production date");

  const cancelled = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z"), { ...leg("A2", "2026-10-21T14:00:00Z", "2026-10-21T18:00:00Z"), cancelled: true }],
    projects: [{ projectId: "order-1", shootDate: D("2026-10-14T14:00:00Z") }], confirmedRequests: [],
  });
  const cancelledShort = sessionShortfall(2, cancelled);
  check("a CANCELLED second session takes the month back to one", cancelledShort.accountedFor === 1 && cancelledShort.missing === 1);
  check("and the reminder asks for session 2 again", sessionGap({ sessionsRequired: 2, sessionsBooked: cancelled.booked, sessionsFilmed: cancelled.filmed, pendingSessionRequests: 0 }).ordinal === 2);

  const filmedOne = countDistinctSessions({
    now: NOW,
    appointments: [leg("A1", "2026-09-30T14:00:00Z", "2026-09-30T18:00:00Z"), leg("A2", "2026-10-21T14:00:00Z", "2026-10-21T18:00:00Z")],
    projects: [{ projectId: "order-1", shootDate: D("2026-09-30T14:00:00Z") }], confirmedRequests: [],
  });
  check("one filmed + one booked = fully scheduled", filmedOne.filmed === 1 && filmedOne.booked === 1 && sessionShortfall(2, filmedOne).fullyScheduled === true);
  const pending = sessionGap({ sessionsRequired: 2, sessionsBooked: one.booked, sessionsFilmed: one.filmed, pendingSessionRequests: 1 });
  check("a request waiting on the OFFICE is not the client's to chase", pending.action === null && pending.suppression === "pending_session_request");

  // =========================================================================
  console.log("\n2b. WHAT THE CLIENT ACTUALLY READS ABOUT THE SECOND SESSION");
  // =========================================================================
  const para = secondSessionParagraph(2, 2, 8);
  console.log(`   "${para}"`);
  check("it names session 2 of 2", para.includes("session 2 of 2"));
  check("it counts the videos off the PACKAGE, not the word four", para.includes("another 4 videos") && secondSessionParagraph(2, 2, 10).includes("another 5 videos"));
  check("it says one is already on the calendar", para.includes("one is\n") || para.includes("one is already on the calendar"));
  check("it ends with the way forward", /Pick a time in your portal and we'll confirm it\.$/.test(para));
  const clientCopy = [para, MID_MONTH_PARAGRAPH];
  check("Jordan's voice: no em dashes", clientCopy.every((x) => !x.includes("\u2014")));
  check("Jordan's voice: no emojis", clientCopy.every((x) => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(x)));
  const body = withExtraParagraph("Hi Jordan,\n\nSomething.\n\n\u2014 Jordan\nRealTour Pilot", para);
  check("the paragraph lands ABOVE the sign-off", body.indexOf(para) < body.indexOf("\u2014 Jordan"));

  // =========================================================================
  console.log("\n3. THE MONTH STATE AGREES WITH THE PORTAL AND THE CHASER");
  // =========================================================================
  const monthShell = {
    strategyCallStatus: "COMPLETED", strategyCallAt: D("2026-10-02T14:00:00Z"), transcriptText: null,
    planningMode: "CALL", preparationStatus: null, preparationCompletedAt: null, preparationWindowDays: null,
    preparationExceptionAt: null, preparationExceptionReason: null, filmingReadyAt: null, historical: false,
  };
  const derived = (booking: ReturnType<typeof countDistinctSessions> | null) => deriveMonthState({
    now: NOW, month: monthShell,
    enrollment: { callMode: "REQUIRED", strategyCallRequired: true, noCallEligible: false },
    records: [{ callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: D("2026-10-02T14:00:00Z"), scheduledEnd: D("2026-10-02T14:30:00Z"), transcriptState: "CONFIRMED" }],
    scripts: [], interviews: [], topics: [], plan: proPlan, booking,
  });
  const dOne = derived(one);
  check("month state: one Pro booking reads 1 of 2", dOne.sessionsAccountedFor === 1 && dOne.sessionsRequired === 2 && dOne.sessionsMissing === 1 && dOne.fullyScheduled === false);
  const dTwo = derived(two);
  check("month state: two Pro bookings read fully scheduled", dTwo.sessionsAccountedFor === 2 && dTwo.fullyScheduled === true);
  const dNone = derived(null);
  check("no booking evidence supplied: bookingKnown false, not 'fully scheduled'", dNone.bookingKnown === false && dNone.fullyScheduled === false, "we did not look is not nothing is booked");
  check("the preparation clock from batch 1 is untouched", dOne.windowHours === 48 && dOne.earliestSessionAt?.toISOString() === "2026-10-06T14:30:00.000Z", dOne.earliestSessionAt?.toISOString() ?? "null");

  // =========================================================================
  console.log("\n4. CLARIFICATION 3 — NO PLANNING DEADLINE, AND THE 20th");
  // =========================================================================
  const cal = monthlyCalendar("2026-11", REMINDER_DEFAULTS);
  check("no date is quoted to a client by default", cal.quotedPlanningDeadlineAt === null && REMINDER_DEFAULTS.quotedPlanningDeadlineDayOfMonth === null);
  check("the 1st and the 15th are still the milestones", REMINDER_DEFAULTS.monthlyOpenDayOfMonth === 1 && REMINDER_DEFAULTS.midMonthDayOfMonth === 15);
  check("a weekend 1st still moves to the next weekday", monthlyCalendar("2026-11", REMINDER_DEFAULTS).monthOpenAt.toISOString().slice(0, 10) === "2026-11-02", "2026-11-01 is a Sunday");
  check("the first-cycle exemption stands", midMonthExemption({ firstCycle: true, carryoverUnclassified: 0 }) === "first_cycle_exempt");
  check("the agency-delayed-work exemption stands", midMonthExemption({ firstCycle: false, carryoverUnclassified: 2 }) === "catch_up_owed");
  console.log(`   FOUND: the only booking cutoff in the tree is REMINDER_DEFAULTS.sessionBookingDeadlineDayOfMonth = ${REMINDER_DEFAULTS.sessionBookingDeadlineDayOfMonth}`);
  console.log("          src/lib/programReminders.ts — declared at the ReminderPolicy type, defaulted in REMINDER_DEFAULTS,");
  console.log("          validated in validateReminderPolicy, and READ IN EXACTLY ONE PLACE: the BOOK_SESSION branch of");
  console.log("          evaluateMonth, which sets the INTERNAL `deadlineAt` the escalation threshold measures.");
  const v = validateReminderPolicy({ ...REMINDER_DEFAULTS });
  check("the stored default policy still validates", v.ok === true);
  check("setting a quoted deadline warns that it is a promise", (() => { const w = validateReminderPolicy({ ...REMINDER_DEFAULTS, quotedPlanningDeadlineDayOfMonth: 15 }); return w.ok && w.warnings.some((x) => x.includes("promise about turnaround")); })());

  // =========================================================================
  console.log("\n5. A24 — THE ADVISORY LOCK, AGAINST THIS DATABASE");
  // =========================================================================
  // The lock is what makes "read the capacity" and "write the request" one
  // decision. ::int4 is not decoration: without the casts Postgres raises 42883
  // (it has no pg_advisory_xact_lock(bigint, bigint)), which is how cut uploads
  // were broken for four hours on Sep 18. Advisory locks are legal inside a
  // read-only transaction, so this proves the real mechanism without a write.
  const key = (str: string): [number, number] => {
    const fnv = (seed: number) => { let h = seed; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h | 0; };
    return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
  };
  const [a1, b1] = key("program-session|E1|M1");
  const [a2, b2] = key("program-session|E1|M2");
  check("the same month gives the same key pair", key("program-session|E1|M1").join() === `${a1},${b1}`);
  check("a different month gives a different pair", `${a1},${b1}` !== `${a2},${b2}`);
  let castOk = true, castErr = "";
  try { await prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a1}::int4, ${b1}::int4)`; }); }
  catch (e) { castOk = false; castErr = e instanceof Error ? e.message.slice(0, 120) : String(e); }
  check("pg_advisory_xact_lock(::int4, ::int4) is accepted by THIS database", castOk, castErr);
  // Mutual exclusion, measured: holder sleeps 1.2s, the waiter cannot proceed until it lets go.
  const t0 = Date.now();
  let waiterStartedAt = 0, waiterGotItAt = 0;
  const holder = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a1}::int4, ${b1}::int4)`;
    await tx.$queryRaw`SELECT pg_sleep(1.2)::text`;
  }, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 200));
  const waiter = prisma.$transaction(async (tx) => {
    waiterStartedAt = Date.now();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a1}::int4, ${b1}::int4)`;
    waiterGotItAt = Date.now();
  }, { timeout: 20_000 });
  await Promise.all([holder, waiter]);
  const waited = waiterGotItAt - waiterStartedAt;
  check("a second caller on the SAME month WAITS for the first", waited > 700, `waited ${waited} ms (holder held ~1200 ms, total ${Date.now() - t0} ms)`);
  // Two different months must not queue behind each other.
  let crossWait = 0;
  const holder2 = prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a1}::int4, ${b1}::int4)`; await tx.$queryRaw`SELECT pg_sleep(1.0)::text`; }, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 150));
  const other = prisma.$transaction(async (tx) => { const s = Date.now(); await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a2}::int4, ${b2}::int4)`; crossWait = Date.now() - s; }, { timeout: 20_000 });
  await Promise.all([holder2, other]);
  check("a DIFFERENT month does not queue behind it", crossWait < 400, `waited ${crossWait} ms`);

  // =========================================================================
  console.log("\n6. LIVE REPLAY — WHAT MOVES FOR REAL CLIENTS TODAY");
  // =========================================================================
  const { sessionCapacity } = await import("../../src/lib/sessionRequests");
  const now = new Date();
  const enrollments = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true, status: true, package: true, sessionsPerMonth: true, videosPerMonth: true } });
  const clientNames = new Map((await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const months = await prisma.contentMonth.findMany({ where: { historical: false }, select: { id: true, enrollmentId: true, monthKey: true } });
  let changedRemaining = 0, changedUsed = 0, checkedMonths = 0;
  for (const m of months) {
    const e = enrollments.find((x) => x.id === m.enrollmentId);
    if (!e) continue;
    checkedMonths++;
    const cap = await sessionCapacity(e.id, m.id, { now });
    // The count this replaces, recomputed here from the same rows.
    const projects = await prisma.project.findMany({ where: { contentMonthId: m.id, clientId: e.clientId, status: { not: "CANCELLED" }, shootDate: { not: null } }, select: { id: true } });
    const reqs = await prisma.programSessionRequest.findMany({ where: { enrollmentId: e.id, monthId: m.id, status: { in: ["CONFIRMED", "REQUESTED"] } }, select: { projectId: true, kind: true, extraApprovedBy: true } });
    const ids = new Set(projects.map((p) => p.id));
    const oldUsed = ids.size + reqs.filter((r) => !(r.projectId && ids.has(r.projectId))).length;
    const oldAllowed = e.sessionsPerMonth + reqs.filter((r) => r.kind === "EXTRA_SESSION" && r.extraApprovedBy).length;
    const oldRemaining = Math.max(0, oldAllowed - oldUsed);
    if (oldUsed !== cap.used) { changedUsed++; console.log(`   used changed: ${clientNames.get(e.clientId)} ${m.monthKey} ${oldUsed} -> ${cap.used} (allowed ${cap.allowed})`); }
    if (oldRemaining !== cap.remaining) { changedRemaining++; console.log(`   REMAINING CHANGED: ${clientNames.get(e.clientId)} ${m.monthKey} ${oldRemaining} -> ${cap.remaining}`); }
  }
  console.log(`   ${checkedMonths} live months replayed`);
  check("no live client's bookable REMAINING moves", changedRemaining === 0, `${changedUsed} month(s) report a different 'used' (the second leg they really have)`);

  // THE ONE MONTH IN PRODUCTION WHERE THE TWO COUNTS DISAGREE. Joe Sutow's
  // 2026-07 is one Aryeo order with TWO appointment legs (07-24 14:30-18:30Z and
  // 07-27 19:00-20:00Z) and a project shootDate pointing at the SECOND. It is
  // `historical: true` / IMPORTED, so it is outside the replay above and outside
  // the hourly recalculation — but it is the exact shape a Pro month will take,
  // sitting in the live database today.
  const joeMonth = await prisma.contentMonth.findUnique({ where: { id: "cmt7h6fj9001h9kcjmtliyh3y" }, select: { monthKey: true, historical: true, enrollmentId: true } });
  if (joeMonth) {
    const cap = await sessionCapacity(joeMonth.enrollmentId, "cmt7h6fj9001h9kcjmtliyh3y", { now });
    console.log(`   Joe Sutow ${joeMonth.monthKey} (historical=${joeMonth.historical}): allowed ${cap.allowed}, used ${cap.used}, remaining ${cap.remaining}, confirmed sessions ${cap.confirmedSessions}`);
    check("the two-leg month now counts BOTH legs", cap.confirmedSessions === 2, "project-counting said 1");
    check("and it still offers no further booking", cap.remaining === 0);
    check("it is historical, so the hourly recalculation never touches it", joeMonth.historical === true);
  } else {
    check("the two-leg month is still on file", false, "cmt7h6fj9001h9kcjmtliyh3y not found");
  }

  const { evaluateReminders } = await import("../../src/lib/programReminders");
  const run = await evaluateReminders({ dryRun: true, now });
  console.log(`   evaluator: ${run.note} (policy ${run.policySource}, enabled ${run.enabled})`);
  check("the evaluator sends nothing on a dry run", run.sent.length === 0);
  check("reminders are still OFF in production", run.enabled === false, "no launch gate moved");
  const laneless = run.candidates.filter((c) => c.decision === "send");
  console.log(`   candidates: ${run.candidates.length}; would send: ${laneless.length}; suppressed: ${run.candidates.filter((c) => c.decision === "suppressed").length}`);
  check("no candidate quotes a date to a client", run.candidates.every((c) => c.quotedDeadlineAt === null), "quotedPlanningDeadlineDayOfMonth is null");
  check("every candidate carries the loss stamp the cadence re-opens on", run.candidates.every((c) => c.state.sessionLostAt === null || !isNaN(Date.parse(c.state.sessionLostAt))));
  check("every candidate carries the completeness answer", run.candidates.every((c) => typeof c.state.fullyScheduled === "boolean"));
  const withSessionCounts = run.candidates.filter((c) => c.state.sessionsRequired > 1);
  console.log(`   candidates on a multi-session package: ${withSessionCounts.length} (the only Pro enrollment is PAUSED)`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
