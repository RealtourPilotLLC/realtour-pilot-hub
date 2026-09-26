import "server-only";
import { prisma } from "@/lib/prisma";
import {
  earliestFilmingStart, preparationGate, recalcProgramMonth, sessionIndexesFrom,
  type DerivedMonthState, type GateAnchor,
} from "@/lib/programMonths";
import { closeProgramDeskTask, dutyAssignedKey, openProgramDeskTask, TASK_DONE_INCLUDING_LEGACY } from "@/lib/programDeskTasks";
import { isTestClientName } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// SESSION REASSESSMENT (A25, unified handoff §6.6, Sep 25 2026).
//
// "Call cancellation, movement, no-show, or material preparation changes must
// create a visible reassessment; never silently alter the customer's
// appointment." The preparation gate is checked ONCE, when a session is asked
// for — which is right (a rule change must never un-book anybody) — and never
// again, so a call moved from Monday to Wednesday left Thursday's shoot with
// one day of preparation and nobody was told. A cancelled call only released
// the month's pointer; a booked shoot was not looked at.
//
// So, after every persisted month derivation (a call record synced, a route
// chosen, answers sent, a session requested) and hourly, each FUTURE live
// session of the month is compared with the anchor it was booked against:
//
//   ANCHOR_MOVED  the gate's anchor (the call's scheduled end, or the session's
//                 submitted answers) is a DIFFERENT fact from the one on file,
//                 and the session now starts before that anchor + the window
//                 the session was booked under;
//   ANCHOR_LOST   the call it was planned around is CANCELLED, RESCHEDULED
//                 away or a NO_SHOW, and no live call replaces it;
//   CALL_BUFFER   the written route's call-buffer conflict (a strategy call
//                 booked inside the buffer before the session). Its desk task
//                 already exists (programMonths.syncCallBufferTask); this only
//                 records the reassessment and links that task — ONE task.
//
// "On file" is the request's gate snapshot (gateAnchorRef / gateWindowHours,
// written when the request was made). A session booked OUTSIDE the hub (Kyle in
// Aryeo, or before snapshots existed) has none, so the first pass that sees it
// records a BASELINE row with the anchor as it stood then, and later passes
// compare against that. A first sight is never a reassessment on its own: the
// person who booked it chose the time, and "the rule says 72 now" is not a
// change to the session (the one exception is a call already gone — that is a
// fact about today, not about the booking).
//
// WINDOWS ARE NEVER COMPARED, ANCHORS ARE. A session booked under the 48-hour
// rule is judged by 48 hours from a moved anchor, and never flagged by the
// 48 → 72 change alone.
//
// What it does: one ProgramSessionReassessment row per (session, anchor, kind)
// and one desk task for the SCHEDULING owner (default Kyle). What it never
// does: move, cancel or re-time anything, or message the client. The portal
// shows "Kyle will confirm your filming time"; the staff Sessions view shows a
// banner. It resolves itself (row RESOLVED, task closed) when the conflict
// goes away; a person closing the task ACKNOWLEDGES it (the session stays, the
// same conflict is not raised again). TEST clients: nothing at all unless
// PROGRAM_DESK_TASKS_FOR_TEST=1 (the house rule for owner work).
// ---------------------------------------------------------------------------

export type ReassessKind = "ANCHOR_MOVED" | "ANCHOR_LOST" | "CALL_BUFFER";
/** A session's first-seen anchor, for sessions with no request snapshot. Never OPEN, never a task. */
const BASELINE = "BASELINE";
const DEAD_CALL = ["CANCELLED", "RESCHEDULED", "NO_SHOW"];
const LIVE_MATCH = ["MATCHED", "CONFIRMED_BY_STAFF", "AMBIGUOUS_CLIENT"];
export const REASSESS_TASK_PREFIX = "program-reassess:";
const CALL_BUFFER_TASK_PREFIX = "program-call-buffer:";

