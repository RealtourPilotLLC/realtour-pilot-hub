import sharp from "sharp";
import type { Severity } from "../registry";
import type { Raster, SourceMeta } from "./derivatives";

// ---------------------------------------------------------------------------
// DETERMINISTIC CV CHECKS (plan §7.3, the registry's cvHints).
//
// Everything is measured on ONE decode of the photo: the 3000 px sRGB raster
// (derivatives.decodeRaster). Blur, exposure, color and the duplicate hash run
// on a 1024 px wide copy of it; dust candidates run on the raster itself.
// All thresholds are the registry's STARTING values, to be calibrated on the
// golden set (§7.7); they live here as named constants.
//
// What CV decides on its own is deliberately small: only what is unambiguous
// becomes a finding (a file that will not open, a wrong format, a preview in
// place of a final, a frame too soft to use anywhere, exact duplicates,
// mismatched resolutions). Everything else (mild blur, exposure, color casts,
// dust candidates) is EVIDENCE: it goes to Claude in <cv_metrics>, and dust
// candidates go to P1b as full-resolution crops for confirmation.
//
// Pure apart from sharp (no I/O, no database), so the drills run it on
// synthetic images.
// ---------------------------------------------------------------------------

export const CV_THRESHOLDS = {
  /** COMP_BLURRY: Laplacian variance on a 1024 px wide luma image. */
  blurSoft: 60,
  blurSevere: 25,
  /** "when the best cell is also low, the whole frame is soft" */
  blurSevereBestCell: 60,
  /** Relative to the gallery median (plan §7.3: below 35%). */
  blurRelative: 0.35,
  /** Dust (plan §7.3): contrast below -6 luma levels on flat regions. */
  dustContrast: 6,
  dustMinArea: 6,
  dustMaxArea: 400,
  /** Local std of the clipped high-pass below this = a flat surface. */
  dustFlatStd: 3.5,
  dustMinSurface: 60,
  dustTop: 15,
  dustBlurSigma: 8,
  /** Duplicates: dHash Hamming distance. */
  nearDuplicate: 6,
  exactDuplicate: 2,
  /** Recurrence (plan §7.3): 3+ photos within 1.5% (edited, perspective-corrected images). */
  recurrenceTolerance: 0.015,
  recurrenceMinPhotos: 3,
  /** FILE_DIMENSIONS starting value (registry): long edge of at least 3000 px. */
  fullResSpecPx: 3000,
  /** FILE_PREVIEW_NOT_FINAL: under 300 KB at full dimensions. */
  previewMaxBytes: 300 * 1024,
  /** GAL_RESOLUTION_CONSISTENCY: long edge more than 2% from the gallery mode. */
  resolutionTolerance: 0.02,
} as const;

export function fullResSpecPx(): number {
  const n = Number(process.env.QC_FULL_RES_LONG_EDGE);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : CV_THRESHOLDS.fullResSpecPx;
}

export type DustCandidate = {
  /** Full-resolution centre and radius (oriented image). */
  x: number;
  y: number;
  r: number;
  bbox: [number, number, number, number];
  /** Normalized by the image's width and height. */
  nx: number;
  ny: number;
  score: number;
  /** Luma levels darker than the local background (0 to 255 scale). */
  depth: number;
  /** Pixels at the CV raster's scale. */
  area: number;
  surfaceLuma: number;
  surfaceStd: number;
  surfaceL: number;
  deltaL: number;
};

export type CvMetrics = {
  v: 1;
  fullW: number;
  fullH: number;
  format: string | null;
  bytes: number;
  space: string | null;
  iccName: string | null;
  depth: string | null;
  blurScore: number;
  blurGrid: number[];
  blurBestCell: number;
  meanLuma: number;
  medianLuma: number;
  stdLuma: number;
  p01: number;
  p99: number;
  clipHighPct: number;
  clipLowPct: number;
  darkPct: number;
  labMean: [number, number, number];
  neutralLab: [number, number, number] | null;
  neutralPct: number;
  grayWorldCast: [number, number];
  satMean: number;
  satHighPct: number;
  bottomUniformPct: number;
  dHash: string;
  dustCandidates: DustCandidate[];
  dustSkipped: string | null;
  flags: string[];
  ms: Record<string, number>;
};

// ---- small numeric helpers -------------------------------------------------------------

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** sRGB 8-bit value → linear light, as a lookup table. */
const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIE L* of a neutral gray at this sRGB luma level. */
export function lumaToLstar(v: number): number {
  const y = LIN[Math.max(0, Math.min(255, Math.round(v)))];
  return 116 * labF(y) - 16;
}

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Luma (Rec. 709 weights on the encoded values) of packed RGB. */
export function lumaOf(rgb: Buffer | Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = (0.2126 * rgb[j] + 0.7152 * rgb[j + 1] + 0.0722 * rgb[j + 2] + 0.5) | 0;
  return out;
}

