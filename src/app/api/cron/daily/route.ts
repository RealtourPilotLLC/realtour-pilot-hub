import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// DAILY — money + housekeeping. Cheap, fast, and the steps that must NEVER be
// starved (Stripe is the only source for a third of revenue).
//
// Why three daily routes (Sep 1 2026): the single daily cron carried 27 steps
// under one 250s budget and its first 16 alone measured ~250s, so the tail —
// including ordersFullReconcile, the safety net for orders that drift — was
// skipped or killed on 29 of the last 30 days. Each route now owns its own
// 5-minute window: /daily (08:00) money + housekeeping, /daily-clients (08:20)
// the full-table client/appointment reconciles, /daily-reconcile (08:40) the
// order sweep (resumable) + the AI/network rebuilds.
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(250_000, Date.now(), "daily");

  await step("expireSlackTasks", async () => {
    const { expireStaleSlackTasks } = await import("@/lib/tasks");
    return expireStaleSlackTasks();
  });
  // Stripe money-in FIRST — see the note above.
  await step("stripe", async () => {
    const { syncStripe } = await import("@/lib/integrations/stripe");
    return syncStripe();
  }, { maxMs: 60_000 });

  // Books: pull the recent QuickBooks ledger, then re-run the classification
  // engine so Finance → Overview stays current. categoriseBooks MUST follow the
  // sync: it persists the `category` that trueProfitAndLoss reads.
  await step("booksSync", async () => {
    const { syncQuickBooks } = await import("@/lib/integrations/quickbooks");
    const sinceKey = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    return syncQuickBooks({ sinceKey });
  }, { maxMs: 60_000 });
  await step("booksClassify", async () => {
    const { categoriseBooks } = await import("@/lib/bookkeeping");
    return categoriseBooks({ sinceKey: "2026-01-01" });
  }, { maxMs: 45_000, after: "booksSync" });
  // Payday morning: "your $X lands today" to every paid creative.
  await step("paydayPings", async () => {
    const { paydayPings } = await import("@/lib/payroll");
    return paydayPings();
  });
  // Statement-import staleness (Venmo / Tilt exports 21+ days stale → owner bell).
  await step("staleStatements", async () => {
    const { nagStaleStatements } = await import("@/lib/financeCategories");
    return nagStaleStatements();
  });
  // Ops go-dark alarm: an ops login went quiet or lost its role.
  await step("opsGoDark", async () => {
    const { checkOpsGoDark } = await import("@/lib/usage");
    return checkOpsGoDark();
  });
  // Plaid: fresh transactions + balances, then business/personal tagging.
  await step("plaidSync", async () => {
    const { syncAllPlaid } = await import("@/lib/integrations/plaid");
    return syncAllPlaid();
  }, { maxMs: 60_000 });
  await step("plaidCategorize", async () => {
    const { categorizeAllPlaid } = await import("@/lib/financeCategories");
    return categorizeAllPlaid();
  }, { after: "plaidSync" });
  // Retire delivery-text nudges that lingered a week (already sent off-app / moot).
  await step("staleDeliveryTexts", async () => {
    const { closeStaleDeliveryTexts } = await import("@/lib/tasks");
    return closeStaleDeliveryTexts(7);
  });
  // Retire week-old positive/neutral feedback-review tasks.
  await step("webhookLogTrimmed", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  });
  await step("cronRunLogTrimmed", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.cronRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
    return r.count;
  });
  await step("notificationsTrimmed", async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const r = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return r.count;
    } catch {
      return 0; // table not pushed yet — never degrade the run over housekeeping
    }
  });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