const whenET = (d: Date) => `${d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
/** GateAnchor refs end in the anchor's epoch ms (`CALL_END:<id>:<ms>`, `SUBMISSION:<id>:<ms>`). */
const refMs = (ref: string | null | undefined): number | null => {
  const m = /:(\d{10,})$/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
};

type Want = { sessionKey: string; anchorRef: string; kind: ReassessKind; reason: string; startsAt: Date; linkedTaskKey?: string };

export type ReassessResult = { monthId: string; sessions: number; raised: number; resolved: number; acknowledged: number; baselines: number; skipped?: string };

/**
 * Compare every future live session of one month with its anchor, and raise,
 * keep or resolve reassessments. Idempotent: three passes over the same facts
 * make one row and one task. `derived` is the recalculation the caller just
 * persisted; without it the month is derived again as a DRY run (this must
 * never cause a persisted recalculation, which would call it again).
 */
export async function reassessMonthSessions(monthId: string, opts: { now?: Date; derived?: DerivedMonthState } = {}): Promise<ReassessResult> {
  const now = opts.now ?? new Date();
  const out: ReassessResult = { monthId, sessions: 0, raised: 0, resolved: 0, acknowledged: 0, baselines: 0 };
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, monthKey: true, enrollmentId: true, clientId: true, historical: true } });
  if (!month || month.historical) return { ...out, skipped: "no live month" };
  const client = await prisma.client.findUnique({ where: { id: month.clientId }, select: { name: true } });
  if (isTestClientName(client?.name) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1") return { ...out, skipped: "TEST client" };
  const derived = opts.derived ?? (await recalcProgramMonth(monthId, { now, dryRun: true }))?.after ?? null;
  if (!derived) return { ...out, skipped: "month could not be derived" };

  const { upcomingProgramSessions } = await import("@/lib/sessionAddress");
  const { monthBookedSessions } = await import("@/lib/monthProgress");
  const [live, count, requests, calls] = await Promise.all([
    upcomingProgramSessions(month.id, now),
    monthBookedSessions(month.id, month.clientId, now),
    prisma.programSessionRequest.findMany({
      where: { monthId: month.id },
      select: {
        id: true, status: true, bookingState: true, supersedesId: true, projectId: true, aryeoAppointmentId: true, slotStart: true, sessionIndex: true,
        gateRoute: true, gateAnchorRef: true, gateAnchorAt: true, gateWindowHours: true,
      },
    }),
    prisma.programCallRecord.findMany({
      where: { monthId: month.id, callType: "MONTHLY_STRATEGY", matchState: { in: LIVE_MATCH } },
      select: { id: true, status: true, scheduledStart: true, scheduledEnd: true, createdAt: true, rescheduledFromId: true },
    }),
  ]);
  out.sessions = live.length;
  const indexes = sessionIndexesFrom(count, requests, derived.sessionsRequired).byKey;
  const requestOf = new Map(requests.map((r) => [r.id, r]));
  // The month's gone calls, latest first: a session with no live call lost the
  // most recent one (a rebooked call that then no-showed is its own fact). A
  // call RESCHEDULED to another record on this month is not gone — its
  // replacement is the call (Calendly's reschedule is a new record pointing
  // back); one rescheduled to another month has no replacement here.
  const replaced = new Set(calls.map((c) => c.rescheduledFromId).filter((x): x is string => !!x));
  const deadCalls = calls
    .filter((c) => DEAD_CALL.includes(c.status) && !replaced.has(c.id))
    .sort((a, b) => (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime());
  const buffers = derived.followUps.filter((f) => f.kind === "CALL_INSIDE_BUFFER" && f.ref);
  // A STALE STAMP IS NOT AN ANCHOR. deriveMonthState keeps a stored SCHEDULED
  // status as "legacy truth" when no live record backs it, and the gate then
  // anchors on the month's stamped call time (CALL_END:legacy:…). When the
  // month's call RECORDS exist and every one of them is gone (cancelled, moved
  // away, no-show), that stamp is the dead call's own time, not a legacy call —
  // so for reassessment there is no anchor, and the session has lost its call.
  const staleLegacy = derived.strategyCallStatus === "SCHEDULED" && calls.length > 0 && calls.every((c) => DEAD_CALL.includes(c.status));

  const wants: Want[] = [];
  for (const s of live) {
    const g = preparationGate(derived, indexes.get(s.key) ?? null);
    const anchor = g.anchor && !(staleLegacy && g.anchor.ref.startsWith("CALL_END:legacy:")) ? g.anchor : null;
    const req = s.requestId ? requestOf.get(s.requestId) ?? null : null;
    // The anchor on file: the request's snapshot, else this session's baseline.
    let prior: { ref: string | null; at: Date | null; windowHours: number | null } | null = null;
    if (req && (req.gateRoute != null || req.gateWindowHours != null)) {
      prior = { ref: req.gateAnchorRef, at: req.gateAnchorAt, windowHours: req.gateWindowHours };
    } else {
      const base = await prisma.programSessionReassessment.findFirst({ where: { sessionKey: s.key, kind: BASELINE }, orderBy: { createdAt: "asc" }, select: { anchorRef: true } });
      if (base) prior = { ref: base.anchorRef === "NONE" ? null : base.anchorRef, at: null, windowHours: null };
      else {
        await recordBaseline(month, s.key, anchor, now);
        out.baselines++;
      }
    }

    // 1. The written route's call-buffer conflict — derived once, in programMonths.
    const buffer = buffers.find((f) => f.ref!.startsWith(`${s.startsAt.getTime()}-`));
    if (buffer) {
      wants.push({ sessionKey: s.key, anchorRef: `CALL_BUFFER:${buffer.ref}`, kind: "CALL_BUFFER", reason: buffer.reason, startsAt: s.startsAt, linkedTaskKey: `${CALL_BUFFER_TASK_PREFIX}${month.id}:${buffer.ref}` });
      continue;
    }

    // 2. The call it was planned around is gone, and nothing replaces it.
    if (!anchor) {
      // Lost when the session was booked against a call, or the month plans
      // by call (a first sight included: a call that is ALREADY gone is
      // today's fact, not the booking's). A written-route session whose
      // answers were reopened has no anchor either — that is not a lost call.
      const plannedByCall = derived.planningMode === "CALL" || !!prior?.ref?.startsWith("CALL_END:");
      const lost = plannedByCall ? deadCalls[0] ?? null : null;
      if (lost) {
        const what = lost.status === "NO_SHOW" ? "was marked a no-show" : lost.status === "RESCHEDULED" ? "was moved to a time outside this month" : "was cancelled";
        // Keyed on the call that is gone, so a cancel and a later no-show are two facts.
        const ref = `CALL_END:${lost.id}:${(lost.scheduledEnd ?? lost.scheduledStart ?? now).getTime()}`;
        wants.push({
          sessionKey: s.key, anchorRef: ref, kind: "ANCHOR_LOST", startsAt: s.startsAt,
          reason: `The strategy call this session was planned around${lost.scheduledStart ? ` (${whenET(lost.scheduledStart)})` : ""} ${what}, and no new call is booked for ${month.monthKey}. The ${whenET(s.startsAt)} filming session is still on the calendar.`,
        });
      } else if (plannedByCall && prior?.ref?.startsWith("CALL_END:") && !prior.ref.startsWith("CALL_END:legacy:")) {
        // The call it was booked against LEFT the month instead of dying on it
        // (batch-3 review, Sep 25 2026): staff marked it not this client's
        // (ignored) or moved it to another month. It is not among the month's
        // records any more, so nothing above sees it — yet the session lost
        // its call just the same.
        const recId = prior.ref.split(":")[1] ?? "";
        if (recId && !calls.some((cl) => cl.id === recId)) {
          const at = refMs(prior.ref);
          wants.push({
            sessionKey: s.key, anchorRef: prior.ref, kind: "ANCHOR_LOST", startsAt: s.startsAt,
            reason: `The strategy call this session was planned around${at ? ` (ending ${whenET(new Date(at))})` : ""} is no longer on file for ${month.monthKey} (it was marked as not this client's call, or moved to another month), and no other call is booked for ${month.monthKey}. The ${whenET(s.startsAt)} filming session is still on the calendar.`,
          });
        }
      }
      continue;
    }

    // 3. The anchor is a different fact from the one on file.
    if (!prior || prior.ref === anchor.ref) continue;
    // On the written route a CALL anchor means the call-buffer rule; that has
    // its own reading above, and a call AFTER the session cannot shorten the
    // preparation for it. Not a reassessment here.
    if (derived.planningMode === "WRITTEN" && anchor.kind === "CALL_END") continue;
    const windowHours = prior.windowHours ?? g.windowHours;
    const earliest = earliestFilmingStart(anchor.at, { windowHours, windowWaived: g.windowWaived });
    if (s.startsAt.getTime() >= earliest.getTime()) continue;
    wants.push({ sessionKey: s.key, anchorRef: anchor.ref, kind: "ANCHOR_MOVED", startsAt: s.startsAt, reason: movedReason(anchor, prior, windowHours, earliest, s.startsAt) });
  }

  // ---- write: raise what is wanted, resolve what is not ----
  const clientName = client?.name ?? "";
  const assignedKey = await dutyAssignedKey(month.enrollmentId, month.id, "SCHEDULING", "kyle");
  const wantKey = (w: { sessionKey: string; anchorRef: string; kind: string }) => `${w.sessionKey}|${w.anchorRef}|${w.kind}`;
  const wanted = new Set(wants.map(wantKey));
  for (const w of wants) {
    const r = await raise(month, clientName, assignedKey, w, now);
    if (r === "raised") out.raised++;
    if (r === "acknowledged") out.acknowledged++;
  }
  const open = await prisma.programSessionReassessment.findMany({ where: { monthId: month.id, state: "OPEN", kind: { not: BASELINE } } });
  for (const row of open) {
    if (wanted.has(wantKey(row))) continue;
    await prisma.programSessionReassessment.update({ where: { id: row.id }, data: { state: "RESOLVED", resolvedAt: now } });
    // The buffer task belongs to syncCallBufferTask, which closes its own.
    if (row.kind !== "CALL_BUFFER") await closeProgramDeskTask(`${REASSESS_TASK_PREFIX}${row.id}`);
    out.resolved++;
  }
  return out;
}

