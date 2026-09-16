// Shared "needs assigning" definition, used by BOTH the Daily Tasks queue and the
// morning brief so the two surfaces can never drift on what counts as triage.
//
// Triage = delegatable work that arrived without a fixed owner (mostly Slack
// to-dos + unrouted edit/vendor/lead work) — the "who does this?" pile. Kyle's SOP
// routine (confirm / QC / deliver / client replies) is his by default and is NOT
// triage, so it stays in his own groups.
// edit_video joined Aug 2026: personal-branding reels deliberately route to
// NOBODY (manual assignment per Jordan), and an unassigned edit must sit in
// the pinned "Needs assigning" pile, not vanish into the board.
export const TRIAGE_TYPES = new Set(["internal_instruction", "todo", "revision", "lead", "vendor_update", "edit_video"]);

// ---------------------------------------------------------------------------
// DISMISSAL VOCABULARY — shared by the server action that writes it
// (app/actions.ts dismissTask), the janitor rules that must not reopen it
// (lib/tasks.ts) and the buttons that offer it (components/tasks). It lives
// HERE, in a plain module, because a "use server" file may only export async
// functions and a "server-only" one can't reach a client component — and the
// one thing worse than a duplicated constant is two spellings of the reason a
// row was closed (Sep 16, Kyle's call).
// ---------------------------------------------------------------------------

/** What a person can give as the reason for closing a row that never got
 *  done. "duplicate" is stored as "duplicate of <id>". */
export const DISMISS_REASONS = ["already done", "not needed", "duplicate", "spam"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** How a dismissed row announces itself in its own summary. The Done tab reads
 *  it to group the row, and the reopen guards read it to leave it alone. */
export const DISMISSED_PREFIX = "Dismissed by ";

/** Was this row closed by a person's judgement rather than by a sweep? */
export function isDismissedSummary(summary: string | null | undefined): boolean {
  return (summary ?? "").startsWith(DISMISSED_PREFIX);
}

/** The reason out of a dismissal stamp ("Dismissed by Kyle Smith — already
 *  done." → "already done"), or null when the row wasn't dismissed by hand. */
export function dismissedReason(summary: string | null | undefined): string | null {
  const first = (summary ?? "").split("\n")[0];
  if (!first.startsWith(DISMISSED_PREFIX)) return null;
  const dash = first.indexOf(" — ");
  if (dash < 0) return null;
  return first.slice(dash + 3).replace(/\.\s*$/, "").trim() || null;
}

/** Who dismissed it ("Dismissed by Kyle Smith — …" → "Kyle Smith"). */
export function dismissedBy(summary: string | null | undefined): string | null {
  const first = (summary ?? "").split("\n")[0];
  if (!first.startsWith(DISMISSED_PREFIX)) return null;
  const dash = first.indexOf(" — ");
  const who = (dash < 0 ? first.slice(DISMISSED_PREFIX.length) : first.slice(DISMISSED_PREFIX.length, dash)).trim();
  return who || null;
}

// `source` is deliberately NOT part of this predicate: the Sep 8 audit weighed
// a source:"manual" exemption and dropped it, because the same rule is restated
// in SQL wherever a screen COUNTS the pile, and every restatement would have to
// change in step. Kyle's own to-dos stay out of the pile because they now store
// assignedKey "kyle" at creation (createManualTask), not because of source.
export function isNeedsAssigning(t: { assignedKey: string | null; taskType: string }): boolean {
  return !t.assignedKey && TRIAGE_TYPES.has(t.taskType);
}

// Task types hidden from the non-editor board (Jordan, Sep 1): comm types live
// on the Comms tab, edits in the Editor Queue, QC + delivery on Kyle's Ops
// Day, and the two text types now send themselves.
export const BOARD_HIDDEN_TYPES = [
  "client_reply", "comms_followup", "callback", "edit_video", "media_qa",
  "delivery", "finish_delivery", "delivery_text", "confirmation_text",
];

// What a NON-EDITOR's Other tab actually shows — shared by the board query,
// the tab badge, and the /ops overdue/due-today pills so a count can never
// point at a list that hides its own rows (review). Unassigned triage-type
// work (e.g. a reel edit routed to nobody, a Slack to-do) is exempt from the
// hiding: it must stay visible in the pinned "Needs assigning" pile.
import type { Prisma } from "@prisma/client";
//
// Sep 16 (Kyle's call: "the Slack reminders are hard to find"): Slack rows are
// now excluded OUTRIGHT, assigned or not. They used to appear in three places
// at once — the Slack tab, this tab's "Needs assigning" pile when unowned, and
// the home's Open Loops — and the same row in three lists is how a board stops
// being a list of work and becomes a wall. The Slack tab is their one home,
// and it carries its own Assign control now, so nothing is stranded by the
// narrowing. Everything that COUNTS this pile (the badge, the /ops pills)
// reads this one predicate, so they all move together.
export function boardVisibleWhere(): Prisma.SmartTaskWhereInput {
  return {
    NOT: { source: "slack" },
    OR: [
      { assignedKey: null, taskType: { in: [...TRIAGE_TYPES] } },
      { taskType: { notIn: BOARD_HIDDEN_TYPES } },
    ],
  };
}
