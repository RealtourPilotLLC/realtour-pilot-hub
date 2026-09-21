// ---------------------------------------------------------------------------
// DRILL: THE MONTHLY REMINDER CALENDAR (F20, Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     set -a && source .env; set +a && NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/reminder-calendar.ts
//
// Part 1 is reconnaissance: what the live roster actually looks like (packages,
// sessions per month, open months, the reminder ledger, provider freshness).
// Part 2 replays §18's A22/A23/A27/A28 against the evaluator's own arithmetic.
//
// READ-ONLY, STRUCTURALLY — the same guard as attribution-rails.ts: the
// connection itself refuses writes (SQLSTATE 25006) and the drill proves it
// before it reads a single row. A promise about what this file calls is worth
// nothing next to a connection that cannot execute an INSERT.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../.env")];
    for (const file of candidates) {
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

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { console.error("  The connection accepted a write. Refusing to run."); process.exitCode = 1; return; }

  const en = await prisma.contentEnrollment.findMany({ select: { id: true, package: true, videosPerMonth: true, sessionsPerMonth: true, sessionHours: true, status: true, startedAt: true, callMode: true, clientId: true } });
  console.log(`\n--- ENROLLMENTS (${en.length}) ---`);
  const byPkg = new Map<string, number>();
  for (const e of en) byPkg.set(`${e.package}/${e.sessionsPerMonth}s/${e.videosPerMonth}v/${e.status}`, (byPkg.get(`${e.package}/${e.sessionsPerMonth}s/${e.videosPerMonth}v/${e.status}`) ?? 0) + 1);
  for (const [k, v] of [...byPkg].sort()) console.log(`  ${k}: ${v}`);
  console.log(`  sessionsPerMonth > 1: ${en.filter((e) => e.sessionsPerMonth > 1).length}`);
  console.log(`  startedAt present: ${en.filter((e) => e.startedAt).length}`);

  const months = await prisma.contentMonth.findMany({ where: { historical: false }, select: { id: true, enrollmentId: true, monthKey: true, status: true, remindersSnoozedUntil: true, strategyCallStatus: true, planningMode: true, preparationStatus: true } });
  console.log(`\n--- NON-HISTORICAL MONTHS (${months.length}) ---`);
  const byKey = new Map<string, number>();
  for (const m of months) byKey.set(m.monthKey, (byKey.get(m.monthKey) ?? 0) + 1);
  for (const [k, v] of [...byKey].sort()) console.log(`  ${k}: ${v}`);
  console.log(`  OPEN months >= 2026-09: ${months.filter((m) => m.status === "OPEN" && m.monthKey >= "2026-09").length}`);
  console.log(`  strategyCallStatus SKIPPED: ${months.filter((m) => m.strategyCallStatus === "SKIPPED").length}`);

  const rem = await prisma.programReminder.findMany({ select: { action: true, state: true, channel: true, dedupeKey: true, sentAt: true, monthKey: true } });
  console.log(`\n--- PROGRAM REMINDER LEDGER (${rem.length}) ---`);
  const byState = new Map<string, number>();
  for (const r of rem) byState.set(`${r.action}/${r.state}/${r.channel}`, (byState.get(`${r.action}/${r.state}/${r.channel}`) ?? 0) + 1);
  for (const [k, v] of [...byState].sort()) console.log(`  ${k}: ${v}`);
  console.log(`  dedupeKey samples: ${rem.slice(0, 5).map((r) => r.dedupeKey).join(" | ") || "(none)"}`);

  const conns = await prisma.connection.findMany({ select: { provider: true, status: true, lastSyncedAt: true, lastError: true } });
  console.log(`\n--- CONNECTIONS ---`);
  for (const c of conns) console.log(`  ${c.provider}: ${c.status} lastSyncedAt=${c.lastSyncedAt?.toISOString() ?? "null"} err=${(c.lastError ?? "").slice(0, 60)}`);

  const maps = await prisma.programCalendlyEventMapping.findMany({ select: { purpose: true, enabled: true, lastSyncedAt: true, validationStatus: true, lastError: true } });
  console.log(`\n--- CALENDLY MAPPINGS (${maps.length}) ---`);
  for (const m of maps) console.log(`  ${m.purpose} enabled=${m.enabled} lastSyncedAt=${m.lastSyncedAt?.toISOString() ?? "null"} ${m.validationStatus ?? ""} ${(m.lastError ?? "").slice(0, 40)}`);

  const auto = await prisma.programAutomation.findMany({ select: { key: true, enabled: true, lastRunAt: true } });
  console.log(`\n--- AUTOMATION SWITCHES ---`);
  for (const a of auto) console.log(`  ${a.key}: enabled=${a.enabled} lastRunAt=${a.lastRunAt?.toISOString() ?? "null"}`);

  const cv = await prisma.contentVideo.groupBy({ by: ["kind"], _count: { _all: true } });
  console.log(`\n--- CONTENT VIDEO KINDS ---`);
  for (const r of cv) console.log(`  ${r.kind}: ${r._count._all}`);

  const reqs = await prisma.programSessionRequest.groupBy({ by: ["status"], _count: { _all: true } });
  console.log(`\n--- SESSION REQUESTS ---`);
  for (const r of reqs) console.log(`  ${r.status}: ${r._count._all}`);

  // =========================================================================
  // PART 2 — THE ACCEPTANCE TESTS (spec §18)
  // =========================================================================
  const R = await import("../../src/lib/programReminders");
  const P = R.REMINDER_DEFAULTS;
  let pass = 0, fail = 0;
  const check = (id: string, what: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${what}${ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
  };
  const etStamp = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

  // ---- A27: the monthly reminder calendar, including weekends -------------
  console.log(`\n=== A27: 1st, three weekdays, three weekdays, 15th/task on weekends and repeated runs ===`);
  const cases: [string, string, string][] = [
    // monthKey, expected MONTH_OPEN day (ET), expected MID_MONTH day (ET)
    ["2026-09", "Tue, 09/01/2026, 09:00", "Tue, 09/15/2026, 09:00"], // both weekdays
    ["2026-11", "Mon, 11/02/2026, 09:00", "Mon, 11/16/2026, 09:00"], // 1st = Sunday, 15th = Sunday
    ["2026-08", "Mon, 08/03/2026, 09:00", "Mon, 08/17/2026, 09:00"], // 1st = Saturday, 15th = Saturday
    ["2026-03", "Mon, 03/02/2026, 09:00", "Mon, 03/16/2026, 09:00"], // 1st = Sunday, DST starts 03/08
    ["2027-02", "Mon, 02/01/2027, 09:00", "Mon, 02/15/2027, 09:00"],
  ];
  for (const [key, openWant, midWant] of cases) {
    const cal = R.monthlyCalendar(key, P);
    check("A27", `${key} MONTH_OPEN`, etStamp(cal.monthOpenAt), openWant);
    check("A27", `${key} MID_MONTH`, etStamp(cal.midMonthAt), midWant);
  }
  // DST: the 9 am wall clock holds either side of the March change.
  const march = R.monthlyCalendar("2026-03", P);
  check("A27", "2026-03 mid-month is 9 am ET after the clocks change", etStamp(march.midMonthAt).endsWith("09:00"), true);

  // Three WEEKDAYS after the ACTUAL send, not 72 elapsed hours.
  const { addBusinessDaysET } = await import("../../src/lib/datetime");
  const fri = new Date("2026-09-18T14:00:00Z"); // Friday 10:00 ET
  check("A27", "Friday send + 3 weekdays lands Wednesday (not Monday)", etStamp(addBusinessDaysET(fri, 3)).slice(0, 3), "Wed");
  const mon = new Date("2026-09-21T18:00:00Z"); // Monday 14:00 ET
  check("A27", "Monday send + 3 weekdays lands Thursday", etStamp(addBusinessDaysET(mon, 3)).slice(0, 3), "Thu");

  // ---- A23: Pro is two sessions --------------------------------------------
  console.log(`\n=== A23: one booked or filmed session does not satisfy two ===`);
  const pro = { sessionsRequired: 2, pendingSessionRequests: 0 };
  check("A23", "Pro, nothing booked -> chase session 1", R.sessionGap({ ...pro, sessionsBooked: 0, sessionsFilmed: 0 }), { required: 2, accountedFor: 0, missing: 2, action: "BOOK_SESSION", ordinal: 1, suppression: null });
  check("A23", "Pro, ONE booked -> still chase session 2", R.sessionGap({ ...pro, sessionsBooked: 1, sessionsFilmed: 0 }), { required: 2, accountedFor: 1, missing: 1, action: "BOOK_SESSION", ordinal: 2, suppression: null });
  check("A23", "Pro, ONE filmed -> still chase session 2", R.sessionGap({ ...pro, sessionsBooked: 0, sessionsFilmed: 1 }), { required: 2, accountedFor: 1, missing: 1, action: "BOOK_SESSION", ordinal: 2, suppression: null });
  check("A23", "Pro, one filmed one booked -> silent", R.sessionGap({ ...pro, sessionsBooked: 1, sessionsFilmed: 1 }), { required: 2, accountedFor: 2, missing: 0, action: null, ordinal: null, suppression: null });
  check("A23", "Pro, two missing but only one request pending -> still chase", R.sessionGap({ sessionsRequired: 2, sessionsBooked: 0, sessionsFilmed: 0, pendingSessionRequests: 1 }), { required: 2, accountedFor: 0, missing: 2, action: "BOOK_SESSION", ordinal: 1, suppression: null });
  check("A23", "Accelerator, one booked -> silent", R.sessionGap({ sessionsRequired: 1, sessionsBooked: 1, sessionsFilmed: 0, pendingSessionRequests: 0 }), { required: 1, accountedFor: 1, missing: 0, action: null, ordinal: null, suppression: null });
  check("A23", "office owes an answer -> not the client's to chase", R.sessionGap({ sessionsRequired: 1, sessionsBooked: 0, sessionsFilmed: 0, pendingSessionRequests: 1 }).suppression, "pending_session_request");

  // ---- A28: first month and agency backlog ---------------------------------
  console.log(`\n=== A28: no forfeiture warning in the first cycle or on work we owe ===`);
  check("A28", "first paid cycle is exempt", R.midMonthExemption({ firstCycle: true, carryoverUnclassified: 0 }), "first_cycle_exempt");
  check("A28", "unclassified carry-in is exempt", R.midMonthExemption({ firstCycle: false, carryoverUnclassified: 3 }), "catch_up_owed");
  check("A28", "an ordinary month is not exempt", R.midMonthExemption({ firstCycle: false, carryoverUnclassified: 0 }), null);

  // ---- A25 (the reminder half): Monday filming -> Friday reminder -----------
  console.log(`\n=== A25 (address clock): Monday filming produces a Friday reminder, never a Saturday one ===`);
  const monShoot = new Date("2026-09-28T14:00:00Z"); // Monday 10:00 ET; minus 48 h = Saturday
  const monRemind = R.addressReminderAt(monShoot, P);
  check("A25", "Monday shoot -> Friday reminder", etStamp(monRemind).slice(0, 3), "Fri");
  const thuShoot = new Date("2026-10-01T14:00:00Z"); // Thursday 10:00 ET; minus 48 h = Tuesday
  check("A25", "Thursday shoot -> plain 48 elapsed hours (Tuesday)", etStamp(R.addressReminderAt(thuShoot, P)), "Tue, 09/29/2026, 10:00");
  check("A25", "a general area is recognised as not-yet-exact", [R.looksLikeGeneralArea("August 2026 Social Content, West Chester, PA 19382"), R.looksLikeGeneralArea("[No address provided], 40.02,-76.52"), R.looksLikeGeneralArea(null), R.looksLikeGeneralArea("117 Kyle Lane, West Chester, PA 19382")], [true, true, true, false]);

  // ---- the mid-month paragraph, in Jordan's voice ---------------------------
  console.log(`\n=== Client copy: the mid-month note ===`);
  const sample = R.withExtraParagraph("Hi Ashley,\n\nBody line.\n\n— Jordan & the RealTour Pilot team\n(Reply to this email and it comes straight to us.)", "Extra paragraph.");
  check("copy", "the extra paragraph goes ABOVE the sign-off", sample.split("\n").indexOf("Extra paragraph.") < sample.split("\n").findIndex((l) => l.startsWith("— Jordan")), true);
  const midBody = R.withExtraParagraph("Hi Ashley,\n\nBody.\n\n— Jordan & the RealTour Pilot team", null);
  check("copy", "no paragraph leaves the body untouched", midBody, "Hi Ashley,\n\nBody.\n\n— Jordan & the RealTour Pilot team");

  // ---- A51 + A27 repeated runs, against production --------------------------
  console.log(`\n=== A51 / A27: two identical cron runs against the live roster ===`);
  const before = await prisma.programReminder.count();
  const at = new Date();
  const run1 = await R.evaluateReminders({ dryRun: true, now: at });
  const run2 = await R.evaluateReminders({ dryRun: true, now: at });
  const after = await prisma.programReminder.count();
  check("A27", "a repeated run writes no ledger row", after, before);
  const shape = (r: Awaited<ReturnType<typeof R.evaluateReminders>>) =>
    r.candidates.map((c) => `${c.clientName}|${c.monthKey}|${c.lane}|${c.milestone}|${c.action}|${c.decision}|${c.suppressionReason ?? ""}`).sort();
  check("A27", "two runs at the same instant decide identically", JSON.stringify(shape(run1)) === JSON.stringify(shape(run2)), true);
  check("A51", "the launch gate holds: nothing would send", run1.candidates.filter((c) => c.decision === "send").length, 0);
  check("A51", "the automation switch is off, so the live path is inert", (await R.evaluateReminders({ dryRun: false, now: at })).evaluated, 0);
  console.log(`  note: ${run1.note}; policy source ${run1.policySource}; enabled=${run1.enabled}`);

  console.log(`\n--- WHAT THE LIVE ROSTER WOULD DO RIGHT NOW (${etStamp(at)} ET) ---`);
  for (const c of run1.candidates) {
    console.log(`  ${c.clientName.padEnd(22).slice(0, 22)} ${c.monthKey} ${c.lane.padEnd(7)} ${String(c.milestone).padEnd(11)} ${String(c.action ?? "-").padEnd(16)} ${c.decision.padEnd(10)} ${c.suppressionReason ?? ""} :: ${c.reason}`);
    if (c.lane === "PRIMARY" && c.calendar) console.log(`      calendar: open ${etStamp(c.calendar.monthOpenAt)} | mid ${etStamp(c.calendar.midMonthAt)} | deadline ${etStamp(c.calendar.planningDeadlineAt)} | sessions ${c.state.sessionsAccountedFor}/${c.state.sessionsRequired}`);
  }
  console.log(`  Kyle follow-ups computed: ${run1.kyleFollowUps.length}; escalations: ${run1.escalations.length}; address-lane rows: ${run1.addressLane.length}`);
  for (const a of run1.addressLane.slice(0, 10)) console.log(`    ADDRESS ${a.clientName} ${a.monthKey} shoot ${etStamp(a.shootAt)} remind ${etStamp(a.remindAt)} weekendMoved=${a.movedOffWeekend} overdue=${a.overdue} addr="${a.addressLine ?? ""}"`);

  // ---- the preview, on a real month ----------------------------------------
  const anyOpen = months.find((m) => m.status === "OPEN" && m.monthKey >= "2026-09");
  if (anyOpen) {
    console.log(`\n--- PREVIEW for ${anyOpen.monthKey} (writes nothing) ---`);
    const before2 = await prisma.programReminder.count();
    const pv = await R.previewReminders(anyOpen.id, { now: at });
    const after2 = await prisma.programReminder.count();
    check("preview", "previewReminders writes no ledger row", after2, before2);
    console.log(`  ${pv.clientName} ${pv.monthKey}`);
    for (const l of pv.lanes) {
      console.log(`  [${l.lane}] ${l.candidate.decision} ${l.candidate.suppressionReason ?? ""} — ${l.candidate.reason}`);
      if (l.body) console.log(l.body.split("\n").map((x) => `      | ${x}`).join("\n"));
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
