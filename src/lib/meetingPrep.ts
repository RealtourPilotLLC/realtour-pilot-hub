import "server-only";
import { prisma } from "@/lib/prisma";
import { listAssignees } from "@/lib/assignees";
import { etAt, etDateTime, etDayKey } from "@/lib/datetime";
import { hubChange } from "@/lib/delegation";

// ---------------------------------------------------------------------------
// MEETING PREP (Oct 23 2026, Jordan's dashboards spec §4E). One prep task per
// Calendly booking CHAIN, by meeting type, from the hub's own call records
// (ProgramCallRecord, synced hourly from Calendly). The rules:
//   · ONE TASK PER MEETING. A reschedule is a new Calendly event whose record
//     points back at the old one (rescheduledFromId); the chain's first
//     record keys the task ("meeting-prep:<rootId>"), so moving a meeting
//     moves its prep instead of adding a second one. A Google Calendar event
//     linked to the booking (calendarExternalId) is the same meeting, never a
//     second row.
//   · BY TYPE, FROM EVIDENCE. Only the program's call types get prep (a
//     monthly strategy call, a brand discovery call); an unclassified booking
//     gets none (no guessing what it is). The prep points name records the
//     hub has (the month's topics, the onboarding answers), never invented
//     client facts.
//   · IT MOVES AND IT STOPS. A reschedule moves the prep deadline (and tells
//     whoever holds it); a cancellation cancels the prep; a meeting that has
//     happened closes prep still open. Nothing stays active and misleading.
//   · PREP IS DUE the business day before the meeting, 5 PM ET; booked too
//     late for that, two hours before it.
// Runs in the hourly sync, right after the Calendly bookings are read.
// ---------------------------------------------------------------------------

export const PREP_CALL_TYPES = ["MONTHLY_STRATEGY", "BRAND_DISCOVERY"] as const;
export const CALL_WORDS: Record<string, string> = {
  MONTHLY_STRATEGY: "monthly strategy call",
  BRAND_DISCOVERY: "brand discovery call",
  UNRELATED: "meeting",
  UNCLASSIFIED: "meeting",
};
export const prepKey = (rootId: string) => `meeting-prep:${rootId}`;
const HOUR = 3_600_000;

/** The business day before the meeting at 5 PM ET; two hours before when that has passed. */
export function prepDueFor(start: Date, now: Date): Date {
  let key = etDayKey(start);
  for (let i = 0; i < 7; i++) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
  }
  const dayBefore = etAt(key, 17);
  if (dayBefore.getTime() > now.getTime()) return dayBefore;
  const twoBefore = new Date(start.getTime() - 2 * HOUR);
  return twoBefore.getTime() > now.getTime() ? twoBefore : start;
}

type Rec = {
  id: string; status: string; callType: string; scheduledStart: Date | null; rescheduledFromId: string | null; createdAt: Date;
  clientId: string | null; enrollmentId: string | null; monthId: string | null; onboardingId: string | null; inviteeName: string | null; meetLink: string | null;
};
const SELECT = { id: true, status: true, callType: true, scheduledStart: true, rescheduledFromId: true, createdAt: true, clientId: true, enrollmentId: true, monthId: true, onboardingId: true, inviteeName: true, meetLink: true } as const;

