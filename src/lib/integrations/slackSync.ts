import "server-only";
import { getSecret } from "./connections";
import { logComm } from "@/lib/commLog";
import { clip, stripInvisible } from "@/lib/text";
import { etAt, etDayKey } from "@/lib/datetime";

// Keep Slack comms memory fresh. A USER token can't receive webhooks, so the
// hourly cron calls this to pull RECENT history (default last 48h) for the
// editor channels + Jordan's DMs with Kyle/Kim/Remar. Idempotent (logComm
// dedups on externalId=slack-<channel>-<ts>), so overlapping windows are safe.

// Jordan's Slack user id. Since Sep 15 the roster (TeamMember.slackId on his
// People card) is the source of truth and the literal is only the fallback
// for a roster that has lost it — cached ten minutes; the poll runs hourly.
const ME_FALLBACK = "U07D2KJH1JP"; // Jordan
let meCache: { at: number; id: string } | null = null;
async function jordanSlackId(): Promise<string> {
  if (meCache && Date.now() - meCache.at < 10 * 60_000) return meCache.id;
  let id = ME_FALLBACK;
  try {
    const { prisma } = await import("@/lib/prisma");
    const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
    const ids = await ownerTeamMemberIds();
    if (ids.length) {
      // Jordan's row first (Lauren is an owner login too); any owner with an
      // id after that.
      const row =
        (await prisma.teamMember.findFirst({
          where: { id: { in: ids }, slackId: { not: null }, name: { startsWith: "Jordan", mode: "insensitive" } },
          select: { slackId: true },
        })) ??
        (await prisma.teamMember.findFirst({ where: { id: { in: ids }, slackId: { not: null } }, select: { slackId: true } }));
      if (row?.slackId) id = row.slackId;
    }
  } catch { /* the literal */ }
  meCache = { at: Date.now(), id };
  return id;
}
const TARGET_DM_USERS: Record<string, string> = {
  U07SCBTPDC7: "Kyle Smith",
  U0ASP9C1WRK: "Kim",
  // Remar departed (John replaced her) — her DM poll removed Aug 25 (audit).
};
const CHANNEL_NAME_RE = /video-editing|project-tracker|photo-editing/i;

// ---------------------------------------------------------------------------
// WHO A SLACK ASK IS FOR (Sep 8 audit). Jordan: "Slack tasks go to Kyle
// typically but I don't want him to get flooded with Slack tasks. Honestly the
// tasks should go from the person sending to who it was sent to."
//
// 9 of the 10 open Slack rows named their owner in plain words and still sat
// in "Needs assigning", because the old parser routed nothing on purpose (its
// keyword routing had mis-fired). This is not keyword routing: it reads who
// the message is ADDRESSED to, in this order, and stops at the first hit —
//   1. a leading address in the text: "Kyle to …", "Kyle: …", "Kyle, …",
//      "Hey Harrison …", "@Kim …";
//   2. one @mention that is not a subject ("let @Kim know" is for the reader);
//   3. the sender's own commitment ("I'll add it to the tracker") → the sender;
//   4. the brain's own "Kyle to …" title (it read the whole thread);
//   5. a DM: Jordan → the person he is DMing, and they → Jordan.
// Anything else stays UNASSIGNED so it lands in "Needs assigning" — never a
// default to Kyle. A name that is merely the subject ("Let Harrison know…",
// "Harrison only took 17 photos", "James should be there by 9am") is not an
// address, so the patterns are about who ACTS; when unsure, nobody.
//
// In a 1:1 DM only the two people in it can be addressed (Sep 8 review): a
// third name there is always the subject — "Harrison needs to go back for the
// missed pic" in Jordan's DM with Kyle is Kyle's to relay, and a row assigned
// to Harrison would sit on nobody's screen (no photographer surface reads
// internal_instruction and the bell only rings on a manual assign).
// Curly apostrophes (Slack's phone keyboards write "I’ll") are straightened
// first so the self-commitment and ask patterns see them.
// ---------------------------------------------------------------------------

export type SlackRosterEntry = {
  /** assignedKey slug exactly as the rest of the engine stores it (kyle, kim, john, harrison…). */
  key: string;
  /** First name, for the card wording. */
  name: string;
  teamMemberId: string | null;
  slackId: string | null;
  /** Lower-case spellings that mean this person (full name, first name, Slack display-name typos). */
  aliases: string[];
};

