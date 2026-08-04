"use server";

import { requireOwner } from "@/lib/auth/guards";
import { getSecret } from "@/lib/integrations/connections";
import { runHubAgent } from "@/lib/integrations/ai";
import { TRENDS_TOOLS, execTrendsTool } from "@/lib/trendsTools";
import { rebuildGrowthPlan, type GrowthPlanData } from "@/lib/growthPlan";
import { etFullDate } from "@/lib/datetime";
import { revalidatePath } from "next/cache";

// ---------------------------------------------------------------------------
// The growth advisor (owner-only). Same agent loop as the AI CPA on Finance,
// but pointed at the demand side: what is selling, what it earns, who is
// buying, who is drifting away — and always aimed at one target, a bigger
// average order.
// ---------------------------------------------------------------------------

export type AdvisorTurn = { role: "user" | "assistant"; content: string };
export type TrendsAnswer = { answer: string; toolsUsed: string[] };

const CONTEXT = `THE BUSINESS: RealTour Pilot LLC — real-estate media agency in Lititz PA (photos, video, drone, floor plans, social reels). Owner Jordan Spackman. Clients are individual real-estate agents and small teams who rebook on their own personal rhythm.
- Capacity: two photographers (Harrison Wells, James Livingston — James is being promoted to Creative Manager) plus Jordan, who is deliberately working himself OUT of the field. Moves that need many more shoot days are expensive; moves that raise the ticket on shoots already booked are cheap.
- Editing is outsourced at known rates (Luma $299/premium reel, Kim ~$120/monthly social video, in-house ~$40/standard video, AutoHDR $0.50/finished photo), so add-ons needing no extra shoot time (virtual staging, virtual twilight, floor plans) are high-margin.
- Products sell as bundles (BRONZE/SILVER/GOLD/PLATINUM/EVERYTHING) plus à la carte add-ons.
- Booking volume is flat-to-up year over year; the AVERAGE TICKET is what has been sliding. That is the problem to solve.
- THERE ARE TWO REVENUE RAILS. Per-listing work is invoiced through Aryeo, and that is what every figure on the Trends page counts. Separately, monthly social-content clients (Video Starter 2HR, Video Accelerator 4HR, VIDEO PRO 8HR) pay a RECURRING QuickBooks invoice of roughly $1,099-$2,500 a month; their Aryeo order is deliberately priced at $0 so they can schedule a session they have already paid for without paying twice. Call recurring_revenue to see that rail. Never tell Jordan a retainer client is small or shrinking from their Aryeo total alone, and never suggest "fixing" a $0 session order — it is intentional.`;

function systemPrompt(): string {
  return `You are the growth advisor for RealTour Pilot, working directly for Jordan, the owner. Today is ${etFullDate(new Date())} (Eastern Time).
${CONTEXT}

YOUR JOB: answer anything about demand and growth — booking pace, what is selling, what each package earns, which clients are growing or drifting, pricing, bundling, promotions, win-backs — using the TOOLS. Never invent a number: call a tool and quote what it returns. For relative dates call current_datetime first.

THE NORTH STAR: two things, and both count.
1. AVERAGE ORDER VALUE on per-listing work, month after month.
2. RECURRING REVENUE. Monthly retainers are the steadiest money in the business — they arrive whether or not anyone lists a house, they do not depend on booking volume, and at $1,099-$2,500 a month each they compound far faster than any per-shoot upsell. Treat winning a new retainer, saving a lapsing one, and upgrading a heavy per-listing client onto one as first-class recommendations, not afterthoughts. The best conversion candidates are agents who already book often enough that a monthly session would cost them less than their current per-listing spend — find them with top_clients and client_history.
When a question has several defensible answers, prefer the one that grows either of those.

HOW TO ANSWER:
- Lead with the direct answer and the number. Then the support.
- Markdown: short paragraphs, bullets, and tables for anything with 3+ rows of figures. Whole dollars.
- Be concrete. Name real packages and real clients from the tools, not categories. "Offer Sharra Mercer the Influencer package at her next booking" beats "target high-value clients".
- Say what the numbers MEAN — trend, risk, opportunity — not just what they are. When asked "should I", give a clear recommendation and the math.
- Jordan is not an analyst. Plain English, no jargon, no filler, no hedging.
- NEVER guess a client's gender from their name. Always write about clients as "they"/"them" unless Jordan has told you otherwise. A wrong guess misgenders a real customer in Jordan's own tool, and the neutral wording reads perfectly well either way.
- Flag data limits rather than implying false precision: margin figures window on shoot date while revenue counts by order date, so the two will not tie exactly; photo-editing cost is only known for jobs whose raw folders have been counted.

BOUNDARIES: you are read-only. You never message a client, change a price, or send anything — you tell Jordan what to do and he decides.`;
}

export async function askTrendsAdvisor(question: string, history: AdvisorTurn[] = []): Promise<TrendsAnswer> {
  await requireOwner();
  const q = question.trim();
  if (!q) return { answer: "Ask me anything about growth — what to sell, what to charge, who to call, how to lift the average order.", toolsUsed: [] };
  const key = await getSecret("ai");
  if (!key) return { answer: "The AI isn't connected — add the Anthropic API key on Connections.", toolsUsed: [] };

  try {
    const { answer, toolsUsed } = await runHubAgent({
      system: systemPrompt(),
      history: history.slice(-10),
      question: q,
      tools: TRENDS_TOOLS,
      exec: (name, input) => execTrendsTool(name, input),
      maxSteps: 12,
      maxTokens: 8000,
    });
    return { answer, toolsUsed: [...new Set(toolsUsed.map((t) => t.name))] };
  } catch (e) {
    return { answer: e instanceof Error ? e.message : "Something went wrong. Try again.", toolsUsed: [] };
  }
}

/** Owner-triggered rebuild of the growth plan card. */
export async function refreshGrowthPlanAction(): Promise<{ plan: GrowthPlanData | null; builtAt: string | null; error?: string }> {
  await requireOwner();
  const r = await rebuildGrowthPlan(true);
  if (r.plan) revalidatePath("/trends");
  return { plan: r.plan, builtAt: r.builtAt ? r.builtAt.toISOString() : null, error: r.error };
}
