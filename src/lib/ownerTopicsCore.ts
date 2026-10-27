// ---------------------------------------------------------------------------
// BOTTLENECKS AS TOPICS (Jordan's Loom, Oct 27 2026, 0:22 to 2:52):
//   "for bottlenecks requiring action, I don't really want to see, like, late
//    videos filling this up. I'd rather see like a topic here ... multiple
//    projects delayed over X amount of time. And then, you know, I can click
//    on it to view it."
// and the same for what keeps coming back: a client text nobody answered
// over a weekend, clients asking for round after round, the same complaint
// from several clients ("all shoots by James").
//
// Pure: no database, no model, no clock but the `now` handed in. The loader
// (lib/ownerTopics) reads the records; the AI step (lib/complaintThemes)
// only ever adds tags this file groups. A topic is a COUNT over a WINDOW that
// says what it is ("Videos past due: 7 projects, oldest 4 days late"); its
// items are the records behind the count, so the number is its list.
// ---------------------------------------------------------------------------
import { etDateTime, etWeekday } from "@/lib/datetime";
import type { AssignSeed, Bottleneck, RowAction, Tone } from "@/lib/ownerDashboard";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** The per-record bottleneck's family (set where the bottleneck is built). */
export type TopicCat = "decisions" | "unowned" | "videos-late" | "photos-late" | "photos-not-uploaded" | "scripts" | "on-hold" | "shoot-flags";

export type TopicItem = {
  id: string;
  title: string;
  sub: string;
  tone: Tone;
  href: string;
  /** the record's own button (a delegated task opens through `taskId`) */
  action: Exclude<RowAction, { kind: "task" }> | null;
  taskId?: string | null;
};

export type BottleneckTopic = {
  /** stable: the state (handled, snoozed) and the delegated task are keyed on it */
  key: string;
  title: string;
  /** the count and what it is: "7 projects, oldest 4 days late" */
  summary: string;
  /** "Now" for live work, "Last 7 days" for what keeps coming back */
  window: string;
  count: number;
  tone: Tone;
  /** whose it is to fix (first name), or null */
  owner: string | null;
  /** hub = counted from records; ai = grouped from what clients or the team wrote */
  source: "hub" | "ai";
  items: TopicItem[];
  review: { label: string; href: string } | null;
  delegate: AssignSeed;
  /** an open delegated task for the topic: who has it */
  handledBy: { taskId: string; words: string } | null;
  /** the item ids it was counted from: Mark handled hides it until one not in this list appears */
  ids: string[];
  /** how it was found, said once in the panel */
  note: string | null;
  rank: number;
};

export const topicHref = (key: string) => `/#topic-${key}`;

const lateWords = (h: number) => (h >= 36 ? plural(Math.round(h / 24), "day") : h >= 20 ? "1 day" : plural(Math.max(1, Math.round(h)), "hour"));

type Desk = { key: string | null; name: string | null };
export type TopicDesks = { office: Desk; cm: Desk; owner: Desk };

const CAT: Record<TopicCat, { title: string; rank: number; review: { label: string; href: string } | null; outcome: string; to: "office" | "cm" | null }> = {
  decisions: { title: "Decisions waiting on you", rank: 0, review: null, outcome: "Each one decided", to: null },
  unowned: { title: "Work nobody is on", rank: 1, review: { label: "Open Shoots", href: "/jobs" }, outcome: "A person named on every job", to: "office" },
  "videos-late": { title: "Videos past due", rank: 2, review: { label: "Open Video Delivery", href: "/review" }, outcome: "A recovery plan and a new date for each video, and the clients told", to: "cm" },
  "photos-late": { title: "Photo delivery late", rank: 3, review: { label: "Open Photo Delivery", href: "/ops/photo-delivery" }, outcome: "Each set delivered, or a new date and the client told", to: "office" },
  "photos-not-uploaded": { title: "Photos not uploaded", rank: 4, review: { label: "Open Shoots", href: "/jobs" }, outcome: "The photos uploaded, so editing can start", to: "office" },
  scripts: { title: "Listing scripts not approved", rank: 5, review: null, outcome: "An approved script before each shoot", to: "cm" },
  "on-hold": { title: "Work on hold", rank: 6, review: null, outcome: "Each hold cleared", to: "office" },
  "shoot-flags": { title: "Shoot issues flagged to you", rank: 7, review: null, outcome: "Each one decided, and the cause recorded", to: null },
};

