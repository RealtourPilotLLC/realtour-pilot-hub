import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { baseSessions, catchUpFrom, catchUpInto, catchUpMonthName, withCatchUp, type CatchUpRecord } from "@/lib/catchUp";
import { monthSessionCount, recalcProgramMonth, type ProgramDb } from "@/lib/programMonths";

// ---------------------------------------------------------------------------
// CATCH UP A MISSED MONTH (Oct 7 2026) — the staff writer. The reading lives
// in catchUp.ts; this file decides who may, and writes.
//
// Jordan: "For John, he missed a month so we are catching up and going to do
// two sessions for him this month. We need an option on the platform for that."
//
// APPLY (owner/admin, on the client file's Overview of the catching-up month):
//   · the catching-up month (this or a later ET month, OPEN, live) owes ONE
//     extra filming session and the missed month's videos — videosOwed goes up
//     by the missed month's count; the session is the overrides record;
//   · the missed month (an EARLIER OPEN, live month with nothing filmed,
//     booked or planned on it) is CLOSED with status SKIPPED and the record
//     says it was caught up, by whom and when — so every "nothing owed here"
//     reader (overview, reminders, roster) already stops chasing it, and the
//     screens say "caught up in October" rather than "skipped";
//   · its open reminder escalations for Kyle are closed (the evaluator itself
//     stops at a non-OPEN month).
// UNDO puts both months back exactly — the catching-up month's count minus
// what the catch-up added, the missed month's status as it was — while
// nothing beyond the package's own sessions has been booked or asked for on
// the catching-up month. Otherwise it is refused with the reason.
//
// Nothing here messages a client, books, cancels, or talks to Aryeo/Calendly.
// ---------------------------------------------------------------------------

/** `forfeited` (Oct 8 2026): the month ended with nothing done on it (forfeit.ts) — the usual reason one is picked. */
export type CatchUpOption = { monthId: string; monthKey: string; label: string; videosOwed: number; refusal: string | null; forfeited: boolean };
export type CatchUpPanel = {
  monthId: string;
  monthKey: string;
  /** This month already carries a catch-up. */
  carrying: (CatchUpRecord & { missedLabel: string; undoRefusal: string | null }) | null;
  /** This month was closed by a later month's catch-up. */
  caughtUpIn: (CatchUpRecord & { targetLabel: string }) | null;
  /** Why this month cannot take a catch-up (null = it can). */
  refusal: string | null;
  /** Earlier months, each with its reason when it can't be picked. */
  options: CatchUpOption[];
  sessionsNow: number;
  videosNow: number;
};

