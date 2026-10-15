import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";
import type { AutohdrPhotoshoot } from "@/lib/integrations/autohdr";

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
// Oct 15 2026: the short steps that finish a delivery (ready, aryeo) run
// before the long catch-up ones (intake, display), so a slow intake can no
// longer push them out. Each step's own budget sits inside its cap, so a step
// ends by itself instead of timing out and running on in the background; the
// fixed caps up to fixes add up to 245 s of the 260 s, and intake and display
// take what is left.
//
//   credits   read AutoHDR's balance (free) every 15 minutes, run the alerts,
//             and keep the price catalogues an hour fresh (pages only read them)
//   verify    compare delivered Aryeo listings with the approved set (round
//             robin; Aryeo's delivered webhook also checks at once)
//   ready     finished hub shoots → numbered copies in 06-Ready-for-Aryeo
//   aryeo     (Oct 14 2026) the ready photos onto the Aryeo listing through
//             the hub's own Aryeo login, and delivery when the stage allows
//   sync      open photo jobs, read the edited gallery (the Aryeo listing,
//             or the Dropbox finals folder), move EDITING → EDITED
//   link      find each job's AutoHDR shoot (free reads)
//   fixes     run the fixes a person approved (never without that click, and
//             only while the owner's fixRunnerEnabled switch is on)
//   intake    (Oct 14 2026) send finished uploads, and files added later, to
//             AutoHDR; commit and poll them (switch: autoSubmit)
//   display   bring finished hub shoots' photos over so the hub can show them
//   digest    Monday 8 AM ET: the weekly photo delivery numbers
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(260_000, startedAt, "photo-delivery");
  // One AutoHDR shoot list per pass (up to 20 pages), shared by link and intake.
  let shoots: Promise<AutohdrPhotoshoot[]> | null = null;
  const listShoots = () =>
    (shoots ??= import("@/lib/integrations/autohdr").then((m) => m.autohdr.listPhotoshoots()).catch((e) => {
      shoots = null;
      throw e;
    }));

  await step("credits", async () => {
    const { latestSnapshot, recordCreditSnapshot } = await import("@/lib/photoDelivery/credits");
    const { refreshCatalogs } = await import("@/lib/photoDelivery/catalog");
    const catalogs = await refreshCatalogs().catch((e) => ({ error: (e as Error).message.slice(0, 120) }));
    const last = await latestSnapshot();
    if (last && Date.now() - last.at.getTime() < 14 * 60_000) return { skipped: "read in the last 15 minutes", catalogs };
    return { ...(await recordCreditSnapshot({ trigger: "cron" })), catalogs };
  }, { maxMs: 20_000 });

  await step("verify", async () => {
    const { verifyDeliveringJobs } = await import("@/lib/photoDelivery/verifySweep");
    return verifyDeliveringJobs({ max: 8 });
  }, { maxMs: 25_000 });

  await step("ready", async () => {
    // Each copy is checked in the folder, then the folder is swapped in.
    const { stageReadyJobs } = await import("@/lib/photoDelivery/handoff");
    return stageReadyJobs({ max: 2, budgetMs: 35_000 });
  }, { maxMs: 45_000 });

  await step("aryeo", async () => {
    const { drivePushes } = await import("@/lib/photoDelivery/aryeoPush");
    return drivePushes({ budgetMs: 35_000 });
  }, { maxMs: 45_000 });

  await step("sync", async () => {
    const { syncPhotoJobs } = await import("@/lib/photoDelivery/jobs");
    return syncPhotoJobs({ budgetMs: 40_000 });
  }, { maxMs: 50_000 });

  await step("link", async () => {
    const { linkOpenJobs } = await import("@/lib/photoDelivery/autohdrLink");
    return linkOpenJobs(6, { listShoots });
  }, { maxMs: 20_000 });

  await step("fixes", async () => {
    // Approved fixes only; new submissions only while the owner's switch is on.
    const { driveFixes } = await import("@/lib/photoDelivery/fixRunner");
    return driveFixes({ budgetMs: 30_000, leaseBy: `pd-cron-${new Date(startedAt).toISOString()}` });
  }, { maxMs: 40_000 });

  await step("intake", async () => {
    const { driveIntake } = await import("@/lib/photoDelivery/intake");
    return driveIntake({ budgetMs: Math.min(110_000, Math.max(15_000, remaining() - 45_000)), listShoots });
  }, { maxMs: 120_000 });

  await step("display", async () => {
    const { downloadForDisplay } = await import("@/lib/photoDelivery/display");
    return downloadForDisplay({ max: 2 });
  }, { maxMs: 30_000 });

  await step("digest", async () => {
    // Monday 8 AM ET: last week's photo delivery numbers to Jordan and Kyle.
    const { maybeSendPhotoDigest } = await import("@/lib/photoDelivery/digest");
    return maybeSendPhotoDigest();
  }, { maxMs: 15_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
