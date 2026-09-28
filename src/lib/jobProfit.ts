import "server-only";
import { prisma } from "@/lib/prisma";
import { computePayroll } from "@/lib/payroll";
import { finishedPhotos } from "@/lib/photoCount";
import { MONTHLY_PLAN_RE } from "@/lib/pipeline";

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
// The photo-bearing deliverables (packageMargin.ts PHOTO_TYPES — one list).
const PHOTO_TYPES = new Set(["PHOTOS", "DRONE"]);
const PREMIUM_RE = /premium|influencer/i;

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
    // Monthly FIRST, on the shared MONTHLY_PLAN_RE — the old inline regex
    // missed the branding-session wordings the sync now keeps as labels, and
    // a premium-worded plan title ("Luxury Personal Branding …") is Kim's
    // $120 monthly work, not a $299 Luma reel.
    if (MONTHLY_PLAN_RE.test(label)) monthly += q;
    else if (PREMIUM_RE.test(label)) premium += q;
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
  /** finished × $0.50 (AutoHDR). NULL when the job owes photos and its raws
   *  have not been counted: unknown, not free (§10 AU-26, Sep 26). */
  photoCost: number | null;
  editingCost: number;      // tiered video editing + photo editing (the known part)
  /** false when a cost the job certainly has is unknown (photoCost null), so
   *  its margin is overstated by that much and must say so. */
  costComplete: boolean;
  margin: number;           // revenue − photographer − editing — MODELLED
  marginPct: number | null;
  /** Recorded rework (ReworkCost), in dollars, BESIDE the margin — never taken
   *  out of it. null = no row recorded, which is not the same as $0. */
  reworkActual: number | null;
  reworkEstimate: number | null;
};

export type JobProfit = {
  jobs: JobRow[];
  count: number;
  revenue: number;
  photographerCost: number;
  editingCost: number;
  margin: number;
  avgMarginPct: number | null;
  /** photo jobs whose raws were never counted — the margin above is missing
   *  their photo editing, so it is incomplete, not exact */
  uncountedJobs: number;
  marginComplete: boolean;
  /** recorded rework over the window, beside the margin (null = none recorded) */
  reworkActual: number | null;
  reworkEstimate: number | null;
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
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
    },
    orderBy: { shootDate: "desc" },
  });
  const rework = await import("@/lib/reworkCost")
    .then((m) => m.reworkByProject(projects.map((p) => p.id)))
    .catch(() => new Map<string, { actualCents: number | null; estimateCents: number | null; rows: number }>());

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
    // UNKNOWN IS NOT ZERO (§10 AU-26). This used to be `: 0`, so a photo job
    // the sweep had not reached carried no photo editing at all and its
    // margin read better than it was, while the cell printed "—". A job that
    // owes no photos really does cost nothing here.
    const owesPhotos = pr.deliverables.some((d) => PHOTO_TYPES.has(d.type));
    const photoCost = fin != null ? fin * RATE_PER_PHOTO : owesPhotos ? null : 0;
    const editingCost = v.cost + (photoCost ?? 0);
    const margin = revenue - photographerCost - editingCost;
    const rw = rework.get(pr.id);
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
      costComplete: photoCost !== null,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
      reworkActual: rw?.actualCents != null ? rw.actualCents / 100 : null,
      reworkEstimate: rw?.estimateCents != null ? rw.estimateCents / 100 : null,
    };
  });

  const revenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const photographerCost = jobs.reduce((s, j) => s + j.photographerCost, 0);
  const editingCost = jobs.reduce((s, j) => s + j.editingCost, 0);
  const uncountedJobs = jobs.filter((j) => !j.costComplete).length;
  const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
  return {
    jobs,
    count: jobs.length,
    revenue,
    photographerCost,
    editingCost,
    margin: revenue - photographerCost - editingCost,
    avgMarginPct: revenue > 0 ? (revenue - photographerCost - editingCost) / revenue : null,
    uncountedJobs,
    marginComplete: uncountedJobs === 0,
    reworkActual: sumOrNull(jobs.map((j) => j.reworkActual)),
    reworkEstimate: sumOrNull(jobs.map((j) => j.reworkEstimate)),
    start,
    end,
  };
}
