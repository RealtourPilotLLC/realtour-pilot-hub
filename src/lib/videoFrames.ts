import "server-only";

import { spawn } from "child_process";
import { accessSync, chmodSync, constants as fsConstants, copyFileSync, existsSync, createWriteStream } from "fs";
import { mkdtemp, readdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import sharp from "sharp";
import { COVER_H, COVER_W } from "@/lib/videoAnalysisCore";

// ---------------------------------------------------------------------------
// THE REAL FRAME, AT FULL RESOLUTION (Oct 24 2026). Gemini answers with a
// MOMENT, read off its own sampled frames (about 2 a second), so its pick is
// the right moment, not the exact frame. Jordan's videos are usually 30 fps:
// for each pick this decodes the real file across about half a second either
// side (every 2nd frame, ~15 frames), scores each frame's sharpness (variance
// of the Laplacian over the face, or the middle of the frame when there is
// none) and keeps the sharpest, so a frame caught mid-blink-or-turn loses to
// the steady one beside it. No extra Gemini call: this is all local.
//
// HOW, ON VERCEL. A static ffmpeg binary from the `ffmpeg-static` package
// (ffmpeg 6.1.1, about 80 MB on linux-x64; Vercel's function limit is 250 MB
// unzipped). It is not bundled by webpack: next.config's
// outputFileTracingIncludes ships node_modules/ffmpeg-static/ffmpeg with the
// one route that runs this (/api/cron/video-analysis), and ffmpegPath() finds
// it there at run time. FFMPEG_PATH overrides it (drills point it at the local
// binary). ffmpeg reads the video straight from its URL (a presigned blob URL
// or a Dropbox temporary link), seeking with HTTP range requests, so only the
// seconds around each moment are downloaded; if it cannot open the URL itself
// the file is copied to /tmp once and read from there. sharp (already a
// dependency) scores the frames and writes the 1080×1920 JPEG.
// ---------------------------------------------------------------------------

export function ffmpegPath(): string | null {
  const env = (process.env.FFMPEG_PATH ?? "").trim();
  if (env) return existsSync(env) ? runnable(env) : null;
  const local = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  return existsSync(local) ? runnable(local) : null;
}

/** The binary as an executable: a deployment that dropped the execute bit gets a copy in /tmp that has it. */
function runnable(p: string): string | null {
  try {
    accessSync(p, fsConstants.X_OK);
    return p;
  } catch {
    try {
      const copy = path.join(os.tmpdir(), "rtp-ffmpeg");
      if (!existsSync(copy)) {
        copyFileSync(p, copy);
        chmodSync(copy, 0o755);
      }
      return copy;
    } catch {
      return null;
    }
  }
}

type RunResult = { code: number | null; stderr: string; timedOut: boolean };

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 400_000) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

