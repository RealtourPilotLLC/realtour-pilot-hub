// ---------------------------------------------------------------------------
// CLOSE OUT A HANDOFF ROW (Oct 26 2026). Jordan, on James's dashboard: "there
// is no way to close these out". A handoff row (his own shoot, or a shoot of
// the team he supervises) said what was missing and offered only "Open".
// "Close out" takes it off HIS list with a reason; the job gets a note saying
// who closed it and why. It is his list only: the photographer's upload page,
// Kyle's desk and the alerts read the job's own records, which this changes
// nothing in.
//
// A closed row comes back on its own when anything on it changes (the row's
// signature: its status, its open lines, what is missing, the exceptions), so
// a new problem on the same job is never hidden. "I followed up" is a snooze:
// back in two days if nothing changed.
//
// Shared by the server (lib/creativeDesk, app/creativeDeskActions) and the
// dashboard's buttons, so nothing here is server-only.
// ---------------------------------------------------------------------------

export const HANDOFF_CLOSE_REASONS = [
  { key: "outside", label: "Handled outside the hub", snoozeDays: null },
  { key: "not_needed", label: "Not needed for this job", snoozeDays: null },
  { key: "followed_up", label: "I followed up with the photographer", snoozeDays: 2 },
] as const;
export type HandoffCloseReason = (typeof HANDOFF_CLOSE_REASONS)[number]["key"];

/** One person's closed rows: AppSetting creative_handoff_closed:<personKey>, by job id. */
export const handoffClosedKey = (personKey: string) => `creative_handoff_closed:${personKey}`;
export type ClosedHandoff = { at: string; by: string; reason: HandoffCloseReason; note: string | null; sig: string; until: string | null };

/** A closed row is kept this long, then dropped from the record (its job long gone from the list). */
export const CLOSED_KEEP_DAYS = 60;

export function readClosedHandoffs(value: string | null | undefined): Record<string, ClosedHandoff> {
  if (!value) return {};
  try {
    const raw = JSON.parse(value) as Record<string, Partial<ClosedHandoff>>;
    const out: Record<string, ClosedHandoff> = {};
    for (const [id, c] of Object.entries(raw ?? {})) {
      if (!c || typeof c.sig !== "string" || typeof c.at !== "string" || !HANDOFF_CLOSE_REASONS.some((r) => r.key === c.reason)) continue;
      out[id] = { at: c.at, by: String(c.by ?? ""), reason: c.reason as HandoffCloseReason, note: typeof c.note === "string" ? c.note : null, sig: c.sig, until: typeof c.until === "string" ? c.until : null };
    }
    return out;
  } catch {
    return {};
  }
}

/** Drop records older than CLOSED_KEEP_DAYS (in place). */
export function pruneClosedHandoffs(map: Record<string, ClosedHandoff>, now: Date): void {
  const cutoff = now.getTime() - CLOSED_KEEP_DAYS * 86_400_000;
  for (const [id, c] of Object.entries(map)) if (!(new Date(c.at).getTime() >= cutoff)) delete map[id];
}

/** The row as it reads now: its status, its open lines, what is missing and the exceptions. */
export function handoffSig(row: { status: string; lines: { label: string; tone: string }[]; missing: string[]; exceptions: string[] }): string {
  const s = [row.status, ...row.lines.filter((l) => l.tone !== "ok").map((l) => l.label), ...row.missing, ...row.exceptions].join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Closed out, and still reading as it did then (and, for a snooze, not yet due back). */
export function isClosedOut(row: { projectId: string; sig: string }, closed: Record<string, ClosedHandoff>, now: Date): boolean {
  const c = closed[row.projectId];
  if (!c || c.sig !== row.sig) return false;
  return !c.until || new Date(c.until).getTime() > now.getTime();
}
