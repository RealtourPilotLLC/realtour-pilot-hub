import "server-only";
import { prisma } from "@/lib/prisma";
import { stripQuotedReply } from "@/lib/text";

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

const VIP_SEGMENTS = new Set(["vip", "whale"]);

function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 140);
}

// The AppSetting key holding a manual "Handled" ack for one email sender-group.
// Scoped per GROUP (not per client) so ticking Matthew's card can't silently
// hide Arielle's mis-attributed emails (review). Legacy client-wide keys
// (comms-ack-email-<cid>) written before this existed are still honored.
export function emailAckKey(clientId: string, groupKey: string): string {
  return `comms-ack-email-${clientId}:${encodeURIComponent(groupKey)}`;
}

// Automated / non-client email noise: payment failures, receipts, newsletters,
// chamber-of-commerce blasts, no-reply senders. Jordan (Sep 1): "I don't even
// want payment failures to show up." Terms are anchored/word-bounded so a REAL
// client email ("Question about my invoice", "Promo video for 456 Oak St",
// a sender surnamed Chambers or Billings) is never eaten (review HIGH) — the
// transactional shapes must open the subject; marketing terms are word-bound.
const EMAIL_NOISE_SUBJECT = /^(accepted|declined|tentatively accepted|updated invitation|canceled event|cancelled event):|^(your |payment )?(receipt|invoice|statement|renewal|auto-?pay(ment)?)\b|subscription (on hold|paused|cancell?ed)\b|payment (failed|failure|declined|unsuccessful)\b|\b(webinar|newsletter|unsubscribe|promo code|chamber)\b|\bweekly (update|digest)\b|% off|\bsale ends\b/i;
const EMAIL_NOISE_SENDER = /no-?reply|do-?not-?reply|notifications?@|\bbilling\b|support@|\bchamber\b|marketing@|\bnewsletter\b|mailer-daemon|\bautomated\b/i;

