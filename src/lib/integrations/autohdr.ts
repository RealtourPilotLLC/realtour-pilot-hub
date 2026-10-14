import "server-only";

import { getConnection, getSecret } from "./connections";

// ---------------------------------------------------------------------------
// AutoHDR External API (Photo Delivery, Oct 13 2026).
//
// Jordan, Oct 13: "Set up the API on AutoHDR for me." The API client (Client
// ID + Client Secret) is created by Jordan in AutoHDR (new.autohdr.com →
// Account settings → Developer) and pasted ONCE on Connections → AutoHDR. The
// secret is stored through the same encrypted plumbing as every other
// provider (saveSecret) and read back only here. It never reaches a browser,
// a log line, an error message or a stored row (scrub() below).
//
// THE RULES THIS FILE ENFORCES (docs/photo-delivery/01 §0.3, §5.1):
//   · Prices and model ids are never hardcoded: capabilities() and models()
//     read the live catalogue.
//   · A POST that can spend credits (download, submitTransform, runPreset,
//     createShoot*) is NEVER retried here, not even on a 5xx or a network
//     error. The caller persists its intent first and, when unsure, looks the
//     state up (listTransforms / listPhotoshoots) instead of resubmitting.
//   · GETs (all free) retry on 429 (honouring Retry-After), 5xx and network
//     errors, and refresh the token once on a 401.
//
// Editing itself stays on AutoHDR's Dropbox watcher (the job folders already
// live under /AutoHDR, so the watcher edits every upload). The API is used
// for what the watcher cannot do: the live credit balance, the photo history,
// descriptions, and QC-driven fixes on the shoots the watcher created. Never
// create a second shoot for photos the watcher already edited: that would
// charge twice.
// ---------------------------------------------------------------------------

export const AUTOHDR_PROVIDER = "autohdr";

const API_BASE = (process.env.AUTOHDR_API_BASE ?? "https://external.realestatephotoediting.com").replace(/\/$/, "");
const TOKEN_URL = process.env.AUTOHDR_TOKEN_URL ?? "https://new.autohdr.com/api/auth/oauth2/token";
const RESOURCE = process.env.AUTOHDR_RESOURCE ?? `${API_BASE}/v1`;
// Two tokens, least privilege (AutoHDR: "a read-only token cannot spend
// credits"; scopes are chosen when the token is requested). Every GET (the
// credit monitor, the shoot linker, QC reads) runs on the read-only token;
// only a POST asks for the full set.
const READ_SCOPES = "photoshoots:read presets:read";
const FULL_SCOPES = process.env.AUTOHDR_SCOPES ?? "photoshoots:read photoshoots:write images:edit presets:read presets:run";

/** Where Jordan creates the API client, and where credits are bought. */
export const AUTOHDR_DEVELOPER_URL = "https://new.autohdr.com/account-settings?accountTab=developer";
export const AUTOHDR_BILLING_URL = process.env.AUTOHDR_BILLING_URL ?? "https://new.autohdr.com/account-settings?accountTab=billing";

export class AutohdrError extends Error {
  constructor(
    message: string,
    /** HTTP status, 0 for network/config problems */
    public status: number,
    /** AutoHDR's `error` code (insufficient_credits, files_not_landed, …) */
    public code: string | null,
    /** true = the same GET is worth repeating later */
    public retryable: boolean,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "AutohdrError";
  }
  get insufficientCredits() {
    return this.status === 402 || this.code === "insufficient_credits";
  }
  get expired() {
    return this.status === 410 || this.code === "photoshoot_expired";
  }
}

/** Strip anything shaped like a credential from text we log, store or show. */
export function scrub(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[secret]");
  return out.replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[token]").replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]").slice(0, 500);
}

// ---- credentials --------------------------------------------------------------

export type AutohdrCredentials = { clientId: string; clientSecret: string; source: "connection" | "env" };

/** The stored API client: the Connections card first, then the deployment env. */
export async function autohdrCredentials(): Promise<AutohdrCredentials | null> {
  const conn = await getConnection(AUTOHDR_PROVIDER).catch(() => null);
  if (conn?.status === "CONNECTED" && conn.secretEncrypted) {
    let clientId: string | null = null;
    try {
      clientId = conn.metadata ? (JSON.parse(conn.metadata) as { clientId?: string }).clientId ?? null : null;
    } catch {
      clientId = null;
    }
    const secret = await getSecret(AUTOHDR_PROVIDER);
    if (clientId && secret) return { clientId, clientSecret: secret, source: "connection" };
  }
  const envId = process.env.AUTOHDR_CLIENT_ID?.trim();
  const envSecret = process.env.AUTOHDR_CLIENT_SECRET?.trim();
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret, source: "env" };
  return null;
}

