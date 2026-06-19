import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Google / Gmail integration (OAuth2 with offline refresh tokens, read-only).
// Reads recent client emails and turns them into tasks — same listener model
// as OpenPhone/Slack. Never sends. App credentials come from env; the per-user
// refresh token is stored encrypted as the "gmail" connection.
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"];

export function googleConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function appBase() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}
export function googleRedirectUri() {
  return `${appBase()}/api/google/callback`;
}

export function googleAuthorizeUrl(): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("scope", SCOPES.join(" "));
  return u.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error_description as string) || (json.error as string) || `Google token ${res.status}`);
  return json;
}

export async function exchangeGoogleCode(code: string): Promise<{ refreshToken: string }> {
  const json = await tokenRequest({
    code: code.trim(),
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(),
  });
  const refreshToken = json.refresh_token as string | undefined;
  if (!refreshToken) throw new Error("Google did not return a refresh token. Remove the app's access and re-authorize.");
  return { refreshToken };
}

async function accessToken(): Promise<string> {
  const refreshToken = await getSecret("gmail");
  if (!refreshToken) throw new Error("Gmail is not connected.");
  const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return json.access_token as string;
}

async function gmail<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gmail ${path} ${res.status}`);
  return (await res.json()) as T;
}

export async function testGmailToken(
  refreshToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
    const token = json.access_token as string;
    const profile = await gmail<{ emailAddress?: string }>("/profile", token);
    return { ok: true, label: `Gmail · ${profile.emailAddress || "connected"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type GmailMsg = { id: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };

function header(m: GmailMsg, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<?([^>]*)>?\s*$/);
  const name = (m?.[1] ?? "").trim();
  const email = (m?.[2] ?? from).trim().toLowerCase();
  return { name: name || email, email };
}

// Pull recent inbound client emails and turn the ones we can match to a client
// into tasks. Deduped per Gmail message id via WebhookEvent.
export async function syncGmail(): Promise<{ scanned: number; tasks: number }> {
  const { recordClientCommunication } = await import("@/lib/comms");
  const token = await accessToken();

  const list = await gmail<{ messages?: { id: string }[] }>(
    "/messages?q=" + encodeURIComponent("in:inbox newer_than:3d -from:me category:primary") + "&maxResults=25",
    token,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return { scanned: 0, tasks: 0 };

  // Preload clients + contacts for email matching.
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({
      where: { email: { not: null } },
      select: { id: true, name: true, email: true, projects: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, title: true, status: true } } },
    }),
    prisma.contact.findMany({ where: { email: { not: null }, clientId: { not: null } }, select: { email: true, clientId: true } }),
  ]);
  const clientByEmail = new Map(clients.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const contactClientByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.clientId!]));

  let tasks = 0;
  for (const id of ids) {
    const seen = await prisma.webhookEvent.findFirst({ where: { provider: "gmail", externalId: id, status: "PROCESSED" } });
    if (seen) continue;
    const msg = await gmail<GmailMsg>(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token);
    const { name, email } = parseFrom(header(msg, "From"));
    const subject = header(msg, "Subject");
    const text = `${subject ? subject + " — " : ""}${msg.snippet ?? ""}`.trim();

    let client = clientByEmail.get(email);
    if (!client) {
      const cid = contactClientByEmail.get(email);
      if (cid) client = clients.find((c) => c.id === cid);
    }

    await prisma.webhookEvent.create({
      data: { provider: "gmail", eventType: "email", externalId: id, payload: text.slice(0, 1000), status: "PROCESSED", processedAt: new Date() },
    });
    if (!client || !text) continue;

    const project = client.projects[0];
    await recordClientCommunication({
      clientId: client.id,
      clientName: client.name || name,
      projectId: project?.id,
      projectStatus: project?.status ?? null,
      propertyAddress: project?.title ?? null,
      text,
      kind: "email",
      source: "gmail",
    });
    tasks++;
  }
  return { scanned: ids.length, tasks };
}
