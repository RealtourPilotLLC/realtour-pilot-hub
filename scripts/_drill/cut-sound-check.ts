// @drill-run: conditions=none
// ---------------------------------------------------------------------------
// DRILL cut-sound-check — the editor-side sound check (src/lib/cutSoundCheck.ts,
// Oct 16 2026): header findings, the short listens, the words, and every way
// it must stay SILENT rather than raise a false alarm.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/cut-sound-check.ts --logs <dir>
//
// Pure: no database, no network, no browser. Node has no WebCodecs, so the
// listening half is driven through its decoder seam with a stand-in
// (_fixtures/mp4 fakeDecoder) that turns each synthetic "AAC" frame's recipe
// into 1024 PCM frames — the window choice, the byte reads out of an
// interleaved multi-GB file, the run-in trim and every level rule are the
// shipped code. The real WebCodecs path is proven to SKIP here (no decoder →
// no level words), which is exactly its behaviour in a browser without one.
//
//   §1 where it listens: the last 2 s + up to six 5 s windows, never the track
//   §2 a clean mix with a fade-out: nothing said; only the windows were read
//   §3 cut off at the end · §4 a muted stretch · §5 far too quiet
//   §6 clipping, and a hot clean master that is NOT clipping
//   §7 silent everywhere · §8 header findings (no sound, sync, PCM) + order
//   §9 never a false alarm: no decoder, a failing decoder, out of time,
//      not an MP4, a real Blob
//   §10 the reviewer's note and the editor's line
// ---------------------------------------------------------------------------
import {
  checkCutSound, editorSentence, listenWindows, soundReviewerNote, soundWarningLine, webCodecsDecode, withSoundNote,
  SOUND_NOTE_PREFIX, type SoundFinding,
} from "../../src/lib/cutSoundCheck";
import { buildExport, fakeDecoder, type ExportSpec, type Frame } from "./_fixtures/mp4";
import { makeChecker } from "./_harness";

const AMP = 0.14; // a 440 Hz tone at ~-20 dBFS RMS — a normal mix level
const tone = (amp = AMP): Frame => ({ mode: "tone", amp });
/** A normal ending: full level, then a 1.5 s fade to nothing at `end`. */
const fadingAt = (end: number, amp = AMP) => (t: number): Frame => (t >= end - 1.5 ? tone(Math.max(0, amp * ((end - t) / 1.5))) : tone(amp));

async function run(spec: ExportSpec, opts: Parameters<typeof checkCutSound>[1] = {}) {
  const file = buildExport(spec);
  const log = { runs: 0, frames: 0 };
  const report = await checkCutSound({ read: file.read, total: file.size }, { decode: fakeDecoder(log), ...opts });
  return { report, log, file, kinds: report.findings.map((f) => f.kind) };
}

