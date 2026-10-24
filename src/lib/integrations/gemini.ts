import "server-only";

import { getConnection, getSecret } from "./connections";
import { fetchWithTimeout } from "@/lib/http";

// ---------------------------------------------------------------------------
// GOOGLE GEMINI, FOR READING OUR OWN VIDEOS (Jordan, Oct 23 2026: Instagram
// cover frames, and an on-screen spelling check on trial). Free tier: Jordan
// said "The free tier I don't care that Google uses it."
//
// NOTHING HERE CAN REACH GOOGLE UNTIL A KEY IS SAVED. Every public function
// that talks to Google takes the key as an argument, and the one reader of the
// key (geminiKey) answers null without any network call when the Connection
// row is missing, not CONNECTED, or does not decrypt. The driver
// (lib/videoAnalysis) asks for the key first and stops there.
//
// THE KEY never reaches a browser, a log line, an error message or a stored
// row: scrubGemini() below cleans anything Google echoes back before it is
// thrown, and the key travels only in the x-goog-api-key header.
//
// THE REQUESTS, as documented on Oct 23-24 2026 (verified on the pages, not
// recalled):
//   Model    gemini-3.8-flash (ai.google.dev/gemini-api/docs/models: "Our most
//            intelligent Flash model", Stable; pricing page: Free Tier input and
//            output "Free of charge", "Used to improve our products: Yes").
//   Files    POST /upload/v1beta/files with X-Goog-Upload-Protocol: resumable,
//            X-Goog-Upload-Command: start, X-Goog-Upload-Header-Content-Length
//            and -Content-Type, body {"file":{"display_name"}}; the upload URL
//            comes back in the x-goog-upload-url header; then POST the bytes to
//            it with X-Goog-Upload-Offset: 0 and X-Goog-Upload-Command:
//            "upload, finalize". The reply carries file.name / file.uri; GET
//            /v1beta/<name> until state is ACTIVE (FAILED = give up). DELETE
//            /v1beta/<name> removes it (files also expire after 48 hours).
//   Ask      POST /v1beta/interactions (the Interactions API, generally
//            available and "recommended for all new projects"; generateContent
//            is legacy and the video guide's REST examples are all
//            interactions) with {"model", "input": [{"type":"video","uri",
//            "mime_type","resolution":"high","processing":{"type":"static",
//            "fps":N}}, {"type":"text","text"}], "response_format":{"type":
//            "text","mime_type":"application/json","schema":{…}}, "store":
//            false}. The answer is the model_output step's text.
//            resolution "high" = 280 tokens a frame on Gemini 3/4 models
//            (media-resolution page), "Required only when the use case
//            involves reading dense text (OCR) or small details", which is
//            exactly the spelling check. Audio is a fixed 25 tokens a second.
//            temperature is NOT sent: Gemini 3.6+ ignores it and will 400 on it.
//   Errors   429 RESOURCE_EXHAUSTED (rate limits are per project; requests per
//            day reset at midnight Pacific). The free tier's own numbers are
//            only shown in AI Studio, so the driver keeps its own daily cap and
//            backs off on every 429, honouring a RetryInfo retryDelay when
//            Google sends one.
// ---------------------------------------------------------------------------

export const GEMINI_CONNECTION = "gemini_video";
export const GEMINI_LABEL = "Gemini (video analysis)";
/** Verified Oct 24 2026 on ai.google.dev/gemini-api/docs/models and /pricing. */
export const GEMINI_VIDEO_MODEL = "gemini-3.8-flash";

const API = "https://generativelanguage.googleapis.com";

export type GeminiErrorKind =
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "unreachable_media"
  | "provider_error"
  | "network"
  | "unreadable"
  | "blocked";

