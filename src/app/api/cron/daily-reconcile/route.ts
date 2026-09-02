import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
// DAILY-RECONCILE (08:40) — the slow AI/network rebuilds (Dropbox recursive
// listings, OSRM routing, model calls). Isolated so a slow Dropbox night can't
// starve money or housekeeping steps in /daily. (The Aryeo order/appointment
// safety-net sweeps are hourly page slices in /api/cron/reconcile.)
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(250_000, Date.now(), "daily-reconcile");

  // Release approved cuts' uploads from the hub store once they're old enough
  // (Settings → Review Room); the Dropbox copy remains the file of record.
  await step("pruneReviewUploads", async () => {
    const { reviewRoomRules } = await import("@/lib/settings");
    const { pruneReviewUploads } = await import("@/lib/reviewCuts");
    return pruneReviewUploads((await reviewRoomRules()).keepUploadsDays);
  }, { maxMs: 60_000 });
  // Count raw photos in recent shoots' Dropbox folders → per-job AutoHDR cost.
  await step("photoCounts", async () => {
    const { sweepPhotoCounts } = await import("@/lib/photoCount");
    return sweepPhotoCounts({ days: 21, max: 80 });
  }, { maxMs: 45_000 });
  // Second-chance Plaid sync for items that FAILED the 08:00 sweep — 40 minutes
  // later is comfortably past minute-scale 429 rate limits.
  await step("plaidRetryErrored", async () => {
    const { retryErroredPlaidItems } = await import("@/lib/integrations/plaid");
    return retryErroredPlaidItems();
  }, { maxMs: 30_000 });
  // Cost every shoot for the Trends margin table (payroll engine + OSRM routing —
  // far too slow for a page request; done here once a night).
  await step("packageMargins", async () => {
    const { rebuildPackageMargins } = await import("@/lib/packageMargin");
    return rebuildPackageMargins();
  }, { maxMs: 60_000 });
  // Rebuild the Trends growth plan (cached against a hash of the numbers — a
  // no-op on a day nothing moved).
  // 150s, not 60s: this is one long reasoning call over the whole trends
  // dataset and it hit the 60s cap every night since July, so the growth-plan
  // card served five-week-old advice while ~150s of the 250s budget sat unused
  // (the steps above it measured ~41s on Sep 2). It is the LAST step, so it can
  // safely take the rest; cronBudget clamps it to what's actually left.
  await step("growthPlan", async () => {
    const { rebuildGrowthPlan } = await import("@/lib/growthPlan");
    const r = await rebuildGrowthPlan();
    return { rebuilt: !!r.plan && !r.error, error: r.error ?? null };
  }, { maxMs: 150_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
