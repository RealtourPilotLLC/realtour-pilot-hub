// ---------------------------------------------------------------------------
// EDIT AND DELETE A REVIEW ROOM NOTE: the pure part (Jordan, Oct 28 2026: "we
// need to be able to delete revision notes in the review room and also edit
// them"). Who may change a note, the words the editor is told, and the line on
// the edit card. No database and no server-only imports, so the screens and
// the drill read the exact same answers lib/noteEdits acts on.
// ---------------------------------------------------------------------------

/** How long after a delete the note can be put back (the panel's Undo). */
export const NOTE_UNDO_HOURS = 24;

/** Roles that may change ANY staff note on a cut: the owner, the office and the creative manager. */
export const NOTE_DESK_ROLES = ["OWNER", "ADMIN", "CREATIVE_MANAGER"] as const;

export type NoteChanger = {
  /** the login's own role (never a "view as" role) */
  realRole: string;
  impersonating: boolean;
  userId: string | null;
  /** the keys this login writes notes under (lib/review sessionAuthor): editor:<key>, tm:<id>, owner, user:<id> */
  authorKeys: string[];
};

/**
 * May this person change (edit or delete) this staff note? The note's author,
 * by login id or by the key their notes are written under, plus the owner, the
 * office and the creative manager on any staff note. A "view as" preview
 * changes nothing, the same rule every other write in the Review Room keeps.
 */
export function mayChangeNote(who: NoteChanger | null, note: { authorKey: string | null; authorUserId: string | null }): boolean {
  if (!who || who.impersonating) return false;
  if ((NOTE_DESK_ROLES as readonly string[]).includes(who.realRole)) return true;
  if (who.userId && note.authorUserId && who.userId === note.authorUserId) return true;
  return !!note.authorKey && who.authorKeys.includes(note.authorKey);
}

/** A client's portal note: only the desk may hold it back or change what the editor gets. */
export function mayCorrectClientNote(who: NoteChanger | null): boolean {
  return !!who && !who.impersonating && (NOTE_DESK_ROLES as readonly string[]).includes(who.realRole);
}

export const clock = (t: number | null | undefined): string =>
  t == null ? "" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** The bullet requestCutChanges writes for a note on the edit card ("• [0:14] words"). */
export function cardBullet(timeSec: number | null, body: string): string {
  return `• ${timeSec == null ? "" : `[${clock(timeSec)}] `}${body.trim()}`;
}

/**
 * Change one note's bullet on the edit card's round text. The bullet may carry
 * its author (" — Kyle Smith", reviewAttribution.attributeLines), which is
 * kept. Returns null when the bullet is not there (a card trimmed to its last
 * 4,000 characters, or a round written before the note): the card is then left
 * as it is, and the editor's list and bell still say what changed.
 */
export function replaceCardBullet(description: string, oldBullet: string, newBullet: string): string | null {
  // Whole bullet only: it starts a line, and the next character ends the line,
  // starts an author suffix, or ends the text. Never the start of a longer
  // note ("• [0:12] Music" inside "• [0:12] Music is too loud").
  for (let at = description.indexOf(oldBullet); at !== -1; at = description.indexOf(oldBullet, at + 1)) {
    const end = at + oldBullet.length;
    const next = description.slice(end, end + 3);
    const starts = at === 0 || description[at - 1] === "\n";
    if (starts && (next === "" || next.startsWith("\n") || next.startsWith(" — "))) return description.slice(0, at) + newBullet + description.slice(end);
  }
  return null;
}

/** "Round 2 — 3 notes to fix (…)": the count on the card's summary moved by `delta`. */
export function bumpRoundCount(summary: string, delta: number): string {
  return summary.replace(/^(Round \d+ — )(\d+) notes? to fix/, (_m, head: string, n: string) => {
    const next = Math.max(0, Number(n) + delta);
    return `${head}${next} note${next === 1 ? "" : "s"} to fix`;
  });
}

