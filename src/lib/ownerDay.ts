import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";
import { listCalendarEvents, type CalEvent } from "@/lib/integrations/googleCalendar";

// ---------------------------------------------------------------------------
// THE DAY PLAN.
//
// The job of this file is to answer one question — "what am I doing next?" —
// so that answering it never costs a decision. Everything here is built to
// remove choices, not add them:
//
//  · The day has a SHAPE that does not change: 8:00-17:00 ET, mornings
//    protected for deep work, afternoons for admin and calls. A fixed shape
//    means the plan is never a blank page.
//  · Real commitments win. Shoots come off the Appointment table and are
//    immovable; to-dos fill what is left, never the reverse.
//  · Travel and recovery are REAL time. A shoot is not just its hour — it is
//    the drive there, the shoot, the drive back, and a beat afterwards. Slotting
//    work into a gap that is actually a commute is how a plan stops being
//    trusted, so gaps are shrunk by a buffer before anything is placed in them.
//  · Deep work goes to the morning, and only as much as actually fits. Better
//    to under-commit the day and finish it than to write a wish list.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 17;
// Deep work is protected until this hour. After it, the day is for shallow work.
const DEEP_UNTIL_HOUR = 12;
// Padding either side of something you have to physically GO to: the drive
// there, and the drive back.
const TRAVEL_BUFFER_MIN = 30;
// A video call or a phone call costs no drive time, but it does cost a few
// minutes on the other side to write the notes down and change gear.
const RECOVERY_BUFFER_MIN = 10;
// A gap shorter than this is not workable time — it is a coffee.
const MIN_USABLE_GAP_MIN = 20;

export type FixedBlock = {
  kind: "shoot" | "meeting";
  title: string;
  where: string | null;
  start: Date;
  end: Date;
  projectId: string | null;
  /** Padded bounds — what the day planner must actually keep clear. */
  guardStart: Date;
  guardEnd: Date;
  /** No drive time needed — a Meet link or a phone call. */
  virtual: boolean;
  /** Minutes held either side, so the UI can explain itself honestly. */
  bufferBeforeMin: number;
  bufferAfterMin: number;
};

type Interval = { start: Date; end: Date };

export type PlannedTodo = {
  id: string;
  title: string;
  energy: string;
  estimateMin: number;
  priority: string;
  start: Date;
  end: Date;
  projectId: string | null;
  onCalendar: boolean;
  /** Held at this exact time because it already exists on Google Calendar. */
  pinned?: boolean;
};

export type DayPlan = {
  dayKey: string;
  dayStart: Date;
  dayEnd: Date;
  fixed: FixedBlock[];
  planned: PlannedTodo[];
  /** Wanted a slot today and could not get one — shown so nothing vanishes. */
  unplaced: { id: string; title: string; estimateMin: number; energy: string }[];
  /** A block already on Google that something real has since landed on top of. */
  conflicts: { id: string; title: string; clashesWith: string }[];
  freeMinutes: number;
  deepMinutesFree: number;
  /** True when the day is so full that planning more is a lie. */
  fullyBooked: boolean;
  /** False when Google Calendar couldn't be read — the plan sees shoots only. */
  calendarOk: boolean;
  /** Google's own words for why, so the fix shown matches the actual problem. */
  calendarError: string | null;
};

function atHour(dayKey: string, hour: number): Date {
  // ET-anchored: etDayStartUtc gives midnight ET as a UTC instant, and the day's
  // hours are offsets from it. Hand-rolling this with local time is the bug that
  // has bitten every date helper in this codebase.
  return new Date(etDayStartUtc(new Date(`${dayKey}T12:00:00Z`)).getTime() + hour * 60 * MIN);
}

/**
 * A wall-clock ET time on a given day, as a real instant.
 *
 * Used when the browser hands back "09:30" from a time picker: the conversion
 * happens HERE, on a server that knows the day is Eastern, rather than in a
 * browser that might be anywhere. Working hours never straddle the 2am DST
 * shift, so the offset-from-midnight arithmetic is safe.
 */
export function etInstant(dayKey: string, hhmm: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return new Date(atHour(dayKey, h).getTime() + min * MIN);
}

