import Link from "next/link";
import { Megaphone, Sparkles, Share2, Star } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { format } from "date-fns";

export const dynamic = "force-dynamic";

export default async function MarketingPage() {
  // Recently delivered work = ready-to-showcase content.
  const delivered = await prisma.project.findMany({
    where: { status: "DELIVERED" },
    orderBy: { deliveredAt: "desc" },
    take: 12,
    include: { client: true, deliverables: true },
  });

  return (
    <div>
      <PageHeader
        title="Marketing"
        subtitle="Showcase delivered work and plan campaigns"
        actions={<Badge soft="var(--surface-2)">Social scheduling — coming with integrations</Badge>}
      />
      <div className="space-y-8 p-6">
        {/* Ready to showcase */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Star className="size-4 text-warning" />
            <h2 className="text-sm font-semibold">Ready to showcase</h2>
            <span className="text-xs text-muted">Recently delivered galleries</span>
          </div>
          {delivered.length === 0 ? (
            <p className="text-sm text-muted">No delivered galleries yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {delivered.map((p) => (
                <div key={p.id} className="rounded-2xl border bg-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/projects/${p.id}`} className="truncate font-semibold hover:underline">
                        {p.title}
                      </Link>
                      <div className="truncate text-xs text-muted">{p.client.name}</div>
                    </div>
                    {p.deliveredAt && (
                      <span className="shrink-0 text-xs text-muted-2">
                        {format(p.deliveredAt, "MMM d")}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.deliverables.slice(0, 4).map((d) => (
                      <span
                        key={d.id}
                        className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                      >
                        {d.type.replace(/_/g, " ").toLowerCase()}
                      </span>
                    ))}
                  </div>
                  <button
                    disabled
                    className="mt-3 inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium opacity-60"
                    title="Available once social accounts are connected"
                  >
                    <Share2 className="size-3.5" /> Create social post
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Campaigns placeholder */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Megaphone className="size-4 text-brand" />
            <h2 className="text-sm font-semibold">Campaigns</h2>
          </div>
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Sparkles className="size-6" />
            </span>
            <h3 className="font-semibold">Campaign planning is on the roadmap</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Plan email and social campaigns, track performance, and auto-generate
              listing promos from delivered galleries. This unlocks when we connect
              SendGrid, Facebook, and your social accounts.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
