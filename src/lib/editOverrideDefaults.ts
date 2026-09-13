// The office's OVERRIDE vocabulary for a video job in the Editing Room
// (Jordan, Sep 13: "I want to be able to change the status, amount of
// deliverables, the due date and all other information for the edits in the
// editing room. I want to be able to override anything.").
//
// This module imports NOTHING on purpose: the override dialog is a client
// component and the queue row is one too, so every constant and type they
// share with the server action has to live somewhere that pulls in neither
// Prisma nor a server-only module. The server side (src/lib/editOverrides.ts,
// src/app/editing/actions.ts saveEditOverrides) codes to these same words.

// The Slack ladder's six labels, verbatim — the status select in the dialog
// lists all six, because an override is exactly the move the pill refuses.
export const EDIT_STATUS_LABELS = [
  "Waiting",
  "Ready for editing",
  "In editing",
  "Ready for review",
  "Revisions",
  "Completed",
] as const;
export type EditStatusLabel = (typeof EDIT_STATUS_LABELS)[number];

export const EDIT_TIERS = ["standard", "premium", "branding"] as const;
export type EditTier = (typeof EDIT_TIERS)[number];

export const EDIT_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type EditPriority = (typeof EDIT_PRIORITIES)[number];

/** What the office set on this job. null on a field = no override there — the
    hub's own value stands. `by` / `at` / `note` describe the last save. */
export type EditOverrideView = {
  statusPinned: boolean;
  dueAt: string | null; // ISO instant
  videosOwed: number | null;
  tier: EditTier | null;
  typeDetail: string | null;
  priority: EditPriority | null;
  by: string | null;
  at: string | null; // ISO instant
  note: string | null;
};

/** What the hub would say on its own — the value each override replaces, shown
    beside the control so the office can see what "Use the hub's value" hands
    back. */
export type EditComputedView = {
  dueAt: string | null; // ISO instant
  videosOwed: number;
  tier: EditTier;
  typeDetail: string;
  priority: EditPriority;
};

/** One save from the dialog. A field left undefined = leave it as it is;
    null = CLEAR that override (back to the hub's value).
    · status given = force that status NOW and pin it (the hub's sweeps stop
      moving it); pinStatus:false alone = unpin without changing the status.
    · editorKey: "" = unassign, "external_agency" = the outside shop, else an
      editor key — the same words setEditVideoEditor takes.
    · dueAt is an ISO instant (the dialog converts the ET wall-clock input).
    · fromLabel = the status label the row/page SHOWED when the dialog opened
      (the queue's cut-derived reading, which can differ from the stored
      status — 38 E Gay St reads Revisions on the queue while Project.status
      is REVIEW). Only for the timeline sentence, so it reads "Revisions →
      Waiting" for a row that said Revisions; never drives the write. */
export type EditOverrideInput = {
  status?: EditStatusLabel | null;
  pinStatus?: boolean;
  fromLabel?: string;
  editorKey?: string | null;
  videosOwed?: number | null;
  dueAt?: string | null;
  priority?: EditPriority | null;
  tier?: EditTier | null;
  typeDetail?: string | null;
  note?: string;
};
