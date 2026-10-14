import "server-only";

import { getSecret } from "@/lib/integrations/connections";
import { qcModel, type QcModelSlot } from "../settings";
import { costOf, ZERO_USAGE, type Usage } from "./cost";
import type { PromptDef, RequestShape, Validation } from "./prompts/shared";

// ---------------------------------------------------------------------------
// THE QC CALLER (prompt pack 0.3, 0.7; plan §5.4). One function, runPass, for
// every Claude pass of the QC engine. It owns everything between "here is a
// prompt, its images and its schema" and "here is a validated answer":
//
//   · Request shape (0.3): system blocks with cache_control on the LAST one
//     (the injected rules when present), images first then text, structured
//     output through `output_config.format` (json_schema), temperature 0,
//     max_tokens per pass. Never an assistant prefill.
//   · Model choice: qcModel(slot). A model id the API does not know (404
//     not_found_error) falls back ONCE to claude-sonnet-4-6, or
//     claude-haiku-4-5-20251001 for a Haiku slot; the fallback is reported on
//     the call so the run records it in modelsJson.
//   · What each model accepts is LEARNED, not guessed (Oct 13 2026, the lead:
//     forced tool calls 400 on sonnet-5-5 and opus-5-5; temperature 400s on
//     the 5.x models): a 400 naming `temperature`, `thinking` or `effort` drops
//     that parameter for that model and retries at once; a 400 naming
//     output_config / json_schema (an older model) switches THAT model to the
//     forced-tool method. Each lesson is kept in memory for the life of the
//     process, so it costs one rejected request per model per cold start.
//   · Transient failures (429, 529, 5xx, network) retry with backoff like
//     ai.ts, honouring retry-after. A timeout is not retried in place: the
//     orchestrator tries again on the next tick.
//   · Response handling (0.7): refusal → outcome "refusal" (the caller files
//     an OTHER_DEFECT / HUMAN_REVIEW finding); max_tokens → one retry with
//     double max_tokens; then parse, validate (the pass's own loose → repair →
//     strict chain), and on failure ONE retry with the validation error
//     appended; a second failure is "invalid", handled like a refusal.
//   · Usage and cost per call (cost.ts), reported through onCall the moment a
//     response lands, so spend is recorded even when the pass later fails.
//
// No secret is ever logged: the key lives in the request header only, and
// error messages carry the API's own message, never the request.
// ---------------------------------------------------------------------------

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export const FALLBACK_MODEL = "claude-sonnet-4-6";
export const FALLBACK_HAIKU = "claude-haiku-4-5-20251001";

export type QcImage = { data: Buffer; w: number; h: number; label?: string | null };
export type ModelCaps = { model: string; maxLongEdge: number };
export type Prepared<C> = { images: QcImage[]; text: string; ctx: C };

export type CallRecord = {
  promptId: string;
  promptVersion: number;
  slot: QcModelSlot;
  requestedModel: string;
  /** The model the API says answered (falls back to the id we sent). */
  model: string;
  fallbackFrom: string | null;
  mode: "json_schema" | "tool";
  status: number;
  stopReason: string | null;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  requestId: string | null;
  maxTokens: number;
  attempt: number;
};

export type PassSpec<T, C> = {
  def: PromptDef;
  /** Injected rules (P1, arbiter, P2): the cache breakpoint sits after it. */
  rulesBlock?: string | null;
  /** Overrides def.maxTokens (P2 overview). */
  maxTokens?: number;
  /** Wire schema for the prepared context (rule-id enums are per room type). */
  schema: (ctx: C) => Record<string, unknown>;
  /** Loose parse → deterministic repairs → strict zod (normalize.ts). */
  validate: (raw: unknown, ctx: C) => Validation<T>;
  /** Images, text and validation context for a model's capabilities. Called
   *  again after a model fallback (an older model takes smaller images). */
  prepare: (caps: ModelCaps) => Promise<Prepared<C>>;
  /** Short, secret-free label for logs ("P1 ph_03"). */
  label: string;
  /** Called after every HTTP response (usage, cost, latency). */
  onCall?: (rec: CallRecord) => void | Promise<void>;
};

