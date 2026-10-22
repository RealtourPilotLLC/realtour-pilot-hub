// ---------------------------------------------------------------------------
// A HOLDING REPLY IS NOT AN ANSWER (Oct 22 2026, comms audit H4). Pure: no
// prisma, no server-only. The reply queue's walk and ledger, the task close
// on our outbound (tasks.closeReplyForOutbound) and the drill read this one
// rule.
//
// Nehemiah Lindo asked to book a premium shoot at 5 Endlich Ave sooner than
// Tuesday. Kyle answered at 10:27 AM "Let me check other options to do it
// sooner, I'll confirm soon", and that line closed the reply task 47 ms later
// and cleared the thread off every comms surface. Nothing has been said since.
// Jeff Scott asked on Oct 12 why his reel's sound runs behind; "Let me check
// on this and I'll let you know!" read as the answer, and his reply task sat
// unassigned and overdue with the conversation off the queue.
//
// A holding line says we owe the answer. So when our last word on a thread is
// one, the thread stays on the reply queue as waiting on us, with a due time
// (holdingReplyDueAt): two hours after the holding line, no later than 6 PM
// ET that business day; one sent before 9 AM is due at 11 AM, one sent after
// 5:30 PM or on a weekend at 11 AM ET the next business day. The pager does
// not ring before it is due.
// ---------------------------------------------------------------------------
import { addBusinessDayKeysET, etAt, etDayKey, etMinutesOfDay, isWeekdayET } from "@/lib/datetime";

/** How long a holding line buys us, in business hours. */
export const HOLDING_DUE_HOURS = 2;
/** Business hours, ET minutes past midnight. */
const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 18 * 60;
/** A holding line sent before the day starts (or after it ends) is due at this ET hour of the next business morning. */
const MORNING_DUE_HOUR = 11;

// We will get back with the answer: "I'll confirm", "we'll let you know",
// "I will check", "we're going to follow up". Not "I'll be there at 9".
const WE_WILL = String.raw`\b(?:i|we)(?:'ll|\s+will|\s+(?:am|are|'m|'re)\s+going\s+to)\s+(?:double[-\s]?)?(?:confirm|check|let\s+you\s+know|get\s+back|circle\s+back|follow\s+up|find\s+out|look\s+into|look\s+in\s+to|update\s+you|keep\s+you\s+(?:posted|updated)|be\s+in\s+touch|reach\s+back|touch\s+base|text\s+you\s+back|email\s+you\s+back|call\s+you\s+back|see\s+what)\b`;
// "Let me check", "lemme check", "let me find out", "let us confirm". Never "let me know".
const LET_ME = String.raw`\b(?:let\s+me|lemme|let\s+us)\s+(?:double[-\s]?)?(?:check|see|confirm|find\s+out|look|ask|verify|get\s+back|circle\s+back|talk\s+to|run\s+(?:it|this|that)\s+by|figure|touch\s+base)\b`;
// "I'm checking with him", "we're looking into it", "still waiting on the editor".
const IN_PROGRESS = String.raw`\b(?:i'm|i\s+am|we're|we\s+are|currently|still)\s+(?:checking|looking\s+into|confirming|finding\s+out|waiting\s+(?:on|to\s+hear|for))\b`;
// "Checking on that now", "Will get back to you", "keep you posted", "give me a minute".
const BARE = String.raw`(?:^|[.!?,]\s*)checking\s+(?:on|with|in\s+on|into|now)\b|\bwill\s+(?:get\s+back|circle\s+back|follow\s+up|keep\s+you\s+posted|let\s+you\s+know|update\s+you)\b|\bwill\s+confirm\s+(?:soon|shortly|asap|later|in\s+a\s+bit|by|once|when)\b|\bget\s+back\s+to\s+you\b|\bkeep\s+you\s+(?:posted|updated)\b|\b(?:give\s+me|gimme|one)\s+(?:a\s+)?(?:sec|second|minute|min|moment)\b|\bhang\s+tight\b|\bbear\s+with\s+(?:me|us)\b`;
const HOLD = new RegExp([WE_WILL, LET_ME, IN_PROGRESS, BARE].join("|"), "i");

// A courtesy offer is not a hold: "I'll let you know if anything changes",
// "we'll reach out if we need anything". Stripped before the test.
const IF_ANYTHING = /\b(?:i'll|we'll|i\s+will|we\s+will|will)\s+(?:let\s+you\s+know|reach\s+out|keep\s+you\s+posted|be\s+in\s+touch|update\s+you)\s+if\s+(?:anything|something|there(?:'s|\s+is|\s+are)|any|we\s+(?:need|have|run))[^.!?]*/gi;
// A definite answer in the same message wins: "You're all set for Thursday at 9,
// I'll let you know when James is on the way." Not after "once" / "when" / "if":
// "I'll let you know once it's confirmed" is still a hold.
const ANSWERED = /(?<!\b(?:once|when|until|after|if|whether|as\s+soon\s+as)\s+)\b(?:you're|you\s+are|it's|it\s+is|we're|we\s+are|everything's|everything\s+is|all)\s+(?:all\s+)?(?:set|confirmed|booked|scheduled)\b/i;

/**
 * Is this outbound a holding line: we said we would come back with the
 * answer, and the answer is still owed? Pure.
 *   · positives: "I'll confirm soon", "I'll let you know", "Let me check",
 *     "lemme check", "Will get back to you", "I'm checking with him",
 *     "Let me find out", "Checking on that now", "I'll circle back";
 *   · negatives: "Thanks, all set", "You're confirmed for Thursday at 9",
 *     "Let me know if you have any questions", "Does Tuesday morning work?",
 *     "I'll let you know if anything changes".
 */
export function isHoldingReply(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (ANSWERED.test(t)) return false;
  return HOLD.test(t.replace(IF_ANYTHING, " "));
}

/**
 * When a holding line sent at `at` is due. Pure.
 *   · on a business day (Mon to Fri ET) between 9 AM and 5:30 PM: two hours
 *     later, but no later than 6 PM ET that day;
 *   · on a business day before 9 AM: 11 AM ET that day;
 *   · after 5:30 PM, or on a weekend: 11 AM ET the next business day.
 */
export function holdingReplyDueAt(at: Date): Date {
  const atMin = etMinutesOfDay(at);
  const day = etDayKey(at);
  if (isWeekdayET(at)) {
    if (atMin < OPEN_MIN) return etAt(day, MORNING_DUE_HOUR);
    if (atMin <= CLOSE_MIN - 30) {
      const due = new Date(at.getTime() + HOLDING_DUE_HOURS * 3_600_000);
      const close = etAt(day, CLOSE_MIN / 60);
      return due <= close ? due : close;
    }
  }
  return etAt(addBusinessDayKeysET(at, 1), MORNING_DUE_HOUR);
}

/** A holding line on a thread, as the comms surfaces carry it. */
export type HoldingLine = { at: Date; text: string; dueAt: Date };

/** The holding line's words, one line, for a card. Pure. */
export function holdingWords(h: { text: string }, max = 120): string {
  const t = h.text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
