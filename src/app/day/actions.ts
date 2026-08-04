"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth/guards";
import { etDayKey, etEndOfDay } from "@/lib/datetime";
import { buildDayPlan, ownerMemberId, etInstant } from "@/lib/ownerDay";
import { createBlock, updateBlock, deleteBlock, CalendarNotConnected } from "@/lib/integrations/googleCalendar";
import { scanMeetTranscripts, parseProposed } from "@/lib/meetings";
import { runHubAgent } from "@/lib/integrations/ai";
import { DAY_TOOLS, daySystem, execDayTool, proposalsFrom, type DayProposal } from "@/lib/dayTools";

// Owner-only throughout: this is one person's private list, and the guard is
// what keeps it out of the shared ops queue in both directions.

export type QuickAddInput = {
  title: string;
  notes?: string;
  priority?: string; // NOW | NEXT | LATER
  energy?: string; // DEEP | SHALLOW
  estimateMin?: number;
  dueAt?: string | null; // yyyy-mm-dd
  planToday?: boolean;
  projectId?: string | null;
  clientId?: string | null;
  commLogId?: string | null;
  gmailThreadId?: string | null;
  gmailMailbox?: string | null;
  sourceNote?: string | null;
};

const PRIORITIES = new Set(["NOW", "NEXT", "LATER"]);
const ENERGIES = new Set(["DEEP", "SHALLOW"]);

export async function addOwnerTodo(input: QuickAddInput): Promise<{ id?: string; error?: string }> {
  await requireOwner();
  const title = (input.title ?? "").trim();
  if (!title) return { error: "Give it a name." };

  const priority = PRIORITIES.has(input.priority ?? "") ? input.priority! : "NEXT";
  const energy = ENERGIES.has(input.energy ?? "") ? input.energy! : "SHALLOW";
  const estimateMin = Math.min(Math.max(Number(input.estimateMin) || 30, 5), 480);
  // 5pm Eastern on that day. A bare "…T17:00:00Z" would be 1pm ET in summer and
  // noon in winter — the day still lands right, but the time on the card lies.
  const due = input.dueAt && /^\d{4}-\d{2}-\d{2}$/.test(input.dueAt) ? etEndOfDay(input.dueAt) : null;

  const row = await prisma.ownerTodo.create({
    data: {
      title: title.slice(0, 200),
      notes: input.notes?.trim()?.slice(0, 2000) || null,
      priority,
      energy,
      estimateMin,
      dueAt: due,
      // "NOW" means today by definition — no second decision about when.
      plannedFor: input.planToday || priority === "NOW" ? etDayKey(new Date()) : null,
      projectId: input.projectId || null,
      clientId: input.clientId || null,
      commLogId: input.commLogId || null,
      gmailThreadId: input.gmailThreadId || null,
      gmailMailbox: input.gmailMailbox || null,
      sourceNote: input.sourceNote?.slice(0, 300) || null,
    },
    select: { id: true },
  });
  revalidatePath("/day");
  return { id: row.id };
}

/**
 * Take the block off the calendar and out of the row, in that order.
 *
 * Called whenever a to-do stops needing its time — finished, dropped, or moved
 * to another day. Leaving the event behind is the failure that matters: Calendly
 * would go on refusing bookings for work that is already done.
 *
 * Best-effort by design. If Google is unreachable the local fields are still
 * cleared, because a to-do you can't complete because an API is down is worse
 * than a stale event you can delete by hand.
 */
async function releaseBlock(id: string): Promise<void> {
  const row = await prisma.ownerTodo.findUnique({
    where: { id },
    select: { calendarEventId: true },
  });
  if (row?.calendarEventId) {
    try {
      await deleteBlock(row.calendarEventId);
    } catch {
      /* keep going — the row must not get stuck behind Google */
    }
  }
  await prisma.ownerTodo.update({
    where: { id },
    data: { calendarEventId: null, blockStart: null, blockEnd: null },
  });
}

export async function completeOwnerTodo(id: string, done = true): Promise<void> {
  await requireOwner();
  await prisma.ownerTodo.update({
    where: { id },
    data: { status: done ? "DONE" : "OPEN", doneAt: done ? new Date() : null },
  });
  if (done) await releaseBlock(id);
  revalidatePath("/day");
}

export async function dropOwnerTodo(id: string): Promise<void> {
  await requireOwner();
  await prisma.ownerTodo.update({ where: { id }, data: { status: "DROPPED", doneAt: new Date() } });
  await releaseBlock(id);
  revalidatePath("/day");
}

