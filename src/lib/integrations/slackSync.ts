import "server-only";
import { createHash } from "crypto";
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

/** Exported Oct 14 2026: slackAskEvidence.ts reads who SENT an ask (its
 *  contactName) with the same alias rule the addressee reader uses. */
export function rosterLookup(roster: SlackRosterEntry[]) {
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

// ---------------------------------------------------------------------------
// ONE DECISION PER SLACK MESSAGE (Oct 22 2026, the AI spend investigation).
//
// The router asked Claude about the same Slack message every five minutes.
// It remembered a message only when it MINTED a card for it (the `slack-<ts>`
// dedupe key below); "no action", "added to an existing card" and "rolled
// into a running card" saved nothing, so every poll whose two-minute overlap
// re-read the channel's latest messages asked again, for four days (the
// recency guard): about 4,070 Sonnet calls in 30 days where about 280 were
// needed. Each repeat "added to an existing card" also appended the same
// "Update:" line again (one card carried it 78 times) and re-opened a card a
// person had closed.
//
// Now EVERY decision is remembered, whatever it was: one AppSetting row per
// message, `slack-routed:<channel>:<ts>`, holding a hash of the text, the
// outcome and the card it touched. A message with a row is never asked about
// again; the overlap stays (it is the safety net for a late write) and costs
// nothing. The row is claimed BEFORE the ask, so the real-time webhook and
// the poll seeing the same message in the same minute ask once between
// them; a claim older than five minutes is a crashed worker and is taken
// over. A message whose text CHANGED (an edit in Slack) is asked once more,
// and only once. Rows are pruned after six days: past four the recency guard
// refuses the message before the row is ever read.
// ---------------------------------------------------------------------------
export const SLACK_ROUTED_PREFIX = "slack-routed:";
const ROUTE_CLAIM_STALE_MS = 5 * 60_000;
const ROUTED_KEEP_MS = 6 * 24 * 3600_000;

/** s: asking (claimed) | done; h: hash of the text decided on; at: ms;
 *  o: outcome; t: the card it went to; e: edits asked about since. */
type RouteMemo = { s: "asking" | "done"; h: string; at: number; o?: string; t?: string | null; e?: number };
export const slackRoutedKey = (channel: string, ts: string) => `${SLACK_ROUTED_PREFIX}${channel || "-"}:${ts}`;
const textHash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

type RouteClaim =
  | { claimed: true; key: string; hash: string; edit: boolean; edits: number; prev: string | null; card: string | null }
  | { claimed: false; busy: boolean };

function parseMemo(raw: string | null | undefined): RouteMemo | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as RouteMemo;
    return m && (m.s === "asking" || m.s === "done") && typeof m.h === "string" ? m : null;
  } catch { return null; }
}

/** Take the right to decide this message, or learn that it is decided (or being decided). */
async function claimRoute(channel: string, ts: string, text: string): Promise<RouteClaim> {
  const { prisma } = await import("@/lib/prisma");
  const key = slackRoutedKey(channel, ts);
  const hash = textHash(text);
  const asking = (e: number, card: string | null): string => JSON.stringify({ s: "asking", h: hash, at: Date.now(), e, t: card } satisfies RouteMemo);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    if (!row) {
      try {
        await prisma.appSetting.create({ data: { key, value: asking(0, null) } });
        return { claimed: true, key, hash, edit: false, edits: 0, prev: null, card: null };
      } catch (e) {
        if (isUnique(e)) continue; // someone claimed it this instant: read what they wrote
        throw e;
      }
    }
    const memo = parseMemo(row.value);
    let edit = false;
    if (memo?.s === "done") {
      if (memo.h === hash) return { claimed: false, busy: false };
      if ((memo.e ?? 0) >= 1) return { claimed: false, busy: false }; // an edit was asked about once already
      edit = true;
    } else if (memo?.s === "asking" && Date.now() - memo.at < ROUTE_CLAIM_STALE_MS) {
      return { claimed: false, busy: true };
    }
    // Claim on the value we read, so two workers cannot both win it.
    const edits = (memo?.e ?? 0) + (edit ? 1 : 0);
    const card = memo?.t ?? null;
    const won = await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value: asking(edits, card) } });
    if (won.count === 1) return { claimed: true, key, hash, edit, edits, prev: memo?.s === "done" ? row.value : null, card };
    return { claimed: false, busy: true };
  }
  return { claimed: false, busy: true };
}

