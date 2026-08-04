import "server-only";

import { prisma } from "@/lib/prisma";
import type { HubTool } from "@/lib/integrations/ai";
import { bookingTrends, serviceTrends, topSpenders } from "@/lib/trends";
import { getPackageMargins } from "@/lib/packageMargin";
import { recurringRevenue } from "@/lib/recurring";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Trends tools — the growth advisor's read-only view of the business.
// OWNER-ONLY: the calling action must guard before exec.
//
// Every tool reads the SAME engines the Trends page renders, so the advisor and
// the page can never quote different numbers at each other. Nothing here writes.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const r0 = (n: number) => Math.round(n);
const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

export const TRENDS_TOOLS: HubTool[] = [
  {
    name: "current_datetime",
    description: "Today's date (Eastern Time). Call first for any relative-date question (this month, last quarter, year to date).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "booking_pace",
    description:
      "How many jobs are being BOOKED and at what average ticket: today / 7d / 30d / past year, each vs the prior equal window and vs a year ago; average bookings per week (4, 12, 52 week horizons); this month's projection vs last month at the same point; median lead time from order to shoot; and the monthly order/revenue series. Start here for 'are we slow?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "package_mix",
    description:
      "Every package sold this year by real Aryeo product name: orders, share of all orders, exact line-item revenue, revenue per order, and 90-day momentum vs the prior 90. Use for 'what sells', 'what is growing', 'what is dying'.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "max packages (default 30)" } } },
  },
  {
    name: "package_margins",
    description:
      "What each package actually EARNS after the photographer payroll and the editors are paid: revenue, cost, margin, margin %, and margin per order. Costs come from the same audited payroll/editing engines as the Finance tab. Use for pricing, bundling and 'which product should I push'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "top_clients",
    description:
      "Biggest spenders this year: YTD revenue, jobs, average ticket, 90-day trend, days since their last order and their own normal booking gap. Also revenue concentration (what share the top 5 and top 10 represent).",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "max clients (default 20)" } } },
  },
  {
    name: "quiet_clients",
    description:
      "Regulars who have gone quiet — past DOUBLE their own normal booking gap, with at least three orders behind them. Returns each one with what they normally spend, plus the combined YTD revenue and the combined annual value (actual dollars paid over the last 12 months). Use for win-back questions and 'what is at risk'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "recurring_revenue",
    description:
      "The SECOND revenue rail, which appears in no other tool: monthly social-content retainers (Video Starter / Accelerator / Pro) billed in QuickBooks, plus one-off content passes. Returns live retainers with their monthly amount, retainers that have LAPSED (stopped billing — all of these are real churn, even where the client later bought a pass, because passes and retainers are held at the same time and one does not replace the other), the monthly run rate and the year to date. Every other tool reports Aryeo per-listing money ONLY, so a retainer client's true value is their Aryeo figure PLUS what this returns. Use for anything about recurring revenue, churn, or which clients to convert to a retainer.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "client_history",
    description:
      "One client's full order history by name: every order with its date, value and the packages on it. Use before recommending anything to a specific client so the advice fits what they actually buy.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Client name, or part of it" } },
      required: ["name"],
    },
  },
  {
    name: "package_buyers",
    description:
      "Who buys a given package, and who does NOT. Returns the clients who have ordered it (with counts) and the top clients who never have — the actual upsell list for that product.",
    input_schema: {
      type: "object",
      properties: { package_name: { type: "string", description: "Package name or part of it, e.g. 'influencer'" } },
      required: ["package_name"],
    },
  },
];

