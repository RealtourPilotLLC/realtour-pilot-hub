"use server";

import { requireOwner } from "@/lib/auth/guards";
import { getSecret } from "@/lib/integrations/connections";
import { runHubAgent } from "@/lib/integrations/ai";
import { FINANCE_TOOLS, execFinanceTool } from "@/lib/financeTools";
import { prisma } from "@/lib/prisma";
import { etFullDate } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// The AI CPA / Financial Advisor (owner-only). Same agent loop as Ask the Hub,
// but armed with the finance tool belt so every number it quotes comes from
// the audited engines the dashboard renders — never from guesswork.
// ---------------------------------------------------------------------------

export type AdvisorTurn = { role: "user" | "assistant"; content: string };
export type AdvisorAnswer = {
  answer: string;
  toolsUsed: string[];
  reports?: { id: string; title: string }[];
  budgetChanged?: boolean;
};

const BUSINESS_CONTEXT = `
THE BUSINESS (ground truth, July 2026): RealTour Pilot LLC — real-estate media agency (photos, video, drone) in Lititz PA. Owner Jordan Spackman, family of six.
- Revenue rails: QuickBooks Payments (bundles + monthly social), Stripe (per-shoot card payments), Venmo (one client, Stephen Kennedy — counted from statement inflows, gross).
- People: Harrison Wells + James Livingston = photographers ("Creative specialists", paid via Venmo + Stripe Connect). Editors: Luma Visuals (premium reels $299), Staffify = Remar & Kyle, Kim (Cliffside Cuts, monthly social ~$120/video), AutoHDR ($0.50/finished photo), Wise/PayPal editors. Paul = $1,500/mo consultant (Staffify/FlyListed owner). Kyle = ops VA.
- Accounts: PNC business checking ···3002, Jordan's personal ···0942, wife's ···4284 (household), Tilt card ···9323, Capital One cards ···1686/···6526, Venmo (statement import).
- Conventions: every transaction is tagged BUSINESS/PERSONAL/EXCLUDE/REVIEW; transfers, card paydowns and Stripe top-ups are EXCLUDE (money-movement) so nothing double-counts; the owner hand-locks re-tags. Heavy commingling exists: personal spend flows through the business account and business spend appears on personal cards — the category engine, not the account, decides business vs personal.
- NEVER ADD UP TOTALS FROM DIFFERENT TOOLS OR ACCOUNTS. Every tool's \`total\` is already the complete figure for what it measures, summed across ALL accounts. The wife's ···4284 account and both Venmo accounts are INSIDE the personal total, not additions to it; money transferred to her account is a funding pipe that is counted where she spends it. Business costs, card paydowns and inter-account transfers are likewise already handled. If you find yourself summing two numbers to answer "how much did we spend", stop — you are about to double-count. Quote the single tool total and break it DOWN, never up. (Jul 2026: adding the wife-transfer memo to the personal total reported a real $121.8k household year as $156.7k and badly misled the owner.)
- Known context: business runs ~40% true margin; household consumption roughly equals owner draw; debt includes Stripe Capital flex loans (~19% flat) and BNPL; there is a $5k/month savings checklist and an owner-salary plan ($3,250/week) in play.`;

function advisorSystemPrompt(): string {
  return `You are the AI CPA and Financial Advisor for RealTour Pilot, working directly for Jordan, the owner. Today is ${etFullDate(new Date())} (Eastern Time).
${BUSINESS_CONTEXT}

YOUR JOB: answer any question about the money — revenue, costs, profit, per-person pay, per-job margins, personal vs business, cash flow, subscriptions, debt strategy, pricing, hiring math — using the TOOLS. Never invent a number: call the tools and quote what they return. For relative dates call current_datetime first. Cross-check when it matters (e.g. compare finance_overview to monthly_pnl).

HOW TO ANSWER:
- Lead with the direct answer and the number. Then the supporting detail.
- Use markdown: short paragraphs, bullet lists, and tables for anything with 3+ rows of figures. Dollar amounts rounded to whole dollars unless cents matter.
- Think like a sharp small-business CPA: point out what the numbers MEAN (margin, run-rate, trend, risk), not just what they are. When asked "should I...", give a clear recommendation with the math behind it.
- Jordan is not technical or an accountant. Plain English, no jargon without a one-line explanation.
- If data has a known limit (Venmo statement lags until the next monthly import, QuickBooks expense coding is the CPA's cleanup, $-figures drift as Jordan re-tags), say so briefly rather than presenting false precision.

REPORTS FROM CHAT: when Jordan asks you to create, save, or generate a report/statement in conversation, pull the data with your tools, COMPOSE the complete formal markdown statement (one-line executive summary, sections, markdown tables for all figures, a Notes & caveats section), then call create_report with it. Keep your chat reply short ("Saved — open it below.") because the report itself carries the content.

THE BUDGET (Finance → Budget): you manage Jordan's personal budget. get_budget shows targets vs this month's actuals and 3-month averages; set_budget writes targets. When asked to set up or rebalance the budget: base each category target on the trailing average, cut where the savings plan says to cut (dining/delivery, subscriptions, impulse shopping), keep fixed costs realistic (rent, car, insurance, childcare), aim the TOTAL at a meaningful step down from the current burn (his goal: free up ~$5k/month across business + personal), and give each target a one-line note. Never budget excluded money-movement categories.

BOUNDARIES: You are not a licensed CPA, tax preparer, or investment advisor. For tax filings, entity structure (S-corp vs LLC draw), and anything you'd sign, tell Jordan to confirm with his human CPA — then still give him the numbers and the reasoning so that conversation is short. You never move money or pay anyone; your only writes are saving reports and budget targets when asked.`;
}

