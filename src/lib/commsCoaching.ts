import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import { etDate, etDayKey, etDayStartUtc } from "@/lib/datetime";
import { clip, cleanText, escapeSlack, scrubMoney } from "@/lib/text";
import { aiJsonWithUsage, AI_MODELS, type ConvoTurn } from "@/lib/integrations/ai";

// ---------------------------------------------------------------------------
// END-OF-DAY COMMS COACHING (Jordan, Sep 21 2026, verbatim): "Can you make sure
// we track Kyle's responses in OpenPhone and automatically send him coaching
// based on his responses and the conversation? Like, 'Hey Kyle! Thank you for
// handling this with [Client]. For future messages, try to have a slightly
// warmer approach. [Example].' Then explain why what he said should change and
// why. I don't have time to track this with Kyle, but I think we should do this
// daily at the end of the day."
//
// READ HIS EXAMPLE BEFORE CHANGING ANYTHING HERE. It opens with THANKS, names
// the client, gives ONE thing to try, shows the better wording, and explains
// why. That is the whole shape. Kyle runs the entire operations desk because he
// handles it well; this is a note to a colleague, not a performance review. A
// note that manufactures a criticism so it has something to say will be read
// once and ignored forever, and it will damage the relationship it exists to
// help. Hence MIN_MESSAGES_TO_COACH below, the empty-suggestions path through
// renderCoachingNote(), and the blunt instruction in the system prompt that
// most days need no correction.
//
// WHAT MAKES THIS POSSIBLE AT ALL is CommLog.senderTeamMemberId, added the same
// day. Kyle's handset IS the company OpenPhone line, so until now every message
// the office sent was logged as "Us" (481 of the last 639 outbound texts) and
// the hub could not tell his words from Jordan's. Coaching built on that would
// eventually coach the wrong person, which is worse than not building it. NULL
// MEANS UNKNOWN, NEVER "NOBODY": nothing here reads an unattributed row.
// ---------------------------------------------------------------------------

/** The kind on the bell row, and the string a future KIND_TO_EVENT entry would key on. */
export const COMMS_COACHING_KIND = "comms_coaching";

/** Where the bell row points: the report itself (src/app/coaching/page.tsx,
 *  in the sidebar as "Comms coaching").
 *
 *  This used to read "/communications?tab=coaching" on the guess that the
 *  report would ship as a tab. It did not, and an unknown ?tab value falls back
 *  to the shared inbox without complaining, so the one row Kyle taps to read
 *  his own note would have landed him in the company inbox instead. A dead link
 *  in the first coaching note anybody ever gets is the whole feature's first
 *  impression (Sep 21 2026 review). */
export const COMMS_COACHING_HREF = "/coaching";

/** The ET hour the audit runs. 7 PM is Jordan's "end of the day" and the hour
 *  the evening cron already wakes for. */
export const COMMS_COACHING_ET_HOUR = 19;

/** The Settings row. */
export const COMMS_COACHING_SETTING_KEY = "comms_coaching";

/** Kyle Smith's TeamMember id, verified on production Sep 21 2026 (active,
 *  MANAGER, Slack ID on file). "Kyle to begin with" is what Jordan asked for, so
 *  he is the default rather than a rule about roles that would also sweep in
 *  Jordan's own texts and Kim's. Settings owns the list from here. */
const KYLE_TEAM_MEMBER_ID = "cmqiiczq100049k2mb930csrx";

export type CommsCoachingSettings = {
  /** Whose outbound texts get audited. Empty list = the feature is dormant. */
  teamMemberIds: string[];
  /** DOES THE NOTE ACTUALLY GO OUT. OFF BY DEFAULT, ON PURPOSE, AND IT STAYS
   *  THAT WAY UNTIL JORDAN SAYS OTHERWISE: the first note Kyle ever receives
   *  decides whether this whole thing lands as help or as surveillance, and
   *  Jordan should read one before it is sent. Everything else (the
   *  attribution, the audit, the report) runs with this off, so flipping it is
   *  a decision about one message, not about the feature. */
  sendEnabled: boolean;
};

export const DEFAULT_COMMS_COACHING: CommsCoachingSettings = {
  teamMemberIds: [KYLE_TEAM_MEMBER_ID],
  sendEnabled: false,
};

export async function commsCoachingSettings(): Promise<CommsCoachingSettings> {
  const s = await getSetting<CommsCoachingSettings>(COMMS_COACHING_SETTING_KEY, DEFAULT_COMMS_COACHING);
  // A hand-edited or half-written row must not crash the cron.
  return {
    teamMemberIds: Array.isArray(s.teamMemberIds) ? s.teamMemberIds.filter((x) => typeof x === "string" && x) : [],
    sendEnabled: s.sendEnabled === true,
  };
}

// THE HUB'S OWN WORDS, NEVER KYLE'S. Every one of these is a message a sweep
// composed and sent unattended (clientTextSweeps.ts, uploadDigest.ts). Coaching
// somebody on a template they did not write is the fastest way to prove the
// feature is not paying attention, so they are excluded from the gathering
// query outright and labelled "Automated" if they appear as context.
const AUTO_SOURCES = [
  "auto-confirmation",
  "auto-delivery",
  "auto-afterhours",
  "auto-welcome",
  "upload-nag",
  "upload-digest",
  "upload-intro",
];

// COST AND TIME CEILINGS. Measured on production (Sep 21): the busiest of the
// last 14 days was 53 outbound human texts across 12 threads for the WHOLE
// office, so these caps clear a real day comfortably and still stop a runaway
// thread from turning one evening cron into a 40k-token bill. Anything dropped
// is counted and recorded on the audit rather than silently lost.
const MAX_MESSAGES_PER_PERSON = 40;
const MAX_THREADS_PER_PERSON = 10;
const MAX_TURNS_PER_THREAD = 16;
const MAX_CHARS_PER_TURN = 400;
/** The same numbers, for the acceptance drill to assert against. A test that
 *  keeps its own copy of a cap is a test that stops testing the day somebody
 *  changes the cap. */
export const COACHING_CAPS = {
  messages: MAX_MESSAGES_PER_PERSON,
  threads: MAX_THREADS_PER_PERSON,
  turns: MAX_TURNS_PER_THREAD,
  chars: MAX_CHARS_PER_TURN,
} as const;
/** Below this, there is nothing to coach on and a note would be noise. One
 *  stray Saturday text is not a day's comms. */
