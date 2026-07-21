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

  // Stripe money-in FIRST. It is cheap (one or two pages off a cursor) and it is
  // the only source for a third of revenue, so it must never be the step that gets
  // starved. It used to run LAST, behind ordersFullReconcile — which the comment
  // below admits can eat the entire budget — and as a result it had not run from
  // cron in weeks while every CronRun died with finishedAt=null. That single
  // ordering bug is why the books showed a 32% revenue collapse that never happened.
  await step("stripe", async () => {
    const { syncStripe } = await import("@/lib/integrations/stripe");
    return syncStripe();
  });

  // Books: pull the recent QuickBooks ledger, then re-run the classification
  // engine so the Finance → Overview true P&L stays current without anyone
  // clicking anything. Bounded (45-day sync window, 2026-only classify) to stay
  // cheap, and under the same budget as every other step — if a slow day starves
  // it, it's picked up next run. categoriseBooks MUST follow the sync: it persists
  // the `category` that trueProfitAndLoss / the Overview read.
  await step("booksSync", async () => {
    const { syncQuickBooks } = await import("@/lib/integrations/quickbooks");
    const sinceKey = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    return syncQuickBooks({ sinceKey });
  });
  await step("booksClassify", async () => {
    const { categoriseBooks } = await import("@/lib/bookkeeping");
    return categoriseBooks({ sinceKey: "2026-01-01" });
  });

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
  // Retire week-old positive/neutral feedback-review tasks (nothing else closes
  // them; negative/URGENT ones stay until a human resolves them).
  await step("staleFeedbackReviews", async () => {
    const { closeStaleFeedbackReviews } = await import("@/lib/tasks");
    return closeStaleFeedbackReviews(7);
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
  // Trim bell notifications past their 90-day retention (single-watermark unread
  // means old rows are pure noise; own try/catch so a pre-db-push run can't fail).
  await step("notificationsTrimmed", async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const r = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return r.count;
    } catch {
      return 0; // table not pushed yet — never degrade the run over housekeeping
    }
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