export async function execTrendsTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "current_datetime":
      return { today: etDayKey(new Date()), timezone: "America/New_York" };

    case "booking_pace": {
      const b = await bookingTrends();
      return {
        windows: b.windows.map((w) => ({
          window: w.label,
          orders: w.count,
          revenue: r0(w.revenue),
          avgTicket: r0(w.avgTicket),
          priorWindowOrders: w.prevCount,
          vsPriorPct: w.countChangePct == null ? null : Math.round(w.countChangePct),
          yearAgoOrders: w.yoyCount,
          yoyPct: w.yoyChangePct == null ? null : Math.round(w.yoyChangePct),
          cancelled: w.cancelled,
        })),
        avgBookingsPerWeek: b.avgPerWeek,
        projection: b.projection,
        medianLeadTimeDays: b.leadTimeDays.median,
        busiestOrderWeekday: b.busiestDow,
        monthly: b.monthly.map((m) => ({
          month: m.key,
          orders: m.count,
          revenue: r0(m.revenue),
          avgTicket: m.count ? r0(m.revenue / m.count) : 0,
        })),
      };
    }

    case "package_mix": {
      const s = await serviceTrends();
      const limit = Math.min(Math.max(num(input.limit, 30), 1), 60);
      return {
        basis: s.exactRevenue ? "exact Aryeo line items" : "estimated attribution (line-item backfill incomplete)",
        totalOrdersThisYear: s.totalOrders,
        soldOnceOnly: s.packageTail,
        packages: s.packages.slice(0, limit).map((p) => ({
          name: p.label,
          orders: p.orders,
          attachPct: Math.round(p.attachPct),
          revenue: r0(p.revenue),
          revenuePerOrder: p.orders ? r0(p.revenue / p.orders) : 0,
          last90Orders: p.last90,
          prior90Orders: p.prev90,
          change90dPct: p.changePct == null ? null : Math.round(p.changePct),
        })),
      };
    }

    case "package_margins": {
      // Reads the nightly snapshot. Running the engine here would drag the
      // payroll/OSRM cost into a chat turn that may already be a dozen model
      // round-trips deep.
      const stored = await getPackageMargins();
      if (!stored) return { available: false, note: "Margins have not been computed yet; the nightly job builds them." };
      const m = stored.data;
      return {
        period: { start: etDayKey(new Date(m.start)), end: etDayKey(new Date(m.end)), builtAt: etDayKey(stored.builtAt) },
        note: "Costs are exact photographer payroll plus editing, allocated to each package by what actually drives that cost (pay follows the eligible invoice, editing follows the deliverables). Windowed on SHOOT date, so it will not tie exactly to order-dated revenue. Monthly social retainer sessions (Video Starter/Accelerator/Pro) are EXCLUDED: they are billed on a recurring QuickBooks invoice and their Aryeo order is $0 by design, so no Aryeo-based margin exists for them.",
        jobsCosted: m.jobs,
        coveragePct: Math.round(m.coverage * 100),
        photoCostKnownPct: Math.round(m.photoCostKnown * 100),
        totals: { revenue: r0(m.revenue), cost: r0(m.cost), margin: r0(m.margin), marginPct: m.marginPct == null ? null : Math.round(m.marginPct) },
        packages: m.rows.map((p) => ({
          name: p.label,
          orders: p.orders,
          revenue: r0(p.revenue),
          photographerCost: r0(p.photographerCost),
          editingCost: r0(p.editingCost),
          margin: r0(p.margin),
          marginPct: p.marginPct == null ? null : Math.round(p.marginPct),
          revenuePerOrder: r0(p.perOrderRevenue),
          marginPerOrder: r0(p.perOrderMargin),
        })),
      };
    }

    case "top_clients": {
      const limit = Math.min(Math.max(num(input.limit, 20), 1), 50);
      const s = await topSpenders(limit);
      return {
        ytdTotalRevenue: r0(s.ytdTotal),
        concentrationTop5Pct: Math.round(s.concentrationTop5),
        concentrationTop10Pct: Math.round(s.concentrationTop10),
        clients: s.rows.map((r) => ({
          name: r.name,
          company: r.company,
          segment: r.segment,
          ytdRevenue: r0(r.ytdRevenue),
          ytdJobs: r.ytdJobs,
          lifetimeRevenue: r0(r.lifetimeRevenue),
          avgTicket: r0(r.avgTicket),
          change90dPct: r.changePct == null ? null : Math.round(r.changePct),
          daysSinceLastOrder: r.daysSinceLastOrder,
          normalGapDays: r.medianGapDays,
          goneQuiet: r.overdue,
        })),
      };
    }

    case "quiet_clients": {
      const s = await topSpenders(1);
      return {
        rule: "past double their own median booking gap (14-day floor), at least three orders behind them",
        count: s.quiet.count,
        combinedYtdRevenue: r0(s.quiet.ytdRevenue),
        combinedLifetimeRevenue: r0(s.quiet.lifetimeRevenue),
        combinedAnnualValue: r0(s.quiet.annualValue),
        annualValueNote: "Actual dollars these clients paid in the last 12 months, annualised over tenure for anyone newer than a year. Measured money, not a cadence projection.",
        clients: s.quiet.rows.map((r) => ({
          name: r.name,
          company: r.company,
          ytdRevenue: r0(r.ytdRevenue),
          ytdJobs: r.ytdJobs,
          lifetimeRevenue: r0(r.lifetimeRevenue),
          avgTicket: r0(r.avgTicket),
          lastTwelveMonths: r0(r.trailing365Revenue),
          normalGapDays: r.medianGapDays,
          silentDays: r.daysSinceLastOrder,
        })),
      };
    }

    case "recurring_revenue": {
      const r = await recurringRevenue();
      const row = (x: (typeof r.retainers)[number]) => ({
        client: x.clientName ?? x.customer,
        monthlyAmount: x.monthlyAmount,
        tier: x.tier,
        monthsBilled: x.monthsBilled,
        lastBilled: x.lastBilledISO,
        ytdRevenue: r0(x.ytdRevenue),
      });
      return {
        note: "Billed in QuickBooks, NOT Aryeo. None of this money appears in booking_pace, package_mix, package_margins or top_clients — add it to a client's Aryeo figure to get their true value. Their Aryeo orders show $0 by design so they can self-schedule a session already paid for.",
        monthlyRunRate: r0(r.monthlyRunRate),
        annualRunRate: r0(r.annualRunRate),
        ytdRetainerRevenue: r0(r.ytdRetainer),
        ytdPassRevenue: r0(r.ytdPasses),
        ytdTotal: r0(r.ytdTotal),
        sessionsDeliveredThisYear: r.sessionShoots,
        liveRetainers: r.retainers.map(row),
        lapsedRetainers: r.lapsed.map((x) => ({
          ...row(x),
          monthlyLost: x.monthlyAmount,
          // Context only. A pass bought afterwards does NOT mean they upgraded —
          // clients hold a pass and a monthly retainer at the same time.
          boughtPassSince: x.passSince ? x.passSince.amount : null,
        })),
        contentPasses: r.passes.map((p) => ({ client: p.customer, date: p.dateISO, amount: r0(p.amount) })),
      };
    }

    case "client_history": {
      const q = String(input.name ?? "").trim();
      if (!q) return { error: "Give me a client name." };
      const client = await prisma.client.findFirst({
        where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { company: { contains: q, mode: "insensitive" } }] },
        select: { id: true, name: true, company: true, segment: true },
      });
      if (!client) return { found: false, searched: q };
      const projects = await prisma.project.findMany({
        where: { clientId: client.id, orderedAt: { not: null } },
        select: {
          title: true, orderedAt: true, shootDate: true, price: true, payableInvoice: true, status: true,
          orderItems: { where: { isCanceled: false }, select: { title: true, amount: true } },
        },
        orderBy: { orderedAt: "desc" },
        take: 60,
      });
      return {
        found: true,
        client: { name: client.name, company: client.company, segment: client.segment },
        orderCount: projects.length,
        orders: projects.map((p) => ({
          address: p.title,
          orderedAt: p.orderedAt ? etDayKey(p.orderedAt) : null,
          shootDate: p.shootDate ? etDayKey(p.shootDate) : null,
          value: r0(p.payableInvoice ?? p.price ?? 0),
          status: p.status,
          packages: p.orderItems.map((i) => `${i.title} ($${r0(i.amount)})`),
        })),
      };
    }

    case "package_buyers": {
      const q = String(input.package_name ?? "").trim();
      if (!q) return { error: "Give me a package name." };
      const since = new Date(Date.now() - 400 * DAY);
      const items = await prisma.orderItem.findMany({
        where: { isCanceled: false, title: { contains: q, mode: "insensitive" }, project: { orderedAt: { gte: since } } },
        select: { title: true, amount: true, project: { select: { clientId: true, client: { select: { name: true } } } } },
      });
      if (items.length === 0) return { found: false, searched: q };
      const buyers = new Map<string, { name: string; orders: number; spend: number }>();
      for (const it of items) {
        const id = it.project?.clientId;
        const nm = it.project?.client?.name;
        if (!id || !nm) continue;
        const e = buyers.get(id) ?? { name: nm, orders: 0, spend: 0 };
        e.orders++;
        e.spend += it.amount || 0;
        buyers.set(id, e);
      }
      // The upsell list: biggest clients who have never bought this.
      const spenders = await topSpenders(40);
      const never = spenders.rows
        .filter((r) => !buyers.has(r.clientId))
        .slice(0, 15)
        .map((r) => ({ name: r.name, ytdRevenue: r0(r.ytdRevenue), ytdJobs: r.ytdJobs, avgTicket: r0(r.avgTicket) }));
      return {
        found: true,
        matchedTitles: [...new Set(items.map((i) => i.title))].slice(0, 10),
        buyerCount: buyers.size,
        buyers: [...buyers.values()].sort((a, b) => b.spend - a.spend).slice(0, 25).map((b) => ({ name: b.name, orders: b.orders, spend: r0(b.spend) })),
        neverBoughtIt: never,
      };
    }

    default:
      return { error: `Unknown tool ${name}` };
  }
}

function keyToDate(v: unknown, fallback: Date): Date {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T12:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }
  return fallback;
}
