// ---------------------------------------------------------------------------
// DELEGATION: A STUB (Oct 23 2026).
//
// Another build owns delegation (one canonical task per assignment, who
// assigned it, accepted, updates, blockers, verification). Kyle's desk only
// READS the tasks assigned to him through these functions. Until that build
// merges, nothing is delegated: every read is empty, and its real file
// replaces this one at merge with the same exports.
// ---------------------------------------------------------------------------

export type DelegationState = "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS" | "BLOCKED" | "READY_FOR_VERIFICATION" | "COMPLETED" | "CANCELLED";

export type DelegatedTask = {
  taskId: string;
  title: string;
  outcome: string | null;
  assigneeKey: string | null;
  assigneeName: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  dueAt: string | null;
  state: DelegationState;
  needsVerification: boolean;
  latestUpdate: string | null;
  blocker: string | null;
  nextStep: string | null;
  clientId: string | null;
  projectId: string | null;
  sourceHref: string | null;
};

export async function delegationFor(taskIds: string[]): Promise<Map<string, DelegatedTask>> {
  void taskIds;
  return new Map();
}

export async function tasksAssignedTo(assigneeKey: string): Promise<DelegatedTask[]> {
  void assigneeKey;
  return [];
}

export async function tasksDelegatedBy(userEmail: string): Promise<DelegatedTask[]> {
  void userEmail;
  return [];
}
