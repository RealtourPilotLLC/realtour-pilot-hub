/** Presentation filters over the status already shown by editorQueue.
 * Never infer work activity, eligibility or approval from another field. */
export const EDITING_STAGES = [
  { key: "ready", label: "Ready for editing", statuses: ["Ready for editing"] },
  { key: "changes", label: "Changes requested", statuses: ["Revisions"] },
  { key: "review", label: "Awaiting review", statuses: ["Ready for review"] },
  // Upcoming jobs also wear Waiting before footage is expected. Calling all
  // of them blocked would imply a missed handoff that has not happened.
  { key: "blocked", label: "Blocked / waiting", statuses: ["Waiting", "Waiting on instructions"] },
  // These remain separate: an unconfirmed old EDITING label is not Start;
  // a held self-check is not in the reviewer's queue; approval is not delivery.
  { key: "editing", label: "In editing", statuses: ["In editing"] },
  { key: "paused", label: "Paused", statuses: ["Paused"] },
  { key: "unconfirmed", label: "Start not confirmed", statuses: ["In editing — not confirmed"] },
  { key: "check", label: "Editor check needed", statuses: ["Check needed"] },
  { key: "approved", label: "Approved, awaiting delivery", statuses: ["Approved"] },
  { key: "additional", label: "Additional video owed", statuses: ["Extra video owed"] },
  { key: "completed", label: "Completed", statuses: ["Completed"] },
  { key: "other", label: "Other status", statuses: [] },
] as const;

export type EditingStageFilter = "all" | typeof EDITING_STAGES[number]["key"];

export function editingStageFilter(raw: string | null): EditingStageFilter {
  return EDITING_STAGES.some((stage) => stage.key === raw) ? raw as EditingStageFilter : "all";
}

export function editingStageOf(status: string): Exclude<EditingStageFilter, "all"> {
  return EDITING_STAGES.find((stage) => (stage.statuses as readonly string[]).includes(status))?.key ?? "other";
}

export function matchesEditingStage(stage: EditingStageFilter, status: string): boolean {
  return stage === "all" || editingStageOf(status) === stage;
}
