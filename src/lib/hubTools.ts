import "server-only";
import type { DeliverableType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBillingRows } from "@/lib/queries";
import { parseEvidence } from "@/lib/statusEvidence";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import { etDateTime, etDate, etDayKey, etDayStartUtc, etAddDays, etFullDate, etEndOfDay } from "@/lib/datetime";
import type { HubTool } from "@/lib/integrations/ai";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { canSeeMoney } from "@/lib/auth/access";

// ---------------------------------------------------------------------------
// Read-only data tools for "Ask the Hub". Each tool maps to a bounded Prisma
// query and returns compact JSON (token- and Neon-egress-friendly). NOTHING here
// writes, sends, or mutates — the assistant can only look things up.
// ---------------------------------------------------------------------------

const dollars = (cents?: number | null) => (cents == null ? null : Math.round(cents) / 100);

function deliverableLabels(ds: { type: DeliverableType; label: string | null }[]): string[] {
  return ds.map((d) => refinedDeliverableLabel(d.type, d.label));
}

export const HUB_TOOLS: HubTool[] = [
  {
    name: "current_datetime",
    description: "Get the current date and time in Eastern Time. Call this first whenever the question involves 'today', 'this week', 'tomorrow', 'overdue', or any relative date.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_projects",
    description: "Search projects (shoots/orders) by property address or client name, and/or filter by status. Use for 'find the 123 Main job', 'what's in revision', 'show delivered jobs for Jane'. Returns compact summaries.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Address or client name to match (optional)." },
        status: { type: "string", description: "Comma-separated statuses to filter: BOOKED, SCHEDULED, SHOT, EDITING, REVIEW, REVISION, DELIVERED, CANCELLED (optional)." },
        limit: { type: "number", description: "Max results, default 15, cap 30." },
      },
    },
  },
  {
    name: "get_project_detail",
    description: "Full detail for ONE project by its id (get the id from search_projects first): status, deliverables, what's delivered vs pending, shoot + photographer, open tasks, recent messages, billing, revision note, Aryeo links.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The project id." } },
      required: ["id"],
    },
  },
  {
    name: "find_client",
    description: "Look up a client by name. Returns profile: segment/tier, order count, social-content plan, contact info, preferences, and their recent projects. Lifetime spend is OWNER-only and is simply absent for anyone else.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Client name (partial ok)." } },
      required: ["name"],
    },
  },
  {
    name: "get_schedule",
    description: "List scheduled shoots (appointments) in a date range. Use for 'what's shooting today', 'this week's schedule'. Pass a range keyword OR explicit from/to dates (YYYY-MM-DD, Eastern).",
    input_schema: {
      type: "object",
      properties: {
        range: { type: "string", description: "One of: today, tomorrow, week (next 7 days), yesterday." },
        from: { type: "string", description: "Start date YYYY-MM-DD (Eastern), if not using range." },
        to: { type: "string", description: "End date YYYY-MM-DD (Eastern, inclusive), if not using range." },
      },
    },
  },
  {
    name: "list_tasks",
    description: "List open or overdue to-dos (SmartTasks). Use for 'what's overdue', 'what does Kyle need to do', 'unanswered messages'. Optionally filter by task type.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "open (default) or overdue (due before now)." },
        taskType: { type: "string", description: "Optional task type filter, e.g. client_reply, media_qa, delivery, revision." },
        limit: { type: "number", description: "Max results, default 25, cap 40." },
      },
    },
  },
  {
    name: "get_billing",
    description: "OWNER ONLY. Outstanding accounts receivable: every delivered Aryeo job with a balance still owed, plus the grand total. Use for 'who owes us money', 'what's our outstanding AR'. For any other viewer this returns a refusal — relay it plainly and never estimate a balance.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "day_summary",
    description: "What happened on a given Eastern calendar day: shoots, deliveries, and completed tasks. Default is today. Use for 'what got done today', 'recap yesterday'.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD (Eastern). Defaults to today." } },
    },
  },
  {
    name: "search_knowledge",
    description: "Search the team's SOPs and resource library (how we shoot, edit, deliver, handle problems). Use for 'how do we handle X', 'what's our policy on Y'.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up." } },
      required: ["query"],
    },
  },
  {
    name: "search_business_knowledge",
    description: "Search Jordan's distilled business knowledge: his preferences, decisions and their outcomes, goals, the recurring problems he has been working through, pricing/financial logic, client-handling rules, and how RealTour Pilot actually operates (learned from his history). Ground your judgment here whenever a question involves 'how do we / should we', pricing, a client situation, strategy, a recommendation, or what Jordan would want. Results are already filtered to what the current viewer is allowed to see, and money knowledge (pricing, fees, financials) is OWNER-only — for anyone else it is absent and figures elsewhere are withheld.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up." },
        category: { type: "string", description: "Optional filter: preference, goal, issue, outcome, sop, fee, pricing, client_insight, strategy, financial, team, comms, script." },
        limit: { type: "number", description: "Max results, default 8, cap 15." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_comms",
    description: "Search the real communication history: client texts, call transcripts, and emails (OpenPhone/Gmail) PLUS internal Slack — team channels and Jordan's DMs with Kyle and the editors (Kim, Remar). Use for 'what did we tell <client>', 'what have Kyle and I discussed', 'what did the editors say about <project>', 'when did we last talk', or before drafting a reply so it fits the thread. The `person` filter matches a client OR a teammate by name. Returns messages newest first.",
    input_schema: {
      type: "object",
      properties: {
        person: { type: "string", description: "A person's name to focus on — client OR teammate (Kyle, Kim, Remar). Optional." },
        client: { type: "string", description: "Alias for person (kept for compatibility)." },
        query: { type: "string", description: "Keyword to find in message text (optional)." },
        limit: { type: "number", description: "Max messages, default 12, cap 25." },
      },
    },
  },
  {
    name: "draft_client_message",
    description: "Draft a ready-to-send message to a client, in Jordan's voice, grounded in their REAL recent conversation history. Use when the user asks to 'draft/write a reply/text to <client>', 'follow up with <client>', or 'reach out to <client about X>'. The draft is shown to the user with a Send button — you NEVER send it yourself, a human always clicks Send. Return your answer briefly noting you drafted it; the draft card renders separately.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client name." },
        channel: { type: "string", description: "text or email (default text)." },
        intent: { type: "string", description: "What the message should accomplish (e.g. 'ask for the lockbox code', 'follow up on the unpaid invoice', 'let them know the reel is ready')." },
      },
      required: ["client"],
    },
  },
  {
    name: "create_task",
    description: "Create a to-do in the hub. Use whenever the user asks to add/create a task, reminder, or follow-up (e.g. 'add a task to call the editor about 123 Main', 'remind me to invoice Jamie Friday'). Write a clear imperative title. Optionally link it to a project or client by name, set a priority and a due date. The task is created and shown as a confirmation card.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative task title (e.g. 'Call Luma about the 3725 Old Post reel')." },
        detail: { type: "string", description: "Optional extra detail / context." },
        project: { type: "string", description: "Optional project address to link the task to." },
        client: { type: "string", description: "Optional client name to link the task to." },
        priority: { type: "string", description: "URGENT, HIGH, MEDIUM (default), or LOW." },
        dueDate: { type: "string", description: "Optional due date YYYY-MM-DD (Eastern). Defaults to tomorrow." },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a hub task done (or reopen it). Use when the user says a task is handled ('mark the QC on 316 Market done', 'I called Gary back — close it'). Find the task by words from its title; confirm what you closed.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Words from the task title (e.g. '316 Market QC', 'call Gary')." },
        reopen: { type: "boolean", description: "True to REOPEN a completed task instead." },
      },
      required: ["task"],
    },
  },
  {
    name: "assign_task",
    description: "Assign a hub task to a person (or take it yourself). Use for 'give the Ruth Ridge edit to John', 'I'll take the Slack to-dos about Marcee', 'assign the unowned confirmation texts to Kyle'. Finds the task by title words; person by first name.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Words from the task title." },
        person: { type: "string", description: "First name of who owns it (Kyle, Jordan, James, John, Kim…) — or 'me'." },
      },
      required: ["task", "person"],
    },
  },
  {
    name: "list_reply_queue",
    description: "The unanswered client texts, each with its pre-drafted reply. Use for 'who's waiting on a reply?', 'show me the reply queue', 'what texts need answers?'. Read-only — send from the Communications Replies tab (or say which one to answer and draft it).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_drafted_texts",
    description: "The day's drafted confirmation/delivery texts (the comms Outbox). WITHOUT confirm:true it only LISTS them for review. When the user has seen the list and explicitly says to send, call again with confirm:true — that actually texts clients, so never set confirm on your own initiative.",
    input_schema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "True ONLY after the user has reviewed the list in this conversation and explicitly said to send." },
      },
    },
  },
  {
    name: "remember_fact",
    description: "Save a lasting fact, rule, price, policy, preference, or correction to the hub's long-term memory so it is remembered and used in future answers. Use this WHENEVER the user tells you to remember something, states or changes a price/fee/policy/rule, shares a durable preference or decision, or corrects something you got wrong ('remember that...', 'from now on...', 'our rush fee is now $X', 'actually it's...', 'going forward we...', 'no, that's wrong, it's...'). Do NOT use it for one-off action items (use create_task) or for things already in the live data. Set min_role carefully: OWNER for anything about money, margins, pay, costs, strategy, or personnel; ADMIN for operations, client handling, fees, and scheduling; CREATIVE only for pure shoot/editing craft. When the user is changing or fixing a known value, set correction=true so the old version is retired. After saving, confirm briefly what you stored.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the fact (e.g. 'Rush fee', 'Preferred drone vendor', 'Twilight pricing')." },
        fact: { type: "string", description: "The fact itself, written as a complete standalone sentence so it still makes sense months later (include the specifics: amounts, names, conditions)." },
        category: { type: "string", description: "One of: preference, goal, issue, outcome, sop, fee, pricing, client_insight, strategy, financial, team, comms, script." },
        min_role: { type: "string", description: "Lowest role allowed to see it: OWNER, ADMIN (default), or CREATIVE. Choose the most restrictive tier that still lets the right people use it." },
        correction: { type: "boolean", description: "True if this fixes or replaces something previously believed; the stale version is superseded." },
      },
      required: ["title", "fact"],
    },
  },
  {
    name: "save_document",
    description:
      "SAVE a document so it survives the conversation — a report, an SOP, a brief, a plan, a written summary. Use this whenever the answer is something Jordan will want to come back to, print, or hand to someone, rather than a couple of sentences in chat. Compose the COMPLETE document in markdown and pass it as `markdown`; that text IS the document, so no 'here's your report' preamble inside it. Use markdown tables for any figures. Say plainly afterwards that you saved it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What it is, as a person would name a file. Max 120 chars." },
        kind: {
          type: "string",
          description: "report | sop | brief | plan | summary | doc. Pick the closest.",
        },
        markdown: {
          type: "string",
          description:
            "The whole document in markdown. Open with a one-line summary of the finding, then the sections. Every figure must come from the tools — never estimated. Close with what the numbers do NOT cover.",
        },
      },
      required: ["title", "markdown"],
    },
  },
];

