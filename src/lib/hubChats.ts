import "server-only";
import { prisma } from "@/lib/prisma";
import { PALETTE } from "@/lib/palette";

// ---------------------------------------------------------------------------
// "Ask the Hub" conversation memory + analytics. Every chat turn is persisted so
// the owner can review what the team asks the brain (and how it answered), and
// see which kinds of questions dominate. Question categories are derived for free
// from which tools the agent called — no extra AI cost on the hot path.
// ---------------------------------------------------------------------------

export type HubCategoryKey =
  | "projects" | "scheduling" | "clients" | "billing" | "tasks"
  | "comms" | "drafting" | "business" | "general";

// Label, palette color, and a plain-English description shown beside each slice.
export const CATEGORY_META: Record<HubCategoryKey, { label: string; color: string; description: string }> = {
  projects:   { label: "Projects & status", color: PALETTE.blue,   description: "Shoot/order lookups: what's in revision, delivered, due, or what happened on a day." },
  scheduling: { label: "Schedule",          color: PALETTE.teal,   description: "What's shooting when, who's assigned, and calendar/availability questions." },
  clients:    { label: "Clients",           color: PALETTE.indigo, description: "Client profiles, segment/tier, spend, preferences, and CRM lookups." },
  billing:    { label: "Billing & AR",      color: PALETTE.gold,   description: "Who owes money, outstanding invoices, and accounts receivable." },
  tasks:      { label: "Tasks & to-dos",    color: PALETTE.green,  description: "Creating to-dos from chat or reviewing what's open and overdue." },
  comms:      { label: "Client messages",   color: PALETTE.violet, description: "What was said to or by clients and teammates across text, call, email, and Slack." },
  drafting:   { label: "Drafting replies",  color: PALETTE.rose,   description: "Writing client texts and emails in your voice, grounded in the real thread." },
  business:   { label: "Business & how-to", color: PALETTE.brand,  description: "Judgment calls, pricing logic, SOPs, how the hub works, and facts you've taught it." },
  general:    { label: "General",           color: PALETTE.gray,   description: "Open-ended or mixed questions that don't map to one area." },
};

// First match wins. Concrete data/action intents beat the broad "business"
// grounding tool, which most judgment questions also touch.
export function classifyCategory(tools: string[]): HubCategoryKey {
  const has = (n: string) => tools.includes(n);
  if (has("draft_client_message")) return "drafting";
  if (has("create_task")) return "tasks";
  if (has("get_billing")) return "billing";
  if (has("search_comms")) return "comms";
  if (has("get_schedule")) return "scheduling";
  if (has("find_client")) return "clients";
  if (has("search_projects") || has("get_project_detail") || has("day_summary")) return "projects";
  if (has("list_tasks")) return "tasks";
  if (has("remember_fact") || has("search_business_knowledge") || has("search_knowledge")) return "business";
  return "general";
}

function normRole(role: string): string {
  const r = (role ?? "").toUpperCase();
  return r === "ADMIN" || r === "CREATIVE" ? r : "OWNER";
}
function heuristicTitle(q: string): string {
  const t = q.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New conversation";
}

// Persist one user→assistant exchange. Creates the chat on the first turn and
// returns its id so the client can keep appending to the same conversation.
// Best-effort: never throws into the assistant's response path.
export async function recordHubTurn(input: {
  chatId?: string | null;
  role: string;
  question: string;
  answer: string;
  toolsUsed: string[];
}): Promise<string | null> {
  try {
    const category = classifyCategory(input.toolsUsed);
    let chatId = input.chatId ?? null;
    if (chatId) {
      const exists = await prisma.hubChat.findUnique({ where: { id: chatId }, select: { id: true } });
      if (!exists) chatId = null;
    }
    if (!chatId) {
      const chat = await prisma.hubChat.create({
        data: { role: normRole(input.role), title: heuristicTitle(input.question), category },
        select: { id: true },
      });
      chatId = chat.id;
    }
    await prisma.hubMessage.createMany({
      data: [
        { chatId, role: "user", content: input.question.slice(0, 4000), category },
        { chatId, role: "assistant", content: input.answer.slice(0, 8000), toolsUsed: JSON.stringify(input.toolsUsed).slice(0, 1000) },
      ],
    });
    // category is set once (the opening intent); later turns only bump counters.
    await prisma.hubChat.update({
      where: { id: chatId },
      data: { messageCount: { increment: 2 }, lastMessageAt: new Date() },
    });
    return chatId;
  } catch {
    return null;
  }
}

