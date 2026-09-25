import "server-only";

import { getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Dropbox integration (OAuth 2 with offline/refresh tokens).
// We store the long-lived REFRESH TOKEN encrypted; access tokens are minted on
// demand (they expire ~4h). App key/secret come from env (app-level config).
// ---------------------------------------------------------------------------

const APP_KEY = process.env.DROPBOX_APP_KEY ?? "";
const APP_SECRET = process.env.DROPBOX_APP_SECRET ?? "";

export class DropboxError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "DropboxError";
  }
}

export function dropboxConfigured() {
  return Boolean(APP_KEY && APP_SECRET);
}

// The user visits this, approves, and copies the shown code back to us.
export function dropboxAuthorizeUrl() {
  const u = new URL("https://www.dropbox.com/oauth2/authorize");
  u.searchParams.set("client_id", APP_KEY);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("token_access_type", "offline"); // get a refresh token
  return u.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: APP_KEY, client_secret: APP_SECRET }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new DropboxError(
      (json.error_description as string) || (json.error as string) || `Dropbox token ${res.status}`,
      res.status,
    );
  }
  return json;
}

// Exchange the one-time authorization code for a refresh token.
export async function exchangeDropboxCode(code: string): Promise<{ refreshToken: string }> {
  const json = await tokenRequest({ code: code.trim(), grant_type: "authorization_code" });
  const refreshToken = json.refresh_token as string | undefined;
  if (!refreshToken) throw new DropboxError("Dropbox did not return a refresh token. Re-authorize and try again.");
  return { refreshToken };
}

async function accessTokenFrom(refreshToken: string): Promise<string> {
  const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return json.access_token as string;
}

// Load a valid access token using the stored refresh token.
// Access tokens live ~4h; minting one per API call meant every page that
// touches several files paid a full OAuth grant (Neon secret read + POST
// /oauth2/token) PER CALL — ~40 parallel grants on an asset-heavy render
// (adversarial review). Cache per lambda for 10 minutes.
let tokenCache: { token: string; at: number } | null = null;
let tokenInflight: Promise<string> | null = null;
const TOKEN_TTL = 10 * 60_000;

export async function dropboxAccessToken(): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL) return tokenCache.token;
  // Single-flight: a burst of parallel calls shares ONE grant.
  if (!tokenInflight) {
    tokenInflight = mintAccessToken()
      .then((token) => {
        tokenCache = { token, at: Date.now() };
        return token;
      })
      .finally(() => {
        tokenInflight = null;
      });
  }
  return tokenInflight;
}

async function mintAccessToken(): Promise<string> {
  const refreshToken = await getSecret("dropbox");
  if (!refreshToken) throw new DropboxError("Dropbox is not connected.", 401);
  return accessTokenFrom(refreshToken);
}