// LINEAR-TIME praise/closer detection (the regex version backtracked
// exponentially on "Awesome!!!!…" — review). Tapbacks that QUOTE our message
// are no-reply; a "Questioned" tapback IS a question, so it stays visible.
const REACTION_PREFIX = /^(loved|liked|laughed at|emphasized|disliked)\s+[“"]/i;
const CALL_ARTIFACT = /^(incoming|outgoing) call|recording\.completed|call\.(completed|ringing)/i;
const ACK_WORDS = new Set([
  "oh","thanks","thank","thankyou","you","u","so","much","ty","tysm","awesome","perfect","great","amazing",
  "love","loved","it","them","these","this","beautiful","wonderful","gorgeous","ok","okay","sounds","good",
  "got","the","best","appreciate","yay","cool","nice","will","do","yes","sir","maam","see","then","looks",
  "sweet","excellent","fantastic","incredible","wow","and","are","truly","kyle","jordan",
]);
/** Email bodies arrive with signature junk — `<tel:...>` / `<https://...>`
 *  angle artifacts, `[image: facebook]` blocks, mailto noise — on top of the
 *  quoted history stripQuotedReply removes. Kyle needs the MESSAGE.
 *  The truncation rules are anchored to signature/attribution SHAPE (bold runs
 *  each on their own line; a "wrote:" tail on date attributions) so mid-prose
 *  emphasis or a sentence naming a date can't eat the message — and if a rule
 *  still empties the text, we fall back to the un-truncated base rather than
 *  silently hiding the email (review). */
function cleanEmailBody(raw: string): string {
  const base = stripQuotedReply(raw)
    .replace(/\[image:[^\]]*\]/gi, " ")
    .replace(/<(?:https?:\/\/|mailto:|tel:)[^>]*>/gi, " ")
    .replace(/<\+?[\d\s().-]{7,}>/g, " ");
  const t = base
    .replace(/\*Warning: This email may not be secure[\s\S]*$/i, " ")
    // "*Name*\n*Title*" signature blocks: one bold run per LINE, never at the
    // very start of the message (that's a header, not a signature).
    .replace(/\n\s*\*[^*\n]{2,40}\*[ \t]*\n\s*\*[^*\n]{2,80}\*[\s\S]*$/, " ")
    // Inline quote attributions the line-based stripper can't see ("Sent from
    // my iPhone On Aug 24, 2026, at 11:34 AM, … wrote:") — the "wrote:" tail is
    // REQUIRED so real prose mentioning a date+time survives. Bounded lazy gap
    // spans the sender name/address without catastrophic backtracking.
    .replace(/\bOn (?:[A-Z][a-z]{2,8},\s*)?[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4},? at \d{1,2}:\d{2}\s*[AP]M,?[\s\S]{0,200}?\bwrote:[\s\S]*$/, " ")
    .replace(/\bSent from my (?:iPhone|iPad|Galaxy|Android|mobile device)[\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || base.replace(/\s+/g, " ").trim();
}

function needsReply(body: string | null): boolean {
  const t = (body ?? "").trim();
  if (!t || t.length <= 3) return false;
  if (REACTION_PREFIX.test(t)) return false;
  if (CALL_ARTIFACT.test(t)) return false;
  // A question mark defeats the ack short-circuit — "Are these good?" is made
  // of ack words but IS a question (review).
  if (t.includes("?")) return true;
  // Strip trailing punctuation/emoji, then: a SHORT message made entirely of
  // acknowledgment words needs no answer. Pure token walk — no backtracking.
  const words = t.toLowerCase().replace(/[^a-z']+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 8 && words.every((w) => ACK_WORDS.has(w))) return false;
  if (words.length === 0) return false; // punctuation/emoji only
  return true;
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
    select: { clientId: true, clientName: true, contactName: true, channel: true, direction: true, body: true, subject: true, occurredAt: true, source: true },
  });

  // The Gmail sync logs EVERYTHING it scans as direction "in" — including our
  // own replies when they echo into the scanned inbox. A message authored by
  // us is an ANSWER, never something waiting on one.
  const ourNames = new Set(["us", "realtour pilot", "jordan spackman"]);
  if (family === "email") {
    const team = await prisma.teamMember.findMany({ select: { name: true } }).catch(() => []);
    for (const t of team) if (t.name?.trim()) ourNames.add(t.name.trim().toLowerCase());
  }

  const pending = new Map<string, { clientName: string | null; clientIds: string[]; firstAt: Date; items: { subject: string | null; body: string; at: Date }[] }>();

  // Walk in time order: collect EVERY unanswered inbound, grouped by SENDER.
  // For phone the client record is reliable (number match); for EMAIL the sync
  // sometimes attributes the wrong client (Jordan: "Arielle Roemer is in
  // Matthew Dunbar"), so email groups key on the actual From identity
  // (contactName) and only fall back to the client record without one.
  // Display-name variants merge only on a first-name PREFIX match ("S Mercer"
  // into "Sharra Mercer") — spouses like John/Jane Smith stay separate groups,
  // and a ", Realtor" / "- Keller Williams" suffix never becomes a surname.
  const groupKey = (r: { clientId: string | null; contactName: string | null }): string => {
    if (family !== "email") return r.clientId as string;
    const rawName = (r.contactName ?? "").split(/,|\s[-–—|]\s/)[0];
    // A bare address ("info@agency.com") keys on the address itself.
    if (rawName.includes("@")) return rawName.trim().toLowerCase();
    const name = rawName.trim().toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return `client:${r.clientId}`;
    const parts = name.split(" ");
    if (parts.length < 2) return name;
    const first = parts[0], last = parts[parts.length - 1];
    for (const k of pending.keys()) {
      const bar = k.lastIndexOf("|");
      if (bar < 0) continue;
      const kl = k.slice(0, bar), kf = k.slice(bar + 1);
      if (kl === last && kf && (kf.startsWith(first) || first.startsWith(kf))) return k;
    }
    return `${last}|${first}`;
  };

  for (const r of rows) {
    if (r.direction === "out") {
      // Automated confirmation/delivery texts answer nothing — a client's
      // unanswered question must not vanish because the robot texted (review).
      if ((r.source ?? "").startsWith("auto-")) continue;
      if (r.channel === "call" && /missed|no answer|unanswered/i.test(r.body ?? "")) continue;
      if (family === "email") {
        // Scope the clear to the replied sender's OWN groups — replying to
        // Matthew must not delete Arielle's mis-attributed pile (review).
        const cleared = new Set<string>([
          groupKey(r),
          groupKey({ clientId: r.clientId, contactName: r.clientName }),
          `client:${r.clientId}`,
        ]);
        for (const k of cleared) pending.delete(k);
      } else {
        // Phone: the number match is reliable — an outbound clears the client.
        for (const [k, v] of pending) {
          if (v.clientIds.includes(r.clientId as string)) pending.delete(k);
        }
      }
    } else {
      // Inbound. A missed call / voicemail demands a callback like a text
      // demands a reply (review: those rows were orphaned from every surface).
      let subject: string | null = null;
      let body: string;
      if (r.channel === "call") {
        if (!/missed|voicemail|no answer/i.test(r.body ?? "")) continue; // answered call — nothing owed
        body = /voicemail/i.test(r.body ?? "") ? "Voicemail — call them back" : "Missed call — call them back";
      } else if (family === "email") {
        // Our own reply, logged inbound by the sync (see ourNames above) —
        // treat it as the answer it is: clear the client's pending pile.
        if (ourNames.has((r.contactName ?? "").trim().toLowerCase())) {
          pending.delete(groupKey({ clientId: r.clientId, contactName: r.clientName }));
          pending.delete(`client:${r.clientId}`);
          continue;
        }
        if (EMAIL_NOISE_SUBJECT.test(r.subject ?? "") || EMAIL_NOISE_SENDER.test(r.contactName ?? "")) continue;
        subject = r.subject;
        body = cleanEmailBody(r.body ?? "");
        // Judge reply-worthiness on the CLEANED text — raw quoted history made
        // every "Thanks!" reply look long enough to need an answer (review).
        // A question in the subject keeps the row even with an all-ack body,
        // and a subject-only email ("Available Friday? EOM") still surfaces.
        const subjectAsks = /\?/.test(r.subject ?? "");
        if (body && !needsReply(body) && !subjectAsks) continue;
        if (!body && !needsReply(r.subject)) continue;
      } else {
        if (!needsReply(r.body)) continue;
        body = (r.body ?? "").trim();
      }
      const k = groupKey(r);
      const cur = pending.get(k) ?? { clientName: family === "email" ? (r.contactName || r.clientName) : r.clientName, clientIds: [], firstAt: r.occurredAt, items: [] };
      if (r.clientId) cur.clientIds.push(r.clientId);
      // One email often lands twice (sent to both inboxes) — show it once, but
      // keep the LATEST timestamp: a repeated "Any update?" nudge after a
      // Handled tick must resurface, not stay hidden behind the old ack.
      const dupIdx = cur.items.findIndex((i) => i.subject === subject && i.body === body);
      if (dupIdx !== -1) {
        const [dup] = cur.items.splice(dupIdx, 1);
        dup.at = r.occurredAt;
        cur.items.push(dup);
        pending.set(k, cur);
        continue;
      }
      // Prefer the fullest display-name variant ("Sharra" over "S").
      const candidate = family === "email" ? r.contactName || r.clientName : r.clientName;
      if (candidate && (cur.clientName?.length ?? 0) < candidate.length) cur.clientName = candidate;
      cur.items.push({ subject, body, at: r.occurredAt });
      if (cur.items.length > 5) cur.items.shift(); // show the latest five — firstAt keeps the TRUE oldest age
      pending.set(k, cur);
    }
  }
  if (pending.size === 0) return [];

  // Majority clientId per group (drives the Handled tick + VIP lookup).
  const majority = (ids: string[]): string => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  const groupClientIds = new Map<string, string>();
  for (const [k, v] of pending) groupClientIds.set(k, majority(v.clientIds));
  const allClientIds = [...new Set([...groupClientIds.values()].filter(Boolean))];

  // Handled is CHANNEL-SCOPED (review HIGH: a text reply must not hide a
  // genuinely unanswered email). Phone honors completed client_reply tasks
  // born on the phone side (source ≠ gmail). Email honors the Gmail sync's own
  // reply detection (gmail-sourced completions — the normal way email gets
  // answered) plus the per-group Handled ack markers.
  const ackKeys = family === "email"
    ? [...pending.keys()].flatMap((k) => {
        const cid = groupClientIds.get(k);
        return cid ? [emailAckKey(cid, k), `comms-ack-email-${cid}`] : [];
      })
    : [];
  const [handled, emailAcks, openTasks, clients] = await Promise.all([
    prisma.smartTask.findMany({
      where: {
        clientId: { in: allClientIds },
        taskType: "client_reply",
        status: "COMPLETED",
        completedAt: { gte: since },
        source: family === "phone" ? { not: "gmail" } : "gmail",
      },
      select: { clientId: true, completedAt: true },
    }),
    ackKeys.length
      ? prisma.appSetting.findMany({ where: { key: { in: [...new Set(ackKeys)] } } })
      : Promise.resolve([] as { key: string; value: string }[]),
    prisma.smartTask.findMany({
      where: { clientId: { in: allClientIds }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, clientId: true },
    }),
    prisma.client.findMany({
      where: { id: { in: allClientIds } },
      select: { id: true, name: true, segment: true, parent: { select: { segment: true } } },
    }),
  ]);
  const handledByClient = new Map<string, Date>();
  for (const h of handled) {
    if (h.clientId && h.completedAt && (handledByClient.get(h.clientId) ?? new Date(0)) < h.completedAt) {
      handledByClient.set(h.clientId, h.completedAt);
    }
  }
  const ackByKey = new Map<string, Date>();
  for (const a of emailAcks) {
    const at = new Date(a.value);
    if (!isNaN(at.getTime())) ackByKey.set(a.key, at);
  }
  // The ack/handled timestamp is a CUT POINT, not an all-or-nothing delete:
  // messages at-or-before it are answered and drop away; anything newer stays
  // visible with its wait measured from the first surviving message (review:
  // a new email after an ack used to resurrect the whole pre-ack pile).
  for (const [k, v] of pending) {
    const cid = groupClientIds.get(k);
    const candidates = [
      cid ? handledByClient.get(cid) : undefined,
      ...(family === "email" && cid ? [ackByKey.get(emailAckKey(cid, k)), ackByKey.get(`comms-ack-email-${cid}`)] : []),
    ].filter((d): d is Date => !!d);
    if (candidates.length === 0) continue;
    const at = new Date(Math.max(...candidates.map((d) => d.getTime())));
    v.items = v.items.filter((i) => i.at > at);
    if (v.items.length === 0) { pending.delete(k); continue; }
    if (v.firstAt <= at) v.firstAt = v.items[0].at;
  }
  const taskByClient = new Map(openTasks.filter((t) => t.clientId).map((t) => [t.clientId as string, t.id]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const out: CommsGroup[] = [];
  for (const [k, p] of pending) {
    const cid = groupClientIds.get(k) ?? "";
    const c = clientById.get(cid);
    out.push({
      clientId: cid,
      groupKey: k,
      clientName: p.clientName || c?.name || "Unknown",
      isVip: VIP_SEGMENTS.has(c?.segment ?? "") || VIP_SEGMENTS.has(c?.parent?.segment ?? ""),
      items: p.items.map((i) => ({
        snippet: snippetOf(i.body) || (i.subject ?? ""),
        subject: i.subject,
        body: family === "email" ? i.body.slice(0, 700) : null,
        atISO: i.at.toISOString(),
        ageHours: Math.max(0, Math.round((now.getTime() - i.at.getTime()) / 3_600_000)),
      })),
      // firstAt survives the 5-item display cap — a client 8 messages deep
      // shows their TRUE wait, not the age of message #4 (review).
      oldestHours: Math.max(0, Math.round((now.getTime() - p.firstAt.getTime()) / 3_600_000)),
      openTaskId: taskByClient.get(cid) ?? null,
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
