// ---------------------------------------------------------------------------
// DRILL: WHEN WAS A SESSION LOST, AND WHERE DOES THE COUNT DOUBLE (Sep 21 2026,
// batch 2 review).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/session-loss-and-double-count.ts
//
// Three questions, all measured against production before anything is edited:
//
//  1. `Appointment.updatedAt` is @updatedAt on a row the Aryeo sync rewrites
//     unconditionally every hour (integrations/aryeo.ts:4136). Reminders read it
//     as "when the session was lost", so the loss stamp walks forward to ~now on
//     every pass and the re-open never fires. Measure how fresh those rows are,
//     and what DURABLE stamps exist instead: Aryeo's own payload (rawJson), the
//     one-per-transition cancellation bell, postponedAt/rescheduledAt.
//  2. Which ProgramSessionRequest terminal states were ever actually BOOKED
//     (confirmedAt set) — EXPIRED and DECLINED requests never were.
//  3. countDistinctSessions double-counts a CONFIRMED request that carries only
//     a projectId when that project already has appointments: the project loop
//     skips the project, so nothing holds `project:<id>` and the request mints a
//     second session for a single booking.
//
// READ-ONLY, STRUCTURALLY. The connection itself refuses writes and this file
// proves it with a refused UPDATE before it reads anything.
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