/**
 * Put a finished (or dropped) to-do back on the list.
 *
 * Undoing a mis-tap has to be as cheap as the tap was, or the checkbox becomes
 * something you hesitate over. The calendar block is NOT restored — completing
 * it gave that hour back, and silently re-taking time on his calendar days later
 * would be a worse surprise than re-blocking it himself.
 */
export async function restoreOwnerTodo(id: string): Promise<{ ok: boolean }> {
  await requireOwner();
  const row = await prisma.ownerTodo.findUnique({ where: { id }, select: { plannedFor: true } });
  const today = etDayKey(new Date());
  await prisma.ownerTodo.update({
    where: { id },
    data: {
      status: "OPEN",
      doneAt: null,
      // A day that has already passed is not a plan. Clearing it puts the row
      // back in "not scheduled yet" rather than into a day that is over.
      ...(row?.plannedFor && row.plannedFor < today ? { plannedFor: null } : {}),
    },
  });
  revalidatePath("/day");
  return { ok: true };
}

/** Move a to-do onto (or off) a given ET day. Null clears the plan. */
export async function planOwnerTodo(id: string, dayKey: string | null): Promise<void> {
  await requireOwner();
  const valid = dayKey && /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : null;
  const before = await prisma.ownerTodo.findUnique({ where: { id }, select: { plannedFor: true } });
  await prisma.ownerTodo.update({ where: { id }, data: { plannedFor: valid } });
  // Any change of day invalidates the block — a held hour on Tuesday is wrong
  // the moment the work moves to Wednesday, and wrong is worse than absent.
  if (before?.plannedFor !== valid) await releaseBlock(id);
  revalidatePath("/day");
}

export async function updateOwnerTodo(
  id: string,
  patch: { priority?: string; energy?: string; estimateMin?: number; title?: string; notes?: string | null },
): Promise<void> {
  await requireOwner();
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title.trim().slice(0, 200);
  if (patch.notes !== undefined) data.notes = patch.notes?.trim()?.slice(0, 2000) || null;
  if (patch.priority && PRIORITIES.has(patch.priority)) data.priority = patch.priority;
  if (patch.energy && ENERGIES.has(patch.energy)) data.energy = patch.energy;
  if (patch.estimateMin !== undefined) data.estimateMin = Math.min(Math.max(Number(patch.estimateMin) || 30, 5), 480);
  if (Object.keys(data).length === 0) return;
  await prisma.ownerTodo.update({ where: { id }, data });
  revalidatePath("/day");
}

// ---------------------------------------------------------------------------
// CALENDAR BLOCKING.
//
// Blocks go on the PRIMARY calendar deliberately: Calendly reads that calendar
// to decide when Jordan is bookable, so a block anywhere else would not stop a
// client booking straight over his focus time.
//
// Every block is written once and then PINNED — the planner holds it at the
// time it was given rather than re-deriving it. Without that, the plan would
// drift a few minutes on every render and the hub would spend the day rewriting
// events in Google. It moves when he moves it, and not otherwise.
// ---------------------------------------------------------------------------

/** Push today's plan onto the calendar. Idempotent: already-blocked rows are skipped. */
export async function blockDayOnCalendar(
  dayKey: string,
): Promise<{ created: number; failed: number; error?: string }> {
  await requireOwner();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { created: 0, failed: 0, error: "Bad day." };

  const plan = await buildDayPlan(dayKey, { memberId: await ownerMemberId() });
  // Pinned rows already hold the right hour and must not be touched. Everything
  // else needs writing — including the rare row that carries an event id but no
  // pinned time (a crash between the Google write and the database write): that
  // one gets PATCHED to the planned time rather than duplicated.
  const todo = plan.planned.filter((p) => !p.pinned);
  if (todo.length === 0) return { created: 0, failed: 0 };

  const existing = new Map(
    (
      await prisma.ownerTodo.findMany({
        where: { id: { in: todo.map((p) => p.id) } },
        select: { id: true, calendarEventId: true },
      })
    ).map((r) => [r.id, r.calendarEventId]),
  );

  let created = 0;
  let failed = 0;
  for (const p of todo) {
    try {
      const stale = existing.get(p.id);
      let eventId: string;
      if (stale) {
        await updateBlock(stale, { start: p.start, end: p.end, title: p.title });
        eventId = stale;
      } else {
        eventId = await createBlock({ todoId: p.id, title: p.title, start: p.start, end: p.end });
      }
      await prisma.ownerTodo.update({
        where: { id: p.id },
        data: { calendarEventId: eventId, blockStart: p.start, blockEnd: p.end },
      });
      created++;
    } catch (e) {
      // Not connected is a whole-run problem, not a per-row one — stop rather
      // than hammering Google once per to-do with a token that cannot work.
      if (e instanceof CalendarNotConnected) {
        revalidatePath("/day");
        return { created, failed, error: e.message };
      }
      failed++;
    }
  }
  revalidatePath("/day");
  return { created, failed };
}

