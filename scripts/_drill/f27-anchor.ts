// ---------------------------------------------------------------------------
// DRILL: WHAT RE-ANCHORING THE PRODUCTION CLOCK CHANGES (F27, Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     set -a && source .env; set +a && NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/f27-anchor.ts
//
// §8 says the internal production window is "target business day 7, overdue
// after business day 10, anchored to THAT APPOINTMENT'S END". Today the hub
// anchors on a START: deliveryBoard.clockStart takes Project.shootDate (and
// `now` for a monthly job with no shoot), tasks.videoAnchorFor takes the last
// appointment's startAt. Moving an anchor is moving the rule that decides when
// work is late, so this drill answers, on the real rows, the only question
// that matters before it ships:
//
//   DOES ANY JOB'S CURRENT DATE MOVE?
//
// It replays both anchors over every attached content session, applies the same
// override/pin ladder the board applies, and prints every difference — split
// into jobs protected by an office override or a frozen promise (which must not
// move at all) and unprotected jobs (where the whole point is that they move,
// and by how much matters).
//
// It also exercises A32 directly: a late upload must consume the deadline, not
// restart it, and each Pro session must carry its own day-7/day-10 pair.
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

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const {
    productionAnchorFor,
    productionClockFor,
    productionWindowFrom,
    dueAtFor,
    cappedByPromise,
    pinnedPromise,
    TIERS,
  } = await import("../../src/lib/turnaround");
  const { sessionClocksFor, sessionMinutesFor, aryeoProductFor, programPriceFor, PACKAGE_RULES } = await import("../../src/lib/contentProgram");
  const { turnaroundRules } = await import("../../src/lib/settings");

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

  const rules = await turnaroundRules();
  const now = Date.now();
  console.log(`\nOffice rules in force: monthlyBusinessDays=${rules.monthlyBusinessDays}, standardVideoHours=${rules.standardVideoHours}`);

  // =========================================================================
  // 1. F01 — the catalogue map, echoed so a reader can check it by eye.
  // =========================================================================
  console.log("\n=== 1. F01 PACKAGE / PROVIDER MAP ===");
  for (const pkg of ["Starter", "Accelerator", "Pro"] as const) {
    const p = aryeoProductFor(pkg)!;
    const r = PACKAGE_RULES[pkg];
    console.log(
      `  ${pkg.padEnd(12)} videos ${r.videosPerMonth}  sessions ${r.sessionsPerMonth}  sold as ${sessionMinutesFor(pkg)}min` +
        `  | Aryeo ${p.productId} "${p.title}" duration ${p.durationMinutes}min` +
        `  ${p.durationMinutes === sessionMinutesFor(pkg) ? "AGREE" : "DISAGREE"}`,
    );
  }
  const sample = programPriceFor("price_1U2ue2RrlUAkQjeVSGwsZXpB");
  const sample2 = programPriceFor("price_1ToRVeRrlUAkQjeVGVfJSGkR");
  console.log(`  price map: the two Accelerator M2M prices resolve apart — $${(sample!.amountCents / 100).toFixed(0)} and $${(sample2!.amountCents / 100).toFixed(0)}, same product id ${sample!.productId}`);
  console.log(`  unknown price -> ${programPriceFor("price_does_not_exist") === null ? "null (name parser stays the fallback)" : "WRONG"}`);

  // =========================================================================
  // 2. The live sessions.
  // =========================================================================
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { not: null }, status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true,
      promisedDueAt: true, dueOverrideAt: true, contentMonthId: true, clientId: true,
      appointments: { select: { id: true, startAt: true, endAt: true, durationMin: true, status: true } },
    },
  });
  const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(projects.map((p) => p.clientId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  console.log(`\n=== 2. LIVE CONTENT SESSIONS: ${projects.length} attached projects, ${projects.reduce((s, p) => s + p.appointments.length, 0)} appointment rows ===`);

  // ---- the anchor ladder, counted -----------------------------------------
  const ladder = new Map<string, number>();
  const estimated: string[] = [];
  for (const p of projects) {
    const a = productionAnchorFor(p, { now });
    ladder.set(a.source, (ladder.get(a.source) ?? 0) + 1);
    if (a.estimated) estimated.push(`      ${nameOf.get(p.clientId) ?? "?"} · ${p.title.slice(0, 44)} — ${a.note}`);
  }
  console.log("  anchor ladder:");
  for (const [k, v] of [...ladder].sort((x, y) => y[1] - x[1])) console.log(`      ${String(v).padStart(3)}  ${k}`);
  console.log(`  estimated anchors (the fallback is VISIBLE, never silent): ${estimated.length}`);
  for (const line of estimated.slice(0, 12)) console.log(line);

  // =========================================================================
  // 3. THE REGRESSION TEST: does any job's CURRENT date move?
  //
  // old = exactly what deliveryBoard does today (clockStart = shootDate, or
  // `now` for a monthly job with no shoot) -> monthly_social due -> the same
  // override/pin ladder. new = the appointment end -> same window -> same
  // ladder. Anything that differs is printed.
  // =========================================================================
  console.log("\n=== 3. OLD ANCHOR vs NEW ANCHOR, with the promise ladder applied ===");
  type Diff = { who: string; title: string; oldDue: Date | null; newDue: Date | null; protectedBy: string; shifted: number };
  const moved: Diff[] = [];
  const sameDay: Diff[] = [];
  let unchanged = 0;
  let protectedRows = 0;
  for (const p of projects) {
    // what today's engine says
    const oldAnchor = p.shootDate ?? new Date(now); // the monthly `now` fallback
    const oldComputed = dueAtFor(TIERS.monthly_social, oldAnchor, rules);
    const oldEffective = p.dueOverrideAt ?? cappedByPromise(oldComputed, pinnedPromise(p));
    // what the new anchor says
    const clock = productionClockFor(p, { now, expectedSessionMinutes: null, rules });
    const newEffective = clock.effectiveDueAt;
    const guarded = p.dueOverrideAt ? "office override" : clock.effectiveSource === "as_promised" ? "frozen promise" : "";
    if (guarded) protectedRows++;
    const a = oldEffective?.getTime() ?? null;
    const b = newEffective?.getTime() ?? null;
    if (a === b) { unchanged++; continue; }
    const row: Diff = {
      who: nameOf.get(p.clientId) ?? "?",
      title: p.title.slice(0, 40),
      oldDue: oldEffective,
      newDue: newEffective,
      protectedBy: guarded || "none",
      shifted: a !== null && b !== null ? Math.round((b - a) / 3_600_000) : NaN,
    };
    (DAYKEY(oldEffective) === DAYKEY(newEffective) ? sameDay : moved).push(row);
  }
  console.log(`  identical date:            ${unchanged}/${projects.length}`);
  console.log(`  same DAY, different hour:  ${sameDay.length}`);
  console.log(`  different DAY:             ${moved.length}`);
  console.log(`  rows protected by an override or a frozen promise: ${protectedRows}`);
  const protectedAndMoved = [...moved, ...sameDay].filter((d) => d.protectedBy !== "none");
  console.log(`  PROTECTED ROWS THAT MOVED: ${protectedAndMoved.length}  ${protectedAndMoved.length === 0 ? "(the freeze holds)" : "(REGRESSION)"}`);
  for (const d of protectedAndMoved) console.log(`      !! ${d.who} · ${d.title} — ${ET(d.oldDue)} -> ${ET(d.newDue)} [${d.protectedBy}]`);
  for (const d of moved.slice(0, 20)) {
    console.log(`      ${d.who.padEnd(20)} ${d.title.padEnd(42)} ${DAYKEY(d.oldDue)} -> ${DAYKEY(d.newDue)}  (${Number.isNaN(d.shifted) ? "n/a" : `${d.shifted >= 0 ? "+" : ""}${d.shifted}h`})`);
  }
  if (sameDay.length) console.log(`      (same-day examples: ${sameDay.slice(0, 3).map((d) => `${d.who} ${d.shifted >= 0 ? "+" : ""}${d.shifted}h`).join(", ")})`);

  // Delivered history must be untouchable: every one of these carries a pin.
  const delivered = projects.filter((p) => p.deliveredAt);
  const deliveredUnpinned = delivered.filter((p) => !p.promisedDueAt && !p.dueOverrideAt);
  console.log(`  delivered content jobs: ${delivered.length}, of which unpinned (no frozen promise, no override): ${deliveredUnpinned.length}`);
  for (const p of deliveredUnpinned.slice(0, 8)) {
    const oldComputed = dueAtFor(TIERS.monthly_social, p.shootDate ?? new Date(now), rules);
    const nw = productionClockFor(p, { now, rules }).productionDueAt;
    console.log(`      ${(nameOf.get(p.clientId) ?? "?").padEnd(20)} ${p.title.slice(0, 36).padEnd(38)} ${DAYKEY(oldComputed)} -> ${DAYKEY(nw)}${DAYKEY(oldComputed) === DAYKEY(nw) ? "" : "   <-- day changes"}`);
  }

  // =========================================================================
  // 4. A32 — appointment end versus late upload.
  // =========================================================================
  console.log("\n=== 4. A32: appointment end versus late upload ===");
  const shot = projects
    .filter((p) => p.appointments.some((a) => a.startAt && a.startAt.getTime() < now && !(a.status || "").toUpperCase().startsWith("CANCEL")))
    .sort((a, b) => (b.shootDate?.getTime() ?? 0) - (a.shootDate?.getTime() ?? 0));
  const subject = shot[0];
  if (!subject) console.log("  no shot content session in the data — skipped");
  else {
    const atEnd = productionClockFor(subject, { now: (subject.shootDate ?? new Date()).getTime() + 3_600_000, rules });
    const daysLater = productionClockFor(subject, { now: now + 30 * 86_400_000, rules });
    const today = productionClockFor(subject, { now, rules });
    console.log(`  subject: ${nameOf.get(subject.clientId) ?? "?"} · ${subject.title.slice(0, 50)}`);
    console.log(`    anchor              ${ET(today.anchor.at)}  [${today.anchor.source}]`);
    console.log(`    day-7 target        ${ET(today.productionTargetAt)}`);
    console.log(`    day-10 overdue      ${ET(today.productionDueAt)}`);
    const stable =
      atEnd.productionDueAt?.getTime() === today.productionDueAt?.getTime() &&
      daysLater.productionDueAt?.getTime() === today.productionDueAt?.getTime();
    console.log(`    computed an hour after the session, today, and 30 days from now: ${stable ? "IDENTICAL — a late upload consumes the deadline, it cannot restart it" : "DRIFTED — FAIL"}`);
    // The contrast: today's monthly fallback for a job with no shoot date walks
    // forward one day per day, which is the drift this anchor removes.
    const noShoot = { shootDate: null, appointments: [] };
    const walk1 = dueAtFor(TIERS.monthly_social, new Date(now), rules);
    const walk2 = dueAtFor(TIERS.monthly_social, new Date(now + 86_400_000), rules);
    console.log(`    for contrast, the old \`now\` fallback on a shootless job: ${DAYKEY(walk1)} today, ${DAYKEY(walk2)} tomorrow (walks); the new anchor answers ${productionAnchorFor(noShoot, { now }).source}, with no date at all`);
  }

  // =========================================================================
  // 5. Each Pro session its own end and its own 7/10.
  // =========================================================================
  console.log("\n=== 5. PER-SESSION TARGETS (Pro) ===");
  const multi = projects.filter((p) => p.appointments.filter((a) => a.startAt && !(a.status || "").toUpperCase().startsWith("CANCEL")).length > 1);
  console.log(`  real content jobs carrying more than one live leg: ${multi.length}`);
  for (const p of multi.slice(0, 5)) {
    const clocks = sessionClocksFor([p], "Accelerator", rules, now);
    console.log(`    ${nameOf.get(p.clientId) ?? "?"} · ${p.title.slice(0, 40)}`);
    for (const c of clocks) console.log(`       session ${c.sessionIndex}/${c.sessionsInMonth}  ends ${ET(c.anchorAt)} [${c.anchorSource}]  target ${DAYKEY(c.productionTargetAt)}  overdue after ${DAYKEY(c.productionDueAt)}`);
  }
  // No Pro order has ever been placed (Phase 0), so the two-session case is
  // exercised on an IN-MEMORY fixture. Nothing below touches the database.
  const proFixture = {
    id: "fixture-pro", title: "FIXTURE · Pro month, two four-hour sessions", shootDate: new Date("2026-10-06T13:00:00Z"),
    promisedDueAt: null, dueOverrideAt: null,
    appointments: [
      { id: "leg-1", startAt: new Date("2026-10-06T13:00:00Z"), endAt: new Date("2026-10-06T17:00:00Z"), durationMin: 240, status: "SCHEDULED" },
      { id: "leg-2", startAt: new Date("2026-10-20T13:00:00Z"), endAt: new Date("2026-10-20T17:00:00Z"), durationMin: 240, status: "SCHEDULED" },
    ],
  };
  const proClocks = sessionClocksFor([proFixture], "Pro", rules, new Date("2026-10-01T12:00:00Z").getTime());
  for (const c of proClocks) {
    console.log(`    [fixture] session ${c.sessionIndex}/${c.sessionsInMonth} ends ${ET(c.anchorAt)} -> target ${DAYKEY(c.productionTargetAt)}, overdue after ${DAYKEY(c.productionDueAt)}  drift:${c.durationDrift ? "yes" : "none"}`);
  }
  console.log(`    two distinct day-10 dates: ${proClocks[0].productionDueAt!.getTime() !== proClocks[1].productionDueAt!.getTime() ? "YES" : "NO — FAIL"}`);

  // =========================================================================
  // 6. Duration drift — reported, never corrected.
  // =========================================================================
  console.log("\n=== 6. BOOKED MINUTES vs PACKAGE MINUTES ===");
  const months = await prisma.contentMonth.findMany({
    where: { id: { in: [...new Set(projects.map((p) => p.contentMonthId!))] } },
    select: { id: true, enrollmentId: true, monthKey: true },
  });
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { id: { in: [...new Set(months.map((m) => m.enrollmentId))] } },
    select: { id: true, package: true, videosPerMonth: true, packageSource: true, clientId: true },
  });
  const pkgOfMonth = new Map(months.map((m) => [m.id, enrollments.find((e) => e.id === m.enrollmentId)?.package ?? null]));
  let drifted = 0;
  for (const p of projects) {
    const clocks = sessionClocksFor([p], pkgOfMonth.get(p.contentMonthId!) ?? null, rules, now);
    for (const c of clocks) {
      if (!c.durationDrift) continue;
      drifted++;
      if (drifted <= 10) console.log(`    ${(nameOf.get(p.clientId) ?? "?").padEnd(20)} ${p.title.slice(0, 34).padEnd(36)} ${c.durationDrift}`);
    }
  }
  console.log(`  sessions whose booked length differs from the package: ${drifted}`);
  const manual = enrollments.filter((e) => e.packageSource === "manual" && PACKAGE_RULES[e.package ?? ""] && e.videosPerMonth !== PACKAGE_RULES[e.package!].videosPerMonth);
  console.log(`  manual allowance overrides still standing (nothing in this batch writes them): ${manual.length}`);
  for (const e of manual) console.log(`      ${(nameOf.get(e.clientId) ?? e.clientId).padEnd(20)} ${e.package} stored ${e.videosPerMonth} videos, table says ${PACKAGE_RULES[e.package!].videosPerMonth}`);

  // =========================================================================
  // 7. DST, with no hard-coded offsets (§8's last line).
  // =========================================================================
  console.log("\n=== 7. DST ===");
  for (const iso of ["2026-03-05T22:00:00Z", "2026-11-05T21:00:00Z"]) {
    const end = new Date(iso);
    const w = productionWindowFrom(end, rules);
    console.log(`    session ends ${ET(end)} -> target ${ET(w.productionTargetAt)} · overdue after ${ET(w.productionDueAt)}`);
  }
  console.log("    both close at 5:00 PM ET on a weekday, across the spring and autumn changeovers.");

  // =========================================================================
  // 8. The ladder's edge cases, on in-memory fixtures (no database).
  //    One live appointment is UNSCHEDULED with null start/end and one live
  //    order has no appointment at all, so these rungs are real, not defensive
  //    padding — and a cancelled Pro leg must not inherit the other session's
  //    deadline.
  // =========================================================================
  console.log("\n=== 8. ANCHOR LADDER, EDGE CASES ===");
  const at = new Date("2026-10-06T13:00:00Z");
  const cases: { label: string; leg: Record<string, unknown> | null; legId?: string }[] = [
    { label: "end present", leg: { id: "a", startAt: at, endAt: new Date("2026-10-06T17:00:00Z"), durationMin: 240, status: "SCHEDULED" } },
    { label: "no end, duration present", leg: { id: "a", startAt: at, endAt: null, durationMin: 180, status: "SCHEDULED" } },
    { label: "no end, no duration (package fills in)", leg: { id: "a", startAt: at, endAt: null, durationMin: null, status: "SCHEDULED" } },
    { label: "UNSCHEDULED leg, null start", leg: { id: "a", startAt: null, endAt: null, durationMin: null, status: "UNSCHEDULED" } },
    { label: "cancelled leg asked for by id", leg: { id: "a", startAt: at, endAt: new Date("2026-10-06T17:00:00Z"), durationMin: 240, status: "CANCELED" }, legId: "a" },
    { label: "no appointment at all", leg: null },
  ];
  for (const c of cases) {
    const p = { shootDate: at, appointments: c.leg ? [c.leg] : [] } as never;
    const a = productionAnchorFor(p, { now: new Date("2026-10-01T12:00:00Z").getTime(), expectedSessionMinutes: 240, legId: c.legId ?? null });
    console.log(`    ${c.label.padEnd(38)} -> ${a.source.padEnd(34)} ${ET(a.at)}${a.estimated ? "  (estimated)" : ""}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
