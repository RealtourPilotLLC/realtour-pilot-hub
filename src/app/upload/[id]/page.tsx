import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { photographerMemberId, photographerOwnsShoot } from "@/lib/shoot";
import {
  FolderOpen,
  Image as ImageIcon,
  Video,
  ExternalLink,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { prisma } from "@/lib/prisma";
import { UploadPortal } from "@/components/upload/UploadPortal";
import { AppointmentFeedback } from "@/components/upload/AppointmentFeedback";
import { getProjectFolderState } from "@/lib/dropboxFolders";
import { ActivityType } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function UploadProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // A photographer can only open the upload page for their OWN shoot.
  const viewer = await getCurrentUser();
  if (viewer?.role === "PHOTOGRAPHER") {
    const mine = await photographerMemberId(viewer);
    if (!mine || !(await photographerOwnsShoot(id, mine))) redirect("/upload");
  }

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      client: true,
      photographer: true,
      deliverables: { orderBy: { createdAt: "asc" } },
      activities: {
        where: { type: { in: [ActivityType.SPECIAL_REQUEST, ActivityType.FLAG] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) notFound();

  const folderState = await getProjectFolderState(project);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <BackLink href="/upload" label="All shoots" />

      <DropboxFolders state={folderState} />

      <UploadPortal
        project={{
          id: project.id,
          title: project.title,
          addressLine: project.addressLine,
          city: project.city,
          state: project.state,
          zip: project.zip,
          packageName: project.packageName,
          shootDate: project.shootDate?.toISOString() ?? null,
          status: project.status,
          editorBrief: project.editorBrief,
          uploadedAt: project.uploadedAt?.toISOString() ?? null,
          editorPdfPath: project.editorPdfPath,
          clientName: project.client.name,
          editingPreferences: project.client.editingPreferences,
          photographerName: project.photographer?.name ?? null,
        }}
        deliverables={project.deliverables.map((d) => ({
          id: d.id,
          type: d.type,
          quantity: d.quantity,
          status: d.status,
          uploadedAt: d.uploadedAt?.toISOString() ?? null,
        }))}
        specialRequests={project.activities
          .filter((a) => a.type === ActivityType.SPECIAL_REQUEST)
          .map((a) => a.body)}
        flags={project.activities
          .filter((a) => a.type === ActivityType.FLAG)
          .map((a) => a.body)}
      />

      <AppointmentFeedback projectId={project.id} />
    </div>
  );
}

// Tiny progress chip (declared at module scope, not inside render).
function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${done ? "text-success" : "text-muted-2"}`}>
      {done ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
      {label}
    </span>
  );
}

function DropboxFolders({
  state,
}: {
  state: Awaited<ReturnType<typeof getProjectFolderState>>;
}) {
  if (!state) return null;
  const iconFor = (label: string) => (/video/i.test(label) ? Video : ImageIcon);

  return (
    <section className="mt-4 rounded-2xl border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-brand" />
          <h2 className="text-sm font-semibold">Dropbox folders for this shoot</h2>
        </div>
        {/* Quick progress: raw uploaded → final delivered */}
        <div className="flex items-center gap-3 text-[11px] font-medium">
          <Step done={state.hasRaw} label="Raw uploaded" />
          <span className="text-muted-2">→</span>
          <Step done={state.hasFinal} label="Final delivered" />
        </div>
      </div>

      <p className="mt-1.5 text-xs text-muted">
        Drop originals into the <strong>Raw</strong> folders — the hub watches them and moves the project to{" "}
        <em>Shot</em> automatically. Final edits go in the <strong>Final</strong> folders.
        {!state.connected && " (Connect Dropbox to see live file counts.)"}
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {state.folders.map((r) => {
          const Icon = iconFor(r.label);
          return (
            <a
              key={r.key}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-lg border bg-surface-2 px-3 py-2 transition-colors hover:border-brand hover:bg-brand-soft/40"
            >
              <Icon className={`size-4 shrink-0 ${r.raw ? "text-warning" : "text-success"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {r.label}
                  {state.connected && (
                    <span
                      className={`rounded-full px-1.5 text-[10px] font-semibold ${
                        r.count > 0 ? "bg-success/15 text-success" : "bg-surface-2 text-muted-2"
                      }`}
                    >
                      {r.count > 0 ? `${r.count} file${r.count === 1 ? "" : "s"}` : "empty"}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-2">{r.path}</div>
              </div>
              <ExternalLink className="size-3.5 shrink-0 text-muted-2 group-hover:text-brand" />
            </a>
          );
        })}
      </div>
    </section>
  );
}
