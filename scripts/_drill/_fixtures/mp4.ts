// ---------------------------------------------------------------------------
// SYNTHETIC MP4/MOV FILES for the sound-check drills (Oct 16 2026).
//
// Builds exactly the boxes src/lib/mp4Probe.ts walks — ftyp, mdat, moov/{mvhd,
// mvex?, trak/{tkhd, edts/elst, mdia/{mdhd, hdlr, minf/stbl/{stsd, stts, stsc,
// stsz, stco|co64}}}} — byte for byte by the ISO/QuickTime layouts, so the
// parser is proven against files it did not write itself.
//
// A VIRTUAL FILE stands in for a multi-gigabyte export: its mdat is mostly
// "virtual" zero regions that are never allocated, so a 4 GB file with moov at
// the END costs a few hundred KB of memory, and every read the parser makes is
// counted (how many, how many bytes) to prove it reads only what it needs.
//
// The "AAC" frames here are not AAC: each frame's bytes carry a tiny recipe
// (mode + amplitude) that the drills' stand-in decoder turns into 1024 frames
// of PCM, so the listening half can be driven in Node, where there is no
// WebCodecs.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
export const u8 = (...n: number[]) => Uint8Array.from(n.map((x) => x & 255));
export const u16 = (n: number) => u8(n >>> 8, n);
export const u32 = (n: number) => u8(n >>> 24, n >>> 16, n >>> 8, n);
export const i32 = (n: number) => u32(n >>> 0);
export const u64 = (n: number) => { const hi = Math.floor(n / 2 ** 32); return cat(u32(hi), u32(n >>> 0)); };
export const i64 = (n: number) => (n < 0 ? u8(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff) : u64(n));
export const str = (s: string) => enc.encode(s);
export const zeros = (n: number) => new Uint8Array(n);

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = cat(...parts);
  return cat(u32(8 + body.length), str(type), body);
}
export const fullBox = (type: string, version: number, flags: number, ...parts: Uint8Array[]) =>
  box(type, u8(version, flags >>> 16, flags >>> 8, flags), ...parts);

export const ftyp = (brand = "isom") => box("ftyp", str(brand), u32(512), str(brand), str("mp42"));

/** MPEG-4 descriptor with a 4-byte length (as most writers emit). */
const descr = (tag: number, body: Uint8Array) => cat(u8(tag, 0x80 | ((body.length >>> 21) & 0x7f), 0x80 | ((body.length >>> 14) & 0x7f), 0x80 | ((body.length >>> 7) & 0x7f), body.length & 0x7f), body);
/** AAC-LC 48 kHz stereo: 00010 0011 0010 000 → 0x11 0x90 */
export const ASC_LC_48K_STEREO = u8(0x11, 0x90);
export const esds = (asc: Uint8Array = ASC_LC_48K_STEREO) =>
  fullBox("esds", 0, 0, descr(0x03, cat(u16(1), u8(0), descr(0x04, cat(u8(0x40, 0x15), u8(0, 0, 0), u32(192000), u32(192000), descr(0x05, asc))), descr(0x06, u8(2)))));

export type Edit = { segment: number; mediaTime: number };
export type SampleLayout = { sizes: number[]; delta: number; chunkOffsets: number[]; samplesPerChunk: number };
export type TrackSpec = {
  kind: "video" | "audio";
  id: number;
  timescale: number;
  /** media duration in timescale units */
  duration: number;
  enabled?: boolean;
  edits?: Edit[];
  elstVersion?: 0 | 1;
  mdhdVersion?: 0 | 1;
  /** sample entry type: video "avc1"; audio "mp4a" | "sowt" | … */
  codec?: string;
  /** QuickTime sound sample entry version (0, 1 or 2) */
  qtVersion?: 0 | 1 | 2;
  /** esds inside a QuickTime 'wave' box */
  wave?: boolean;
  asc?: Uint8Array;
  samples?: SampleLayout;
  co64?: boolean;
  width?: number;
  height?: number;
};

