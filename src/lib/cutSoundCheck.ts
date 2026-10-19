// ---------------------------------------------------------------------------
// THE SOUND CHECK ON THE EDITOR'S OWN FILE, BEFORE IT IS UPLOADED (Oct 16 2026).
//
// Today sound is a tick box for the editor and another for the reviewer, and
// about eighteen videos since June still went out (or reached review) with a
// sound problem: no music, a muted stretch, the voice cut off at the end, the
// sound half a second behind the picture. Jordan: catch it at the source, and
// keep the reviewer's step simple — "we know what to look for".
//
// What it does, all in the editor's browser, on the file they just picked:
//   1  HEADER (mp4Probe, Blob.slice — a few small reads, no matter how big):
//      no sound track; sound not AAC; sound starting or stopping more than
//      0.25 s away from the picture.
//   2  SHORT LISTENS (WebCodecs AudioDecoder on AAC frames cut straight out of
//      the file by the header's own sample table): the last 2 s and up to six
//      5 s windows across the video — never the whole track. From those: sound
//      still going on the very last frame (cut off mid-word), 4.5 s or more of
//      nothing, everything far too quiet, or clipping.
//
// WARN, NEVER BLOCK. It returns findings; the uploader shows one line and the
// upload goes ahead regardless. And NEVER A FALSE ALARM: whatever cannot run —
// not an MP4, a browser without AudioDecoder, a codec it won't take, a slow
// machine past the budget — is skipped without a word, and a skipped check is
// never reported as a pass or a problem.
//
// Pure apart from the default decoder (which touches the browser's WebCodecs
// only when called), so drills drive every step in Node with a stand-in.
// ---------------------------------------------------------------------------

import {
  AV_WARN_SEC,
  PCM_CODECS,
  avSyncOf,
  avSyncWords,
  avTimingOf,
  blobReader,
  readMp4Info,
  type Mp4Info,
  type ReadRange,
  type SampleTable,
} from "@/lib/mp4Probe";

export type SoundFinding =
  | { kind: "no-audio" }
  | { kind: "silent-throughout" }
  | { kind: "sync"; words: string }
  | { kind: "silence"; atSec: number; lenSec: number }
  | { kind: "cut-off-end" }
  | { kind: "quiet" }
  | { kind: "clipping"; atSec: number }
  | { kind: "not-aac"; codec: string };

export type SoundReport = {
  findings: SoundFinding[];
  /** which parts actually ran — a part that didn't is silent, not "fine" */
  ran: { header: boolean; levels: boolean };
};

const ORDER: SoundFinding["kind"][] = ["no-audio", "silent-throughout", "sync", "silence", "cut-off-end", "quiet", "clipping", "not-aac"];
const byPriority = (a: SoundFinding, b: SoundFinding) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind);

// ---- the words ----------------------------------------------------------------

/** "1:05" */
export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const codecWords = (codec: string) => (PCM_CODECS.includes(codec) ? "uncompressed (PCM)" : `"${codec.trim()}"`);

/** One finding as a sentence for the EDITOR: what is wrong, then what to do. */
export function editorSentence(f: SoundFinding): string {
  switch (f.kind) {
    case "no-audio": return "This file has no sound. Check the audio was switched on in the export before you send it.";
    case "silent-throughout": return "The sound track is silent everywhere we listened. Check the audio wasn't muted in the export.";
    case "sync": return `${cap(f.words)}. Check the sync before you send it.`;
    case "silence": return `There's no sound for ${Math.floor(f.lenSec)} s from ${mmss(f.atSec)}. Check that part isn't muted.`;
    case "cut-off-end": return "The sound is still going on the very last frame. Check the ending isn't cut off mid-word.";
    case "quiet": return "The sound is very quiet all the way through. Check the levels before you send it.";
    case "clipping": return `The sound distorts (clips) around ${mmss(f.atSec)}. Bring the levels down a little before you send it.`;
    case "not-aac": return `The sound is ${codecWords(f.codec)}, not AAC. Export with AAC audio before you send it.`;
  }
}

/** The same finding as a short phrase, for the reviewer's note and for the
 *  "also" tail of the editor's line. */
export function shortPhrase(f: SoundFinding): string {
  switch (f.kind) {
    case "no-audio": return "the file has no sound";
    case "silent-throughout": return "the sound track is silent everywhere it was sampled";
    case "sync": return f.words;
    case "silence": return `no sound for ${Math.floor(f.lenSec)} s from ${mmss(f.atSec)}`;
    case "cut-off-end": return "the sound is still going on the last frame (cut off?)";
    case "quiet": return "very quiet all the way through";
    case "clipping": return `distorts (clips) around ${mmss(f.atSec)}`;
    case "not-aac": return `the sound is ${codecWords(f.codec)}, not AAC`;
  }
}