function movedReason(anchor: GateAnchor, prior: { ref: string | null; at: Date | null }, windowHours: number, earliest: Date, startsAt: Date): string {
  const priorMs = refMs(prior.ref) ?? prior.at?.getTime() ?? null;
  const was = priorMs ? ` (it was ${whenET(new Date(priorMs))})` : prior.ref ? "" : " (there was none when the session was booked)";
  const what = anchor.kind === "CALL_END" ? `The strategy call now ends ${whenET(anchor.at)}${was}` : `The answers for this session were sent again ${whenET(anchor.at)}${was}`;
  return `${what}, so the ${whenET(startsAt)} filming session is inside the ${windowHours} weekday hours of preparation. It would need to start ${whenET(earliest)} or later.`;
}

async function recordBaseline(month: { id: string; enrollmentId: string }, sessionKey: string, anchor: GateAnchor | null, now: Date): Promise<void> {
  await prisma.programSessionReassessment
    .create({
      data: {
        enrollmentId: month.enrollmentId, monthId: month.id, sessionKey, anchorRef: anchor?.ref ?? "NONE", kind: BASELINE,
        reason: `first seen ${now.toISOString()} with no gate snapshot: ${anchor ? `anchored to ${anchor.label}` : "no anchor yet"}`,
        state: "RESOLVED", resolvedAt: now,
      },
    })
    .catch(() => { /* a concurrent pass recorded it first — the oldest row wins */ });
}

