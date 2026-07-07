import { NextRequest, NextResponse } from "next/server";
import { syncAryeoSocialPlans, syncAllAryeoClients, syncAryeoAppointments, syncAryeoCustomerTeams, syncAryeoOrders } from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";
import { dedupeClients } from "@/lib/clientDedupe";
import { cronBudget } from "@/lib/cron";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// DAILY cron — the heavy, full-table maintenance jobs that scan every client /
// customer-user. Run once a day (not every tick) to keep Neon data transfer low.
// Steps run under a time budget so a slow one degrades gracefully (the rest are
// reported as `skipped` and picked up next run) instead of being hard-killed.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const { step, out, finish } = cronBudget(250_000, Date.now(), "daily"); // ~50s headroom under maxDuration

  await step("clients", () => syncAllAryeoClients());
  await step("dedupe", () => dedupeClients());
  await step("segments", () => syncClientSegments());
  await step("social", () => syncAryeoSocialPlans());
  // Fold agency-team assistants under their agent so comms route to the orders.
  await step("customerTeams", () => syncAryeoCustomerTeams());
  // Full appointments reconcile once a day (the hourly cron only does recent+future).
  await step("appointments", () => syncAryeoAppointments());
  // Retire delivery-text nudges that lingered a week (already sent off-app / moot).
  await step("staleDeliveryTexts", async () => {
    const { closeStaleDeliveryTexts } = await import("@/lib/tasks");
    return closeStaleDeliveryTexts(7);
  });
  await step("webhookLogTrimmed", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  });
  // Trim the cron-run log on the same 30-day horizon (best-effort pre-db-push).
  await step("cronRunLogTrimmed", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.cronRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
    return r.count;
  });
  // Rebuild a bounded batch of stale client working profiles (AI; cost-capped).
  await step("clientProfiles", async () => {
    const { refreshStaleClientProfiles } = await import("@/lib/clientProfile");
    return refreshStaleClientProfiles(20);
  });
  // Full ORDERS reconcile once a day — safety net for any order that finalized out
  // of created_at order (e.g. a draft placed days after it was created) and slipped
  // past the hourly incremental's recent window, so it can never be stranded.
  // LAST on purpose: measured at 130-330s it can eat the whole budget, and when it
  // does it must starve only itself — never the cheap safety-net steps above
  // (July 5's profile refreshes ran zero times because this step ran mid-list).
  await step("ordersFullReconcile", () => syncAryeoOrders({ full: true }));

  // Persist this run (CronRun) + Slack-ping on a NEW failure/skip. Best-effort.
  await finish();

  return NextResponse.json({ ok: true, ...out });
}
