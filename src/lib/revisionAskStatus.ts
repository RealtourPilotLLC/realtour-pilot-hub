// ---------------------------------------------------------------------------
// IS A CLIENT'S REVISION ASK DONE, AND WHO HAS IT? (Oct 27 2026). Pure.
//
// Jordan on a client's Revisions tab: "When did this one come in? And why
// isn't it with the editor? ... It says it's not done, but was it done? ... I
// can't even see where or what the revision was ... it says 0 of 1 done, so
// why does it say that?"
//
// Why it said that: the tab counted only the editor's ticks on the work order
// (doneJson). Ticking is optional (best-effort everywhere else in the hub);
// editors fix the video, upload the new cut and the revision task closes, so
// a finished ask read "0 of 1 done" forever. The ask is now done when its
// revision task is closed, when every item is ticked, or when a newer cut of
// the job was approved after it came in. Photo-only items are not the
// editor's (revisionBrief.ts drops them from the editor's list), so they are
// not counted here either.
// ---------------------------------------------------------------------------

export type RevisionAskStatus = { open: boolean; word: string; tone: "done" | "editor" | "review" | "waiting" };

export function revisionAskStatus(i: {
  /** editor items on the work order (photo-only items left out) */
  total: number;
  /** of those, ticked off */
  done: number;
  /** the revision SmartTask's status, when the ask has one */
  taskStatus: string | null;
  /** who holds the task (editorMeta name), when anyone */
  editorName: string | null;
  /** the newest cut of the job uploaded AFTER the ask came in */
  laterCut: { status: string } | null;
}): RevisionAskStatus {
  if (i.taskStatus === "COMPLETED") return { open: false, word: "Done", tone: "done" };
  if (i.taskStatus === "CANCELLED") return { open: false, word: "Closed without changes", tone: "done" };
  if (i.total > 0 && i.done >= i.total) return { open: false, word: "Done, every item ticked off", tone: "done" };
  if (i.laterCut?.status === "APPROVED") return { open: false, word: "Done, the new cut was approved", tone: "done" };
  if (i.laterCut?.status === "PENDING") return { open: true, word: "New cut uploaded, waiting for review", tone: "review" };
  if (i.editorName) return { open: true, word: `With ${i.editorName}${i.total > 0 ? `, ${i.done} of ${i.total} item${i.total === 1 ? "" : "s"} ticked` : ""}`, tone: "editor" };
  return { open: true, word: "Not with an editor yet", tone: "waiting" };
}
