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

// Resolve a Slack user by email (users.lookupByEmail), keeping Slack's own
// error code. The People page's "Find on Slack" (Sep 15) has to tell "the bot
// token lacks users:read.email" (missing_scope → re-install the app) apart
// from "no Slack account on that email" (users_not_found → paste the member
// ID by hand); a bare null said neither.
export type SlackLookup = { ok: true; id: string } | { ok: false; error: string };
export async function slackLookupByEmail(email: string): Promise<SlackLookup> {
  let botError = "unreachable";
  try {
    const token = await getSecret("slack");
    if (!token) botError = "not_connected";
    else {
      const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; user?: { id?: string } };
      if (json.ok && json.user?.id) return { ok: true, id: json.user.id };
      botError = json.error || "lookup_failed";
    }
  } catch { botError = "unreachable"; }
  // Sep 15: the bot token lacks users:read.email, but Jordan's own user token
  // (slack_user, the comms-memory one) reads the workspace directory — so a
  // bot refusal falls through to that list before anyone is told to re-
  // install. A readable list that has no such email is the honest answer
  // (users_not_found); an unreadable list keeps the bot's own error.
  const ws = await slackWorkspaceUsers();
  if (!ws.ok) return { ok: false, error: botError };
  // A directory with no emails at all (the user token lacks users:read.email
  // too — the case on Sep 15) cannot say "no such account"; the bot's own
  // error stands so the re-install advice is the one the office sees.
  if (!ws.users.some((u) => !!u.email)) return { ok: false, error: botError };
  const wanted = email.trim().toLowerCase();
  const hit = ws.users.find((u) => u.email?.toLowerCase() === wanted);
  return hit ? { ok: true, id: hit.id } : { ok: false, error: "users_not_found" };
}

// The workspace's HUMANS — id, real name, display name, email — read with
// the USER token (users.list; the bot token has no users:read). Cached ten
// minutes per lambda: People's "Sync Slack IDs" and the by-email lookup both
// call it, and the directory changes a few times a year. Bots, deleted
// accounts and Slackbot are dropped so a name match can never land on an
// integration. Read-only; never throws.
export type SlackWorkspaceUser = { id: string; name: string; displayName: string; email?: string };
let workspaceCache: { at: number; users: SlackWorkspaceUser[] } | null = null;
export async function slackWorkspaceUsers(): Promise<{ ok: true; users: SlackWorkspaceUser[] } | { ok: false; error: string }> {
  if (workspaceCache && Date.now() - workspaceCache.at < 10 * 60_000) return { ok: true, users: workspaceCache.users };
  try {
    const token = await getSecret("slack_user");
    if (!token) return { ok: false, error: "user_token_not_connected" };
    type Member = {
      id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean;
      profile?: { display_name?: string; real_name?: string; email?: string };
    };
    const users: SlackWorkspaceUser[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const j = (await r.json().catch(() => ({ ok: false, error: "bad_response" }))) as {
        ok: boolean; error?: string; members?: Member[]; response_metadata?: { next_cursor?: string };
      };
      if (!j.ok) return { ok: false, error: j.error || "users_list_failed" };
      for (const m of j.members ?? []) {
        if (m.deleted || m.is_bot || m.is_app_user || m.id === "USLACKBOT") continue;
        users.push({
          id: m.id,
          name: (m.real_name || m.profile?.real_name || m.name || "").trim(),
          displayName: (m.profile?.display_name || "").trim(),
          ...(m.profile?.email ? { email: m.profile.email.trim() } : {}),
        });
      }
      cursor = j.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    workspaceCache = { at: Date.now(), users };
    return { ok: true, users };
  } catch { return { ok: false, error: "unreachable" }; }
}

// Null when the scope is missing or the email has no Slack account — callers
// fall back to the ops channel rather than failing the ping.
export async function slackUserByEmail(email: string): Promise<string | null> {
  const r = await slackLookupByEmail(email);
  return r.ok ? r.id : null;
}

// What the bot token can actually DO. Slack returns the granted scopes on
// every auth.test response (the x-oauth-scopes header) — read-only, no scope
// needed to ask. Null when Slack is not connected or unreachable. Backs the
// Connections card (Sep 15) so the re-install click is informed: the People
// page's "Find on Slack" needs users:read + users:read.email, and the token
// installed today carries neither.
export async function slackBotScopes(): Promise<{ scopes: string[]; team: string | null } | null> {
  try {
    const token = await getSecret("slack");
    if (!token) return null;
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean; team?: string };
    if (!json.ok) return null;
    const header = res.headers.get("x-oauth-scopes") ?? "";
    const scopes = header.split(",").map((s) => s.trim()).filter(Boolean);
    return { scopes, team: json.team ?? null };
  } catch { return null; }
}

// DM a Slack user. The bot token has chat:write but NOT im:write (verified
// Aug 24), so conversations.open is unavailable — but posting straight to the
// user id works when the bot's DM with them exists (the long-standing Kyle
// fallback in notify.ts relies on exactly this). Try direct post first;
// attempt conversations.open only as a forward-compat fallback.
export async function slackDmUser(userId: string, text: string): Promise<boolean> {
  return (await slackDmUserDetailed(userId, text)).ok;
}

// The same DM, keeping Slack's own words on failure — People's "Send test
// DM" (Sep 15) has to show the office WHY a teammate can't be reached:
// "channel_not_found" on the direct post plus "missing_scope" on the open is
// the signature of a person the bot has never DMed on a token without
// im:write, and the fix is a re-install, not a different member ID.
export type SlackDmResult = { ok: true } | { ok: false; error: string };
export async function slackDmUserDetailed(userId: string, text: string): Promise<SlackDmResult> {
  let postError: string;
  try {
    await slackPostMessage(userId, text);
    return { ok: true };
  } catch (e) {
    postError = e instanceof Error ? e.message : String(e);
  }
  try {
    const token = await getSecret("slack");
    if (!token) return { ok: false, error: `chat.postMessage → ${postError}; Slack is not connected` };
    const open = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: userId }),
    });
    const oj = (await open.json()) as { ok?: boolean; error?: string; channel?: { id?: string } };
    if (!oj.ok || !oj.channel?.id) {
      return { ok: false, error: `chat.postMessage → ${postError}; conversations.open → ${oj.error || "no channel"}` };
    }
    await slackPostMessage(oj.channel.id, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `chat.postMessage → ${postError}; conversations.open → ${e instanceof Error ? e.message : String(e)}` };
  }
}