/** The ONE line under the upload. null = nothing to say (fine, or not run). */
export function soundWarningLine(findings: readonly SoundFinding[]): string | null {
  if (!findings.length) return null;
  const [first, ...rest] = [...findings].sort(byPriority);
  return rest.length ? `${editorSentence(first)} Also: ${rest.map(shortPhrase).join("; ")}.` : editorSentence(first);
}

export const SOUND_NOTE_PREFIX = "Sound check (automatic):";

/** The small automatic note the reviewer sees on the version. null when there
 *  is nothing to say — a clean or un-run check adds nothing to their screen. */
export function soundReviewerNote(findings: readonly SoundFinding[]): string | null {
  if (!findings.length) return null;
  return `${SOUND_NOTE_PREFIX} ${[...findings].sort(byPriority).map(shortPhrase).join("; ")}.`;
}

/** The editor's own message with the automatic line after it (never instead of
 *  it). Either may be empty; the column's 1,000-character clamp keeps the
 *  editor's words first. */
export function withSoundNote(message: string, note: string | null): string {
  const m = message.trim();
  if (!note || m.includes(SOUND_NOTE_PREFIX)) return m;
  return m ? `${m}\n${note}` : note;
}

// ---- the header part ------------------------------------------------------------

export function headerFindings(info: Mp4Info | null): SoundFinding[] {
  const sync = avSyncOf(avTimingOf(info));
  if (!sync) return [];
  if (!sync.hasAudio) return [{ kind: "no-audio" }];
  const out: SoundFinding[] = [];
  const words = avSyncWords(sync, AV_WARN_SEC);
  if (words) out.push({ kind: "sync", words });
  if (sync.codec && sync.codec !== "mp4a") out.push({ kind: "not-aac", codec: sync.codec });
  return out;
}

// ---- the listening part ------------------------------------------------------------

/** Decoded sound: per-channel samples starting at `startSec` on the movie's
 *  timeline. */
export type PcmWindow = { startSec: number; sampleRate: number; channels: Float32Array[]; tail: boolean };

export type EncodedSample = { data: Uint8Array; timestampUs: number; durationUs: number };
export type DecoderConfig = { codec: string; sampleRate: number; numberOfChannels: number; description: Uint8Array };
export type DecodedPiece = { timestampUs: number; sampleRate: number; channels: Float32Array[] };
/** Decode a run of AAC frames. null = this decoder can't (unsupported, failed). */
export type DecodeRun = (cfg: DecoderConfig, samples: EncodedSample[]) => Promise<DecodedPiece[] | null>;

/** Block size for every level figure: 50 ms. */
export const BLOCK_SEC = 0.05;
/** Below this a 50 ms block is silence (digital silence decodes to -inf). */
export const SILENT_DB = -55;
/** A stretch of silence this long inside one listen is reported. */
export const SILENCE_SEC = 4.5;
/** Everything this quiet (90th-percentile block, and no peak above -15 dBFS)
 *  is "far too low" — a normal mix sits around -20 to -10. */
export const QUIET_P90_DB = -35;
export const QUIET_PEAK = 0.178; // -15 dBFS
/** A block with this share of its samples on the rail is clipping, and it takes
 *  this many such blocks before it is said: a loud, clean master touches the
 *  rail now and then; a distorted one sits on it. */
export const CLIP_LEVEL = 0.999;
export const CLIP_BLOCK_FRACTION = 0.03;
export const CLIP_BLOCKS = 4;
/** The last 150 ms is "the very last frame" (a few frames at 30 fps). It is
 *  "still going" when it is at least -24 dBFS, within 6 dB of the program's
 *  usual level, and not fading (no more than 4 dB under the second before). */
export const TAIL_SEC = 0.15;
export const TAIL_MIN_DB = -24;
export const TAIL_BELOW_PROGRAM_DB = 6;
export const TAIL_FADE_DB = 4;

type Block = { atSec: number; rmsDb: number; power: number; peak: number; clipFrac: number };