export class GeminiError extends Error {
  constructor(
    message: string,
    public kind: GeminiErrorKind,
    /** true = the same call is worth making again later (429, 5xx, network). */
    public retryable = false,
    public status?: number,
    /** 429 only: how long Google asked us to wait, when it said. */
    public retryAfterMs: number | null = null,
    /** 429 only: the per-day quota is spent (it resets at midnight Pacific). */
    public perDay = false,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** Remove the key and anything key-shaped from text we might store or show. */
export function scrubGemini(text: string, key?: string | null): string {
  let out = String(text ?? "");
  if (key && key.length >= 8) out = out.split(key).join("[key]");
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]")
    .replace(/([?&](?:key|upload_id|X-Goog-[A-Za-z-]+)=)[^&\s"]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 400);
}

/** The saved key, or null. No network, ever. */
export async function geminiKey(): Promise<string | null> {
  const row = await getConnection(GEMINI_CONNECTION).catch(() => null);
  if (!row || row.status !== "CONNECTED" || !row.secretEncrypted) return null;
  return getSecret(GEMINI_CONNECTION).catch(() => null);
}

/** Per the card: is a key stored, and would a run use it? No network. */
export async function geminiKeyStatus(): Promise<{ configured: boolean; stored: boolean; accountLabel: string | null; savedAt: string | null; lastError: string | null }> {
  const row = await getConnection(GEMINI_CONNECTION).catch(() => null);
  return {
    configured: Boolean(await geminiKey()),
    stored: Boolean(row?.secretEncrypted),
    accountLabel: row?.accountLabel ?? null,
    savedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    lastError: row?.status === "ERROR" ? (row.lastError ?? null) : null,
  };
}

/** "37s" / "1.5s" → ms. */
export function parseRetryDelay(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v ?? "").trim());
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

type GoogleErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ "@type"?: string; retryDelay?: string; violations?: Array<{ quotaId?: string; quotaMetric?: string }>; reason?: string }>;
  };
};

/** One Google error answer, in our words, with what the driver needs to back off. */
export function geminiHttpError(status: number, bodyText: string, key: string | null, what = "Gemini"): GeminiError {
  let body: GoogleErrorBody | null = null;
  try { body = JSON.parse(bodyText) as GoogleErrorBody; } catch { body = null; }
  const details = body?.error?.details ?? [];
  const retryAfterMs = parseRetryDelay(details.find((d) => /RetryInfo$/.test(d["@type"] ?? ""))?.retryDelay);
  const perDay = details.some((d) => (d.violations ?? []).some((v) => /PerDay/i.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`)));
  const reason = details.find((d) => d.reason)?.reason ?? "";
  const detail = scrubGemini(body?.error?.message ?? bodyText, key);
  if (status === 429 || body?.error?.status === "RESOURCE_EXHAUSTED") {
    return new GeminiError(
      perDay ? `${what} says today's free requests are used up. It starts again after midnight Pacific.` : `${what} is rate limiting us. The hub waits and tries again.`,
      "rate_limited", true, 429, retryAfterMs, perDay,
    );
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(`${reason} ${bodyText}`)) {
    return new GeminiError(`${what} refused the key${detail ? ` (${detail})` : ""}.`, "unauthorized", false, status);
  }
  if (status === 413) return new GeminiError(`${what} says the video is too large for one upload.`, "too_large", false, status);
  if (status === 408 || status >= 500) return new GeminiError(`${what} ${status}${detail ? `: ${detail}` : ""}`, "provider_error", true, status);
  return new GeminiError(`${what} ${status}${detail ? `: ${detail}` : ""}`, "provider_error", false, status);
}

async function call(url: string, init: RequestInit, ms: number, key: string, what: string): Promise<Response> {
  try {
    return await fetchWithTimeout(url, { ...init, cache: "no-store" }, ms);
  } catch (e) {
    throw new GeminiError(scrubGemini(`Couldn't reach ${what} (${(e as Error).message}).`, key), "network", true);
  }
}

// ---- the key test -------------------------------------------------------------

/**
 * The cheapest authenticated call: read the model's own description
 * (GET /v1beta/models/<model>). It generates nothing and costs nothing. A key
 * that fails here is never saved.
 */
export async function testGeminiKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const k = key.trim();
  if (k.length < 20) return { ok: false, error: "That looks too short to be a Gemini API key. Copy the whole thing from AI Studio." };
  if (/\s/.test(k)) return { ok: false, error: "That has spaces in it. Copy the key again, on its own." };
  try {
    const res = await call(`${API}/v1beta/models/${GEMINI_VIDEO_MODEL}`, { headers: { "x-goog-api-key": k } }, 15_000, k, "Gemini");
    if (!res.ok) throw geminiHttpError(res.status, await res.text().catch(() => ""), k);
    const body = (await res.json().catch(() => null)) as { displayName?: string; name?: string } | null;
    return { ok: true, label: `Key accepted · ${body?.displayName ?? GEMINI_VIDEO_MODEL} available` };
  } catch (e) {
    if (e instanceof GeminiError) return { ok: false, error: e.message };
    return { ok: false, error: scrubGemini(e instanceof Error ? e.message : "Couldn't reach Google.", k) };
  }
}

