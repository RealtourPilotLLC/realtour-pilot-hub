import "server-only";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { phoneKey } from "@/lib/integrations/openphone";
import { classifyComm, isReaction, PRAISE_ONLY } from "@/lib/comms";
import { stripQuotedReply } from "@/lib/text";

// ---------------------------------------------------------------------------
// THE ONE ANSWER TO "WHO IS WAITING ON A REPLY".
//
// Four engines used to answer this question and they disagreed on screen. On
// 2026-09-02 the Ops Day pill and the Tasks→Comms tab said 1 while the
// Dashboard and the Replies tab said 5, and five unanswered EMAIL
// conversations appeared on no home screen at all. Every one of the four extra
// text rows was wrong, each for a different reason:
//   · Tabitha Heit — her last "message" was a `Loved "…"` tapback on OUR text.
//   · Sarina Spinelli — the thread was already ticked handled (a COMPLETED
//     client_reply task); only the two count-only engines honored that.
//   · Stephen Kennedy — Jordan answered from his own cell, and the OpenPhone
//     receiver logged his outbound texts as `direction: "in"`, so a queue built
//     on "newest row is inbound" could never clear that thread.
//   · James Livingston — his last "message" was a lone 🙌🏻.
// Jordan's condition for moving the team onto this hub is that every number on
// screen is true — a count has to match the list it links to, and nothing may
// read "done" without the thing having happened. So there is now ONE walk over
// the comms log, `unansweredComms()`, and every surface is a thin slice of it:
//
//   /communications?tab=replies + the Dashboard chip → replyQueue() /
//        replyWaitingSummary()      (phone, every sender, drafts + send)
//   /ops pill + preview            → findUnansweredInbound()  (commsSla.ts)
//   /tasks?tab=comms Phone | Email → unansweredCommsBoard()   (commsBoard.ts)
//   the 5-minute SLA pager         → findUnansweredInbound({ families: ["phone"] })
//
// THE RULES, in one place:
//  1. A thread is waiting when it holds at least one INBOUND message, still
//     unanswered, that actually asks something of us.
//  2. Tapbacks and reactions are not messages. `Loved "…"`, a lone 🙌🏻, a
//     "recording.completed" breadcrumb: dropped, never even collapsed.
//  3. Courtesy closers ("Thanks!", "Will do", "Thx!") don't hold a thread open.
//     They're kept separately so the Replies tab can still show them under a
//     fold — Kyle may want to answer a thank-you — but they are never counted.
//  4. OUR SIDE ANSWERING CLOSES IT, however the answer got logged: an outbound
//     row, a row labelled "Us"/"RealTour Pilot", or a row a TEAMMATE authored
//     inside a client's thread (that last one is what rescues the Stephen
//     Kennedy case — see `authoredByUs`, and note it stays correct once the
//     receiver's direction bug is fixed, because it is an OR, not a guess).
//     An automated confirmation/delivery text answers nothing.
//  5. A HUMAN JUDGMENT closes it: a COMPLETED client_reply task (phone) or the
//     Gmail sync's own reply detection + the per-group Handled tick (email).
//     It is a CUT POINT, not a delete — a message that arrives after the tick
//     is waiting again.
//
// Built on CommLog rather than on open reply TASKS, deliberately. A task only
// exists when the sender matched a client; the 30-day comms review found a
// large share of inbound texts come from people we haven't matched (a new lead,
// an assistant on someone's team, a number that never got saved). Those are
// exactly the ones that go unanswered, so a queue that can't see them misses
// the problem it exists to solve.
// ---------------------------------------------------------------------------

// Older than this and a reply isn't a reply any more. ONE window for every
// surface: the boards and the pager stopped at 7 days while the Replies tab
// went back 21, which is the same disagreement in a different coat.
//
// 7 and not 21, measured against live data on 2026-09-02: at 21 days the email
// board goes from 5 rows to 17, and the twelve extra are out-of-office
// auto-replies, an Instagram download notice, forwarded vendor pitches and
// three-week-old threads long since dealt with outside the hub. A board that is
// mostly noise is one Kyle stops trusting — the same reason the courtesy filter
// exists. Anything older than a week that is genuinely unanswered is an audit
// finding, not a live queue item. It is one constant if Jordan wants it longer.
const WINDOW_DAYS = 7;
const SCAN_CAP = 3000; // rows pulled; ~3 weeks of comms sits well under this
const THREAD_TURNS = 24; // how much history each thread carries for the AI
const PENDING_SHOWN = 5; // messages listed per thread — waitingSince keeps the TRUE age

// Same tiering as every other CommLog reader — a viewer sees their tier and below.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };

// Top-tier clients get the faster clock and the star. "vip" is $20k+, "heavy"
// is $5k–$20k (src/lib/segments.ts) — the same pair queries.ts treats as
// top-of-book. (The board used to test for "whale", which is not a segment this
// system has ever written, so no email row was ever starred.)
const VIP_SEGMENTS = new Set(["vip", "heavy"]);

export type WaitingFamily = "phone" | "email";
export type ReplyTurn = { role: "client" | "us"; text: string; at: string };

// ---------------------------------------------------------------------------
// What counts as a message that needs answering
// ---------------------------------------------------------------------------