function visualEntry(codec: string, w: number, h: number) {
  return box(codec, zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), i32(-1).subarray(2));
}
function audioEntry(t: TrackSpec) {
  const codec = t.codec ?? "mp4a";
  const v = t.qtVersion ?? 0;
  const kids = codec === "mp4a" ? (t.wave ? box("wave", box("frma", str("mp4a")), esds(t.asc), u32(8), u32(0)) : esds(t.asc)) : new Uint8Array(0);
  const head = cat(zeros(6), u16(1));
  if (v === 2) {
    const f64 = new Uint8Array(8);
    new DataView(f64.buffer).setFloat64(0, 48000);
    return box(codec, head, u16(2), u16(0), u32(0), u16(3), u16(16), u16(0xfffe), u16(0), u32(65536), u32(72), f64, u32(2), u32(0x7f000000), u32(16), u32(0), u32(0), u32(1), kids);
  }
  const base = cat(u16(v), u16(0), u32(0), u16(2), u16(16), u16(v === 1 ? 0xfffe : 0), u16(0), u32(48000 * 65536));
  return box(codec, head, base, v === 1 ? cat(u32(1024), u32(0), u32(0), u32(2)) : new Uint8Array(0), kids);
}

function trak(t: TrackSpec, movieTimescale: number) {
  const enabled = t.enabled ?? true;
  const mv = t.mdhdVersion ?? 0;
  const tkhd = fullBox("tkhd", 0, enabled ? 0x7 : 0x6, u32(0), u32(0), u32(t.id), u32(0), u32(Math.round((t.duration / t.timescale) * movieTimescale)), zeros(8), u16(0), u16(t.kind === "audio" ? 1 : 0), u16(t.kind === "audio" ? 0x0100 : 0), u16(0),
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
    u32(t.kind === "video" ? (t.width ?? 1920) << 16 : 0), u32(t.kind === "video" ? (t.height ?? 1080) << 16 : 0));
  const edts = t.edits
    ? box("edts", fullBox("elst", t.elstVersion ?? 0, 0, u32(t.edits.length), ...t.edits.map((e) =>
      (t.elstVersion ?? 0) === 1 ? cat(u64(e.segment), i64(e.mediaTime), u32(0x00010000)) : cat(u32(e.segment), i32(e.mediaTime), u32(0x00010000)))))
    : new Uint8Array(0);
  const mdhd = mv === 1
    ? fullBox("mdhd", 1, 0, u64(0), u64(0), u32(t.timescale), u64(t.duration), u16(0x55c4), u16(0))
    : fullBox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(t.duration), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), str(t.kind === "video" ? "vide" : "soun"), zeros(12), str("Drill\0"));
  const entry = t.kind === "video" ? visualEntry(t.codec ?? "avc1", t.width ?? 1920, t.height ?? 1080) : audioEntry(t);
  const s = t.samples;
  const count = s ? s.sizes.length : Math.max(1, Math.round(t.duration / (t.kind === "video" ? t.timescale / 30 : 1024)));
  const delta = s ? s.delta : Math.max(1, Math.round(t.duration / count));
  const sizes = s ? s.sizes : Array.from({ length: count }, () => 100);
  const offsets = s ? s.chunkOffsets : [0];
  const perChunk = s ? s.samplesPerChunk : count;
  const stbl = box("stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    fullBox("stts", 0, 0, u32(1), u32(count), u32(delta)),
    fullBox("stsc", 0, 0, u32(1), u32(1), u32(perChunk), u32(1)),
    fullBox("stsz", 0, 0, u32(0), u32(count), ...sizes.map(u32)),
    t.co64 ? fullBox("co64", 0, 0, u32(offsets.length), ...offsets.map(u64)) : fullBox("stco", 0, 0, u32(offsets.length), ...offsets.map(u32)));
  const minf = box("minf", t.kind === "video" ? fullBox("vmhd", 0, 1, zeros(8)) : fullBox("smhd", 0, 0, zeros(4)), stbl);
  return box("trak", tkhd, edts, box("mdia", mdhd, hdlr, minf));
}

