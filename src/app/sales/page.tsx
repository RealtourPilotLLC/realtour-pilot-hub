import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { RevenueTab } from "@/components/finance/RevenueTab";
import { UnpaidTab } from "@/components/finance/UnpaidTab";
import { PayrollTab } from "@/components/finance/PayrollTab";
import { MoneyTab } from "@/components/finance/MoneyTab";
import { OverviewTab } from "@/components/finance/OverviewTab";
import { PersonalTab } from "@/components/finance/PersonalTab";
import { PeopleTab } from "@/components/finance/PeopleTab";
import { JobsTab } from "@/components/finance/JobsTab";
import { SpendingTab } from "@/components/finance/SpendingTab";
import { AdvisorTab } from "@/components/finance/AdvisorTab";
import { BudgetTab } from "@/components/finance/BudgetTab";
import type { FinanceTab } from "@/components/finance/FinanceTabs";

export const dynamic = "force-dynamic";
// The Jobs tab runs the payroll engine (mileage routing) over a 60-day window;
// give the whole hub headroom so a cold mileage cache can't time the page out.
export const maxDuration = 60;

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
  // Transient session/DB failure must not render owner finance to a stale tab —
  // bounce to login (middleware guarantees a session exists in prod, so a null
  // here is a hiccup, and a healthy reload lands right back).
  if (!me && authEnforced()) redirect("/login?next=/sales");
  if (me && !canAccess(me, "sales")) redirect("/");
  // A real user → their role decides. No user → owner ONLY when auth is off
  // (local dev). getCurrentUser also returns null for a DISABLED/deleted
  // account, so in prod `!me` must NOT grant the owner-only Revenue/Payroll
  // tabs to a revoked session still holding a valid 7-day JWT.
  const isOwner = me ? me.role === "OWNER" : !authEnforced();

  const sp = await searchParams;
  const requested = sp.tab;

  // Which tabs this viewer may see (owner: all; admin: Unpaid only).
  const show: FinanceTab[] = isOwner
    ? ["overview", "advisor", "jobs", "people", "personal", "budget", "spending", "money", "revenue", "unpaid", "payroll"]
    : ["unpaid"];
  // Where non-owners land: their only tab, Unpaid. Owners land on Overview (the
  // command center — true P&L, cash, where the money's actually going).
  const fallback: FinanceTab = isOwner ? "overview" : "unpaid";

  let tab: FinanceTab;
  if (requested === "unpaid") tab = "unpaid";
  else if (requested === "payroll") tab = "payroll";
  else if (requested === "revenue") tab = "revenue";
  else if (requested === "money") tab = "money";
  else if (requested === "overview") tab = "overview";
  else if (requested === "personal") tab = "personal";
  else if (requested === "people") tab = "people";
  else if (requested === "jobs") tab = "jobs";
  else if (requested === "spending") tab = "spending";
  else if (requested === "advisor") tab = "advisor";
  else if (requested === "budget") tab = "budget";
  else tab = fallback; // no/unknown ?tab= → role default

  // Owner-only tabs: bounce a non-owner who asked for them to their default tab
  // (mirrors the old owner-only route gate, now per-tab).
  if (!isOwner && (tab === "revenue" || tab === "payroll" || tab === "money" || tab === "overview"
    || tab === "personal" || tab === "people" || tab === "jobs" || tab === "spending" || tab === "advisor" || tab === "budget")) {
    redirect("/sales?tab=unpaid");
  }

  if (tab === "unpaid") return <UnpaidTab show={show} />;
  if (tab === "payroll") return <PayrollTab show={show} start={sp.start} />;
  if (tab === "money") return <MoneyTab show={show} />;
  if (tab === "overview") return <OverviewTab show={show} />;
  if (tab === "personal") return <PersonalTab show={show} />;
  if (tab === "people") return <PeopleTab show={show} />;
  if (tab === "jobs") return <JobsTab show={show} />;
  if (tab === "spending") return <SpendingTab show={show} />;
  if (tab === "advisor") return <AdvisorTab show={show} />;
  if (tab === "budget") return <BudgetTab show={show} />;
  return <RevenueTab show={show} />;
}
