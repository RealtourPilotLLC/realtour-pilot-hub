import { FONT_METRICS, GLYPHS } from "./lotLinesFont";

// ---------------------------------------------------------------------------
// LOT LINES ON A PHOTO, EXACTLY (Oct 22 2026).
//
// Jordan: "Let's add a lot lines adder tool to the photos section so we can
// add lot lines." Lot Lines is an order item clients buy (58 Recreation Dr,
// Jim Thorpe: "Lot Lines" + "Drone Aerial Photography"): the property
// boundary drawn on a drone or aerial photo.
//
// This file is the drawing, PURE (no I/O, no server-only), like straighten.ts:
// the editor in the browser (LotLinesEditor) draws its preview from the same
// numbers, the server's full-size render (hubFiles.ts saveLotLines) paints
// them into the pixels, and the drill checks both.
//
// A drawing is stored in IMAGE-RELATIVE coordinates (0..1 of the picture's
// width and height), so the 2048 px preview Kyle clicks on and the 6000 px
// file the client gets are the same drawing. Sizes scale with the photo too:
//   · the line width is tenths of a percent of the long edge (4 = 0.4%:
//     24 px on a 6000 px drone photo, 8 px on the 2048 preview);
//   · the label's size is the letters' em as a percent of the long edge;
//   · a dash is two line widths on, three off, with round ends (an SVG
//     dasharray of the same numbers, so the preview matches the file).
// The label's letters are Liberation Sans Bold outlines kept as data
// (lotLinesFont.ts): no font has to exist on the server.
//
// THE CONTRACT (another part of the hub reads it): the version this makes is
// labelled "Lot lines by <name>" (LOT_LINES_LABEL is the prefix). A job whose
// order has lot lines counts them as done when an active photo on the job has
// a version whose label starts with it.
// ---------------------------------------------------------------------------

export const LOT_LINES_LABEL = "Lot lines";
export const DEFAULT_LABEL_TEXT = "Approximate property lines";
export const MAX_POINTS = 150;
export const MAX_LABEL_CHARS = 60;
export const WIDTH_MIN = 1;
export const WIDTH_MAX = 20;
export const LABEL_SIZE_MIN = 1.5;
export const LABEL_SIZE_MAX = 8;
export const FILL_OPACITY_MIN = 0.05;
export const FILL_OPACITY_MAX = 0.6;
/** The soft shadow under the line and the label: black at this strength where it is thickest. */
export const GLOW_ALPHA = 0.5;

export const COLOR_PRESETS = [
  { key: "white", label: "White", hex: "#ffffff" },
  { key: "yellow", label: "Yellow", hex: "#ffd400" },
  { key: "red", label: "Red", hex: "#ff2d2d" },
] as const;

export type LotPoint = { x: number; y: number };
export type LotStyle = { color: string; width: number; dashed: boolean; glow: boolean; fill: boolean; fillOpacity: number };
export type LotLabel = { show: boolean; text: string; x: number; y: number; size: number };
export type LotDrawing = { points: LotPoint[]; closed: boolean; style: LotStyle; label: LotLabel };

export const DEFAULT_STYLE: LotStyle = { color: "#ffffff", width: 4, dashed: false, glow: true, fill: false, fillOpacity: 0.15 };
export const DEFAULT_LABEL: LotLabel = { show: true, text: DEFAULT_LABEL_TEXT, x: 0.5, y: 0.93, size: 2.6 };

