// ---------------------------------------------------------------------------
// "SCRIPT NOT APPROVED BY THE CLIENT YET", ANSWERED ON THE UPLOAD PAGE (Jordan,
// Oct 27 2026, on the editor's brief: "The editor does not need to know, this
// should be addressed in the upload portal ... prompt the person uploading to
// confirm that's what they filmed, if it's not already confirmed elsewhere.
// And I mean, if they filmed it, and it's uploaded, then it's approved. Unless
// ... the creative changed the script in the upload portal.").
//
// A content-session topic ticked as filmed whose script the client has not
// signed off asks the uploader for one answer: "I filmed this script as
// written", or "I changed it on site" and what changed. The answer is recorded
// ON THE UPLOAD, as a line on that topic's note to the editor (the note rides
// the filming report, the draft and the reopened page exactly as it always
// has, so no new column), e.g.
//
//   C0012 to C0015, use the second take.
//   Script: filmed as written.
//
//   Script changed on site: she dropped the stat about rates.
//
// It never edits the script itself, and never writes the client's approval:
// a script already shared with a client is the client's (lib/scriptFilmed:
// filmed means the client is no longer asked about it).
//
// Pure and client-safe.
// ---------------------------------------------------------------------------

export type TopicScriptChoice = "as-written" | "changed";

export const SCRIPT_AS_WRITTEN_LINE = "Script: filmed as written.";
export const SCRIPT_CHANGED_PREFIX = "Script changed on site: ";
/** The topic note's own cap (upload/actions.ts and filmedTopics keep 1000 characters). */
export const TOPIC_NOTE_CAP = 1000;

const CHANGED_RE = /^\s*Script changed on site:\s?/i;

/**
 * The note's own words, and the script answer it carries (null = none
 * recorded). The answer is the note's LAST line; the words before it come
 * back exactly as typed (a trailing space or new line is kept), so the page
 * can split and join on every keystroke.
 */
export function splitTopicScriptNote(note: string | null | undefined): { note: string; choice: TopicScriptChoice | null; changed: string } {
  const text = note ?? "";
  const cut = text.lastIndexOf("\n");
  const last = text.slice(cut + 1);
  const before = cut >= 0 ? text.slice(0, cut) : "";
  if (last.trim().toLowerCase() === SCRIPT_AS_WRITTEN_LINE.toLowerCase()) return { note: before, choice: "as-written", changed: "" };
  if (CHANGED_RE.test(last)) return { note: before, choice: "changed", changed: last.replace(CHANGED_RE, "") };
  return { note: text, choice: null, changed: "" };
}

/** The note as it is saved: the photographer's words, then the script answer on its own last line. */
export function joinTopicScriptNote(note: string, choice: TopicScriptChoice | null, changed = ""): string {
  const own = splitTopicScriptNote(note).note;
  const line = choice === "as-written" ? SCRIPT_AS_WRITTEN_LINE : choice === "changed" ? `${SCRIPT_CHANGED_PREFIX}${changed.replace(/[\r\n]+/g, " ")}` : "";
  if (!line) return own;
  // The answer is kept whole: the photographer's own words give way first.
  const head = own.slice(0, Math.max(0, TOPIC_NOTE_CAP - line.length - 1));
  return head ? `${head}\n${line}` : line;
}

/** What a topic still needs before the video can go (null = nothing): the photographer's words. */
export function topicScriptProblem(input: { title: string; choice: TopicScriptChoice | null; changed: string }): string | null {
  if (!input.choice) return `confirm the script for “${input.title}” (filmed as written, or what changed on site)`;
  if (input.choice === "changed" && !input.changed.trim()) return `what changed on site in the script for “${input.title}”`;
  return null;
}

/**
 * Does this topic ask? Only a ticked topic with a script the client has not
 * signed off, that nobody has confirmed as filmed yet (a confirmation made
 * elsewhere, by the office or at another session, is not asked twice).
 */
export function asksScriptConfirm(t: { scriptTitle: string | null; clientApproved: boolean; filmedConfirmedAtISO: string | null }, ticked: boolean): boolean {
  return ticked && !!t.scriptTitle && !t.clientApproved && !t.filmedConfirmedAtISO;
}
