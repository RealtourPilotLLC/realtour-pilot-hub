import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { syncAryeoSocialPlans, syncAllAryeoClients, syncAryeoCustomerTeams } from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";
import { reviewClientDuplicates } from "@/lib/clientDedupe";

// DAILY-CLIENTS (08:20) — the full-table client / customer-user / appointment
// reconciles. These scan every client and were the steps that ate the old
// single daily run's budget; they get their own window now (see /daily).
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(250_000, Date.now(), "daily-clients");

  await step("clients", () => syncAllAryeoClients(), { maxMs: 90_000 });
  // REPORT ONLY (Sep 2 2026): this step used to merge look-alike clients and
  // hard-delete the losers — it deleted 12 client rows on its first run, off a
  // phone-number match that can't tell a couple sharing a line from one person
  // with two records. It now files each candidate as a decision task instead.
  await step("duplicateReview", () => reviewClientDuplicates(), { maxMs: 30_000 });
  await step("segments", () => syncClientSegments(), { maxMs: 30_000 });
  await step("social", () => syncAryeoSocialPlans(), { maxMs: 30_000 });
  // Fold agency-team assistants under their agent so comms route to the orders.
  await step("customerTeams", () => syncAryeoCustomerTeams(), { maxMs: 30_000 });
  // (The full appointments reconcile is NOT here: measured at ~190s of API on
  // its own — 16 pages × 11.7s — it is what exhausted the old single daily
  // run. It runs as page slices in /api/cron/reconcile every hour instead.)
  // Rebuild a bounded batch of stale client working profiles (AI; cost-capped).
  // 150s, not 60s: 20 profiles' worth of model calls never fit in a minute, so
  // the step timed out EVERY night (2-5 profiles rebuilt instead of 20) while
  // ~240s of the 250s budget went unused — the steps above it measured ~7s
  // total on Sep 2. cronBudget still clamps this to whatever is actually left,
  // and 150s leaves the last step + finish() their room inside maxDuration.
  await step("clientProfiles", async () => {
    const { refreshStaleClientProfiles } = await import("@/lib/clientProfile");
    return refreshStaleClientProfiles(20);
  }, { maxMs: 150_000 });
  // Re-summarize every photographer's "work-ons for your next shoot" themes.
  await step("shootFocusSummaries", async () => {
    const { rebuildAllShootFocusSummaries } = await import("@/lib/photographerFeedback");
    return rebuildAllShootFocusSummaries();
  }, { maxMs: 60_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
