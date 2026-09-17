import "server-only";

import { getConnection, getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Instagram publishing — the Meta Graph adapter (spec §12), Sep 16 2026.
//
// Jordan: "Build the Instagram integration as far as credentials and provider
// approval permit. Keep unavailable integrations clearly disabled." Tonight
// there are NO Meta credentials anywhere (no env, no Connection row — verified
// Sep 16), no Meta app, and no app review. So every method below is written
// against the documented Graph endpoints AND begins with configured(): when the
// app id + secret are absent it returns { ok: false, reason: "not_configured" }
// WITHOUT any network call. There is no fake OAuth button anywhere; the
// Connections card shows REQUIREMENTS instead until this file says it is ready.
//
// Where the app credentials live once Jordan has them: Connection "meta" —
// the app SECRET encrypted in secretEncrypted (saveSecret), the app ID in the
// row's metadata JSON ({ appId }). Env META_APP_ID / META_APP_SECRET are
// honoured as a deploy-time fallback, the way GOOGLE_CLIENT_ID is, but the
// Connection row wins so a rotation on /connections takes effect without a
// deploy. Per-account access tokens are NOT here: they belong to a
// ProgramPublishingAccount row (credentialEncrypted, lib/publishing.ts).
//
// The documented flow this file implements (Instagram API with Facebook
// Login, content publishing for Reels):
//   1. Login dialog  https://www.facebook.com/{v}/dialog/oauth
//   2. Code → token  POST /oauth/access_token (secret in the body; then a long-lived exchange)
//   3. Accounts      GET  /me/accounts?fields=…instagram_business_account{…}
//   4. Container     POST /{ig-user-id}/media  (media_type=REELS, video_url)
//   5. Status        GET  /{container-id}?fields=status_code,status
//   6. Publish       POST /{ig-user-id}/media_publish (creation_id in the body)
//   7. Receipt       GET  /{media-id}?fields=id,permalink
//   8. Disconnect    DELETE /me/permissions  (revokes the grant)
// Endpoint shapes are what Meta documents at the Graph version pinned below;
// the spec's own doc links could not be fetched during its drafting, so the
// first real run against a Meta app is a verification gate, not a formality.
// ---------------------------------------------------------------------------

export const META_CONNECTION = "meta";
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

/**
 * The permissions the login dialog asks for — THE list; the REQUIREMENTS card
 * text below is derived from it so Jordan's App Review submission can never
 * drift from what the dialog requests. pages_read_engagement is included
 * because Meta's content-publishing requirements list it beside
 * pages_show_list for reading the Page → instagram_business_account link.
 * business_management only if Meta's review asks for it.
 */
export const META_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"] as const;

/**
 * What Jordan must obtain before anything here can run. Shown verbatim on the
 * Connections card. Written for him, not for a developer.
 */
export const REQUIREMENTS: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  {
    key: "meta_app",
    label: "A Meta app (App ID + App Secret)",
    detail: "Created at developers.facebook.com under the RealTour Pilot business, with the Instagram product added. Paste the ID and Secret on this card once you have them.",
  },
  {
    key: "ig_business",
    label: "Each client's Instagram as a Business or Creator account, linked to a Facebook Page",
    detail: "A personal Instagram account cannot be published to by the API. The client switches to Professional (Business or Creator) in Instagram settings and connects it to a Facebook Page they admin.",
  },
  {
    key: "permissions",
    label: `Permissions: ${META_SCOPES.join(", ")} (+ business_management if Meta asks)`,
    detail: "These are what the connect step requests. Before App Review only people with a role on the Meta app (developers, testers) can grant them — enough for a pilot on Jordan's own account, not for clients.",
  },
  {
    key: "app_review",
    label: "Meta App Review approved for instagram_content_publish",
    detail: "Required before any client (anyone without a role on the app) can connect. Meta asks for a screencast of the exact flow and a privacy policy URL.",
  },
  {
    key: "eligibility",
    label: "Account and media eligibility (spec §12 caveats)",
    detail: "Reels only via the API: MP4/MOV, H.264, up to 1 GB, 3 s–15 min, 9:16 recommended, from a public URL. Cover selection, music, collaborators and scheduling are NOT all available through the API — anything the API does not support gets an honest fallback (the posting kit), never a button that pretends.",
  },
  {
    key: "public_url",
    label: "A public file URL for each cut",
    detail: "Instagram fetches the video from a URL it can reach. The hub's review store already serves cuts publicly, so this is met once the store's privacy question (Sep 16) is settled in a way that keeps a publish-time URL reachable.",
  },
];

export type IgAccount = {
  igUserId: string;
  username: string | null;
  name: string | null;
  pageId: string;
  pageName: string | null;
  profilePictureUrl: string | null;
};

