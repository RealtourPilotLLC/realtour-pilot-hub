import "server-only";

import sharp from "sharp";

// ---------------------------------------------------------------------------
// QC DERIVATIVES (prompt pack 0.2, plan §3.4).
//
// Every derivative follows 0.2: EXIF orientation applied first, resized "fit
// inside" without enlargement, sRGB, JPEG quality 85, metadata stripped (no
// GPS leaves the building), and the sent width and height READ BACK from
// sharp's info: those exact numbers go into the prompt and into the box
// rescaling, never a size computed from the aspect ratio.
//
// One more rule makes rebuilds safe: the target size of every derivative is
// computed from the photo's ORIENTED full-resolution dimensions alone
// (fitInside), so a derivative built during the QC run from the 3000 px CV
// raster and one rendered later by the image route straight from the source
// come out the same size, to the pixel.
//
// Sizes: thumb256 (UI grid), thumb768 (P2 overview), qc1024 (P0, P2 cluster),
// qc2048 (P1 and the arbiter; QC_LONG_EDGE, default 2048), qc1568 (only for a
// fallback model without the high-resolution tier), crop512 (P1b, cut at FULL
// resolution) and region768 (post-fix target region, on demand).
//
// Memory: one photo's source bytes and its 3000 px raster live only inside the
// function that needs them; the small JPEGs that come out go to a bounded
// in-process LRU (derivCache) so the next pass in the same tick, or the next
// tick on a warm instance, does not download the photo again.
// ---------------------------------------------------------------------------

export const UI_SIZES = ["thumb256", "thumb768", "qc1024", "qc2048"] as const;
export type UiSize = (typeof UI_SIZES)[number];
export type DerivSize = UiSize | "qc1568";

/** The CV raster's long edge (plan §7.3: dust candidates at about 3000 px). */
export const CV_EDGE = 3000;
const LIMIT_INPUT_PIXELS = 150_000_000;
const JPEG_QUALITY = 85;
const CROP_QUALITY = 92; // dust is subtle: keep compression artifacts out of the crops

export function qcLongEdge(): number {
  const n = Number(process.env.QC_LONG_EDGE);
  return Number.isFinite(n) && n > 0 ? Math.max(1024, Math.min(2576, Math.round(n))) : 2048;
}

export function edgeOf(size: DerivSize): number {
  switch (size) {
    case "thumb256": return 256;
    case "thumb768": return 768;
    case "qc1024": return 1024;
    case "qc1568": return 1568;
    case "qc2048": return qcLongEdge();
  }
}

/** The inspection derivative for a model whose image limit is `maxLongEdge`. */
export function inspectionSize(maxLongEdge: number): "qc2048" | "qc1568" {
  return maxLongEdge >= qcLongEdge() ? "qc2048" : "qc1568";
}

/** Fit (W, H) inside a square of `edge` without enlarging. Deterministic. */
export function fitInside(W: number, H: number, edge: number): { w: number; h: number } {
  const long = Math.max(W, H);
  if (long <= edge) return { w: W, h: H };
  const s = edge / long;
  return W >= H ? { w: edge, h: Math.max(1, Math.round(H * s)) } : { w: Math.max(1, Math.round(W * s)), h: edge };
}

export type SourceMeta = {
  format: string | null;
  /** Oriented (display) dimensions: what every box is measured against. */
  width: number;
  height: number;
  orientation: number;
  space: string | null;
  depth: string | null;
  channels: number | null;
  hasAlpha: boolean;
  hasProfile: boolean;
  iccName: string | null;
  bytes: number;
};

