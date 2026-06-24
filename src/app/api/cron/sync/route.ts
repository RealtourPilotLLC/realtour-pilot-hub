import { NextRequest, NextResponse } from "next/server";
import { syncAryeoOrders, syncAryeoAppointments } from "@/lib/integrations/aryeo";
import { syncSlackHistory } from "@/lib/integrations/slackSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// HOURLY sync — keep orders + shoots fresh. Incremental (stops at known orders),
// so it's cheap. Heavy full-table jobs live in /api/cron/daily.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  // Isolate the two syncs so one failing doesn't abort the other.
  try {
    out.orders = await syncAryeoOrders({ full: false });
  } catch (e) {
    out.ordersError = e instanceof Error ? e.message : String(e);
  }
  try {
    // Recent + future only, so the hourly run stays well under the time limit.
    out.appointments = await syncAryeoAppointments({ recentOnlyDays: 21 });
  } catch (e) {
    out.appointmentsError = e instanceof Error ? e.message : String(e);
  }
  try {
    // Slack uses a user token (no webhooks) — pull the last ~3h of history into
    // comms memory each hour. logComm dedups, so the overlap is harmless.
    out.slack = await syncSlackHistory({ sinceHours: 3 });
  } catch (e) {
    out.slackError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json({ ok: true, ...out });
}
