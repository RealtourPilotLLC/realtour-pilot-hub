// ---------------------------------------------------------------------------
// THE DEMO'S VIDEO FILE — one short clip every demo cut plays and downloads.
//
//   import { DEMO_CLIP_URL, demoClipUrlFor, ensureSampleClip, startSampleServer } from "./sample";
//
// WHY THE URL LOOKS LIKE VERCEL BLOB. The cut stream route (src/app/api/review/
// cut/[id]/stream/route.ts) serves a hub-uploaded cut by proxying its blobUrl,
// and src/lib/reviewCuts.ts blobFetchDecision refuses any host that is not
// `*.blob.vercel-storage.com` ("unreadable", 502). A plain http://127.0.0.1 URL
// would therefore never play, and the only other door is Dropbox. So the demo
// stores a Vercel-shaped URL on an invented PUBLIC store (demo-config.json
// blobHost) and the demo dev server's network fence (demo-preload.cjs) answers
// that host from the local server below. The route, its gate, the release rule
// and the download door all run exactly as shipped; only the bytes are local.
// If the fence were ever missing, the request would go to a store that does not
// exist and the player would show an error — nothing real is behind that name.
//
// WHY NO FFMPEG. The clip is written here, byte by byte: H.264 Constrained
// Baseline with every macroblock I_PCM (raw samples — no transform, no entropy
// coding to get wrong), every frame an IDR, muxed into a faststart MP4 with the
// SPS/PPS in avcC. ~1.3 MB, 3 s, 144x256 portrait like a reel, a colour-bar
// field with a white band sweeping down so playback visibly moves. Deterministic:
// the same bytes on every machine, and no binary checked into public/.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import config from "./demo-config.json";

export const DEMO_BLOB_HOST: string = config.blobHost;
export const DEMO_SAMPLE_PORT: number = config.samplePort;
/** Where the fence forwards the invented store to. Loopback only. */
export const DEMO_SAMPLE_ORIGIN = `http://127.0.0.1:${DEMO_SAMPLE_PORT}`;
/** Every cut path on the invented store lives under this prefix (the real store's own prefix). */
export const DEMO_CLIP_PREFIX = "review-cuts/demo";
/** The one clip, at a stable address — what a fixture stores as a cut's blobUrl. */
export const DEMO_CLIP_URL = `https://${DEMO_BLOB_HOST}/${DEMO_CLIP_PREFIX}/sample-reel.mp4`;
/** A distinct address per cut (same bytes). Distinct so each row reads as its own upload. */
export const demoClipUrlFor = (key: string) => `https://${DEMO_BLOB_HOST}/${DEMO_CLIP_PREFIX}/${key.replace(/[^A-Za-z0-9_-]/g, "")}.mp4`;
export const isDemoClipUrl = (url: string | null | undefined) => {
  try { return new URL(url ?? "").host === DEMO_BLOB_HOST; } catch { return false; }
};

// ---- H.264 --------------------------------------------------------------

const W = 144; // 9 macroblocks
const H = 256; // 16 macroblocks
const FPS = 8;
const FRAMES = 24;
const TIMESCALE = 1000;

class Bits {
  private out: number[] = [];
  private cur = 0;
  private n = 0;
  u(value: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  /** Exp-Golomb, unsigned. */
  ue(v: number) {
    const x = v + 1;
    const len = 32 - Math.clz32(x);
    this.u(0, len - 1);
    this.u(x, len);
  }
  se(v: number) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); }
  get aligned() { return this.n === 0; }
  alignZero() { while (this.n !== 0) this.u(0, 1); }
  bytes(b: Uint8Array) {
    if (!this.aligned) throw new Error("byte write on an unaligned stream");
    for (const x of b) this.out.push(x);
  }
  /** rbsp_trailing_bits: a stop bit, then zeros to the byte boundary. */
  trailing(): Uint8Array {
    this.u(1, 1);
    this.alignZero();
    return Uint8Array.from(this.out);
  }
}