/** Create/reopen one reassessment and its task; a person-closed task makes it ACKNOWLEDGED. */
async function raise(
  month: { id: string; monthKey: string; enrollmentId: string; clientId: string },
  clientName: string, assignedKey: string, w: Want, now: Date,
): Promise<"raised" | "kept" | "acknowledged"> {
  let row = await prisma.programSessionReassessment.findUnique({ where: { sessionKey_anchorRef_kind: { sessionKey: w.sessionKey, anchorRef: w.anchorRef, kind: w.kind } } });
  if (row?.state === "ACKNOWLEDGED") return "kept";
  let raised = false;
  if (!row) {
    row = await prisma.programSessionReassessment
      .create({ data: { enrollmentId: month.enrollmentId, monthId: month.id, sessionKey: w.sessionKey, anchorRef: w.anchorRef, kind: w.kind, reason: w.reason, state: "OPEN" } })
      .catch(async () => prisma.programSessionReassessment.findUnique({ where: { sessionKey_anchorRef_kind: { sessionKey: w.sessionKey, anchorRef: w.anchorRef, kind: w.kind } } }));
    if (!row) return "kept";
    raised = true;
  } else if (row.state === "RESOLVED") {
    // The same conflict came back (a call moved away and back again).
    row = await prisma.programSessionReassessment.update({ where: { id: row.id }, data: { state: "OPEN", resolvedAt: null, reason: w.reason } });
    raised = true;
  } else if (row.reason !== w.reason) {
    row = await prisma.programSessionReassessment.update({ where: { id: row.id }, data: { reason: w.reason } });
  }

  // A task a person closed while the conflict stood is their answer: the
  // session stays. Recorded, never re-raised for the same facts.
  if (!raised && row.taskId) {
    const t = await prisma.smartTask.findUnique({ where: { id: row.taskId }, select: { status: true } }).catch(() => null);
    if (t && TASK_DONE_INCLUDING_LEGACY.includes(t.status)) {
      await prisma.programSessionReassessment.update({ where: { id: row.id }, data: { state: "ACKNOWLEDGED", resolvedAt: now } });
      return "acknowledged";
    }
  }

  const dedupeKey = w.linkedTaskKey ?? `${REASSESS_TASK_PREFIX}${row.id}`;
  if (!w.linkedTaskKey) {
    const hoursOut = (w.startsAt.getTime() - now.getTime()) / 3_600_000;
    await openProgramDeskTask({
      dedupeKey, clientId: month.clientId, clientName,
      title: `Filming session to reassess — ${clientName || "program client"} · ${whenET(w.startsAt)}`,
      lines: [
        w.reason,
        "",
        "Nothing has been moved or cancelled, and the client has not been messaged. Their portal says Kyle will confirm their filming time.",
        "Talk to them: keep the session, or move it. Change it in Aryeo only if they agree.",
        "This closes itself if the conflict goes away (the call moves back, or a new one is booked in time). Closing it yourself means the session stays as it is.",
      ],
      assignedKey,
      reasonCreated: w.kind === "ANCHOR_LOST" ? "The strategy call behind a booked filming session is gone (A25)" : "The preparation anchor of a booked filming session moved (A25)",
      // Back on the list when the same conflict returns after it had cleared.
      reopenIfClosed: raised && !!row.taskId,
      dueAt: new Date(Math.max(now.getTime(), Math.min(now.getTime() + 864e5, w.startsAt.getTime() - 24 * 3_600_000))),
      priority: hoursOut <= 72 ? "URGENT" : "HIGH",
    });
  }
  if (!row.taskId) {
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } }).catch(() => null);
    if (task) await prisma.programSessionReassessment.update({ where: { id: row.id }, data: { taskId: task.id } });
  }
  return raised ? "raised" : "kept";
}