async function main() {
  const c = makeChecker();

  // =========================================================================
  c.head("§1 · where it listens");
  // =========================================================================
  {
    const w60 = listenWindows(0, 60);
    c.ok("60 s: five 5 s windows spread across + the last 2 s", w60.length === 6 && w60.filter((w) => !w.tail).every((w) => Math.abs(w.toSec - w.fromSec - 5) < 1e-9) && w60[5].tail && w60[5].fromSec === 58 && w60[5].toSec === 60,
      w60.map((w) => `${w.fromSec}-${w.toSec}${w.tail ? "T" : ""}`).join(" "));
    c.ok("…centred at 6/18/30/42/54 s (windows 3.5, 15.5, 27.5, 39.5, 51.5)", JSON.stringify(w60.slice(0, 5).map((w) => w.fromSec)) === "[3.5,15.5,27.5,39.5,51.5]");
    const w8 = listenWindows(0, 8);
    c.ok("8 s: one 5 s window + the last 2 s", w8.length === 2 && w8[1].tail);
    const w300 = listenWindows(0, 300);
    c.ok("5 minutes: still at most six windows (32 s of sound decoded at most)", w300.length === 7 && w300.reduce((s, w) => s + (w.toSec - w.fromSec), 0) <= 32 + 1e-9);
    c.ok("under a second: nothing to listen to", listenWindows(0, 0.8).length === 0);
  }

  // =========================================================================
  c.head("§2 · a clean mix: nothing said, and only the windows were read");
  // =========================================================================
  {
    const { report, log, file } = await run({ videoSec: 60, audioSec: 60, sound: fadingAt(60), moovAtEnd: true, videoChunkBytes: 15_000_000 });
    c.ok("a 4.2 GB export, sound faded out at the end: no findings, both parts ran", report.findings.length === 0 && report.ran.header && report.ran.levels, JSON.stringify(report));
    c.ok("…six decoder runs, 27 s of frames (5×5 s + 2 s, plus 3 frames of run-in each) — never the whole 60 s", log.runs === 6 && log.frames >= 1265 && log.frames <= 1300, `${log.runs} runs, ${log.frames} frames of 2813`);
    c.ok("…under 100 KB read out of 4.2 GB", file.bytesRead < 100_000 && file.size > 4.2e9, `${file.bytesRead} bytes in ${file.reads} reads`);
    c.ok("…nothing to show the editor, nothing for the reviewer", soundWarningLine(report.findings) === null && soundReviewerNote(report.findings) === null);
  }

  // =========================================================================
  c.head("§3 · cut off at the end");
  // =========================================================================
  {
    const hard = await run({ videoSec: 60, audioSec: 60, sound: () => tone() });
    c.ok("sound at full level on the very last frame: cut-off-end", JSON.stringify(hard.kinds) === '["cut-off-end"]', JSON.stringify(hard.kinds));
    c.ok("…said: \"The sound is still going on the very last frame. Check the ending isn't cut off mid-word.\"", soundWarningLine(hard.report.findings) === "The sound is still going on the very last frame. Check the ending isn't cut off mid-word.", String(soundWarningLine(hard.report.findings)));
    const early = await run({ videoSec: 60, audioSec: 60, sound: fadingAt(59.0) });
    c.ok("a fade that finishes a second early (silence on the last frame): nothing said", early.kinds.length === 0, JSON.stringify(early.kinds));
  }

  // =========================================================================
  c.head("§4 · a muted stretch");
  // =========================================================================
  {
    const muted = await run({ videoSec: 60, audioSec: 60, sound: (t) => (t >= 14 && t < 22 ? { mode: "silent", amp: 0 } : fadingAt(60)(t)) });
    const f = muted.report.findings.find((x) => x.kind === "silence") as Extract<SoundFinding, { kind: "silence" }> | undefined;
    c.ok("sound muted 0:14–0:22: found where a window falls in it (from 0:15, 5 s)", JSON.stringify(muted.kinds) === '["silence"]' && !!f && f.atSec >= 15.4 && f.atSec <= 15.6 && f.lenSec >= 4.9, JSON.stringify(muted.report.findings));
    c.ok("…said: \"There's no sound for 5 s from 0:15. Check that part isn't muted.\"", soundWarningLine(muted.report.findings) === "There's no sound for 5 s from 0:15. Check that part isn't muted.", String(soundWarningLine(muted.report.findings)));
    const pause = await run({ videoSec: 60, audioSec: 60, sound: (t) => (t >= 16 && t < 19 ? { mode: "silent", amp: 0 } : fadingAt(60)(t)) });
    c.ok("a 3 s pause: not reported (under 4.5 s)", pause.kinds.length === 0, JSON.stringify(pause.kinds));
  }

  // =========================================================================
  c.head("§5 · far too quiet");
  // =========================================================================
  {
    const quiet = await run({ videoSec: 60, audioSec: 60, sound: fadingAt(60, 0.008) });
    c.ok("everything at about -45 dBFS: quiet", JSON.stringify(quiet.kinds) === '["quiet"]', JSON.stringify(quiet.kinds));
    const lowish = await run({ videoSec: 60, audioSec: 60, sound: fadingAt(60, 0.03) });
    c.ok("a low but normal mix (about -33 dBFS): nothing said", lowish.kinds.length === 0, JSON.stringify(lowish.kinds));
  }

  // =========================================================================
  c.head("§6 · clipping — and a loud master that is not");
  // =========================================================================
  {
    const clip = await run({ videoSec: 60, audioSec: 60, sound: (t) => (t >= 30 && t < 34 ? { mode: "clip", amp: 3 } : fadingAt(60)(t)) });
    c.ok("hard clipping 0:30–0:34: clipping around 0:30", JSON.stringify(clip.kinds) === '["clipping"]' && /around 0:30/.test(soundWarningLine(clip.report.findings) ?? ""), String(soundWarningLine(clip.report.findings)));
    const hot = await run({ videoSec: 60, audioSec: 60, sound: fadingAt(60, 0.98) });
    c.ok("a hot master peaking at 0.98: NOT clipping", !hot.kinds.includes("clipping"), JSON.stringify(hot.kinds));
  }

  // =========================================================================
  c.head("§7 · silent everywhere");
  // =========================================================================
  {
    const mute = await run({ videoSec: 60, audioSec: 60, sound: () => ({ mode: "silent", amp: 0 }) });
    c.ok("a sound track of digital silence: ONE finding (not silence + quiet + …)", JSON.stringify(mute.kinds) === '["silent-throughout"]', JSON.stringify(mute.kinds));
  }

  // =========================================================================
  c.head("§8 · what the header alone says");
  // =========================================================================
  {
    const none = await run({ videoSec: 30, audioSec: 0, sound: () => tone(), noAudio: true });
    c.ok("no sound track: no-audio, and the decoder is never asked", JSON.stringify(none.kinds) === '["no-audio"]' && none.log.runs === 0);
    c.ok("…said: \"This file has no sound. Check the audio was switched on in the export before you send it.\"", soundWarningLine(none.report.findings) === "This file has no sound. Check the audio was switched on in the export before you send it.");
    const short = await run({ videoSec: 60, audioSec: 59.4, sound: fadingAt(59.4), priming: true });
    c.ok("sound 0.6 s shorter than the picture (faded): exactly the sync finding", JSON.stringify(short.kinds) === '["sync"]', JSON.stringify(short.report.findings));
    c.ok("…said: \"The audio ends 0.6 s before the picture. Check the sync before you send it.\"", soundWarningLine(short.report.findings) === "The audio ends 0.6 s before the picture. Check the sync before you send it.", String(soundWarningLine(short.report.findings)));
    const both = await run({ videoSec: 60, audioSec: 59.4, sound: () => tone(), priming: true });
    c.ok("ends early AND loud to its last frame: both, sync first", JSON.stringify(both.kinds) === '["sync","cut-off-end"]', JSON.stringify(both.kinds));
    c.ok("…one line: the first in full, the rest after \"Also:\"", soundWarningLine(both.report.findings) === "The audio ends 0.6 s before the picture. Check the sync before you send it. Also: the sound is still going on the last frame (cut off?).", String(soundWarningLine(both.report.findings)));
    const late = await run({ videoSec: 60, audioSec: 59.5, sound: fadingAt(59.5), audioDelaySec: 0.5 });
    c.ok("an empty edit of 0.5 s: \"The sound starts 0.5 s after the picture.\"", soundWarningLine(late.report.findings)?.startsWith("The sound starts 0.5 s after the picture. Check the sync") === true, String(soundWarningLine(late.report.findings)));
    c.ok("…and the listens still line up with the late start (no false silence)", JSON.stringify(late.kinds) === '["sync"]', JSON.stringify(late.kinds));
    c.ok("PCM sound in words: \"The sound is uncompressed (PCM), not AAC.\"", editorSentence({ kind: "not-aac", codec: "sowt" }).startsWith("The sound is uncompressed (PCM), not AAC. Export with AAC audio"));
  }

  // =========================================================================
  c.head("§9 · never a false alarm");
  // =========================================================================
  {
    const spec: ExportSpec = { videoSec: 60, audioSec: 59.4, sound: () => ({ mode: "silent", amp: 0 }), priming: true };
    const noDecoder = await run(spec, { decode: async () => null });
    c.ok("no decoder for this sound: the levels part is skipped — no silence, no quiet — the header still speaks", noDecoder.report.ran.header && !noDecoder.report.ran.levels && JSON.stringify(noDecoder.kinds) === '["sync"]', JSON.stringify(noDecoder.report));
    const throws = await run(spec, { decode: async () => { throw new Error("decoder crashed"); } });
    c.ok("a decoder that throws: same — levels skipped, nothing invented", !throws.report.ran.levels && JSON.stringify(throws.kinds) === '["sync"]');
    let n = 0;
    const flaky = await run(spec, { decode: async (cfg, s) => (++n === 3 ? null : fakeDecoder()(cfg, s)) });
    c.ok("a decoder that fails on one window: the whole levels part is dropped (a partial listen is not compared)", !flaky.report.ran.levels && JSON.stringify(flaky.kinds) === '["sync"]');
    const slow = await run(spec, { budgetMs: 250, decode: async (cfg, s) => { await new Promise((r) => setTimeout(r, 120)); return fakeDecoder()(cfg, s); } });
    c.ok("out of time (250 ms budget, 120 ms a window): levels dropped unsaid", !slow.report.ran.levels && JSON.stringify(slow.kinds) === '["sync"]', JSON.stringify(slow.report));
    c.ok("the real WebCodecs path where there is none (Node): null, i.e. skipped", (await webCodecsDecode({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) }, [])) === null);
    const shipped = buildExport(spec);
    const viaDefault = await checkCutSound({ read: shipped.read, total: shipped.size });
    c.ok("…so the shipped default here says only what the header proves", viaDefault.ran.header && !viaDefault.ran.levels && JSON.stringify(viaDefault.findings.map((f) => f.kind)) === '["sync"]');
    const webm = new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81]), new Uint8Array(5000)]);
    const w = await checkCutSound(webm, { decode: fakeDecoder() });
    c.ok("a WebM file: nothing ran, nothing said", w.findings.length === 0 && !w.ran.header && !w.ran.levels);
    const broken = await checkCutSound({ read: async () => { throw new Error("disk gone"); }, total: 1e6 });
    c.ok("a read that fails: an empty report, never a throw", broken.findings.length === 0 && !broken.ran.header);
    const asBlob = new Blob([await buildExport({ videoSec: 20, audioSec: 19.4, sound: fadingAt(19.4), priming: true }).bytes()]);
    const b = await checkCutSound(asBlob, { decode: fakeDecoder() });
    c.ok("a real Blob (as the browser's File is) goes through Blob.slice: sync found, levels ran", JSON.stringify(b.findings.map((f) => f.kind)) === '["sync"]' && b.ran.levels, JSON.stringify(b));
  }

  // =========================================================================
  c.head("§10 · the reviewer's note and the editor's line");
  // =========================================================================
  {
    const f: SoundFinding[] = [{ kind: "cut-off-end" }, { kind: "sync", words: "the audio ends 0.6 s before the picture" }];
    c.ok("the note: one short line, prefixed, in priority order", soundReviewerNote(f) === `${SOUND_NOTE_PREFIX} the audio ends 0.6 s before the picture; the sound is still going on the last frame (cut off?).`, String(soundReviewerNote(f)));
    c.ok("nothing found → no note", soundReviewerNote([]) === null);
    c.ok("with the editor's words: theirs first, the automatic line after", withSoundNote("  no border version ", "Sound check (automatic): x.") === "no border version\nSound check (automatic): x.");
    c.ok("no words of theirs: the automatic line alone", withSoundNote("", "Sound check (automatic): x.") === "Sound check (automatic): x.");
    c.ok("no finding: the editor's words untouched (empty stays empty)", withSoundNote("hi", null) === "hi" && withSoundNote("", null) === "");
    c.ok("never twice (a retried hand-in)", withSoundNote("hi\nSound check (automatic): x.", "Sound check (automatic): x.") === "hi\nSound check (automatic): x.");
  }

  c.summary();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
