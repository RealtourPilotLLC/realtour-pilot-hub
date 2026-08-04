import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import {
  MapPin,
  Package,
  FileText,
  Star,
  Flag,
  StickyNote,
  RefreshCw,
  Calendar,
  CalendarClock,
  Clock,
  Mail,
  Phone,
  Building2,
  Sparkles,
  CreditCard,
  ExternalLink,
  ListTodo,
  ListChecks,
  History,
  User,
  Users,
} from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { Suspense } from "react";
import { ListingMedia, ListingMediaSkeleton } from "@/components/project/ListingMedia";
import { StatusEvidenceCard } from "@/components/project/StatusEvidenceCard";
import { TaskCard } from "@/components/queue/TaskCard";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { getProject, getTeam } from "@/lib/queries";
import { AssignmentPanel } from "@/components/project/AssignmentPanel";
import { AppointmentManager } from "@/components/project/AppointmentManager";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, ink } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { CopyButton } from "@/components/ui/CopyButton";
import { taskToView } from "@/lib/taskView";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { VendorBadge } from "@/components/editing/VendorBadge";
import { StageSelector } from "@/components/project/StageSelector";
import { RefreshFromAryeo } from "@/components/projects/RefreshFromAryeo";
import { Checklist } from "@/components/project/Checklist";
import { ActivityComposer } from "@/components/project/ActivityComposer";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ProjectMap } from "@/components/map/ProjectMap";
import { DroneBadge, hasDroneOps } from "@/components/project/DroneBadge";
import { DroneAdvisory } from "@/components/project/DroneAdvisory";
import { DeliverableStatusSelect } from "@/components/project/DeliverableStatusSelect";
import { FrameioButton } from "@/components/project/FrameioButton";
import { PRIORITY_META, DELIVERABLE_META, refinedDeliverableLabel, stageMeta } from "@/lib/pipeline";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { photoTargetFor } from "@/lib/culling";
import { PhotoTargetControl } from "@/components/project/PhotoTargetControl";
import { formatMoney, stripHtml } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { etDateTime, etDateYear } from "@/lib/datetime";
import { listAssignees } from "@/lib/assignees";
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

  // Only owner/admin see the full order detail (pricing, invoices, client
  // financials). /projects isn't a top-level nav key, so the middleware doesn't
  // gate it — guard here. Photographers get the guided field view of their shoot;
  // editors (and any other non-admin role) are bounced home.
  const viewer = await getCurrentUser();
  if (viewer && viewer.role !== "OWNER" && viewer.role !== "ADMIN") {
    redirect(viewer.role === "PHOTOGRAPHER" ? `/shoot/${id}` : "/");
  }

  const [project, team, assigneeList] = await Promise.all([getProject(id), getTeam(), listAssignees()]);
  if (!project) notFound();
  const assignees = assigneeList.map((a) => ({ key: a.key, name: a.name }));

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

  const hasBilling =
    !!project.paymentStatus ||
    project.balanceAmount != null ||
    !!project.invoiceUrl ||
    !!project.paymentUrl;

  // Deep links to this project's Dropbox upload folders (AutoHDR convention).
  const folders = projectFolderPaths({
    title: project.title,
    addressLine: project.addressLine,
    shootDate: project.shootDate,
    createdAt: project.createdAt,
    client: { name: project.client.name },
  });
  const dropboxLinks = [
    { label: "Raw Photos", url: dropboxWebUrl(folders.rawPhotos) },
    { label: "Raw Video", url: dropboxWebUrl(folders.rawVideo) },
    { label: "Final Photos", url: dropboxWebUrl(folders.finalPhotos) },
    { label: "Final Video", url: dropboxWebUrl(folders.finalVideo) },
  ];

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <BackLink href="/pipeline" label="Back to tracker" />

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
            <Badge color={priority.color} soft={priority.soft}>
              {priority.label}
            </Badge>
            {hasDroneOps(project.deliverables) && <DroneBadge />}
          </div>
          {addressParts.length > 0 && (
            <div className="mt-1 flex items-center gap-1.5 text-sm text-muted">
              <MapPin className="size-3.5 shrink-0" /> {addressParts.join(", ")}
              <CopyButton value={addressParts.join(", ")} title="Copy address" className="shrink-0" />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          {(project.aryeoOrderId || project.aryeoListingId) && <RefreshFromAryeo projectId={project.id} />}
          {project.aryeoOrderId && (
            <a
              href={`https://app.aryeo.com/orders/${project.aryeoOrderId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              Open in Aryeo <ExternalLink className="size-3.5" />
            </a>
          )}
          <StageSelector projectId={project.id} status={project.status} />
        </div>
      </div>

      {/* Client — who the project is for, surfaced at the top (was buried in the
          side rail, and fell to the very bottom on mobile). */}
      <Section icon={User} title="Client" className="mt-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Avatar name={project.client.name} size={44} color="#4f46e5" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={`/clients/${project.client.id}`} className="text-base font-semibold hover:underline">
                  {project.client.name}
                </Link>
                <SegmentBadge segment={project.client.segment} size="xs" />
                <SocialBadge socialClient={project.client.socialClient} socialPlan={project.client.socialPlan} size="xs" />
              </div>
              {project.client.company && (
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                  <Building2 className="size-3" /> {project.client.company}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:justify-end">
            {project.client.email && (
              <a href={`mailto:${project.client.email}`} className="flex items-center gap-1.5 text-muted hover:text-foreground">
                <Mail className="size-3.5 shrink-0" /> <span className="truncate">{project.client.email}</span>
              </a>
            )}
            {project.client.phone && (
              <a href={`tel:${project.client.phone}`} className="flex items-center gap-1.5 text-muted hover:text-foreground">
                <Phone className="size-3.5 shrink-0" /> {project.client.phone}
              </a>
            )}
          </div>
        </div>
        {(project.client.editingPreferences || project.client.generalNotes) && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {project.client.editingPreferences && (
              <div className="rounded-lg bg-brand-soft px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
                  <Sparkles className="size-3" /> Editing preferences
                </div>
                <p className="text-xs text-foreground/80">{project.client.editingPreferences}</p>
              </div>
            )}
            {project.client.generalNotes && (
              <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                {stripHtml(project.client.generalNotes)}
              </div>
            )}
          </div>
        )}
      </Section>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main column — the work, in workflow order:
            status → tasks → order → logistics → output → money → collaboration */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* Smart status cross-check */}
          <StatusEvidenceCard
            status={project.status}
            evidence={project.statusEvidence}
            checkedAt={project.statusCheckedAt}
            projectId={project.id}
            revisionNote={project.revisionNote}
            revisionRequestedAt={project.revisionRequestedAt}
            dropboxLinks={dropboxLinks}
            dropboxRootUrl={dropboxWebUrl(folders.listing)}
          />

          {/* Open tasks for this job */}
          {project.smartTasks.length > 0 && (
            <Section icon={ListTodo} title="Open tasks" count={project.smartTasks.length} flush>
              <div className="grid gap-3 p-5 sm:grid-cols-2">
                {project.smartTasks.map((t) => (
                  <TaskCard key={t.id} task={taskToView(t)} assignees={assignees} />
                ))}
              </div>
            </Section>
          )}

          {/* The locked reel script from Script Studio — visible to the whole
              crew here (the photographer also gets it on their shoot screen). */}
          <ReelScriptCard
            hook={project.reelHook}
            script={project.reelScript}
            song={project.reelSong}
            shotList={project.reelShotList}
            updatedAt={project.reelRecipeUpdatedAt ? project.reelRecipeUpdatedAt.toISOString() : null}
            studioUrl={project.scriptingUrl ?? project.reelScriptUrl}
          />

          {/* Ordered deliverables */}
          <Section icon={Package} title="Ordered deliverables" count={project.deliverables.length || null} flush>
            <div className="divide-y">
              {project.deliverables.length === 0 && (
                <p className="px-5 py-4 text-sm text-muted">Nothing ordered yet.</p>
              )}
              {project.deliverables.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                      <Package className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {refinedDeliverableLabel(d.type, d.label)}
                        {d.quantity > 1 && (
                          <span className="text-muted"> ×{d.quantity}</span>
                        )}
                        <VendorBadge type={d.type} label={d.label} />
                      </div>
                      {d.notes && <div className="text-xs text-muted">{d.notes}</div>}
                    </div>
                  </div>
                  <DeliverableStatusSelect id={d.id} status={d.status} />
                </div>
              ))}
            </div>
          </Section>

          {/* Appointments (from Aryeo) */}
          {project.appointments.length > 0 && (
            <Section
              icon={Calendar}
              title={`Appointment${project.appointments.length > 1 ? "s" : ""}`}
              count={project.appointments.length > 1 ? project.appointments.length : null}
              flush
            >
              <div className="divide-y">
                {project.appointments.map((a) => (
                  <AppointmentManager
                    key={a.id}
                    appt={{
                      id: a.id,
                      startAt: a.startAt,
                      endAt: a.endAt,
                      durationMin: a.durationMin,
                      status: a.status,
                      title: a.title,
                      description: a.description,
                      preferenceType: a.preferenceType,
                      requiresConfirmation: a.requiresConfirmation,
                      canCancel: a.canCancel,
                      canReschedule: a.canReschedule,
                      rescheduledAt: a.rescheduledAt,
                      postponedAt: a.postponedAt,
                      previousStartAt: a.previousStartAt,
                      assignedTo: a.assignedTo
                        ? { name: a.assignedTo.name, avatarColor: a.assignedTo.avatarColor }
                        : null,
                    }}
                  />
                ))}
              </div>
            </Section>
          )}

          {/* Location map — pin, weather for the shoot time, drive times */}
          {project.lat != null && project.lng != null && (
            <Section icon={MapPin} title="Location" bodyClassName="p-4">
              <ProjectMap
                pins={[{
                  id: project.id,
                  projectId: project.id,
                  title: project.title,
                  lat: project.lat,
                  lng: project.lng,
                  color: stageMeta(project.status).color,
                  stage: stageMeta(project.status).short,
                  client: project.client.name,
                  shootISO: (project.appointments[0]?.startAt ?? project.shootDate)?.toISOString() ?? null,
                  endISO: project.appointments[0]?.endAt?.toISOString() ?? null,
                  photographer: project.photographer?.name ?? null,
                }]}
              />
            </Section>
          )}

          {/* Drone operations — FAA airspace check + advisory to the creative */}
          {hasDroneOps(project.deliverables) && <DroneAdvisory projectId={project.id} />}

          {/* Delivered media pulled live from Aryeo */}
          {project.aryeoListingId && (
            <Suspense fallback={<ListingMediaSkeleton />}>
              <ListingMedia listingId={project.aryeoListingId} title={project.title} projectId={project.id} />
            </Suspense>
          )}

          {/* Uploads & editor brief */}
          {(project.uploads.length > 0 || project.editorPdfPath || project.editorBrief) && (
            <Section
              icon={FileText}
              title="Uploads & editor brief"
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <FrameioButton projectId={project.id} viewUrl={project.frameioViewUrl} />
                  {project.editorPdfPath && (
                    <a
                      href={`/api/projects/${project.id}/editor-brief`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand hover:opacity-90"
                    >
                      <FileText className="size-3.5" /> Editor brief PDF
                    </a>
                  )}
                </div>
              }
              bodyClassName="space-y-3"
            >
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
                      <Package className="size-3.5 shrink-0 text-muted" />
                      <a
                        href={`/api/file?path=${encodeURIComponent(u.storedPath)}&download=1`}
                        className="flex-1 truncate hover:underline"
                      >
                        {u.originalName}
                      </a>
                      {u.deliverable && (
                        <span className="shrink-0 text-muted-2">
                          {DELIVERABLE_META[u.deliverable.type].label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {/* Billing (from Aryeo) — payment status + balance + links (order total lives in Order & schedule) */}
          {hasBilling && (
            <Section
              icon={CreditCard}
              title="Billing"
              action={
                project.paymentStatus ? (
                  project.paymentStatus === "PAID" ? (
                    <Badge color="#16a34a" soft="#dcfce7">Paid</Badge>
                  ) : (
                    <Badge color="#d97706" soft="#fef3c7">
                      {project.paymentStatus.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                  )
                ) : null
              }
            >
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
                {project.balanceAmount != null && (
                  <div>
                    <div className="text-xs text-muted">Balance due</div>
                    <div className={project.balanceAmount > 0 ? "font-semibold text-warning" : "font-semibold text-success"}>
                      {formatMoney(project.balanceAmount / 100)}
                    </div>
                  </div>
                )}
                <div className="ml-auto flex gap-2">
                  {project.invoiceUrl && (
                    <a href={project.invoiceUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
                      <FileText className="size-3.5" /> Invoice
                    </a>
                  )}
                  {project.paymentUrl && project.balanceAmount != null && project.balanceAmount > 0 && (
                    <a href={project.paymentUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90">
                      <ExternalLink className="size-3.5" /> Payment link
                    </a>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* Team messages — editor/crew coordination on this job */}
          <ProjectMessages
            projectId={project.id}
            team={team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
            messages={project.messages.map((m) => ({
              id: m.id,
              authorId: m.authorId,
              authorName: m.authorName,
              body: m.body,
              createdAt: m.createdAt.toISOString(),
              ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
              replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: m.replyTo.body } : null,
            }))}
          />

          {/* Checklist */}
          <Section icon={ListChecks} title="Checklist">
            <Checklist items={project.checklist} />
          </Section>

          {/* Activity */}
          <Section icon={History} title="Activity & notes" bodyClassName="space-y-4">
            <ActivityComposer projectId={project.id} />
            <ol className="space-y-3">
              {project.activities.map((a) => {
                const meta = ACTIVITY_ICON[a.type] ?? ACTIVITY_ICON.NOTE;
                const Icon = meta.icon;
                return (
                  <li key={a.id} className="flex gap-3">
                    <span
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${meta.color}1a`, color: ink(meta.color) }}
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
          </Section>
        </div>

        {/* Side column — reference: who, when, how much, who's on it */}
        <div className="space-y-6">
          {/* Special requests highlight */}
          {specialRequests.length > 0 && (
            <Section icon={Star} title="Special requests" tone="warning" bodyClassName="py-3">
              <ul className="space-y-2">
                {specialRequests.map((r) => (
                  <li key={r.id} className="text-sm text-foreground/90">
                    {r.body}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Schedule & order */}
          <Section icon={CalendarClock} title="Order & schedule">
            <dl className="space-y-2.5 text-sm">
              {project.packageName && (
                <Row label="Package" value={project.packageName} />
              )}
              {project.price != null && (
                <Row label="Order total" value={formatMoney(project.price)} />
              )}
              {project.squareFeet && (
                <Row label="Size" value={`${project.squareFeet.toLocaleString()} sq ft`} />
              )}
              {/* Owner/admin photo-culling budget (the whole page is admin-gated). */}
              <div className="pt-1">
                <PhotoTargetControl
                  projectId={project.id}
                  photoTarget={project.photoTarget}
                  computed={photoTargetFor({ squareFeet: project.squareFeet, photoTarget: null })}
                  squareFeet={project.squareFeet}
                />
              </div>
              <Row
                label="Shoot"
                value={
                  project.shootDate ? (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="size-3.5 text-muted" />
                      {etDateTime(project.shootDate)}
                    </span>
                  ) : (
                    "Not scheduled"
                  )
                }
              />
              <Row
                label="Delivery due"
                value={
                  project.deliveryDue ? etDateYear(project.deliveryDue) : "—"
                }
              />
              {project.deliveredAt && (
                <Row label="Delivered" value={etDateYear(project.deliveredAt)} />
              )}
            </dl>
          </Section>

          {/* Team — editable assignments */}
          <Section icon={Users} title="Team" flush>
            <AssignmentPanel
              projectId={project.id}
              team={team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
              current={{
                photographer: project.photographerId,
                editor: project.editorId,
                va: project.vaId,
              }}
            />
          </Section>
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
