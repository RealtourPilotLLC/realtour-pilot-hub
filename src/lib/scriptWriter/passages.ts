// ---------------------------------------------------------------------------
// CALL TRANSCRIPTS, READ AS PASSAGES (Oct 22 2026). Pure text handling for
// the script writer's retrieval: no database, no model.
//
// The writer used to see two to four quotes per topic, picked by an earlier
// pass to PROVE the client agreed to the topic ("Let's do that one."). Now the
// retrieval step reads the topic's call in full, and code:
//   · splits a Gemini transcript into timed, speaker-tagged lines;
//   · finds the passages the model quotes, VERBATIM, in the source (a quote
//     that is not in the call is dropped, never trusted) and returns the lines
//     around each one, so a passage is never cut one sentence short again;
//   · ranks windows of OLDER transcripts by the topic's words, so earlier calls
//     on the same subject are read without loading every call ever held;
//   · holds back a passage that is plainly internal talk (our billing, the
//     schedule, production logistics) whatever the model said about it.
// ---------------------------------------------------------------------------

export type TranscriptLine = { i: number; text: string; time: string | null; speaker: string | null };

const TIME_ONLY_RE = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const INLINE_TIME_RE = /\((\d{1,2}:\d{2}(?::\d{2})?)\)/;
const SPEAKER_RE = /^\s*([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3})\s*:\s+(.*)$/;

/** Split a transcript into lines carrying the last timestamp seen and the speaker label, when there is one. */
export function segmentTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let time: string | null = null;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const only = TIME_ONLY_RE.exec(t);
    if (only) { time = only[1]; continue; }
    const inline = INLINE_TIME_RE.exec(t);
    const sp = SPEAKER_RE.exec(t);
    out.push({ i: out.length, text: t, time: inline ? inline[1] : time, speaker: sp ? sp[1] : null });
  }
  return out;
}

// Oct 22 2026 (the listening fix): the generic words that matched anything in
// an older call ("make", "work", "client", "time", "look", "talk" ...) are
// stop words too, checked on the stem as well as the word.
const STOP = new Set(("about above after again against also among because been before being below between both but could does doing down during each every from further have having here hers herself himself into itself just like made make many more most much must myself never only other ought ours ourselves over same should some such than that their theirs them themselves then there these they this those through under until very want what when where which while whom will with would your yours yourself yourselves actually really thing things going know think said says video videos topic topics script scripts sellers seller buyers buyer home homes house houses real estate agent agents need needs "
  + "work works worked working client clients people person time times even still look looks looking good great find found talk talking line lines life type today used happen happened happens moment original kind sort little maybe yeah okay right well lots come came back sure stuff gonna wanna mean means pretty definitely probably everything something anything nothing someone everyone always gets getting give gives given take takes taking tell telling told year years making coming saying wanted were didn doesn wasn aren couldn wouldn shouldn haven hasn your youre there").split(" "));
const STOP_STEMS = new Set([...STOP].map((w) => stemOf(w)));

function stemOf(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ers", "ed", "es", "er", "ly", "s"]) {
    if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

/** A word's rough stem: lower case, common endings off. Good enough to match "repairs" with "repair" and "pricing" with "price". */
export function stem(w: string): string {
  return stemOf(w);
}

/** A content word's stem, or null for a stop word or one too short to search by. Split the way keywordHits splits. */
function contentStem(w: string): string | null {
  const lw = w.toLowerCase();
  if (lw.length < 4 || STOP.has(lw)) return null;
  const s = stemOf(lw);
  return s.length >= 4 && !STOP_STEMS.has(s) ? s : null;
}

/** The topic's search words: content words of four letters or more, stemmed, stop words out. */
export function topicKeywords(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    // The same split as keywordHits ("first-time" is two words there, so it is two here).
    for (const w of (t ?? "").split(/[^A-Za-z0-9]+/)) {
      const s = contentStem(w);
      if (s) seen.add(s);
    }
  }
  return [...seen];
}

