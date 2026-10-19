// ---------------------------------------------------------------------------
// KYLE'S FIVE JOBS (Jordan, Oct 19 2026): photo delivery, video delivery,
// client messages, special requests, scheduling requests. Each job's own
// screen owns its query; Home only shows these four numbers per job, taken
// from the function that builds that screen, so a tile can never disagree
// with the page it opens.
// ---------------------------------------------------------------------------

export type JobCounts = {
  /** Open items in this job right now. */
  open: number;
  /** Due today (ET) and not done yet. */
  dueToday: number;
  /** Past their due time and not done. */
  behind: number;
  /** Hours the oldest open item has waited; null when nothing is open. */
  oldestHours: number | null;
};

export const EMPTY_COUNTS: JobCounts = { open: 0, dueToday: 0, behind: 0, oldestHours: null };
