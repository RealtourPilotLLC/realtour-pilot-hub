// ---------------------------------------------------------------------------
// THE CLIENT COMPLAINT RECORD, PURE HALF (Oct 15 2026). No prisma, no
// server-only: the staff card, the /quality list and the server read the same
// states and the same words.
//
// A complaint used to be a Feedback row on ONE job (rating, reply, resolved),
// and a call like Marcee McMullen's on Oct 15, about several months of
// videos, had nowhere to go. A ClientIssue is the whole story: what happened,
// the impact, the cause, the correction, the process change, who owns it and
// by when, and whether the client said they are satisfied.
//
//   OPEN ──(correction made)──> CORRECTED ──> CONFIRMED_SATISFIED
//                                    └──────> UNRESOLVED ──(reopen)──> OPEN
//
// CORRECTED opens a task for Kyle to check in with the client two business
// days later. It is a task only: the hub never sends the client anything.
// ---------------------------------------------------------------------------

export const ISSUE_STATES = ["OPEN", "CORRECTED", "CONFIRMED_SATISFIED", "UNRESOLVED"] as const;
export type ClientIssueState = (typeof ISSUE_STATES)[number];
export const isClientIssueState = (v: unknown): v is ClientIssueState => typeof v === "string" && (ISSUE_STATES as readonly string[]).includes(v);

export const STATE_WORDS: Record<ClientIssueState, string> = {
  OPEN: "Open",
  CORRECTED: "Corrected, checking in",
  CONFIRMED_SATISFIED: "Client satisfied",
  UNRESOLVED: "Not resolved",
};

/** Which moves a person may make from each state. */
export const NEXT_STATES: Record<ClientIssueState, readonly ClientIssueState[]> = {
  OPEN: ["CORRECTED", "UNRESOLVED"],
  CORRECTED: ["CONFIRMED_SATISFIED", "UNRESOLVED", "OPEN"],
  CONFIRMED_SATISFIED: ["OPEN"],
  UNRESOLVED: ["OPEN"],
};
export const canMove = (from: string, to: ClientIssueState): boolean => isClientIssueState(from) && NEXT_STATES[from].includes(to);

export const ISSUE_SOURCES = ["call", "text", "email", "portal", "feedback", "staff"] as const;

/** The causes a person picks from: the revision-issue vocabulary plus the delay causes. */
export const COMPLAINT_CAUSES: { key: string; label: string }[] = [
  { key: "EDITOR_ERROR", label: "Editing mistake" },
  { key: "MISSED_INSTRUCTION", label: "A supplied instruction was missed" },
  { key: "BRIEF_GAP", label: "Missing or conflicting brief" },
  { key: "CREATIVE_DIRECTION", label: "Creative direction was off for this client" },
  { key: "CLIENT_CHANGE", label: "Client preference changed" },
  { key: "CAPTURE", label: "Capture problem at the shoot" },
  { key: "LATE_DELIVERY", label: "Late delivery" },
  { key: "EDITING_CAPACITY", label: "Not enough editing capacity" },
  { key: "REVIEW_BOTTLENECK", label: "Waiting on review" },
  { key: "COMMUNICATION", label: "We didn't keep them informed" },
  { key: "MISSING_DELIVERY", label: "Something delivered never reached them" },
  { key: "PROCESSING", label: "Processing or platform problem" },
  { key: "OTHER", label: "Other" },
];
export const causeLabel = (k: string | null | undefined) => COMPLAINT_CAUSES.find((c) => c.key === k)?.label ?? (k ? k : "Not decided yet");

export type IssueHistory = { at: string; by: string | null; what: string };

export function readHistory(json: string | null | undefined): IssueHistory[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((h) => h && typeof h.what === "string") : []; } catch { return []; }
}

export function readIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