export async function autohdrConfigured(): Promise<boolean> {
  return (await autohdrCredentials()) !== null;
}

// ---- token --------------------------------------------------------------------

type TokenCache = { clientId: string; token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCache>();

/** Exchange the client credentials for a bearer token (free). The `resource`
 *  field is required: without it every API call answers 401. */
export async function fetchToken(creds: { clientId: string; clientSecret: string }, scope: string = FULL_SCOPES): Promise<{ token: string; expiresIn: number; scope: string | null }> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope,
    resource: RESOURCE,
  });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new AutohdrError(scrub(`Couldn't reach AutoHDR to sign in (${(e as Error).message})`, [creds.clientSecret]), 0, null, true);
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok || typeof json.access_token !== "string") {
    const code = typeof json.error === "string" ? json.error : null;
    const desc = typeof json.error_description === "string" ? json.error_description : text;
    const hint = res.status === 401 || code === "invalid_client" ? "The Client ID or Client Secret was not accepted." : `AutoHDR sign-in failed (${res.status}).`;
    throw new AutohdrError(scrub(`${hint}${desc ? ` ${desc}` : ""}`, [creds.clientSecret, creds.clientId]), res.status, code, res.status >= 500 || res.status === 429);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return { token: json.access_token, expiresIn, scope: typeof json.scope === "string" ? json.scope : null };
}

async function bearer(creds: AutohdrCredentials, scope: string, force = false): Promise<string> {
  const now = Date.now();
  const hit = tokenCache.get(scope);
  if (!force && hit && hit.clientId === creds.clientId && hit.expiresAt - 300_000 > now) return hit.token;
  const t = await fetchToken(creds, scope);
  tokenCache.set(scope, { clientId: creds.clientId, token: t.token, expiresAt: now + t.expiresIn * 1000 });
  return t.token;
}

// ---- transport ------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CallOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** POSTs that spend credits: one attempt, no retry of any kind. */
  spends?: boolean;
  timeoutMs?: number;
  creds?: AutohdrCredentials;
};

export async function autohdrCall<T>(path: string, opts: CallOpts = {}): Promise<{ data: T; requestId: string | null }> {
  const creds = opts.creds ?? (await autohdrCredentials());
  if (!creds) throw new AutohdrError("AutoHDR isn't connected yet. Paste the API Client ID and Secret on Connections → AutoHDR.", 0, "not_configured", false);
  const method = opts.method ?? "GET";
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}${qs ? `?${qs}` : ""}`;
  const isRead = method === "GET";
  // A non-GET is never repeated after it may have reached AutoHDR. The one
  // exception is a 401 on the token itself, answered before any work happens.
  const maxAttempts = isRead ? 4 : 1;
  let refreshed = false;
  let last: AutohdrError | null = null;
  const scope = isRead ? READ_SCOPES : FULL_SCOPES;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await bearer(creds, scope);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      // A POST whose response never arrived may still have been processed.
      // That is exactly the case the caller must resolve by LOOKING, so the
      // error says so and is never retried here.
      last = new AutohdrError(
        scrub(`Couldn't reach AutoHDR (${(e as Error).message})${isRead ? "" : ". The request may or may not have been processed; look it up before trying again."}`, [creds.clientSecret]),
        0,
        isRead ? "network" : "uncertain",
        isRead,
      );
      if (!isRead || attempt >= maxAttempts) throw last;
      await sleep(attempt * 1500);
      continue;
    }
    const requestId = res.headers.get("x-request-id");
    if (res.ok) {
      const text = await res.text();
      if (!text) return { data: {} as T, requestId };
      try {
        return { data: JSON.parse(text) as T, requestId };
      } catch {
        throw new AutohdrError("AutoHDR sent back something we couldn't read.", res.status, "bad_json", false, requestId);
      }
    }
    const text = await res.text().catch(() => "");
    let code: string | null = null;
    let desc = "";
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string; message?: string; detail?: { loc?: unknown[]; msg?: string }[] };
      code = j.error ?? (Array.isArray(j.detail) ? "validation_error" : null);
      desc = j.error_description ?? j.message ?? (Array.isArray(j.detail) ? j.detail.map((d) => `${(d.loc ?? []).join(".")}: ${d.msg ?? ""}`).join("; ") : "");
    } catch {
      desc = text;
    }
    // 401: refresh the token once and repeat. Safe for a POST too: AutoHDR
    // rejected the call at the door, nothing was processed or charged.
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await bearer(creds, scope, true);
      attempt--;
      continue;
    }
    const retryable = isRead && (res.status === 429 || res.status >= 500);
    last = new AutohdrError(scrub(`AutoHDR ${res.status}${code ? ` ${code}` : ""}${desc ? `: ${desc}` : ""}`, [creds.clientSecret]), res.status, code, retryable, requestId);
    if (!retryable || attempt >= maxAttempts) throw last;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : attempt * 2000);
  }
  throw last ?? new AutohdrError("AutoHDR call failed.", 0, null, false);
}

