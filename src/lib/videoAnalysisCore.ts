// ---------------------------------------------------------------------------
// VIDEO ANALYSIS, THE PURE HALF (Jordan, Oct 23 2026). Covers for Instagram and
// an on-screen spelling check on trial, read by Google Gemini (lib/integrations/
// gemini.ts) and driven by lib/videoAnalysis.ts. Everything here is pure: the
// words, the prompts, the answer schemas, which readings may become a flag,
// which moments become the three covers, the free-tier arithmetic. The drill
// and the driver call the same functions.
//
// Jordan's rule for the spelling check, in his words: "I don't want to flag
// too much though and if it's not accurate I don't know if I want to do it."
// So a flag needs ALL of:
//   (a) the text was read clearly: two readings that agree, and a confidence
//       of at least READ_CONFIDENCE_MIN;
//   (b) the word is one we know the right spelling of: a name on the client's
//       "Spell these exactly" list (lib/spellList), the listing's address, or
//       a word straight from the script, never Deepgram's transcript (it can
//       mishear names; it is used only for WHEN a line is spoken);
//   (c) what is on screen does not match it, by a small, typo-sized margin
//       (an unrelated word is not a misspelling of anything).
// Unreadable text and unknown words are never flagged, a caption that follows
// what was SAID instead of the script (an extra "s", "-ing") is not a
// misspelling, and at most MAX_FLAGS reach Jordan per video.
// ---------------------------------------------------------------------------

// ---- free tier and settings --------------------------------------------------

export const FPS_MIN = 1;
export const FPS_MAX = 5;
export const FPS_DEFAULT = 2;
/** Model requests a Pacific day (the free tier's per-day quota resets at midnight Pacific). About 2 a video version. */
export const DAILY_CAP_DEFAULT = 40;
export const DAILY_CAP_MAX = 500;
/** media-resolution page, Gemini 3/4 models: video at "high" is 280 tokens a frame; audio is 25 tokens a second at any setting. */
export const TOKENS_PER_FRAME_HIGH = 280;
export const AUDIO_TOKENS_PER_SEC = 25;

export const clampFps = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(FPS_MAX, Math.max(FPS_MIN, v)) : FPS_DEFAULT;
};
export const clampDailyCap = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(DAILY_CAP_MAX, Math.max(1, v)) : DAILY_CAP_DEFAULT;
};

/** Tokens Gemini counts for one minute of video at this sampling rate (frames at "high" plus the sound). */
export function tokensPerMinute(fps: number): number {
  return clampFps(fps) * 60 * TOKENS_PER_FRAME_HIGH + 60 * AUDIO_TOKENS_PER_SEC;
}

/** "2 fps · about 35k tokens per minute of video" */
export function fpsWords(fps: number): string {
  const f = clampFps(fps);
  return `${f} fps · about ${Math.round(tokensPerMinute(f) / 1000)}k tokens per minute of video`;
}

/** The Pacific calendar day ("2026-10-24"): the free tier's day. */
export function pacificDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The next midnight Pacific after `now`, when the per-day quota starts again. */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const today = pacificDay(now);
  // Walk forward in 15-minute steps until the Pacific date changes (DST-proof, at most 97 steps).
  let t = now.getTime();
  for (let i = 0; i < 100; i++) {
    t += 15 * 60_000;
    if (pacificDay(new Date(t)) !== today) break;
  }
  // Back to the exact millisecond the day turned (midnight itself).
  let lo = t - 15 * 60_000;
  let hi = t;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (pacificDay(new Date(mid)) === today) lo = mid; else hi = mid;
  }
  return new Date(hi);
}

/**
 * How long to wait after a refused or failed request. A 429 that names a
 * retryDelay is honoured (never less than 30 s); otherwise 1, 2, 4, 8… minutes,
 * capped at an hour, plus up to 10% jitter so two jobs do not retry together.
 */
