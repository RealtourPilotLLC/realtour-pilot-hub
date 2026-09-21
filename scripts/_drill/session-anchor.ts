// ---------------------------------------------------------------------------
// DRILL: THE JOB-LEVEL ANSWER ON A MULTI-SESSION JOB (F27 review, Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     set -a && source .env; set +a && NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/session-anchor.ts
//
// §9: "Each Pro session has a separate end time and day-7/day-10 target."
//
// f27-anchor.ts moved the production clock onto the appointment's END and gave
// every session its own clock WHEN A CALLER NAMES A LEG. The review then found
// what the job-level call did with no legId: it picked the LATEST leg that had
// happened, mirroring tasks.videoAnchorFor. On a two-visit job that ERASES the
// first session's deadline — the job answers with visit two's day-10 and
// session one's videos read as on time for as long as the gap between visits.
//
// Proved below on Joe Sutow, 1023 Sycamore Mills Rd: filmed Fri Jul 24 (ends
// 2:30pm) and again Mon Jul 27 (ends 4:00pm). sessionClocksFor was already
// right — session 1 overdue after 2026-08-07, session 2 after 2026-08-10 — and
// the job-level call answered 2026-08-10 alone.
//
// This drill answers, on the real rows:
//   1. THE TWO-LEG JOB, session by session, old rule vs new.
//   2. EVERY CONTENT JOB: does any single-session job's date move? (It must
//      not. Only a job with more than one bookable leg may change, and a
//      minimum can only ever pull a date EARLIER.)
//   3. KYLE'S BOARD: does outstandingPromise still merge a multi-session job
//      into one unlabelled date, and does every other job keep its date?
//   4. THE PER-SESSION READERS are untouched — sessionClocksFor named a leg all
//      along and its numbers are the same before and after.
//
// READ-ONLY, STRUCTURALLY — the connection itself refuses writes (SQLSTATE
// 25006) before the first app module is imported, and the guard is proved
// before anything else runs. Copied deliberately from attribution-rails.ts,
// whose header records why a promise about what a file calls is worth nothing
// next to a connection that cannot execute an INSERT.
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
      if (m) {
        url = m[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

const ET = (d: Date | null | undefined): string =>
  d
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short", month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(d)
    : "—";
const DAYKEY = (d: Date | null | undefined): string =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : "—";

/** Exactly what turnaround.SessionLeg needs, and what the OLD rule read. */
type Leg = { id: string; startAt: Date | null; endAt: Date | null; durationMin: number | null; status: string | null };

const bookable = (a: Leg): boolean => {
  const s = (a.status || "").toUpperCase();
  return !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && a.startAt !== null;
};

/**
 * THE OLD JOB-LEVEL LEG PICK, reimplemented here so the two rules can be run
 * side by side on the same rows. Verbatim from turnaround.ts before this fix:
 * the latest leg that has happened, else the earliest upcoming one.
 */
function oldJobLevelLeg(legs: Leg[], now: number): Leg | null {
  const ok = legs.filter(bookable);
  const past = ok.filter((a) => a.startAt!.getTime() < now).sort((x, y) => y.startAt!.getTime() - x.startAt!.getTime());
  const upcoming = ok.filter((a) => a.startAt!.getTime() >= now).sort((x, y) => x.startAt!.getTime() - y.startAt!.getTime());
  return past[0] ?? upcoming[0] ?? null;
}

async function main() {
  const { prisma } = await import("../../src/lib/prisma");

  // ---- prove the guard before trusting anything else in this file ----------
  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") {
    console.error("  The connection accepted a write. Refusing to run against production.");
    process.exitCode = 1;
    return;
  }

  const { productionAnchorFor, productionSessionsFor, productionClockFor, productionWindowFrom, legEnd } =
    await import("../../src/lib/turnaround");
  const { sessionClocksFor, sessionMinutesFor } = await import("../../src/lib/contentProgram");
  const { outstandingPromise, boardSessions } = await import("../../src/lib/deliveryBoard");
  const { turnaroundRules } = await import("../../src/lib/settings");

  const rules = await turnaroundRules();
  const now = Date.now();
  console.log(`\nOffice rules in force: monthlyBusinessDays=${rules.monthlyBusinessDays}, standardVideoHours=${rules.standardVideoHours}`);
  console.log(`Replaying at now = ${ET(new Date(now))}`);

  // =========================================================================
  // 1. THE TWO-LEG JOB.
  // =========================================================================
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { not: null }, status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true,
      promisedDueAt: true, dueOverrideAt: true, contentMonthId: true, clientId: true,
      appointments: { select: { id: true, startAt: true, endAt: true, durationMin: true, status: true }, orderBy: { startAt: "asc" } },
    },
  });
  const clients = await prisma.client.findMany({
    where: { id: { in: [...new Set(projects.map((p) => p.clientId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const multi = projects.filter((p) => p.appointments.filter(bookable).length > 1);

  console.log(`\n=== 1. THE MULTI-SESSION JOBS: ${multi.length} of ${projects.length} attached content projects ===`);
  for (const p of multi) {
    console.log(`\n  ${nameOf.get(p.clientId) ?? "?"} · ${p.title}`);
    console.log(`    status=${p.status}  Project.shootDate=${ET(p.shootDate)}  pin=${ET(p.promisedDueAt)}  override=${ET(p.dueOverrideAt)}`);

    // Per-session, the way §9 asks for it. Pro sessions are sold as 240 min.
    const sessions = productionSessionsFor(p, { expectedSessionMinutes: sessionMinutesFor("Pro") });
    for (const s of sessions) {
      const win = s.anchor.at ? productionWindowFrom(s.anchor.at, rules) : null;
      console.log(
        `    session ${s.index} of ${s.of}  leg ${(s.legId ?? "—").slice(0, 8)}  start ${ET(s.startAt)}  END ${ET(s.anchor.at)} (${s.anchor.source})` +
          `\n        day-7 target ${DAYKEY(win?.productionTargetAt)}   DAY-10 OVERDUE AFTER ${DAYKEY(win?.productionDueAt)}`,
      );
    }

    // The OLD job-level answer vs the NEW one.
    const oldLeg = oldJobLevelLeg(p.appointments, now);
    const oldAnchor = oldLeg ? legEnd(oldLeg, sessionMinutesFor("Pro")) : null;
    const oldWin = oldAnchor?.at ? productionWindowFrom(oldAnchor.at, rules) : null;
    const nowAnchor = productionAnchorFor(p, { now, expectedSessionMinutes: sessionMinutesFor("Pro") });
    const nowWin = nowAnchor.at ? productionWindowFrom(nowAnchor.at, rules) : null;
    console.log(`    JOB-LEVEL, OLD (latest leg that happened): end ${ET(oldAnchor?.at)} -> day-10 ${DAYKEY(oldWin?.productionDueAt)}`);
    console.log(`    JOB-LEVEL, NEW (earliest obligation):      end ${ET(nowAnchor.at)} -> day-10 ${DAYKEY(nowWin?.productionDueAt)}`);
    console.log(`    the new answer names its session: "${nowAnchor.note ?? "(no note)"}"`);
    const erased = sessions
      .map((s) => (s.anchor.at ? productionWindowFrom(s.anchor.at, rules).productionDueAt : null))
      .filter((d): d is Date => !!d)
      .filter((d) => oldWin?.productionDueAt && d.getTime() < oldWin.productionDueAt.getTime());
    console.log(
      erased.length
        ? `    THE DEFECT: the old answer hid ${erased.length} earlier deadline(s) — ${erased.map(DAYKEY).join(", ")} — behind ${DAYKEY(oldWin?.productionDueAt)}.`
        : `    (nothing was hidden on this job)`,
    );

    // And the clock with the override/pin ladder on top, which is what a screen prints.
    const oldClockDue = (() => {
      // The old clock, rebuilt: same ladder, old leg pick.
      const c = productionClockFor({ ...p, appointments: oldLeg ? [oldLeg] : [] }, { now, expectedSessionMinutes: sessionMinutesFor("Pro"), rules });
      return c.effectiveDueAt;
    })();
    const newClock = productionClockFor(p, { now, expectedSessionMinutes: sessionMinutesFor("Pro"), rules });
    console.log(`    productionClockFor(project).effectiveDueAt:  OLD ${DAYKEY(oldClockDue)}  ->  NEW ${DAYKEY(newClock.effectiveDueAt)} (${newClock.effectiveSource})`);

    // §9's own reader was right all along — show it agrees with the new answer.
    const clocks = sessionClocksFor(
      [{ id: p.id, title: p.title, shootDate: p.shootDate, promisedDueAt: p.promisedDueAt, dueOverrideAt: p.dueOverrideAt, appointments: p.appointments }],
      "Pro",
      rules,
      now,
    );
    for (const c of clocks) {
      console.log(`    sessionClocksFor session ${c.sessionIndex}/${c.sessionsInMonth}: day-10 ${DAYKEY(c.productionDueAt)} effective ${DAYKEY(c.effectiveDueAt)}`);
    }
    const earliestSessionDue = clocks
      .map((c) => c.productionDueAt)
      .filter((d): d is Date => !!d)
      .reduce<Date | null>((a, b) => (a && a.getTime() <= b.getTime() ? a : b), null);
    console.log(
      nowWin?.productionDueAt && earliestSessionDue && nowWin.productionDueAt.getTime() === earliestSessionDue.getTime()
        ? `    AGREE: the job-level day-10 is now exactly the earliest session's day-10.`
        : `    MISMATCH: job-level ${DAYKEY(nowWin?.productionDueAt)} vs earliest session ${DAYKEY(earliestSessionDue)}`,
    );
  }

  // =========================================================================
  // 2. EVERY CONTENT JOB — does anything move that should not?
  // =========================================================================
  console.log(`\n=== 2. OLD vs NEW JOB-LEVEL DATE, all ${projects.length} content projects ===`);
  let same = 0;
  const moved: string[] = [];
  const later: string[] = [];
  for (const p of projects) {
    const legs = p.appointments.filter(bookable);
    const oldLeg = oldJobLevelLeg(p.appointments, now);
    const oldAnchorAt = oldLeg ? legEnd(oldLeg, sessionMinutesFor("Pro")).at : p.shootDate ?? null;
    const newAnchor = productionAnchorFor(p, { now, expectedSessionMinutes: sessionMinutesFor("Pro") });
    const o = oldAnchorAt ? productionWindowFrom(oldAnchorAt, rules).productionDueAt : null;
    const n = newAnchor.at ? productionWindowFrom(newAnchor.at, rules).productionDueAt : null;
    const oKey = DAYKEY(o);
    const nKey = DAYKEY(n);
    if (oKey === nKey) {
      same++;
      continue;
    }
    const line = `    ${(nameOf.get(p.clientId) ?? "?").padEnd(20)} ${p.title.slice(0, 44).padEnd(46)} legs=${legs.length}  ${oKey} -> ${nKey}`;
    moved.push(line);
    if (n && o && n.getTime() > o.getTime()) later.push(line);
  }
  console.log(`  unchanged: ${same}`);
  console.log(`  moved:     ${moved.length}`);
  moved.forEach((l) => console.log(l));
  const singleMoved = projects.filter((p) => {
    const legs = p.appointments.filter(bookable);
    if (legs.length > 1) return false;
    const oldLeg = oldJobLevelLeg(p.appointments, now);
    const oldAnchorAt = oldLeg ? legEnd(oldLeg, sessionMinutesFor("Pro")).at : p.shootDate ?? null;
    const newAnchor = productionAnchorFor(p, { now, expectedSessionMinutes: sessionMinutesFor("Pro") });
    const o = oldAnchorAt ? productionWindowFrom(oldAnchorAt, rules).productionDueAt : null;
    const n = newAnchor.at ? productionWindowFrom(newAnchor.at, rules).productionDueAt : null;
    return DAYKEY(o) !== DAYKEY(n);
  });
  console.log(`\n  SINGLE-SESSION (0 or 1 bookable leg) JOBS WHOSE DATE MOVED: ${singleMoved.length}  ${singleMoved.length === 0 ? "— none, as required" : "— REGRESSION"}`);
  console.log(`  JOBS WHOSE DATE MOVED LATER: ${later.length}  ${later.length === 0 ? "— none; a minimum can only pull a date earlier" : "— REGRESSION, a later date hides lateness"}`);

  // =========================================================================
  // 3. KYLE'S BOARD — the session grouping, and every other job untouched.
  // =========================================================================
  console.log(`\n=== 3. THE DELIVERY BOARD ===`);
  const boardRows = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true,
      revisionRequestedAt: true, dueOverrideAt: true, tierOverride: true,
      promisedDueAt: true, promisedReason: true, packageName: true, statusEvidence: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { select: { type: true, status: true, uploadedAt: true, label: true } },
      appointments: { select: { id: true, startAt: true, endAt: true, durationMin: true, status: true }, orderBy: { startAt: "asc" } },
    },
    take: 5000,
  });
  console.log(`  ${boardRows.length} live project rows read.`);

  let boardSame = 0;
  const boardMoved: string[] = [];
  const boardLater: string[] = [];
  let grouped = 0;
  for (const row of boardRows) {
    // THE OLD BOARD CLOCK, exactly: with no appointment rows, boardSessions
    // returns [] and clockStart falls back to Project.shootDate — which is what
    // this board did for every job before today.
    const before = outstandingPromise({ ...row, appointments: [] }, { now: new Date(now), turnarounds: rules });
    const after = outstandingPromise(row, { now: new Date(now), turnarounds: rules });
    const sess = boardSessions(row, rules);
    if (sess.length) {
      grouped++;
      console.log(`\n  GROUPED: ${row.title.slice(0, 60)}  (${sess.length} sessions)`);
      for (const s of sess) {
        console.log(`      session ${s.index} of ${s.of}  start ${ET(s.startAt)}  end ${ET(s.anchorAt)}${s.anchorEstimated ? " (estimated)" : ""}  day-7 ${DAYKEY(s.productionTargetAt)}  day-10 ${DAYKEY(s.productionDueAt)}`);
      }
      console.log(`      board date BEFORE ${DAYKEY(before.at)} (for "${before.label ?? "—"}")`);
      console.log(`      board date AFTER  ${DAYKEY(after.at)} (for "${after.sessionLabel ? `${after.sessionLabel} · ` : ""}${after.label ?? "—"}")`);
    }
    if (DAYKEY(before.at) === DAYKEY(after.at)) {
      boardSame++;
      continue;
    }
    const line = `    ${row.title.slice(0, 50).padEnd(52)} legs=${row.appointments.filter(bookable).length}  ${DAYKEY(before.at)} -> ${DAYKEY(after.at)}`;
    boardMoved.push(line);
    if (before.at && after.at && after.at.getTime() > before.at.getTime()) boardLater.push(line);
  }
  console.log(`\n  jobs carrying a §9 session grouping: ${grouped}`);
  console.log(`  board dates unchanged: ${boardSame}`);
  console.log(`  board dates moved:     ${boardMoved.length}`);
  boardMoved.forEach((l) => console.log(l));
  console.log(`  board dates that moved LATER: ${boardLater.length}  ${boardLater.length === 0 ? "— none" : "— REGRESSION"}`);
  const groupedIds = new Set(boardRows.filter((r) => boardSessions(r, rules).length > 0).map((r) => r.id));
  const movedNotGrouped = boardRows.filter((r) => {
    const before = outstandingPromise({ ...r, appointments: [] }, { now: new Date(now), turnarounds: rules });
    const after = outstandingPromise(r, { now: new Date(now), turnarounds: rules });
    return DAYKEY(before.at) !== DAYKEY(after.at) && !groupedIds.has(r.id);
  });
  console.log(`  board dates that moved on a job with NO session grouping: ${movedNotGrouped.length}  ${movedNotGrouped.length === 0 ? "— none, as required" : "— REGRESSION"}`);

  // =========================================================================
  // 3b. THE SAME REAL ROW, REPLAYED WHILE IT WAS STILL OPEN.
  //
  // The one multi-session job in the book was delivered in August, so on
  // today's board it is settled and carries no date at all — which proves the
  // grouping renders but not what the date says. So replay THE REAL ROW at Sat
  // Aug 8 2026, the day after session 1's day-10 and two days before session
  // 2's, with only the delivery stamps cleared. That is the exact window in
  // which the old board called this job on time.
  // =========================================================================
  console.log(`\n=== 3b. THE REAL ROW, REPLAYED OPEN AT Sat Aug 8 2026 ===`);
  const replayAt = new Date("2026-08-08T16:00:00Z");
  for (const row of boardRows.filter((r) => boardSessions(r, rules).length > 0)) {
    const open = { ...row, status: "EDITING", deliveredAt: null, revisionRequestedAt: null };
    const before = outstandingPromise({ ...open, appointments: [] }, { now: replayAt, turnarounds: rules });
    const after = outstandingPromise(open, { now: replayAt, turnarounds: rules });
    console.log(`  ${row.title.slice(0, 60)}`);
    console.log(`    BEFORE: due ${DAYKEY(before.at)} for "${before.label ?? "—"}"  overdue=${before.at ? before.at < replayAt : false}`);
    console.log(`    AFTER:  due ${DAYKEY(after.at)} for "${after.sessionLabel ? `${after.sessionLabel} · ` : ""}${after.label ?? "—"}"  overdue=${after.at ? after.at < replayAt : false}`);
    for (const s of boardSessions(open, rules)) {
      console.log(`      session ${s.index} of ${s.of}: day-7 ${DAYKEY(s.productionTargetAt)}  day-10 ${DAYKEY(s.productionDueAt)}`);
    }
  }

  // =========================================================================
  // 4. THE PER-SESSION READER IS UNTOUCHED.
  // =========================================================================
  console.log(`\n=== 4. sessionClocksFor NAMES ITS LEG, SO ITS NUMBERS ARE UNCHANGED ===`);
  // It always passes legId, and the legId branch of productionAnchorFor was not
  // edited. Replayed here so that claim is measured rather than asserted: each
  // row's day-10 must equal its OWN leg's day-10, never the job-level roll-up.
  let perSessionOk = 0;
  let perSessionBad = 0;
  for (const p of projects) {
    const clocks = sessionClocksFor(
      [{ id: p.id, title: p.title, shootDate: p.shootDate, promisedDueAt: p.promisedDueAt, dueOverrideAt: p.dueOverrideAt, appointments: p.appointments }],
      "Pro",
      rules,
      now,
    );
    for (const c of clocks) {
      const leg = p.appointments.find((a) => a.id === c.appointmentId) ?? null;
      const ownEnd = leg ? legEnd(leg, sessionMinutesFor("Pro")).at : null;
      const ownDue = ownEnd ? productionWindowFrom(ownEnd, rules).productionDueAt : null;
      if (!leg) continue;
      if (DAYKEY(ownDue) === DAYKEY(c.productionDueAt)) perSessionOk++;
      else {
        perSessionBad++;
        console.log(`    MISMATCH ${p.title.slice(0, 40)} leg ${c.appointmentId?.slice(0, 8)}: own ${DAYKEY(ownDue)} vs reported ${DAYKEY(c.productionDueAt)}`);
      }
    }
  }
  console.log(`  per-session rows dated by their OWN leg: ${perSessionOk}   mismatches: ${perSessionBad}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../../src/lib/prisma");
    await prisma.$disconnect();
  });
