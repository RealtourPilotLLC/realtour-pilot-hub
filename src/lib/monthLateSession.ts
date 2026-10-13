import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { catchUpFrom, catchUpInto } from "@/lib/catchUp";
import {
  COMBINED_SESSION_HOURS, SEPARATE_SESSION_HOURS, combineOffered, combinedLateOf, combinedSlotLabel,
  lateMonthName, latePortalLine, lateScriptsLock, lateSessionMessage as composeMessage, lateSessionOf, lateSessionsInto, lateSlotLabel, withLateSession,
  type HostPlanning, type LateSessionRecord, type LateState,
} from "@/lib/lateSession";
import { monthSessionCount, recalcProgramMonth, type ProgramDb } from "@/lib/programMonths";

// ---------------------------------------------------------------------------
// FILM A LATE MONTH'S SESSION THIS MONTH (Oct 12 2026) — the staff writer and
// the readers the portal and the office share. The record and the words live
// in lateSession.ts; this file decides who may, and writes.
//
// APPLY (owner/admin, an exception like the catch-up): the HOST month (this
// or a later ET month, OPEN, live) brings in an EARLIER month's session —
// a month that is over, OPEN, live, PLANNED (a call held or booked, or
// topics / answers / scripts on it) and with no session linked, booked or
// asked for. Nothing on either month moves: the late month keeps its topics,
// scripts, videos and its one session; the host keeps its own. The record is
// one entry in the enrollment's overrides bag, ledgered. The late month's
// open reminder escalations close (their next ones read "booking in October").
//
// UNDO takes the record off while nothing is booked or asked for on the late
// month — decided under the same per-month lock a booking takes, so a
// booking racing it is one after the other, never both.
//
// Nothing here messages a client, books, cancels, or talks to Aryeo/Calendly.
// The message is composed for the office to copy and send.
//
// ONE SESSION OR TWO (Oct 13 2026). Jordan: "I'd like to give the option to
// film 4 in one session if needing to catch up or 2 separate sessions ... so
// essentially they would be using the video accelerator package to catch
// up." On Starter the client (portal) or the office (Overview) may choose to
// film both months' videos in ONE Video Accelerator-length session (4 hours)
// instead of two 2-hour sessions. The record's `combined` flag says so; the
// one booking is filed on the LATE month and the host counts it as its own
// session (programMonths.sessionSourceMonthIds). The choice changes only
// while neither month has a session booked, filmed or asked for, decided
// under BOTH months' booking locks (late month first, then host: the order
// createSessionRequest takes them in).
// ---------------------------------------------------------------------------

type Db = Pick<typeof prisma, "programCallRecord" | "contentMonth" | "project" | "programSessionRequest" | "contentVideo" | "contentTopic" | "contentTopicSelection" | "contentScript" | "contentInterview" | "appointment">;

