// @drill-run: conditions=none
// ---------------------------------------------------------------------------
// DRILL mp4-probe — the MP4/MOV header reader behind the sound checks
// (src/lib/mp4Probe.ts, Oct 16 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/mp4-probe.ts --logs <dir>
//
// Pure: no database, no network. Every file is SYNTHETIC, built box by box by
// scripts/_drill/_fixtures/mp4.ts from the ISO/QuickTime layouts, so the parser
// is proven against bytes it did not write.
//
//   §1 moov at the front and at the END of a 4+ GB file (64-bit mdat, co64):
//      the same answer, and only a handful of small reads either way
//   §2 sound against picture: in step, starting late (empty edit), ending
//      early, running past; AAC priming edits are NOT a gap
//   §3 the thresholds: warn past 0.25 s, hold past 0.3 s, exactly at the line
//   §4 no sound track / an empty one; PCM sound named; first ENABLED track
//   §5 QuickTime: v1 and v2 sound entries, esds inside 'wave'; elst v1, mdhd v1
//   §6 never a guess: fragmented, WebM, truncated, junk → null / no finding
//   §7 the server path: avTimingFromMoov on a Node Buffer view (pooled offset)
//   §8 the words
// ---------------------------------------------------------------------------
import {
  AV_HOLD_SEC, AV_WARN_SEC, avOffBy, avSyncOf, avSyncWords, avTimingFromMoov, avTimingOf, locateMoov, parseAudioSpecificConfig,
  parseMoov, readMp4Info, secWords,
} from "../../src/lib/mp4Probe";
import { buildExport, cat, moovBox, ftyp, box, str, u32, VirtualFile, type TrackSpec } from "./_fixtures/mp4";
import { makeChecker } from "./_harness";

const tone = () => ({ mode: "tone" as const, amp: 0.14 });