const LIVE_MONTHLY_CALL = { callType: "MONTHLY_STRATEGY", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF", "AMBIGUOUS_CLIENT"] }, status: { notIn: ["CANCELLED", "RESCHEDULED"] } };
const LIVE_REQUEST = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
const FILMED_TOPIC = ["FILMED", "EDITING", "DELIVERED"];
const name = (key: string, rel?: string | null) => catchUpMonthName(key, rel);
const day = (d: Date | null) => d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

type Db = Pick<typeof prisma, "programCallRecord" | "contentMonth" | "project" | "programSessionRequest" | "contentVideo" | "contentTopic" | "contentTopicSelection" | "contentScript" | "contentInterview">;

/** Why an earlier month can't be caught up (null = it can). Plain words for the office. */
async function missedMonthRefusal(db: Db, m: { id: string; monthKey: string; status: string; historical: boolean }, targetKey: string, overridesJson: string | null): Promise<string | null> {
  const n = name(m.monthKey, targetKey);
  if (m.monthKey >= targetKey) return `${n} is not before ${name(targetKey)}.`;
  if (m.historical) return `${n} is imported history.`;
  if (m.status !== "OPEN") {
    const from = catchUpFrom(overridesJson, m.monthKey);
    return from ? `${n} is already caught up in ${name(from.targetMonthKey, m.monthKey)}.` : `${n} is already ${m.status === "SKIPPED" ? "marked skipped" : m.status.toLowerCase()}.`;
  }
  if (catchUpInto(overridesJson, m.monthKey)) return `${n} already carries a catch-up of its own.`;
  const [shoots, requests, videos, filmed, selections, scripts, interviews] = await Promise.all([
    db.project.findMany({ where: { contentMonthId: m.id, status: { not: "CANCELLED" } }, select: { shootDate: true }, orderBy: { shootDate: "asc" } }),
    db.programSessionRequest.count({ where: { monthId: m.id, status: { in: LIVE_REQUEST } } }),
    db.contentVideo.count({ where: { monthId: m.id } }),
    db.contentTopic.count({ where: { monthId: m.id, status: { in: FILMED_TOPIC } } }),
    db.contentTopicSelection.count({ where: { monthId: m.id, status: { in: LIVE_SELECTION } } }),
    db.contentScript.count({ where: { monthId: m.id } }),
    db.contentInterview.count({ where: { monthId: m.id } }),
  ]);
  if (shoots.length) {
    const when = day(shoots[0].shootDate);
    return `${n} has a shoot linked to it${when ? ` (${when})` : ""}. If that shoot belongs to another month, move it there first (Production › Sessions).`;
  }
  if (requests) return `${n} has a filming session booked or asked for.`;
  if (videos || filmed) return `${n} already has videos.`;
  if (selections || scripts || interviews) return `${n} already has topics, answers or scripts planned. Move them to ${name(targetKey)} first, then catch it up.`;
  return null;
}

async function targetRefusal(t: { monthKey: string; status: string; historical: boolean }, enrollment: { status: string; overridesJson: string | null }, now: Date): Promise<string | null> {
  const n = name(t.monthKey);
  if (enrollment.status !== "ACTIVE") return `The program is ${enrollment.status.toLowerCase()} — reactivate it first.`;
  if (t.historical) return `${n} is imported history.`;
  if (t.status !== "OPEN") return `${n} is ${t.status === "SKIPPED" ? "closed" : t.status.toLowerCase()}, so it can't carry a catch-up.`;
  if (t.monthKey < etMonthKey(now)) return `${n} is over — catch up in this month or a later one.`;
  const into = catchUpInto(enrollment.overridesJson, t.monthKey);
  if (into) return `${n} already includes the ${name(into.missedMonthKey, t.monthKey)} catch-up. Undo it first to catch up a different month.`;
  return null;
}

/**
 * Undo is honest only while nothing beyond the package's own sessions is on
 * the catching-up month: no session booked, filmed or asked for past the
 * package's count, and no request filed for the extra session's index.
 */
export async function undoRefusal(monthId: string, opts: { now?: Date; db?: ProgramDb } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const m = await db.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, clientId: true, enrollmentId: true, monthKey: true, status: true, videosOwed: true } });
  if (!m) return "That month is no longer on file.";
  const e = await db.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { sessionsPerMonth: true, overridesJson: true } });
  const rec = e ? catchUpInto(e.overridesJson, m.monthKey) : null;
  if (!e || !rec) return `${name(m.monthKey)} doesn't carry a catch-up.`;
  const base = baseSessions(e.sessionsPerMonth);
  const [count, requests, missed] = await Promise.all([
    monthSessionCount(m.id, m.clientId, now, db),
    db.programSessionRequest.findMany({ where: { monthId: m.id, status: { in: LIVE_REQUEST }, bookingState: { not: "CONFLICT" } }, select: { id: true, status: true, sessionIndex: true, projectId: true, aryeoAppointmentId: true, supersedesId: true } }),
    db.contentMonth.findFirst({ where: { enrollmentId: m.enrollmentId, monthKey: rec.missedMonthKey }, select: { id: true, status: true } }),
  ]);
  const counted = new Set(count.sessions.map((s) => s.key));
  const moving = new Set(requests.filter((r) => r.supersedesId).map((r) => r.supersedesId));
  const pending = requests.filter((r) => r.status !== "CONFIRMED" && !moving.has(r.id) && !r.supersedesId &&
    !(r.aryeoAppointmentId && counted.has(`appt:${r.aryeoAppointmentId}`)) && !(r.projectId && counted.has(`project:${r.projectId}`)));
  const holding = count.accountedFor + pending.length;
  if (holding > base || requests.some((r) => (r.sessionIndex ?? 0) > base)) {
    return `${name(m.monthKey)} already has ${holding} filming session${holding === 1 ? "" : "s"} booked or asked for — more than the package's ${base}. Cancel the extra session first, then undo.`;
  }
  if (m.status !== "OPEN") return `${name(m.monthKey)} is no longer open.`;
  // A strategy call filed on the month AFTER the catch-up plans the caught-up
  // batch. Without the catch-up the month would re-read its dates from that
  // newer call, so it goes first (Strategy calls page → Unassign).
  if (rec.before.callIds) {
    const later = await db.programCallRecord.findMany({ where: { monthId: m.id, ...LIVE_MONTHLY_CALL, id: { notIn: rec.before.callIds } }, select: { scheduledStart: true }, orderBy: { scheduledStart: "asc" } });
    if (later.length) return `${name(m.monthKey)} has a second strategy call filed for the catch-up${later[0].scheduledStart ? ` (${day(later[0].scheduledStart)})` : ""}. Unassign it on the Strategy calls page first, then undo.`;
  }
  if (m.videosOwed < rec.extraVideos) return `${name(m.monthKey)} owes ${m.videosOwed} videos now, fewer than the ${rec.extraVideos} the catch-up added — set its count by hand instead.`;
  if (!missed) return `${name(rec.missedMonthKey, m.monthKey)} is no longer on file.`;
  if (missed.status !== "SKIPPED") return `${name(rec.missedMonthKey, m.monthKey)} was reopened since — set the months by hand instead.`;
  return null;
}