export async function askAdvisor(question: string, history: AdvisorTurn[] = []): Promise<AdvisorAnswer> {
  await requireOwner();
  const q = question.trim();
  if (!q) return { answer: "Ask me anything about the money — P&L, pay, margins, subscriptions, cash flow, or ask me to build a report.", toolsUsed: [] };
  const key = await getSecret("ai");
  if (!key) return { answer: "The AI isn't connected — add the Anthropic API key on Connections.", toolsUsed: [] };
  // Capture side effects (saved reports, budget writes) so the chat UI can
  // render open-the-report cards and refresh the Budget tab.
  const reports: { id: string; title: string }[] = [];
  let budgetChanged = false;
  const exec = async (name: string, input: Record<string, unknown>) => {
    const out = await execFinanceTool(name, input);
    const o = out as { report_created?: boolean; id?: string; title?: string; budget_saved?: boolean };
    if (name === "create_report" && o?.report_created && o.id) reports.push({ id: o.id, title: o.title ?? "Report" });
    if (name === "set_budget" && o?.budget_saved) budgetChanged = true;
    return out;
  };

  try {
    const { answer, toolsUsed } = await runHubAgent({
      system: advisorSystemPrompt(),
      history: history.slice(-10),
      question: q,
      tools: FINANCE_TOOLS,
      exec,
      maxSteps: 12,
      maxTokens: 8000,
    });
    return {
      answer, toolsUsed: [...new Set(toolsUsed.map((t) => t.name))],
      reports: reports.length ? reports : undefined,
      budgetChanged: budgetChanged || undefined,
    };
  } catch (e) {
    return { answer: e instanceof Error ? e.message : "Something went wrong. Try again.", toolsUsed: [] };
  }
}

/** One-click "have the Advisor build my budget" (Budget tab empty state). */
export async function aiSetupBudgetAction(): Promise<{ summary: string; error?: string }> {
  await requireOwner();
  const key = await getSecret("ai");
  if (!key) return { summary: "", error: "The AI isn't connected — add the Anthropic API key on Connections." };
  try {
    const { answer } = await runHubAgent({
      system: advisorSystemPrompt(),
      question:
        "Set up my personal budget now. Call get_budget and personal_spending (year to date) first, then call set_budget with a target for EVERY meaningful personal category (skip categories under ~$50/month). Follow the budget guidance in your instructions. After saving, reply with a SHORT markdown summary: total monthly budget vs my current burn, and the 3 biggest cuts you're asking me to make.",
      tools: FINANCE_TOOLS,
      exec: (name, input) => execFinanceTool(name, input),
      maxSteps: 10,
      maxTokens: 6000,
    });
    return { summary: answer };
  } catch (e) {
    return { summary: "", error: e instanceof Error ? e.message : "Budget setup failed. Try again." };
  }
}

// ---- Reports & statements --------------------------------------------------

