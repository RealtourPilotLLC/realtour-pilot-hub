import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";
import { firstName } from "@/lib/assignees";
import { isAckOnlyInbound, isCourtesyMessage, outboundIsAnswer } from "@/lib/replyQueue";
import { ruleById } from "@/lib/photoDelivery/registry";
import type { Bottleneck } from "@/lib/ownerDashboard";
import {
  EMPTY_THEME_STORE, TOPIC_STATE_PREFIX, missedTextsTopic, orderTopics, photoIssueTopics, repeatRevisionsTopic, replyWaits, slowRepliesTopic,
  themeTopics, themesUsable, topicHidden, topicHref, topicsFromBottlenecks,
  type BottleneckTopic, type CommEvent, type PhotoIssue, type ThemeStore, type TopicDesks, type TopicState,
} from "@/lib/ownerTopicsCore";

// ---------------------------------------------------------------------------
// THE TOPICS ON JORDAN'S DASHBOARD, READ (Loom, Oct 27 2026; the rules are in
// lib/ownerTopicsCore). Live work comes grouped from the bottleneck rows the
// dashboard already built; what keeps coming back is read here, each source
// on its own so one that fails is named and the rest still show:
//   · client revision asks (RevisionBrief, the office's own notes excluded);
//   · client texts and emails and our next real reply (CommLog; a thanks and
//     an automated text neither start nor end a wait: replyQueue's tests);
//   · photo problems on three or more jobs: the photo check's findings the
//     photographer answers for, and the team's flags on photos;
//   · complaint themes the AI step tagged (lib/complaintThemes): read from
//     its store only, never a model call on a page load, and shown only
//     while that step is running well.
// His decisions (Mark handled, Snooze, Make it my task) are AppSetting rows
// `owner_topic:<key>`; a topic someone was given shows who has it.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
export const THEME_STORE_KEY = "owner_complaint_themes";

const subjectKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

export async function readThemeStore(): Promise<ThemeStore | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: THEME_STORE_KEY } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<ThemeStore>;
    return { ...EMPTY_THEME_STORE, ...v, seen: Array.isArray(v.seen) ? v.seen : [], tags: Array.isArray(v.tags) ? v.tags : [] };
  } catch {
    return null;
  }
}

export async function readTopicStates(): Promise<Map<string, TopicState>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: TOPIC_STATE_PREFIX } }, select: { key: true, value: true } });
  const out = new Map<string, TopicState>();
  for (const r of rows) {
    try { out.set(r.key.slice(TOPIC_STATE_PREFIX.length), JSON.parse(r.value) as TopicState); } catch { /* a bad row is no decision */ }
  }
  return out;
}