export type PassOutcome<T, C> =
  | { ok: true; value: T; coerced: string[]; raw: unknown; ctx: C; model: string; fallbackFrom: string | null; mode: "json_schema" | "tool"; callIds: string[] }
  | { ok: false; reason: "refusal" | "invalid" | "truncated"; message: string; raw: unknown; ctx: C | null; model: string; fallbackFrom: string | null; callIds: string[] };

/** A failure that is not the model's answer: no key, a rejected key, the API
 *  unreachable, or a request the API refuses for a reason no retry fixes. */
export class QcCallError extends Error {
  constructor(message: string, public kind: "transient" | "config" | "fatal", public status: number | null = null) {
    super(message);
    this.name = "QcCallError";
  }
}

// ---- transport (swappable in drills) -------------------------------------------------

export type ApiResponse = { status: number; json: unknown; requestId: string | null; retryAfterMs: number | null };
export type Transport = (body: Record<string, unknown>, opts: { timeoutMs: number }) => Promise<ApiResponse>;

let testTransport: Transport | null = null;
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drills only: answer every Messages call from `fn` instead of the network. */
export function __setQcTransportForTests(fn: Transport | null): void {
  testTransport = fn;
}
/** Drills only: make backoff waits instant (or observable). */
export function __setQcSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

let keyCache: { key: string; at: number } | null = null;
async function apiKey(): Promise<string> {
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.key;
  const key = await getSecret("ai");
  if (!key) throw new QcCallError("The Anthropic API key is not connected (Connections, AI).", "config");
  keyCache = { key, at: Date.now() };
  return key;
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const realTransport: Transport = async (body, { timeoutMs }) => {
  const key = await apiKey();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403) keyCache = null; // a rotated key is re-read next call
  return { status: res.status, json, requestId: res.headers.get("request-id"), retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
};

// ---- what each model accepts (learned per process) -------------------------------

const memory = {
  unavailable: new Set<string>(),
  noTemperature: new Set<string>(),
  noThinking: new Set<string>(),
  noEffort: new Set<string>(),
  toolMode: new Set<string>(),
};

/** Drills only. */
export function __resetQcModelMemoryForTests(): void {
  for (const s of Object.values(memory)) s.clear();
}
export function qcModelMemory(): Record<keyof typeof memory, string[]> {
  return Object.fromEntries(Object.entries(memory).map(([k, s]) => [k, [...s]])) as Record<keyof typeof memory, string[]>;
}

export function fallbackModelFor(model: string): string {
  return /haiku/i.test(model) ? FALLBACK_HAIKU : FALLBACK_MODEL;
}

/** The model a slot runs on right now: its configured id, or the fallback when
 *  the API has already told this process that id does not exist. */
export function resolveModel(slot: QcModelSlot): { requested: string; model: string; fallbackFrom: string | null } {
  const requested = qcModel(slot);
  if (memory.unavailable.has(requested)) {
    const fb = fallbackModelFor(requested);
    return { requested, model: fb, fallbackFrom: requested };
  }
  return { requested, model: requested, fallbackFrom: null };
}

/** The high-resolution tier (2576 px long edge) is on the 5.x generation and
 *  Opus 4.7 / 4.8; older models resize anything above 1568 px, which would
 *  silently break box coordinates (0.2), so they are sent smaller images. */
export function modelMaxLongEdge(model: string): number {
  const m = model.toLowerCase();
  if (/claude-(opus|sonnet|haiku|fable|mythos)-5/.test(m)) return 2576;
  if (/claude-opus-4-[78]/.test(m)) return 2576;
  return 1568;
}

/** "off" means: no extended thinking where the model allows it. Opus 5.5
 *  cannot switch it off (its lowest setting is effort "low"); Sonnet 5.5 turns
 *  it off with `between_tools`; Haiku 5.5, Sonnet 5 and Opus 5 accept
 *  `disabled` at effort high or below; the 4.x fallbacks think only on request. */
function thinkingParam(model: string, shape: RequestShape): Record<string, unknown> | null {
  if (memory.noThinking.has(model) || shape.thinking === "adaptive") return null;
  const m = model.toLowerCase();
  if (/claude-sonnet-5-5/.test(m)) return { type: "between_tools" };
  if (/claude-haiku-5/.test(m)) return { type: "disabled" };
  if (/claude-(opus|sonnet)-5(?!-\d)/.test(m)) return { type: "disabled" };
  return null;
}

function effortParam(model: string, shape: RequestShape): string | null {
  if (memory.noEffort.has(model)) return null;
  const m = model.toLowerCase();
  if (/claude-haiku-4/.test(m)) return null; // Haiku 4.5 rejects effort
  if (shape.thinking === "off" && /claude-opus-5-5/.test(m)) return shape.effort ?? "low";
  return shape.effort ?? null;
}

type ApiContentBlock = { type?: string; text?: string; name?: string; input?: unknown };
type ApiMessage = {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: ApiContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { type?: string; message?: string };
  type?: string;
};

function usageOf(msg: ApiMessage): Usage {
  const u = msg.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function errorOf(json: unknown): { type: string; message: string } {
  const e = (json as ApiMessage | null)?.error;
  return { type: String(e?.type ?? ""), message: String(e?.message ?? "") };
}

const TOOL_NAME = "report";

type Optional = "temperature" | "thinking" | "effort" | "format";

function buildBody<C>(
  spec: PassSpec<unknown, C>,
  model: string,
  prepared: Prepared<C>,
  maxTokens: number,
  extraText: string | null,
  drop: ReadonlySet<Optional> = new Set(),
): { body: Record<string, unknown>; mode: "json_schema" | "tool" } {
  const def = spec.def;
  const system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [{ type: "text", text: def.system }];
  if (spec.rulesBlock) system.push({ type: "text", text: spec.rulesBlock });
  if (def.cache) system[system.length - 1].cache_control = { type: "ephemeral" };

  // 0.2: more than 20 images in one request means every image must be at most
  // 2000 px per side. The callers comply by construction; assert it anyway.
  if (prepared.images.length > 20 && prepared.images.some((i) => i.w > 2000 || i.h > 2000)) {
    throw new QcCallError(`${spec.label}: more than 20 images and one is above 2000 px`, "fatal");
  }
  const content: Array<Record<string, unknown>> = [];
  for (const img of prepared.images) {
    if (prepared.images.length > 1 && img.label) content.push({ type: "text", text: img.label });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data.toString("base64") } });
  }
  content.push({ type: "text", text: prepared.text });
  if (extraText) content.push({ type: "text", text: extraText });

  const schema = spec.schema(prepared.ctx);
  const toolMode = memory.toolMode.has(model) || drop.has("format");
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  };
  if (!memory.noTemperature.has(model) && !drop.has("temperature")) body.temperature = def.temperature;
  const thinking = drop.has("thinking") ? null : thinkingParam(model, def.shape);
  if (thinking) body.thinking = thinking;
  const effort = drop.has("effort") ? null : effortParam(model, def.shape);
  const outputConfig: Record<string, unknown> = {};
  if (!toolMode) outputConfig.format = { type: "json_schema", schema };
  if (effort) outputConfig.effort = effort;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (toolMode) {
    body.tools = [{ name: TOOL_NAME, description: "Return the result.", input_schema: schema }];
    body.tool_choice = { type: "tool", name: TOOL_NAME };
  }
  return { body, mode: toolMode ? "tool" : "json_schema" };
}

