import { listMyShoots, photographerMemberId, getShootPhotographer } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { MyShootsView } from "@/components/shoot/MyShootsView";

export const dynamic = "force-dynamic";

export default async function MyShootsPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const user = await getCurrentUser();
  const isPhotographer = user?.role === "PHOTOGRAPHER";
  const { as } = await searchParams;

  // Owner/admin can step into a specific photographer's view (read-only preview
  // of that photographer's My Shoots). Photographers can never use ?as= — they're
  // always scoped to themselves, fail-closed.
  const viewAs = !isPhotographer && as ? await getShootPhotographer(as) : null;

  // Photographers see ONLY their own assigned shoots; owner/admin see everyone's,
  // unless they're viewing as a specific photographer.
  const scoped = isPhotographer
    ? ((await photographerMemberId(user)) ?? "__none__")
    : viewAs?.id ?? null;
  const rows = await listMyShoots(scoped);

  // Owner/admin (not already scoped): their own photographer id for "only mine".
  const meId = scoped === null && user ? await photographerMemberId(user) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Field"
        title={viewAs ? `${viewAs.name}’s shoots` : "My Shoots"}
        subtitle={
          viewAs
            ? `Read-only — exactly what ${viewAs.name.split(" ")[0]} sees`
            : scoped
              ? "Your upcoming and recent shoots"
              : "All upcoming and recent shoots"
        }
      />
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <MyShootsView rows={rows} showWho={scoped === null} meId={meId} viewAs={viewAs} />
      </div>
    </div>
  );
}