async function finishRoute(c: Extract<RouteClaim, { claimed: true }>, outcome: string, card: string | null): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const value = JSON.stringify({ s: "done", h: c.hash, at: Date.now(), o: outcome, t: card ?? c.card, e: c.edits } satisfies RouteMemo);
  await prisma.appSetting.update({ where: { key: c.key }, data: { value } });
}

/** The decision failed: give the message back, exactly as it was, for the next poll. */
async function releaseRoute(c: Extract<RouteClaim, { claimed: true }>): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  if (c.prev) await prisma.appSetting.update({ where: { key: c.key }, data: { value: c.prev } }).catch(() => {});
  else await prisma.appSetting.deleteMany({ where: { key: c.key } }).catch(() => {});
}

/** Drop the decisions on messages the recency guard would refuse anyway. */
export async function pruneSlackRouted(now: Date = new Date()): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const r = await prisma.appSetting
    .deleteMany({ where: { key: { startsWith: SLACK_ROUTED_PREFIX }, updatedAt: { lt: new Date(now.getTime() - ROUTED_KEEP_MS) } } })
    .catch(() => ({ count: 0 }));
  return r.count;
}

// Turn a Slack message into a to-do when it reads like an action item. AI writes
// a clean title/detail and judges whether it's actually actionable (skips
// chatter). Decided once per message (above). Used by the webhook AND the poll.
export async function maybeCreateSlackTask(opts: SlackRouteInput): Promise<boolean> {
  return (await routeSlackMessage(opts)) === true;
}

type SlackRouteInput = {
  text: string;
  ts: string;
  channel: string;
  senderName?: string;
  /** On a DM the poll reads, the OTHER party's display name (Kyle Smith / Kim) —
   *  the addressee rule needs to know who the message could only have been for.
   *  Leave unset on channels and group DMs. */
  dmWith?: string | null;
};

/** true = a card was made or added to; false = decided, nothing to do (now or
 *  before); "busy" = another worker is deciding it right now (the poll keeps
 *  its cursor behind it and looks again next time). Throws when the decision
 *  could not be written; the claim is given back first. */
async function routeSlackMessage(opts: SlackRouteInput): Promise<boolean | "busy"> {
  const text = opts.text.trim();
  if (text.length < 6 || IGNORE_RE.test(text) || !INSTRUCTION_RE.test(text)) return false;
  // RECENCY GUARD: never turn an OLD message into a task. The Slack ts is unix
  // seconds; if a history backfill (or a re-sync of a huge thread) feeds us a
  // months-old message, skip it — only genuinely recent messages become to-dos.
  // This is what stopped a Sep conversation from being resurrected in June.
  const tsMs = Number(opts.ts) * 1000;
  if (Number.isFinite(tsMs) && tsMs > 0 && Date.now() - tsMs > 4 * 24 * 3600_000) return false;
  const claim = await claimRoute(opts.channel, opts.ts, text);
  if (!claim.claimed) return claim.busy ? "busy" : false;
  try {
    return await decideSlackMessage(opts, text, claim);
  } catch (e) {
    await releaseRoute(claim);
    throw e;
  }
}

