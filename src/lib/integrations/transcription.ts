import "server-only";

import { getConnection, getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Speech-to-text providers for the cut transcripts of spec §9 (Sep 16 2026).
//
// The hub's AI is Anthropic only: there is NO speech-to-text provider in env,
// in a Connection row, or anywhere else tonight (verified Sep 16). So this file
// is the real adapter for two documented APIs — OpenAI Whisper and Deepgram —
// written so that NOTHING here can make a network call until an owner pastes a
// key on /connections. Every public function checks for the key first and
// returns / throws "not_configured" without touching fetch. The cut_transcripts
// automation switch (programAutomation.ts) is a SEPARATE gate on top: a saved
// key only makes configured() true; the driver in lib/cutTranscripts.ts still
// does nothing until Jordan turns the switch on.
//
// Keys are stored through saveSecret (encrypted at rest) under their own
// Connection rows, one per provider, and read back ONLY here:
//   OpenAI Whisper → Connection "transcription_openai"
//   Deepgram       → Connection "transcription_deepgram"
// They never reach a browser, a log line, an error message or a stored row —
// scrub() below is the belt to that braces for anything a provider echoes back.
//
// Why two providers: they take the audio differently, and the cut lives in the
// hub's Vercel Blob store as a public URL.
//   · Deepgram is handed the URL and fetches the file itself (pre-recorded
//     "listen" endpoint, JSON body {url}). No size ceiling that a client cut
//     would hit. This is the better fit for the hub, so it is preferred when
//     both keys exist.
//   · OpenAI Whisper needs the BYTES in a multipart upload and caps a request
//     at 25 MB. A finished 20–30 s reel at 1080p is usually under that; a 4K
//     source is often not. Over the cap the provider refuses BEFORE any upload
//     with a plain-language, non-retryable error, so a driver does not burn its
//     attempts on a file that can never fit.
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_PROVIDER_IDS = ["deepgram", "openai_whisper"] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDER_IDS)[number];

export const isTranscriptionProviderId = (v: unknown): v is TranscriptionProviderId =>
  typeof v === "string" && (TRANSCRIPTION_PROVIDER_IDS as readonly string[]).includes(v);

/** The Connection row each provider's key lives in (saveSecret / getSecret). */
export const TRANSCRIPTION_CONNECTION_KEY: Record<TranscriptionProviderId, string> = {
  openai_whisper: "transcription_openai",
  deepgram: "transcription_deepgram",
};

export const TRANSCRIPTION_LABEL: Record<TranscriptionProviderId, string> = {
  openai_whisper: "OpenAI Whisper",
  deepgram: "Deepgram",
};

export type TranscriptSegment = { start: number; end: number; text: string };

export type TranscribeInput = {
  /** A URL the provider can fetch (Deepgram) or we can fetch to upload (Whisper). */
  url: string;
  /** The cut (ReviewSubmission id) — for the provider's own bookkeeping tag only. */
  submissionId: string;
};

export type TranscribeResult = {
  text: string;
  segments?: TranscriptSegment[];
  language?: string;
  durationSec?: number;
};

export interface TranscriptionProvider {
  id: TranscriptionProviderId;
  label: string;
  /** A key exists and decrypts. No network. */
  configured(): Promise<boolean>;
  /** Transcribe one cut. Throws TranscriptionError("not_configured") without any network call when no key exists. */
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export type TranscriptionErrorKind =
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "unreachable_media"
  | "provider_error"
  | "network"
  | "unreadable";

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public kind: TranscriptionErrorKind,
    /** true = the same call is worth making again later (429, 5xx, network). */
    public retryable = false,
    public status?: number,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/** Remove anything that looks like a key from text we might log, store or show. */
export function scrubTranscriptionText(text: string, key?: string | null): string {
  let out = text;
  if (key && key.length >= 8) out = out.split(key).join("[key]");
  return out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]").slice(0, 400);
}

// Connected = a CONNECTED row whose secret still decrypts — the same test the
// connections page makes for every other provider (a stored-but-unreadable key
// is not a connection, and must not make configured() true).
async function keyFor(id: TranscriptionProviderId): Promise<string | null> {
  const row = await getConnection(TRANSCRIPTION_CONNECTION_KEY[id]).catch(() => null);
  if (!row || row.status !== "CONNECTED" || !row.secretEncrypted) return null;
  return getSecret(TRANSCRIPTION_CONNECTION_KEY[id]);
}

const OPENAI_API = "https://api.openai.com/v1";
const DEEPGRAM_API = "https://api.deepgram.com/v1";
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // documented request cap for audio/transcriptions

function httpError(provider: string, status: number, bodyText: string, key: string | null): TranscriptionError {
  const detail = scrubTranscriptionText(bodyText, key);
  if (status === 401 || status === 403) return new TranscriptionError(`${provider} rejected the key.`, "unauthorized", false, status);
  if (status === 429) return new TranscriptionError(`${provider} is rate limiting us — try again in a minute.`, "rate_limited", true, status);
  if (status === 413) return new TranscriptionError(`${provider} says the file is too large for one request.`, "too_large", false, status);
  if (status >= 500) return new TranscriptionError(`${provider} ${status}${detail ? ` — ${detail}` : ""}`, "provider_error", true, status);
  return new TranscriptionError(`${provider} ${status}${detail ? ` — ${detail}` : ""}`, "provider_error", false, status);
}