async function main() {
  const c = makeChecker();

  // =========================================================================
  c.head("§1 · finding moov, front or back, without reading the file");
  // =========================================================================
  {
    const front = buildExport({ videoSec: 60, audioSec: 60, sound: tone });
    const info = await readMp4Info(front.read, front.size, { samples: true });
    c.ok("moov in front: parsed, a picture track and a sound track", !!info?.video && !!info.audio && info.audioTracks === 1, JSON.stringify(avTimingOf(info)));
    c.ok("…picture 0–60 s, sound 0–60.01 s (AAC frames round up)", !!info && Math.abs(info.video!.endSec - 60) < 0.001 && info.audio!.endSec >= 60 && info.audio!.endSec < 60.03, `${info?.video?.endSec} / ${info?.audio?.endSec}`);
    c.ok("…the AAC config: mp4a.40.2, 48 kHz, 2 channels", info?.audioEntry?.aac?.codecString === "mp4a.40.2" && info.audioEntry.aac.sampleRate === 48000 && info.audioEntry.aac.channels === 2);
    c.ok("…the sample table: every frame placed (2813 frames)", info?.audioSamples?.count === 2813 && info.audioSamples.offsets[1] - info.audioSamples.offsets[0] === 16);

    // 4.2 GB: 282 chunks of sound, each followed by 15 MB of (virtual) picture.
    const huge = buildExport({ videoSec: 60, audioSec: 60, sound: tone, moovAtEnd: true, videoChunkBytes: 15_000_000 });
    c.ok("setup: a 4.2 GB export with moov at the END (64-bit mdat, co64 offsets)", huge.size > 4.2e9, `${(huge.size / 1e9).toFixed(2)} GB`);
    huge.reads = 0; huge.bytesRead = 0;
    const loc = await locateMoov(huge.read, huge.size);
    c.ok("moov found after stepping over the mdat by its size", !!loc && loc.start > 4.2e9 && loc.brand === "isom", JSON.stringify(loc));
    c.ok("…in 3 reads of at most 16 bytes (ftyp, mdat, moov)", huge.reads === 3 && huge.bytesRead <= 48, `${huge.reads} reads, ${huge.bytesRead} bytes`);
    huge.reads = 0; huge.bytesRead = 0;
    const hinfo = await readMp4Info(huge.read, huge.size, { samples: true });
    c.ok("the whole header read: 4 reads, under 100 KB of a 4.2 GB file", huge.reads === 4 && huge.bytesRead < 100_000, `${huge.reads} reads, ${huge.bytesRead} bytes`);
    c.ok("…the same timing as the front-moov file", JSON.stringify(avTimingOf(hinfo)) === JSON.stringify(avTimingOf(info)));
    c.ok("…and 64-bit sample offsets beyond 4 GB read exactly", !!hinfo?.audioSamples && hinfo.audioSamples.offsets[hinfo.audioSamples.count - 1] > 4.2e9);
  }

  // =========================================================================
  c.head("§2 · sound against picture");
  // =========================================================================
  {
    const sync = async (spec: Parameters<typeof buildExport>[0]) => {
      const f = buildExport(spec);
      return avSyncOf(avTimingOf(await readMp4Info(f.read, f.size)));
    };
    const ok = await sync({ videoSec: 60, audioSec: 60, sound: tone });
    c.ok("in step: no words", !!ok && ok.hasAudio && avSyncWords(ok, AV_WARN_SEC) === null, JSON.stringify(ok));
    const late = await sync({ videoSec: 60, audioSec: 59.5, sound: tone, audioDelaySec: 0.5 });
    c.ok("an empty edit of 0.5 s in front of the sound: it starts 0.5 s late", !!late && Math.abs(late.startGapSec - 0.5) < 0.001, JSON.stringify(late));
    c.ok("…said: \"the sound starts 0.5 s after the picture\"", avSyncWords(late, AV_WARN_SEC) === "the sound starts 0.5 s after the picture", String(avSyncWords(late, AV_WARN_SEC)));
    const short = await sync({ videoSec: 60, audioSec: 59.4, sound: tone, priming: true });
    c.ok("sound 0.6 s shorter than the picture: \"the audio ends 0.6 s before the picture\"", avSyncWords(short, AV_WARN_SEC) === "the audio ends 0.6 s before the picture", `${JSON.stringify(short)} → ${avSyncWords(short, AV_WARN_SEC)}`);
    const past = await sync({ videoSec: 60, audioSec: 60.8, sound: tone, priming: true });
    c.ok("sound 0.8 s longer: \"the audio runs 0.8 s past the end of the picture\"", avSyncWords(past, AV_WARN_SEC) === "the audio runs 0.8 s past the end of the picture", String(avSyncWords(past, AV_WARN_SEC)));
    const primed = await sync({ videoSec: 60, audioSec: 60, sound: tone, priming: true });
    c.ok("an AAC priming edit (media_time 2112) is not a gap: starts at 0, no words", !!primed && primed.startGapSec === 0 && avSyncWords(primed, AV_WARN_SEC) === null, JSON.stringify(primed));
    const early = avSyncOf({ fragmented: false, video: { startSec: 0.4, endSec: 60 }, audio: { startSec: 0, endSec: 60, codec: "mp4a" } });
    c.ok("a picture that starts 0.4 s in (sound first): \"the sound starts 0.4 s before the picture\"", avSyncWords(early, AV_WARN_SEC) === "the sound starts 0.4 s before the picture", String(avSyncWords(early, AV_WARN_SEC)));
  }

  // =========================================================================
  c.head("§3 · the thresholds: warn past 0.25 s, hold past 0.3 s");
  // =========================================================================
  {
    const at = (gap: number) => avSyncOf({ fragmented: false, video: { startSec: 0, endSec: 60 }, audio: { startSec: 0, endSec: 60 + gap, codec: "mp4a" } });
    c.ok("the lines are 0.25 s (editor) and 0.3 s (finished file)", AV_WARN_SEC === 0.25 && AV_HOLD_SEC === 0.3);
    c.ok("0.24 s: neither warned nor held", avSyncWords(at(-0.24), AV_WARN_SEC) === null && avSyncWords(at(-0.24), AV_HOLD_SEC) === null);
    c.ok("0.25 s exactly: not warned (past the line, not on it)", avSyncWords(at(-0.25), AV_WARN_SEC) === null);
    c.ok("0.26 s: warned, not held", avSyncWords(at(-0.26), AV_WARN_SEC) !== null && avSyncWords(at(-0.26), AV_HOLD_SEC) === null);
    c.ok("0.30 s exactly: not held", avSyncWords(at(-0.3), AV_HOLD_SEC) === null);
    c.ok("0.31 s: held", avSyncWords(at(-0.31), AV_HOLD_SEC) !== null);
    c.ok("one frame (0.033 s) and AAC priming (0.044 s) are far inside", avSyncWords(at(0.033), AV_WARN_SEC) === null && avSyncWords(at(0.044), AV_WARN_SEC) === null);
    c.ok("avOffBy takes the larger gap; 0 with no sound", avOffBy({ hasAudio: true, codec: "mp4a", startGapSec: 0.1, endGapSec: -0.4 }) === 0.4 && avOffBy({ hasAudio: false, codec: null, startGapSec: 0, endGapSec: 0 }) === 0);
  }

  // =========================================================================
  c.head("§4 · no sound, empty sound, PCM sound, which track plays");
  // =========================================================================
  {
    const silent = buildExport({ videoSec: 30, audioSec: 0, sound: tone, noAudio: true });
    const s = avSyncOf(avTimingOf(await readMp4Info(silent.read, silent.size)));
    c.ok("no sound track at all: hasAudio false", !!s && s.hasAudio === false, JSON.stringify(s));
    const v: TrackSpec = { kind: "video", id: 1, timescale: 30000, duration: 30 * 30000 };
    const empty = parseMoov(moovBox({ tracks: [v, { kind: "audio", id: 2, timescale: 48000, duration: 0 }] }));
    c.ok("a sound track with no length: hasAudio false (it plays nothing)", avSyncOf(avTimingOf(empty))?.hasAudio === false);
    const pcm = parseMoov(moovBox({ tracks: [v, { kind: "audio", id: 2, timescale: 48000, duration: 30 * 48000, codec: "sowt" }] }));
    c.ok("PCM ('sowt') sound: codec named, no AAC config, no sample table expanded", pcm?.audio?.codec === "sowt" && pcm.audioEntry?.aac === null && pcm.audioSamples === null);
    const two = parseMoov(moovBox({ tracks: [v,
      { kind: "audio", id: 2, timescale: 48000, duration: 10 * 48000, enabled: false },
      { kind: "audio", id: 3, timescale: 48000, duration: 30 * 48000, enabled: true }] }));
    c.ok("two sound tracks, the first switched off: the ENABLED one is the one judged", two?.audio?.id === 3 && two.audioTracks === 2 && Math.abs(two.audio.endSec - 30) < 0.001, `id ${two?.audio?.id}`);
  }

  // =========================================================================
  c.head("§5 · QuickTime shapes");
  // =========================================================================
  {
    const v: TrackSpec = { kind: "video", id: 1, timescale: 600, duration: 60 * 600, mdhdVersion: 1 };
    for (const qt of [1, 2] as const) {
      const m = parseMoov(moovBox({ tracks: [v, { kind: "audio", id: 2, timescale: 48000, duration: 60 * 48000, qtVersion: qt, wave: true }] }));
      c.ok(`sound entry v${qt} with esds inside 'wave': AAC found (mp4a.40.2, 48 kHz)`, m?.audioEntry?.aac?.codecString === "mp4a.40.2" && m.audioEntry.aac.sampleRate === 48000, JSON.stringify(m?.audioEntry && { ...m.audioEntry, aac: m.audioEntry.aac && { ...m.audioEntry.aac, config: [...m.audioEntry.aac.config] } }));
    }
    const m1 = parseMoov(moovBox({ tracks: [v, { kind: "audio", id: 2, timescale: 48000, duration: 59 * 48000, elstVersion: 1, mdhdVersion: 1, edits: [{ segment: 700, mediaTime: -1 }, { segment: 59000, mediaTime: 0 }] }] }));
    c.ok("elst v1 + mdhd v1: a 0.7 s empty edit read as a 0.7 s late start", Math.abs((m1?.audio?.startSec ?? 0) - 0.7) < 0.001 && Math.abs((m1?.audio?.endSec ?? 0) - 59.7) < 0.001, JSON.stringify(avTimingOf(m1)));
    c.ok("…the picture's mdhd v1 (timescale 600) reads 60 s", Math.abs((m1?.video?.endSec ?? 0) - 60) < 0.001);
    const he = parseAudioSpecificConfig(Uint8Array.from([0x2b, 0x10]));
    c.ok("an HE-AAC config (object type 5, 24 kHz core) reads as such", he?.objectType === 5 && he.sampleRate === 24000 && he.channels === 2, JSON.stringify(he));
  }

  // =========================================================================
  c.head("§6 · never a guess");
  // =========================================================================
  {
    const v: TrackSpec = { kind: "video", id: 1, timescale: 30000, duration: 60 * 30000 };
    const frag = parseMoov(moovBox({ fragmented: true, tracks: [v, { kind: "audio", id: 2, timescale: 48000, duration: 0 }] }));
    c.ok("a fragmented file (mvex): parsed but flagged, and sync is not judged", frag?.fragmented === true && avSyncOf(avTimingOf(frag)) === null);
    const webm = new VirtualFile([{ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81]) }, { zero: 10_000 }]);
    c.ok("WebM: not an MP4 → null after one read", (await readMp4Info(webm.read, webm.size)) === null && webm.reads === 1, `${webm.reads} reads`);
    const good = await buildExport({ videoSec: 10, audioSec: 10, sound: tone, moovAtEnd: true }).bytes();
    const cut = new VirtualFile([{ bytes: good.subarray(0, good.length - 200) }]);
    c.ok("a file cut short on upload (moov truncated): null", (await readMp4Info(cut.read, cut.size)) === null);
    const junk = new VirtualFile([{ bytes: cat(ftyp(), box("free", str("x")), u32(3), str("moov")) }]);
    c.ok("a box claiming 3 bytes: null, no loop", (await readMp4Info(junk.read, junk.size)) === null);
    const noVideo = avSyncOf(avTimingOf(parseMoov(moovBox({ tracks: [{ kind: "audio", id: 2, timescale: 48000, duration: 48000 * 30 }] }))));
    c.ok("sound with no picture track: nothing to compare → null", noVideo === null);
    c.ok("avTimingFromMoov on garbage: null, never a throw", avTimingFromMoov(Uint8Array.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76])) === null && avTimingFromMoov(new Uint8Array(3)) === null);
  }

  // =========================================================================
  c.head("§7 · the server's path: the moov bytes probeVideoMetadata already holds");
  // =========================================================================
  {
    const moov = moovBox({ tracks: [{ kind: "video", id: 1, timescale: 30000, duration: 60 * 30000 }, { kind: "audio", id: 2, timescale: 48000, duration: Math.round(59.4 * 48000) }] });
    // A Node Buffer that is a VIEW into a larger pool, as Buffer.from often is.
    const pool = Buffer.alloc(moov.length + 4096);
    Buffer.from(moov).copy(pool, 1234);
    const view = pool.subarray(1234, 1234 + moov.length);
    const t = avTimingFromMoov(view);
    c.ok("a pooled Buffer view (byteOffset 1234) reads right", !!t && Math.abs(t.audio!.endSec - 59.4) < 0.001 && Math.abs(t.video!.endSec - 60) < 0.001, JSON.stringify(t));
    c.ok("…and the finished-file rule holds it: \"the audio ends 0.6 s before the picture\"", avSyncWords(avSyncOf(t), AV_HOLD_SEC) === "the audio ends 0.6 s before the picture");
  }

  // =========================================================================
  c.head("§8 · the words");
  // =========================================================================
  c.ok("seconds: one decimal, never 0.0", secWords(0.6) === "0.6 s" && secWords(-0.26) === "0.3 s" && secWords(0.01) === "0.1 s" && secWords(1.25) === "1.3 s");

  c.summary();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
