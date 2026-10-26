// ---------------------------------------------------------------------------
// STRATEGY CALL NOTES FOR THE TOPIC BANK (Oct 26 2026). Pure: no database, no
// model, safe to import anywhere.
//
// Jordan: "the skits and topics need to be built around them and their
// content strategy and strategy calls that we have had." Until today the bank
// prompt read the strategy document, the client file's facts and the month's
// priorities, and nothing from the calls themselves.
//
// What it reads: each completed strategy or discovery call's Google "Notes by
// Gemini" export, the part ABOVE the "📖 Transcript" heading (a summary and a
// "Details" paragraph per subject), never the raw transcript below it. The
// newest CALL_NOTES_MAX_CALLS calls, newest first, each tidied (the note
// taker's boilerplate, the header with email addresses, the separators and
// the "Next steps" action items go) and capped at CALL_NOTES_MAX_WORDS. A call
// with no notes part is skipped. Between the tidy and the cap the caller runs
// the generation scrub (contentGeneration.scrubTranscriptForGeneration:
// confidential marks and facts, other clients' names).
// ---------------------------------------------------------------------------

export const CALL_NOTES_MAX_CALLS = 4;
export const CALL_NOTES_MAX_WORDS = 1200;

export type StrategyCallNotes = {
  /** The call's day (YYYY-MM-DD), when known. */
  dateISO: string | null;
  kind: "strategy" | "discovery";
  /** The tidied, scrubbed, capped notes. */
  notes: string;
};

const FULL_NOTES_RE = /^[^\S\n]*(?:📝\s*)?Full notes[^\S\n]*$/m;

/** Lines that are the note taker's furniture, not what was said. */
const DROP_LINE_RES: readonly RegExp[] = [
  /^(?:✍️\s*)?Quick notes$/i,
  /^(?:📝\s*)?Full notes$/i,
  /^Please rate\b/i,
  /^Want to see more\?/i,
  /^Tip: You can always access/i,
  /^You should review Gemini/i,
  /^How is the quality of these/i,
  /^(?:Invited|Attachments|Meeting records)\b/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // a header line carrying an email address
  /^[_\-\u2013\u2014=*\u00b7\s]{3,}$/, // a separator
  /^(?:Suggested )?next steps:?$/i,
  // An action item ("* [Jordan Spackman] Send Portal Link: ..."): who does what next is our process, not content.
  /^[*•-]?\s*\[[^\]]{2,60}\]\s/,
  /^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/, // a date on its own
];

/**
 * The notes of one call, tidied: from "Full notes" down when the export has
 * both the quick and the full notes (the quick ones repeat it, shorter), the
 * note taker's furniture out, blank runs folded.
 */
export function tidyCallNotes(notes: string): string {
  let t = (notes ?? "").replace(/\r\n?/g, "\n");
  const full = FULL_NOTES_RE.exec(t);
  if (full) t = t.slice(full.index + full[0].length);
  const kept = t.split("\n").map((l) => l.trim()).filter((l) => !l || !DROP_LINE_RES.some((re) => re.test(l)));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** At most `max` words, whole lines kept while they fit; a line that crosses the cap is cut there with " ...". */
export function capWords(text: string, max: number = CALL_NOTES_MAX_WORDS): string {
  const out: string[] = [];
  let used = 0;
  for (const line of (text ?? "").split("\n")) {
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length) { if (out.length) out.push(""); continue; }
    if (used + words.length <= max) { out.push(line); used += words.length; continue; }
    const room = max - used;
    if (room > 0) out.push(`${words.slice(0, room).join(" ")} ...`);
    break;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function wordCount(text: string): number {
  return (text ?? "").split(/\s+/).filter(Boolean).length;
}
