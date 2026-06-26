import "server-only";
import { getSecret } from "./connections";
import { logComm } from "@/lib/commLog";

// Keep Slack comms memory fresh. A USER token can't receive webhooks, so the
// hourly cron calls this to pull RECENT history (default last 48h) for the
// editor channels + Jordan's DMs with Kyle/Kim/Remar. Idempotent (logComm
// dedups on externalId=slack-<channel>-<ts>), so overlapping windows are safe.

const ME = "U07D2KJH1JP"; // Jordan
const TARGET_DM_USERS: Record<string, string> = {
  U07SCBTPDC7: "Kyle Smith",
  U0ASP9C1WRK: "Kim",
  U0B7WNGEH0D: "Remar",
};
const CHANNEL_NAME_RE = /video-editing|project-tracker|photo-editing/i;

// Instruction detection (shared with the real-time Slack webhook).
const INSTRUCTION_RE =
  /\b(can you|could you|do you mind|please|reach out|check with|let them know|follow up|make sure|send|add|upload|request a revision|schedule|confirm|call|email|fix|need|re-?do|redo|re-?edit)\b/i;
const IGNORE_RE = /^(thanks|thank you|ok|okay|sounds good|got it|yep|yes|no problem|np|👍|🙏|done)\.?$/i;

// Turn a Slack message into a to-do when it reads like an action item. AI writes
// a clean title/detail and judges whether it's actually actionable (skips
// chatter). Deduped on the message ts. Used by the webhook AND the poll.
export async function maybeCreateSlackTask(opts: { text: string; ts: string; channel: string; senderName?: string }): Promise<boolean> {
  const { prisma } = await import("@/lib/prisma");
  const text = opts.text.trim();
  if (text.length < 6 || IGNORE_RE.test(text) || !INSTRUCTION_RE.test(text)) return false;
  const dedupeKey = `slack-${opts.ts}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey } })) return false;

  const { matchProjectFromText } = await import("@/lib/matchProject");
  const match = await matchProjectFromText(text);

  let title = text.length > 90 ? text.slice(0, 88) + "…" : text;
  let detail = text;
  let priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
  let projectId = match?.id ?? null;
  let clientId = match?.clientId ?? null;
  let propertyAddress = match?.title ?? null;
  let usedBrain = false;

  // Route through the thread-aware Smart Brain: it reads the recent Slack thread
  // (so "she" / "the form" resolve to the right client even when this message
  // doesn't name them), knows that client's shoots (today/upcoming), and COMBINES
  // this into an existing open Slack to-do when it's the same workflow.
  try {
    const { routeSlackTask } = await import("@/lib/brain");
    const d = await routeSlackTask({ message: text, ts: opts.ts, channel: opts.channel, senderName: opts.senderName });
    if (d) {
      if (!d.actionable) return false;
      if (d.mergeIntoTaskId) {
        const { mergeIntoExistingTask } = await import("@/lib/tasks");
        const merged = await mergeIntoExistingTask(d.mergeIntoTaskId, {
          title: d.title, detail: d.detail, priority: d.priority,
          projectId: d.projectId ?? undefined, clientId: d.clientId ?? undefined, snippet: text,
        });
        // Merge refused (e.g. it pointed at a production task) → fall through and
        // create a fresh Slack to-do below instead of dropping the message.
        if (merged) return true;
      }
      title = d.title;
      detail = d.detail || text;
      priority = d.priority;
      if (d.projectId) projectId = d.projectId;
      if (d.clientId) clientId = d.clientId;
      usedBrain = true;
    }
  } catch { /* fall through to single-message helper */ }

  // Fallback (no client/project match, or brain unavailable): single-message to-do.
  if (!usedBrain) {
    try {
      if (await getSecret("ai")) {
        const { messageToTodo } = await import("@/lib/integrations/ai");
        const todo = await messageToTodo({
          channel: "Slack message",
          clientName: opts.senderName ?? null,
          propertyAddress: match?.title ?? null,
          message: text,
        });
        if (todo) {
          if (/no action needed/i.test(todo.title)) return false;
          title = todo.title;
          detail = todo.detail || text;
        }
      }
    } catch { /* fall back to raw text */ }
  }

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const summary = (usedBrain && detail && detail !== text)
    ? detail
    : `${opts.senderName || "A teammate"} in Slack: “${text.slice(0, 220)}”`;
  await prisma.smartTask.create({
    data: {
      taskType: "internal_instruction",
      title,
      summary: summary.slice(0, 500),
      description: detail,
      reasonCreated: match ? `From Slack — re: ${match.title}` : `From Slack — ${opts.senderName || "team"}`,
      checklist: JSON.stringify(["Do the requested action", "Reply in Slack when done"]),
      source: "slack",
      sourceDetail: opts.channel ? `channel ${opts.channel} · ${opts.ts}` : opts.ts,
      priority,
      dueAt: new Date(Date.now() + 6 * 3600_000),
      ownerId: kyle?.id ?? null,
      projectId,
      clientId,
      propertyAddress,
      dedupeKey,
    },
  });
  return true;
}

async function su(token: string, method: string, query: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const j = (await r.json().catch(() => ({ ok: false }))) as any;
    if (j.ok) return j;
    if (j.error === "ratelimited") { await new Promise((res) => setTimeout(res, (attempt + 1) * 1500)); continue; }
    return j;
  }
  return { ok: false, error: "ratelimited" };
}

function resolver(userMap: Record<string, string>) {
  return (text: string) =>
    (text || "")
      .replace(/<@(U\w+)>/g, (_m, id) => "@" + (userMap[id] || id))
      .replace(/<#C\w+\|([^>]+)>/g, "#$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<(https?:[^>]+)>/g, "$1");
}

async function recentHistory(token: string, channel: string, oldest: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 12; i++) {
    const q: Record<string, string> = { channel, limit: "200", oldest };
    if (cursor) q.cursor = cursor;
    const r = await su(token, "conversations.history", q);
    if (!r.ok) break;
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function ingest(channel: string, messages: any[], minRole: string, source: string, otherName: string | undefined, resolve: (t: string) => string, userMap: Record<string, string>): Promise<number> {
  let n = 0;
  for (const m of messages) {
    if (m.subtype && m.subtype !== "thread_broadcast") continue;
    const text = resolve(m.text || "");
    if (!text.trim()) continue;
    const senderName = m.user === ME ? "Jordan" : userMap[m.user] || otherName || m.user || "Slack";
    const created = await logComm({
      channel: "slack",
      direction: m.user === ME ? "out" : "in",
      minRole,
      contactName: senderName,
      body: text,
      occurredAt: m.ts ? new Date(Number(m.ts) * 1000) : undefined,
      source,
      externalId: `slack-${channel}-${m.ts}`,
    });
    n++;
    // Only newly-seen messages become tasks (backfilled history won't re-trigger).
    if (created) {
      try { await maybeCreateSlackTask({ text, ts: m.ts, channel, senderName }); } catch { /* non-fatal */ }
    }
  }
  return n;
}

export async function syncSlackHistory(opts: { sinceHours?: number } = {}): Promise<{ logged: number; skipped?: boolean }> {
  const token = await getSecret("slack_user");
  if (!token) return { logged: 0, skipped: true };
  const auth = await su(token, "auth.test");
  if (!auth.ok) return { logged: 0, skipped: true };

  const oldest = String(Math.floor((Date.now() - (opts.sinceHours ?? 48) * 3600_000) / 1000));
  const u = await su(token, "users.list", { limit: "500" });
  const userMap: Record<string, string> = {};
  for (const m of u.members ?? []) userMap[m.id] = m.profile?.display_name || m.real_name || m.name || m.id;
  const resolve = resolver(userMap);

  let logged = 0;
  // Channels (ADMIN).
  const ch = await su(token, "conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" });
  for (const c of (ch.channels ?? []).filter((c: any) => c.is_member && CHANNEL_NAME_RE.test(c.name))) {
    logged += await ingest(c.id, await recentHistory(token, c.id, oldest), "ADMIN", "slack-channel", undefined, resolve, userMap);
  }
  // DMs (OWNER).
  const ims = await su(token, "conversations.list", { types: "im", limit: "400" });
  for (const im of (ims.channels ?? []).filter((im: any) => TARGET_DM_USERS[im.user])) {
    logged += await ingest(im.id, await recentHistory(token, im.id, oldest), "OWNER", "slack-dm", TARGET_DM_USERS[im.user], resolve, userMap);
  }
  // Group DMs (OWNER).
  const mpims = await su(token, "conversations.list", { types: "mpim", limit: "100" });
  for (const g of mpims.channels ?? []) {
    logged += await ingest(g.id, await recentHistory(token, g.id, oldest), "OWNER", "slack-groupdm", undefined, resolve, userMap);
  }
  return { logged };
}