/**
 * Move one block to a new time. Writes the same change to Google.
 *
 * Takes an ET day plus a wall-clock "09:30" rather than an instant: the browser
 * shows Eastern regardless of where it is, so it must not be the thing that
 * decides what "9:30" means.
 */
export async function rescheduleBlock(
  id: string,
  dayKey: string,
  hhmm: string,
  minutes?: number,
): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { ok: false, error: "Bad day." };
  const start = etInstant(dayKey, hhmm);
  if (!start) return { ok: false, error: "Bad time." };

  const row = await prisma.ownerTodo.findUnique({
    where: { id },
    select: { title: true, estimateMin: true, calendarEventId: true },
  });
  if (!row) return { ok: false, error: "Gone." };

  const len = Math.min(Math.max(minutes ?? row.estimateMin, 5), 480);
  const end = new Date(start.getTime() + len * 60_000);

  try {
    if (row.calendarEventId) {
      await updateBlock(row.calendarEventId, { start, end, title: row.title });
    } else {
      const eventId = await createBlock({ todoId: id, title: row.title, start, end });
      await prisma.ownerTodo.update({ where: { id }, data: { calendarEventId: eventId } });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't update the calendar." };
  }

  await prisma.ownerTodo.update({
    where: { id },
    // The block IS the plan for this row now, so keep the day in step with it.
    data: { blockStart: start, blockEnd: end, plannedFor: etDayKey(start), estimateMin: len },
  });
  revalidatePath("/day");
  return { ok: true };
}

