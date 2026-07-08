import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { TeamTab } from "@/components/people/TeamTab";
import { LoginsTab } from "@/components/people/LoginsTab";
import type { PeopleTab } from "@/components/people/PeopleTabs";

export const dynamic = "force-dynamic";

// People = the merged Team (old /team workload directory) | Logins & access (old
// /users AppUser allowlist) hub. Each tab early-returns loading ONLY its own data
// (the communications pattern): the AppUser pull never runs for a Team view, the
// TeamMember pull never runs for a Logins view.
//
// PER-TAB GATING mirrors the two separate routes exactly:
//   • Team   — admin-visible (old /team was in ADMIN's page set)
//   • Logins — owner-only    (old /users was owner-only)
// A non-owner who deep-links ?tab=logins is redirected to Team — same net effect
// as the old owner-only route gate, now scoped to the tab.
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  // Same guard shape as the Tasks hub: getCurrentUser() is null sessionless
  // (local dev = owner view, gate off) and never redirects on its own; we only
  // bounce a signed-in user who lacks "users" access (owner + admin have it;
  // creatives are already stopped by middleware). No user ⇒ owner-view default.
  const me = await getCurrentUser().catch(() => null);
  if (me && !canAccess(me, "users")) redirect("/");
  // A real user → their role decides. No user → owner ONLY when auth is off
  // (local dev). In prod a null user is unauthenticated OR a revoked/disabled
  // account with a live JWT — neither may reach the owner-only Logins allowlist.
  const isOwner = me ? me.role === "OWNER" : !authEnforced();

  const sp = await searchParams;
  const requested = sp.tab;

  // Which tabs this viewer may see (owner: both; admin: Team only).
  const show: PeopleTab[] = isOwner ? ["team", "logins"] : ["team"];

  let tab: PeopleTab;
  if (requested === "logins") tab = "logins";
  else tab = "team"; // default (and the only tab admins get)

  // Owner-only tab: bounce a non-owner who asked for Logins to the Team tab.
  if (!isOwner && tab === "logins") {
    redirect("/users?tab=team");
  }

  if (tab === "logins") return <LoginsTab show={show} me={me} />;
  return <TeamTab show={show} />;
}
