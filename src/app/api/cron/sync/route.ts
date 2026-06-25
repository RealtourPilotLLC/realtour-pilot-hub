import { NextRequest, NextResponse } from "next/server";
import { syncAryeoOrders, syncAryeoAppointments } from "@/lib/integrations/aryeo";

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
  // Re-evaluate project statuses (Aryeo has no media-upload webhook, so this is
  // how a shoot's media gets detected → SHOT/REVIEW) and (re)generate the QC /
  // delivery tasks for active jobs. Bounded to the active set, so it stays cheap.
  try {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    out.statuses = await syncProjectStatuses();
  } catch (e) {
    out.statusesError = e instanceof Error ? e.message : String(e);
  }
  try {
    const { generateTasksForActiveProjects } = await import("@/lib/tasks");
    out.tasks = await generateTasksForActiveProjects();
  } catch (e) {
    out.tasksError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json({ ok: true, ...out });
}
