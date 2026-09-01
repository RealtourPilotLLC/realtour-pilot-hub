import "server-only";
import crypto from "crypto";
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
// V4 requires an api-version header; "4.0" is the current stable version (per the
// published OpenAPI spec — "experimental" only exposes reads).
const API_VERSION = "4.0";

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

// True once the OAuth refresh token is stored (connected).
export async function frameioConnected(): Promise<boolean> {
  return !!(await getSecret("frameio"));
}

// The account + workspace we create projects under (the connected owner's first
// of each). Cached per warm instance.
let ctxCache: { accountId: string; workspaceId: string } | null = null;
export async function frameioContext(): Promise<{ accountId: string; workspaceId: string }> {
  if (ctxCache) return ctxCache;
  const accs = await fio<{ data?: { id: string }[] }>("/accounts");
  const accountId = accs.data?.[0]?.id;
  if (!accountId) throw new FrameioError("No Frame.io account found for this login.");
  const wss = await fio<{ data?: { id: string }[] }>(`/accounts/${accountId}/workspaces`);
  const workspaceId = wss.data?.[0]?.id;
  if (!workspaceId) throw new FrameioError("No Frame.io workspace found.");
  ctxCache = { accountId, workspaceId };
  return ctxCache;
}

export type FrameioProject = { id: string; name: string; viewUrl: string; rootFolderId: string };

// Create a review project (titled e.g. "123 Main St — Client Name").
export async function createFrameioProject(name: string): Promise<FrameioProject> {
  const { accountId, workspaceId } = await frameioContext();
  const r = await fio<{ data: { id: string; name: string; view_url: string; root_folder_id: string } }>(
    `/accounts/${accountId}/workspaces/${workspaceId}/projects`,
    { method: "POST", body: { data: { name: name.slice(0, 250) } } },
  );
  const d = r.data;
  return { id: d.id, name: d.name, viewUrl: d.view_url, rootFolderId: d.root_folder_id };
}

export async function deleteFrameioProject(projectId: string): Promise<void> {
  const { accountId } = await frameioContext();
  await fio(`/accounts/${accountId}/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
}

// The custom-action event string our webhook receiver keys on. Editors click
// "Send to RealTour for review" on a project/asset → Frame.io POSTs this to us.
export const FRAMEIO_REVIEW_EVENT = "rtp.ready_for_review";

// Register the "Send to RealTour for review" custom action once for the
// workspace (idempotent — skips if it already exists). Its URL must be the
// public prod receiver, so pass the base explicitly when running off-prod.
export async function ensureReviewAction(baseUrl?: string): Promise<{ created: boolean; id?: string; url: string }> {
  const { accountId, workspaceId } = await frameioContext();
  // A shared-secret token in the action URL authenticates the callback: a
  // spoofer who doesn't know it can't push a job into review or spam Kyle.
  // Rotated on (re)registration; read back from the "frameio_webhook" secret.
  const token = crypto.randomBytes(24).toString("hex");
  await saveSecret("frameio_webhook", token);
  const url = `${baseUrl || appBase()}/api/webhooks/frameio?t=${token}`;
  const list = await fio<{ data?: { id: string; event: string }[] }>(`/accounts/${accountId}/workspaces/${workspaceId}/actions`);
  // Recreate any existing action so the new token URL takes effect (the list
  // response doesn't expose the URL, so we can't tell if it already has one).
  const existing = (list.data ?? []).find((a) => a.event === FRAMEIO_REVIEW_EVENT);
  if (existing) {
    await fio(`/accounts/${accountId}/workspaces/${workspaceId}/actions/${existing.id}`, { method: "DELETE" }).catch(() => {});
  }
  const r = await fio<{ data: { id: string } }>(
    `/accounts/${accountId}/workspaces/${workspaceId}/actions`,
    {
      method: "POST",
      body: {
        data: {
          name: "Send to RealTour for review",
          description: "Tell RealTour Pilot the finished video is ready to review",
          event: FRAMEIO_REVIEW_EVENT,
          url,
        },
      },
    },
  );
  return { created: true, id: r.data?.id, url };
}

// Verify an inbound Frame.io callback's shared-secret token (constant-time).
// True when nothing to verify against yet (no token stored) so the action keeps
// working until it's (re)registered with a token.
export async function frameioRequestAuthorized(token: string | null): Promise<boolean> {
  const expected = await getSecret("frameio_webhook");
  // No token registered = the integration is DORMANT (retired Aug 14, the
  // action was never re-registered) — reject, don't fail open: this receiver
  // flips job statuses and mints tasks, and the audit found it accepting
  // unauthenticated internet POSTs. Re-arming Frame.io = register the token.
  if (!expected) return false;
  const got = token ?? "";
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Idempotently ensure a Frame.io review project exists for a job (create + save
// its id/url). No-ops when one already exists or Frame.io isn't connected. Used
// by BOTH the manual "set up" button and the auto-create sweep, so a video job
// gets its review project whether or not the raw came through the in-app upload.
export async function ensureFrameioProjectForProject(projectId: string): Promise<{ created: boolean; viewUrl?: string }> {
  const { prisma } = await import("@/lib/prisma");
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, frameioProjectId: true, frameioViewUrl: true, client: { select: { name: true } } },
  });
  if (!p) return { created: false };
  if (p.frameioProjectId) return { created: false, viewUrl: p.frameioViewUrl ?? undefined };
  if (!(await frameioConnected())) return { created: false };
  const street = (p.title || "").split(",")[0].trim() || p.title || "Project";
  const name = `${street} — ${p.client?.name ?? "Client"}`.slice(0, 250);
  const proj = await createFrameioProject(name);
  await prisma.project.update({ where: { id: p.id }, data: { frameioProjectId: proj.id, frameioViewUrl: proj.viewUrl } });
  return { created: true, viewUrl: proj.viewUrl };
}

// Auto-create review projects for in-production VIDEO jobs that don't have one
// yet. Bounded + best-effort (a failure on one job never breaks the sweep).
export async function ensureFrameioProjectsForActiveVideoJobs(limit = 5): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  if (!(await frameioConnected())) return 0;
  const jobs = await prisma.project.findMany({
    where: {
      status: { in: ["EDITING", "REVIEW", "REVISION"] },
      frameioProjectId: null,
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null } },
    },
    select: { id: true },
    take: limit,
  });
  let created = 0;
  for (const j of jobs) {
    try {
      if ((await ensureFrameioProjectForProject(j.id)).created) created++;
    } catch {
      /* best-effort; try the next job */
    }
  }
  return created;
}