const LIVE_REQUEST = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
const FILMED_TOPIC = ["FILMED", "EDITING", "DELIVERED"];
const LIVE_CALL = { callType: "MONTHLY_STRATEGY", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF", "AMBIGUOUS_CLIENT"] }, status: { in: ["SCHEDULED", "COMPLETED"] } };
const name = (key: string, rel?: string | null) => lateMonthName(key, rel);
const day = (d: Date | null) => d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : null;

/** The late month's scripts the client can read (released), and whether its session may be booked on scripts. */
export async function lateScriptsReady(lateMonthId: string, rec: Pick<LateSessionRecord, "scriptsSentOutside"> | null, db: Pick<typeof prisma, "contentScript"> = prisma): Promise<{ released: number; ready: boolean }> {
  const { scriptVisibility } = await import("@/lib/postingKit");
  const rows = await db.contentScript.findMany({ where: { monthId: lateMonthId, historical: false }, select: { status: true, releaseState: true, historical: true } });
  const released = rows.filter((s) => scriptVisibility(s) === "released").length;
  return { released, ready: released > 0 || !!rec?.scriptsSentOutside };
}

/** Where the late month's one session stands. */
export async function lateMonthState(lateMonthId: string, clientId: string, now: Date, db: ProgramDb = prisma): Promise<{ state: LateState; filmed: boolean; startsAt: Date | null }> {
  const [count, pending] = await Promise.all([
    monthSessionCount(lateMonthId, clientId, now, db),
    db.programSessionRequest.count({ where: { monthId: lateMonthId, status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED"] }, bookingState: { not: "CONFLICT" } } }),
  ]);
  const first = count.sessions.find((s) => !s.filmed) ?? count.sessions[0] ?? null;
  return {
    state: count.accountedFor > 0 ? "BOOKED" : pending > 0 ? "REQUESTED" : "TO_BOOK",
    filmed: count.accountedFor > 0 && count.filmed >= count.accountedFor,
    startsAt: first?.startsAt ?? first?.at ?? null,
  };
}

/** Why an earlier month's session can't be brought in (null = it can). Plain words for the office. */
async function lateRefusal(db: Db, m: { id: string; monthKey: string; status: string; historical: boolean; strategyCallStatus: string | null }, hostKey: string, overridesJson: string | null, now: Date): Promise<string | null> {
  const n = name(m.monthKey, hostKey);
  if (m.monthKey >= hostKey) return `${n} is not before ${name(hostKey)}.`;
  if (m.monthKey >= etMonthKey(now)) return `${n} isn't over yet — its session is booked in ${n} as usual.`;
  if (m.historical) return `${n} is imported history.`;
  if (m.status !== "OPEN") {
    const from = catchUpFrom(overridesJson, m.monthKey);
    return from ? `${n} was caught up in ${name(from.targetMonthKey, m.monthKey)} — its videos are filmed there.` : `${n} is ${m.status === "SKIPPED" ? "marked skipped" : m.status.toLowerCase()}.`;
  }
  const already = lateSessionOf(overridesJson, m.monthKey);
  if (already) return `${n}'s session is already being booked in ${name(already.hostMonthKey, m.monthKey)}.`;
  if (catchUpInto(overridesJson, m.monthKey)) return `${n} carries a catch-up of its own.`;
  if (lateSessionsInto(overridesJson, m.monthKey).length) return `${n} already brings in another month's session.`;
  const [shoots, requests, videos, filmed, calls, selections, scripts, interviews] = await Promise.all([
    db.project.findMany({ where: { contentMonthId: m.id, status: { not: "CANCELLED" } }, select: { shootDate: true }, orderBy: { shootDate: "asc" } }),
    db.programSessionRequest.count({ where: { monthId: m.id, status: { in: LIVE_REQUEST } } }),
    db.contentVideo.count({ where: { monthId: m.id } }),
    db.contentTopic.count({ where: { monthId: m.id, status: { in: FILMED_TOPIC } } }),
    db.programCallRecord.count({ where: { monthId: m.id, ...LIVE_CALL } }),
    db.contentTopicSelection.count({ where: { monthId: m.id, status: { in: LIVE_SELECTION } } }),
    db.contentScript.count({ where: { monthId: m.id } }),
    db.contentInterview.count({ where: { monthId: m.id } }),
  ]);
  if (shoots.length) {
    const when = day(shoots[0].shootDate);
    return `${n} already has a shoot linked to it${when ? ` (${when})` : ""}.`;
  }
  if (requests) return `${n} already has a filming session booked or asked for.`;
  if (videos || filmed) return `${n} already has videos.`;
  const planned = calls > 0 || m.strategyCallStatus === "COMPLETED" || m.strategyCallStatus === "SCHEDULED" || selections + scripts + interviews > 0;
  if (!planned) return `${n} has nothing planned (no strategy call, topics or scripts), so it is forfeited. If you're making an exception, approve a catch-up instead.`;
  return null;
}

async function hostRefusal(t: { monthKey: string; status: string; historical: boolean }, enrollment: { status: string; overridesJson: string | null }, now: Date): Promise<string | null> {
  const n = name(t.monthKey);
  if (enrollment.status !== "ACTIVE") return `The program is ${enrollment.status.toLowerCase()} — reactivate it first.`;
  if (t.historical) return `${n} is imported history.`;
  if (t.status !== "OPEN") return `${n} is ${t.status === "SKIPPED" ? "closed" : t.status.toLowerCase()}, so it can't book another month's session.`;
  if (t.monthKey < etMonthKey(now)) return `${n} is over — bring the session into this month or a later one.`;
  const into = lateSessionsInto(enrollment.overridesJson, t.monthKey)[0];
  if (into) return `${n} already brings in ${name(into.lateMonthKey, t.monthKey)}'s session. Undo that first to bring in a different month.`;
  const own = lateSessionOf(enrollment.overridesJson, t.monthKey);
  if (own) return `${n}'s own session is being booked in ${name(own.hostMonthKey, t.monthKey)}.`;
  return null;
}

/**
 * Undo is honest only while the late month has no session booked, filmed or
 * asked for — the booking would otherwise sit on a month the portal no
 * longer offers.
 */
export async function lateUndoRefusal(lateMonthId: string, opts: { now?: Date; db?: ProgramDb } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const m = await db.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, clientId: true, enrollmentId: true, monthKey: true } });
  if (!m) return "That month is no longer on file.";
  const e = await db.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { overridesJson: true } });
  const rec = e ? lateSessionOf(e.overridesJson, m.monthKey) : null;
  if (!rec) return `${name(m.monthKey)}'s session isn't being booked late.`;
  const [count, live] = await Promise.all([
    monthSessionCount(m.id, m.clientId, now, db),
    db.programSessionRequest.findFirst({ where: { monthId: m.id, status: { in: LIVE_REQUEST }, bookingState: { not: "CONFLICT" } }, orderBy: { slotStart: "asc" }, select: { slotStart: true } }),
  ]);
  const late = name(m.monthKey, rec.hostMonthKey);
  if (count.accountedFor > 0 || live) {
    const when = day(count.sessions[0]?.startsAt ?? live?.slotStart ?? null);
    return `${late}'s session is already booked or asked for${when ? ` (${when})` : ""}. Cancel it first, then undo.`;
  }
  return null;
}

export type LateOption = { monthId: string; monthKey: string; label: string; refusal: string | null; scriptsReleased: number };
/**
 * Oct 13 2026: one session or two, for a late month and its host. `offered`:
 * the package may combine (Starter). `refusal`: why the choice can't change
 * right now (null = it can). `videos`: both months' videos together.
 */
