import { listMyShoots, photographerMemberId } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { MyShootsView } from "@/components/shoot/MyShootsView";

export const dynamic = "force-dynamic";

export default async function MyShootsPage() {
  const user = await getCurrentUser();
  // Photographers see ONLY their own assigned shoots — fail closed: if we can't
  // place them on the roster, they see none rather than everyone's. Owner/admin
  // (and the open, pre-cutover app) see everyone's.
  const scoped =
    user?.role === "PHOTOGRAPHER" ? ((await photographerMemberId(user)) ?? "__none__") : null;
  const rows = await listMyShoots(scoped);
  // Owner/admin: their own photographer id (so they can quick-filter to "only
  // mine" among the photographer toggles).
  const meId = scoped === null && user ? await photographerMemberId(user) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Field"
        title="My Shoots"
        subtitle={scoped ? "Your upcoming and recent shoots" : "All upcoming and recent shoots"}
      />
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <MyShootsView rows={rows} showWho={!scoped} meId={meId} />
      </div>
    </div>
  );
}