async function decideSlackMessage(opts: SlackRouteInput, text: string, claim: Extract<RouteClaim, { claimed: true }>): Promise<boolean> {
  const { prisma } = await import("@/lib/prisma");
  const dedupeKey = `slack-${opts.ts}`;
  const own = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true, description: true } });
  if (own) {
    // The message already has its own card (made before the hub remembered
    // decisions, or by the first ask). An edit is added to that card's notes,
    // never a second card and never a reopen; nothing is asked.
    if (claim.edit && own.status !== "COMPLETED" && own.status !== "CANCELLED") {
      const description = [own.description, `Edited in Slack: ${clip(text, 800)}`].filter(Boolean).join("\n\n");
      await prisma.smartTask.update({ where: { id: own.id }, data: { description: description.length > 4000 ? "…" + description.slice(-4000) : description } });
    }
    await finishRoute(claim, "own_card", own.id);
    return false;
  }
  // Added to a card before the hub remembered its decisions: its words are
  // already on that card as an "Update:" line. Remembered as merged without
  // asking, so a card a person has closed since gets neither a reopen nor a
  // twin.
  if (!claim.edit) {
    const already = await prisma.smartTask.findFirst({ where: { source: "slack", description: { contains: `Update: ${clip(text, 800)}` } }, select: { id: true } });
    if (already) {
      await finishRoute(claim, "merged", already.id);
      return true;
    }
  }

  const { matchProjectFromText } = await import("@/lib/matchProject");
  const match = await matchProjectFromText(text);

  let title = clip(text, 90);
  let detail = text;
  let priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
  let projectId = match?.id ?? null;
  let clientId = match?.clientId ?? null;
  const propertyAddress = match?.title ?? null;
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
  // The outcome, written down OUTSIDE the best-effort try below so a failure
  // to remember it is never mistaken for "the brain was unavailable".
  let decided: { outcome: string; card: string | null; result: boolean } | null = null;
  try {
    const { routeSlackTask } = await import("@/lib/brain");
    const d = await routeSlackTask({ message: text, ts: opts.ts, channel: opts.channel, senderName: opts.senderName, forKey: addressee?.key ?? null });
    if (d && !d.actionable) decided = { outcome: "no_action", card: null, result: false };
    else if (d?.mergeIntoTaskId) {
      // The same words never go on a card twice (Oct 22 2026): a message the
      // router added before it remembered its decisions is already there.
      const target = await prisma.smartTask.findUnique({ where: { id: d.mergeIntoTaskId }, select: { description: true } });
      if (target?.description?.includes(`Update: ${clip(text, 800)}`)) {
        decided = { outcome: "merged", card: d.mergeIntoTaskId, result: true };
      } else {
        const { mergeIntoExistingTask } = await import("@/lib/tasks");
        const merged = await mergeIntoExistingTask(d.mergeIntoTaskId, {
          title: d.title, detail: d.detail, priority: d.priority,
          projectId: d.projectId ?? undefined, clientId: d.clientId ?? undefined, snippet: text,
        }, { keepClosed: true });
        // Merge refused (e.g. it pointed at a production task, or a person
        // closed that card since) → fall through and create a fresh Slack
        // to-do below instead of dropping the message.
        if (merged) decided = { outcome: "merged", card: d.mergeIntoTaskId, result: true };
      }
    }
    if (d && !decided) {
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
  if (decided) {
    await finishRoute(claim, decided.outcome, decided.card);
    return decided.result;
  }

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
          if (/no action needed/i.test(todo.title)) decided = { outcome: "no_action", card: null, result: false };
          title = todo.title;
          detail = todo.detail || text;
        }
      }
    } catch { /* fall back to raw text */ }
    if (decided) {
      await finishRoute(claim, decided.outcome, decided.card);
      return decided.result;
    }
  }

  // CONSOLIDATE (Aug 24 audit: 86 open per-message Slack tasks = 60% of the
  // whole list). Same sender + same project (or both unanchored) + same person
  // it is for, within 24h → append to their OPEN rolling task instead of
  // minting another card. (Same addressee since Sep 8: Kyle's "I'll do it"
  // must not ride on a card that is Jordan's.)
  let rolledInto: string | null = null;
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
      rolledInto = rolling.id;
    }
  } catch { /* consolidation is best-effort — fall through to a fresh card */ }
  if (rolledInto) {
    await finishRoute(claim, "rolled", rolledInto);
    return true;
  }

  const sender = opts.senderName || "A teammate";
  const summary = (usedBrain && detail && detail !== text)
    ? detail
    : `${sender} in Slack: “${clip(text, 260)}”`;
  // The card says who asked and who it is for (contactName is the sender; the
  // "Why" line carries the addressee). Sep 8: assigned to the person the
  // message was sent to, or to nobody — Kyle is no longer the default.
  const forWhom = addressee ? `${sender} to ${addressee.name}` : `${sender}, no one named`;
  const card = await prisma.smartTask.create({
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
    select: { id: true },
  });
  await finishRoute(claim, "created", card.id);
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

// Every Slack read has a time limit (audit H7, Oct 20 2026): a hung request
// held the 5-minute comms cron until the platform killed it.
const SLACK_TIMEOUT_MS = 20_000;