/** Take one block off the calendar. The to-do stays; only the held time goes. */
export async function unblockTodo(id: string): Promise<{ ok: boolean }> {
  await requireOwner();
  await releaseBlock(id);
  revalidatePath("/day");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MEETING RECAPS.
//
// One card, many proposed items, nothing created until Accept. He can drop the
// ones he doesn't want first — the whole point of a review step is that it can
// say no.
// ---------------------------------------------------------------------------

/** Pull this month's Meet transcripts into review cards. */
export async function scanMeetings(): Promise<{ created: number; found: number; error?: string }> {
  await requireOwner();
  try {
    const r = await scanMeetTranscripts();
    revalidatePath("/day");
    return { created: r.created, found: r.found };
  } catch (e) {
    return { created: 0, found: 0, error: e instanceof Error ? e.message : "Couldn't read Drive." };
  }
}

/**
 * Accept a recap: mint the chosen action items as real to-dos.
 *
 * `skip` carries the indexes he unticked, so accepting is one tap when the list
 * is right and still precise when it isn't.
 */
export async function acceptMeeting(id: string, skip: number[] = []): Promise<{ created: number; error?: string }> {
  await requireOwner();
  const meeting = await prisma.ownerMeeting.findUnique({
    where: { id },
    select: { id: true, title: true, heldAt: true, proposed: true, status: true },
  });
  if (!meeting) return { created: 0, error: "Gone." };
  if (meeting.status === "ACCEPTED") return { created: 0, error: "Already accepted." };

  const drop = new Set(skip);
  const items = parseProposed(meeting.proposed).filter((_, i) => !drop.has(i));

  if (items.length > 0) {
    await prisma.ownerTodo.createMany({
      data: items.map((it) => ({
        title: String(it.title ?? "").slice(0, 200) || "Follow up",
        notes: String(it.notes ?? "").slice(0, 2000) || null,
        priority: "NEXT",
        energy: it.energy === "DEEP" ? "DEEP" : "SHALLOW",
        estimateMin: Math.min(Math.max(Number(it.estimateMin) || 30, 5), 480),
        // Deadlines are counted from when the meeting HAPPENED, not from when
        // he got round to reviewing it — a week is a week from the promise. The
        // result lands at 5pm Eastern like every other due date, rather than
        // inheriting whatever time of day the call happened to start.
        dueAt: etEndOfDay(
          etDayKey(new Date(meeting.heldAt.getTime() + Math.max(Number(it.dueInDays) || 7, 0) * 86_400_000)),
        ),
        sourceNote: `From the ${meeting.title} call`.slice(0, 300),
        meetingId: meeting.id,
      })),
    });
  }

  await prisma.ownerMeeting.update({
    where: { id },
    data: { status: "ACCEPTED", reviewedAt: new Date() },
  });
  revalidatePath("/day");
  return { created: items.length };
}

/** Not worth any to-dos. The recap stays readable; it just leaves the queue. */
export async function dismissMeeting(id: string): Promise<void> {
  await requireOwner();
  await prisma.ownerMeeting.update({
    where: { id },
    data: { status: "DISMISSED", reviewedAt: new Date() },
  });
  revalidatePath("/day");
}

/** Add one more item to a recap by hand before accepting it. */
export async function addMeetingItem(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const clean = title.trim();
  if (!clean) return { ok: false, error: "Give it a name." };
  const meeting = await prisma.ownerMeeting.findUnique({ where: { id }, select: { proposed: true } });
  if (!meeting) return { ok: false, error: "Gone." };
  const items = parseProposed(meeting.proposed);
  items.push({ title: clean.slice(0, 200), notes: "Added by hand", dueInDays: 7, energy: "SHALLOW", estimateMin: 30 });
  await prisma.ownerMeeting.update({ where: { id }, data: { proposed: JSON.stringify(items) } });
  revalidatePath("/day");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// THE DAY ASSISTANT.
//
// It works on Jordan's own list directly, and can only ever PROPOSE anything
// that reaches Kyle. The two send paths below are separate actions fired by his
// click — the model has no route to either.
// ---------------------------------------------------------------------------

export type DayChatTurn = { role: "user" | "assistant"; content: string };

export async function askMyDay(
  question: string,
  history: DayChatTurn[] = [],
): Promise<{ answer: string; proposals: DayProposal[]; error?: string }> {
  await requireOwner();
  const q = question.trim();
  if (!q) return { answer: "", proposals: [], error: "Ask me something." };

  try {
    const { answer, toolsUsed } = await runHubAgent({
      system: daySystem(),
      // Enough to follow a thread, not enough to drown the context.
      history: history.slice(-8).map((h) => ({ role: h.role, content: h.content.slice(0, 4000) })),
      question: q.slice(0, 4000),
      tools: DAY_TOOLS,
      exec: execDayTool,
      maxSteps: 8,
      maxTokens: 1600,
    });
    revalidatePath("/day");
    return { answer, proposals: proposalsFrom(toolsUsed) };
  } catch (e) {
    return { answer: "", proposals: [], error: e instanceof Error ? e.message : "The assistant is unavailable." };
  }
}

/** Jordan pressed Send on a drafted Slack message. Only his click reaches Kyle. */
export async function sendSlackToKyle(text: string): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const body = text.trim();
  if (!body) return { ok: false, error: "Nothing to send." };
  const { opsAlert } = await import("@/lib/notify");
  const sent = await opsAlert(body.slice(0, 3000));
  return sent ? { ok: true } : { ok: false, error: "Slack didn't accept it — check the connection." };
}

/** Jordan pressed Create on a drafted task for Kyle's queue. */
export async function createTaskForKyle(input: {
  title: string;
  detail?: string;
  dueDate?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  await requireOwner();
  const title = input.title.trim();
  if (!title) return { ok: false, error: "A task needs a title." };
  const kyle = await prisma.teamMember.findFirst({
    where: { name: { contains: "Kyle" }, active: true },
    select: { id: true },
  });
  const row = await prisma.smartTask.create({
    data: {
      taskType: "internal_instruction",
      title: title.slice(0, 140),
      summary: (input.detail || `From Jordan's day assistant: ${title}`).slice(0, 500),
      description: input.detail || null,
      reasonCreated: "Asked for by Jordan on My Day",
      source: "assistant",
      priority: "MEDIUM",
      dueAt: input.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? etEndOfDay(input.dueDate) : null,
      ownerId: kyle?.id ?? null,
    },
    select: { id: true },
  });
  try {
    const { opsAlert } = await import("@/lib/notify");
    await opsAlert(`📋 Jordan added a task for you: “${title}”`);
  } catch { /* the task is what matters */ }
  revalidatePath("/day");
  return { ok: true, id: row.id };
}

/** Search projects to attach a to-do to — used by the quick-add box. */
export async function searchProjectsForTodo(q: string): Promise<{ id: string; label: string }[]> {
  await requireOwner();
  const term = q.trim();
  if (term.length < 2) return [];
  const rows = await prisma.project.findMany({
    where: { OR: [{ title: { contains: term, mode: "insensitive" } }, { client: { name: { contains: term, mode: "insensitive" } } }] },
    select: { id: true, title: true, client: { select: { name: true } } },
    orderBy: { shootDate: "desc" },
    take: 8,
  });
  return rows.map((r) => ({ id: r.id, label: `${(r.title || "").split(",")[0]}${r.client?.name ? ` · ${r.client.name}` : ""}` }));
}