export function blocksOf(w: PcmWindow): Block[] {
  const len = Math.max(1, Math.round(w.sampleRate * BLOCK_SEC));
  const ch = w.channels.length;
  const frames = ch ? Math.min(...w.channels.map((c) => c.length)) : 0;
  const out: Block[] = [];
  for (let b = 0; b + len <= frames; b += len) {
    let sum = 0;
    let peak = 0;
    let clipped = 0;
    for (const c of w.channels) {
      for (let i = b; i < b + len; i++) {
        const x = c[i];
        const a = x < 0 ? -x : x;
        sum += x * x;
        if (a > peak) peak = a;
        if (a >= CLIP_LEVEL) clipped++;
      }
    }
    const power = sum / (len * ch);
    out.push({ atSec: w.startSec + b / w.sampleRate, power, rmsDb: power > 0 ? 10 * Math.log10(power) : -Infinity, peak, clipFrac: clipped / (len * ch) });
  }
  return out;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
const meanDb = (bs: Block[]) => {
  if (!bs.length) return null;
  const p = bs.reduce((s, b) => s + b.power, 0) / bs.length;
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
};

/**
 * What the listens found. `endSec` is where the picture (or the sound, if it
 * stops first) ends on the timeline — the "very last frame".
 */
export function levelFindings(windows: readonly PcmWindow[], endSec: number): SoundFinding[] {
  const perWindow = windows.map((w) => ({ w, blocks: blocksOf(w) }));
  const all = perWindow.flatMap((p) => p.blocks);
  if (all.length < 10) return []; // too little decoded to say anything
  const sounding = all.filter((b) => b.rmsDb > SILENT_DB);
  if (!sounding.length) return [{ kind: "silent-throughout" }];

  const out: SoundFinding[] = [];
  const levels = sounding.map((b) => b.rmsDb).sort((a, b) => a - b);
  const program = pct(levels, 0.75);
  const p90 = pct(levels, 0.9);
  const maxPeak = Math.max(...all.map((b) => b.peak));

  // A stretch of nothing, inside one listen (blocks are contiguous within it).
  let silence: { atSec: number; lenSec: number } | null = null;
  for (const { blocks } of perWindow) {
    let run = 0;
    let runStart = 0;
    for (let i = 0; i <= blocks.length; i++) {
      const quiet = i < blocks.length && blocks[i].rmsDb <= SILENT_DB;
      if (quiet) {
        if (run === 0) runStart = blocks[i].atSec;
        run++;
      } else {
        const len = run * BLOCK_SEC;
        if (len >= SILENCE_SEC - 1e-9 && (!silence || runStart < silence.atSec)) silence = { atSec: runStart, lenSec: len };
        run = 0;
      }
    }
  }
  if (silence) out.push({ kind: "silence", ...silence });

  // The very last frame.
  const tail = perWindow.find((p) => p.w.tail);
  if (tail) {
    const last = tail.blocks.filter((b) => b.atSec >= endSec - TAIL_SEC - 1e-9 && b.atSec + BLOCK_SEC <= endSec + 1e-9);
    const before = tail.blocks.filter((b) => b.atSec >= endSec - TAIL_SEC - 1 - 1e-9 && b.atSec < endSec - TAIL_SEC - 1e-9);
    const lastDb = meanDb(last);
    const beforeDb = meanDb(before);
    if (last.length >= 2 && before.length >= 10 && lastDb !== null && beforeDb !== null
      && lastDb >= TAIL_MIN_DB && lastDb >= program - TAIL_BELOW_PROGRAM_DB && lastDb >= beforeDb - TAIL_FADE_DB) {
      out.push({ kind: "cut-off-end" });
    }
  }

  if (p90 < QUIET_P90_DB && maxPeak < QUIET_PEAK) out.push({ kind: "quiet" });

  const clipping = all.filter((b) => b.clipFrac >= CLIP_BLOCK_FRACTION);
  if (clipping.length >= CLIP_BLOCKS) out.push({ kind: "clipping", atSec: Math.min(...clipping.map((b) => b.atSec)) });
  return out;
}

/** Where to listen: the last 2 s, and up to six 5 s windows spread across. */
export function listenWindows(startSec: number, endSec: number): { fromSec: number; toSec: number; tail: boolean }[] {
  const d = endSec - startSec;
  if (!(d > 1)) return [];
  const len = Math.min(5, d);
  const n = d < 12 ? 1 : Math.min(6, Math.max(2, Math.round(d / 12)));
  const out: { fromSec: number; toSec: number; tail: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const centre = startSec + (d * (i + 0.5)) / n;
    const from = Math.min(Math.max(startSec, centre - len / 2), endSec - len);
    out.push({ fromSec: from, toSec: from + len, tail: false });
  }
  out.push({ fromSec: Math.max(startSec, endSec - 2), toSec: endSec, tail: true });
  return out;
}

/** The samples covering [fromSec, toSec] plus a few frames of run-in (an AAC
 *  frame overlaps the one before it), on the movie timeline. */
export function samplesFor(table: SampleTable, timing: { startSec: number; mediaStart: number; timescale: number }, fromSec: number, toSec: number, runIn = 3): { first: number; last: number } | null {
  const pres = (i: number) => timing.startSec + (table.times[i] - timing.mediaStart) / timing.timescale;
  let lo = 0;
  let hi = table.count - 1;
  // first sample whose end is after fromSec
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pres(mid) + table.durations[mid] / timing.timescale <= fromSec) lo = mid + 1;
    else hi = mid;
  }
  const first = Math.max(0, lo - runIn);
  let last = lo;
  while (last + 1 < table.count && pres(last + 1) < toSec) last++;
  return last >= first ? { first, last } : null;
}

