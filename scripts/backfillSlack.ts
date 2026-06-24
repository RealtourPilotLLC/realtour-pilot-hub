import { getSecret } from "@/lib/integrations/connections";
import { logComm } from "@/lib/commLog";

// Backfill Slack history into comms memory using Jordan's USER token (xoxp).
// Channels (#video-editing etc.) = ADMIN tier; Jordan's DMs with Kyle/Kim/Remar
// + group DMs = OWNER only. Dedup on externalId=slack-<channel>-<ts>.
//   npx tsx --env-file=.env scripts/backfillSlack.ts

const ME = "U07D2KJH1JP"; // Jordan
const TARGET_DM_USERS: Record<string, string> = {
  U07SCBTPDC7: "Kyle Smith",
  U0ASP9C1WRK: "Kim",
  U0B7WNGEH0D: "Remar",
};
const CHANNEL_NAME_RE = /video-editing|project-tracker|photo-editing/i;

let token: string | null = null;
async function su(method: string, query: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await r.json()) as any;
    if (j.ok) return j;
    if (j.error === "ratelimited") { await new Promise((res) => setTimeout(res, (attempt + 1) * 2000)); continue; }
    return j; // other errors: return so caller can log
  }
  return { ok: false, error: "ratelimited" };
}

async function allHistory(channel: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 60; i++) {
    const q: Record<string, string> = { channel, limit: "200" };
    if (cursor) q.cursor = cursor;
    const r = await su("conversations.history", q);
    if (!r.ok) { if (i === 0) console.log(`   history error on ${channel}: ${r.error}`); break; }
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

function makeResolver(userMap: Record<string, string>) {
  return (text: string) =>
    (text || "")
      .replace(/<@(U\w+)>/g, (_m, id) => "@" + (userMap[id] || id))
      .replace(/<#C\w+\|([^>]+)>/g, "#$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<(https?:[^>]+)>/g, "$1");
}

async function ingest(channel: string, messages: any[], opts: { minRole: string; source: string; otherName?: string }, resolve: (t: string) => string, userMap: Record<string, string>) {
  let n = 0;
  for (const m of messages) {
    if (m.subtype && m.subtype !== "thread_broadcast") continue; // skip joins/system
    const text = resolve(m.text || "");
    if (!text.trim()) continue;
    const authorName = m.user === ME ? "Jordan" : userMap[m.user] || opts.otherName || m.user || "Slack";
    await logComm({
      channel: "slack",
      direction: m.user === ME ? "out" : "in",
      minRole: opts.minRole,
      contactName: authorName,
      body: text,
      occurredAt: m.ts ? new Date(Number(m.ts) * 1000) : undefined,
      source: opts.source,
      externalId: `slack-${channel}-${m.ts}`,
    });
    n++;
  }
  return n;
}

async function main() {
  token = await getSecret("slack_user");
  if (!token) { console.error("slack_user not connected"); process.exit(1); }
  const auth = await su("auth.test");
  if (!auth.ok) { console.error("auth.test failed:", auth.error); process.exit(1); }

  // user id -> display name
  const u = await su("users.list", { limit: "500" });
  const userMap: Record<string, string> = {};
  for (const m of u.members ?? []) userMap[m.id] = m.profile?.display_name || m.real_name || m.name || m.id;
  const resolve = makeResolver(userMap);

  let totalLogged = 0;

  // 1) CHANNELS (ADMIN tier) — editor + project-tracker coordination.
  const ch = await su("conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" });
  const channels = (ch.channels ?? []).filter((c: any) => c.is_member && CHANNEL_NAME_RE.test(c.name));
  console.log(`Channels to ingest (${channels.length}): ${channels.map((c: any) => "#" + c.name).join(", ")}`);
  for (const c of channels) {
    const msgs = await allHistory(c.id);
    const n = await ingest(c.id, msgs, { minRole: "ADMIN", source: "slack-channel" }, resolve, userMap);
    totalLogged += n;
    console.log(`   #${c.name}: ${msgs.length} messages, ${n} logged`);
  }

  // 2) DIRECT MESSAGES with Kyle/Kim/Remar (OWNER only).
  const ims = await su("conversations.list", { types: "im", limit: "400" });
  const targetIms = (ims.channels ?? []).filter((im: any) => TARGET_DM_USERS[im.user]);
  console.log(`\nDMs to ingest (${targetIms.length}): ${targetIms.map((im: any) => TARGET_DM_USERS[im.user]).join(", ")}`);
  for (const im of targetIms) {
    const who = TARGET_DM_USERS[im.user];
    const msgs = await allHistory(im.id);
    const n = await ingest(im.id, msgs, { minRole: "OWNER", source: "slack-dm", otherName: who }, resolve, userMap);
    totalLogged += n;
    console.log(`   DM ${who}: ${msgs.length} messages, ${n} logged`);
  }

  // 3) GROUP DMs (OWNER only) that include any target editor.
  const mpims = await su("conversations.list", { types: "mpim", limit: "100" });
  for (const g of mpims.channels ?? []) {
    const msgs = await allHistory(g.id);
    const n = await ingest(g.id, msgs, { minRole: "OWNER", source: "slack-groupdm" }, resolve, userMap);
    totalLogged += n;
    console.log(`   group DM ${g.name || g.id}: ${msgs.length} messages, ${n} logged`);
  }

  console.log(`\nDone. ${totalLogged} Slack messages logged into comms memory.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
