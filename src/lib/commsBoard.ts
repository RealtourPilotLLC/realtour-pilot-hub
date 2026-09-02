import "server-only";
import { prisma } from "@/lib/prisma";
import { unansweredComms } from "@/lib/replyQueue";

// ---------------------------------------------------------------------------
// The Comms Checklist boards (Jordan, Sep 1 2026: "we don't need to turn every
// Slack message, text, or email into a task — the board just gets clogged").
// The task ENGINE keeps tracking silently (auto-close on reply, receipts, Hub
// context); these boards are the only PRESENTATION: unanswered comms grouped
// by sender (Phone | Email), revisions grouped by requester, Slack to-dos.
// A row clears itself when a reply/delivery is detected; the manual tick
// completes the silent client_reply task, which the unanswered walk already
// honors as "handled" — one mechanism, no new bookkeeping.
//
// WHO IS WAITING is no longer decided here. It used to be — and the Ops Day
// pill, the Dashboard chip, the Replies tab and this board each decided it
// differently, which is how the hub came to show 1 and 6 for the same question
// on the same morning. That walk now lives once, in src/lib/replyQueue.ts
// (`unansweredComms`); this file is the PRESENTATION of the phone/email slices
// of it. Everything below the unanswered section (revisions, Slack) is
// unchanged.
// ---------------------------------------------------------------------------

// The two helpers the boards used to own. They moved next to the walk that
// needs them (replyQueue.ts) and are re-exported here so their existing
// importers — src/lib/opsDay.ts (cleanEmailBody) and src/app/actions.ts
// (emailAckKey, the Handled tick) — keep working unchanged.
export { cleanEmailBody, emailAckKey } from "@/lib/replyQueue";

export type CommsThreadItem = { snippet: string; subject: string | null; body: string | null; atISO: string; ageHours: number };
export type CommsGroup = {
  /** clientId for the Handled tick (the most common one among the rows) */
  clientId: string;
  /** stable per-sender key — the React key AND the Handled tick's ack scope,
   *  so two senders mis-filed under one client record never share a tick */
  groupKey: string;
  /** the SENDER the group is keyed by — for email this is the actual From
   *  name, not the (sometimes mis-attributed) client record */
  clientName: string;
  isVip: boolean;
  items: CommsThreadItem[]; // every inbound since our last answer, oldest first
  oldestHours: number;
  openTaskId: string | null; // the silent client_reply task, when one exists
};

function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Unanswered inbound comms for one channel family, grouped by sender.
 *  channelFamily "phone" = texts + calls (a completed outbound call answers);
 *  "email" = the Gmail sync.
 *
 *  A thin slice of the ONE walk (src/lib/replyQueue.ts): client-matched threads
 *  only, because this board's Handled tick and VIP star are keyed on a client
 *  record. Unmatched numbers and our own team's texts are real and still
 *  counted — they show on the Replies tab, which can actually answer them.
 *  Same rows, same ages, same order as every other surface. */
export async function unansweredCommsBoard(family: "phone" | "email", now: Date = new Date()): Promise<CommsGroup[]> {
  const threads = await unansweredComms({
    now,
    families: [family],
    includeUnmatched: false, // the tick needs a client record
    includeTeam: false, // "unanswered CLIENTS", not our own photographers
  });
  return threads.map((t) => ({
    clientId: t.clientId ?? "",
    groupKey: t.groupKey,
    clientName: t.displayName,
    isVip: t.isVip,
    items: t.pending.map((i) => ({
      snippet: snippetOf(i.body) || (i.subject ?? ""),
      subject: i.subject,
      body: family === "email" ? i.body.slice(0, 700) : null,
      atISO: i.at.toISOString(),
      ageHours: Math.max(0, Math.round((now.getTime() - i.at.getTime()) / 3_600_000)),
    })),
    // The wait is measured from the OLDEST message still owed an answer, which
    // survives the 5-item display cap — a client 8 messages deep shows their
    // TRUE wait, not the age of message #4.
    oldestHours: t.hoursWaiting,
    openTaskId: t.openTaskId,
  }));
}

