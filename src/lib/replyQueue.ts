import "server-only";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { phoneKey } from "@/lib/integrations/openphone";
import { classifyComm, isReaction, PRAISE_ONLY } from "@/lib/comms";
import { stripQuotedReply } from "@/lib/text";
import { HUB_REPLY_SOURCE, HUB_SMS_PREFIX, HUB_SMS_SOURCES, isHubSms, isHubSmsSource } from "@/lib/hubSms";

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
//  5. A HUMAN JUDGMENT closes it: a COMPLETED client_reply task (phone), the
//     Gmail sync's own reply detection + the per-group Handled tick (email),
//     or — since Sep 16 — a THREAD tick on any row at all, client record or
//     not (`comms-ack-thread:<family>:<key>`; see below). It is a CUT POINT,
//     not a delete — a message that arrives after the tick is waiting again.
//     A number marked spam is muted outright until someone un-mutes it.
//  6. BULK MAIL IS NOT A PERSON WAITING, even from a matched client record: a
//     newsletter, a marketing blast, a cold vendor pitch (see `isBulkEmail`).
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
// AN OBLIGATION THE HUB ALREADY RAISED DOES NOT AGE OUT (audit WF-05, Sep 17).
//
// The window above is right about NOISE and the audit is right about LOSS: an
// unanswered client question could leave the reply workflow through age alone,
// silently. The two reconcile on who decided. The twelve extra rows at 21 days
// were out-of-office replies, vendor pitches and threads long since dealt with
// — nobody chose them. An open client_reply task is the opposite: the hub
// looked at that conversation and recorded that we owe an answer, and that
// obligation is persistent state, not a rolling read.
//
// So threads belonging to a client with an OPEN reply to-do are looked up
// beyond the window, bounded to this many days and this many rows. Every other
// thread keeps the seven-day read exactly as before. Closing the task is still
// what ends it — this changes nothing about how a thread is answered, only
// about whether it can vanish while still owed.
const OWED_LOOKBACK_DAYS = 45;
const OWED_SCAN_CAP = 600;
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

/** CommLog.source on an outbound row the Gmail sync lifted out of Sent
 *  (src/lib/integrations/google.ts). Shared so the walk and the writer can
 *  never drift on the spelling. */
export const GMAIL_SENT_SOURCE = "gmail-sent";

/** One mail thread's identity, from its subject: "Re: Fwd: Your listing content
 *  is ready!" and "Your listing content is ready!" are the same conversation.
 *  Empty string = nothing to match on (a subject-less send), and the caller
 *  must not treat that as a match. */
function threadSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  // Stripped one prefix at a time: "Re: Fwd: …" carries two, and an anchored
  // global replace only ever fires at position 0.
  const PREFIX = /^(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i;
  while (PREFIX.test(s)) s = s.replace(PREFIX, "");
  return s.toLowerCase();
}

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
export function isCourtesyMessage(text: string): boolean {
  return isCourtesy(text);
}

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

// ---------------------------------------------------------------------------
// DISMISS, FOR EVERY ROW — NOT JUST THE ONES WITH A CLIENT RECORD.
//
// Kyle's call (Sep 16): "there's no way to get rid of things I've already
// dealt with." The human-judgment cut (rule 5) was keyed on `clientId`, so an
// unmatched number, a teammate's status text and a spam blast had NO exit at
// all — the only way to clear James Livingston's six-day row was to text him
// back from the company line. On Sep 16 the Replies tab read "2 waiting ·
// oldest has been 6 day(s)" and BOTH rows were our own photographers.
//
// So the cut now has a thread-scoped twin that works on any key:
//   comms-ack-thread:<family>:<threadKey>   value: "<ISO>" or "<ISO>|<reason>"
// It behaves EXACTLY like the client cut — a CUT POINT, not a delete. Messages
// at-or-before it drop; a new one after it is waiting again; CommLog is never
// touched, so the Inbox still holds the whole conversation.
//
// Spam goes one step further and mutes the NUMBER (comms-mute:<phoneKey>), so
// the same blaster doesn't need a tick a day. Muting is reversible from the
// Replies tab and is refused on a teammate's number (app/actions.ts).
// ---------------------------------------------------------------------------

/** The reasons a person can give for clearing a conversation by hand. */
export const COMMS_DISMISS_REASONS = ["answered elsewhere", "no reply needed", "spam"] as const;
export type CommsDismissReason = (typeof COMMS_DISMISS_REASONS)[number];

/** AppSetting key for a thread-scoped "handled" cut. Family-scoped so a text
 *  tick can never hide a genuinely unanswered email. */
export function threadAckKey(family: WaitingFamily, threadKey: string): string {
  return `comms-ack-thread:${family}:${encodeURIComponent(threadKey)}`;
}

/** AppSetting key muting one 10-digit number: it stops opening rows until
 *  someone un-mutes it. History is never deleted. */
export function commsMuteKey(phone: string): string {
  return `comms-mute:${phone}`;
}

/** An ack/mute value is "<ISO>" or "<ISO>|<reason>" — one column, two facts. */
export function ackValue(at: Date, reason?: string | null): string {
  return reason ? `${at.toISOString()}|${reason}` : at.toISOString();
}

/** Split one back out. Returns null when the stored value isn't a date. */
export function parseAckValue(raw: string | null | undefined): { at: Date; reason: string | null } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const bar = s.indexOf("|");
  const at = new Date(bar < 0 ? s : s.slice(0, bar));
  if (isNaN(at.getTime())) return null;
  return { at, reason: bar < 0 ? null : s.slice(bar + 1).trim() || null };
}

export type MutedNumber = { phone: string; since: string; reason: string | null };

/** Every number currently muted, newest first — the Replies tab's un-mute fold
 *  (a mute nobody can see is a mute nobody can undo). */
export async function mutedNumbers(): Promise<MutedNumber[]> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: "comms-mute:" } },
    select: { key: true, value: true },
  });
  return rows
    .map((r) => {
      const v = parseAckValue(r.value);
      return v ? { phone: r.key.slice("comms-mute:".length), since: v.at.toISOString(), reason: v.reason } : null;
    })
    .filter((m): m is MutedNumber => !!m)
    .sort((a, b) => (a.since < b.since ? 1 : -1));
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