/** "Duration: 00:00:31.53" → 31.53 */
export function durationFromStderr(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** How long the video is, read from its header (ffmpeg -i, no decoding). Null when it can't be read. */
export async function probeDurationSec(source: string): Promise<number | null> {
  const bin = ffmpegPath();
  if (!bin) return null;
  const r = await runFfmpeg(bin, ["-hide_banner", "-nostdin", "-i", source], 30_000);
  return durationFromStderr(r.stderr);
}

/** showinfo's per-frame pts_time values, in output order. */
export function ptsTimesFromStderr(stderr: string): number[] {
  return [...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
}

/**
 * Sharpness of one frame: the variance of its Laplacian (edges), over the face
 * when Gemini placed one, else the middle of the frame. Higher is sharper.
 */
export async function sharpnessOf(input: string | Buffer, focus?: { x: number; y: number } | null): Promise<number> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return 0;
  const rw = Math.max(16, Math.round(w * (focus ? 0.4 : 0.6)));
  const rh = Math.max(16, Math.round(h * (focus ? 0.3 : 0.6)));
  const cx = focus ? focus.x * w : w / 2;
  const cy = focus ? focus.y * h : h / 2;
  const left = Math.min(Math.max(0, Math.round(cx - rw / 2)), Math.max(0, w - rw));
  const top = Math.min(Math.max(0, Math.round(cy - rh / 2)), Math.max(0, h - rh));
  const { data, info } = await sharp(input)
    .extract({ left, top, width: Math.min(rw, w - left), height: Math.min(rh, h - top) })
    .greyscale()
    .resize({ width: 480, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return laplacianVariance(data, info.width, info.height, info.channels);
}

/** Variance of the 4-neighbour Laplacian over a greyscale raw buffer (the first channel of each pixel). */
export function laplacianVariance(data: Uint8Array, width: number, height: number, channels = 1): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  const at = (x: number, y: number) => data[(y * width + x) * channels];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const lap = 4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return Math.round((sumSq / n - mean * mean) * 100) / 100;
}

/** One 1080×1920 JPEG from a frame: cropped to 9:16 around the face when the video is wider than that. */
export async function coverJpeg(input: string | Buffer, faceX = 0.5): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? COVER_W;
  const h = meta.height ?? COVER_H;
  const target = COVER_W / COVER_H;
  let img = sharp(input);
  if (w / h > target + 0.01) {
    const cw = Math.round((h * COVER_W) / COVER_H);
    const left = Math.min(Math.max(0, Math.round(faceX * w - cw / 2)), w - cw);
    img = img.extract({ left, top: 0, width: cw, height: h });
  } else if (w / h < target - 0.01) {
    const ch = Math.round((w * COVER_H) / COVER_W);
    img = img.extract({ left: 0, top: Math.round((h - ch) / 2), width: w, height: ch });
  }
  return img.resize(COVER_W, COVER_H, { fit: "cover" }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

export type FrameSample = { t: number; file: string; sharpness: number };

/**
 * Every 2nd frame of the real file across [t - half, t + half], each scored.
 * `source` is a URL ffmpeg can read with range requests, or a local path.
 */
export async function sampleWindow(
  bin: string,
  source: string,
  t: number,
  dir: string,
  opts: { half?: number; step?: number; focus?: { x: number; y: number } | null; timeoutMs?: number } = {},
): Promise<{ frames: FrameSample[]; durationSec: number | null; error: string | null }> {
  const half = opts.half ?? 0.5;
  const step = Math.max(1, Math.round(opts.step ?? 2));
  const t0 = Math.max(0, t - half);
  const sub = await mkdtemp(path.join(dir, "w-"));
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "info",
    "-ss", t0.toFixed(3), "-i", source, "-t", (half * 2).toFixed(3),
    "-an", "-sn", "-dn",
    "-vf", `select=not(mod(n\\,${step})),showinfo`,
    "-fps_mode", "passthrough", "-q:v", "2",
    path.join(sub, "f%03d.jpg"),
  ];
  const r = await runFfmpeg(bin, args, opts.timeoutMs ?? 45_000);
  const files = (await readdir(sub).catch(() => [] as string[])).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  const durationSec = durationFromStderr(r.stderr);
  if (!files.length) {
    // Never the URL in a message: it carries a signed token.
    const why = r.timedOut ? "timed out" : (r.stderr.split("\n").map((l) => l.trim()).filter((l) => /error|invalid|not found|failed|denied|refused|protocol/i.test(l)).pop() ?? `exit ${r.code}`);
    return { frames: [], durationSec, error: why.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) };
  }
  const pts = ptsTimesFromStderr(r.stderr);
  // Score at most ~16 frames (a 60 fps file gives twice as many).
  const stride = Math.max(1, Math.ceil(files.length / 16));
  const frames: FrameSample[] = [];
  for (let i = 0; i < files.length; i += stride) {
    const file = path.join(sub, files[i]);
    const at = Number.isFinite(pts[i]) ? t0 + pts[i] : t0 + (i * step) / 30;
    frames.push({ t: Math.round(at * 1000) / 1000, file, sharpness: await sharpnessOf(file, opts.focus ?? null).catch(() => 0) });
  }
  return { frames, durationSec, error: null };
}

const MAX_LOCAL_COPY = 900 * 1024 * 1024;

async function localCopy(url: string, dir: string): Promise<string | null> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(180_000) }).catch(() => null);
  if (!res || !res.ok || !res.body) return null;
  const size = Number(res.headers.get("content-length") || 0);
  if (size > MAX_LOCAL_COPY) {
    await res.body.cancel().catch(() => {});
    return null;
  }
  const file = path.join(dir, "source.bin");
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), createWriteStream(file));
  return (await stat(file)).size > 0 ? file : null;
}

export type GrabbedCover = { t: number; frameT: number; sharpness: number; bytes: Buffer; width: number; height: number };

/**
 * The covers for a list of moments, in the same order: for each, the sharpest
 * real frame near it, as a 1080×1920 JPEG. Throws with a plain reason when no
 * frame at all can be read (no ffmpeg, an unreadable file).
 */
export async function grabCovers(input: {
  source: string;
  picks: readonly { t: number; faceX: number; faceY: number; hasFace?: boolean }[];
}): Promise<{ covers: GrabbedCover[]; durationSec: number | null }> {
  const bin = ffmpegPath();
  if (!bin) throw new Error("The frame grabber (ffmpeg) isn't installed on this server.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "rtp-cover-"));
  try {
    let source = input.source;
    let durationSec: number | null = null;
    const covers: GrabbedCover[] = [];
    let triedCopy = !/^https?:\/\//i.test(source);
    for (const p of input.picks) {
      const focus = p.hasFace === false ? null : { x: p.faceX, y: p.faceY };
      let w = await sampleWindow(bin, source, p.t, dir, { focus });
      if (!w.frames.length && !triedCopy) {
        // ffmpeg could not open the URL itself: one local copy, then every window reads it.
        triedCopy = true;
        const local = await localCopy(source, dir);
        if (local) {
          source = local;
          w = await sampleWindow(bin, source, p.t, dir, { focus });
        }
      }
      durationSec = durationSec ?? w.durationSec;
      if (!w.frames.length) {
        if (!covers.length && p === input.picks[input.picks.length - 1]) throw new Error(`No frame could be read from the video (${w.error ?? "unknown"}).`);
        continue;
      }
      const best = w.frames.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
      const bytes = await coverJpeg(best.file, p.faceX);
      covers.push({ t: p.t, frameT: best.t, sharpness: best.sharpness, bytes, width: COVER_W, height: COVER_H });
    }
    if (!covers.length) throw new Error("No frame could be read from the video.");
    return { covers, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
