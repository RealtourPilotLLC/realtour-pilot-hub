"use server";

import { getSecret } from "@/lib/integrations/connections";
import { runHubAgent } from "@/lib/integrations/ai";
import { HUB_TOOLS, execHubTool } from "@/lib/hubTools";
import { etFullDate } from "@/lib/datetime";

export type HubSource = { kind: "data" | "knowledge"; title: string };
export type HubAnswer = {
  answer: string;
  sources: HubSource[];
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

You have read-only tools that query the live operations database (projects/shoots, clients, schedule, to-dos, billing, daily activity, the SOP library) AND Jordan's distilled business knowledge (his preferences, decisions and outcomes, goals, recurring issues, pricing/financial logic, client-handling rules) plus how the hub works. USE THE TOOLS to answer; never guess at data you can look up. For relative dates ("today", "this week", "overdue") call current_datetime first. For a specific project, use search_projects then get_project_detail. For anything involving judgment, pricing, a client situation, strategy, "how do we / should we", how the hub works, or what Jordan would want, call search_business_knowledge to ground your answer.

Offering tips: when someone seems unsure how to do something, or their question maps to a hub feature, add one short, practical tip pointing them to the right page or a faster way to do it. Keep it to a sentence, and only when it genuinely helps.

How to answer:
- Be concise, specific, and factual. Lead with the direct answer, then supporting details. Plain text or short bullets.
- Reference real names, dates, and amounts from the tools. Never invent a date, price, status, or commitment the tools did not return.
- When you make a recommendation, briefly ground it in Jordan's known preferences/decisions when relevant.
- Eastern Time for dates/times. Money in dollars.

CONFIDENTIALITY (critical): The business-knowledge tool ALREADY filters out anything above the current viewer's clearance, so only share what it returns. Never speculate about, reconstruct, or hint at finances, margins, pay rates, vendor costs, strategy, or personnel matters for a viewer who is not the OWNER. If asked something above their clearance, say it's not something you can share at their access level. Never put owner-only facts (margins, pay, costs, strategy, personnel) into any message drafted for a client or creative.

Hard rules: no em dashes, no emojis, no bold. Speak plainly to the team.

Critical boundary: you are read-only. You can look things up, summarize, and recommend, but you cannot send messages, change records, or take actions. If asked to message a client or change something, explain what you'd do and point them to where in the hub to do it (a human always stays on the Send button).`;
}

export async function askHub(question: string, history: HubTurn[] = [], role: HubRole = "OWNER"): Promise<HubAnswer> {
  const q = question.trim();
  if (!q) return { answer: "Ask me anything about your projects, clients, schedule, to-dos, billing, or how the business runs.", sources: [] };

  const viewerRole: HubRole = role === "ADMIN" || role === "CREATIVE" ? role : "OWNER";

  const key = await getSecret("ai");
  if (!key) {
    return {
      answer: "The AI isn't connected yet. Add your Anthropic API key on the Connections page and I'll be able to answer from your live data.",
      sources: [],
    };
  }

  try {
    const { answer, toolsUsed } = await runHubAgent({
      system: hubSystemPrompt(viewerRole),
      history: history.slice(-8),
      question: q,
      tools: HUB_TOOLS,
      exec: (name, input) => execHubTool(name, input, { role: viewerRole }),
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
    return { answer, sources };
  } catch (e) {
    return {
      answer: e instanceof Error ? e.message : "Something went wrong answering that. Please try again.",
      sources: [],
    };
  }
}
