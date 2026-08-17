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