const MIN_MESSAGES_TO_COACH = 2;
/** How far back the surrounding conversation is read, so the client's message
 *  BEFORE his first reply of the day is in the transcript. */
const CONTEXT_LOOKBACK_MS = 36 * 60 * 60 * 1000;

export type CoachingSuggestion = {
  /** Which client's thread this came from. */
  client: string;
  /** His actual words, quoted. */
  said: string;
  /** The same thing, warmer, in the house voice. */
  tryInstead: string;
  /** Why the rewrite lands better. This is the half Jordan asked for twice. */
  why: string;
};

export type CoachingAudit = {
  version: 1;
  teamMemberId: string;
  personName: string;
  /** ET day, YYYY-MM-DD. */
  dayKey: string;
  generatedAt: string;
  /** How many of his own messages the day held, before the caps. */
  messagesConsidered: number;
  messagesAnalysed: number;
  threadsAnalysed: number;
  /** Messages the caps dropped. Shown on the report so a busy day is visibly
   *  sampled rather than quietly truncated. */
  droppedForCap: number;
  /** Messages left out because the other side of the conversation was not a
   *  client: a teammate's handset, or a number we could not place. Recorded so
   *  a day that looks thin on the report is visibly a day of internal traffic
   *  rather than a gatherer that silently lost his work.
   *
   *  OPTIONAL because CoachingAudit is a contract other screens already build
   *  and read (src/app/coaching, scripts/_drill/coaching-card.tsx); absent means
   *  the row predates this counter, never that the number was zero. */
  offClientSkipped?: number;
  /** Suggestions the model returned that could not be matched to words he
   *  actually wrote, and were therefore dropped. See the quote gate below: this
   *  number is how a model that starts paraphrasing becomes visible instead of
   *  silent. */
  suggestionsDropped?: number;
  clients: string[];
  thanks: string;
  wentWell: string[];
  suggestions: CoachingSuggestion[];
  /** The note exactly as it would be (or was) sent. */
  note: string;
  sent: boolean;
  sentAt: string | null;
  /** Why nothing went out, when nothing did. Null once it has been sent. */
  sendSkipped: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** One person, one ET day. The same AppSetting-marker pattern the rest of the
 *  hub uses for daily work (auto-delivery-<id>, upload-digest-<day>-<id>). */
export const coachingAuditKey = (teamMemberId: string, dayKey: string) => `comms-coaching:${teamMemberId}:${dayKey}`;

const COACHING_KEY_PREFIX = "comms-coaching:";

/** Read one day's audit, or null. Goes to AppSetting directly rather than
 *  through getSetting: that helper merges a fallback over the stored row, which
 *  is right for a settings shape and wrong for a record. */
export async function readCoachingAudit(teamMemberId: string, dayKey: string): Promise<CoachingAudit | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: coachingAuditKey(teamMemberId, dayKey) } });
    if (!row) return null;
    return JSON.parse(row.value) as CoachingAudit;
  } catch {
    return null;
  }
}

/** History for the report, newest day first. The key ends in the ET day, so a
 *  descending key sort IS a descending date sort. */
export async function listCoachingAudits(opts?: { teamMemberId?: string; limit?: number }): Promise<CoachingAudit[]> {
  const prefix = opts?.teamMemberId ? `${COACHING_KEY_PREFIX}${opts.teamMemberId}:` : COACHING_KEY_PREFIX;
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { startsWith: prefix } },
      orderBy: { key: "desc" },
      take: Math.min(opts?.limit ?? 60, 200),
      select: { value: true },
    });
    const out: CoachingAudit[] = [];
    for (const r of rows) {
      try {
        const a = JSON.parse(r.value) as CoachingAudit;
        if (a && a.version === 1) out.push(a);
      } catch {
        // A row we cannot parse is a row we skip. It must not blank the report.
      }
    }
    // Per-person keys sort by day already; a mixed read needs the day back on top.
    return out.sort((a, b) => (a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0));
  } catch {
    return [];
  }
}

async function writeCoachingAudit(audit: CoachingAudit): Promise<void> {
  const key = coachingAuditKey(audit.teamMemberId, audit.dayKey);
  const json = JSON.stringify(audit);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: json, updatedBy: "comms-coaching" },
    update: { value: json, updatedBy: "comms-coaching" },
  });
}

// ---------------------------------------------------------------------------
// 1. GATHER
// ---------------------------------------------------------------------------

/** One conversation, ready to judge. Exported with judgeThreads() and
 *  renderCoachingNote() so the acceptance drill can put a KNOWN day in front of
 *  the same prompt the cron uses — including a deliberately warm one, to prove
 *  it returns zero suggestions rather than inventing one. A second copy of the
 *  prompt in a test is exactly how the two drift apart. */
export type CoachThread = {
  threadKey: string;
  clientName: string | null;
  /** Oldest first, the whole two-sided conversation around today's messages. */
  turns: ConvoTurn[];
  /** How many of HIS messages today sit in this thread. */
  ownCount: number;
  lastAt: number;
};

type Gathered = {
  threads: CoachThread[];
  messagesConsidered: number;
  messagesAnalysed: number;
  droppedForCap: number;
  /** His messages to somebody who is not a client. Never judged, always counted. */
  offClientSkipped: number;
  clients: string[];
};

// ---------------------------------------------------------------------------
// WHO IS ON THE OTHER END. This is a client-care audit, and more than half of
// what goes out of the company line is not client care at all.
//
// MEASURED ON PRODUCTION, Sep 21 2026, 30 days, 498 human outbound texts:
//   272 (55%) went to a TEAMMATE's handset — Jordan 133, James 105, Harrison 34
//   222 went to a number linked to a Client record
//     4 went to a number we cannot place at all
// Every one of those 272 is on the company line, so every one of them carries
// Kyle's senderTeamMemberId the moment attribution goes live. Without this test
// roughly half the corpus the judge reads is Kyle talking to his own colleagues,
// the recency-ordered caps let office chatter push real client threads out of
// the day entirely, and judgePrompt renders the teammate as "Client (Jordan
// Spackman)" — so the first note Kyle ever gets could coach him on how he texts
// the owner. That is not a rough edge, it is the feature being wrong about what
// it is auditing.
//
// TWO TESTS, IN THIS ORDER, AND THE FIRST ONE WINS:
//  1. Is the other number one of OURS (team roster, any status, plus our own
//     OpenPhone lines)? Then it is internal, full stop. It has to be checked
//     first because 22 of those 272 internal rows DO carry a clientId — two
//     teammates texting about a job is still not client care.
//  2. Otherwise, is there a Client record on the conversation? Only then is the
//     thread judged.
// Anything else is an UNKNOWN counterparty and it is left out. Null means
// unknown, never nobody: coaching somebody on a conversation we cannot even
// place is worse than the silence of leaving it alone.
// ---------------------------------------------------------------------------

