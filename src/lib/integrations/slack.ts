import "server-only";
import { getSecret } from "./connections";

// ---------------------------------------------------------------------------
// Slack Web API client. Uses a Bot User OAuth token (xoxb-…) as a Bearer token.
// (An app-level xapp- token cannot call these methods.)
// ---------------------------------------------------------------------------

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

async function slackApi<T = Record<string, unknown>>(
  method: string,
  body: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const t = token ?? (await getSecret("slack"));
  if (!t) throw new SlackError("Slack is not connected.");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({ ok: false, error: "bad_response" }))) as { ok: boolean; error?: string };
  if (!json.ok) throw new SlackError(json.error || `Slack ${method} failed`);
  return json as T;
}

export async function testSlackKey(
  token: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    if (!token.startsWith("xoxb-")) {
      return { ok: false, error: "That isn't a bot token. I need the Bot User OAuth token (starts with xoxb-)." };
    }
    const auth = await slackApi<{ team?: string; url?: string }>("auth.test", {}, token);
    return { ok: true, label: `Slack · ${auth.team || "workspace"}` };
  } catch (e) {
    return { ok: false, error: e instanceof SlackError ? e.message : String(e) };
  }
}

// Validate a USER OAuth token (xoxp-…) — used to read channel + DM history for
// the comms-memory backfill (a bot token cannot read user-to-user DMs).
export async function testSlackUserKey(
  token: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    if (!token.startsWith("xoxp-")) {
      return { ok: false, error: "That isn't a user token. I need the User OAuth Token (starts with xoxp-), not the bot token." };
    }
    const auth = await slackApi<{ team?: string; user?: string }>("auth.test", {}, token);
    return { ok: true, label: `Slack history · ${auth.user || "user"}` };
  } catch (e) {
    return { ok: false, error: e instanceof SlackError ? e.message : String(e) };
  }
}

export type SlackChannel = { id: string; name: string; is_member?: boolean };

export async function slackChannels(): Promise<SlackChannel[]> {
  const res = await slackApi<{ channels: SlackChannel[] }>("conversations.list", {
    types: "public_channel,private_channel",
    limit: 200,
    exclude_archived: true,
  });
  return res.channels ?? [];
}

export async function slackPostMessage(channel: string, text: string): Promise<void> {
  await slackApi("chat.postMessage", { channel, text, unfurl_links: false });
}

// Best-effort notification: never throws (so it can't break the calling flow).
export async function slackNotify(channel: string, text: string): Promise<boolean> {
  try {
    await slackPostMessage(channel, text);
    return true;
  } catch {
    return false;
  }
}

// Resolve a Slack user id → display name, cached ~1h. Uses the USER token
// (the bot lacks users:read). Falls back to the id. Used to label real-time
// Slack messages logged into comms memory.
let slackUserCache: { at: number; map: Record<string, string> } | null = null;
export async function slackUserName(id: string): Promise<string> {
  if (!id) return "";
  const fresh = slackUserCache && Date.now() - slackUserCache.at < 3600_000;
  if (!fresh) {
    try {
      const t = await getSecret("slack_user");
      if (t) {
        const r = await fetch("https://slack.com/api/users.list?limit=500", {
          headers: { Authorization: `Bearer ${t}` }, cache: "no-store",
        });
        const j = (await r.json().catch(() => ({ ok: false }))) as { ok: boolean; members?: { id: string; name?: string; real_name?: string; profile?: { display_name?: string } }[] };
        if (j.ok && j.members) {
          const map: Record<string, string> = {};
          for (const u of j.members) map[u.id] = u.profile?.display_name || u.real_name || u.name || u.id;
          slackUserCache = { at: Date.now(), map };
        }
      }
    } catch { /* fall back to id */ }
  }
  return slackUserCache?.map[id] ?? id;
}

// Resolve a Slack user by email (users.lookupByEmail). Null when the scope is
// missing or the email has no Slack account — callers fall back to the ops
// channel rather than failing the ping.
export async function slackUserByEmail(email: string): Promise<string | null> {
  try {
    const token = await getSecret("slack");
    if (!token) return null;
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    const json = (await res.json()) as { ok?: boolean; user?: { id?: string } };
    return json.ok && json.user?.id ? json.user.id : null;
  } catch { return null; }
}

// DM a Slack user. The bot token has chat:write but NOT im:write (verified
// Aug 24), so conversations.open is unavailable — but posting straight to the
// user id works when the bot's DM with them exists (the long-standing Kyle
// fallback in notify.ts relies on exactly this). Try direct post first;
// attempt conversations.open only as a forward-compat fallback.
export async function slackDmUser(userId: string, text: string): Promise<boolean> {
  try {
    await slackPostMessage(userId, text);
    return true;
  } catch { /* fall through */ }
  try {
    const token = await getSecret("slack");
    if (!token) return false;
    const open = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: userId }),
    });
    const oj = (await open.json()) as { ok?: boolean; channel?: { id?: string } };
    if (!oj.ok || !oj.channel?.id) return false;
    await slackPostMessage(oj.channel.id, text);
    return true;
  } catch { return false; }
}