// ---- files ----------------------------------------------------------------------

export type GeminiFile = { name: string; uri: string; mimeType: string };

/** The mime words the Interactions API's video item accepts (its enum lists video/mov, not video/quicktime). */
export function interactionMime(mime: string | null | undefined, fileName?: string | null): string {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "video/quicktime" || m === "video/mov" || /\.mov$/i.test(fileName ?? "")) return "video/mov";
  if (m === "video/webm") return "video/webm";
  if (m === "video/mpeg") return "video/mpeg";
  return "video/mp4";
}

/** The Content-Type for the upload itself. */
export function uploadMime(mime: string | null | undefined, fileName?: string | null): string {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m.startsWith("video/")) return m === "video/mov" ? "video/quicktime" : m;
  return /\.mov$/i.test(fileName ?? "") ? "video/quicktime" : "video/mp4";
}

/** Files API caps one file at 2 GB (files page, "Usage information"). */
export const GEMINI_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Upload one video by streaming it from `sourceUrl` straight into a resumable
 * Files API session (never held whole in memory), then wait for ACTIVE.
 * `sourceUrl` must carry its own permission (a presigned blob URL or a Dropbox
 * temporary link); it is never logged.
 */
export async function uploadVideoToGemini(
  key: string,
  input: { sourceUrl: string; fileName: string | null; displayName: string; activeWithinMs?: number; waitForActive?: boolean },
): Promise<GeminiFile> {
  let media: Response;
  try {
    media = await fetchWithTimeout(input.sourceUrl, { cache: "no-store" }, 240_000);
  } catch (e) {
    throw new GeminiError(`Couldn't read the video file (${scrubGemini((e as Error).message, key)}).`, "unreachable_media", true);
  }
  if (!media.ok || !media.body) throw new GeminiError(`The video file answered ${media.status}.`, "unreachable_media", media.status >= 500);
  const size = Number(media.headers.get("content-length") || 0);
  if (!size) {
    await media.body.cancel().catch(() => {});
    throw new GeminiError("The video file did not say how big it is, so it can't be sent.", "unreachable_media", false);
  }
  if (size > GEMINI_FILE_MAX_BYTES) {
    await media.body.cancel().catch(() => {});
    throw new GeminiError(`This video is ${(size / 1024 / 1024).toFixed(0)} MB; Gemini takes at most 2 GB a file.`, "too_large", false);
  }
  const contentType = uploadMime(media.headers.get("content-type"), input.fileName);

  const start = await call(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": contentType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: input.displayName.slice(0, 120) } }),
  }, 30_000, key, "Gemini");
  if (!start.ok) {
    await media.body.cancel().catch(() => {});
    throw geminiHttpError(start.status, await start.text().catch(() => ""), key);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    await media.body.cancel().catch(() => {});
    throw new GeminiError("Gemini did not give an upload address.", "provider_error", true);
  }

  const put = await call(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: media.body,
    // A streamed request body (undici needs this to send a ReadableStream).
    ...({ duplex: "half" } as Record<string, unknown>),
  }, 280_000, key, "Gemini");
  if (!put.ok) throw geminiHttpError(put.status, await put.text().catch(() => ""), key);
  const done = (await put.json().catch(() => null)) as { file?: { name?: string; uri?: string; mimeType?: string; state?: string } } | null;
  const f = done?.file;
  if (!f?.name || !f.uri) throw new GeminiError("Gemini did not say where the upload went.", "unreadable", true);
  const file: GeminiFile = { name: f.name, uri: f.uri, mimeType: f.mimeType ?? contentType };
  if (f.state === "ACTIVE" || input.waitForActive === false) return file;
  await waitActive(key, file, input.activeWithinMs ?? 120_000);
  return file;
}

