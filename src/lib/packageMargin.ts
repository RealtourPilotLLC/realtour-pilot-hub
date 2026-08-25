import "server-only";
import { prisma } from "@/lib/prisma";
import { jobProfitability, videoEditingCost } from "@/lib/jobProfit";
import { deliverablesForTitle, isPayExcludedItem, loadManualProductMap } from "@/lib/integrations/aryeo";
import { canonicalPackage } from "@/lib/packageNames";

// ---------------------------------------------------------------------------
// MARGIN BY PACKAGE — what each product actually earns after the people who
// deliver it are paid.
//
// The finance side computes profit PER JOB (jobProfitability): revenue minus
// the exact photographer payroll minus editing. But a job is usually several
// packages — "Bronze Package + Drone + Virtual Staging" is one shoot, one
// payroll line, three products. To get margin per PACKAGE that cost has to be
// split, and how it is split is the whole ballgame.
//
// Splitting it proportionally to revenue would be worthless: every package
// would come back with the identical margin percentage as the job it sat on,
// which tells you nothing about which product to sell. So each cost bucket is
// allocated by WHAT ACTUALLY DRIVES IT:
//
//  • Photographer pay follows the ELIGIBLE invoice, because that is literally
//    how it is computed (payPercent × the non-virtual item total, plus mileage
//    for the trip). Virtual staging / AI add-ons are excluded from the pay
//    basis, so they correctly carry ZERO shooter cost — nobody drives to a
//    virtual twilight.
//  • Video editing follows the video deliverables the item expands into, at
//    the real rates ($299 Luma premium, $120 monthly social, $40 standard).
//    A premium reel carries its own $299; the photo package on the same order
//    carries none of it.
//  • Photo editing (AutoHDR) follows the photo-bearing items only.
//
// Each bucket's weights are then NORMALISED to the job's actual cost, so the
// sum of every package's allocated cost equals the job total to the penny and
// this page can never drift from the Finance tab.
//
// AXIS: this windows on shootDate, not orderedAt — cost is incurred when the
// shoot happens and the editors work. The Revenue-by-package card above it
// counts by order date. The two totals are therefore close but not identical,
// which the UI says out loud rather than hiding.
// ---------------------------------------------------------------------------

const PHOTO_TYPES = new Set(["PHOTOS", "DRONE"]);

export type PackageMarginRow = {
  label: string;
  orders: number; // distinct jobs containing this package
  revenue: number; // exact Aryeo line-item dollars
  photographerCost: number;
  editingCost: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  perOrderRevenue: number;
  perOrderMargin: number;
};

