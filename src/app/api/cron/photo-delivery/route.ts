import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE PHOTO DELIVERY LANE (every 5 minutes, see vercel.json; Oct 13 2026,
// docs/photo-delivery/01 §3.2). The hub has no queue service, so, like the
// 1080p lane, this is "one bounded step per tick, resumable": every unit of
// work is keyed by a content hash or a leased row, so a tick that is killed
// mid-way loses nothing and the next tick carries on.
//
//   credits   read AutoHDR's balance (free) every 15 minutes, run the alerts
//   intake    (Oct 14 2026) send finished uploads, and files added later, to
//             AutoHDR; commit and poll them (switch: autoSubmit)
//   sync      open photo jobs, read the edited gallery (the Aryeo listing,
//             or the Dropbox finals folder), move EDITING → EDITED
//   link      find each job's AutoHDR shoot (free reads)
//   fixes     run the fixes a person approved (never without that click, and
//             only while the owner's fixRunnerEnabled switch is on)
//   verify    compare delivered Aryeo listings with the approved set
//   digest    Monday 8 AM ET: the weekly photo delivery numbers
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(260_000, startedAt, "photo-delivery");

  await step("credits", async () => {
    const { latestSnapshot, recordCreditSnapshot } = await import("@/lib/photoDelivery/credits");
    const last = await latestSnapshot();
    if (last && Date.now() - last.at.getTime() < 14 * 60_000) return { skipped: "read in the last 15 minutes" };
    return recordCreditSnapshot({ trigger: "cron" });
  }, { maxMs: 30_000 });

  await step("intake", async () => {
    const { driveIntake } = await import("@/lib/photoDelivery/intake");
    return driveIntake({ budgetMs: 110_000 });
  }, { maxMs: 130_000 });

  await step("sync", async () => {
    const { syncPhotoJobs } = await import("@/lib/photoDelivery/jobs");
    return syncPhotoJobs({ budgetMs: Math.min(90_000, Math.max(20_000, remaining() - 150_000)) });
  }, { maxMs: 100_000 });

  await step("link", async () => {
    // Free reads: find each new job's AutoHDR shoot so approved fixes can run.
    const { linkOpenJobs } = await import("@/lib/photoDelivery/autohdrLink");
    return linkOpenJobs(6);
  }, { maxMs: 30_000 });

  await step("fixes", async () => {
    // Approved fixes only; new submissions only while the owner's switch is on.
    const { driveFixes } = await import("@/lib/photoDelivery/fixRunner");
    return driveFixes({ budgetMs: 45_000, leaseBy: `pd-cron-${new Date(startedAt).toISOString()}` });
  }, { maxMs: 60_000 });

  await step("verify", async () => {
    const { verifyDeliveringJobs } = await import("@/lib/photoDelivery/verifySweep");
    return verifyDeliveringJobs({ max: 5 });
  }, { maxMs: 30_000 });

  await step("digest", async () => {
    // Monday 8 AM ET: last week's photo delivery numbers to Jordan and Kyle.
    const { maybeSendPhotoDigest } = await import("@/lib/photoDelivery/digest");
    return maybeSendPhotoDigest();
  }, { maxMs: 30_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
