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
  /** TRUE when this row came from the OBLIGATION LEDGER, not the message
   *  window: the request is still open but the conversation behind it is older
   *  than the seven-day read, so `items` is the ONE message the obligation was
   *  raised on rather than the thread. The card should say so — there is no
   *  scrollback here, and the full conversation lives on the client page. */
  fromLedger: boolean;
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
    // A WORK ITEM MUST NOT VANISH FROM A LIST OF WORK (audit R07, Sep 18). The
    // seven-day window is a rule about NOISE — the twelve extra rows a 21-day
    // read added were out-of-office replies and vendor pitches nobody chose.
    // An open reply to-do is the opposite: the hub looked at that conversation
    // and wrote down that we owe an answer. That obligation is read from the
    // ledger with no window and no row cap, so a question older than 45 days,
    // or buried under 600 newer messages on a busy account, stays on this board
    // until somebody resolves it. The board opts in; the 5-minute SLA pager
    // deliberately does not (see UnansweredOptions.includeOwed).
    includeOwed: true,
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
    fromLedger: !!t.fromLedger,
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
// SLACK ASKS — one home, and a WORK list rather than a de-clogging list.
//
// Kyle's call (Sep 16): "the Slack reminders are hard to find, and when you do
// find them you can't tell what they're about." He was right on both counts.
// The tab rendered a title, a raw assignee slug ("· jordan") and an age, and
// nothing else: not who asked, not who it is for, not the client, not the
// property, not the message it came from, and no way back to the thread. The
// data was all there — slackBoard simply never selected it.
//
// It now carries, per row: who asked → who it is for (a NAME, not a slug), the
// client, the property, the quoted message with a working "open in Slack"
// link (slack.ts slackPermalink, cached), the action, and the due date. One
// list, oldest first, unassigned at the top — the order you would work them in.
// ---------------------------------------------------------------------------
export type SlackTaskRow = {
  taskId: string;
  title: string; // the action
  summary: string | null;
  /** the raw Slack message behind the ask */
  quote: string | null;
  permalink: string | null;
  askedBy: string | null;
  forWhom: string | null; // a roster name, or null = needs assigning
  clientName: string | null;
  propertyAddress: string | null;
  projectId: string | null;
  ageDays: number;
  assignedKey: string | null;
  dueISO: string | null;
  overdue: boolean;
};

export type SlackBoard = {
  /** oldest first, unassigned first — one list, the order to work them in */
  rows: SlackTaskRow[];
  /** counted over `rows`, i.e. over what is actually shown */
  unassignedCount: number;
  overdueCount: number;
  /** EVERY open Slack ask, counted in SQL — not rows.length. The tab badge and
   *  the "one home" sentence quote this, and quoting a capped list as the
   *  authoritative number is how a board starts lying about its own size
   *  (review, Sep 16). */
  total: number;
  /** true when `total` is bigger than what `rows` could carry */
  capped: boolean;
};

/** How many rows the page renders at once. */
const SLACK_PAGE = 60;

/** Every open Slack ask, counted. Cheap enough for a badge or a signpost on a
 *  page that doesn't render the list (the Board tab's pointer at this tab). */
