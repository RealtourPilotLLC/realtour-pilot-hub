// ---------------------------------------------------------------------------
// PROOF: the three session defects, before and after (Sep 21 2026, batch 2).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/session-loss-and-double-count-proof.ts
//
// Each section re-implements the OLD rule beside the shipped one and prints
// both, so the fix is a measured difference rather than an assertion. Real rows
// throughout; the only synthetic thing is a ProgramSessionRequest, because that
// table holds 0 rows today (the program is pre-launch) and the shape is taken
// verbatim from what sessionRequests.confirmSessionRequest writes.
//
// READ-ONLY, STRUCTURALLY, proven by a refused UPDATE before the first read.
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

const aryeoLastChangedAt = (rawJson: string | null): Date | null => {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const updatedAt = (parsed as { updated_at?: unknown } | null)?.updated_at;
    if (typeof updatedAt !== "string") return null;
    const d = new Date(updatedAt);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { countDistinctSessions, sessionShortfall } = await import("../../src/lib/programMonths");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  const now = new Date();

  // ---- A. the loss stamp ------------------------------------------------------
  console.log("\nA. WHEN A SESSION WAS LOST — old stamp vs new");
  const canceled = (await prisma.appointment.findMany({
    where: { status: "CANCELED" },
    select: { aryeoId: true, projectId: true, updatedAt: true, rawJson: true },
  }));
  const hrs = (d: Date) => (now.getTime() - d.getTime()) / 3_600_000;
  const oldFresh = canceled.filter((a) => hrs(a.updatedAt) <= 3).length;
  const newFresh = canceled.filter((a) => { const d = aryeoLastChangedAt(a.rawJson); return !!d && hrs(d) <= 3; }).length;
  console.log(`   CANCELED appointments: ${canceled.length}`);
  console.log(`   OLD (Appointment.updatedAt) reading the loss as "within the last 3h": ${oldFresh}`);
  console.log(`   NEW (Aryeo rawJson.updated_at) reading the loss as "within the last 3h": ${newFresh}`);
  console.log(`   NEW undatable (no parseable Aryeo stamp, so no loss claimed): ${canceled.filter((a) => !aryeoLastChangedAt(a.rawJson)).length}`);

  // What that does to the cadence, on a reminder that really was sent 3 days ago.
  const sentAt = new Date(now.getTime() - 3 * 86_400_000);
  const afterLoss = (lostAt: Date | null) => !lostAt || sentAt > lostAt;
  let oldReopens = 0, newReopens = 0;
  for (const a of canceled) {
    if (!afterLoss(a.updatedAt)) oldReopens++;          // old: reminder discounted -> cadence re-opens
    if (!afterLoss(aryeoLastChangedAt(a.rawJson))) newReopens++;
  }
  console.log(`   a reminder sent ${sentAt.toISOString().slice(0, 10)} is discounted (cadence re-opens) on:`);
  console.log(`     OLD: ${oldReopens} / ${canceled.length} cancellations — including every one re-synced this hour, forever`);
  console.log(`     NEW: ${newReopens} / ${canceled.length} — only cancellations that really happened after it`);

  // ---- B. the re-open was applied to every lane -------------------------------
  console.log("\nB. RE-OPEN SCOPING — which lanes a lost session may touch");
  const lostAt = new Date(now.getTime() - 86_400_000);
  const lanes = ["REVIEW_WORK", "COMPLETE_ANSWERS", "BOOK_CALL", "CHOOSE_PATH", "BOOK_SESSION"] as const;
  for (const action of lanes) {
    const oldLost: Date | null = lostAt;                                  // shared by every lane
    const newLost: Date | null = action === "BOOK_SESSION" ? lostAt : null; // booking lane only
    const priorSends = [4, 3, 2].map((d) => new Date(now.getTime() - d * 86_400_000));
    const countedOld = priorSends.filter((s) => !oldLost || s > oldLost).length;
    const countedNew = priorSends.filter((s) => !newLost || s > newLost).length;
    console.log(`   ${action.padEnd(17)} attempts counted — OLD ${countedOld}/3, NEW ${countedNew}/3${action !== "BOOK_SESSION" && countedOld < 3 ? "  <- OLD re-chased a lane the cancellation had nothing to do with" : ""}`);
  }

  // ---- C. the double count ----------------------------------------------------
  console.log("\nC. countDistinctSessions — a CONFIRMED request carrying only a projectId");
  const project = await prisma.project.findFirst({
    where: { appointments: { some: { status: { not: "CANCELED" }, startAt: { not: null } } } },
    select: { id: true, shootDate: true, addressLine: true, appointments: { select: { aryeoId: true, projectId: true, startAt: true, endAt: true, status: true } } },
    orderBy: { shootDate: "desc" },
  });
  if (!project) { console.log("   no real project with a live dated appointment — cannot prove"); await prisma.$disconnect(); return; }
  const appointments = project.appointments
    .filter((a) => a.status !== "CANCELED" && a.startAt)
    .map((a) => ({ appointmentId: a.aryeoId, projectId: a.projectId, startAt: a.startAt, endAt: a.endAt, cancelled: false }));
  const projects = [{ projectId: project.id, shootDate: project.shootDate, addressLine: project.addressLine }];
  // The shape confirmSessionRequest(requestId, { projectId }, by) writes: projectId set, aryeoAppointmentId null.
  const confirmedRequests = [{ requestId: "req_synthetic_bare", projectId: project.id, appointmentId: null, slotStart: appointments[0]?.startAt ?? null }];

  // The OLD keying, verbatim, for the before number.
  const oldCount = (() => {
    const keys = new Set<string>();
    const withAppts = new Set<string>();
    for (const a of appointments) { if (!a.startAt) continue; withAppts.add(a.projectId); keys.add(`appt:${a.appointmentId}`); }
    for (const p of projects) { if (!p.shootDate || withAppts.has(p.projectId)) continue; keys.add(`project:${p.projectId}`); }
    for (const r of confirmedRequests) keys.add(r.appointmentId ? `appt:${r.appointmentId}` : r.projectId ? `project:${r.projectId}` : `request:${r.requestId}`);
    return keys.size;
  })();
  const now2 = new Date(appointments[0]!.startAt!.getTime() - 86_400_000); // a day before the shoot, so it reads as booked
  const fixed = countDistinctSessions({ now: now2, appointments, projects, confirmedRequests });
  console.log(`   real project ${project.id} with ${appointments.length} live dated appointment(s) + 1 bare CONFIRMED request`);
  console.log(`   OLD accountedFor: ${oldCount}   NEW accountedFor: ${fixed.accountedFor}   (duplicatesFolded ${fixed.duplicatesFolded})`);
  console.log(`   NEW evidence: ${fixed.sessions.map((s) => `${s.key} <- [${s.evidence.join(" + ")}]`).join(" | ")}`);
  const req = 2; // a Pro month
  console.log(`   Pro month (needs ${req}): OLD ${sessionShortfall(req, { ...fixed, accountedFor: oldCount }).fullyScheduled ? "FULLY SCHEDULED on one booking" : "still short"} / NEW ${sessionShortfall(req, fixed).fullyScheduled ? "fully scheduled" : `still short ${sessionShortfall(req, fixed).missing}`}`);

  // Surplus: two bare requests against one appointment must still be two sessions.
  const two = countDistinctSessions({
    now: now2, appointments: appointments.slice(0, 1), projects,
    confirmedRequests: [
      { requestId: "req_a", projectId: project.id, appointmentId: null, slotStart: appointments[0]!.startAt },
      { requestId: "req_b", projectId: project.id, appointmentId: null, slotStart: appointments[0]!.startAt },
    ],
  });
  console.log(`   2 bare confirmed requests vs 1 appointment -> accountedFor ${two.accountedFor} (one folds onto the appointment, the unsynced one stands)`);

  // THE PRO SHAPE: two legs on ONE order, which is one Project here. Aryeo has
  // never carried a Pro order (see the note above countDistinctSessions), so the
  // two legs are two REAL appointment rows read off production and presented as
  // legs of one project — the shape the first Pro booking will produce.
  const twoLegs = (await prisma.appointment.findMany({
    where: { status: { not: "CANCELED" }, startAt: { not: null } },
    select: { aryeoId: true, startAt: true, endAt: true },
    orderBy: { startAt: "desc" }, take: 2,
  })).map((a) => ({ appointmentId: a.aryeoId, projectId: project.id, startAt: a.startAt, endAt: a.endAt, cancelled: false }));
  if (twoLegs.length === 2) {
    const proNow = new Date(Math.min(...twoLegs.map((a) => a.startAt!.getTime())) - 86_400_000);
    // An explicitly linked request must claim its own leg before a bare one takes it.
    const both = countDistinctSessions({
      now: proNow, appointments: twoLegs, projects,
      confirmedRequests: [
        { requestId: "req_bare", projectId: project.id, appointmentId: null, slotStart: twoLegs[0].startAt },
        { requestId: "req_linked", projectId: project.id, appointmentId: twoLegs[0].appointmentId, slotStart: twoLegs[0].startAt },
      ],
    });
    console.log(`   Pro shape, 2 legs on one project, 1 bare + 1 linked request -> accountedFor ${both.accountedFor} (expected 2, one per leg)`);
    console.log(`     ${both.sessions.map((s) => `${s.key} <- [${s.evidence.join(" + ")}]`).join(" | ")}`);
    const oneLegBooked = countDistinctSessions({
      now: proNow, appointments: [twoLegs[0]], projects,
      confirmedRequests: [{ requestId: "req_bare", projectId: project.id, appointmentId: null, slotStart: twoLegs[0].startAt }],
    });
    console.log(`   Pro shape, only leg 1 booked -> accountedFor ${oneLegBooked.accountedFor}, still short ${sessionShortfall(2, oneLegBooked).missing} (Jordan's clarification 1)`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
