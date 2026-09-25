import type { ClientVideoState } from "@/lib/contentVideos";
import type { PortalTopicState } from "@/lib/portal";
import type { ClientSessionCard } from "@/lib/monthProgress";
import type { PlanStep } from "@/lib/planningState";

// ---------------------------------------------------------------------------
// ONE CLIENT VOCABULARY (UI-01, Sep 24 2026). The audit asked for a consistent
// status language across every view, never carried by colour alone. So every
// state a client reads — a video, a topic, a script, a session — has ONE
// label, ONE tone and ONE icon here, and the v2 Home, Plan, Library and
// Schedule render them through ui.tsx's StatusChip (icon + text, always).
//
// Pure data: the icon is a key, not a component, so a drill or a server
// module can import this without React. The words are the client's — never
// "reconcile", "ledger" or an internal job state.
// ---------------------------------------------------------------------------

export type WordTone = "brand" | "success" | "warning" | "muted" | "danger";
export type WordIcon = "review" | "changes" | "check" | "delivered" | "production" | "idea" | "selected" | "preparing" | "filmed" | "script" | "calendar" | "clock" | "alert";
export type Word = { label: string; tone: WordTone; icon: WordIcon };

export const VIDEO_WORDS: Record<ClientVideoState, Word> = {
  FOR_REVIEW: { label: "Needs your review", tone: "brand", icon: "review" },
  CHANGES_IN_PROGRESS: { label: "Changes in progress", tone: "warning", icon: "changes" },
  // The list cannot know WHO approved without reading every decision, and a
  // viewer seat must not be told "by you" about somebody else's approval.
  APPROVED: { label: "Approved", tone: "success", icon: "check" },
  DELIVERED: { label: "Delivered", tone: "success", icon: "delivered" },
  IN_PRODUCTION: { label: "In production", tone: "muted", icon: "production" },
};

export const TOPIC_WORDS: Record<PortalTopicState, Word> = {
  SUGGESTED: { label: "Suggested", tone: "muted", icon: "idea" },
  SELECTED: { label: "Selected", tone: "brand", icon: "selected" },
  PREPARING: { label: "Preparing", tone: "warning", icon: "preparing" },
  FILMED: { label: "Filmed", tone: "success", icon: "filmed" },
};

/**
 * WHERE A TOPIC STANDS IN ITS MONTH (R01 / §11 precise progress, Sep 25 2026).
 * One sentence per planningState step — "Preparing" used to cover answered,
 * writing, team review and ready-for-you alike. Every topic row on an open
 * month (Your Month, the topic bank, Home's month card) reads its chip here,
 * so a refresh after an answer, a selection or an approval shows the server's
 * step, not a transient message.
 */
export const PLAN_STEP_WORDS: Record<PlanStep, Word> = {
  FILMED: { label: "Filmed", tone: "success", icon: "filmed" },
  EXTRA: { label: "Extra — waits its turn", tone: "muted", icon: "clock" },
  APPROVED: { label: "Script approved", tone: "success", icon: "check" },
  CHANGES_REQUESTED: { label: "We're making your changes", tone: "warning", icon: "changes" },
  READY_FOR_YOU: { label: "Ready for your review", tone: "brand", icon: "script" },
  TEAM_REVIEW: { label: "Our team is reviewing", tone: "muted", icon: "preparing" },
  CONFIRMING: { label: "From your call — confirming", tone: "muted", icon: "clock" },
  WRITING: { label: "We're writing your script", tone: "warning", icon: "preparing" },
  NEEDS_MORE: { label: "We need one more answer", tone: "brand", icon: "alert" },
  ON_CALL: { label: "We'll cover this on your call", tone: "muted", icon: "calendar" },
  CHOSEN: { label: "Chosen", tone: "brand", icon: "selected" },
  NEEDS_ANSWERS: { label: "Needs your answers", tone: "brand", icon: "script" },
};

/** The chip for a step, with the gap count said out loud ("We need 2 more answers"). */
export function planStepWord(step: PlanStep, missing = 0): Word {
  const w = PLAN_STEP_WORDS[step];
  if (step !== "NEEDS_MORE") return w;
  return { ...w, label: missing > 1 ? `We need ${missing} more answers` : missing === 1 ? "We need one more answer" : "We need a few answers" };
}

/**
 * THE BUTTONS (§11 plain labels). One word for one act on every page:
 * TopicBank, ScriptApprovalCard, Home's next step and Your Month read these.
 */
export const CTA_WORDS = {
  CHOOSE: "Choose this topic",
  SWAP: "Choose another topic",
  ANSWER: "Answer questions",
  ANSWER_MORE: "Answer one more question",
  REVIEW: "Review script",
  APPROVE: "Approve script",
  CHANGES: "Request changes",
  BOOK: "Book filming",
  LATER: "Schedule later",
} as const;

/** The questions button for a topic: the gap count when there is one, else the plain label. */
export function answerCta(missing: number): string {
  return missing === 1 ? CTA_WORDS.ANSWER_MORE : missing > 1 ? `Answer ${missing} more questions` : CTA_WORDS.ANSWER;
}

export type ScriptWordKey = "AWAITING" | "APPROVED" | "CHANGES_REQUESTED";
export const SCRIPT_WORDS: Record<ScriptWordKey, Word> = {
  AWAITING: { label: "Script ready for your read", tone: "brand", icon: "script" },
  APPROVED: { label: "You approved the script", tone: "success", icon: "check" },
  CHANGES_REQUESTED: { label: "Script changes requested", tone: "warning", icon: "changes" },
};

/** A session as the client reads it — the month-progress reader's four states plus an open request. */
export const SESSION_WORDS: Record<ClientSessionCard["state"] | "REQUESTED", Word> = {
  BOOKED: { label: "Booked", tone: "success", icon: "calendar" },
  HELD: { label: "Session held", tone: "success", icon: "check" },
  FILMED: { label: "Filmed", tone: "success", icon: "filmed" },
  CONFIRMING: { label: "Being confirmed", tone: "muted", icon: "clock" },
  REQUESTED: { label: "Requested", tone: "brand", icon: "clock" },
};

/** The Library's simple status filters. `states` is what each chip keeps. */
export const LIBRARY_FILTERS = [
  { key: "all", label: "All", states: null },
  { key: "review", label: "Needs review", states: ["FOR_REVIEW"] },
  { key: "progress", label: "In progress", states: ["CHANGES_IN_PROGRESS", "IN_PRODUCTION"] },
  { key: "approved", label: "Approved", states: ["APPROVED", "DELIVERED"] },
] as const satisfies readonly { key: string; label: string; states: readonly ClientVideoState[] | null }[];
export type LibraryFilterKey = (typeof LIBRARY_FILTERS)[number]["key"];
export const isLibraryFilter = (k: unknown): k is LibraryFilterKey => LIBRARY_FILTERS.some((f) => f.key === k);

// ---------------------------------------------------------------------------
// THE OFFICE LINE IN A SENTENCE (Sep 24). A refusal or a hint that cannot hold
// a link used to end "text us" — with no name and no number (audit §6: generic
// "text us" instructions are friction). These name Kyle and the office line,
// the same values as ContactTeam's DEFAULT_PORTAL_CONTACT and
// reviewWindows.URGENT_CONTACT (the ui01 drill asserts they agree). The contact
// card beside every page reads the owner-editable `portal-contact` setting;
// these sentences are written where no async read is possible (constant maps,
// sync refusals), so they follow the default.
// ---------------------------------------------------------------------------
export const TEXT_KYLE = "text Kyle at (215) 645-4889";
export const TEXT_KYLE_START = "Text Kyle at (215) 645-4889";