export async function loadOwnerTopics(opts: { now: Date; bottlenecks: Bottleneck[]; excludeClientIds: string[]; desks: TopicDesks }): Promise<{ topics: BottleneckTopic[]; unavailable: string[]; note: string | null }> {
  const { now, desks } = opts;
  const exclude = opts.excludeClientIds;
  const since7 = new Date(now.getTime() - 7 * DAY);
  // A wait that started seven days ago is timed from the messages before it too.
  const since8 = new Date(now.getTime() - 8 * DAY);
  const unavailable: string[] = [];
  const fail = (what: string) => (e: unknown) => {
    console.warn(`owner topics: ${what} failed`, (e as Error)?.message);
    unavailable.push(what);
    return null;
  };
  const clientScope = exclude.length ? { clientId: { notIn: exclude } } : {};
  const [asks, comms, findings, flags, store, states] = await Promise.all([
    prisma.revisionBrief.findMany({
      where: { createdAt: { gte: since7 }, OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }], ...(exclude.length ? { project: clientScope } : {}) },
      select: { id: true, projectId: true, createdAt: true, project: { select: { title: true, client: { select: { name: true } } } } },
    }).catch(fail("revision asks")),
    prisma.commLog.findMany({
      where: { channel: { in: ["text", "email", "call"] }, occurredAt: { gte: since8 }, clientId: { not: null, ...(exclude.length ? { notIn: exclude } : {}) } },
      orderBy: { occurredAt: "asc" },
      take: 4000,
      select: { id: true, channel: true, direction: true, clientId: true, clientName: true, contactName: true, subject: true, body: true, source: true, occurredAt: true },
    }).catch(fail("client messages")),
    prisma.photoQcFinding.findMany({
      where: { createdAt: { gte: since7 }, responsibility: "PHOTOGRAPHER", status: { notIn: ["FALSE_POSITIVE", "SUPERSEDED", "OVERRIDDEN"] }, arbitration: { not: "OVERTURNED" } },
      select: { id: true, ruleId: true, createdAt: true, job: { select: { projectId: true } } },
      take: 2000,
    }).catch(fail("photo check findings")),
    prisma.imageFlag.findMany({ where: { createdAt: { gte: since7 } }, select: { id: true, projectId: true, tags: true, createdAt: true }, take: 1000 }).catch(fail("photo flags")),
    readThemeStore().catch(fail("complaint themes")),
    readTopicStates().catch(fail("topic decisions")),
  ]);

  // The jobs behind the photo problems and the AI tags: street, client, who shot it.
  const pids = new Set<string>();
  for (const f of findings ?? []) pids.add(f.job.projectId);
  for (const f of flags ?? []) pids.add(f.projectId);
  for (const t of store?.tags ?? []) if (t.projectId) pids.add(t.projectId);
  const projects = pids.size
    ? await prisma.project.findMany({ where: { id: { in: [...pids] } }, select: { id: true, title: true, clientId: true, client: { select: { name: true } }, photographer: { select: { name: true } } } }).catch(fail("jobs"))
    : [];
  const proj = new Map((projects ?? []).map((p) => [p.id, p]));
  const excluded = new Set(exclude);
  const shooterOf = (pid: string | null) => {
    const n = pid ? proj.get(pid)?.photographer?.name : null;
    return n ? firstName(n) : null;
  };

  const topics: BottleneckTopic[] = topicsFromBottlenecks(opts.bottlenecks, desks);

  if (asks) {
    const t = repeatRevisionsTopic(asks.map((a) => ({ id: a.id, projectId: a.projectId, client: a.project?.client?.name ?? "A client", street: (a.project?.title ?? "").split(",")[0] || "A job", atISO: a.createdAt.toISOString(), href: `/projects/${a.projectId}` })), now, desks);
    if (t) topics.push(t);
  }

  if (comms) {
    const name = (c: (typeof comms)[number]) => (c.clientName || c.contactName || "A client").split(/\s+/)[0];
    const texts: CommEvent[] = [];
    const emails: CommEvent[] = [];
    const answers: { clientId: string; e: Omit<CommEvent, "thread"> }[] = [];
    const threadsOf = new Map<string, Set<string>>();
    for (const c of comms) {
      const base = { id: c.id, clientId: c.clientId!, name: name(c), direction: (c.direction === "out" ? "out" : "in") as "in" | "out", atISO: c.occurredAt.toISOString(), body: c.body ?? "" };
      if (base.direction === "out") {
        const skip = !outboundIsAnswer({ channel: c.channel, source: c.source, body: c.body });
        // Any real answer to the client (a text, a call, an email) ends a text wait.
        texts.push({ ...base, thread: "", skip });
        if (c.channel === "email") emails.push({ ...base, thread: subjectKey(c.subject), skip });
        else if (!skip) answers.push({ clientId: base.clientId, e: base });
        continue;
      }
      if (c.channel === "call") continue; // a call in is not a text to answer
      if (c.channel === "text") texts.push({ ...base, thread: "", skip: isCourtesyMessage(base.body) || isAckOnlyInbound(base.body, "text") });
      else {
        const thread = subjectKey(c.subject);
        emails.push({ ...base, thread, skip: isCourtesyMessage(base.body) || isAckOnlyInbound(base.body, "email") });
        const set = threadsOf.get(base.clientId) ?? new Set<string>();
        set.add(thread);
        threadsOf.set(base.clientId, set);
      }
    }
    // A client who emailed and was called or texted back was answered.
    for (const a of answers) for (const thread of threadsOf.get(a.clientId) ?? []) emails.push({ ...a.e, thread });
    const tt = missedTextsTopic(replyWaits(texts, now), now, desks);
    if (tt) topics.push(tt);
    const et = slowRepliesTopic(replyWaits(emails, now), now, desks);
    if (et) topics.push(et);
  }

  const issues: PhotoIssue[] = [];
  const issueOf = (id: string, key: string, label: string, pid: string, at: Date): PhotoIssue | null => {
    const p = proj.get(pid);
    if (!p || (p.clientId && excluded.has(p.clientId))) return null;
    return { id, key, label, projectId: pid, client: p.client?.name ?? "A client", street: p.title.split(",")[0], shooter: shooterOf(pid), atISO: at.toISOString(), href: `/projects/${pid}` };
  };
  for (const f of findings ?? []) {
    const i = issueOf(f.id, `qc:${f.ruleId}`, ruleById(f.ruleId)?.shortLabel ?? f.ruleId.toLowerCase().replace(/_/g, " "), f.job.projectId, f.createdAt);
    if (i) issues.push(i);
  }
  for (const f of flags ?? []) {
    let tags: string[] = [];
    try { tags = (JSON.parse(f.tags) as unknown[]).filter((t): t is string => typeof t === "string"); } catch { /* untagged */ }
    for (const tag of tags) {
      const i = issueOf(`${f.id}:${tag}`, `flag:${tag.toLowerCase()}`, tag, f.projectId, f.createdAt);
      if (i) issues.push(i);
    }
  }
  topics.push(...photoIssueTopics(issues, now, desks));

  // The AI half: only from its store, only while it runs well.
  const ai = themeTopics(store ?? null, now, desks, shooterOf).filter((t) => t.items.length);
  topics.push(...ai);
  const note = store?.lastRunAt && !themesUsable(store, now)
    ? `Complaint themes are paused: the AI step last ran well ${store.lastOkAt ? etDateTime(store.lastOkAt) : "never"}. Everything else here is counted from records.`
    : null;

  // Who has each topic already (a delegated task keyed to the topic).
  const keys = topics.map((t) => `deleg:${topicHref(t.key)}`.slice(0, 190));
  const tasks = keys.length
    ? await prisma.smartTask.findMany({ where: { dedupeKey: { in: keys }, status: { notIn: ["COMPLETED", "CANCELLED"] }, delegatedAt: { not: null } }, select: { id: true, dedupeKey: true } }).catch(fail("topic tasks"))
    : [];
  if (tasks?.length) {
    const { delegationFor } = await import("@/lib/delegation");
    const views = await delegationFor(tasks.map((t) => t.id)).catch(() => new Map());
    for (const t of topics) {
      const task = tasks.find((x) => x.dedupeKey === `deleg:${topicHref(t.key)}`.slice(0, 190));
      const v = task ? views.get(task.id) : null;
      if (v) t.handledBy = { taskId: v.taskId, words: `${v.assigneeName ?? "Someone"} has it · ${v.state === "ASSIGNED" ? "not accepted yet" : String(v.state).toLowerCase().replace(/_/g, " ")}` };
    }
  }

  const visible = topics.filter((t) => !topicHidden(t, states?.get(t.key), now));
  return { topics: orderTopics(visible), unavailable, note };
}