export function moovBox(o: { movieTimescale?: number; movieDurationSec?: number; tracks: TrackSpec[]; fragmented?: boolean }): Uint8Array {
  const ts = o.movieTimescale ?? 1000;
  const dur = Math.round((o.movieDurationSec ?? Math.max(...o.tracks.map((t) => t.duration / t.timescale))) * ts);
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(ts), u32(dur), u32(0x00010000), u16(0x0100), zeros(10),
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000), zeros(24), u32(o.tracks.length + 1));
  return box("moov", mvhd, ...(o.fragmented ? [box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))] : []), ...o.tracks.map((t) => trak(t, ts)));
}

// ---- files --------------------------------------------------------------------

/** A file made of real byte segments and never-allocated zero regions. */
export type Segment = { bytes: Uint8Array } | { zero: number };
export class VirtualFile {
  readonly size: number;
  reads = 0;
  bytesRead = 0;
  private parts: { start: number; len: number; bytes: Uint8Array | null }[] = [];
  constructor(segments: Segment[]) {
    let o = 0;
    for (const s of segments) {
      const len = "bytes" in s ? s.bytes.length : s.zero;
      this.parts.push({ start: o, len, bytes: "bytes" in s ? s.bytes : null });
      o += len;
    }
    this.size = o;
  }
  read = async (start: number, end: number): Promise<Uint8Array<ArrayBuffer>> => {
    end = Math.min(end, this.size);
    const out = new Uint8Array(Math.max(0, end - start));
    this.reads++;
    this.bytesRead += out.length;
    for (const p of this.parts) {
      const a = Math.max(start, p.start);
      const b = Math.min(end, p.start + p.len);
      if (a >= b || !p.bytes) continue;
      out.set(p.bytes.subarray(a - p.start, b - p.start), a - start);
    }
    return out;
  };
  /** Everything, as one buffer — only for small files. */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.read(0, this.size);
  }
}

// ---- a whole export: picture + "AAC" sound, interleaved --------------------------

/** What one 1024-frame "AAC" frame should decode to. */
export type Frame = { mode: "tone" | "clip" | "silent"; amp: number };
export const FRAME_BYTES = 16;
export function encodeFrame(f: Frame): Uint8Array {
  const b = new Uint8Array(FRAME_BYTES);
  b[0] = f.mode === "tone" ? 1 : f.mode === "clip" ? 2 : 0;
  new DataView(b.buffer).setFloat32(1, f.amp);
  return b;
}
export function decodeFrame(b: Uint8Array): Frame {
  const mode = b[0] === 1 ? "tone" : b[0] === 2 ? "clip" : "silent";
  return { mode, amp: new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(1) };
}

export type ExportSpec = {
  /** picture length, seconds (30 fps, timescale 30000) */
  videoSec: number;
  /** sound length, seconds (48 kHz AAC frames of 1024) */
  audioSec: number;
  /** what the sound is at time t (seconds of media) */
  sound: (t: number) => Frame;
  /** an empty edit in front of the sound, seconds (it starts late) */
  audioDelaySec?: number;
  /** AAC priming edit (media_time 2112) like a real encoder writes */
  priming?: boolean;
  /** moov after mdat (Premiere's .mov layout) */
  moovAtEnd?: boolean;
  /** bytes of picture between sound chunks; virtual (never allocated) */
  videoChunkBytes?: number;
  samplesPerChunk?: number;
  /** no sound track at all */
  noAudio?: boolean;
  brand?: string;
};

/**
 * A complete file. The mdat holds the sound frames in chunks, each followed by
 * a (virtual) slab of picture bytes, so a window's frames are NOT contiguous on
 * disk — exactly the interleave a real export has.
 */