export type CombineChoice = { combined: boolean; offered: boolean; refusal: string | null; videos: number; combinedHours: number; separateHours: number };
export type LateSessionPanel = {
  monthId: string;
  monthKey: string;
  monthName: string;
  /** HOST side: this month brings in an earlier month's session. */
  carrying: (LateSessionRecord & { lateLabel: string; undoRefusal: string | null; state: LateState; filmed: boolean; startsAtISO: string | null; scriptsReleased: number; scriptsReady: boolean; lateVideosOwed: number; combine: CombineChoice }) | null;
  /** HOST side, nothing carried yet: the earlier months, each with its reason when it can't be picked. */
  options: LateOption[];
  hostRefusal: string | null;
  /** LATE side: this (over) month's session is being booked in a later month. */
  filmingIn: (LateSessionRecord & { hostLabel: string; undoRefusal: string | null; state: LateState; filmed: boolean; startsAtISO: string | null; combine: CombineChoice }) | null;
  /** LATE side, not yet: this over, planned month could be brought into `host` (the first open month from now). */
  offer: { hostMonthId: string; hostMonthKey: string; hostLabel: string; refusal: string | null; scriptsReleased: number } | null;
};

/** Everything the Overview's late-session control needs for one month. */
export async function lateSessionPanel(monthId: string, opts: { now?: Date } = {}): Promise<LateSessionPanel | null> {
  const now = opts.now ?? new Date();
  const t = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, status: true, historical: true, videosOwed: true, strategyCallStatus: true } });
  if (!t) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: t.enrollmentId }, select: { status: true, overridesJson: true } });
  if (!e) return null;
  const out: LateSessionPanel = { monthId: t.id, monthKey: t.monthKey, monthName: name(t.monthKey), carrying: null, options: [], hostRefusal: null, filmingIn: null, offer: null };
  const nowKey = etMonthKey(now);

  if (t.monthKey >= nowKey) {
    const into = lateSessionsInto(e.overridesJson, t.monthKey)[0] ?? null;
    if (into) {
      const lm = await prisma.contentMonth.findUnique({ where: { id: into.lateMonthId }, select: { id: true, videosOwed: true } });
      const [st, scripts, undo, combine] = await Promise.all([
        lateMonthState(into.lateMonthId, t.clientId, now),
        lateScriptsReady(into.lateMonthId, into),
        lateUndoRefusal(into.lateMonthId, { now }),
        combineChoice(into, { now }),
      ]);
      out.carrying = { ...into, lateLabel: name(into.lateMonthKey, t.monthKey), undoRefusal: undo, state: st.state, filmed: st.filmed, startsAtISO: st.startsAt?.toISOString() ?? null, scriptsReleased: scripts.released, scriptsReady: scripts.ready, lateVideosOwed: lm?.videosOwed ?? 0, combine };
      return out;
    }
    out.hostRefusal = await hostRefusal(t, e, now);
    if (out.hostRefusal) return out;
    const earlier = await prisma.contentMonth.findMany({
      where: { enrollmentId: t.enrollmentId, monthKey: { lt: nowKey }, historical: false, status: "OPEN" },
      orderBy: { monthKey: "desc" }, take: 6,
      select: { id: true, monthKey: true, status: true, historical: true, strategyCallStatus: true },
    });
    for (const m of earlier) {
      const refusal = await lateRefusal(prisma, m, t.monthKey, e.overridesJson, now);
      out.options.push({ monthId: m.id, monthKey: m.monthKey, label: name(m.monthKey, t.monthKey), refusal, scriptsReleased: refusal ? 0 : (await lateScriptsReady(m.id, null)).released });
    }
    return out;
  }

  // An over month: is its session being booked late, or could it be?
  const own = lateSessionOf(e.overridesJson, t.monthKey);
  if (own) {
    const [st, undo, combine] = await Promise.all([lateMonthState(t.id, t.clientId, now), lateUndoRefusal(t.id, { now }), combineChoice(own, { now })]);
    out.filmingIn = { ...own, hostLabel: name(own.hostMonthKey, t.monthKey), undoRefusal: undo, state: st.state, filmed: st.filmed, startsAtISO: st.startsAt?.toISOString() ?? null, combine };
    return out;
  }
  const { catchUpTargetFor } = await import("@/lib/monthForfeit");
  const host = await catchUpTargetFor(t.enrollmentId, now);
  if (!host) return out;
  const hostRow = await prisma.contentMonth.findUnique({ where: { id: host.id }, select: { monthKey: true, status: true, historical: true } });
  const refusal = (hostRow ? await hostRefusal(hostRow, e, now) : "No open month to book it in.") ?? await lateRefusal(prisma, t, host.monthKey, e.overridesJson, now);
  out.offer = { hostMonthId: host.id, hostMonthKey: host.monthKey, hostLabel: name(host.monthKey, t.monthKey), refusal, scriptsReleased: refusal ? 0 : (await lateScriptsReady(t.id, null)).released };
  return out;
}

const ref = (r: LateSessionRecord) => `${r.lateMonthKey} session booked in ${r.hostMonthKey}`;