/** Variance of the 4-neighbour Laplacian over a window of a luma image. */
export function laplacianVariance(l: Uint8Array, w: number, h: number, x0 = 0, y0 = 0, x1 = w, y1 = h): number {
  const xa = Math.max(1, x0), xb = Math.min(w - 1, x1), ya = Math.max(1, y0), yb = Math.min(h - 1, y1);
  let n = 0, sum = 0, sq = 0;
  for (let y = ya; y < yb; y++) {
    const row = y * w;
    for (let x = xa; x < xb; x++) {
      const i = row + x;
      const v = l[i - 1] + l[i + 1] + l[i - w] + l[i + w] - 4 * l[i];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sq / n - mean * mean;
}

/** Separable box mean of radius r (Float64 prefix sums per line). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pre = new Float64Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[y * w + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
      tmp[y * w + x] = (pre[b] - pre[a]) / (b - a);
    }
  }
  for (let x = 0; x < w; x++) {
    pre[0] = 0;
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
      out[y * w + x] = (pre[b] - pre[a]) / (b - a);
    }
  }
  return out;
}

// ---- dHash ---------------------------------------------------------------------------------

/** 64-bit difference hash (9x8 gray, left > right per row) as 16 hex digits. */
export async function dHash64(rgb: Buffer, w: number, h: number): Promise<string> {
  const { data: g, info } = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || g.length !== 72) throw new Error(`dHash plane has ${info.channels} channels`);
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const POP4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Hamming distance of two hex hashes (64 when either is missing). */
export function hammingHex(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP4[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// ---- dust candidates (plan §7.3) ----------------------------------------------------------

/**
 * Dark, soft, roughly round blobs on flat regions. High-pass = luma minus a
 * Gaussian blur (sigma 8); flat = local std (31 px window, measured at quarter
 * scale) below a threshold; blobs 6 to 400 px at the 3000 px raster, at least
 * 6 luma levels darker than their surroundings, roughly round and filled. The
 * top 15 by score, in full-resolution coordinates.
 */
export async function detectDust(r: Raster, luma?: Uint8Array): Promise<{ candidates: DustCandidate[]; skipped: string | null }> {
  const T = CV_THRESHOLDS;
  const W = r.width, H = r.height, N = W * H;
  const L = luma ?? lumaOf(r.data, N);
  // sharp turns a 1-channel raw input back into sRGB on output unless told
  // otherwise; extractChannel keeps the blurred plane aligned with L.
  const blurred = await sharp(Buffer.from(L.buffer, L.byteOffset, L.byteLength), { raw: { width: W, height: H, channels: 1 } })
    .blur(T.dustBlurSigma)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (blurred.info.channels !== 1 || blurred.data.length !== N) throw new Error(`dust blur plane has ${blurred.info.channels} channels`);
  const B = blurred.data;

  // Flatness: the local standard deviation of the high-pass, CLIPPED to the
  // contrast threshold, in a window of 9x9 blocks of 4x4 px (about 36 px, the
  // plan's 31 px window). Texture (wood grain, carpet, stucco, noise) keeps
  // the clipped high-pass busy and fails; a smooth wall or sky stays near
  // zero; a dust spot fills only a few percent of its window with values at
  // the clip, so it barely moves the measure and does not exclude itself.
  // Measured from per-block first and second moments, so the window std is
  // the exact pixel-level std at a sixteenth of the memory.
  const sw = Math.max(1, Math.floor(W / 4)), sh = Math.max(1, Math.floor(H / 4));
  const S1 = new Float32Array(sw * sh);
  const S2 = new Float32Array(sw * sh);
  const clip = T.dustContrast;
  for (let by = 0; by < sh; by++) {
    for (let bx = 0; bx < sw; bx++) {
      let s = 0, s2 = 0;
      for (let dy = 0; dy < 4; dy++) {
        const row = (by * 4 + dy) * W + bx * 4;
        for (let dx = 0; dx < 4; dx++) {
          let c = L[row + dx] - B[row + dx];
          if (c > clip) c = clip;
          else if (c < -clip) c = -clip;
          s += c;
          s2 += c * c;
        }
      }
      S1[by * sw + bx] = s / 16;
      S2[by * sw + bx] = s2 / 16;
    }
  }
  const m1 = boxMean(S1, sw, sh, 4);
  const m2 = boxMean(S2, sw, sh, 4);
  const std = new Float32Array(sw * sh);
  for (let i = 0; i < std.length; i++) std[i] = Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i]));

  const margin = 6;
  const mark = new Uint8Array(N);
  let marked = 0;
  for (let y = margin; y < H - margin; y++) {
    const sy = Math.min(sh - 1, y >> 2) * sw;
    for (let x = margin; x < W - margin; x++) {
      const i = y * W + x;
      if (L[i] - B[i] > -T.dustContrast) continue;
      if (B[i] < T.dustMinSurface) continue;
      if (std[sy + Math.min(sw - 1, x >> 2)] >= T.dustFlatStd) continue;
      mark[i] = 1;
      marked++;
    }
  }
  // A frame where a tenth of the flat area reads as "dark speck" is texture or
  // noise, not dust; ranking it would only feed P1b junk.
  if (marked > N * 0.1) return { candidates: [], skipped: "too many dark specks on flat areas to rank (textured or noisy image)" };

  const sx = r.fullW / W, sy = r.fullH / H;
  const found: DustCandidate[] = [];
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (mark[start] !== 1) continue;
    // One 8-connected blob, flood-filled from its first pixel. The margin
    // keeps every neighbour index inside the frame.
    mark[start] = 2;
    stack.length = 0;
    stack.push(start);
    let area = 0, minX = W, minY = H, maxX = 0, maxY = 0, sumW = 0, cx = 0, cy = 0, minHp = 0;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % W, y = (i - x) / W;
      const hp = L[i] - B[i];
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const wgt = -hp;
      sumW += wgt;
      cx += x * wgt;
      cy += y * wgt;
      if (hp < minHp) minHp = hp;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = i + dy * W + dx;
          if (mark[j] === 1) {
            mark[j] = 2;
            stack.push(j);
          }
        }
      }
    }
    if (area < T.dustMinArea || area > T.dustMaxArea) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    const fill = area / (bw * bh);
    if (aspect < 0.4 || fill < 0.4) continue;
    const depth = -minHp;
    // Isolation: dust sits on a surface that is flat all around it. The ring
    // two pixels outside the blob's box must be close to the background; the
    // dark side of a soft edge or shadow fails this even when it is round.
    let ringSum = 0, ringN = 0;
    const rx0 = Math.max(0, minX - 2), rx1 = Math.min(W - 1, maxX + 2), ry0 = Math.max(0, minY - 2), ry1 = Math.min(H - 1, maxY + 2);
    for (let x = rx0; x <= rx1; x++) {
      ringSum += L[ry0 * W + x] - B[ry0 * W + x] + (L[ry1 * W + x] - B[ry1 * W + x]);
      ringN += 2;
    }
    for (let y = ry0 + 1; y < ry1; y++) {
      ringSum += L[y * W + rx0] - B[y * W + rx0] + (L[y * W + rx1] - B[y * W + rx1]);
      ringN += 2;
    }
    if (ringN && ringSum / ringN < -Math.max(3, depth * 0.35)) continue;
    const ccx = cx / sumW, ccy = cy / sumW;
    const ci = Math.round(ccy) * W + Math.round(ccx);
    const surfaceLuma = B[ci];
    const surfaceStd = std[Math.min(sh - 1, Math.round(ccy) >> 2) * sw + Math.min(sw - 1, Math.round(ccx) >> 2)];
    const surfaceL = lumaToLstar(surfaceLuma);
    const score = depth * aspect * Math.min(1, fill / 0.6) * (area >= 12 ? 1 : 0.8);
    const fx = ccx * sx, fy = ccy * sy;
    found.push({
      x: Math.round(fx),
      y: Math.round(fy),
      r: Math.max(2, Math.round(Math.sqrt(area / Math.PI) * Math.max(sx, sy))),
      bbox: [Math.round(minX * sx), Math.round(minY * sy), Math.round((maxX + 1) * sx), Math.round((maxY + 1) * sy)],
      nx: round(fx / r.fullW, 4),
      ny: round(fy / r.fullH, 4),
      score: round(score, 2),
      depth: round(depth, 1),
      area,
      surfaceLuma: round(surfaceLuma, 1),
      surfaceStd: round(surfaceStd, 2),
      surfaceL: round(surfaceL, 1),
      deltaL: round(lumaToLstar(surfaceLuma - depth) - surfaceL, 1),
    });
  }
  found.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return { candidates: found.slice(0, T.dustTop), skipped: null };
}