/** Everything the Overview's catch-up control needs for one month. */
export async function catchUpPanel(monthId: string, opts: { now?: Date } = {}): Promise<CatchUpPanel | null> {
  const now = opts.now ?? new Date();
  const t = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true, videosOwed: true } });
  if (!t) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: t.enrollmentId }, select: { status: true, sessionsPerMonth: true, overridesJson: true } });
  if (!e) return null;
  const into = catchUpInto(e.overridesJson, t.monthKey);
  const from = t.status === "SKIPPED" ? catchUpFrom(e.overridesJson, t.monthKey) : null;
  const refusal = await targetRefusal(t, e, now);
  const earlier = into || refusal ? [] : await prisma.contentMonth.findMany({
    where: { enrollmentId: t.enrollmentId, monthKey: { lt: t.monthKey }, historical: false },
    orderBy: { monthKey: "desc" }, take: 12,
    select: { id: true, monthKey: true, status: true, historical: true, videosOwed: true, strategyCallStatus: true },
  });
  const forfeited = earlier.length ? await import("@/lib/monthForfeit").then((f) => f.forfeitedMonths(earlier, { now })).catch(() => new Set<string>()) : new Set<string>();
  const options: CatchUpOption[] = [];
  for (const m of earlier) {
    // Months long closed are history, not candidates: list OPEN ones and say why each can't be used.
    if (m.status !== "OPEN") continue;
    options.push({ monthId: m.id, monthKey: m.monthKey, label: name(m.monthKey, t.monthKey), videosOwed: m.videosOwed, refusal: await missedMonthRefusal(prisma, m, t.monthKey, e.overridesJson), forfeited: forfeited.has(m.id) });
  }
  return {
    monthId: t.id, monthKey: t.monthKey,
    carrying: into ? { ...into, missedLabel: name(into.missedMonthKey, t.monthKey), undoRefusal: await undoRefusal(t.id, { now }) } : null,
    caughtUpIn: from ? { ...from, targetLabel: name(from.targetMonthKey, t.monthKey) } : null,
    refusal, options,
    sessionsNow: baseSessions(e.sessionsPerMonth) + (into?.extraSessions ?? 0),
    videosNow: t.videosOwed,
  };
}

