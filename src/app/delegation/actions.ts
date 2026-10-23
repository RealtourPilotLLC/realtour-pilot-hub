"use server";

// ---------------------------------------------------------------------------
// DELEGATION ACTIONS: A STUB (Oct 23 2026). The delegation build replaces this
// file at merge with the same exports. Until then nothing is assigned, and
// every action says so plainly instead of pretending it worked.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const NOT_YET: Result = { ok: false, message: "Assigning work to someone else is not switched on yet. Nothing was saved." };

export async function assignTaskAction(input: {
  title: string;
  outcome?: string;
  assigneeKey: string;
  dueAt?: string;
  needsVerification?: boolean;
  sourceTaskId?: string;
  clientId?: string;
  projectId?: string;
  sourceHref?: string;
  note?: string;
}): Promise<Result> {
  void input;
  return NOT_YET;
}

export async function acceptTaskAction(taskId: string): Promise<Result> {
  void taskId;
  return NOT_YET;
}

export async function updateTaskAction(taskId: string, note: string): Promise<Result> {
  void taskId; void note;
  return NOT_YET;
}

export async function flagBlockerAction(taskId: string, why: string): Promise<Result> {
  void taskId; void why;
  return NOT_YET;
}

export async function submitForVerificationAction(taskId: string): Promise<Result> {
  void taskId;
  return NOT_YET;
}

export async function completeTaskAction(taskId: string, evidence?: string): Promise<Result> {
  void taskId; void evidence;
  return NOT_YET;
}

export async function escalateTaskAction(taskId: string, why: string): Promise<Result> {
  void taskId; void why;
  return NOT_YET;
}

export async function reassignTaskAction(taskId: string, assigneeKey: string): Promise<Result> {
  void taskId; void assigneeKey;
  return NOT_YET;
}
