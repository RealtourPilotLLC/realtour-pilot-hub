// ---------------------------------------------------------------------------
// THE MP4/MOV HEADER, READ FOR ITS SOUND (Oct 16 2026).
//
// Slack #video-editing and Jordan↔Kyle, June to October: about eighteen
// delivered or reviewed videos had something wrong with the sound — none at
// all, the voice cut off at the end, the sound "about half a second behind the
// picture after posting" (Oct 12). The file's own header answers the first and
// the last of those exactly, without playing a frame:
//
//   · is there a sound track at all ('soun' handler under moov/trak/mdia/hdlr);
//   · when does the sound start and stop on the movie's timeline, against when
//     the picture does (mdhd duration + the edit list, edts/elst — an empty edit
//     at the front of a track is exactly "this track starts late").
//
// PURE, and shaped for both sides: the editor's browser reads its local file
// with Blob.slice (CutUploader, before a byte is uploaded), and the server reads
// the finished 1080p file over HTTP ranges (integrations/topaz
// probeVideoMetadata hands this module the moov bytes it already fetched). Only
// Uint8Array and DataView — no Buffer, no DOM, no node: imports — and only the
// bytes a question needs: the top-level box headers, 16 bytes each, then moov
// (tens of KB) wherever it sits, front or END of the file (Premiere writes it at
// the end of a .mov).
//
// It never guesses. Anything it cannot read — not an MP4, a fragmented file
// whose durations live in the fragments, a truncated box — comes back null, and
// every caller treats null as "this check didn't run", never as a finding.
// ---------------------------------------------------------------------------

/** Read bytes [start, end) of the file. */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

export type Box = { type: string; start: number; headerSize: number; size: number };

/** How far apart sound and picture may start or stop before it is said out
 *  loud. The editor is WARNED past 0.25 s; the finished file is HELD past 0.3 s.
 *  For scale: one frame at 30 fps is 0.033 s, and an AAC encoder's priming adds
 *  about 0.02–0.05 s to a track that has no edit list — both far inside these. */
export const AV_WARN_SEC = 0.25;
export const AV_HOLD_SEC = 0.3;

/** A moov larger than this is not a property video's header. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
/** Top-level boxes walked before giving up (a real file has a handful). */
const MAX_TOP_BOXES = 64;
/** A sample table this long is not one this module should expand. */
const MAX_SAMPLES = 2_000_000;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u8 = (b: Uint8Array, o: number) => b[o];
const u16 = (b: Uint8Array, o: number) => view(b).getUint16(o);
const u32 = (b: Uint8Array, o: number) => view(b).getUint32(o);
const i32 = (b: Uint8Array, o: number) => view(b).getInt32(o);
/** 64-bit unsigned as a double — exact to 2^53, which every real size is. */
const u64 = (b: Uint8Array, o: number) => view(b).getUint32(o) * 2 ** 32 + view(b).getUint32(o + 4);
/** 64-bit signed; -1 (an empty edit) is the only negative value that matters. */
const i64 = (b: Uint8Array, o: number) => view(b).getInt32(o) * 2 ** 32 + view(b).getUint32(o + 4);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
/** A box type an MP4 writer would actually use: four printable characters
 *  (QuickTime allows a space, as in "raw "). WebM, a PNG or a text file fails
 *  this on its first four bytes. */
const plausibleType = (t: string) => /^[\x20-\x7e]{4}$/.test(t) && /[a-z0-9]/i.test(t);

export function readBoxAt(buf: Uint8Array, off: number, limit: number = buf.length): Box | null {
  if (off + 8 > limit || off + 8 > buf.length) return null;
  let size = u32(buf, off);
  const type = fourcc(buf, off + 4);
  let headerSize = 8;
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = u64(buf, off + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - off; // "to the end of the enclosing space"
  }
  if (size < headerSize) return null;
  return { type, start: off, headerSize, size };
}

export function* childBoxes(buf: Uint8Array, from: number, to: number): Generator<Box> {
  let off = from;
  const end = Math.min(to, buf.length);
  while (off + 8 <= end) {
    const b = readBoxAt(buf, off, end);
    if (!b || b.start + b.size > end) return;
    yield b;
    off = b.start + b.size;
  }
}