export function buildExport(spec: ExportSpec): VirtualFile {
  const rate = 48000;
  const frames = spec.noAudio ? 0 : Math.ceil((spec.audioSec * rate) / 1024);
  const perChunk = spec.samplesPerChunk ?? 10;
  const chunks = Math.ceil(frames / perChunk);
  const slab = spec.videoChunkBytes ?? 2000;
  const big = (chunks * (perChunk * FRAME_BYTES + slab)) + 64 > 2 ** 32 - 1;
  const ftypBytes = ftyp(spec.brand ?? "isom");

  const layout = (mdatStart: number) => {
    const headerLen = big ? 16 : 8;
    const offsets: number[] = [];
    const segs: Segment[] = [];
    let o = mdatStart + headerLen;
    for (let c = 0; c < chunks; c++) {
      const n = Math.min(perChunk, frames - c * perChunk);
      offsets.push(o);
      const bytes = cat(...Array.from({ length: n }, (_, k) => encodeFrame(spec.sound(((c * perChunk + k) * 1024) / rate))));
      segs.push({ bytes });
      segs.push({ zero: slab });
      o += bytes.length + slab;
    }
    if (!chunks) segs.push({ zero: slab });
    const total = o - mdatStart + (chunks ? 0 : slab);
    const header = big ? cat(u32(1), str("mdat"), u64(total)) : cat(u32(total), str("mdat"));
    return { offsets, segs: [{ bytes: header } as Segment, ...segs], total };
  };

  const tracks = (offsets: number[]): TrackSpec[] => {
    const video: TrackSpec = { kind: "video", id: 1, timescale: 30000, duration: Math.round(spec.videoSec * 30000), codec: "avc1" };
    if (spec.noAudio) return [video];
    const delay = spec.audioDelaySec ?? 0;
    const prime = spec.priming ? 2112 : 0;
    const audioMovieMs = Math.round(((frames * 1024 - prime) / rate) * 1000);
    const edits: Edit[] = [];
    if (delay > 0) edits.push({ segment: Math.round(delay * 1000), mediaTime: -1 });
    if (delay > 0 || prime) edits.push({ segment: Math.min(audioMovieMs, Math.round(spec.audioSec * 1000)), mediaTime: prime });
    return [video, {
      kind: "audio", id: 2, timescale: rate, duration: frames * 1024, codec: "mp4a",
      edits: edits.length ? edits : undefined, co64: big,
      samples: { sizes: Array.from({ length: frames }, () => FRAME_BYTES), delta: 1024, chunkOffsets: offsets, samplesPerChunk: perChunk },
    }];
  };

  if (spec.moovAtEnd) {
    const l = layout(ftypBytes.length);
    const moov = moovBox({ tracks: tracks(l.offsets), movieDurationSec: Math.max(spec.videoSec, spec.audioSec + (spec.audioDelaySec ?? 0)) });
    return new VirtualFile([{ bytes: ftypBytes }, ...l.segs, { bytes: moov }]);
  }
  // moov in front: its size doesn't depend on the offsets' values, so build it
  // once to measure, then again with the real offsets.
  const probe = moovBox({ tracks: tracks(layout(0).offsets), movieDurationSec: Math.max(spec.videoSec, spec.audioSec) });
  const l = layout(ftypBytes.length + probe.length);
  const moov = moovBox({ tracks: tracks(l.offsets), movieDurationSec: Math.max(spec.videoSec, spec.audioSec + (spec.audioDelaySec ?? 0)) });
  return new VirtualFile([{ bytes: ftypBytes }, { bytes: moov }, ...l.segs]);
}

/** The drills' stand-in for WebCodecs: each frame's recipe → 1024 PCM frames
 *  per channel, a 440 Hz tone (phase from its timestamp), hard-clipped for
 *  "clip", zeros for "silent". */
export function fakeDecoder(log?: { runs: number; frames: number }) {
  return async (cfg: { sampleRate: number; numberOfChannels: number }, samples: { data: Uint8Array; timestampUs: number }[]) => {
    if (log) { log.runs++; log.frames += samples.length; }
    return samples.map((s) => {
      const f = decodeFrame(s.data);
      const ch = Array.from({ length: cfg.numberOfChannels }, () => new Float32Array(1024));
      const t0 = s.timestampUs / 1e6;
      for (let i = 0; i < 1024; i++) {
        const t = t0 + i / cfg.sampleRate;
        let x = f.mode === "silent" ? 0 : f.amp * Math.sin(2 * Math.PI * 440 * t);
        if (f.mode === "clip") x = Math.max(-1, Math.min(1, x));
        for (const c of ch) c[i] = x;
      }
      return { timestampUs: s.timestampUs, sampleRate: cfg.sampleRate, channels: ch };
    });
  };
}
