"use server";

import { getSecret } from "@/lib/integrations/connections";
import { runHubAgent } from "@/lib/integrations/ai";
import { HUB_TOOLS, execHubTool } from "@/lib/hubTools";
import { etFullDate } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess, contentTier } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";

export type HubSource = { kind: "data" | "knowledge"; title: string };
export type HubDraft = {
  clientId: string;
  clientName: string;
  channel: "text" | "email";
  message: string;
  canText: boolean;
};
export type HubTaskCard = {
  id: string;
  title: string;
  priority: string;
  due: string;
  project?: string | null;
  href: string;
};
export type HubMemoryCard = {
  id: string;
  title: string;
  category: string;
  minRole: string;
  superseded: number;
};
export type HubAnswer = {
  answer: string;
  sources: HubSource[];
  drafts?: HubDraft[];
  tasks?: HubTaskCard[];
  memories?: HubMemoryCard[];
  chatId?: string;
};

export type HubTurn = { role: "user" | "assistant"; content: string };

// Friendly names for the tools the assistant called, shown to the user as the
// "what I looked at" trail under each answer.
const TOOL_LABEL: Record<string, string> = {
  current_datetime: "Today's date",
  search_projects: "Projects",
  get_project_detail: "Project detail",
  find_client: "Client lookup",
  get_schedule: "Schedule",
  list_tasks: "To-dos",
  get_billing: "Billing / AR",
  day_summary: "Day recap",
  search_knowledge: "SOPs & resources",
  search_business_knowledge: "Business knowledge",
  search_comms: "Client messages",
  draft_client_message: "Drafted a message",
  create_task: "Created a task",
  remember_fact: "Saved to memory",
};

export type HubRole = "OWNER" | "ADMIN" | "CREATIVE";
const ROLE_DESC: Record<HubRole, string> = {
  OWNER: "Jordan, the owner. You may use and discuss everything, including finances, margins, pay rates, strategy, and personnel.",
  ADMIN: "Kyle, the operations admin / VA. You may discuss client handling, scheduling, fees, and operations, but NOT owner-only finances, margins, pay rates, strategy, or personnel assessments.",
  CREATIVE: "a creative (photographer or editor). You may discuss shoot prep, editing standards, deliverables, and tone, but NOT pricing internals, client lists, finances, or any private business matters.",
};