/**
 * The words to look for HER on this subject in her older calls (Oct 22 2026,
 * the listening fix): the topic's title and her own words in the passages
 * already found on the topic's call (the lines around them carry the
 * interviewer's question), plus anything else of hers (the call analysis's
 * quotable lines, her written answers). Never the AI-written description or
 * intended message: their generic words matched notes headers and unrelated
 * talk, and her real words ("retirement community", "inspection", "neighbor")
 * were not among them.
 *
 * Weighted: a title word 3, a word in her quote 2 (once per passage), a word in
 * the lines around it or in her other words 1. A word needs 2 to count; the
 * heaviest `max` are kept.
 */
export function herKeywords(o: { title: string; passages: { quote: string; context?: string | null }[]; herWords?: (string | null | undefined)[]; max?: number }): string[] {
  const weight = new Map<string, number>();
  // Speaker labels and inline times are not words she said: "Marcee McMullen:" on every
  // line of context would make her own name a keyword that matches every line she speaks.
  const spoken = (text: string | null | undefined) => (text ?? "").split(/\r?\n/).map((l) => l.replace(SPEAKER_RE, "$2").replace(INLINE_TIME_RE, " ")).join("\n");
  const add = (text: string | null | undefined, w: number) => {
    const once = new Set<string>();
    for (const word of spoken(text).split(/[^A-Za-z0-9]+/)) {
      const s = contentStem(word);
      if (s) once.add(s);
    }
    for (const s of once) weight.set(s, (weight.get(s) ?? 0) + w);
  };
  add(o.title, 3);
  for (const p of o.passages) {
    add(p.quote, 2);
    add(p.context, 1);
  }
  for (const h of o.herWords ?? []) add(h, 1);
  return [...weight.entries()].filter(([, w]) => w >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, o.max ?? 28).map(([k]) => k);
}

/**
 * A Gemini export from the "Transcript" heading down (Oct 22 2026): the notes
 * above it are a reader's summary, and in an older call they matched the
 * topic's words better than her own lines did (every "older call" window the
 * seniors test read was a notes header). A text without the heading is
 * returned whole.
 */
export function transcriptBody(text: string): string {
  const t = text ?? "";
  const m = TRANSCRIPT_HEADING_RE.exec(t);
  if (!m) return t;
  return t.slice(m.index + m[0].length).replace(/^\s+/, "");
}

/** The "📖 Transcript" line of a Gemini export: the notes are above it, the raw transcript below. */
const TRANSCRIPT_HEADING_RE = /^[^\S\n]*(?:📖\s*)?Transcript[^\S\n]*$/m;

/**
 * The other half (Oct 26 2026): a Gemini export's NOTES, the summary and the
 * per-topic "Details" above the "Transcript" heading. The topic bank reads
 * these (contentPolicy/callNotes.ts), not the raw transcript. Null when the
 * text has no heading (a pasted transcript, no notes) or nothing above it.
 */
export function transcriptNotes(text: string): string | null {
  const t = text ?? "";
  const m = TRANSCRIPT_HEADING_RE.exec(t);
  if (!m) return null;
  const notes = t.slice(0, m.index).trim();
  return notes || null;
}

/** How many of the keywords a text mentions (each counted once). */
export function keywordHits(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const words = new Set(text.split(/[^A-Za-z0-9]+/).map(stem).filter(Boolean));
  return keywords.filter((k) => words.has(k)).length;
}

export type Window = { from: number; to: number; time: string | null; text: string; score: number };

/**
 * The best windows of a long transcript for these keywords: each line scored
 * by its hits, a window of `radius` lines around each strong line, overlaps
 * merged, the top `max` returned in transcript order, each at most `maxChars`.
 *
 * Oct 22 2026 (the listening fix): a window over `maxChars` is cut AROUND its
 * best line (the line with the most hits), not from its start: the old cut
 * kept the first 2,200 characters and lost the line that matched. Its time is
 * the best line's.
 */
