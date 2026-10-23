import "server-only";

// ---------------------------------------------------------------------------
// STUB (Oct 23 2026). The shared delegation workflow is built in parallel by
// the Jordan's-dashboard builder; that file replaces this one at merge. Until
// then every read is empty. Same exports, same shapes, nothing more.
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