/** Bring `lateMonthId`'s session into `hostMonthId`. Throws a plain sentence when it can't. */
export async function applyLateSession(hostMonthId: string, lateMonthId: string, by: string | null, opts: { now?: Date; scriptsSentOutside?: boolean } = {}): Promise<{ record: LateSessionRecord; message: string }> {
  const now = opts.now ?? new Date();
  const record = await prisma.$transaction(async (tx) => {
    const t = await tx.contentMonth.findUnique({ where: { id: hostMonthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true } });
    if (!t) throw new Error("That month is no longer on file.");
    const m = await tx.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true, strategyCallStatus: true } });
    if (!m || m.enrollmentId !== t.enrollmentId) throw new Error("Pick an earlier month of this client's program.");
    const e = await tx.contentEnrollment.findUnique({ where: { id: t.enrollmentId }, select: { id: true, clientId: true, status: true, overridesJson: true } });
    if (!e) throw new Error("Enrollment not found.");
    // The late month's per-month lock (the one a booking takes): a request
    // filed on it a moment ago is seen here, and refuses.
    const { monthLockKey } = await import("@/lib/sessionRequests");
    const [a, b] = monthLockKey(e.id, m.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
    const hr = await hostRefusal(t, e, now);
    if (hr) throw new Error(hr);
    const lr = await lateRefusal(tx, m, t.monthKey, e.overridesJson, now);
    if (lr) throw new Error(lr);
    const rec: LateSessionRecord = {
      lateMonthKey: m.monthKey, lateMonthId: m.id, hostMonthKey: t.monthKey, hostMonthId: t.id,
      scriptsSentOutside: opts.scriptsSentOutside === true, by, at: now.toISOString(),
    };
    // Compare-and-set: a second click, or a change in another tab, writes nothing.
    const w = await tx.contentEnrollment.updateMany({ where: { id: e.id, overridesJson: e.overridesJson }, data: { overridesJson: withLateSession(e.overridesJson, m.monthKey, rec) } });
    if (w.count !== 1) throw new Error("This program changed while you were working. Reload and try again.");
    await tx.programEnrollmentChange.create({
      data: {
        enrollmentId: e.id, clientId: e.clientId, field: "overrides",
        fromValue: JSON.stringify({ lateSession: null }), toValue: JSON.stringify({ lateSession: ref(rec), scriptsSentOutside: rec.scriptsSentOutside }),
        effectiveAt: now, effectiveMonthKey: m.monthKey,
        reason: `Film ${name(m.monthKey, t.monthKey)}'s session in ${name(t.monthKey)}: the client books it alongside ${name(t.monthKey)}'s. ${name(m.monthKey, t.monthKey)} keeps its own topics, scripts and videos.${rec.scriptsSentOutside ? ` Its scripts were sent outside the hub.` : ""}`,
        source: "manual", billingTruth: false, changedBy: by, appliedAt: now,
      },
    });
    return rec;
  }, { timeout: 20_000 });
  // The late month's old chasing ("book September") stops; anything it raises
  // next reads "booking in October" (programReminders).
  await prisma.smartTask.updateMany({
    where: { status: { notIn: ["COMPLETED", "CANCELLED", "DONE", "CLOSED"] }, OR: [{ dedupeKey: { startsWith: `program-reminder-escalation:${record.lateMonthId}:` } }, { dedupeKey: { startsWith: `program-reminder-midmonth:${record.lateMonthId}` } }] },
    data: { status: "COMPLETED", completedAt: now },
  }).catch(() => null);
  await recalcProgramMonth(record.lateMonthId, { now }).catch(() => null);
  await recalcProgramMonth(record.hostMonthId, { now }).catch(() => null);
  const t = name(record.hostMonthKey), l = name(record.lateMonthKey, record.hostMonthKey);
  return { record, message: `${t} now brings in ${l}'s session: the client books both in the portal. ${l} keeps its own topics, scripts and videos, and the session booked for it is filed on ${l}.` };
}

/** Take the record off. Throws the plain reason when it can't. */
export async function undoLateSession(lateMonthId: string, by: string | null, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  const refusal = await lateUndoRefusal(lateMonthId, { now });
  if (refusal) throw new Error(refusal);
  const rec = await prisma.$transaction(async (tx) => {
    const m = await tx.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, enrollmentId: true, monthKey: true } });
    if (!m) throw new Error("That month is no longer on file.");
    const { monthLockKey } = await import("@/lib/sessionRequests");
    const [a, b] = monthLockKey(m.enrollmentId, m.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
    // Re-read INSIDE the lock: a session asked for a moment ago refuses the undo.
    const again = await lateUndoRefusal(m.id, { now, db: tx });
    if (again) throw new Error(again);
    const e = await tx.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { id: true, clientId: true, overridesJson: true } });
    const r = e ? lateSessionOf(e.overridesJson, m.monthKey) : null;
    if (!e || !r) throw new Error(`${name(m.monthKey)}'s session isn't being booked late.`);
    const w = await tx.contentEnrollment.updateMany({ where: { id: e.id, overridesJson: e.overridesJson }, data: { overridesJson: withLateSession(e.overridesJson, m.monthKey, null) } });
    if (w.count !== 1) throw new Error("This program changed while you were working. Reload and try again.");
    await tx.programEnrollmentChange.create({
      data: {
        enrollmentId: e.id, clientId: e.clientId, field: "overrides",
        fromValue: JSON.stringify({ lateSession: ref(r) }), toValue: JSON.stringify({ lateSession: null }),
        effectiveAt: now, effectiveMonthKey: m.monthKey, reason: `Undid filming ${name(m.monthKey, r.hostMonthKey)}'s session in ${name(r.hostMonthKey)}; nothing had been booked for it.`,
        source: "manual", billingTruth: false, changedBy: by, appliedAt: now,
      },
    });
    return r;
  }, { timeout: 20_000 });
  await recalcProgramMonth(rec.lateMonthId, { now }).catch(() => null);
  await recalcProgramMonth(rec.hostMonthId, { now }).catch(() => null);
  return { message: `Undone. ${name(rec.lateMonthKey, rec.hostMonthKey)}'s session is no longer offered in ${name(rec.hostMonthKey)}.` };
}