/** How much a meeting really costs, either side of the time on the invite. */
function buffersFor(e: { virtual: boolean; where: string | null }): { before: number; after: number } {
  // Somewhere to drive to: hold the drive on both ends.
  if (!e.virtual && e.where) return { before: TRAVEL_BUFFER_MIN, after: TRAVEL_BUFFER_MIN };
  // A call: nothing before, a short beat after to write it down. An event with
  // no location and no link is treated as a call — the cautious read, since
  // over-holding an hour a day for a phone call is its own kind of wrong.
  return { before: 0, after: RECOVERY_BUFFER_MIN };
}

const overlapMs = (a: Interval, b: Interval) =>
  Math.max(0, Math.min(a.end.getTime(), b.end.getTime()) - Math.max(a.start.getTime(), b.start.getTime()));

/**
 * The immovable things on a given ET day: shoots off the Appointment table, and
 * real meetings off the owner's Google Calendar.
 *
 * The calendar is best-effort on purpose — if Google isn't connected (or the
 * token predates the calendar scope), the day still plans around shoots rather
 * than failing. `calendarOk` tells the UI which of the two it is looking at, so
 * a plan built with half the picture never silently claims to be complete.
 */
export async function fixedBlocksFor(
  dayKey: string,
  opts?: { memberId?: string | null },
): Promise<{ blocks: FixedBlock[]; calendarOk: boolean; calendarError: string | null }> {
  const start = atHour(dayKey, 0);
  const end = new Date(start.getTime() + 24 * 60 * MIN);

  const [appts, cal] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        startAt: { gte: start, lt: end },
        ...(opts?.memberId ? { assignedToId: opts.memberId } : {}),
      },
      select: {
        startAt: true,
        endAt: true,
        project: { select: { id: true, title: true, addressLine: true } },
        status: true,
      },
      orderBy: { startAt: "asc" },
    }),
    listCalendarEvents(start, end).then(
      (items) => ({ ok: true, items, error: null as string | null }),
      // Keep Google's own wording. "Reconnect Google" is the right advice for a
      // scope problem and the WRONG advice for an API that's switched off in
      // Cloud Console — one generic message would send him round the consent
      // screen on a problem consent cannot fix.
      (e: unknown) => ({
        ok: false,
        items: [] as CalEvent[],
        error: e instanceof Error ? e.message : "Couldn't read Google Calendar.",
      }),
    ),
  ]);

  const shoots: FixedBlock[] = appts
    .filter((a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt)
    .map((a) => {
      const s = a.startAt!;
      // Aryeo does not always carry an end time; a shoot is ~90 minutes.
      const e = a.endAt && a.endAt > s ? a.endAt : new Date(s.getTime() + 90 * MIN);
      return {
        kind: "shoot" as const,
        title: (a.project?.title || "Shoot").split(",")[0].trim(),
        where: a.project?.addressLine ?? null,
        start: s,
        end: e,
        projectId: a.project?.id ?? null,
        guardStart: new Date(s.getTime() - TRAVEL_BUFFER_MIN * MIN),
        guardEnd: new Date(e.getTime() + TRAVEL_BUFFER_MIN * MIN),
        virtual: false,
        bufferBeforeMin: TRAVEL_BUFFER_MIN,
        bufferAfterMin: TRAVEL_BUFFER_MIN,
      };
    });

  const meetings: FixedBlock[] = [];
  for (const e of cal.items) {
    // All-day rows are context (a holiday, a trip), not an hour of the day.
    if (e.allDay) continue;
    // Our own focus blocks are the OUTPUT of this planner. Counting them as
    // fixed commitments would make the plan double-book itself against itself.
    if (e.ours) continue;
    // The same shoot often lives in both Aryeo and Google. Whichever we drop,
    // keep the Aryeo one — it carries the project link and the real address.
    const dupe = shoots.some((s) => {
      const shorter = Math.min(s.end.getTime() - s.start.getTime(), e.end.getTime() - e.start.getTime());
      return shorter > 0 && overlapMs(s, e) >= shorter * 0.5;
    });
    if (dupe) continue;

    const { before, after } = buffersFor(e);
    meetings.push({
      kind: "meeting",
      title: e.title,
      where: e.where,
      start: e.start,
      end: e.end,
      projectId: null,
      guardStart: new Date(e.start.getTime() - before * MIN),
      guardEnd: new Date(e.end.getTime() + after * MIN),
      virtual: e.virtual,
      bufferBeforeMin: before,
      bufferAfterMin: after,
    });
  }

  const blocks = [...shoots, ...meetings].sort((a, b) => a.start.getTime() - b.start.getTime());
  return { blocks, calendarOk: cal.ok, calendarError: cal.error };
}

