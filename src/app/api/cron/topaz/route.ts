import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE 1080p LANE (every minute since Oct 19 2026 — see vercel.json).
//
// This is the driver for src/lib/topazJobs.ts: it claims a few jobs, moves each
// one step, and goes away. It does NOT try to finish anything. A render takes
// minutes at Topaz's end, the source files measure 76–465 MB, and this function
// is killed at 300 seconds — so the design is "one step per tick, resumable",
// not "do the render".
//
// Why five minutes and not the hourly sync: an approval is something Jordan
// does and then waits on. An hourly lane would mean a cut approved at 9:05 sat
// untouched until 10:00 before the upload even started. Five minutes keeps the
// whole pass — estimate, upload, render, file, ping Kyle — inside the window
// where he is still thinking about that job.
//
// EVERY MINUTE, NOT FIVE (Oct 19 2026, Jordan: "why is it taking so long to
// send the videos to Topaz?"). One step per tick at five-minute ticks made the
// median approve-to-filed time 28 minutes, about 6 of them real work (the
// estimate, the upload, Topaz's render, the Dropbox copy) and the rest waiting
// for the next tick. A tick with nothing to move does two reads and returns.
//
// It is SAFE for this and the hourly sync's own topaz step to run at the same
// time: every row is claimed by a compare-and-swap lease, so two ticks each get
// rows the other did not, and a row whose driver was hard-killed becomes
// claimable again when its lease expires.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(250_000, startedAt, "topaz"); // ~50s headroom under maxDuration

  // Run first so a long render/upload cannot starve staff delivery alerts.
  await step("delivery-alerts", async () => {
    const { notifyKyleDeliveryReady } = await import("@/lib/deliveryReadyNotify");
    return notifyKyleDeliveryReady();
  });

  await step("topaz", async () => {
    const { driveTopazJobs } = await import("@/lib/topazJobs");
    // Four jobs a tick, each one step. An upload step can hold the whole budget
    // for one big file, which is fine: the other three come back next tick.
    // About 80 s are kept back for the listing videos below.
    return driveTopazJobs({
      max: 4,
      budgetMs: Math.max(30_000, remaining() - 80_000),
      leaseBy: `topaz-cron-${new Date(startedAt).toISOString()}`,
    });
  });

  // LISTING VIDEOS INTO ARYEO (Oct 19 2026, lib/videoAryeoPush): moves on
  // the uploads PEOPLE STARTED with Upload to Aryeo and send in the Video
  // Review Room. Button only: it never starts a video nobody pressed,
  // whatever the stored switch says. Resumable: a big file goes up across
  // several ticks.
  await step("aryeo-video", async () => {
    const { driveVideoPushes } = await import("@/lib/videoAryeoPush");
    return driveVideoPushes({ budgetMs: Math.max(20_000, Math.min(65_000, remaining() - 15_000)) });
  }, { maxMs: 80_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
