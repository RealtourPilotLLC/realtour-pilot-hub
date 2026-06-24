import { NextRequest, NextResponse } from "next/server";
import { syncGmail } from "@/lib/integrations/google";
import { sweepRepliedOpenPhoneTasks } from "@/lib/integrations/openphone";
import { syncSlackHistory } from "@/lib/integrations/slackSync";

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
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    out.gmail = await syncGmail();
  } catch (e) {
    out.gmailError = e instanceof Error ? e.message : String(e);
  }
  try {
    out.openphoneClosed = await sweepRepliedOpenPhoneTasks();
  } catch (e) {
    out.openphoneError = e instanceof Error ? e.message : String(e);
  }
  try {
    // Keep Slack comms memory near-live (channels + Jordan's DMs) every few
    // minutes via the user token. Small window; logComm dedups the overlap.
    out.slack = await syncSlackHistory({ sinceHours: 2 });
  } catch (e) {
    out.slackError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json({ ok: true, ...out });
}
