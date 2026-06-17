import { Building2, Mail, Phone, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { getClients } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const clients = await getClients();

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={`${clients.length} clients · smart notes & preferences`}
      />
      <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
        {clients.map((c) => (
          <div key={c.id} className="rounded-2xl border bg-surface p-5">
            <div className="flex items-center gap-3">
              <Avatar name={c.name} size={40} color="#4f46e5" />
              <div className="min-w-0">
                <div className="truncate font-semibold">{c.name}</div>
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
              <p className="mt-2 text-xs text-muted">{c.generalNotes}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
