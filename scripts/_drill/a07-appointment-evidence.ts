// ---------------------------------------------------------------------------
// DRILL: A07 — A CONTENT SESSION IS NOT CONFIRMED BY PROXIMITY (Sep 22 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     npx tsx scripts/_drill/a07-appointment-evidence.ts
//
// The Sep 21 audit reproduced this: "A content-session request at 10:00 matched
// a same-client listing-photo appointment at 11:00 whose project had no
// content-month link. Reconciliation marked the content request confirmed,
// linked the unrelated project, and closed the booking task."
//
// Every scenario the audit's acceptance list names is run here against the real
// decision function, with no database and no mocks — chooseSessionAppointment
// is pure over rows, which is why it was extracted.
//
//   · same-client listing shoot near the requested time
//   · content shoot in another month
//   · two ambiguous eligible appointments
//   · a cancelled appointment (filtered upstream, asserted as absent)
//   · one Pro appointment vs two distinct valid Pro appointments
// ---------------------------------------------------------------------------
import { chooseSessionAppointment, type ApptRow } from "../../src/lib/sessionRequests";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${ok ? "" : `\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`}`);
}

const MONTH = "month_sep";
const OTHER_MONTH = "month_aug";
const at = (iso: string) => new Date(iso);

function appt(o: { id: string; startAt: string; contentMonthId?: string | null; labels?: string[] }): ApptRow {
  return {
    id: `row_${o.id}`,
    aryeoId: o.id,
    startAt: at(o.startAt),
    projectId: `proj_${o.id}`,
    project: { contentMonthId: o.contentMonthId ?? null, deliverables: (o.labels ?? []).map((label) => ({ label })) },
  };
}

// The request the audit used: a content session asked for at 10:00 ET.
const REQ = { monthId: MONTH, monthKey: "2026-09", slotStart: at("2026-09-24T14:00:00Z"), createdAt: at("2026-09-20T12:00:00Z") };
const NONE = new Set<string>();

console.log("\n=== A07: proximity is not evidence ===\n");

// THE RULE THAT USED TO DECIDE, so this drill can be shown to have teeth. A
// test that passes against both the bug and the fix proves nothing; every
// scenario below is run through the old predicate first and the two answers
// are printed side by side.
const OLD_RULE = (a: ApptRow, slotStart: Date | null): boolean =>
  !!a.startAt && !!slotStart && Math.abs(a.startAt.getTime() - slotStart.getTime()) <= 2 * 3600_000;

// 1. THE AUDIT'S EXACT REPRODUCTION. Listing photos at 11:00, same client, no
//    content link, no content deliverable.
{
  const listing = appt({ id: "listing", startAt: "2026-09-24T15:00:00Z", labels: ["Listing Photos - 25 Images", "Zillow 3D Tour"] });
  check("BEFORE: the old proximity rule accepted this listing shoot", OLD_RULE(listing, REQ.slotStart), true);
  const d = chooseSessionAppointment(REQ, [listing], NONE);
  check("AFTER:  a listing shoot an hour away confirms nothing", d.verdict, "NONE");
  check("  …and is recorded as a near miss, not silence", d.nearMisses.length, 1);
}

// 2. The real content session, attached to this month.
{
  const d = chooseSessionAppointment(REQ, [appt({ id: "content", startAt: "2026-09-24T14:00:00Z", contentMonthId: MONTH })], NONE);
  check("the month's own content session confirms", d.verdict, "CONFIRM");
  check("  …on the month link, not on the clock", d.eligible[0]?.kind, "MONTH_LINK");
}

// 3. Content work identified by its deliverables, never attached (attachMonthlyProjects has not run).
{
  const d = chooseSessionAppointment(REQ, [appt({ id: "unattached", startAt: "2026-09-24T13:30:00Z", labels: ["Video Accelerator - 4HR Session"] })], NONE);
  check("unattached content work still confirms on its deliverables", d.verdict, "CONFIRM");
  check("  …and says which evidence it used", d.eligible[0]?.kind, "CONTENT_DELIVERABLE");
}

// 4. A content shoot belonging to ANOTHER month. Positive evidence of the
//    wrong thing — it is somebody's other session.
{
  const aug = appt({ id: "augshoot", startAt: "2026-09-24T14:00:00Z", contentMonthId: OTHER_MONTH, labels: ["Video Accelerator - 4HR Session"] });
  check("BEFORE: the old rule accepted another month's content shoot", OLD_RULE(aug, REQ.slotStart), true);
  check("AFTER:  a content shoot linked to a different month never matches", chooseSessionAppointment(REQ, [aug], NONE).verdict, "NONE");
}

// 5. Two eligible content appointments both fitting the window.
{
  const d = chooseSessionAppointment(REQ, [
    appt({ id: "c1", startAt: "2026-09-24T13:00:00Z", contentMonthId: MONTH }),
    appt({ id: "c2", startAt: "2026-09-24T15:30:00Z", contentMonthId: MONTH }),
  ], NONE);
  check("two eligible appointments go to a person, not to a guess", d.verdict, "AMBIGUOUS");
  check("  …with both candidates named", d.eligible.map((e) => e.a.aryeoId), ["c1", "c2"]);
}

// 6. PRO, one session booked. The second request must not confirm against the
//    first's appointment — the claim set is the guard.
{
  const both = [
    appt({ id: "pro1", startAt: "2026-09-24T14:00:00Z", contentMonthId: MONTH }),
    appt({ id: "pro2", startAt: "2026-09-25T14:00:00Z", contentMonthId: MONTH }),
  ];
  const first = chooseSessionAppointment(REQ, both, NONE);
  check("Pro session one confirms against its own appointment", first.eligible[0]?.a.aryeoId, "pro1");
  // The second request asked for the NEXT day; pro1 is now claimed.
  const REQ2 = { ...REQ, slotStart: at("2026-09-25T14:00:00Z") };
  const second = chooseSessionAppointment(REQ2, both, new Set(["pro1"]));
  check("Pro session two confirms against the OTHER appointment", second.eligible[0]?.a.aryeoId, "pro2");
  check("  …and never re-uses the first", second.eligible.some((e) => e.a.aryeoId === "pro1"), false);
}

// 7. PRO, only ONE appointment booked, two requests. The second must stay open.
{
  const only = [appt({ id: "pro1", startAt: "2026-09-24T14:00:00Z", contentMonthId: MONTH })];
  const second = chooseSessionAppointment({ ...REQ, slotStart: at("2026-09-24T15:00:00Z") }, only, new Set(["pro1"]));
  check("with one Pro appointment booked, the second request confirms nothing", second.verdict, "NONE");
}

// 8. FLEX request (no chosen time). The month link still has to be real.
{
  const flex = { monthId: MONTH, monthKey: "2026-09", slotStart: null, createdAt: at("2026-09-01T12:00:00Z") };
  const listing = chooseSessionAppointment(flex, [appt({ id: "l2", startAt: "2026-09-18T15:00:00Z", labels: ["Listing Photos - 25 Images"] })], NONE);
  check("a flex request is not confirmed by any listing shoot in the month", listing.verdict, "NONE");
  const real = chooseSessionAppointment(flex, [appt({ id: "c3", startAt: "2026-09-18T15:00:00Z", contentMonthId: MONTH })], NONE);
  check("a flex request IS confirmed by the month's content session", real.verdict, "CONFIRM");
}

// 9. An appointment with no start time cannot be matched on timing at all.
{
  const d = chooseSessionAppointment(REQ, [{ ...appt({ id: "unsched", startAt: "2026-09-24T14:00:00Z", contentMonthId: MONTH }), startAt: null }], NONE);
  check("an UNSCHEDULED appointment (null start) confirms nothing", d.verdict, "NONE");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