function hubSystemPrompt(role: HubRole): string {
  const today = etFullDate(new Date());
  return `You are "Ask the Hub", the AI operations brain for RealTour Pilot, a real estate media agency. You answer questions about the live state of the business AND ground your judgment in how Jordan actually runs it.

Today is ${today} (Eastern Time). Everything operates in Eastern Time.

WHO YOU ARE TALKING TO: ${ROLE_DESC[role]}

ABOUT THE HUB (so you can guide people and offer useful tips): This app is RealTour Pilot's operations hub. Main pages, by section:
- Operations: Dashboard (/) = the morning brief (today's shoots, unanswered client messages, what needs attention, next-day deliveries); Daily Tasks (/queue) = Kyle's single to-do list (QC checklists, deliveries, reply drafts, confirmations, with Send buttons); Task History (/history) = completed work by day + an AI day-recap; Project Tracker (/pipeline) = the pipeline board booked through delivered; Schedule (/schedule) = shoots by day with photographers; Map (/map) = live shoot map with weather, traffic, and drone-airspace flags; Communications (/communications) = client text/call threads incl. group chats; Clients (/clients) = the CRM, grouped by segment, each client page has orders, spend, notes, and Text/Email-draft tools; Team (/team) = team members, schedules, and KPIs.
- Creative: Upload Portal (/upload) = photographers drop raw/final files by day; Editor Queue (/editing) = the editing pipeline and vendor routing.
- Sales & Finance: Sales Tracker (/sales); Billing (/billing) = outstanding AR on delivered jobs; Service Catalog (/catalog) = products/packages; Payouts (/payouts) = creative pay.
- Knowledge: Resources & SOPs (/resources); Ask the Hub (/assistant) = you.
- System: Feedback & requests (/feedback) = submit a feature/bug (there's also a floating Feedback button on every page); Connections (/connections) = integrations (Aryeo, OpenPhone, Gmail, Dropbox, Slack, AI).
Cross-cutting: the hub DRAFTS client messages but a human always clicks Send (it never auto-sends). Inbound texts/calls and Aryeo order changes arrive in real time; Gmail is scanned every few minutes. Everything is in Eastern Time. For deeper "how do I do X in the hub" questions, call search_business_knowledge (it also holds hub how-tos).

You have read-only tools that query the live operations database (projects/shoots, clients, schedule, to-dos, billing, daily activity, the SOP library) AND Jordan's distilled business knowledge (his preferences, decisions and outcomes, goals, recurring issues, pricing/financial logic, client-handling rules) plus how the hub works. USE THE TOOLS to answer; never guess at data you can look up. For relative dates ("today", "this week", "overdue") call current_datetime first. For a specific project, use search_projects then get_project_detail. For anything involving judgment, pricing, a client situation, strategy, "how do we / should we", how the hub works, or what Jordan would want, call search_business_knowledge to ground your answer. For what was actually said to or by a client (what we told them, when we last spoke, what was promised), or BEFORE drafting any client reply, call search_comms and read the real thread first so your answer or draft fits what was already said; never invent what a client said, and if search_comms returns nothing say there is no record.

Offering tips: when someone seems unsure how to do something, or their question maps to a hub feature, add one short, practical tip pointing them to the right page or a faster way to do it. Keep it to a sentence, and only when it genuinely helps.

How to answer:
- Be concise, specific, and factual. Lead with the direct answer, then supporting details. Plain text or short bullets.
- Reference real names, dates, and amounts from the tools. Never invent a date, price, status, or commitment the tools did not return.
- When you make a recommendation, briefly ground it in Jordan's known preferences/decisions when relevant.
- Eastern Time for dates/times. Money in dollars.

CONFIDENTIALITY (critical): The business-knowledge tool ALREADY filters out anything above the current viewer's clearance, so only share what it returns. Never speculate about, reconstruct, or hint at finances, margins, pay rates, vendor costs, strategy, or personnel matters for a viewer who is not the OWNER. If asked something above their clearance, say it's not something you can share at their access level. Never put owner-only facts (margins, pay, costs, strategy, personnel) into any message drafted for a client or creative.

Hard rules: no em dashes, no emojis, no bold. Speak plainly to the team.

Drafting: when the user asks to write/draft/reply to a client or follow up with someone, call draft_client_message. It writes the message in Jordan's voice grounded in the real thread and shows it to the user with a Send button. You DRAFT; a human always clicks Send. Keep your own reply short (e.g. "Drafted a text to Stephen below, grounded in your last few messages. Review and send.").

Adding tasks: when the user asks to add/create a task, reminder, or follow-up ("add a task to...", "remind me to...", "make a to-do for..."), call create_task with a clear imperative title, and link it to a project or client by name when one is mentioned. Confirm briefly (e.g. "Added it to the queue."). Only create a task when they actually ask for one.

Learning (memory): you get smarter over time by remembering what you are told. Call remember_fact ONLY when the user is actively telling you something to remember or correcting you: a durable fact, price, fee, policy, rule, preference, or decision ("remember that...", "from now on...", "our rush fee is now $X", "actually it's...", "going forward...", "no, that's wrong..."). Write the fact as a complete standalone sentence with the specifics, pick the right category, and set min_role by sensitivity: OWNER for money/margins/pay/costs/strategy/personnel, ADMIN for operations/client-handling/fees/scheduling, CREATIVE only for shoot or editing craft. When the user is changing or fixing a value you already knew, set correction=true so the old version is retired. Confirm briefly what you saved (e.g. "Got it, I'll remember the rush fee is now $200."). NEVER call remember_fact to answer a question, to confirm, or to restate a fact you already know or just looked up. If you are only retrieving or reciting something (the user asked "what is X"), just answer. Do NOT use it for one-off action items (use create_task). If the viewer is a creative, you cannot save to memory; say so plainly.

Critical boundary: aside from drafting client messages (proposed for a human to send), creating internal to-dos when asked, and saving facts you are taught, you do not send anything to clients or change external records on your own. The human always stays on the Send button.`;
}