export async function slackOpenCount(): Promise<number> {
  return prisma.smartTask.count({ where: { source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
}

/** Every open Slack ask. `withPermalinks` costs one cached Slack call per row
 *  the first time it is seen, so the tab asks for them and the badge count
 *  does not. */
export async function slackBoard(
  now: Date = new Date(),
  opts: { withPermalinks?: boolean } = {},
): Promise<SlackBoard> {
  const [tasks, total] = await Promise.all([
    prisma.smartTask.findMany({
      where: { source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: {
        id: true, title: true, summary: true, description: true, createdAt: true, assignedKey: true,
        dueAt: true, contactName: true, sourceDetail: true, propertyAddress: true, projectId: true,
        client: { select: { name: true } },
        project: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
      take: SLACK_PAGE,
    }),
    slackOpenCount(),
  ]);
  if (tasks.length === 0) return { rows: [], unassignedCount: 0, overdueCount: 0, total: 0, capped: false };

  // assignedKey is a slug ("jordan", "kim"). The tab showed the slug; a person
  // needs the name.
  const { listAssignees, assigneeName } = await import("@/lib/assignees");
  const assignees = await listAssignees().catch(() => []);
  const nameFor = (key: string | null): string | null => {
    if (!key) return null;
    const n = assigneeName(key, assignees) || key;
    return n.charAt(0).toUpperCase() + n.slice(1);
  };

  const { parseSlackSourceDetail } = await import("@/lib/integrations/slack");
  const parsed = tasks.map((t) => parseSlackSourceDetail(t.sourceDetail));
  // ONE lookup for the whole page, not one per row: these used to resolve
  // serially inside the render, so a 22-row tab made 22 sequential Slack calls
  // before it painted (review, Sep 16).
  const links = opts.withPermalinks
    ? await import("@/lib/integrations/slack").then((m) => m.slackPermalinks(parsed)).catch(() => new Map<string, string | null>())
    : new Map<string, string | null>();
  const rows: SlackTaskRow[] = [];
  for (const [i, t] of tasks.entries()) {
    const { channel, ts } = parsed[i];
    const permalink = channel && ts ? links.get(`${channel}:${ts}`) ?? null : null;
    rows.push({
      taskId: t.id,
      title: t.title,
      summary: t.summary,
      // `description` holds the raw Slack text (and the "(+N more)" rolling
      // card's whole bullet list); the summary is the brain's read of it. On a
      // row the brain summarised in its own words the two are the same string,
      // and printing it twice makes the card look like it is repeating itself —
      // so an identical quote is dropped and only the link survives.
      quote: (() => {
        const d = (t.description ?? "").trim();
        if (!d) return null;
        const sum = (t.summary ?? "").trim();
        return d === sum || d === t.title.trim() ? null : d;
      })(),
      permalink,
      askedBy: t.contactName,
      forWhom: nameFor(t.assignedKey),
      clientName: t.client?.name ?? null,
      propertyAddress: t.propertyAddress ?? t.project?.title ?? null,
      projectId: t.projectId,
      ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / 86_400_000),
      assignedKey: t.assignedKey,
      dueISO: t.dueAt?.toISOString() ?? null,
      overdue: !!t.dueAt && t.dueAt < now,
    });
  }
  // Unassigned first (nobody is doing those), then oldest first — the rest of
  // the ordering is already the query's.
  rows.sort((a, b) => Number(!!a.assignedKey) - Number(!!b.assignedKey));
  return {
    rows,
    unassignedCount: rows.filter((r) => !r.assignedKey).length,
    overdueCount: rows.filter((r) => r.overdue).length,
    total,
    capped: total > rows.length,
  };
}

// Task types that live in the Comms/Revisions/Slack checklists now — the
// Today stack and Board hide them (tracking continues silently underneath).
export const COMMS_VIEW_TASK_TYPES = ["client_reply", "comms_followup", "callback"];

// ---------------------------------------------------------------------------
// KYLE'S 4 O'CLOCK CHECK — rebuilt so the link lands on the work.
//
// Kyle's call (Sep 16): "I thought the Tasks page had stopped being updated."
// The 4pm Slack DM was the main reason. It listed to-do TITLES with no client
// and no property, then appended `${appBase()}/today` — and /today redirects to
// /tasks?tab=today, which the router maps to the COMMS tab. So a DM opening
// with "🔴 Review Erica's video…" landed him on a page reading "Nobody is
// waiting on a text reply". The morning digest had the mirror-image fault: it
// linked the Other tab, which no longer lists Slack rows at all.
//
// So: Slack asks lead (up to 8, oldest first, each with client · property and
// its OWN deep link into /tasks?tab=slack&task=<id>), overdue board tasks
// follow, then what is still due today but not yet late (the old digest's third
// list, restored in review), and every line goes somewhere that contains it.
//
// It keeps the SAME once-a-day claim key as the old digest in notify.ts
// (`kyle-digest-<ET day>`), so even if both were somehow called on one
// afternoon exactly one DM goes out.
// ---------------------------------------------------------------------------

const DIGEST_ITEMS = 8;

export async function afternoonSlackDigest(): Promise<{ sent: boolean; reason?: string }> {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (etHour < 16 || etHour >= 18) return { sent: false, reason: "outside 4-6pm ET" };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const claim = `kyle-digest-${day}`;
  try {
    await prisma.appSetting.create({ data: { key: claim, value: "sent" } });
  } catch {
    return { sent: false, reason: "already sent today" };
  }
  try {
    const { appBase } = await import("@/lib/appUrl");
    const { slackDmUser } = await import("@/lib/integrations/slack");
    const { getMorningBrief, getOverdueTasks, getClientTextTasks } = await import("@/lib/queries");
    const base = appBase();
    // Kyle's Slack id off the roster; the literal is the long-standing fallback
    // that notify.ts has always carried for a row with no slackId.
    const kyle = await prisma.teamMember
      .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { slackId: true } })
      .catch(() => null);
    const slackId = kyle?.slackId || "U07SCBTPDC7";

    const [slack, overdue, brief, texts] = await Promise.all([
      slackBoard().catch(() => ({ rows: [], unassignedCount: 0, overdueCount: 0, total: 0, capped: false } as SlackBoard)),
      getOverdueTasks().catch(() => []),
      getMorningBrief().catch(() => []),
      getClientTextTasks().catch(() => []),
    ]);
    // The Slack rows are listed in full below, so they must not be listed a
    // second time as "overdue board tasks" — the double-listing was half of why
    // the old digest felt like noise.
    const slackIds = new Set(slack.rows.map((r) => r.taskId));
    const boardOverdue = overdue.filter((t) => !slackIds.has(t.id));
    // DUE TODAY, NOT YET LATE — the old 4 o'clock digest's third list (notify.ts
    // kyleAfternoonDigest), which the rebuild dropped. It is the half of the
    // afternoon check that can still be SAVED: something due at 5pm is not
    // overdue at 4pm, and leaving it out meant the DM went quiet on exactly the
    // rows a last hour could rescue (review). Same two exclusions as above so
    // nothing appears twice.
    const listed = new Set([...slackIds, ...boardOverdue.map((t) => t.id)]);
    const dueToday = brief.filter((t) => !listed.has(t.id));

    if (slack.total === 0 && boardOverdue.length === 0 && dueToday.length === 0 && texts.length === 0) {
      await slackDmUser(slackId, "🕓 4 o'clock check — everything's clear. Nice work today. 🎉");
      return { sent: true };
    }

    const where = (client: string | null, property: string | null) => {
      const bits = [client, property?.split(",")[0]?.trim()].filter(Boolean);
      return bits.length ? ` — ${bits.join(" · ")}` : "";
    };
    // Every line lands on the tab that HOLDS the row — the whole point of the
    // rebuild. Comm-type rows live on the Comms tab, everything else on the
    // board; a Slack row can't reach here (it was filtered out above) and the
    // router resolves one anyway.
    const linkFor = (t: { id: string; taskType: string }) =>
      `${base}/tasks?tab=${COMMS_VIEW_TASK_TYPES.includes(t.taskType) ? "comms" : "other"}&task=${t.id}`;

    const lines: string[] = ["🕓 *4 o'clock check* — still open today:"];
    if (slack.total > 0) {
      lines.push(`*Slack asks* (${slack.total}${slack.unassignedCount ? `, ${slack.unassignedCount} unassigned` : ""}):`);
      for (const r of slack.rows.slice(0, DIGEST_ITEMS)) {
        const flag = r.overdue ? "🔴 " : "";
        lines.push(`• ${flag}${r.title}${where(r.clientName, r.propertyAddress)} → ${base}/tasks?tab=slack&task=${r.taskId}`);
      }
      if (slack.total > DIGEST_ITEMS) {
        lines.push(`  …and ${slack.total - DIGEST_ITEMS} more → ${base}/tasks?tab=slack`);
      }
    }
    if (boardOverdue.length > 0) {
      lines.push(`*Overdue on the board* (${boardOverdue.length}):`);
      for (const t of boardOverdue.slice(0, DIGEST_ITEMS)) {
        lines.push(`• 🔴 ${t.title}${where(t.clientName, t.propertyAddress)} → ${linkFor(t)}`);
      }
      if (boardOverdue.length > DIGEST_ITEMS) {
        lines.push(`  …and ${boardOverdue.length - DIGEST_ITEMS} more → ${base}/tasks?tab=other`);
      }
    }
    if (dueToday.length > 0) {
      lines.push(`*Due today* (${dueToday.length}):`);
      for (const t of dueToday.slice(0, DIGEST_ITEMS)) {
        lines.push(`• ${t.title}${where(t.clientName, t.propertyAddress)} → ${linkFor(t)}`);
      }
      if (dueToday.length > DIGEST_ITEMS) {
        lines.push(`  …and ${dueToday.length - DIGEST_ITEMS} more → ${base}/tasks`);
      }
    }
    if (texts.length > 0) {
      lines.push(`✉️ ${texts.length} client text${texts.length === 1 ? "" : "s"} drafted & waiting → ${base}/communications?tab=outbox`);
    }
    await slackDmUser(slackId, lines.join("\n"));
    return { sent: true };
  } catch (e) {
    console.warn("afternoonSlackDigest failed", e);
    // Release the day claim — marking "sent" BEFORE a Slack hiccup permanently
    // ate that day's digest with no retry (audit). The next 5-min tick retries.
    await prisma.appSetting.delete({ where: { key: claim } }).catch(() => {});
    return { sent: false, reason: "failed" };
  }
}
