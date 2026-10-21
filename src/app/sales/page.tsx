import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess, canSeeMoney } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { UnpaidTab } from "@/components/finance/UnpaidTab";
import { PayrollTab } from "@/components/finance/PayrollTab";
import { OverviewTab } from "@/components/finance/OverviewTab";
import { PersonalTab } from "@/components/finance/PersonalTab";
import { PeopleTab } from "@/components/finance/PeopleTab";
import { JobsTab } from "@/components/finance/JobsTab";
import { SpendingTab } from "@/components/finance/SpendingTab";
import { AdvisorTab } from "@/components/finance/AdvisorTab";
import { BudgetTab } from "@/components/finance/BudgetTab";
import { BonusTab } from "@/components/finance/BonusTab";
import { PayStructureTab } from "@/components/finance/PayStructureTab";
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
// PER-TAB GATING:
//   • every tab but Unpaid — owner-only
//   • Unpaid — the one tab a NON-owner can open, and only with a per-person
//     `sales` grant: ADMIN's default page set has had no "sales" since Sep 2
//     ("full ops access, no money"), so Kyle never reaches this page at all.
//     (Corrected Oct 20 2026, audit G12: this used to say "admin-visible".)
//     A PAGE GRANT IS NOT A MONEY GRANT (Jordan, Oct 21 2026: "A page-access
//     override never grants money"): such a person sees which delivered jobs
//     are unpaid, never an amount, and none of the chase / mark-paid buttons
//     (those actions are owner-only, app/billing/actions.ts).
// A non-owner who deep-links any other ?tab= is redirected to Unpaid.
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; start?: string; back?: string }>;
}) {
  // Same guard shape as the Tasks hub: getCurrentUser() is null sessionless
  // (local dev = owner view, gate off) and never redirects on its own; we only
  // bounce a signed-in user who lacks "sales" access (the owner, plus anyone
  // holding a per-person grant; the auth proxy already stops everyone else).
  // No user ⇒ owner-view default.
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
  // Dollars follow canSeeMoney (the hub's one money rule), never the page
  // grant. The previewed role under "view as", so a preview shows the truth.
  const money = me ? canSeeMoney(me.role) : !authEnforced();

  const sp = await searchParams;
  const requested = sp.tab;

  // Which tabs this viewer may see (owner: all; a `sales` grant holder: Unpaid only).
  // "money" + "revenue" retired Aug 25 (audit) — Money duplicated Overview and
  // its entry forms were never used; Revenue reported Aryeo-price figures that
  // contradicted the processor-truth engine. Old ?tab= deep links fall through
  // to Overview below.
  const show: FinanceTab[] = isOwner
    ? ["overview", "advisor", "jobs", "people", "personal", "budget", "spending", "unpaid", "payroll", "paystructure", "bonus"]
    : ["unpaid"];
  // Where non-owners land: their only tab, Unpaid. Owners land on Overview (the
  // command center — true P&L, cash, where the money's actually going).
  const fallback: FinanceTab = isOwner ? "overview" : "unpaid";

  let tab: FinanceTab;
  if (requested === "unpaid") tab = "unpaid";
  else if (requested === "payroll") tab = "payroll";
  else if (requested === "paystructure") tab = "paystructure";
  else if (requested === "overview" || requested === "revenue" || requested === "money") tab = "overview";
  else if (requested === "personal") tab = "personal";
  else if (requested === "people") tab = "people";
  else if (requested === "jobs") tab = "jobs";
  else if (requested === "spending") tab = "spending";
  else if (requested === "advisor") tab = "advisor";
  else if (requested === "budget") tab = "budget";
  else if (requested === "bonus") tab = "bonus";
  else tab = fallback; // no/unknown ?tab= → role default

  // Owner-only tabs: bounce a non-owner who asked for them to their default tab
  // (mirrors the old owner-only route gate, now per-tab).
  if (!isOwner && tab !== "unpaid") {
    redirect("/sales?tab=unpaid");
  }

  if (tab === "unpaid") return <UnpaidTab show={show} money={money} />;
  if (tab === "payroll") return <PayrollTab show={show} start={sp.start} />;
  // Old vs new pay (Oct 21 2026). Owner-only like every tab but Unpaid; the
  // tab's loader (lib/paySavings.ts ownerPaySavings) refuses anyone else too.
  if (tab === "paystructure") return <PayStructureTab show={show} />;
  if (tab === "personal") return <PersonalTab show={show} />;
  if (tab === "people") return <PeopleTab show={show} />;
  if (tab === "jobs") return <JobsTab show={show} />;
  if (tab === "spending") return <SpendingTab show={show} />;
  if (tab === "advisor") return <AdvisorTab show={show} />;
  if (tab === "budget") return <BudgetTab show={show} />;
  if (tab === "bonus") return <BonusTab show={show} back={Number(sp.start ?? 0) || Number((sp as { back?: string }).back ?? 0) || 0} />;
  return <OverviewTab show={show} />;
}