const commonest = (names: (string | null | undefined)[]) => {
  const n = new Map<string, number>();
  for (const x of names) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

const seed = (key: string, title: string, summary: string, outcome: string, to: Desk | null): AssignSeed => ({
  title: clip(`${title}: ${summary}`, 140),
  outcome,
  assigneeKey: to?.key ?? null,
  sourceHref: topicHref(key),
});

/**
 * The live per-record bottlenecks, grouped into one topic per family. The
 * records keep their own buttons (Request update, Remind photographer, Decide)
 * inside the topic's panel.
 */
export function topicsFromBottlenecks(bs: Bottleneck[], desks: TopicDesks): BottleneckTopic[] {
  const groups = new Map<TopicCat, Bottleneck[]>();
  for (const b of bs) {
    if (!b.topic) continue;
    const g = groups.get(b.topic) ?? [];
    g.push(b);
    groups.set(b.topic, g);
  }
  const out: BottleneckTopic[] = [];
  for (const [cat, rows] of groups) {
    const meta = CAT[cat];
    const oldest = Math.max(0, ...rows.map((r) => r.lateHours ?? 0));
    const projects = new Set(rows.map((r) => r.projectId ?? r.id)).size;
    const summary =
      cat === "videos-late" ? `${plural(projects, "project")}, oldest ${lateWords(oldest)} late`
        : cat === "photos-late" ? `${plural(rows.length, "job")}, oldest ${lateWords(oldest)} late`
          : cat === "photos-not-uploaded" ? `${plural(rows.length, "shoot")}, oldest ${lateWords(oldest)} late`
            : cat === "unowned" ? `${plural(rows.length, "job")} with no photographer or editor on ${rows.length === 1 ? "it" : "them"}`
              : cat === "on-hold" ? `${plural(rows.length, "job")} held`
                : cat === "scripts" ? rows[0].issue
                  : cat === "shoot-flags" ? `${plural(rows.length, "flag")} from the team`
                    : `${plural(rows.length, "task")} escalated or waiting on your decision`;
    const to = meta.to === "cm" ? (desks.cm.key ? desks.cm : desks.office) : meta.to === "office" ? desks.office : null;
    const items: TopicItem[] = rows.map((b) => {
      const first = b.actions.find((a) => a.kind !== "task") as TopicItem["action"] | undefined;
      const task = b.actions.find((a) => a.kind === "task") as { taskId: string } | undefined;
      return {
        id: b.id,
        title: b.issue,
        sub: [b.client, b.commitment, b.handledBy?.words ?? b.owner, b.nextStep].filter(Boolean).join(" · "),
        tone: b.tone,
        href: b.href,
        action: first ?? null,
        taskId: task?.taskId ?? null,
      };
    });
    out.push({
      key: cat,
      title: meta.title,
      summary,
      window: "Now",
      count: cat === "videos-late" ? projects : rows.length,
      tone: rows.some((r) => r.tone === "bad") ? "bad" : "warn",
      owner: cat === "decisions" || cat === "shoot-flags" ? "You" : cat === "scripts" ? rows[0].owner : commonest(rows.map((r) => r.owner)),
      source: "hub",
      items,
      review: meta.review,
      delegate: seed(cat, meta.title, summary, meta.outcome, to),
      handledBy: null,
      ids: rows.map((r) => r.id),
      note: null,
      rank: meta.rank,
    });
  }
  return out;
}

// ---- what keeps coming back (last 7 days) ------------------------------------------------

export const WINDOW_DAYS = 7;
const inWindow = (iso: string, now: Date, days = WINDOW_DAYS) => Date.parse(iso) >= now.getTime() - days * DAY && Date.parse(iso) <= now.getTime();

/** One client revision ask (RevisionBrief from the client, by any channel). */
export type RevisionAsk = { id: string; projectId: string; client: string; street: string; atISO: string; href: string };

/** "Repeat revision requests: 2 clients asked for 2+ rounds this week". */
export function repeatRevisionsTopic(asks: RevisionAsk[], now: Date, desks: TopicDesks): BottleneckTopic | null {
  const byJob = new Map<string, RevisionAsk[]>();
  for (const a of asks) {
    if (!inWindow(a.atISO, now)) continue;
    const g = byJob.get(a.projectId) ?? [];
    g.push(a);
    byJob.set(a.projectId, g);
  }
  const repeat = [...byJob.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
  if (!repeat.length) return null;
  const clients = new Set(repeat.map((g) => g[0].client)).size;
  const summary = `${plural(clients, "client")} asked for 2+ rounds in the last 7 days`;
  const key = "repeat-revisions";
  const title = "Repeat revision requests";
  return {
    key, title, summary, window: "Last 7 days", count: clients,
    tone: repeat.some((g) => g.length >= 3) ? "bad" : "warn",
    owner: desks.cm.name ?? desks.office.name,
    source: "hub",
    items: repeat.map((g) => {
      const last = [...g].sort((a, b) => b.atISO.localeCompare(a.atISO))[0];
      return { id: `rev:${g[0].projectId}`, title: `${g[0].client}: ${g[0].street}, ${g.length} rounds`, sub: `Latest ask ${etDateTime(last.atISO)}`, tone: g.length >= 3 ? "bad" : "warn", href: g[0].href, action: null };
    }),
    review: { label: "Open Video Delivery", href: "/review" },
    delegate: seed(key, title, summary, "Why each one keeps coming back, and the fix at the source", desks.cm.key ? desks.cm : desks.office),
    handledBy: null,
    ids: repeat.map((g) => `rev:${g[0].projectId}:${g.length}`),
    note: "Counted from client revision asks (the office's own notes are not asks).",
    rank: 8,
  };
}

/** A message in a conversation with a client, for timing replies. `skip`
 *  marks what never needs or never is an answer (a "thanks!", an automated
 *  text): it neither starts a wait nor ends one. */
export type CommEvent = { id: string; clientId: string; name: string; thread: string; direction: "in" | "out"; atISO: string; body: string; skip?: boolean };
export type ReplyWait = { id: string; clientId: string; name: string; thread: string; fromISO: string; toISO: string | null; hours: number; snippet: string };

/** Every wait of `minHours` or more that started in the window: from the
 *  first unanswered message to our next real reply (or still waiting). */
export function replyWaits(events: CommEvent[], now: Date, minHours = 24): ReplyWait[] {
  const byThread = new Map<string, CommEvent[]>();
  for (const e of events) {
    const k = `${e.clientId}::${e.thread}`;
    const g = byThread.get(k) ?? [];
    g.push(e);
    byThread.set(k, g);
  }
  const out: ReplyWait[] = [];
  for (const g of byThread.values()) {
    g.sort((a, b) => a.atISO.localeCompare(b.atISO));
    let start: CommEvent | null = null;
    const close = (end: CommEvent | null) => {
      if (!start) return;
      const to = end ? Date.parse(end.atISO) : now.getTime();
      const hours = (to - Date.parse(start.atISO)) / HOUR;
      if (hours >= minHours && inWindow(start.atISO, now)) {
        out.push({ id: start.id, clientId: start.clientId, name: start.name, thread: start.thread, fromISO: start.atISO, toISO: end?.atISO ?? null, hours, snippet: clip(start.body.replace(/\s+/g, " ").trim(), 90) });
      }
      start = null;
    };
    for (const e of g) {
      if (e.skip) continue;
      if (e.direction === "in") { if (!start) start = e; }
      else close(e);
    }
    close(null);
  }
  return out.sort((a, b) => b.hours - a.hours);
}

/** "A client text went unanswered: Logan, Sat to Mon". One is enough: a
 *  client left on read over a weekend is the issue. */
export function missedTextsTopic(waits: ReplyWait[], now: Date, desks: TopicDesks): BottleneckTopic | null {
  if (!waits.length) return null;
  const one = waits.length === 1 ? waits[0] : null;
  const span = (w: ReplyWait) => `${etWeekday(w.fromISO)} to ${w.toISO ? etWeekday(w.toISO) : "now, still waiting"}`;
  const names = [...new Set(waits.map((w) => w.name))];
  const key = "missed-texts";
  const title = one ? "A client text went unanswered" : "Client texts unanswered a day or more";
  const summary = one ? `${one.name}, ${span(one)}` : `${plural(waits.length, "text")} in the last 7 days (${clip(names.join(", "), 60)})`;
  return {
    key, title, summary, window: "Last 7 days", count: waits.length,
    tone: waits.some((w) => !w.toISO) ? "bad" : "warn",
    owner: desks.office.name,
    source: "hub",
    items: waits.map((w) => ({ id: `text:${w.id}`, title: `${w.name}: "${w.snippet}"`, sub: `${etDateTime(w.fromISO)} to ${w.toISO ? etDateTime(w.toISO) : "now (still waiting)"} · ${lateWords(w.hours)}`, tone: w.toISO ? "warn" : "bad", href: "/communications", action: null })),
    review: { label: "Open Messages", href: "/communications" },
    delegate: seed(key, title, summary, "Why the texts waited, and how the line is covered nights and weekends", desks.office),
    handledBy: null,
    ids: waits.map((w) => `text:${w.id}`),
    note: "Client texts and our next real reply (automated texts and a plain thanks don't count).",
    rank: 9,
  };
}

/** "Slow replies to clients: 4 threads waited 24h+". Two or more: one slow
 *  thread is the inbox's job, a pattern is the dashboard's. */
export function slowRepliesTopic(waits: ReplyWait[], now: Date, desks: TopicDesks): BottleneckTopic | null {
  if (waits.length < 2) return null;
  const key = "slow-replies";
  const title = "Slow replies to clients";
  const summary = `${plural(waits.length, "email thread")} waited 24h+ in the last 7 days`;
  void now;
  return {
    key, title, summary, window: "Last 7 days", count: waits.length,
    tone: waits.filter((w) => !w.toISO).length >= 2 ? "bad" : "warn",
    owner: desks.office.name,
    source: "hub",
    items: waits.map((w) => ({ id: `email:${w.id}`, title: `${w.name}: ${clip(w.thread || w.snippet, 80)}`, sub: `${etDateTime(w.fromISO)} to ${w.toISO ? etDateTime(w.toISO) : "now (still waiting)"} · ${lateWords(w.hours)}`, tone: w.toISO ? "warn" : "bad", href: "/communications?tab=email", action: null })),
    review: { label: "Open Messages", href: "/communications?tab=email" },
    delegate: seed(key, title, summary, "Every thread answered, and what slowed them", desks.office),
    handledBy: null,
    ids: waits.map((w) => `email:${w.id}`),
    note: "Client email threads and our next reply, from every connected mailbox.",
    rank: 10,
  };
}

/** A photo problem on one job: a QC finding the photographer answers for, or a person's flag on a photo. */
export type PhotoIssue = { id: string; key: string; label: string; projectId: string; client: string; street: string; shooter: string | null; atISO: string; href: string };

const shooterWords = (shooters: (string | null)[]) => {
  const named = shooters.filter((s): s is string => !!s);
  if (!named.length) return "";
  const set = [...new Set(named)];
  if (set.length === 1 && named.length === shooters.length) return `, all shoots by ${set[0]}`;
  const counts = set.map((s) => `${s} ${named.filter((x) => x === s).length}`);
  return ` (${counts.join(", ")})`;
};

/** The same photo problem on 3+ different jobs in 7 days. */
export function photoIssueTopics(issues: PhotoIssue[], now: Date, desks: TopicDesks): BottleneckTopic[] {
  const byKey = new Map<string, PhotoIssue[]>();
  for (const i of issues) {
    if (!inWindow(i.atISO, now)) continue;
    const g = byKey.get(i.key) ?? [];
    g.push(i);
    byKey.set(i.key, g);
  }
  const out: BottleneckTopic[] = [];
  for (const [k, g] of byKey) {
    const jobs = new Map<string, PhotoIssue>();
    for (const i of g) if (!jobs.has(i.projectId)) jobs.set(i.projectId, i);
    if (jobs.size < 3) continue;
    const list = [...jobs.values()];
    const key = `photo:${k}`;
    const title = `Recurring photo issue: ${list[0].label}`;
    const summary = `${plural(list.length, "shoot")} in the last 7 days${shooterWords(list.map((i) => i.shooter))}`;
    const shooter = commonest(list.map((i) => i.shooter));
    out.push({
      key, title, summary, window: "Last 7 days", count: list.length,
      tone: list.length >= 5 ? "bad" : "warn",
      owner: shooter ?? desks.office.name,
      source: "hub",
      items: list.map((i) => ({ id: `photo:${k}:${i.projectId}`, title: `${i.street}: ${i.label}`, sub: [i.client, i.shooter ? `Shot by ${i.shooter}` : null, etDateTime(i.atISO)].filter(Boolean).join(" · "), tone: "warn", href: i.href, action: null })),
      review: { label: "Open Photo Delivery", href: "/ops/photo-delivery" },
      delegate: seed(key, title, summary, "The cause found, and the photographer coached on it", desks.cm.key ? desks.cm : desks.office),
      handledBy: null,
      ids: list.map((i) => `photo:${k}:${i.projectId}`),
      note: "The photo check's findings the photographer answers for, and the team's own flags on photos.",
      rank: 11,
    });
  }
  return out;
}

// ---- what clients and the team keep writing about (AI tags, grouped here) ------------------

/** The complaint vocabulary the model may answer with (anything else is dropped). */
export const CLIENT_THEMES = {
  photo_angles: "photo angles or composition",
  photo_quality: "photo quality",
  video_edit: "video editing",
  late_delivery: "late delivery",
  communication: "slow or unclear communication",
  scheduling: "scheduling",
  billing: "billing",
  missing_items: "missing items in a delivery",
  other_complaint: "something else",
} as const;
/** What the team keeps hitting, from Slack. */
export const TEAM_THEMES = {
  upload_problem: "upload problems",
  missing_footage: "missing footage or files",
  equipment: "equipment",
  handoff: "handoffs between the team",
  tool_outage: "a tool not working",
} as const;
export type ThemeKey = keyof typeof CLIENT_THEMES | keyof typeof TEAM_THEMES;
const isTheme = (t: string): t is ThemeKey => t in CLIENT_THEMES || t in TEAM_THEMES;

/** One message the model tagged. */
export type ThemeTag = { commLogId: string; channel: string; clientId: string | null; client: string | null; projectId: string | null; theme: ThemeKey; detail: string; atISO: string };

/**
 * The model's answer, checked: only ids it was asked about, only themes in
 * the vocabulary ("none" = not a complaint), a detail of a few words. Never
 * throws; anything malformed is dropped (and so changes nothing).
 */
export function parseThemeReply(raw: unknown, askedIds: string[]): { id: string; theme: ThemeKey | "none"; detail: string }[] {
  const asked = new Set(askedIds);
  const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : [];
  const out: { id: string; theme: ThemeKey | "none"; detail: string }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const { id, theme, detail } = it as { id?: unknown; theme?: unknown; detail?: unknown };
    if (typeof id !== "string" || !asked.has(id) || seen.has(id) || typeof theme !== "string") continue;
    const t = theme.trim().toLowerCase();
    if (t !== "none" && !isTheme(t)) continue;
    seen.add(id);
    out.push({ id, theme: t as ThemeKey | "none", detail: typeof detail === "string" ? clip(detail.replace(/\s+/g, " ").trim().toLowerCase(), 60) : "" });
  }
  return out;
}

/** What the AI step keeps between runs (AppSetting `owner_complaint_themes`). */
export type ThemeStore = {
  v: 1;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** every message already read (tagged or not), so none is sent twice */
  seen: { id: string; at: string }[];
  tags: ThemeTag[];
};
export const EMPTY_THEME_STORE: ThemeStore = { v: 1, lastRunAt: null, lastOkAt: null, lastError: null, seen: [], tags: [] };
export const THEME_KEEP_DAYS = 14;

/**
 * One run's result folded into the store. A failed run (the model down, a
 * timeout, a refusal) records the error and changes nothing else: no tag is
 * added or removed, no message is marked read. Old entries (14 days) age out
 * only on a run that worked.
 */
export function foldThemeRun(prev: ThemeStore, run: { ok: true; read: { id: string; at: string }[]; tags: ThemeTag[] } | { ok: false; error: string }, now: Date): ThemeStore {
  const at = now.toISOString();
  if (!run.ok) return { ...prev, lastRunAt: at, lastError: clip(run.error, 200) };
  const cutoff = now.getTime() - THEME_KEEP_DAYS * DAY;
  const keep = <T extends { at?: string; atISO?: string }>(x: T) => Date.parse(x.at ?? x.atISO ?? at) >= cutoff;
  const seenIds = new Set(prev.seen.map((s) => s.id));
  const tagIds = new Set(prev.tags.map((t) => t.commLogId));
  return {
    v: 1,
    lastRunAt: at,
    lastOkAt: at,
    lastError: null,
    seen: [...prev.seen, ...run.read.filter((r) => !seenIds.has(r.id))].filter(keep),
    tags: [...prev.tags, ...run.tags.filter((t) => !tagIds.has(t.commLogId))].filter(keep),
  };
}

/** AI topics are shown only while the step is running well: a store whose
 *  last good run is over a day old (the AI down, the switch off) shows none. */
export const THEMES_FRESH_HOURS = 24;
export function themesUsable(store: ThemeStore | null, now: Date): boolean {
  return !!store?.lastOkAt && now.getTime() - Date.parse(store.lastOkAt) <= THEMES_FRESH_HOURS * HOUR;
}

/**
 * "Recurring client complaint: 3 clients in 7 days about bathroom angles,
 * all shoots by James". A client theme needs two different clients in the
 * window; a team theme (Slack) three messages. `shooterOf` names who shot a
 * job, so a pattern on one photographer says so.
 */
export function themeTopics(store: ThemeStore | null, now: Date, desks: TopicDesks, shooterOf: (projectId: string | null) => string | null): BottleneckTopic[] {
  if (!store || !themesUsable(store, now)) return [];
  const byTheme = new Map<ThemeKey, ThemeTag[]>();
  for (const t of store.tags) {
    if (!inWindow(t.atISO, now)) continue;
    const g = byTheme.get(t.theme) ?? [];
    g.push(t);
    byTheme.set(t.theme, g);
  }
  const out: BottleneckTopic[] = [];
  for (const [theme, g] of byTheme) {
    const team = theme in TEAM_THEMES;
    const clients = new Set(g.map((t) => t.clientId ?? t.client).filter(Boolean)).size;
    if (team ? g.length < 3 : clients < 2) continue;
    const words = team ? TEAM_THEMES[theme as keyof typeof TEAM_THEMES] : CLIENT_THEMES[theme as keyof typeof CLIENT_THEMES];
    // The detail two or more of them share says it better than the theme ("bathroom angles").
    const detail = commonest(g.map((t) => t.detail).filter((d) => d && g.filter((x) => x.detail === d).length >= 2));
    const about = detail ?? words;
    const key = `ai:${theme}`;
    const title = team ? `The team keeps hitting ${words}` : "Recurring client complaint";
    // Who shot it is said per JOB (two complaints about one shoot are one
    // shoot), and only from two jobs on: a message tied to no job neither
    // spoils "all shoots by Harrison" nor is counted as one of his.
    const jobs = team ? [] : [...new Set(g.map((t) => t.projectId).filter((p): p is string => !!p))];
    const shooters = jobs.map((p) => shooterOf(p));
    const summary = team
      ? `${plural(g.length, "Slack message")} in the last 7 days${detail ? ` about ${detail}` : ""}`
      : `${plural(clients, "client")} in the last 7 days about ${about}${jobs.length >= 2 && shooters.some(Boolean) ? shooterWords(shooters) : ""}`;
    out.push({
      key, title, summary, window: "Last 7 days", count: team ? g.length : clients,
      tone: !team && clients >= 3 ? "bad" : "warn",
      owner: team ? desks.office.name : theme === "photo_angles" || theme === "photo_quality" || theme === "video_edit" ? desks.cm.name ?? desks.office.name : desks.office.name,
      source: "ai",
      items: g.sort((a, b) => b.atISO.localeCompare(a.atISO)).map((t) => ({
        id: `ai:${t.commLogId}`,
        title: `${t.client ?? (t.channel === "slack" ? "Slack" : "A client")}: ${t.detail || words}`,
        sub: [t.channel === "slack" ? "Slack" : t.channel === "email" ? "Email" : "Text", etDateTime(t.atISO), shooterOf(t.projectId) ? `Shot by ${shooterOf(t.projectId)}` : null].filter(Boolean).join(" · "),
        tone: "warn" as Tone,
        href: t.projectId ? `/projects/${t.projectId}` : t.clientId ? `/clients/${t.clientId}` : "/communications",
        action: null,
      })),
      review: { label: "Open Messages", href: "/communications" },
      delegate: seed(key, title, summary, "The cause found and fixed at the source, and the clients answered", team ? desks.office : theme.startsWith("photo") || theme === "video_edit" ? (desks.cm.key ? desks.cm : desks.office) : desks.office),
      handledBy: null,
      ids: g.map((t) => `ai:${t.commLogId}`),
      note: `Grouped by AI from ${team ? "the team's Slack messages" : "client texts and emails"}; read the messages before acting.`,
      rank: 12,
    });
  }
  return out;
}

// ---- his decisions on a topic --------------------------------------------------------------

/** What he did with a topic (AppSetting `owner_topic:<key>`). */
export type TopicState = { state: "handled" | "snoozed" | "mine"; at: string; until: string | null; ids: string[]; by: string | null };
export const TOPIC_STATE_PREFIX = "owner_topic:";
export const SNOOZE_DAYS = 7;

/** Hidden while snoozed; once handled (or made his own task), hidden until a record not counted then appears. */
export function topicHidden(t: Pick<BottleneckTopic, "ids">, s: TopicState | null | undefined, now: Date): boolean {
  if (!s) return false;
  if (s.state === "snoozed") return !!s.until && Date.parse(s.until) > now.getTime();
  const then = new Set(s.ids);
  return t.ids.every((id) => then.has(id));
}

/** Live work first (by family), then what keeps coming back; a topic someone already has sinks. */
export function orderTopics(ts: BottleneckTopic[]): BottleneckTopic[] {
  return [...ts].sort((a, b) => Number(!!a.handledBy) - Number(!!b.handledBy) || a.rank - b.rank || Number(b.tone === "bad") - Number(a.tone === "bad") || b.count - a.count);
}
