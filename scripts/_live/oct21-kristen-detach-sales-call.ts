// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 21 2026): Kristen Pavillard's Oct 14 SALES call is not her
// October strategy call.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_live/oct21-kristen-detach-sales-call.ts [--apply]
//
// She booked the program's strategy-call Calendly link on Oct 14 as the
// pre-sale call (with Bruce), signed up Oct 18, and the sync filed that call
// on her first program month: strategyCallStatus COMPLETED, planningMode CALL,
// preparationStatus PREPARING_SCRIPTS. So the reminder engine read October as
// planned and lined up "book your filming session". Her brand discovery call
// is Oct 29; no strategy exists yet.
//
// This takes her MONTHLY_STRATEGY call records (the Oct 14 call and the Oct 8
// booking it was rescheduled from) off her months, marks them the way the
// Calendly intake now marks a pre-program call (matchState AMBIGUOUS_MONTH,
// with the reason; the hourly sync keeps them there, see strategyCallHold),
// releases the month stamp the call took, and recomputes the month from what
// is left. The month's prioritiesJson and notes from that call are kept.
//
// DRY RUN by default: reads only. --apply writes.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { recalcProgramMonth } from "@/lib/programMonths";

const ENROLLMENT = "cmve60q460003jn0702c8rfgd";
const MONTH = "cmve60q630004jn07tdxslbgc";
const SALES_CALL = "cmuzo14je00gtjv0484s2b6pf";
const apply = process.argv.includes("--apply");
const NOTE = "booked for Oct 14, before the program started (Oct 18): a sales call, not this month's strategy call (detached by hand Oct 21)";

const monthSelect = { id: true, monthKey: true, callRecordId: true, strategyCallStatus: true, strategyCallAt: true, planningMode: true, preparationStatus: true, transcriptText: true, prioritiesJson: true, notes: true } as const;
const show = (m: { monthKey: string; callRecordId: string | null; strategyCallStatus: string; strategyCallAt: Date | null; planningMode: string | null; preparationStatus: string | null; prioritiesJson: string | null; notes: string | null } | null) =>
  m ? JSON.stringify({ month: m.monthKey, callRecordId: m.callRecordId, strategyCallStatus: m.strategyCallStatus, strategyCallAt: m.strategyCallAt?.toISOString() ?? null, planningMode: m.planningMode, preparationStatus: m.preparationStatus, priorities: !!m.prioritiesJson, notes: !!m.notes }) : "(missing)";

(async () => {
  console.log(apply ? "APPLY: writing to the LIVE database" : "DRY RUN: nothing is written");
  const records = await prisma.programCallRecord.findMany({
    where: { enrollmentId: ENROLLMENT, callType: "MONTHLY_STRATEGY" },
    select: { id: true, scheduledStart: true, status: true, matchState: true, monthId: true, matchNote: true, rawJson: true },
  });
  if (!records.some((r) => r.id === SALES_CALL)) throw new Error("The Oct 14 call record is not on her enrollment any more; nothing done.");
  const monthIds = [...new Set([MONTH, ...records.map((r) => r.monthId).filter((x): x is string => !!x)])];
  const before = await prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: monthSelect });
  console.log("records before:");
  for (const r of records) console.log("  ", r.id, r.scheduledStart?.toISOString(), r.status, r.matchState, r.monthId ?? "-", "|", r.matchNote ?? "");
  console.log("months before:");
  for (const m of before) console.log("  ", show(m));

  for (const r of records) {
    const plan = `${r.id}: matchState ${r.matchState} → AMBIGUOUS_MONTH, monthId ${r.monthId ?? "-"} → null`;
    if (!apply) { console.log("would set", plan); continue; }
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(r.rawJson ?? "{}") as Record<string, unknown>; } catch { raw = {}; }
    await prisma.programCallRecord.update({ where: { id: r.id }, data: { matchState: "AMBIGUOUS_MONTH", monthId: null, matchNote: NOTE, rawJson: JSON.stringify({ ...raw, identity: { note: NOTE, candidates: [] } }) } });
    if (r.monthId) {
      await prisma.contentMonth.updateMany({ where: { id: r.monthId, callRecordId: r.id }, data: { callRecordId: null } });
      // releaseMonthStamp (contentCallRecords): the stamp this call put on the month, when no transcript was pasted.
      if (r.scheduledStart) {
        await prisma.contentMonth.updateMany({
          where: { id: r.monthId, strategyCallAt: r.scheduledStart, strategyCallStatus: { in: ["SCHEDULED", "COMPLETED"] }, OR: [{ transcriptText: null }, { transcriptText: "" }] },
          data: { strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null },
        });
      }
    }
    console.log("set", plan);
  }
  for (const id of monthIds) {
    const r = await recalcProgramMonth(id, { dryRun: !apply });
    if (!apply) console.log("recalc (dry, before detaching, so it shows today's derivation):", id, JSON.stringify(r?.after ? { strategyCallStatus: r.after.strategyCallStatus, planningMode: r.after.planningMode, preparationStatus: r.after.preparationStatus } : null));
  }
  if (apply) {
    const after = await prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: monthSelect });
    console.log("months after:");
    for (const m of after) console.log("  ", show(m));
  }
  await prisma.$disconnect();
})();