export type PackageMargins = {
  rows: PackageMarginRow[];
  start: Date;
  end: Date;
  jobs: number; // jobs actually costed (priced line items present)
  jobsInWindow: number; // every shot job in the window
  unpricedJobs: number; // real shoots whose Aryeo order carries $0 (billed elsewhere)
  unpricedCost: number; // what those shoots cost to deliver
  coverage: number; // jobs ÷ jobsInWindow — how much of the period this covers
  photoCostKnown: number; // share of costed jobs where the raw photo count was known
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  revenueBasisDelta: number; // line-item sum − order-price sum, for honesty
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split `total` across `weights`, normalised so the parts sum back to `total`.
 * Falls back to `alt` (then to an even split) when nothing in the bucket has a
 * weight — e.g. a job whose only item is a virtual add-on but which still paid
 * a shoot-pay floor.
 */
function allocate(total: number, weights: number[], alt: number[]): number[] {
  const n = weights.length;
  if (n === 0 || total === 0) return new Array(n).fill(0);
  let w = weights;
  let sum = w.reduce((s, x) => s + x, 0);
  if (sum <= 0) {
    w = alt;
    sum = w.reduce((s, x) => s + x, 0);
  }
  if (sum <= 0) return new Array(n).fill(total / n);
  return w.map((x) => (total * x) / sum);
}

export async function packageMargins(start: Date, end: Date): Promise<PackageMargins> {
  await loadManualProductMap();
  // The per-job engine gives exact photographer payroll + editing per project.
  const profit = await jobProfitability(start, end);
  const byProject = new Map(profit.jobs.map((j) => [j.id, j]));
  const ids = profit.jobs.map((j) => j.id);

  const items = ids.length
    ? await prisma.orderItem.findMany({
        where: { projectId: { in: ids }, isCanceled: false },
        select: { projectId: true, title: true, quantity: true, amount: true },
      })
    : [];

  const byJob = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byJob.get(it.projectId) ?? [];
    arr.push(it);
    byJob.set(it.projectId, arr);
  }

  const acc = new Map<
    string,
    { orders: Set<string>; revenue: number; shooter: number; editing: number }
  >();
  let photoKnown = 0;
  let itemRevenue = 0;
  let priceRevenue = 0;
  let unpricedJobs = 0;
  let unpricedCost = 0;
  let costed = 0;

  for (const [projectId, rows] of byJob) {
    const job = byProject.get(projectId);
    if (!job) continue;

    // MONTHLY SOCIAL RETAINER SESSIONS. Video Starter / Accelerator / Pro clients
    // are billed a recurring monthly invoice in QuickBooks; the Aryeo order is
    // priced at $0 ON PURPOSE so they can schedule the session they have already
    // paid for without being asked to pay again at booking. So the shoot is real,
    // the cost is real, and the money is on the other rail. No honest per-package
    // margin can be computed from Aryeo alone — including them would print a pure
    // loss against a product that is in fact one of the better ones. Set aside
    // and reported separately.
    const orderTotal = rows.reduce((s, it) => s + Math.max(it.amount || 0, 0), 0);
    if (orderTotal <= 0) {
      unpricedJobs++;
      unpricedCost += job.photographerCost + job.editingCost;
      continue;
    }

    costed++;
    if (job.finishedPhotos != null) photoKnown++;
    priceRevenue += job.revenue;

    // Per-item cost drivers.
    const amounts = rows.map((it) => Math.max(it.amount || 0, 0));
    const eligible = rows.map((it) => (isPayExcludedItem({ title: it.title }) ? 0 : 1));
    // A $0 line item is a COMPONENT of a bundle that was priced elsewhere on the
    // same order ("Video Accelerator - 4HR Session" riding along inside a paid
    // package). It generates real work, but the money for that work sits on the
    // priced line — so cost must land there too. Letting a $0 row absorb cost
    // prints it as a pure loss and flatters whatever package actually holds the
    // revenue. Only paying lines can carry cost.
    const paying = amounts.map((a) => (a > 0 ? 1 : 0));
    const videoW: number[] = [];
    const photoW: number[] = [];
    rows.forEach((it, i) => {
      const parsed = deliverablesForTitle(it.title, it.quantity || 1);
      videoW.push(videoEditingCost(parsed).cost * paying[i]);
      photoW.push(parsed.some((d) => PHOTO_TYPES.has(d.type)) ? paying[i] : 0);
    });

    // Shooter pay tracks the eligible invoice — that IS the formula. (Already
    // zero on unpriced lines, since the weight is the amount itself.)
    const shooterW = amounts.map((a, i) => a * eligible[i]);
    // Photo editing lands on the photo-bearing items, weighted by their value.
    const photoWeighted = amounts.map((a, i) => a * photoW[i]);

    const videoCost = Math.max(job.editingCost - job.photoCost, 0);
    const shooterParts = allocate(job.photographerCost, shooterW, amounts);
    const videoParts = allocate(videoCost, videoW, amounts);
    const photoParts = allocate(job.photoCost, photoWeighted, amounts);

    rows.forEach((it, i) => {
      const label = canonicalPackage(it.title);
      const e = acc.get(label) ?? { orders: new Set<string>(), revenue: 0, shooter: 0, editing: 0 };
      e.orders.add(projectId);
      e.revenue += amounts[i];
      e.shooter += shooterParts[i];
      e.editing += videoParts[i] + photoParts[i];
      acc.set(label, e);
      itemRevenue += amounts[i];
    });
  }

  const rows: PackageMarginRow[] = [...acc.entries()]
    .map(([label, v]) => {
      const photographerCost = r2(v.shooter);
      const editingCost = r2(v.editing);
      const cost = r2(photographerCost + editingCost);
      const revenue = r2(v.revenue);
      const margin = r2(revenue - cost);
      const orders = v.orders.size;
      return {
        label,
        orders,
        revenue,
        photographerCost,
        editingCost,
        cost,
        margin,
        marginPct: revenue > 0 ? (margin / revenue) * 100 : null,
        perOrderRevenue: orders ? r2(revenue / orders) : 0,
        perOrderMargin: orders ? r2(margin / orders) : 0,
      };
    })
    .sort((a, b) => b.margin - a.margin);

  const revenue = r2(rows.reduce((s, r) => s + r.revenue, 0));
  const cost = r2(rows.reduce((s, r) => s + r.cost, 0));
  const jobs = costed;

  return {
    rows,
    start,
    end,
    jobs,
    jobsInWindow: profit.jobs.length,
    unpricedJobs,
    unpricedCost: r2(unpricedCost),
    coverage: profit.jobs.length ? jobs / profit.jobs.length : 0,
    photoCostKnown: jobs ? photoKnown / jobs : 0,
    revenue,
    cost,
    margin: r2(revenue - cost),
    marginPct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
    revenueBasisDelta: r2(itemRevenue - priceRevenue),
  };
}