// ---------------------------------------------------------------------------
// ONE SESSION OR TWO (Oct 13 2026)
// ---------------------------------------------------------------------------

const LIVE_ASK = { status: { in: LIVE_REQUEST }, bookingState: { not: "CONFLICT" } };

/** The videos one combined session films: both months' own (Starter: 2 + 2). */
export async function combinedVideoCount(rec: Pick<LateSessionRecord, "lateMonthId" | "hostMonthId">, db: Pick<typeof prisma, "contentMonth"> = prisma): Promise<number> {
  const rows = await db.contentMonth.findMany({ where: { id: { in: [rec.lateMonthId, rec.hostMonthId] } }, select: { videosOwed: true } });
  return rows.reduce((n, m) => n + m.videosOwed, 0);
}

/**
 * Why a late month's "one session or two" can't be set to `want` now (null =
 * it can). Plain words, the same for the client and the office: Starter only
 * (to combine), both months still open, and NEITHER month has a session
 * booked, filmed or asked for — a booking would otherwise sit on a choice
 * that no longer matches it. Pass the transaction when deciding under the locks.
 */
export async function combineRefusal(lateMonthId: string, want: boolean, opts: { now?: Date; db?: ProgramDb } = {}): Promise<string | null> {
  const db = opts.db ?? prisma;
  const m = await db.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, status: true, historical: true } });
  if (!m) return "That month is no longer on file.";
  const e = await db.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { package: true, status: true, overridesJson: true } });
  const rec = e ? lateSessionOf(e.overridesJson, m.monthKey) : null;
  if (!e || !rec || rec.lateMonthId !== m.id) return `${name(m.monthKey)}'s session isn't being booked late.`;
  const late = name(rec.lateMonthKey, rec.hostMonthKey), host = name(rec.hostMonthKey);
  if (want && !combineOffered(e.package)) return `Filming ${late} and ${host} in one session is only offered on the Starter package (one ${SEPARATE_SESSION_HOURS}-hour session a month). Each month keeps its own session.`;
  if (e.status !== "ACTIVE") return `The program is ${e.status.toLowerCase()}, so how ${late} and ${host} are filmed can't change now.`;
  const hostRow = await db.contentMonth.findUnique({ where: { id: rec.hostMonthId }, select: { enrollmentId: true, status: true, historical: true } });
  if (m.status !== "OPEN" || m.historical || !hostRow || hostRow.enrollmentId !== m.enrollmentId || hostRow.status !== "OPEN" || hostRow.historical) return `Booking for these months has closed, so how they are filmed can't change now.`;
  const [lateAsks, hostAsks, lateShoots, hostShoots] = await Promise.all([
    db.programSessionRequest.count({ where: { monthId: rec.lateMonthId, ...LIVE_ASK } }),
    db.programSessionRequest.count({ where: { monthId: rec.hostMonthId, ...LIVE_ASK } }),
    db.project.count({ where: { contentMonthId: rec.lateMonthId, clientId: m.clientId, status: { not: "CANCELLED" } } }),
    db.project.count({ where: { contentMonthId: rec.hostMonthId, clientId: m.clientId, status: { not: "CANCELLED" } } }),
  ]);
  if (lateAsks || lateShoots) return rec.combined
    ? `The ${late} and ${host} session is already booked or requested, so this can't change now. Cancel that session first to change it.`
    : `${late}'s session is already booked or requested, so how the two months are filmed can't change now. Cancel that session first to change it.`;
  if (hostAsks || hostShoots) return `${host}'s session is already booked or requested, so how the two months are filmed can't change now. Cancel that session first to change it.`;
  return null;
}

/** The choice as a screen shows it (CombineChoice). */
export async function combineChoice(rec: LateSessionRecord, opts: { now?: Date } = {}): Promise<CombineChoice> {
  const [pkg, refusal, videos] = await Promise.all([
    prisma.contentMonth.findUnique({ where: { id: rec.lateMonthId }, select: { enrollmentId: true } })
      .then((m) => m ? prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { package: true } }) : null).then((e) => e?.package ?? null),
    combineRefusal(rec.lateMonthId, !rec.combined, opts),
    combinedVideoCount(rec),
  ]);
  return { combined: !!rec.combined, offered: !!rec.combined || combineOffered(pkg), refusal, videos, combinedHours: COMBINED_SESSION_HOURS, separateHours: SEPARATE_SESSION_HOURS };
}

/**
 * Film the late month together with its host in ONE session (combined) or in
 * two (not). Owner/admin on the Overview, or the client on the portal. Under
 * BOTH months' booking locks (late first, then host — the order a combined
 * booking takes), so a booking racing the switch is one after the other.
 * Throws the plain reason when it can't. Ledgered; sends nothing.
 */
