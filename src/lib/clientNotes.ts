// ---------------------------------------------------------------------------
// THE customer note — one list, read the same way on every screen.
//
// Jordan, Sep 2: "if we add customer notes to the hub it should save to the
// customer notes in Aryeo — I just want to make sure we don't have different
// customer notes in different spots."
//
// `Client.generalNotes` IS that note: a mirror of the Aryeo customer's
// `internal_notes`, written (and pushed back to Aryeo) by saveCustomerNotes.
// `Client.editingPreferences` is the older hub-only editing note. When the two
// notes cards were merged it lost its writer, and every creative surface kept
// reading it — a live probe on Sep 2 found it NULL on all 349 clients while 17
// carried a real generalNotes ("Always add his animated logo on his videos",
// "add his logo and phone number to every video", "step back further to capture
// wider angles"), i.e. exactly the instructions the reader needed. So the note
// the office writes now reaches the people who do the work, through here.
//
// The legacy column is still read as a FALLBACK, and appended when a row
// somehow has both (a dedupe merge or a restore can resurrect one), so no note
// anyone wrote can be silently hidden. Nothing writes it any more — one note,
// one writer, one system of record.
//
// Pure on purpose: the QC card and the shoot screen are client-render paths, so
// this module must not pull in server-only code. `noteToText` is the display
// twin of `notesHtmlToText` in src/lib/integrations/aryeo.ts (that file is
// `import "server-only"`); keep the two in step if either changes.
// ---------------------------------------------------------------------------

import { stripMoneySentences } from "@/lib/text";

export type ClientNoteFields = {
  /** The merged customer note (mirrors Aryeo `internal_notes`). */
  generalNotes?: string | null;
  /** Legacy hub-only editing note. Read-only — no writer since the merge. */
  editingPreferences?: string | null;
};

// Aryeo's notes editor stores rich text; anything typed in the hub box is plain.
const NOTE_TAGS = "div|p|br|span|strong|b|em|i|u|ul|ol|li|h[1-6]|a|blockquote|table|tbody|tr|td|font|hr|img";
const looksHtml = (s: string) =>
  new RegExp(`<\\/?(?:${NOTE_TAGS})\\b[^>]*>|&(?:nbsp|amp|lt|gt|quot|apos|#\\d+);`, "i").test(s);

// Provenance lines the hub wrote INTO the note (the Content Program backfill
// stamps one on every client it created — 7 of the 17 notes on file are nothing
// but that line). They say nothing about the work, so they never reach a
// creative screen; the same de-noising /edit already does for machine-written
// Review Room notes. A real note appended under one still shows.
const MACHINE_LINE = /^created by [^\n]*\b(backfill|import|sync)\b/i;

/** Aryeo rich text → plain text for display. Plain text passes through. */
export function noteToText(value?: string | null): string {
  if (!value) return "";
  const s = looksHtml(value)
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        // Bullets open the line; the closing </li> falls to the generic strip
        // below, or every list item would come out double-spaced.
        .replace(/<li[^>]*>/gi, "\n• ")
        .replace(/<\/(?:div|p|h[1-6]|tr|ul|ol|blockquote)>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        // Entities last, and `&amp;` LAST of all — decoding it first would turn
        // a literal "&lt;" somebody typed into a real tag.
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
    : value.replace(/\r\n?/g, "\n");
  return s
    .split("\n")
    .filter((line) => !MACHINE_LINE.test(line.trim()))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The customer note for a client, as plain text — or null when there is none.
 * generalNotes is the note; editingPreferences is the retired column, read only
 * as a fallback (and appended, never dropped, on a row that has both).
 */
export function customerNote(client?: ClientNoteFields | null): string | null {
  if (!client) return null;
  const merged = noteToText(client.generalNotes);
  const legacy = noteToText(client.editingPreferences);
  if (!merged) return legacy || null;
  if (!legacy) return merged;
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  return norm(merged).includes(norm(legacy)) ? merged : `${merged}\n${legacy}`;
}

/**
 * The same note for a screen that must never show pricing (photographers,
 * editors). Scrubbed LINE BY LINE so a bulleted note keeps its shape instead of
 * collapsing into one paragraph; a note that was nothing but money comes back
 * null rather than as an empty block.
 */
export function scrubNoteMoney(note: string | null): string | null {
  if (!note) return null;
  const lines: string[] = [];
  for (const line of note.split("\n")) {
    if (!line.trim()) { lines.push(""); continue; }
    const kept = stripMoneySentences(line);
    // A line that was nothing but money vanishes — leaving the empty line would
    // punch a visible hole in a bulleted note.
    if (kept) lines.push(kept);
  }
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || null;
}

/** Convenience: the customer note as a creative may see it. */
export function creativeCustomerNote(client?: ClientNoteFields | null): string | null {
  return scrubNoteMoney(customerNote(client));
}