// Tapbacks that quote our own message, and the bare reaction verbs. A
// "Questioned …" tapback IS a question, so it deliberately stays visible.
const TAPBACK_RE = /^(loved|liked|laughed at|emphasi[sz]ed|disliked)\b/i;
// Call-log artifacts a backfill wrote into the text channel — machine
// breadcrumbs, not a client waiting.
const CALL_ARTIFACT_RE = /^(incoming|outgoing|missed) call\b|recording\.completed|call\.(completed|ringing)/i;

// LINEAR-TIME courtesy detection (a regex version of this backtracked
// exponentially on "Awesome!!!!…"). A SHORT message made entirely of
// acknowledgment words closes a thread; it doesn't open one.
const ACK_WORDS = new Set([
  "oh", "thanks", "thank", "thankyou", "thx", "ty", "tysm", "you", "u", "so", "much", "very",
  "awesome", "perfect", "great", "amazing", "love", "loved", "it", "them", "these", "this",
  "beautiful", "wonderful", "gorgeous", "ok", "okay", "sounds", "good", "got", "the", "best",
  "appreciate", "appreciated", "yay", "cool", "nice", "will", "do", "yes", "yep", "yup", "sir",
  "maam", "see", "then", "looks", "sweet", "excellent", "fantastic", "incredible", "wow", "and",
  "are", "truly", "really", "kyle", "jordan", "for", "understanding", "again", "everything",
  "welcome", "no", "nope", "problem", "worries", "np", "hi", "hey", "hello", "guys", "team",
  "all", "set", "done", "sure", "absolutely", "works", "fine", "of", "course",
]);
// Unambiguous closing phrases that survive a couple of non-ack words around
// them ("All good homey 🙏", "You're the man", "Looking forward to Friday").
const ACK_PHRASE_RE =
  /\b(will do|sounds (good|great)|no (problem|worries)|all (good|set)|you'?re the (man|best)|looking forward to|see you (then|there|soon)|good luck|have a (good|great)|talk (soon|later))\b/i;
// Short, appreciative, no question in it — "Thank you!!", "These look amazing".
// PRAISE_ONLY is the classifier's own regex (src/lib/comms.ts), imported rather
// than copied: three files used to carry their own edition of it.

/** Reactions, tapbacks, machine breadcrumbs: not messages at all. Dropped
 *  outright — they are never even shown under the "probably handled" fold. */
function isNoise(text: string | null): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length <= 3) return true;
  // A "Questioned" tapback IS a question — it stays visible, so it has to be
  // caught before isReaction (whose list includes it, because that list gates
  // TASK creation rather than this queue).
  if (/^questioned\b/i.test(t)) return false;
  if (TAPBACK_RE.test(t)) return true;
  if (CALL_ARTIFACT_RE.test(t)) return true;
  // Emoji-only / punctuation-only, and the "Liked …" family (src/lib/comms.ts).
  if (isReaction(t)) return true;
  return false;
}

/** A real message that leaves nothing owed: "Thanks!", "Will do", "Thx!".
 *  Deliberately conservative — a false "needs an answer" costs a click, a false
 *  "handled" costs a client. Anything with a question mark, a number (a time, an
 *  address, a price) or a real ask in it falls through to the queue. */
