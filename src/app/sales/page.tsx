import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { RevenueTab } from "@/components/finance/RevenueTab";
import { UnpaidTab } from "@/components/finance/UnpaidTab";
import { PayrollTab } from "@/components/finance/PayrollTab";
import type { FinanceTab } from "@/components/finance/FinanceTabs";

export const dynamic = "force-dynamic";

// Finance = the merged Revenue (old /sales) | Unpaid (old /billing) | Payroll
// (old /payouts) hub. Each tab early-returns loading ONLY its own data (the
// communications pattern) — the heavy payroll computation never runs for a
// Revenue view, the AR pull never runs for a Payroll view.
//
// PER-TAB GATING mirrors exactly what the three separate routes did before:
//   • Revenue  — owner-only  (admins never saw the Sales Tracker)
//   • Unpaid   — admin-visible (old /billing was in ADMIN's page set)
//   • Payroll  — owner-only  (old /payouts was owner-only in ROLE_PAGES)
// A non-owner who deep-links ?tab=revenue or ?tab=payroll is redirected to the
// tab they CAN see (their default) — same net effect as the old middleware
// bounce on /sales and /payouts, but scoped to the tab instead of the page.
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; start?: string }>;
}) {
  // Same guard shape as the Tasks hub: getCurrentUser() is null sessionless
  // (local dev = owner view, gate off) and never redirects on its own; we only
  // bounce a signed-in user who lacks "sales" access (owner + admin have it;
  // creatives are already stopped by middleware). No user ⇒ owner-view default.
  const me = await getCurrentUser().catch(() => null);
  if (me && !canAccess(me, "sales")) redirect("/");
  // A real user → their role decides. No user → owner ONLY when auth is off
  // (local dev). getCurrentUser also returns null for a DISABLED/deleted
  // account, so in prod `!me` must NOT grant the owner-only Revenue/Payroll
  // tabs to a revoked session still holding a valid 7-day JWT.
  const isOwner = me ? me.role === "OWNER" : !authEnforced();

  const sp = await searchParams;
  const requested = sp.tab;

  // Which tabs this viewer may see (owner: all three; admin: Unpaid only).
  const show: FinanceTab[] = isOwner ? ["revenue", "unpaid", "payroll"] : ["unpaid"];
  // Where non-owners land: their only tab, Unpaid. Owners default to Revenue.
  const fallback: FinanceTab = isOwner ? "revenue" : "unpaid";

  let tab: FinanceTab;
  if (requested === "unpaid") tab = "unpaid";
  else if (requested === "payroll") tab = "payroll";
  else if (requested === "revenue") tab = "revenue";
  else tab = fallback; // no/unknown ?tab= → role default

  // Owner-only tabs: bounce a non-owner who asked for them to their default tab
  // (mirrors the old owner-only route gate, now per-tab).
  if (!isOwner && (tab === "revenue" || tab === "payroll")) {
    redirect("/sales?tab=unpaid");
  }

  if (tab === "unpaid") return <UnpaidTab show={show} />;
  if (tab === "payroll") return <PayrollTab show={show} start={sp.start} />;
  return <RevenueTab show={show} />;
}
