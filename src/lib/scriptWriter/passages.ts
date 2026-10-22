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

const STOP = new Set("about above after again against also among because been before being below between both but could does doing down during each every from further have having here hers herself himself into itself just like made make many more most much must myself never only other ought ours ourselves over same should some such than that their theirs them themselves then there these they this those through under until very want what when where which while whom will with would your yours yourself yourselves actually really thing things going know think said says video videos topic topics script scripts sellers seller buyers buyer home homes house houses real estate agent agents need needs".split(" "));

/** A word's rough stem: lower case, common endings off. Good enough to match "repairs" with "repair" and "pricing" with "price". */
export function stem(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ers", "ed", "es", "er", "ly", "s"]) {
    if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

/** The topic's search words: content words of four letters or more, stemmed, stop words out. */
export function topicKeywords(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    for (const w of (t ?? "").split(/[^A-Za-z0-9'’-]+/)) {
      const lw = w.toLowerCase();
      if (lw.length < 4 || STOP.has(lw)) continue;
      const s = stem(lw);
      if (s.length >= 4) seen.add(s);
    }
  }
  return [...seen];
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
 */
export function keywordWindows(lines: TranscriptLine[], keywords: string[], opts: { radius?: number; max?: number; maxChars?: number; minHits?: number } = {}): Window[] {
  const radius = opts.radius ?? 4, max = opts.max ?? 4, maxChars = opts.maxChars ?? 2400, minHits = opts.minHits ?? 2;
  const scored = lines.map((l) => ({ i: l.i, s: keywordHits(l.text, keywords) })).filter((x) => x.s >= minHits).sort((a, b) => b.s - a.s || a.i - b.i);
  const windows: { from: number; to: number; score: number }[] = [];
  for (const x of scored) {
    const from = Math.max(0, x.i - radius), to = Math.min(lines.length - 1, x.i + radius);
    const hit = windows.find((w) => from <= w.to + 1 && to >= w.from - 1);
    if (hit) { hit.from = Math.min(hit.from, from); hit.to = Math.max(hit.to, to); hit.score += x.s; }
    else windows.push({ from, to, score: x.s });
  }
  return windows
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.from - b.from)
    .map((w) => {
      let text = lines.slice(w.from, w.to + 1).map((l) => l.text).join("\n");
      if (text.length > maxChars) text = `${text.slice(0, maxChars)} ...`;
      return { from: w.from, to: w.to, time: lines[w.from]?.time ?? null, text, score: w.score };
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

/**
 * The passage with the lines around it, as one block of text: at least
 * `before` / `after` lines each side, and more (up to `maxLines`) while a side
 * holds under `minChars`, because a Gemini transcript is full of one-word
 * turns ("Right.", "Mhm.") and three of them are no context at all.
 */
export function contextAround(lines: TranscriptLine[], range: { first: number; last: number }, before = 3, after = 3, maxChars = 2200, minChars = 500, maxLines = 8): string {
  let from = Math.max(0, range.first - before), to = Math.min(lines.length - 1, range.last + after);
  const chars = (a: number, b: number) => lines.slice(a, b + 1).reduce((n, l) => n + l.text.length, 0);
  while (from > 0 && range.first - from < maxLines && chars(from, range.first - 1) < minChars) from--;
  while (to < lines.length - 1 && to - range.last < maxLines && chars(range.last + 1, to) < minChars) to++;
  // The lines around it never carry our internal talk (the passage's own lines are kept whole).
  const text = lines.slice(from, to + 1).filter((l) => (l.i >= range.first && l.i <= range.last) || !isInternalTalk(l.text)).map((l) => l.text).join("\n");
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