/** Free windows inside the working day, once the given busy spans are removed. */
function openWindows(dayStart: Date, dayEnd: Date, busy: Interval[]): Interval[] {
  const guards = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());

  const out: Interval[] = [];
  let cursor = dayStart;
  for (const g of guards) {
    if (g.end <= cursor) continue; // already behind us (or overlapping)
    if (g.start > cursor) out.push({ start: cursor, end: new Date(Math.min(g.start.getTime(), dayEnd.getTime())) });
    cursor = new Date(Math.max(cursor.getTime(), g.end.getTime()));
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) out.push({ start: cursor, end: dayEnd });
  return out.filter((w) => w.end.getTime() - w.start.getTime() >= MIN_USABLE_GAP_MIN * MIN);
}

/**
 * Lay today's to-dos into the gaps around real commitments.
 *
 * Deep work is placed first and only into the protected morning; shallow work
 * takes whatever is left. Anything that does not fit is returned as `unplaced`
 * rather than crammed in — a plan you cannot finish is the thing that stops
 * getting opened.
 */
export async function buildDayPlan(dayKey: string, opts?: { memberId?: string | null }): Promise<DayPlan> {
  const dayStart = atHour(dayKey, DAY_START_HOUR);
  const dayEnd = atHour(dayKey, DAY_END_HOUR);
  const deepUntil = atHour(dayKey, DEEP_UNTIL_HOUR);

  const [{ blocks: fixed, calendarOk, calendarError }, todos] = await Promise.all([
    fixedBlocksFor(dayKey, opts),
    prisma.ownerTodo.findMany({
      where: { status: "OPEN", plannedFor: dayKey },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, title: true, energy: true, estimateMin: true, priority: true,
        projectId: true, blockStart: true, blockEnd: true, calendarEventId: true,
      },
    }),
  ]);

  // A to-do that is already ON the calendar keeps the time it was given. Left to
  // re-derive its slot every render, the plan would drift a few minutes each
  // time and we'd be rewriting Google events all day. Pinned once, then stable —
  // it only moves when Jordan moves it.
  const pinned = todos.filter(
    (t): t is typeof t & { blockStart: Date; blockEnd: Date } =>
      !!t.blockStart && !!t.blockEnd && t.blockEnd > t.blockStart && etDayKey(t.blockStart) === dayKey,
  );
  const pinnedIds = new Set(pinned.map((t) => t.id));

  const guards: Interval[] = fixed.map((f) => ({ start: f.guardStart, end: f.guardEnd }));
  const windows = openWindows(dayStart, dayEnd, [
    ...guards,
    ...pinned.map((t) => ({ start: t.blockStart, end: t.blockEnd })),
  ]);
  const freeMinutes = Math.round(windows.reduce((s, w) => s + (w.end.getTime() - w.start.getTime()), 0) / MIN);
  const deepMinutesFree = Math.round(
    windows.reduce((s, w) => {
      const end = new Date(Math.min(w.end.getTime(), deepUntil.getTime()));
      return s + Math.max(0, end.getTime() - w.start.getTime());
    }, 0) / MIN,
  );

  // Deep first (it needs the scarce protected hours), then everything else.
  const order = [...todos].filter((t) => !pinnedIds.has(t.id)).sort((a, b) => {
    const deep = (t: typeof a) => (t.energy === "DEEP" ? 0 : 1);
    if (deep(a) !== deep(b)) return deep(a) - deep(b);
    const rank: Record<string, number> = { NOW: 0, NEXT: 1, LATER: 2 };
    return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
  });

  const cursors = windows.map((w) => ({ ...w, at: w.start }));
  const planned: PlannedTodo[] = [];
  const unplaced: DayPlan["unplaced"] = [];
  const conflicts: DayPlan["conflicts"] = [];

  // Pinned blocks go in at their own times, untouched.
  for (const t of pinned) {
    planned.push({
      id: t.id,
      title: t.title,
      energy: t.energy,
      estimateMin: t.estimateMin,
      priority: t.priority,
      start: t.blockStart,
      end: t.blockEnd,
      projectId: t.projectId,
      onCalendar: !!t.calendarEventId,
      pinned: true,
    });
    // Something real landed on top of a block we'd already written — usually a
    // Calendly booking. Say so; never quietly move a block that exists in
    // Google, because the hub and his calendar would then disagree.
    const clash = fixed.find((f) => overlapMs({ start: t.blockStart, end: t.blockEnd }, f) > 0);
    if (clash) conflicts.push({ id: t.id, title: t.title, clashesWith: clash.title });
  }

  for (const t of order) {
    const need = Math.max(t.estimateMin, 15) * MIN;
    // Deep work may only be placed before the deep-work cutoff.
    const limit = t.energy === "DEEP" ? deepUntil : dayEnd;
    const slot = cursors.find((c) => c.at.getTime() + need <= Math.min(c.end.getTime(), limit.getTime()));
    if (!slot) {
      unplaced.push({ id: t.id, title: t.title, estimateMin: t.estimateMin, energy: t.energy });
      continue;
    }
    const start = slot.at;
    const end = new Date(start.getTime() + need);
    slot.at = end;
    planned.push({
      id: t.id,
      title: t.title,
      energy: t.energy,
      estimateMin: t.estimateMin,
      priority: t.priority,
      start,
      end,
      projectId: t.projectId,
      onCalendar: !!t.calendarEventId,
    });
  }

  planned.sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    dayKey,
    dayStart,
    dayEnd,
    fixed,
    planned,
    unplaced,
    conflicts,
    freeMinutes,
    deepMinutesFree,
    fullyBooked: freeMinutes < MIN_USABLE_GAP_MIN,
    calendarOk,
    calendarError,
  };
}

