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
  // FAIL CLOSED: in prod/Vercel a missing CRON_SECRET must refuse, not open the
  // door — same rule as the auth gate (losing an env var never fails open).
  const secret = process.env.CRON_SECRET;
  const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  if (!secret && enforced) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
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
  await step("expireSlackTasks", async () => {
    const { expireStaleSlackTasks } = await import("@/lib/tasks");
    return expireStaleSlackTasks();
  });
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
  // Pull fresh transactions + balances from every connected Plaid bank/card.
  // No-op (returns 0 items) until Jordan links accounts — safe to always run.
  await step("plaidSync", async () => {
    const { syncAllPlaid } = await import("@/lib/integrations/plaid");
    return syncAllPlaid();
  });
  // Tag any freshly-synced bank/card rows business/personal by category
  // (skips rows the owner hand-locked). Powers the Categories tab.
  await step("plaidCategorize", async () => {
    const { categorizeAllPlaid } = await import("@/lib/financeCategories");
    return categorizeAllPlaid();
  });
  // Count raw photos in recent shoots' Dropbox folders → per-job AutoHDR cost.
  await step("photoCounts", async () => {
    const { sweepPhotoCounts } = await import("@/lib/photoCount");
    return sweepPhotoCounts({ days: 21, max: 80 });
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
  // HARD-CAPPED at 150s: measured 130-330s, it kept blowing past maxDuration and
  // killing the function BEFORE finish() — so every CronRun died with
  // finishedAt=null and monitoring was blind since inception (final-audit find).
  // A timed-out reconcile resumes next run; a dead finish() never does.
  await step("ordersFullReconcile", () =>
    Promise.race([
      syncAryeoOrders({ full: true }),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, note: "capped at 150s so finish() always records the run" }), 150_000)),
    ]),
  );

  // Second-chance Plaid sync for items that FAILED the morning sweep — runs
  // minutes after plaidSync, comfortably past minute-scale 429 rate limits (a
  // single 429 used to freeze an item for a full day; PNC sat stuck 2 days).
  await step("plaidRetryErrored", async () => {
    const { retryErroredPlaidItems } = await import("@/lib/integrations/plaid");
    return retryErroredPlaidItems();
  });

  // Re-summarize every photographer's "work-ons for your next shoot" themes so
  // acknowledged/resolved notes drop out overnight (the share action rebuilds
  // on demand; this is the backstop).
  await step("shootFocusSummaries", async () => {
    const { rebuildAllShootFocusSummaries } = await import("@/lib/photographerFeedback");
    return rebuildAllShootFocusSummaries();
  });

  // Cost every shoot for the Trends margin table. This runs the payroll engine,
  // which resolves mileage through the public OSRM router — far too slow and too
  // network-dependent for a page request (it took a 60s serverless function down
  // in production). Done here once a night; the page just reads the row.
  await step("packageMargins", async () => {
    const { rebuildPackageMargins } = await import("@/lib/packageMargin");
    return rebuildPackageMargins();
  });

  // Rebuild the Trends growth plan (new packages, promotions, what to focus on
  // and fix) so it reflects last night's bookings. It is cached against a hash
  // of the business numbers, so on a day nothing moved this is a no-op and
  // costs nothing — the model is only called when the picture actually changed.
  await step("growthPlan", async () => {
    const { rebuildGrowthPlan } = await import("@/lib/growthPlan");
    const r = await rebuildGrowthPlan();
    return { rebuilt: !!r.plan && !r.error, error: r.error ?? null };
  });

  // Persist this run (CronRun) + Slack-ping on a NEW failure/skip. Best-effort.
  await finish();

  return NextResponse.json({ ok: true, ...out });
}
