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
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send", // lets the hub email Jordan (e.g. new feedback)
  "https://www.googleapis.com/auth/userinfo.email",
];

// Owner's address — where platform notifications (new feedback, etc.) go.
const OWNER_EMAIL = "info@realtourpilot.com";

// Send a plain-text email from one of our connected mailboxes to the owner.
// Best-effort: returns false (never throws) if Gmail isn't connected or the
// token lacks the send scope (readonly-only until the owner reconnects Google).
export async function notifyOwnerEmail(subject: string, body: string): Promise<boolean> {
  try {
    const accounts = await gmailAccounts();
    const acct = accounts.find((a) => a.email === OWNER_EMAIL) ?? accounts[0];
    if (!acct) return false;
    const token = await accessTokenFor(acct.refreshToken);
    const mime = [
      `To: ${OWNER_EMAIL}`,
      `From: ${acct.email}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
    ].join("\r\n");
    const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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

type GmailPart = { mimeType?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
type GmailMsg = { id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: GmailPart };
type GmailThread = { messages?: GmailMsg[] };

function header(m: GmailMsg, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<?([^>]*)>?\s*$/);
  let name = (m?.[1] ?? "").trim();
  let email = (m?.[2] ?? "").trim().toLowerCase();
  // Bare address with no display name / angle brackets (e.g. "status@luma.co"):
  // the regex captures it as the name and leaves email empty. Recover it.
  if (!email) {
    email = name.toLowerCase();
    name = "";
  }
  return { name: name || email, email };
}

// Mailboxes that should ONLY surface emails from people already in the client
// list (no "new lead" tasks from unknown senders). info@ is Jordan's personal
// account, so unknown senders there are usually personal mail, not leads.
const CLIENTS_ONLY_MAILBOXES = ["info@realtourpilot.com"];

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

// Our own addresses. Any mail whose latest thread message is from one of these
// means WE'VE already replied — so the thread shouldn't generate a "to reply" task.
const OUR_DOMAIN = "realtourpilot.com";

// Luma Visuals = our premium-reel VIDEO EDITOR (a vendor, not a lead). Their
// status@ / Zapier mails mean "edit done" or "editor has a question" → route to
// a "check the Luma Visuals reel tracker" task instead of a lead.
const LUMA_DOMAINS = ["lumavisuals.co", "lumavisuals.com"];
// A Luma subject like "Revision Request Received -- 3725 Old Post Circle (Rick…)"
// means the reel is being revised → reflect it on the project (status + task),
// not just a generic "check the tracker" pointer.
const LUMA_REVISION_RE = /\brevision\b/i;
// Match a project to a Luma subject by its street (house number + suffix dropped,
// so "3752 Old Post Cir" matches "3725 Old Post Circle").
const STREET_SUFFIX_RE = /\b(dr|drive|st|street|rd|road|ave|avenue|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|hwy|sq|square|run|trl|trail|loop|pike|row)\.?$/i;
function streetCore(title: string): string {
  let s = (title.split(",")[0] || "").trim().replace(/^\d+\s+/, "");
  s = s.replace(STREET_SUFFIX_RE, "").trim();
  return s.toLowerCase();
}
// Other production-tool senders that should never be leads (drop them).
const VENDOR_NAME_RE = /\b(autohdr|auto\s?hdr|cubicasa|matterport|aryeo)\b/i;

function isLikelyHuman(fromEmail: string, listUnsubscribe: string, subject: string, fromName = ""): boolean {
  if (!fromEmail || !fromEmail.includes("@")) return false;
  if (listUnsubscribe) return false; // bulk / marketing / newsletters
  const [local, domain] = fromEmail.split("@");
  if (AUTOMATED_LOCAL.test(local)) return false;
  if (domain === OUR_DOMAIN) return false; // our own / forwarded mail
  if (VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return false;
  if (domain === "zapiermail.com") return false; // Zapier-relayed automation
  if (VENDOR_NAME_RE.test(fromName) || VENDOR_NAME_RE.test(local)) return false; // vendor brands
  // Obvious receipts/invoices/marketing by subject.
  if (/\b(invoice|receipt|payment received|your order|statement|unsubscribe|newsletter|webinar|sale ends|% off)\b/i.test(subject)) return false;
  return true;
}

// True if the most recent message in the thread was sent by us — i.e. we've
// already replied, so there's nothing for Kyle to action.
async function threadAlreadyAnswered(threadId: string, token: string): Promise<boolean> {
  try {
    const thread = await gmail<GmailThread>(
      `/threads/${threadId}?format=metadata&metadataHeaders=From`,
      token,
    );
    const msgs = thread.messages ?? [];
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    const from = header(last, "From").toLowerCase();
    return from.includes("@" + OUR_DOMAIN);
  } catch {
    return false; // if we can't tell, don't suppress
  }
}

// ---------------------------------------------------------------------------
// Reading email threads (for the "see the conversation" view on a client page).
// Read-only; we only ever display, never send.
// ---------------------------------------------------------------------------

export type GmailEmail = {
  id: string;
  threadId: string;
  mailbox: string; // which of our mailboxes surfaced it
  from: string; // display name (or address)
  fromEmail: string;
  date: string; // ISO
  subject: string;
  snippet: string;
  body: string; // plain-text body
  fromUs: boolean; // sent by us (one of our addresses)
};

function decodeB64Url(data?: string): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

// Decode HTML entities so bodies/snippets read naturally (Gmail HTML-encodes
// snippets — apostrophes show up as &#39; etc).
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Pull a readable plain-text body out of a (possibly multipart) Gmail payload.
// Prefers text/plain; falls back to a crude HTML strip.
function extractBody(payload?: GmailPart): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.parts?.length) { p.parts.forEach(walk); return; }
    const mime = p.mimeType ?? "";
    if (mime.startsWith("text/plain")) plain.push(decodeB64Url(p.body?.data));
    else if (mime.startsWith("text/html")) html.push(decodeB64Url(p.body?.data));
  };
  walk(payload);
  let text = plain.join("\n").trim();
  if (!text) {
    text = html.join("\n").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  }
  // Collapse excess blank lines + decode entities so the panel stays readable.
  return decodeEntities(text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n")).trim();
}

// Load recent email messages involving any of a client's addresses, across all
// connected mailboxes, newest-last (chronological, like a thread).
export async function clientEmailThreads(
  emails: string[],
  maxMessages = 15,
): Promise<GmailEmail[]> {
  const accounts = await gmailAccounts();
  if (accounts.length === 0) return [];
  const addrs = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"))));
  if (addrs.length === 0) return [];

  // Gmail OR-group query: {from:a to:a from:b to:b} matches mail to OR from them.
  const terms = addrs.flatMap((a) => [`from:${a}`, `to:${a}`]);
  const q = `{${terms.join(" ")}} newer_than:1y`;

  const out: GmailEmail[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    let token: string;
    try { token = await accessTokenFor(account.refreshToken); } catch { continue; }
    let list: { messages?: { id: string }[] };
    try {
      list = await gmail(`/messages?q=${encodeURIComponent(q)}&maxResults=${maxMessages}`, token);
    } catch { continue; }
    for (const { id } of list.messages ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      let msg: GmailMsg;
      try { msg = await gmail<GmailMsg>(`/messages/${id}?format=full`, token); } catch { continue; }
      const { name, email } = parseFrom(header(msg, "From"));
      const dateHdr = header(msg, "Date");
      const ts = dateHdr ? new Date(dateHdr) : new Date(Number(msg.internalDate ?? 0));
      out.push({
        id,
        threadId: msg.threadId ?? id,
        mailbox: account.email,
        from: name || email,
        fromEmail: email,
        date: (isNaN(ts.getTime()) ? new Date() : ts).toISOString(),
        subject: header(msg, "Subject"),
        snippet: msg.snippet ?? "",
        body: extractBody(msg.payload).slice(0, 4000),
        fromUs: email.endsWith("@" + OUR_DOMAIN),
      });
    }
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// Scan recent inbound emails across all connected mailboxes (hello@ + info@),
// keep only genuine client/lead messages (no marketing, invoices, automated),
// and turn them into tasks. Matched clients → reply task; unknown humans → lead.
export async function syncGmail(): Promise<{ scanned: number; tasks: number }> {
  const { recordClientCommunication } = await import("@/lib/comms");
  const { logComm } = await import("@/lib/commLog");
  const accounts = await gmailAccounts();
  if (accounts.length === 0) throw new Error("Gmail is not connected.");

  // Preload clients + contacts for email matching (shared across mailboxes).
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({
      where: { email: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        parentClientId: true, // fold team assistants → the agent who holds the orders
        // Most-recent REAL order (orderedAt), not import order (createdAt is ≈same for all).
        projects: {
          orderBy: [
            { orderedAt: { sort: "desc", nulls: "last" } },
            { shootDate: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
          ],
          take: 1,
          select: { id: true, title: true, status: true },
        },
      },
    }),
    prisma.contact.findMany({ where: { email: { not: null }, clientId: { not: null } }, select: { email: true, clientId: true } }),
  ]);
  const clientByEmail = new Map(clients.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  // An assistant's email folds to their agent (where the orders live).
  const toAgent = (c: (typeof clients)[number]) => (c.parentClientId && clientById.get(c.parentClientId)) || c;
  const contactClientByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.clientId!]));
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  let scanned = 0;
  let tasks = 0;
  const tokens = new Map<string, string>(); // mailbox email -> access token (for the reply sweep)

  for (const account of accounts) {
    let token: string;
    try {
      token = await accessTokenFor(account.refreshToken);
    } catch {
      continue; // token revoked / expired — skip this mailbox
    }
    tokens.set(account.email, token);
    // NOTE: do NOT add `category:primary` — these are Workspace mailboxes that
    // don't use Gmail's tabbed-inbox categories, so that operator matches zero
    // messages and silently drops everything. We rely on isLikelyHuman() below
    // to filter out marketing/automated/vendor mail instead.
    const list = await gmail<{ messages?: { id: string }[] }>(
      "/messages?q=" + encodeURIComponent("in:inbox newer_than:3d -from:me") + "&maxResults=50",
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
      const threadId = msg.threadId ?? id;
      const threadRef = `gmail-thread:${account.email}:${threadId}`;
      const domain = email.includes("@") ? email.split("@")[1] : "";

      await prisma.webhookEvent.create({
        data: { provider: "gmail", eventType: "email", externalId: dedupe, payload: text.slice(0, 1000), status: "PROCESSED", processedAt: new Date() },
      });
      if (!text) continue;

      // Luma Visuals = our premium-reel video editor. Their mail isn't a lead —
      // it means an edit is ready or the editor has a question. Route it to a
      // "check the Luma Visuals reel tracker" task (skip bare order-received acks).
      if (domain && LUMA_DOMAINS.includes(domain)) {
        if (!/\b(ready|delivered|complete|completed|message from your editor|question|revision|approved|update)\b/i.test(subject)) continue;
        const matchedClient = clients.find((c) => c.name && subject.toLowerCase().includes(c.name.toLowerCase()));

        // Revision email → reflect it on the matched project (status → REVISION
        // when delivered, revision note + urgent revision task). Match by the
        // street named in the subject; prefer a DELIVERED order (a revision
        // request lands after the reel was delivered).
        if (LUMA_REVISION_RE.test(subject) && matchedClient) {
          const subjLower = subject.toLowerCase();
          const projs = await prisma.project.findMany({
            where: { clientId: matchedClient.id },
            orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
            select: { id: true, title: true, status: true, deliverables: { select: { type: true } } },
          });
          const addrMatches = projs.filter((p) => { const c = streetCore(p.title); return c.length >= 4 && subjLower.includes(c); });
          const target = addrMatches.find((p) => p.status === "DELIVERED") || addrMatches[0] || projs[0];
          if (target) {
            // Luma does reels/video — reopen that QC item for the re-QC.
            const types = new Set(target.deliverables.map((d) => d.type));
            const qcCategories = [types.has("SOCIAL_REEL") ? "Reel" : null, types.has("VIDEO") ? "Video" : null].filter(Boolean) as string[];
            const { raiseRevision } = await import("@/lib/comms");
            await raiseRevision({
              projectId: target.id,
              clientId: matchedClient.id,
              clientName: matchedClient.name,
              propertyAddress: target.title,
              note: subject.slice(0, 300),
              source: "Luma Visuals",
              qcCategories: qcCategories.length ? qcCategories : ["Reel"],
            });
            tasks++;
            continue;
          }
        }
        // One Luma task per project/client (not per notification email) — Luma
        // fires several mails per reel (revision received / editor message / ready)
        // and they should collapse to a single "check the tracker" pointer.
        const key = matchedClient ? `luma-client-${matchedClient.id}` : `luma-${threadId}`;
        const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
        if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") continue;
        const who = matchedClient?.name ? ` (${matchedClient.name})` : "";
        const data = {
          taskType: "vendor_update",
          title: `Luma Visuals reel update${who} — check the tracker`.slice(0, 120),
          description: text.slice(0, 400),
          reasonCreated: "Luma Visuals (reel editor) update via Gmail",
          checklist: JSON.stringify([
            "Open the Luma Visuals tracker: https://portal.lumavisuals.co/",
            "See if the edit is done or the editor has a question",
            "QC / download the reel, or answer the editor",
            "Deliver to the client + update the project if it's done",
          ]),
          source: "gmail",
          sourceDetail: threadRef,
          priority: "HIGH" as const,
          dueAt: new Date(Date.now() + 4 * 3600_000),
          ownerId: kyle?.id ?? null,
          clientId: matchedClient?.id ?? null,
          projectId: matchedClient?.projects[0]?.id ?? null,
          dedupeKey: key,
        };
        if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
        else await prisma.smartTask.create({ data });
        tasks++;
        continue;
      }

      // Only real client/lead emails — drop marketing, invoices, automated, vendors.
      if (!isLikelyHuman(email, listUnsub, subject, name)) continue;

      // Don't surface anything we've already replied to (latest thread message
      // is from us) — only flag messages still awaiting a response.
      if (await threadAlreadyAnswered(threadId, token)) continue;

      let client = clientByEmail.get(email);
      if (!client) {
        const cid = contactClientByEmail.get(email);
        if (cid) client = clients.find((c) => c.id === cid);
      }
      if (client) client = toAgent(client); // route assistant comms to the agent

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
          threadRef,
        });
        // Comms memory: store the inbound client email (subject + snippet).
        await logComm({
          channel: "email",
          direction: "in",
          clientId: client.id,
          clientName: client.name || name,
          projectId: project?.id ?? null,
          contactName: client.name || name,
          subject,
          body: msg.snippet || text,
          source: "gmail",
          externalId: `gmail-${dedupe}`,
        });
        tasks++;
      } else if (CLIENTS_ONLY_MAILBOXES.includes(account.email)) {
        // info@ is Jordan's personal account — only surface known clients,
        // never manufacture "leads" from his personal mail. hello@ still does.
        continue;
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
          sourceDetail: threadRef,
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

  // Reply sweep: close any open email-driven task whose thread we've since
  // answered (latest message is from us). This keeps "Check your messages" to
  // only the messages that still need a response.
  let closed = 0;
  const openEmailTasks = await prisma.smartTask.findMany({
    where: {
      source: "gmail",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      sourceDetail: { startsWith: "gmail-thread:" },
    },
    select: { id: true, sourceDetail: true },
  });
  for (const t of openEmailTasks) {
    const [, mailbox, threadId] = (t.sourceDetail ?? "").split(":");
    const tk = mailbox ? tokens.get(mailbox) : undefined;
    if (!tk || !threadId) continue;
    if (await threadAlreadyAnswered(threadId, tk)) {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      closed++;
    }
  }
  void closed;

  return { scanned, tasks };
}
