// ---------------------------------------------------------------------------
// DRILL: THE PREPARATION CLOCK (F04, Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     set -a && source .env; set +a && NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/preparation-clock.ts
//
// Four things, in this order:
//   1. the weekday-hours clock against Jordan's own worked examples and against
//      both 2026 DST transitions, with NO hard-coded UTC offsets anywhere in
//      the expectations — every one is written as an ET wall clock and read
//      back through Intl;
//   2. per-session sufficiency (A15, A23) and the revalidation rule, as pure
//      deriveMonthState calls on fixtures — no database at all;
//   3. a READ-ONLY replay over every live program month, printing what the new
//      derivation says versus what the stored columns say, so the cost of
//      shipping this is a number rather than a hope.
//   4. the real sessionGate, run over every live enrollment's months, with the
//      "booked but not yet held" branch printed three ways — the retired rule,
//      the `windowHours / 24` defect F04 closed, and today's answer — so the
//      question "does any real client's earliest bookable slot move" has a
//      printed answer. Also read-only: sessionGate recalculates as a dry run.
//
// READ-ONLY, STRUCTURALLY. The guard below appends
// `options=-c default_transaction_read_only=on` to DATABASE_URL *before* the
// first dynamic import, because src/lib/prisma builds its client at module load
// and reads DATABASE_URL then. The guard is proved with a real UPDATE before
// step 3 touches anything. Step 1 and step 2 never open a connection.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { DeriveInput, TopicMaterialInput } from "../../src/lib/programMonths";

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

const TZ = "America/New_York";
/** An ET wall clock read off an instant: "Mon 2026-09-14 14:00 EDT". */
function etWall(d: Date | null): string {
  if (!d) return "(none)";
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  });
  const p = f.formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("weekday")} ${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ${g("timeZoneName")}`;
}

let pass = 0, fail = 0;
function check(label: string, got: string, want: string): void {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}\n        got  ${got}${ok ? "" : `\n        want ${want}`}`);
}

