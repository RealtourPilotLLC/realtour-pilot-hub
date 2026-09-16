import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE 1080p LANE (every 5 minutes — see vercel.json).
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

  await step("topaz", async () => {
    const { driveTopazJobs } = await import("@/lib/topazJobs");
    // Four jobs a tick, each one step. An upload step can hold the whole budget
    // for one big file, which is fine: the other three come back next tick.
    return driveTopazJobs({
      max: 4,
      budgetMs: Math.max(30_000, remaining() - 20_000),
      leaseBy: `topaz-cron-${new Date(startedAt).toISOString()}`,
    });
  });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
