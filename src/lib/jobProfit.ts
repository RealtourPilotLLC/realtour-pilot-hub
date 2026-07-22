import "server-only";
import { prisma } from "@/lib/prisma";
import { computePayroll } from "@/lib/payroll";

export type JobRow = {
  id: string;
  title: string;
  client: string;
  photographer: string;
  shootDate: Date | null;
  status: string;
  paymentStatus: string | null;
  revenue: number;        // eligible invoice (payableInvoice) or order price
  photographerCost: number; // exact: base shoot pay + mileage share
  margin: number;         // revenue − photographer cost
  marginPct: number | null;
};

export type JobProfit = {
  jobs: JobRow[];
  count: number;
  revenue: number;
  photographerCost: number;
  margin: number;
  avgMarginPct: number | null;
  start: Date;
  end: Date;
};

/**
 * Per-job P&L over a window. Revenue is the eligible invoice; photographer cost
 * is the EXACT payroll number (base % pay + that day's mileage share), taken
 * from a single computePayroll pass over the range and keyed back to each
 * project. Editing is NOT included per-job — editors bill monthly/hourly, so
 * their cost is a business-level line, not a per-shoot one. This margin is
 * therefore "revenue minus the photographer who shot it."
 */
export async function jobProfitability(start: Date, end: Date): Promise<JobProfit> {
  // One payroll pass → per-project photographer cost (summed across any legs).
  const people = await computePayroll(start, end);
  const costByProject: Record<string, number> = {};
  const shooterByProject: Record<string, string> = {};
  for (const p of people) {
    for (const j of p.jobs) {
      costByProject[j.projectId] = (costByProject[j.projectId] ?? 0) + j.jobTotal;
      if (!shooterByProject[j.projectId]) shooterByProject[j.projectId] = p.member.name;
    }
  }

  const projects = await prisma.project.findMany({
    where: { shootDate: { gte: start, lte: end } },
    select: {
      id: true, title: true, price: true, payableInvoice: true,
      paymentStatus: true, shootDate: true, status: true,
      photographer: { select: { name: true } },
      client: { select: { name: true } },
    },
    orderBy: { shootDate: "desc" },
  });

  const jobs: JobRow[] = projects.map((pr) => {
    const revenue = pr.payableInvoice ?? pr.price ?? 0;
    const photographerCost = costByProject[pr.id] ?? 0;
    const margin = revenue - photographerCost;
    return {
      id: pr.id,
      title: pr.title,
      client: pr.client?.name ?? "—",
      photographer: shooterByProject[pr.id] ?? pr.photographer?.name ?? "—",
      shootDate: pr.shootDate,
      status: pr.status,
      paymentStatus: pr.paymentStatus,
      revenue,
      photographerCost,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
    };
  });

  const revenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const photographerCost = jobs.reduce((s, j) => s + j.photographerCost, 0);
  return {
    jobs,
    count: jobs.length,
    revenue,
    photographerCost,
    margin: revenue - photographerCost,
    avgMarginPct: revenue > 0 ? (revenue - photographerCost) / revenue : null,
    start,
    end,
  };
}
