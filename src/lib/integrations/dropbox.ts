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
export async function dropboxAccessToken(): Promise<string> {
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
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(skipPathRoot ? {} : await pathRootHeader(token)),
      ...(arg !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: arg !== undefined ? JSON.stringify(arg) : undefined,
    cache: "no-store",
  });
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
    throw new DropboxError((json?.error_summary as string) || `Dropbox ${endpoint} ${res.status}`, res.status);
  }
  return json as T;
}

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

export async function dropboxListFolder(path: string): Promise<{ name: string; tag: string; path: string }[]> {
  type Page = { entries: { name: string; [".tag"]: string; path_display?: string }[]; has_more?: boolean; cursor?: string };
  // PAGINATED: a 400-raw shoot folder exceeds one page and used to be silently
  // truncated, which under-counted photos (and photo-editing cost).
  let res = await dbx<Page>("files/list_folder", { path: path === "/" ? "" : path });
  const all = [...(res.entries ?? [])];
  let guard = 0;
  while (res.has_more && res.cursor && guard++ < 50) {
    res = await dbx<Page>("files/list_folder/continue", { cursor: res.cursor });
    all.push(...(res.entries ?? []));
  }
  return all.map((e) => ({ name: e.name, tag: e[".tag"], path: e.path_display ?? "" }));
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

export async function dropboxUpload(
  path: string,
  bytes: Buffer | Uint8Array,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
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