/**
 * Hourly: every live month from last month forward. Desk truth, outside every
 * switch (like the address and scripts-before-filming tasks): it opens and
 * closes SmartTasks and contacts nobody, and never touches a booking.
 */
export async function reassessOpenMonths(opts: { now?: Date; max?: number } = {}): Promise<{ months: number; raised: number; resolved: number; acknowledged: number; baselines: number }> {
  const now = opts.now ?? new Date();
  // Only months with a session still ahead can need a look — plus any month
  // holding an OPEN reassessment, which must be read again to close it.
  const [projects, requests, openRows] = await Promise.all([
    prisma.project.findMany({
      where: { contentMonthId: { not: null }, status: { not: "CANCELLED" }, OR: [{ shootDate: { gt: now } }, { appointments: { some: { startAt: { gt: now } } } }] },
      select: { contentMonthId: true },
    }),
    prisma.programSessionRequest.findMany({ where: { status: "CONFIRMED", slotStart: { gt: now } }, select: { monthId: true } }),
    prisma.programSessionReassessment.findMany({ where: { state: "OPEN" }, select: { monthId: true } }),
  ]);
  const candidateIds = [...new Set([...projects.map((p) => p.contentMonthId!), ...requests.map((r) => r.monthId), ...openRows.map((r) => r.monthId)])];
  const months = candidateIds.length
    ? await prisma.contentMonth.findMany({ where: { id: { in: candidateIds }, historical: false }, select: { id: true }, take: opts.max ?? 200 })
    : [];
  const tally = { months: 0, raised: 0, resolved: 0, acknowledged: 0, baselines: 0 };
  for (const m of months) {
    const r = await reassessMonthSessions(m.id, { now }).catch(() => null);
    if (!r || r.skipped) continue;
    tally.months++;
    tally.raised += r.raised; tally.resolved += r.resolved; tally.acknowledged += r.acknowledged; tally.baselines += r.baselines;
  }
  return tally;
}

export type OpenReassessment = { id: string; sessionKey: string; kind: ReassessKind; reason: string; createdAt: Date };

/** The OPEN reassessments of some months — the staff banner and the portal's "Kyle will confirm" line. */
export async function openReassessments(monthIds: string[]): Promise<Map<string, OpenReassessment[]>> {
  const out = new Map<string, OpenReassessment[]>();
  if (!monthIds.length) return out;
  const rows = await prisma.programSessionReassessment.findMany({
    where: { monthId: { in: monthIds }, state: "OPEN", kind: { not: BASELINE } },
    orderBy: { createdAt: "asc" },
    select: { id: true, monthId: true, sessionKey: true, kind: true, reason: true, createdAt: true },
  });
  for (const r of rows) {
    const list = out.get(r.monthId) ?? [];
    list.push({ id: r.id, sessionKey: r.sessionKey, kind: r.kind as ReassessKind, reason: r.reason, createdAt: r.createdAt });
    out.set(r.monthId, list);
  }
  return out;
}