export async function askHub(question: string, history: HubTurn[] = [], chatId?: string): Promise<HubAnswer> {
  const q = question.trim();
  if (!q) return { answer: "Ask me anything about your projects, clients, schedule, to-dos, billing, or how the business runs.", sources: [] };

  // The viewer's content tier is derived from the SIGNED-IN user, never trusted
  // from the client. A creative (photographer/editor) only ever gets CREATIVE-tier
  // knowledge + comms; admin → ADMIN; owner → everything. Middleware only gates
  // page navigation, not the POST that invokes this action — so once enforcement
  // is on (always in prod/Vercel, same signal as the server-action guards) an
  // unauthenticated or unauthorized call must refuse cleanly, never fall back to
  // a privileged tier. No session with enforcement OFF = open local dev → owner.
  const me = await getCurrentUser();
  if (authEnforced()) {
    if (!me) return { answer: "Please sign in to use Ask the Hub.", sources: [] };
    if (!canAccess(me, "assistant")) {
      return { answer: "Ask the Hub isn't available at your access level.", sources: [] };
    }
  }
  const viewerRole: HubRole = me ? contentTier(me.role) : "OWNER";

  const key = await getSecret("ai");
  if (!key) {
    return {
      answer: "The AI isn't connected yet. Add your Anthropic API key on the Connections page and I'll be able to answer from your live data.",
      sources: [],
    };
  }

  // Capture any client-message drafts the agent produces, so the UI can render
  // them as Send-ready cards (the assistant never sends; a human clicks Send).
  const drafts: HubDraft[] = [];
  const tasks: HubTaskCard[] = [];
  const memories: HubMemoryCard[] = [];
  const exec = async (name: string, input: Record<string, unknown>) => {
    // Impersonation state rides along so write tools (create_task, remember_fact)
    // stay read-only while the owner is previewing someone else ("view as").
    const out = await execHubTool(name, input, { role: viewerRole, impersonating: me?.impersonating ?? false });
    const o = out as { drafted?: boolean; client_id?: string; client_name?: string; channel?: string; message?: string; can_text?: boolean; created_task?: boolean; id?: string; title?: string; priority?: string; due?: string; project?: string | null; href?: string; remembered?: boolean; category?: string; min_role?: string; superseded?: number };
    if (name === "draft_client_message" && o?.drafted && o.message && o.client_id) {
      drafts.push({
        clientId: o.client_id,
        clientName: o.client_name ?? "client",
        channel: o.channel === "email" ? "email" : "text",
        message: o.message,
        canText: !!o.can_text,
      });
    }
    if (name === "create_task" && o?.created_task && o.id && o.title) {
      tasks.push({ id: o.id, title: o.title, priority: o.priority ?? "MEDIUM", due: o.due ?? "", project: o.project ?? null, href: o.href ?? "/queue" });
    }
    if (name === "remember_fact" && o?.remembered && o.id && o.title) {
      memories.push({ id: o.id, title: o.title, category: o.category ?? "preference", minRole: o.min_role ?? "ADMIN", superseded: o.superseded ?? 0 });
    }
    return out;
  };

  try {
    const { answer, toolsUsed } = await runHubAgent({
      system: hubSystemPrompt(viewerRole),
      history: history.slice(-8),
      question: q,
      tools: HUB_TOOLS,
      exec,
      maxSteps: 7,
    });

    // De-duplicate the tools used into a friendly "what I looked at" trail.
    const seen = new Set<string>();
    const sources: HubSource[] = [];
    for (const t of toolsUsed) {
      if (t.name === "current_datetime" || seen.has(t.name)) continue;
      seen.add(t.name);
      sources.push({ kind: t.name === "search_knowledge" ? "knowledge" : "data", title: TOOL_LABEL[t.name] ?? t.name });
    }

    // Persist the exchange (owner-only history + usage analytics). Best-effort;
    // never let logging break the answer.
    let newChatId: string | undefined = chatId;
    try {
      const { recordHubTurn } = await import("@/lib/hubChats");
      const saved = await recordHubTurn({ chatId, role: viewerRole, question: q, answer, toolsUsed: toolsUsed.map((t) => t.name) });
      if (saved) newChatId = saved;
    } catch {
      /* ignore */
    }

    return { answer, sources, drafts: drafts.length ? drafts : undefined, tasks: tasks.length ? tasks : undefined, memories: memories.length ? memories : undefined, chatId: newChatId };
  } catch (e) {
    return {
      answer: e instanceof Error ? e.message : "Something went wrong answering that. Please try again.",
      sources: [],
    };
  }
}
