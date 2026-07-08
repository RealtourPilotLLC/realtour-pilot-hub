import { NextRequest, NextResponse } from "next/server";
import { syncGmail } from "@/lib/integrations/google";
import { sweepRepliedOpenPhoneTasks } from "@/lib/integrations/openphone";
import { syncSlackHistory } from "@/lib/integrations/slackSync";
import { sweepReplySla } from "@/lib/commsSla";
import { cronBudget } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// COMMS cron (runs every few minutes — see vercel.json). Keeps communications
// live: scans the inbox into tasks and closes OpenPhone reply tasks we've since
// answered. Inbound texts/calls already arrive in real time via OpenPhone
// webhooks; this covers Gmail (no push) + the answered-thread sweep. It's light
// on the DB (no full-table scans — those run in /api/cron/daily).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  // Budgeted steps (same pattern as /sync + /daily): each failure is captured
  // per-step, and the run lands in CronRun so a dead comms scan is visible on
  // /connections instead of silently degrading.
  const { step, out, finish } = cronBudget(100_000, Date.now(), "gmail"); // ~20s headroom under maxDuration

  await step("gmail", () => syncGmail());
  await step("openphoneClosed", () => sweepRepliedOpenPhoneTasks());
  // Keep Slack comms memory near-live (channels + Jordan's DMs) every few
  // minutes via the user token. Small window; logComm dedups the overlap.
  await step("slack", () => syncSlackHistory({ sinceHours: 2 }));
  // Reply-SLA escalation: page the team when an inbound client text sits
  // unanswered (30m → ADMIN bell + Slack, 2h → OWNER + urgent; VIPs faster).
  // Best-effort by construction — sweepReplySla never throws — and the step()
  // wrapper keeps even a surprise failure from blocking Gmail polling.
  await step("replySla", () => sweepReplySla());

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
