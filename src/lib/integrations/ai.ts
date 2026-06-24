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

// Low-level POST to the Messages API with transient-failure retry (529/429/5xx/
// network). Returns the parsed JSON response (caller pulls text / tool_use out).
// Shared by the simple one-shot helper and the tool-using agent loop.
type AnthropicResponse = {
  content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  error?: { message?: string };
};
async function callMessages(body: Record<string, unknown>, key: string): Promise<AnthropicResponse> {
  const payload = JSON.stringify(body);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1200));
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: payload,
        cache: "no-store",
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error("Network error reaching the AI.");
      continue; // network blip → retry
    }
    const json = (await res.json().catch(() => ({}))) as AnthropicResponse;
    if (res.ok) return json;
    lastErr = new Error(json.error?.message || `Anthropic ${res.status}`);
    const retryable = res.status === 429 || res.status === 529 || (res.status >= 500 && res.status < 600);
    if (!retryable) throw lastErr;
  }
  if (lastErr && /overload/i.test(lastErr.message)) {
    throw new Error("The AI is briefly overloaded. Please try again in a moment.");
  }
  throw lastErr ?? new Error("The AI request failed. Please try again.");
}

async function anthropic(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  key?: string;
}): Promise<string> {
  const key = opts.key ?? (await getSecret("ai"));
  if (!key) throw new Error("AI is not connected.");
  const json = await callMessages(
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 600,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    },
    key,
  );
  return (json.content?.find((b) => b.type === "text")?.text ?? json.content?.[0]?.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Tool-using agent ("Ask the Hub"). Runs a multi-step loop: Claude calls
// read-only data tools, we execute them and feed the results back, until it
// produces a final answer. The caller supplies the tool schemas + an executor.
// ---------------------------------------------------------------------------
export type HubTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type HubToolCall = { name: string; input: Record<string, unknown> };

export async function runHubAgent(opts: {
  system: string;
  history?: { role: "user" | "assistant"; content: string }[];
  question: string;
  tools: HubTool[];
  exec: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  model?: string;
  maxSteps?: number;
}): Promise<{ answer: string; toolsUsed: HubToolCall[] }> {
  const key = await getSecret("ai");
  if (!key) throw new Error("AI is not connected.");
  const model = opts.model ?? SMART;
  const maxSteps = opts.maxSteps ?? 6;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.question },
  ];
  const toolsUsed: HubToolCall[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const json = await callMessages(
      { model, max_tokens: 1600, system: opts.system, tools: opts.tools, messages },
      key,
    );
    const blocks = json.content ?? [];
    messages.push({ role: "assistant", content: blocks });

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (json.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "I couldn't find an answer to that.", toolsUsed };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      toolsUsed.push({ name: tu.name!, input });
      let out: unknown;
      try {
        out = await opts.exec(tu.name!, input);
      } catch (e) {
        out = { error: e instanceof Error ? e.message : String(e) };
      }
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(out ?? null).slice(0, 14000),
      });
    }
    messages.push({ role: "user", content: results });
  }

  // Out of steps — force a final answer with no more tool calls.
  const finalJson = await callMessages(
    {
      model,
      max_tokens: 1200,
      system: `${opts.system}\n\nYou have gathered enough data. Give your best answer now from what you have; do not request more tools.`,
      messages,
    },
    key,
  );
  const text = (finalJson.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return {
    answer: text || "I gathered some data but couldn't compose a full answer. Try narrowing the question.",
    toolsUsed,
  };
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

// A single turn in a conversation. role: who said it. sender: optional speaker
// label for group threads (e.g. "Jane (buyer agent)").
export type ConvoTurn = { role: "client" | "us"; text: string; at?: string | null; sender?: string | null };

// Draft a reply WITH the full conversation in context, plus who the client is and
// what work they have in flight. This is the "smart suggested reply" — it reads
// the thread the way a person would before answering, so it can reference what
// was already said, pick up an open question, and match the relationship.
export async function draftReplyWithContext(ctx: {
  channel: string; // text | email
  clientName?: string | null;
  segment?: string | null; // e.g. vip, regular, never_converted
  socialPlan?: string | null; // monthly social content plan, if any
  propertyAddress?: string | null;
  projects?: { title: string; status: string }[]; // recent jobs + stage
  transcript: ConvoTurn[]; // oldest first
  isGroup?: boolean;
  note?: string | null;
  availability?: string | null; // real open shoot dates (from Aryeo scheduling)
}): Promise<string> {
  const turns = ctx.transcript.filter((t) => t.text && t.text.trim()).slice(-24);
  const lines = turns.map((t) => {
    const who = t.role === "us" ? "Us" : t.sender ? `Client (${t.sender})` : "Client";
    return `${who}: ${t.text!.trim().slice(0, 600)}`;
  });
  // The last client turn is what we're replying to; spell it out so the model
  // anchors on it rather than the most recent line (which might be ours).
  const lastClient = [...turns].reverse().find((t) => t.role === "client");

  const profile = [
    ctx.clientName ? `Client: ${ctx.clientName}` : null,
    ctx.segment ? `Relationship: ${segmentLabel(ctx.segment)}` : null,
    ctx.socialPlan ? `On a monthly social content plan: ${ctx.socialPlan}` : null,
    ctx.propertyAddress ? `Property in question: ${ctx.propertyAddress}` : null,
    ctx.projects && ctx.projects.length
      ? `Recent jobs: ${ctx.projects.slice(0, 6).map((p) => `${p.title} (${prettyStatus(p.status)})`).join("; ")}`
      : null,
    ctx.note ? `Note: ${ctx.note}` : null,
    ctx.availability ? `Our open shoot availability (real, from our scheduling calendar): ${ctx.availability}` : null,
  ].filter(Boolean).join("\n");

  const user = `You are drafting our team's next ${ctx.channel === "email" ? "email" : "text"} reply in an ongoing${
    ctx.isGroup ? " GROUP" : ""
  } conversation. Read the whole thread first, then answer the client's most recent message.

${profile ? `Who you're talking to:\n${profile}\n` : ""}
Conversation so far (oldest first):
"""
${lines.join("\n")}
"""
${lastClient ? `\nThe message to reply to:\n"""\n${lastClient.text!.trim().slice(0, 1200)}\n"""` : ""}

Rules:
- Use the conversation for context. If a question was already answered or a time already proposed, do not repeat it; move things forward.
- Only state facts present in the thread or profile above. Do NOT invent dates, prices, delivery times, or commitments. If you need info we have not stated, ask for it or say we will confirm.
- If the client is asking about availability / when we can shoot and "open shoot availability" is listed above, offer 2-4 of those exact open dates and ask which works (you MAY use those dates — they're real). Never offer a date that isn't listed.
- If the latest message needs no reply (a thank-you, a confirmation, an emoji), respond with exactly: NO_REPLY_NEEDED
${ctx.isGroup ? "- This is a group thread; address the group naturally, not one person.\n" : ""}
Write only the reply, ready to copy and send. No preamble, no options, no signature unless it reads like a full email.`;
  return anthropic({ model: SMART, system: STYLE, user, maxTokens: 500 });
}

function segmentLabel(seg: string): string {
  const map: Record<string, string> = {
    vip: "VIP / top client — treat with extra care",
    heavy: "high-volume repeat client",
    regular: "regular repeat client",
    casual_repeat: "occasional repeat client",
    one_timer: "has booked once",
    never_converted: "lead / has not booked yet",
  };
  return map[seg] ?? seg;
}
function prettyStatus(s: string): string {
  return s.toLowerCase().replace(/_/g, " ");
}

// Turn an inbound message into a specific, actionable to-do for Kyle.
// A plain-English recap of one operations day for the owner, built from the
// day's completed tasks, deliveries, and shoots. Factual + skimmable.
export async function summarizeWorkday(input: {
  date: string;
  tasks: { type: string; title: string }[];
  deliveries: string[];
  shoots: { title: string; time: string; photographer?: string | null }[];
}): Promise<string> {
  const user = [
    `Date: ${input.date}`,
    input.shoots.length
      ? `Shoots (${input.shoots.length}): ${input.shoots.map((s) => `${s.title} at ${s.time}${s.photographer ? ` — ${s.photographer}` : ""}`).join("; ")}`
      : "Shoots: none",
    input.deliveries.length ? `Delivered (${input.deliveries.length}): ${input.deliveries.join("; ")}` : "Delivered: none",
    `Completed tasks (${input.tasks.length}): ${input.tasks.map((t) => `${t.type}: ${t.title}`).join(" | ").slice(0, 4000)}`,
  ].join("\n");
  const system = `You write a concise daily operations recap for the owner of a real estate media agency. Summarize what happened that day in 3 to 6 short sentences (or tight bullets), grouped by theme: shoots, editing and QC, deliveries, and client communications. Name notable clients and properties. Be specific and factual; skip filler. No emojis, no em dashes, no bold.`;
  return anthropic({ model: FAST, system, user, maxTokens: 500 });
}

export async function messageToTodo(ctx: {
  channel: string;
  clientName?: string | null;
  propertyAddress?: string | null;
  message: string;
}): Promise<{ title: string; detail: string } | null> {
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const user = `Today is ${today}. An inbound ${ctx.channel} came in${ctx.clientName ? ` from ${ctx.clientName}` : ""}${
    ctx.propertyAddress ? ` about ${ctx.propertyAddress}` : ""
  }. Summarize it into ONE specific action item for our assistant.

Rules:
- Use ONLY facts stated in the message. Do NOT invent dates, months, or a "content period" — if the message doesn't name one, don't add one.
- If the message is already resolved/answered (a confirmation, a thank-you, "all set"), title it "No action needed".
- The assistant works remotely and does NOT attend, drive to, or shoot anything. Never write "attend", "go to", "show up at", "shoot", or "cover" as the action. For shoot logistics the action is to confirm/coordinate/notify the photographer or client.
- If the message is just an automated system notification or appointment reminder (no human asking for anything), title it "No action needed".

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
