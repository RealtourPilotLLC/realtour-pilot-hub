import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// VIDEO ANALYSIS WITH GEMINI (every 5 minutes, Oct 24 2026; lib/videoAnalysis).
// Covers for approved versions, and the spelling check (on trial, owner only)
// for versions in review. A tick with no key saved does one database read and
// returns: nothing reaches Google until Jordan pastes the key on Connections.
// With a key, at most two jobs a tick, each one model request, inside the
// owner's daily cap and outside any 429 pause. The frame grab runs the static
// ffmpeg that next.config ships with this route only.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(270_000, startedAt, "video-analysis");
  await step("gemini", async () => {
    const { runVideoAnalysis } = await import("@/lib/videoAnalysis");
    return runVideoAnalysis({ budgetMs: Math.max(60_000, remaining() - 15_000), leaseBy: `gva-cron-${new Date(startedAt).toISOString()}` });
  });
  await finish();
  return NextResponse.json({ ok: true, ...out });
}
