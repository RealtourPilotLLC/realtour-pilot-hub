import "server-only";
import type { DeliverableType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBillingRows } from "@/lib/queries";
import { parseEvidence } from "@/lib/statusEvidence";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import { etDateTime, etDate, etDayKey, etDayStartUtc, etAddDays, etFullDate } from "@/lib/datetime";
import type { HubTool } from "@/lib/integrations/ai";

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
    description: "Look up a client by name. Returns profile: segment/tier, lifetime spend, order count, social-content plan, contact info, preferences, and their recent projects.",
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
    description: "Outstanding accounts receivable: every delivered Aryeo job with a balance still owed, plus the grand total. Use for 'who owes us money', 'what's our outstanding AR'.",
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
    description: "Search Jordan's distilled business knowledge: his preferences, decisions and their outcomes, goals, the recurring problems he has been working through, pricing/financial logic, client-handling rules, and how RealTour Pilot actually operates (learned from his history). Ground your judgment here whenever a question involves 'how do we / should we', pricing, a client situation, strategy, a recommendation, or what Jordan would want. Results are already filtered to what the current viewer is allowed to see.",
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
];

// Role tiers map onto the future per-user RBAC. A viewer sees an item only if
// their role rank is >= the item's required minRole rank.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };
function allowedRolesFor(viewer: string): string[] {
  const rank = ROLE_RANK[viewer] ?? ROLE_RANK.OWNER;
  return Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= rank);
}

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
  ctx: { role: string } = { role: "OWNER" },
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
          balanceAmount: true, paymentStatus: true,
          client: { select: { name: true } },
          deliverables: { select: { type: true, label: true } },
        },
      });
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
          balance_owed: dollars(p.balanceAmount),
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
          price: true, balanceAmount: true, paymentStatus: true, invoiceUrl: true,
          aryeoOrderId: true, statusEvidence: true, revisionNote: true, revisionRequestedAt: true, notes: true,
          client: { select: { id: true, name: true, segment: true } },
          photographer: { select: { name: true } },
          deliverables: { select: { type: true, label: true, status: true } },
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
        in_revision: p.revisionRequestedAt ? { since: etDate(p.revisionRequestedAt), note: p.revisionNote } : null,
        billing: { total: p.price, balance_owed: dollars(p.balanceAmount), payment_status: p.paymentStatus, invoice_url: p.invoiceUrl },
        open_tasks: p.smartTasks.map((t) => ({ type: t.taskType, title: t.title, priority: t.priority, due: t.dueAt ? etDate(t.dueAt) : null })),
        recent_messages: p.messages.map((m) => ({ from: m.authorName, at: etDate(m.createdAt), text: (m.body ?? "").slice(0, 280) })),
        aryeo_url: p.aryeoOrderId ? `https://app.aryeo.com/orders/${p.aryeoOrderId}` : null,
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
      return {
        matches: clients.map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.segment,
          company: c.company,
          email: c.email,
          phone: c.phone,
          lifetime_spend: dollars(c.lifetimeSpendCents),
          completed_orders: c.transactionCount,
          total_projects: c._count.projects,
          social_plan: c.socialClient ? (c.socialPlan ?? "yes") : null,
          preferences: c.clientPreferences || null,
          editing_notes: c.editingPreferences || null,
          notes: c.generalNotes || null,
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
      return {
        scope,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          type: t.taskType,
          title: t.title,
          priority: t.priority,
          due: t.dueAt ? etDate(t.dueAt) : null,
          client: t.client?.name ?? null,
          address: t.project?.title ?? t.propertyAddress ?? null,
          project_id: t.project?.id ?? null,
        })),
      };
    }

    case "get_billing": {
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
      return {
        date: etFullDate(start),
        shoots: shoots.map((s) => ({ address: s.project?.title ?? null, time: s.startAt ? etDateTime(s.startAt) : null, photographer: s.assignedTo?.name ?? null })),
        deliveries: delivered.map((d) => ({ address: d.title, client: d.client?.name ?? null })),
        completed_tasks: completed.map((t) => ({ type: t.taskType, title: t.title, address: t.project?.title ?? null })),
        counts: { shoots: shoots.length, deliveries: delivered.length, tasks_completed: completed.length },
      };
    }

    case "search_knowledge": {
      const q = String(input.query ?? "").toLowerCase();
      const terms = q.split(/\s+/).filter((w) => w.length > 2);
      if (!terms.length) return { sops: [], resources: [] };
      const [sops, resources] = await Promise.all([prisma.sop.findMany(), prisma.resource.findMany()]);
      const score = (text: string) => terms.reduce((s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0), 0);
      const sopHits = sops
        .map((s) => ({ s, score: score(`${s.title} ${s.summary ?? ""} ${s.content} ${s.category}`) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      const resHits = resources
        .map((r) => ({ r, score: score(`${r.title} ${r.description ?? ""} ${r.category}`) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
      return {
        sops: sopHits.map((h) => ({ title: h.s.title, category: h.s.category, content: h.s.content.slice(0, 1200) })),
        resources: resHits.map((h) => ({ title: h.r.title, url: h.r.url, category: h.r.category })),
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
      if (category) where.category = category;
      const items = await prisma.knowledgeItem.findMany({
        where,
        take: 400,
        select: { category: true, title: true, body: true, minRole: true, tags: true, confidence: true },
      });
      const score = (it: { title: string; body: string; tags: string | null }) => {
        const hay = `${it.title} ${it.body} ${it.tags ?? ""}`.toLowerCase();
        let s = 0;
        for (const t of terms) if (hay.includes(t)) s += hay.includes(` ${t} `) || it.title.toLowerCase().includes(t) ? 2 : 1;
        return s;
      };
      const hits = items
        .map((it) => ({ it, s: terms.length ? score(it) : 1 }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || (b.it.confidence ?? 0) - (a.it.confidence ?? 0))
        .slice(0, limit);
      return {
        viewer_role: ctx.role,
        count: hits.length,
        knowledge: hits.map((h) => ({
          category: h.it.category,
          title: h.it.title,
          insight: h.it.body,
          sensitivity: h.it.minRole,
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
