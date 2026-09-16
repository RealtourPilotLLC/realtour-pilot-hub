import "server-only";

import { getConnection, getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Topaz Video AI — the HTTP side (Sep 16 2026).
//
// Jordan: "Once the video cut is approved, it runs through the Topaz Video AI
// API, applies a preset, and exports it at 1080p to the Dropbox folder… I want
// all videos to be ran through topaz when uploaded and approved in ops hub."
//
// The key is pasted ONCE on Connections and stored through the same encrypted
// plumbing as every other provider (saveSecret). It is read back here and
// nowhere else: it never reaches a browser, a log line, an error message, a
// stored row or a task summary. `scrub()` below is the belt to that braces —
// an upstream error body that echoes the key back never survives into anything
// we persist.
//
// The render flow, in Topaz's order. Only step 4 costs money:
//   1. POST   /video/                      → requestId + cost/time ESTIMATE.
//             FREE. Consumes no credits. Does not start processing. This is
//             the pre-flight every job must pass before we commit to spend.
//   2. PATCH  /video/{id}/accept           → presigned upload URL(s).
//   3. PUT    <presigned url>              → the bytes; each PUT returns an eTag.
//   4. PATCH  /video/{id}/complete-upload  → PROCESSING STARTS HERE. Credits.
//   5. GET    /video/{id}/status           → …and eventually a download link.
//
// Restrictions Topaz documents: 500 MB per request (413 over it), 429 on rate
// limits (exponential backoff), HTTPS only.
// ---------------------------------------------------------------------------

export const TOPAZ_PROVIDER = "topaz";

const API = "https://api.topazlabs.com";

// Endpoint paths — ALL VERIFIED against Topaz's reference docs on Sep 16.
// Two of the three housekeeping paths had been guessed, and both guesses were
// wrong: cancelling is a DELETE on the request itself (not PATCH …/cancel), and
// the file purge is …/media (not …/files). A wrong cancel path is not cosmetic
// — accepting a request RESERVES credits, so a cancel that 404s silently leaves
// Jordan's credits reserved against a render nobody is waiting for.
// …/cancel-estimate exists but is a GET that PREVIEWS what cancelling would
// cost; it is not a way to release anything, so releasing an estimate we
// decided not to accept uses the cancel endpoint too. Still overridable without
// a deploy if Topaz moves them.
const PATH_CANCEL_REQUEST = process.env.TOPAZ_PATH_CANCEL ?? "/video/{id}";
const PATH_DELETE_FILES = process.env.TOPAZ_PATH_DELETE_FILES ?? "/video/{id}/media";

export class TopazError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** true = the same call is worth making again later (429, 5xx, network) */
    public retryable = false,
  ) {
    super(message);
    this.name = "TopazError";
  }
}

/** Remove anything that looks like the API key from text we are about to log,
 *  store or show. Topaz echoes request context in some error bodies, and an
 *  error message is the one place a secret leaks without anybody noticing. */
export function scrub(text: string, key?: string | null): string {
  let out = text;
  if (key && key.length >= 8) out = out.split(key).join("[key]");
  // Anything shaped like a long opaque token, whether or not it is OUR key.
  return out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]").slice(0, 400);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function topazFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; key?: string; timeoutMs?: number } = {},
): Promise<T> {
  const key = init.key ?? (await getSecret(TOPAZ_PROVIDER));
  if (!key) throw new TopazError("Topaz isn't connected yet — paste the API key on the Connections page.", 0, false);
  const url = `${API}${path}`;
  let last: TopazError | null = null;
  // Three tries with exponential backoff. 429 is the one Topaz names
  // explicitly; 5xx and network blips get the same treatment because they are
  // equally "not processed". A 4xx that is not 429 is a decision, not a blip.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          "X-API-Key": key,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      });
    } catch (e) {
      last = new TopazError(scrub(`Couldn't reach Topaz (${(e as Error).message})`, key), 0, true);
      if (attempt === 3) throw last;
      await sleep(attempt * 2000 + Math.random() * 500);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TopazError("Topaz sent back something we couldn't read.", res.status, false);
      }
    }
    const bodyText = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    last = new TopazError(
      scrub(`Topaz ${res.status}${bodyText ? ` — ${bodyText}` : ""}`, key),
      res.status,
      retryable,
    );
    if (!retryable || attempt === 3) throw last;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : attempt * 3000;
    await sleep(waitMs + Math.random() * 500);
  }
  throw last ?? new TopazError("Topaz didn't answer.", 0, true);
}

