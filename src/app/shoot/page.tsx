import { listMyShoots } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { MyShootsView } from "@/components/shoot/MyShootsView";

export const dynamic = "force-dynamic";

export default async function MyShootsPage() {
  const user = await getCurrentUser();
  // Photographers see only their own shoots; owner/admin (and the open,
  // pre-cutover app) see everyone's.
  const scoped = user?.role === "PHOTOGRAPHER" && user.teamMemberId ? user.teamMemberId : null;
  const rows = await listMyShoots(scoped);

  return (
    <div>
      <PageHeader
        eyebrow="Field"
        title="My Shoots"
        subtitle={scoped ? "Your upcoming and recent shoots" : "All upcoming and recent shoots"}
      />
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <MyShootsView rows={rows} showWho={!scoped} />
      </div>
    </div>
  );
}