const sameMonthRef = (r: CatchUpRecord) => `${r.missedMonthKey} → ${r.targetMonthKey} (+${r.extraSessions} session, +${r.extraVideos} videos)`;

/** Catch `missedMonthId` up in `targetMonthId`. Throws a plain sentence when it can't. */
export async function applyCatchUp(targetMonthId: string, missedMonthId: string, by: string | null, opts: { now?: Date } = {}): Promise<{ record: CatchUpRecord; message: string }> {
  const now = opts.now ?? new Date();
  const record = await prisma.$transaction(async (tx) => {
    const t = await tx.contentMonth.findUnique({ where: { id: targetMonthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, status: true, historical: true, videosOwed: true } });
    if (!t) throw new Error("That month is no longer on file.");
    const m = await tx.contentMonth.findUnique({ where: { id: missedMonthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true, videosOwed: true } });
    if (!m || m.enrollmentId !== t.enrollmentId) throw new Error("Pick an earlier month of this client's program.");
    const e = await tx.contentEnrollment.findUnique({ where: { id: t.enrollmentId }, select: { id: true, clientId: true, status: true, overridesJson: true } });
    if (!e) throw new Error("Enrollment not found.");
    const tr = await targetRefusal(t, e, now);
    if (tr) throw new Error(tr);
    const mr = await missedMonthRefusal(tx, m, t.monthKey, e.overridesJson);
    if (mr) throw new Error(mr);
    const calls = await tx.programCallRecord.findMany({ where: { monthId: t.id, ...LIVE_MONTHLY_CALL }, select: { id: true } });
    const rec: CatchUpRecord = {
      targetMonthKey: t.monthKey, targetMonthId: t.id, missedMonthKey: m.monthKey, missedMonthId: m.id,
      extraSessions: 1, extraVideos: Math.max(0, m.videosOwed), by, at: now.toISOString(),
      before: { targetVideosOwed: t.videosOwed, missedStatus: m.status, callIds: calls.map((x) => x.id) },
    };
    // Compare-and-set on all three rows: a second click, or a change made in
    // another tab meanwhile, writes nothing.
    const bag = await tx.contentEnrollment.updateMany({ where: { id: e.id, overridesJson: e.overridesJson }, data: { overridesJson: withCatchUp(e.overridesJson, t.monthKey, rec) } });
    const tw = await tx.contentMonth.updateMany({ where: { id: t.id, status: "OPEN", videosOwed: t.videosOwed }, data: { videosOwed: t.videosOwed + rec.extraVideos } });
    const mw = await tx.contentMonth.updateMany({ where: { id: m.id, status: "OPEN" }, data: { status: "SKIPPED" } });
    if (bag.count !== 1 || tw.count !== 1 || mw.count !== 1) throw new Error("These months changed while you were working. Reload and try again.");
    await tx.programEnrollmentChange.create({
      data: {
        enrollmentId: e.id, clientId: e.clientId, field: "overrides",
        fromValue: JSON.stringify({ catchUp: null }), toValue: JSON.stringify({ catchUp: sameMonthRef(rec) }),
        effectiveAt: now, effectiveMonthKey: t.monthKey, reason: `Catch up ${name(m.monthKey, t.monthKey)} in ${name(t.monthKey)}: one extra filming session and ${rec.extraVideos} more videos; ${name(m.monthKey, t.monthKey)} closed as caught up.`,
        source: "manual", billingTruth: false, changedBy: by, appliedAt: now,
      },
    });
    return rec;
  });
  // The missed month's chasing for Kyle stops with it (the evaluator already skips a non-OPEN month).
  await prisma.smartTask.updateMany({
    where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, dedupeKey: { startsWith: `program-reminder-escalation:${record.missedMonthId}:` } },
    data: { status: "COMPLETED", completedAt: now },
  }).catch(() => null);
  await recalcProgramMonth(record.targetMonthId, { now }).catch(() => null);
  const t = name(record.targetMonthKey), mm = name(record.missedMonthKey, record.targetMonthKey);
  return { record, message: `${t} now includes the ${mm} catch-up: one more filming session and ${record.extraVideos} more videos. ${mm} is closed as caught up in ${t}.` };
}