/**
 * Which TeamMember the plan should treat as "me".
 *
 * The day is planned around the shoots JORDAN is shooting, not the whole team's
 * calendar — someone else's 9am is not a commitment he has to work around. Both
 * the page and the calendar actions resolve it the same way so the plan on
 * screen and the plan written to Google can never be built from different days.
 */
export async function ownerMemberId(loginMemberId?: string | null): Promise<string | null> {
  if (loginMemberId) return loginMemberId;
  const row = await prisma.teamMember.findFirst({
    where: { name: { contains: "Jordan" }, active: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** The lists either side of the plan: what is queued, and what is overdue. */
export async function ownerTodoLists() {
  const today = etDayKey(new Date());
  const [open, doneToday] = await Promise.all([
    prisma.ownerTodo.findMany({
      where: { status: "OPEN" },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      select: {
        id: true, title: true, notes: true, priority: true, energy: true, estimateMin: true,
        dueAt: true, plannedFor: true, projectId: true, clientId: true, commLogId: true,
        gmailThreadId: true, sourceNote: true, calendarEventId: true,
        project: { select: { id: true, title: true } },
        client: { select: { id: true, name: true } },
      },
      take: 200,
    }),
    prisma.ownerTodo.count({ where: { status: "DONE", doneAt: { gte: etDayStartUtc() } } }),
  ]);

  const overdue = open.filter((t) => t.dueAt && etDayKey(t.dueAt) < today);
  const todayList = open.filter((t) => t.plannedFor === today && !overdue.includes(t));
  const unscheduled = open.filter((t) => !t.plannedFor && !overdue.includes(t));
  const later = open.filter((t) => t.plannedFor && t.plannedFor > today && !overdue.includes(t));

  return { open, overdue, today: todayList, unscheduled, later, doneToday };
}

export const DAY_SHAPE = {
  startHour: DAY_START_HOUR,
  endHour: DAY_END_HOUR,
  deepUntilHour: DEEP_UNTIL_HOUR,
  bufferMin: TRAVEL_BUFFER_MIN,
};