export async function setLateCombined(lateMonthId: string, combined: boolean, by: string | null, opts: { now?: Date } = {}): Promise<{ record: LateSessionRecord; changed: boolean; message: string }> {
  const now = opts.now ?? new Date();
  const out = await prisma.$transaction(async (tx) => {
    const m = await tx.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, enrollmentId: true, monthKey: true } });
    if (!m) throw new Error("That month is no longer on file.");
    const e0 = await tx.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { overridesJson: true } });
    const rec0 = e0 ? lateSessionOf(e0.overridesJson, m.monthKey) : null;
    if (!rec0 || rec0.lateMonthId !== m.id) throw new Error(`${name(m.monthKey)}'s session isn't being booked late.`);
    const { monthLockKey } = await import("@/lib/sessionRequests");
    const [a, b] = monthLockKey(m.enrollmentId, m.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
    const [c, d] = monthLockKey(m.enrollmentId, rec0.hostMonthId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${c}::int4, ${d}::int4)`;
    // Re-read INSIDE the locks: a booking or another switch a moment ago is seen here.
    const e = await tx.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { id: true, clientId: true, overridesJson: true } });
    const rec = e ? lateSessionOf(e.overridesJson, m.monthKey) : null;
    if (!e || !rec || rec.lateMonthId !== m.id) throw new Error(`${name(m.monthKey)}'s session isn't being booked late.`);
    if (!!rec.combined === combined) return { record: rec, changed: false };
    const refusal = await combineRefusal(m.id, combined, { now, db: tx });
    if (refusal) throw new Error(refusal);
    const { combined: _old, ...rest } = rec;
    void _old;
    const next: LateSessionRecord = combined ? { ...rest, combined: true } : rest;
    const w = await tx.contentEnrollment.updateMany({ where: { id: e.id, overridesJson: e.overridesJson }, data: { overridesJson: withLateSession(e.overridesJson, m.monthKey, next) } });
    if (w.count !== 1) throw new Error("This program changed while you were working. Reload and try again.");
    const l = name(rec.lateMonthKey, rec.hostMonthKey), h = name(rec.hostMonthKey);
    await tx.programEnrollmentChange.create({
      data: {
        enrollmentId: e.id, clientId: e.clientId, field: "overrides",
        fromValue: JSON.stringify({ lateSession: ref(rec), combined: !!rec.combined }), toValue: JSON.stringify({ lateSession: ref(rec), combined }),
        effectiveAt: now, effectiveMonthKey: rec.lateMonthKey,
        reason: combined
          ? `Film ${l} and ${h} together in one ${COMBINED_SESSION_HOURS}-hour Video Accelerator session, booked on ${l}, instead of two ${SEPARATE_SESSION_HOURS}-hour sessions.`
          : `Film ${l} and ${h} in two ${SEPARATE_SESSION_HOURS}-hour sessions again, one for each month.`,
        source: "manual", billingTruth: false, changedBy: by, appliedAt: now,
      },
    });
    return { record: next, changed: true };
  }, { timeout: 20_000 });
  if (out.changed) {
    await recalcProgramMonth(out.record.lateMonthId, { now }).catch(() => null);
    await recalcProgramMonth(out.record.hostMonthId, { now }).catch(() => null);
  }
  const l = name(out.record.lateMonthKey, out.record.hostMonthKey), h = name(out.record.hostMonthKey);
  const videos = await combinedVideoCount(out.record).catch(() => 0);
  const message = combined
    ? `${out.changed ? "Saved." : "Already set."} ${l} and ${h} are filmed together in one ${COMBINED_SESSION_HOURS}-hour session${videos ? ` (all ${videos} videos)` : ""}.`
    : `${out.changed ? "Saved." : "Already set."} ${l} and ${h} are filmed in two sessions, ${SEPARATE_SESSION_HOURS} hours each.`;
  return { record: out.record, changed: out.changed, message };
}

/**
 * The combined record that makes `monthId` the LATE month of one session for
 * both months, or null. What the booking doors read to use the Accelerator
 * product's length and to hold the session to the host month's gate too.
 */
export async function combinedLateRecord(enrollmentId: string, monthId: string, db: Pick<typeof prisma, "contentEnrollment" | "contentMonth"> = prisma): Promise<LateSessionRecord | null> {
  const m = await db.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true, monthKey: true } });
  if (!m || m.enrollmentId !== enrollmentId) return null;
  const e = await db.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const rec = combinedLateOf(e?.overridesJson, m.monthKey);
  return rec && rec.lateMonthId === monthId ? rec : null;
}

/**
 * The host month a LATE month is filmed together with, in one session — or
 * null. What the shoot's readers (filmedTopics.topicsForSession, the shoot
 * screen's office-approved scripts, the editor's brief) add the host month's
 * topics and scripts from: the shoot sits on the late month, and the people
 * filming need all four scripts.
 */
export async function combinedHostOfLateMonth(lateMonthId: string, db: Pick<typeof prisma, "contentEnrollment" | "contentMonth"> = prisma): Promise<{ id: string; monthKey: string; videosOwed: number; enrollmentId: string; clientId: string } | null> {
  const m = await db.contentMonth.findUnique({ where: { id: lateMonthId }, select: { enrollmentId: true } });
  if (!m) return null;
  const rec = await combinedLateRecord(m.enrollmentId, lateMonthId, db);
  if (!rec) return null;
  const host = await db.contentMonth.findUnique({ where: { id: rec.hostMonthId }, select: { id: true, monthKey: true, videosOwed: true, enrollmentId: true, clientId: true } });
  return host && host.enrollmentId === m.enrollmentId ? host : null;
}

/** The host month's gate for a combined session (its one session). */
export async function combinedHostGate(enrollmentId: string, rec: Pick<LateSessionRecord, "hostMonthId">, now: Date): Promise<import("@/lib/portal").SessionGate> {
  const { sessionGate } = await import("@/lib/portal");
  return sessionGate(enrollmentId, rec.hostMonthId, { now, sessionIndex: 1 });
}

// ---------------------------------------------------------------------------
// THE PORTAL'S READS
// ---------------------------------------------------------------------------

/**
 * The live record that makes `monthId` (an over month) bookable on the
 * portal: its host is this ET month or later and still open, and the late
 * month itself is open and live. Null for every other month.
 */
export async function bookableLateRecord(enrollmentId: string, month: { id: string; monthKey: string; status: string; historical: boolean }, now: Date = new Date(), db: Pick<typeof prisma, "contentEnrollment" | "contentMonth"> = prisma): Promise<LateSessionRecord | null> {
  if (month.historical || month.status !== "OPEN") return null;
  const e = await db.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const rec = e ? lateSessionOf(e.overridesJson, month.monthKey) : null;
  if (!rec || rec.lateMonthId !== month.id || rec.hostMonthKey < etMonthKey(now)) return null;
  const host = await db.contentMonth.findUnique({ where: { id: rec.hostMonthId }, select: { enrollmentId: true, status: true, historical: true } });
  return host && host.enrollmentId === enrollmentId && host.status === "OPEN" && !host.historical ? rec : null;
}

/**
 * The extra lock on a late month's session gate (portal.sessionGate): its
 * scripts must be ready (released in the hub, or sent outside it), and its
 * host month must still be running. Null = no extra lock; also null for any
 * month that is not over (nothing changes for them).
 */
export async function lateGateLock(enrollmentId: string, month: { id: string; monthKey: string; status: string; historical: boolean }, now: Date): Promise<string | null> {
  if (month.monthKey >= etMonthKey(now)) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  const rec = e ? lateSessionOf(e.overridesJson, month.monthKey) : null;
  if (!rec) return null;
  if (!(await bookableLateRecord(enrollmentId, month, now))) return `Booking for your ${name(month.monthKey)} session has closed. Send us a message and we'll sort it out together.`;
  const scripts = await lateScriptsReady(month.id, rec);
  return scripts.ready ? null : lateScriptsLock(rec.lateMonthKey, rec.hostMonthKey);
}