// ---- typed endpoints -------------------------------------------------------------

export type AutohdrMe = { client_id?: string; user_id?: number; email?: string; scopes?: string[]; credit_balance?: number | null };
export type AutohdrCredits = { user_id?: number; credit_balance: number };
export type AutohdrCapability = {
  name: string;
  version?: number;
  credit_cost?: number | null;
  requires_mask?: boolean;
  requires_prompt?: boolean;
  looks?: { name?: string; id?: string; credit_cost?: number | null }[];
  description?: string;
  [k: string]: unknown;
};
export type AutohdrModel = { id: number; name: string; description?: string | null; type: string; variant: "indoor" | "outdoor" | "indoor/outdoor" | string; thumbnail_url?: string | null; style_credit_cost: number };
// Shapes verified against AutoHDR's published OpenAPI spec (v0.1.0, read Oct 13 2026).
export type AutohdrPhotoshoot = { photoshoot_id: number; address?: string | null; status?: string; created_at?: string; updated_at?: string; image_count?: number; [k: string]: unknown };
export type AutohdrPhoto = { image_uuid: string; image_version_uuid: string; name?: string; downloaded?: boolean; [k: string]: unknown };
export type AutohdrHistoryStep = { image_version_uuid: string; parent_image_version_uuid: string | null; is_head?: boolean; label?: string; description?: string; created_at?: string };
/** TransformJobResponse, as published (openapi v0.1.0). */
export type AutohdrTransformJob = {
  job_id: string;
  photoshoot_id: number;
  image_uuid: string;
  /** the INPUT version the transform ran on */
  image_version_uuid: string;
  transform_name: string;
  transform_version: number;
  status: "queued" | "running" | "succeeded" | "failed";
  status_url?: string | null;
  submitted_at: string;
  updated_at: string;
  /** null when succeeded with nothing to change (a no-op, refunded) */
  output_image_version_uuid?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
};