// ---------------------------------------------------------------------------
// PRECOMPUTED, NEVER COMPUTED ON A REQUEST.
//
// packageMargins() runs jobProfitability -> computePayroll, and computePayroll
// resolves mileage through the PUBLIC OSRM router over the network. Against a
// warm local MileageDay cache that is ~9 seconds; from a serverless function
// with a cold cache it is minutes, because every uncached day costs a
// rate-limited third-party HTTP round trip. It timed out a 60-second function
// in production while measuring 3 seconds locally — the exact shape of bug that
// only ever shows up on the deployed site.
//
// So the engine runs ONCE a night in the cron, and every reader gets a stored
// row. An in-request cache was not enough: the first miss after any deploy still
// paid the full cost, and that first miss is an outage.
// ---------------------------------------------------------------------------

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Run the engine and persist the result. Cron-only — never call from a page. */
export async function rebuildPackageMargins(): Promise<{ built: boolean; jobs: number; error?: string }> {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  try {
    const data = await packageMargins(start, now);
    await prisma.marginSnapshot.upsert({
      where: { scope: "ytd" },
      create: { scope: "ytd", startKey: dayKey(start), endKey: dayKey(now), json: JSON.stringify(data), builtAt: new Date() },
      update: { startKey: dayKey(start), endKey: dayKey(now), json: JSON.stringify(data), builtAt: new Date() },
    });
    return { built: true, jobs: data.jobs };
  } catch (e) {
    return { built: false, jobs: 0, error: e instanceof Error ? e.message : "margin rebuild failed" };
  }
}

export type StoredMargins = { data: PackageMargins; builtAt: Date; ageHours: number } | null;

/**
 * What every reader uses. A single indexed row read — no payroll engine, no
 * network, no timeout risk. Returns null until the first nightly build.
 */
export async function getPackageMargins(): Promise<StoredMargins> {
  const row = await prisma.marginSnapshot.findUnique({ where: { scope: "ytd" } }).catch(() => null);
  if (!row) return null;
  try {
    return {
      data: JSON.parse(row.json) as PackageMargins,
      builtAt: row.builtAt,
      ageHours: (Date.now() - row.builtAt.getTime()) / 3_600_000,
    };
  } catch {
    return null;
  }
}