export type PortalLateSession = {
  monthId: string;
  monthKey: string;
  /** "September" */
  label: string;
  /** The scheduler's tab: "September session (your scripts are ready)". */
  slotLabel: string;
  /** "Your September session still needs booking, and October's too." */
  line: string;
  state: LateState;
  scriptsReady: boolean;
  /** Staff sent the scripts outside the hub (none may be released here). */
  sentOutside: boolean;
  /** Oct 13 2026: one session or two. `offered` false = the package can't combine (the card shows no choice). */
  combine: CombineChoice;
  /** The host month's name ("October"). */
  hostLabel: string;
};

/** The late session the host month brings in, for the client — null when none (or it has been filmed). */
export async function portalLateSession(enrollment: { id: string; clientId: string }, hostMonthId: string, opts: { now?: Date; hostStillToBook?: boolean; timezone?: string | null } = {}): Promise<PortalLateSession | null> {
  const now = opts.now ?? new Date();
  const host = await prisma.contentMonth.findUnique({ where: { id: hostMonthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true } });
  if (!host || host.enrollmentId !== enrollment.id || host.status !== "OPEN" || host.historical || host.monthKey < etMonthKey(now)) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { overridesJson: true } });
  const rec = lateSessionsInto(e?.overridesJson, host.monthKey)[0] ?? null;
  if (!rec) return null;
  const lm = await prisma.contentMonth.findUnique({ where: { id: rec.lateMonthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true } });
  if (!lm || lm.enrollmentId !== enrollment.id || lm.status !== "OPEN" || lm.historical) return null;
  const [st, scripts, hostRemaining, combine] = await Promise.all([
    lateMonthState(lm.id, enrollment.clientId, now),
    lateScriptsReady(lm.id, rec),
    opts.hostStillToBook != null ? Promise.resolve(opts.hostStillToBook) : import("@/lib/sessionRequests").then((m) => m.sessionCapacity(enrollment.id, host.id, { now })).then((c) => c.remaining > 0).catch(() => true),
    combineChoice(rec, { now }),
  ]);
  if (st.filmed) return null;
  const tz = opts.timezone ?? "America/New_York";
  const bookedLabel = st.state === "BOOKED" && st.startsAt ? st.startsAt.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }) : null;
  return {
    monthId: lm.id, monthKey: lm.monthKey, label: name(lm.monthKey, host.monthKey),
    slotLabel: rec.combined ? combinedSlotLabel(lm.monthKey, host.monthKey, combine.videos) : lateSlotLabel(lm.monthKey, host.monthKey, scripts.ready),
    line: latePortalLine({ lateMonthKey: lm.monthKey, hostMonthKey: host.monthKey, state: st.state, hostStillToBook: hostRemaining, bookedLabel, combinedVideos: rec.combined ? combine.videos : null }),
    state: st.state, scriptsReady: scripts.ready, sentOutside: rec.scriptsSentOutside,
    combine, hostLabel: name(host.monthKey),
  };
}

