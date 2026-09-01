import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";
import { syncAryeoOrders, syncAryeoAppointments } from "@/lib/integrations/aryeo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// RECONCILE (:30 every hour) — the Aryeo safety net, in page slices.
//
// A full pass over every order is ~226s of pure API (31 pages × 7.3s) and the
// full appointments pass ~190s (16 × 11.7s) — neither can finish inside one
// 5-minute function, which is why the old daily "ordersFullReconcile" had
// completed zero times in 30 days. Each run here walks a bounded number of
// pages, persists its cursor, and the next run continues; a full cycle over
// all orders completes every ~4 hours and is provable (/connections shows the
// last completed pass). Offset to :30 so it never overlaps the :00 sync.
//
// What the pass catches that the hourly 45-day incremental can't: orders that
// finalized out of created_at order, money/fulfilment drift on old orders, and
// (since Sep 1) line items removed/added after import → deliverables.
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish, remaining } = cronBudget(250_000, Date.now(), "reconcile");

  await step("ordersSlice", () =>
    syncAryeoOrders({ full: true, maxPages: 8, budgetMs: Math.max(60_000, remaining() - 120_000) }));
  await step("appointmentsSlice", () =>
    syncAryeoAppointments({ maxPages: 4, budgetMs: Math.max(30_000, remaining() - 20_000) }));

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