/** Each booking chain: its first record and its newest. */
export async function meetingChains(now: Date, opts: { lookAheadDays?: number } = {}): Promise<{ root: Rec; leaf: Rec }[]> {
  const ahead = new Date(now.getTime() + (opts.lookAheadDays ?? 30) * 24 * HOUR);
  const recent = await prisma.programCallRecord.findMany({
    where: { callType: { in: [...PREP_CALL_TYPES] }, OR: [{ scheduledStart: { gte: new Date(now.getTime() - 3 * 24 * HOUR), lte: ahead } }, { updatedAt: { gte: new Date(now.getTime() - 7 * 24 * HOUR) } }] },
    select: SELECT,
  });
  const byId = new Map<string, Rec>(recent.map((r) => [r.id, r]));
  // Pull in ancestors and descendants outside the window so a chain is whole.
  for (let round = 0; round < 6; round++) {
    const missing = [...new Set([...byId.values()].map((r) => r.rescheduledFromId).filter((x): x is string => !!x && !byId.has(x)))];
    const kids = await prisma.programCallRecord.findMany({ where: { rescheduledFromId: { in: [...byId.keys()] }, id: { notIn: [...byId.keys()] } }, select: SELECT });
    const parents = missing.length ? await prisma.programCallRecord.findMany({ where: { id: { in: missing } }, select: SELECT }) : [];
    if (!kids.length && !parents.length) break;
    for (const r of [...kids, ...parents]) byId.set(r.id, r);
  }
  const children = new Map<string, Rec[]>();
  for (const r of byId.values()) if (r.rescheduledFromId) children.set(r.rescheduledFromId, [...(children.get(r.rescheduledFromId) ?? []), r]);
  const out: { root: Rec; leaf: Rec }[] = [];
  for (const r of byId.values()) {
    if (r.rescheduledFromId && byId.has(r.rescheduledFromId)) continue; // not a root
    let leaf = r;
    for (let i = 0; i < 20; i++) {
      const next = (children.get(leaf.id) ?? []).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!next) break;
      leaf = next;
    }
    out.push({ root: r, leaf });
  }
  return out;
}

/** What to prepare, from what the hub knows (never invented client facts). */
export async function prepPointsFor(r: Pick<Rec, "callType" | "monthId" | "onboardingId" | "enrollmentId">): Promise<{ points: string[]; missing: string[] }> {
  const points: string[] = [];
  const missing: string[] = [];
  if (r.callType === "MONTHLY_STRATEGY") {
    const [topics, strategy] = await Promise.all([
      r.monthId ? prisma.contentTopic.count({ where: { monthId: r.monthId, status: { notIn: ["REJECTED", "ARCHIVED"] } } }).catch(() => null) : Promise.resolve(null),
      r.enrollmentId ? prisma.contentStrategyVersion.count({ where: { enrollmentId: r.enrollmentId, status: "APPROVED" } }).catch(() => null) : Promise.resolve(null),
    ]);
    if (topics === 0) missing.push("Topic shortlist missing");
    points.push(topics ? `Review the ${topics} topic${topics === 1 ? "" : "s"} on the month` : "Build the topic shortlist for the month");
    if (strategy === 0) missing.push("No approved strategy");
    points.push(strategy ? "Re-read the approved strategy" : "Draft the strategy to bring to the call");
    points.push("Look at last month's videos and what the client said about them");
  } else if (r.callType === "BRAND_DISCOVERY") {
    points.push(r.onboardingId ? "Read their onboarding answers" : "Find out who they are: no onboarding answers are on file");
    if (!r.onboardingId) missing.push("No onboarding answers");
    points.push("Look at their current listings and social accounts before the call");
  }
  return { points, missing };
}

async function prepOwnerKey(r: Rec): Promise<string | null> {
  const roster = await listAssignees();
  let teamMemberId: string | null = null;
  if (r.enrollmentId) {
    const { ownersFor } = await import("@/lib/contentProgram");
    const owner = await ownersFor(r.enrollmentId, r.monthId).then((m) => m.STRATEGY).catch(() => null);
    if (owner?.appUserId) teamMemberId = (await prisma.appUser.findUnique({ where: { id: owner.appUserId }, select: { teamMemberId: true } }))?.teamMemberId ?? null;
  }
  if (!teamMemberId) teamMemberId = (await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, orderBy: { createdAt: "asc" }, select: { teamMemberId: true } }))?.teamMemberId ?? null;
  return teamMemberId ? roster.find((a) => a.teamMemberId === teamMemberId)?.key ?? null : roster.find((a) => a.kind === "owner")?.key ?? null;
}

export type PrepSync = { created: number; moved: number; cancelled: number; closed: number; reopened: number };