// The team's root namespace — file paths like /AutoHDR resolve against the
// team space (where the Zap creates folders) rather than the user's personal
// home. Cached after the first lookup.
let cachedRootNs: string | null | undefined;
async function pathRootHeader(token: string): Promise<Record<string, string>> {
  if (cachedRootNs === undefined) {
    try {
      const acct = await dbx<{ root_info?: { root_namespace_id?: string } }>(
        "users/get_current_account",
        undefined,
        token,
        true, // skip path-root for the account call itself
      );
      cachedRootNs = acct.root_info?.root_namespace_id ?? null;
    } catch {
      cachedRootNs = null;
    }
  }
  return cachedRootNs ? { "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "root", root: cachedRootNs }) } : {};
}

// RPC-style API call (api.dropboxapi.com/2/...).
export async function dbx<T = unknown>(
  endpoint: string,
  arg?: unknown,
  accessToken?: string,
  skipPathRoot = false,
): Promise<T> {
  const token = accessToken ?? (await dropboxAccessToken());
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(skipPathRoot ? {} : await pathRootHeader(token)),
    ...(arg !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const body = arg !== undefined ? JSON.stringify(arg) : undefined;
  // The rate limit is per app+account and EVERY caller shares this one token:
  // the hourly status sweep alone fired 20 recursive list_folder calls at once
  // (5 projects × 4 folders) and, measured live, 13 of 44 came back 429 while
  // the same 44 reads succeed 44/44 one at a time. So the fix is a ceiling
  // here, at the one choke point, plus a polite retry: honour Retry-After
  // (header, or error.retry_after in the body — Dropbox's 429 body carries an
  // EMPTY error_summary), jittered so a burst doesn't re-fire in lockstep.
  // A 429 read as "couldn't look" cost a job with 126 clips its raws-in
  // evidence, its SHOT transition and its editor handoff (audit HIGH).
  let res: Response | undefined;
  await acquire();
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Timed: a slot is held for the whole call, so a socket that accepts
        // and never answers must not pin the ceiling for minutes (review).
        res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: "POST", headers, body, cache: "no-store", signal: AbortSignal.timeout(25_000) });
      } catch (e) {
        if (attempt === 3 || !READ_ENDPOINT.test(endpoint)) throw e;
        await sleep(attempt * 1000 + Math.random() * 500); // network blip — one polite retry
        continue;
      }
      // 429 = not processed, safe to retry anywhere. 5xx/network can arrive
      // AFTER Dropbox applied a write (a move that "failed" then conflicts on
      // retry) — so those are retried only on idempotent READ endpoints.
      const retryable = res.status === 429 || (res.status >= 500 && READ_ENDPOINT.test(endpoint));
      if (!retryable || attempt === 3) break;
      let waitS = Number(res.headers.get("Retry-After"));
      if (!Number.isFinite(waitS) || waitS <= 0) {
        try {
          const j = JSON.parse(await res.clone().text()) as { error?: { retry_after?: number } };
          waitS = Number(j?.error?.retry_after);
        } catch { /* no body hint */ }
      }
      if (!Number.isFinite(waitS) || waitS <= 0) waitS = attempt; // 1s, then 2s
      await sleep(Math.min(waitS, 8) * 1000 + Math.random() * 500);
    }
  } finally {
    release();
  }
  if (!res) throw new DropboxError(`Dropbox ${endpoint} — no response`, 0);
  const text = await res.text();
  // Guard the parse — a non-JSON edge/maintenance page (HTML 502, etc.) must
  // surface as a clean DropboxError, not an uncaught SyntaxError that escapes the
  // typed error handling callers rely on.
  let json: { error_summary?: string } | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    // Dropbox's 429 body has an empty error_summary — fall back to the reason
    // tag so a final failure reads "too_many_requests", not a bare status.
    const tag = (json as { error?: { reason?: { ".tag"?: string }; ".tag"?: string } } | undefined)?.error;
    const reason = tag?.reason?.[".tag"] ?? tag?.[".tag"];
    throw new DropboxError((json?.error_summary as string) || reason || `Dropbox ${endpoint} ${res.status}`, res.status);
  }
  return json as T;
}

const READ_ENDPOINT = /^(files\/list_folder(\/continue)?|files\/get_metadata|files\/get_temporary_link|users\/get_current_account|sharing\/list_shared_links)$/;

// ---- Concurrency ceiling ----------------------------------------------------
// At most MAX_IN_FLIGHT Dropbox calls at once per process (a Vercel lambda
// instance — the sweep, the folder engine and /upload's counts on the same
// instance share it; a render on another instance does not, and the retry
// above absorbs those rarer cross-instance collisions). It removes the
// demonstrated cause — the sweep's own 20-wide burst. Plain FIFO; a waiter is
// released as soon as a slot frees. The slot is held during a 429 backoff on
// purpose: that IS the throttle.
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiters: (() => void)[] = [];
function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(() => { inFlight++; resolve(); }));
}
function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DropboxAccount = { name?: { display_name?: string }; email?: string };

export async function dropboxCurrentAccount(accessToken?: string): Promise<DropboxAccount> {
  return dbx<DropboxAccount>("users/get_current_account", undefined, accessToken);
}

export async function testDropboxRefreshToken(
  refreshToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const token = await accessTokenFrom(refreshToken);
    const acct = await dropboxCurrentAccount(token);
    return { ok: true, label: `Dropbox · ${acct.name?.display_name || acct.email || "account"}` };
  } catch (e) {
    return { ok: false, error: e instanceof DropboxError ? e.message : String(e) };
  }
}

// ---- File operations (used by the upload portal) ---------------------------
export async function dropboxCreateFolder(path: string): Promise<void> {
  try {
    await dbx("files/create_folder_v2", { path, autorename: false });
  } catch (e) {
    // Ignore "already exists" conflicts.
    if (e instanceof DropboxError && /conflict|already/i.test(e.message)) return;
    throw e;
  }
}

/** Create a folder and say what Dropbox made: its permanent id (which survives
 *  a rename by hand) and the path as Dropbox spells it. null = something is
 *  already at that path — the caller decides whether that is its folder.
 *  CP-09's topic folders record the id so they can still be found after
 *  somebody renames one. Real failures throw, as dropboxCreateFolder does. */
export async function dropboxCreateFolderMeta(path: string): Promise<{ id: string | null; path: string } | null> {
  try {
    const r = await dbx<{ metadata?: { id?: string; path_display?: string } }>("files/create_folder_v2", { path, autorename: false });
    return { id: r?.metadata?.id ?? null, path: r?.metadata?.path_display ?? path };
  } catch (e) {
    if (e instanceof DropboxError && /conflict|already/i.test(e.message)) return null;
    throw e;
  }
}