export type IgContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED" | "UNKNOWN";

export type IgResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_configured"; needs: typeof REQUIREMENTS; message: string }
  | { ok: false; reason: "unauthorized" | "rate_limited" | "provider_error" | "network" | "unreadable" | "invalid_input"; message: string; retryable: boolean; status?: number; code?: number };

const NOT_CONFIGURED: IgResult<never> = {
  ok: false,
  reason: "not_configured",
  needs: REQUIREMENTS,
  message: "Instagram publishing is not configured — no Meta app credentials exist yet. Nothing was sent to Meta.",
};

export type MetaAppCredentials = { appId: string; appSecret: string; source: "connection" | "env" };

/** Remove anything that looks like a token or secret from text we might store or show. */
export function scrubMeta(text: string, ...secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[secret]");
  return out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]").slice(0, 400);
}

/** App id + secret, or null. No network. */
export async function metaAppCredentials(): Promise<MetaAppCredentials | null> {
  const row = await getConnection(META_CONNECTION).catch(() => null);
  if (row && row.status === "CONNECTED" && row.secretEncrypted) {
    const secret = await getSecret(META_CONNECTION);
    let appId: string | null = null;
    try {
      const meta = row.metadata ? (JSON.parse(row.metadata) as { appId?: unknown }) : null;
      if (meta && typeof meta.appId === "string" && meta.appId.trim()) appId = meta.appId.trim();
    } catch {
      /* unreadable metadata = no app id */
    }
    if (secret && appId) return { appId, appSecret: secret, source: "connection" };
  }
  const envId = process.env.META_APP_ID?.trim();
  const envSecret = process.env.META_APP_SECRET?.trim();
  if (envId && envSecret) return { appId: envId, appSecret: envSecret, source: "env" };
  return null;
}

/** THE GATE every method runs first. false tonight. No network. */
export async function configured(): Promise<boolean> {
  return Boolean(await metaAppCredentials());
}

// ---- HTTP ------------------------------------------------------------------

type GraphError = { error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string } };

async function graphFetch<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    /** Plain query parameters — never a secret. */
    params?: Record<string, string>;
    /** Parameters that carry a secret (app secret, auth code, exchange token): sent as a form BODY, never in the URL. */
    secretParams?: Record<string, string>;
    /** The user access token: sent as a Bearer header, never in the URL. */
    token?: string;
    timeoutMs?: number;
    secrets?: Array<string | null | undefined>;
  },
): Promise<IgResult<T>> {
  // Secrets never travel in a URL: a query string is what proxies, CDNs and
  // access logs keep. Graph accepts form-encoded bodies and a Bearer header
  // for every endpoint used here, so the URL only ever carries public ids and
  // field lists. The fetch spy in the W1-D acceptance probe asserts exactly this.
  const params = new URLSearchParams(init.params ?? {});
  const url = `${GRAPH}${path}${params.size ? `?${params}` : ""}`;
  const secrets = [init.token, ...Object.values(init.secretParams ?? {}), ...(init.secrets ?? [])];
  const method = init.method ?? (init.secretParams ? "POST" : "GET");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.secretParams) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.secretParams).toString();
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, cache: "no-store", signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  } catch (e) {
    return { ok: false, reason: "network", message: scrubMeta(`Couldn't reach Meta (${(e as Error).message}).`, ...secrets), retryable: true };
  }
  const text = await res.text().catch(() => "");
  let parsedBody: unknown = null;
  try {
    parsedBody = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) return { ok: false, reason: "unreadable", message: "Meta sent back something we couldn't read.", retryable: false, status: res.status };
  }
  if (!res.ok) {
    const err = (parsedBody as GraphError | null)?.error;
    const msg = scrubMeta(err?.message ? `Meta: ${err.message}` : `Meta ${res.status}`, ...secrets);
    // Graph codes: 190 = invalid/expired token, 4/17/32/613 = rate limits, 10/200-299 = permission.
    if (res.status === 401 || err?.code === 190) return { ok: false, reason: "unauthorized", message: msg, retryable: false, status: res.status, code: err?.code };
    if (res.status === 429 || [4, 17, 32, 613].includes(err?.code ?? -1)) return { ok: false, reason: "rate_limited", message: msg, retryable: true, status: res.status, code: err?.code };
    return { ok: false, reason: "provider_error", message: msg, retryable: res.status >= 500, status: res.status, code: err?.code };
  }
  return { ok: true, value: (parsedBody ?? {}) as T };
}

// ---- 1–2. Connect (OAuth) ---------------------------------------------------

/**
 * The Facebook Login dialog URL. No network; still gated, because a URL that
 * names a non-existent app is a broken button, not a disabled one.
 */