const REPORT_TYPES: Record<string, { title: string; brief: string }> = {
  pnl: {
    title: "Profit & Loss Statement",
    brief: "A formal P&L: revenue by processor rail, expenses grouped by category (people, editing, software, fees, gear, other), net profit and margin. Include a month-over-month context line and 3-5 plain-English notes on what stands out.",
  },
  spending: {
    title: "Spending & Categories Statement",
    brief: "Business costs by category (table, biggest first), personal spending by category (table), credit-card payments with funding split, top 15 vendors with monthly run-rates, and what is still in review.",
  },
  people: {
    title: "Contractor & People Pay Report",
    brief: "Everyone paid in the period: per-person totals with channels (people_payments), grouped by type, plus notes on rates and anything unusual (bounced pulls, unsplit Stripe transfers).",
  },
  personal: {
    title: "Personal Spending Statement",
    brief: "Household consumption: total, by category, by month, top merchants, net transfers to the wife's account, and 3 concrete observations on where the burn is trending.",
  },
  monthly: {
    title: "Monthly Financial Summary",
    brief: "Month-by-month picture using monthly_pnl for each month in the period (current month first): revenue, payroll, expenses, profit; then a short trend commentary.",
  },
  custom: { title: "Financial Report", brief: "Follow the owner's instructions exactly." },
};

export async function generateReportAction(type: string, startKey: string, endKey: string, custom?: string): Promise<{ id?: string; error?: string }> {
  await requireOwner();
  const spec = REPORT_TYPES[type] ?? REPORT_TYPES.custom;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey)) return { error: "Bad date range" };
  const key = await getSecret("ai");
  if (!key) return { error: "The AI isn't connected — add the Anthropic API key on Connections." };

  const ask = `Produce the report below as a FORMAL FINANCIAL STATEMENT in pure markdown, then SAVE it by calling the create_report tool with title "${spec.title}", start_key "${startKey}", end_key "${endKey}", and the COMPLETE markdown document. No greeting, no closing chatter — the markdown IS the document. Start with a one-line executive summary, then the sections. Use markdown tables for all figures. End with a "Notes & caveats" section (data freshness, anything provisional). After create_report succeeds, reply with just "Saved."

REPORT: ${spec.title}
PERIOD: ${startKey} through ${endKey}
SPEC: ${spec.brief}
${custom?.trim() ? `OWNER'S ADDITIONAL INSTRUCTIONS: ${custom.trim()}` : ""}

Pull every figure from the tools for exactly this period. Round to whole dollars.`;

  try {
    // The agent saves the statement itself via create_report — capture that id.
    // (Saving the loop's final TEXT used to race with the tool call and could
    // persist interim chatter like "let me compose the statement" as the body.)
    let toolReportId: string | null = null;
    const exec = async (name: string, input: Record<string, unknown>) => {
      const out = await execFinanceTool(name, input);
      const o = out as { report_created?: boolean; id?: string };
      if (name === "create_report" && o?.report_created && o.id) toolReportId = o.id;
      return out;
    };
    // The model sometimes ANNOUNCES its plan ("let me compose and save it") and
    // ends the turn without acting — nudge it once to actually do it.
    let answer = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await runHubAgent({
        system: advisorSystemPrompt(),
        history: attempt === 0 ? undefined : [{ role: "user", content: ask }, { role: "assistant", content: answer }],
        question:
          attempt === 0
            ? ask
            : "You stopped before saving. Compose the COMPLETE markdown statement right now and call create_report with it. Do not describe your plan — act.",
        tools: FINANCE_TOOLS,
        exec,
        maxSteps: 14,
        maxTokens: 8000,
      });
      answer = r.answer;
      if (toolReportId) break;
      if (answer.trim().length >= 300 && answer.includes("|")) break; // direct-markdown fallback is fine
    }
    if (toolReportId) {
      // Stamp the builder's type/period metadata onto the tool-created row.
      await prisma.financeReport
        .update({ where: { id: toolReportId }, data: { type, title: spec.title, startKey, endKey } })
        .catch(() => {});
      return { id: toolReportId };
    }
    // Fallback: the agent answered with the markdown directly. Refuse to save
    // anything that isn't a real document (meta-chatter, truncation, refusals).
    if (answer.trim().length < 300 || !answer.includes("|")) {
      return { error: "The Advisor didn't finish composing that statement — hit Generate again (its full answer was: " + answer.trim().slice(0, 140) + "…)" };
    }
    const row = await prisma.financeReport.create({
      data: { title: spec.title, type, startKey, endKey, markdown: answer },
      select: { id: true },
    });
    return { id: row.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Report generation failed. Try again." };
  }
}

export async function deleteReportAction(id: string) {
  await requireOwner();
  await prisma.financeReport.delete({ where: { id } }).catch(() => null);
}