/** Read samples [first, last] in as few slices as their layout allows: frames
 *  in one chunk sit back to back, so each chunk is one read. */
async function readSamples(read: ReadRange, table: SampleTable, first: number, last: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  let i = first;
  while (i <= last) {
    let j = i;
    while (j + 1 <= last && table.offsets[j + 1] === table.offsets[j] + table.sizes[j]) j++;
    const start = table.offsets[i];
    const bytes = await read(start, table.offsets[j] + table.sizes[j]);
    for (let k = i; k <= j; k++) {
      const o = table.offsets[k] - start;
      out.push(bytes.subarray(o, o + table.sizes[k]));
    }
    i = j + 1;
  }
  return out;
}

/** The browser's own AAC decoder. null when there isn't one, or it won't take
 *  this config, or anything goes wrong — the caller says nothing. */
export const webCodecsDecode: DecodeRun = async (cfg, samples) => {
  const AD = (globalThis as { AudioDecoder?: typeof AudioDecoder }).AudioDecoder;
  const EAC = (globalThis as { EncodedAudioChunk?: typeof EncodedAudioChunk }).EncodedAudioChunk;
  if (!AD || !EAC) return null;
  const config: AudioDecoderConfig = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels, description: cfg.description };
  try {
    const support = await AD.isConfigSupported(config);
    if (!support.supported) return null;
  } catch {
    return null;
  }
  const pieces: DecodedPiece[] = [];
  let failed = false;
  const dec = new AD({
    output: (d) => {
      try {
        const ch = planar(d);
        if (ch) pieces.push({ timestampUs: d.timestamp, sampleRate: d.sampleRate, channels: ch });
        else failed = true;
      } finally {
        d.close();
      }
    },
    error: () => { failed = true; },
  });
  try {
    dec.configure(config);
    for (const s of samples) dec.decode(new EAC({ type: "key", timestamp: s.timestampUs, duration: s.durationUs, data: s.data }));
    await dec.flush();
  } catch {
    failed = true;
  } finally {
    try { if (dec.state !== "closed") dec.close(); } catch { /* already closed */ }
  }
  return failed || !pieces.length ? null : pieces;
};

