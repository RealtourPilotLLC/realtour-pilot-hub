"use server";

// ---------------------------------------------------------------------------
// STUB (Oct 23 2026). The shared delegation workflow's actions are built in
// parallel by the Jordan's-dashboard builder; that file replaces this one at
// merge. Until then every action answers "Not available yet" and writes
// nothing. Same exports, same signatures.
// ---------------------------------------------------------------------------

export type DelegationResult = { ok: boolean; message: string };

const NOT_YET: DelegationResult = { ok: false, message: "Not available yet" };

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
}): Promise<{ ok: boolean; message: string }> {
  void input;
  return NOT_YET;
}

export async function acceptTaskAction(taskId: string): Promise<{ ok: boolean; message: string }> {
  void taskId;
  return NOT_YET;
}

export async function updateTaskAction(taskId: string, note: string): Promise<{ ok: boolean; message: string }> {
  void taskId; void note;
  return NOT_YET;
}

export async function flagBlockerAction(taskId: string, why: string): Promise<{ ok: boolean; message: string }> {
  void taskId; void why;
  return NOT_YET;
}

export async function submitForVerificationAction(taskId: string): Promise<{ ok: boolean; message: string }> {
  void taskId;
  return NOT_YET;
}

export async function completeTaskAction(taskId: string, evidence?: string): Promise<{ ok: boolean; message: string }> {
  void taskId; void evidence;
  return NOT_YET;
}

export async function escalateTaskAction(taskId: string, why: string): Promise<{ ok: boolean; message: string }> {
  void taskId; void why;
  return NOT_YET;
}

export async function reassignTaskAction(taskId: string, assigneeKey: string): Promise<{ ok: boolean; message: string }> {
  void taskId; void assigneeKey;
  return NOT_YET;
}