/** Minimal ICC 'desc' reader: the profile's description string, or null. */
export function iccDescription(icc: Buffer | undefined | null): string | null {
  if (!icc || icc.length < 132) return null;
  try {
    const count = icc.readUInt32BE(128);
    for (let i = 0; i < Math.min(count, 100); i++) {
      const at = 132 + i * 12;
      if (at + 12 > icc.length) break;
      if (icc.toString("ascii", at, at + 4) !== "desc") continue;
      const off = icc.readUInt32BE(at + 4);
      const size = icc.readUInt32BE(at + 8);
      if (off + 12 > icc.length) return null;
      const type = icc.toString("ascii", off, off + 4);
      if (type === "desc") {
        const n = icc.readUInt32BE(off + 8);
        return icc.toString("latin1", off + 12, Math.min(off + 12 + n, off + size, icc.length)).replace(/\u0000+$/g, "").trim() || null;
      }
      if (type === "mluc") {
        const recs = icc.readUInt32BE(off + 8);
        if (!recs) return null;
        const len = icc.readUInt32BE(off + 20);
        const start = off + icc.readUInt32BE(off + 24);
        const buf = icc.subarray(start, Math.min(start + len, icc.length));
        let s = "";
        for (let j = 0; j + 1 < buf.length; j += 2) s += String.fromCharCode(buf.readUInt16BE(j));
        return s.replace(/\u0000+$/g, "").trim() || null;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Header-level facts about the file. Throws when sharp cannot read it at all. */
export async function readMeta(bytes: Buffer): Promise<SourceMeta> {
  const m = await sharp(bytes, { failOn: "none", limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
  const orientation = m.orientation ?? 1;
  const rw = m.width ?? 0;
  const rh = m.height ?? 0;
  const swap = orientation >= 5 && orientation <= 8;
  return {
    format: m.format ?? null,
    width: swap ? rh : rw,
    height: swap ? rw : rh,
    orientation,
    space: m.space ?? null,
    depth: m.depth ?? null,
    channels: m.channels ?? null,
    hasAlpha: !!m.hasAlpha,
    hasProfile: !!m.hasProfile,
    iccName: iccDescription(m.icc),
    bytes: bytes.length,
  };
}

/** FILE_OPENS (registry cvHint): decode with failOn "error". */
export async function strictDecode(bytes: Buffer): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // A real decode (not just the header), into a tiny output so the check
    // costs little memory; shrink-on-load still reads every scanline.
    await sharp(bytes, { failOn: "error", limitInputPixels: LIMIT_INPUT_PIXELS }).resize(64, 64, { fit: "inside" }).raw().toBuffer();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

/** A JPEG that does not end in the end-of-image marker was cut short. */
export function jpegMissingEoi(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false; // not a JPEG
  let end = bytes.length;
  while (end > 2 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20)) end--;
  return !(bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9);
}

function base(bytes: Buffer, meta: SourceMeta, failOn: "error" | "none" = "none") {
  let s = sharp(bytes, { failOn, limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();
  if (meta.hasAlpha) s = s.flatten({ background: "#ffffff" });
  return s;
}

/** The photo as packed RGB at most `edge` px on the long side (oriented, sRGB). */
export type Raster = { data: Buffer; width: number; height: number; fullW: number; fullH: number };

export async function decodeRaster(bytes: Buffer, meta: SourceMeta, edge = CV_EDGE): Promise<Raster> {
  const { w, h } = fitInside(meta.width, meta.height, edge);
  const { data, info } = await base(bytes, meta)
    .resize(w, h, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`raster has ${info.channels} channels`);
  return { data, width: info.width, height: info.height, fullW: meta.width, fullH: meta.height };
}

export type Rendered = { data: Buffer; w: number; h: number };

/** A derivative from the CV raster (same size as renderFromSource would make). */
export async function renderFromRaster(r: Raster, size: DerivSize): Promise<Rendered> {
  const { w, h } = fitInside(r.fullW, r.fullH, edgeOf(size));
  if (w > r.width || h > r.height) throw new Error(`${size} (${w}x${h}) is larger than the raster (${r.width}x${r.height})`);
  const { data, info } = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
    .resize(w, h, { fit: "fill" })
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** A derivative straight from the source file (the image route; rebuilds). */
export async function renderFromSource(bytes: Buffer, meta: SourceMeta, size: DerivSize): Promise<Rendered> {
  const { w, h } = fitInside(meta.width, meta.height, edgeOf(size));
  const { data, info } = await base(bytes, meta)
    .resize(w, h, { fit: "fill" })
    .toColourspace("srgb")
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** Where a size x size crop centred on (cx, cy) starts, clamped to the image. */
export function cropOrigin(cx: number, cy: number, fullW: number, fullH: number, size = 512): { x0: number; y0: number; w: number; h: number } {
  const w = Math.min(size, fullW);
  const h = Math.min(size, fullH);
  const x0 = Math.max(0, Math.min(fullW - w, Math.round(cx - w / 2)));
  const y0 = Math.max(0, Math.min(fullH - h, Math.round(cy - h / 2)));
  return { x0, y0, w, h };
}

export type Crop = { data: Buffer; x0: number; y0: number; w: number; h: number };

/**
 * crop512 (0.2): full-resolution crops around points, for P1b. ONE full decode
 * for all of a photo's crops, sliced in memory; the decoded frame is released
 * when this returns. Never resized: P1b boxes map back as X = x0 + x (0.4).
 */
export async function cutCrops(bytes: Buffer, meta: SourceMeta, centers: { x: number; y: number }[], size = 512): Promise<Crop[]> {
  if (!centers.length) return [];
  const { data, info } = await base(bytes, meta).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const out: Crop[] = [];
  for (const c of centers) {
    const o = cropOrigin(c.x, c.y, W, H, size);
    const buf = Buffer.allocUnsafe(o.w * o.h * 3);
    for (let y = 0; y < o.h; y++) {
      const src = ((o.y0 + y) * W + o.x0) * 3;
      data.copy(buf, y * o.w * 3, src, src + o.w * 3);
    }
    const jpg = await sharp(buf, { raw: { width: o.w, height: o.h, channels: 3 } }).jpeg({ quality: CROP_QUALITY, chromaSubsampling: "4:4:4" }).toBuffer();
    out.push({ data: jpg, ...o });
  }
  return out;
}

/** region768 (0.2): a box plus margin from the full-resolution image, scaled
 *  to fit 768. Boxes map back as X = x0 + x * cropW / sentW (0.4). */
export async function cutRegion(bytes: Buffer, meta: SourceMeta, box: [number, number, number, number], maxEdge = 768, marginPct = 0.15) {
  const [x1, y1, x2, y2] = box;
  const mw = Math.round((x2 - x1) * marginPct) + 16;
  const mh = Math.round((y2 - y1) * marginPct) + 16;
  const x0 = Math.max(0, x1 - mw);
  const y0 = Math.max(0, y1 - mh);
  const cropW = Math.min(meta.width, x2 + mw) - x0;
  const cropH = Math.min(meta.height, y2 + mh) - y0;
  const { w, h } = fitInside(cropW, cropH, maxEdge);
  const { data, info } = await base(bytes, meta)
    .extract({ left: x0, top: y0, width: cropW, height: cropH })
    .resize(w, h, { fit: "fill" })
    .toColourspace("srgb")
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, x0, y0, cropW, cropH, sentW: info.width, sentH: info.height };
}

// ---- the in-process cache --------------------------------------------------------------

/** A byte-budgeted LRU for derivative JPEGs (never full-resolution images). */
export class ByteLru {
  private map = new Map<string, Buffer>();
  private total = 0;
  constructor(private maxBytes: number) {}
  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes / 4) return; // never let one item flush the cache
    const prev = this.map.get(key);
    if (prev) {
      this.total -= prev.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.total += value.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
  deletePrefix(prefix: string): void {
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.total -= v.length;
      }
    }
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.map.size;
  }
}

const MB = 1024 * 1024;
export const derivCache = new ByteLru(Math.max(16, Number(process.env.QC_MEM_CACHE_MB) || 96) * MB);

export function derivKey(photoId: string, contentHash: string, what: string): string {
  return `${photoId}:${contentHash}:${what}`;
}

/** What PhotoAsset.derivJson holds per size: the sent size always, the private
 *  blob location only when a private store persisted it. */
export type DerivRef = { w: number; h: number; pathname?: string; url?: string; bytes?: number };
export type DerivMap = Partial<Record<DerivSize, DerivRef>>;

export function parseDerivMap(json: string | null | undefined): DerivMap {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as unknown;
    return o && typeof o === "object" ? (o as DerivMap) : {};
  } catch {
    return {};
  }
}