// ---- connection ------------------------------------------------------------

/** Connected = a CONNECTED row whose secret still decrypts. Same test the
 *  Connections page makes for every other provider: a stored-but-unreadable
 *  key is not a connection. */
export async function topazConnected(): Promise<boolean> {
  const c = await getConnection(TOPAZ_PROVIDER).catch(() => null);
  if (!c || c.status !== "CONNECTED" || !c.secretEncrypted) return false;
  return Boolean(await getSecret(TOPAZ_PROVIDER));
}

export type TopazBalance = { available_credits: number; reserved_credits: number; total_credits: number };

/** The ONLY call "Test connection" is allowed to make: it reads the balance and
 *  spends nothing. `key` lets the Connections page test a pasted key before it
 *  is saved. */
export async function topazBalance(key?: string): Promise<TopazBalance> {
  const raw = await topazFetch<Partial<TopazBalance>>("/account/v1/credits/balance", { key, timeoutMs: 20_000 });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    available_credits: n(raw.available_credits),
    reserved_credits: n(raw.reserved_credits),
    total_credits: n(raw.total_credits),
  };
}

/**
 * "Test & connect" on the Connections page. It calls THE FREE BALANCE ENDPOINT
 * AND NOTHING ELSE — no estimate, no render, no request of any kind that could
 * reserve or spend a credit. `key` is the pasted value, tested before it is
 * saved; it is never logged and never returned.
 *
 * Shaped to drop straight into the TESTERS table in
 * src/app/connections/actions.ts: `topaz: testTopazKey`.
 */
export async function testTopazKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const k = key.trim();
  if (k.length < 12) return { ok: false, error: "That looks too short to be a Topaz API key — copy the whole thing." };
  try {
    const b = await topazBalance(k);
    return { ok: true, label: `${Math.round(b.available_credits)} credits available` };
  } catch (e) {
    if (e instanceof TopazError) {
      if (e.status === 401 || e.status === 403) return { ok: false, error: "Topaz didn't accept that key — check it was copied in full and hasn't been revoked." };
      if (e.status === 429) return { ok: false, error: "Topaz is rate limiting us — try again in a minute." };
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? scrub(e.message, k) : "Couldn't reach Topaz." };
  }
}

// ---- the render flow -------------------------------------------------------

export type TopazSource = {
  resolution: { width: number; height: number };
  container: string;
  size: number;
  duration: number;
  frameRate: number;
  frameCount: number;
};

export type TopazOutput = {
  resolution: { width: number; height: number };
  audioCodec: string;
  audioTransfer: string;
  frameRate: number;
  dynamicCompressionLevel: string;
  container: string;
};

export type TopazFilter = Record<string, string | number> & { model: string };

export type TopazRequestBody = { source: TopazSource; output: TopazOutput; filters: TopazFilter[] };

/** What step 1 hands back. Topaz's field names for the estimate are not pinned
 *  down in the docs, so `raw` is kept and read defensively by estimateFrom(). */
export type TopazEstimate = { requestId: string; credits: number | null; seconds: number | null; raw: unknown };

function pick(o: unknown, ...names: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const n of names) if (rec[n] !== undefined && rec[n] !== null) return rec[n];
  return undefined;
}
const asNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Read the cost and time estimate out of whatever shape step 1 returns.
 *  Deliberately generous about names and deliberately STRICT about the result:
 *  a null credits figure means "we could not read a price", and the caller's
 *  rule is that no price means no spend. Guessing a number here would be the
 *  one bug that bills Jordan silently. */
function fromRange(v: unknown, take: "max" | "min"): number | null {
  // Topaz answers with a RANGE. Measured against the live API on Sep 16:
  //   {"requestId":"…","estimates":{"cost":[8,9],"time":[1211,1287]}}
  // A scalar is still read, in case the shape ever settles down.
  if (Array.isArray(v)) {
    const nums = v.map(asNum).filter((n): n is number => n !== null);
    if (!nums.length) return null;
    return take === "max" ? Math.max(...nums) : Math.min(...nums);
  }
  return asNum(v);
}