async function su(token: string, method: string, query: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
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

/** The fields of a conversations.history message this file reads. */
type SlackMsg = { ts?: string; text?: string; user?: string; subtype?: string };
/** One row of conversations.list, whichever type was asked for. */
type SlackConv = { id: string; name?: string; is_member?: boolean; user?: string };

// `complete` is false when Slack refused a page or the page cap was hit: the
// messages in hand are real, but older ones in the window may be missing, so
// the caller must not move its cursor past them (H20).
async function recentHistory(token: string, channel: string, oldest: string): Promise<{ messages: SlackMsg[]; complete: boolean }> {
  const out: SlackMsg[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 12; i++) {
    const q: Record<string, string> = { channel, limit: "200", oldest };
    if (cursor) q.cursor = cursor;
    const r = await su(token, "conversations.history", q);
    if (!r.ok) return { messages: out, complete: false };
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) return { messages: out, complete: true };
  }
  return { messages: out, complete: false };
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
 *
 * Oct 22 2026: "idempotent" above held for the card, not for the AI. Only a
 * minted card was remembered, so a no-action, merged or rolled message was
 * asked about again on every poll; every decision is remembered now (ONE
 * DECISION PER SLACK MESSAGE, above maybeCreateSlackTask).
 */
async function ingest(channel: string, messages: SlackMsg[], minRole: string, source: string, otherName: string | undefined, resolve: (t: string) => string, userMap: Record<string, string>): Promise<{ logged: number; taskErrors: string[]; advanceTo: string | null }> {
  let n = 0;
  const taskErrors: string[] = [];
  const me = await jordanSlackId();
  // Oldest first, so the cursor (H20, below) can stop at the first message
  // that did not fully land: every message up to `advanceTo` is stored AND
  // was offered to the task rule without an error.
  const ordered = [...messages].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
  let advanceTo: string | null = null;
  let clean = true;
  for (const m of ordered) {
    let ok = true;
    const text = m.subtype && m.subtype !== "thread_broadcast" ? "" : resolve(m.text || "");
    if (text.trim()) {
      const senderName = m.user === me ? "Jordan" : (m.user ? userMap[m.user] : undefined) || otherName || m.user || "Slack";
      try {
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
      } catch (e) {
        ok = false;
        taskErrors.push(`${channel}/${m.ts} (not stored): ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
      }
      // EVERY message in the window is offered to the task rule, every poll. Old
      // messages and already-DECIDED ones (any outcome, Oct 22 2026) are
      // refused inside it without asking the AI; a message whose task write
      // failed last time gets another go (the cursor stays behind it). A DM
      // names its other party so the addressee rule can use it (Sep 8);
      // channels and group DMs pass nothing.
      if (ok) {
        try {
          const routed = await routeSlackMessage({ text, ts: m.ts ?? "", channel, senderName, dmWith: source === "slack-dm" ? otherName ?? null : null });
          // Another worker (the real-time webhook) is deciding it this minute:
          // not an error, but the cursor waits behind it until it is decided.
          if (routed === "busy") ok = false;
        } catch (e) {
          // Not fatal to the sync — but not invisible either. The next poll retries
          // this same message, and until it succeeds the failure is reported.
          ok = false;
          taskErrors.push(`${channel}/${m.ts}: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
        }
      }
    }
    if (!ok) clean = false;
    if (clean && typeof m.ts === "string" && m.ts) advanceTo = m.ts;
  }
  return { logged: n, taskErrors, advanceTo };
}

// ---------------------------------------------------------------------------
// READ ONLY WHAT IS NEW (audit H20, Oct 20 2026). Every 5 minutes this called
// auth.test, users.list and three conversations.list, then re-read two hours
// of every channel and DM: about 24 times the reading needed, with the
// externalId dedupe throwing the repeats away.
//
//   · The user map and the channel lists change a few times a year: kept in
//     AppSetting for an hour (SLACK_DIRECTORY_KEY).
//   · Each channel keeps a cursor in AppSetting (slack-sync:cursor:<id>), the
//     newest message ts that was STORED and offered to the task rule without
//     an error. The next poll reads from there, less a two-minute overlap
//     (repeats are idempotent). The cursor never moves past a message that
//     failed to store or whose task write threw, nor past a read Slack cut
//     short, so no message can be skipped. A channel with no cursor yet reads
//     the caller's window (sinceHours), as before.
// ---------------------------------------------------------------------------
const SLACK_DIRECTORY_KEY = "slack-sync:directory";
const SLACK_CURSOR_PREFIX = "slack-sync:cursor:";
const DIRECTORY_TTL_MS = 60 * 60_000;
const CURSOR_OVERLAP_S = 120;

type SlackDirectory = {
  at: number;
  userMap: Record<string, string>;
  channels: { id: string; name: string; is_member?: boolean }[];
  ims: { id: string; user: string }[];
  mpims: { id: string }[];
};

async function slackDirectory(token: string): Promise<SlackDirectory | null> {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.appSetting.findUnique({ where: { key: SLACK_DIRECTORY_KEY }, select: { value: true } }).catch(() => null);
  if (row?.value) {
    try {
      const d = JSON.parse(row.value) as SlackDirectory;
      if (d && typeof d.at === "number" && Date.now() - d.at < DIRECTORY_TTL_MS && d.userMap && Array.isArray(d.channels) && Array.isArray(d.ims) && Array.isArray(d.mpims)) return d;
    } catch { /* rebuilt below */ }
  }
  const auth = await su(token, "auth.test");
  if (!auth.ok) return null;
  const [u, ch, ims, mpims] = await Promise.all([
    su(token, "users.list", { limit: "500" }),
    su(token, "conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" }),
    su(token, "conversations.list", { types: "im", limit: "400" }),
    su(token, "conversations.list", { types: "mpim", limit: "100" }),
  ]);
  const userMap: Record<string, string> = {};
  for (const m of u.members ?? []) userMap[m.id] = m.profile?.display_name || m.real_name || m.name || m.id;
  const d: SlackDirectory = {
    at: Date.now(),
    userMap,
    channels: ((ch.channels ?? []) as SlackConv[]).map((c) => ({ id: c.id, name: c.name ?? "", is_member: c.is_member })),
    ims: ((ims.channels ?? []) as SlackConv[]).map((c) => ({ id: c.id, user: c.user ?? "" })),
    mpims: ((mpims.channels ?? []) as SlackConv[]).map((c) => ({ id: c.id })),
  };
  // Only a complete answer is remembered; a partial one is used this once.
  if (u.ok && ch.ok && ims.ok && mpims.ok) {
    const value = JSON.stringify(d);
    await prisma.appSetting.upsert({ where: { key: SLACK_DIRECTORY_KEY }, create: { key: SLACK_DIRECTORY_KEY, value }, update: { value } }).catch(() => {});
  }
  return d;
}