export function backoffMs(attempt: number, retryAfterMs: number | null = null, rand: () => number = Math.random): number {
  const base = retryAfterMs != null ? Math.max(30_000, retryAfterMs) : Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
  return Math.round(base * (1 + 0.1 * rand()));
}

// ---- the stored job ----------------------------------------------------------

export type GvaKind = "spell" | "cover";
export type GvaState = "QUEUED" | "WAITING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";

export type StoredCoverRef = { store: "blob" | "dropbox" | "memory"; pathname: string; url: string | null };

export type CoverCandidate = {
  /** 0, 1, 2: the order Gemini ranked them (0 is the pre-selected best) */
  n: number;
  /** the moment Gemini picked, seconds */
  t: number;
  /** the frame actually used: the sharpest within about half a second of t */
  frameT: number;
  score: number;
  why: string;
  sharpness: number | null;
  inGrid: boolean;
  ref: StoredCoverRef;
  width: number;
  height: number;
};

export type CoverResult = {
  candidates: CoverCandidate[];
  /** the pre-selected cover (Gemini's best) */
  best: number;
  /** the client's (or staff's) own choice, when they made one */
  pick: { n: number; by: string; at: string } | null;
  /** what the frames were read from */
  source: "topaz" | "editor";
};

export type SpellVerdict = "RIGHT" | "WRONG";

export type SpellFlag = {
  id: string;
  /** seconds into the video */
  t: number;
  onScreen: string;
  expected: string;
  source: SpellSourceKind;
  kind: "misspelled" | "spacing";
  line: string;
  confidence: number;
  verdict: SpellVerdict | null;
  verdictBy: string | null;
  verdictAt: string | null;
};

export type SpellResult = {
  flags: SpellFlag[];
  /** on-screen texts Gemini returned */
  read: number;
  /** what was left out, and why (never shown as a flag) */
  dropped: { unclear: number; unknown: number; overCap: number; notOverlay: number };
  /** nothing to check against (no script and no names) */
  nothingToCheck?: boolean;
};

export type GvaJob = {
  v: 1;
  kind: GvaKind;
  submissionId: string;
  projectId: string;
  /** the bytes this run is for (cutIdentityHash): one run per version */
  fingerprint: string;
  state: GvaState;
  attempts: number;
  rateLimited: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  leaseBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** a cover waiting for the Topaz pass, in words */
  waitReason?: string | null;
  /** the uploaded copy in Gemini's Files API, kept between tries (deleted when the job ends) */
  file?: { name: string; uri: string; mimeType: string; at: string } | null;
  model?: string | null;
  fps?: number | null;
  usage?: { input: number | null; output: number | null; total: number | null } | null;
  /** "deepgram" when the caption builder's transcript gave the timing */
  timing?: "deepgram" | "none" | null;
  /** cover only: Gemini's ranked moments, kept so a frame-grab retry never asks again */
  picks?: CoverPick[] | null;
  cover?: CoverResult | null;
  spell?: SpellResult | null;
};

export const GVA_KEY = (kind: GvaKind, submissionId: string) => `gva:${kind}:${submissionId}`;
export const GVA_PREFIX = "gva:";

export function newJob(kind: GvaKind, submissionId: string, projectId: string, fingerprint: string, now: Date = new Date()): GvaJob {
  const iso = now.toISOString();
  return {
    v: 1, kind, submissionId, projectId, fingerprint, state: "QUEUED", attempts: 0, rateLimited: 0,
    nextAttemptAt: iso, leaseUntil: null, leaseBy: null, createdAt: iso, updatedAt: iso, startedAt: null, finishedAt: null, error: null,
  };
}

export function parseJob(value: string | null | undefined): GvaJob | null {
  if (!value) return null;
  try {
    const j = JSON.parse(value) as GvaJob;
    return j && j.v === 1 && (j.kind === "spell" || j.kind === "cover") && typeof j.submissionId === "string" ? j : null;
  } catch {
    return null;
  }
}

