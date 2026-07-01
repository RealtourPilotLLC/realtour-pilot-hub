import "server-only";
import { getSecret, saveSecret } from "./connections";

// ---------------------------------------------------------------------------
// Frame.io V4 integration. V4 is the Adobe-era API: auth is Adobe IMS OAuth
// (User Authentication / "OAuth Web App"), and we keep the long-lived REFRESH
// token (offline_access) encrypted, minting short-lived access tokens on demand
// — same shape as our Dropbox integration.
//
// App credential (FRAMEIO_CLIENT_ID / FRAMEIO_CLIENT_SECRET) lives in env, like
// Google/Dropbox. The OAuth app + redirect URI are configured in the Adobe
// Developer Console (Frame.io API → OAuth Web App).
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.FRAMEIO_CLIENT_ID ?? "";

// The Adobe OAuth client secret. Pasted into the Connections page → encrypted in
// the Connection store (preferred, so the owner never touches Vercel); falls back
// to an env var if one is set.
async function clientSecret(): Promise<string> {
  return (await getSecret("frameio_app")) || process.env.FRAMEIO_CLIENT_SECRET || "";
}

const IMS = "https://ims-na1.adobelogin.com";
const V4 = "https://api.frame.io/v4";
// The scopes the Adobe credential exposes (all auto-granted). offline_access is
// what gets us the refresh token.
const SCOPES = "openid,offline_access,profile,email,additional_info.roles";
// V4 requires an api-version header; "experimental" is the current named version.
const API_VERSION = "experimental";

export class FrameioError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "FrameioError";
  }
}

function appBase(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

// True once the Client ID (env) and Client Secret (Connection store) are both set.
export async function frameioConfigured(): Promise<boolean> {
  return Boolean(CLIENT_ID && (await clientSecret()));
}

export function frameioRedirectUri(): string {
  return `${appBase()}/api/frameio/callback`;
}

// The Adobe IMS consent URL the owner visits to authorize the integration.
export function frameioAuthorizeUrl(state: string): string {
  const u = new URL(`${IMS}/ims/authorize/v2`);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", frameioRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  return u.toString();
}

// Exchange the auth code for tokens and persist the refresh token (encrypted).
export async function exchangeFrameioCode(code: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${IMS}/ims/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: await clientSecret(),
      code: code.trim(),
      redirect_uri: frameioRedirectUri(),
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string; error?: string; error_description?: string;
  };
  if (!res.ok || !json.refresh_token) {
    return { ok: false, error: json.error_description || json.error || `Adobe token ${res.status}` };
  }
  await saveSecret("frameio", json.refresh_token, { accountLabel: "Frame.io" });
  return { ok: true };
}

// Mint a short-lived access token from the stored refresh token.
async function frameioAccessToken(): Promise<string> {
  const refresh = await getSecret("frameio");
  if (!refresh) throw new FrameioError("Frame.io is not connected.", 401);
  const res = await fetch(`${IMS}/ims/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: await clientSecret(),
      refresh_token: refresh,
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !json.access_token) {
    throw new FrameioError(`Frame.io token refresh failed (${res.status})`, res.status);
  }
  return json.access_token;
}

// V4 REST wrapper: Bearer + the required api-version header.
export async function fio<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const token = opts.token ?? (await frameioAccessToken());
  const res = await fetch(`${V4}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "api-version": API_VERSION,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let json: { errors?: { detail?: string }[]; message?: string } | undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new FrameioError(json?.errors?.[0]?.detail || json?.message || `Frame.io ${path} ${res.status}`, res.status);
  }
  return json as T;
}

// Quick connectivity probe — used by the Connections page to confirm the token
// works. Returns the accounts the connected user can see.
export async function frameioPing(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await fio("/accounts");
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof FrameioError ? e.message : String(e) };
  }
}
