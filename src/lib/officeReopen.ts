// ---------------------------------------------------------------------------
// THE OFFICE PUT A FINISHED JOB BACK (Oct 21 2026, audit B11).
//
// Project.officeReopenedAt is stamped by the two writers that reopen a job on
// the office's word: the board's move (app/actions.ts moveProjectStatus) and
// the Editing Room's "Add a job" on a finished job (editing/actions.ts
// addToEditorQueue, the new-cut branch). The Editing Room queue and the
// reopened-clock net read the stamp. Before it existed they matched the
// timeline wording, so a renamed stage label silently brought back the
// Greenridge Rd bug. That wording is kept here only for jobs reopened before
// the stamp (LEGACY) and for the one-off backfill
// (scripts/_fix/oct21/backfill-office-reopened.ts).
// ---------------------------------------------------------------------------
import { ProjectStatus } from "@prisma/client";
import { ALL_STAGES } from "@/lib/pipeline";

/** The timeline line the Editing Room's "New cut" queue-add writes. */
export const OFFICE_NEW_CUT_LINE = "Queued a new cut (as a revision)";

/** A delivered job dragged back onto one of these is back in the work. */
const BACK_IN_THE_WORK = new Set<ProjectStatus>([ProjectStatus.SHOT, ProjectStatus.EDITING, ProjectStatus.REVIEW]);

/**
 * Does this board move put a finished job back to the editor? Any move to
 * Revisions, and a move off Delivered back onto a working stage (the hourly
 * net dates a reopened job from that move). Off Delivered to On hold, a
 * reshoot or Cancelled is not a put-back.
 */
export function boardMoveReopens(from: ProjectStatus, to: ProjectStatus): boolean {
  if (from === to) return false;
  return to === ProjectStatus.REVISION || (from === ProjectStatus.DELIVERED && BACK_IN_THE_WORK.has(to));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * LEGACY (jobs reopened before Oct 21 2026): is this timeline line one of the
 * office's put-backs? Reads moveProjectStatus's own sentence ("Moved from
 * <stage> to <stage>." with an optional "with … still missing" clause) and
 * the queue-add's, by the same rule the writers now stamp with.
 */
export function isOfficeReopenLine(body: string): boolean {
  if (body.startsWith(OFFICE_NEW_CUT_LINE)) return true;
  const m = MOVE_LINE.exec(body);
  if (!m) return false;
  const from = BY_LABEL.get(m[1]);
  const to = BY_LABEL.get(m[2]);
  return !!from && !!to && boardMoveReopens(from, to);
}

const BY_LABEL = new Map(ALL_STAGES.map((s) => [s.label, s.status]));
const LABELS = [...BY_LABEL.keys()].map(escapeRe).join("|");
const MOVE_LINE = new RegExp(`^Moved from (${LABELS}) to (${LABELS})(?:\\.| with )`);