// ---- OpenAI Whisper ---------------------------------------------------------
// POST /v1/audio/transcriptions (multipart): file, model=whisper-1,
// response_format=verbose_json (gives language, duration, segments).

type WhisperVerbose = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
};

async function whisperTranscribe(key: string, input: TranscribeInput): Promise<TranscribeResult> {
  // Fetch the cut ourselves — Whisper wants bytes, not a URL. A HEAD first so a
  // file over the 25 MB cap is refused before any download or upload happens.
  let head: Response;
  try {
    head = await fetch(input.url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new TranscriptionError(`Couldn't reach the cut's file (${(e as Error).message}).`, "unreachable_media", true);
  }
  if (!head.ok) throw new TranscriptionError(`The cut's file answered ${head.status}.`, "unreachable_media", head.status >= 500);
  const declared = Number(head.headers.get("content-length") || 0);
  if (declared > WHISPER_MAX_BYTES) {
    throw new TranscriptionError(
      `This cut is ${(declared / 1024 / 1024).toFixed(0)} MB; Whisper takes at most 25 MB per request. Use Deepgram for this one, or transcribe a smaller export.`,
      "too_large",
      false,
    );
  }
  let media: Response;
  try {
    media = await fetch(input.url, { cache: "no-store", signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new TranscriptionError(`Couldn't download the cut's file (${(e as Error).message}).`, "unreachable_media", true);
  }
  if (!media.ok) throw new TranscriptionError(`The cut's file answered ${media.status}.`, "unreachable_media", media.status >= 500);
  const bytes = await media.arrayBuffer();
  if (bytes.byteLength > WHISPER_MAX_BYTES) {
    throw new TranscriptionError("This cut is over Whisper's 25 MB per-request cap.", "too_large", false);
  }
  const contentType = media.headers.get("content-type") || "video/mp4";
  const ext = contentType.includes("quicktime") ? "mov" : contentType.includes("mpeg") && !contentType.includes("video") ? "mp3" : "mp4";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), `cut-${input.submissionId}.${ext}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  let res: Response;
  try {
    res = await fetch(`${OPENAI_API}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new TranscriptionError(scrubTranscriptionText(`Couldn't reach OpenAI (${(e as Error).message}).`, key), "network", true);
  }
  if (!res.ok) throw httpError("OpenAI", res.status, await res.text().catch(() => ""), key);
  let parsed: WhisperVerbose;
  try {
    parsed = (await res.json()) as WhisperVerbose;
  } catch {
    throw new TranscriptionError("OpenAI sent back something we couldn't read.", "unreadable", false);
  }
  return {
    text: (parsed.text ?? "").trim(),
    language: parsed.language,
    durationSec: typeof parsed.duration === "number" ? parsed.duration : undefined,
    segments: Array.isArray(parsed.segments)
      ? parsed.segments.map((s) => ({ start: s.start, end: s.end, text: (s.text ?? "").trim() }))
      : undefined,
  };
}

// ---- Deepgram ---------------------------------------------------------------
// POST /v1/listen?model=nova-2&smart_format=true&utterances=true&detect_language=true
// with JSON body {url}: Deepgram fetches the file itself. Auth: "Token <key>".

type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string }>;
    }>;
    utterances?: Array<{ start: number; end: number; transcript: string }>;
  };
};

async function deepgramTranscribe(key: string, input: TranscribeInput): Promise<TranscribeResult> {
  const qs = new URLSearchParams({
    model: "nova-2",
    smart_format: "true",
    utterances: "true",
    detect_language: "true",
    tag: `rtp-cut-${input.submissionId}`, // shows up in Deepgram's usage log, never anything client-identifying
  });
  let res: Response;
  try {
    res = await fetch(`${DEEPGRAM_API}/listen?${qs}`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: input.url }),
      cache: "no-store",
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new TranscriptionError(scrubTranscriptionText(`Couldn't reach Deepgram (${(e as Error).message}).`, key), "network", true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Deepgram answers 400 with REMOTE_CONTENT_ERROR when it cannot fetch the URL.
    if (res.status === 400 && /REMOTE_CONTENT|fetch|url/i.test(body)) {
      throw new TranscriptionError("Deepgram couldn't fetch the cut's file from its URL.", "unreachable_media", true, 400);
    }
    throw httpError("Deepgram", res.status, body, key);
  }
  let parsed: DeepgramResponse;
  try {
    parsed = (await res.json()) as DeepgramResponse;
  } catch {
    throw new TranscriptionError("Deepgram sent back something we couldn't read.", "unreadable", false);
  }
  const channel = parsed.results?.channels?.[0];
  return {
    text: (channel?.alternatives?.[0]?.transcript ?? "").trim(),
    language: channel?.detected_language,
    durationSec: typeof parsed.metadata?.duration === "number" ? parsed.metadata.duration : undefined,
    segments: Array.isArray(parsed.results?.utterances)
      ? parsed.results.utterances.map((u) => ({ start: u.start, end: u.end, text: (u.transcript ?? "").trim() }))
      : undefined,
  };
}