/** The structured answer: the JSON in the first text block (json_schema mode)
 *  or the forced tool call's input (tool mode). undefined = none usable. */
function extractAnswer(msg: ApiMessage, mode: "json_schema" | "tool"): unknown {
  const blocks = msg.content ?? [];
  if (mode === "tool") return blocks.find((b) => b.type === "tool_use" && b.name === TOOL_NAME)?.input;
  const text = blocks.find((b) => b.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text.trim());
  } catch {
    // A stray code fence around otherwise valid JSON: accept the object inside.
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}

async function sendWithRetry(body: Record<string, unknown>, timeoutMs: number, label: string): Promise<{ res: ApiResponse; latencyMs: number; attempt: number }> {
  const transport = testTransport ?? realTransport;
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t0 = Date.now();
    let res: ApiResponse;
    try {
      res = await transport(body, { timeoutMs });
    } catch (e) {
      if (e instanceof QcCallError) throw e;
      const name = (e as Error)?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") throw new QcCallError(`${label}: Anthropic did not answer within ${Math.round(timeoutMs / 1000)}s`, "transient");
      last = (e as Error)?.message ?? "network error";
      if (attempt < 4) await sleepImpl(attempt * 1500);
      continue;
    }
    if (res.status === 429 || res.status === 529 || (res.status >= 500 && res.status < 600)) {
      last = `HTTP ${res.status} ${errorOf(res.json).message}`.trim();
      if (attempt < 4) await sleepImpl(Math.min(20_000, res.retryAfterMs ?? attempt * 1500));
      continue;
    }
    return { res, latencyMs: Date.now() - t0, attempt };
  }
  throw new QcCallError(`${label}: Anthropic unavailable after retries (${last.slice(0, 200)})`, "transient");
}