/** Where an uploaded file stands: ACTIVE (ready), PROCESSING, FAILED, or null when it is gone (48-hour expiry, deleted). */
export async function geminiFileState(key: string, file: GeminiFile): Promise<"ACTIVE" | "PROCESSING" | "FAILED" | null> {
  const res = await call(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } }, 15_000, key, "Gemini").catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { state?: string } | null;
  return body?.state === "ACTIVE" || body?.state === "PROCESSING" || body?.state === "FAILED" ? body.state : null;
}

/** Poll GET /v1beta/<name> until ACTIVE. FAILED throws; running out of time throws a retryable error (the file is kept and reused). */
export async function waitActive(key: string, file: GeminiFile, withinMs: number, pollMs = 3_000): Promise<void> {
  const until = Date.now() + withinMs;
  for (;;) {
    const res = await call(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } }, 15_000, key, "Gemini");
    if (!res.ok) throw geminiHttpError(res.status, await res.text().catch(() => ""), key);
    const body = (await res.json().catch(() => null)) as { state?: string; error?: { message?: string } } | null;
    if (body?.state === "ACTIVE") return;
    if (body?.state === "FAILED") throw new GeminiError(`Gemini could not read this video${body.error?.message ? ` (${scrubGemini(body.error.message, key)})` : ""}.`, "unreadable", false);
    if (Date.now() + pollMs > until) throw new GeminiError("Gemini is still reading the video. The hub tries again shortly.", "provider_error", true);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Best effort: remove an uploaded file. Never throws (they expire on their own after 48 hours). */
export async function deleteGeminiFile(key: string, name: string | null | undefined): Promise<boolean> {
  if (!name || !/^files\/[A-Za-z0-9_-]+$/.test(name)) return false;
  const res = await call(`${API}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key } }, 15_000, key, "Gemini").catch(() => null);
  return !!res && (res.ok || res.status === 404);
}

// ---- the question ---------------------------------------------------------------

export type AskVideoInput = {
  file: GeminiFile;
  /** frames a second Gemini samples (owner setting, 1 to 5) */
  fps: number;
  prompt: string;
  /** JSON Schema the answer must follow */
  schema: Record<string, unknown>;
  model?: string;
  /** how long to wait for the answer (the driver passes what its budget has left) */
  timeoutMs?: number;
};

export type AskVideoResult<T> = { data: T; usage: { input: number | null; output: number | null; total: number | null } };

type InteractionBody = {
  status?: string;
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number };
};

/** The model's text out of an Interaction resource (the model_output step's text parts). */
export function interactionText(body: InteractionBody | null): string {
  if (!body) return "";
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  return (body.steps ?? [])
    .filter((s) => !s.type || s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => (!c.type || c.type === "text") && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/** One question about one uploaded video; the answer parsed as JSON. ONE model request. */
export async function askAboutVideo<T>(key: string, input: AskVideoInput): Promise<AskVideoResult<T>> {
  const fps = Math.min(5, Math.max(1, Math.round(input.fps)));
  const res = await call(`${API}/v1beta/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model ?? GEMINI_VIDEO_MODEL,
      input: [
        { type: "video", uri: input.file.uri, mime_type: interactionMime(input.file.mimeType), resolution: "high", processing: { type: "static", fps } },
        { type: "text", text: input.prompt },
      ],
      response_format: { type: "text", mime_type: "application/json", schema: input.schema },
      store: false,
    }),
  }, Math.min(200_000, Math.max(20_000, input.timeoutMs ?? 200_000)), key, "Gemini");
  if (!res.ok) throw geminiHttpError(res.status, await res.text().catch(() => ""), key);
  const body = (await res.json().catch(() => null)) as InteractionBody | null;
  if (body?.status && body.status !== "completed") {
    throw new GeminiError(`Gemini stopped before answering (${body.status}).`, body.status === "failed" ? "provider_error" : "blocked", body.status === "failed");
  }
  const text = interactionText(body).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new GeminiError("Gemini's answer could not be read.", "unreadable", true);
  }
  const u = body?.usage;
  return { data, usage: { input: u?.total_input_tokens ?? null, output: u?.total_output_tokens ?? null, total: u?.total_tokens ?? null } };
}
