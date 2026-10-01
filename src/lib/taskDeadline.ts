import { etDayKey, etEndOfDay } from "@/lib/datetime";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];

/** These two creation paths already let the office choose a date. A manual
 * field flag, generated to-do or editing task is never an ad hoc deadline.
 * Missing dedupe evidence fails closed, including older presentation callers. */
export function canEditTaskDeadline(task: { taskType: string; source: string; status: string; dedupeKey?: string | null }): boolean {
  return task.dedupeKey === null && ACTIVE.includes(task.status) && (
    (task.taskType === "todo" && task.source === "manual") ||
    (task.taskType === "internal_instruction" && task.source === "assistant")
  );
}

/** Repeat eligibility in the write predicate: a close or transformation that
 * races the initial read must not turn into a write to a different workflow. */
export function editableTaskDeadlineWhere() {
  return {
    status: { in: ACTIVE },
    dedupeKey: null,
    OR: [{ taskType: "todo", source: "manual" }, { taskType: "internal_instruction", source: "assistant" }],
  };
}

export function parseTaskDeadlineDate(value: unknown): { ok: true; dueAt: Date | null } | { ok: false; message: string } {
  if (value === "") return { ok: true, dueAt: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, message: "Choose a valid calendar date, or clear the date." };
  const date = etEndOfDay(value);
  // etAt normalizes impossible dates (e.g. February 31). Do not silently save
  // the resulting March date when the office asked for February.
  if (!Number.isFinite(date.getTime()) || etDayKey(date) !== value) return { ok: false, message: "Choose a valid calendar date, or clear the date." };
  return { ok: true, dueAt: date };
}

export type TaskDeadlineSnapshot = { dueAt: string | null; editable: boolean };
export type TaskDeadlineReceipt = { ok: boolean; message: string; dueAt?: string | null; needsRefresh?: boolean };

/** After a lost response only a fresh exact-row read can unlock a retry. The
 * draft is owned by the form and never replaced by this reconciliation. */
export function reconcileTaskDeadline(snapshot: TaskDeadlineSnapshot, submitted: string) {
  const parsed = parseTaskDeadlineDate(submitted);
  const matches = parsed.ok && (parsed.dueAt?.toISOString() ?? null) === snapshot.dueAt;
  return {
    matches,
    message: matches
      ? "The current task date matches your submitted change."
      : snapshot.editable
        ? "The current task date is shown above. Your chosen date is still here; review it before saving again."
        : "This task is no longer an editable ad hoc task. Your chosen date is still here.",
  };
}
