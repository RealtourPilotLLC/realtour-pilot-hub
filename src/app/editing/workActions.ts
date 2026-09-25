"use server";

import { confirmCurrentWork, pauseEditing, startEditing, type WorkResult } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// The three buttons of §7.1 — Start/Resume, Pause, and the one-time "which one
// are you on" — as thin server actions over lib/editorWork, which does the
// authorization (the assigned editor, or the office recorded AS the office),
// the one-active-per-editor switch and the log. Nothing here decides anything.
//
// Opening a brief or choosing a preview never calls these: only a person
// pressing one of the buttons does (WorkStateBar, EditorDesk, the queue pill).
// ---------------------------------------------------------------------------

export async function startEditingAction(input: {
  projectId: string;
  outputId?: string | null;
  forEditorKey?: string | null;
  requestId: string;
}): Promise<WorkResult> {
  return startEditing(input).catch(() => ({ ok: false, message: "Couldn't start editing — nothing changed. Try again." }));
}

export async function pauseEditingAction(input: { projectId: string; forEditorKey?: string | null; requestId: string }): Promise<WorkResult> {
  return pauseEditing(input).catch(() => ({ ok: false, message: "Couldn't pause — nothing changed. Try again." }));
}

export async function confirmCurrentWorkAction(input: { projectId: string | null; requestId: string }): Promise<WorkResult> {
  return confirmCurrentWork(input).catch(() => ({ ok: false, message: "Couldn't save that — nothing changed. Try again." }));
}