// Role tiers map onto the future per-user RBAC. A viewer sees an item only if
// their role rank is >= the item's required minRole rank.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };
function allowedRolesFor(viewer: string): string[] {
  const rank = ROLE_RANK[viewer] ?? ROLE_RANK.CREATIVE;
  return Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= rank);
}

// ---------------------------------------------------------------------------
// Money blindness (Jordan, Sep 2 2026: "everyone filtered by role but Kyle
// should not have access to any money related info"). canSeeMoney now means
// OWNER only — it used to mean admin-and-up, which is why Kyle could ask the
// Hub for AR, a client's lifetime spend, or a job's invoice total.
//
// The gate lives HERE, at the tool boundary, not in the system prompt. A prompt
// is a request the model can be argued out of; a filter is a fact. If the tool
// never returns the figure, there is nothing for the model to leak, quote, or
// reason its way back to — and this is the one surface where a leak is silent.
//
// Two strengths, because Kyle still has to run operations on this data:
//   redactMoney(text) — keeps the sentence, removes the figure, so "chase the
//     invoice on 12 Oak" survives while "$450" does not. Sentences whose
//     SUBJECT is internal money (margin, payroll, revenue, AR) are dropped
//     whole: redacting the number there would still say a margin exists and
//     what it applies to.
//   MONEY_SUBJECT / MONEY_CATEGORIES — whole knowledge items, SOPs and
//     resources that are ABOUT money are never fetched for a money-blind
//     viewer, however their individual sentences read.
// ---------------------------------------------------------------------------

// Sentence-level kill list: internal financials. Deliberately narrow — verbs
// like "paid" or "quote" are everyday ops language ("they already paid, go
// ahead and deliver") and dropping those sentences would gut Kyle's comms
// search for no gain, since the FIGURE in them is redacted either way.
const MONEY_HARD =
  /\b(margins?|markups?|profit\w*|p&l|net income|gross (?:income|revenue|profit|margin)|revenues?|payroll|payouts?|pay ?rates?|hourly rate|day rate|salar(?:y|ies)|wages?|commissions?|cogs|overhead|cash ?flow|runway|burn rate|lifetime (?:spend|value)|accounts receivable|a\/r\b|outstanding balance|balance owed|take-?home|owner draw)\b/i;