// ---- one photo ----------------------------------------------------------------------------

/**
 * Every per-photo measurement, from the 3000 px raster. Well under a second on
 * a 6000x4000 source (the decode dominates and happens before this).
 */
export async function analyzeRaster(r: Raster, meta: SourceMeta): Promise<CvMetrics> {
  const ms: Record<string, number> = {};
  let t = Date.now();
  const lap = () => {
    const n = Date.now();
    const d = n - t;
    t = n;
    return d;
  };

  // The 1024 px wide working copy (plan: blur on a 1024 px wide luma image).
  let w1 = r.width, h1 = r.height, rgb1: Buffer = r.data;
  if (r.width > 1024) {
    w1 = 1024;
    h1 = Math.max(1, Math.round((r.height * 1024) / r.width));
    rgb1 = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).resize(w1, h1, { fit: "fill" }).raw().toBuffer();
  }
  const n1 = w1 * h1;
  const l1 = lumaOf(rgb1, n1);
  ms.resize = lap();

  // Blur: global and on a 3x3 grid.
  const blurScore = laplacianVariance(l1, w1, h1);
  const grid: number[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      grid.push(round(laplacianVariance(l1, w1, h1, Math.floor((gx * w1) / 3), Math.floor((gy * h1) / 3), Math.floor(((gx + 1) * w1) / 3), Math.floor(((gy + 1) * h1) / 3)), 1));
    }
  }
  ms.blur = lap();

  // Exposure: the luma histogram.
  const hist = new Float64Array(256);
  let sum = 0, sq = 0;
  for (let i = 0; i < n1; i++) {
    const v = l1[i];
    hist[v]++;
    sum += v;
    sq += v * v;
  }
  const mean = sum / n1;
  const pct = (p: number) => {
    let acc = 0;
    const target = p * n1;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  let high = 0, low = 0, dark = 0;
  for (let v = 250; v < 256; v++) high += hist[v];
  for (let v = 0; v <= 5; v++) low += hist[v];
  for (let v = 0; v < 20; v++) dark += hist[v];
  ms.exposure = lap();

  // Color: Lab means (all pixels, and likely-neutral pixels: L* 60 to 95,
  // chroma below 25) and HSV saturation, on every second pixel each way.
  let labN = 0, Ls = 0, As = 0, Bs = 0, neuN = 0, nL = 0, nA = 0, nB = 0, satN = 0, satS = 0, satHigh = 0;
  for (let y = 0; y < h1; y += 2) {
    for (let x = 0; x < w1; x += 2) {
      const j = (y * w1 + x) * 3;
      const R = rgb1[j], G = rgb1[j + 1], Bv = rgb1[j + 2];
      const [L, a, b] = srgbToLab(R, G, Bv);
      labN++;
      Ls += L;
      As += a;
      Bs += b;
      if (L >= 60 && L <= 95 && Math.sqrt(a * a + b * b) < 25) {
        neuN++;
        nL += L;
        nA += a;
        nB += b;
      }
      const mx = Math.max(R, G, Bv), mn = Math.min(R, G, Bv);
      if (mx > 51) {
        const s = (mx - mn) / mx;
        satN++;
        satS += s;
        if (s > 0.9) satHigh++;
      }
    }
  }
  const neutralPct = labN ? (neuN / labN) * 100 : 0;
  const neutralLab: [number, number, number] | null = neuN >= Math.max(50, labN * 0.01) ? [round(nL / neuN), round(nA / neuN), round(nB / neuN)] : null;
  const labMean: [number, number, number] = [round(Ls / labN), round(As / labN), round(Bs / labN)];
  ms.color = lap();

  // FILE_CORRUPT evidence: uniform rows filling the bottom of the frame.
  let uniformRows = 0;
  for (let y = r.height - 1; y > 0; y--) {
    const row = y * r.width * 3;
    const prev = (y - 1) * r.width * 3;
    let same = true;
    for (let x = 0; x < r.width * 3; x += 3) {
      if (r.data[row + x] !== r.data[row] || r.data[row + x + 1] !== r.data[row + 1] || r.data[row + x + 2] !== r.data[row + 2] || r.data[prev + x] !== r.data[row + x]) {
        same = false;
        break;
      }
    }
    if (!same) break;
    uniformRows++;
  }
  const dHash = await dHash64(rgb1, w1, h1);
  ms.hash = lap();

  const dust = await detectDust(r);
  ms.dust = lap();

  const m: CvMetrics = {
    v: 1,
    fullW: meta.width,
    fullH: meta.height,
    format: meta.format,
    bytes: meta.bytes,
    space: meta.space,
    iccName: meta.iccName,
    depth: meta.depth,
    blurScore: round(blurScore, 1),
    blurGrid: grid,
    blurBestCell: Math.max(...grid),
    meanLuma: round(mean, 1),
    medianLuma: pct(0.5),
    stdLuma: round(Math.sqrt(Math.max(0, sq / n1 - mean * mean)), 1),
    p01: pct(0.01),
    p99: pct(0.99),
    clipHighPct: round((high / n1) * 100, 2),
    clipLowPct: round((low / n1) * 100, 2),
    darkPct: round((dark / n1) * 100, 2),
    labMean,
    neutralLab,
    neutralPct: round(neutralPct, 1),
    grayWorldCast: neutralLab ? [neutralLab[1], neutralLab[2]] : [labMean[1], labMean[2]],
    satMean: round(satN ? satS / satN : 0, 3),
    satHighPct: round(satN ? (satHigh / satN) * 100 : 0, 2),
    bottomUniformPct: round((uniformRows / r.height) * 100, 2),
    dHash,
    dustCandidates: dust.candidates,
    dustSkipped: dust.skipped,
    flags: [],
    ms,
  };
  m.flags = cvFlags(m, null);
  return m;
}