/** What the run throws when it cannot say who is internal. Exported so the
 *  acceptance drill asserts on the real message and not on a copy of it. */
export const NO_INTERNAL_ROSTER =
  "comms coaching cannot establish which numbers are ours, so it cannot tell client care from office chatter; no note tonight";

/**
 * FAIL CLOSED. The set is the only thing standing between "Kyle was warm with a
 * client" and "Kyle was curt with Jordan", so an empty set is not a smaller
 * audit, it is a WRONG one.
 *
 * This used to be a warning. The comment above it reasoned the direction
 * backwards ("a smaller set only ever means we coach on less") while the warning
 * one line below it said the truth, which is the tell that the two halves were
 * written at different moments (Sep 21 2026 review). The arrow points the other
 * way: bucketClientThreads asks "is the other end OURS" first and "is there a
 * client on it" second, so every number missing from this set stops being
 * internal and starts being eligible.
 *
 * MEASURED ON PRODUCTION, Sep 21 2026, 30 days, with the set emptied: the day
 * goes from 222 client messages to 355. Only 22 of the 272 internal rows carry
 * a clientId, but classification is per CONVERSATION, so those 22 pull in all
 * 133 messages on Jordan's handset thread with them. The first note Kyle ever
 * got would have been graded mostly on how he texts the owner.
 *
 * A night with no note costs nothing and says so in the cron summary. Throwing
 * here lands in runDailyCommsCoaching's per-person catch as status "failed", the
 * other people still run, and the cron still finishes.
 */
export function requireInternalNumbers(keys: Set<string>): Set<string> {
  if (keys.size === 0) throw new Error(NO_INTERNAL_ROSTER);
  return keys;
}

/** Our own numbers as 10-digit keys: the whole team roster (inactive included,
 *  a number Sarah still answers is still ours) plus the workspace's OpenPhone
 *  lines.
 *
 *  The roster read is NOT caught: if it throws we have no idea who is internal
 *  and the right answer is silence, not a guess. The OpenPhone half stays
 *  best-effort because it only ever ADDS to the set, so losing it can only make
 *  us leave a thread out, never let an internal one in.
 *
 *  THROWS rather than returning a short set. Exported because
 *  src/app/coaching/page.tsx keeps a knowing second copy of this (its own
 *  comment asks for the export so that copy can be deleted), and two answers to
 *  "who is internal" is how the headline on that card quietly stops describing
 *  what the audit read. Whoever owns that file: this is the one to call. */
