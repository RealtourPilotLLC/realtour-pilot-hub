import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE TOPIC BANKS (every 15 minutes — see vercel.json). Oct 13 2026.
//
// CP-07: the initial bank after a strategy is approved, and per-pillar refills
// when usable stock runs low. Behind `topic_refresh` (and `ai_runs` under it);
// every result is a suggestion Jordan reviews, nothing reaches a client.
//
// It used to be one step near the end of the hourly sync with ~60 seconds.
// One refresh takes 45–60 seconds (a whole bank longer), so the second run of
// a tick always started with seconds left, the server stopped it mid-call and
// it read "AI run topic_refresh failed — lease expired" on every client's
// card (Jordan: "Everyone's topic idea refreshes have failed"). Here it has
// its own budget, and a run starts only with 150 seconds left to finish.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(270_000, startedAt, "topics");
  await step("topicBanks", async () => {
    const { sweepTopicBanks } = await import("@/lib/contentTopics");
    return sweepTopicBanks({ max: 3, budgetMs: Math.max(0, remaining() - 10_000), minStartMs: 150_000 });
  });
  await finish();
  return NextResponse.json(out);
}
