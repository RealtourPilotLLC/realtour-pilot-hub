import "server-only";

import { prisma } from "@/lib/prisma";
import type { HubTool } from "@/lib/integrations/ai";

// ---------------------------------------------------------------------------
// Finance tools — the AI CPA / Financial Advisor's read-only view of the money.
// OWNER-ONLY: the calling action must guard with requireOwner() before exec.
// Every tool reads the same audited engines the Finance tabs render, so the
// advisor's numbers always match the dashboard.
// ---------------------------------------------------------------------------

const D = (s: unknown, fallback: string) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback);
const yearStart = () => `${new Date().getUTCFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export const FINANCE_TOOLS: HubTool[] = [
  {
    name: "current_datetime",
    description: "Today's date (Eastern Time business). Call first for any relative-date question (this month, YTD, last quarter).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "finance_overview",
    description: "The headline picture for a period: revenue by processor rail (QuickBooks Payments, Stripe, Venmo), business costs, true profit + margin, personal spending, and the still-unreviewed amount. Start here for most questions.",
    input_schema: { type: "object", properties: { start_key: { type: "string", description: "YYYY-MM-DD (default Jan 1 this year)" }, end_key: { type: "string", description: "YYYY-MM-DD (default today)" } } },
  },
  {
    name: "category_breakdown",
    description: "Every business and personal spending category for a period with dollar totals and counts, plus excluded money-movement and the to-review bucket.",
    input_schema: { type: "object", properties: { start_key: { type: "string" }, end_key: { type: "string" } } },
  },
  {
    name: "vendor_breakdown",
    description: "Per-vendor/payee YTD spend and average monthly run rate (business and personal), biggest first. Use for 'how much do we pay X' and subscription audits.",
    input_schema: { type: "object", properties: { start_key: { type: "string" }, end_key: { type: "string" }, limit: { type: "number", description: "max vendors (default 40)" } } },
  },
  {
    name: "people_payments",
    description: "Everyone paid, person-merged across all rails (Venmo, Stripe Connect, ACH, cards): per-person totals, channels, months, and group totals (Creative specialists, Editors, ...).",
    input_schema: { type: "object", properties: { start_key: { type: "string" }, end_key: { type: "string" } } },
  },
  {
    name: "personal_spending",
    description: "Personal (household) consumption for a period: total, by category, by month, top vendors, and net transfers to the wife's account (shown separately, never double-counted).",
    input_schema: { type: "object", properties: { start_key: { type: "string" }, end_key: { type: "string" } } },
  },
  {
    name: "card_payments",
    description: "Credit-card payments (cash sent to each card) for a period, split by funding source (business checking vs personal accounts). Money-movement: purchases themselves are counted in categories.",
    input_schema: { type: "object", properties: { start_key: { type: "string" }, end_key: { type: "string" } } },
  },
  {
    name: "monthly_pnl",
    description: "One calendar month's P&L: revenue, payroll (photographers + team), card fees, other expenses, profit. months_back=0 is the current month, 1 is last month, etc.",
    input_schema: { type: "object", properties: { months_back: { type: "number", description: "0 = current month (default 0, max 12)" } } },
  },
  {
    name: "job_profitability",
    description: "Per-job margins for recent shoots: revenue minus exact photographer pay and editing costs (video tiers + $0.50/finished photo). Returns totals plus the best and worst jobs.",
    input_schema: { type: "object", properties: { days_back: { type: "number", description: "window size in days (default 60, max 365)" } } },
  },
  {
    name: "search_transactions",
    description: "Search raw bank/card/Venmo transactions: by text, category, kind (BUSINESS/PERSONAL/EXCLUDE/REVIEW/INCOME), account last-4, or minimum amount. Use to verify specific charges or list examples.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to match in the transaction name" },
        category: { type: "string" },
        kind: { type: "string", enum: ["BUSINESS", "PERSONAL", "EXCLUDE", "REVIEW", "INCOME"] },
        account_mask: { type: "string", description: "account last-4: 3002 (business), 0942 (personal), 4284 (wife), 9323 (Tilt), 1686/6526 (CapOne), venmo (Venmo statement)" },
        min_amount: { type: "number" },
        start_key: { type: "string" }, end_key: { type: "string" },
        limit: { type: "number", description: "default 30, max 100" },
      },
    },
  },
  {
    name: "accounts_snapshot",
    description: "The connected accounts: bank/card names, last-4, business/personal tag, latest known balance, and how far back their data goes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "savings_plan",
    description: "The owner's $5k/month savings checklist: each cut, monthly value, and whether it's done, skipped, or open.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_budget",
    description: "The personal budget: every category's monthly target vs this month's actual spending and the trailing 3-month average. Call before discussing or changing the budget.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_budget",
    description: "Create or update personal budget targets (the Budget tab). Pass the FULL list of categories you're setting; existing categories not included stay untouched. Use real category names from get_budget/personal_spending. Set monthly_target 0 to signal 'cut entirely'; pass remove true to delete a target.",
    input_schema: {
      type: "object",
      required: ["targets"],
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            required: ["category", "monthly_target"],
            properties: {
              category: { type: "string" },
              monthly_target: { type: "number" },
              note: { type: "string", description: "one short line on why this number" },
              remove: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "create_report",
    description: "Save a formal financial statement the owner can open and download as a PDF. YOU compose the complete markdown document (executive summary, sections, markdown tables, notes) from data you already pulled with other tools, then call this with it. Use when the owner asks you to create/save/generate a report or statement in chat.",
    input_schema: {
      type: "object",
      required: ["title", "start_key", "end_key", "markdown"],
      properties: {
        title: { type: "string", description: "e.g. 'Profit & Loss Statement' or 'July Spending Review'" },
        start_key: { type: "string", description: "period start YYYY-MM-DD" },
        end_key: { type: "string", description: "period end YYYY-MM-DD" },
        markdown: { type: "string", description: "the FULL statement body in markdown" },
      },
    },
  },
];

export async function execFinanceTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const start = D(input.start_key, yearStart());
  const end = D(input.end_key, today());

  switch (name) {
    case "current_datetime": {
      // ET, as the description promises — the UTC date told the Advisor it was
      // tomorrow every evening after ~8pm ET (audit).
      const { etDayKey } = await import("@/lib/datetime");
      const day = etDayKey(new Date());
      return { date: day, month: day.slice(0, 7), year: Number(day.slice(0, 4)) };
    }
    case "finance_overview": {
      const [{ revenueByProcessor }, { categoryBreakdown }] = await Promise.all([import("@/lib/bookkeeping"), import("@/lib/financeCategories")]);
      const [rev, cats] = await Promise.all([revenueByProcessor(start, end), categoryBreakdown(start, end)]);
      const profit = rev.total - cats.businessTotal;
      return {
        period: { start, end },
        revenue: { total: r2(rev.total), quickbooks_payments: r2(rev.quickbooks), stripe: r2(rev.stripe), venmo: r2(rev.venmo) },
        business_costs: r2(cats.businessTotal),
        true_profit: r2(profit),
        margin_pct: rev.total > 0 ? Math.round((profit / rev.total) * 100) : 0,
        personal_spending: r2(cats.personalTotal),
        needs_review: r2(cats.reviewTotal),
        note: "Revenue counted at the processor; costs from the audited all-account ledger. Card paydowns/transfers excluded as money-movement.",
      };
    }
    case "category_breakdown": {
      const { categoryBreakdown } = await import("@/lib/financeCategories");
      const b = await categoryBreakdown(start, end);
      const slim = (rows: { category: string; sum: number; count: number }[]) => rows.map((r) => ({ category: r.category, total: r2(r.sum), count: r.count }));
      return { period: { start, end }, business: slim(b.business), personal: slim(b.personal), excluded_money_movement: slim(b.excluded), to_review: slim(b.review), business_total: r2(b.businessTotal), personal_total: r2(b.personalTotal) };
    }
    case "vendor_breakdown": {
      const { vendorBreakdown } = await import("@/lib/financeCategories");
      const limit = Math.min(Math.max(Number(input.limit) || 40, 1), 100);
      const vb = await vendorBreakdown(start, end);
      return {
        period: { start, end }, months_elapsed: r2(vb.months),
        vendors: vb.vendors.slice(0, limit).map((v) => ({ vendor: v.vendor, kind: v.kind, category: v.category, ytd: r2(v.ytd), avg_monthly: r2(v.avgMonthly), txns: v.count })),
      };
    }
    case "people_payments": {
      const { peoplePayments } = await import("@/lib/bookkeeping");
      const p = await peoplePayments(start, end);
      return {
        period: { start, end }, total: r2(p.total),
        groups: p.groupTotals,
        channels: p.channelTotals,
        people: p.list.map((x) => ({ payee: x.payee, group: x.group, total: r2(x.total), payments: x.count, channels: Object.fromEntries(Object.entries(x.channels).map(([k, v]) => [k, r2(v)])) })),
      };
    }
    case "personal_spending": {
      const { personalTruth } = await import("@/lib/financeCategories");
      const p = await personalTruth(start, end);
      return {
        period: { start, end },
        // `total` is the COMPLETE household figure for the period. Everything
        // below it is a breakdown OF that number, never an addition to it.
        total: r2(p.total),
        total_note:
          "This is the complete household spend for the period, across ALL accounts including the wife's ··4284 and both Venmo accounts. Do not add any other figure to it.",
        transactions: p.count,
        by_category: p.byBucket.map((x) => ({ category: x.bucket, total: r2(x.amount) })),
        by_month: p.byMonth,
        top_vendors: p.topVendors.map((v) => ({ vendor: v.vendor, total: r2(v.amount), txns: v.count })),
        // Renamed from `net_to_wife_account`, which read like a separate bucket
        // and got added to `total` (quoted a $121.8k year as $156.7k, Jul 2026).
        wife_account_funding_ALREADY_INCLUDED_IN_TOTAL: {
          transferred_to_her_account: r2(p.toWife),
          of_which_already_counted_in_total: r2(p.wifeCounted),
          still_uncategorised_not_in_total: r2(p.wifeInReview),
          unaccounted_gap: r2(p.wifeUnaccounted),
          note:
            "MEMO ONLY — money moved to the wife's ··4284 account, which is then counted where she actually SPENDS it (her ··4284 purchases and her Venmo payments are both already inside `total`). NEVER add this to `total`; doing so double-counts every dollar of it.",
        },
      };
    }
    case "card_payments": {
      const { cardPaydowns } = await import("@/lib/financeCategories");
      const c = await cardPaydowns(start, end);
      return { period: { start, end }, total: r2(c.total), this_month: r2(c.thisMonth), by_card: c.byCard.map((x) => ({ card: x.card, total: r2(x.sum), payments: x.count, avg_monthly: r2(x.avgMonthly) })), funded_from_business: r2(c.fromBusiness), funded_from_personal: r2(c.fromPersonal) };
    }
    case "monthly_pnl": {
      const { getMonthlyPnl } = await import("@/lib/finance");
      const back = Math.min(Math.max(Number(input.months_back) || 0, 0), 12);
      return await getMonthlyPnl(back);
    }
    case "job_profitability": {
      const { jobProfitability } = await import("@/lib/jobProfit");
      const days = Math.min(Math.max(Number(input.days_back) || 60, 7), 365);
      const to = new Date();
      const fromD = new Date(Date.now() - days * 864e5);
      const jp = await jobProfitability(fromD, to);
      const rows = [...jp.jobs].sort((a, b) => b.margin - a.margin);
      const slim = (r: (typeof rows)[number]) => ({
        job: r.title, client: r.client, photographer: r.photographer,
        date: r.shootDate?.toISOString().slice(0, 10) ?? null,
        revenue: r2(r.revenue), photographer_cost: r2(r.photographerCost), editing_cost: r2(r.editingCost),
        margin: r2(r.margin), margin_pct: r.marginPct,
      });
      return {
        window_days: days, jobs: jp.count,
        revenue: r2(jp.revenue), photographer_cost: r2(jp.photographerCost), editing_cost: r2(jp.editingCost),
        margin: r2(jp.margin), avg_margin_pct: jp.avgMarginPct,
        best_jobs: rows.slice(0, 8).map(slim),
        worst_jobs: rows.slice(-8).reverse().map(slim),
      };
    }
    case "search_transactions": {
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 100);
      const where: Record<string, unknown> = {
        date: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T23:59:59Z`) },
        pending: false,
      };
      if (typeof input.query === "string" && input.query.trim()) where.name = { contains: input.query.trim(), mode: "insensitive" };
      if (typeof input.category === "string" && input.category.trim()) where.financeCategory = input.category.trim();
      if (typeof input.kind === "string" && ["BUSINESS", "PERSONAL", "EXCLUDE", "REVIEW", "INCOME"].includes(input.kind)) where.financeKind = input.kind;
      if (typeof input.account_mask === "string" && input.account_mask.trim()) where.account = { mask: input.account_mask.trim() };
      if (typeof input.min_amount === "number") where.amount = { gte: input.min_amount };
      const rows = await prisma.plaidTransaction.findMany({
        where, orderBy: { date: "desc" }, take: limit,
        select: { date: true, name: true, amount: true, financeKind: true, financeCategory: true, financeLocked: true, account: { select: { mask: true } } },
      });
      return {
        matches: rows.length,
        transactions: rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), account: `···${r.account?.mask}`, name: (r.name ?? "").slice(0, 70), amount: r2(r.amount), kind: r.financeKind, category: r.financeCategory, owner_locked: r.financeLocked })),
        note: "amount > 0 = money out; amount < 0 = money in.",
      };
    }
    case "accounts_snapshot": {
      const accounts = await prisma.plaidAccount.findMany({
        select: { accountId: true, name: true, mask: true, isBusiness: true, currentBalance: true, item: { select: { institutionName: true, lastSyncedAt: true } } },
      });
      const out = [];
      for (const a of accounts) {
        const range = await prisma.plaidTransaction.aggregate({ where: { accountId: a.accountId }, _min: { date: true }, _max: { date: true }, _count: true });
        out.push({
          account: `${a.item?.institutionName ?? "?"} · ${a.name} ···${a.mask}`,
          business: a.isBusiness === true, balance: a.currentBalance,
          transactions: range._count, data_from: range._min.date?.toISOString().slice(0, 10) ?? null, data_through: range._max.date?.toISOString().slice(0, 10) ?? null,
          last_synced: a.item?.lastSyncedAt?.toISOString().slice(0, 10) ?? null,
        });
      }
      return { accounts: out };
    }
    case "savings_plan": {
      const items = await prisma.savingsItem.findMany({ orderBy: { rank: "asc" } });
      const done = items.filter((i) => i.status === "DONE");
      return {
        goal_per_month: 5000,
        reclaimed_per_month: r2(done.reduce((s, i) => s + i.savesPerMonth, 0)),
        items: items.map((i) => ({ title: i.title, saves_per_month: r2(i.savesPerMonth), tier: i.tier, status: i.status })),
      };
    }
    case "get_budget": {
      const { personalTruth } = await import("@/lib/financeCategories");
      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const threeBack = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
      const [targets, monthData, trailing] = await Promise.all([
        prisma.budgetTarget.findMany({ orderBy: { monthlyTarget: "desc" } }),
        personalTruth(`${monthKey}-01`, today()),
        personalTruth(threeBack, `${monthKey}-01`),
      ]);
      const actualBy = Object.fromEntries(monthData.byBucket.map((b) => [b.bucket, b.amount]));
      const avgBy = Object.fromEntries(trailing.byBucket.map((b) => [b.bucket, b.amount / 3]));
      const dayOfMonth = now.getUTCDate();
      const daysInMonth = monthEnd.getUTCDate();
      return {
        month: monthKey, day_of_month: dayOfMonth, days_in_month: daysInMonth,
        targets: targets.map((t) => ({
          category: t.category, monthly_target: r2(t.monthlyTarget), note: t.note,
          spent_this_month: r2(actualBy[t.category] ?? 0),
          projected_month_end: r2(((actualBy[t.category] ?? 0) / Math.max(1, dayOfMonth)) * daysInMonth),
          trailing_3mo_avg: r2(avgBy[t.category] ?? 0),
        })),
        unbudgeted_categories: monthData.byBucket
          .filter((b) => !targets.some((t) => t.category === b.bucket))
          .map((b) => ({ category: b.bucket, spent_this_month: r2(b.amount), trailing_3mo_avg: r2(avgBy[b.bucket] ?? 0) })),
        total_target: r2(targets.reduce((s, t) => s + t.monthlyTarget, 0)),
        total_spent_this_month: r2(monthData.total),
      };
    }
    case "set_budget": {
      const targets = Array.isArray(input.targets) ? (input.targets as { category?: unknown; monthly_target?: unknown; note?: unknown; remove?: unknown }[]) : [];
      if (targets.length === 0 || targets.length > 40) return { error: "Pass 1-40 targets" };
      let set = 0, removed = 0;
      for (const t of targets) {
        const category = typeof t.category === "string" ? t.category.trim().slice(0, 60) : "";
        if (!category) continue;
        if (t.remove === true) {
          await prisma.budgetTarget.deleteMany({ where: { category } });
          removed++;
          continue;
        }
        const amt = Number(t.monthly_target);
        if (!Number.isFinite(amt) || amt < 0 || amt > 100000) continue;
        await prisma.budgetTarget.upsert({
          where: { category },
          create: { category, monthlyTarget: amt, note: typeof t.note === "string" ? t.note.slice(0, 200) : null },
          update: { monthlyTarget: amt, note: typeof t.note === "string" ? t.note.slice(0, 200) : undefined },
        });
        set++;
      }
      return { budget_saved: true, targets_set: set, targets_removed: removed, note: "Visible on Finance → Budget immediately." };
    }
    case "create_report": {
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : "Financial Report";
      const md = typeof input.markdown === "string" ? input.markdown.trim() : "";
      if (md.length < 200) return { error: "markdown too short — compose the full statement first" };
      const row = await prisma.financeReport.create({
        data: { title, type: "chat", startKey: D(input.start_key, yearStart()), endKey: D(input.end_key, today()), markdown: md },
        select: { id: true },
      });
      return { report_created: true, id: row.id, title, url: `/sales/report/${row.id}` };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
