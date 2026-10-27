// ---------------------------------------------------------------------------
// WHO A CLIENT-MONTH IS WAITING ON, IN ONE PLAIN LINE (Oct 27 2026).
//
// Jordan, Oct 27 2026, on Monthly Content: "all of these little chips here are
// really, pretty, overwhelming ... make it look much nicer and easy to identify
// where people are at and what they're waiting on." And on Bernadette's month:
// "One session still to book. That's not on us, that's on them."
//
// So every client-month reads as one sentence, "Waiting on Bernadette: answer
// 1 topic, book the October session" or "Waiting on us: approve 1 script",
// built from the items below. programOverview fills the items (it holds every
// fact); this module only words them, so the roster row, the card and the
// client file's Overview say the same thing. Pure: no database, no React.
// ---------------------------------------------------------------------------

export type WaitItem = { key: string; text: string; n: number };
export type Waiting = { them: WaitItem[]; us: WaitItem[] };

/** Every fact the two lists are built from (programOverview fills it per row). */
export type WaitingInput = {
  monthKey: string;
  /** a month that owes nothing (forfeited, skipped, ended, history, dormant) */
  closed: boolean;
  /** a new client before their strategy is in the portal (strategyGate.ts) */
  strategy: "discovery_needed" | "discovery_booked" | "build" | null;
  /** a strategy-call transcript problem only a person can fix */
  callProblem: boolean;
  /** filmed work whose planning links need checking */
  reconcile: boolean;
  /** the client still has to book the strategy call, or choose call vs written */
  callAsk: "book" | "choose" | null;
  answersOwed: number;
  topicsToPick: number;
  strategyToApprove: number;
  scriptsToApprove: number;
  scriptsToWrite: number;
  /** session requests the client sent that nobody has confirmed */
  sessionRequests: number;
  /** filming sessions the client still has to book (no request pending) */
  sessionsToBook: number;
  /** a planned month filming late, in this host month */
  lateHostMonthKey: string | null;
  unverified: number;
  heldUnconfirmed: number;
  /** released cuts waiting on the client's approval in their portal */
  videosToApprove: number;
  /** approved cuts we have to send (no portal seat) */
  videosToSend: number;
  cutsWithClient: number;
  videosInProduction: number;
  /** open client script change requests */
  scriptRequests: number;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10" → "October" */
export const monthNameOf = (key: string): string => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function waitingFor(i: WaitingInput): Waiting {
  const them: WaitItem[] = [];
  const us: WaitItem[] = [];
  if (i.closed) return { them, us };
  const month = monthNameOf(i.monthKey);
  // A new client's month waits on the strategy first: nothing is booked,
  // picked or filmed until it is in their portal (Oct 21 2026).
  if (i.strategy === "discovery_needed") them.push({ key: "book_discovery", text: "book the brand discovery call", n: 1 });
  if (i.strategy === "build") us.push({ key: "build_strategy", text: "build and release the content strategy", n: 1 });
  if (i.strategy) return { them, us };

  if (i.callProblem) us.push({ key: "call_notes", text: "sort out the strategy call notes", n: 1 });
  if (i.reconcile) us.push({ key: "reconcile", text: "check the month's topic links", n: 1 });
  if (i.callAsk === "book") them.push({ key: "book_call", text: "book the strategy call", n: 1 });
  if (i.callAsk === "choose") them.push({ key: "choose_path", text: "choose a strategy call or written planning", n: 1 });
  if (i.answersOwed > 0) them.push({ key: "answers", text: `answer ${plural(i.answersOwed, "topic")}`, n: i.answersOwed });
  if (i.topicsToPick > 0) us.push({ key: "pick_topics", text: `pick ${plural(i.topicsToPick, "topic")}`, n: i.topicsToPick });
  if (i.strategyToApprove > 0) us.push({ key: "approve_strategy", text: "approve the new strategy version", n: i.strategyToApprove });
  if (i.scriptsToApprove > 0) us.push({ key: "approve_scripts", text: `approve ${plural(i.scriptsToApprove, "script")}`, n: i.scriptsToApprove });
  if (i.scriptRequests > 0) us.push({ key: "script_requests", text: `answer ${plural(i.scriptRequests, "script request")}`, n: i.scriptRequests });
  // Scripts not started only once the planning in front of them is done; "write
  // 4 scripts" beside "answer 1 topic" would be noise.
  if (i.scriptsToWrite > 0 && i.answersOwed === 0 && i.topicsToPick === 0 && !i.callAsk) us.push({ key: "write_scripts", text: `write ${plural(i.scriptsToWrite, "script")}`, n: i.scriptsToWrite });
  if (i.sessionRequests > 0) us.push({ key: "confirm_session", text: i.sessionRequests === 1 ? "confirm the session they asked for" : `confirm the ${i.sessionRequests} sessions they asked for`, n: i.sessionRequests });
  if (i.sessionsToBook > 0) {
    const text = i.lateHostMonthKey
      ? `book ${month}'s session (filming in ${monthNameOf(i.lateHostMonthKey)})`
      : i.sessionsToBook === 1 ? `book the ${month} session` : `book ${i.sessionsToBook} ${month} sessions`;
    them.push({ key: "book_session", text, n: i.sessionsToBook });
  }
  if (i.unverified > 0) us.push({ key: "confirm_appointment", text: "confirm the session appointment", n: i.unverified });
  if (i.heldUnconfirmed > 0) us.push({ key: "confirm_filmed", text: "confirm what was filmed", n: i.heldUnconfirmed });
  if (i.videosToApprove > 0) them.push({ key: "approve_videos", text: `approve ${plural(i.videosToApprove, "video")}`, n: i.videosToApprove });
  else if (i.cutsWithClient > 0) them.push({ key: "review_cuts", text: `review ${plural(i.cutsWithClient, "video")}`, n: i.cutsWithClient });
  if (i.videosToSend > 0) us.push({ key: "send_videos", text: `send ${plural(i.videosToSend, "approved video")}`, n: i.videosToSend });
  if (i.videosInProduction > 0) us.push({ key: "finish_videos", text: `finish ${plural(i.videosInProduction, "video")}`, n: i.videosInProduction });
  return { them, us };
}

/**
 * The name the line uses: a person's first name ("Bernadette"), the whole
 * name for a team or business ("The Smith Group").
 */
export function clientCallName(name: string): string {
  const words = name.replace(/\s+/g, " ").trim().split(" ").filter((w) => !/^test$/i.test(w));
  if (words.length === 0) return "the client";
  const business = /^(the|team)$/i.test(words[0]) || words.some((w) => /^(team|group|realty|homes|properties|partners|&|and|llc|inc)$/i.test(w));
  return business ? words.join(" ") : words[0];
}

/** "answer 1 topic, book the October session and approve 2 videos" */
export function joinItems(items: WaitItem[]): string {
  const t = items.map((x) => x.text);
  if (t.length <= 1) return t[0] ?? "";
  return `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
}

export type StatusSide = "them" | "us" | "none" | "closed";
export type StatusLine = {
  side: StatusSide;
  /** "Waiting on Bernadette", "Waiting on us", or where the month is ("Filming Wed, Oct 21") */
  lead: string;
  /** what they are waiting for ("answer 1 topic and book the October session"); empty for none/closed */
  detail: string;
  /** the other side's items as one short clause, or null ("We also need to approve 1 script") */
  also: string | null;
  /** "Waiting on Bernadette: answer 1 topic" — the whole sentence, for titles and drills */
  sentence: string;
};

/** The facts statusLine reads, a narrow slice of programOverview's row. */
export type StatusRowInput = {
  clientName: string;
  waiting: Waiting;
  nextAction: { blocked: "us" | "client" | "nobody"; closed?: boolean; text: string };
};

/**
 * One line per client-month. The side that leads is the next action's side
 * when it has items (so the line agrees with the button), else whichever side
 * has any; a month waiting on nobody says where it is in its own words.
 */
export function statusLine(r: StatusRowInput): StatusLine {
  const name = clientCallName(r.clientName);
  const { them, us } = r.waiting;
  if (r.nextAction.closed && them.length === 0 && us.length === 0) {
    const lead = tidy(r.nextAction.text);
    return { side: "closed", lead, detail: "", also: null, sentence: lead };
  }
  const lead: "them" | "us" | null =
    r.nextAction.blocked === "client" && them.length ? "them"
    : r.nextAction.blocked === "us" && us.length ? "us"
    : us.length ? "us"
    : them.length ? "them"
    : null;
  if (!lead) {
    const text = tidy(r.nextAction.text);
    return { side: "none", lead: text, detail: "", also: null, sentence: text };
  }
  const main = lead === "them" ? them : us;
  const other = lead === "them" ? us : them;
  const head = lead === "them" ? `Waiting on ${name}` : "Waiting on us";
  const detail = joinItems(main);
  const also = other.length ? (lead === "them" ? `We also need to ${joinItems(other)}` : `${name} also needs to ${joinItems(other)}`) : null;
  return { side: lead, lead: head, detail, also, sentence: `${head}: ${detail}` };
}

/** Office words without dashes (house rule): "Paused — no workspace" → "Paused. No workspace". */
function tidy(text: string): string {
  return text.replace(/\s+[—–]\s+/g, ". ").replace(/\s+/g, " ").trim();
}

/**
 * THE BOOKING REMINDER LINE (Oct 27 2026, Jordan: "if it's not scheduled, they
 * need to be emailed automatically, daily until they do schedule their
 * session"). Read from the reminder ledger only: it says what was actually
 * sent, never what should have been.
 */
export function bookingReminderLine(
  c: { lastBookingSentAt: Date | null; snoozedUntil: Date | null },
  now: Date,
): { text: string; tone: "quiet" | "attention" } {
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  if (c.snoozedUntil && c.snoozedUntil > now) return { text: `Booking reminders paused until ${day(c.snoozedUntil)}`, tone: "quiet" };
  if (!c.lastBookingSentAt) return { text: "No booking reminder sent yet", tone: "attention" };
  // Weekdays only, so a Friday send is still "daily" on Monday.
  const fresh = now.getTime() - c.lastBookingSentAt.getTime() <= 4 * 864e5;
  return fresh
    ? { text: `Booking reminder emailed daily, last sent ${day(c.lastBookingSentAt)}`, tone: "quiet" }
    : { text: `Last booking reminder sent ${day(c.lastBookingSentAt)}`, tone: "attention" };
}
