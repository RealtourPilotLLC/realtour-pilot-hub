// ---------------------------------------------------------------------------
// WHOSE NAME IS "ANOTHER CLIENT", AND WHAT A TURN IS (Oct 22 2026, the
// listening fix). Pure: no database, no model, so the generators
// (contentGeneration.scrubOtherClients / scrubTranscriptForGeneration /
// otherClientScrubbers) and the drills read one rule.
//
// THE BUG. The other-client filter dropped every line naming another enrolled
// client by full name or first two words. "Jordan Spackman TEST" (the §16 test
// account, enrolled Sep 22 2026) put "Jordan Spackman" on that list, so every
// line Jordan said was deleted from every call of every client: on Marcee's
// Oct 15 call all 262 of his lines (his questions, how he framed each topic),
// and on transcripts exported before mid-2026, where Gemini ran both speakers
// together on one stored line, the whole conversation (her Jan 26 call reached
// the writer as 27 lines of Gemini's notes). The live writer, the call-based
// quotable lines, the strategy drafter and the new writer all read through it.
//
// THE RULE NOW.
//   · a test client (testClients.isSyntheticClientRow: the TEST word, never a
//     never-synthetic id) is never "another client": it is not a person;
//   · a member of staff (TeamMember / AppUser names, and Jordan and the company
//     name as a backstop) is never "another client", even when a client row
//     carries the same name (the two real "Jordan Spackman" rows are Jordan);
//   · a transcript is judged per SPEAKER TURN, not per stored line: a line that
//     holds several "Name: ..." turns is split, and only the turn that names a
//     real other client goes. The kept turns come out one per line.
// ---------------------------------------------------------------------------

import { isSyntheticClientRow } from "../testClients";

/** Names that are always the house, whatever the staff tables hold. */
export const HOUSE_NAMES: readonly string[] = ["Jordan Spackman", "Realtour Pilot", "RealTour Pilot"];

const squash = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The names a client's lines are scrubbed of: every OTHER enrolled client's
 * full name and its first two words, never a test client's and never a name
 * that is a member of staff's (full name or first two words).
 */
export function namesToScrub(clients: { id?: string | null; name: string | null }[], staffNames: readonly (string | null | undefined)[] = []): string[] {
  const staff = new Set<string>();
  for (const s of [...staffNames, ...HOUSE_NAMES]) {
    const n = squash(s);
    if (!n) continue;
    staff.add(n);
    const w = n.split(" ");
    if (w.length >= 2) staff.add(`${w[0]} ${w[1]}`);
  }
  const out: string[] = [];
  for (const c of clients) {
    if (isSyntheticClientRow({ id: c.id ?? null, name: c.name })) continue;
    const n = (c.name ?? "").trim().replace(/\s+/g, " ");
    const w = n.split(" ");
    if (w.length < 2) continue;
    for (const cand of [n, `${w[0]} ${w[1]}`]) if (cand.length >= 5 && !staff.has(squash(cand))) out.push(cand);
  }
  return [...new Set(out)];
}

/** One regex over the names (whole words, any case), or null when there are none. */
export function namesRegex(names: readonly string[]): RegExp | null {
  if (!names.length) return null;
  return new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");
}

const LINE_START_LABEL_RE = /^\s*([A-Z][A-Za-z'’-]*(?: [A-Z][A-Za-z'’-]*){0,3})\s*:\s/;
// Two to four capitalised words and a colon, anywhere: Gemini's older exports
// glue the next speaker straight on ("Okay.Marcee McMullen: New clients.").
const INLINE_LABEL_RE = /([A-Z][a-z'’-]+(?: [A-Z][A-Za-z'’-]+){1,3}):\s/g;

/**
 * The speaker labels a transcript uses: a label that starts two or more lines,
 * or a two-to-four-word name followed by a colon three or more times anywhere.
 * A one-off "Step Two:" or "Note:" is not a speaker.
 */
export function speakerLabels(text: string): string[] {
  const atStart = new Map<string, number>();
  const inline = new Map<string, number>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = LINE_START_LABEL_RE.exec(line);
    if (m) atStart.set(m[1], (atStart.get(m[1]) ?? 0) + 1);
    for (const x of line.matchAll(INLINE_LABEL_RE)) inline.set(x[1], (inline.get(x[1]) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [k, n] of atStart) if (n >= 2) out.add(k);
  for (const [k, n] of inline) if (n >= 3) out.add(k);
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * A stored line as speaker turns: split wherever a known label and its colon
 * begin (even glued onto the word before it). A line with one turn, or no
 * label, comes back whole.
 */
export function splitTurns(line: string, labels: readonly string[]): string[] {
  if (!labels.length) return [line];
  const re = new RegExp(`(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*:`, "g");
  const cuts: number[] = [];
  for (const m of line.matchAll(re)) if (m.index! > 0 && line.slice(0, m.index).trim()) cuts.push(m.index!);
  if (!cuts.length) return [line];
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) {
    const piece = line.slice(from, c).trim();
    if (piece) out.push(piece);
    from = c;
  }
  const last = line.slice(from).trim();
  if (last) out.push(last);
  return out;
}
