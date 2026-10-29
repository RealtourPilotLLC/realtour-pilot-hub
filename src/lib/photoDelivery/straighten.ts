// ---------------------------------------------------------------------------
// STRAIGHTEN, KEYSTONE AND CROP, EXACTLY (Oct 21 2026).
//
// Jordan: "Kyle needs a quick and easy way to fix image perspective, and
// cropping, etc." AutoHDR's API has no deterministic crop, straighten or
// perspective (only a free-form AI re-edit, imprecise for geometry), so the
// hub does it itself. This file is the math, PURE (no I/O, no server-only):
// the editor in the browser, the server's fallback render and the drill all
// use the same functions, so what Kyle sees is what gets saved.
//
// The model (pixel coordinates, origin at the frame's centre, y down):
//   · rotate θ: positive turns the picture clockwise;
//   · keystone K: tenths of a degree of lean taken out at the frame's left and
//     right edges. Positive makes verticals that lean in toward the top (the
//     camera pointed up) parallel; negative does the same for verticals that
//     lean in toward the bottom (the camera pointed down). It is the
//     projective map (X, Y) → (X, Y) / (1 + pY), p = 2·tan(K/10°)/W, which
//     sends every line through the vanishing point (0, -1/p) to a vertical;
//   · the source is turned first, then keystoned (a camera's roll, then its
//     pitch): FORWARD = K · R.
//   · crop: the kept part of the corrected frame (W × H, same size as the
//     source), as shares of its width and height. Turning and keystoning leave
//     empty corners; autoCrop finds the largest rectangle of the chosen shape
//     that has none.
// The saved file keeps the original's long edge (the gallery's photos stay
// one size, GAL_RESOLUTION_CONSISTENCY) unless that would enlarge the crop by
// more than MAX_UPSCALE; then it keeps the crop's own pixels.
// ---------------------------------------------------------------------------

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type CropRect = { x: number; y: number; w: number; h: number };
export type AspectKey = "original" | "3:2" | "4:3" | "16:9" | "free";
export type StraightenParams = { rotate: number; keystone: number; crop: CropRect; aspect: AspectKey };
export type Pt = { x: number; y: number };