// Currency figures in every shape a person or a model writes them, including
// bare thousands-formatted numbers (a "1,200" in this business is money) and
// per-unit rates ("0.50 per photo", "299/video"). The k/m suffix is grouped WITH
// its space so "$3,000 starting" doesn't lose the space and read "[amount
// withheld]starting".
const MONEY_FIGURE =
  /[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|bucks|usd)\b|\b\d[\d,]*(?:\.\d+)?\s?(?:\/|per )\s?(?:photo|image|video|reel|shoot|hour|hr|month|mo|job|listing|edit)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gi;

// The other half of the leak: numbers that are money only because of the words
// around them — "we charge 500", "charge 'em 30% of the total", "a processing
// fee of approximately 4%". A currency symbol is the easy case; a live probe of
// the 910 sales transcripts found dozens of these with no symbol at all.
// Applied ONLY inside a sentence that names money, and even then only to
// percentages and numbers of two digits or more, so a field SOP's "charge 2
// batteries" and "4 hours per month" survive intact. Times (1:30), decimals
// already handled above, and years (2026) are excluded by the lookarounds.
const MONEY_CONTEXT =
  /\b(fees?|charge[ds]?|charging|price[ds]?|pricing|cost(?:s|ed)?|invoiced?|paid|pay(?:s|ment|ments)?|deposit|retainer|commissions?|discounts?|refunds?|quoted?|budget|markup|margins?|salar(?:y|ies)|wages?|payouts?|upcharge|surcharge|per (?:photo|image|video|reel|shoot|edit|listing))\b/i;
const CONTEXT_NUM =
  /\b\d+(?:\.\d+)?\s?%|(?<![:\d.])(?!(?:19|20)\d{2}\b)\d{2,}(?:[.,]\d+)*(?![:\d])/g;

const WITHHELD = "[amount withheld]";

// URLs and email addresses are masked out before redaction and put back after.
// Without this, an order link's UUID ("…/orders/01a03491-a7a0-…") sitting in a
// sentence that says "invoice" came back as "orders/[amount withheld]a[amount
// withheld]…" — a link Kyle needs, destroyed to hide digits that were never money.
const URLISH = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+/gi;
const MASK = "\u0001"; // a control char that cannot occur in real copy

/** Keep the meaning, lose the number. Empty string if nothing survives.
 *  Exported so the guarantee is testable from a probe, and so any future
 *  money-blind surface reuses this rule instead of writing a weaker one (the
 *  creative-facing stripMoneySentences in src/lib/text.ts is the narrow cousin:
 *  it drops whole sentences and does not catch context-only numbers). */