export function estimateFrom(raw: unknown): { credits: number | null; seconds: number | null } {
  const roots = [raw, pick(raw, "estimate", "estimates", "data")].filter(Boolean);
  let credits: number | null = null;
  let seconds: number | null = null;
  for (const r of roots) {
    credits ??= fromRange(pick(r, "cost", "credits", "estimatedCredits", "creditCost", "cost_credits", "creditsRequired"), "max");
    const costObj = pick(r, "cost");
    if (credits === null && costObj && typeof costObj === "object" && !Array.isArray(costObj)) {
      credits = fromRange(pick(costObj, "credits", "estimatedCredits", "amount", "value", "max"), "max");
    }
    seconds ??= fromRange(pick(r, "time", "estimatedSeconds", "seconds", "processingTime", "estimatedTime", "eta"), "max");
    const timeObj = pick(r, "time");
    if (seconds === null && timeObj && typeof timeObj === "object" && !Array.isArray(timeObj)) {
      seconds = fromRange(pick(timeObj, "seconds", "estimatedSeconds", "value", "max"), "max");
    }
  }
  // The TOP of the range, always. This number is what every spend guard is
  // checked against, so the cautious end is the only honest one to plan with.
  return { credits, seconds: seconds === null ? null : Math.round(seconds) };
}

/** STEP 1 — free. Returns a requestId and the estimate. Consumes no credits and
 *  starts nothing: this is the pre-flight, and every job must pass it. */
export async function createVideoRequest(body: TopazRequestBody): Promise<TopazEstimate> {
  const raw = await topazFetch<unknown>("/video/", { method: "POST", body, timeoutMs: 90_000 });
  const requestId = String(pick(raw, "requestId", "request_id", "id") ?? "");
  if (!requestId) throw new TopazError("Topaz accepted the request but didn't give it an id.", 0, false);
  return { requestId, ...estimateFrom(raw), raw };
}

export type TopazUploadTarget = { partNum: number; url: string };

/** STEP 2 — accept the estimate and get somewhere to put the bytes. Still no
 *  credits: processing starts at complete-upload, not here. That is what makes
 *  a repeated accept safe after a crash. */
export async function acceptVideoRequest(requestId: string): Promise<TopazUploadTarget[]> {
  const raw = await topazFetch<unknown>(`/video/${encodeURIComponent(requestId)}/accept`, {
    method: "PATCH",
    timeoutMs: 60_000,
  });
  return uploadTargetsFrom(raw);
}

/** Topaz may answer with one URL or with a multipart set. Normalise both into
 *  numbered parts so the uploader has exactly one shape to resume against. */
export function uploadTargetsFrom(raw: unknown): TopazUploadTarget[] {
  const direct = pick(raw, "uploadUrl", "upload_url", "url", "presignedUrl");
  if (typeof direct === "string" && direct) return [{ partNum: 1, url: direct }];
  const list = pick(raw, "uploadUrls", "upload_urls", "urls", "parts", "uploadResults");
  if (Array.isArray(list)) {
    const out: TopazUploadTarget[] = [];
    for (const [i, item] of list.entries()) {
      if (typeof item === "string") out.push({ partNum: i + 1, url: item });
      else {
        const url = pick(item, "url", "uploadUrl", "upload_url", "presignedUrl");
        const partNum = asNum(pick(item, "partNum", "part_number", "partNumber", "part"));
        if (typeof url === "string" && url) out.push({ partNum: partNum ?? i + 1, url });
      }
    }
    if (out.length) return out.sort((a, b) => a.partNum - b.partNum);
  }
  throw new TopazError("Topaz didn't say where to upload the file.", 0, false);
}

export type TopazUploadResult = { partNum: number; eTag: string };

/** STEP 3 — PUT one part's bytes to its presigned URL and return the eTag.
 *  Written as its own call so the driver can do one part per tick and resume:
 *  the sources measure 76–465 MB and a Vercel function dies at 300s. */