/** The cover a person sees first: their own pick, else Gemini's best. */
export function chosenCover(c: CoverResult | null | undefined): CoverCandidate | null {
  if (!c || !c.candidates.length) return null;
  const n = c.pick?.n ?? c.best;
  return c.candidates.find((x) => x.n === n) ?? c.candidates[0];
}

// ---- words -------------------------------------------------------------------

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’‘`]/g, "'");
/** letters and digits only, lower case: "Brandywine," → "brandywine" */
export const wordKey = (w: string) => fold(w).replace(/[^a-z0-9]/g, "");

/** The words of a line, as written (punctuation trimmed, apostrophes and inner hyphens kept; a house number is a word). */
export function wordsOf(s: string | null | undefined): string[] {
  return (String(s ?? "").match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9'’-]*/g) ?? []).map((w) => w.replace(/['’-]+$/, "")).filter(Boolean);
}

/** Two readings of one text agree when their words agree (case and punctuation aside). */
export function sameReading(a: string, b: string): boolean {
  const n = (s: string) => wordsOf(s).map(wordKey).join(" ");
  return !!n(a) && n(a) === n(b);
}

/** Optimal string alignment distance (a swap of two neighbours counts as one). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** How many typo-sized edits a word of this length may be off by and still be "that word, misspelled". */
export function typoAllowance(len: number, source: "name" | "script"): number {
  if (source === "name") return len < 5 ? 0 : len < 8 ? 1 : 2;
  return len < 5 ? 0 : len < 9 ? 1 : 2;
}

const INFLECTIONS = ["s", "es", "'s", "s'", "ed", "d", "ing", "er", "ers", "ly", "y", "n", "en"];
/** One is the other plus an ending ("listing"/"listings", "buy"/"buying"): what was SAID, not a misspelling. */
export function inflectionOf(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short) || short.length < 3) return false;
  return INFLECTIONS.includes(long.slice(short.length));
}

// ---- the references: what we KNOW the spelling of ---------------------------------

export type SpellSourceKind = "script" | "name" | "address";
export type NameInput = { text: string; from: string };
export type NameRef = { text: string; keys: string[]; squash: string; source: "name" | "address" };

export type SpellReferences = {
  names: NameRef[];
  /** script word key → the script's own spelling */
  scriptWords: Map<string, string>;
  /** each script sentence's word keys */
  sentences: string[][];
  /** every reference word key (script and names) */
  known: Set<string>;
};

// A section label at the start of a script line ("Hook:", "Talking Point 1 (Re-hook):"), and lines never spoken.
const LABEL = /^\s*(?:[-•*]\s*)?[A-Z][A-Za-z0-9 /&()+'’-]{0,40}?:\s*/;
const UNSPOKEN = /^\s*(?:[-•*]\s*)?(?:category|caption(?:\s*cta)?|hashtags?|music|song|length|shot list|b-?roll|notes?)\s*:/i;

/** The spoken sentences of a script, labels and unspoken lines removed. */
export function scriptSentences(script: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(script ?? "").split(/\r?\n/)) {
    if (!raw.trim() || UNSPOKEN.test(raw)) continue;
    const line = raw.replace(LABEL, "").trim();
    for (const s of line.split(/(?<=[.!?…])\s+/)) if (wordsOf(s).length) out.push(s.trim());
  }
  return out;
}

export function buildReferences(input: { script: string | null | undefined; names: readonly NameInput[] }): SpellReferences {
  const names: NameRef[] = [];
  const seen = new Set<string>();
  for (const n of input.names) {
    const keys = wordsOf(n.text).map(wordKey).filter(Boolean);
    const squash = keys.join("");
    if (!squash || squash.length < 3 || seen.has(squash)) continue;
    seen.add(squash);
    names.push({ text: n.text.trim(), keys, squash, source: n.from === "address" ? "address" : "name" });
  }
  const sentences = scriptSentences(input.script);
  const scriptWords = new Map<string, string>();
  for (const s of sentences) for (const w of wordsOf(s)) if (!scriptWords.has(wordKey(w))) scriptWords.set(wordKey(w), w);
  const known = new Set<string>([...scriptWords.keys(), ...names.flatMap((n) => n.keys)]);
  return { names, scriptWords, sentences: sentences.map((s) => wordsOf(s).map(wordKey)), known };
}

// ---- readings → flags ----------------------------------------------------------

export const READ_CONFIDENCE_MIN = 0.85;
export const MAX_FLAGS = 3;

/** What Gemini returns for each on-screen text (spellingSchema). */
export type OnScreenReading = { start: number; text: string; second_reading: string; confidence: number; overlay?: boolean };

export function clearReading(r: OnScreenReading): boolean {
  return (
    typeof r.text === "string" && typeof r.second_reading === "string" && typeof r.confidence === "number" &&
    Number.isFinite(r.confidence) && r.confidence >= READ_CONFIDENCE_MIN && r.confidence <= 1 && sameReading(r.text, r.second_reading)
  );
}

/** "00:07" */
export function mmss(t: number): string {
  const s = Math.max(0, Math.floor(Number(t) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The flag's one line, as Jordan asked for it: "On screen: 'Brandywine Ln' reads 'Brandywyne Ln' at 00:07 (the script says Brandywine Ln)." */
export function flagLine(f: Pick<SpellFlag, "expected" | "onScreen" | "t" | "source" | "kind">): string {
  const said = f.source === "script" ? `the script says ${f.expected}` : f.source === "address" ? `the address says ${f.expected}` : `the spelling list says ${f.expected}`;
  const spacing = f.kind === "spacing" ? (wordsOf(f.expected).length > 1 ? ", as separate words" : ", as one word") : "";
  return `On screen: '${f.expected}' reads '${f.onScreen}' at ${mmss(f.t)} (${said}${spacing}).`;
}

type Candidate = Omit<SpellFlag, "id" | "line" | "verdict" | "verdictBy" | "verdictAt"> & { rank: number };

/**
 * The flags in a set of readings. Pure; the drill feeds it the same shapes
 * Gemini returns. Readings that are not clear, not an overlay, or name no word
 * we know are counted in `dropped` and never become a flag.
 */
export function selectSpellingFlags(readings: readonly OnScreenReading[], refs: SpellReferences): SpellResult {
  const dropped = { unclear: 0, unknown: 0, overCap: 0, notOverlay: 0 };
  const found: Candidate[] = [];
  for (const r of readings) {
    if (r?.overlay === false) { dropped.notOverlay++; continue; }
    if (!clearReading(r)) { dropped.unclear++; continue; }
    const raw = wordsOf(r.text);
    const keys = raw.map(wordKey);
    const covered = new Set<number>();
    const before = found.length;
    const t = Math.max(0, Number(r.start) || 0);
    const mixedCase = /[a-z]/.test(r.text) && /[A-Z]/.test(r.text);

    // 1 · names and the address: exact, run together / split apart, or one typo off.
    for (const name of refs.names) {
      const L = name.keys.length;
      for (let size = Math.max(1, L - 1); size <= L + 1; size++) {
        for (let i = 0; i + size <= keys.length; i++) {
          const win = keys.slice(i, i + size);
          if (win.some((_, k) => covered.has(i + k))) continue;
          const sq = win.join("");
          const shown = raw.slice(i, i + size).join(" ");
          if (sq === name.squash) {
            const sameSplit = size === L && win.every((k, j) => k === name.keys[j]);
            if (!sameSplit && wordKey(shown) === name.squash) {
              found.push({ t, onScreen: shown, expected: name.text, source: name.source, kind: "spacing", confidence: r.confidence, rank: 0 });
            }
            for (let k = 0; k < size; k++) covered.add(i + k);
            continue;
          }
          if (size !== L) continue;
          // Every word already a word we know (the script spells it this way too): not ours to call.
          if (win.every((k) => refs.known.has(k))) continue;
          // Only the differing word(s) may be off; a name's ending ("Erika's") is not a misspelling.
          const off = win.map((k, j) => (k === name.keys[j] ? null : { k, ref: name.keys[j], word: raw[i + j] })).filter((x): x is { k: string; ref: string; word: string } => !!x);
          if (!off.length || off.some((o) => o.k[0] !== o.ref[0] || inflectionOf(o.k, o.ref) || (/\d/.test(o.k) || /\d/.test(o.ref)))) continue;
          // In a sentence-case caption a name starts with a capital: a lower-case
          // word one letter off a name ("home" beside "Hope") is just a word.
          if (mixedCase && off.some((o) => !/^[A-ZÀ-Þ]/.test(o.word))) continue;
          const dist = editDistance(sq, name.squash);
          if (dist >= 1 && dist <= typoAllowance(name.squash.length, "name") && refs.names.every((other) => other === name || other.squash !== sq)) {
            found.push({ t, onScreen: shown, expected: name.text, source: name.source, kind: "misspelled", confidence: r.confidence, rank: 1 });
            for (let k = 0; k < size; k++) covered.add(i + k);
          }
        }
      }
    }

    // 2 · words straight from the script, in a caption that is clearly that script line.
    keys.forEach((k, i) => {
      if (covered.has(i) || !k || /\d/.test(k) || refs.known.has(k) || k.length < 5) return;
      let best: { key: string; d: number } | null = null;
      let tie = false;
      for (const s of refs.scriptWords.keys()) {
        if (s.length < 5 || s[0] !== k[0] || /\d/.test(s) || inflectionOf(s, k)) continue;
        const d = editDistance(k, s);
        if (d < 1 || d > typoAllowance(s.length, "script")) continue;
        if (!best || d < best.d) { best = { key: s, d }; tie = false; } else if (d === best.d && s !== best.key) tie = true;
      }
      if (!best || tie) return;
      // The caption must be that script sentence: at least two of its other words, and half of them, are in it.
      const others = keys.filter((x, j) => j !== i && x.length >= 3);
      const target = best.key;
      const aligned = refs.sentences.some((sen) => {
        if (!sen.includes(target)) return false;
        const hit = others.filter((x) => sen.includes(x)).length;
        return hit >= 2 && hit * 2 >= others.length;
      });
      if (!aligned) return;
      found.push({ t, onScreen: raw[i], expected: refs.scriptWords.get(target) ?? target, source: "script", kind: "misspelled", confidence: r.confidence, rank: 2 });
      covered.add(i);
    });
    if (found.length === before) dropped.unknown++;
  }

  // One flag per (expected, on screen), the first time it shows.
  const unique = new Map<string, Candidate>();
  for (const f of found.sort((a, b) => a.t - b.t)) {
    const k = `${wordKey(f.expected)}|${wordKey(f.onScreen)}|${f.kind}`;
    if (!unique.has(k)) unique.set(k, f);
  }
  const ranked = [...unique.values()].sort((a, b) => a.rank - b.rank || b.confidence - a.confidence || a.t - b.t);
  dropped.overCap = Math.max(0, ranked.length - MAX_FLAGS);
  const flags: SpellFlag[] = ranked.slice(0, MAX_FLAGS).sort((a, b) => a.t - b.t).map((f, i) => {
    const { rank: _rank, ...rest } = f;
    void _rank;
    const flag = { ...rest, id: `f${i + 1}-${wordKey(f.onScreen).slice(0, 16)}`, line: "", verdict: null, verdictBy: null, verdictAt: null } as SpellFlag;
    flag.line = flagLine(flag);
    return flag;
  });
  return { flags, read: readings.length, dropped };
}

// ---- the trial ------------------------------------------------------------------

export const TRIAL_DAYS = 14;
export const PRECISION_BAR = 0.9;
export const PRECISION_MIN_MARKED = 10;

export type TrialSummary = { flags: number; right: number; wrong: number; open: number; precision: number | null; barMet: boolean; words: string };

/** Right = a real mistake on screen; Wrong = a false alarm. Precision = Right / (Right + Wrong). */
export function trialSummary(flags: readonly { verdict: SpellVerdict | null }[]): TrialSummary {
  const right = flags.filter((f) => f.verdict === "RIGHT").length;
  const wrong = flags.filter((f) => f.verdict === "WRONG").length;
  const open = flags.length - right - wrong;
  const precision = right + wrong ? right / (right + wrong) : null;
  const barMet = right + wrong >= PRECISION_MIN_MARKED && (precision ?? 0) >= PRECISION_BAR;
  const words = flags.length
    ? `${flags.length} flag${flags.length === 1 ? "" : "s"} · ${right} right · ${wrong} wrong${open ? ` · ${open} to mark` : ""}${precision != null ? ` · ${Math.round(precision * 100)}% right` : ""}`
    : "No flags yet";
  return { flags: flags.length, right, wrong, open, precision, barMet, words };
}

/** Who sees spelling flags: the owner always (with Right / Wrong); a reviewer at the desk only once the switch is on. */
export function spellingViewFor(role: string | null | undefined, opts: { reviewersOn: boolean; atReviewDesk: boolean }): "owner" | "reviewer" | null {
  if (role === "OWNER") return "owner";
  if (opts.reviewersOn && opts.atReviewDesk && role !== "PHOTOGRAPHER" && role !== "EDITOR") return "reviewer";
  return null;
}

// ---- timing from the transcript (WHEN, never WHAT) ---------------------------------

export type Segment = { start: number; end: number; text: string };

export function parseSegments(json: string | null | undefined): Segment[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => r as Partial<Segment>)
      .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && typeof r.text === "string")
      .map((r) => ({ start: Number(r.start), end: Number(r.end), text: String(r.text) }));
  } catch {
    return [];
  }
}

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const hit = a.filter((x) => sb.has(x)).length;
  return hit / Math.max(a.length, b.length);
};

/**
 * When each script sentence is spoken: the transcript run (one to three
 * segments) whose words overlap it most. The transcript's own words are never
 * passed on; only the script's sentence and the times.
 */
export function alignScript(sentences: readonly string[], segments: readonly Segment[]): { line: string; start: number; end: number }[] {
  const out: { line: string; start: number; end: number }[] = [];
  const segKeys = segments.map((s) => wordsOf(s.text).map(wordKey));
  for (const line of sentences) {
    const lk = wordsOf(line).map(wordKey);
    let best: { start: number; end: number; score: number } | null = null;
    for (let i = 0; i < segments.length; i++) {
      for (let span = 1; span <= 3 && i + span <= segments.length; span++) {
        const score = overlap(lk, segKeys.slice(i, i + span).flat());
        if (!best || score > best.score) best = { start: segments[i].start, end: segments[i + span - 1].end, score };
      }
    }
    if (best && best.score >= 0.3) out.push({ line, start: best.start, end: best.end });
  }
  return out;
}

/** The hook: the script's first spoken sentence(s), up to about 25 words. */
export function hookOf(script: string | null | undefined): string | null {
  const sentences = scriptSentences(script);
  if (!sentences.length) return null;
  let hook = sentences[0];
  if (wordsOf(hook).length < 6 && sentences[1]) hook = `${hook} ${sentences[1]}`;
  return wordsOf(hook).slice(0, 25).join(" ") || null;
}

// ---- covers ----------------------------------------------------------------------

/** The Reel cover is 1080×1920; the profile grid shows about the middle 1080×1350. */
export const COVER_W = 1080;
export const COVER_H = 1920;
export const GRID_BAND = { top: (1920 - 1350) / 2 / 1920, bottom: 1 - (1920 - 1350) / 2 / 1920 };

/** What Gemini returns for each moment (coverSchema). */
export type CoverPickRaw = {
  t: number; score: number; person?: boolean; facing_camera?: boolean; eyes_open?: boolean; sharp?: boolean; well_lit?: boolean;
  face_x?: number; face_y?: number; in_grid?: boolean; why?: string;
};
export type CoverPick = { t: number; score: number; person: boolean; faceX: number; faceY: number; inGrid: boolean; why: string; nearby?: boolean };

const clamp01 = (n: unknown, d = 0.5) => (Number.isFinite(Number(n)) ? Math.min(1, Math.max(0, Number(n))) : d);

/**
 * The three moments, best first: Gemini's own score, nudged by the things a
 * cover must have (face and title inside the grid band, eyes open and facing
 * the camera when a person is in it, sharp, well lit), at least 1.5 s apart.
 * Fewer than three good ones: the rest are taken close to the best moment.
 */
export function rankCoverPicks(raw: unknown, durationSec: number | null): CoverPick[] {
  const list = Array.isArray(raw) ? (raw as CoverPickRaw[]) : [];
  const maxT = durationSec && durationSec > 0 ? Math.max(0, durationSec - 0.2) : Number.POSITIVE_INFINITY;
  const scored = list
    .filter((p) => p && Number.isFinite(Number(p.t)) && Number(p.t) >= 0 && Number(p.t) <= maxT)
    .map((p) => {
      const person = p.person !== false;
      const adj =
        (Number(p.score) || 0) +
        (p.in_grid === false ? -3 : 1) +
        (person ? (p.facing_camera !== false && p.eyes_open !== false ? 0.5 : -2) : 0) +
        (p.sharp === false ? -1 : 0.5) +
        (p.well_lit === false ? -0.5 : 0.3);
      return { pick: { t: Math.round(Number(p.t) * 10) / 10, score: Math.round((Number(p.score) || 0) * 10) / 10, person, faceX: clamp01(p.face_x), faceY: clamp01(p.face_y), inGrid: p.in_grid !== false, why: String(p.why ?? "").slice(0, 120) }, adj };
    })
    .sort((a, b) => b.adj - a.adj);
  const out: CoverPick[] = [];
  for (const s of scored) {
    if (out.length >= 3) break;
    if (out.some((o) => Math.abs(o.t - s.pick.t) < 1.5)) continue;
    out.push(s.pick);
  }
  if (out.length && out.length < 3) {
    const best = out[0];
    for (const dt of [2, -2, 4, -4, 6, -6]) {
      if (out.length >= 3) break;
      const t = Math.round((best.t + dt) * 10) / 10;
      if (t < 0.3 || t > maxT || out.some((o) => Math.abs(o.t - t) < 1.5)) continue;
      out.push({ ...best, t, score: Math.max(0, best.score - 1), why: "close to the best moment", nearby: true });
    }
  }
  return out;
}

// ---- the questions ------------------------------------------------------------------

export const SPELLING_PROMPT_VERSION = "spell@v1";
export const COVER_PROMPT_VERSION = "cover@v1";

export const spellingSchema = {
  type: "object",
  properties: {
    texts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number", description: "When the text first appears, seconds from the start of the video." },
          text: { type: "string", description: "Exactly the characters shown, letter for letter, never corrected." },
          second_reading: { type: "string", description: "The same text read again, independently, letter for letter." },
          confidence: { type: "number", description: "0 to 1: how sure every letter is read correctly." },
          overlay: { type: "boolean", description: "true for text added in editing (captions, titles, name or address cards); false for text that is part of the scene." },
        },
        required: ["start", "text", "second_reading", "confidence", "overlay"],
      },
    },
  },
  required: ["texts"],
} as const;

export function spellingPrompt(input: { script: string | null; names: readonly string[]; timing: readonly { line: string; start: number; end: number }[] }): string {
  const lines = [
    "Read the text that appears on screen in this short real estate video.",
    "List every piece of text added in editing: captions (subtitles), titles, lower thirds, name cards and address cards. Each caption line once, at the moment it first appears, even if it stays on screen for several seconds.",
    "For each one give: start (seconds from the start), text (exactly the characters shown, letter for letter, keeping any spelling mistake exactly as displayed; never correct it), second_reading (read the same text again, independently, letter for letter), confidence (0 to 1, how sure you are of every letter; below 0.6 when the text is small, blurred, moving, partly covered or on screen too briefly to read), and overlay (false for text that is part of the scene, like signs, screens or packaging).",
    "Do not guess at text you cannot read, and do not list spoken words that are not shown on screen.",
    "",
    "For reference only, below are the script the video was made from and names that must be spelled exactly. Use them only to know where to look. Never use them to fill in or correct what is on screen.",
  ];
  if (input.script) lines.push("", "Script:", input.script.slice(0, 4000));
  if (input.names.length) lines.push("", `Names: ${input.names.slice(0, 20).join("; ")}`);
  if (input.timing.length) {
    lines.push("", "When each script line is spoken (from a timing pass; for timing only):");
    for (const t of input.timing.slice(0, 40)) lines.push(`${mmss(t.start)} to ${mmss(t.end)}: ${t.line.slice(0, 160)}`);
  }
  return lines.join("\n");
}

export const coverSchema = {
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          t: { type: "number", description: "The moment, seconds from the start of the video (one decimal)." },
          score: { type: "number", description: "0 to 10: how good a cover this frame makes." },
          person: { type: "boolean" },
          facing_camera: { type: "boolean" },
          eyes_open: { type: "boolean" },
          sharp: { type: "boolean" },
          well_lit: { type: "boolean" },
          face_x: { type: "number", description: "Centre of the main face, as a fraction of the frame width (0 to 1); 0.5 when there is no face." },
          face_y: { type: "number", description: "Centre of the main face, as a fraction of the frame height (0 to 1); 0.5 when there is no face." },
          in_grid: { type: "boolean", description: "true if the face and any title text sit inside the middle band of the frame (from 15% to 85% of its height)." },
          why: { type: "string", description: "A few plain words." },
        },
        required: ["t", "score", "person", "facing_camera", "eyes_open", "sharp", "well_lit", "face_x", "face_y", "in_grid", "why"],
      },
    },
  },
  required: ["moments"],
} as const;

export function coverPrompt(input: { hook: string | null; hookWindow: { start: number; end: number } | null }): string {
  const lines = [
    "Pick the best moments in this short real estate video to use as its Instagram Reel cover.",
    "The cover is the whole vertical frame, but on the profile grid Instagram shows only about the middle part of it: the band from 15% to 85% of the frame's height.",
    "A good cover: the agent (the person speaking) facing the camera, eyes open, a natural expression, ideally not mid-word; sharp, with no motion blur; well lit and nicely framed; the face and any on-screen title inside that middle band.",
    "If no person appears in the video, choose the most attractive, sharp, well-lit shot of the property.",
  ];
  if (input.hook) {
    lines.push(
      input.hookWindow
        ? `The hook ("${input.hook.slice(0, 200)}") is spoken from ${mmss(input.hookWindow.start)} to ${mmss(input.hookWindow.end)}. Prefer a moment in or near it when it looks just as good, but choose the best-looking moments anywhere in the video.`
        : `The video opens with the hook ("${input.hook.slice(0, 200)}"). Prefer a moment near it when it looks just as good, but choose the best-looking moments anywhere in the video.`,
    );
  }
  lines.push("Return up to 6 moments, best first, at least 1.5 seconds apart.");
  return lines.join("\n");
}