export function redactMoney(text: string | null | undefined): string {
  if (!text) return "";
  const kept: string[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (MONEY_HARD.test(sentence)) continue; // subject is internal money: drop it whole
    // Mask/restore per sentence so a dropped sentence can't misalign the queue.
    const links: string[] = [];
    const masked = sentence.replace(URLISH, (u) => (links.push(u), MASK));
    const symbolled = masked.replace(MONEY_FIGURE, WITHHELD);
    const redacted = MONEY_CONTEXT.test(symbolled) ? symbolled.replace(CONTEXT_NUM, WITHHELD) : symbolled;
    let i = 0;
    kept.push(redacted.split(MASK).reduce((acc, part, idx) => acc + (idx ? links[i++] ?? "" : "") + part, ""));
  }
  return kept
    .join(" ")
    // "$1,200-$1,500" collapses to one placeholder rather than a stutter.
    .replace(/(?:\[amount withheld\][\s\-–—to]*){2,}/g, `${WITHHELD} `)
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Per-viewer scrubber: identity for the owner, redactor for everyone else. */
function scrubberFor(role: string): (t: string | null | undefined) => string {
  return canSeeMoney(role) ? (t) => t ?? "" : redactMoney;
}

// Whole-item topic gate. An SOP called "Pricing & packages" or a knowledge item
// filed under `financial` is money end to end — there is no useful ops residue
// left after redaction, so it is never fetched. Mirrors the creative filter the
// /resources page already applies (src/app/resources/page.tsx MONEY_RE).
const MONEY_SUBJECT =
  /\b(pricing|price list|prices?|rate card|fees?|fee schedule|invoic\w*|billing|payments?|payouts?|payroll|financials?|finance|p&l|profit\w*|margins?|revenues?|quickbooks|stripe|venmo|bookkeeping|accounts receivable|salar(?:y|ies)|commissions?|budget\w*|cost\w*|expenses?)\b/i;

// KnowledgeItem.category values that exist only to hold money knowledge.
const MONEY_CATEGORIES = ["pricing", "fee", "financial"];

// One line appended to a scrubbed tool result so the model states the boundary
// instead of filling the hole with a guess.
const MONEY_BLIND_NOTICE =
  "Figures removed for this viewer's access level. Do not estimate, infer, or reconstruct any amount, price, rate, margin, or balance; if asked for one, say it is not available at their access level.";

// Resolve a range keyword / explicit dates into [startUtc, endUtc).
function resolveRange(input: { range?: string; from?: string; to?: string }): { start: Date; end: Date; label: string } {
  const todayStart = etDayStartUtc(new Date());
  if (input.from) {
    const start = etDayStartUtc(new Date(`${input.from}T12:00:00-05:00`));
    const end = input.to ? etAddDays(etDayStartUtc(new Date(`${input.to}T12:00:00-05:00`)), 1) : etAddDays(start, 1);
    return { start, end, label: `${input.from}${input.to ? ` → ${input.to}` : ""}` };
  }
  switch ((input.range ?? "today").toLowerCase()) {
    case "tomorrow": return { start: etAddDays(todayStart, 1), end: etAddDays(todayStart, 2), label: "tomorrow" };
    case "yesterday": return { start: etAddDays(todayStart, -1), end: todayStart, label: "yesterday" };
    case "week": case "next7": return { start: todayStart, end: etAddDays(todayStart, 7), label: "next 7 days" };
    default: return { start: todayStart, end: etAddDays(todayStart, 1), label: "today" };
  }
}

export async function execHubTool(
  name: string,
  input: Record<string, unknown>,
  // Least privilege if a caller forgets; `impersonating` = the owner is in the
  // read-only "view as" preview, so write tools must refuse.
  ctx: { role: string; impersonating?: boolean; who?: string | null } = { role: "CREATIVE" },
): Promise<unknown> {
  switch (name) {
    case "current_datetime": {
      const now = new Date();
      return { now_eastern: etDateTime(now), today: etFullDate(now), day_key: etDayKey(now) };
    }

    case "search_projects": {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      const statusRaw = typeof input.status === "string" ? input.status : "";
      const limit = Math.min(Number(input.limit) || 15, 30);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};
      if (statusRaw) where.status = { in: statusRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) };
      if (query) where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { client: { name: { contains: query, mode: "insensitive" } } },
      ];
      const rows = await prisma.project.findMany({
        where,
        take: limit,
        orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true, title: true, status: true, shootDate: true, deliveryDue: true, deliveredAt: true,
          balanceAmount: true, paymentStatus: true, paidMarkedAt: true, arRemovedAt: true,
          client: { select: { name: true } },
          deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
        },
      });
      const money = canSeeMoney(ctx.role); // everyone below OWNER sees the job, never the dollars
      return {
        count: rows.length,
        projects: rows.map((p) => ({
          id: p.id,
          address: p.title,
          client: p.client?.name ?? null,
          status: p.status,
          shoot: p.shootDate ? etDate(p.shootDate) : null,
          due: p.deliveryDue ? etDate(p.deliveryDue) : null,
          delivered: p.deliveredAt ? etDate(p.deliveredAt) : null,
          balance_owed: money && !p.paidMarkedAt && !p.arRemovedAt ? dollars(p.balanceAmount) : undefined,
          deliverables: deliverableLabels(p.deliverables),
        })),
      };
    }

    case "get_project_detail": {
      const id = String(input.id ?? "");
      const p = await prisma.project.findUnique({
        where: { id },
        select: {
          id: true, title: true, status: true, shootDate: true, deliveryDue: true, deliveredAt: true,
          price: true, balanceAmount: true, paymentStatus: true, invoiceUrl: true, paidMarkedAt: true, arRemovedAt: true,
          aryeoOrderId: true, aryeoListingId: true, statusEvidence: true, revisionNote: true, revisionRequestedAt: true, notes: true,
          client: { select: { id: true, name: true, segment: true } },
          photographer: { select: { name: true } },
          deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, status: true } },
          appointments: { select: { startAt: true, status: true, assignedTo: { select: { name: true } } }, orderBy: { startAt: "asc" } },
          smartTasks: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
            select: { taskType: true, title: true, priority: true, dueAt: true },
            orderBy: { dueAt: "asc" },
          },
          messages: { orderBy: { createdAt: "desc" }, take: 6, select: { authorName: true, body: true, createdAt: true } },
        },
      });
      if (!p) return { error: "No project with that id." };
      const ev = parseEvidence(p.statusEvidence);
      // Free text on a project (the client's revision ask, the last few thread
      // messages) routinely carries amounts — "we agreed $150 off", "invoice
      // says 1,200". Redact for a money-blind viewer; keep the ops meaning.
      const scrub = scrubberFor(ctx.role);
      const seesMoney = canSeeMoney(ctx.role);
      return {
        id: p.id,
        address: p.title,
        status: p.status,
        client: p.client ? { id: p.client.id, name: p.client.name, segment: p.client.segment } : null,
        photographer: p.photographer?.name ?? null,
        shoot: p.shootDate ? etDateTime(p.shootDate) : null,
        delivery_due: p.deliveryDue ? etDate(p.deliveryDue) : null,
        delivered: p.deliveredAt ? etDate(p.deliveredAt) : null,
        deliverables_ordered: deliverableLabels(p.deliverables),
        delivered_categories: ev?.present ?? [],
        missing: ev?.missing ?? [],
        in_revision: p.revisionRequestedAt ? { since: etDate(p.revisionRequestedAt), note: scrub(p.revisionNote) || null } : null,
        // Billing block (price, balance, payment status, invoice link) is
        // OWNER-only — everyone else gets the project without the money.
        billing: seesMoney
          ? { total: p.price, balance_owed: p.paidMarkedAt || p.arRemovedAt ? 0 : dollars(p.balanceAmount), payment_status: p.paymentStatus, invoice_url: p.invoiceUrl }
          : undefined,
        open_tasks: p.smartTasks.map((t) => ({ type: t.taskType, title: scrub(t.title) || t.taskType, priority: t.priority, due: t.dueAt ? etDate(t.dueAt) : null })),
        recent_messages: p.messages.map((m) => ({ from: m.authorName, at: etDate(m.createdAt), text: scrub((m.body ?? "").slice(0, 280)) })),
        redaction_notice: seesMoney ? undefined : MONEY_BLIND_NOTICE,
        aryeo_url: p.aryeoListingId ? aryeoListingUrl(p.aryeoListingId) : p.aryeoOrderId ? aryeoOrderUrl(p.aryeoOrderId) : null, // the listing editor opens for everyone; the order page does not (Sep 15)
        hub_url: `/projects/${p.id}`,
      };
    }

    case "find_client": {
      const nm = String(input.name ?? "").trim();
      if (!nm) return { error: "Provide a name." };
      const clients = await prisma.client.findMany({
        where: { name: { contains: nm, mode: "insensitive" } },
        take: 5,
        select: {
          id: true, name: true, email: true, phone: true, company: true, segment: true,
          lifetimeSpendCents: true, transactionCount: true, socialClient: true, socialPlan: true,
          clientPreferences: true, editingPreferences: true, generalNotes: true,
          projects: {
            orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
            take: 6,
            select: { id: true, title: true, status: true, shootDate: true },
          },
          _count: { select: { projects: true } },
        },
      });
      if (!clients.length) return { error: `No client matching "${nm}".` };
      const money = canSeeMoney(ctx.role); // client financials are OWNER-only
      // Free-text client notes are where "she always asks for a discount, we
      // hold her at $325" lives. Redact for a money-blind viewer.
      const scrubC = scrubberFor(ctx.role);
      return {
        redaction_notice: money ? undefined : MONEY_BLIND_NOTICE,
        matches: clients.map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.segment,
          company: c.company,
          email: c.email,
          phone: c.phone,
          lifetime_spend: money ? dollars(c.lifetimeSpendCents) : undefined,
          completed_orders: c.transactionCount,
          total_projects: c._count.projects,
          social_plan: c.socialClient ? (c.socialPlan ?? "yes") : null,
          preferences: scrubC(c.clientPreferences) || null,
          editing_notes: scrubC(c.editingPreferences) || null,
          notes: scrubC(c.generalNotes) || null,
          recent_projects: c.projects.map((p) => ({ id: p.id, address: p.title, status: p.status, shoot: p.shootDate ? etDate(p.shootDate) : null })),
        })),
      };
    }

    case "get_schedule": {
      const { start, end, label } = resolveRange(input as { range?: string; from?: string; to?: string });
      const appts = await prisma.appointment.findMany({
        where: { startAt: { gte: start, lt: end }, status: { not: "CANCELED" } },
        orderBy: { startAt: "asc" },
        take: 60,
        select: {
          startAt: true, status: true,
          assignedTo: { select: { name: true } },
          project: { select: { id: true, title: true, client: { select: { name: true } } } },
        },
      });
      return {
        range: label,
        count: appts.length,
        shoots: appts.map((a) => ({
          address: a.project?.title ?? null,
          client: a.project?.client?.name ?? null,
          time: a.startAt ? etDateTime(a.startAt) : null,
          photographer: a.assignedTo?.name ?? "unassigned",
          project_id: a.project?.id ?? null,
        })),
      };
    }

    case "list_tasks": {
      const scope = String(input.scope ?? "open").toLowerCase();
      const taskType = typeof input.taskType === "string" ? input.taskType.trim() : "";
      const limit = Math.min(Number(input.limit) || 25, 40);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { status: { notIn: ["COMPLETED", "CANCELLED"] } };
      if (scope === "overdue") where.dueAt = { lt: new Date() };
      if (taskType) where.taskType = taskType;
      const tasks = await prisma.smartTask.findMany({
        where,
        take: limit,
        orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
        select: {
          taskType: true, title: true, priority: true, dueAt: true, propertyAddress: true,
          client: { select: { name: true } },
          project: { select: { id: true, title: true } },
        },
      });
      // Task titles carry amounts ("Invoice Jamie $450"). Keep the to-do, drop
      // the figure — Kyle still has to do the chasing.
      const scrubT = scrubberFor(ctx.role);
      return {
        scope,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          type: t.taskType,
          title: scrubT(t.title) || t.taskType,
          priority: t.priority,
          due: t.dueAt ? etDate(t.dueAt) : null,
          client: t.client?.name ?? null,
          address: t.project?.title ?? t.propertyAddress ?? null,
          project_id: t.project?.id ?? null,
        })),
      };
    }

    case "get_billing": {
      // Accounts receivable IS the money. OWNER only (Jordan, Sep 2 2026) — this
      // used to be admin-and-up, which handed Kyle every client's balance and the
      // company's total outstanding in one call.
      if (!canSeeMoney(ctx.role)) {
        return { error: "Billing, invoice totals and outstanding balances are owner-only. Say so plainly and do not estimate any figure." };
      }
      const { rows, totalOutstanding } = await getBillingRows();
      return {
        total_outstanding: Math.round(totalOutstanding * 100) / 100,
        count: rows.length,
        jobs: rows.slice(0, 40).map((r) => ({
          address: r.title,
          client: r.clientName,
          outstanding: r.outstanding,
          invoice_total: r.invoiceTotal,
          delivered: r.deliveredAt ? etDate(r.deliveredAt) : null,
          open_tasks: r.openTasks,
          project_id: r.id,
        })),
      };
    }

    case "day_summary": {
      const dateStr = typeof input.date === "string" && input.date ? input.date : null;
      const start = dateStr ? etDayStartUtc(new Date(`${dateStr}T12:00:00-05:00`)) : etDayStartUtc(new Date());
      const end = etAddDays(start, 1);
      const [completed, delivered, shoots] = await Promise.all([
        prisma.smartTask.findMany({
          where: { status: "COMPLETED", completedAt: { gte: start, lt: end } },
          take: 60,
          select: { taskType: true, title: true, project: { select: { title: true } } },
        }),
        prisma.project.findMany({
          where: { deliveredAt: { gte: start, lt: end } },
          take: 40,
          select: { id: true, title: true, client: { select: { name: true } } },
        }),
        prisma.appointment.findMany({
          where: { startAt: { gte: start, lt: end }, status: { not: "CANCELED" } },
          take: 40,
          orderBy: { startAt: "asc" },
          select: { startAt: true, project: { select: { title: true } }, assignedTo: { select: { name: true } } },
        }),
      ]);
      const scrubD = scrubberFor(ctx.role); // completed-task titles can quote amounts
      return {
        date: etFullDate(start),
        shoots: shoots.map((s) => ({ address: s.project?.title ?? null, time: s.startAt ? etDateTime(s.startAt) : null, photographer: s.assignedTo?.name ?? null })),
        deliveries: delivered.map((d) => ({ address: d.title, client: d.client?.name ?? null })),
        completed_tasks: completed.map((t) => ({ type: t.taskType, title: scrubD(t.title) || t.taskType, address: t.project?.title ?? null })),
        counts: { shoots: shoots.length, deliveries: delivered.length, tasks_completed: completed.length },
      };
    }

    case "search_knowledge": {
      const q = String(input.query ?? "").toLowerCase();
      const terms = q.split(/\s+/).filter((w) => w.length > 2);
      if (!terms.length) return { sops: [], resources: [] };
      const [sopsAll, resourcesAll] = await Promise.all([prisma.sop.findMany(), prisma.resource.findMany()]);
      // The SOP shelf holds the pricing sheet, the invoicing SOP and the payroll
      // runbook alongside the shoot and delivery ones. A money-blind viewer never
      // sees the money ones at all — same filter /resources already applies to
      // creatives — and the ones they do see come back with figures redacted.
      const seesMoneyK = canSeeMoney(ctx.role);
      const scrubK = scrubberFor(ctx.role);
      const sops = seesMoneyK ? sopsAll : sopsAll.filter((s) => !MONEY_SUBJECT.test(`${s.title} ${s.category}`));
      const resources = seesMoneyK
        ? resourcesAll
        : resourcesAll.filter((r) => !MONEY_SUBJECT.test(`${r.title} ${r.category} ${r.description ?? ""}`) && !/quickbooks|stripe|venmo/i.test(r.url));
      const score = (text: string) => terms.reduce((s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0), 0);
      const sopHits = sops
        .map((s) => ({ s, score: score(`${s.title} ${s.summary ?? ""} ${s.content} ${s.category}`) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      const resHits = resources
        .map((r) => ({ r, score: score(`${r.title} ${r.description ?? ""} ${r.category}`) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
      return {
        sops: sopHits.map((h) => ({ title: scrubK(h.s.title) || h.s.category, category: h.s.category, content: scrubK(h.s.content.slice(0, 1200)) })),
        resources: resHits.map((h) => ({ title: scrubK(h.r.title) || h.r.category, url: h.r.url, category: h.r.category })),
        redaction_notice: seesMoneyK ? undefined : MONEY_BLIND_NOTICE,
      };
    }

    case "search_business_knowledge": {
      const q = String(input.query ?? "").toLowerCase();
      const category = typeof input.category === "string" ? input.category.trim().toLowerCase() : "";
      const limit = Math.min(Number(input.limit) || 8, 15);
      const terms = q.split(/\s+/).filter((w) => w.length > 2);
      // STRICT role gate: only items at or below the viewer's role are even fetched.
      const allowed = allowedRolesFor(ctx.role);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { archived: false, minRole: { in: allowed } };
      // SECOND gate, orthogonal to minRole: money blindness. The tier gate alone
      // is not enough — a live count on Sep 2 2026 found 98 `pricing`, 11 `fee`
      // and ~1,600 other items sitting at minRole ADMIN, i.e. Jordan's real rate
      // card and fee logic were one question away for Kyle. Money-subject
      // CATEGORIES are excluded from the query, money-subject TITLES are dropped
      // after scoring, and every surviving body is redacted.
      const seesMoneyB = canSeeMoney(ctx.role);
      const scrubB = scrubberFor(ctx.role);
      if (!seesMoneyB) where.category = { notIn: MONEY_CATEGORIES };
      if (category) {
        // Asking for the money shelf by name gets a clean refusal, not an empty
        // result the model would try to explain away.
        if (!seesMoneyB && MONEY_CATEGORIES.includes(category)) {
          return { error: `The "${category}" knowledge is owner-only. Say so plainly and do not estimate any amount.`, viewer_role: ctx.role };
        }
        where.category = category;
      }
      // Keyword prefilter in SQL so the KB scales past a few hundred rows (the
      // ingested training courses add thousands of transcript chunks). Fetch
      // TITLE/tag matches (few, high-signal) and BODY matches (capped) SEPARATELY
      // then merge — so a specific lesson title is never crowded out of the slice
      // by a common word that appears in thousands of chunks.
      const sel = { id: true, category: true, title: true, body: true, minRole: true, tags: true, confidence: true } as const;
      let items: { id: string; category: string; title: string; body: string; minRole: string; tags: string | null; confidence: number | null }[];
      if (terms.length) {
        const [titleHits, bodyHits] = await Promise.all([
          prisma.knowledgeItem.findMany({ where: { ...where, OR: terms.flatMap((t) => [{ title: { contains: t, mode: "insensitive" } }, { tags: { contains: t, mode: "insensitive" } }]) }, take: 300, select: sel }),
          prisma.knowledgeItem.findMany({ where: { ...where, OR: terms.map((t) => ({ body: { contains: t, mode: "insensitive" } })) }, take: 500, select: sel }),
        ]);
        const seen = new Set<string>();
        items = [...titleHits, ...bodyHits].filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
      } else {
        items = await prisma.knowledgeItem.findMany({ where, take: 200, select: sel });
      }
      const score = (it: { title: string; body: string; tags: string | null }) => {
        const hay = `${it.title} ${it.body} ${it.tags ?? ""}`.toLowerCase();
        let s = 0;
        for (const t of terms) if (hay.includes(t)) s += hay.includes(` ${t} `) || it.title.toLowerCase().includes(t) ? 2 : 1;
        return s;
      };
      const hits = items
        .map((it) => ({ it, s: terms.length ? score(it) : 1 }))
        .filter((x) => x.s > 0)
        // A "Reel pricing" item filed under `strategy` slipped the category gate;
        // its title gives it away, so drop it here before it is ever quoted.
        .filter((x) => seesMoneyB || !MONEY_SUBJECT.test(x.it.title))
        .sort((a, b) => b.s - a.s || (b.it.confidence ?? 0) - (a.it.confidence ?? 0))
        .slice(0, limit);
      return {
        viewer_role: ctx.role,
        count: hits.length,
        knowledge: hits
          .map((h) => {
            // Bound the returned text so a long lesson/chunk can't blow the Hub's
            // context (most curated facts are well under this; only long training
            // transcript chunks get clipped), THEN redact.
            const raw = h.it.body.length > 2600 ? h.it.body.slice(0, 2600) + "…" : h.it.body;
            // The TITLE carries figures too — these facts are titled like
            // sentences ("Airbnb photography rate is $350 for 0-2500 sqft").
            // Redact it on the same rule as the body, or the headline leaks
            // exactly what the body no longer says.
            return { category: h.it.category, title: scrubB(h.it.title), insight: scrubB(raw), sensitivity: h.it.minRole };
          })
          // A fact that was nothing but money reduces to nothing: don't hand the
          // model an empty husk with a suggestive title still attached.
          .filter((k) => k.insight.length > 0 && k.title.length > 0),
        redaction_notice: seesMoneyB ? undefined : MONEY_BLIND_NOTICE,
      };
    }

    case "search_comms": {
      // Client comms are sensitive: admin + owner only, never creatives.
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Client communication history is available to admin and owner roles only." };
      }
      const person = typeof input.person === "string" && input.person.trim()
        ? input.person.trim()
        : typeof input.client === "string" ? input.client.trim() : "";
      const query = typeof input.query === "string" ? input.query.trim() : "";
      const limit = Math.min(Number(input.limit) || 12, 25);
      // Per-row sensitivity: an ADMIN sees ADMIN-tier comms but NOT owner-only
      // ones (e.g. Jordan's Slack DMs); OWNER sees everything.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { minRole: { in: allowedRolesFor(ctx.role) } };
      if (person) {
        const matches = await prisma.client.findMany({
          where: { name: { contains: person, mode: "insensitive" } },
          select: { id: true }, take: 10,
        });
        const ids = matches.map((m) => m.id);
        // Match a client (by id or denormalized name) OR a teammate (contactName).
        where.OR = [
          ...(ids.length ? [{ clientId: { in: ids } }] : []),
          { clientName: { contains: person, mode: "insensitive" } },
          { contactName: { contains: person, mode: "insensitive" } },
        ];
      }
      if (query) where.body = { contains: query, mode: "insensitive" };
      const rows = await prisma.commLog.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: limit,
        select: { channel: true, direction: true, clientName: true, contactName: true, subject: true, body: true, occurredAt: true },
      });
      // Real threads quote real amounts — "invoice is $1,200", "we did 299 last
      // time", Slack DMs about what an editor gets paid. Redact per viewer: the
      // conversation stays readable so Kyle can answer it, the numbers go.
      const scrubM = scrubberFor(ctx.role);
      const seesMoneyC = canSeeMoney(ctx.role);
      return {
        count: rows.length,
        messages: rows.map((r) => ({
          when: etDateTime(r.occurredAt),
          channel: r.channel,
          who: r.direction === "out" ? "Us" : r.contactName || r.clientName || "Client",
          subject: (r.subject ? scrubM(r.subject) : "") || undefined,
          text: scrubM(r.body.slice(0, 600)),
        })),
        redaction_notice: seesMoneyC ? undefined : MONEY_BLIND_NOTICE,
      };
    }

    case "draft_client_message": {
      // Drafting client comms is an admin/owner action (creatives don't message clients).
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Drafting client messages is available to admin and owner roles only." };
      }
      const name2 = String(input.client ?? "").trim();
      if (!name2) return { error: "Which client?" };
      const channel = input.channel === "email" ? "email" : "text";
      const intent = typeof input.intent === "string" ? input.intent.trim() : "";
      const c = await prisma.client.findFirst({
        where: { name: { contains: name2, mode: "insensitive" } },
        select: {
          id: true, name: true, phone: true, email: true, segment: true, socialClient: true, socialPlan: true,
          projects: { orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }], take: 6, select: { title: true, status: true } },
        },
      });
      if (!c) return { error: `No client matching "${name2}".` };
      // Pull the real recent thread (client-facing channels only) for context.
      const comms = await prisma.commLog.findMany({
        where: { clientId: c.id, channel: { in: ["text", "email", "call"] } },
        orderBy: { occurredAt: "desc" }, take: 14,
        select: { direction: true, body: true, occurredAt: true },
      });
      // The transcript is what the drafter reads AND what comes back to the user
      // as context. For a money-blind viewer it is redacted before it is used, so
      // the draft cannot contain a figure the viewer was never allowed to see.
      const scrubDraft = scrubberFor(ctx.role);
      const transcript = comms.reverse().map((m) => ({
        role: (m.direction === "out" ? "us" : "client") as "us" | "client",
        text: scrubDraft(m.body), at: m.occurredAt.toISOString(),
      })).filter((m) => m.text.length > 0);
      const { draftReplyWithContext } = await import("@/lib/integrations/ai");
      const draft = await draftReplyWithContext({
        channel,
        clientName: c.name,
        segment: c.segment ?? null,
        socialPlan: c.socialClient ? (c.socialPlan ?? "yes") : null,
        propertyAddress: c.projects[0]?.title ?? null,
        projects: c.projects,
        transcript: transcript.length ? transcript : [{ role: "client", text: intent || "(no recent message — write a brief, friendly check-in)" }],
        note: intent || null,
      });
      const phoneOk = !!c.phone && c.phone.replace(/\D/g, "").length >= 10;
      const noReply = /^\s*NO_REPLY_NEEDED\s*$/i.test(draft);
      // Strip a leaked reasoning preamble ("...here is the reply:") only when it's
      // clearly meta (reply/draft/message/text), so legit lines like "here is the
      // link:" inside the message aren't cut. Then trim wrapping quotes.
      let clean = draft;
      const marker = draft.match(/\bhere(?:'s| is)\s+(?:the |a |my )?(?:reply|draft|text|message|response|note)\b[^:\n]{0,20}:\s*([\s\S]+)$/i);
      if (marker) clean = marker[1];
      clean = clean.trim().replace(/^["“']|["”']$/g, "").trim();
      return {
        drafted: true,
        client_id: c.id,
        client_name: c.name,
        channel,
        can_text: phoneOk,
        message: noReply ? "" : clean,
        note: noReply ? "Nothing seems to need a reply right now." : undefined,
      };
    }

    case "complete_task": {
      if (ctx.impersonating) return { error: "You're previewing another user — exit View As first." };
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Completing tasks is available to admin and owner roles only." };
      }
      const q = String(input.task ?? "").trim();
      if (!q) return { error: "Which task?" };
      const reopen = input.reopen === true;
      const matches = await prisma.smartTask.findMany({
        where: {
          status: reopen ? "COMPLETED" : { notIn: ["COMPLETED", "CANCELLED"] },
          OR: q.split(/\s+/).filter((w) => w.length > 2).map((w) => ({ title: { contains: w, mode: "insensitive" as const } })),
        },
        orderBy: { createdAt: "desc" },
        take: 25, // score over a real pool — 5-newest could exclude the true match (review)
        select: { id: true, title: true, taskType: true, status: true },
      });
      const scored = matches
        .map((m) => ({ m, hits: q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && m.title.toLowerCase().includes(w)).length }))
        .sort((a, b) => b.hits - a.hits);
      const best = scored[0];
      if (!best || best.hits === 0) return { error: `No ${reopen ? "completed" : "open"} task matches “${q}”.` };
      if (scored.length > 1 && scored[1].hits === best.hits) {
        return { ambiguous: scored.slice(0, 3).map((x) => x.m.title), note: "Say which one you mean." };
      }
      await prisma.smartTask.update({
        where: { id: best.m.id },
        data: reopen ? { status: "OPEN", completedAt: null } : { status: "COMPLETED", completedAt: new Date() },
      });
      return { done: true, task: best.m.title, nowStatus: reopen ? "OPEN" : "COMPLETED" };
    }

    case "assign_task": {
      if (ctx.impersonating) return { error: "You're previewing another user — exit View As first." };
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Assigning tasks is available to admin and owner roles only." };
      }
      const q = String(input.task ?? "").trim();
      let who = String(input.person ?? "").trim().toLowerCase();
      if (!q || !who) return { error: "Which task, and to whom?" };
      const { listAssignees, slugForName } = await import("@/lib/assignees");
      const roster = await listAssignees();
      if (who === "me" || who === "myself") who = ctx.who ? slugForName(ctx.who) : who;
      const target = roster.find((a) => a.key === slugForName(who) || a.name.toLowerCase().startsWith(who));
      if (!target) return { error: `I don't know “${input.person}” — people here: ${roster.map((a) => a.name).join(", ")}.` };
      const matches = await prisma.smartTask.findMany({
        where: {
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          OR: q.split(/\s+/).filter((w) => w.length > 2).map((w) => ({ title: { contains: w, mode: "insensitive" as const } })),
        },
        orderBy: { createdAt: "desc" },
        take: 25, // score over a real pool (review)
        select: { id: true, title: true },
      });
      const scored2 = matches
        .map((m) => ({ m, hits: q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && m.title.toLowerCase().includes(w)).length }))
        .sort((a, b) => b.hits - a.hits);
      const best2 = scored2[0];
      if (!best2 || best2.hits === 0) return { error: `No open task matches “${q}”.` };
      if (scored2.length > 1 && scored2[1].hits === best2.hits) {
        return { ambiguous: scored2.slice(0, 3).map((x) => x.m.title), note: "Say which one you mean." };
      }
      // Human assignment through chat IS manual — the engines must respect it.
      await prisma.smartTask.update({ where: { id: best2.m.id }, data: { assignedKey: target.key, assignedManually: true } });
      return { done: true, task: best2.m.title, assignedTo: target.name };
    }

    case "list_reply_queue": {
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "The reply queue is admin/owner only." };
      }
      const { replyQueue } = await import("@/lib/replyQueue");
      const rq = await replyQueue();
      const scrubR = scrubberFor(ctx.role); // inbound texts quote invoice amounts
      return {
        waiting: rq.cards.slice(0, 12).map((c) => ({
          client: c.displayName,
          theirMessage: scrubR(c.lastInbound.slice(0, 200)),
          canTextBack: !!c.phone,
        })),
        count: rq.cards.length,
        note: "Send from Communications → Replies (each has a pre-drafted answer), or tell me which one to draft here.",
      };
    }

    case "send_drafted_texts": {
      if (ctx.impersonating) return { error: "You're previewing another user — exit View As first." };
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "The Outbox is admin/owner only." };
      }
      const { listDraftedTexts, sendDraftText } = await import("@/app/tasks/sendAllActions");
      const listed = await listDraftedTexts();
      if (!listed.ok || !listed.rows?.length) return { texts: [], note: "The Outbox is empty — nothing drafted to send." };
      if (input.confirm !== true) {
        // REVIEW step — listing only. The human must read these and explicitly
        // say “send” before the confirm call. The hub never texts on its own.
        return {
          review: listed.rows.map((r) => ({
            to: r.clientName, kind: r.taskType, street: r.street, text: r.body, blocked: r.blocked,
            held: r.warnStale ? "STALE — the shoot time may already have passed; this one will NOT send in the batch (handle it on the Outbox)" : null,
          })),
          count: listed.rows.length,
          note: "Nothing sent. Show the user this list (including any held/stale rows); only when they explicitly say to send, call again with confirm:true.",
        };
      }
      const results: { to: string; ok: boolean; message: string }[] = [];
      for (const r of listed.rows) {
        if (r.blocked) { results.push({ to: r.clientName, ok: false, message: r.blocked }); continue; }
        // The Outbox loads stale confirmations UNTICKED — the batch must never
        // fire one (review finding). Same rule here: held, not sent.
        if (r.warnStale) { results.push({ to: r.clientName, ok: false, message: "held — possibly stale confirmation; review it on the Outbox" }); continue; }
        const res = await sendDraftText(r.taskId, r.body).catch((e) => ({ ok: false, message: (e as Error).message }));
        results.push({ to: r.clientName, ok: res.ok, message: res.message });
      }
      return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), note: "Each send used the same reviewed draft the Outbox shows." };
    }

    case "create_task": {
      // "View as" is read-only — same rule as the server-action guards.
      if (ctx.impersonating) {
        return { error: "You're previewing another user — exit the View As preview to create tasks." };
      }
      // Creating to-dos is an admin/owner action.
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Creating tasks is available to admin and owner roles only." };
      }
      const title = String(input.title ?? "").trim();
      if (!title) return { error: "What should the task say?" };
      const detail = typeof input.detail === "string" ? input.detail.trim() : "";
      const priIn = String(input.priority ?? "MEDIUM").toUpperCase();
      const priority = ["URGENT", "HIGH", "MEDIUM", "LOW"].includes(priIn) ? priIn : "MEDIUM";

      // Optional project / client linkage by name.
      let projectId: string | null = null, clientId: string | null = null, address: string | null = null;
      const projName = typeof input.project === "string" ? input.project.trim() : "";
      const cliName = typeof input.client === "string" ? input.client.trim() : "";
      if (projName) {
        const p = await prisma.project.findFirst({
          where: { title: { contains: projName, mode: "insensitive" } },
          orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }],
          select: { id: true, title: true, clientId: true },
        });
        if (p) { projectId = p.id; clientId = p.clientId; address = p.title; }
      }
      if (!clientId && cliName) {
        const c = await prisma.client.findFirst({ where: { name: { contains: cliName, mode: "insensitive" } }, select: { id: true } });
        if (c) clientId = c.id;
      }

      // Due date: explicit YYYY-MM-DD (ET, ~5pm) or default to tomorrow.
      let dueAt: Date;
      const dd = typeof input.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : "";
      if (dd) dueAt = etEndOfDay(dd); // 5pm ET, DST-safe
      else dueAt = etAddDays(etDayStartUtc(new Date()), 1);

      // Don't duplicate: if the same assistant to-do (same title, same order) is
      // already open, return it instead of making another.
      const dup = await prisma.smartTask.findFirst({
        where: {
          source: "assistant",
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          projectId: projectId ?? null,
          title: { equals: title.slice(0, 140), mode: "insensitive" },
        },
        select: { id: true },
      });
      const kyle = dup ? null : await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
      const task = dup ?? await prisma.smartTask.create({
        data: {
          taskType: "internal_instruction",
          title: title.slice(0, 140),
          summary: detail || `Added from Ask the Hub: ${title}`.slice(0, 500),
          description: detail || null,
          reasonCreated: "Added from Ask the Hub",
          source: "assistant",
          priority,
          dueAt,
          ownerId: kyle?.id ?? null,
          projectId,
          clientId,
          propertyAddress: address,
        },
        select: { id: true },
      });
      return {
        created_task: true,
        id: task.id,
        title: title.slice(0, 140),
        priority,
        due: etDate(dueAt),
        project: address,
        href: projectId ? `/projects/${projectId}` : "/queue",
      };
    }

    case "remember_fact": {
      // "View as" is read-only — and a fact taught mid-preview would be
      // misattributed to the impersonated role.
      if (ctx.impersonating) {
        return { error: "You're previewing another user — exit the View As preview to save to memory." };
      }
      // Teaching the brain is an admin/owner action; creatives can't write memory.
      if ((ROLE_RANK[ctx.role] ?? ROLE_RANK.CREATIVE) < ROLE_RANK.ADMIN) {
        return { error: "Saving to the hub's memory is available to admin and owner roles only." };
      }
      const { learnFact } = await import("@/lib/learn");
      const res = await learnFact({
        title: String(input.title ?? ""),
        fact: String(input.fact ?? ""),
        category: typeof input.category === "string" ? input.category : undefined,
        minRole: typeof input.min_role === "string" ? input.min_role : undefined,
        correction: input.correction === true,
        teacherRole: ctx.role,
      });
      if (!res.ok) return { error: res.error ?? "Could not save that." };
      if (res.noop) {
        // Already in memory verbatim — tell the model, but render no card.
        return { remembered: false, already_known: true, title: res.title };
      }
      return {
        remembered: true,
        id: res.id,
        title: res.title,
        category: res.category,
        min_role: res.minRole,
        superseded: res.superseded,
      };
    }

    case "save_document": {
      if (ctx.impersonating) return { error: "Read-only preview — documents can't be saved from 'view as'." };
      const title = String(input.title ?? "").trim();
      const markdown = String(input.markdown ?? "").trim();
      if (!title) return { error: "A document needs a title." };
      // Refuse to save meta-chatter as a document. The finance advisor hit this:
      // the model would answer "let me compose that" and the answer got saved as
      // the report body. A stub with a title is worse than no document, because
      // it looks like the work was done.
      if (markdown.length < 200) {
        return { error: "That's too short to be a document — compose the full markdown and call save_document again." };
      }
      const KINDS = ["report", "sop", "brief", "plan", "summary", "doc"];
      const kind = KINDS.includes(String(input.kind)) ? String(input.kind) : "report";
      const row = await prisma.hubDocument.create({
        data: {
          title: title.slice(0, 160),
          kind,
          markdown: markdown.slice(0, 120_000),
          createdBy: ctx.who ?? null,
        },
        select: { id: true, title: true, kind: true },
      });
      return {
        document_saved: true,
        id: row.id,
        title: row.title,
        kind: row.kind,
        href: `/assistant/docs/${row.id}`,
        note: "Saved. Tell Jordan it's saved and that he can open it from Documents — do not paste the whole document back into the chat.",
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
