import "server-only";
import { prisma } from "@/lib/prisma";
import { forfeitCandidate, isForfeited, NO_EVIDENCE, type ForfeitEvidence } from "@/lib/forfeit";

// ---------------------------------------------------------------------------
// FORFEITED MONTHS (Oct 8 2026) — the server half: load the evidence, ask
// forfeit.isForfeited. See forfeit.ts for the rule and why it is derived.
//
// FIXED COST. The evidence is eight grouped reads whatever the number of
// months (a roster, or one month), so monthProgress keeps its batched shape.
// Only months that COULD be forfeited (OPEN, live, ET month over) are asked
// about. With none, the reads are skipped — except for a caller that asks for
// `fixedCost` (monthProgress), where they run on a sentinel id so its
// statement count never depends on the calendar.
// ---------------------------------------------------------------------------

type Db = Pick<typeof prisma, "contentMonth" | "project" | "programSessionRequest" | "contentVideo" | "contentTopic" | "contentTopicSelection" | "contentScript" | "contentInterview" | "programCallRecord">;

const LIVE_REQUEST = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
const FILMED_TOPIC = ["FILMED", "EDITING", "DELIVERED"];

export type ForfeitMonthInput = { id: string; monthKey: string; status: string; historical: boolean; strategyCallStatus: string | null };

/** The evidence for each month id (only candidates are read; the rest read as none). */
export async function forfeitEvidence(monthIds: string[], db: Db = prisma): Promise<Map<string, ForfeitEvidence>> {
  const ids = monthIds.length ? monthIds : ["-"];
  const by = <T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + r._count._all); }
    return m;
  };
  const [shoots, requests, videos, filmed, selections, scripts, interviews, calls] = await Promise.all([
    db.project.groupBy({ by: ["contentMonthId"], where: { contentMonthId: { in: ids }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
    db.programSessionRequest.groupBy({ by: ["monthId"], where: { monthId: { in: ids }, status: { in: LIVE_REQUEST } }, _count: { _all: true } }),
    db.contentVideo.groupBy({ by: ["monthId"], where: { monthId: { in: ids } }, _count: { _all: true } }),
    db.contentTopic.groupBy({ by: ["monthId"], where: { monthId: { in: ids }, status: { in: FILMED_TOPIC } }, _count: { _all: true } }),
    db.contentTopicSelection.groupBy({ by: ["monthId"], where: { monthId: { in: ids }, status: { in: LIVE_SELECTION } }, _count: { _all: true } }),
    db.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: ids } }, _count: { _all: true } }),
    db.contentInterview.groupBy({ by: ["monthId"], where: { monthId: { in: ids } }, _count: { _all: true } }),
    db.programCallRecord.groupBy({ by: ["monthId"], where: { monthId: { in: ids }, callType: "MONTHLY_STRATEGY", status: { notIn: ["CANCELLED", "RESCHEDULED"] } }, _count: { _all: true } }),
  ]);
  const s = by(shoots, (r) => r.contentMonthId), q = by(requests, (r) => r.monthId), v = by(videos, (r) => r.monthId), f = by(filmed, (r) => r.monthId);
  const sel = by(selections, (r) => r.monthId), sc = by(scripts, (r) => r.monthId), iv = by(interviews, (r) => r.monthId), c = by(calls, (r) => r.monthId);
  const out = new Map<string, ForfeitEvidence>();
  for (const id of monthIds) {
    out.set(id, {
      shoots: s.get(id) ?? 0, sessionRequests: q.get(id) ?? 0, videos: v.get(id) ?? 0, filmedTopics: f.get(id) ?? 0,
      plannedWork: (sel.get(id) ?? 0) + (sc.get(id) ?? 0) + (iv.get(id) ?? 0), calls: c.get(id) ?? 0,
    });
  }
  return out;
}

/**
 * Which of these months are forfeited. Pass the rows when you already have
 * them (monthProgress, the overview); otherwise they are read.
 */
export async function forfeitedMonths(months: ForfeitMonthInput[] | string[], opts: { now?: Date; db?: Db; fixedCost?: boolean } = {}): Promise<Set<string>> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const rows: ForfeitMonthInput[] = months.length && typeof months[0] === "string"
    ? await db.contentMonth.findMany({ where: { id: { in: months as string[] } }, select: { id: true, monthKey: true, status: true, historical: true, strategyCallStatus: true } })
    : (months as ForfeitMonthInput[]);
  const candidates = rows.filter((m) => forfeitCandidate(m, now));
  if (!candidates.length && !opts.fixedCost) return new Set();
  const evidence = await forfeitEvidence(candidates.map((m) => m.id), db);
  const out = new Set<string>();
  for (const m of candidates) if (isForfeited(m, evidence.get(m.id) ?? NO_EVIDENCE, now)) out.add(m.id);
  return out;
}

/** One month. */
export async function isMonthForfeited(monthId: string, opts: { now?: Date; db?: Db } = {}): Promise<boolean> {
  return (await forfeitedMonths([monthId], opts)).has(monthId);
}

/**
 * A forfeited month's internal chasing stops with it: the reminder
 * escalation, the mid-month follow-up, and the call-end / call-buffer desk
 * tasks keyed on the month. Idempotent; never touches a client.
 */
export async function closeForfeitedMonthTasks(monthId: string, now: Date = new Date()): Promise<number> {
  const prefixes = [`program-reminder-escalation:${monthId}:`, `program-reminder-midmonth:${monthId}`, `program-call-end:${monthId}`, `program-call-buffer:${monthId}`];
  const r = await prisma.smartTask.updateMany({
    where: { status: { notIn: ["COMPLETED", "CANCELLED", "DONE", "CLOSED"] }, OR: prefixes.map((p) => ({ dedupeKey: { startsWith: p } })) },
    data: { status: "COMPLETED", completedAt: now },
  }).catch(() => ({ count: 0 }));
  return r.count;
}

/**
 * The month a staff "Approve a catch-up" link should open: the first OPEN,
 * live month of the program at or after this ET month (where a catch-up can
 * be carried). Null when none is on file yet.
 */
export async function catchUpTargetFor(enrollmentId: string, now: Date = new Date()): Promise<{ id: string; monthKey: string } | null> {
  const { etMonthKeyOf } = await import("@/lib/forfeit");
  return prisma.contentMonth.findFirst({
    where: { enrollmentId, historical: false, status: "OPEN", monthKey: { gte: etMonthKeyOf(now) } },
    orderBy: { monthKey: "asc" },
    select: { id: true, monthKey: true },
  });
}