/**
 * The <cv_metrics> "Flags:" line: each registry cvHint whose starting
 * threshold the photo crosses, as plain words. Evidence for Claude, not a
 * verdict. `galleryBlurMedian` adds the gallery-relative blur flag.
 */
export function cvFlags(m: CvMetrics, galleryBlurMedian: number | null, roomType?: string | null): string[] {
  const T = CV_THRESHOLDS;
  const f: string[] = [];
  if (m.blurScore < T.blurSevere) f.push(`very low sharpness score ${m.blurScore} (severe below ${T.blurSevere})`);
  else if (m.blurScore < T.blurSoft) f.push(`low sharpness score ${m.blurScore} (soft below ${T.blurSoft})`);
  if (galleryBlurMedian && galleryBlurMedian > 0 && m.blurScore < T.blurRelative * galleryBlurMedian) {
    f.push(`sharpness ${Math.round((m.blurScore / galleryBlurMedian) * 100)}% of the gallery median`);
  }
  const twilight = roomType === "TWILIGHT_EXTERIOR";
  if (!twilight && (m.medianLuma < 70 || m.darkPct > 30)) f.push(`dark frame (median luma ${m.medianLuma}, ${m.darkPct}% of pixels below 20)`);
  if (m.clipHighPct > 15 || m.medianLuma > 200) f.push(`very bright frame (median luma ${m.medianLuma}, ${m.clipHighPct}% at 250 or above)`);
  else if (m.clipHighPct > 4) f.push(`highlight clipping ${m.clipHighPct}% (windows or bulbs may explain it)`);
  if (m.stdLuma > 75 && m.clipLowPct > 5 && m.clipHighPct > 5) f.push(`high contrast (luma std ${m.stdLuma})`);
  if (m.stdLuma < 35 && m.p99 < 215) f.push(`flat tonality (luma std ${m.stdLuma}, 99th percentile ${m.p99})`);
  const n = m.neutralLab;
  if (n) {
    const [, a, b] = n;
    if (b > 14 && a > 6) f.push(`orange cast on neutral surfaces (a* ${a}, b* ${b})`);
    else if (b > 14 && a >= -4 && a <= 6) f.push(`yellow cast on neutral surfaces (b* ${b})`);
    if (b < -6) f.push(`blue cast on neutral surfaces (b* ${b})`);
    if (a < -5) f.push(`green cast on neutral surfaces (a* ${a})`);
    if (a > 8) f.push(`magenta cast on neutral surfaces (a* ${a})`);
  }
  if (m.satMean > 0.45 || m.satHighPct > 8) f.push(`high saturation (mean ${m.satMean}, ${m.satHighPct}% above 0.9)`);
  if (m.dustCandidates.length) f.push(`${m.dustCandidates.length} possible dust spot${m.dustCandidates.length === 1 ? "" : "s"} (checked separately on full-resolution crops)`);
  return f;
}

// ---- unambiguous file findings ------------------------------------------------------------

export type CvIssue = {
  ruleId: "FILE_OPENS" | "FILE_CORRUPT" | "FILE_FORMAT" | "FILE_PREVIEW_NOT_FINAL" | "FILE_DIMENSIONS" | "COMP_BLURRY";
  severity: Severity;
  confidence: number;
  specificIssue: string;
  explanation: string;
  recommendedAction: string;
};

const NON_SRGB_ICC = /adobe\s*rgb|prophoto|romm|wide\s*gamut|display\s*p3|dci[\s-]*p3|rec\.?\s*2020|bt\.?\s*2020/i;
const PREVIEW_NAME = /(^|[^a-z])(preview|thumb|thumbnail|proof|web)([^a-z]|$)/i;

