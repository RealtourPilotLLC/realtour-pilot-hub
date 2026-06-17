import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  MapPin,
  Package,
  FileText,
  Star,
  Flag,
  StickyNote,
  RefreshCw,
  Calendar,
  Clock,
  Mail,
  Phone,
  Building2,
  Sparkles,
} from "lucide-react";
import { getProject } from "@/lib/queries";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { StageSelector } from "@/components/project/StageSelector";
import { Checklist } from "@/components/project/Checklist";
import { ActivityComposer } from "@/components/project/ActivityComposer";
import { DeliverableStatusSelect } from "@/components/project/DeliverableStatusSelect";
import { PRIORITY_META, DELIVERABLE_META } from "@/lib/pipeline";
import { formatMoney } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import { ActivityType } from "@prisma/client";

export const dynamic = "force-dynamic";

const ACTIVITY_ICON: Record<string, { icon: typeof Star; color: string }> = {
  SPECIAL_REQUEST: { icon: Star, color: "#d97706" },
  FLAG: { icon: Flag, color: "#dc2626" },
  STATUS_CHANGE: { icon: RefreshCw, color: "#0ea5e9" },
  ASSIGNMENT: { icon: RefreshCw, color: "#8b5cf6" },
  NOTE: { icon: StickyNote, color: "#64748b" },
  SYSTEM: { icon: Sparkles, color: "#64748b" },
  REMINDER: { icon: Clock, color: "#d97706" },
  FILE: { icon: Package, color: "#64748b" },
};

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const priority = PRIORITY_META[project.priority];
  const specialRequests = project.activities.filter(
    (a) => a.type === ActivityType.SPECIAL_REQUEST,
  );

  const addressParts = [
    project.addressLine,
    project.city,
    project.state,
    project.zip,
  ].filter(Boolean);

  const assignments = [
    { label: "Photographer", member: project.photographer },
    { label: "Editor", member: project.editor },
    { label: "VA", member: project.va },
  ];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Link
        href="/pipeline"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to pipeline
      </Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
            <Badge color={priority.color} soft={priority.soft}>
              {priority.label}
            </Badge>
          </div>
          {addressParts.length > 0 && (
            <div className="mt-1 flex items-center gap-1.5 text-sm text-muted">
              <MapPin className="size-3.5" /> {addressParts.join(", ")}
            </div>
          )}
        </div>
        <StageSelector projectId={project.id} status={project.status} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          {/* Deliverables */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Ordered deliverables</h2>
            </div>
            <div className="divide-y">
              {project.deliverables.length === 0 && (
                <p className="px-5 py-4 text-sm text-muted">Nothing ordered yet.</p>
              )}
              {project.deliverables.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted">
                      <Package className="size-4" />
                    </span>
                    <div>
                      <div className="text-sm font-medium">
                        {DELIVERABLE_META[d.type].label}
                        {d.quantity > 1 && (
                          <span className="text-muted"> ×{d.quantity}</span>
                        )}
                      </div>
                      {d.notes && <div className="text-xs text-muted">{d.notes}</div>}
                    </div>
                  </div>
                  <DeliverableStatusSelect id={d.id} status={d.status} />
                </div>
              ))}
            </div>
          </section>

          {/* Uploads & editor brief */}
          {(project.uploads.length > 0 || project.editorPdfPath || project.editorBrief) && (
            <section className="rounded-2xl border bg-surface">
              <div className="flex items-center justify-between border-b px-5 py-3.5">
                <h2 className="text-sm font-semibold">Uploads &amp; editor brief</h2>
                {project.editorPdfPath && (
                  <a
                    href={`/api/file?path=${encodeURIComponent(project.editorPdfPath)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand hover:opacity-90"
                  >
                    <FileText className="size-3.5" /> Editor brief PDF
                  </a>
                )}
              </div>
              <div className="space-y-3 px-5 py-4">
                {project.editorBrief && (
                  <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-foreground/85">
                    {project.editorBrief}
                  </div>
                )}
                {project.uploads.length === 0 ? (
                  <p className="text-sm text-muted">No files uploaded yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {project.uploads.map((u) => (
                      <li
                        key={u.id}
                        className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
                      >
                        <Package className="size-3.5 text-muted" />
                        <a
                          href={`/api/file?path=${encodeURIComponent(u.storedPath)}&download=1`}
                          className="flex-1 truncate hover:underline"
                        >
                          {u.originalName}
                        </a>
                        {u.deliverable && (
                          <span className="text-muted-2">
                            {DELIVERABLE_META[u.deliverable.type].label}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* Checklist */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Checklist</h2>
            </div>
            <div className="px-5 py-4">
              <Checklist items={project.checklist} />
            </div>
          </section>

          {/* Activity */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Activity &amp; notes</h2>
            </div>
            <div className="space-y-4 px-5 py-4">
              <ActivityComposer projectId={project.id} />
              <ol className="space-y-3">
                {project.activities.map((a) => {
                  const meta = ACTIVITY_ICON[a.type] ?? ACTIVITY_ICON.NOTE;
                  const Icon = meta.icon;
                  return (
                    <li key={a.id} className="flex gap-3">
                      <span
                        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                        style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground/90">{a.body}</div>
                        <div className="mt-0.5 text-xs text-muted">
                          {a.author?.name ?? "System"} ·{" "}
                          {formatDistanceToNow(a.createdAt, { addSuffix: true })}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        </div>

        {/* Side column */}
        <div className="space-y-6">
          {/* Special requests highlight */}
          {specialRequests.length > 0 && (
            <section className="rounded-2xl border border-warning/30 bg-warning-soft/40">
              <div className="flex items-center gap-2 border-b border-warning/20 px-5 py-3">
                <Star className="size-4 text-warning" />
                <h2 className="text-sm font-semibold text-warning">Special requests</h2>
              </div>
              <ul className="space-y-2 px-5 py-3">
                {specialRequests.map((r) => (
                  <li key={r.id} className="text-sm text-foreground/90">
                    {r.body}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Client */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Client</h2>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="flex items-center gap-3">
                <Avatar name={project.client.name} size={36} color="#4f46e5" />
                <div>
                  <Link
                    href={`/clients`}
                    className="text-sm font-semibold hover:underline"
                  >
                    {project.client.name}
                  </Link>
                  {project.client.company && (
                    <div className="flex items-center gap-1 text-xs text-muted">
                      <Building2 className="size-3" /> {project.client.company}
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-1.5 text-sm">
                {project.client.email && (
                  <div className="flex items-center gap-2 text-muted">
                    <Mail className="size-3.5" /> {project.client.email}
                  </div>
                )}
                {project.client.phone && (
                  <div className="flex items-center gap-2 text-muted">
                    <Phone className="size-3.5" /> {project.client.phone}
                  </div>
                )}
              </div>
              {project.client.editingPreferences && (
                <div className="rounded-lg bg-brand-soft px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
                    <Sparkles className="size-3" /> Editing preferences
                  </div>
                  <p className="text-xs text-foreground/80">
                    {project.client.editingPreferences}
                  </p>
                </div>
              )}
              {project.client.generalNotes && (
                <p className="text-xs text-muted">{project.client.generalNotes}</p>
              )}
            </div>
          </section>

          {/* Schedule & order */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Order &amp; schedule</h2>
            </div>
            <dl className="space-y-2.5 px-5 py-4 text-sm">
              {project.packageName && (
                <Row label="Package" value={project.packageName} />
              )}
              {project.price != null && (
                <Row label="Order total" value={formatMoney(project.price)} />
              )}
              {project.squareFeet && (
                <Row label="Size" value={`${project.squareFeet.toLocaleString()} sq ft`} />
              )}
              <Row
                label="Shoot"
                value={
                  project.shootDate ? (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="size-3.5 text-muted" />
                      {format(project.shootDate, "MMM d, h:mm a")}
                    </span>
                  ) : (
                    "Not scheduled"
                  )
                }
              />
              <Row
                label="Delivery due"
                value={
                  project.deliveryDue
                    ? format(project.deliveryDue, "MMM d, yyyy")
                    : "—"
                }
              />
              {project.deliveredAt && (
                <Row label="Delivered" value={format(project.deliveredAt, "MMM d, yyyy")} />
              )}
            </dl>
          </section>

          {/* Team */}
          <section className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Team</h2>
            </div>
            <div className="space-y-3 px-5 py-4">
              {assignments.map(({ label, member }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-2">
                    {label}
                  </span>
                  {member ? (
                    <span className="flex items-center gap-2">
                      <Avatar name={member.name} color={member.avatarColor} size={22} />
                      <span className="text-sm">{member.name}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-muted-2">Unassigned</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
