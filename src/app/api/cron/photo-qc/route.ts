import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE PHOTO QC LANE (every 5 minutes, offset from the photo-delivery lane; Oct
// 14 2026, docs/photo-delivery/01 §7). The QC engine (sharp + Claude) works a
// gallery a bounded slice at a time: every photo step is keyed by its content
// hash, so a tick that ends mid-gallery loses nothing and the next tick
// carries on (a 40-photo gallery takes 2 or 3 ticks). A Claude call is only
// STARTED with enough budget left; one in flight can overrun by up to about
// two minutes, which the 300 s ceiling absorbs. Off unless the owner's
// qcEnabled switch is on; shadow mode makes every result advisory.
// Then: coaching notes for galleries whose QC just finished (drafts only; the
// owner approves each one).
// Oct 14 2026, first: the FREE photo check (autohdrCheck.ts): AutoHDR's free
// describe call asks each edited photo the checklist. No credits, no Claude.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish } = cronBudget(285_000, startedAt, "photo-qc");

  await step("check", async () => {
    const { driveAutohdrChecks } = await import("@/lib/photoDelivery/autohdrCheck");
    return driveAutohdrChecks({ budgetMs: 90_000 });
  }, { maxMs: 110_000 });

  await step("autofix", async () => {
    // Oct 14 2026: the free second look on each finding, then (autoFix on) the
    // budgeted fix plan. The fix runner (photo-delivery lane) does the edits.
    const { driveAutoFixPlanning } = await import("@/lib/photoDelivery/fixPolicy");
    return driveAutoFixPlanning({ budgetMs: 60_000 });
  }, { maxMs: 80_000 });

  await step("qc", async () => {
    const { driveQc } = await import("@/lib/photoDelivery/qc");
    // Unique per tick: two overlapping ticks must never share a lease.
    return driveQc({ budgetMs: 120_000, leaseBy: `qc-cron:${startedAt}:${Math.random().toString(36).slice(2, 8)}`, maxJobs: 2 });
  }, { maxMs: 240_000 });

  await step("coaching", async () => {
    const { draftPendingCoaching } = await import("@/lib/photoDelivery/coaching");
    return draftPendingCoaching(3);
  }, { maxMs: 30_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