/** FILE_* checks from the header, the strict decode and the measurements. */
export function fileIssues(input: {
  meta: SourceMeta | null;
  strictError: string | null;
  missingEoi: boolean;
  name: string;
  path: string | null;
  minLongEdgePx: number;
  metrics: CvMetrics | null;
}): CvIssue[] {
  const out: CvIssue[] = [];
  const { meta, metrics } = input;
  const opens = (why: string) =>
    out.push({ ruleId: "FILE_OPENS", severity: "CRITICAL", confidence: 0.95, specificIssue: "File does not open cleanly", explanation: why, recommendedAction: "Re-export or re-download the photo, then run QC again." });
  if (!meta || !meta.width || !meta.height) {
    opens(input.strictError ? `The file could not be decoded: ${input.strictError}` : "The file has no readable image dimensions.");
    return out;
  }
  if (input.strictError) opens(`The image decodes only with errors: ${input.strictError}`);
  else if (input.missingEoi) opens("The JPEG has no end-of-image marker, so the file was cut short.");
  if (meta.format && meta.format !== "jpeg") {
    out.push({ ruleId: "FILE_FORMAT", severity: "MAJOR", confidence: 0.95, specificIssue: `Delivered as ${meta.format.toUpperCase()}, not JPEG`, explanation: `The delivery spec is JPEG, sRGB, 8-bit; this file is ${meta.format}.`, recommendedAction: "Export the photo as an sRGB JPEG." });
  }
  if (meta.space === "cmyk") {
    out.push({ ruleId: "FILE_FORMAT", severity: "MAJOR", confidence: 0.95, specificIssue: "CMYK color space", explanation: "The file is CMYK; listing sites expect sRGB.", recommendedAction: "Export the photo in sRGB." });
  } else if (meta.iccName && NON_SRGB_ICC.test(meta.iccName)) {
    out.push({ ruleId: "FILE_FORMAT", severity: "MAJOR", confidence: 0.9, specificIssue: "Embedded non-sRGB color profile", explanation: `The embedded profile is "${meta.iccName.slice(0, 60)}"; many listing sites show it with shifted colors.`, recommendedAction: "Convert the photo to sRGB on export." });
  }
  if (meta.depth && meta.depth !== "uchar") {
    out.push({ ruleId: "FILE_FORMAT", severity: "MAJOR", confidence: 0.9, specificIssue: "Not an 8-bit file", explanation: `The file stores ${meta.depth} samples; the spec is 8-bit.`, recommendedAction: "Export the photo as an 8-bit sRGB JPEG." });
  }
  const long = Math.max(meta.width, meta.height);
  const named = PREVIEW_NAME.test(input.name) || PREVIEW_NAME.test((input.path ?? "").split("/").slice(-2).join("/"));
  if (long < input.minLongEdgePx) {
    out.push({ ruleId: "FILE_PREVIEW_NOT_FINAL", severity: "CRITICAL", confidence: 0.9, specificIssue: `Only ${long} px on the long edge`, explanation: `Full-resolution finals are at least ${input.minLongEdgePx} px on the long edge; this looks like a preview.`, recommendedAction: "Replace it with the full-resolution final." });
  } else if (named) {
    out.push({ ruleId: "FILE_PREVIEW_NOT_FINAL", severity: "CRITICAL", confidence: 0.75, specificIssue: "File name suggests a preview", explanation: `The name "${input.name.slice(0, 80)}" contains a preview, proof, thumb or web marker.`, recommendedAction: "Check that the full-resolution final is the file being delivered." });
  } else if (meta.bytes < CV_THRESHOLDS.previewMaxBytes && long >= input.minLongEdgePx) {
    out.push({ ruleId: "FILE_PREVIEW_NOT_FINAL", severity: "CRITICAL", confidence: 0.7, specificIssue: `Only ${Math.round(meta.bytes / 1024)} KB at full size`, explanation: "A full-resolution final is rarely under 300 KB; this may be a heavily compressed preview.", recommendedAction: "Check that the full-resolution final is the file being delivered." });
  } else if (long < fullResSpecPx()) {
    out.push({ ruleId: "FILE_DIMENSIONS", severity: "MAJOR", confidence: 0.85, specificIssue: `${long} px long edge, below the ${fullResSpecPx()} px spec`, explanation: `The delivery spec for full resolution is a long edge of at least ${fullResSpecPx()} px.`, recommendedAction: "Confirm the export size, or re-export at full resolution." });
  }
  if (metrics) {
    if (metrics.stdLuma < 0.5) {
      out.push({ ruleId: "FILE_CORRUPT", severity: "CRITICAL", confidence: 0.9, specificIssue: "Image is a single flat color", explanation: "Every pixel has the same tone, so the file holds no photo.", recommendedAction: "Re-export or re-download the photo." });
    } else if (metrics.bottomUniformPct > 5) {
      out.push({ ruleId: "FILE_CORRUPT", severity: "CRITICAL", confidence: 0.85, specificIssue: "Bottom of the frame is a flat block", explanation: `${metrics.bottomUniformPct}% of the rows at the bottom are one identical color, the mark of a truncated file.`, recommendedAction: "Re-export or re-download the photo." });
    }
  }
  return out;
}

/** COMP_BLURRY at the severe level, from CV alone: the whole frame is soft
 *  (global score severe AND even the sharpest ninth is soft). */
export function severeBlurIssue(m: CvMetrics): CvIssue | null {
  const T = CV_THRESHOLDS;
  if (m.blurScore >= T.blurSevere || m.blurBestCell >= T.blurSevereBestCell) return null;
  return {
    ruleId: "COMP_BLURRY",
    severity: "CRITICAL",
    confidence: 0.8,
    specificIssue: "Whole frame is soft",
    explanation: `Sharpness score ${m.blurScore} (severe below ${T.blurSevere}), and even the sharpest part of the frame scores ${m.blurBestCell}.`,
    recommendedAction: "Check the photo at full screen; replace it with a sharp frame or reshoot.",
  };
}