export type HubChatRow = {
  id: string;
  role: string;
  title: string;
  summary: string | null;
  category: HubCategoryKey;
  messageCount: number;
  fresh: boolean; // summary is current with messageCount
  createdAt: Date;
  lastMessageAt: Date;
};

export async function listHubChats(limit = 100): Promise<HubChatRow[]> {
  const rows = await prisma.hubChat.findMany({
    orderBy: { lastMessageAt: "desc" },
    take: Math.min(limit, 300),
    select: { id: true, role: true, title: true, summary: true, summaryAtCount: true, category: true, messageCount: true, createdAt: true, lastMessageAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    title: r.title || "Conversation",
    summary: r.summary,
    category: (r.category && r.category in CATEGORY_META ? r.category : "general") as HubCategoryKey,
    messageCount: r.messageCount,
    fresh: !!r.summary && r.summaryAtCount >= r.messageCount,
    createdAt: r.createdAt,
    lastMessageAt: r.lastMessageAt,
  }));
}

export async function getHubChatDetail(id: string): Promise<{ id: string; role: string; messages: { role: string; content: string; createdAt: Date }[] } | null> {
  const chat = await prisma.hubChat.findUnique({
    where: { id },
    select: { id: true, role: true, messages: { orderBy: { createdAt: "asc" }, select: { role: true, content: true, createdAt: true } } },
  });
  return chat ?? null;
}

// Build (and cache) the detailed summary + a cleaner title for one chat. Skips
// the AI call if the cached summary already covers the current message count.
export async function summarizeHubChat(id: string): Promise<{ title: string; summary: string } | null> {
  const chat = await prisma.hubChat.findUnique({
    where: { id },
    select: { id: true, title: true, summary: true, summaryAtCount: true, messageCount: true, messages: { orderBy: { createdAt: "asc" }, select: { role: true, content: true } } },
  });
  if (!chat) return null;
  if (chat.summary && chat.summaryAtCount >= chat.messageCount) {
    return { title: chat.title ?? "", summary: chat.summary };
  }
  const { summarizeHubConversation } = await import("@/lib/integrations/ai");
  const transcript = chat.messages.map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", text: m.content }));
  const { title, summary } = await summarizeHubConversation({ transcript });
  if (!summary) return { title: chat.title ?? "", summary: chat.summary ?? "" };
  await prisma.hubChat.update({
    where: { id },
    data: { summary, summaryAtCount: chat.messageCount, ...(title ? { title } : {}) },
  });
  return { title: title || chat.title || "", summary };
}

export type HubStatsSlice = {
  key: HubCategoryKey;
  label: string;
  color: string;
  count: number;
  pct: number;
  description: string;
  examples: string[];
};

// Aggregate user questions by category for the pie chart, with up to 3 real
// example questions per slice.
export async function hubQuestionStats(): Promise<{ total: number; slices: HubStatsSlice[] }> {
  const rows = await prisma.hubMessage.findMany({
    where: { role: "user" },
    orderBy: { createdAt: "desc" },
    take: 3000,
    select: { category: true, content: true },
  });
  const total = rows.length;
  const byCat = new Map<HubCategoryKey, { count: number; examples: string[] }>();
  for (const r of rows) {
    const key: HubCategoryKey = (r.category && r.category in CATEGORY_META ? r.category : "general") as HubCategoryKey;
    const e = byCat.get(key) ?? { count: 0, examples: [] };
    e.count++;
    const text = r.content.trim();
    if (e.examples.length < 3 && text) e.examples.push(text.length > 110 ? `${text.slice(0, 107)}…` : text);
    byCat.set(key, e);
  }
  const slices: HubStatsSlice[] = [...byCat.entries()]
    .map(([key, v]) => ({
      key,
      label: CATEGORY_META[key].label,
      color: CATEGORY_META[key].color,
      count: v.count,
      pct: total ? Math.round((v.count / total) * 100) : 0,
      description: CATEGORY_META[key].description,
      examples: v.examples,
    }))
    .sort((a, b) => b.count - a.count);
  return { total, slices };
}