export async function authorizeUrl(input: { state: string; redirectUri: string }): Promise<IgResult<string>> {
  const creds = await metaAppCredentials();
  if (!creds) return NOT_CONFIGURED;
  const p = new URLSearchParams({
    client_id: creds.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    scope: META_SCOPES.join(","),
  });
  return { ok: true, value: `${DIALOG}?${p}` };
}

export type IgToken = { accessToken: string; expiresAt: Date | null; longLived: boolean };

/** Code → short-lived user token → long-lived (~60 days) user token. */
export async function exchangeCode(input: { code: string; redirectUri: string }): Promise<IgResult<IgToken>> {
  const creds = await metaAppCredentials();
  if (!creds) return NOT_CONFIGURED;
  const short = await graphFetch<{ access_token?: string; expires_in?: number }>("/oauth/access_token", {
    params: { client_id: creds.appId, redirect_uri: input.redirectUri },
    secretParams: { client_secret: creds.appSecret, code: input.code },
  });
  if (!short.ok) return short;
  if (!short.value.access_token) return { ok: false, reason: "unreadable", message: "Meta returned no access token.", retryable: false };
  const long = await graphFetch<{ access_token?: string; expires_in?: number }>("/oauth/access_token", {
    params: { grant_type: "fb_exchange_token", client_id: creds.appId },
    secretParams: { client_secret: creds.appSecret, fb_exchange_token: short.value.access_token },
  });
  if (long.ok && long.value.access_token) {
    const ttl = typeof long.value.expires_in === "number" ? long.value.expires_in : 60 * 24 * 3600;
    return { ok: true, value: { accessToken: long.value.access_token, expiresAt: new Date(Date.now() + ttl * 1000), longLived: true } };
  }
  // A short-lived token still works for an hour; better than failing the connect.
  const ttl = typeof short.value.expires_in === "number" ? short.value.expires_in : 3600;
  return { ok: true, value: { accessToken: short.value.access_token, expiresAt: new Date(Date.now() + ttl * 1000), longLived: false } };
}

// ---- 3. Which Instagram accounts this login can publish to --------------------

type PagesResponse = {
  data?: Array<{
    id: string;
    name?: string;
    instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
  }>;
};

export async function listInstagramAccounts(accessToken: string): Promise<IgResult<IgAccount[]>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<PagesResponse>("/me/accounts", {
    token: accessToken,
    params: { fields: "id,name,instagram_business_account{id,username,name,profile_picture_url}", limit: "50" },
  });
  if (!r.ok) return r;
  const accounts: IgAccount[] = [];
  for (const page of r.value.data ?? []) {
    const ig = page.instagram_business_account;
    if (!ig?.id) continue; // a Page with no linked professional Instagram cannot be published to
    accounts.push({
      igUserId: ig.id,
      username: ig.username ?? null,
      name: ig.name ?? null,
      pageId: page.id,
      pageName: page.name ?? null,
      profilePictureUrl: ig.profile_picture_url ?? null,
    });
  }
  return { ok: true, value: accounts };
}

// ---- 4–7. Publish a Reel -------------------------------------------------------

export type CreateContainerInput = {
  igUserId: string;
  accessToken: string;
  /** Public URL Instagram can fetch. */
  videoUrl: string;
  caption: string;
  /** Optional public cover image URL; the API also accepts thumb_offset (ms). */
  coverUrl?: string | null;
  shareToFeed?: boolean;
};

export async function createMediaContainer(input: CreateContainerInput): Promise<IgResult<{ containerId: string }>> {
  if (!(await configured())) return NOT_CONFIGURED;
  if (!/^https:\/\//.test(input.videoUrl)) {
    return { ok: false, reason: "invalid_input", message: "Instagram needs an https URL it can fetch the video from.", retryable: false };
  }
  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: input.videoUrl,
    caption: input.caption.slice(0, 2200), // Instagram's caption limit
    share_to_feed: String(input.shareToFeed ?? true),
  };
  if (input.coverUrl) params.cover_url = input.coverUrl;
  const r = await graphFetch<{ id?: string }>(`/${input.igUserId}/media`, { method: "POST", token: input.accessToken, secretParams: params });
  if (!r.ok) return r;
  if (!r.value.id) return { ok: false, reason: "unreadable", message: "Meta returned no container id.", retryable: false };
  return { ok: true, value: { containerId: r.value.id } };
}

export async function containerStatus(input: { containerId: string; accessToken: string }): Promise<IgResult<{ status: IgContainerStatus; detail: string | null }>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<{ status_code?: string; status?: string }>(`/${input.containerId}`, {
    token: input.accessToken,
    params: { fields: "status_code,status" },
  });
  if (!r.ok) return r;
  const code = (r.value.status_code ?? "UNKNOWN").toUpperCase();
  const status: IgContainerStatus = ["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"].includes(code) ? (code as IgContainerStatus) : "UNKNOWN";
  return { ok: true, value: { status, detail: r.value.status ?? null } };
}

