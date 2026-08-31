import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// The Comms Checklist boards (Jordan, Sep 1 2026: "we don't need to turn every
// Slack message, text, or email into a task — the board just gets clogged").
// The task ENGINE keeps tracking silently (auto-close on reply, receipts, Hub
// context); these boards are the only PRESENTATION: unanswered comms grouped
// by sender (Phone | Email), revisions grouped by requester, Slack to-dos.
// A row clears itself when a reply/delivery is detected; the manual tick
// completes the silent client_reply task, which the unanswered walk already
// honors as "handled" — one mechanism, no new bookkeeping.
// ---------------------------------------------------------------------------

const SCAN_DAYS = 7;

export type CommsThreadItem = { snippet: string; atISO: string; ageHours: number };
export type CommsGroup = {
  clientId: string;
  clientName: string;
  isVip: boolean;
  items: CommsThreadItem[]; // every inbound since our last answer, oldest first
  oldestHours: number;
  openTaskId: string | null; // the silent client_reply task, when one exists
};

const VIP_SEGMENTS = new Set(["vip", "whale"]);

function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 140);
}

// Same praise/reaction filter idea as commsSla: don't demand answers to "❤️",
// "oh thank you so much!!!", or an iMessage tapback quoting OUR message.
const REACTION_PREFIX = /^(loved|liked|laughed at|emphasized|disliked|questioned)\s+[“"]/i;
const PRAISE_ONLY = /^(oh\s+)?(thanks|thank(s)?\s?(you|u)?|ty|awesome|perfect|great|amazing|love(d)?\s?(it|them|these)?|beautiful|wonderful|ok(ay)?|sounds good|got it|you('re| are) the best|appreciate (it|you)|so much|👍|❤️|🙏|🔥|!+|\.+|\s)+[\s!.🙌❤️🔥🙏👍]*$/i;
function needsReply(body: string | null): boolean {
  const t = (body ?? "").trim();
  if (!t) return false;
  if (t.length <= 3) return false;
  if (REACTION_PREFIX.test(t)) return false;
  return !PRAISE_ONLY.test(t);
}

/** Unanswered inbound comms for one channel family, grouped by sender.
 *  channelFamily "phone" = texts + calls (a completed outbound call answers);
 *  "email" = the Gmail sync. */
export async function unansweredCommsBoard(family: "phone" | "email", now: Date = new Date()): Promise<CommsGroup[]> {
  const since = new Date(now.getTime() - SCAN_DAYS * 86_400_000);
  const channels = family === "phone" ? ["text", "call"] : ["email"];
  const rows = await prisma.commLog.findMany({
    where: { channel: { in: channels }, occurredAt: { gte: since }, clientId: { not: null } },
    orderBy: { occurredAt: "asc" },
    select: { clientId: true, clientName: true, channel: true, direction: true, body: true, subject: true, occurredAt: true },
  });

  // Walk in time order: collect EVERY unanswered inbound per client (Jordan:
  // grouped by who sent it); any real outbound clears the pile.
  const pending = new Map<string, { clientName: string | null; items: { body: string; at: Date }[] }>();
  for (const r of rows) {
    const cid = r.clientId as string;
    if (r.direction === "out") {
      if (r.channel === "call" && /missed|no answer|unanswered/i.test(r.body ?? "")) continue;
      pending.delete(cid);
    } else if (r.channel !== "call") {
      const text = family === "email" ? [r.subject, r.body].filter(Boolean).join(" — ") : r.body;
      if (!needsReply(text)) continue;
      const cur = pending.get(cid) ?? { clientName: r.clientName, items: [] };
      cur.items.push({ body: text ?? "", at: r.occurredAt });
      if (cur.items.length > 5) cur.items.shift(); // keep the latest five
      pending.set(cid, cur);
    }
  }
  if (pending.size === 0) return [];

  // A completed client_reply AFTER the newest inbound = handled by a human
  // (the manual tick uses exactly this — one shared semantics with the pager).
  const [handled, openTasks, clients] = await Promise.all([
    prisma.smartTask.findMany({
      where: { clientId: { in: [...pending.keys()] }, taskType: "client_reply", status: "COMPLETED", completedAt: { gte: since } },
      select: { clientId: true, completedAt: true },
    }),
    prisma.smartTask.findMany({
      where: { clientId: { in: [...pending.keys()] }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, clientId: true },
    }),
    prisma.client.findMany({
      where: { id: { in: [...pending.keys()] } },
      select: { id: true, name: true, segment: true, parent: { select: { segment: true } } },
    }),
  ]);
  for (const h of handled) {
    const pnd = h.clientId ? pending.get(h.clientId) : null;
    if (pnd && h.completedAt && pnd.items.length && h.completedAt > pnd.items[pnd.items.length - 1].at) {
      pending.delete(h.clientId!);
    }
  }
  const taskByClient = new Map(openTasks.filter((t) => t.clientId).map((t) => [t.clientId as string, t.id]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const out: CommsGroup[] = [];
  for (const [clientId, p] of pending) {
    const c = clientById.get(clientId);
    out.push({
      clientId,
      clientName: p.clientName || c?.name || "Unknown",
      isVip: VIP_SEGMENTS.has(c?.segment ?? "") || VIP_SEGMENTS.has(c?.parent?.segment ?? ""),
      items: p.items.map((i) => ({
        snippet: snippetOf(i.body),
        atISO: i.at.toISOString(),
        ageHours: Math.max(0, Math.round((now.getTime() - i.at.getTime()) / 3_600_000)),
      })),
      oldestHours: Math.max(0, Math.round((now.getTime() - p.items[0].at.getTime()) / 3_600_000)),
      openTaskId: taskByClient.get(clientId) ?? null,
    });
  }
  return out.sort((a, b) => (b.isVip ? 1 : 0) - (a.isVip ? 1 : 0) || b.oldestHours - a.oldestHours);
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