// Move/rename a folder. Distinguishes "destination already exists" (returns
// false — caller decides) from real failures (throws). Used by the folder
// engine for reschedules (month changed) and cancellations (archive).
export async function dropboxMoveFolder(fromPath: string, toPath: string): Promise<boolean> {
  try {
    await dbx("files/move_v2", { from_path: fromPath, to_path: toPath, autorename: false });
    return true;
  } catch (e) {
    if (e instanceof DropboxError && /conflict/i.test(e.message)) return false;
    throw e;
  }
}

export async function dropboxListFolder(
  path: string,
  opts: { recursive?: boolean } = {},
): Promise<{ name: string; tag: string; path: string; id: string | null }[]> {
  type Page = { entries: { name: string; [".tag"]: string; path_display?: string; id?: string }[]; has_more?: boolean; cursor?: string };
  // PAGINATED: a 400-raw shoot folder exceeds one page and used to be silently
  // truncated, which under-counted photos (and photo-editing cost).
  // RECURSIVE (opt-in): camera dumps land as nested folders (Sony/Canon card
  // trees, or a photographer's own subfolder), and a top-level-only listing
  // counted those as ZERO — the portal told Harrison "the RAW-Video folder is
  // empty" while his footage sat one level down (Jordan, Sep 1).
  let res = await dbx<Page>("files/list_folder", {
    path: path === "/" ? "" : path,
    ...(opts.recursive ? { recursive: true } : {}),
  });
  const all = [...(res.entries ?? [])];
  let guard = 0;
  while (res.has_more && res.cursor && guard++ < 50) {
    res = await dbx<Page>("files/list_folder/continue", { cursor: res.cursor });
    all.push(...(res.entries ?? []));
  }
  // `id` is Dropbox's permanent id ("id:…"), the one handle that survives a
  // rename — CP-09's topic folders match on it.
  return all.map((e) => ({ name: e.name, tag: e[".tag"], path: e.path_display ?? "", id: e.id ?? null }));
}

// Turn a Dropbox share URL into a direct/raw URL that OpenPhone can fetch.
function directLink(u: string): string {
  return u.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace(/([?&])dl=0/, "$1raw=1");
}

// Create (or reuse) a public shared link for a Dropbox file → direct URL.
export async function dropboxSharedLink(path: string): Promise<string | null> {
  try {
    const r = await dbx<{ url?: string }>("sharing/create_shared_link_with_settings", { path });
    return r.url ? directLink(r.url) : null;
  } catch (e) {
    if (e instanceof DropboxError && /already_exists/i.test(e.message)) {
      const l = await dbx<{ links?: { url: string }[] }>("sharing/list_shared_links", { path, direct_only: true });
      const u = l.links?.[0]?.url;
      return u ? directLink(u) : null;
    }
    return null;
  }
}

// Upload bytes to Dropbox and return a public direct link (for MMS attachments).
export async function dropboxUploadPublic(path: string, bytes: Uint8Array): Promise<string | null> {
  const token = await dropboxAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(await pathRootHeader(token)),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true, mute: true }),
    },
    body: new Uint8Array(bytes) as unknown as BodyInit,
    cache: "no-store",
  });
  if (!res.ok) throw new DropboxError(`Dropbox upload failed: ${(await res.text()).slice(0, 160)}`, res.status);
  const j = (await res.json()) as { path_display?: string };
  return dropboxSharedLink(j.path_display ?? path);
}

/** Upload a file. Returns where it actually landed: with autorename on, a
 *  collision puts "logo.png" at "logo (1).png", and a caller that records the
 *  file (the brand registry, CP-06) must point at the renamed path, not the
 *  one it asked for. Callers that ignore the result are unaffected. */
export async function dropboxUpload(
  path: string,
  bytes: Buffer | Uint8Array,
  opts: { overwrite?: boolean } = {},
): Promise<{ pathDisplay: string }> {
  const token = await dropboxAccessToken();
  const mode = opts.overwrite ? "overwrite" : "add";
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(await pathRootHeader(token)),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode, autorename: !opts.overwrite, mute: false }),
    },
    body: new Uint8Array(bytes) as unknown as BodyInit,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new DropboxError(`Dropbox upload failed: ${t.slice(0, 160)}`, res.status);
  }
  const j = (await res.json().catch(() => ({}))) as { path_display?: string };
  return { pathDisplay: j.path_display ?? path };
}

// Download a file's raw bytes (content API). Throws DropboxError (status 409 with
// a path/not_found summary) when the file is missing.
export async function dropboxDownload(path: string): Promise<Buffer> {
  const token = await dropboxAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(await pathRootHeader(token)),
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new DropboxError(`Dropbox download failed: ${t.slice(0, 160)}`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Delete a file/folder; a missing path is treated as success (idempotent).
export async function dropboxDelete(path: string): Promise<void> {
  try {
    await dbx("files/delete_v2", { path });
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return;
    throw e;
  }
}