export const ROTATE_LIMIT = 10;
export const KEYSTONE_LIMIT = 100;
export const MAX_UPSCALE = 1.35;
export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
export const ASPECTS: { key: AspectKey; label: string }[] = [
  { key: "original", label: "Original" },
  { key: "3:2", label: "3:2" },
  { key: "4:3", label: "4:3" },
  { key: "16:9", label: "16:9" },
  { key: "free", label: "Free" },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The parameters as the hub accepts them: in range, rotate in tenths, keystone whole, crop inside the frame. */
export function cleanParams(p: Partial<StraightenParams> | null | undefined): StraightenParams {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const rotate = round1(clamp(n(p?.rotate), -ROTATE_LIMIT, ROTATE_LIMIT));
  const keystone = Math.round(clamp(n(p?.keystone), -KEYSTONE_LIMIT, KEYSTONE_LIMIT));
  const c = p?.crop ?? FULL_CROP;
  const x = clamp(n(c.x), 0, 1);
  const y = clamp(n(c.y), 0, 1);
  const w = clamp(n(c.w) || 1, 0.02, 1 - x);
  const h = clamp(n(c.h) || 1, 0.02, 1 - y);
  const aspect = ASPECTS.some((a) => a.key === p?.aspect) ? (p!.aspect as AspectKey) : "original";
  return { rotate: Object.is(rotate, -0) ? 0 : rotate, keystone: Object.is(keystone, -0) ? 0 : keystone, crop: { x, y, w, h }, aspect };
}

/** Nothing to do: no turn, no keystone, the whole frame. */
export function isIdentity(p: StraightenParams): boolean {
  return p.rotate === 0 && p.keystone === 0 && p.crop.x <= 1e-6 && p.crop.y <= 1e-6 && p.crop.w >= 1 - 1e-6 && p.crop.h >= 1 - 1e-6;
}

// ---- matrices --------------------------------------------------------------------------------

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error("the transform cannot be undone");
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function apply3(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** The keystone's projective strength for a frame `width` pixels wide. */
export const keystoneP = (keystone: number, width: number) => (2 * Math.tan((keystone / 10) * (Math.PI / 180))) / width;

/** Source → corrected frame, in centred pixel coordinates. */
export function forwardCentered(rotate: number, keystone: number, W: number): Mat3 {
  const t = (rotate * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const R: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1];
  const K: Mat3 = [1, 0, 0, 0, 1, 0, 0, keystoneP(keystone, W), 1];
  return mul3(K, R);
}

/** Source → corrected frame, in top-left pixel coordinates of a W × H image. */
export function forwardMatrix(rotate: number, keystone: number, W: number, H: number): Mat3 {
  const to: Mat3 = [1, 0, W / 2, 0, 1, H / 2, 0, 0, 1];
  const from: Mat3 = [1, 0, -W / 2, 0, 1, -H / 2, 0, 0, 1];
  return mul3(to, mul3(forwardCentered(rotate, keystone, W), from));
}

/**
 * The CSS matrix3d (column-major) that draws a W × H image, laid out at the
 * same W × H box with transform-origin 0 0, the way the forward map puts it.
 * The editor's live preview: the GPU draws it, the final render matches it.
 */
export function cssMatrix3d(rotate: number, keystone: number, W: number, H: number): string {
  const m = forwardMatrix(rotate, keystone, W, H);
  const k = m[8];
  const v = [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, m[8]].map((x) => x / k);
  return `matrix3d(${v.map((x) => (Math.abs(x) < 1e-12 ? 0 : Number(x.toPrecision(10)))).join(",")})`;
}

// ---- the empty corners -----------------------------------------------------------------------

/** The corrected picture's outline in the frame (top-left, top-right, bottom-right, bottom-left). */
export function frameQuad(rotate: number, keystone: number, W: number, H: number): Pt[] {
  const m = forwardMatrix(rotate, keystone, W, H);
  return [apply3(m, 0, 0), apply3(m, W, 0), apply3(m, W, H), apply3(m, 0, H)];
}

/** Inside (or on) a convex polygon, either winding. */
export function insideConvex(poly: Pt[], x: number, y: number, eps = 1e-6): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = cross / len;
    if (Math.abs(d) <= eps) continue;
    const s = d > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** A pixel rectangle with no empty corner: all four corners on the picture and in the frame. */
export function rectFits(r: { x: number; y: number; w: number; h: number }, quad: Pt[], W: number, H: number): boolean {
  const e = 1e-6 * Math.max(W, H);
  if (r.x < -e || r.y < -e || r.x + r.w > W + e || r.y + r.h > H + e) return false;
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].every(([x, y]) => insideConvex(quad, x, y, 1e-3));
}

/** Width over height of a preset, turned to match a portrait photo. */
export function aspectRatio(key: AspectKey, W: number, H: number): number | null {
  if (key === "free") return null;
  if (key === "original") return W / H;
  const [a, b] = key.split(":").map(Number);
  const r = a / b;
  return H > W ? 1 / r : r;
}

/**
 * The largest rectangle of width/height `ratio` with no empty corner (pixels).
 * A size search at each centre of a grid, then finer grids around the best.
 */
export function largestRect(quad: Pt[], W: number, H: number, ratio: number): { x: number; y: number; w: number; h: number } {
  const maxH = (cx: number, cy: number) => {
    let hi = Math.min(2 * Math.min(cy, H - cy), (2 * Math.min(cx, W - cx)) / ratio);
    if (hi <= 0 || !insideConvex(quad, cx, cy, 1e-3)) return 0;
    const fits = (h: number) => rectFits({ x: cx - (ratio * h) / 2, y: cy - h / 2, w: ratio * h, h }, quad, W, H);
    if (fits(hi)) return hi;
    let lo = 0;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let best = { h: maxH(W / 2, H / 2), cx: W / 2, cy: H / 2 };
  const tryAt = (cx: number, cy: number) => {
    const h = maxH(cx, cy);
    // A centred crop wins a tie (a straightened photo stays centred).
    if (h > best.h * (1 + 1e-6)) best = { h, cx, cy };
  };
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) tryAt(W * (0.3 + (0.4 * i) / 20), H * (0.3 + (0.4 * j) / 20));
  let sx = W * 0.01, sy = H * 0.01;
  for (let round = 0; round < 6; round++) {
    const c0 = { ...best };
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) tryAt(c0.cx + di * sx, c0.cy + dj * sy);
    sx /= 2;
    sy /= 2;
  }
  return { x: best.cx - (ratio * best.h) / 2, y: best.cy - best.h / 2, w: ratio * best.h, h: best.h };
}

