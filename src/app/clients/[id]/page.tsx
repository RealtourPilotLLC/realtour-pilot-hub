import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft, Mail, Phone, Building2, IdCard, Package, DollarSign,
  Activity as ActivityIcon, Star, ArrowRight, Camera, Users, Sparkles,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { ClientWorkspace } from "@/components/clients/ClientWorkspace";
import { AgentProfile } from "@/components/clients/AgentProfile";
import { ClientChat } from "@/components/clients/ClientChat";
import { ClientEmails } from "@/components/clients/ClientEmails";
import { ClientTodos } from "@/components/clients/ClientTodos";
import { ShowMore } from "@/components/ui/ShowMore";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { getClientDetail } from "@/lib/queries";
import { stageMeta } from "@/lib/pipeline";
import { formatMoney, stripHtml } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { etDateYear, etMonthDay } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClientDetail(id);
  if (!data) notFound();
  const { client, timeline, totalSpend } = data;

  // Orders count + lifetime spend exclude cancelled, to match the segment chip.
  const orderCount = client.projects.filter((p) => p.status !== "CANCELLED").length;

  // Best-effort "last thing the client said" for the AI draft hint — exclude our
  // own outbound log lines ("Text sent to …", "Delivery text sent …") so we never
  // draft a reply to ourselves.
  const lastInbound =
    timeline.find(
      (t) =>
        t.kind === "activity" &&
        /text:|email|message|said|wrote|asked|inbound/i.test(t.body) &&
        !/\bsent to\b|sent\.|\breplied\b/i.test(t.body),
    )?.body ?? "";

  return (
    <div>
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <Link href="/clients" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> All clients
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={client.name} size={56} color="#4f46e5" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
              <SegmentBadge segment={client.segment} title />
              <SocialBadge socialClient={client.socialClient} socialPlan={client.socialPlan} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {client.company && (
                <span className="inline-flex items-center gap-1.5"><Building2 className="size-3.5" /> {client.company}</span>
              )}
              {client.email && (
                <a href={`mailto:${client.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Mail className="size-3.5" /> {client.email}
                </a>
              )}
              {client.backupEmail && (
                <a href={`mailto:${client.backupEmail}`} className="inline-flex items-center gap-1.5 text-muted-2 hover:text-foreground" title="Backup email (from a merged duplicate)">
                  <Mail className="size-3.5" /> {client.backupEmail} <span className="text-[10px] uppercase tracking-wide">backup</span>
                </a>
              )}
              {client.phone && (
                <a href={`tel:${client.phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Phone className="size-3.5" /> {client.phone}
                </a>
              )}
              {client.licenseNumber && (
                <span className="inline-flex items-center gap-1.5"><IdCard className="size-3.5" /> {client.licenseNumber}</span>
              )}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={`/assistant?q=${encodeURIComponent(`Catch me up on ${client.name}: recent messages, open work, and anything outstanding.`)}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm font-medium text-brand hover:bg-brand-soft"
            >
              <Sparkles className="size-4" /> Ask the Hub
            </Link>
            <Stat icon={<Package className="size-4" />} label="Orders" value={String(orderCount)} />
            <Stat icon={<DollarSign className="size-4" />} label="Lifetime" value={formatMoney(totalSpend)} />
          </div>
        </div>
        {client.parent && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-xs text-brand">
            <Users className="size-3.5 shrink-0" />
            <span>
              Assistant on{" "}
              <Link href={`/clients/${client.parent.id}`} className="font-semibold underline">{client.parent.name}</Link>
              ’s team{client.aryeoTeamName ? ` (${client.aryeoTeamName})` : ""} — their texts &amp; emails route to {client.parent.name}’s projects.
            </span>
          </div>
        )}
        {!client.parent && client.teamMembers.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            <Users className="size-3.5 shrink-0" />
            <span>Team{client.aryeoTeamName ? ` (${client.aryeoTeamName})` : ""}: {client.teamMembers.map((m) => m.name).join(", ")} — their comms fold into this account.</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* MAIN: orders + activity */}
        <div className="space-y-6">
          {/* Orders */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Package className="size-4 text-muted" /> Orders &amp; projects</h2>
            <div className="space-y-2">
              {client.projects.length === 0 && <p className="text-sm text-muted">No orders yet.</p>}
              <ShowMore initial={5}>
              {client.projects.map((p) => {
                const stage = stageMeta(p.status);
                return (
                  <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 rounded-xl border bg-surface p-3 hover:bg-surface-2">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: stage.soft, color: stage.color }}>
                      <Camera className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{p.title}</span>
                        <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
                      </div>
                      <div className="truncate text-xs text-muted">
                        {p.orderedAt ? etDateYear(p.orderedAt) : ""}
                        {p.shootDate ? ` · shoot ${etMonthDay(p.shootDate)}` : ""}
                        {` · ${p.deliverables.length} item${p.deliverables.length === 1 ? "" : "s"}`}
                        {p.price ? ` · ${formatMoney(p.price)}` : ""}
                        {p.paymentStatus ? ` · ${p.paymentStatus.toLowerCase().replace(/_/g, " ")}` : ""}
                      </div>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted" />
                  </Link>
                );
              })}
              </ShowMore>
            </div>
          </section>

          {/* Live OpenPhone conversation — full texting chat */}
          {client.phone && <ClientChat clientId={client.id} clientName={client.name} />}

          {/* Live Gmail conversation (read-only) for context */}
          {(client.email || client.backupEmail) && <ClientEmails clientId={client.id} />}

          {/* Activity timeline */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="size-4 text-muted" /> Recent activity</h2>
            <div className="rounded-2xl border bg-surface">
              {timeline.length === 0 && <p className="p-4 text-sm text-muted">No activity yet.</p>}
              <ShowMore initial={5} className="border-t border-border">
              {timeline.slice(0, 60).map((t) => (
                <div key={t.id} className="flex gap-3 border-b border-border px-4 py-3 last:border-0">
                  <span className="mt-1">
                    {t.kind === "feedback" ? <Star className="size-4 text-warning" /> : <ActivityIcon className="size-4 text-muted-2" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    {t.kind === "feedback" && (
                      <div className="mb-0.5 text-xs font-medium text-warning">
                        Feedback{t.rating ? ` · ${t.rating}/5` : ""}{t.sentiment ? ` · ${t.sentiment.toLowerCase()}` : ""}
                      </div>
                    )}
                    <p className="text-sm text-foreground/90">{stripHtml(t.body)}</p>
                    <div className="mt-0.5 text-[11px] text-muted-2">
                      {formatDistanceToNow(t.at, { addSuffix: true })}
                      {t.projectTitle && (
                        <> · <Link href={`/projects/${t.projectId}`} className="text-brand hover:underline">{t.projectTitle}</Link></>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              </ShowMore>
            </div>
          </section>
        </div>

        {/* SIDEBAR: agent profile + workspace + open to-dos */}
        <div className="space-y-6">
          <AgentProfile
            clientId={client.id}
            clientPreferences={client.clientPreferences ?? ""}
            brandColors={client.brandColors ?? ""}
            brandAssetsPath={client.brandAssetsPath}
            brandAssetsUrl={client.brandAssetsPath ? dropboxWebUrl(client.brandAssetsPath) : null}
          />

          <ClientWorkspace
            clientId={client.id}
            hasPhone={!!client.phone}
            email={client.email}
            lastInbound={lastInbound}
            editingPreferences={client.editingPreferences ?? ""}
            generalNotes={client.generalNotes ?? ""}
          />

          <ClientTodos
            todos={client.smartTasks.map((t) => ({
              id: t.id,
              title: t.title,
              taskType: t.taskType,
              dueAt: t.dueAt ? t.dueAt.toISOString() : null,
              projectId: t.projectId,
            }))}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-surface px-3 py-2 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-2">{icon}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
    </div>
  );
}