export type SlackAddressee = {
  key: string;
  name: string;
  teamMemberId: string | null;
  how: "leading" | "mention" | "self" | "title" | "dm";
};

// Slack display names that are not the roster spelling. "Jhon Mark" is what
// John Mark's Slack profile says, and it is how the poll unwraps his @mention.
const SLACK_NAME_ALIASES: Record<string, string> = { "jhon mark": "john", jhon: "john" };

/** The active team, keyed the way assignedKey is stored. Inactive rows (Remar,
 *  departed photographers) are excluded so nothing new can land on them. */
export async function loadSlackRoster(): Promise<SlackRosterEntry[]> {
  const { prisma } = await import("@/lib/prisma");
  const { slugForName, firstName } = await import("@/lib/assignees");
  const members = await prisma.teamMember.findMany({
    where: { active: true },
    select: { id: true, name: true, slackId: true },
  });
  return members.map((m) => {
    const key = slugForName(m.name);
    const full = m.name.trim().toLowerCase().replace(/\s+/g, " ");
    const aliases = new Set<string>([full, full.split(" ")[0]]);
    for (const [alias, k] of Object.entries(SLACK_NAME_ALIASES)) if (k === key) aliases.add(alias);
    return {
      key,
      name: firstName(m.name),
      teamMemberId: m.id,
      slackId: m.slackId ?? null,
      aliases: [...aliases].filter((a) => a.length >= 3),
    };
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rosterLookup(roster: SlackRosterEntry[]) {
  const byAlias = new Map<string, SlackRosterEntry>();
  for (const r of roster) for (const a of r.aliases) byAlias.set(a, r);
  const alt = [...byAlias.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const find = (name: string | null | undefined): SlackRosterEntry | null => {
    const n = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!n) return null;
    return byAlias.get(n) ?? byAlias.get(n.split(" ")[0]) ?? null;
  };
  return { alt, find };
}

// Greetings that can sit in front of a name without changing who it is for.
const GREET = "(?:(?:hey|hi|hello|yo|good morning|morning|good afternoon|afternoon)[\\s,!.]+)+(?:(?:bro|man|dude|team)[\\s,!.]+)?";
// Fillers a message may open with before it gets to the name.
const OPENER = "(?:(?:ok|okay|also|and|so|oh|yeah|yes)[\\s,!.]+)*";
// What must FOLLOW a leading name for it to be an address rather than a subject.
// "Kyle will/should/needs to …" is NOT here (Sep 8 review): those describe the
// person, they do not speak to them — "James should be there by 9am tomorrow"
// is news for the reader, not a task for James.
const ADDRESS_TAIL =
  "(?:\\s*[:,\\-–—!]|\\s+(?:to|please|pls|can you|could you|would you|will you|do you|did you|are you|have you|when you|if you|you|let'?s)\\b|\\s*$)";
// Words that make an @mention the SUBJECT of the sentence, not its addressee.
// Thanking someone addresses them ("thanks @Kim, can you also fix the typo"),
// so thank/thanks is not a subject cue (Sep 8 review).
const SUBJECT_CUE_RE = /\b(?:let|tell|ask|remind|notify|inform|update|ping|contact|call|text|email|message|with|to|for|from|about|cc|and|or)\s*$/i;
// The sender committing to do it themselves ("I'll add it to the tracker",
// "will send John's video shortly", "I'm currently exporting it"). "I got" /
// "I've got" are not commitments — "I got the photos, send them to Kim" is an
// ask of the reader (Sep 8 review).
const SELF_RE =
  /^(?:(?:ok(?:ay)?|yeah|yes|yep|sure|awesome|great|sounds good|got it|perfect|cool|no worries|thanks(?: bro)?|thank you|hey|hi|bro|guys|team|fyi|heads up|just (?:want(?:ed)? to|to) (?:inform|let you know|note|say)(?: that)?)[\s,.!]+)*(?:i'?ll|i will|i am going to|just gonna|gonna|let me|i can|i need to|i have to|on it|will do|will (?:send|upload|start|add|check|fix|finish|work|get|have|do|share|redo|go)|(?:just |currently |already )*(?:working on|finalizing|finishing|uploading|exporting)|reminder to myself|note to self|i already|i'?m\s+(?:also\s+|just\s+)?(?:gonna|going to|on it|(?:currently\s+|already\s+)?(?:working|exporting|uploading|finalizing|sending|fixing|finishing|scheduling)))\b/i;
// …unless the same message also asks the other person for something.
const ASK_RE = /\b(?:can|could|would|will|do|did|are|have) you\b|\bplease\b|\bpls\b|\?/i;
// Slack on a phone writes "I’ll" with a curly apostrophe; the patterns above
// only know the straight one. 186 of 3,766 Slack messages in 60d carried a
// curly one (Sep 8 review), so every text is straightened before matching.
const CURLY_APOSTROPHE_RE = /[‘’‛ʼ]/g;
// Leading emoji / punctuation before the words start.
const LEADING_JUNK_RE = /^[\s\p{Extended_Pictographic}️!.…*_~]+/u;

/** Unwrap Slack "@U…" ids (the real-time webhook stores mentions as raw ids)
 *  into "@Name" using whatever id→name map the caller has. */
function unwrapSlackIds(text: string, idNames: Record<string, string>): string {
  return text
    .replace(/<@(U[A-Z0-9]+)>/g, (_m, id: string) => "@" + (idNames[id] ?? id))
    .replace(/@(U[A-Z0-9]{6,})\b/g, (_m, id: string) => "@" + (idNames[id] ?? id));
}

/**
 * Who this Slack message is FOR. Pure — no I/O — so the acceptance probe and
 * the one-off data fix run the exact rule production runs.
 *
 * @param text      the raw message (already run through resolveSlackText)
 * @param senderName who wrote it ("Jordan", "Kyle Smith", "Jhon Mark"…)
 * @param dmWith    on a DM Jordan polls, the OTHER party's display name; null on channels
 * @param aiTitle   the brain's title, used only for its "Kyle to …" form
 * @param idNames   Slack user id → display name, for mentions still in id form
 */
export function resolveSlackAddressee(opts: {
  text: string;
  senderName?: string | null;
  dmWith?: string | null;
  aiTitle?: string | null;
  roster: SlackRosterEntry[];
  idNames?: Record<string, string>;
}): SlackAddressee | null {
  if (opts.roster.length === 0) return null;
  const { alt, find } = rosterLookup(opts.roster);
  if (!alt) return null;
  // In a 1:1 DM only the two people in it can be spoken to; a third name is the
  // subject. Null on channels and group DMs (anyone on the roster). Sep 8 review.
  // Every DM the sync reads is Jordan's own (his user token), so he is in the
  // room even when the partner is off-roster — Remar's "Hey Jordan, …" is still
  // for Jordan.
  const room: Set<string> | null = opts.dmWith
    ? new Set([find("jordan")?.key, find(opts.dmWith)?.key, find(opts.senderName)?.key].filter((k): k is string => !!k))
    : null;
  const inRoom = (r: SlackRosterEntry) => !room || room.has(r.key);
  const pick = (name: string, how: SlackAddressee["how"]): SlackAddressee | null => {
    const r = find(name);
    return r && inRoom(r) ? { key: r.key, name: r.name, teamMemberId: r.teamMemberId, how } : null;
  };
  const NAME = `@?(${alt})(?![\\w'])`;
  const text = unwrapSlackIds(opts.text || "", opts.idNames ?? {})
    .replace(CURLY_APOSTROPHE_RE, "'")
    .trim()
    .replace(LEADING_JUNK_RE, "");

  // Who is @-tagged, and whether each tag is the addressee or only the subject
  // ("let @Kim know" is for the reader). Two different people tagged as
  // addressees ("Hi @Kyle Smith @Jordan, here's the invoice") = for both =
  // nobody in particular, whatever the rest of the text says.
  const mentionRe = new RegExp(`(^|[^\\w@])@(${alt})(?![\\w'])`, "gi");
  const tagged = new Map<string, { entry: SlackRosterEntry; subject: boolean }>();
  for (let m = mentionRe.exec(text); m; m = mentionRe.exec(text)) {
    const entry = find(m[2]);
    if (!entry || !inRoom(entry)) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index + m[1].length);
    const subject = SUBJECT_CUE_RE.test(before);
    const prev = tagged.get(entry.key);
    tagged.set(entry.key, { entry, subject: prev ? prev.subject && subject : subject });
  }
  const addressed = [...tagged.values()].filter((t) => !t.subject);
  if (addressed.length >= 2) return null;

  // 1. Leading address. "Hey Kyle …" needs nothing after the name; a bare
  //    "Kyle …" needs the ask to follow ("Kyle to", "Kyle, ", "Kyle can you").
  const greeted = new RegExp(`^${OPENER}${GREET}${NAME}`, "i").exec(text);
  if (greeted) { const a = pick(greeted[1], "leading"); if (a) return a; }
  const bare = new RegExp(`^${OPENER}${NAME}${ADDRESS_TAIL}`, "i").exec(text);
  if (bare) { const a = pick(bare[1], "leading"); if (a) return a; }

  // 2. One @mention, anywhere, that is the addressee and not the subject.
  if (addressed.length === 1) {
    const { entry } = addressed[0];
    return { key: entry.key, name: entry.name, teamMemberId: entry.teamMemberId, how: "mention" };
  }

  // 3. The sender's own commitment → the sender.
  if (SELF_RE.test(text) && !ASK_RE.test(text)) {
    const a = pick(opts.senderName ?? "", "self");
    if (a) return a;
  }

  // 4. The brain's title names the actor ("Kyle to add 208 Adams…") — it read
  //    the whole thread to write that, so it beats the channel default. Still
  //    only someone in the room: "James needs to reshoot…" in Jordan's DM
  //    with Kyle is Kyle's to pass on.
  if (opts.aiTitle) {
    const t = new RegExp(`^${NAME}${ADDRESS_TAIL}`, "i").exec(opts.aiTitle.replace(CURLY_APOSTROPHE_RE, "'").trim());
    if (t) { const a = pick(t[1], "title"); if (a) return a; }
  }

  // 5. A DM has exactly one other person in it.
  if (opts.dmWith) {
    const sender = find(opts.senderName);
    const partner = find(opts.dmWith);
    const jordan = find("jordan");
    if (sender && partner && jordan) {
      if (sender.key === jordan.key) return { key: partner.key, name: partner.name, teamMemberId: partner.teamMemberId, how: "dm" };
      if (sender.key === partner.key) return { key: jordan.key, name: jordan.name, teamMemberId: jordan.teamMemberId, how: "dm" };
    }
  }
  return null;
}

/** Slack user id → display name for the @mentions in this text: Jordan and the
 *  DM partners are known statically, the roster's slackId column next, and any
 *  id still unresolved is looked up once (cached ~1h in slack.ts). Best-effort. */
async function slackIdNamesFor(text: string, roster: SlackRosterEntry[]): Promise<Record<string, string>> {
  const idNames: Record<string, string> = { [await jordanSlackId()]: "Jordan", ...TARGET_DM_USERS };
  for (const r of roster) if (r.slackId) idNames[r.slackId] = r.name;
  const unknown = [...text.matchAll(/(?:<@|@)(U[A-Z0-9]{6,})\b/g)].map((m) => m[1]).filter((id) => !idNames[id]);
  if (unknown.length > 0) {
    try {
      const { slackUserName } = await import("@/lib/integrations/slack");
      for (const id of new Set(unknown)) {
        const name = await slackUserName(id);
        if (name && name !== id) idNames[id] = name;
      }
    } catch { /* ids stay ids; the rule just won't see a name there */ }
  }
  return idNames;
}

// ---------------------------------------------------------------------------
// WHEN A SLACK ASK IS DUE (Sep 8 audit, due-fuses paper). The old fuse was
// now + 6h with no office-hours logic, so an evening ask read "Overdue · Sun
// 4:00 AM" — a deadline nobody could have met. The default is now the end of
// the NEXT business day, 5:00 PM ET (Mon–Fri; holidays are not modelled, the
// same limitation as turnaround.ts). Jordan was not asked about this number —
// it is his to change.
// ---------------------------------------------------------------------------
function isWeekendET(d: Date): boolean {
  const dow = new Date(`${etDayKey(d)}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
export function slackAskDueAt(from: Date = new Date()): Date {
  let d = from;
  do { d = new Date(d.getTime() + 86_400_000); } while (isWeekendET(d));
  return etAt(etDayKey(d), 17);
}

// The daily 7-day expiry (tasks.ts expireStaleSlackTasks) used to cancel an
// unactioned Slack ask silently — 76 of 178 in 60 days, with nothing on the
// row saying why, and (until Sep 16) nowhere to read it afterwards either:
// the Done tab listed COMPLETED only, so a cancelled row left no trace at
// all. It now shows under "Dismissed & auto-closed", and the summary below is
// what that row says. The marker is for APPENDING to
// sourceDetail (" · slack-expired-7d"), never for replacing it the way
// closeTasksOnInactiveProjects stamps JOB_ON_HOLD: a Slack row's sourceDetail
// is "channel <id> · <ts>" and taskSource.ts receivedByLabel parses the
// channel out of it (Sep 8 review). Writing the summary alone is enough.
export const SLACK_EXPIRED = "slack-expired-7d";
// Sep 16 (Kyle's call): the assignee now gets one "still needed? it closes
// tomorrow" nudge on day 6 (tasks.ts expireStaleSlackTasks), so the cancelled
// row can say the office was warned instead of reading like the board quietly
// forgot. "Posted in the hub", not "went out": that nudge is a bell row — the
// DM half is dead until task_expiring is classified in notifyPrefs.ts — and a
// summary that claims a message nobody received is exactly the kind of small
// lie that cost the board its credibility (review). Text mirrored literally in
// tasks.ts — keep the two in step.
export const SLACK_EXPIRED_SUMMARY = "Auto-closed: 7 days with no action. A reminder was posted in the hub yesterday.";

// Instruction detection (shared with the real-time Slack webhook).
const INSTRUCTION_RE =
  /\b(can you|could you|do you mind|please|reach out|check with|let them know|follow up|make sure|send|add|upload|request a revision|schedule|confirm|call|email|fix|need|re-?do|redo|re-?edit)\b/i;
const IGNORE_RE = /^(thanks|thank you|ok|okay|sounds good|got it|yep|yes|no problem|np|👍|🙏|done)\.?$/i;

// Turn a Slack message into a to-do when it reads like an action item. AI writes
// a clean title/detail and judges whether it's actually actionable (skips
// chatter). Deduped on the message ts. Used by the webhook AND the poll.
export async function maybeCreateSlackTask(opts: {
  text: string;
  ts: string;
  channel: string;
  senderName?: string;
  /** On a DM the poll reads, the OTHER party's display name (Kyle Smith / Kim) —
   *  the addressee rule needs to know who the message could only have been for.
   *  Leave unset on channels and group DMs. */
  dmWith?: string | null;
}): Promise<boolean> {
  const { prisma } = await import("@/lib/prisma");
  const text = opts.text.trim();
  if (text.length < 6 || IGNORE_RE.test(text) || !INSTRUCTION_RE.test(text)) return false;
  // RECENCY GUARD: never turn an OLD message into a task. The Slack ts is unix
  // seconds; if a history backfill (or a re-sync of a huge thread) feeds us a
  // months-old message, skip it — only genuinely recent messages become to-dos.
  // This is what stopped a Sep conversation from being resurrected in June.
  const tsMs = Number(opts.ts) * 1000;
  if (Number.isFinite(tsMs) && tsMs > 0 && Date.now() - tsMs > 4 * 24 * 3600_000) return false;
  const dedupeKey = `slack-${opts.ts}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey } })) return false;

  const { matchProjectFromText } = await import("@/lib/matchProject");
  const match = await matchProjectFromText(text);

  let title = clip(text, 90);
  let detail = text;
  let priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
  let projectId = match?.id ?? null;
  let clientId = match?.clientId ?? null;
  let propertyAddress = match?.title ?? null;
  let usedBrain = false;

  // Who it is for — see resolveSlackAddressee above (Sep 8). Null = nobody
  // named = "Needs assigning". Never Kyle by default. Read BEFORE the brain
  // runs so its merge candidates can be limited to that person's open cards:
  // Kyle's "I'll do it" must not ride onto Jordan's card through a brain merge
  // any more than through the 24h consolidation below (Sep 8 review). The
  // brain's title is fed back in afterwards (rule 4).
  let roster: SlackRosterEntry[] = [];
  let idNames: Record<string, string> = {};
  try {
    roster = await loadSlackRoster();
    idNames = await slackIdNamesFor(text, roster);
  } catch { /* empty roster → unassigned, the honest fallback */ }
  const addresseeFor = (aiTitle: string | null): SlackAddressee | null => {
    try {
      return resolveSlackAddressee({ text, senderName: opts.senderName, dmWith: opts.dmWith ?? null, aiTitle, roster, idNames });
    } catch { return null; }
  };
  let addressee = addresseeFor(null);

  // Route through the thread-aware Smart Brain: it reads the recent Slack thread
  // (so "she" / "the form" resolve to the right client even when this message
  // doesn't name them), knows that client's shoots (today/upcoming), and COMBINES
  // this into an existing open Slack to-do when it's the same workflow — one
  // that is for the same person (forKey), or for nobody when this one is.
  try {
    const { routeSlackTask } = await import("@/lib/brain");
    const d = await routeSlackTask({ message: text, ts: opts.ts, channel: opts.channel, senderName: opts.senderName, forKey: addressee?.key ?? null });
    if (d) {
      if (!d.actionable) return false;
      if (d.mergeIntoTaskId) {
        const { mergeIntoExistingTask } = await import("@/lib/tasks");
        const merged = await mergeIntoExistingTask(d.mergeIntoTaskId, {
          title: d.title, detail: d.detail, priority: d.priority,
          projectId: d.projectId ?? undefined, clientId: d.clientId ?? undefined, snippet: text,
        });
        // Merge refused (e.g. it pointed at a production task) → fall through and
        // create a fresh Slack to-do below instead of dropping the message.
        if (merged) return true;
      }
      title = d.title;
      detail = d.detail || text;
      priority = d.priority;
      if (d.projectId) projectId = d.projectId;
      if (d.clientId) clientId = d.clientId;
      usedBrain = true;
      // Rule 4: the brain's "Kyle to …" title can name the actor when the raw
      // text did not. Rules 1–3 still win, so this only fills a gap.
      addressee = addresseeFor(title);
    }
  } catch { /* fall through to single-message helper */ }

  // Fallback (no client/project match, or brain unavailable): single-message to-do.
  if (!usedBrain) {
    try {
      if (await getSecret("ai")) {
        const { messageToTodo } = await import("@/lib/integrations/ai");
        const todo = await messageToTodo({
          channel: "Slack message",
          clientName: opts.senderName ?? null,
          propertyAddress: match?.title ?? null,
          message: text,
        });
        if (todo) {
          if (/no action needed/i.test(todo.title)) return false;
          title = todo.title;
          detail = todo.detail || text;
        }
      }
    } catch { /* fall back to raw text */ }
  }

  // CONSOLIDATE (Aug 24 audit: 86 open per-message Slack tasks = 60% of the
  // whole list). Same sender + same project (or both unanchored) + same person
  // it is for, within 24h → append to their OPEN rolling task instead of
  // minting another card. (Same addressee since Sep 8: Kyle's "I'll do it"
  // must not ride on a card that is Jordan's.)
  try {
    const rolling = await prisma.smartTask.findFirst({
      where: {
        taskType: "internal_instruction",
        source: "slack",
        status: "OPEN",
        contactName: opts.senderName ?? undefined,
        projectId: projectId ?? null,
        assignedKey: addressee?.key ?? null,
        createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (rolling && opts.senderName) {
      const prev = rolling.description ?? "";
      const appended = `${prev}\n\n• ${title}${detail && detail !== title ? ` — ${clip(detail, 300)}` : ""}`.trim();
      const count = (appended.match(/^• /gm)?.length ?? 0) + 1;
      await prisma.smartTask.update({
        where: { id: rolling.id },
        data: {
          description: appended.length > 4000 ? appended.slice(appended.length - 4000) : appended,
          title: `${rolling.title.replace(/ \(\+\d+ more\)$/, "")} (+${count - 1} more)`.slice(0, 120),
          summary: `${opts.senderName} in Slack — ${count} asks on one card. Latest: ${clip(title, 160)}`.slice(0, 500),
          ...(priority === "URGENT" ? { priority: "URGENT" } : {}),
        },
      });
      return true;
    }
  } catch { /* consolidation is best-effort — fall through to a fresh card */ }

  const sender = opts.senderName || "A teammate";
  const summary = (usedBrain && detail && detail !== text)
    ? detail
    : `${sender} in Slack: “${clip(text, 260)}”`;
  // The card says who asked and who it is for (contactName is the sender; the
  // "Why" line carries the addressee). Sep 8: assigned to the person the
  // message was sent to, or to nobody — Kyle is no longer the default.
  const forWhom = addressee ? `${sender} to ${addressee.name}` : `${sender}, no one named`;
  await prisma.smartTask.create({
    data: {
      taskType: "internal_instruction",
      title,
      summary: summary.slice(0, 500),
      description: detail,
      assignedKey: addressee?.key ?? null,
      reasonCreated: `From Slack — ${forWhom}${match ? `, re: ${match.title}` : ""}`.slice(0, 300),
      checklist: JSON.stringify(["Do the requested action", "Reply in Slack when done"]),
      source: "slack",
      contactName: opts.senderName ?? null,
      sourceDetail: opts.channel ? `channel ${opts.channel} · ${opts.ts}` : opts.ts,
      priority,
      dueAt: slackAskDueAt(),
      ownerId: addressee?.teamMemberId ?? null,
      projectId,
      clientId,
      propertyAddress,
      dedupeKey,
    },
  });
  // URGENT means "someone should know NOW" — Slack-ping instead of waiting for
  // the next hub visit. Best-effort: never breaks task creation.
  if (priority === "URGENT") {
    try {
      const { notifyUrgent } = await import("@/lib/notify");
      await notifyUrgent(`URGENT — ${title}`);
    } catch { /* non-fatal */ }
  }
  return true;
}

async function su(token: string, method: string, query: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const j = (await r.json().catch(() => ({ ok: false }))) as any;
    if (j.ok) return j;
    if (j.error === "ratelimited") { await new Promise((res) => setTimeout(res, (attempt + 1) * 1500)); continue; }
    return j;
  }
  return { ok: false, error: "ratelimited" };
}

// Same cleanup for callers outside this file (the real-time webhook logs
// channel messages FIRST, and its externalId dedupe blocks the cron from
// re-writing them — so the webhook must store CLEAN text too).
export function resolveSlackText(text: string, userMap: Record<string, string> = {}): string {
  return resolver(userMap)(text);
}

function resolver(userMap: Record<string, string>) {
  // Token unwrap FIRST (Slack's real <@U…>/<url> tokens use literal angle
  // brackets), THEN entity decode — Slack HTML-escapes the user's own &, <, >.
  // Without the decode, tasks read "photos &amp; video".
  return (text: string) =>
    stripInvisible(
      (text || "")
        .replace(/<@(U\w+)>/g, (_m, id) => "@" + (userMap[id] || id))
        .replace(/<#C\w+\|([^>]+)>/g, "#$1")
        .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
        .replace(/<(https?:[^>]+)>/g, "$1")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    );
}

async function recentHistory(token: string, channel: string, oldest: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 12; i++) {
    const q: Record<string, string> = { channel, limit: "200", oldest };
    if (cursor) q.cursor = cursor;
    const r = await su(token, "conversations.history", q);
    if (!r.ok) break;
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * A06 (Sep 21 audit, fixed Sep 22 2026) — TASK PROCESSING IS RETRIED, NOT SKIPPED.
 *
 * The poll wrote the communication first and only called maybeCreateSlackTask
 * when logComm reported the row as NEWLY created, with the call itself wrapped
 * in a bare `catch {}`. So one failing task write lost the task permanently: the
 * next poll saw the message already logged, skipped task generation entirely,
 * and the request sat in the hub's history with nothing in the queue. The audit
 * reproduced exactly that — "a second ingestion of the same message did not
 * attempt task creation again."
 *
 * The `created` gate is gone, and it can be, because BOTH of the things it was
 * standing in for already live inside maybeCreateSlackTask and are stronger
 * there: a four-day recency guard (a history backfill cannot resurrect an old
 * message as a to-do) and a `slack-<ts>` dedupe key checked against SmartTask
 * (a message that already has its task never gets a second one). Re-asking is
 * therefore idempotent — and a message that is correctly no task at all is
 * refused by the same deterministic rules every time, which is how "processed,
 * needs no task" and "failed to process" stop looking alike.
 *
 * Errors are counted and returned rather than swallowed, so a persistent
 * failure shows up in the sync's own result instead of nowhere.
 */
async function ingest(channel: string, messages: any[], minRole: string, source: string, otherName: string | undefined, resolve: (t: string) => string, userMap: Record<string, string>): Promise<{ logged: number; taskErrors: string[] }> {
  let n = 0;
  const taskErrors: string[] = [];
  const me = await jordanSlackId();
  for (const m of messages) {
    if (m.subtype && m.subtype !== "thread_broadcast") continue;
    const text = resolve(m.text || "");
    if (!text.trim()) continue;
    const senderName = m.user === me ? "Jordan" : userMap[m.user] || otherName || m.user || "Slack";
    const created = await logComm({
      channel: "slack",
      direction: m.user === me ? "out" : "in",
      minRole,
      contactName: senderName,
      body: text,
      occurredAt: m.ts ? new Date(Number(m.ts) * 1000) : undefined,
      source,
      externalId: `slack-${channel}-${m.ts}`,
    });
    n++;
    void created; // logComm's "was this row new" — no longer what decides the task (A06)
    // EVERY message in the window is offered to the task rule, every poll. Old
    // messages and already-tasked ones are refused inside it; a message whose
    // task write failed last time gets another go. A DM names its other party so
    // the addressee rule can use it (Sep 8); channels and group DMs pass nothing.
    try {
      await maybeCreateSlackTask({ text, ts: m.ts, channel, senderName, dmWith: source === "slack-dm" ? otherName ?? null : null });
    } catch (e) {
      // Not fatal to the sync — but not invisible either. The next poll retries
      // this same message, and until it succeeds the failure is reported.
      taskErrors.push(`${channel}/${m.ts}: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    }
  }
  return { logged: n, taskErrors };
}

export async function syncSlackHistory(opts: { sinceHours?: number } = {}): Promise<{ logged: number; skipped?: boolean; taskErrors?: string[] }> {
  const token = await getSecret("slack_user");
  if (!token) return { logged: 0, skipped: true };
  const auth = await su(token, "auth.test");
  if (!auth.ok) return { logged: 0, skipped: true };

  const oldest = String(Math.floor((Date.now() - (opts.sinceHours ?? 48) * 3600_000) / 1000));
  const u = await su(token, "users.list", { limit: "500" });
  const userMap: Record<string, string> = {};
  for (const m of u.members ?? []) userMap[m.id] = m.profile?.display_name || m.real_name || m.name || m.id;
  const resolve = resolver(userMap);

  let logged = 0;
  // A06: task-processing failures ride back with the result rather than being
  // swallowed. Every one of these messages is retried on the next poll.
  const taskErrors: string[] = [];
  const take = (r: { logged: number; taskErrors: string[] }) => { logged += r.logged; taskErrors.push(...r.taskErrors); };
  // Channels (ADMIN).
  const ch = await su(token, "conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" });
  for (const c of (ch.channels ?? []).filter((c: any) => c.is_member && CHANNEL_NAME_RE.test(c.name))) {
    take(await ingest(c.id, await recentHistory(token, c.id, oldest), "ADMIN", "slack-channel", undefined, resolve, userMap));
  }
  // DMs (OWNER).
  const ims = await su(token, "conversations.list", { types: "im", limit: "400" });
  for (const im of (ims.channels ?? []).filter((im: any) => TARGET_DM_USERS[im.user])) {
    take(await ingest(im.id, await recentHistory(token, im.id, oldest), "OWNER", "slack-dm", TARGET_DM_USERS[im.user], resolve, userMap));
  }
  // Group DMs (OWNER).
  const mpims = await su(token, "conversations.list", { types: "mpim", limit: "100" });
  for (const g of mpims.channels ?? []) {
    take(await ingest(g.id, await recentHistory(token, g.id, oldest), "OWNER", "slack-groupdm", undefined, resolve, userMap));
  }
  if (taskErrors.length) console.warn(`syncSlackHistory: ${taskErrors.length} message(s) logged but their task did not write — retried next poll. ${taskErrors.slice(0, 3).join(" · ")}`);
  return { logged, ...(taskErrors.length ? { taskErrors } : {}) };
}