/**
 * Run one pass. Resolves with the model's answer (validated) or a model-level
 * failure (refusal / invalid / truncated); throws QcCallError when the API
 * itself could not be used.
 */
export async function runPass<T, C>(spec: PassSpec<T, C>): Promise<PassOutcome<T, C>> {
  const def = spec.def;
  const resolved = resolveModel(def.slot);
  let model = resolved.model;
  let fallbackFrom = resolved.fallbackFrom;
  const requestedModel = resolved.requested;
  let prepared = await spec.prepare({ model, maxLongEdge: modelMaxLongEdge(model) });
  let maxTokens = spec.maxTokens ?? def.maxTokens;
  let doubled = false;
  let validationRetried = false;
  let extraText: string | null = null;
  let lastRaw: unknown = null;
  // An unrecognised 400 is diagnosed by dropping one optional parameter at a
  // time (cheap: a rejected request bills nothing); only the drop that makes
  // the request succeed is remembered for the model.
  const drop = new Set<Optional>();
  let guessing: Optional | null = null;
  let first400: string | null = null;
  const callIds: string[] = [];

  for (let guard = 0; guard < 12; guard++) {
    const { body, mode } = buildBody(spec as PassSpec<unknown, C>, model, prepared, maxTokens, extraText, drop);
    const { res, latencyMs, attempt } = await sendWithRetry(body, def.timeoutMs, spec.label);
    const msg = (res.json ?? {}) as ApiMessage;
    const ok = res.status >= 200 && res.status < 300;
    const usage = ok ? usageOf(msg) : ZERO_USAGE;
    const answeredBy = ok && msg.model ? msg.model : model;
    const rec: CallRecord = {
      promptId: def.id,
      promptVersion: def.version,
      slot: def.slot,
      requestedModel,
      model: answeredBy,
      fallbackFrom,
      mode,
      status: res.status,
      stopReason: ok ? (msg.stop_reason ?? null) : null,
      usage,
      costUsd: ok ? costOf(answeredBy, usage) : 0,
      latencyMs,
      requestId: res.requestId ?? msg.id ?? null,
      maxTokens,
      attempt,
    };
    if (ok && msg.id) callIds.push(msg.id);
    await spec.onCall?.(rec);

    if (!ok) {
      const err = errorOf(res.json);
      const text = `${err.type} ${err.message}`.toLowerCase();
      if (res.status === 404 && /not_found/.test(err.type) && !fallbackFrom && /model/.test(text)) {
        memory.unavailable.add(model);
        fallbackFrom = model;
        model = fallbackModelFor(model);
        prepared = await spec.prepare({ model, maxLongEdge: modelMaxLongEdge(model) });
        continue;
      }
      if (res.status === 400) {
        first400 ??= err.message;
        // Most specific first: "output_config.effort" names output_config too.
        if (/effort/.test(text) && (body.output_config as Record<string, unknown> | undefined)?.effort && !memory.noEffort.has(model)) {
          memory.noEffort.add(model);
          continue;
        }
        if (/temperature/.test(text) && body.temperature !== undefined) {
          memory.noTemperature.add(model);
          continue;
        }
        if (/thinking/.test(text) && body.thinking && !memory.noThinking.has(model)) {
          memory.noThinking.add(model);
          continue;
        }
        if (/output_config|json_schema|output format|structured output/.test(text) && mode === "json_schema") {
          memory.toolMode.add(model);
          continue;
        }
        const candidates: [Optional, boolean][] = [
          ["temperature", body.temperature !== undefined],
          ["thinking", !!body.thinking],
          ["effort", !!(body.output_config as Record<string, unknown> | undefined)?.effort],
          ["format", mode === "json_schema"],
        ];
        const next = candidates.find(([k, present]) => present && !drop.has(k))?.[0];
        if (next) {
          drop.add(next);
          guessing = next;
          continue;
        }
      }
      const kind = res.status === 401 || res.status === 403 ? "config" : "fatal";
      // Report the FIRST rejection: later ones may only describe a diagnosis step.
      throw new QcCallError(`${spec.label}: Anthropic ${res.status} ${(first400 ?? err.message).slice(0, 300)}`.trim(), kind, res.status);
    }

    if (guessing) {
      // The diagnosis got past the rejection: remember what it dropped for
      // this model (temperature is tried first, the usual culprit on 5.x).
      const sets = { temperature: memory.noTemperature, thinking: memory.noThinking, effort: memory.noEffort, format: memory.toolMode } as const;
      for (const k of drop) sets[k].add(model);
      guessing = null;
    }
    if (msg.stop_reason === "refusal") {
      return { ok: false, reason: "refusal", message: "The model declined to inspect this input.", raw: msg.content ?? null, ctx: prepared.ctx, model: answeredBy, fallbackFrom, callIds };
    }
    if (msg.stop_reason === "max_tokens") {
      if (!doubled) {
        doubled = true;
        maxTokens = Math.min(maxTokens * 2, 32_000);
        continue;
      }
      return { ok: false, reason: "truncated", message: "The answer was cut off twice at the token limit.", raw: msg.content ?? null, ctx: prepared.ctx, model: answeredBy, fallbackFrom, callIds };
    }

    const raw = extractAnswer(msg, mode);
    lastRaw = raw ?? msg.content ?? null;
    if (raw === undefined) {
      if (!validationRetried) {
        validationRetried = true;
        extraText = "Your previous answer was not valid JSON for the required schema. Answer again with only the JSON object.";
        continue;
      }
      return { ok: false, reason: "invalid", message: "No parseable answer after one retry.", raw: lastRaw, ctx: prepared.ctx, model: answeredBy, fallbackFrom, callIds };
    }
    const v = spec.validate(raw, prepared.ctx);
    if (v.ok) return { ok: true, value: v.value, coerced: v.coerced, raw, ctx: prepared.ctx, model: answeredBy, fallbackFrom, mode, callIds };
    if (!validationRetried) {
      validationRetried = true;
      extraText = `Your previous answer did not pass validation: ${v.error}. Answer again, following the schema and every rule above exactly.`;
      continue;
    }
    return { ok: false, reason: "invalid", message: v.error, raw, ctx: prepared.ctx, model: answeredBy, fallbackFrom, callIds };
  }
  throw new QcCallError(`${spec.label}: too many request adjustments`, "fatal");
}