export async function ourPhoneKeys(): Promise<Set<string>> {
  const { phoneKey, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const keys = new Set<string>();
  const rows = await prisma.teamMember.findMany({ where: { phone: { not: null } }, select: { phone: true } });
  for (const r of rows) {
    const k = phoneKey(r.phone);
    if (k.length === 10) keys.add(k);
  }
  // GUARD THE ROSTER HALF, NOT THE UNION (Sep 21 2026, second review).
  // This used to call requireInternalNumbers on the finished set, which looks
  // equivalent and is not: a findMany that SUCCEEDS but yields nothing usable —
  // every phone null, every phone unparseable, a filtered or wiped roster —
  // leaves this empty, and the best-effort half below then adds the one or two
  // workspace LINE numbers, so the union is non-empty and the guard passes.
  // Those line numbers are the number we send FROM; they essentially never
  // appear as the counterparty on a thread, so the internal test would match
  // nothing and every message Kyle sent to Jordan, James or Harrison would be
  // read as client work and graded. 272 of 498 outbound texts in 30 days are
  // exactly that shape. The roster is the half that does the work, so the
  // roster is the half that has to be there.
  requireInternalNumbers(keys);
  try {
    for (const k of await ourOpenPhoneNumberKeys()) keys.add(k);
  } catch {
    // The line numbers are the smaller half of the set and the roster covers the
    // measured traffic; an OpenPhone blip must not stop the evening run. It can
    // only ever ADD, so losing it leaves a thread out rather than letting an
    // internal one in.
  }
  return keys;
}

/** The shape gatherDay reads out of CommLog for his own messages. Named so the
 *  bucketing below can be exercised on rows the drill builds by hand. */
export type CoachOwnRow = {
  id: string;
  occurredAt: Date;
  clientId: string | null;
  clientName: string | null;
  fromPhone: string | null;
};

export type CoachBucket = {
  key: string;
  phone: string | null;
  clientId: string | null;
  clientName: string | null;
  own: number;
  lastAt: number;
};

export type Bucketed = {
  /** Client conversations, most recent first. */
  buckets: CoachBucket[];
  /** His messages that went to one of our own numbers. */
  internal: number;
  /** His messages to a number with no Client record on it. */
  unplaceable: number;
};

/**
 * Group his day into conversations and keep only the ones with a client. Pure,
 * so the acceptance drill can prove the exclusion on rows it controls instead
 * of waiting for a production day that happens to contain internal traffic.
 *
 * `ourNumbers` is keyed on the last 10 digits, the same key the OpenPhone
 * webhook uses everywhere else; `phoneKey` is passed in rather than imported so
 * this stays free of I/O.
 */
export function bucketClientThreads(
  own: CoachOwnRow[],
  ourNumbers: Set<string>,
  phoneKey: (p?: string | null) => string,
): Bucketed {
  const buckets = new Map<string, CoachBucket>();
  let internal = 0;
  let unplaceable = 0;

  for (const m of own) {
    const k = phoneKey(m.fromPhone);
    if (k.length === 10 && ourNumbers.has(k)) {
      // Ours. Checked before the client test on purpose — see above.
      internal += 1;
      continue;
    }
    // fromPhone is the other party's number and is the only key that survives a
    // client record being edited or missing; clientId is the fallback.
    const key = m.fromPhone ? `p:${k || m.fromPhone}` : m.clientId ? `c:${m.clientId}` : `m:${m.id}`;
    const b = buckets.get(key) ?? {
      key,
      phone: m.fromPhone,
      clientId: m.clientId,
      clientName: m.clientName,
      own: 0,
      lastAt: 0,
    };
    b.own += 1;
    b.lastAt = Math.max(b.lastAt, m.occurredAt.getTime());
    if (!b.clientId && m.clientId) b.clientId = m.clientId;
    if (!b.clientName && m.clientName) b.clientName = m.clientName;
    buckets.set(key, b);
  }

  // The classification is per CONVERSATION, not per message: one linked message
  // on the thread is enough to say who the other party is, so his earlier reply
  // on the same thread (logged before the client was matched) rides along
  // instead of being thrown away as unknown.
  const all = [...buckets.values()];
  const client = all.filter((b) => !!b.clientId);
  for (const b of all) if (!b.clientId) unplaceable += b.own;

  // Most recent conversations first: those are the ones he would still recognise
  // tonight. A day past the cap keeps the freshest threads and says how many it
  // put down. Internal threads are gone by here, so the cap can no longer spend
  // itself on office chatter.
  return { buckets: client.sort((a, b) => b.lastAt - a.lastAt), internal, unplaceable };
}

export async function gatherDay(person: { id: string; name: string }, dayStart: Date, until: Date): Promise<Gathered> {
  const firstName = person.name.split(/\s+/)[0] || person.name;

  // HIS OWN WORDS ONLY. senderTeamMemberId is the attribution column; a null
  // there means we do not know who wrote it, and an unknown message is never
  // coached on. Automated sources are gone before the AI ever sees them.
  const own = await prisma.commLog.findMany({
    where: {
      channel: "text",
      direction: "out",
      senderTeamMemberId: person.id,
      occurredAt: { gte: dayStart, lt: until },
      source: { notIn: AUTO_SOURCES },
    },
    select: { id: true, body: true, occurredAt: true, clientId: true, clientName: true, fromPhone: true },
    orderBy: { occurredAt: "asc" },
    take: MAX_MESSAGES_PER_PERSON * 3,
  });
  if (own.length === 0) {
    return { threads: [], messagesConsidered: 0, messagesAnalysed: 0, droppedForCap: 0, offClientSkipped: 0, clients: [] };
  }

  const { phoneKey } = await import("@/lib/integrations/openphone");
  const grouped = bucketClientThreads(own, await ourPhoneKeys(), phoneKey);
  const offClientSkipped = grouped.internal + grouped.unplaceable;
  // messagesConsidered is what the day HELD FOR HIM AS CLIENT WORK. Internal and
  // unplaceable messages are not "considered and dropped", they were never this
  // audit's business, so they do not inflate the number on the report either.
  const considered = grouped.buckets.reduce((n, b) => n + b.own, 0);
  if (considered === 0) {
    return { threads: [], messagesConsidered: 0, messagesAnalysed: 0, droppedForCap: 0, offClientSkipped, clients: [] };
  }
  const kept = grouped.buckets.slice(0, MAX_THREADS_PER_PERSON);
  let budget = MAX_MESSAGES_PER_PERSON;
  const threads: CoachThread[] = [];
  let analysed = 0;

  const contextStart = new Date(dayStart.getTime() - CONTEXT_LOOKBACK_MS);
  for (const b of kept) {
    if (budget <= 0) break;
    const where = b.phone ? { fromPhone: b.phone } : { clientId: b.clientId };
    const rows = await prisma.commLog.findMany({
      where: { channel: "text", occurredAt: { gte: contextStart, lt: until }, ...where },
      select: {
        body: true,
        direction: true,
        occurredAt: true,
        contactName: true,
        clientName: true,
        source: true,
        senderTeamMemberId: true,
      },
      // NEWEST FIRST, then reversed below. It read `asc` with `take: 80` and
      // then kept the last 16 of those, which on a thread with more than 80 rows
      // in the window hands the judge the MIDDLE of the conversation with
      // today's messages missing entirely — the opposite of what the comment
      // said it did (Sep 21 2026 review). It also pulled 80 rows to keep 16.
      orderBy: { occurredAt: "desc" },
      take: MAX_TURNS_PER_THREAD,
    });
    // The tail is the part that matters: the conversation as it stood when he
    // answered, not last week's.
    const turns = turnsFromRows([...rows].reverse(), person.id, firstName, b.clientName);
    if (turns.length === 0) continue;

    const take = Math.min(b.own, budget);
    budget -= take;
    analysed += take;
    threads.push({ threadKey: b.key, clientName: b.clientName, turns, ownCount: take, lastAt: b.lastAt });
  }

  const clients = [...new Set(threads.map((t) => t.clientName).filter((c): c is string => !!c))];
  return {
    threads,
    messagesConsidered: considered,
    messagesAnalysed: analysed,
    droppedForCap: Math.max(0, considered - analysed),
    offClientSkipped,
    clients,
  };
}

/**
 * The transcript, speaker by speaker. Pure, and exported, because WHO EACH LINE
 * BELONGS TO is the whole safety property of this feature and it deserves a test
 * that does not need a production day to exist.
 *
 * The labels are load-bearing: his own lines carry his first name, a sweep's
 * carry "Automated", and anything else of ours carries "Us" — including his own
 * older messages whose provider id never came back, because unknown is not him.
 * The judge is told to read only his name, and the quote gate below enforces it.
 */
export function turnsFromRows(
  rows: {
    body: string | null;
    direction: string;
    occurredAt: Date;
    contactName: string | null;
    source: string;
    senderTeamMemberId: string | null;
  }[],
  personId: string,
  firstName: string,
  fallbackClientName: string | null,
): ConvoTurn[] {
  return rows
    .map((r) => {
      const isOurs = r.direction === "out";
      const auto = AUTO_SOURCES.includes(r.source);
      const sender = !isOurs
        ? r.contactName ?? fallbackClientName ?? null
        : auto
          ? "Automated"
          : r.senderTeamMemberId === personId
            ? firstName
            : "Us";
      return {
        role: isOurs ? ("us" as const) : ("client" as const),
        text: clip(cleanText(r.body ?? ""), MAX_CHARS_PER_TURN),
        at: r.occurredAt.toISOString(),
        sender,
      };
    })
    .filter((t) => t.text.length > 0);
}

// ---------------------------------------------------------------------------
// 2. JUDGE
// ---------------------------------------------------------------------------

// AI_MODELS.SMART, not FAST. This is a judgement about how a colleague speaks
// to people, delivered to that colleague under the owner's name. The cheap
// model is the wrong economy: one unfair note costs more than a year of the
// price difference.
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    thanks: {
      type: "string",
      description:
        "One warm sentence of genuine thanks that names a real client and the real thing that got handled. No praise that could be said about any day.",
    },
    wentWell: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
      description: "One short line each, specific, naming the client. Empty only if the day held nothing worth naming.",
    },
    suggestions: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client whose thread this is." },
          said: { type: "string", description: "His exact words, quoted, not paraphrased. Under 240 characters." },
          tryInstead: { type: "string", description: "The same message rewritten warmer, the same length or shorter." },
          why: { type: "string", description: "Why the rewrite lands better for this client in this moment. One or two sentences." },
        },
        required: ["client", "said", "tryInstead", "why"],
      },
      description: "AT MOST TWO, and usually ZERO. Return an empty array when the day needed no correction.",
    },
  },
  required: ["thanks", "wentWell", "suggestions"],
};

