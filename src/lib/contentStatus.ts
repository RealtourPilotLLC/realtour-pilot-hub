// ---------------------------------------------------------------------------
// The plain-English status engine (redesign, Aug 28) — every Content Program
// surface speaks through this instead of enum chips and fractions. One
// sentence per client per month, derived from the SAME counts the roster and
// workspace already share, so the words can never disagree with the numbers.
// Tones: "action" = waiting on Jordan (the only thing that gets brand orange),
// "moving" = in motion, "ok" = wrapped, "quiet" = paused/history.
// ---------------------------------------------------------------------------

export type StatusTone = "action" | "moving" | "ok" | "quiet";

// Pure copy of contentProgram's monthLabel — this module must stay importable
// from client components, and contentProgram pulls in prisma.
export function monthWords(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export type StatusInput = {
  status: string; // enrollment status: ACTIVE | PAUSED | ENDED
  monthKey: string;
  videosOwed: number;
  strategyCallStatus: string;
  strategyCallAt: string | null;
  strategyCallRequired: boolean;
  clientSuppliesTopics: boolean;
  topicsSelected: number;
  scriptsReady: number;
  scriptsAwaiting: number;
  openSuggestions: number;
  sessionsScheduled: number;
  sessionsRequired: number;
  shotCount: number;
  delivered: number;
  inReview: number;
  nextShootDate: string | null;
  behind: { monthKey: string; delivered: number; owed: number } | null;
  lastMonthKey?: string | null;
};

const ET = "America/New_York";

export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
}

export function fmtDayTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The one sentence. Priority: waiting-on-you beats in-motion beats done.
export function statusSentence(r: StatusInput): { text: string; tone: StatusTone } {
  if (r.status === "PAUSED") {
    return { text: r.lastMonthKey ? `Paused — last active ${monthWords(r.lastMonthKey)}` : "Paused", tone: "quiet" };
  }
  const owed = Math.max(r.videosOwed, 1);
  const suffix = r.behind
    ? ` · still owes ${plural(r.behind.owed - r.behind.delivered, "video")} from ${monthWords(r.behind.monthKey)}`
    : "";

  // Month wrapped — nothing else matters once everything owed is delivered.
  if (r.videosOwed > 0 && r.delivered >= r.videosOwed) {
    return { text: `All ${plural(r.videosOwed, "video")} delivered — ${monthWords(r.monthKey)} is wrapped${suffix}`, tone: suffix ? "action" : "ok" };
  }
  // Cuts sitting in the Review Room ARE Jordan's queue.
  if (r.inReview > 0) {
    return { text: `${plural(r.inReview, "video")} waiting in the Review Room${suffix}`, tone: "action" };
  }
  // Scripts on his desk.
  if (r.scriptsAwaiting > 0) {
    const notes = r.openSuggestions > 0 ? ` · ${plural(r.openSuggestions, "client note")}` : "";
    return { text: `${plural(r.scriptsAwaiting, "script")} waiting on your OK${notes}${suffix}`, tone: "action" };
  }
  if (r.openSuggestions > 0) {
    return { text: `${plural(r.openSuggestions, "client note")} on their scripts${suffix}`, tone: "action" };
  }
  // The call gate.
  if (r.strategyCallStatus === "NOT_SCHEDULED" && r.strategyCallRequired) {
    return { text: `Waiting to book the strategy call${suffix}`, tone: "action" };
  }
  if (r.strategyCallStatus === "SCHEDULED") {
    const when = r.strategyCallAt ? ` ${fmtDay(r.strategyCallAt)}` : "";
    return { text: `Strategy call${when ? ` —${when}` : " booked"}${suffix}`, tone: "moving" };
  }
  // A booked shoot is the month's anchor — say it, with script readiness beside it.
  if (r.nextShootDate) {
    const scripts = r.scriptsReady < owed ? ` · ${r.scriptsReady} of ${owed} scripts ready` : " · scripts ready";
    return { text: `Filming ${fmtDay(r.nextShootDate)}${scripts}${suffix}`, tone: "moving" };
  }
  // Call handled, planning the month.
  if (r.topicsSelected === 0 && !r.clientSuppliesTopics) {
    return { text: `Call handled — pick ${monthWords(r.monthKey).split(" ")[0]}'s topics${suffix}`, tone: "action" };
  }
  if (r.scriptsReady < owed) {
    const text = r.scriptsReady === 0 ? `Topics picked — scripts up next${suffix}` : `${r.scriptsReady} of ${owed} scripts ready to film${suffix}`;
    return { text, tone: "moving" };
  }
  // Scripts done, no session on the books.
  if (r.sessionsScheduled === 0) {
    return { text: `Scripts ready — no filming session booked yet${suffix}`, tone: "action" };
  }
  if (r.shotCount > 0) {
    return { text: `Filmed — ${r.delivered} of ${owed} videos delivered${suffix}`, tone: "moving" };
  }
  return { text: `${r.delivered} of ${owed} videos delivered${suffix}`, tone: "moving" };
}

// The cross-client "Needs you" inbox: each row is ONE thing waiting on Jordan.
// Derived from the same fields as the sentence, worst-first per client.
export type NeedsYouItem = { text: string; anchor: "scripts" | "month" | "review" | "prev" };

export function needsYouItems(r: StatusInput): NeedsYouItem[] {
  if (r.status !== "ACTIVE") return [];
  const items: NeedsYouItem[] = [];
  if (r.scriptsAwaiting > 0) items.push({ text: `${plural(r.scriptsAwaiting, "script")} waiting on your OK`, anchor: "scripts" });
  if (r.openSuggestions > 0) items.push({ text: `left ${plural(r.openSuggestions, "note")} on their scripts`, anchor: "scripts" });
  if (r.inReview > 0) items.push({ text: `${plural(r.inReview, "video")} waiting in the Review Room`, anchor: "review" });
  if (r.strategyCallStatus === "NOT_SCHEDULED" && r.strategyCallRequired) items.push({ text: "strategy call isn't booked yet", anchor: "month" });
  if (r.sessionsScheduled === 0 && r.strategyCallStatus !== "NOT_SCHEDULED" && r.strategyCallStatus !== "SCHEDULED") {
    items.push({ text: "no filming session on the calendar", anchor: "month" });
  }
  if (r.behind) items.push({ text: `still owes ${plural(r.behind.owed - r.behind.delivered, "video")} from ${monthWords(r.behind.monthKey)}`, anchor: "prev" });
  return items;
}

// Plain words for a script's status — enum text never renders anywhere.
export const SCRIPT_STATUS_WORDS: Record<string, { label: string; tone: "action" | "ok" | "quiet" }> = {
  DRAFT: { label: "needs your OK", tone: "action" },
  INTERNAL_REVIEW: { label: "needs your OK", tone: "action" },
  APPROVED: { label: "approved", tone: "ok" },
  CLIENT_VISIBLE: { label: "live in their portal", tone: "ok" },
  READY_TO_FILM: { label: "ready to film", tone: "ok" },
};

// Plain words for a topic's status.
export const TOPIC_STATUS_WORDS: Record<string, string> = {
  SELECTED: "picked",
  SCRIPTED: "has a script",
  FILMED: "filmed",
  EDITING: "in editing",
  DELIVERED: "delivered ✓",
  SAVED: "saved for later",
  RECOMMENDED: "suggested",
  IDEA: "video topic",
};