export function keywordWindows(lines: TranscriptLine[], keywords: string[], opts: { radius?: number; max?: number; maxChars?: number; minHits?: number } = {}): Window[] {
  const radius = opts.radius ?? 4, max = opts.max ?? 4, maxChars = opts.maxChars ?? 2400, minHits = opts.minHits ?? 2;
  const scored = lines.map((l) => ({ i: l.i, s: keywordHits(l.text, keywords) })).filter((x) => x.s >= minHits).sort((a, b) => b.s - a.s || a.i - b.i);
  const windows: { from: number; to: number; score: number; best: number; bestS: number }[] = [];
  for (const x of scored) {
    const from = Math.max(0, x.i - radius), to = Math.min(lines.length - 1, x.i + radius);
    const hit = windows.find((w) => from <= w.to + 1 && to >= w.from - 1);
    if (hit) { hit.from = Math.min(hit.from, from); hit.to = Math.max(hit.to, to); hit.score += x.s; }
    else windows.push({ from, to, score: x.s, best: x.i, bestS: x.s });
  }
  return windows
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.from - b.from)
    .map((w) => {
      let from = w.from, to = w.to;
      const len = (a: number, b: number) => lines.slice(a, b + 1).reduce((n, l) => n + l.text.length + 1, 0);
      if (len(from, to) > maxChars) {
        // Grow outward from the best line, one line each side in turn, while it fits.
        from = to = w.best;
        let grew = true;
        while (grew) {
          grew = false;
          if (from > w.from && len(from - 1, to) <= maxChars) { from--; grew = true; }
          if (to < w.to && len(from, to + 1) <= maxChars) { to++; grew = true; }
        }
      }
      let text = lines.slice(from, to + 1).map((l) => l.text).join("\n");
      if (text.length > maxChars) text = `${text.slice(0, maxChars)} ...`;
      return { from, to, time: lines[w.best]?.time ?? lines[from]?.time ?? null, text, score: w.score };
    });
}

const tokens = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9']+/).filter(Boolean);

/**
 * Where a quoted passage sits in the transcript, as a line range, or null
 * when it is not there. The model's quote must be the source's own words:
 * its first six and last four words found in order within a span not much
 * longer than the quote (an ellipsis the model put in the middle is allowed).
 */
export function locateQuote(lines: TranscriptLine[], quote: string): { first: number; last: number } | null {
  const q = tokens(quote);
  if (q.length < 4) return null;
  const flat: { t: string; line: number }[] = [];
  for (const l of lines) for (const t of tokens(l.text)) flat.push({ t, line: l.i });
  const head = q.slice(0, Math.min(6, q.length));
  const tail = q.slice(Math.max(head.length, q.length - 4));
  const maxSpan = Math.round(q.length * 1.6) + 12;
  for (let s = 0; s + head.length <= flat.length; s++) {
    if (!head.every((t, k) => flat[s + k]?.t === t)) continue;
    if (!tail.length) return { first: flat[s].line, last: flat[s + head.length - 1].line };
    const limit = Math.min(flat.length, s + maxSpan);
    for (let e = s + head.length; e + tail.length <= limit; e++) {
      if (tail.every((t, k) => flat[e + k]?.t === t)) return { first: flat[s].line, last: flat[e + tail.length - 1].line };
    }
  }
  return null;
}

/** "Mhm.", "Right.", "Yeah, absolutely." : a listener's short reply that does not end the speaker's turn. */
export function isInterjection(l: TranscriptLine | undefined): boolean {
  if (!l) return false;
  const said = l.speaker ? l.text.slice(l.text.indexOf(":") + 1).trim() : l.text.trim();
  return said.length <= 30 && said.split(/\s+/).length <= 5;
}

