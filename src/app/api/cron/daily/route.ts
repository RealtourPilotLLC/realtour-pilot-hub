import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";
import { prisma } from "@/lib/prisma";
import { etDayKey, etYearStartKey } from "@/lib/datetime";

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
  // SHOOT NOTES THAT OUTLIVED THEIR SHOOT (Oct 19 2026, lib/taskAging): the
  // brain's "Note X for Y shoot" to-dos close themselves once the shoot day is
  // over, as a dismissal that says why, recorded in AuditLog and reversible
  // (scripts/_fix/oct19/old-items-cleanup.ts --undo). Before the 8 AM digests.
  await step("expireShootNotes", async () => {
    const { expireShootNotes } = await import("@/lib/taskAging");
    const r = await expireShootNotes(new Date(), { apply: true, actor: "cron:daily" });
    return { found: r.candidates.length, closed: r.closed };
  });
  // TO-DOS THAT OUTLIVED THEIR SHOOT (Oct 29 2026, lib/pastShootTasks): a
  // before-the-shoot step (booking, access, prep) on a job that was shot closes
  // as a dismissal that says why, reversible. OFF until Jordan's go
  // (`tasks:past_shoot_sweep`): until then this only counts what it would clear.
  await step("pastShootTasks", async () => {
    const { runPastShootSweep } = await import("@/lib/pastShootTasks");
    return runPastShootSweep(new Date(), { actor: "cron:daily" });
  });
  // Stripe money-in FIRST — see the note above.
  await step("stripe", async () => {
    const { syncStripe } = await import("@/lib/integrations/stripe");
    return syncStripe();
  }, { maxMs: 60_000 });

  // Books: pull the recent QuickBooks ledger, then re-run its classification
  // so Finance → Overview and the review desk stay current. RESTORED Oct 21
  // 2026: they were stopped on Oct 13 on the belief that Jordan does not use
  // QuickBooks, and he does ("QuickBooks should still pull and be
  // categorized"). The pull takes the one-caller QuickBooks lease
  // (integrations/quickbooks withQuickBooks): when the Sync button is mid-pull
  // it answers `skipped` having sent nothing, and the classify still runs over
  // what is stored. 45 days covers late entries and edits; a full 400-day pull
  // is the Sync button's job. The classify reads the ET year (and at least 60
  // days back, so January keeps December's peers for duplicate matching).
  await step("booksSync", async () => {
    const { syncQuickBooks } = await import("@/lib/integrations/quickbooks");
    const sinceKey = etDayKey(new Date(Date.now() - 45 * 864e5));
    return syncQuickBooks({ sinceKey, by: "the early-morning daily pull" });
  }, { maxMs: 60_000 });
  await step("booksClassify", async () => {
    const { categoriseBooks } = await import("@/lib/bookkeeping");
    const back60 = etDayKey(new Date(Date.now() - 60 * 864e5));
    const yearStart = etYearStartKey();
    const r = await categoriseBooks({ sinceKey: back60 < yearStart ? back60 : yearStart });
    return { scanned: r.scanned, flagged: r.flagged };
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
  // The year-to-date books audit (Oct 24 2026): its findings open owner tasks
  // and close them once the problem is gone (lib/financeAuditTasks).
  await step("booksAudit", async () => {
    const { runBooksAudit } = await import("@/lib/financeAuditTasks");
    return runBooksAudit();
  }, { maxMs: 45_000, after: "plaidCategorize" });
  // Retire delivery-text nudges that lingered a week (already sent off-app / moot).
  await step("staleDeliveryTexts", async () => {
    const { closeStaleDeliveryTexts } = await import("@/lib/tasks");
    return closeStaleDeliveryTexts(7);
  });
  // §10 AU-20 (Sep 26): Kyle's Monday AutoHDR balance check — one task on the
  // check day, none once a reading has landed. A reading, never a purchase.
  await step("autohdrBalanceCheck", async () => {
    const { ensureWeeklyBalanceCheck } = await import("@/lib/vendorBalance");
    return ensureWeeklyBalanceCheck();
  });
  // §10 AU-26 (Sep 26): a waived extra-round fee is revenue given up — one
  // rework row per round, idempotent, voided (never deleted) if reversed.
  await step("reworkWaivers", async () => {
    const { deriveWaivedRevenue } = await import("@/lib/reworkCost");
    return deriveWaivedRevenue();
  });
  // Housekeeping: webhook and cron-run logs past 30 days, bell rows past 90.
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
  // THE ERROR TRACKER'S DAILY REPORT (Oct 6 2026): every OPEN error with its
  // count, to Jordan (bell + Slack DM; his Saturday quiet window holds the DM
  // until 7:30 PM like every other notice). Once per ET day; nothing is sent
  // when nothing is open. A missing table is a no-op, never a failed step.
  await step("errorDigest", async () => {
    const { errorDigest } = await import("@/lib/errorTracker");
    return errorDigest();
  });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