/** Put both months back exactly as they were. Throws the plain reason when it can't. */
export async function undoCatchUp(targetMonthId: string, by: string | null, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  const refusal = await undoRefusal(targetMonthId, { now });
  if (refusal) throw new Error(refusal);
  const rec = await prisma.$transaction(async (tx) => {
    const t = await tx.contentMonth.findUnique({ where: { id: targetMonthId }, select: { id: true, enrollmentId: true, monthKey: true, videosOwed: true } });
    if (!t) throw new Error("That month is no longer on file.");
    // The same per-month lock a session request takes (sessionRequests.monthLockKey):
    // a booking racing this undo is decided one after the other, never both.
    const { monthLockKey } = await import("@/lib/sessionRequests");
    const [a, b] = monthLockKey(t.enrollmentId, t.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
    // Re-read INSIDE the lock: a session asked for a moment ago refuses the undo.
    const again = await undoRefusal(t.id, { now, db: tx });
    if (again) throw new Error(again);
    const e = await tx.contentEnrollment.findUnique({ where: { id: t.enrollmentId }, select: { id: true, clientId: true, overridesJson: true } });
    const r = e ? catchUpInto(e.overridesJson, t.monthKey) : null;
    if (!e || !r) throw new Error(`${name(t.monthKey)} doesn't carry a catch-up.`);
    const missed = await tx.contentMonth.findFirst({ where: { enrollmentId: t.enrollmentId, monthKey: r.missedMonthKey }, select: { id: true } });
    const bag = await tx.contentEnrollment.updateMany({ where: { id: e.id, overridesJson: e.overridesJson }, data: { overridesJson: withCatchUp(e.overridesJson, t.monthKey, null) } });
    const tw = await tx.contentMonth.updateMany({ where: { id: t.id, status: "OPEN", videosOwed: t.videosOwed }, data: { videosOwed: t.videosOwed - r.extraVideos } });
    const mw = missed ? await tx.contentMonth.updateMany({ where: { id: missed.id, status: "SKIPPED" }, data: { status: r.before.missedStatus || "OPEN" } }) : { count: 0 };
    if (bag.count !== 1 || tw.count !== 1 || mw.count !== 1) throw new Error("These months changed while you were working. Reload and try again.");
    await tx.programEnrollmentChange.create({
      data: {
        enrollmentId: e.id, clientId: e.clientId, field: "overrides",
        fromValue: JSON.stringify({ catchUp: sameMonthRef(r) }), toValue: JSON.stringify({ catchUp: null }),
        effectiveAt: now, effectiveMonthKey: t.monthKey, reason: `Undid the ${name(r.missedMonthKey, t.monthKey)} catch-up in ${name(t.monthKey)}; both months are back as they were.`,
        source: "manual", billingTruth: false, changedBy: by, appliedAt: now,
      },
    });
    return { ...r, missedId: missed!.id };
  });
  await recalcProgramMonth(rec.targetMonthId || targetMonthId, { now }).catch(() => null);
  await recalcProgramMonth(rec.missedId, { now }).catch(() => null);
  const t = name(rec.targetMonthKey), mm = name(rec.missedMonthKey, rec.targetMonthKey);
  return { message: `Undone. ${t} is back to its own sessions and videos, and ${mm} is open again.` };
}
