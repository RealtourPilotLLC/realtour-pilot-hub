import { APPLY, db } from "./_oct22-guard";

// ---------------------------------------------------------------------------
// Jordan, Oct 27 2026 (Loom 27:33, a client's Settings tab, "What they're
// owed"): "signed ... August, 2026, no, they signed, she did not sign in
// August, she signed much before that."
//
// Why it said August: with no signed start on file (termStartMonth null), the
// card used the client's first LIVE ContentMonth. Months from before the hub
// ran the program were imported as historical, so every long-standing client
// "started" the month the hub took over. The code fix (entitlements.ts →
// earliestMonthKey) now uses the earliest evidence instead: the first month on
// record including imported history, or the enrollment's startedAt.
//
// This script checks the STORED data:
//   dry run (default): every ACTIVE or PAUSED program, with the start the card
//     showed, the start it shows now, and the evidence (first month on record,
//     startedAt, the client's first job of any kind). A row is FLAGGED when a
//     stored termStartMonth is LATER than the earliest evidence: that one is
//     wrong data, and the code fix cannot override it.
//   --apply --only=<enrollmentId>[,<enrollmentId>] [--start=YYYY-MM]: for the
//     named, flagged programs only, sets termStartMonth to --start (or else the
//     earliest evidence), ledgered as a ProgramEnrollmentChange the way the
//     Settings tab's "Save term" records it. The real signing month is a fact
//     Jordan knows and the data only suggests, so nothing is written without
//     naming the program.
// Nothing is sent to anybody.
// ---------------------------------------------------------------------------

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ONLY = new Set((arg("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const START = arg("start");
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const etMonth = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
const earliest = (keys: (string | null | undefined)[]) => keys.filter((k): k is string => !!k && MONTH.test(k)).sort()[0] ?? null;

async function main() {
  if (START && !MONTH.test(START)) throw new Error("--start is written like 2025-11.");
  if (APPLY && ONLY.size === 0) throw new Error("--apply needs --only=<enrollmentId>: the signing month is Jordan's to confirm, per program.");
  if (START && ONLY.size !== 1) throw new Error("--start applies to exactly one program (--only=<one id>).");
  const prisma = await db();

  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, clientId: true, status: true, termStartMonth: true, termEndMonth: true, billingMonths: true, startedAt: true },
  });
  const ids = enrollments.map((e) => e.id);
  const clientIds = enrollments.map((e) => e.clientId);
  const [clients, liveFirst, anyFirst, firstJobs] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    prisma.contentMonth.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: ids }, historical: false }, _min: { monthKey: true } }),
    prisma.contentMonth.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: ids } }, _min: { monthKey: true } }),
    prisma.project.groupBy({ by: ["clientId"], where: { clientId: { in: clientIds }, shootDate: { not: null } }, _min: { shootDate: true } }),
  ]);

  let flagged = 0, changed = 0;
  for (const e of enrollments) {
    const name = clients.find((c) => c.id === e.clientId)?.name ?? e.clientId;
    const firstLive = liveFirst.find((r) => r.enrollmentId === e.id)?._min.monthKey ?? null;
    const firstOnRecord = anyFirst.find((r) => r.enrollmentId === e.id)?._min.monthKey ?? null;
    const startedKey = e.startedAt ? etMonth(e.startedAt) : null;
    const firstJob = firstJobs.find((r) => r.clientId === e.clientId)?._min.shootDate ?? null;
    const evidence = earliest([firstLive, firstOnRecord, startedKey]);
    const showedBefore = e.termStartMonth ?? firstLive;
    const showsNow = e.termStartMonth ?? evidence;
    const wrongStored = !!(e.termStartMonth && evidence && e.termStartMonth > evidence);
    if (wrongStored) flagged++;
    const moved = showedBefore !== showsNow;
    if (!wrongStored && !moved && !ONLY.has(e.id)) continue;

    console.log(`${wrongStored ? "FLAGGED " : ""}${name} · ${e.id} · ${e.status}`);
    console.log(`  stored start ${e.termStartMonth ?? "(none)"} · end ${e.termEndMonth ?? "(none)"} · billing months ${e.billingMonths ?? "(none)"}`);
    console.log(`  the card showed ${showedBefore ?? "(no start)"} · now shows ${showsNow ?? "(no start)"}`);
    console.log(`  evidence: first live month ${firstLive ?? "-"} · first month on record ${firstOnRecord ?? "-"} · startedAt ${startedKey ?? "-"} · first job of any kind ${firstJob ? etMonth(firstJob) : "-"}`);

    if (!ONLY.has(e.id)) continue;
    if (!wrongStored && !START) { console.log("  named, but the stored start is not later than the evidence: nothing to write"); continue; }
    const to = START ?? evidence;
    if (!to || to === e.termStartMonth) { console.log("  nothing to write"); continue; }
    if (e.termEndMonth && e.termEndMonth < to) { console.log(`  refused: the stored end ${e.termEndMonth} is before ${to}`); continue; }
    if (APPLY) {
      const now = new Date();
      await prisma.contentEnrollment.update({ where: { id: e.id }, data: { termStartMonth: to } });
      await prisma.programEnrollmentChange.create({
        data: {
          enrollmentId: e.id, clientId: e.clientId, field: "termStartMonth",
          fromValue: JSON.stringify(e.termStartMonth), toValue: JSON.stringify(to),
          effectiveAt: now, effectiveMonthKey: etMonth(now), reason: "Agreement term start corrected Oct 27 2026 on Jordan's word: the client signed before the hub's first live month.",
          source: "manual", billingTruth: false, changedBy: "oct27-loom-signed-date", appliedAt: now,
        },
      });
      changed++;
      console.log(`  start set to ${to} (ledgered)`);
    } else console.log(`  would set the start to ${to}`);
  }
  console.log(`\n${enrollments.length} live or paused programs · ${flagged} with a stored start later than the evidence · ${APPLY ? `${changed} changed` : "dry run, nothing written"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