// ---- gallery level ----------------------------------------------------------------------------

export type GalleryPhoto = { id: string; dHash: string | null; contentHash: string | null; w: number; h: number };

/** Pairs within the near-duplicate distance; `exact` = distance 2 or less (or
 *  the same file hash), the registry's escalation for GAL_NO_DUPLICATES. */
export function duplicatePairs(photos: GalleryPhoto[], maxDistance: number = CV_THRESHOLDS.nearDuplicate): { a: string; b: string; distance: number; exact: boolean }[] {
  const out: { a: string; b: string; distance: number; exact: boolean }[] = [];
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const p = photos[i], q = photos[j];
      const sameFile = !!p.contentHash && p.contentHash === q.contentHash;
      const d = sameFile ? 0 : hammingHex(p.dHash, q.dHash);
      if (d <= maxDistance) out.push({ a: p.id, b: q.id, distance: d, exact: sameFile || d <= CV_THRESHOLDS.exactDuplicate });
    }
  }
  return out;
}

/** Photos whose long edge is more than 2% from the gallery's most common long
 *  edge. Only meaningful with 3+ photos and a mode shared by 2+. */
export function resolutionOutliers(photos: GalleryPhoto[]): { id: string; long: number; mode: number }[] {
  if (photos.length < 3) return [];
  const counts = new Map<number, number>();
  for (const p of photos) {
    const long = Math.max(p.w, p.h);
    counts.set(long, (counts.get(long) ?? 0) + 1);
  }
  let mode = 0, best = 0;
  for (const [long, n] of counts) if (n > best || (n === best && long > mode)) [mode, best] = [long, n];
  if (best < 2) return [];
  return photos
    .map((p) => ({ id: p.id, long: Math.max(p.w, p.h), mode }))
    .filter((x) => Math.abs(x.long - mode) / mode > CV_THRESHOLDS.resolutionTolerance);
}

export type RecurrenceGroup = {
  id: string;
  /** Centre, in long-edge units. */
  px: number;
  py: number;
  landscape: boolean;
  aspect: number;
  members: { photoId: string; index: number }[];
  photoCount: number;
};

/**
 * Repeated dust (plan §7.3, REFL_REPEATED_DUST_LOCATION's cvHint): cluster the
 * candidates of every photo by position, comparing only photos with the same
 * orientation and aspect ratio (within 3%); a cluster holding candidates from
 * 3+ photos is a recurrence group. Tolerance 1.5% of the long edge, because
 * AutoHDR's perspective correction moves a sensor speck a little in each
 * edited frame. A photo contributes at most one candidate per group.
 */
export function clusterDust(
  photos: { id: string; fullW: number; fullH: number; candidates: DustCandidate[] }[],
  tolerance: number = CV_THRESHOLDS.recurrenceTolerance,
  minPhotos: number = CV_THRESHOLDS.recurrenceMinPhotos,
): RecurrenceGroup[] {
  type Cl = { px: number; py: number; landscape: boolean; aspect: number; members: { photoId: string; index: number; score: number }[] };
  const clusters: Cl[] = [];
  const all: { photoId: string; index: number; px: number; py: number; landscape: boolean; aspect: number; score: number }[] = [];
  for (const p of photos) {
    const long = Math.max(p.fullW, p.fullH);
    if (!long) continue;
    p.candidates.forEach((c, index) => all.push({ photoId: p.id, index, px: c.x / long, py: c.y / long, landscape: p.fullW >= p.fullH, aspect: p.fullW / p.fullH, score: c.score }));
  }
  all.sort((a, b) => b.score - a.score || (a.photoId < b.photoId ? -1 : 1) || a.index - b.index);
  for (const c of all) {
    const hit = clusters.find(
      (k) => k.landscape === c.landscape && Math.abs(k.aspect - c.aspect) / k.aspect <= 0.03 && Math.hypot(k.px - c.px, k.py - c.py) <= tolerance && !k.members.some((m) => m.photoId === c.photoId),
    );
    if (hit) {
      const n = hit.members.length;
      hit.px = (hit.px * n + c.px) / (n + 1);
      hit.py = (hit.py * n + c.py) / (n + 1);
      hit.members.push({ photoId: c.photoId, index: c.index, score: c.score });
    } else {
      clusters.push({ px: c.px, py: c.py, landscape: c.landscape, aspect: c.aspect, members: [{ photoId: c.photoId, index: c.index, score: c.score }] });
    }
  }
  return clusters
    .filter((k) => new Set(k.members.map((m) => m.photoId)).size >= minPhotos)
    .sort((a, b) => b.members.length - a.members.length || a.py - b.py || a.px - b.px)
    .map((k, i) => ({
      id: `rg${i + 1}`,
      px: round(k.px, 4),
      py: round(k.py, 4),
      landscape: k.landscape,
      aspect: round(k.aspect, 3),
      members: k.members.map((m) => ({ photoId: m.photoId, index: m.index })),
      photoCount: new Set(k.members.map((m) => m.photoId)).size,
    }));
}

/** P1b's outcome for one photo version, kept beside the candidates it judged
 *  so a photo is not sent to P1b twice for the same content hash. */
export type P1bState = {
  hash: string;
  at: string;
  crops: number;
  dust: number;
  real: number;
  texture: number;
  uncertain: number;
  /** Why the photo's candidates were not sent (cap reached, no candidates). */
  skipped: string | null;
  results: { index: number; verdict: string; confidence: number; group: string | null }[];
};

/** PhotoAsset.cvJson. `unavailable` is set (and `metrics` null) when the file
 *  could not be loaded or decoded for this content hash. */