function isCourtesy(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.includes("?")) return false; // they asked something
  if (t.length > 120) return false; // a real message, whatever it opens with
  const words = t.toLowerCase().replace(/[^a-z']+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true; // punctuation/emoji only
  if (words.length <= 10 && words.every((w) => ACK_WORDS.has(w))) return true;
  // A short message carrying a closing phrase, unless it is also asking for an
  // edit ("Sounds good — can you also swap the cover photo").
  if (/\d/.test(t)) return false; // a time, a date, an address, a price
  if (t.length <= 80 && ACK_PHRASE_RE.test(t) && !classifyComm(t).isRevision) return true;
  if (t.length <= 60 && PRAISE_ONLY.test(t) && !classifyComm(t).isRevision) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Email hygiene (lives here because the one walk needs it; commsBoard.ts and
// app/actions.ts still import both names from their old home, which re-exports)
// ---------------------------------------------------------------------------

// The AppSetting key holding a manual "Handled" ack for one email sender-group.
// Scoped per GROUP (not per client) so ticking Matthew's card can't silently
// hide Arielle's mis-attributed emails. Legacy client-wide keys
// (comms-ack-email-<cid>) written before this existed are still honored.
export function emailAckKey(clientId: string, groupKey: string): string {
  return `comms-ack-email-${clientId}:${encodeURIComponent(groupKey)}`;
}

// Automated / non-client email noise: payment failures, receipts, newsletters,
// chamber-of-commerce blasts, no-reply senders. Jordan (Sep 1): "I don't even
// want payment failures to show up." Terms are anchored/word-bounded so a REAL
// client email ("Question about my invoice", "Promo video for 456 Oak St", a
// sender surnamed Chambers or Billings) is never eaten — the transactional
// shapes must open the subject; marketing terms are word-bound.
// (`automatic reply` / `out of office` added Sep 2: an auto-responder is by
// definition nobody waiting on us, and one was sitting on the board.)
const EMAIL_NOISE_SUBJECT = /^(accepted|declined|tentatively accepted|updated invitation|canceled event|cancelled event):|^(automatic reply|auto-?reply|out of (the )?office)\b|^(your |payment )?(receipt|invoice|statement|renewal|auto-?pay(ment)?)\b|subscription (on hold|paused|cancell?ed)\b|payment (failed|failure|declined|unsuccessful)\b|\b(webinar|newsletter|unsubscribe|promo code|chamber)\b|\bweekly (update|digest)\b|% off|\bsale ends\b/i;
const EMAIL_NOISE_SENDER = /no-?reply|do-?not-?reply|notifications?@|\bbilling\b|support@|\bchamber\b|marketing@|\bnewsletter\b|mailer-daemon|\bautomated\b/i;

/** Email bodies arrive with signature junk — `<tel:...>` / `<https://...>`
 *  angle artifacts, `[image: facebook]` blocks, mailto noise — on top of the
 *  quoted history stripQuotedReply removes. Kyle needs the MESSAGE.
 *  The truncation rules are anchored to signature/attribution SHAPE (bold runs
 *  each on their own line; a "wrote:" tail on date attributions) so mid-prose
 *  emphasis or a sentence naming a date can't eat the message — and if a rule
 *  still empties the text, we fall back to the un-truncated base rather than
 *  silently hiding the email. */
export function cleanEmailBody(raw: string): string {
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

// ---------------------------------------------------------------------------
// The one walk
// ---------------------------------------------------------------------------

export type WaitingMessage = {
  channel: "text" | "call" | "email";
  subject: string | null;
  /** what a human should read — cleaned for email, verbatim for a text */
  body: string;
  at: Date;
};

export type WaitingThread = {
  /** stable conversation id: `c:<clientId>` | `p:<phone>` | `n:<name>` | `e:<groupKey>` */
  key: string;
  family: WaitingFamily;
  /** the per-sender key inside the family — the React key AND the email
   *  Handled tick's ack scope, so two senders mis-filed under one client
   *  record never share a tick */
  groupKey: string;
  clientId: string | null;
  /** every client id seen on this thread (email attribution is imperfect) */
  clientIds: string[];
  clientName: string | null;
  contactName: string | null;
  /** who the human sees: client, contact, teammate, or a formatted number */
  displayName: string;
  /** 10-digit key we'd text back on; null = can't send from here */
  phone: string | null;
  isClient: boolean;
  isTeam: boolean; // a photographer/editor, not a customer
  isVip: boolean;
  segment: string | null;
  socialPlan: string | null;
  propertyAddress: string | null;
  projectId: string | null;
  /** unanswered inbound that needs an answer, oldest first, last 5 */
  pending: WaitingMessage[];
  /** unanswered but courtesy-only ("Thanks!") — never counted */
  courtesy: WaitingMessage[];
  /** true when the thread holds ONLY courtesy closers */
  courtesyOnly: boolean;
  /** the oldest message still owed an answer — the TRUE wait */
  waitingSince: Date;
  hoursWaiting: number;
  /** recent dialogue, oldest first, for drafting context */
  turns: ReplyTurn[];
  /** the reply to-do this clears, when there is one */
  openTaskId: string | null;
};

export type UnansweredOptions = {
  now?: Date;
  /** default both. Phone = texts + calls; email = the Gmail sync. */
  families?: WaitingFamily[];
  /** default WINDOW_DAYS (7). The SLA pager sets its own; nothing else should. */
  windowDays?: number;
  /** conversations we never matched to a client (new leads, unsaved numbers).
   *  Phone only — unmatched EMAIL is newsletters, not people. Default true. */
  includeUnmatched?: boolean;
  /** our own photographers/editors texting in. Default true. */
  includeTeam?: boolean;
  /** threads holding only "Thanks!" — shown under a fold, never counted. */
  includeCourtesy?: boolean;
  /** CommLog tier gate (a viewer sees their tier and below). null = no gate. */
  minRoles?: string[] | null;
};

type Row = {
  channel: string;
  direction: string;
  clientId: string | null;
  clientName: string | null;
  contactName: string | null;
  fromPhone: string | null;
  projectId: string | null;
  subject: string | null;
  body: string;
  occurredAt: Date;
  source: string;
};

type Bucket = {
  key: string;
  family: WaitingFamily;
  groupKey: string;
  clientId: string | null;
  clientIds: string[];
  clientName: string | null;
  contactName: string | null;
  /** the FULLEST inbound sender label seen ("Sharra Mercer" over "S Mercer") —
   *  who this conversation is WITH, never our own "Us" stamp */
  senderName: string | null;
  phone: string | null;
  projectId: string | null;
  pending: WaitingMessage[];
  courtesy: WaitingMessage[];
  /** true oldest still-owed message, survives the display cap */
  firstAt: Date | null;
  rows: Row[]; // recent dialogue for `turns`
};

const fmtPhone = (k: string) =>
  k.length === 10 ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : k;

/** Labels the receivers stamp on our own outgoing messages. */
const OUR_LABELS = new Set(["us", "realtour pilot", "realtour pilot, llc"]);

/**
 * Every conversation still owed an answer — phone and email in one list.
 * This is the only place that question is answered; every surface slices this.
 */
export async function unansweredComms(opts: UnansweredOptions = {}): Promise<WaitingThread[]> {
  const now = opts.now ?? new Date();
  const families = opts.families ?? (["phone", "email"] as WaitingFamily[]);
  const wantPhone = families.includes("phone");
  const wantEmail = families.includes("email");
  if (!wantPhone && !wantEmail) return [];
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const includeUnmatched = opts.includeUnmatched ?? true;
  const includeTeam = opts.includeTeam ?? true;
  const includeCourtesy = opts.includeCourtesy ?? false;
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const channels = [...(wantPhone ? ["text", "call"] : []), ...(wantEmail ? ["email"] : [])];
  // Newest-first with a cap, then reversed: the walk needs time order, but a
  // blown-out window must drop the OLDEST rows, never the live ones.
  const rows: Row[] = (
    await prisma.commLog.findMany({
      where: {
        channel: { in: channels },
        occurredAt: { gte: since },
        ...(opts.minRoles ? { minRole: { in: opts.minRoles } } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: SCAN_CAP,
      select: {
        channel: true, direction: true, clientId: true, clientName: true, contactName: true,
        fromPhone: true, projectId: true, subject: true, body: true, occurredAt: true, source: true,
      },
    })
  ).reverse();
  if (rows.length === 0) return [];

  // Our own people, by number and by name. The number is the reliable signal
  // (a name only helps on rows logged before fromPhone existed).
  const teamMembers = await prisma.teamMember.findMany({ select: { name: true, phone: true } });
  const teamPhones = new Map<string, string>();
  const teamNames = new Set<string>();
  for (const t of teamMembers) {
    const k = phoneKey(t.phone);
    if (k.length === 10) teamPhones.set(k, t.name);
    if (t.name?.trim()) teamNames.add(t.name.trim().toLowerCase());
  }

  const buckets = new Map<string, Bucket>();
  // Email display-name variants merge only on a first-name PREFIX match
  // ("S Mercer" into "Sharra Mercer") — spouses like John/Jane Smith stay
  // separate groups, and a ", Realtor" / "- Keller Williams" suffix never
  // becomes a surname. Kept across clears so a group can't split in two when a
  // reply lands in the middle of a thread.
  const emailKeysSeen = new Set<string>();

  /** `<last>|<first>` from a display name, or the bare address / client id. */
  const emailKeyOf = (contactName: string | null, clientId: string | null): string | null => {
    const rawName = (contactName ?? "").split(/,|\s[-–—|]\s/)[0];
    // A bare address ("info@agency.com") keys on the address itself.
    if (rawName.includes("@")) return rawName.trim().toLowerCase();
    const name = rawName.trim().toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return clientId ? `client:${clientId}` : null;
    const parts = name.split(" ");
    if (parts.length < 2) return name;
    return `${parts[parts.length - 1]}|${parts[0]}`;
  };

  const emailGroupKey = (contactName: string | null, clientId: string | null): string => {
    const k = emailKeyOf(contactName, clientId) ?? `client:${clientId}`;
    const bar = k.lastIndexOf("|");
    if (bar < 0) return k;
    const last = k.slice(0, bar), first = k.slice(bar + 1);
    for (const seen of emailKeysSeen) {
      const sbar = seen.lastIndexOf("|");
      if (sbar < 0) continue;
      const sl = seen.slice(0, sbar), sf = seen.slice(sbar + 1);
      if (sl === last && sf && (sf.startsWith(first) || first.startsWith(sf))) return seen;
    }
    return k;
  };

  const phoneOf = (r: Row): string | null =>
    r.fromPhone && r.fromPhone.length === 10 ? r.fromPhone : null;

  /** The conversation this row belongs to. Null = untraceable; a row we could
   *  never reply to must not become a card. */
  const keyFor = (r: Row): { key: string; groupKey: string } | null => {
    if (r.channel === "email") {
      if (!r.clientId) return null; // unmatched email is newsletters, not people
      const g = emailGroupKey(r.contactName, r.clientId);
      return { key: `e:${g}`, groupKey: g };
    }
    // Prefer the client id (so a client texting from a second number is ONE
    // conversation); fall back to the number, then the name.
    if (r.clientId) return { key: `c:${r.clientId}`, groupKey: r.clientId };
    const p = phoneOf(r);
    if (p) return { key: `p:${p}`, groupKey: p };
    if (r.contactName) return { key: `n:${r.contactName}`, groupKey: r.contactName };
    return null;
  };

  /**
   * Did OUR side write this? Three independent signals, OR'd — which is what
   * makes it survive the OpenPhone receiver's direction bug in both states:
   *   · `direction: "out"` — the normal case, and what the fixed receiver writes.
   *   · the "Us" / "RealTour Pilot" label the receivers stamp on our own sends.
   *   · a TEAMMATE's number (or name) inside someone else's conversation —
   *     Jordan answering Stephen from his personal cell got logged `"in"`, and
   *     that thread could never clear. In a teammate's OWN thread (key
   *     `p:<their number>`) they are the counterparty, so the rule stands down.
   * Returns how we know, because a mis-logged row can't tell us who the
   * counterparty was and so must not clear a phone-keyed bucket.
   */
  const authoredByUs = (r: Row, key: string): "outbound" | "teammate" | null => {
    if (r.direction === "out") return "outbound";
    const label = (r.contactName ?? "").trim().toLowerCase();
    if (OUR_LABELS.has(label)) return "outbound";
    const counterpartyPhone = key.startsWith("p:") ? key.slice(2) : null;
    const counterpartyName = key.startsWith("n:") ? key.slice(2).trim().toLowerCase() : null;
    const fp = phoneOf(r);
    if (fp && teamPhones.has(fp) && fp !== counterpartyPhone) return "teammate";
    if (!fp && label && teamNames.has(label) && label !== counterpartyName) return "teammate";
    return null;
  };

  const bucketFor = (r: Row, id: { key: string; groupKey: string }): Bucket => {
    const existing = buckets.get(id.key);
    if (existing) return existing;
    const b: Bucket = {
      key: id.key,
      family: r.channel === "email" ? "email" : "phone",
      groupKey: id.groupKey,
      clientId: r.clientId,
      clientIds: [],
      clientName: r.clientName,
      contactName: r.contactName,
      senderName: null,
      // A number-keyed conversation IS that number. Anywhere else the number
      // gets filled in from the counterparty's own rows below — never from a
      // teammate's row, or a "reply" would text the teammate.
      phone: id.key.startsWith("p:") ? id.key.slice(2) : null,
      projectId: r.projectId,
      pending: [],
      courtesy: [],
      firstAt: null,
      rows: [],
    };
    buckets.set(id.key, b);
    if (b.family === "email") emailKeysSeen.add(id.groupKey);
    return b;
  };

  /** Our side answered — drop what was owed, WITHIN THIS CHANNEL FAMILY. A
   *  text reply must never clear a genuinely unanswered email (and vice versa);
   *  that was one of the reviewed rules the old boards each kept separately. */
  const clearFor = (r: Row, key: string, how: "outbound" | "teammate") => {
    const family: WaitingFamily = r.channel === "email" ? "email" : "phone";
    const kill = new Set<string>([key]);
    if (family === "email") {
      // Scope the clear to the replied sender's OWN groups — replying to
      // Matthew must not delete Arielle's mis-attributed pile.
      kill.add(`e:${emailGroupKey(r.contactName, r.clientId)}`);
      kill.add(`e:${emailGroupKey(r.clientName, r.clientId)}`);
      kill.add(`e:client:${r.clientId}`);
    } else {
      if (r.clientId) kill.add(`c:${r.clientId}`);
      // On a genuine outbound `fromPhone` is who we TEXTED. On a row a teammate
      // authored it is the teammate THEMSELVES, and using it would wipe that
      // teammate's own waiting thread. The two are told apart by the label: our
      // own sends are stamped "Us"/"RealTour Pilot", a teammate-authored row
      // keeps their name. Written this way so it stays right whichever state
      // the OpenPhone receiver's direction bug is in — including if the fix
      // ever backfills old rows to `direction: "out"` without being able to
      // recover who the counterparty was.
      if (how === "outbound") {
        const p = phoneOf(r);
        const label = (r.contactName ?? "").trim().toLowerCase();
        if (p && (!teamPhones.has(p) || OUR_LABELS.has(label))) kill.add(`p:${p}`);
      }
      // A reply sent before we knew who they were still closes their old
      // number-keyed thread.
      if (r.clientId) {
        for (const [k, b] of buckets) if (b.family === "phone" && b.clientIds.includes(r.clientId)) kill.add(k);
      }
    }
    for (const k of kill) {
      const b = buckets.get(k);
      if (!b || b.family !== family) continue;
      b.pending = [];
      b.courtesy = [];
      b.firstAt = null;
    }
  };

  // ---- the walk: oldest first. Inbound opens, our answer closes. ----
  for (const r of rows) {
    if (r.channel === "email" && !r.clientId) continue;
    const id = keyFor(r);
    if (!id) continue;
    const b = bucketFor(r, id);
    const ours = authoredByUs(r, id.key);

    // Keep the dialogue for drafting context, whatever we decide below.
    b.rows.push(r);
    if (b.rows.length > THREAD_TURNS) b.rows.shift();
    if (r.clientId) {
      if (!b.clientId) b.clientId = r.clientId;
      // Only the OTHER side's rows vote on who this conversation is with — our
      // own replies carry whatever client the router guessed for them, and an
      // email group is deliberately keyed on the SENDER, not that guess.
      if (!ours) b.clientIds.push(r.clientId);
    }
    if (r.projectId) b.projectId = r.projectId;
    if (r.clientName && !ours) b.clientName = r.clientName;

    if (ours) {
      // Automated confirmation/delivery texts answer nothing — a client's
      // unanswered question must not vanish because the robot texted.
      if ((r.source ?? "").startsWith("auto-")) continue;
      // A missed / unanswered outgoing call clears nothing either; an ANSWERED
      // outbound call IS an answer (Jordan kept getting "still unanswered"
      // pages two hours after handling it by phone).
      if (r.channel === "call" && /missed|no answer|unanswered/i.test(r.body ?? "")) continue;
      clearFor(r, id.key, ours);
      continue;
    }

    // Inbound. Work out what it is and whether it asks anything of us.
    let subject: string | null = null;
    let body: string;
    // A question in the SUBJECT line keeps the row even when the body reads as
    // a courtesy note, and a subject-only email ("Available Friday? EOM") still
    // surfaces.
    let asksInSubject = false;
    if (r.channel === "call") {
      // A missed call / voicemail demands a callback like a text demands a
      // reply — those rows used to be orphaned from every surface.
      if (!/missed|voicemail|no answer/i.test(r.body ?? "")) continue; // answered — nothing owed
      body = /voicemail/i.test(r.body ?? "") ? "Voicemail — call them back" : "Missed call — call them back";
    } else if (r.channel === "email") {
      if (EMAIL_NOISE_SUBJECT.test(r.subject ?? "") || EMAIL_NOISE_SENDER.test(r.contactName ?? "")) continue;
      subject = r.subject;
      // Judge on the CLEANED text — raw quoted history made every "Thanks!"
      // reply look long enough to need an answer.
      body = cleanEmailBody(r.body ?? "");
      asksInSubject = /\?/.test(r.subject ?? "");
      if (!body) body = (r.subject ?? "").trim();
      if (isNoise(body) && !asksInSubject) continue;
    } else {
      if (isNoise(r.body)) continue; // tapback, emoji, call breadcrumb
      body = (r.body ?? "").trim();
    }

    if (r.contactName && !OUR_LABELS.has(r.contactName.trim().toLowerCase())) {
      // Prefer the fullest display-name variant ("Sharra" over "S").
      if ((b.senderName?.length ?? 0) < r.contactName.length) b.senderName = r.contactName;
    }
    // Last write wins — the most recent number this person wrote in from.
    const p = phoneOf(r);
    if (p && !teamPhones.has(p)) b.phone = p;
    pushPending(b, { channel: r.channel as WaitingMessage["channel"], subject, body, at: r.occurredAt }, asksInSubject);
  }

  /** File one unanswered inbound: real ask, or courtesy closer. */
  function pushPending(b: Bucket, m: WaitingMessage, forceReal = false) {
    const list = !forceReal && isCourtesy(m.body) ? b.courtesy : b.pending;
    // One email often lands twice (sent to both inboxes) — show it once, but
    // keep the LATEST timestamp: a repeated "Any update?" nudge after a
    // Handled tick must resurface, not stay hidden behind the old ack.
    const dupIdx = list.findIndex((i) => i.subject === m.subject && i.body === m.body);
    if (dupIdx !== -1) {
      const [dup] = list.splice(dupIdx, 1);
      dup.at = m.at;
      list.push(dup);
    } else {
      list.push(m);
      if (list.length > PENDING_SHOWN) list.shift();
    }
    if (list === b.pending && (!b.firstAt || m.at < b.firstAt)) b.firstAt = m.at;
  }

  // The MAJORITY client id decides which record a group belongs to — it drives
  // the Handled tick's target and the VIP lookup, and email attribution is
  // imperfect enough ("Arielle Roemer is in Matthew Dunbar") that the first row
  // seen is not a safe answer.
  for (const b of buckets.values()) {
    if (b.clientIds.length === 0) continue;
    const counts = new Map<string, number>();
    for (const id of b.clientIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    b.clientId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  }

  // An email group key is the Handled tick's ack scope, so it must not drift
  // with the scan window. Whichever name variant happened to arrive first used
  // to decide it — "S Mercer" keyed the group `mercer|s` one morning and
  // `mercer|sharra` the next, and a stored ack silently stopped matching.
  // Re-derive it from the FULLEST name on the thread, which is the name the
  // card shows anyway.
  const emailGroups = [...buckets.values()].filter((b) => b.family === "email");
  for (const b of emailGroups) {
    const canonical = emailKeyOf(b.senderName ?? b.clientName, b.clientId);
    if (!canonical || canonical === b.groupKey) continue;
    if (emailGroups.some((o) => o !== b && o.groupKey === canonical)) continue; // never collide
    b.groupKey = canonical;
    b.key = `e:${canonical}`;
  }

  // ---- the human judgments: a ticked/auto-closed reply task, an email ack ----
  const live = [...buckets.values()].filter((b) => b.pending.length > 0 || b.courtesy.length > 0);
  if (live.length === 0) return [];
  const allClientIds = [...new Set(live.flatMap((b) => (b.clientId ? [b.clientId] : [])))];

  const ackKeys = live
    .filter((b) => b.family === "email" && b.clientId)
    .flatMap((b) => [emailAckKey(b.clientId!, b.groupKey), `comms-ack-email-${b.clientId}`]);

  const [handledTasks, emailAcks, openTasks, clients] = await Promise.all([
    allClientIds.length
      ? prisma.smartTask.findMany({
          where: {
            clientId: { in: allClientIds },
            taskType: "client_reply",
            status: "COMPLETED",
            completedAt: { gte: since },
          },
          select: { clientId: true, completedAt: true, source: true },
        })
      : Promise.resolve([] as { clientId: string | null; completedAt: Date | null; source: string }[]),
    ackKeys.length
      ? prisma.appSetting.findMany({ where: { key: { in: [...new Set(ackKeys)] } } })
      : Promise.resolve([] as { key: string; value: string }[]),
    allClientIds.length
      ? prisma.smartTask.findMany({
          where: { clientId: { in: allClientIds }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
          select: { id: true, clientId: true, propertyAddress: true, projectId: true },
        })
      : Promise.resolve([] as { id: string; clientId: string | null; propertyAddress: string | null; projectId: string | null }[]),
    allClientIds.length
      ? prisma.client.findMany({
          where: { id: { in: allClientIds } },
          select: {
            id: true, name: true, phone: true, segment: true, socialClient: true, socialPlan: true,
            parent: { select: { segment: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  // Handled is CHANNEL-SCOPED: a text reply must not hide a genuinely
  // unanswered email. Phone honors completed client_reply tasks born on the
  // phone side (source ≠ gmail); email honors the Gmail sync's own reply
  // detection (gmail-sourced completions — the normal way email gets answered)
  // plus the per-group Handled ack markers.
  const handledByClient = { phone: new Map<string, Date>(), email: new Map<string, Date>() };
  for (const h of handledTasks) {
    if (!h.clientId || !h.completedAt) continue;
    const lane = h.source === "gmail" ? "email" : "phone";
    const m = handledByClient[lane];
    if ((m.get(h.clientId) ?? new Date(0)) < h.completedAt) m.set(h.clientId, h.completedAt);
  }
  const ackByKey = new Map<string, Date>();
  for (const a of emailAcks) {
    const at = new Date(a.value);
    if (!isNaN(at.getTime())) ackByKey.set(a.key, at);
  }
  const openTaskByClient = new Map(openTasks.filter((t) => t.clientId).map((t) => [t.clientId as string, t]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const out: WaitingThread[] = [];
  for (const b of live) {
    // The ack/handled timestamp is a CUT POINT, not an all-or-nothing delete:
    // messages at-or-before it are answered and drop away; anything newer stays
    // visible with its wait measured from the first surviving message.
    const cut: Date[] = [];
    if (b.clientId) {
      const h = handledByClient[b.family].get(b.clientId);
      if (h) cut.push(h);
      if (b.family === "email") {
        const a1 = ackByKey.get(emailAckKey(b.clientId, b.groupKey));
        const a2 = ackByKey.get(`comms-ack-email-${b.clientId}`);
        if (a1) cut.push(a1);
        if (a2) cut.push(a2);
      }
    }
    if (cut.length) {
      const at = new Date(Math.max(...cut.map((d) => d.getTime())));
      b.pending = b.pending.filter((i) => i.at > at);
      b.courtesy = b.courtesy.filter((i) => i.at > at);
      b.firstAt = b.pending[0]?.at ?? null;
    }
    if (b.pending.length === 0 && b.courtesy.length === 0) continue;

    const courtesyOnly = b.pending.length === 0;
    if (courtesyOnly && !includeCourtesy) continue;

    const client = b.clientId ? clientById.get(b.clientId) : undefined;
    const task = b.clientId ? openTaskByClient.get(b.clientId) : undefined;
    // Fall back to the number on file for rows logged before fromPhone existed.
    const phone = b.phone ?? (client?.phone ? phoneKey(client.phone) || null : null);
    // Match our own people by number, and by name when the row predates
    // fromPhone — otherwise a photographer shows up as an unknown stranger.
    const teamName =
      (phone ? teamPhones.get(phone) : undefined) ??
      (b.senderName && teamNames.has(b.senderName.trim().toLowerCase()) ? b.senderName : undefined);
    const isTeam = !b.clientId && !!teamName;
    if (isTeam && !includeTeam) continue;
    if (!b.clientId && !includeUnmatched) continue;

    const waitingSince = b.firstAt ?? b.courtesy[0]?.at ?? b.rows[b.rows.length - 1].occurredAt;
    out.push({
      key: b.key,
      family: b.family,
      groupKey: b.groupKey,
      clientId: b.clientId,
      clientIds: [...new Set(b.clientIds)],
      clientName: client?.name ?? b.clientName ?? null,
      contactName: b.senderName,
      displayName:
        b.family === "email"
          ? b.senderName || client?.name || b.clientName || "Unknown"
          : client?.name ?? b.senderName ?? teamName ?? (phone ? fmtPhone(phone) : "Unknown number"),
      phone: phone && phone.length === 10 ? phone : null,
      isClient: !!b.clientId,
      isTeam,
      isVip: VIP_SEGMENTS.has(client?.segment ?? "") || VIP_SEGMENTS.has(client?.parent?.segment ?? ""),
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? client?.socialPlan ?? "yes" : null,
      propertyAddress: task?.propertyAddress ?? null,
      projectId: task?.projectId ?? b.projectId ?? null,
      pending: b.pending,
      courtesy: b.courtesy,
      courtesyOnly,
      waitingSince,
      hoursWaiting: Math.max(0, Math.round((now.getTime() - waitingSince.getTime()) / 3_600_000)),
      turns: b.rows.map((r) => ({
        role: authoredByUs(r, b.key) ? ("us" as const) : ("client" as const),
        text: r.channel === "email" ? cleanEmailBody(r.body) || r.subject || r.body : r.body,
        at: r.occurredAt.toISOString(),
      })),
      openTaskId: task?.id ?? null,
    });
  }

  // Longest wait first — VIPs ahead of the rest of an equal wait. The message
  // that's been sitting two days is the one that costs us a client, not the one
  // that came in ten minutes ago.
  return out.sort(
    (a, b) => (b.isVip ? 1 : 0) - (a.isVip ? 1 : 0) || a.waitingSince.getTime() - b.waitingSince.getTime(),
  );
}

/** The CommLog tier gate for the signed-in viewer (their tier and below).
 *  Sessionless local dev renders the owner view, same as the dashboard. */
async function viewerRoles(): Promise<string[]> {
  const me = await getCurrentUser().catch(() => null);
  const tier = contentTier(me?.role ?? "OWNER");
  return Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[tier]);
}

// ---------------------------------------------------------------------------
// The Replies tab (/communications?tab=replies) — the TEXT console: every
// conversation still owed an answer that we can actually answer from here, each
// with a draft ready to read.
//
// Jordan: "a generate response engine for Kyle so he can have responses
// generated to all inbound text messages, and then give him the ability to
// explain what he wants to say to be able to tailor the message."
//
// Phone family only — email is read-only in this hub (no gmail.send scope), so
// an email card here would be a Send button that can't send. Unanswered email
// is counted and listed on Ops Day and on /tasks?tab=comms&via=email, both of
// which read the SAME walk.
// ---------------------------------------------------------------------------

export type ReplyCard = {
  key: string; // stable id for this conversation (clientId or phone key)
  clientId: string | null;
  clientName: string | null;
  displayName: string; // who Kyle sees: client, contact, or a formatted number
  phone: string | null; // 10-digit key we'd send to; null = can't send from here
  isClient: boolean;
  isTeam: boolean; // a photographer/editor, not a customer
  segment: string | null;
  socialPlan: string | null;
  propertyAddress: string | null;
  projectId: string | null;
  lastInbound: string; // the message actually awaiting an answer
  waitingSince: string; // ISO
  hoursWaiting: number;
  turns: ReplyTurn[]; // oldest first, capped
  openTaskId: string | null; // the reply to-do this clears, when there is one
  likelyHandled: boolean; // last word was a thank-you — shown, but out of the way
};

export type ReplyQueue = {
  cards: ReplyCard[]; // needs a real answer
  handled: ReplyCard[]; // courtesy closers, collapsed under the queue
  clientCount: number;
  teamCount: number;
  oldestHours: number;
};

function toCard(t: WaitingThread): ReplyCard {
  // The newest message still owed an answer. On a courtesy-only thread that's
  // the thank-you itself, which is what the collapsed card is showing.
  const list = t.pending.length ? t.pending : t.courtesy;
  const latest = list[list.length - 1];
  return {
    key: t.key,
    clientId: t.clientId,
    clientName: t.clientName,
    displayName: t.displayName,
    phone: t.phone,
    isClient: t.isClient,
    isTeam: t.isTeam,
    segment: t.segment,
    socialPlan: t.socialPlan,
    propertyAddress: t.propertyAddress,
    projectId: t.projectId,
    lastInbound: latest?.body ?? "",
    waitingSince: t.waitingSince.toISOString(),
    hoursWaiting: t.hoursWaiting,
    turns: t.turns,
    openTaskId: t.openTaskId,
    likelyHandled: t.courtesyOnly,
  };
}

export async function replyQueue(): Promise<ReplyQueue> {
  const threads = await unansweredComms({
    families: ["phone"],
    includeCourtesy: true, // the fold below the queue
    minRoles: await viewerRoles(),
  });
  const cards = threads.filter((t) => !t.courtesyOnly).map(toCard);
  const handled = threads.filter((t) => t.courtesyOnly).map(toCard);
  return {
    cards,
    handled,
    clientCount: cards.filter((c) => c.isClient).length,
    teamCount: cards.filter((c) => c.isTeam).length,
    // The MAX, not the first row — VIPs jump the queue, so position no longer
    // means age and a "oldest 3d" badge read off cards[0] would understate it.
    oldestHours: cards.reduce((m, c) => Math.max(m, c.hoursWaiting), 0),
  };
}

// How many conversations are owed an answer, and how long the oldest has been
// sitting. `count` is the PHONE number, because that's the list the Dashboard
// chip and the Replies tab badge link to — a count must match what you land on.
// `email` rides alongside for any surface that wants to show both without a
// second scan. `oldestHours` is the number that actually makes someone act:
// seven unanswered is a queue, one of them sitting three days is a problem.
export async function replyWaitingSummary(): Promise<{
  count: number;
  oldestHours: number;
  phone: number;
  email: number;
  total: number;
}> {
  const threads = await unansweredComms({ minRoles: await viewerRoles() });
  const phone = threads.filter((t) => t.family === "phone");
  const email = threads.filter((t) => t.family === "email");
  return {
    count: phone.length,
    oldestHours: phone.reduce((m, t) => Math.max(m, t.hoursWaiting), 0),
    phone: phone.length,
    email: email.length,
    total: threads.length,
  };
}

// Rebuild ONE card after something changes (a send, a regenerate) without
// trusting the UI's optimism. Searches BOTH lists — Kyle can still choose to
// answer a thank-you, and the send action must find that card rather than
// reporting it already handled.
export async function replyCardFor(key: string): Promise<ReplyCard | null> {
  const q = await replyQueue();
  return [...q.cards, ...q.handled].find((c) => c.key === key) ?? null;
}
