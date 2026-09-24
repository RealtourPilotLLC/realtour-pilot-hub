// ---------------------------------------------------------------------------
// Content Program words and the month journey's step logic — pure, no prisma,
// so client components, server pages and the drills all import the same rules.
//
// CP-10 (Sep 24 2026): statusSentence / needsYouItems used to live here. They
// took the roster's proxy counts (a project = a booked session, a past shoot
// date = filmed, a DELIVERED project = its whole quantity delivered) and had
// no callers left, so they were removed rather than left to be re-wired onto
// the numbers the completion audit showed were wrong. The journey below reads
// lib/monthProgress's facts instead.
// ---------------------------------------------------------------------------

const ET = "America/New_York";

export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
}

export function fmtDayTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// THE MONTH JOURNEY (Call → Topics → Scripts → Shoot → Delivered), as data.
// MonthJourney.tsx draws it; monthProgress.journeyInputFrom fills it, so the
// roster card and the client file's hero tracker cannot compute it two ways.
// ---------------------------------------------------------------------------

export type JourneyInput = {
  callStatus: string; // NOT_REQUIRED | NOT_SCHEDULED | SCHEDULED | COMPLETED | SKIPPED
  topicsSelected: number;
  scriptsReady: number;
  /** drafts sitting on Jordan's desk — when set, the Scripts node says "N to review" instead of a 0/4 that lies */
  scriptsAwaiting?: number;
  videosOwed: number;
  sessionsRequired: number;
  /** DISTINCT confirmed sessions (an appointment, a confirmed request, or one whose filming was confirmed) — never a project count */
  sessionsConfirmed: number;
  /** sessions somebody confirmed were FILMED — never "the date has passed" */
  sessionsFilmedConfirmed: number;
  delivered: number;
  /** videos the client approved on their own current version */
  clientApproved?: number;
  inReview: number;
  /** A step the facts cannot answer: the sentence says why, and the node draws as "unknown", never as a confident state. */
  unknown?: Partial<Record<"shoot" | "delivered", string>>;
  /** historical/imported months read as record-keeping, never as warnings */
  muted?: boolean;
};

export type JourneyStepKey = "call" | "topics" | "scripts" | "shoot" | "delivered";
export type JourneyStepState = "done" | "active" | "warn" | "todo" | "unknown";
export type JourneyStep = { key: JourneyStepKey; label: string; state: JourneyStepState; detail: string; why: string | null };

export function journeySteps(j: JourneyInput): JourneyStep[] {
  const owed = Math.max(j.videosOwed, 1);
  const step = (key: JourneyStepKey, label: string, state: JourneyStepState, detail: string, why: string | null = null): JourneyStep => ({ key, label, state, detail, why });
  const call: JourneyStep =
    j.callStatus === "NOT_REQUIRED" ? step("call", "Call", "done", "not needed")
    : j.callStatus === "SKIPPED" ? step("call", "Call", "done", "skipped")
    : j.callStatus === "COMPLETED" ? step("call", "Call", "done", "done")
    : j.callStatus === "SCHEDULED" ? step("call", "Call", "active", "booked")
    : step("call", "Call", "warn", "not booked");
  const topics = step("topics", "Topics",
    j.topicsSelected >= owed ? "done" : j.topicsSelected > 0 ? "active" : call.state === "done" ? "warn" : "todo",
    `${j.topicsSelected}/${owed}`);
  // Drafts on Jordan's desk mean NOT done, even with enough approved — the
  // node must agree with its own "N to review" caption and the next-step line.
  const scripts = step("scripts", "Scripts",
    (j.scriptsAwaiting ?? 0) > 0 ? "warn"
    : j.scriptsReady >= owed ? "done"
    : j.scriptsReady > 0 ? "active"
    : topics.state === "done" ? "warn" : "todo",
    (j.scriptsAwaiting ?? 0) > 0 ? `${j.scriptsAwaiting} to review` : `${j.scriptsReady}/${owed}`);
  // DONE ONLY WHEN EVERY OWED SESSION WAS CONFIRMED FILMED (CP-10). It used to
  // be "one project's date has passed and there are as many projects as
  // sessions" — so a Pro month read filmed after one of its two sessions, and
  // a dated job nobody had confirmed read filmed the day after its date.
  const req = Math.max(j.sessionsRequired, 1);
  const shootUnknown = j.sessionsFilmedConfirmed < req ? j.unknown?.shoot ?? null : null;
  const shoot = step("shoot", "Shoot",
    j.sessionsFilmedConfirmed >= req ? "done" : shootUnknown ? "unknown" : j.sessionsConfirmed > 0 ? "active" : "warn",
    shootUnknown ? "unknown" : j.sessionsFilmedConfirmed > 0 ? `${j.sessionsFilmedConfirmed}/${req} filmed` : `${j.sessionsConfirmed}/${req} booked`,
    shootUnknown);
  const deliveredUnknown = j.unknown?.delivered ?? null;
  const delivered = step("delivered", "Delivered",
    j.videosOwed > 0 && j.delivered >= j.videosOwed ? "done" : deliveredUnknown ? "unknown" : j.delivered > 0 ? "active" : "todo",
    `${j.delivered}/${owed}${deliveredUnknown ? "?" : ""}`,
    deliveredUnknown);
  const steps = [call, topics, scripts, shoot, delivered];
  // Imported history: show what happened, never nag about what didn't.
  if (j.muted) for (const s of steps) if (s.state === "warn" || s.state === "unknown") s.state = "todo";
  return steps;
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