export type StoredCv = {
  v: 1;
  metrics: CvMetrics | null;
  unavailable: { kind: string; reason: string; at: string } | null;
  p1b: P1bState | null;
};

export function parseCv(json: string | null | undefined): StoredCv | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as StoredCv;
    return o && o.v === 1 && "metrics" in o ? o : null;
  } catch {
    return null;
  }
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---- line geometry (Oct 15 2026) ------------------------------------------------------------
//
// Jordan: "the biggest thing I need is making sure images are not warped".
// The registry's cvHints for crooked verticals (Sobel orientation, length-
// weighted median deviation above 1.0 degree, at least 8 edges) were never
// built; this is them, plus a bend measure for warped architecture:
//   · strong near-vertical edges (within 15 degrees) on a ~1024 px luma image,
//     thinned to one pixel and linked row by row into chains (same polarity);
//   · each long chain gets a straight fit (its angle: TILT) and a parabola
//     fit (its bow: BEND). A clean chain (small parabola residual) whose bow
//     is at least 3 px and 1.2% of its length is bent: real walls, door
//     frames and window edges are straight, so a bent one is a warp (barrel
//     distortion, AI straightening that stretched a corner, a wavy edit);
//   · the same on the transposed image measures near-horizontal lines.
// Evidence, not a verdict: a warp finding counts in full only when this and
// the free check agree (geometry.ts). Starting values, calibrate.
// Pure (no I/O): the drills feed it synthetic images.

export const GEOMETRY_THRESHOLDS = {
  /** Sobel |gx| (0 to 1020) an edge pixel needs. */
  edgeMin: 64,
  /** Within this many degrees of vertical. */
  maxAngleDeg: 15,
  /** A chain must span at least this share of the image height (and 40 px). */
  minSpan: 0.12,
  /** Straight-fit RMS above this = a texture, not a line. */
  maxRmsPx: 1.5,
  /** Crooked: at least this many lines, median deviation above this. */
  crookedMinLines: 8,
  crookedDeg: 1.0,
  /** Bent: bow at least this many px and this share of the chain's length. */
  bowMinPx: 3,
  bowMinRatio: 0.012,
  /** Warped: at least this many bent lines. */
  warpedMinLines: 2,
} as const;

export type BentLine = { nx: number; ny: number; bowPx: number; len: number; dir: "v" | "h" };
export type LineGeometry = {
  v: 1;
  width: number;
  height: number;
  /** Long, clean near-vertical lines measured. */
  verticalLines: number;
  /** Length-weighted median |deviation from vertical|, degrees (null under 3 lines). */
  tiltDeg: number | null;
  /** Length-weighted median signed deviation (positive: the top leans right). */
  leanDeg: number | null;
  /** Long, clean lines (both directions) bent past the limit. */
  bentLines: number;
  maxBowPx: number;
  maxBowRatio: number;
  bent: BentLine[];
  crooked: boolean;
  warped: boolean;
  /** Why the tilt could not be judged (too few lines), or null. */
  skipped: string | null;
};

type Chain = { sign: number; lastY: number; firstY: number; lastX: number; xs: number[]; ys: number[] };

/** Least squares x = a*u + b (u centred and scaled), and x = c*u^2 + d*u + e; residual stats. */
function fitChain(xs: number[], ys: number[]): { slope: number; rms: number; bow: number; qRms: number } {
  const n = xs.length;
  let ym = 0;
  for (const y of ys) ym += y;
  ym /= n;
  const span = Math.max(1, ys[n - 1] - ys[0]);
  // Straight fit in pixels (slope in px per row).
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const y = ys[i] - ym;
    sy += y; sx += xs[i]; syy += y * y; sxy += y * xs[i];
  }
  const den = n * syy - sy * sy;
  const slope = den ? (n * sxy - sy * sx) / den : 0;
  const icpt = (sx - slope * sy) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = xs[i] - (slope * (ys[i] - ym) + icpt);
    ss += r * r;
  }
  const rms = Math.sqrt(ss / n);
  // Parabola on u in [-1, 1]: normal equations (3x3), solved by Cramer's rule.
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const u = (2 * (ys[i] - ys[0])) / span - 1;
    const u2 = u * u;
    s0 += 1; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    t0 += xs[i]; t1 += u * xs[i]; t2 += u2 * xs[i];
  }
  const det = (a: number[]) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const M = [s4, s3, s2, s3, s2, s1, s2, s1, s0];
  const D = det(M);
  if (!D) return { slope, rms, bow: 0, qRms: rms };
  const c = det([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D;
  const d = det([s4, t2, s2, s3, t1, s1, s2, t0, s0]) / D;
  const e = det([s4, s3, t2, s3, s2, t1, s2, s1, t0]) / D;
  let qs = 0;
  for (let i = 0; i < n; i++) {
    const u = (2 * (ys[i] - ys[0])) / span - 1;
    const r = xs[i] - (c * u * u + d * u + e);
    qs += r * r;
  }
  // A parabola c*u^2 over u in [-1, 1] departs from its chord by |c| in the middle.
  return { slope, rms, bow: Math.abs(c), qRms: Math.sqrt(qs / n) };
}

/** Near-vertical edge chains of a luma image (one pixel wide, same polarity, linked row by row). */
function verticalChains(l: Uint8Array, w: number, h: number): Chain[] {
  const T = GEOMETRY_THRESHOLDS;
  const tan = Math.tan((T.maxAngleDeg * Math.PI) / 180);
  const gx = new Float32Array(w * h);
  const ok = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = l[i - w - 1], b = l[i - w], c = l[i - w + 1], d = l[i - 1], f = l[i + 1], g = l[i + w - 1], k = l[i + w], m = l[i + w + 1];
      const sx = c + 2 * f + m - (a + 2 * d + g);
      const sy = g + 2 * k + m - (a + 2 * b + c);
      gx[i] = sx;
      if (Math.abs(sx) >= T.edgeMin && Math.abs(sy) <= tan * Math.abs(sx)) ok[i] = 1;
    }
  }
  const chains: Chain[] = [];
  let prev = new Int32Array(w).fill(-1);
  let prev2 = new Int32Array(w).fill(-1);
  for (let y = 1; y < h - 1; y++) {
    const cur = new Int32Array(w).fill(-1);
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ok[i]) continue;
      const v = Math.abs(gx[i]);
      // Thin to the ridge across the edge.
      if (v < Math.abs(gx[i - 1]) || v <= Math.abs(gx[i + 1])) continue;
      const sign = gx[i] > 0 ? 1 : -1;
      let id = -1;
      for (const rows of [prev, prev2]) {
        for (const dx of [0, -1, 1, -2, 2]) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const cand = rows[xx];
          if (cand >= 0 && chains[cand].sign === sign && chains[cand].lastY < y) {
            id = cand;
            break;
          }
        }
        if (id >= 0) break;
      }
      if (id < 0) {
        id = chains.length;
        chains.push({ sign, lastY: y, firstY: y, lastX: x, xs: [x], ys: [y] });
      } else {
        const ch = chains[id];
        ch.lastY = y;
        ch.lastX = x;
        ch.xs.push(x);
        ch.ys.push(y);
      }
      cur[x] = id;
    }
    prev2 = prev;
    prev = cur;
  }
  return chains;
}