export function defaultDrawing(): LotDrawing {
  return { points: [], closed: true, style: { ...DEFAULT_STYLE }, label: { ...DEFAULT_LABEL } };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The label's words as they can be drawn: straight quotes, no long dashes, only letters the font has. */
export function cleanLabelText(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .split("")
    .filter((ch) => ch in GLYPHS)
    .join("")
    .trim();
  return s.slice(0, MAX_LABEL_CHARS);
}

/** A colour as the hub keeps it: "#rrggbb", lower case; anything else is white. */
export function cleanColor(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return DEFAULT_STYLE.color;
}

/** A drawing as the hub accepts it: points inside the picture, sizes in range, the label's words cleaned. */
export function cleanDrawing(raw: unknown): LotDrawing {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<LotDrawing>;
  const points = (Array.isArray(o.points) ? o.points : [])
    .filter((p): p is LotPoint => !!p && typeof p === "object" && Number.isFinite((p as LotPoint).x) && Number.isFinite((p as LotPoint).y))
    .slice(0, MAX_POINTS)
    .map((p) => ({ x: r4(clamp(p.x, 0, 1)), y: r4(clamp(p.y, 0, 1)) }));
  const s = (o.style ?? {}) as Partial<LotStyle>;
  const l = (o.label ?? {}) as Partial<LotLabel>;
  const text = cleanLabelText(l.text ?? DEFAULT_LABEL_TEXT);
  return {
    points,
    closed: o.closed !== false,
    style: {
      color: cleanColor(s.color),
      width: Math.round(clamp(num(s.width, DEFAULT_STYLE.width), WIDTH_MIN, WIDTH_MAX) * 2) / 2,
      dashed: s.dashed === true,
      glow: s.glow !== false,
      fill: s.fill === true,
      fillOpacity: Math.round(clamp(num(s.fillOpacity, DEFAULT_STYLE.fillOpacity), FILL_OPACITY_MIN, FILL_OPACITY_MAX) * 100) / 100,
    },
    label: {
      show: l.show !== false && text.length > 0,
      text,
      x: r4(clamp(num(l.x, DEFAULT_LABEL.x), 0, 1)),
      y: r4(clamp(num(l.y, DEFAULT_LABEL.y), 0, 1)),
      size: Math.round(clamp(num(l.size, DEFAULT_LABEL.size), LABEL_SIZE_MIN, LABEL_SIZE_MAX) * 10) / 10,
    },
  };
}

/** What stops a drawing from being saved, in plain words; null when it can be. */
export function drawingProblem(d: LotDrawing): string | null {
  if (d.closed && d.points.length < 3) return "Click at least 3 points around the property to close the boundary.";
  if (!d.closed && d.points.length < 2) return "Click at least 2 points to draw a line.";
  return null;
}

/** The version's name: the prefix another part of the hub reads, then who drew it. */
export function lotLinesVersionLabel(by: string): string {
  return `${LOT_LINES_LABEL} by ${by || "staff"}`.slice(0, 80);
}

// ---- sizes in pixels ---------------------------------------------------------------------------

/** The line's width in pixels on a W × H picture. */
export const strokePx = (s: LotStyle, W: number, H: number) => Math.max(1, (s.width / 1000) * Math.max(W, H));
/** How far the soft shadow reaches past the line's edge, in pixels. */
export const glowPx = (stroke: number, W: number, H: number) => Math.max(2, stroke * 1.1 + 0.003 * Math.max(W, H));
/** A dash: on and off lengths in pixels (the ends are round, so a dash shows 3 widths and a gap 2). */
export const dashOf = (stroke: number) => ({ on: stroke * 2, off: stroke * 3 });

export type Seg = { ax: number; ay: number; bx: number; by: number };
export type Pt = { x: number; y: number };

/** The boundary's edges in pixels (a closed one ends where it began). */
export function pathSegments(d: LotDrawing, W: number, H: number): Seg[] {
  const p = d.points.map((q) => ({ x: q.x * W, y: q.y * H }));
  const out: Seg[] = [];
  for (let i = 0; i + 1 < p.length; i++) out.push({ ax: p[i].x, ay: p[i].y, bx: p[i + 1].x, by: p[i + 1].y });
  if (d.closed && p.length >= 3) out.push({ ax: p[p.length - 1].x, ay: p[p.length - 1].y, bx: p[0].x, by: p[0].y });
  return out;
}

/** The drawn pieces of a dashed path: the dash pattern runs on around the corners, as an SVG dasharray does. */
export function dashPieces(segs: Seg[], on: number, off: number): Seg[] {
  const out: Seg[] = [];
  let drawing = true;
  let left = on;
  for (const s of segs) {
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
    if (len <= 0) continue;
    let at = 0;
    while (at < len - 1e-9) {
      const step = Math.min(left, len - at);
      if (drawing) {
        const t0 = at / len, t1 = (at + step) / len;
        out.push({ ax: s.ax + (s.bx - s.ax) * t0, ay: s.ay + (s.by - s.ay) * t0, bx: s.ax + (s.bx - s.ax) * t1, by: s.ay + (s.by - s.ay) * t1 });
      }
      at += step;
      left -= step;
      if (left <= 1e-9) {
        drawing = !drawing;
        left = drawing ? on : off;
      }
    }
  }
  return out;
}

/** What the line paints: its edges, or their dashes. */
export function strokePieces(d: LotDrawing, W: number, H: number): Seg[] {
  const segs = pathSegments(d, W, H);
  if (!d.style.dashed) return segs;
  const { on, off } = dashOf(strokePx(d.style, W, H));
  return dashPieces(segs, on, off);
}

// ---- the label ---------------------------------------------------------------------------------

type GlyphCmd = { c: "M" | "L" | "Q" | "Z"; v: number[] };
const parsed = new Map<string, GlyphCmd[]>();
function glyphCmds(ch: string): GlyphCmd[] {
  const hit = parsed.get(ch);
  if (hit) return hit;
  const d = GLYPHS[ch]?.[1] ?? "";
  const out: GlyphCmd[] = [];
  for (const m of d.matchAll(/([MLQZ])([^MLQZ]*)/g)) out.push({ c: m[1] as GlyphCmd["c"], v: m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [] });
  parsed.set(ch, out);
  return out;
}

/** Where the label sits, in pixels: its em, the pen's start, the baseline, and its box (kept inside the picture). */
export function labelPlacement(label: LotLabel, W: number, H: number): { em: number; x0: number; baseline: number; box: { x0: number; y0: number; x1: number; y1: number } } | null {
  const text = cleanLabelText(label.text);
  if (!label.show || !text) return null;
  const long = Math.max(W, H);
  const margin = 0.015 * long;
  const units = [...text].reduce((s, ch) => s + (GLYPHS[ch]?.[0] ?? 0), 0);
  if (!units) return null;
  let em = (label.size / 100) * long;
  // Too wide for the picture: smaller, never cut off.
  if ((units / 1000) * em > W - 2 * margin) em = ((W - 2 * margin) * 1000) / units;
  const w = (units / 1000) * em;
  const up = 0.76 * em, down = 0.22 * em;
  const cx = clamp(label.x * W, margin + w / 2, W - margin - w / 2);
  const cy = clamp(label.y * H, margin + (up + down) / 2, H - margin - (up + down) / 2);
  const baseline = cy + ((FONT_METRICS.capHeight / 1000) * em) / 2;
  const x0 = cx - w / 2;
  return { em, x0, baseline, box: { x0, y0: baseline - up, x1: x0 + w, y1: baseline + down } };
}

/** The label's outlines in pixels, curves flattened: closed contours for the nonzero fill. */
export function labelContours(label: LotLabel, W: number, H: number): Pt[][] {
  const at = labelPlacement(label, W, H);
  if (!at) return [];
  const s = at.em / 1000;
  const out: Pt[][] = [];
  let pen = 0;
  for (const ch of cleanLabelText(label.text)) {
    const adv = GLYPHS[ch]?.[0] ?? 0;
    const X = (x: number) => at.x0 + (pen + x) * s;
    const Y = (y: number) => at.baseline - y * s;
    let cur: Pt[] = [];
    let last: Pt = { x: 0, y: 0 };
    for (const cmd of glyphCmds(ch)) {
      if (cmd.c === "M") {
        if (cur.length > 2) out.push(cur);
        last = { x: X(cmd.v[0]), y: Y(cmd.v[1]) };
        cur = [last];
      } else if (cmd.c === "L") {
        last = { x: X(cmd.v[0]), y: Y(cmd.v[1]) };
        cur.push(last);
      } else if (cmd.c === "Q") {
        const c1 = { x: X(cmd.v[0]), y: Y(cmd.v[1]) }, p2 = { x: X(cmd.v[2]), y: Y(cmd.v[3]) };
        const len = Math.hypot(c1.x - last.x, c1.y - last.y) + Math.hypot(p2.x - c1.x, p2.y - c1.y);
        const n = Math.max(1, Math.min(24, Math.ceil(len / 2.5)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          cur.push({ x: u * u * last.x + 2 * u * t * c1.x + t * t * p2.x, y: u * u * last.y + 2 * u * t * c1.y + t * t * p2.y });
        }
        last = p2;
      } else if (cmd.c === "Z") {
        if (cur.length > 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length > 2) out.push(cur);
    pen += adv;
  }
  return out;
}

/** The label as one SVG path in the picture's pixels (the editor's preview: the same letters the file gets). */
export function labelSvgPath(label: LotLabel, W: number, H: number): string {
  const at = labelPlacement(label, W, H);
  if (!at) return "";
  const s = at.em / 1000;
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  let d = "";
  let pen = 0;
  for (const ch of cleanLabelText(label.text)) {
    const X = (x: number) => f(at.x0 + (pen + x) * s);
    const Y = (y: number) => f(at.baseline - y * s);
    for (const cmd of glyphCmds(ch)) {
      if (cmd.c === "Z") d += "Z";
      else if (cmd.c === "Q") d += `Q${X(cmd.v[0])} ${Y(cmd.v[1])} ${X(cmd.v[2])} ${Y(cmd.v[3])}`;
      else d += `${cmd.c}${X(cmd.v[0])} ${Y(cmd.v[1])}`;
    }
    pen += GLYPHS[ch]?.[0] ?? 0;
  }
  return d;
}

// ---- painting the pixels ----------------------------------------------------------------------

export type LotRaster = { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 3 | 4 };

export function hexToRgb(hex: string): [number, number, number] {
  const h = cleanColor(hex);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function blend(r: LotRaster, i: number, rgb: readonly [number, number, number], a: number) {
  if (a <= 0) return;
  if (a > 1) a = 1;
  const d = r.data;
  d[i] = Math.round(d[i] + (rgb[0] - d[i]) * a);
  d[i + 1] = Math.round(d[i + 1] + (rgb[1] - d[i + 1]) * a);
  d[i + 2] = Math.round(d[i + 2] + (rgb[2] - d[i + 2]) * a);
}

const BLACK = [0, 0, 0] as const;

/** Even-odd fill of a polygon (pixel coordinates), exact across each row, at strength `alpha`. */
function fillPolygon(r: LotRaster, pts: Pt[], rgb: readonly [number, number, number], alpha: number) {
  const W = r.width, H = r.height, C = r.channels;
  const ys = pts.map((p) => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const L = Math.max(0, xs[k]), R = Math.min(W, xs[k + 1]);
      if (R <= L) continue;
      for (let x = Math.floor(L); x < Math.ceil(R); x++) {
        const cov = Math.min(x + 1, R) - Math.max(x, L);
        if (cov > 0) blend(r, (y * W + x) * C, rgb, alpha * cov);
      }
    }
  }
}

/**
 * The shadow and the line: for every pixel near the path, its distance to
 * the nearest drawn piece; the line covers what lies within half its width
 * (smooth over the last pixel), the shadow fades out past it.
 */
function strokePath(r: LotRaster, pieces: Seg[], half: number, glow: number, rgb: readonly [number, number, number]) {
  const W = r.width, H = r.height, C = r.channels;
  if (!pieces.length) return;
  const reach = half + glow + 1;
  const dist = new Float32Array(W);
  const minY = Math.max(0, Math.floor(Math.min(...pieces.map((p) => Math.min(p.ay, p.by))) - reach));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(...pieces.map((p) => Math.max(p.ay, p.by))) + reach));
  const spans: { p: Seg; x0: number; x1: number }[] = [];
  for (let y = minY; y <= maxY; y++) {
    const cy = y + 0.5;
    spans.length = 0;
    let lo = W, hi = -1;
    for (const p of pieces) {
      if (cy < Math.min(p.ay, p.by) - reach || cy > Math.max(p.ay, p.by) + reach) continue;
      const dx = p.bx - p.ax, dy = p.by - p.ay;
      // The strip around the piece's line on this row, inside its box (a superset of where it can reach).
      let xa = Math.min(p.ax, p.bx) - reach, xb = Math.max(p.ax, p.bx) + reach;
      if (Math.abs(dy) > 1e-9) {
        const xc = p.ax + ((cy - p.ay) * dx) / dy;
        const hw = (reach * Math.hypot(dx, dy)) / Math.abs(dy);
        xa = Math.max(xa, xc - hw);
        xb = Math.min(xb, xc + hw);
      }
      const x0 = Math.max(0, Math.floor(xa)), x1 = Math.min(W - 1, Math.ceil(xb));
      if (x1 < x0) continue;
      spans.push({ p, x0, x1 });
      lo = Math.min(lo, x0);
      hi = Math.max(hi, x1);
    }
    if (hi < lo) continue;
    dist.fill(Infinity, lo, hi + 1);
    for (const { p, x0, x1 } of spans) {
      const dx = p.bx - p.ax, dy = p.by - p.ay;
      const len2 = dx * dx + dy * dy;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        let t = len2 > 0 ? ((px - p.ax) * dx + (cy - p.ay) * dy) / len2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = px - (p.ax + t * dx), ey = cy - (p.ay + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d < dist[x]) dist[x] = d;
      }
    }
    for (let x = lo; x <= hi; x++) {
      const d = dist[x];
      if (!(d < reach)) continue;
      const i = (y * W + x) * C;
      if (glow > 0) {
        const t = d <= half ? 0 : (d - half) / glow;
        if (t < 1) blend(r, i, BLACK, GLOW_ALPHA * (1 - t) * (1 - t));
      }
      const cov = half + 0.5 - d;
      if (cov > 0) blend(r, i, rgb, cov);
    }
  }
}

/** The label: letters filled (nonzero, 4 rows a pixel, exact across), on a soft shadow when the line has one. */
function paintLabel(r: LotRaster, contours: Pt[][], rgb: readonly [number, number, number], halo: number) {
  if (!contours.length) return;
  const W = r.width, H = r.height, C = r.channels;
  const all = contours.flat();
  const pad = Math.ceil(halo * 2) + 2;
  const bx0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.x))) - pad), bx1 = Math.min(W, Math.ceil(Math.max(...all.map((p) => p.x))) + pad);
  const by0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.y))) - pad), by1 = Math.min(H, Math.ceil(Math.max(...all.map((p) => p.y))) + pad);
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw <= 0 || bh <= 0) return;
  const cov = new Float32Array(bw * bh);
  const edges: { ax: number; ay: number; bx: number; by: number; dir: number }[] = [];
  for (const c of contours) for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    if (a.y !== b.y) edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, dir: b.y > a.y ? 1 : -1 });
  }
  const SUB = 4;
  const hits: { x: number; dir: number }[] = [];
  for (let y = by0; y < by1; y++) {
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      hits.length = 0;
      for (const e of edges) {
        if ((e.ay <= sy && e.by > sy) || (e.by <= sy && e.ay > sy)) hits.push({ x: e.ax + ((sy - e.ay) * (e.bx - e.ax)) / (e.by - e.ay), dir: e.dir });
      }
      hits.sort((p, q) => p.x - q.x);
      // Inside wherever the winding is not 0: a span from where it leaves 0 to where it comes back.
      let wind = 0;
      let start = 0;
      for (let k = 0; k < hits.length; k++) {
        const was = wind;
        wind += hits[k].dir;
        if (was === 0 && wind !== 0) start = hits[k].x;
        else if (was !== 0 && wind === 0) {
          const L = Math.max(bx0, start), R = Math.min(bx1, hits[k].x);
          for (let x = Math.floor(L); x < Math.ceil(R); x++) {
            const c = Math.min(x + 1, R) - Math.max(x, L);
            if (c > 0) cov[(y - by0) * bw + (x - bx0)] += c / SUB;
          }
        }
      }
    }
  }
  if (halo > 0) {
    // Two box blurs each way: close to a Gaussian, cheap on the label's box.
    const rad = Math.max(1, Math.round(halo));
    const tmp = new Float32Array(bw * bh);
    let a = Float32Array.from(cov), b = tmp;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < bh; y++) {
        let sum = 0;
        for (let x = -rad; x <= rad; x++) sum += a[y * bw + clamp(x, 0, bw - 1)];
        for (let x = 0; x < bw; x++) {
          b[y * bw + x] = sum / (2 * rad + 1);
          sum += a[y * bw + Math.min(bw - 1, x + rad + 1)] - a[y * bw + Math.max(0, x - rad)];
        }
      }
      [a, b] = [b, a];
      for (let x = 0; x < bw; x++) {
        let sum = 0;
        for (let y = -rad; y <= rad; y++) sum += a[clamp(y, 0, bh - 1) * bw + x];
        for (let y = 0; y < bh; y++) {
          b[y * bw + x] = sum / (2 * rad + 1);
          sum += a[Math.min(bh - 1, y + rad + 1) * bw + x] - a[Math.max(0, y - rad) * bw + x];
        }
      }
      [a, b] = [b, a];
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const h = Math.min(1, a[y * bw + x] * 3) * (GLOW_ALPHA + 0.15);
      if (h > 0.002) blend(r, ((y + by0) * W + (x + bx0)) * C, BLACK, h);
    }
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const c = cov[y * bw + x];
    if (c > 0.002) blend(r, ((y + by0) * W + (x + bx0)) * C, rgb, Math.min(1, c));
  }
}

/**
 * Paint a drawing into a picture, in place (RGB or RGBA; alpha untouched):
 * the fill, the line's shadow and the line, then the label on its own shadow.
 */
export function renderLotLines(r: LotRaster, raw: LotDrawing): void {
  const d = cleanDrawing(raw);
  const W = r.width, H = r.height;
  const rgb = hexToRgb(d.style.color);
  const w = strokePx(d.style, W, H);
  const glow = d.style.glow ? glowPx(w, W, H) : 0;
  if (d.closed && d.style.fill && d.points.length >= 3) fillPolygon(r, d.points.map((p) => ({ x: p.x * W, y: p.y * H })), rgb, d.style.fillOpacity);
  if (d.points.length >= 2) strokePath(r, strokePieces(d, W, H), w / 2, glow, rgb);
  const at = labelPlacement(d.label, W, H);
  if (at) paintLabel(r, labelContours(d.label, W, H), rgb, d.style.glow ? Math.max(1, at.em * 0.07) : 0);
}
