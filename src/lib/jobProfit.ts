import "server-only";
import { prisma } from "@/lib/prisma";
import { computePayroll } from "@/lib/payroll";
import { finishedPhotos } from "@/lib/photoCount";

const RATE_PER_PHOTO = 0.5; // AutoHDR, per FINISHED photo

// Editing rates (owner-supplied, 2026-07-22):
//   • Premium reels / premium cinematic (Luma)  → $299 each (tips of ~$50 on
//     big projects are NOT modeled — actual tips land in the ledger anyway).
//   • Monthly social content videos (Kim)        → ~$120 each (Starter/
//     Accelerator/Pro content sessions).
//   • Standard videos & reels (Remar, in-house)  → ~$40 each.
//   • Photos (AutoHDR): $0.50 per FINISHED photo = (5-bracket sets ÷ 5) +
//     single drone JPGs — needs the per-job Dropbox raw-file count (next build).
const RATE_PREMIUM = 299;
const RATE_MONTHLY_SOCIAL = 120;
const RATE_STANDARD = 40;
const VIDEO_TYPES = new Set(["VIDEO", "SOCIAL_REEL"]);
const PREMIUM_RE = /premium|influencer/i;
const MONTHLY_RE = /starter|accelerator|content (session|day)|video pro\b/i;

/**
 * Editing cost implied by a set of deliverables, at the real per-video rates.
 * Exported so the per-PACKAGE margin engine can weight the same way this
 * weights per job — one rate table, so the two can never disagree.
 */
export function videoEditingCost(deliverables: { type: string; label: string | null; quantity: number }[]) {
  let premium = 0, monthly = 0, standard = 0;
  for (const d of deliverables) {
    if (!VIDEO_TYPES.has(d.type)) continue;
    const q = d.quantity ?? 1;
    const label = d.label ?? "";
    if (PREMIUM_RE.test(label)) premium += q;
    else if (MONTHLY_RE.test(label)) monthly += q;
    else standard += q;
  }
  return {
    premium, monthly, standard,
    cost: premium * RATE_PREMIUM + monthly * RATE_MONTHLY_SOCIAL + standard * RATE_STANDARD,
  };
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
  premiumVideos: number;    // $299 Luma premium reels/cinematics
  monthlyVideos: number;    // $120 monthly-social videos (Kim)
  standardVideos: number;   // $40 standard videos/reels (in-house)
  finishedPhotos: number | null; // (brackets ÷ 5) + drone singles — null until counted
  photoCost: number;        // finished × $0.50 (AutoHDR)
  editingCost: number;      // tiered video editing + photo editing
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
      rawPhotoCount: true, dronePhotoCount: true,
      photographer: { select: { name: true } },
      client: { select: { name: true } },
      deliverables: { select: { type: true, label: true, quantity: true } },
    },
    orderBy: { shootDate: "desc" },
  });

  const jobs: JobRow[] = projects.map((pr) => {
    // Revenue = the order total (what the client paid). payableInvoice is the
    // photographer PAY basis (excludes virtual/AI add-ons) and understates job
    // revenue, so it's used only inside the cost calc, never as the top line.
    const revenue = pr.price ?? pr.payableInvoice ?? 0;
    const photographerCost = costByProject[pr.id] ?? 0;
    const v = videoEditingCost(pr.deliverables);
    // Photo editing: from the persisted Dropbox raw-folder counts (null until
    // the sweep has visited this job — shown as "—", never a fake zero).
    const fin = pr.rawPhotoCount != null
      ? finishedPhotos(pr.rawPhotoCount, pr.dronePhotoCount ?? 0)
      : null;
    const photoCost = fin != null ? fin * RATE_PER_PHOTO : 0;
    const editingCost = v.cost + photoCost;
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
      premiumVideos: v.premium,
      monthlyVideos: v.monthly,
      standardVideos: v.standard,
      finishedPhotos: fin,
      photoCost,
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