async function main() {
  const { addWeekdayHoursET, deriveMonthState, planSessions, DEFAULT_PREPARATION_WINDOW_HOURS } =
    await import("../../src/lib/programMonths");
  const { etAt } = await import("../../src/lib/datetime");

  // =========================================================================
  console.log("\n=== 1. THE CLOCK — 48 hours of weekday time (spec §8, A22) ===");
  // =========================================================================
  const W = DEFAULT_PREPARATION_WINDOW_HOURS;
  // 2026-09-14 is a Monday, 2026-09-18 a Friday. Built with etAt(), so the
  // instant is derived from the ET calendar rather than an offset literal.
  check("A22  Monday 2 PM + 48 weekday hours", etWall(addWeekdayHoursET(etAt("2026-09-14", 14), W)), etWall(etAt("2026-09-16", 14)));
  check("A22  Friday 10 AM + 48 weekday hours", etWall(addWeekdayHoursET(etAt("2026-09-18", 10), W)), etWall(etAt("2026-09-22", 10)));
  check("     Thursday 4 PM  (spans one weekend)", etWall(addWeekdayHoursET(etAt("2026-09-17", 16), W)), etWall(etAt("2026-09-21", 16)));
  check("     Saturday 9 AM  (weekend start → Monday 00:00 + 48)", etWall(addWeekdayHoursET(etAt("2026-09-19", 9), W)), etWall(etAt("2026-09-23", 0)));
  check("     Sunday 11 PM   (same)", etWall(addWeekdayHoursET(etAt("2026-09-20", 23), W)), etWall(etAt("2026-09-23", 0)));
  check("     Friday 00:00 + 24h lands on the next weekday, not Saturday", etWall(addWeekdayHoursET(etAt("2026-09-18", 0), 24)), etWall(etAt("2026-09-21", 0)));
  check("     a 3-day staff override (72 weekday hours)", etWall(addWeekdayHoursET(etAt("2026-09-14", 14), 72)), etWall(etAt("2026-09-17", 14)));

  console.log("\n  DST — the US changes clocks at 2 AM on a SUNDAY, inside the frozen weekend:");
  // Spring forward: Sun 2026-03-08. Fri Mar 6 10 AM EST -> Tue Mar 10 10 AM EDT.
  check("     spring forward: Fri 2026-03-06 10:00 EST + 48", etWall(addWeekdayHoursET(etAt("2026-03-06", 10), W)), etWall(etAt("2026-03-10", 10)));
  // Fall back: Sun 2026-11-01. Fri Oct 30 10 AM EDT -> Tue Nov 3 10 AM EST.
  check("     fall back:      Fri 2026-10-30 10:00 EDT + 48", etWall(addWeekdayHoursET(etAt("2026-10-30", 10), W)), etWall(etAt("2026-11-03", 10)));
  check("     wall clock survives spring forward (Mon before → Wed after)", etWall(addWeekdayHoursET(etAt("2026-03-05", 14), W)), etWall(etAt("2026-03-09", 14)));
  console.log(`     (proof the offsets really differ: ${etWall(etAt("2026-03-06", 10))} vs ${etWall(etAt("2026-03-10", 10))})`);

  // A sweep rather than a handful of dates: every hour of a year, including
  // both transitions, must land on an ET weekday and must advance the clock.
  const { isWeekdayET } = await import("../../src/lib/datetime");
  let sweepBad = 0, sweepBackwards = 0;
  for (let h = 0; h < 366 * 24; h++) {
    const from = new Date(Date.UTC(2026, 0, 1, 0) + h * 3_600_000);
    const to = addWeekdayHoursET(from, W);
    if (!isWeekdayET(to)) sweepBad++;
    if (to <= from) sweepBackwards++;
  }
  check("     8784 hourly starts across 2026 all land on an ET weekday", String(sweepBad), "0");
  check("     …and every one moves the clock forward", String(sweepBackwards), "0");

  // =========================================================================
  console.log("\n=== 2. SUFFICIENCY IS PER SESSION (spec §8, A15, A23) ===");
  // =========================================================================
  const NOW = etAt("2026-09-21", 9);
  const topic = (n: number, over: Partial<TopicMaterialInput> = {}): TopicMaterialInput => ({
    topicId: `t${n}`, status: "SELECTED", title: `Topic ${n}`, createdAt: new Date(Date.UTC(2026, 8, 1, 12, 0, n)),
    scriptApproved: false, scriptApprovedAt: null, interviewStatus: null, interviewSubmittedAt: null, ...over,
  });
  const submitted = (n: number, at: Date) => topic(n, { interviewStatus: "SUBMITTED", interviewSubmittedAt: at });

  const base = (over: Partial<DeriveInput> = {}): DeriveInput => ({
    now: NOW,
    month: {
      strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null, transcriptText: null,
      planningMode: "WRITTEN", preparationStatus: null, preparationCompletedAt: null,
      preparationWindowDays: null, preparationExceptionAt: null, preparationExceptionReason: null,
      filmingReadyAt: null, historical: false,
    },
    enrollment: { callMode: "OPTIONAL_WRITTEN", strategyCallRequired: false, noCallEligible: true },
    records: [], scripts: [], interviews: [],
    plan: { videosPerMonth: 4, sessionsPerMonth: 1 }, topics: [],
    ...over,
  });

  const mon2pm = etAt("2026-09-14", 14);
  // A15 — one of four interviews submitted.
  const a15 = deriveMonthState(base({
    topics: [submitted(1, mon2pm), topic(2), topic(3), topic(4)],
    interviews: [
      { topicId: "t1", status: "SUBMITTED", submittedAt: mon2pm },
      { topicId: "t2", status: "IN_PROGRESS", submittedAt: null },
      { topicId: "t3", status: "NOT_STARTED", submittedAt: null },
      { topicId: "t4", status: "NOT_STARTED", submittedAt: null },
    ],
  }));
  check("A15  1 of 4 ready → session stays shut", String(a15.earliestSessionAt), "null");
  check("A15  and says which topics are missing", a15.sessions[0].missingTopicIds.join(","), "t2,t3,t4");
  check("A15  preparation reads AWAITING_ANSWERS", String(a15.preparationStatus), "AWAITING_ANSWERS");

  // All four in → opens 48 weekday hours after the LAST one.
  const wed10 = etAt("2026-09-16", 10);
  const a15b = deriveMonthState(base({
    topics: [submitted(1, mon2pm), submitted(2, mon2pm), submitted(3, mon2pm), submitted(4, wed10)],
    interviews: [1, 2, 3, 4].map((n) => ({ topicId: `t${n}`, status: "SUBMITTED", submittedAt: n === 4 ? wed10 : mon2pm })),
  }));
  check("A15  4 of 4 ready → opens 48 weekday hours after the LAST one", etWall(a15b.earliestSessionAt), etWall(etAt("2026-09-18", 10)));

  // A carried-over approved script is material in its own right (§8).
  const fri3pm = etAt("2026-09-11", 15);
  const a15c = deriveMonthState(base({
    topics: [submitted(1, mon2pm), submitted(2, mon2pm), submitted(3, mon2pm), topic(4, { status: "SCRIPTED", scriptApproved: true, scriptApprovedAt: fri3pm })],
    interviews: [1, 2, 3].map((n) => ({ topicId: `t${n}`, status: "SUBMITTED", submittedAt: mon2pm })),
  }));
  check("§8   a carried-over APPROVED script counts as material", etWall(a15c.earliestSessionAt), etWall(etAt("2026-09-16", 14)));

  // Revalidation: answers reopened after submission must close the gate again.
  const reopened = deriveMonthState(base({
    month: { ...base().month, preparationCompletedAt: mon2pm },
    topics: [submitted(1, mon2pm), submitted(2, mon2pm), submitted(3, mon2pm), topic(4, { interviewStatus: "IN_PROGRESS", interviewSubmittedAt: wed10 })],
    interviews: [
      ...[1, 2, 3].map((n) => ({ topicId: `t${n}`, status: "SUBMITTED", submittedAt: mon2pm })),
      { topicId: "t4", status: "IN_PROGRESS", submittedAt: wed10 },
    ],
  }));
  check("F04  a stored completion stamp no longer holds the gate open", String(reopened.earliestSessionAt), "null");
  check("F04  and the reopened topic is named in a follow-up", reopened.followUps.filter((f) => f.kind === "ANSWERS_REOPENED").map((f) => f.sessionIndex).join(","), "1");
  check("F04  the historical stamp itself is preserved, not wiped", etWall(reopened.preparationCompletedAt), etWall(mon2pm));

  // A23 — Pro: two sessions of four, first must not wait on the second.
  const proTopics = [
    ...[1, 2, 3, 4].map((n) => submitted(n, mon2pm)),
    ...[5, 6, 7, 8].map((n) => topic(n)),
  ];
  const pro = deriveMonthState(base({
    plan: { videosPerMonth: 8, sessionsPerMonth: 2 },
    topics: proTopics,
    interviews: [1, 2, 3, 4].map((n) => ({ topicId: `t${n}`, status: "SUBMITTED", submittedAt: mon2pm })),
  }));
  check("A23  Pro splits into 2 sessions of 4", pro.sessions.map((s) => `${s.index}:${s.topicIds.length}/${s.plannedVideos}`).join(" "), "1:4/4 2:4/4");
  check("A23  session 1 opens without session 2's material", etWall(pro.sessions[0].earliestSessionAt), etWall(etAt("2026-09-16", 14)));
  check("A23  session 2 stays shut", String(pro.sessions[1].earliestSessionAt), "null");
  check("A23  the month reports the EARLIEST open session", etWall(pro.earliestSessionAt), etWall(etAt("2026-09-16", 14)));
  check("A23  Starter is one session of two", planSessions([topic(1), topic(2)], { videosPerMonth: 2, sessionsPerMonth: 1 }).map((s) => `${s.index}:${s.topics.length}/${s.plannedVideos}`).join(" "), "1:2/2");

  // =========================================================================
  console.log("\n=== 2b. THE CALL CLOCK STARTS AT THE CALL'S END (spec §7/§8) ===");
  // =========================================================================
  const callStart = etAt("2026-09-14", 14);
  const callEnd = etAt("2026-09-14", 15);
  const callBase = (records: DeriveInput["records"], over: Partial<DeriveInput> = {}) =>
    deriveMonthState(base({
      month: { ...base().month, planningMode: "CALL" },
      enrollment: { callMode: "REQUIRED", strategyCallRequired: true, noCallEligible: false },
      records, ...over,
    }));
  const rec = (over: Partial<DeriveInput["records"][number]> = {}): DeriveInput["records"][number] => ({
    callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED",
    scheduledStart: callStart, scheduledEnd: callEnd, transcriptState: "CONFIRMED", ...over,
  });
  const heldCall = callBase([rec()]);
  check("§8   window runs from the call END (15:00), not its start", etWall(heldCall.earliestSessionAt), etWall(etAt("2026-09-16", 15)));
  const futureCompleted = callBase([rec({ scheduledStart: etAt("2026-09-28", 14), scheduledEnd: etAt("2026-09-28", 15) })]);
  check("§8   a FUTURE call marked completed does not open the window", String(futureCompleted.earliestSessionAt), "null");
  check("§8   and it is raised as an exception, not guessed", String(futureCompleted.exceptions.length > 0), "true");
  const noShow = callBase([rec({ status: "NO_SHOW" })]);
  check("§8   NO_SHOW vs a confirmed transcript → exception, window shut", `${noShow.exceptions.length > 0}/${noShow.earliestSessionAt === null}`, "true/true");
  const missingInfo = callBase([rec()], { topics: [topic(1), topic(2), topic(3), topic(4)] });
  check("§8   missing post-call info does NOT move the clock", etWall(missingInfo.earliestSessionAt), etWall(etAt("2026-09-16", 15)));
  check("§8   …it raises a follow-up instead", missingInfo.followUps.filter((f) => f.kind === "MISSING_POST_CALL_INFO").map((f) => f.owner).join(","), "KYLE");
  const waived = callBase([rec()], { month: { ...base().month, planningMode: "CALL", preparationExceptionAt: NOW, preparationExceptionReason: "Jordan approved a same-week shoot" } });
  check("§8   a staff exception still waives the window to the call end", etWall(waived.earliestSessionAt), etWall(callEnd));

  // =========================================================================
  console.log("\n=== 3. LIVE REPLAY (read-only) ===");
  // =========================================================================
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`  READ-ONLY GUARD: ${guard}`);
  if (guard !== "PROVEN") { console.error("  The connection accepted a write. Refusing to read production."); process.exitCode = 1; return; }

  const { recalcProgramMonth, addBusinessDaysET } = await import("../../src/lib/programMonths");
  const months = await prisma.contentMonth.findMany({
    where: { historical: false },
    select: { id: true, monthKey: true, clientId: true, preparationStatus: true, strategyCallStatus: true },
    orderBy: { monthKey: "desc" },
  });
  const clientNames = new Map(
    (await prisma.client.findMany({ where: { id: { in: months.map((m) => m.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );
  let changed = 0, opened = 0, closed = 0;
  for (const m of months) {
    // dryRun: recalcProgramMonth writes nothing, and the connection could not
    // let it if it tried.
    const r = await recalcProgramMonth(m.id, { dryRun: true });
    if (!r) continue;
    const a = r.after;
    const note = `${clientNames.get(m.clientId) ?? "?"} ${m.monthKey}`;
    if (a.exceptions.length > 0) console.log(`  EXCEPTION  ${note}: ${a.exceptions.join(" | ")}`);
    if (r.changed) {
      changed++;
      console.log(`  CHANGED    ${note}: ${r.before.strategyCallStatus}/${r.before.preparationStatus ?? "-"} -> ${a.strategyCallStatus}/${a.preparationStatus ?? "-"}`);
    }
    if (a.earliestSessionAt) {
      opened++;
      // What the retired rule would have said, for the same month, so the
      // change is a printed pair rather than a claim.
      const old = a.strategyCallAt ? addBusinessDaysET(a.strategyCallAt, 3) : null;
      console.log(`  WINDOW     ${note}`);
      console.log(`             was (3 business days from the call START, midnight ET): ${etWall(old)}`);
      console.log(`             now (48 weekday hours from the call END):               ${etWall(a.earliestSessionAt)}`);
      console.log(`             sessions ${a.sessions.map((s) => `${s.index}: ${s.readyTopicIds.length}/${s.topicIds.length} topics ready of ${s.plannedVideos} planned`).join(" | ")}`);
      for (const f of a.followUps) console.log(`             follow-up (${f.owner}): ${f.reason}`);
    } else closed++;
  }
  // Every monthly call record on file, and which month it lands on — so a
  // month that does NOT open is accounted for rather than assumed.
  const allCalls = await prisma.programCallRecord.findMany({
    where: { callType: "MONTHLY_STRATEGY" },
    select: { id: true, monthId: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
  });
  console.log("\n  every MONTHLY_STRATEGY record on file:");
  for (const c of allCalls) {
    const m = months.find((x) => x.id === c.monthId);
    console.log(`    ${c.status}/${c.matchState}/${c.transcriptState} start ${etWall(c.scheduledStart)} end ${etWall(c.scheduledEnd)} -> ${m ? `${clientNames.get(m.clientId) ?? "?"} ${m.monthKey}` : c.monthId ? "a month outside this list (historical?)" : "NO MONTH"}`);
  }
  console.log(`\n  ${months.length} live months · ${changed} would change a stored column · ${opened} with an open window · ${closed} shut`);

  // =========================================================================
  console.log("\n=== 4. THE BOOKING GATE, BEFORE AND AFTER (F04) ===");
  // =========================================================================
  // sessionGate's "booked but not yet held" branch is the one a client is
  // actually held to: portalRequestSession refuses any slot before
  // `gate.earliest`. It used to read `addBusinessDaysET(callStart, windowDays)`,
  // and `windowDays` was `windowHours / 24` — 2 once the window became 48
  // weekday hours, where the retired rule meant 3. Three answers are printed
  // for every month that reaches that branch, so the move is a pair of ET wall
  // clocks rather than a claim.
  const { sessionGate } = await import("../../src/lib/portal");
  const { addWeekdayHoursET: addWH } = await import("../../src/lib/programMonths");
  const hours = (a: Date | null, b: Date | null) =>
    a && b ? `${((b.getTime() - a.getTime()) / 3_600_000).toFixed(1)}h` : "n/a";

  let preCall = 0, movedLooser = 0, movedTighter = 0, gateErrors = 0;
  for (const m of months) {
    const month = await prisma.contentMonth.findUnique({ where: { id: m.id }, select: { enrollmentId: true } });
    if (!month) continue;
    let gate: Awaited<ReturnType<typeof sessionGate>>;
    try { gate = await sessionGate(month.enrollmentId, m.id); }
    catch (e) { gateErrors++; console.log(`  GATE ERROR ${clientNames.get(m.clientId) ?? "?"} ${m.monthKey}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    const d = (await recalcProgramMonth(m.id, { dryRun: true }))?.after;
    if (!d) continue;
    const note = `${clientNames.get(m.clientId) ?? "?"} ${m.monthKey}`;
    const inPreCallBranch = !d.earliestSessionAt && d.strategyCallStatus === "SCHEDULED" && !!d.strategyCallAt && d.strategyCallAt > new Date();
    if (!inPreCallBranch) {
      console.log(`  ${gate.locked ? "LOCKED" : "OPEN  "}     ${note}: ${gate.locked ? gate.reason : `earliest ${etWall(gate.earliest)}`}`);
      continue;
    }
    preCall++;
    const start = d.strategyCallAt!;
    const end = d.strategyCallEndsAt ?? start;
    const retired = addBusinessDaysET(start, 3);   // before the hour clock landed
    const broken = addBusinessDaysET(start, 2);    // what windowHours / 24 produced
    const now = d.windowWaived ? end : addWH(end, d.windowHours);
    console.log(`  PRE-CALL   ${note} — call ${etWall(start)} to ${etWall(end)}`);
    console.log(`             retired rule (3 business days from the START):  ${etWall(retired)}`);
    console.log(`             the defect   (windowDays = 48/24 = 2):          ${etWall(broken)}   ${hours(broken, retired)} LOOSER than the retired rule`);
    console.log(`             now          (${d.windowHours} weekday hours from the END):    ${etWall(now)}   ${hours(broken, now)} vs the defect`);
    console.log(`             gate.earliest the client is held to (24h floor applied): ${etWall(gate.earliest)}`);
    if (now < broken) movedTighter++;
    if (now > broken) movedLooser++;
  }
  check("F04  no live month's gate errored", String(gateErrors), "0");
  check("F04  no live client's booking gate is LOOSER than the broken build", String(movedLooser), "0");
  console.log(`  ${preCall} live month(s) reach the pre-call branch · ${movedTighter} tightened · ${movedLooser} loosened`);

  // Production carries no future booked monthly call today, so the branch's
  // arithmetic is also proved on a fixture — otherwise "0 months moved" would
  // be a statement about the calendar, not about the code.
  const fxStart = etAt("2026-09-28", 14), fxEnd = etAt("2026-09-28", 14, 30);
  check("F04  fixture: the defect opened 2 business days from the START", etWall(addBusinessDaysET(fxStart, 2)), etWall(etAt("2026-09-30", 0)));
  check("F04  fixture: the retired rule opened 3", etWall(addBusinessDaysET(fxStart, 3)), etWall(etAt("2026-10-01", 0)));
  check("F04  fixture: now, 48 weekday hours from the call END", etWall(addWH(fxEnd, DEFAULT_PREPARATION_WINDOW_HOURS)), etWall(etAt("2026-09-30", 14, 30)));
  check("F04  fixture: the new answer is NOT looser than the defect's", String(addWH(fxEnd, DEFAULT_PREPARATION_WINDOW_HOURS) >= addBusinessDaysET(fxStart, 2)), "true");
  check("F04  fixture: the estimate equals the gate once the call is held", etWall(addWH(fxEnd, DEFAULT_PREPARATION_WINDOW_HOURS)), etWall(callBase([rec({ scheduledStart: fxStart, scheduledEnd: fxEnd, status: "COMPLETED" })], { now: etAt("2026-09-29", 9) }).earliestSessionAt));
  // Said out loud rather than buried: against the RETIRED rule the gate is
  // still looser, and deliberately so — §8 is 48 weekday hours now, and the
  // held-call branch has already been answering that way since this batch
  // landed. What F04 removed was the extra, unintended day on top of it.
  const fxNow = addWH(fxEnd, DEFAULT_PREPARATION_WINDOW_HOURS);
  console.log(`  the defect vs the retired rule: ${hours(addBusinessDaysET(fxStart, 2), addBusinessDaysET(fxStart, 3))} looser (the bug)`);
  console.log(`  now        vs the defect:       ${hours(addBusinessDaysET(fxStart, 2), fxNow)} tighter`);
  console.log(`  now        vs the retired rule: ${hours(fxNow, addBusinessDaysET(fxStart, 3))} still looser — §8's own change, not F04's`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