// Bulk mail and cold pitches from a MATCHED sender — the two regexes above
// judge the subject and the sender label, and on Sep 8 2026 both let through
// the rows that made Kyle's "7 clients waiting on a reply" (and its red
// "oldest has waited 7 days") wrong: Natalie Curry's "September Happenings"
// newsletter (an agent we shot for once, blasting her list) and a "Job
// proposal" from Growwtech Images (an outsourcing pitch the router filed
// under Jeff Scott). Gmail would say so with List-Unsubscribe / Precedence:
// bulk, but CommLog keeps no headers, and logComm's 6,000-char body cap can
// cut a newsletter off above its unsubscribe footer (Natalie's was exactly
// 6,000 chars). So this reads the SHAPE of the mail instead:
//   · mass-mail tooling artifacts — a "View in browser" link, the run of
//     invisible U+034F / zero-width padding Mailchimp and friends put in the
//     preheader — which no human types;
//   · an unsubscribe / preferences / "you are receiving this" footer, unless
//     the sender's own words ask something (a client forwarding a newsletter
//     with "can we do this?" on top keeps her row);
//   · a cold pitch: an impersonal opener ("Hello Team," / "Dear Sir/Madam")
//     plus three or more sales tells (a price list in USD, "our portfolio",
//     "trial project", PayPal, "we are professional ... editors").
// Conservative on purpose, the same trade isCourtesy makes: a false "needs an
// answer" costs Kyle a click, a false "bulk" costs a client.
const BULK_TOOLING_RE = /\bview (?:this (?:e-?mail )?)?in (?:your |a )?browser\b/i;
const PREHEADER_PAD_RE = /(?:[\u034F\u200B\u200C\u200D\u2007\u00AD\uFEFF]\s*){12,}/;
const BULK_FOOTER_RE =
  /\b(?:unsubscribe|opt[- ]?out|manage (?:your )?(?:e-?mail )?preferences|update your preferences|e-?mail preferences|you(?:'re| are) receiving this (?:e-?mail|message)|why did i get this|this (?:e-?mail|message) was sent to|thanks for (?:reading|subscribing))\b/i;
const PITCH_OPENER_RE = /^\s*(?:hello|hi|hey|dear|greetings)[\s,!]+(?:team|there|sir|madam|sir\/madam|sir or madam|business owner|owner|realtor|partner|friend)\b/i;
const PITCH_TELLS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s?usd\b|\busd\s?\d/i, // a price list quoted in a currency code
  /\bper (?:image|photo|picture|edit)\b/i,
  /\bour (?:portfolio|services|best price|pricing|rates|price list|team of)\b/i,
  /\b(?:free )?trial (?:project|images?|photos?|edits?)\b|\bfree trial\b/i,
  /\bpaypal\b/i,
  /\bwe(?:'re| are) (?:a |an )?(?:professional|team|company|leading)\b/i,
  /\boutsourc/i,
  /\bsatisfaction (?:is )?guaranteed\b/i,
];

/** Newsletter, marketing blast, or cold vendor pitch — nobody is waiting on
 *  us. `raw` is the stored body (footers live below the quoted history the
 *  cleaner strips); `ownWords` is the cleaned message. */
export function isBulkEmail(raw: string, ownWords: string): boolean {
  if (BULK_TOOLING_RE.test(raw) || PREHEADER_PAD_RE.test(raw)) return true;
  if (BULK_FOOTER_RE.test(raw) && !ownWords.includes("?")) return true;
  if (PITCH_OPENER_RE.test(ownWords) && PITCH_TELLS.filter((re) => re.test(ownWords)).length >= 3) return true;
  return false;
}

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
  /** the reply to-do this clears, when there is one. For an unmatched number
   *  that is the `lead` task the receiver filed — the triage path an inquiry
   *  from a stranger has always had, now actually joined to its conversation. */
  openTaskId: string | null;
  /** TRUE when this row came from the OBLIGATION LEDGER rather than from the
   *  message window: the request is still open, but the conversation behind it
   *  has paginated out of the inbox read. The card should say so — there is no
   *  scrollback here, just the message the obligation was raised on. */
  fromLedger?: boolean;
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
  /** Add the OBLIGATION LEDGER: requests the hub wrote down and nobody has
   *  resolved, whose conversation has since left the message window entirely.
   *
   *  DEFAULT FALSE, and the default is the point. The BOARDS opt in — a work
   *  item must not vanish from a list of work. The 5-minute SLA PAGER does not:
   *  commsSla.ts already keeps its own 7-day scan "so widening what the BOARDS
   *  reach back to can never silently start paging people about three-week-old
   *  messages", and a row that arrives here with a months-old timestamp would
   *  mint a brand-new dedupe key and wake somebody about it. Persisting an
   *  obligation is a visibility change; it must never become an alerting one. */
  includeOwed?: boolean;
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

/** A sender LABEL that is really a phone number — "(267) 900-8794" — back to
 *  its 10-digit key, or null for an actual name.
 *
 *  Not cosmetic. The OpenPhone receiver logs an unmatched inbound CALL with the
 *  number only in `contactName` and `fromPhone` left NULL
 *  (src/app/api/webhooks/openphone/route.ts, the `if (!match …)` lead path), so
 *  on 2026-09-18 the live Replies tab carried a row keyed `n:(267) 900-8794`
 *  with phone=null: nobody could text it back, and it could not be joined to
 *  the OPEN `lead-2679008794` to-do the same webhook had just filed. The row
 *  would have aged out in seven days with the obligation still open on another
 *  tab — exactly the loss this audit is about. Letters disqualify the string
 *  outright, so a real name is never mistaken for a number. */
function nameAsPhone(name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  if (!s || /[a-z]/i.test(s)) return null;
  const k = phoneKey(s);
  return k.length === 10 ? k : null;
}

/** `<last>|<first>` from a display name, or the bare address / client id.
 *  Module scope rather than a closure inside the walk because the obligation
 *  ledger (below) has to derive the SAME email thread key from a stored task,
 *  long after the messages that made it have left the window. */
function emailKeyOf(contactName: string | null, clientId: string | null): string | null {
  const rawName = (contactName ?? "").split(/,|\s[-–—|]\s/)[0];
  // A bare address ("info@agency.com") keys on the address itself.
  if (rawName.includes("@")) return rawName.trim().toLowerCase();
  const name = rawName.trim().toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return clientId ? `client:${clientId}` : null;
  const parts = name.split(" ");
  if (parts.length < 2) return name;
  return `${parts[parts.length - 1]}|${parts[0]}`;
}

/** Labels the receivers stamp on our own outgoing messages. */
const OUR_LABELS = new Set(["us", "realtour pilot", "realtour pilot, llc"]);

// ---------------------------------------------------------------------------
// THE OBLIGATION LEDGER — an unresolved request outlives the message window.
//
// (audit R07, Sep 18.) The Sep 17 widening above had the right instinct and the
// wrong mechanism. It reaches past the window for a client who already has an
// open reply to-do — but it is still a read of MESSAGES, so it inherits
// messages' bounds, and it can only see a thread whose obligation happens to be
// filed against a client record. Three ways a live request still disappears:
//
//   · it is older than OWED_LOOKBACK_DAYS (45);
//   · the account is busy enough that OWED_SCAN_CAP (600) newer rows sit on top
//     of the question, so the scan never reaches it;
//   · it came from a number we never matched, so there is no client to key the
//     lookback on at all.
//
// The answer is NOT a wider window. That was measured (see WINDOW_DAYS): at 21
// days the email board went from 5 rows to 17, and the twelve extra were
// out-of-office replies, an Instagram download notice, forwarded vendor pitches
// and three-week-old threads dealt with outside the hub. A board that is mostly
// noise is one Kyle stops trusting.
//
// So the OBLIGATION persists, not the window. The hub already writes one down
// the moment it decides we owe an answer: an open `client_reply` task for a
// client we know, an open `lead` task for a stranger (the OpenPhone receiver's
// upsertPhoneLeadTask, google.ts's `lead-<email>`). That row is STATE, not a
// rolling read — it has an owner, a next action, a follow-up date and its own
// copy of the message that raised it. `openObligations()` reads it with no
// window and no row cap, and fetches exactly ONE message per obligation, the
// last inbound still owed an answer. The work item is what persists; the
// message history paginates independently of it, wherever a human goes to read
// it (the client page, the Inbox).
//
// The twelve noise rows never had a task. Nobody chose them, so they stay out
// at 21 days and at 60 — that distinction is the whole reason this is a ledger
// and not a bigger number.
// ---------------------------------------------------------------------------

/** The task types that ARE an unanswered obligation. `client_reply` is the
 *  known-client ask; `lead` is the same promise for someone we have no record
 *  of — the triage path an unmatched inquiry has always had (it lands on the
 *  Board/Other tab), which nothing ever joined back to the conversation. */
const OBLIGATION_TYPES = ["client_reply", "lead"] as const;

/** How many recent inbound rows the ledger reads across ALL obligations to find
 *  each one's last real message. When this cap bites for a thread we do not
 *  lose the obligation — we fall back to the copy of the message the task
 *  itself carries. It is the only bound in here, and it can cost detail, never
 *  a row. (The task read below has NO cap on purpose: a cap on the ledger is a
 *  cap on what can be remembered. Measured on live data 2026-09-18 — 5 open
 *  client_reply/lead rows in total, so the read is small by nature.) */
const OBLIGATION_INBOUND_SCAN = 2000;

export type Obligation = {
  taskId: string;
  kind: "client_reply" | "lead";
  family: WaitingFamily;
  /** the WaitingThread key this belongs to, so a surface can join the two */
  threadKey: string;
  clientId: string | null;
  displayName: string;
  /** 10-digit key, when the obligation is a phone conversation */
  phone: string | null;
  ownerId: string | null;
  /** the next action, in words — the task's own title */
  nextAction: string;
  /** when the hub wrote the obligation down */
  raisedAt: Date;
  /** the last inbound message still owed an answer, and where it came from */
  lastInboundAt: Date;
  lastInboundText: string;
  lastInboundChannel: WaitingMessage["channel"];
  /** SmartTask.followUpAt — when to chase it again. Distinct from dueAt, which
   *  is the original "reply within 4 hours" clock and is long gone. */
  followUpAt: Date | null;
  /** SmartTask.blockedReason — why it is parked, in a sentence */
  blockedReason: string | null;
  daysWaiting: number;
  /** true when the conversation is older than `windowDays`, i.e. this row
   *  exists ONLY because the obligation was written down */
  beyondWindow: boolean;
};

/** The obligation's thread identity, derived from the stored task alone.
 *  Returns null for a task that is not an unanswered conversation at all (the
 *  Smart Brain's internal notes used to be filed as `client_reply`). */
function obligationThread(t: {
  taskType: string;
  source: string;
  dedupeKey: string | null;
  clientId: string | null;
  contactName: string | null;
}): { family: WaitingFamily; threadKey: string; phone: string | null } | null {
  if (t.taskType === "lead") {
    // The receivers key a lead by its sender: `lead-<10 digits>` from the phone
    // line, `lead-<address>` from Gmail. That key IS the conversation.
    const m = /^lead-(.+)$/.exec(t.dedupeKey ?? "");
    if (!m) return null;
    const who = m[1];
    if (/^\d{10}$/.test(who)) return { family: "phone", threadKey: `p:${who}`, phone: who };
    if (who.includes("@")) return { family: "email", threadKey: `e:${who.toLowerCase()}`, phone: null };
    return null;
  }
  if (!t.clientId) return null; // a client ask with no client is not a thread
  // The walk keys a client's texts by the client record and their mail by the
  // SENDER. `source` is the only thing on the task that says which lane it was
  // born in (createCommTask stamps "gmail" for mail, "openphone" otherwise).
  if (t.source === "gmail") {
    const g = emailKeyOf(t.contactName, t.clientId) ?? `client:${t.clientId}`;
    return { family: "email", threadKey: `e:${g}`, phone: null };
  }
  return { family: "phone", threadKey: `c:${t.clientId}`, phone: null };
}

/**
 * A CALL THAT NOBODY ANSWERED IS NOT AN ANSWER (review, Sep 18).
 *
 * OpenPhone logs an outbound attempt as a `call` row like any other, and the
 * live walk has always known the difference — an ANSWERED outbound call is a
 * real reply (Jordan kept getting "still unanswered" pages two hours after
 * handling something by phone), a missed one is not. The persistent ledger
 * below did not: its outbound aggregate took the newest outbound row of any
 * kind, so one unsuccessful callback made an old unanswered text disappear off
 * the communications board while the task itself stayed open and invisible.
 *
 * The words live here so the two paths cannot drift. They are matched in SQL by
 * the aggregate and in JavaScript by the walk, which is the same rule twice
 * rather than two rules — `outboundIsAnswer` is the arbiter and the SQL is
 * built from the same list.
 */
const UNANSWERED_CALL_WORDS = ["missed", "no answer", "unanswered"] as const;

/** Did this outbound row actually answer anybody? Pure, and the only place the
 *  question is decided. */
export function outboundIsAnswer(r: { channel: string; source: string | null; body: string | null }): boolean {
  if ((r.source ?? "").startsWith("auto-")) return false; // our robots
  if (isHubSmsSource(r.source) || isHubSms(r.body)) return false; // the hub's own staff texts
  if (r.channel === "call" && UNANSWERED_CALL_WORDS.some((w) => (r.body ?? "").toLowerCase().includes(w))) return false;
  return true;
}

/**
 * Every request the hub wrote down and nobody has resolved — read from the
 * ledger, with no message window and no row cap.
 *
 * "Resolved" means one of the things a PERSON does: completing or cancelling
 * the task, ticking the thread handled, muting the number as spam, or actually
 * answering. Nothing here ages out, and nothing here is closed by a robot: the
 * "have we answered since?" test ignores our own automated sends (`auto-*`) and
 * hub staff texts, because an automated acknowledgement answers nobody's
 * question — the same rule the walk applies to a live thread, applied to the
 * obligation so it cannot be lost the other way round.
 */
export async function openObligations(
  opts: { now?: Date; families?: WaitingFamily[]; windowDays?: number } = {},
): Promise<Obligation[]> {
  const now = opts.now ?? new Date();
  const families = opts.families ?? (["phone", "email"] as WaitingFamily[]);
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  const tasks = await prisma.smartTask.findMany({
    where: { taskType: { in: [...OBLIGATION_TYPES] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: {
      id: true, taskType: true, title: true, summary: true, description: true, source: true,
      dedupeKey: true, clientId: true, contactName: true, createdAt: true, ownerId: true,
      followUpAt: true, blockedReason: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  type TaskRow = (typeof tasks)[number];
  const filed: { t: TaskRow; family: WaitingFamily; threadKey: string; phone: string | null }[] = [];
  for (const t of tasks) {
    const id = obligationThread(t);
    if (!id || !families.includes(id.family)) continue;
    filed.push({ t, ...id });
  }
  if (filed.length === 0) return [];

  const clientIds = [...new Set(filed.map((f) => f.t.clientId).filter((c): c is string => !!c))];
  const phones = [...new Set(filed.map((f) => f.phone).filter((p): p is string => !!p))];
  const channels = [
    ...(families.includes("phone") ? ["text", "call"] : []),
    ...(families.includes("email") ? ["email"] : []),
  ];
  // OUR OWN ROBOTS ARE NOT AN ANSWER. `auto-*` is every automated client text
  // (confirmation, delivery, after-hours, welcome); HUB_SMS_SOURCES is the
  // staff-side equivalent. Excluding them in SQL is what makes "have we replied
  // since?" mean a PERSON replied since.
  const substantiveOut = {
    direction: "out",
    channel: { in: channels },
    source: { notIn: [...HUB_SMS_SOURCES, HUB_REPLY_SOURCE] },
    NOT: {
      OR: [
        { source: { startsWith: "auto-" } },
        // The hub's own staff texts, recognised by their body as well as their
        // source: a "⚙️ RealTour Hub:" line logged under somebody's own number
        // is not that person answering (outboundIsAnswer says the same).
        { body: { startsWith: HUB_SMS_PREFIX } },
        // AND THE UNSUCCESSFUL CALL. This is the reopened defect: without it a
        // later missed callback counted as the answer to a text from a week
        // ago, and the obligation vanished from the board without anybody
        // having spoken to the client.
        ...UNANSWERED_CALL_WORDS.map((w) => ({ channel: "call", body: { contains: w, mode: "insensitive" as const } })),
      ],
    },
  };
  // A stranger's CALL rows carry the number in `contactName` and nothing in
  // `fromPhone` (see nameAsPhone). Matching on both is what lets a lead
  // obligation find its own missed call.
  const pretty = phones.map(fmtPhone);
  const onPhone = { OR: [{ fromPhone: { in: phones } }, { contactName: { in: pretty } }] };

  const [inMaxByClient, inMaxByPhone, outMaxByClient, outMaxByPhone, recent] = await Promise.all([
    clientIds.length
      ? prisma.commLog.groupBy({
          by: ["clientId"],
          where: { clientId: { in: clientIds }, direction: "in", channel: { in: channels } },
          _max: { occurredAt: true },
        })
      : Promise.resolve([] as { clientId: string | null; _max: { occurredAt: Date | null } }[]),
    phones.length
      ? prisma.commLog.groupBy({
          by: ["fromPhone", "contactName"],
          where: { ...onPhone, direction: "in", channel: { in: channels } },
          _max: { occurredAt: true },
        })
      : Promise.resolve([] as { fromPhone: string | null; contactName: string | null; _max: { occurredAt: Date | null } }[]),
    clientIds.length
      ? prisma.commLog.groupBy({
          // BY CHANNEL TOO (check, Sep 18). Grouped on clientId alone, ONE
          // unrelated email we sent marked a sixty-day-old TEXT question
          // answered — the two lanes are different conversations with different
          // people in them, and an obligation is only settled by a reply on the
          // lane it was raised on.
          by: ["clientId", "channel"],
          where: { clientId: { in: clientIds }, ...substantiveOut },
          _max: { occurredAt: true },
        })
      : Promise.resolve([] as { clientId: string | null; channel: string; _max: { occurredAt: Date | null } }[]),
    phones.length
      ? prisma.commLog.groupBy({
          by: ["fromPhone", "contactName"],
          where: { ...onPhone, ...substantiveOut },
          _max: { occurredAt: true },
        })
      : Promise.resolve([] as { fromPhone: string | null; contactName: string | null; _max: { occurredAt: Date | null } }[]),
    // ONE bounded read for the message each obligation is actually waiting on.
    // Bounded because it is a render path; safe because when the bound bites we
    // fall back to the task's own copy of the message rather than dropping the
    // row (a cap that can only cost detail, never the obligation).
    prisma.commLog.findMany({
      where: {
        direction: "in",
        channel: { in: channels },
        OR: [
          ...(clientIds.length ? [{ clientId: { in: clientIds } }] : []),
          ...(phones.length ? onPhone.OR : []),
        ],
      },
      orderBy: { occurredAt: "desc" },
      take: OBLIGATION_INBOUND_SCAN,
      select: { clientId: true, fromPhone: true, contactName: true, channel: true, subject: true, body: true, occurredAt: true, source: true },
    }),
  ]);

  /** Prisma types a groupBy row by the selected aggregate, which no shared
   *  helper can name generically — one narrow cast, in one place. */
  type MaxRow = { clientId?: string | null; fromPhone?: string | null; contactName?: string | null; _max?: { occurredAt?: Date | null } };
  /** `clientId` reads straight off the row; a phone row may carry its number in
   *  either column, and the LATEST of the two wins. */
  const maxOf = (rows: unknown[], field: "clientId" | "phone"): Map<string, Date> => {
    const m = new Map<string, Date>();
    for (const r of rows as MaxRow[]) {
      const at = r._max?.occurredAt;
      if (!at) continue;
      const k = field === "clientId" ? r.clientId : r.fromPhone || nameAsPhone(r.contactName);
      if (!k) continue;
      if ((m.get(k) ?? new Date(0)) < at) m.set(k, at);
    }
    return m;
  };
  const lastInClient = maxOf(inMaxByClient, "clientId");
  const lastInPhone = maxOf(inMaxByPhone, "phone");
  // Keyed "<clientId>|<family>", so a reply on one lane cannot answer for the
  // other. The channel vocabulary is the same one familyOf uses everywhere else
  // in this file: text and call are the phone lane, email is its own.
  const lastOutClient = new Map<string, Date>();
  for (const r of outMaxByClient as { clientId: string | null; channel: string; _max: { occurredAt: Date | null } }[]) {
    const at = r._max?.occurredAt;
    if (!at || !r.clientId) continue;
    const key = `${r.clientId}|${r.channel === "email" ? "email" : "phone"}`;
    if ((lastOutClient.get(key) ?? new Date(0)) < at) lastOutClient.set(key, at);
  }
  const lastOutPhone = maxOf(outMaxByPhone, "phone");

  // The newest inbound per thread that actually ASKS something — the same
  // noise/courtesy rules the live walk applies, so the ledger and the board can
  // never disagree about what counts as a message.
  type Msg = { channel: string; subject: string | null; body: string; at: Date };
  const bestByClient = new Map<string, Msg>();
  const bestByPhone = new Map<string, Msg>();
  for (const r of recent) {
    if (r.source === HUB_REPLY_SOURCE) continue;
    let body: string;
    if (r.channel === "call") {
      if (!/missed|voicemail|no answer/i.test(r.body ?? "")) continue;
      body = /voicemail/i.test(r.body ?? "") ? "Voicemail — call them back" : "Missed call — call them back";
    } else if (r.channel === "email") {
      if (EMAIL_NOISE_SUBJECT.test(r.subject ?? "") || EMAIL_NOISE_SENDER.test(r.contactName ?? "")) continue;
      body = cleanEmailBody(r.body ?? "");
      if (isBulkEmail(r.body ?? "", body)) continue;
      if (!body) body = (r.subject ?? "").trim();
      if (isNoise(body) && !/\?/.test(r.subject ?? "")) continue;
      if (isCourtesy(body) && !/\?/.test(r.subject ?? "")) continue;
    } else {
      if (isNoise(r.body)) continue;
      body = (r.body ?? "").trim();
      if (isCourtesy(body)) continue;
    }
    const m: Msg = { channel: r.channel, subject: r.subject, body, at: r.occurredAt };
    // `recent` is newest-first, so the FIRST survivor per thread is the one.
    if (r.clientId && !bestByClient.has(r.clientId)) bestByClient.set(r.clientId, m);
    const rp = r.fromPhone || nameAsPhone(r.contactName);
    if (rp && !bestByPhone.has(rp)) bestByPhone.set(rp, m);
  }

  // Human exits that end an obligation without an answer: the thread tick and
  // the spam mute. Both are CUT POINTS, exactly as they are for a live thread.
  const [acks, mutes] = await Promise.all([
    prisma.appSetting.findMany({
      where: { key: { in: [...new Set(filed.map((f) => threadAckKey(f.family, f.threadKey)))] } },
      select: { key: true, value: true },
    }),
    phones.length
      ? prisma.appSetting.findMany({ where: { key: { in: phones.map(commsMuteKey) } }, select: { key: true, value: true } })
      : Promise.resolve([] as { key: string; value: string }[]),
  ]);
  const ackAt = new Map<string, Date>();
  for (const a of acks) {
    const v = parseAckValue(a.value);
    if (v) ackAt.set(a.key, v.at);
  }
  const muted = new Set(mutes.filter((m) => parseAckValue(m.value)).map((m) => m.key.slice("comms-mute:".length)));

  const out: Obligation[] = [];
  for (const f of filed) {
    const { t, family, threadKey, phone } = f;
    if (phone && muted.has(phone)) continue; // spam, muted until someone un-mutes

    // WHEN did they last write? The groupBy is exact and unbounded, so this is
    // the true age even when the scan above could not reach the row.
    const lastIn = (t.clientId ? lastInClient.get(t.clientId) : undefined) ?? (phone ? lastInPhone.get(phone) : undefined);
    // NOTHING INBOUND AT ALL = NOT AN OBLIGATION. The Smart Brain used to file
    // its own to-dos as `client_reply` ("Note builder relationship context and
    // brief team for shoot", Erica Walker, Sep 1) and those never close. They
    // are real work, they live on the board — but nobody is waiting on a reply,
    // and resurrecting them here would put an internal note on the comms board
    // forever.
    if (!lastIn) continue;

    const best = (t.clientId ? bestByClient.get(t.clientId) : undefined) ?? (phone ? bestByPhone.get(phone) : undefined);
    // WHAT ARE WE MEASURING FROM? The newest inbound that actually asks
    // something, when the scan reached it — otherwise the moment the hub wrote
    // the obligation down, which is within seconds of the message either way.
    //
    // Deliberately NOT `lastIn`: that is the newest inbound of ANY kind. A
    // client who asked, got answered, and wrote "Thanks so much!!" has a
    // `lastIn` newer than our reply, and keying on it would hold a settled
    // conversation open forever on a task nobody remembered to close — the
    // courtesy rule (rule 3 at the top of this file) applied to the ledger.
    const refAt = best?.at ?? t.createdAt;
    const text =
      best?.body ||
      (t.description ?? "").split(/\n\n— /)[0].trim() ||
      t.summary ||
      t.title;

    // Has a PERSON answered since? (`substantiveOut` already dropped our
    // robots.) If so the obligation is stale, not owed — leave it on the board
    // as a task and keep it off the comms queue.
    const lastOut = (t.clientId ? lastOutClient.get(`${t.clientId}|${family}`) : undefined) ?? (phone ? lastOutPhone.get(phone) : undefined);
    if (lastOut && lastOut >= refAt) continue;

    // Ticked handled by hand, after the message — an explicit resolution.
    const ack = ackAt.get(threadAckKey(family, threadKey));
    if (ack && ack >= refAt) continue;

    out.push({
      taskId: t.id,
      kind: t.taskType === "lead" ? "lead" : "client_reply",
      family,
      threadKey,
      clientId: t.clientId,
      displayName: t.client?.name || t.contactName || (phone ? fmtPhone(phone) : t.title),
      phone,
      ownerId: t.ownerId,
      nextAction: t.title,
      raisedAt: t.createdAt,
      lastInboundAt: refAt,
      lastInboundText: text,
      lastInboundChannel: (best?.channel === "call" ? "call" : best?.channel === "email" ? "email" : family === "email" ? "email" : "text"),
      followUpAt: t.followUpAt,
      blockedReason: t.blockedReason,
      daysWaiting: Math.max(0, Math.floor((now.getTime() - refAt.getTime()) / 86_400_000)),
      beyondWindow: refAt < windowStart,
    });
  }
  // Longest wait first — the same order every other comms surface uses.
  return out.sort((a, b) => a.lastInboundAt.getTime() - b.lastInboundAt.getTime());
}

/**
 * The ledger's contribution to the one list: obligations whose conversation has
 * left the message window, as threads.
 *
 * Only the ones the walk could not produce. A thread already on the board is
 * the richer row — real messages, real history — and is left alone; this adds
 * back the requests that are still open with nothing left to see. Matching is
 * on the CLIENT within the family rather than on the thread key, because email
 * group keys are re-derived from whichever name variant the window happened to
 * carry, and a key that drifted by one initial would print the same
 * conversation twice.
 */
async function ledgerThreads(
  shown: WaitingThread[],
  o: { now: Date; families: WaitingFamily[]; windowDays: number; includeUnmatched: boolean; includeTeam: boolean },
): Promise<WaitingThread[]> {
  const ledger = await openObligations({ now: o.now, families: o.families, windowDays: o.windowDays });
  if (ledger.length === 0) return [];
  const shownKeys = new Set(shown.map((t) => t.key));
  const shownClients = new Set(shown.map((t) => `${t.family}:${t.clientId ?? ""}`));
  const keep = ledger.filter(
    (x) =>
      !shownKeys.has(x.threadKey) &&
      !(x.clientId && shownClients.has(`${x.family}:${x.clientId}`)) &&
      (x.clientId || o.includeUnmatched) &&
      // UNMATCHED EMAIL STAYS OUT OF THIS WALK, as it always has (`keyFor`
      // refuses it: "unmatched email is newsletters, not people"). An emailed
      // lead's obligation is real and lives on the tasks board where it was
      // filed; injecting it here would make replyWaitingSummary's email count
      // disagree with the email board, which filters unmatched out — the exact
      // class of disagreement this module exists to end.
      (x.family !== "email" || !!x.clientId),
  );
  if (keep.length === 0) return [];

  const ids = [...new Set(keep.map((x) => x.clientId).filter((c): c is string => !!c))];
  const [clients, team] = await Promise.all([
    ids.length
      ? prisma.client.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, segment: true, socialClient: true, socialPlan: true, parent: { select: { segment: true } } },
        })
      : Promise.resolve([] as { id: string; name: string; segment: string | null; socialClient: boolean; socialPlan: string | null; parent: { segment: string | null } | null }[]),
    prisma.teamMember.findMany({ select: { phone: true } }),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const teamPhones = new Set(team.map((t) => phoneKey(t.phone)).filter((k) => k.length === 10));

  const out: WaitingThread[] = [];
  for (const x of keep) {
    // A teammate's number never becomes a lead (the receiver refuses to file
    // one), so this should never fire — but the flag stays honest either way.
    const isTeam = !x.clientId && !!(x.phone && teamPhones.has(x.phone));
    if (isTeam && !o.includeTeam) continue;
    const client = x.clientId ? clientById.get(x.clientId) : undefined;
    out.push({
      key: x.threadKey,
      family: x.family,
      groupKey: x.threadKey.slice(2),
      clientId: x.clientId,
      clientIds: x.clientId ? [x.clientId] : [],
      clientName: client?.name ?? (x.clientId ? x.displayName : null),
      contactName: x.clientId ? null : x.displayName,
      displayName: client?.name ?? x.displayName,
      phone: x.phone,
      isClient: !!x.clientId,
      isTeam,
      isVip: VIP_SEGMENTS.has(client?.segment ?? "") || VIP_SEGMENTS.has(client?.parent?.segment ?? ""),
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? client?.socialPlan ?? "yes" : null,
      propertyAddress: null,
      projectId: null,
      pending: [{ channel: x.lastInboundChannel, subject: null, body: x.lastInboundText, at: x.lastInboundAt }],
      courtesy: [],
      courtesyOnly: false,
      waitingSince: x.lastInboundAt,
      hoursWaiting: Math.max(0, Math.round((o.now.getTime() - x.lastInboundAt.getTime()) / 3_600_000)),
      // ONE turn, not a transcript. The history is deliberately NOT pulled into
      // the work item: drafting context assembled from a months-old thread is
      // worse than none, and the conversation itself is one click away on the
      // client page. The obligation persists; the history paginates separately.
      turns: [{ role: "client", text: x.lastInboundText, at: x.lastInboundAt.toISOString() }],
      openTaskId: x.taskId,
      fromLedger: true,
    });
  }
  return out;
}

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
  const ROW_SELECT = {
    channel: true, direction: true, clientId: true, clientName: true, contactName: true,
    fromPhone: true, projectId: true, subject: true, body: true, occurredAt: true, source: true,
  } as const;
  const roleGate = opts.minRoles ? { minRole: { in: opts.minRoles } } : {};
  // Clients we have already written down that we owe an answer to. Read before
  // the window so their threads can be fetched past it — see OWED_LOOKBACK_DAYS.
  const owedClientIds = [
    ...new Set(
      (
        await prisma.smartTask.findMany({
          where: { taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] }, clientId: { not: null } },
          select: { clientId: true },
        })
      )
        .map((t) => t.clientId)
        .filter((id): id is string => !!id),
    ),
  ];
  // Newest-first with a cap, then reversed: the walk needs time order, but a
  // blown-out window must drop the OLDEST rows, never the live ones.
  const [fresh, owed] = await Promise.all([
    prisma.commLog.findMany({
      where: { channel: { in: channels }, occurredAt: { gte: since }, ...roleGate },
      orderBy: { occurredAt: "desc" },
      take: SCAN_CAP,
      select: ROW_SELECT,
    }),
    owedClientIds.length
      ? prisma.commLog.findMany({
          where: {
            channel: { in: channels },
            clientId: { in: owedClientIds },
            occurredAt: { lt: since, gte: new Date(now.getTime() - OWED_LOOKBACK_DAYS * 86_400_000) },
            ...roleGate,
          },
          orderBy: { occurredAt: "desc" },
          take: OWED_SCAN_CAP,
          select: ROW_SELECT,
        })
      : Promise.resolve([] as Row[]),
  ]);
  // One time-ordered walk over both reads. The older rows only ever ADD history
  // to a thread the queue would otherwise have started mid-conversation.
  const rows: Row[] = [...fresh, ...owed].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  // AN EMPTY WINDOW IS NOT AN EMPTY QUEUE. Both of this function's early exits
  // now go through the ledger: the 60-day-old request is precisely the case
  // where the window returns nothing, and returning [] here is how it used to
  // disappear (audit R07).
  if (rows.length === 0) {
    return opts.includeOwed
      ? await ledgerThreads([], { now, families, windowDays, includeUnmatched, includeTeam })
      : [];
  }

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
    const p = phoneOf(r) ?? nameAsPhone(r.contactName);
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
      // A reply WE sent, pulled back out of Gmail's Sent folder (Sep 16,
      // google.ts): the row is stamped "Us", so the two group keys above are
      // our own label, not the person we wrote to. The THREAD is what tells us
      // who we answered — the sent row carries the subject we replied under,
      // and Gmail's own "Re:" chain is the only handle on the recipient that
      // survives the "Us" stamp.
      //
      // Scoped by that subject, NOT by the client record (review). A
      // client-wide kill would clear Arielle's genuinely unanswered mail the
      // moment we replied to Matthew on the record they share — and this
      // module's whole doctrine is that a false "handled" costs a client while
      // a false "waiting" costs a glance. The client-wide fallback survives
      // only where it cannot hurt: one email conversation on the record in the
      // window, so there is nobody else it could be. Either way it stays a CUT
      // POINT — a newer inbound on that thread is waiting again.
      if (r.source === GMAIL_SENT_SOURCE && r.clientId) {
        const cid = r.clientId;
        const onRecord = [...buckets.entries()].filter(([, b]) => b.family === "email" && b.clientIds.includes(cid));
        const thread = threadSubject(r.subject);
        const sameThread = thread
          ? onRecord.filter(([, b]) =>
              b.rows.some((x) => threadSubject(x.subject) === thread) ||
              [...b.pending, ...b.courtesy].some((m) => threadSubject(m.subject) === thread),
            )
          : [];
        const target = sameThread.length > 0 ? sameThread : onRecord.length === 1 ? onRecord : [];
        for (const [k] of target) kill.add(k);
      }
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
      // ONE RULE, SHARED WITH THE LEDGER (review, Sep 18). Automated
      // confirmation/delivery texts answer nothing; nor do the hub's own staff
      // texts — a "⚙️ RealTour Hub:" line (its echo was logged as "Us" → the
      // teammate until Sep 11) or an upload-page chaser on the teammate's own
      // number, which used to make a payday notice read as Kyle answering
      // Jordan; nor does a missed outgoing call, though an ANSWERED one is a
      // real reply. openObligations applies the same predicate in SQL.
      if (!outboundIsAnswer(r)) continue;
      clearFor(r, id.key, ours);
      continue;
    }

    // The owner answering a hub text from his pocket ("Approved"): kept in the
    // dialogue above for context, owed nothing by the office (Sep 11).
    if (r.source === HUB_REPLY_SOURCE) continue;

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
      if (isBulkEmail(r.body ?? "", body)) continue; // rule 6: a blast, not a person
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
  if (live.length === 0) {
    return opts.includeOwed
      ? await ledgerThreads([], { now, families, windowDays, includeUnmatched, includeTeam })
      : [];
  }
  const allClientIds = [...new Set(live.flatMap((b) => (b.clientId ? [b.clientId] : [])))];

  const ackKeys = [
    ...live
      .filter((b) => b.family === "email" && b.clientId)
      .flatMap((b) => [emailAckKey(b.clientId!, b.groupKey), `comms-ack-email-${b.clientId}`]),
    // The thread-scoped twin (Sep 16) — every row, client record or not.
    ...live.map((b) => threadAckKey(b.family, b.key)),
  ];
  // Muted numbers, read for the phone buckets that could be muted. A client's
  // own thread is never muted (there is no control for it) but the key is
  // checked anyway: whatever wrote it meant it.
  const muteKeys = [
    ...new Set(
      live
        .filter((b) => b.family === "phone")
        .flatMap((b) => [b.phone, b.key.startsWith("p:") ? b.key.slice(2) : null])
        .filter((p): p is string => !!p && p.length === 10)
        .map(commsMuteKey),
    ),
  ];

  // WHERE AN UNMATCHED INQUIRY GOES. A stranger who texts the business line
  // already gets a `lead-<phone>` task (the OpenPhone receiver's
  // upsertPhoneLeadTask) — but nothing ever joined it to the conversation, so
  // the card on the Replies tab showed no to-do, had no owner, and the two
  // could be worked, or forgotten, independently. Same key, same triage path,
  // now actually attached to the row a human is looking at (audit R07).
  const leadKeys = [
    ...new Set(
      live
        .filter((b) => b.family === "phone" && !b.clientId)
        .map((b) => b.phone ?? (b.key.startsWith("p:") ? b.key.slice(2) : null))
        .filter((p): p is string => !!p && p.length === 10)
        .map((p) => `lead-${p}`),
    ),
  ];

  const [handledTasks, emailAcks, mutes, openTasks, clients, leadTasks] = await Promise.all([
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
    muteKeys.length
      ? prisma.appSetting.findMany({ where: { key: { in: muteKeys } }, select: { key: true, value: true } })
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
    leadKeys.length
      ? prisma.smartTask.findMany({
          where: { dedupeKey: { in: leadKeys }, taskType: "lead", status: { notIn: ["COMPLETED", "CANCELLED"] } },
          select: { id: true, dedupeKey: true, propertyAddress: true, projectId: true },
        })
      : Promise.resolve([] as { id: string; dedupeKey: string | null; propertyAddress: string | null; projectId: string | null }[]),
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
    // "<ISO>" (the email ticks written before Sep 16) and "<ISO>|<reason>"
    // (every thread ack) both parse here — one reader, two vintages.
    const v = parseAckValue(a.value);
    if (v) ackByKey.set(a.key, v.at);
  }
  const mutedPhones = new Set<string>();
  for (const m of mutes) {
    if (parseAckValue(m.value)) mutedPhones.add(m.key.slice("comms-mute:".length));
  }
  const openTaskByClient = new Map(openTasks.filter((t) => t.clientId).map((t) => [t.clientId as string, t]));
  const leadTaskByPhone = new Map(
    leadTasks
      .filter((t) => t.dedupeKey)
      .map((t) => [(t.dedupeKey as string).slice("lead-".length), t] as const),
  );
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const out: WaitingThread[] = [];
  for (const b of live) {
    // A MUTED number opens nothing (Sep 16, "spam"). The conversation is still
    // in the Inbox and in comms memory — this drops the ROW, not the history,
    // and the Replies tab's muted fold un-mutes it.
    if (b.family === "phone") {
      const p = b.phone ?? (b.key.startsWith("p:") ? b.key.slice(2) : null);
      if (p && mutedPhones.has(p)) continue;
    }
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
    // The thread-scoped tick (Sep 16) — the ONLY exit an unmatched number, a
    // teammate's status text or a spam blast has. Same cut-point rule.
    const threadAck = ackByKey.get(threadAckKey(b.family, b.key));
    if (threadAck) cut.push(threadAck);
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
    // The client's reply to-do, or — for a number we never matched — the lead
    // task the receiver already filed for it. Either way the card now has a
    // work item behind it that outlives the message window.
    const task =
      (b.clientId ? openTaskByClient.get(b.clientId) : undefined) ??
      (!b.clientId && b.family === "phone"
        ? leadTaskByPhone.get(b.phone ?? (b.key.startsWith("p:") ? b.key.slice(2) : ""))
        : undefined);
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

  if (opts.includeOwed) out.push(...(await ledgerThreads(out, { now, families, windowDays, includeUnmatched, includeTeam })));

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
  /** which lane the Handled/Dismiss tick writes into — the Replies tab is
   *  phone-only today, but the ack key is family-scoped and must say so */
  family: WaitingFamily;
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
  /** TRUE when the row came from the OBLIGATION LEDGER rather than the message
   *  window: still open, but the conversation is older than the seven-day read,
   *  so `turns` is the one message the obligation was raised on. The draft
   *  engine has no thread to work from here — say so rather than inventing one. */
  fromLedger: boolean;
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
    family: t.family,
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
    fromLedger: !!t.fromLedger,
  };
}

export async function replyQueue(): Promise<ReplyQueue> {
  const threads = await unansweredComms({
    families: ["phone"],
    includeCourtesy: true, // the fold below the queue
    minRoles: await viewerRoles(),
    // Same reason as the Comms board (audit R07): an unresolved request is
    // persistent state, and this tab is where an unmatched number — a real
    // prospective client we have no record of — is actually answerable. Its
    // `lead-<phone>` to-do is what carries it past the window, and the card now
    // carries that to-do's id.
    includeOwed: true,
  });
  // OUR OWN TEAM IS NOT A CLIENT WAITING (Kyle's call, Sep 16). Harrison's
  // "Photos uploaded" and James's shoot questions are status texts to the
  // office, not a customer sitting on an unanswered message — and counting
  // them here while the Comms tab and the /ops pill (both includeTeam:false)
  // did not is exactly how the Replies tab came to read "2 waiting" on a
  // morning when no client was waiting at all. They still RENDER, under the
  // same fold as the thank-yous, so Kyle can answer or dismiss them; they are
  // simply never part of the number.
  const waiting = threads.filter((t) => !t.courtesyOnly && !t.isTeam);
  const aside = threads.filter((t) => t.courtesyOnly || t.isTeam);
  const cards = waiting.map(toCard);
  const handled = aside.map(toCard);
  return {
    cards,
    handled,
    clientCount: cards.filter((c) => c.isClient).length,
    teamCount: handled.filter((c) => c.isTeam).length,
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
  // includeTeam:false, same as the Comms board and the /ops pill (Sep 16): a
  // teammate's status text is not a client waiting on a reply, and the badge
  // this feeds has to match the list it links to.
  const threads = await unansweredComms({ includeTeam: false, minRoles: await viewerRoles(), includeOwed: true });
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