/**
 * The passage with the lines around it, as one block of text.
 *   before: at least `before` lines, more (up to `maxLines`) while that side
 *     holds under `minChars` (a Gemini transcript is full of one-word turns),
 *     so the question she was answering is there;
 *   after (Oct 22 2026, v2.1): her thought is FINISHED first: her lines
 *     continue through the listener's "Mhm." / "Right." up to the next
 *     substantial turn by someone else, and that following turn is included
 *     with the start of her answer to it. The seniors retro test lost its central line
 *     ("every bit as scary ... as a senior moving out of a home ... sixty
 *     years") because the passage stopped one sentence before it.
 */
export function contextAround(lines: TranscriptLine[], range: { first: number; last: number }, before = 3, after = 3, maxChars = 3500, minChars = 500, maxLines = 8): string {
  let from = Math.max(0, range.first - before), to = Math.min(lines.length - 1, range.last + after);
  const chars = (a: number, b: number) => lines.slice(a, b + 1).reduce((n, l) => n + l.text.length, 0);
  while (from > 0 && range.first - from < maxLines && chars(from, range.first - 1) < minChars) from--;
  while (to < lines.length - 1 && to - range.last < maxLines && chars(range.last + 1, to) < minChars) to++;
  const who = lines[range.last]?.speaker ?? null;
  if (who) {
    // Finish her thought: her own lines and the listener's interjections.
    let k = range.last + 1;
    while (k < lines.length && k - range.last <= 24 && (lines[k].speaker === who || isInterjection(lines[k]) || !lines[k].speaker)) k++;
    // The following turn (someone else's substantial line) and the start of her answer to it (two lines at most).
    if (k < lines.length && k - range.last <= 24) {
      k++;
      const stop = k + 2;
      while (k < lines.length && k < stop && (lines[k].speaker === who || isInterjection(lines[k]))) k++;
    }
    to = Math.max(to, Math.min(lines.length - 1, k - 1));
  }
  // The lines around it never carry our internal talk (the passage's own lines are kept whole).
  const around = (a: number, b: number) => lines.slice(a, b).filter((l) => !isInternalTalk(l.text)).map((l) => l.text);
  const ahead = around(from, range.first);
  const mid = lines.slice(range.first, range.last + 1).map((l) => l.text);
  const behind = around(range.last + 1, to + 1);
  const join = () => [...ahead, ...mid, ...behind].join("\n");
  // Over the limit: the lines BEFORE give way first; the finished thought after it is what matters.
  let text = join();
  while (text.length > maxChars && ahead.length > 1) { ahead.shift(); text = join(); }
  return text.length > maxChars ? `${text.slice(0, maxChars)} ...` : text;
}

/**
 * Plainly internal talk: our billing and contract, the schedule, the
 * production line. A passage whose own words match is never a source for a
 * script, whatever the model said about it (the context around it may be).
 */
// Words a real estate conversation also uses ("payment", "under contract",
// "schedule a showing") are deliberately NOT here: a buyer's monthly payment
// is script material. These are about OUR work with the client.
export const INTERNAL_TALK_RE = /\b(?:invoice[sd]?|billing|bill(?:ed)? (?:you|me)|refund|retainer|reschedul(?:e|ed|ing)|calendly|next (?:strategy )?(?:call|session|shoot)|shoot day|filming day|editors?|editing team|upload(?:ed|ing)?|dropbox|the portal|turnaround|raw (?:files|footage)|b-roll|teleprompter|realtour pilot)\b/i;

export function isInternalTalk(text: string): boolean {
  return INTERNAL_TALK_RE.test(text);
}

/** "01:09:23" from a line range's first timed line. */
export function timeOf(lines: TranscriptLine[], range: { first: number; last: number }): string | null {
  for (let i = range.first; i >= 0 && i >= range.first - 40; i--) if (lines[i]?.time) return lines[i].time;
  return null;
}