export async function syncMeetingPrep(now: Date = new Date()): Promise<PrepSync> {
  const out: PrepSync = { created: 0, moved: 0, cancelled: 0, closed: 0, reopened: 0 };
  const chains = await meetingChains(now);
  const keys = chains.map((c) => prepKey(c.root.id));
  const tasks = keys.length ? await prisma.smartTask.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true, dedupeKey: true, status: true, dueAt: true } }) : [];
  const taskOf = new Map(tasks.map((t) => [t.dedupeKey, t]));
  const clientIds = [...new Set(chains.map((c) => c.leaf.clientId).filter((x): x is string => !!x))];
  const names = new Map((clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
  for (const { root, leaf } of chains) {
    const key = prepKey(root.id);
    const task = taskOf.get(key);
    const open = !!task && task.status !== "COMPLETED" && task.status !== "CANCELLED";
    const start = leaf.scheduledStart;
    const upcoming = leaf.status === "SCHEDULED" && !!start && start.getTime() > now.getTime();
    const who = (leaf.clientId && names.get(leaf.clientId)) || leaf.inviteeName || "a client";
    const words = CALL_WORDS[leaf.callType] ?? "meeting";
    if (upcoming && start) {
      const due = prepDueFor(start, now);
      const { points } = await prepPointsFor(leaf);
      const description = [`${who}'s ${words}: ${etDateTime(start)} ET.`, ...points.map((p) => `· ${p}`)].join("\n");
      if (!task) {
        const assignedKey = await prepOwnerKey(leaf);
        try {
          await prisma.smartTask.create({
            data: {
              taskType: "meeting_prep", source: "calendly", priority: "MEDIUM",
              title: `Prepare for ${who}'s ${words}`.slice(0, 140),
              summary: `${words[0].toUpperCase()}${words.slice(1)} ${etDateTime(start)} ET`,
              description, reasonCreated: "A Calendly booking", dueAt: due, assignedKey, clientId: leaf.clientId,
              sourceDetail: `calendly-call:${leaf.id}`, dedupeKey: key,
            },
          });
          out.created++;
        } catch { /* the twin tick made it */ }
        continue;
      }
      if (!open && task.status === "CANCELLED") {
        // Cancelled earlier (the meeting was cancelled) and booked again on the same chain.
        await hubChange(task.id, { kind: "reopened", text: `The meeting is back on: ${etDateTime(start)} ET. Prep due ${etDateTime(due)}.`, data: { status: "OPEN", dueAt: due, description, completedAt: null }, tell: `Meeting back on: prep for ${who} due ${etDateTime(due)}` }, now);
        out.reopened++;
        continue;
      }
      if (open && (!task.dueAt || Math.abs(task.dueAt.getTime() - due.getTime()) > 60_000)) {
        await hubChange(task.id, { kind: "update", text: `The meeting moved to ${etDateTime(start)} ET; prep is now due ${etDateTime(due)}.`, data: { dueAt: due, description, summary: `${words[0].toUpperCase()}${words.slice(1)} ${etDateTime(start)} ET` }, tell: `Meeting moved: prep for ${who} now due ${etDateTime(due)}` }, now);
        out.moved++;
      }
      continue;
    }
    if (!open || !task) continue;
    if (leaf.status === "CANCELLED" || leaf.status === "RESCHEDULED") {
      await hubChange(task.id, { kind: "cancelled", text: `The meeting was cancelled${leaf.status === "RESCHEDULED" ? " (rescheduled with no new time on record)" : ""}; prep is no longer needed.`, data: { status: "CANCELLED", summary: `Meeting cancelled: ${who}'s ${words}` }, tell: `Meeting cancelled: prep for ${who} is no longer needed` }, now);
      out.cancelled++;
    } else if (start && start.getTime() <= now.getTime()) {
      await hubChange(task.id, { kind: "cancelled", text: "The meeting has happened; prep was never marked done.", data: { status: "CANCELLED", summary: `Meeting held ${etDateTime(start)}: prep not marked done` } }, now);
      out.closed++;
    }
  }
  return out;
}