// ---------------------------------------------------------------------------
// Revisions — grouped by requester. Auto-clears when the project leaves
// REVISION (delivery is the tick).
// ---------------------------------------------------------------------------
export type RevisionGroup = {
  clientId: string | null;
  clientName: string;
  jobs: {
    projectId: string;
    title: string;
    ageDays: number;
    editor: string | null;
    headline: string | null; // the AI brief's one-line summary of the ask
    itemsDone: number;
    itemsTotal: number;
    note: string | null; // raw revision note fallback
  }[];
};

export async function revisionsBoard(now: Date = new Date()): Promise<RevisionGroup[]> {
  const projects = await prisma.project.findMany({
    where: { status: "REVISION" },
    select: {
      id: true, title: true, revisionRequestedAt: true, updatedAt: true, revisionNote: true, clientId: true,
      client: { select: { name: true } },
      editor: { select: { name: true } },
      revisionBriefs: { orderBy: { createdAt: "desc" }, take: 1, select: { headline: true, itemsJson: true, doneJson: true } },
    },
    orderBy: { updatedAt: "asc" },
    take: 40,
  });
  const groups = new Map<string, RevisionGroup>();
  for (const p of projects) {
    const key = p.clientId ?? "none";
    const brief = p.revisionBriefs[0] ?? null;
    let itemsTotal = 0, itemsDone = 0;
    if (brief?.itemsJson) {
      // itemsJson is an OBJECT: { items, keep, references, questions }.
      try { itemsTotal = ((JSON.parse(brief.itemsJson) as { items?: unknown[] }).items ?? []).length; } catch { /* ignore */ }
      try { itemsDone = (JSON.parse(brief.doneJson ?? "[]") as unknown[]).length; } catch { /* ignore */ }
    }
    const g = groups.get(key) ?? { clientId: p.clientId, clientName: p.client?.name ?? "Unknown client", jobs: [] };
    g.jobs.push({
      projectId: p.id,
      title: p.title.split(",")[0],
      ageDays: Math.floor((now.getTime() - (p.revisionRequestedAt ?? p.updatedAt).getTime()) / 86_400_000),
      editor: p.editor?.name ?? null,
      headline: brief?.headline ?? null,
      itemsDone, itemsTotal,
      note: p.revisionNote,
    });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.jobs.map((j) => j.ageDays)) - Math.max(...a.jobs.map((j) => j.ageDays)));
}

// ---------------------------------------------------------------------------
// Slack to-dos — the parsed action items from Slack, no longer clogging the
// board. Complete = the normal task completion.
// ---------------------------------------------------------------------------
export type SlackTaskRow = {
  taskId: string;
  title: string;
  summary: string | null;
  ageDays: number;
  assignedKey: string | null;
  dueISO: string | null;
  overdue: boolean;
};

export async function slackBoard(now: Date = new Date()): Promise<{ unassigned: SlackTaskRow[]; assigned: SlackTaskRow[] }> {
  const tasks = await prisma.smartTask.findMany({
    where: { source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, title: true, summary: true, createdAt: true, assignedKey: true, dueAt: true },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  const row = (t: (typeof tasks)[number]): SlackTaskRow => ({
    taskId: t.id,
    title: t.title,
    summary: t.summary,
    ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / 86_400_000),
    assignedKey: t.assignedKey,
    dueISO: t.dueAt?.toISOString() ?? null,
    overdue: !!t.dueAt && t.dueAt < now,
  });
  return {
    unassigned: tasks.filter((t) => !t.assignedKey).map(row),
    assigned: tasks.filter((t) => t.assignedKey).map(row),
  };
}

// Task types that live in the Comms/Revisions/Slack checklists now — the
// Today stack and Board hide them (tracking continues silently underneath).
export const COMMS_VIEW_TASK_TYPES = ["client_reply", "comms_followup", "callback"];