// ---- the providers ----------------------------------------------------------

function makeProvider(id: TranscriptionProviderId, run: (key: string, input: TranscribeInput) => Promise<TranscribeResult>): TranscriptionProvider {
  return {
    id,
    label: TRANSCRIPTION_LABEL[id],
    configured: async () => Boolean(await keyFor(id)),
    transcribe: async (input) => {
      // THE GATE. No key → no fetch, ever. The driver checks configured() too,
      // but a method that can be called directly must refuse on its own.
      const key = await keyFor(id);
      if (!key) {
        throw new TranscriptionError(
          `${TRANSCRIPTION_LABEL[id]} isn't connected — paste its API key on the Connections page.`,
          "not_configured",
          false,
        );
      }
      return run(key, input);
    },
  };
}

export const TRANSCRIPTION_PROVIDERS: Record<TranscriptionProviderId, TranscriptionProvider> = {
  deepgram: makeProvider("deepgram", deepgramTranscribe),
  openai_whisper: makeProvider("openai_whisper", whisperTranscribe),
};

/**
 * The provider a driver should use right now, or null when no key exists.
 * Deepgram first when both are saved (URL-based, no 25 MB cap — see the header).
 */
export async function activeTranscriptionProvider(): Promise<TranscriptionProvider | null> {
  for (const id of TRANSCRIPTION_PROVIDER_IDS) {
    const p = TRANSCRIPTION_PROVIDERS[id];
    if (await p.configured()) return p;
  }
  return null;
}

/**
 * Per-provider state for the Connections card. `stored` and `configured`
 * differ on purpose: a key whose re-Test failed is marked ERROR (so
 * configured() is false and no driver will use it) but its encrypted value is
 * still in the row — the card must say "saved, failing" and offer Test/Remove,
 * not pretend there is no key.
 */
export async function transcriptionStatus(): Promise<Array<{ id: TranscriptionProviderId; label: string; configured: boolean; stored: boolean; accountLabel: string | null; savedAt: string | null; lastError: string | null }>> {
  const out = [];
  for (const id of TRANSCRIPTION_PROVIDER_IDS) {
    const row = await getConnection(TRANSCRIPTION_CONNECTION_KEY[id]).catch(() => null);
    out.push({
      id,
      label: TRANSCRIPTION_LABEL[id],
      configured: await TRANSCRIPTION_PROVIDERS[id].configured(),
      stored: Boolean(row?.secretEncrypted),
      accountLabel: row?.accountLabel ?? null,
      savedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      lastError: row?.status === "ERROR" ? (row.lastError ?? null) : null,
    });
  }
  return out;
}

/**
 * Test a candidate key against the CHEAPEST authenticated endpoint each
 * provider offers — a list call that bills nothing and transcribes nothing:
 *   OpenAI   GET /v1/models      (401 on a bad key)
 *   Deepgram GET /v1/projects    (401 on a bad key; lists the key's projects)
 * Used by the Connections card before a key is stored: a key that fails here is
 * never saved.
 */
export async function testTranscriptionKey(
  provider: TranscriptionProviderId,
  key: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const k = key.trim();
  if (k.length < 12) return { ok: false, error: "That looks too short to be an API key — copy the whole thing." };
  if (provider === "openai_whisper" && !k.startsWith("sk-")) {
    return { ok: false, error: "An OpenAI API key starts with sk- — check what was pasted." };
  }
  try {
    let res: Response;
    if (provider === "openai_whisper") {
      res = await fetch(`${OPENAI_API}/models`, {
        headers: { Authorization: `Bearer ${k}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw httpError("OpenAI", res.status, await res.text().catch(() => ""), k);
      const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
      const hasWhisper = Array.isArray(body?.data) && body.data.some((m) => m.id === "whisper-1");
      return {
        ok: true,
        label: hasWhisper ? "OpenAI key accepted · whisper-1 available" : "OpenAI key accepted · whisper-1 not listed for this key",
      };
    }
    res = await fetch(`${DEEPGRAM_API}/projects`, {
      headers: { Authorization: `Token ${k}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw httpError("Deepgram", res.status, await res.text().catch(() => ""), k);
    const body = (await res.json().catch(() => null)) as { projects?: Array<{ name?: string }> } | null;
    const name = body?.projects?.[0]?.name;
    return { ok: true, label: name ? `Deepgram key accepted · project “${name}”` : "Deepgram key accepted" };
  } catch (e) {
    if (e instanceof TranscriptionError) return { ok: false, error: e.message };
    return { ok: false, error: scrubTranscriptionText(e instanceof Error ? e.message : "Couldn't reach the provider.", k) };
  }
}