export async function syncSlackHistory(opts: { sinceHours?: number } = {}): Promise<{ logged: number; skipped?: boolean; taskErrors?: string[] }> {
  const token = await getSecret("slack_user");
  if (!token) return { logged: 0, skipped: true };
  const dir = await slackDirectory(token);
  if (!dir) return { logged: 0, skipped: true };

  // The window for a channel that has no cursor yet.
  const windowOldest = (Date.now() - (opts.sinceHours ?? 48) * 3600_000) / 1000;
  const { userMap } = dir;
  const resolve = resolver(userMap);

  const { prisma } = await import("@/lib/prisma");
  const cursorRows = await prisma.appSetting
    .findMany({ where: { key: { startsWith: SLACK_CURSOR_PREFIX } }, select: { key: true, value: true } })
    .catch(() => [] as { key: string; value: string }[]);
  const cursors = new Map(cursorRows.map((r) => [r.key.slice(SLACK_CURSOR_PREFIX.length), r.value]));

  let logged = 0;
  // A06: task-processing failures ride back with the result rather than being
  // swallowed. Every one of these messages is retried on the next poll.
  const taskErrors: string[] = [];
  const pull = async (id: string, minRole: string, source: string, otherName: string | undefined) => {
    const cursor = cursors.get(id);
    const cursorS = cursor ? Number(cursor) : NaN;
    const oldest = (Number.isFinite(cursorS) ? cursorS - CURSOR_OVERLAP_S : windowOldest).toFixed(6);
    let read: { messages: SlackMsg[]; complete: boolean };
    try {
      read = await recentHistory(token, id, oldest);
    } catch (e) {
      // A timeout or a dropped connection on one channel: its cursor stays
      // put and the next poll reads the same stretch again.
      taskErrors.push(`${id} (not read): ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
      return;
    }
    const r = await ingest(id, read.messages, minRole, source, otherName, resolve, userMap);
    logged += r.logged;
    taskErrors.push(...r.taskErrors);
    if (read.complete && r.advanceTo && (!Number.isFinite(cursorS) || Number(r.advanceTo) > cursorS)) {
      const key = `${SLACK_CURSOR_PREFIX}${id}`;
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: r.advanceTo }, update: { value: r.advanceTo } }).catch(() => {});
    }
  };
  // Channels (ADMIN).
  for (const c of dir.channels.filter((c) => c.is_member && CHANNEL_NAME_RE.test(c.name))) {
    await pull(c.id, "ADMIN", "slack-channel", undefined);
  }
  // DMs (OWNER).
  for (const im of dir.ims.filter((im) => TARGET_DM_USERS[im.user])) {
    await pull(im.id, "OWNER", "slack-dm", TARGET_DM_USERS[im.user]);
  }
  // Group DMs (OWNER).
  for (const g of dir.mpims) {
    await pull(g.id, "OWNER", "slack-groupdm", undefined);
  }
  await pruneSlackRouted();
  if (taskErrors.length) console.warn(`syncSlackHistory: ${taskErrors.length} message(s) did not fully land — retried next poll. ${taskErrors.slice(0, 3).join(" · ")}`);
  return { logged, ...(taskErrors.length ? { taskErrors } : {}) };
}
