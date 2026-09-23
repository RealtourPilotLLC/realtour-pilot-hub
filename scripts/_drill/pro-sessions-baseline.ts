// ---------------------------------------------------------------------------
// DRILL: WHAT A "SESSION" IS, MEASURED (Sep 21 2026, batch 2).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/pro-sessions-baseline.ts
//
// Jordan, Sep 21: Video Pro is the EXISTING four-hour product booked TWICE, and
// a month is fully scheduled only when two DISTINCT confirmed sessions are
// linked to that client and month. Booking one product twice puts two
// APPOINTMENTS on one Aryeo order, which is ONE Project here. Everything that
// answers "how many sessions does this month have" counted projects.
//
// This drill measures, against production, how often project-counting and
// appointment-counting disagree, so the fix is anchored to real rows.
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

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  const enrollments = await prisma.contentEnrollment.findMany({
    select: { id: true, clientId: true, status: true, package: true, videosPerMonth: true, sessionsPerMonth: true, sessionHours: true },
  });
  const clientNames = new Map((await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  console.log(`\n1. ENROLLMENTS: ${enrollments.length}`);
  for (const e of enrollments.filter((x) => x.sessionsPerMonth > 1)) {
    console.log(`   MULTI-SESSION: ${clientNames.get(e.clientId) ?? e.clientId} — ${e.package} ${e.status} videos=${e.videosPerMonth} sessions=${e.sessionsPerMonth} hours=${e.sessionHours}`);
  }

  const months = await prisma.contentMonth.findMany({ select: { id: true, enrollmentId: true, monthKey: true, historical: true, status: true } });
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { not: null } },
    select: { id: true, clientId: true, contentMonthId: true, shootDate: true, status: true, addressLine: true },
  });
  const appts = await prisma.appointment.findMany({
    where: { projectId: { in: projects.map((p) => p.id) } },
    select: { id: true, aryeoId: true, projectId: true, startAt: true, endAt: true, status: true },
    orderBy: { startAt: "asc" },
  });
  const apptsByProject = new Map<string, typeof appts>();
  for (const a of appts) { const l = apptsByProject.get(a.projectId) ?? []; l.push(a); apptsByProject.set(a.projectId, l); }

  console.log(`\n2. CONTENT-MONTH PROJECTS: ${projects.length}, APPOINTMENTS ON THEM: ${appts.length}`);
  const multi = projects.filter((p) => (apptsByProject.get(p.id) ?? []).filter((a) => a.status !== "CANCELED").length > 1);
  console.log(`   projects carrying MORE THAN ONE live appointment: ${multi.length}`);
  for (const p of multi) {
    const list = (apptsByProject.get(p.id) ?? []).filter((a) => a.status !== "CANCELED");
    const m = months.find((x) => x.id === p.contentMonthId);
    console.log(`     project ${p.id} month ${m?.monthKey ?? "?"} shootDate=${p.shootDate?.toISOString() ?? "null"} legs=${list.length}`);
    for (const a of list) console.log(`        appt ${a.aryeoId} ${a.startAt?.toISOString() ?? "no start"} -> ${a.endAt?.toISOString() ?? "no end"} ${a.status ?? "?"}`);
  }
  const noAppt = projects.filter((p) => (apptsByProject.get(p.id) ?? []).length === 0);
  console.log(`   content-month projects with NO appointment row at all: ${noAppt.length} (${noAppt.filter((p) => p.shootDate).length} of them carry a shootDate)`);
  const apptNoStart = appts.filter((a) => a.status !== "CANCELED" && !a.startAt);
  console.log(`   live appointments with NO startAt: ${apptNoStart.length}`);

  console.log(`\n3. PER MONTH: projects-with-a-shoot-date vs live appointments`);
  let disagree = 0;
  for (const m of months) {
    const ps = projects.filter((p) => p.contentMonthId === m.id && p.status !== "CANCELLED");
    if (ps.length === 0) continue;
    const byProject = ps.filter((p) => p.shootDate).length;
    const byAppt = ps.reduce((n, p) => {
      const live = (apptsByProject.get(p.id) ?? []).filter((a) => a.status !== "CANCELED" && a.startAt);
      return n + (live.length > 0 ? live.length : p.shootDate ? 1 : 0);
    }, 0);
    if (byProject !== byAppt) { disagree++; console.log(`   ${m.monthKey} month ${m.id}: projects=${byProject} appointments=${byAppt}`); }
  }
  console.log(`   months where the two counts DISAGREE: ${disagree}`);

  console.log(`\n4. SESSION REQUESTS`);
  const reqs = await prisma.programSessionRequest.findMany({ select: { id: true, monthId: true, status: true, projectId: true, aryeoAppointmentId: true, slotStart: true, dedupeKey: true } });
  console.log(`   rows: ${reqs.length}`);
  const byStatus = new Map<string, number>();
  for (const r of reqs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log(`   by status: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  const seen = new Map<string, string[]>();
  for (const r of reqs.filter((x) => x.status === "CONFIRMED")) {
    const key = r.aryeoAppointmentId ? `appt:${r.aryeoAppointmentId}` : r.projectId ? `project:${r.projectId}` : `request:${r.id}`;
    const l = seen.get(key) ?? []; l.push(r.id); seen.set(key, l);
  }
  const dupes = [...seen].filter(([, ids]) => ids.length > 1);
  console.log(`   CONFIRMED requests sharing ONE appointment/project: ${dupes.length}${dupes.length ? ` — ${dupes.map(([k, ids]) => `${k} x${ids.length}`).join(", ")}` : ""}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
