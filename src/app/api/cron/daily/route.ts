import { NextRequest, NextResponse } from "next/server";
import { syncAryeoSocialPlans, syncAllAryeoClients, syncAryeoAppointments, syncAryeoCustomerTeams } from "@/lib/integrations/aryeo";
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
  const { step, out } = cronBudget(250_000, Date.now()); // ~50s headroom under maxDuration

  await step("clients", () => syncAllAryeoClients());
  await step("dedupe", () => dedupeClients());
  await step("segments", () => syncClientSegments());
  await step("social", () => syncAryeoSocialPlans());
  // Fold agency-team assistants under their agent so comms route to the orders.
  await step("customerTeams", () => syncAryeoCustomerTeams());
  // Full appointments reconcile once a day (the hourly cron only does recent+future).
  await step("appointments", () => syncAryeoAppointments());
  await step("webhookLogTrimmed", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  });
  // Rebuild a bounded batch of stale client working profiles (AI; cost-capped).
  await step("clientProfiles", async () => {
    const { refreshStaleClientProfiles } = await import("@/lib/clientProfile");
    return refreshStaleClientProfiles(20);
  });

  return NextResponse.json({ ok: true, ...out });
}