type JudgeResult = { thanks?: string; wentWell?: string[]; suggestions?: CoachingSuggestion[] };

/** The judge, as one call. Exported so the acceptance drill runs the PROMPT the
 *  cron runs, not a copy of it. */
export async function judgeThreads(
  firstName: string,
  dayLabel: string,
  threads: CoachThread[],
): Promise<{ result: JudgeResult; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  return aiJsonWithUsage<JudgeResult>({
    system: judgeSystem(firstName),
    prompt: judgePrompt(firstName, dayLabel, threads),
    schema: JUDGE_SCHEMA,
    model: AI_MODELS.SMART,
    maxTokens: 1600,
  });
}

function judgeSystem(firstName: string): string {
  return `You help the owner of a small real estate media agency write ONE short, warm end-of-day note to ${firstName}, who runs the operations desk and answers the company text line.

THE MOST IMPORTANT RULE: most days need no correction at all. If the day's messages were clear, warm and accurate, return an empty suggestions array and say what went well. Inventing something to fix so the note has content is a FAILURE, and it is the exact failure that would make ${firstName} stop reading these. Silence on a good day is the right answer.

${firstName} is trusted and good at this. The owner handed him the whole client inbox because he handles it well. You are writing a note between colleagues, not a performance review, and never a list of errors.

Raise something only when a real client would have felt it:
- a reply that reads clipped or transactional where the moment asked for a person
- logistics delivered with no acknowledgement of what the client actually said
- vague timing ("soon", "shortly", "should be", "as soon as possible")
- a question the client asked that went unanswered
- a "no" with no way forward offered
- an internal reason handed to a client (a teammate, an editor, a vendor, a mistake on our end)

"Warmer" NEVER means longer, softer about the facts, or less clear. The house voice is short, warm and concrete:
- no em dashes, no double dashes, no emojis, no bold
- no "lol", no slang, no exclamation pile-ups
- acknowledge once, take ownership, give the clear next step, then stop
- always give a specific time, never a vague one
- "we" for anything the business does ("we will have it to you Thursday"); "I" only for something he personally is about to do ("I will send the link the moment it is up")
- prefer "thank you for your patience" over "sorry", "investment" over "price"
- never name a teammate or an internal problem to a client

EVERY FIELD YOU RETURN OBEYS THOSE RULES, not just the rewrite: the thanks, every line of what went well, every rewrite and every why. The one exception is "said", which is his own words quoted back exactly as he typed them. The note goes out under the owner's name and he does not write em dashes, so an em dash anywhere in your answer is words in his mouth he never used.

Your rewrite must also not invent a fact, a date, a time or a commitment that is not already in the conversation.

Never build a suggestion around a number, a price, an amount or anything about money.
Never criticise a message that was correct because the client was being difficult.
Ignore every message not written by ${firstName}. Messages marked Automated were sent by software, not by him, and messages marked "Us" were written by someone else on the team.

Quote his words exactly in "said". If you cannot quote it, you cannot coach on it.`;
}

function judgePrompt(firstName: string, dayLabel: string, threads: CoachThread[]): string {
  const blocks = threads.map((t, i) => {
    const lines = t.turns.map((turn) => {
      const who = turn.role === "client" ? `Client${turn.sender ? ` (${turn.sender})` : ""}` : turn.sender ?? "Us";
      return `${who}: ${turn.text}`;
    });
    return `Conversation ${i + 1}${t.clientName ? ` with ${t.clientName}` : ""} (oldest first):\n"""\n${lines.join("\n")}\n"""`;
  });
  return `Today is ${dayLabel}. Below are the text conversations ${firstName} took part in today, each with enough history around it to judge tone in context rather than in isolation.

${blocks.join("\n\n")}

Judge ONLY the lines written by ${firstName}. Everything else is context: it tells you what the client asked for, what mood they were in, and whether his answer met it.

Return the thanks, what went well, and at most two things to try. Remember that zero things to try is the normal answer on a good day.`;
}

// ---------------------------------------------------------------------------
// 2b. THE QUOTE GATE — a suggestion has to be about something he really wrote
// ---------------------------------------------------------------------------

// THE ONE RULE THIS FEATURE CANNOT GET WRONG: never tell a person he wrote
// something he did not write. The prompt asks the model to judge only the lines
// marked with his first name and to quote them exactly, and the drill proves it
// does — but a prompt is a request and a drill is a sample, and this note goes
// out under Jordan's name to a colleague who cannot check it against the log.
//
// The risk is not theoretical. gatherDay deliberately labels an outbound line
// we cannot attribute as "Us" (unknown is not him), so during the attribution
// transition, and permanently for any send whose provider id never came back,
// a thread legitimately contains HIS OWN earlier messages under somebody else's
// label. A model reading that transcript can quote a line that is genuinely his
// and genuinely NOT marked his, or paraphrase his words into something he never
// typed, and nothing downstream would notice.
//
// So: a suggestion whose quoted words cannot be found in a turn that carries
// HIS name is dropped. Dropping is the right failure and not a conservative one
// — the cost of dropping a fair suggestion is that a note is shorter tonight,
// and the cost of keeping an unverifiable one is telling Kyle he was curt with a
// client in words that were Jordan's, the sweep's, or nobody's. The count is
// recorded on the audit so a model that starts paraphrasing shows up on the
// report instead of quietly reshaping what he is told he said.