/** Lists come back either bare or wrapped ({ data | items | photoshoots | … }). */
function listOf<T>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    for (const k of [...keys, "data", "items", "results"]) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export const autohdr = {
  async me(creds?: AutohdrCredentials) {
    return (await autohdrCall<AutohdrMe>("/v1/me", { creds })).data;
  },
  async credits(creds?: AutohdrCredentials) {
    return (await autohdrCall<AutohdrCredits>("/v1/credits", { creds })).data;
  },
  async capabilities() {
    return listOf<AutohdrCapability>((await autohdrCall<unknown>("/v1/capabilities")).data, "transforms");
  },
  async models(type: "all" | "predefined" | "custom" = "all") {
    return listOf<AutohdrModel>((await autohdrCall<unknown>("/v1/models", { query: { type } })).data, "models");
  },
  /** Every shoot of the last 7 days (AutoHDR keeps no older ones), all pages. */
  async listPhotoshoots() {
    // `page` is ZERO-based in AutoHDR's spec (page_count pages: 0..page_count-1).
    const out: AutohdrPhotoshoot[] = [];
    for (let page = 0; page < 20; page++) {
      const raw = (await autohdrCall<unknown>("/v1/photoshoots", { query: { page, page_size: 100 } })).data;
      out.push(...listOf<AutohdrPhotoshoot>(raw, "photoshoots"));
      const pageCount = raw && typeof raw === "object" ? Number((raw as Record<string, unknown>).page_count) : NaN;
      if (!Number.isFinite(pageCount) || page + 1 >= pageCount) break;
    }
    return out;
  },
  async photoshootStatus(id: number) {
    return (await autohdrCall<{ status: string; pipeline?: string; image_count?: number; awaiting_files?: boolean }>(`/v1/photoshoots/${id}/status`)).data;
  },
  /** The shoot's photos in gallery order, with `downloaded` (true = already paid for). */
  async listPhotos(id: number) {
    const out: AutohdrPhoto[] = [];
    for (let page = 0; page < 20; page++) {
      const raw = (await autohdrCall<unknown>(`/v1/photoshoots/${id}/photos`, { query: { page, page_size: 100 } })).data;
      out.push(...listOf<AutohdrPhoto>(raw, "photos"));
      const pageCount = raw && typeof raw === "object" ? Number((raw as Record<string, unknown>).page_count) : NaN;
      if (!Number.isFinite(pageCount) || page + 1 >= pageCount) break;
    }
    return out;
  },
  async history(id: number, imageUuid: string) {
    return listOf<AutohdrHistoryStep>((await autohdrCall<unknown>(`/v1/photoshoots/${id}/photos/${imageUuid}/history`)).data, "steps", "history");
  },
  /** Free text description of a photo (or one of its versions). */
  async describe(id: number, imageUuid: string, opts: { image_version_uuid?: string; prompt?: string } = {}) {
    // describe is free and has no side effects, but it is a POST: one attempt.
    const body: Record<string, string> = {};
    if (opts.image_version_uuid) body.image_version_uuid = opts.image_version_uuid;
    if (opts.prompt) body.prompt = opts.prompt;
    const r = await autohdrCall<{ description?: string }>(`/v1/photoshoots/${id}/photos/${imageUuid}/describe`, { method: "POST", body, spends: false });
    return r.data.description ?? "";
  },
  /** CREDITS: the first download of each photo costs 1 credit. Never retried. */
  async download(id: number, images: { image_uuid: string; filename?: string }[]) {
    return (
      await autohdrCall<{ credits_charged?: number; downloads?: { image_uuid: string; filename: string; url: string; byte_size?: number }[] }>(`/v1/photoshoots/${id}/photos/download`, {
        method: "POST",
        body: { images },
        spends: true,
        timeoutMs: 60_000,
      })
    );
  },
  /** Free: make another version the head (revert a bad fix). */
  async setVersion(id: number, imageUuid: string, versionUuid: string) {
    return (await autohdrCall<unknown>(`/v1/photoshoots/${id}/photos/${imageUuid}/version`, { method: "POST", body: { image_version_uuid: versionUuid } })).data;
  },
  /** Free. `kind` MUST be sent: it defaults to "reference", and a reference
   *  used as a mask fails the transform with 400 invalid_mask_url. */
  async createAssetUploads(id: number, kind: "mask" | "reference", files: { filename: string; content_type: "image/png" | "image/jpeg"; md5?: string }[]) {
    return listOf<{ filename: string; url: string; s3_url: string }>((await autohdrCall<unknown>(`/v1/photoshoots/${id}/asset-uploads`, { method: "POST", body: { kind, files } })).data, "uploads");
  },
  /** CREDITS: charged on submit (refunded by AutoHDR when the job fails or is a no-op). Never retried. */
  async submitTransform(input: {
    photoshoot_id: number;
    image_uuid: string;
    image_version_uuid: string;
    transform_name: string;
    transform_version?: number;
    prompt?: string;
    model_id?: number;
    mask_url?: string;
    reference_image_urls?: string[];
    params?: Record<string, unknown>;
  }) {
    return (await autohdrCall<AutohdrTransformJob>("/v1/transforms", { method: "POST", body: input, spends: true, timeoutMs: 60_000 }));
  },
  async getTransform(jobId: string) {
    return (await autohdrCall<AutohdrTransformJob>(`/v1/transforms/${encodeURIComponent(jobId)}`)).data;
  },
  async listTransforms(photoshootId: number, state: "active" | "history" | "all" = "all") {
    // state defaults to "active" at AutoHDR, which hides finished jobs.
    const out: AutohdrTransformJob[] = [];
    for (let page = 0; page < 20; page++) {
      const raw = (await autohdrCall<unknown>("/v1/transforms", { query: { photoshoot_id: photoshootId, state, page, page_size: 100 } })).data;
      out.push(...listOf<AutohdrTransformJob>(raw, "jobs"));
      const pageCount = raw && typeof raw === "object" ? Number((raw as Record<string, unknown>).page_count) : NaN;
      if (!Number.isFinite(pageCount) || page + 1 >= pageCount) break;
    }
    return out;
  },
};

/** The connection test: sign in and read the balance. Spends nothing. */
export async function testAutohdrCredentials(creds: { clientId: string; clientSecret: string }): Promise<{ ok: true; label: string; balance: number | null; email: string | null } | { ok: false; error: string }> {
  try {
    const full: AutohdrCredentials = { ...creds, source: "connection" };
    tokenCache.clear();
    const me = await autohdr.me(full).catch(() => null);
    const credits = await autohdr.credits(full);
    const balance = typeof credits.credit_balance === "number" ? credits.credit_balance : typeof me?.credit_balance === "number" ? me.credit_balance : null;
    const email = me?.email ?? null;
    return { ok: true, balance, email, label: `AutoHDR${email ? ` (${email})` : ""}${balance != null ? `: ${balance.toLocaleString("en-US")} credits` : ""}` };
  } catch (e) {
    const err = e as AutohdrError;
    return { ok: false, error: err.message || "AutoHDR didn't accept those credentials." };
  }
}

/** The client id shown on Connections (never the secret). */
export async function autohdrClientIdHint(): Promise<string | null> {
  const c = await autohdrCredentials().catch(() => null);
  if (!c) return null;
  return c.clientId.length > 10 ? `${c.clientId.slice(0, 6)}…${c.clientId.slice(-4)}` : c.clientId;
}
