// Oct 8 2026 (Jordan): Janice Pigga and Joe Sutow paid in September FOR October
// (payments are a month ahead); Ashley Brunner is on a one-month trial whose
// month is filmed Oct 28. Their September months were never owed → closed as
// skipped on purpose (same write as content/actions.setMonthSkipped). Bernadette's
// September stays forfeited (derived). No client messages.
import { prisma } from "../../../src/lib/prisma";
const NAMES = ["Janice Pigga", "Joseph Sutow", "Ashley Brunner"];
(async () => {
  for (const n of NAMES) {
    const ids = (await prisma.client.findMany({ where: { name: n }, select: { id: true } })).map((x) => x.id);
    const e = await prisma.contentEnrollment.findFirst({ where: { clientId: { in: ids }, status: "ACTIVE" }, select: { id: true, overridesJson: true } });
    if (!e) { console.log(n, "no active enrollment"); continue; }
    const m = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: "2026-09" } }, select: { id: true, status: true } });
    if (!m) { console.log(n, "no September month"); continue; }
    const linked = await prisma.project.count({ where: { contentMonthId: m.id, status: { not: "CANCELLED" } } });
    if (linked) { console.log(n, "September has", linked, "linked job(s) — left alone"); continue; }
    if (m.status !== "OPEN") { console.log(n, "September already", m.status); continue; }
    await prisma.contentMonth.update({ where: { id: m.id }, data: { status: "SKIPPED" } });
    console.log(n, "September", m.id, "→ SKIPPED (nothing owed)");
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