/** Case, curly quotes, surrounding quote marks and runs of whitespace all gone,
 *  so the gate tests the WORDS and not the typography. Both sides go through
 *  this, never one. */
function quoteNorm(s: string): string {
  return cleanText(s)
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .toLowerCase();
}

/** Every turn across the day that is HIS, normalised once. */
export function ownQuoteCorpus(threads: CoachThread[], firstName: string): string[] {
  const want = firstName.trim().toLowerCase();
  const out: string[] = [];
  for (const t of threads) {
    for (const turn of t.turns) {
      if (turn.role !== "us") continue;
      if ((turn.sender ?? "").trim().toLowerCase() !== want) continue;
      const n = quoteNorm(turn.text);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Did he write this? Substring rather than equality: the model is asked for
 *  the sentence that mattered, not the whole message, and a turn is clipped at
 *  MAX_CHARS_PER_TURN anyway. A quote from past that clip cannot be verified
 *  here, and an unverifiable quote is dropped like any other. */
export function quotedFromHim(said: string, corpus: string[]): boolean {
  const needle = quoteNorm(said);
  if (!needle) return false;
  return corpus.some((turn) => turn.includes(needle));
}

/**
 * The filter the run applies to whatever the judge returned: every field
 * present, and the quote provably his. Returns what it kept and what it put
 * down, because a silent drop is how a drifting model stays invisible.
 */
export function verifySuggestions(
  raw: unknown,
  threads: CoachThread[],
  firstName: string,
): { kept: CoachingSuggestion[]; dropped: number; droppedQuotes: string[] } {
  const list = Array.isArray(raw) ? (raw as CoachingSuggestion[]) : [];
  const complete = list.filter((s) => s && s.client && s.said && s.tryInstead && s.why);
  const corpus = ownQuoteCorpus(threads, firstName);
  const kept: CoachingSuggestion[] = [];
  const droppedQuotes: string[] = [];
  for (const s of complete) {
    if (quotedFromHim(s.said, corpus)) kept.push(s);
    else droppedQuotes.push(s.said);
  }
  return {
    kept: kept.slice(0, 2),
    dropped: list.length - Math.min(kept.length, 2),
    droppedQuotes,
  };
}

// ---------------------------------------------------------------------------
// 3. THE NOTE
// ---------------------------------------------------------------------------

/** Money never travels. Kyle is ADMIN and already saw the message he wrote, but
 *  a coaching note is not a reason to widen what anybody sees, and a Slack DM
 *  goes somewhere the hub does not control. scrubMoney keeps the sentence and
 *  drops the figure, so the point still reads. */
const safe = (s: string) => scrubMoney(cleanText(s));

// ---------------------------------------------------------------------------
// THE HOUSE VOICE, ENFORCED RATHER THAN REQUESTED.
//
// judgeSystem lists the punctuation rules and now binds them to every field,
// but a prompt is a request. Until Sep 21 2026 it bound them to the rewrite
// alone, and the model put em dashes straight into the two fields the reader
// sees first. Both of these came back verbatim in the acceptance drill:
//   "Thank you for how you handled Marcus today — reschedule requests can go
//    sideways fast..."
//   "Andrea got a specific time, a personal commitment on the link, and a warm
//    close — nothing left hanging."
// That text is stored on the audit, rendered on /coaching by NoteCard (which
// reads the stored parts, NOT the rendered note) and sent as a Slack DM opening
// "Hey Kyle!" in Jordan's voice. Jordan does not write em dashes.
//
// So the prompt asks and this normalises, and the note is correct even on the
// day a model ignores the instruction. A COMMA, not a full stop: a dash used as
// a pair of brackets ("Andrea, who called twice, got a time") survives a comma
// and is mangled by a full stop, and the clause-joining case reads naturally
// either way.
//
// IT NEVER TOUCHES "said". That field is HIS words quoted back to him, and
// tidying a man's own punctuation before showing it to him is the small version
// of the exact failure this whole feature is built to avoid.
// ---------------------------------------------------------------------------

/** The emoji blocks the house rules forbid. Kept narrow on purpose: this runs
 *  over prose, and a greedy range would eat ordinary symbols. Built fresh each
 *  time it is needed, because a /g regex carries lastIndex between .test calls
 *  and would answer the same string differently on alternate runs. */
const emojiRe = () => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu;
/** An em dash, an en dash, or the double hyphen people type for one. */
const dashRe = () => /\s*(?:—|–|--+)\s*/g;

/** Does the hub's own copy break the house rules? Exported so the drill can
 *  assert on it, and used below to make a drifting model VISIBLE in the logs
 *  rather than silently corrected. */
export function violatesHouseVoice(s: string): string[] {
  const found: string[] = [];
  if (/—|–|--+/.test(s)) found.push("dash");
  if (emojiRe().test(s)) found.push("emoji");
  if (/\*\*/.test(s)) found.push("bold");
  return found;
}

/** Jordan's punctuation, applied to anything the hub wrote. */
export function houseVoice(s: string): string {
  if (!s) return s;
  return s
    .replace(emojiRe(), "")
    .replace(/\*\*/g, "")
    // A dash landing where there is already a mark of punctuation just goes.
    .replace(/([,.;:!?])\s*(?:—|–|--+)\s*/g, "$1 ")
    .replace(dashRe(), ", ")
    .replace(/,(?:\s*,)+/g, ", ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Everything the hub WROTE goes through this: money out, house voice in.
 *  `safe` on its own stays for his quoted words and for a client's name. */
const ours = (s: string) => houseVoice(safe(s));

/** The note in PLAIN text. Slack escaping happens once, at the Slack boundary
 *  in sendNote — it lived here too until the Sep 21 drill, and a client called
 *  "Smith & Co" came out of the two passes as "Smith &amp;amp; Co". The report
 *  screen wants the plain text anyway. */
export function renderCoachingNote(firstName: string, audit: Omit<CoachingAudit, "note" | "sent" | "sentAt" | "sendSkipped">): string {
  const out: string[] = [];
  // `ours` for everything the hub wrote, `safe` for his own quoted words and for
  // a client's name. Applied here as well as at the point the audit is stored,
  // so an audit written before the house-voice pass still renders in his voice.
  out.push(`Hey ${firstName}! ${ours(audit.thanks)}`);

  if (audit.wentWell.length) {
    out.push("");
    out.push("What went well");
    for (const w of audit.wentWell) out.push(`• ${ours(w)}`);
  }

  if (audit.suggestions.length) {
    out.push("");
    out.push(audit.suggestions.length === 1 ? "One to try" : "Two to try");
    for (const s of audit.suggestions) {
      out.push("");
      out.push(`With ${safe(s.client)}, you wrote:`);
      out.push(`"${clip(safe(s.said), 260)}"`);
      out.push(`Try: "${clip(ours(s.tryInstead), 320)}"`);
      out.push(`Why: ${ours(s.why)}`);
    }
    out.push("");
    out.push("Nothing else from me today. Thanks for carrying the desk.");
  } else {
    out.push("");
    out.push("Nothing to change today. Keep going exactly like that.");
  }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// 4. SEND, BEHIND THE SWITCH
// ---------------------------------------------------------------------------

type SendOutcome = { sent: boolean; reason: string | null };

/**
 * The bell row goes to the person and nobody else (userKey tm:<id> is read by
 * that person alone, src/app/api/notifications/route.ts). The DM carries the
 * note itself.
 *
 * WHY THE SLACK LEG IS SENT HERE AND NOT BY notifyInApp'S BRIDGE. The bridge
 * delivers a person-addressed row on the channels their saved matrix names FOR
 * THE ROW'S EVENT, and an unclassified kind is bell-only by design
 * ("a new emitter nobody classified must never text or DM someone by surprise",
 * notifyPrefs.ts). `comms_coaching` has no KIND_TO_EVENT entry and should not
 * borrow one: mapping it to "mention" or "job_ping" would put Kyle's coaching
 * behind a switch that names something else, and notifyPrefs.ts is not this
 * pass's file. So the bell row is minted the normal way and the DM is sent
 * directly, guarded by eventForKind: the moment somebody classifies this kind,
 * the guard falls through and the bridge owns delivery. It cannot double-send.
 *
 * TEXT IS NEVER AN OPTION, whatever a future mapping says. A coaching note that
 * buzzes a phone at 7 PM is a different message than the same words in Slack,
 * and Kyle's saved matrix reads sms:false on every event anyway.
 */
async function sendNote(
  person: { id: string; name: string; slackId: string | null },
  dayKey: string,
  note: string,
  thanks: string,
): Promise<SendOutcome> {
  const { notifyInApp, holdUntilCovered } = await import("@/lib/notify");
  const { eventForKind } = await import("@/lib/notifyPrefs");

  // Kept even though it returns null today (COMMS_COACHING_KIND is not in
  // ROUTINE_KINDS): a coaching note on a day nobody works should wait, and when
  // this kind is classified the answer starts arriving through the same door
  // every other alert uses.
  const hold = await holdUntilCovered(COMMS_COACHING_KIND, undefined);
  if (hold) return { sent: false, reason: `nobody works today, holding until ${hold.toISOString()}` };

  // Clip first, escape second: escaping then slicing can cut an "&amp;" in half.
  const slackDm = escapeSlack(clip(note, 2800));
  await notifyInApp({
    kind: COMMS_COACHING_KIND,
    title: `Your comms note for ${etDate(new Date(`${dayKey}T12:00:00Z`))}`,
    body: clip(thanks, 140),
    href: COMMS_COACHING_HREF,
    targets: [{ roles: ["OWNER", "ADMIN"], userKey: `tm:${person.id}`, slackDm }],
    dedupeKey: `comms-coaching-${dayKey}-${person.id}`,
  }).catch((e) => {
    // The bell is best-effort. The DM below is the delivery that matters.
    console.warn("comms coaching bell row failed", person.name, e);
  });

  if (eventForKind(COMMS_COACHING_KIND)) {
    return { sent: true, reason: null }; // the bridge delivered it
  }
  if (!person.slackId) return { sent: false, reason: "no Slack ID on file" };
  const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
  const dm = await slackDmUserDetailed(person.slackId, slackDm);
  return dm.ok ? { sent: true, reason: null } : { sent: false, reason: `Slack DM failed: ${dm.error}` };
}

// ---------------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------------

export type CoachingPersonResult = {
  teamMemberId: string;
  personName: string;
  status: "coached" | "sent" | "quiet" | "already-done" | "held" | "failed";
  detail: string;
};

export type CoachingRunSummary = {
  dayKey: string;
  ran: boolean;
  sendEnabled: boolean;
  people: CoachingPersonResult[];
};

/**
 * The whole end-of-day pass, called once from the evening cron.
 *
 * Idempotent by the stored audit, so the evening route's two UTC firings (the
 * DST pair) and any re-run cost nothing and cannot double-send. One live
 * exception, and it is deliberate: an audit recorded earlier TODAY with the
 * send switch off is re-sent, not re-analysed, if Jordan flips the switch
 * before the day is out. That is exactly the "read one before it is sent" loop
 * the default-off switch exists for.
 *
 * Never throws. The caller is a cron route whose other steps must still run.
 *
 * `dryRun` makes the whole pass INCAPABLE of writing anything: no audit row, no
 * bell row, no Slack DM. It exists because the acceptance drill has to run this
 * entry point against the live production database, and "it happens to be a
 * no-op because no row is attributed yet" is circumstance, not a guarantee. The
 * day attribution lands, the old drill would have written rows and, with the
 * switch on, DM'd Kyle a note nobody had read (Sep 21 2026 review). A guard on
 * the assertion is not a guard on the call.
 */
export async function runDailyCommsCoaching(opts?: { now?: Date; dryRun?: boolean }): Promise<CoachingRunSummary> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun === true;
  const dayKey = etDayKey(now);
  const dayLabel = etDate(now);
  const settings = await commsCoachingSettings().catch(() => DEFAULT_COMMS_COACHING);
  const summary: CoachingRunSummary = { dayKey, ran: true, sendEnabled: settings.sendEnabled, people: [] };
  if (settings.teamMemberIds.length === 0) {
    return { ...summary, ran: false, people: [] };
  }

  const dayStart = etDayStartUtc(now);
  for (const teamMemberId of settings.teamMemberIds.slice(0, 5)) {
    try {
      const member = await prisma.teamMember.findUnique({
        where: { id: teamMemberId },
        select: { id: true, name: true, active: true, slackId: true },
      });
      if (!member || !member.active) {
        summary.people.push({ teamMemberId, personName: member?.name ?? teamMemberId, status: "failed", detail: "not an active team member" });
        continue;
      }
      const firstName = member.name.split(/\s+/)[0] || member.name;

      // Already handled today?
      const existing = await readCoachingAudit(teamMemberId, dayKey);
      if (existing?.sent) {
        summary.people.push({ teamMemberId, personName: member.name, status: "already-done", detail: "already sent today" });
        continue;
      }
      if (existing && !settings.sendEnabled) {
        summary.people.push({ teamMemberId, personName: member.name, status: "already-done", detail: "audit recorded; sending is off" });
        continue;
      }
      if (existing && settings.sendEnabled) {
        if (dryRun) {
          summary.people.push({ teamMemberId, personName: member.name, status: "already-done", detail: "dry run: would re-send the note recorded earlier today" });
          continue;
        }
        // Analysed earlier today, switch flipped since. Send what was written.
        const out = await sendNote(member, dayKey, existing.note, existing.thanks);
        await writeCoachingAudit({ ...existing, sent: out.sent, sentAt: out.sent ? new Date().toISOString() : null, sendSkipped: out.reason });
        summary.people.push({
          teamMemberId,
          personName: member.name,
          status: out.sent ? "sent" : "held",
          detail: out.reason ?? "sent the note recorded earlier today",
        });
        continue;
      }

      const gathered = await gatherDay(member, dayStart, now);
      if (gathered.messagesAnalysed < MIN_MESSAGES_TO_COACH) {
        // SAY NOTHING RATHER THAN SOMETHING EMPTY. No audit row either: a day
        // with nothing to read is not a day that was reviewed, and the report
        // must not show it as one.
        summary.people.push({
          teamMemberId,
          personName: member.name,
          status: "quiet",
          detail: `${gathered.messagesConsidered} attributable client message${gathered.messagesConsidered === 1 ? "" : "s"} today, below the ${MIN_MESSAGES_TO_COACH} needed to judge a day${gathered.offClientSkipped ? ` (${gathered.offClientSkipped} more went to a teammate or a number we cannot place, which is not client work)` : ""}`,
        });
        continue;
      }

      const judged = await judgeThreads(firstName, dayLabel, gathered.threads);

      // THE QUOTE GATE, not a request in the prompt. See section 2b.
      const verified = verifySuggestions(judged.result.suggestions, gathered.threads, firstName);
      const suggestions = verified.kept;
      if (verified.droppedQuotes.length) {
        console.warn(
          `comms coaching dropped ${verified.droppedQuotes.length} suggestion(s) for ${member.name}: quoted words not found in a turn that is his`,
          verified.droppedQuotes,
        );
      }
      // THE HOUSE VOICE IS NORMALISED, NOT HOPED FOR (see houseVoice above).
      // The prompt now binds the rules to every field; this is what makes the
      // stored audit correct on the day a model ignores it, because NoteCard
      // renders the STORED parts and never the rendered note. A model that has
      // started drifting is logged rather than silently tidied.
      const drifted = [
        judged.result.thanks ?? "",
        ...(Array.isArray(judged.result.wentWell) ? judged.result.wentWell : []),
        ...suggestions.flatMap((s) => [s.tryInstead, s.why]),
      ].flatMap((s) => (typeof s === "string" ? violatesHouseVoice(s) : []));
      if (drifted.length) {
        console.warn(
          `comms coaching normalised ${drifted.length} house-voice break(s) out of the note for ${member.name}`,
          [...new Set(drifted)].join(", "),
        );
      }

      const base = {
        version: 1 as const,
        teamMemberId,
        personName: member.name,
        dayKey,
        generatedAt: new Date().toISOString(),
        messagesConsidered: gathered.messagesConsidered,
        messagesAnalysed: gathered.messagesAnalysed,
        threadsAnalysed: gathered.threads.length,
        droppedForCap: gathered.droppedForCap,
        offClientSkipped: gathered.offClientSkipped,
        suggestionsDropped: verified.dropped,
        clients: gathered.clients,
        thanks: ours(judged.result.thanks?.trim() || `Thank you for handling the text line today.`),
        wentWell: (Array.isArray(judged.result.wentWell) ? judged.result.wentWell : [])
          .filter((w) => typeof w === "string" && w.trim())
          .slice(0, 3)
          .map(ours)
          .filter((w) => w.length > 0),
        // His quoted words are stored exactly as he typed them; only the two
        // fields the hub wrote are put into Jordan's punctuation.
        suggestions: suggestions.map((s) => ({ ...s, tryInstead: houseVoice(s.tryInstead), why: houseVoice(s.why) })),
        model: judged.model,
        inputTokens: judged.usage.inputTokens,
        outputTokens: judged.usage.outputTokens,
      };
      const note = renderCoachingNote(firstName, base);

      let sent = false;
      let reason: string | null = "sending is off (Settings → comms coaching)";
      if (dryRun) {
        reason = "dry run: nothing was sent and nothing was written";
      } else if (settings.sendEnabled) {
        const out = await sendNote(member, dayKey, note, base.thanks);
        sent = out.sent;
        reason = out.reason;
      }
      if (!dryRun) {
        await writeCoachingAudit({ ...base, note, sent, sentAt: sent ? new Date().toISOString() : null, sendSkipped: reason });
      }
      summary.people.push({
        teamMemberId,
        personName: member.name,
        status: sent ? "sent" : "coached",
        detail: `${gathered.messagesAnalysed} message${gathered.messagesAnalysed === 1 ? "" : "s"} across ${gathered.threads.length} conversation${gathered.threads.length === 1 ? "" : "s"}, ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}${verified.dropped ? `, ${verified.dropped} dropped as unquotable` : ""}${gathered.droppedForCap ? `, ${gathered.droppedForCap} past the cap` : ""}${gathered.offClientSkipped ? `, ${gathered.offClientSkipped} not client work` : ""}${sent ? "" : `; not sent: ${reason}`}`,
      });
    } catch (e) {
      // One person's failure must not take the others, and none of them may take
      // the cron. The evening route has a digest and a chaser riding on it.
      console.warn("comms coaching failed", teamMemberId, e);
      summary.people.push({
        teamMemberId,
        personName: teamMemberId,
        status: "failed",
        detail: e instanceof Error ? e.message : "coaching failed",
      });
    }
  }
  return summary;
}
