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

async function accessTokenFor(refreshToken: string): Promise<string> {
  const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return json.access_token as string;
}

// We support multiple mailboxes (hello@ + info@). The "gmail" secret holds an
// encrypted JSON map of { email: refreshToken }.
async function gmailAccounts(): Promise<{ email: string; refreshToken: string }[]> {
  const raw = await getSecret("gmail");
  if (!raw) return [];
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return Object.entries(map).map(([email, refreshToken]) => ({ email, refreshToken }));
  } catch {
    return [{ email: "account", refreshToken: raw }]; // legacy single-token
  }
}

// Add (or refresh) a mailbox after the user authorizes it.
export async function addGmailAccount(refreshToken: string): Promise<string> {
  const { saveSecret } = await import("./connections");
  const token = await accessTokenFor(refreshToken);
  const profile = await gmail<{ emailAddress?: string }>("/profile", token);
  const email = (profile.emailAddress || "account").toLowerCase();
  const existing = await gmailAccounts();
  const map: Record<string, string> = {};
  for (const a of existing) map[a.email] = a.refreshToken;
  map[email] = refreshToken;
  await saveSecret("gmail", JSON.stringify(map), {
    accountLabel: `Gmail · ${Object.keys(map).join(", ")}`,
  });
  return email;
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

// Automated / non-human sender local-parts (the part before @).
const AUTOMATED_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|notify|notification|notifications|mailer|mailer-daemon|bounce|bounces|postmaster|news|newsletter|marketing|promo|promotions|billing|invoice|invoices|invoicing|receipt|receipts|payments?|orders?|alerts?|updates?|system|automated|auto|do_not_reply|noticed|team|hello|info|support|help|account|accounts|email|mail|members?|notices?|reply)$/i;

// Vendor / tooling domains whose mail is transactional, never a client.
const VENDOR_DOMAINS = [
  "aryeo.com", "dropbox.com", "dropboxmail.com", "stripe.com", "intuit.com", "quickbooks.com",
  "docusign.net", "docusign.com", "calendly.com", "google.com", "accounts.google.com",
  "squarespace.com", "wix.com", "openphone.com", "openphone.co", "slack.com", "anthropic.com",
  "vercel.com", "hubspot.com", "mail.hubspot.com", "zoom.us", "canva.com", "venmo.com",
  "paypal.com", "facebookmail.com", "mailchimp.com", "sendgrid.net", "amazonses.com",
  "matterport.com", "cubicasa.com", "autohdr.com", "frame.io",
];

function isLikelyHuman(fromEmail: string, listUnsubscribe: string, subject: string): boolean {
  if (!fromEmail || !fromEmail.includes("@")) return false;
  if (listUnsubscribe) return false; // bulk / marketing / newsletters
  const [local, domain] = fromEmail.split("@");
  if (AUTOMATED_LOCAL.test(local)) return false;
  if (VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return false;
  // Obvious receipts/invoices/marketing by subject.
  if (/\b(invoice|receipt|payment received|your order|statement|unsubscribe|newsletter|webinar|sale ends|% off)\b/i.test(subject)) return false;
  return true;
}

// Scan recent inbound emails across all connected mailboxes (hello@ + info@),
// keep only genuine client/lead messages (no marketing, invoices, automated),
// and turn them into tasks. Matched clients → reply task; unknown humans → lead.
export async function syncGmail(): Promise<{ scanned: number; tasks: number }> {
  const { recordClientCommunication } = await import("@/lib/comms");
  const accounts = await gmailAccounts();
  if (accounts.length === 0) throw new Error("Gmail is not connected.");

  // Preload clients + contacts for email matching (shared across mailboxes).
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({
      where: { email: { not: null } },
      select: { id: true, name: true, email: true, projects: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, title: true, status: true } } },
    }),
    prisma.contact.findMany({ where: { email: { not: null }, clientId: { not: null } }, select: { email: true, clientId: true } }),
  ]);
  const clientByEmail = new Map(clients.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const contactClientByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.clientId!]));
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  let scanned = 0;
  let tasks = 0;

  for (const account of accounts) {
    let token: string;
    try {
      token = await accessTokenFor(account.refreshToken);
    } catch {
      continue; // token revoked / expired — skip this mailbox
    }
    const list = await gmail<{ messages?: { id: string }[] }>(
      "/messages?q=" + encodeURIComponent("in:inbox newer_than:3d -from:me category:primary") + "&maxResults=25",
      token,
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    scanned += ids.length;

    for (const id of ids) {
      const dedupe = `${account.email}:${id}`;
      const seen = await prisma.webhookEvent.findFirst({ where: { provider: "gmail", externalId: dedupe, status: "PROCESSED" } });
      if (seen) continue;
      const msg = await gmail<GmailMsg>(
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`,
        token,
      );
      const { name, email } = parseFrom(header(msg, "From"));
      const subject = header(msg, "Subject");
      const listUnsub = header(msg, "List-Unsubscribe");
      const text = `${subject ? subject + " — " : ""}${msg.snippet ?? ""}`.trim();

      await prisma.webhookEvent.create({
        data: { provider: "gmail", eventType: "email", externalId: dedupe, payload: text.slice(0, 1000), status: "PROCESSED", processedAt: new Date() },
      });

      // Only real client/lead emails — drop marketing, invoices, automated.
      if (!text || !isLikelyHuman(email, listUnsub, subject)) continue;

      let client = clientByEmail.get(email);
      if (!client) {
        const cid = contactClientByEmail.get(email);
        if (cid) client = clients.find((c) => c.id === cid);
      }

      if (client) {
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
      } else {
        // Unknown human → a lead. One open lead task per sender.
        const key = `lead-${email}`;
        const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
        if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") continue;
        const data = {
          taskType: "lead",
          title: `New lead: ${name || email}`.slice(0, 120),
          description: text.slice(0, 400),
          reasonCreated: `New inbound email to ${account.email}`,
          checklist: JSON.stringify(["Read the email", "Qualify (listing, timeline, budget)", "Reply / book a strategy call", "Add to CRM"]),
          source: "gmail",
          priority: "HIGH" as const,
          dueAt: new Date(Date.now() + 4 * 3600_000),
          ownerId: kyle?.id ?? null,
          dedupeKey: key,
        };
        if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
        else await prisma.smartTask.create({ data });
        tasks++;
      }
    }
  }
  return { scanned, tasks };
}