/** AudioData → one Float32Array per channel, whatever format it came in. */
function planar(d: AudioData): Float32Array[] | null {
  const n = d.numberOfFrames;
  const ch = d.numberOfChannels;
  try {
    const out: Float32Array[] = [];
    for (let c = 0; c < ch; c++) {
      const a = new Float32Array(n);
      d.copyTo(a, { planeIndex: c, format: "f32-planar" });
      out.push(a);
    }
    return out;
  } catch { /* this browser won't convert — read the native format */ }
  try {
    const out = Array.from({ length: ch }, () => new Float32Array(n));
    switch (d.format) {
      case "f32-planar":
        for (let c = 0; c < ch; c++) d.copyTo(out[c], { planeIndex: c });
        return out;
      case "f32": {
        const all = new Float32Array(n * ch);
        d.copyTo(all, { planeIndex: 0 });
        for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = all[i * ch + c];
        return out;
      }
      case "s16": {
        const all = new Int16Array(n * ch);
        d.copyTo(all, { planeIndex: 0 });
        for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = all[i * ch + c] / 32768;
        return out;
      }
      case "s16-planar":
        for (let c = 0; c < ch; c++) {
          const p = new Int16Array(n);
          d.copyTo(p, { planeIndex: c });
          for (let i = 0; i < n; i++) out[c][i] = p[i] / 32768;
        }
        return out;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Decode one window and lay it on the timeline. null = it didn't decode. */
async function listen(read: ReadRange, info: Mp4Info, w: { fromSec: number; toSec: number; tail: boolean }, decode: DecodeRun): Promise<PcmWindow | null> {
  const a = info.audio!;
  const table = info.audioSamples!;
  const aac = info.audioEntry!.aac!;
  const range = samplesFor(table, a, w.fromSec, w.toSec);
  if (!range) return null;
  const bytes = await readSamples(read, table, range.first, range.last);
  const samples: EncodedSample[] = bytes.map((data, k) => {
    const i = range.first + k;
    const t = a.startSec + (table.times[i] - a.mediaStart) / a.timescale;
    return { data, timestampUs: Math.round(t * 1e6), durationUs: Math.round((table.durations[i] / a.timescale) * 1e6) };
  });
  const pieces = await decode({ codec: aac.codecString, sampleRate: aac.sampleRate, numberOfChannels: aac.channels || 2, description: aac.config }, samples);
  if (!pieces || !pieces.length) return null;
  // Lay the pieces end to end from the first one's time (decoders keep the
  // timestamps they were given; a stand-in that doesn't still lines up), then
  // cut away the run-in and anything past the window.
  const rate = pieces[0].sampleRate;
  const chans = Math.min(...pieces.map((p) => p.channels.length));
  if (!(rate > 0) || !(chans > 0) || pieces.some((p) => p.sampleRate !== rate)) return null;
  const t0 = pieces[0].timestampUs / 1e6;
  const total = pieces.reduce((s, p) => s + p.channels[0].length, 0);
  const skip = Math.max(0, Math.round((w.fromSec - t0) * rate));
  const keep = Math.max(0, Math.min(total - skip, Math.round((w.toSec - Math.max(t0, w.fromSec)) * rate)));
  if (keep < rate * BLOCK_SEC * 2) return null;
  const channels = Array.from({ length: chans }, (_, c) => {
    const joined = new Float32Array(total);
    let o = 0;
    for (const p of pieces) { joined.set(p.channels[c], o); o += p.channels[c].length; }
    return joined.subarray(skip, skip + keep);
  });
  return { startSec: t0 + skip / rate, sampleRate: rate, channels, tail: w.tail };
}

/** How long the listening part may take before it is dropped unsaid. */
export const LISTEN_BUDGET_MS = 12_000;

/**
 * Check one file. Never throws, never blocks: the worst outcome is an empty
 * report. `read`/`total` are for drills; the uploader passes the File.
 */
export async function checkCutSound(
  file: Blob | { read: ReadRange; total: number },
  opts: { decode?: DecodeRun; budgetMs?: number } = {},
): Promise<SoundReport> {
  const report: SoundReport = { findings: [], ran: { header: false, levels: false } };
  try {
    const read = "read" in file ? file.read : blobReader(file);
    const total = "read" in file ? file.total : file.size;
    const info = await readMp4Info(read, total, { samples: true });
    const header = headerFindings(info);
    if (!info || !avSyncOf(avTimingOf(info))) return report;
    report.ran.header = true;
    report.findings.push(...header);
    if (header.some((f) => f.kind === "no-audio")) return report;

    const a = info.audio;
    if (!a || !info.audioSamples || !info.audioEntry?.aac) return report;
    const endSec = Math.min(a.endSec, info.video?.endSec ?? a.endSec);
    const plan = listenWindows(a.startSec, endSec);
    if (!plan.length) return report;
    const decode = opts.decode ?? webCodecsDecode;
    const deadline = Date.now() + (opts.budgetMs ?? LISTEN_BUDGET_MS);
    const heard: PcmWindow[] = [];
    for (const w of plan) {
      const left = deadline - Date.now();
      if (left <= 0) return report; // out of time: say nothing about levels
      let timer: ReturnType<typeof setTimeout> | undefined;
      const got = await Promise.race([
        listen(read, info, w, decode).catch(() => null),
        new Promise<"late">((r) => { timer = setTimeout(() => r("late"), left); }),
      ]);
      if (timer) clearTimeout(timer);
      if (got === "late") return report;
      // A window that won't decode spoils the comparison between them (and a
      // decoder that fails once is not one to trust on the rest).
      if (!got) return report;
      heard.push(got);
    }
    report.ran.levels = true;
    report.findings.push(...levelFindings(heard, endSec));
    // "Silent everywhere" and "no sound for N s" say the same thing twice.
    if (report.findings.some((f) => f.kind === "silent-throughout")) {
      report.findings = report.findings.filter((f) => f.kind !== "silence" && f.kind !== "cut-off-end" && f.kind !== "quiet");
    }
    report.findings.sort(byPriority);
    return report;
  } catch {
    return { findings: [], ran: { header: false, levels: false } };
  }
}
