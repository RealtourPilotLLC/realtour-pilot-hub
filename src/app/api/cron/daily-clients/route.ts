import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { syncAryeoSocialPlans, syncAllAryeoClients, syncAryeoCustomerTeams } from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";
import { dedupeClients } from "@/lib/clientDedupe";

// DAILY-CLIENTS (08:20) — the full-table client / customer-user / appointment
// reconciles. These scan every client and were the steps that ate the old
// single daily run's budget; they get their own window now (see /daily).
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(250_000, Date.now(), "daily-clients");

  await step("clients", () => syncAllAryeoClients(), { maxMs: 90_000 });
  await step("dedupe", () => dedupeClients(), { maxMs: 30_000 });
  await step("segments", () => syncClientSegments(), { maxMs: 30_000 });
  await step("social", () => syncAryeoSocialPlans(), { maxMs: 30_000 });
  // Fold agency-team assistants under their agent so comms route to the orders.
  await step("customerTeams", () => syncAryeoCustomerTeams(), { maxMs: 30_000 });
  // (The full appointments reconcile is NOT here: measured at ~190s of API on
  // its own — 16 pages × 11.7s — it is what exhausted the old single daily
  // run. It runs as page slices in /api/cron/reconcile every hour instead.)
  // Rebuild a bounded batch of stale client working profiles (AI; cost-capped).
  await step("clientProfiles", async () => {
    const { refreshStaleClientProfiles } = await import("@/lib/clientProfile");
    return refreshStaleClientProfiles(20);
  }, { maxMs: 60_000 });
  // Re-summarize every photographer's "work-ons for your next shoot" themes.
  await step("shootFocusSummaries", async () => {
    const { rebuildAllShootFocusSummaries } = await import("@/lib/photographerFeedback");
    return rebuildAllShootFocusSummaries();
  }, { maxMs: 60_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