function findChild(buf: Uint8Array, from: number, to: number, type: string): Box | null {
  for (const b of childBoxes(buf, from, to)) if (b.type === type) return b;
  return null;
}

function findPath(buf: Uint8Array, box: Box, path: string[]): Box | null {
  let cur: Box | null = box;
  for (const p of path) {
    if (!cur) return null;
    cur = findChild(buf, cur.start + cur.headerSize, cur.start + cur.size, p);
  }
  return cur;
}

// ---- finding moov ---------------------------------------------------------

export type MoovLocation = { start: number; size: number; brand: string | null };

/**
 * Walk the top-level boxes by their headers alone until moov. Each step reads
 * 16 bytes; mdat (the whole video, gigabytes) is stepped over by its size, so a
 * moov at the END of a 4 GB file costs the same three or four tiny reads as one
 * at the front.
 */
export async function locateMoov(read: ReadRange, total: number): Promise<MoovLocation | null> {
  if (!(total > 16)) return null;
  let off = 0;
  let brand: string | null = null;
  for (let i = 0; i < MAX_TOP_BOXES && off + 8 <= total; i++) {
    const head = await read(off, Math.min(off + 16, total));
    if (head.length < 8) return null;
    const b = readBoxAt(head, 0, total - off);
    if (!b || !plausibleType(b.type)) return null;
    if (i === 0 && !["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "junk"].includes(b.type)) return null;
    if (b.type === "ftyp" && head.length >= 12) brand = fourcc(head, 8);
    if (b.type === "moov") {
      if (b.size > MAX_MOOV_BYTES || off + b.size > total) return null;
      return { start: off, size: b.size, brand };
    }
    off += b.size;
  }
  return null;
}

// ---- reading moov -----------------------------------------------------------

/** One track as it plays on the movie's timeline. */
export type TrackTiming = {
  id: number;
  kind: "video" | "audio";
  enabled: boolean;
  /** The sample entry's four-character format: "avc1", "hvc1", "mp4a" (AAC),
   *  "sowt"/"twos"/"in24"/"lpcm"/"ipcm" (uncompressed PCM)… */
  codec: string | null;
  /** Media timescale (mdhd) and the track's own media length in those units. */
  timescale: number;
  mediaDuration: number;
  /** Where on the movie timeline its first sample is shown, and where its last
   *  one ends — the edit list applied, seconds. */
  startSec: number;
  endSec: number;
  /** The media time (timescale units) the first shown sample comes from. */
  mediaStart: number;
};

export type AudioEntry = {
  codec: string;
  channels: number;
  sampleRate: number;
  /** AAC only: what WebCodecs needs to decode it. */
  aac: { codecString: string; objectType: number; config: Uint8Array; sampleRate: number; channels: number } | null;
};

/** The audio track's samples: where each one is in the file, and when. */
export type SampleTable = {
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** media time (timescale units) each sample starts at */
  times: Float64Array;
  durations: Uint32Array;
};

export type Mp4Info = {
  brand: string | null;
  movieTimescale: number;
  movieDurationSec: number;
  /** moof-style files keep their real durations in the fragments; the header's
   *  numbers are not the file's, so timing checks do not run on them. */
  fragmented: boolean;
  video: TrackTiming | null;
  audio: TrackTiming | null;
  audioTracks: number;
  audioEntry: AudioEntry | null;
  audioSamples: SampleTable | null;
};

/** The two facts the sound checks compare — small enough to travel anywhere
 *  (VideoMeta.timing on the server, the uploader's report in the browser). */
export type AvTiming = {
  fragmented: boolean;
  video: { startSec: number; endSec: number } | null;
  audio: { startSec: number; endSec: number; codec: string | null } | null;
};

function handlerOf(buf: Uint8Array, trak: Box): string | null {
  const hdlr = findPath(buf, trak, ["mdia", "hdlr"]);
  if (!hdlr) return null;
  // hdlr body: version+flags(4), pre_defined / component type(4), handler_type(4)
  const o = hdlr.start + hdlr.headerSize + 8;
  return o + 4 <= hdlr.start + hdlr.size ? fourcc(buf, o) : null;
}

type Edit = { segment: number; mediaTime: number };

function editsOf(buf: Uint8Array, trak: Box): Edit[] | null {
  const elst = findPath(buf, trak, ["edts", "elst"]);
  if (!elst) return null;
  const body = elst.start + elst.headerSize;
  const end = elst.start + elst.size;
  if (body + 8 > end) return null;
  const version = u8(buf, body);
  const count = u32(buf, body + 4);
  const step = version === 1 ? 20 : 12;
  const edits: Edit[] = [];
  for (let i = 0, o = body + 8; i < count && o + step <= end; i++, o += step) {
    edits.push(version === 1
      ? { segment: u64(buf, o), mediaTime: i64(buf, o + 8) }
      : { segment: u32(buf, o), mediaTime: i32(buf, o + 4) });
  }
  return edits;
}

function trackTiming(buf: Uint8Array, trak: Box, kind: "video" | "audio", movieTimescale: number): TrackTiming | null {
  const tkhd = findChild(buf, trak.start + trak.headerSize, trak.start + trak.size, "tkhd");
  const mdhd = findPath(buf, trak, ["mdia", "mdhd"]);
  if (!mdhd) return null;
  const mb = mdhd.start + mdhd.headerSize;
  const mv = u8(buf, mb);
  if (mb + (mv === 1 ? 32 : 20) > mdhd.start + mdhd.size) return null;
  const timescale = mv === 1 ? u32(buf, mb + 20) : u32(buf, mb + 12);
  const mediaDuration = mv === 1 ? u64(buf, mb + 24) : u32(buf, mb + 16);
  if (!(timescale > 0)) return null;
  // An all-ones duration means "unknown" (a file still being written).
  if (mediaDuration === 0xffffffff || mediaDuration >= 2 ** 53) return null;

  let id = 0;
  let enabled = true;
  if (tkhd) {
    const tb = tkhd.start + tkhd.headerSize;
    if (tb + 16 <= tkhd.start + tkhd.size) {
      enabled = (u32(buf, tb) & 0x1) === 1 || (u32(buf, tb) & 0xffffff) === 0; // flags; 0 = old writers that never set it
      id = u8(buf, tb) === 1 ? u32(buf, tb + 20) : u32(buf, tb + 12);
    }
  }

  const stsd = findPath(buf, trak, ["mdia", "minf", "stbl", "stsd"]);
  const entry = stsd ? readBoxAt(buf, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size) : null;

  const mediaSec = mediaDuration / timescale;
  let startSec = 0;
  let endSec = mediaSec;
  let mediaStart = 0;
  const edits = editsOf(buf, trak);
  if (edits && edits.length && movieTimescale > 0) {
    let t = 0;
    let first: number | null = null;
    for (const e of edits) {
      if (e.mediaTime === -1) { t += e.segment; continue; }
      if (first === null) { first = t; mediaStart = e.mediaTime; }
      // A zero segment duration on a real edit means "the rest of the media".
      t += e.segment > 0 ? e.segment : Math.max(0, (mediaDuration - e.mediaTime) / timescale) * movieTimescale;
    }
    startSec = (first ?? t) / movieTimescale;
    endSec = t / movieTimescale;
  }
  return { id, kind, enabled, codec: entry ? entry.type : null, timescale, mediaDuration, startSec, endSec, mediaStart };
}

// ---- the audio sample entry, esds and the AAC config ------------------------

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** MPEG-4 AudioSpecificConfig: object type, sample rate, channels. */
export function parseAudioSpecificConfig(cfg: Uint8Array): { objectType: number; sampleRate: number; channels: number } | null {
  if (cfg.length < 2) return null;
  let bit = 0;
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >> 3 >= cfg.length) throw new Error("short");
      v = (v << 1) | ((cfg[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  try {
    let objectType = bits(5);
    if (objectType === 31) objectType = 32 + bits(6);
    const fi = bits(4);
    const sampleRate = fi === 15 ? bits(24) : AAC_RATES[fi] ?? 0;
    const channels = bits(4);
    return sampleRate > 0 ? { objectType, sampleRate, channels } : null;
  } catch {
    return null;
  }
}

/** Walk an esds box's descriptors to the DecoderSpecificInfo (tag 5). */
function esdsConfig(buf: Uint8Array, esds: Box): { oti: number; config: Uint8Array } | null {
  const end = esds.start + esds.size;
  let o = esds.start + esds.headerSize + 4; // version + flags
  const descr = (at: number): { tag: number; len: number; body: number } | null => {
    if (at + 2 > end) return null;
    const tag = buf[at];
    let len = 0;
    let p = at + 1;
    for (let i = 0; i < 4 && p < end; i++) {
      const b = buf[p++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return p + len <= end ? { tag, len, body: p } : null;
  };
  const es = descr(o);
  if (!es || es.tag !== 0x03) return null;
  o = es.body + 2; // ES_ID
  const flags = buf[o++];
  if (flags & 0x80) o += 2; // streamDependence
  if (flags & 0x40) o += 1 + buf[o]; // URL
  if (flags & 0x20) o += 2; // OCR stream
  const dc = descr(o);
  if (!dc || dc.tag !== 0x04 || dc.len < 13) return null;
  const oti = buf[dc.body];
  const dsi = descr(dc.body + 13);
  if (!dsi || dsi.tag !== 0x05 || dsi.len < 2) return null;
  return { oti, config: buf.slice(dsi.body, dsi.body + dsi.len) };
}

function audioEntryOf(buf: Uint8Array, trak: Box): AudioEntry | null {
  const stsd = findPath(buf, trak, ["mdia", "minf", "stbl", "stsd"]);
  const entry = stsd ? readBoxAt(buf, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size) : null;
  if (!entry) return null;
  const body = entry.start + entry.headerSize;
  const end = entry.start + entry.size;
  if (body + 28 > end) return { codec: entry.type, channels: 0, sampleRate: 0, aac: null };
  // ISO AudioSampleEntry, with QuickTime's version 1 and 2 extensions.
  const version = u16(buf, body + 8);
  let channels = u16(buf, body + 16);
  let sampleRate = u32(buf, body + 24) / 65536;
  let kids = body + 28;
  if (version === 1) kids = body + 44;
  else if (version === 2 && body + 64 <= end) {
    sampleRate = view(buf).getFloat64(body + 32);
    channels = u32(buf, body + 40);
    kids = body + 64;
  }
  let aac: AudioEntry["aac"] = null;
  if (entry.type === "mp4a" && kids < end) {
    // MP4: esds is a child. QuickTime: inside a 'wave' box.
    let esds = findChild(buf, kids, end, "esds");
    if (!esds) {
      const wave = findChild(buf, kids, end, "wave");
      if (wave) esds = findChild(buf, wave.start + wave.headerSize, wave.start + wave.size, "esds");
    }
    const dsi = esds ? esdsConfig(buf, esds) : null;
    const asc = dsi && dsi.oti === 0x40 ? parseAudioSpecificConfig(dsi.config) : null;
    if (dsi && asc) {
      aac = {
        codecString: `mp4a.40.${asc.objectType}`,
        objectType: asc.objectType,
        config: dsi.config,
        // The config's own numbers: the sample entry's are the CORE rate for
        // HE-AAC and 0 for anything over 65535 Hz.
        sampleRate: asc.sampleRate,
        channels: asc.channels || channels,
      };
    }
  }
  return { codec: entry.type, channels, sampleRate, aac };
}

function sampleTableOf(buf: Uint8Array, trak: Box): SampleTable | null {
  const stbl = findPath(buf, trak, ["mdia", "minf", "stbl"]);
  if (!stbl) return null;
  const inStbl = (t: string) => findChild(buf, stbl.start + stbl.headerSize, stbl.start + stbl.size, t);
  const stsz = inStbl("stsz");
  const stsc = inStbl("stsc");
  const stts = inStbl("stts");
  const stco = inStbl("stco");
  const co64 = stco ? null : inStbl("co64");
  if (!stsz || !stsc || !stts || !(stco || co64)) return null;

  const zb = stsz.start + stsz.headerSize;
  const fixed = u32(buf, zb + 4);
  const count = u32(buf, zb + 8);
  if (!(count > 0) || count > MAX_SAMPLES) return null;
  const sizes = new Uint32Array(count);
  if (fixed) sizes.fill(fixed);
  else {
    if (zb + 12 + count * 4 > stsz.start + stsz.size) return null;
    for (let i = 0; i < count; i++) sizes[i] = u32(buf, zb + 12 + i * 4);
  }

  const cbox = (stco ?? co64)!;
  const cb = cbox.start + cbox.headerSize;
  const chunks = u32(buf, cb + 4);
  const wide = !!co64;
  if (cb + 8 + chunks * (wide ? 8 : 4) > cbox.start + cbox.size) return null;
  const chunkOffset = (c: number) => (wide ? u64(buf, cb + 8 + c * 8) : u32(buf, cb + 8 + c * 4));

  const sb = stsc.start + stsc.headerSize;
  const runs = u32(buf, sb + 4);
  if (sb + 8 + runs * 12 > stsc.start + stsc.size || runs === 0) return null;
  const offsets = new Float64Array(count);
  let s = 0;
  for (let r = 0; r < runs && s < count; r++) {
    const firstChunk = u32(buf, sb + 8 + r * 12) - 1;
    const perChunk = u32(buf, sb + 8 + r * 12 + 4);
    const nextFirst = r + 1 < runs ? u32(buf, sb + 8 + (r + 1) * 12) - 1 : chunks;
    for (let c = firstChunk; c < nextFirst && c < chunks && s < count; c++) {
      let at = chunkOffset(c);
      for (let k = 0; k < perChunk && s < count; k++, s++) {
        offsets[s] = at;
        at += sizes[s];
      }
    }
  }
  if (s !== count) return null;

  const tb = stts.start + stts.headerSize;
  const entries = u32(buf, tb + 4);
  if (tb + 8 + entries * 8 > stts.start + stts.size) return null;
  const times = new Float64Array(count);
  const durations = new Uint32Array(count);
  let t = 0;
  s = 0;
  for (let e = 0; e < entries && s < count; e++) {
    const n = u32(buf, tb + 8 + e * 8);
    const d = u32(buf, tb + 12 + e * 8);
    for (let k = 0; k < n && s < count; k++, s++) {
      times[s] = t;
      durations[s] = d;
      t += d;
    }
  }
  if (s !== count) return null;
  return { count, offsets, sizes, times, durations };
}

/**
 * Parse a moov box. `moov` holds the whole box, header included, starting at
 * byte 0 (exactly what a ranged read of [moov.start, moov.start + moov.size)
 * returns). `samples: true` also expands the AAC track's sample table, which
 * only the browser's short decode needs.
 */
export function parseMoov(moov: Uint8Array, opts: { brand?: string | null; samples?: boolean } = {}): Mp4Info | null {
  const top = readBoxAt(moov, 0);
  if (!top || top.type !== "moov" || top.size > moov.length) return null;
  const mvhd = findChild(moov, top.headerSize, top.size, "mvhd");
  if (!mvhd) return null;
  const vb = mvhd.start + mvhd.headerSize;
  const mvv = u8(moov, vb);
  const movieTimescale = mvv === 1 ? u32(moov, vb + 20) : u32(moov, vb + 12);
  const movieDuration = mvv === 1 ? u64(moov, vb + 24) : u32(moov, vb + 16);
  if (!(movieTimescale > 0)) return null;
  const fragmented = !!findChild(moov, top.headerSize, top.size, "mvex");

  let video: TrackTiming | null = null;
  let audio: TrackTiming | null = null;
  let audioTrak: Box | null = null;
  let audioTracks = 0;
  for (const trak of childBoxes(moov, top.headerSize, top.size)) {
    if (trak.type !== "trak") continue;
    const handler = handlerOf(moov, trak);
    if (handler === "vide") {
      const t = trackTiming(moov, trak, "video", movieTimescale);
      if (t && (!video || (!video.enabled && t.enabled))) video = t;
    } else if (handler === "soun") {
      audioTracks++;
      const t = trackTiming(moov, trak, "audio", movieTimescale);
      // The first ENABLED sound track is the one a player plays.
      if (t && (!audio || (!audio.enabled && t.enabled))) { audio = t; audioTrak = trak; }
    }
  }
  const audioEntry = audioTrak ? audioEntryOf(moov, audioTrak) : null;
  const audioSamples = opts.samples && audioTrak && audioEntry?.aac ? sampleTableOf(moov, audioTrak) : null;
  return {
    brand: opts.brand ?? null,
    movieTimescale,
    movieDurationSec: movieDuration / movieTimescale,
    fragmented,
    video,
    audio,
    audioTracks,
    audioEntry,
    audioSamples,
  };
}

/** The A/V summary of a parsed header. */
export function avTimingOf(info: Mp4Info | null): AvTiming | null {
  if (!info) return null;
  return {
    fragmented: info.fragmented,
    video: info.video ? { startSec: round3(info.video.startSec), endSec: round3(info.video.endSec) } : null,
    audio: info.audio ? { startSec: round3(info.audio.startSec), endSec: round3(info.audio.endSec), codec: info.audio.codec } : null,
  };
}

/** The A/V summary straight from moov bytes; null when it can't be read. Never
 *  throws — a header this module can't follow is "didn't run". */
export function avTimingFromMoov(moov: Uint8Array): AvTiming | null {
  try {
    return avTimingOf(parseMoov(moov));
  } catch {
    return null;
  }
}

/** Read a whole file's header through `read`: locate moov, fetch it, parse. */
export async function readMp4Info(read: ReadRange, total: number, opts: { samples?: boolean } = {}): Promise<Mp4Info | null> {
  try {
    const loc = await locateMoov(read, total);
    if (!loc) return null;
    const moov = await read(loc.start, loc.start + loc.size);
    if (moov.length !== loc.size) return null;
    return parseMoov(moov, { brand: loc.brand, samples: opts.samples });
  } catch {
    return null;
  }
}

/** A Blob (the editor's chosen File) as a ReadRange. Browser only at call time. */
export const blobReader = (blob: Blob): ReadRange => async (start, end) =>
  new Uint8Array(await blob.slice(start, end).arrayBuffer());

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---- comparing sound with picture ------------------------------------------

/**
 * Where the sound sits against the picture. null = there is nothing honest to
 * say (no picture track, a fragmented file, a track with no length).
 *   hasAudio   false = no sound track at all, or one with no length
 *   startGap   + the sound starts late, − it starts early (seconds)
 *   endGap     + the sound runs past the picture, − it stops before it
 */
export type AvSync = { hasAudio: boolean; codec: string | null; startGapSec: number; endGapSec: number };

export function avSyncOf(t: AvTiming | null | undefined): AvSync | null {
  if (!t || t.fragmented || !t.video) return null;
  const v = t.video;
  if (!(v.endSec - v.startSec > 0.1)) return null;
  const a = t.audio;
  if (!a || !(a.endSec - a.startSec > 0.05)) return { hasAudio: false, codec: a?.codec ?? null, startGapSec: 0, endGapSec: 0 };
  return {
    hasAudio: true,
    codec: a.codec,
    startGapSec: round3(a.startSec - v.startSec),
    endGapSec: round3(a.endSec - v.endSec),
  };
}

/** The larger of the two gaps, seconds (0 when there is no sound to compare). */
export const avOffBy = (s: AvSync | null): number => (s && s.hasAudio ? Math.max(Math.abs(s.startGapSec), Math.abs(s.endGapSec)) : 0);

/** "0.6 s" — one decimal, never "0.0". */
export const secWords = (n: number): string => `${Math.max(0.1, Math.round(Math.abs(n) * 10) / 10).toFixed(1)} s`;

/**
 * The sync problem in plain words, or null when sound and picture line up
 * within `limit` seconds. The start is said before the end: a late start is
 * the "sound behind the picture" the client heard on Oct 12, and it moves the
 * end too.
 */
export function avSyncWords(s: AvSync | null, limit: number): string | null {
  if (!s || !s.hasAudio) return null;
  if (Math.abs(s.startGapSec) > limit) {
    return s.startGapSec > 0
      ? `the sound starts ${secWords(s.startGapSec)} after the picture`
      : `the sound starts ${secWords(s.startGapSec)} before the picture`;
  }
  if (Math.abs(s.endGapSec) > limit) {
    return s.endGapSec < 0
      ? `the audio ends ${secWords(s.endGapSec)} before the picture`
      : `the audio runs ${secWords(s.endGapSec)} past the end of the picture`;
  }
  return null;
}

/** PCM sample formats, in words (the Sep 17 silent video was "ipcm"). */
export const PCM_CODECS = ["ipcm", "lpcm", "sowt", "twos", "in24", "in32", "fl32", "fl64", "raw "];