type Json = Record<string, unknown>;

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  const now = new Date();

  // ---- 1. how useless is Appointment.updatedAt --------------------------------
  const appts = await prisma.appointment.findMany({
    select: { id: true, aryeoId: true, projectId: true, status: true, startAt: true, createdAt: true, updatedAt: true, postponedAt: true, rescheduledAt: true, rawJson: true },
  });
  const freshH = (d: Date) => (now.getTime() - d.getTime()) / 3_600_000;
  console.log(`\n1. APPOINTMENTS: ${appts.length}`);
  for (const h of [3, 24, 72]) {
    console.log(`   updatedAt within last ${h}h: ${appts.filter((a) => freshH(a.updatedAt) <= h).length}`);
  }
  const canceled = appts.filter((a) => (a.status ?? "").toUpperCase().startsWith("CANCEL"));
  console.log(`   CANCELED rows: ${canceled.length}`);
  console.log(`   CANCELED with updatedAt within 3h: ${canceled.filter((a) => freshH(a.updatedAt) <= 3).length}`);
  console.log(`   CANCELED where updatedAt > createdAt + 1min: ${canceled.filter((a) => a.updatedAt.getTime() - a.createdAt.getTime() > 60_000).length}`);
  console.log(`   CANCELED with postponedAt: ${canceled.filter((a) => a.postponedAt).length}  rescheduledAt: ${canceled.filter((a) => a.rescheduledAt).length}`);

  // What does Aryeo itself say about a cancelled appointment?
  const keyCounts = new Map<string, number>();
  const dateishKeys = new Map<string, string>();
  for (const a of canceled) {
    if (!a.rawJson) continue;
    let j: Json;
    try { j = JSON.parse(a.rawJson) as Json; } catch { continue; }
    for (const [k, v] of Object.entries(j)) {
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
      if (typeof v === "string" && /cancel|updated|deleted|status/i.test(k)) dateishKeys.set(k, v);
    }
  }
  console.log(`   rawJson keys on CANCELED rows: ${[...keyCounts.entries()].map(([k, n]) => `${k}(${n})`).join(", ") || "none"}`);
  console.log(`   cancel/updated-ish values seen: ${JSON.stringify([...dateishKeys.entries()].slice(0, 12))}`);

  // The cancellation bell: one row per transition, dedupeKey `appt-<aryeoId>-canceled-<i>`,
  // createdAt never rewritten. 90-day retention (cron/daily).
  const bells = await prisma.notification.findMany({
    where: { kind: "appointment_change", dedupeKey: { contains: "-canceled" } },
    select: { dedupeKey: true, createdAt: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`   cancellation bells on file: ${bells.length}`);
  const bellByAppt = new Map<string, Date>();
  for (const b of bells) {
    const m = (b.dedupeKey ?? "").match(/^appt-(.+)-canceled(?:-\d+)?$/);
    if (!m) continue;
    const prev = bellByAppt.get(m[1]);
    if (!prev || b.createdAt < prev) bellByAppt.set(m[1], b.createdAt);
  }
  console.log(`   distinct appointments with a cancellation bell: ${bellByAppt.size}`);
  const canceledWithBell = canceled.filter((a) => bellByAppt.has(a.aryeoId));
  console.log(`   CANCELED rows covered by a bell: ${canceledWithBell.length} / ${canceled.length}`);
  for (const a of canceledWithBell.slice(0, 6)) {
    const b = bellByAppt.get(a.aryeoId)!;
    console.log(`     ${a.aryeoId}: bell ${b.toISOString()} (${freshH(b).toFixed(1)}h ago) vs updatedAt ${a.updatedAt.toISOString()} (${freshH(a.updatedAt).toFixed(1)}h ago)`);
  }
  const bellAges = [...bellByAppt.values()].map((d) => freshH(d) / 24);
  if (bellAges.length) console.log(`   bell ages (days): min ${Math.min(...bellAges).toFixed(1)} max ${Math.max(...bellAges).toFixed(1)}`);

  // ---- 2. which terminal requests were ever a booking -------------------------
  const reqs = await prisma.programSessionRequest.findMany({
    select: { id: true, monthId: true, clientId: true, status: true, projectId: true, aryeoAppointmentId: true, slotStart: true, confirmedAt: true, cancelledAt: true, createdAt: true, updatedAt: true },
  });
  console.log(`\n2. PROGRAM SESSION REQUESTS: ${reqs.length}`);
  const byStatus = new Map<string, typeof reqs>();
  for (const r of reqs) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r]);
  for (const [s, rows] of [...byStatus.entries()].sort()) {
    console.log(`   ${s}: ${rows.length}  (confirmedAt set: ${rows.filter((r) => r.confirmedAt).length}, cancelledAt set: ${rows.filter((r) => r.cancelledAt).length}, projectId: ${rows.filter((r) => r.projectId).length}, apptId: ${rows.filter((r) => r.aryeoAppointmentId).length})`);
  }
  for (const s of ["CANCELLED", "EXPIRED", "DECLINED"]) {
    const rows = byStatus.get(s) ?? [];
    console.log(`   ${s} that were EVER confirmed (a real lost booking): ${rows.filter((r) => r.confirmedAt).length} / ${rows.length}`);
  }

  // ---- 3. the double count ----------------------------------------------------
  const confirmed = reqs.filter((r) => r.status === "CONFIRMED");
  const projectIds = [...new Set(confirmed.map((r) => r.projectId).filter((x): x is string => !!x))];
  const apptsByProject = new Map<string, typeof appts>();
  for (const a of appts) apptsByProject.set(a.projectId, [...(apptsByProject.get(a.projectId) ?? []), a]);
  console.log(`\n3. CONFIRMED REQUESTS: ${confirmed.length}`);
  console.log(`   with an appointment id: ${confirmed.filter((r) => r.aryeoAppointmentId).length}`);
  const bare = confirmed.filter((r) => !r.aryeoAppointmentId && r.projectId);
  console.log(`   with ONLY a projectId: ${bare.length}`);
  let wouldDouble = 0;
  for (const r of bare) {
    const live = (apptsByProject.get(r.projectId!) ?? []).filter((a) => !(a.status ?? "").toUpperCase().startsWith("CANCEL") && a.startAt);
    if (live.length > 0) wouldDouble++;
    console.log(`     req ${r.id} project ${r.projectId} -> ${live.length} live dated appointment(s)  ${live.length ? "DOUBLE-COUNTED TODAY" : "counts once (no appointment yet)"}`);
  }
  console.log(`   requests that double-count today: ${wouldDouble} / ${bare.length}`);
  console.log(`   projects carrying MORE THAN ONE bare confirmed request: ${projectIds.filter((p) => bare.filter((r) => r.projectId === p).length > 1).length}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
