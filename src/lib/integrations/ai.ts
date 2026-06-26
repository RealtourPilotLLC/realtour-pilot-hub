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

// Polish a photographer's rough, OUTBOUND note into a clean client text in
// Jordan's voice. Not a reply to anything — the photographer is initiating
// (e.g. "running 10 late traffic" → a warm, professional heads-up). Keep it the
// same intent, just well-said. DRAFT ONLY: returned to the UI for a human to
// review + send. Uses the fast model since it's a light rewrite.
export async function polishOutbound(ctx: {
  rough: string;
  clientName?: string | null;
  propertyAddress?: string | null;
  photographerName?: string | null;
}): Promise<string> {
  const me = (ctx.photographerName || "").trim().split(/\s+/)[0];
  const user = `A photographer on a real estate shoot wants to text the client. Rewrite their rough note as a short, polished, professional text.
${ctx.clientName ? `Client: ${ctx.clientName}` : ""}
${ctx.propertyAddress ? `Property: ${ctx.propertyAddress}` : ""}
${me ? `Sender (the photographer): ${me}, with RealTour Pilot` : "Sender: RealTour Pilot"}

Their rough note:
"""
${ctx.rough.slice(0, 800)}
"""

Keep their intent and any facts (times, delays, requests). Warm but brief, no emojis, no em dashes. Write only the finished text, ready to send.`;
  return anthropic({ model: FAST, system: STYLE, user, maxTokens: 320 });
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

// ---------------------------------------------------------------------------
// Smart Brain task router. Before an inbound message becomes a to-do, this looks
// at the WHOLE picture — the client's orders, the recent conversation, and the
// team's existing open tasks — and decides: is it actionable, which order it is
// about, the right title + priority, whether it duplicates an open task, and what
// to flag. This is what makes task creation cross-check the comms instead of
// reacting to one message in isolation. The DB context is gathered in brain.ts;
// this function is the AI judgment step.
// ---------------------------------------------------------------------------
export type BrainOrder = {
  id: string;
  address: string;
  status: string;
  due: string | null;
  delivered: string | null;
  inRevision: boolean;
};
export type BrainOpenTask = { id: string; type: string; about: string | null; title: string };
export type BrainThreadLine = { who: string; when: string; text: string };
export type BrainContext = {
  channel: string; // text | call | email | slack
  message: string;
  senderName: string;
  senderIsClient: boolean;
  clientName: string | null;
  orders: BrainOrder[];
  openTasks: BrainOpenTask[];
  thread: BrainThreadLine[];
};
export type BrainPriority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";
export type BrainDecision = {
  actionable: boolean;
  projectId: string | null;
  title: string;
  detail: string;
  priority: BrainPriority;
  mergeIntoTaskId: string | null;
  isRevisionRequest: boolean; // client wants ALREADY-DELIVERED work changed/redone
  flags: string[];
  reason: string;
};

export async function decideCommTask(ctx: BrainContext, key?: string): Promise<BrainDecision | null> {
  const apiKey = key ?? (await getSecret("ai"));
  if (!apiKey) return null;
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const ordersBlock = ctx.orders.length
    ? ctx.orders
        .map((o) => `${o.id} | ${o.address} | ${o.status}${o.due ? ` | due ${o.due}` : ""}${o.delivered ? ` | delivered ${o.delivered}` : ""}${o.inRevision ? " | IN REVISION" : ""}`)
        .join("\n")
    : "(no orders on file)";
  const tasksBlock = ctx.openTasks.length
    ? ctx.openTasks.map((t) => `${t.id} | ${t.type} | ${t.about ?? "no order"} | ${t.title}`).join("\n")
    : "(no open to-dos)";
  const threadBlock = ctx.thread.length
    ? ctx.thread.map((l) => `${l.who} (${l.when}): ${l.text}`).join("\n")
    : "(no prior messages on record)";

  const system = `You are the task-routing brain for RealTour Pilot, a real estate media agency. You turn an incoming message into the right internal to-do for the team, cross-checking the client's orders, the conversation so far, and the team's existing open to-dos. You output ONLY strict JSON, no prose. No em dashes, no emojis.`;

  const user = `Today is ${today} (Eastern).

A ${ctx.channel} message came in from ${ctx.senderName} (${ctx.senderIsClient ? "the client" : "not the client — a teammate, photographer, or coordinator"}).

Message:
"""
${ctx.message.slice(0, 1500)}
"""

This client's orders (id | address | status | due | delivered | revision):
${ordersBlock}

Recent conversation (oldest first):
${threadBlock}

Existing OPEN to-dos for this client (id | type | order | title):
${tasksBlock}

Decide how we should handle this message and respond as STRICT JSON only:
{"actionable": <bool>, "projectId": <"order id" or null>, "title": "<short imperative to-do, max 12 words, what WE must do, no client name>", "detail": "<one sentence of context>", "priority": "<URGENT|HIGH|MEDIUM|LOW>", "mergeIntoTaskId": <"task id" or null>, "isRevisionRequest": <bool>, "flags": ["<short note>", ...], "reason": "<one sentence>"}

Rules:
- actionable = false ONLY when the message needs no work from us: a thank-you, an emoji/reaction, "sounds good", a confirmation, or something the conversation shows is already fully handled. Otherwise true.
- projectId: choose the order this message is about, using the addresses and the conversation. Use null only if no order clearly applies. NEVER invent an id; it must be one listed above.
- priority: URGENT if the client is upset, it is time-sensitive, a delivery is overdue, or they explicitly need it now; HIGH for a normal question or request; MEDIUM for minor or non-urgent; LOW for FYI.
- mergeIntoTaskId: if one of the existing OPEN to-dos already covers this same request, return its id so we update it instead of creating a duplicate. It must be one of the ids listed above, else null.
- isRevisionRequest: true ONLY when the client is asking us to CHANGE, FIX, REDO, RESHOOT, or RE-EDIT media we have ALREADY DELIVERED for one of their orders. It is FALSE for scheduling or booking a shoot, availability, pricing/checkout/payment questions, a new order, a general question, a complaint about service, or anything about work not yet delivered. When in doubt, false.
- flags: 0 to 4 short notes worth surfacing (e.g. "delivery 2 days overdue", "we already promised Tuesday", "asking a second time", "client sounds frustrated"). Only include real, grounded notes.
- Base everything ONLY on the data above. Do not invent dates, prices, or promises.`;

  try {
    const raw = await anthropic({ model: SMART, system, user, maxTokens: 450, key: apiKey });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as Partial<BrainDecision>;
    const orderIds = new Set(ctx.orders.map((o) => o.id));
    const taskIds = new Set(ctx.openTasks.map((t) => t.id));
    const priority: BrainPriority = ["URGENT", "HIGH", "MEDIUM", "LOW"].includes(String(p.priority))
      ? (p.priority as BrainPriority)
      : "HIGH";
    const title = (typeof p.title === "string" && p.title.trim() ? p.title.trim() : "Follow up on client message").slice(0, 120);
    return {
      actionable: p.actionable !== false, // default to creating a task if unclear
      projectId: typeof p.projectId === "string" && orderIds.has(p.projectId) ? p.projectId : null,
      title,
      detail: typeof p.detail === "string" ? p.detail.slice(0, 400) : "",
      priority,
      mergeIntoTaskId: typeof p.mergeIntoTaskId === "string" && taskIds.has(p.mergeIntoTaskId) ? p.mergeIntoTaskId : null,
      isRevisionRequest: p.isRevisionRequest === true,
      flags: Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === "string").slice(0, 4) : [],
      reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

// Slack-thread-aware task router. Internal Slack messages often say "she" / "the
// form" with the subject named earlier in the thread, and several messages are
// really steps of ONE workflow. This reads the recent thread (so it can resolve
// who it's about) and the team's open Slack to-dos (so it can COMBINE related
// messages into one task instead of spawning several).
export type SlackCandidate = { id: string; name: string; orders: BrainOrder[]; shoots: string[] };
export type SlackBrainContext = {
  message: string;
  senderName: string;
  thread: { who: string; text: string }[]; // recent channel messages, oldest first
  candidates: SlackCandidate[]; // clients whose full name appears in the thread
  openSlackTasks: { id: string; title: string }[];
};
export type SlackDecision = {
  actionable: boolean;
  title: string;
  detail: string;
  priority: BrainPriority;
  clientId: string | null;
  projectId: string | null;
  mergeIntoTaskId: string | null;
  flags: string[];
  reason: string;
};

export async function decideSlackTask(ctx: SlackBrainContext, key?: string): Promise<SlackDecision | null> {
  const apiKey = key ?? (await getSecret("ai"));
  if (!apiKey) return null;
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const threadBlock = ctx.thread.length
    ? ctx.thread.map((l) => `${l.who}: ${l.text}`).join("\n")
    : "(no earlier messages)";
  const candidatesBlock = ctx.candidates.length
    ? ctx.candidates
        .map((c) => `CLIENT ${c.id} — ${c.name}\n  orders: ${c.orders.map((o) => `${o.id} (${o.address.split(",")[0]}, ${o.status})`).join("; ") || "none"}\n  shoots: ${c.shoots.join("; ") || "none"}`)
        .join("\n")
    : "(no client names found in the thread)";
  const tasksBlock = ctx.openSlackTasks.length
    ? ctx.openSlackTasks.map((t) => `${t.id} | ${t.title}`).join("\n")
    : "(none)";

  const system = `You convert the team's internal Slack messages into clean to-dos for the operations assistant. Several messages about the same job or workflow must become ONE combined to-do, not several. You read the recent thread to understand who and what it is about. Output ONLY strict JSON. No em dashes, no emojis.`;
  const user = `Today is ${today} (Eastern).

New Slack message from ${ctx.senderName}:
"""
${ctx.message.slice(0, 1200)}
"""

Recent Slack conversation in this channel (oldest first):
${threadBlock}

Possible clients this might be about (their full name appeared in the thread; pick the RIGHT one or none):
${candidatesBlock}

Existing OPEN Slack to-dos you could COMBINE this into (id | title):
${tasksBlock}

Decide and respond as STRICT JSON only:
{"actionable": <bool>, "title": "<one clear to-do for the whole thing>", "detail": "<1-2 sentences or short ordered steps>", "priority": "<URGENT|HIGH|MEDIUM|LOW>", "clientId": <"client id" or null>, "projectId": <"order id" or null>, "mergeIntoTaskId": <"task id" or null>, "flags": ["<short note>", ...], "reason": "<one sentence>"}

Rules:
- actionable = false for chatter/acknowledgements ("got it", "thanks", "sounds good") or anything that needs no action from us.
- clientId: ONLY if the THREAD makes clear this message/workflow is about one of the candidate clients above, return that client's id. If it is unclear or none fit, return null. NEVER guess; a wrong client is worse than none.
- mergeIntoTaskId: if this message is part of the SAME effort as one of the existing open Slack to-dos above (the next step of that workflow, or more detail about it), return THAT to-do's id so we combine them into one. It must be one of the ids listed, else null.
- title: describe the whole thing the team must do; if combining, cover both. Name the client only when you are confident from the thread.
- projectId: the order this is about — an id from the CHOSEN client's orders above — or null. NEVER invent an id.
- flags: short notes worth surfacing (e.g. "shoot today", "waiting on the client's scripting form"). Only real, grounded notes.
- priority: URGENT if tied to a shoot today or tomorrow or otherwise time-sensitive; HIGH for a normal action; MEDIUM for minor.
- Base everything ONLY on the data above. Do not invent names, dates, or facts.`;

  try {
    const raw = await anthropic({ model: SMART, system, user, maxTokens: 450, key: apiKey });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as Partial<SlackDecision>;
    const candIds = new Set(ctx.candidates.map((c) => c.id));
    const clientId = typeof p.clientId === "string" && candIds.has(p.clientId) ? p.clientId : null;
    const chosen = clientId ? ctx.candidates.find((c) => c.id === clientId) : undefined;
    const orderIds = new Set(chosen?.orders.map((o) => o.id) ?? []);
    const taskIds = new Set(ctx.openSlackTasks.map((t) => t.id));
    const priority: BrainPriority = ["URGENT", "HIGH", "MEDIUM", "LOW"].includes(String(p.priority)) ? (p.priority as BrainPriority) : "MEDIUM";
    return {
      actionable: p.actionable !== false,
      title: (typeof p.title === "string" && p.title.trim() ? p.title.trim() : "Follow up on Slack message").slice(0, 140),
      detail: typeof p.detail === "string" ? p.detail.slice(0, 600) : "",
      priority,
      clientId,
      projectId: typeof p.projectId === "string" && orderIds.has(p.projectId) ? p.projectId : null,
      mergeIntoTaskId: typeof p.mergeIntoTaskId === "string" && taskIds.has(p.mergeIntoTaskId) ? p.mergeIntoTaskId : null,
      flags: Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === "string").slice(0, 4) : [],
      reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

// Title + detailed recap of one "Ask the Hub" conversation, for the owner-only
// chat-history view. Factual, skimmable; names the real subjects discussed.
export async function summarizeHubConversation(input: {
  transcript: { role: "user" | "assistant"; text: string }[];
}): Promise<{ title: string; summary: string }> {
  const lines = input.transcript
    .filter((t) => t.text && t.text.trim())
    .slice(0, 40)
    .map((t) => `${t.role === "user" ? "Asked" : "Hub"}: ${t.text.trim().slice(0, 700)}`)
    .join("\n");
  const user = `Here is a conversation between a user and "Ask the Hub", an operations assistant for a real estate media agency.
"""
${lines.slice(0, 7000)}
"""

Respond as strict JSON: {"title": "<4 to 7 word topic title>", "summary": "<2 to 4 sentence recap of what they asked and what the hub answered or did, naming real clients/projects/amounts mentioned>"}. No other text. No emojis, no em dashes, no bold.`;
  try {
    const raw = await anthropic({ model: FAST, system: "You output only strict JSON.", user, maxTokens: 300 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { title: "", summary: "" };
    const parsed = JSON.parse(m[0]) as { title?: string; summary?: string };
    return { title: (parsed.title ?? "").slice(0, 80), summary: (parsed.summary ?? "").slice(0, 800) };
  } catch {
    return { title: "", summary: "" };
  }
}

// Synthesize a creative-safe "working profile" of a client from everything we
// know — comms, shoot debriefs, revision history, brand notes. Written FOR the
// photographers/editors who'll work with them, so it must stay appropriate.
export type ClientProfileInsights = {
  summary: string;
  touchLevel: "high" | "medium" | "low" | "";
  workingStyle: string;
  communication: string;
  revisions: { summary: string; commonTypes: string[] };
  brandStyle: string;
  shootNotes: string[];
  aboutThem: string[];
  dos: string[];
  donts: string[];
};
export async function synthesizeClientProfile(input: {
  name: string;
  company?: string | null;
  segment?: string | null;
  socialPlan?: string | null;
  stats: { totalOrders: number; revisions: number; inboundMsgs: number };
  sampleOrders: string[];
  notes: { preferences?: string | null; editing?: string | null; general?: string | null; brandColors?: string | null };
  comms: { who: string; when: string; text: string }[];
  activities: string[];
  feedback: { rating?: number | null; sentiment?: string | null; text: string }[];
}): Promise<ClientProfileInsights | null> {
  const commsBlock = input.comms.length
    ? input.comms.map((c) => `${c.who} (${c.when}): ${c.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")
    : "(no messages on record)";
  const actsBlock = input.activities.length ? input.activities.map((a) => `- ${a.slice(0, 300)}`).join("\n") : "(none)";
  const fbBlock = input.feedback.length
    ? input.feedback.map((f) => `- ${f.rating ? f.rating + "/5 " : ""}${f.sentiment ?? ""}: ${f.text.slice(0, 240)}`).join("\n")
    : "(none)";
  const notesBlock = [
    input.notes.preferences ? `Working preferences: ${input.notes.preferences}` : null,
    input.notes.editing ? `Editing preferences: ${input.notes.editing}` : null,
    input.notes.general ? `General notes: ${input.notes.general}` : null,
    input.notes.brandColors ? `Brand colors: ${input.notes.brandColors}` : null,
  ].filter(Boolean).join("\n") || "(none on file)";

  const system = `You write an internal "working profile" of a real estate agent (our client) for the CREATIVE TEAM — the photographers and editors who will shoot and edit for them. The reader needs to quickly know who they're working with.

It MUST be appropriate for a creative to read. Focus on: how they are to work with, their communication and revision habits, their brand and aesthetic taste, shoot logistics/preferences, and respectful rapport notes. NEVER include pricing, fees, payments, balances, internal finances, margins, business strategy, or anything unkind or gossipy. If you have nothing solid for a section, leave it brief or empty rather than inventing. Ground every statement ONLY in the data provided. Warm, specific, professional. No em dashes, no emojis, no bold. Output ONLY strict JSON.`;

  const user = `Client: ${input.name}${input.company ? ` (${input.company})` : ""}
Relationship: ${input.segment ?? "unknown"}${input.socialPlan ? ` · social plan ${input.socialPlan}` : ""}
By the numbers: ${input.stats.totalOrders} orders, ${input.stats.revisions} revision request(s), ${input.stats.inboundMsgs} inbound messages on record.
Recent properties: ${input.sampleOrders.slice(0, 8).join("; ") || "n/a"}

Manual notes on file:
${notesBlock}

Recent messages (to/from them; "Us" = our team):
${commsBlock}

Shoot debriefs, requests, and timeline notes:
${actsBlock}

Feedback they've given:
${fbBlock}

Write the profile as STRICT JSON only:
{"summary": "<2-4 sentence narrative of who they are to work with>", "touchLevel": "<high|medium|low>", "workingStyle": "<1-2 sentences>", "communication": "<how they communicate: channel, pace, tone>", "revisions": {"summary": "<how often / how particular about revisions>", "commonTypes": ["<recurring kinds of changes they ask for>"]}, "brandStyle": "<their look/aesthetic/brand taste>", "shootNotes": ["<logistics, access, things they mention about shoots>"], "aboutThem": ["<appropriate rapport notes>"], "dos": ["<tips for the creative>"], "donts": ["<things to avoid>"]}

Rules:
- touchLevel: high = frequent contact / particular / many revisions; low = hands-off / rarely asks for changes.
- commonTypes / shootNotes / aboutThem / dos / donts: 0 to 5 short bullets each, only real ones from the data.
- Do not invent facts, dates, or preferences not supported above. Empty arrays and short strings are fine when the signal is thin.`;

  try {
    const raw = await anthropic({ model: SMART, system, user, maxTokens: 900 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as Partial<ClientProfileInsights> & { revisions?: { summary?: string; commonTypes?: unknown } };
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []);
    const touch = ["high", "medium", "low"].includes(String(p.touchLevel)) ? (p.touchLevel as "high" | "medium" | "low") : "";
    return {
      summary: typeof p.summary === "string" ? p.summary.slice(0, 1000) : "",
      touchLevel: touch,
      workingStyle: typeof p.workingStyle === "string" ? p.workingStyle.slice(0, 500) : "",
      communication: typeof p.communication === "string" ? p.communication.slice(0, 500) : "",
      revisions: {
        summary: typeof p.revisions?.summary === "string" ? p.revisions.summary.slice(0, 500) : "",
        commonTypes: arr(p.revisions?.commonTypes),
      },
      brandStyle: typeof p.brandStyle === "string" ? p.brandStyle.slice(0, 500) : "",
      shootNotes: arr(p.shootNotes),
      aboutThem: arr(p.aboutThem),
      dos: arr(p.dos),
      donts: arr(p.donts),
    };
  } catch {
    return null;
  }
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