/** RBSP → NAL unit: header byte plus emulation prevention (00 00 0x → 00 00 03 0x for x ≤ 3). */
function nal(refIdc: number, type: number, rbsp: Uint8Array): Buffer {
  const out: number[] = [(refIdc << 5) | type];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

function sps(): Buffer {
  const b = new Bits();
  b.u(66, 8); // profile_idc: Baseline
  b.u(0b11000000, 8); // constraint_set0 + set1: Constrained Baseline
  b.u(30, 8); // level 3.0
  b.ue(0); // seq_parameter_set_id
  b.ue(0); // log2_max_frame_num_minus4
  b.ue(2); // pic_order_cnt_type 2: output order = decode order
  b.ue(1); // max_num_ref_frames
  b.u(0, 1); // gaps_in_frame_num_value_allowed_flag
  b.ue(W / 16 - 1);
  b.ue(H / 16 - 1);
  b.u(1, 1); // frame_mbs_only_flag
  b.u(1, 1); // direct_8x8_inference_flag
  b.u(0, 1); // frame_cropping_flag
  b.u(0, 1); // vui_parameters_present_flag
  return nal(3, 7, b.trailing());
}

function pps(): Buffer {
  const b = new Bits();
  b.ue(0); // pic_parameter_set_id
  b.ue(0); // seq_parameter_set_id
  b.u(0, 1); // entropy_coding_mode_flag: CAVLC
  b.u(0, 1); // bottom_field_pic_order_in_frame_present_flag
  b.ue(0); // num_slice_groups_minus1
  b.ue(0); // num_ref_idx_l0_default_active_minus1
  b.ue(0); // num_ref_idx_l1_default_active_minus1
  b.u(0, 1); // weighted_pred_flag
  b.u(0, 2); // weighted_bipred_idc
  b.se(0); // pic_init_qp_minus26
  b.se(0); // pic_init_qs_minus26
  b.se(0); // chroma_qp_index_offset
  b.u(0, 1); // deblocking_filter_control_present_flag (PCM blocks filter at qP 0: a no-op)
  b.u(0, 1); // constrained_intra_pred_flag
  b.u(0, 1); // redundant_pic_cnt_present_flag
  return nal(3, 8, b.trailing());
}

/** BT.601 video-range YCbCr — never 0, so a sample can never start a start code. */
function ycc(r: number, g: number, bl: number): [number, number, number] {
  const y = 16 + (65.481 * r + 128.553 * g + 24.966 * bl) / 255;
  const cb = 128 + (-37.797 * r - 74.203 * g + 112 * bl) / 255;
  const cr = 128 + (112 * r - 93.786 * g - 18.214 * bl) / 255;
  return [Math.round(y), Math.round(cb), Math.round(cr)];
}

const BARS: [number, number, number][] = [
  [191, 191, 191], [191, 191, 0], [0, 191, 191], [0, 191, 0], [191, 0, 191], [191, 0, 0], [0, 0, 191],
].map(([r, g, b]) => ycc(r, g, b));
const BAND = ycc(235, 235, 235);
const FLOOR = ycc(24, 32, 56);

/** Frame i's colour at (x, y): bars in the upper two thirds, a dark floor, a white band sweeping down. */
function pixel(i: number, x: number, y: number): [number, number, number] {
  const bandTop = Math.floor((i / FRAMES) * (H - 24));
  if (y >= bandTop && y < bandTop + 24) return BAND;
  if (y >= Math.floor((H * 2) / 3)) return FLOOR;
  return BARS[Math.min(BARS.length - 1, Math.floor((x / W) * BARS.length))];
}

function idrSlice(i: number): Buffer {
  const b = new Bits();
  b.ue(0); // first_mb_in_slice
  b.ue(7); // slice_type: I (every slice in the picture)
  b.ue(0); // pic_parameter_set_id
  b.u(0, 4); // frame_num (IDR)
  b.ue(i % 2); // idr_pic_id: consecutive IDRs must differ
  b.u(0, 1); // no_output_of_prior_pics_flag
  b.u(0, 1); // long_term_reference_flag
  b.se(0); // slice_qp_delta
  const sample = new Uint8Array(384);
  for (let my = 0; my < H / 16; my++) {
    for (let mx = 0; mx < W / 16; mx++) {
      b.ue(25); // mb_type I_PCM
      b.alignZero(); // pcm_alignment_zero_bit
      let k = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sample[k++] = pixel(i, mx * 16 + x, my * 16 + y)[0];
      // 4:2:0 — one chroma sample per 2x2 block, taken from its top-left pixel.
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sample[k++] = pixel(i, mx * 16 + 2 * x, my * 16 + 2 * y)[1];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sample[k++] = pixel(i, mx * 16 + 2 * x, my * 16 + 2 * y)[2];
      b.bytes(sample);
    }
  }
  return nal(3, 5, b.trailing());
}

// ---- MP4 ----------------------------------------------------------------

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) =>
  box(type, u8(version), Buffer.from([(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

function mp4(spsNal: Buffer, ppsNal: Buffer, samples: Buffer[], chunkOffset: number): { moov: Buffer; ftyp: Buffer } {
  const delta = TIMESCALE / FPS;
  const duration = samples.length * delta;
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1"));
  const avcC = box("avcC", u8(1), u8(spsNal[1]), u8(spsNal[2]), u8(spsNal[3]), u8(0xff), u8(0xe1), u16(spsNal.length), spsNal, u8(1), u16(ppsNal.length), ppsNal);
  const avc1 = box(
    "avc1",
    Buffer.alloc(6), u16(1), // reserved, data_reference_index
    Buffer.alloc(16), // pre_defined, reserved, pre_defined[3]
    u16(W), u16(H), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    Buffer.alloc(32), // compressorname
    u16(0x0018), u16(0xffff),
    avcC,
  );
  const stbl = box(
    "stbl",
    full("stsd", 0, 0, u32(1), avc1),
    full("stts", 0, 0, u32(1), u32(samples.length), u32(delta)),
    full("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
    full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.length))),
    full("stco", 0, 0, u32(1), u32(chunkOffset)),
    // No stss: every sample is an IDR, so every sample is a sync sample.
  );
  const minf = box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const mdia = box(
    "mdia",
    full("mdhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "latin1")),
    minf,
  );
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(W << 16), u32(H << 16));
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  return { ftyp, moov: box("moov", mvhd, box("trak", tkhd, mdia)) };
}

/** The whole clip, as bytes. Pure and deterministic. */
export function buildSampleMp4(): Buffer {
  const spsNal = sps();
  const ppsNal = pps();
  // Each MP4 sample is the slice NAL with a 4-byte length prefix (avcC lengthSizeMinusOne = 3).
  const samples = Array.from({ length: FRAMES }, (_, i) => {
    const n = idrSlice(i);
    return Buffer.concat([u32(n.length), n]);
  });
  const mdatBody = Buffer.concat(samples);
  // moov's size does not depend on the offset's VALUE, so measure it once, then write the real one.
  const probe = mp4(spsNal, ppsNal, samples, 0);
  const offset = probe.ftyp.length + probe.moov.length + 8;
  const { ftyp, moov } = mp4(spsNal, ppsNal, samples, offset);
  return Buffer.concat([ftyp, moov, u32(8 + mdatBody.length), Buffer.from("mdat", "latin1"), mdatBody]);
}

export const SAMPLE_FILE_NAME = "sample-reel.mp4";

/** Write the clip into `dir` if it is not already there; returns its path. */
export function ensureSampleClip(dir: string): string {
  const file = path.join(dir, SAMPLE_FILE_NAME);
  const bytes = buildSampleMp4();
  let current: Buffer | null = null;
  try { current = fs.readFileSync(file); } catch { /* first run */ }
  if (!current || !current.equals(bytes)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return file;
}

// ---- the local server -----------------------------------------------------

/**
 * Serve the clip at ANY `/review-cuts/...mp4` path on 127.0.0.1, with Range
 * support (a <video> element seeks with Range and expects 206). The fence
 * forwards the invented Blob host here; nothing else ever calls it.
 */
export function startSampleServer(file: string, port = DEMO_SAMPLE_PORT): Promise<{ port: number; stop: () => Promise<void>; hits: () => number }> {
  const bytes = fs.readFileSync(file);
  let hits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if ((req.method !== "GET" && req.method !== "HEAD") || !/^\/review-cuts\/.+\.mp4$/.test(url.pathname)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not a demo clip");
      return;
    }
    hits++;
    const total = bytes.length;
    const common = { "content-type": "video/mp4", "accept-ranges": "bytes", etag: `"demo-${total}"`, "last-modified": new Date(0).toUTCString(), "cache-control": "no-store" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : total - 1;
      end = Math.min(end, total - 1);
      if (start > end || start >= total) {
        res.writeHead(416, { ...common, "content-range": `bytes */${total}` });
        res.end();
        return;
      }
      start = Math.max(0, start);
      res.writeHead(206, { ...common, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${total}` });
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...common, "content-length": String(total) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        hits: () => hits,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// `npx tsx scripts/demo/sample.ts [out.mp4]` writes the clip on its own, for a look.
if (require.main === module) {
  const out = process.argv[2] ?? path.join(process.cwd(), SAMPLE_FILE_NAME);
  fs.writeFileSync(out, buildSampleMp4());
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
}