/** The crop that removes every empty corner, for a preset (Free keeps the frame's shape), as shares of the frame. */
export function autoCrop(rotate: number, keystone: number, W: number, H: number, aspect: AspectKey): CropRect {
  const ratio = aspectRatio(aspect, W, H) ?? W / H;
  if (rotate === 0 && keystone === 0 && Math.abs(ratio - W / H) < 1e-9) return { ...FULL_CROP };
  const r = largestRect(frameQuad(rotate, keystone, W, H), W, H, ratio);
  return { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
}

/** Does a crop (shares of the frame) show any empty corner? */
export function cropFits(rotate: number, keystone: number, W: number, H: number, c: CropRect): boolean {
  return rectFits({ x: c.x * W, y: c.y * H, w: c.w * W, h: c.h * H }, frameQuad(rotate, keystone, W, H), W, H);
}

/**
 * A person's crop after the turn or keystone changed: kept when it still has
 * no empty corner, else shrunk about its centre until it has none, else the
 * automatic crop.
 */
export function fitCrop(rotate: number, keystone: number, W: number, H: number, c: CropRect, aspect: AspectKey): CropRect {
  if (cropFits(rotate, keystone, W, H, c)) return c;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const at = (k: number): CropRect => ({ x: cx - (c.w * k) / 2, y: cy - (c.h * k) / 2, w: c.w * k, h: c.h * k });
  if (!cropFits(rotate, keystone, W, H, at(0.02))) return autoCrop(rotate, keystone, W, H, aspect);
  let lo = 0.02, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits(rotate, keystone, W, H, at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

// ---- the saved file ----------------------------------------------------------------------------

/** The saved file's size: the original's long edge kept (up to MAX_UPSCALE), else the crop's own pixels. */
export function outputSize(W: number, H: number, crop: CropRect): { width: number; height: number; scale: number } {
  const cw = crop.w * W, ch = crop.h * H;
  const scale = Math.max(1, Math.min(Math.max(W, H) / Math.max(cw, ch), MAX_UPSCALE));
  const width = Math.max(1, Math.round(cw * scale));
  const height = Math.max(1, Math.round(ch * scale));
  return { width, height, scale };
}

export type Raster = { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 3 | 4 };

/**
 * Render rows [y0, y1) of the corrected, cropped picture into `out` (same
 * channel count as `src`): each output pixel's centre is mapped back through
 * the inverse transform and sampled bilinearly. A point that falls off the
 * source (a crop with an empty corner) takes the nearest edge pixel.
 */
export function renderRows(src: Raster, out: Raster, p: StraightenParams, y0 = 0, y1 = out.height): void {
  const W = src.width, H = src.height, C = src.channels;
  if (out.channels !== C) throw new Error("the output must have the source's channels");
  const inv = invert3(forwardMatrix(p.rotate, p.keystone, W, H));
  const fx0 = p.crop.x * W, fy0 = p.crop.y * H;
  const sx = (p.crop.w * W) / out.width, sy = (p.crop.h * H) / out.height;
  const s = src.data, o = out.data;
  // A canvas's clamped array rounds what it is given; a plain one truncates.
  const bias = o instanceof Uint8ClampedArray ? 0 : 0.5;
  const [a, b, c, d, e, f, g, h, i] = inv;
  for (let oy = y0; oy < y1; oy++) {
    const fy = fy0 + (oy + 0.5) * sy;
    let k = oy * out.width * C;
    for (let ox = 0; ox < out.width; ox++) {
      const fx = fx0 + (ox + 0.5) * sx;
      const w = g * fx + h * fy + i;
      // Continuous source position; pixel centres sit at +0.5.
      let u = (a * fx + b * fy + c) / w - 0.5;
      let v = (d * fx + e * fy + f) / w - 0.5;
      if (u < 0) u = 0; else if (u > W - 1) u = W - 1;
      if (v < 0) v = 0; else if (v > H - 1) v = H - 1;
      const x0 = u | 0, y0r = v | 0;
      const x1 = x0 + 1 < W ? x0 + 1 : x0, y1r = y0r + 1 < H ? y0r + 1 : y0r;
      const tx = u - x0, ty = v - y0r;
      const p00 = (y0r * W + x0) * C, p10 = (y0r * W + x1) * C, p01 = (y1r * W + x0) * C, p11 = (y1r * W + x1) * C;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      for (let ch = 0; ch < C; ch++) o[k++] = s[p00 + ch] * w00 + s[p10 + ch] * w10 + s[p01 + ch] * w01 + s[p11 + ch] * w11 + bias;
    }
  }
}

/** The whole picture at once (the server's render, the drill). */
export function renderStraightened(src: Raster, p: StraightenParams): Raster {
  const size = outputSize(src.width, src.height, p.crop);
  const out: Raster = { data: new Uint8Array(size.width * size.height * src.channels), width: size.width, height: size.height, channels: src.channels };
  renderRows(src, out, p);
  return out;
}

// ---- Auto: the measured lean as a starting point ------------------------------------------

/** One measured line: its lean (degrees, positive: the top leans right), where it crosses the middle row, and its length. */
export type LeanLine = { leanDeg: number; xMid: number; len: number };

/**
 * The turn and keystone that make the measured lines vertical: a weighted fit
 * of lean = roll + edge·u (u = -1 at the left edge, +1 at the right), with
 * lines far off the fit dropped twice (a slanted chair leg is not a wall).
 * Turn = -roll; keystone = -edge in tenths of a degree. First order: a
 * starting point a person checks on the grid.
 */
export function solveLean(lines: LeanLine[], W: number): { rotate: number; keystone: number; used: number; residualDeg: number | null } {
  let use = lines.filter((l) => Number.isFinite(l.leanDeg) && Number.isFinite(l.xMid) && l.len > 0 && Math.abs(l.leanDeg) <= 15);
  if (use.length < 3) return { rotate: 0, keystone: 0, used: use.length, residualDeg: null };
  let roll = 0, edge = 0;
  const fit = (ls: LeanLine[]) => {
    let sw = 0, su = 0, sa = 0, suu = 0, sua = 0;
    for (const l of ls) {
      const u = (l.xMid - W / 2) / (W / 2);
      const w = l.len;
      sw += w; su += w * u; sa += w * l.leanDeg; suu += w * u * u; sua += w * u * l.leanDeg;
    }
    const den = sw * suu - su * su;
    // Every line in one place: no keystone can be told apart, the turn only.
    if (Math.abs(den) < 1e-9 * sw * sw || ls.length < 4) return { roll: sa / sw, edge: 0 };
    const e = (sw * sua - su * sa) / den;
    return { roll: (sa - e * su) / sw, edge: e };
  };
  const residual = (l: LeanLine) => l.leanDeg - (roll + edge * ((l.xMid - W / 2) / (W / 2)));
  for (let round = 0; round < 3; round++) {
    ({ roll, edge } = fit(use));
    if (round === 2) break;
    const rs = use.map((l) => Math.abs(residual(l))).sort((a, b) => a - b);
    const mad = rs[Math.floor(rs.length / 2)] ?? 0;
    const limit = Math.max(1, 2.5 * mad);
    const kept = use.filter((l) => Math.abs(residual(l)) <= limit);
    if (kept.length < 3 || kept.length === use.length) {
      ({ roll, edge } = fit(use));
      break;
    }
    use = kept;
  }
  const rs = use.map((l) => Math.abs(residual(l))).sort((a, b) => a - b);
  return {
    rotate: round1(clamp(-roll, -ROTATE_LIMIT, ROTATE_LIMIT)) || 0,
    keystone: Math.round(clamp(-edge * 10, -KEYSTONE_LIMIT, KEYSTONE_LIMIT)) || 0,
    used: use.length,
    residualDeg: rs.length ? Math.round(rs[Math.floor(rs.length / 2)] * 100) / 100 : null,
  };
}

/** A measured line from the line check (qc/cv verticalLineFits: x per row, centre): its lean and where it crosses the middle row. */
export function leanLineOf(fit: { slope: number; x: number; y: number; len: number }, H: number): LeanLine {
  // slope = dx/dy with y down: a top leaning right has a negative slope.
  return { leanDeg: (-Math.atan(fit.slope) * 180) / Math.PI, xMid: fit.x + fit.slope * (H / 2 - fit.y), len: fit.len };
}

// ---- finding boxes follow the picture --------------------------------------------------------

type Box = [number, number, number, number];
const bounds = (pts: Pt[]) => ({ x1: Math.min(...pts.map((q) => q.x)), y1: Math.min(...pts.map((q) => q.y)), x2: Math.max(...pts.map((q) => q.x)), y2: Math.max(...pts.map((q) => q.y)) });
const cornersOf = ([x1, y1, x2, y2]: Box): Pt[] => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];

/** A full-resolution box on the W × H source, on the saved file (null when the crop cut it away). */
export function boxToEdited(box: Box, p: StraightenParams, W: number, H: number): Box | null {
  const m = forwardMatrix(p.rotate, p.keystone, W, H);
  const out = outputSize(W, H, p.crop);
  const kx = out.width / (p.crop.w * W), ky = out.height / (p.crop.h * H);
  const b = bounds(cornersOf(box).map((q) => apply3(m, q.x, q.y)).map((q) => ({ x: (q.x - p.crop.x * W) * kx, y: (q.y - p.crop.y * H) * ky })));
  const x1 = clamp(b.x1, 0, out.width), y1 = clamp(b.y1, 0, out.height), x2 = clamp(b.x2, 0, out.width), y2 = clamp(b.y2, 0, out.height);
  return x2 - x1 < 1 || y2 - y1 < 1 ? null : [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
}

/** A box on the saved file, back on the W × H source. */
export function boxToSource(box: Box, p: StraightenParams, W: number, H: number): Box | null {
  const inv = invert3(forwardMatrix(p.rotate, p.keystone, W, H));
  const out = outputSize(W, H, p.crop);
  const kx = out.width / (p.crop.w * W), ky = out.height / (p.crop.h * H);
  const b = bounds(cornersOf(box).map((q) => apply3(inv, q.x / kx + p.crop.x * W, q.y / ky + p.crop.y * H)));
  const x1 = clamp(b.x1, 0, W), y1 = clamp(b.y1, 0, H), x2 = clamp(b.x2, 0, W), y2 = clamp(b.y2, 0, H);
  return x2 - x1 < 1 || y2 - y1 < 1 ? null : [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
}

// ---- which findings an edit can settle ---------------------------------------------------------

/** Leaning lines: a turn or a keystone fixes them. */
export const LEAN_RULES = ["PERSP_CROOKED_VERTICALS", "PERSP_LEANING_DOOR_FRAMES", "PERSP_EXTERIOR_WALLS_LEANING", "PERSP_CROOKED_HORIZON", "PERSP_INCORRECT_LR_CORRECTION", "PERSP_HORIZONTAL_DISTORTION"];
/** Framing a crop fixes. */
export const CROP_RULES = ["COMP_TOO_MUCH_CEILING", "COMP_TOO_MUCH_FLOOR", "COMP_EXCESSIVE_FOREGROUND", "COMP_EXTERIOR_NOT_CENTERED", "PERSP_EXTERIOR_NOT_CENTERED", "PERSP_EXCESSIVE_CEILING_FLOOR_SPACE"];
/** The rows that offer Straighten, and the findings a save may mark fixed. */
export const editCanSettle = (ruleId: string) => ruleId.startsWith("PERSP_") || CROP_RULES.includes(ruleId);
/** Ticked by default: lean findings when the photo was turned or keystoned, framing ones when it was cropped. */
export function settledByDefault(ruleId: string, p: StraightenParams): boolean {
  const cropped = !(p.crop.x <= 1e-6 && p.crop.y <= 1e-6 && p.crop.w >= 1 - 1e-6 && p.crop.h >= 1 - 1e-6);
  return (LEAN_RULES.includes(ruleId) && (p.rotate !== 0 || p.keystone !== 0)) || (CROP_RULES.includes(ruleId) && cropped);
}

/** "Straightened 2.3°, keystone 12, cropped 3:2": what the version is called. */
export function editLabel(p: StraightenParams, by: string): string {
  const parts: string[] = [];
  if (p.rotate) parts.push(`straightened ${Math.abs(p.rotate).toFixed(1)}°`);
  if (p.keystone) parts.push(`keystone ${p.keystone}`);
  const full = p.crop.x <= 1e-6 && p.crop.y <= 1e-6 && p.crop.w >= 1 - 1e-6 && p.crop.h >= 1 - 1e-6;
  if (!full) parts.push(p.aspect === "original" ? "cropped" : p.aspect === "free" ? "cropped (free)" : `cropped ${p.aspect}`);
  const what = parts.length ? parts.join(", ") : "re-saved";
  return `${what[0].toUpperCase()}${what.slice(1)} by ${by}`.slice(0, 80);
}
