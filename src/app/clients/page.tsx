import Link from "next/link";
import { Building2, Mail, Palette, Phone, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { getClients } from "@/lib/queries";
import { SEGMENT_META, type SegmentKey } from "@/lib/segments";
import { stripHtml } from "@/lib/utils";

export const dynamic = "force-dynamic";

// High-value → low-value, so the most important customers sit at the top.
const SEGMENT_ORDER: SegmentKey[] = ["vip", "heavy", "regular", "casual_repeat", "one_timer", "never_converted"];

export default async function ClientsPage() {
  const clients = await getClients();

  // Group clients by their segment, preserving the name sort within each group.
  const groups = SEGMENT_ORDER.map((key) => ({
    key,
    meta: SEGMENT_META[key],
    clients: clients.filter((c) => (c.segment ?? "never_converted") === key),
  })).filter((g) => g.clients.length > 0);

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={`${clients.length} clients · grouped by segment`}
        // Client Assets lives as a TAB here (Jordan: "client assets should be
        // in the clients tab"), not its own nav item.
        actions={
          <Link
            href="/clients/assets"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <Palette className="size-4 text-brand" /> Client Assets
          </Link>
        }
      />
      <div className="space-y-8 p-4 sm:p-6">
        {groups.map((g) => (
          <section key={g.key}>
            <div className="mb-3 flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: g.meta.color }} />
              <h2 className="text-sm font-semibold">{g.meta.label}</h2>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">{g.clients.length}</span>
              <span className="hidden truncate text-xs text-muted-2 sm:inline">· {g.meta.blurb}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {g.clients.map((c) => (
                <Link key={c.id} href={`/clients/${c.id}`} className="panel-shadow lift rounded-2xl border bg-surface p-5 hover:bg-surface-2">
            <div className="flex items-center gap-3">
              <Avatar name={c.name} size={40} color="#4f46e5" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-semibold">{c.name}</span>
                  <SegmentBadge segment={c.segment} size="xs" />
                  <SocialBadge socialClient={c.socialClient} socialPlan={c.socialPlan} size="xs" />
                </div>
                {c.company && (
                  <div className="flex items-center gap-1 truncate text-xs text-muted">
                    <Building2 className="size-3" /> {c.company}
                  </div>
                )}
              </div>
              <Badge className="ml-auto">{c._count.projects} projects</Badge>
            </div>

            <div className="mt-3 space-y-1 text-sm text-muted">
              {c.email && (
                <div className="flex items-center gap-2">
                  <Mail className="size-3.5" /> {c.email}
                </div>
              )}
              {c.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="size-3.5" /> {c.phone}
                </div>
              )}
            </div>

            {c.editingPreferences && (
              <div className="mt-3 rounded-lg bg-brand-soft px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
                  <Sparkles className="size-3" /> Editing preferences
                </div>
                <p className="text-xs text-foreground/80">{c.editingPreferences}</p>
              </div>
            )}
            {c.generalNotes && (
              <p className="mt-2 line-clamp-4 text-xs text-muted">{stripHtml(c.generalNotes)}</p>
            )}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