export async function publishContainer(input: { igUserId: string; creationId: string; accessToken: string }): Promise<IgResult<{ mediaId: string }>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<{ id?: string }>(`/${input.igUserId}/media_publish`, {
    method: "POST",
    token: input.accessToken,
    secretParams: { creation_id: input.creationId },
    timeoutMs: 60_000,
  });
  if (!r.ok) return r;
  if (!r.value.id) return { ok: false, reason: "unreadable", message: "Meta returned no media id — the publish is unconfirmed.", retryable: false };
  return { ok: true, value: { mediaId: r.value.id } };
}

export async function mediaPermalink(input: { mediaId: string; accessToken: string }): Promise<IgResult<{ permalink: string | null; timestamp: string | null }>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<{ permalink?: string; timestamp?: string }>(`/${input.mediaId}`, { token: input.accessToken, params: { fields: "id,permalink,timestamp" } });
  if (!r.ok) return r;
  return { ok: true, value: { permalink: r.value.permalink ?? null, timestamp: r.value.timestamp ?? null } };
}

/**
 * Recent media on the account — the reconciliation read after a publish that
 * timed out: a container reporting PUBLISHED means a post exists, and this is
 * how it is found by caption + time WITHOUT publishing again.
 */
export async function recentMedia(input: { igUserId: string; accessToken: string; limit?: number }): Promise<IgResult<Array<{ id: string; caption: string | null; permalink: string | null; timestamp: string | null }>>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<{ data?: Array<{ id: string; caption?: string; permalink?: string; timestamp?: string }> }>(`/${input.igUserId}/media`, {
    token: input.accessToken,
    params: { fields: "id,caption,permalink,timestamp", limit: String(Math.min(input.limit ?? 10, 25)) },
  });
  if (!r.ok) return r;
  return { ok: true, value: (r.value.data ?? []).map((m) => ({ id: m.id, caption: m.caption ?? null, permalink: m.permalink ?? null, timestamp: m.timestamp ?? null })) };
}

// ---- 8. Disconnect -------------------------------------------------------------

/** Revoke the login's grant at Meta. The caller (lib/publishing.ts) drops the stored token either way. */
export async function revokeAccess(accessToken: string): Promise<IgResult<{ revoked: boolean }>> {
  if (!(await configured())) return NOT_CONFIGURED;
  const r = await graphFetch<{ success?: boolean }>("/me/permissions", { method: "DELETE", token: accessToken });
  if (!r.ok) return r;
  return { ok: true, value: { revoked: r.value.success === true } };
}

// ---- App credential check --------------------------------------------------------

/**
 * The cheapest authenticated call a Meta app can make: mint an APP access token
 * from id + secret (client_credentials). Proves the pair is real without
 * touching any user, page or account. Used before storing the pair — a bogus
 * pair fails here and is never saved.
 */
export async function testMetaAppCredentials(appId: string, appSecret: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const id = appId.trim();
  const secret = appSecret.trim();
  if (!/^\d{5,}$/.test(id)) return { ok: false, error: "A Meta App ID is a number — check what was pasted." };
  if (secret.length < 16) return { ok: false, error: "That App Secret looks too short — copy the whole thing." };
  const r = await graphFetch<{ access_token?: string }>("/oauth/access_token", {
    params: { client_id: id, grant_type: "client_credentials" },
    secretParams: { client_secret: secret },
    timeoutMs: 15_000,
  });
  if (!r.ok) {
    if (r.reason === "not_configured") return { ok: false, error: r.message };
    // The verification gate from the W1-D notes: Meta documents this call as
    // GET-with-query; the adapter sends the secret in a POST form body so it
    // never sits in a URL. A bogus App ID cannot prove Meta read the body (it
    // fails on the id first), so the first REAL pair is the test — and if Meta
    // ever answers "missing client_secret", say exactly that instead of
    // blaming the pair.
    if (/client_secret/i.test(r.message)) {
      return { ok: false, error: "Meta did not read the App Secret from the request body (it answered about client_secret). The adapter's POST-body choice needs revisiting before this can be saved — see the W1-D handover; nothing was stored." };
    }
    return { ok: false, error: r.reason === "unauthorized" || r.status === 400 ? "Meta didn't accept that App ID + Secret." : r.message };
  }
  if (!r.value.access_token) return { ok: false, error: "Meta answered without an app token." };
  return { ok: true, label: `Meta app ${id}` };
}
