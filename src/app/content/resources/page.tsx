import { redirect } from "next/navigation";
import Link from "next/link";
import { BookOpen, FileSearch } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { listResourcesForAdmin, RESOURCE_GROUPS, PLATFORMS, DEVICES, LINKABLE_ACTIONS } from "@/lib/portalResourcesAdmin";
import { staffChoices } from "@/lib/programOwners";
import { programReviewItems } from "@/lib/programMonitoring";
import { ResourcesAdminPanel } from "@/components/content/ResourcesAdminPanel";
import { BackfillReview } from "@/components/content/BackfillReview";

export const dynamic = "force-dynamic";

// Resources authoring (§11) and the program-wide backfill review (§14) — two
// jobs that are neither one client's nor one month's, kept off the portfolio
// overview so that screen stays about the month.
export default async function ContentResourcesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content/resources");
  if (me && !canAccess(me, "content")) redirect("/");
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  const view = (await searchParams).view === "backfill" ? "backfill" : "guides";

  const [rows, staff, items] = await Promise.all([
    view === "guides" ? listResourcesForAdmin().catch(() => []) : Promise.resolve([]),
    staffChoices().catch(() => []),
    view === "backfill" ? programReviewItems().catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader
        eyebrow="Content program"
        title={view === "guides" ? "Client resources" : "Backfill review"}
        subtitle={view === "guides" ? "the guides clients read — edited here, live without a deploy" : "records across every client that look mis-filed"}
        actions={
          <div className="flex items-center gap-1.5">
            <Link href="/content/resources" className={view === "guides" ? "rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white" : "rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"}>
              <BookOpen className="mr-1 inline size-3.5" />Guides
            </Link>
            <Link href="/content/resources?view=backfill" className={view === "backfill" ? "rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white" : "rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"}>
              <FileSearch className="mr-1 inline size-3.5" />Backfill review
            </Link>
          </div>
        }
      />
      <div className="mx-auto max-w-5xl space-y-6 p-4 pb-16 sm:p-6">
        {view === "guides" ? (
          <ResourcesAdminPanel
            rows={rows.map((r) => ({
              id: r.id, slug: r.slug, groupKey: r.groupKey, title: r.title, summary: r.summary, body: r.body,
              platform: r.platform, deviceContext: r.deviceContext, ownerAppUserId: r.ownerAppUserId, ownerName: r.ownerName,
              reviewedAtISO: r.reviewedAt?.toISOString() ?? null, linkedActions: r.linkedActions, published: r.published,
              sortOrder: r.sortOrder, stale: r.stale,
            }))}
            groups={RESOURCE_GROUPS}
            platforms={[...PLATFORMS]}
            devices={[...DEVICES]}
            actions={LINKABLE_ACTIONS}
            staff={staff.map((s) => ({ id: s.id, name: s.name }))}
            isOwner={ownerEyes}
          />
        ) : (
          <BackfillReview
            items={items.map((i) => ({
              key: i.key, kind: i.kind, clientName: i.clientName, enrollmentId: i.enrollmentId, monthKey: i.monthKey,
              title: i.title, detail: i.detail, handled: i.handled,
            }))}
          />
        )}
      </div>
    </div>
  );
}