const short = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * The one short line the editor is told when a note they already have changes
 * (their bell, and the line under the item on their list). Plain words, no
 * dashes. `at` is the time words (lib/reviewAttribution whenET).
 */
export function editorChangeLine(c: {
  action: "EDITED" | "DELETED" | "RESTORED" | "REWORDED" | "REMOVED";
  by: string;
  timeSec: number | null;
  before: string | null;
  after: string | null;
  wasFixed?: boolean;
}): string {
  const who = firstName(c.by);
  const where = c.timeSec == null ? "a note" : `the note at ${clock(c.timeSec)}`;
  switch (c.action) {
    case "EDITED":
      return `${who} changed ${where}. It now says: "${short(c.after ?? "")}"${c.wasFixed ? ". You had marked it fixed, so it is open again." : "."}`;
    case "DELETED":
      return `${who} deleted ${where} ("${short(c.before ?? "", 80)}"). Nothing to do for it${c.wasFixed ? ", and your fix can stay" : ""}.`;
    case "RESTORED":
      return `${who} put back ${where}: "${short(c.after ?? "", 80)}".`;
    case "REWORDED":
      return `${who} changed how the client's note reads for you. It now says: "${short(c.after ?? "")}".`;
    case "REMOVED":
      return `${who} took the client's note off your list ("${short(c.before ?? "", 80)}"). Nothing to do for it.`;
  }
}

export type EditorBellAction = "EDITED" | "DELETED" | "RESTORED" | "REWORDED" | "REMOVED" | "REWORD_UNDONE" | "REMOVE_UNDONE";

/**
 * The editor's bell TITLE for a changed note. An editor's bell row carries no
 * body (lib/notify's money clamp drops it for creatives) and their Slack/text
 * bridge sends the title, so the one line they are told IS the title: who,
 * which note, which job, and whether there is anything to do. 90 characters
 * at most (the bell's limit); the street goes first when it would not fit.
 */
export function editorBellTitle(c: { action: EditorBellAction; by: string; timeSec: number | null; wasFixed?: boolean }, street: string): string {
  const who = firstName(c.by);
  const at = c.timeSec == null ? "a note" : `the note at ${clock(c.timeSec)}`;
  const parts: Record<EditorBellAction, [string, string]> = {
    EDITED: [`${who} changed ${at}`, c.wasFixed ? ", open again" : ""],
    DELETED: [`${who} deleted ${at}`, ": nothing to do"],
    RESTORED: [`${who} put back ${at}`, ""],
    REWORDED: [`${who} reworded a client note`, ""],
    REMOVED: [`${who} took a client note off your list`, ""],
    REWORD_UNDONE: [`${who} put a client's own words back`, ""],
    REMOVE_UNDONE: [`${who} put a client note back on your list`, ""],
  };
  const [head, tail] = parts[c.action];
  const full = `${head} on ${street}${tail}`;
  return full.length <= 90 ? full : `${head}${tail}`.slice(0, 90);
}

/** The bullet a deleted note leaves on the edit card, so the round text never contradicts the list. */
export function deletedBullet(timeSec: number | null, body: string, by: string, when: string): string {
  return `${cardBullet(timeSec, `(deleted by ${firstName(by)}, ${when}, nothing to do) ${body}`)}`;
}

/** The bullet an edited note leaves on the edit card. */
export function editedBullet(timeSec: number | null, body: string, by: string, when: string): string {
  return cardBullet(timeSec, `${body.trim()} (changed by ${firstName(by)}, ${when})`);
}

/** The words a corrected client note goes to the editor with: staff's wording, the client's words beside it. */
export function correctedClientLine(corrected: string, original: string, by: string): string {
  return `${corrected.trim()} (worded by ${firstName(by)}. The client wrote: "${short(original, 300)}")`;
}

/** Is a delete still within its Undo window? `now` is the caller's (the server's): this module is shared with client components, which never read the clock here. */
export function undoOpen(at: Date | string, now: Date): boolean {
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  return now.getTime() - t < NOTE_UNDO_HOURS * 3_600_000;
}
