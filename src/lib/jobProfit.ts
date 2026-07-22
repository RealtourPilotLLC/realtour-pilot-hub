import "server-only";
import { prisma } from "@/lib/prisma";
import { computePayroll } from "@/lib/payroll";

// Editing rates (owner-supplied). Luma edits only PREMIUM video-type deliverables
// ($299 each); standard videos/reels are edited in-house (Remar/Kim). AutoHDR is
// $0.50 per raw photo (added once raw-photo counts are snapshotted per project).
const LUMA_PER_VIDEO = 299;
const VIDEO_TYPES = new Set(["VIDEO", "SOCIAL_REEL"]);
const PREMIUM_RE = /premium|influencer/i;

function lumaEditing(deliverables: { type: string; label: string | null; quantity: number }[]) {
  let lumaVideos = 0;
  for (const d of deliverables) {
    if (!VIDEO_TYPES.has(d.type)) continue;
    if (PREMIUM_RE.test(d.label ?? "")) lumaVideos += d.quantity ?? 1;
  }
  return { lumaVideos, lumaCost: lumaVideos * LUMA_PER_VIDEO };
}

export type JobRow = {
  id: string;
  title: string;
  client: string;
  photographer: string;
  shootDate: Date | null;
  status: string;
  paymentStatus: string | null;
  revenue: number;          // eligible invoice (payableInvoice) or order price
  photographerCost: number; // exact: base shoot pay + mileage share
  lumaVideos: number;       // premium videos/reels routed to Luma
  editingCost: number;      // Luma (exact); AutoHDR + in-house added as they land
  margin: number;           // revenue − photographer − editing
  marginPct: number | null;
};

export type JobProfit = {
  jobs: JobRow[];
  count: number;
  revenue: number;
  photographerCost: number;
  editingCost: number;
  margin: number;
  avgMarginPct: number | null;
  start: Date;
  end: Date;
};

/**
 * Per-job P&L over a window. Revenue = eligible invoice. Costs, to the penny:
 *  • photographer — exact payroll (base % + mileage) from one computePayroll pass.
 *  • editing — Luma at $299 per PREMIUM video/reel (from the deliverable data).
 * AutoHDR ($0.50/raw photo) and the in-house editor pool are added as their data
 * sources come online; margin here is "revenue minus shooter and Luma."
 */
export async function jobProfitability(start: Date, end: Date): Promise<JobProfit> {
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
      deliverables: { select: { type: true, label: true, quantity: true } },
    },
    orderBy: { shootDate: "desc" },
  });

  const jobs: JobRow[] = projects.map((pr) => {
    const revenue = pr.payableInvoice ?? pr.price ?? 0;
    const photographerCost = costByProject[pr.id] ?? 0;
    const { lumaVideos, lumaCost } = lumaEditing(pr.deliverables);
    const editingCost = lumaCost;
    const margin = revenue - photographerCost - editingCost;
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
      lumaVideos,
      editingCost,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
    };
  });

  const revenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const photographerCost = jobs.reduce((s, j) => s + j.photographerCost, 0);
  const editingCost = jobs.reduce((s, j) => s + j.editingCost, 0);
  return {
    jobs,
    count: jobs.length,
    revenue,
    photographerCost,
    editingCost,
    margin: revenue - photographerCost - editingCost,
    avgMarginPct: revenue > 0 ? (revenue - photographerCost - editingCost) / revenue : null,
    start,
    end,
  };
}
