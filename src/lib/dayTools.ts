import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etEndOfDay, etDateTime } from "@/lib/datetime";
import { buildDayPlan, ownerTodoLists, ownerMemberId, calendarAhead } from "@/lib/ownerDay";
import { ownerPulse } from "@/lib/ownerPulse";
import type { HubTool } from "@/lib/integrations/ai";

// ---------------------------------------------------------------------------
// THE DAY ASSISTANT'S TOOLS.
//
// One rule shapes the whole set: it may do what it likes to JORDAN'S OWN list,
// and it may not touch anyone else without him pressing a button.
//
//  · His to-dos — add, edit, re-order, finish. It's his list; a plan you have to
//    ask permission to change isn't much of an assistant.
//  · Kyle — DRAFTS ONLY. `draft_slack_to_kyle` and `draft_task_for_kyle` return
//    proposed text and create nothing. The page turns them into buttons and
//    Jordan sends. Nothing reaches another person off the model's own say-so.
//  · Clients — nothing at all. There is no tool here that can reach a client,
//    by any route, deliberately.
// ---------------------------------------------------------------------------

export const DAY_TOOLS: HubTool[] = [
  {
    name: "my_day",
    description:
      "Today's actual schedule: shoots and meetings off the calendar, what's already planned into the gaps, how much free time is left, and anything that didn't fit. Start here for 'what should I do now' questions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "my_todos",
    description:
      "Jordan's full to-do list: overdue, planned for today, waiting to be scheduled, and later. Includes each one's id, energy (DEEP/SHALLOW), estimate, due date and what it's about.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "week_ahead",
    description: "The next 7 days of the calendar with free hours per day. Use when asked where something fits, or which day is clear.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "business_snapshot",
    description: "Revenue, profit, cash, what's owed, shoots this week, open team tasks. Context for 'what matters most' questions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_todo",
    description: "Add a to-do to Jordan's own list. Use when he asks you to remember or capture something.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Imperative and specific. Max 90 chars." },
        notes: { type: "string", description: "Context he'd otherwise have to remember." },
        priority: { type: "string", enum: ["NOW", "NEXT", "LATER"], description: "NOW=today, NEXT=this week, LATER=someday." },
        energy: { type: "string", enum: ["DEEP", "SHALLOW"], description: "DEEP needs the protected morning. SHALLOW is admin/calls." },
        estimateMin: { type: "number", description: "15, 30, 60 or 120." },
        dueDate: { type: "string", description: "YYYY-MM-DD, only if a real deadline was stated." },
        planToday: { type: "boolean", description: "Put it in today's plan." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_todo",
    description:
      "Change one of Jordan's to-dos: retitle, re-prioritise, change how long it needs, mark it DEEP or SHALLOW, or move it to a different day. Use the id from my_todos. This is how you re-order his day when he asks you to prioritise.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string", enum: ["NOW", "NEXT", "LATER"] },
        energy: { type: "string", enum: ["DEEP", "SHALLOW"] },
        estimateMin: { type: "number" },
        plannedFor: { type: "string", description: "ET day YYYY-MM-DD, or the word 'none' to take it off the schedule." },
        dueDate: { type: "string", description: "YYYY-MM-DD, or 'none' to clear." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_todo",
    description: "Mark one of Jordan's to-dos finished. Only when he says it's done — never because it looks done.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_job",
    description:
      "Search jobs by street, town, client name or job title. Searches the town separately from the street, so 'West Chester' finds jobs there even when the street line doesn't name the town. If you're looking for a shoot on a particular DAY, call my_day or week_ahead instead — those carry the schedule.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        upcomingOnly: { type: "boolean", description: "Only jobs not yet delivered. Default false." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_slack_to_kyle",
    description:
      "DRAFT a Slack message to Kyle. This sends NOTHING — it puts a Send button in front of Jordan with your text in it. Write it as Jordan would: direct, warm, no corporate padding. Use whenever he wants to tell Kyle something.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message itself, ready to send. No greeting boilerplate." },
        why: { type: "string", description: "One short line on what this is for." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_task_for_kyle",
    description:
      "DRAFT a task for Kyle's queue. Creates NOTHING — Jordan gets a Create button. Use when the work belongs to Kyle rather than Jordan.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Imperative. Max 120 chars." },
        detail: { type: "string", description: "What Kyle needs to know to do it without asking." },
        dueDate: { type: "string", description: "YYYY-MM-DD if there's a real deadline." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
  Math.min(Math.max(Number(n) || dflt, lo), hi);
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Proposals the model made that need Jordan to press a button. */
export type DayProposal =
  | { kind: "slack"; text: string; why?: string }
  | { kind: "task"; title: string; detail?: string; dueDate?: string };

export async function execDayTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const today = etDayKey(new Date());

  switch (name) {
    case "my_day": {
      const plan = await buildDayPlan(today, { memberId: await ownerMemberId() });
      return {
        date: today,
        nowEt: etDateTime(new Date()),
        freeMinutes: plan.freeMinutes,
        deepMinutesFree: plan.deepMinutesFree,
        calendarConnected: plan.calendarOk,
        commitments: plan.fixed.map((f) => ({
          what: f.title,
          kind: f.kind,
          from: etDateTime(f.start),
          to: etDateTime(f.end),
          where: f.where,
          driveHeldEachSideMin: f.bufferBeforeMin,
        })),
        planned: plan.planned.map((p) => ({
          id: p.id, title: p.title, from: etDateTime(p.start), to: etDateTime(p.end),
          energy: p.energy, onCalendar: p.onCalendar,
        })),
        didNotFit: plan.unplaced.map((u) => ({ id: u.id, title: u.title, needsMin: u.estimateMin })),
        doubleBooked: plan.conflicts,
      };
    }

    case "my_todos": {
      const l = await ownerTodoLists();
      const shape = (t: (typeof l.open)[number]) => ({
        id: t.id,
        title: t.title,
        notes: t.notes,
        priority: t.priority,
        energy: t.energy,
        estimateMin: t.estimateMin,
        due: t.dueAt ? etDayKey(t.dueAt) : null,
        plannedFor: t.plannedFor,
        about: t.project?.title ?? t.client?.name ?? null,
        source: t.sourceNote,
      });
      return {
        today: today,
        overdue: l.overdue.map(shape),
        plannedToday: l.today.map(shape),
        notScheduled: l.unscheduled.map(shape),
        later: l.later.map(shape),
        finishedToday: l.doneToday,
      };
    }

    case "week_ahead": {
      const { days } = await calendarAhead(7, { memberId: await ownerMemberId() });
      return days.map((d) => ({
        day: d.dayKey,
        isToday: d.isToday,
        weekend: d.isWeekend,
        freeHours: Math.round((d.freeMinutes / 60) * 10) / 10,
        alreadyPlanned: d.plannedCount,
        commitments: d.blocks.map((b) => `${etDateTime(b.start)} ${b.title}`),
      }));
    }

    case "business_snapshot": {
      const p = await ownerPulse();
      return {
        month: p.monthLabel,
        revenueThisMonth: p.revenueMonth,
        spendThisMonth: p.spendMonth,
        profitThisMonth: p.profitMonth,
        revenueThisYear: p.revenueYtd,
        bank: p.bankBalance,
        bankAccounts: p.bankLabel,
        owedToUs: p.owedToYou,
        unpaidJobs: p.owedCount,
        shootsThisWeek: p.shootsThisWeek,
        deliveredThisMonth: p.deliveredThisMonth,
        teamTasksOpen: p.openTasks,
        teamTasksOverdue: p.overdueTasks,
      };
    }

    case "add_todo": {
      const title = String(input.title ?? "").trim();
      if (!title) return { error: "A to-do needs a title." };
      const priority = ["NOW", "NEXT", "LATER"].includes(String(input.priority)) ? String(input.priority) : "NEXT";
      const row = await prisma.ownerTodo.create({
        data: {
          title: title.slice(0, 200),
          notes: input.notes ? String(input.notes).slice(0, 2000) : null,
          priority,
          energy: String(input.energy) === "DEEP" ? "DEEP" : "SHALLOW",
          estimateMin: clamp(input.estimateMin, 5, 480, 30),
          dueAt: isDay(input.dueDate) ? etEndOfDay(input.dueDate) : null,
          plannedFor: input.planToday === true || priority === "NOW" ? today : null,
          sourceNote: "Added from the day assistant",
        },
        select: { id: true, title: true, plannedFor: true },
      });
      return { added: row };
    }

    case "update_todo": {
      const id = String(input.id ?? "");
      if (!id) return { error: "Which to-do?" };
      const data: Record<string, unknown> = {};
      if (typeof input.title === "string" && input.title.trim()) data.title = input.title.trim().slice(0, 200);
      if (typeof input.notes === "string") data.notes = input.notes.slice(0, 2000) || null;
      if (["NOW", "NEXT", "LATER"].includes(String(input.priority))) data.priority = String(input.priority);
      if (["DEEP", "SHALLOW"].includes(String(input.energy))) data.energy = String(input.energy);
      if (input.estimateMin !== undefined) data.estimateMin = clamp(input.estimateMin, 5, 480, 30);
      if (input.plannedFor === "none") data.plannedFor = null;
      else if (isDay(input.plannedFor)) data.plannedFor = input.plannedFor;
      if (input.dueDate === "none") data.dueAt = null;
      else if (isDay(input.dueDate)) data.dueAt = etEndOfDay(input.dueDate);
      if (Object.keys(data).length === 0) return { error: "Nothing to change." };
      try {
        const row = await prisma.ownerTodo.update({
          where: { id },
          data,
          select: { id: true, title: true, priority: true, energy: true, estimateMin: true, plannedFor: true },
        });
        return { updated: row };
      } catch {
        return { error: "No to-do with that id." };
      }
    }

    case "complete_todo": {
      try {
        const row = await prisma.ownerTodo.update({
          where: { id: String(input.id ?? "") },
          // Blocked time is released the same way the checkbox does it, so a
          // finished to-do can't go on refusing Calendly bookings.
          data: { status: "DONE", doneAt: new Date(), calendarEventId: null, blockStart: null, blockEnd: null },
          select: { id: true, title: true },
        });
        return { completed: row };
      } catch {
        return { error: "No to-do with that id." };
      }
    }

    case "find_job": {
      const q = String(input.query ?? "").trim();
      if (q.length < 2) return { error: "Give me at least two characters." };
      const rows = await prisma.project.findMany({
        where: {
          // CITY is searched separately from the street line. Aryeo stores
          // "1033 Preserve Ln" and "West Chester" in different columns, so a
          // street-only search finds nothing for a town name — which is exactly
          // how Jordan refers to a shoot out loud.
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { addressLine: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            { client: { name: { contains: q, mode: "insensitive" } } },
          ],
          ...(input.upcomingOnly === true ? { deliveredAt: null } : {}),
        },
        select: {
          id: true, title: true, status: true, shootDate: true, deliveredAt: true,
          addressLine: true, city: true, state: true,
          client: { select: { name: true } },
        },
        orderBy: { shootDate: "desc" },
        take: 10,
      });
      return rows.map((r) => ({
        id: r.id,
        job: r.title,
        address: [r.addressLine, r.city, r.state].filter(Boolean).join(", ") || null,
        client: r.client?.name ?? null,
        status: r.status,
        shoot: r.shootDate ? etDayKey(r.shootDate) : null,
        delivered: !!r.deliveredAt,
      }));
    }

    // Both drafts deliberately WRITE NOTHING. They exist so the model can put a
    // button in front of Jordan; the send happens from his click, not its call.
    case "draft_slack_to_kyle":
      return {
        staged: true,
        note: "Nothing sent. Jordan now has a Send button with this text — say so plainly and do not claim it went out.",
        text: String(input.text ?? "").slice(0, 2000),
      };

    case "draft_task_for_kyle":
      return {
        staged: true,
        note: "Nothing created. Jordan now has a Create button for this task — do not claim it exists yet.",
        title: String(input.title ?? "").slice(0, 200),
      };

    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** Pull the button-worthy proposals out of what the model actually called. */
export function proposalsFrom(toolsUsed: { name: string; input: Record<string, unknown> }[]): DayProposal[] {
  const out: DayProposal[] = [];
  for (const t of toolsUsed) {
    if (t.name === "draft_slack_to_kyle") {
      const text = String(t.input.text ?? "").trim();
      if (text) out.push({ kind: "slack", text: text.slice(0, 2000), why: t.input.why ? String(t.input.why).slice(0, 200) : undefined });
    }
    if (t.name === "draft_task_for_kyle") {
      const title = String(t.input.title ?? "").trim();
      if (title) {
        out.push({
          kind: "task",
          title: title.slice(0, 200),
          detail: t.input.detail ? String(t.input.detail).slice(0, 1000) : undefined,
          dueDate: isDay(t.input.dueDate) ? t.input.dueDate : undefined,
        });
      }
    }
  }
  return out;
}

/**
 * The system prompt, stamped with the current moment.
 *
 * Built per request rather than held as a constant because the model has no
 * clock: asked to message Kyle about "Friday", it guessed the date was four
 * days off and named the wrong shoot. An assistant whose whole subject is TODAY
 * has to be told what today is.
 */
export function daySystem(now: Date = new Date()): string {
  const dayKey = etDayKey(now);
  const long = now.toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  return `${DAY_SYSTEM}

RIGHT NOW it is ${long} Eastern (${dayKey}). All dates and times are US Eastern. When Jordan says "Friday" or "tomorrow" he means the next one from this moment — work it out from the date above and say which date you landed on, so a wrong guess is visible rather than silent.`;
}

const DAY_SYSTEM = `You are Jordan's assistant on My Day — his personal command centre. Jordan owns RealTour Pilot, a real-estate media agency in Lititz, PA. Kyle is his operations manager; James and Harrison shoot.

How to be useful here:
- Answer from the tools, not from guesses. Call my_day or my_todos before saying anything about his schedule or his list.
- Be SHORT. He is on this page to act, not to read. Two or three sentences, then a list only if the list is the answer.
- When he asks what to do next, give ONE recommendation and the reason, not a ranked menu of five.
- When prioritising: protected mornings are for DEEP work, money-at-risk beats admin, and anything with a real external deadline beats anything without one. Say what you'd drop, not just what you'd do.
- You may freely add, edit, re-order and finish HIS OWN to-dos. Do it rather than describing it.
- Kyle: you can only DRAFT. draft_slack_to_kyle and draft_task_for_kyle send and create nothing — they put a button in front of Jordan. Never say a message was sent or a task was created; say it's ready for him to send.
- You cannot reach clients at all from here. If he wants a client contacted, say so and point him at the job.
- Never guess anyone's gender; if you don't know someone's pronouns, use "they".
- Money: quote only figures the tools return. Never estimate revenue or profit.
- If a tool errors or comes back empty, say so plainly. Do not fill the gap with something plausible.`;
