import { editorForDeliverable, editorKeyForTeamName, editorMeta, type VideoRoutingRules } from "@/lib/editors";

/** One display contract for the queue, Home exceptions and the job brief.
 * A routing rule suggests a person; only a task, project or vendor assignment
 * actually names the owner. Start/Pause remains separate work evidence. */
export type EditorAssignment = {
  state: "assigned" | "predicted" | "unassigned";
  source: "task" | "project" | "vendor" | "routing" | "manual" | "none";
  key: string | null;
  name: string | null;
  savedKey: string | null;
};

export function resolveEditorAssignment(input: {
  taskKey?: string | null;
  taskUnassignedManually?: boolean;
  projectEditorName?: string | null;
  projectVendorKey?: string | null;
  projectManual?: boolean;
  deliverableType?: string | null;
  deliverableLabel?: string | null;
  monthly?: boolean;
  rules: VideoRoutingRules;
}): EditorAssignment {
  const named = (key: string) => editorMeta(key)?.name ?? key;
  if (input.taskKey) return { state: "assigned", source: "task", key: input.taskKey, name: named(input.taskKey), savedKey: input.taskKey };
  if (input.taskUnassignedManually) return { state: "unassigned", source: "manual", key: null, name: null, savedKey: null };
  if (input.projectEditorName) {
    const key = editorKeyForTeamName(input.projectEditorName);
    return { state: "assigned", source: "project", key, name: input.projectEditorName, savedKey: key };
  }
  if (input.projectVendorKey) return { state: "assigned", source: "vendor", key: input.projectVendorKey, name: named(input.projectVendorKey), savedKey: input.projectVendorKey };
  if (input.projectManual) return { state: "unassigned", source: "manual", key: null, name: null, savedKey: null };
  const predicted = editorForDeliverable(input.deliverableType, input.deliverableLabel, input.monthly, input.rules);
  return predicted
    ? { state: "predicted", source: "routing", key: predicted, name: named(predicted), savedKey: null }
    : { state: "unassigned", source: "none", key: null, name: null, savedKey: null };
}
