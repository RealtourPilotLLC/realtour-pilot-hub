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
export function boardVisibleWhere(): Prisma.SmartTaskWhereInput {
  return {
    OR: [
      { assignedKey: null, taskType: { in: [...TRIAGE_TYPES] } },
      { taskType: { notIn: BOARD_HIDDEN_TYPES }, NOT: { source: "slack" } },
    ],
  };
}
