// Shared checklist model for SmartTasks. A task's `checklist` column is a JSON
// string; historically it held a plain string[] of guidance steps. It now holds
// checkable items `{ label, done }` so a single consolidated task (e.g. one QC
// task covering every deliverable) can be ticked off in place. The parser is
// backward-compatible: legacy string[] entries become unchecked items.

export type ChecklistItem = { label: string; done: boolean };

export function parseChecklist(raw: string | null | undefined): ChecklistItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x): ChecklistItem | null => {
        if (typeof x === "string") return { label: x, done: false };
        if (x && typeof x === "object" && typeof x.label === "string") return { label: x.label, done: !!x.done };
        return null;
      })
      .filter((x): x is ChecklistItem => x !== null);
  } catch {
    return [];
  }
}

export function serializeChecklist(items: ChecklistItem[]): string {
  return JSON.stringify(items.map((i) => ({ label: i.label, done: i.done })));
}

// A checklist is "complete" only when it has items and every one is checked.
export function checklistComplete(items: ChecklistItem[]): boolean {
  return items.length > 0 && items.every((i) => i.done);
}