export type PortalLateScript = { topicId: string | null; title: string; body: string };

/** The late month's released scripts, words in full — so the client can prep for the session. */
export async function portalLateScripts(enrollment: { id: string; clientId: string }, lateMonthId: string): Promise<PortalLateScript[]> {
  const { scriptVisibility } = await import("@/lib/postingKit");
  const rows = await prisma.contentScript.findMany({
    where: { monthId: lateMonthId, enrollmentId: enrollment.id, clientId: enrollment.clientId, historical: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, topicId: true, title: true, body: true, status: true, releaseState: true, historical: true },
  });
  const released = rows.filter((s) => scriptVisibility(s) === "released");
  if (!released.length) return [];
  // The same words the topic bank shows (one renderer, version-exact), else the stored body.
  const { portalTopicScript } = await import("@/lib/portal");
  const out: PortalLateScript[] = [];
  for (const s of released) {
    const v = s.topicId ? await portalTopicScript(enrollment, s.topicId).catch(() => null) : null;
    out.push({ topicId: s.topicId, title: v?.title ?? s.title, body: v && !v.historical ? v.body : s.body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE MESSAGE (copy only)
// ---------------------------------------------------------------------------

/** How the host month will be planned, in the message's terms. */
function hostPlanningOf(d: { planningMode: string; strategyCallStatus: string; callMode: string; clientPlanned: boolean }, chosenBy: string | null, noCallEligible: boolean): HostPlanning {
  if (d.clientPlanned) return "CLIENT_PLANNED";
  if (d.planningMode === "WRITTEN") return chosenBy?.startsWith("office:") ? "OFFICE" : "TOPICS";
  if (d.strategyCallStatus === "COMPLETED") return "PLANNED";
  if (d.strategyCallStatus === "SCHEDULED") return "CALL_BOOKED";
  if (d.planningMode === "UNDECIDED" && noCallEligible) return "CHOOSE";
  return "CALL_TO_BOOK";
}

/**
 * Jordan's message to the client, filled in with their portal link. The
 * enrollment's own page link first (it lasts — a text sent this afternoon
 * still opens tonight); a one-time sign-in link only when there is none.
 * Sends nothing.
 */
export async function lateSessionCopy(lateMonthId: string, byAppUserId: string | null, opts: { now?: Date } = {}): Promise<{ body: string; url: string; kind: "login" | "token" }> {
  const now = opts.now ?? new Date();
  const m = await prisma.contentMonth.findUnique({ where: { id: lateMonthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true } });
  if (!m) throw new Error("That month is no longer on file.");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { id: true, clientId: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true, overridesJson: true, noCallEligible: true } });
  const rec = e ? lateSessionOf(e.overridesJson, m.monthKey) : null;
  if (!e || !rec) throw new Error(`${name(m.monthKey)}'s session isn't being booked late.`);
  const { resolvePortalLink } = await import("@/lib/programReminders");
  const seat = await prisma.clientMembership.findFirst({ where: { enrollmentId: e.id, revokedAt: null, role: "OWNER" }, orderBy: { invitedAt: "asc" }, select: { id: true, clientUserId: true } });
  const link = (await resolvePortalLink(e, null, byAppUserId, now))
    ?? (seat ? await resolvePortalLink(e, { membershipId: seat.id, clientUserId: seat.clientUserId }, byAppUserId, now) : null);
  if (!link) throw new Error("No portal link exists for this client yet (no seat, no page link). Make one with “Client portal link” first.");
  const [client, seatUser, st, hostCap, hostRecalc, hostRow] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    seat ? prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { name: true } }) : Promise.resolve(null),
    lateMonthState(m.id, m.clientId, now),
    import("@/lib/sessionRequests").then((x) => x.sessionCapacity(e.id, rec.hostMonthId, { now })),
    recalcProgramMonth(rec.hostMonthId, { now, dryRun: true }),
    prisma.contentMonth.findUnique({ where: { id: rec.hostMonthId }, select: { planningChosenBy: true } }),
  ]);
  const d = hostRecalc?.after;
  const hostPlanning: HostPlanning = d ? hostPlanningOf({ planningMode: d.planningMode, strategyCallStatus: d.strategyCallStatus, callMode: d.callMode, clientPlanned: d.clientPlanned }, hostRow?.planningChosenBy ?? null, d.callMode === "OPTIONAL_WRITTEN" && e.noCallEligible !== false) : "CALL_TO_BOOK";
  const firstName = (seatUser?.name || client?.name || "").trim().split(/\s+/)[0] || null;
  const body = composeMessage({
    firstName, lateMonthKey: rec.lateMonthKey, hostMonthKey: rec.hostMonthKey, link: link.url,
    lateState: st.state, hostSessionBooked: hostCap.remaining <= 0, hostPlanning,
  });
  return { body, url: link.url, kind: link.kind };
}