export async function putUploadPart(
  target: TopazUploadTarget,
  bytes: ArrayBuffer | Uint8Array,
  contentType = "video/mp4",
): Promise<TopazUploadResult> {
  // No X-API-Key here — a presigned URL carries its own authorisation, and
  // adding a header that is not part of the signature is how these 403.
  const res = await fetch(target.url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes as BodyInit,
    cache: "no-store",
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TopazError(
      scrub(`Upload of part ${target.partNum} failed (${res.status}${body ? ` — ${body}` : ""})`),
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  const eTag = (res.headers.get("etag") ?? res.headers.get("ETag") ?? "").replace(/"/g, "");
  if (!eTag) throw new TopazError(`Topaz's storage didn't confirm part ${target.partNum}.`, res.status, true);
  return { partNum: target.partNum, eTag };
}

/** STEP 4 — THE ONE CALL THAT SPENDS MONEY. Processing starts here. The driver
 *  claims the right to make it with a compare-and-swap first (TopazJob
 *  .completeUploadAt), so exactly one invocation can ever fire it for a job. */
export async function completeUpload(requestId: string, uploadResults: TopazUploadResult[]): Promise<void> {
  // Trailing slash is Topaz's published path: PATCH /video/{requestId}/complete-upload/
  await topazFetch(`/video/${encodeURIComponent(requestId)}/complete-upload/`, {
    method: "PATCH",
    body: { uploadResults },
    timeoutMs: 60_000,
  });
}

export type TopazStatus = {
  /** Topaz's own word, lower-cased. */
  status: string;
  /** Set once the render is finished. */
  downloadUrl: string | null;
  /** What it actually cost, when Topaz says. */
  credits: number | null;
  progress: number | null;
  message: string | null;
  raw: unknown;
};

/** STEP 5 — where is it? This is also the ARBITER after a crash: our own state
 *  column can be stale or wrong, Topaz's answer cannot. The recovery path for a
 *  complete-upload we are not sure landed is to ask here, never to call it
 *  again. */
export async function videoStatus(requestId: string): Promise<TopazStatus> {
  const raw = await topazFetch<unknown>(`/video/${encodeURIComponent(requestId)}/status`, { timeoutMs: 30_000 });
  const status = String(pick(raw, "status", "state", "requestStatus") ?? "unknown").toLowerCase();
  // "download" FIRST — it is the key Topaz actually sends, measured on a real
  // finished render (Sep 16): {"status":"complete","progress":100,
  // "download":{"url":"https://…/enhanced.mp4?X-Amz-…","expiresAt":…}}.
  // It was missing from this list, so a render that had genuinely finished and
  // been PAID FOR looked unfinished for ever: the job sat in `processing` until
  // the four-hour stall check failed it, and the file would have been left on
  // Topaz's servers to expire. The nested read below is what recovers the URL.
  const dl = pick(raw, "download", "downloadUrl", "download_url", "url", "downloadLink", "output");
  let downloadUrl: string | null = typeof dl === "string" && dl.startsWith("http") ? dl : null;
  if (!downloadUrl && dl && typeof dl === "object") {
    const nested = pick(dl, "url", "downloadUrl", "download_url", "link");
    if (typeof nested === "string" && nested.startsWith("http")) downloadUrl = nested;
  }
  return {
    status,
    downloadUrl,
    // Topaz does not report what it finally charged: a finished render still
    // answers with the same estimate RANGE it opened with ("estimates":
    // {"cost":[24,27]}). Read the range's low end — on the real render measured
    // Sep 16 the balance moved by exactly that (569 → 545 on a [24,27] quote) —
    // and let the caller prefer its own balance-delta when it has one.
    credits:
      fromRange(pick(raw, "credits", "creditsUsed", "creditsCharged"), "max") ??
      fromRange(pick(pick(raw, "estimates", "estimate") ?? {}, "cost"), "min"),
    progress: asNum(pick(raw, "progress", "percent", "percentComplete")),
    message: typeof pick(raw, "message", "error", "detail") === "string" ? (pick(raw, "message", "error", "detail") as string) : null,
    raw,
  };
}

/** Topaz's own words for "there is a finished file" and "this will never
 *  finish". Anything else is read as still running — the safe reading, because
 *  a job we wrongly call finished loses the render we already paid for. */
// Topaz's documented status vocabulary (from the cancel-estimate schema, the
// only place they publish the enum): requested · accepted · initializing ·
// preprocessing · processing · postprocessing · complete · canceling ·
// canceled · failed. The extra synonyms below cost nothing and cover a rename.
export const TOPAZ_DONE = new Set(["complete", "completed", "finished", "done", "success", "succeeded"]);
export const TOPAZ_DEAD = new Set(["failed", "error", "cancelled", "canceled", "canceling", "rejected", "expired"]);
/**
 * Bytes are still owed — complete-upload has not been accepted yet.
 *
 * ONLY WORDS THAT CAN MEAN NOTHING ELSE belong in here, because this set is
 * what hands the spend claim back: a status in it makes the pipeline ask Topaz
 * to start the render again. "created", "accepted" and "estimated" were in this
 * list until the Sep 16 review and none of them is unambiguous — "accepted" is
 * a perfectly plausible thing for Topaz to call a request that has been
 * accepted AND queued, and reading it as "send it again" would re-fire the one
 * call that spends money on a render that was already running and paid for.
 * Anything not listed here is read as "still working", which is the safe
 * reading: it costs a wait, and the four-hour stall check ends it either way.
 */
export const TOPAZ_AWAITING_UPLOAD = new Set([
  "awaiting_upload",
  "awaiting-upload",
  "awaitingupload",
  "pending_upload",
  "pending-upload",
  "upload_pending",
  "waiting_for_upload",
]);

// ---- housekeeping (best-effort; a 404 here is never a failure) -------------

const fill = (tpl: string, id: string) => tpl.replace("{id}", encodeURIComponent(id));

/** Stop a request Topaz is (or might be) working on. Used when Jordan cancels a
 *  stuck job — the point is to stop paying for it. */
export async function cancelVideoRequest(requestId: string): Promise<boolean> {
  try {
    await topazFetch(fill(PATH_CANCEL_REQUEST, requestId), { method: "DELETE", timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Release an estimate we asked for and decided not to accept. There is no
 *  separate "release an estimate" call — …/cancel-estimate only PREVIEWS the
 *  settlement — so this is the ordinary cancel, which Topaz documents as
 *  refunding everything when a request has not started processing. Free at that
 *  point, by their own words. */
export async function cancelEstimate(requestId: string): Promise<boolean> {
  return cancelVideoRequest(requestId);
}

/** Hygiene: once the finished file is safely in Dropbox, there is no reason for
 *  a copy of a client's property video to sit on Topaz's servers. Called ONLY
 *  after the Dropbox copy is confirmed complete — never before. */
export async function deleteVideoFiles(requestId: string): Promise<boolean> {
  try {
    await topazFetch(fill(PATH_DELETE_FILES, requestId), { method: "DELETE", timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WHAT SIZE DOES IT COME OUT? "1080p" means the SHORT side is 1080, with the
// orientation and aspect ratio of the source kept exactly. That is not a
// detail: the cuts in the store are BOTH shapes — 1080×1920 vertical reels and
// 3840×2160 landscape personal-branding pieces — so a fixed 1080×1920 output
// would letterbox or stretch half of his work. Vertical stays 1080×1920;
// the 4K landscape comes out 1920×1080. Both are "1080p", which is what Jordan
// asked for ("I want it to be 1080p though which works best on Social Media").
// Rounded to even numbers because every codec in use wants even dimensions.
// ---------------------------------------------------------------------------
export function plannedOutput(
  source: { width: number; height: number },
  opts: { shortSide: number; neverUpscale: boolean },
): { width: number; height: number } {
  const short = Math.min(source.width, source.height);
  if (short <= 0) return { width: source.width, height: source.height };
  if (opts.neverUpscale && short <= opts.shortSide) return { width: source.width, height: source.height };
  const scale = opts.shortSide / short;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/** Topaz's published Proteus price list, as a per-minute rate. Used ONLY as a
 *  second opinion next to the API's own estimate — never as a substitute.
 *  (1080p: 1 min = 8, 5 min = 38, 10 min = 76 credits. 4K: 1 min = 31.)
 *
 *  PRICING FOLLOWS THE BIGGER OF SOURCE AND OUTPUT, not the output alone.
 *  Measured Sep 16 on a real cut: a 3840x2160 source rendered DOWN to
 *  1920x1080 was quoted 27 credits, which is the 4K rate for its 50 seconds —
 *  not the 7 an output-only reading predicted. The model still has to read
 *  every 4K frame, so downscaling buys quality, not a discount. Reading this
 *  the old way under-quoted 4K jobs four-fold, which matters because this
 *  number is one of the two the spend ceiling is checked against. */
export function localCreditEstimate(
  output: { width: number; height: number },
  durationSec: number,
  source?: { width: number; height: number } | null,
): number {
  const pixels = Math.max(output.width * output.height, source ? source.width * source.height : 0);
  const perMinute = pixels >= 3840 * 2160 * 0.9 ? 31 : pixels >= 1920 * 1080 * 0.9 ? 8 : 4;
  return Math.ceil((Math.max(1, durationSec) / 60) * perMinute);
}

// ---------------------------------------------------------------------------
// HOW BIG IS IT, HOW LONG IS IT, HOW MANY FRAMES?
//
// Topaz's step 1 requires duration, frameRate and frameCount, and THE HUB DOES
// NOT KNOW ANY OF THEM. Nothing in the schema stores video metadata, there is
// no ffprobe on a Vercel function, and the editor's browser never told us. The
// three options were: guess (never — those numbers go into a paid API and a
// wrong frameCount is a wrong price), download 465 MB to measure it (a lambda
// cannot), or read the file's own header.
//
// So we read the header. An MP4/MOV is a tree of boxes; the `moov` box carries
// the whole answer and is typically 27–43 KB. We walk the top-level boxes by
// their 16-byte headers over HTTP range requests, jump straight to `moov`
// wherever it sits (Premiere writes it at the END of a .mov — both real
// examples in the store do), and read it alone. Measured against the actual
// cuts: ~250–300 ms and ~40 KB pulled per file, exact answers every time.
//
// If it cannot be read, the job FAILS with a plain-English message. It never
// falls back to an assumed duration: that is the one place a made-up number
// would turn into a bill.
// ---------------------------------------------------------------------------

export type VideoMeta = {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationSec: number;
  container: string;
  codec: string;
  sizeBytes: number;
};

type Box = { type: string; start: number; headerSize: number; size: number };

function readBox(buf: Buffer, off: number): Box | null {
  if (off + 8 > buf.length) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString("latin1", off + 4, off + 8);
  let headerSize = 8;
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(off + 8));
    headerSize = 16;
  }
  return { type, start: off, headerSize, size };
}

function* children(buf: Buffer, from: number, to: number): Generator<Box> {
  let off = from;
  while (off + 8 <= Math.min(to, buf.length)) {
    const b = readBox(buf, off);
    if (!b || b.size < 8) return;
    yield b;
    off = b.start + b.size;
  }
}

function findBox(buf: Buffer, from: number, to: number, type: string): Box | null {
  for (const b of children(buf, from, to)) if (b.type === type) return b;
  return null;
}

function findPath(buf: Buffer, from: number, to: number, path: string[]): Box | null {
  let f = from;
  let t = to;
  let box: Box | null = null;
  for (const p of path) {
    box = findBox(buf, f, t, p);
    if (!box) return null;
    f = box.start + box.headerSize;
    t = box.start + box.size;
  }
  return box;
}

async function rangeBytes(url: string, start: number, end: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new TopazError(`Couldn't read the video file (${res.status}).`, res.status, res.status >= 500);
  return Buffer.from(await res.arrayBuffer());
}

export async function probeVideoMetadata(url: string, knownSize?: number | null): Promise<VideoMeta> {
  let total = knownSize ?? 0;
  if (!total) {
    const head = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!head.ok) throw new TopazError(`Couldn't open the video file (${head.status}).`, head.status, head.status >= 500);
    total = Number(head.headers.get("content-length") ?? 0);
  }
  if (!total) throw new TopazError("Couldn't tell how big the video file is.", 0, true);

  // Walk the top-level boxes, reading only each one's header, until `moov`.
  // 64 is a generous ceiling: a real file has a handful (ftyp, free, mdat, moov).
  let off = 0;
  let moov: Box | null = null;
  let container = "mp4";
  for (let i = 0; i < 64 && off < total; i++) {
    const head = await rangeBytes(url, off, off + 15);
    const b = readBox(head, 0);
    if (!b || b.size < 8) break;
    if (b.type === "ftyp") {
      const brand = head.toString("latin1", 8, 12).trim();
      container = brand === "qt" ? "mov" : "mp4";
    }
    if (b.type === "moov") {
      moov = { ...b, start: off };
      break;
    }
    off += b.size;
  }
  if (!moov || moov.size > 64 * 1024 * 1024) {
    throw new TopazError("This video file's header isn't where a video file's header should be, so its length and frame rate can't be read.", 0, false);
  }
  const m = await rangeBytes(url, moov.start, moov.start + moov.size - 1);

  for (const trak of children(m, moov.headerSize, moov.size)) {
    if (trak.type !== "trak") continue;
    const tf = trak.start + trak.headerSize;
    const tt = trak.start + trak.size;
    const hdlr = findPath(m, tf, tt, ["mdia", "hdlr"]);
    if (!hdlr) continue;
    // hdlr body: version+flags(4), pre_defined(4), handler_type(4)
    if (m.toString("latin1", hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12) !== "vide") continue;

    const mdhd = findPath(m, tf, tt, ["mdia", "mdhd"]);
    const stts = findPath(m, tf, tt, ["mdia", "minf", "stbl", "stts"]);
    const stsd = findPath(m, tf, tt, ["mdia", "minf", "stbl", "stsd"]);
    if (!mdhd || !stts || !stsd) break;

    const mv = m.readUInt8(mdhd.start + mdhd.headerSize);
    const mBody = mdhd.start + mdhd.headerSize;
    const timescale = mv === 1 ? m.readUInt32BE(mBody + 20) : m.readUInt32BE(mBody + 12);
    const mediaDur = mv === 1 ? Number(m.readBigUInt64BE(mBody + 24)) : m.readUInt32BE(mBody + 16);
    const durationSec = timescale > 0 ? mediaDur / timescale : 0;

    // stts: version+flags(4), entry_count(4), then [sample_count, sample_delta]×N
    const sBody = stts.start + stts.headerSize;
    const entries = m.readUInt32BE(sBody + 4);
    let frameCount = 0;
    const deltas = new Map<number, number>();
    for (let i = 0; i < entries && sBody + 8 + i * 8 + 8 <= stts.start + stts.size; i++) {
      const count = m.readUInt32BE(sBody + 8 + i * 8);
      const delta = m.readUInt32BE(sBody + 12 + i * 8);
      frameCount += count;
      deltas.set(delta, (deltas.get(delta) ?? 0) + count);
    }
    // stsd: version+flags(4), entry_count(4), then the sample entry box, whose
    // visual width/height sit 24/26 bytes into its body.
    const entry = readBox(m, stsd.start + stsd.headerSize + 8);
    if (!entry) break;
    let width = m.readUInt16BE(entry.start + 8 + 24);
    let height = m.readUInt16BE(entry.start + 8 + 26);

    // A phone-shot clip stores landscape pixels plus a 90° rotation matrix; the
    // display shape is what "1080p vertical" has to be measured against.
    const tkhd = findBox(m, tf, tt, "tkhd");
    if (tkhd) {
      const tv = m.readUInt8(tkhd.start + tkhd.headerSize);
      const mOff = tkhd.start + tkhd.headerSize + (tv === 1 ? 52 : 40);
      if (mOff + 16 <= tkhd.start + tkhd.size) {
        const a = m.readInt32BE(mOff) / 65536;
        const b = m.readInt32BE(mOff + 4) / 65536;
        if (Math.abs(a) < 0.01 && Math.abs(b) > 0.99) [width, height] = [height, width]; // 90°/270°
      }
    }

    const common = [...deltas.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const frameRate =
      common && timescale > 0 ? timescale / common : durationSec > 0 ? frameCount / durationSec : 0;

    if (!(width > 0 && height > 0 && frameCount > 0 && durationSec > 0 && frameRate > 0)) break;
    return {
      width,
      height,
      frameRate: Math.round(frameRate * 1000) / 1000,
      frameCount,
      durationSec: Math.round(durationSec * 1000) / 1000,
      container,
      codec: entry.type,
      sizeBytes: total,
    };
  }
  throw new TopazError("Couldn't find a video track in that file — it may not be a video, or it may have been cut short on upload.", 0, false);
}

// ---------------------------------------------------------------------------
// THE ARYEO HALF CANNOT BE BUILT, AND THE SCREEN HAS TO SAY SO.
//
// Aryeo's full OpenAPI spec (95 operations) was read on Sep 16 2026. There is
// NO endpoint that uploads or creates a video: PUT /videos/{video_id} accepts
// exactly one property, `title`. ListingPutPayload has 16 properties, all of
// them property metadata, none of them media. There is no delivery or
// re-delivery endpoint anywhere in the spec. The word "upload" appears only in
// prose describing videos people uploaded through Aryeo's own website.
//
// So the pipeline ends by handing Kyle everything he needs and getting out of
// the way. This sentence goes on the task and on every screen that shows one,
// so nobody sits waiting for an automation that cannot exist.
// ---------------------------------------------------------------------------
export const ARYEO_MANUAL_NOTE =
  "Aryeo has no way for another program to upload a video or send a delivery — we checked every option their system offers. This last step is by hand, and it always will be.";
