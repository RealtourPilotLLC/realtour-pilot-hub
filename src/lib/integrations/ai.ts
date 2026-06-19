import "server-only";
import { getSecret } from "./connections";

// ---------------------------------------------------------------------------
// AI assistant (Anthropic / Claude). Powers two things, both DRAFT-ONLY — the
// hub never sends anything itself:
//   • draftReply()   — a suggested reply in Jordan's voice, for Kyle to send
//   • messageToTodo() — turns an inbound message into a specific to-do
// The API key is stored encrypted as the "ai" connection.
// ---------------------------------------------------------------------------

const FAST = "claude-haiku-4-5-20251001";
const SMART = "claude-sonnet-4-6";

export function aiConfigured(key?: string) {
  return Boolean(key);
}

// Jordan's house style — kept tight so it steers tone without bloating tokens.
const STYLE = `You write as the RealTour Pilot team (a real estate media agency). Voice: warm, confident, accountable, solution-first. Never pushy or defensive.
HARD RULES: never use an em dash or double dash. No bold. No emojis. Do not use the words "hidden gem", "gem", "move the needle", "break the mold", or "deal breaker".
Prefer "investment" over "price", "fully committed" over "booked", "thank you for your patience" over "sorry". Use "we" not "I". Acknowledge once, take ownership, give the clear next step, then stop. Leave room for recourse ("let us know if you need anything"). Keep texts short and copy-paste ready. When scheduling, offer two specific options with exact times. Sign-off only if it reads like a full email, as: "In the Spirit of Success, Jordan Spackman".`;

async function anthropic(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  key?: string;
}): Promise<string> {
  const key = opts.key ?? (await getSecret("ai"));
  if (!key) throw new Error("AI is not connected.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 600,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    content?: { text?: string }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message || `Anthropic ${res.status}`);
  return (json.content?.[0]?.text ?? "").trim();
}

export async function testAiKey(
  key: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    await anthropic({ model: FAST, system: "Reply with OK.", user: "ping", maxTokens: 5, key });
    return { ok: true, label: "Claude (Anthropic)" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Draft a reply in Jordan's voice. Returns the suggested text only.
export async function draftReply(ctx: {
  channel: string; // text | call | email | slack
  clientName?: string | null;
  propertyAddress?: string | null;
  message: string;
  note?: string | null;
}): Promise<string> {
  const user = `Draft a ${ctx.channel === "email" ? "short email" : "short text"} reply on behalf of our team.
${ctx.clientName ? `Client: ${ctx.clientName}` : ""}
${ctx.propertyAddress ? `Property: ${ctx.propertyAddress}` : ""}
${ctx.note ? `Context: ${ctx.note}` : ""}

Their message:
"""
${ctx.message.slice(0, 1500)}
"""

Write only the reply, ready to copy and send. Do not add notes or options.`;
  return anthropic({ model: SMART, system: STYLE, user, maxTokens: 500 });
}

// Turn an inbound message into a specific, actionable to-do for Kyle.
export async function messageToTodo(ctx: {
  channel: string;
  clientName?: string | null;
  propertyAddress?: string | null;
  message: string;
}): Promise<{ title: string; detail: string } | null> {
  const user = `An inbound ${ctx.channel} came in${ctx.clientName ? ` from ${ctx.clientName}` : ""}${
    ctx.propertyAddress ? ` about ${ctx.propertyAddress}` : ""
  }. Summarize it into ONE specific action item for our assistant.

Message:
"""
${ctx.message.slice(0, 1500)}
"""

Respond as strict JSON: {"title": "<imperative action, max 8 words>", "detail": "<1 sentence on what they need>"}. No other text.`;
  try {
    const raw = await anthropic({ model: FAST, system: "You output only strict JSON.", user, maxTokens: 200 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; detail?: string };
    if (!parsed.title) return null;
    return { title: parsed.title.slice(0, 80), detail: (parsed.detail ?? "").slice(0, 240) };
  } catch {
    return null;
  }
}
