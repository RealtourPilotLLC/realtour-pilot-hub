import { NextRequest, NextResponse } from "next/server";
import { syncAryeoOrders, syncAryeoAppointments } from "@/lib/integrations/aryeo";
import { cronBudget } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// HOURLY sync — keep orders + shoots fresh. Incremental (stops at known orders),
// so it's cheap. Heavy full-table jobs live in /api/cron/daily. Steps run under a
// time budget so a slow one degrades gracefully (the rest are reported as
// `skipped` and picked up next run) instead of being hard-killed mid-write.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const { step, out } = cronBudget(250_000, Date.now()); // ~50s headroom under maxDuration

  await step("orders", () => syncAryeoOrders({ full: false }));
  // Recent + future only, so the hourly run stays well under the time limit.
  await step("appointments", () => syncAryeoAppointments({ recentOnlyDays: 21 }));
  // Re-evaluate project statuses (Aryeo has no media-upload webhook, so this is
  // how a shoot's media gets detected → SHOT/REVIEW) and (re)generate the QC /
  // delivery tasks for active jobs. Bounded to the active set, so it stays cheap.
  await step("statuses", async () => {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    return syncProjectStatuses();
  });
  await step("tasks", async () => {
    const { generateTasksForActiveProjects } = await import("@/lib/tasks");
    return generateTasksForActiveProjects();
  });

  return NextResponse.json({ ok: true, ...out });
}
