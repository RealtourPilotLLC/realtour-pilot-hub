// ---------------------------------------------------------------------------
// DRILL: "DON'T INVENT PRODUCTION DATES" (Jordan, Sep 21 2026 — batch 2)
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/honest-dates.ts
//
// Batch 1 answered a missing appointment end by estimating one — booked start
// plus the package's minutes, or the shoot date — and labelling it
// "(estimated)". Jordan replaced that rule:
//
//   "Don't invent production dates. Show 'Not scheduled' for genuinely unbooked
//    work. If filming happened but its appointment or end time is missing, show
//    'Production date needs verification' and assign Kyle the correction.
//    Unknown deadlines must not appear as on time."
//
// This replays the new rule over EVERY monthly-content project in production and
// answers four questions:
//   1. does any live session LOSE a date it has today?
//   2. does every undated job say WHICH kind of nothing it is?
//   3. can an unknown date still reach a consumer as a date, anywhere?
//   4. does the delivery board's retired `now` fallback change any live row?
//
// READ-ONLY, STRUCTURALLY. The connection refuses writes and proves it with a
// refused UPDATE before it reads anything (scripts/_drill/attribution-rails.ts).
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

const DAY = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "—";

let checks = 0;
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const {
    productionAnchorFor, productionClockFor, productionSessionsFor, legEnd, anchorIsKnown,
    NOT_SCHEDULED_LABEL, NEEDS_VERIFICATION_LABEL,
  } = await import("../../src/lib/turnaround");
  const { boardSessions, boardItems, outstandingPromise, productionDateState } = await import("../../src/lib/deliveryBoard");
  const { sessionClocksFor, sessionMinutesFor, SESSION_CLOCK_SELECT } = await import("../../src/lib/contentProgram");
  const { turnaroundRules } = await import("../../src/lib/settings");

  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  const rules = await turnaroundRules();
  const now = Date.now();

  // -------------------------------------------------------------------------
  console.log(`\n=== 1. THE UNIT TESTS THE LIVE DATA CANNOT REACH (synthetic legs) ===`);
  const t = (iso: string) => new Date(iso);
  const realEnd = legEnd({ id: "a", startAt: t("2026-09-22T13:00:00Z"), endAt: t("2026-09-22T17:00:00Z"), status: "SCHEDULED" }, 240);
  check(realEnd.status === "known" && realEnd.at?.toISOString() === "2026-09-22T17:00:00.000Z",
    "a recorded end is the anchor", `${realEnd.source} ${DAY(realEnd.at)}`);

  const byDuration = legEnd({ id: "b", startAt: t("2026-09-22T13:00:00Z"), endAt: null, durationMin: 180, status: "SCHEDULED" }, 240);
  check(byDuration.status === "known" && byDuration.at?.toISOString() === "2026-09-22T16:00:00.000Z",
    "no end_at but Aryeo's OWN 180 minutes is still the appointment's end, not a guess", `${byDuration.source} ${DAY(byDuration.at)}`);
  check(byDuration.at!.getTime() !== t("2026-09-22T17:00:00Z").getTime(),
    "…and it does NOT get stretched to the package's 240", `booked ${byDuration.bookedMinutes}`);

  const blind = legEnd({ id: "c", startAt: t("2026-09-22T13:00:00Z"), endAt: null, durationMin: null, status: "SCHEDULED" }, 240);
  check(blind.at === null && blind.status === "needs_verification" && blind.unknownLabel === NEEDS_VERIFICATION_LABEL,
    "BATCH 1 INVENTED start+package here; now it is 'Production date needs verification' with NO date", `${blind.source}`);

  const unsched = legEnd({ id: "d", startAt: null, endAt: null, status: "UNSCHEDULED" }, 240);
  check(unsched.at === null && unsched.status === "not_scheduled" && unsched.unknownLabel === NOT_SCHEDULED_LABEL,
    "an unscheduled leg is 'Not scheduled' — nothing for Kyle to correct");

  const shootOnly = productionAnchorFor({ shootDate: t("2026-09-11T14:00:00Z"), appointments: [] }, { now });
  check(shootOnly.at === null && shootOnly.status === "needs_verification",
    "BATCH 1 BORROWED THE SHOOT DATE here; now it is undated and Kyle owns it", shootOnly.note ?? "");

  const nothing = productionAnchorFor({ shootDate: null, appointments: [] }, { now });
  check(nothing.at === null && nothing.status === "not_scheduled", "genuinely unbooked work reads 'Not scheduled'");

  // A Pro month with one good session and one blind one must not read as fully clocked.
  const mixed = productionAnchorFor({
    shootDate: null,
    appointments: [
      { id: "s1", startAt: t("2026-10-05T13:00:00Z"), endAt: t("2026-10-05T17:00:00Z"), status: "SCHEDULED" },
      { id: "s2", startAt: t("2026-10-12T13:00:00Z"), endAt: null, durationMin: null, status: "SCHEDULED" },
    ],
  }, { now, expectedSessionMinutes: 240 });
  check(anchorIsKnown(mixed) && /no end time yet/.test(mixed.note ?? ""),
    "a Pro job with one dated and one blind session is dated AND says the other has no date", mixed.note ?? "");
  const s2 = productionAnchorFor({ shootDate: null, appointments: [
    { id: "s1", startAt: t("2026-10-05T13:00:00Z"), endAt: t("2026-10-05T17:00:00Z"), status: "SCHEDULED" },
    { id: "s2", startAt: t("2026-10-12T13:00:00Z"), endAt: null, durationMin: null, status: "SCHEDULED" },
  ] }, { now, legId: "s2", expectedSessionMinutes: 240 });
  check(s2.at === null && s2.status === "needs_verification",
    "…and session 2 asked for by id answers for ITSELF, never borrowing session 1's end");

  // The on-time guard, on the one shape where a date and an unknown anchor coexist.
  const overridden = productionClockFor(
    { shootDate: t("2026-09-11T14:00:00Z"), appointments: [], dueOverrideAt: t("2026-10-01T21:00:00Z") },
    { now, rules },
  );
  check(overridden.effectiveDueAt !== null && overridden.dateKnown === false && overridden.needsProductionDateCheck,
    "an OFFICE OVERRIDE keeps its date, and dateKnown is still false so nothing counts it as on time");
  const pinned = productionClockFor(
    { shootDate: t("2026-09-11T14:00:00Z"), appointments: [], promisedDueAt: t("2026-10-01T21:00:00Z") },
    { now, rules },
  );
  check(pinned.effectiveDueAt === null && pinned.effectiveSource === "none",
    "a FROZEN PROMISE alone cannot manufacture a due date off an unknown anchor");

  // -------------------------------------------------------------------------
  console.log(`\n=== 2. REPLAY OVER EVERY LIVE MONTHLY-CONTENT PROJECT ===`);
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { not: null } },
    select: { ...SESSION_CLOCK_SELECT, contentMonthId: true, status: true, deliveredAt: true },
  });
  console.log(`   ${projects.length} projects`);
  let lost = 0, known = 0, verify = 0, unbooked = 0;
  for (const p of projects) {
    const before = productionSessionsFor(p, { expectedSessionMinutes: 240 });
    const a = productionAnchorFor(p, { now, expectedSessionMinutes: 240 });
    // "Would batch 1 have had a date here?" — batch 1 dated anything with a
    // bookable leg OR a shootDate. Anything in that set that is undated now is
    // a date we deliberately gave up, and every one has to be justified.
    const batch1WouldHaveDated = before.length > 0 || !!p.shootDate;
    if (a.status === "known") known++;
    else if (a.status === "needs_verification") verify++;
    else unbooked++;
    if (batch1WouldHaveDated && a.status !== "known") {
      lost++;
      console.log(`   DATE GIVEN UP: ${p.title.slice(0, 44).padEnd(44)} -> ${a.unknownLabel}`);
      console.log(`                  ${a.note}`);
    }
  }
  console.log(`   known ${known} · needs verification ${verify} · not scheduled ${unbooked}`);
  check(known === projects.length - verify - unbooked, "every project lands in exactly one of the three states");
  check(lost === verify, "every date given up is a 'needs verification' exception, never a silent blank", `${lost} given up`);

  // -------------------------------------------------------------------------
  console.log(`\n=== 3. NO UNKNOWN REACHES A CONSUMER AS A DATE ===`);
  let leaks = 0;
  for (const p of projects) {
    const pkg = "Accelerator";
    const clocks = sessionClocksFor([p], pkg, rules, now);
    for (const c of clocks) {
      const undated = c.anchorSource === "needs_verification" || c.anchorSource === "none";
      if (undated && (c.anchorAt || c.productionTargetAt || c.productionDueAt)) {
        leaks++;
        console.log(`   LEAK ${p.title}: ${c.anchorSource} yet anchorAt=${DAY(c.anchorAt)} due=${DAY(c.productionDueAt)}`);
      }
      if (!undated && !c.anchorAt) { leaks++; console.log(`   LEAK ${p.title}: known yet no anchorAt`); }
    }
    const sess = boardSessions({ deliverables: [{ type: "SOCIAL_REEL", status: "PENDING", uploadedAt: null, label: null }], packageName: "Monthly Social Content Plan", appointments: p.appointments }, rules);
    for (const s of sess) {
      if (s.anchorStatus !== "known" && (s.anchorAt || s.productionDueAt)) { leaks++; console.log(`   LEAK board session ${p.title}`); }
      if (s.anchorEstimated) { leaks++; console.log(`   LEAK: anchorEstimated is true somewhere — nothing may be an estimate now`); }
    }
  }
  check(leaks === 0, "no undated session carries an anchor, a target or a due date anywhere", `${leaks} leaks`);
  check(sessionMinutesFor("Pro") === 240, "Pro asks availability for 240 minutes per session, not 480");

  // -------------------------------------------------------------------------
  console.log(`\n=== 4. THE BOARD: THE RETIRED \`now\` FALLBACK, AND WHAT KYLE SEES ===`);
  const boardRows = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, revisionRequestedAt: true,
      dueOverrideAt: true, tierOverride: true, promisedDueAt: true, promisedReason: true,
      packageName: true, statusEvidence: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { select: { type: true, status: true, uploadedAt: true, label: true } },
      appointments: { select: { id: true, startAt: true, endAt: true, durationMin: true, status: true }, orderBy: { startAt: "asc" } },
    },
    take: 400,
    orderBy: { shootDate: "desc" },
  });
  const nowD = new Date();
  let movedOffNow = 0, stateShown = 0;
  for (const p of boardRows) {
    const st = productionDateState(p, nowD);
    if (!st) continue;
    const promise = outstandingPromise(p, { now: nowD, turnarounds: rules });
    if (st.status !== "known") {
      stateShown++;
      // The old rule: monthly + no shootDate -> anchored on `now` -> always a
      // date, always ten business days out, never late. Those are the rows that
      // moved, and a moved row MUST now carry a label.
      if (!p.shootDate) movedOffNow++;
      console.log(`   ${st.label!.padEnd(34)} ${p.title.slice(0, 40).padEnd(40)} dueAt=${DAY(promise.at)} needsCheck=${st.needsCheck}`);
      if (!st.label) { failures++; checks++; console.log("   FAIL: undated job with no label"); }
    }
  }
  console.log(`   monthly jobs with no production date: ${stateShown} (${movedOffNow} of them previously anchored on a receding \`now\`)`);
  check(true, `board replayed over ${boardRows.length} live projects with no throw`);

  // -------------------------------------------------------------------------
  console.log(`\n=== 5. THE PIN FALLBACK: WHICH ROWS IT ACTUALLY TOUCHES ===`);
  // `const at = earliest ? cappedByPromise(earliest.dueAt, pin) : pin` was
  // written for ONE shape — a live job whose only clock was the retired monthly
  // `now` — but outstandingPromise leaves `earliest` null on THREE paths:
  //   · SETTLED: every candidate is zeroed on purpose (a delivered job has no
  //     outstanding promise, and its pin is months old, so it reads overdue).
  //   · REOPENED: an explicit `reopened ? null : …`, because a revision has no
  //     clock until Jordan answers — re-dating it to the promise it already
  //     KEPT is the exact thing that ternary exists to prevent.
  //   · genuinely dateless: the three jobs this was for.
  // So this walks the same 400 rows, works out which path each one is on, and
  // reports how many take a date from the fallback. Only the third path may.
  const { pinnedPromise } = await import("../../src/lib/turnaround");
  const TERMINAL = new Set(["DELIVERED", "CANCELLED"]);
  // deliveryBoard.hasOpenRevision / isSettled, replayed here because both are
  // module-private. Kept literal rather than paraphrased.
  const openRevision = (p: { status: string; deliveredAt: Date | null; revisionRequestedAt: Date | null }) =>
    p.status === "REVISION" ? true : !p.revisionRequestedAt ? false : !p.deliveredAt || p.revisionRequestedAt > p.deliveredAt;

  let fellBack = 0, settledPin = 0, settledOverdue = 0, reopenedPin = 0, datelessPin = 0, heldByOverride = 0;
  for (const p of boardRows) {
    const pin = pinnedPromise(p);
    if (!pin) continue;
    const settled = TERMINAL.has(p.status) && !openRevision(p);
    const reopened = !settled && !!p.deliveredAt;
    const dated = boardItems(p, nowD, rules).some((i) => i.dueAt !== null);
    // With a dated item `earliest` is never null (the whole-order fallback
    // picks the min), so the pin line cannot be what answers for this row.
    if (!settled && !reopened && dated) continue;
    // An office override returns BEFORE the pin line, so it cannot move either.
    // Counted, not silently skipped: the Sep 21 review read 4 reopened jobs
    // here and this drill reads 3, and the difference is a reopened job whose
    // date Jordan had already set by hand.
    if (!settled && p.dueOverrideAt) {
      if (reopened) heldByOverride++;
      continue;
    }
    const promise = outstandingPromise(p, { now: nowD, turnarounds: rules });
    if (!promise.at) continue; // the fallback did not fire on this row
    fellBack++;
    if (settled) {
      settledPin++;
      if (promise.at < nowD) settledOverdue++;
    } else if (reopened) {
      reopenedPin++;
      console.log(`   REOPENED RE-DATED: ${p.title.slice(0, 44).padEnd(44)} ${DAY(promise.at)}  (${promise.tierLabel})`);
    } else {
      datelessPin++;
      console.log(`   PIN NOW SHOWN:     ${p.title.slice(0, 44).padEnd(44)} ${DAY(promise.at)}  (${promise.tierLabel})`);
    }
  }
  console.log(`   rows whose date comes from the pin alone: ${fellBack}`);
  console.log(`      settled/DELIVERED ${settledPin} (${settledOverdue} of them now overdue) · reopened ${reopenedPin} · dateless ${datelessPin}`);
  console.log(`      reopened jobs with a pin whose date the office had already set by hand: ${heldByOverride}`);
  check(settledPin === 0, "a SETTLED job takes no date from the pin", `${settledPin} settled jobs re-dated`);
  check(reopenedPin === 0, "a REOPENED job takes no date from the pin", `${reopenedPin} reopened jobs re-dated`);
  check(fellBack === datelessPin, "the fallback fires ONLY on the dateless-but-promised job", `${fellBack} rows, ${datelessPin} of them dateless`);

  console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
  if (failures) process.exitCode = 1;
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