function weightedMedian(items: { v: number; w: number }[]): number | null {
  if (!items.length) return null;
  const s = [...items].sort((a, b) => a.v - b.v);
  const total = s.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return s[s.length - 1].v;
}

/** Measure one direction: the clean long chains' angles and bends. */
function measureDirection(l: Uint8Array, w: number, h: number, dir: "v" | "h") {
  const T = GEOMETRY_THRESHOLDS;
  const minSpan = Math.max(40, Math.round(T.minSpan * h));
  const angles: { v: number; w: number }[] = [];
  const bent: BentLine[] = [];
  let maxBowPx = 0, maxBowRatio = 0;
  for (const ch of verticalChains(l, w, h)) {
    const len = ch.lastY - ch.firstY + 1;
    if (len < minSpan || ch.xs.length < minSpan * 0.8) continue;
    const f = fitChain(ch.xs, ch.ys);
    const clean = f.qRms <= T.maxRmsPx;
    if (!clean) continue;
    if (f.rms <= T.maxRmsPx * 2) angles.push({ v: (Math.atan(f.slope) * 180) / Math.PI, w: len });
    const ratio = f.bow / len;
    if (f.bow > maxBowPx) maxBowPx = f.bow;
    if (ratio > maxBowRatio) maxBowRatio = ratio;
    if (f.bow >= T.bowMinPx && ratio >= T.bowMinRatio) {
      const mx = ch.xs.reduce((s, x) => s + x, 0) / ch.xs.length;
      const my = (ch.firstY + ch.lastY) / 2;
      bent.push(dir === "v" ? { nx: mx / w, ny: my / h, bowPx: Math.round(f.bow * 10) / 10, len, dir } : { nx: my / h, ny: mx / w, bowPx: Math.round(f.bow * 10) / 10, len, dir });
    }
  }
  return { angles, bent, maxBowPx, maxBowRatio };
}

/** Transpose a luma image (rows become columns). */
function transpose(l: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = l[y * w + x];
  return out;
}

/** Crooked verticals and bent architecture from a luma image (about 1024 px wide). Pure. */
export function lineGeometry(l: Uint8Array, w: number, h: number): LineGeometry {
  const T = GEOMETRY_THRESHOLDS;
  const vert = measureDirection(l, w, h, "v");
  const horiz = measureDirection(transpose(l, w, h), h, w, "h");
  const lines = vert.angles.length;
  const tilt = lines >= 3 ? weightedMedian(vert.angles.map((a) => ({ v: Math.abs(a.v), w: a.w }))) : null;
  const lean = lines >= 3 ? weightedMedian(vert.angles) : null;
  const bent = [...vert.bent, ...horiz.bent].sort((a, b) => b.bowPx - a.bowPx);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    v: 1,
    width: w,
    height: h,
    verticalLines: lines,
    tiltDeg: tilt == null ? null : r2(tilt),
    leanDeg: lean == null ? null : r2(lean),
    bentLines: bent.length,
    maxBowPx: r2(Math.max(vert.maxBowPx, horiz.maxBowPx)),
    maxBowRatio: Math.round(Math.max(vert.maxBowRatio, horiz.maxBowRatio) * 10_000) / 10_000,
    bent: bent.slice(0, 8),
    crooked: lines >= T.crookedMinLines && (tilt ?? 0) > T.crookedDeg,
    warped: bent.length >= T.warpedMinLines,
    skipped: lines < T.crookedMinLines ? `only ${lines} long straight line${lines === 1 ? "" : "s"} to measure (needs ${T.crookedMinLines})` : null,
  };
}

/** The measurement in plain words, for a finding's explanation. */
export function geometryWords(g: LineGeometry): string {
  const parts: string[] = [];
  if (g.tiltDeg != null) parts.push(`${g.verticalLines} vertical line${g.verticalLines === 1 ? "" : "s"} measured, leaning ${g.tiltDeg.toFixed(1)}° on average`);
  else parts.push(`${g.verticalLines} vertical line${g.verticalLines === 1 ? "" : "s"} measured`);
  parts.push(g.bentLines ? `${g.bentLines} line${g.bentLines === 1 ? "" : "s"} bent (up to ${Math.round(g.maxBowPx)} px)` : "no bent lines");
  return parts.join("; ");
}
