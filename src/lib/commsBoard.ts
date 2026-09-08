import "server-only";
import { prisma } from "@/lib/prisma";
import { unansweredComms } from "@/lib/replyQueue";
import { editorMeta } from "@/lib/editors";

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

// The email Handled tick's effect on the gmail-born client_reply task lives
// with the rest of that task's lifecycle in src/lib/integrations/google.ts
// (completeEmailReplyTasks / closeAckedEmailReplyTasks) — this file stays the
// presentation of the walk.

const OPEN_STATUS: { notIn: string[] } = { notIn: ["COMPLETED", "CANCELLED"] };

// ---------------------------------------------------------------------------
// Revisions — grouped by requester, read from the OPEN `revision` tasks, not
// from Project.status.
//
// Sep 8 audit: this listed projects in status REVISION (4) while 7 revision
// tasks were open on 6 jobs. 332 Ruth Ridge and 1956 Wetherhill had been moved
// to DELIVERED by the queue's "Completed" button, which closes nothing in the
// revision lane — so John was being chased on the Other tab ("Needs John · 2
// overdue") for revisions this tab said did not exist, and Kyle's photo-lane
// ask on Wetherhill (a real open revision, raised Sep 5) was off the tab, off
// "open revisions" and off the closeout row. The task IS the revision: it is
// what the editor's board, the Other tab and the owner pulse already count, so
// this board reads the same rows and the numbers agree. A row clears when its
// task does (resolveRevision, the editor's submit, the Complete button) —
// delivery alone is no longer the tick, because a job can read Delivered while
// a lane is still owed. Where the two sources disagree the row says so
// (`projectStatus`), so a finished job whose task was never closed is a tick
// away instead of an invisible one.
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
    /** the job's own status. "DELIVERED" here = the engine says done while the
     *  ask is still open — the two sources disagree and a human should look. */
    projectStatus: string;
    /** the open revision task(s) behind this row — one per lane (video / photo) */
    taskIds: string[];
  }[];
};

export async function revisionsBoard(now: Date = new Date()): Promise<RevisionGroup[]> {
  const tasks = await prisma.smartTask.findMany({
    where: { taskType: "revision", status: OPEN_STATUS, projectId: { not: null } },
    select: {
      id: true, projectId: true, assignedKey: true, createdAt: true, summary: true,
      project: {
        select: {
          id: true, title: true, status: true, clientId: true, revisionNote: true,
          client: { select: { name: true } },
          editor: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 80,
  });
  if (tasks.length === 0) return [];
  // The ask behind each task is its own brief (RevisionBrief.taskId), newest
  // first: a re-raised ask on the same task gets a fresh brief, and the fresh
  // one is the round the editor is on. Briefs minted before taskId existed
  // carry none, so those fall back to the project's newest unowned brief —
  // never another lane's, which would put the video ask on the photo row.
  const briefs = await prisma.revisionBrief.findMany({
    where: { projectId: { in: [...new Set(tasks.map((t) => t.projectId as string))] } },
    orderBy: { createdAt: "desc" },
    select: { taskId: true, projectId: true, headline: true, itemsJson: true, doneJson: true, createdAt: true },
  });
  type Brief = (typeof briefs)[number];
  const briefByTask = new Map<string, Brief>();
  const unownedByProject = new Map<string, Brief>();
  for (const b of briefs) {
    if (b.taskId) { if (!briefByTask.has(b.taskId)) briefByTask.set(b.taskId, b); }
    else if (!unownedByProject.has(b.projectId)) unownedByProject.set(b.projectId, b);
  }
  const countItems = (b: Brief | undefined): { total: number; done: number } => {
    if (!b?.itemsJson) return { total: 0, done: 0 };
    let total = 0, done = 0;
    // itemsJson is an OBJECT: { items, keep, references, questions }.
    try { total = ((JSON.parse(b.itemsJson) as { items?: unknown[] }).items ?? []).length; } catch { /* ignore */ }
    try { done = (JSON.parse(b.doneJson ?? "[]") as unknown[]).length; } catch { /* ignore */ }
    return { total, done };
  };

  // One row per JOB: Wetherhill carries a video lane (John) and a photo lane
  // (Kyle) as two tasks, and the view keys rows by projectId.
  type Job = RevisionGroup["jobs"][number];
  const jobs = new Map<string, Job & { askedAt: number; editors: string[]; headlines: string[] }>();
  for (const t of tasks) {
    const p = t.project;
    if (!p) continue;
    const brief = briefByTask.get(t.id) ?? unownedByProject.get(p.id);
    const askedAt = (brief?.createdAt ?? t.createdAt).getTime();
    const { total, done } = countItems(brief);
    const editor = editorMeta(t.assignedKey)?.name ?? p.editor?.name ?? null;
    const j = jobs.get(p.id) ?? {
      projectId: p.id,
      title: p.title.split(",")[0],
      ageDays: 0,
      editor: null,
      headline: null,
      itemsDone: 0,
      itemsTotal: 0,
      note: p.revisionNote ?? t.summary,
      projectStatus: p.status,
      taskIds: [],
      askedAt,
      editors: [],
      headlines: [],
    };
    // The wait is the OLDEST open ask on the job, not the newest lane.
    j.askedAt = Math.min(j.askedAt, askedAt);
    if (editor && !j.editors.includes(editor)) j.editors.push(editor);
    if (brief?.headline) j.headlines.push(brief.headline);
    j.itemsTotal += total;
    j.itemsDone += done;
    j.taskIds.push(t.id);
    jobs.set(p.id, j);
  }

  const groups = new Map<string, RevisionGroup>();
  for (const j of jobs.values()) {
    const t = tasks.find((x) => x.projectId === j.projectId);
    const p = t?.project;
    const key = p?.clientId ?? "none";
    const g = groups.get(key) ?? { clientId: p?.clientId ?? null, clientName: p?.client?.name ?? "Unknown client", jobs: [] };
    g.jobs.push({
      projectId: j.projectId,
      title: j.title,
      ageDays: Math.floor((now.getTime() - j.askedAt) / 86_400_000),
      editor: j.editors.length ? j.editors.join(" / ") : null,
      headline: j.headlines.length ? j.headlines.join(" · ") : null,
      itemsDone: j.itemsDone,
      itemsTotal: j.itemsTotal,
      note: j.note,
      projectStatus: j.projectStatus,
      taskIds: j.taskIds,
    });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.jobs.map((j) => j.ageDays)) - Math.max(...a.jobs.map((j) => j.ageDays)));
}

/** Jobs with at least one open revision task — the same source as the board
 *  above, for home's "open revisions" pill and the closeout row (opsDay.ts
 *  still counts Project.status === "REVISION", which is how home said "4 open
 *  revisions" while the board owed 6). */
export async function openRevisionJobCount(): Promise<number> {
  const rows = await prisma.smartTask.findMany({
    where: { taskType: "revision", status: OPEN_STATUS, projectId: { not: null } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  return rows.length;
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
