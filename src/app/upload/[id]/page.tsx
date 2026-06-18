import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FolderOpen, Image as ImageIcon, Video } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { UploadPortal } from "@/components/upload/UploadPortal";
import { projectFolderPaths } from "@/lib/dropboxFolders";
import { ActivityType } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function UploadProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      client: true,
      photographer: true,
      deliverables: {
        orderBy: { createdAt: "asc" },
        include: { uploads: { orderBy: { createdAt: "asc" } } },
      },
      uploads: { where: { deliverableId: null }, orderBy: { createdAt: "asc" } },
      activities: {
        where: { type: { in: [ActivityType.SPECIAL_REQUEST, ActivityType.FLAG] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) notFound();

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        href="/upload"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All shoots
      </Link>

      <DropboxFolders project={project} />

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
          notes: d.notes,
          uploads: d.uploads.map((u) => ({
            id: u.id,
            originalName: u.originalName,
            size: u.size,
          })),
        }))}
        extraUploads={project.uploads.map((u) => ({
          id: u.id,
          originalName: u.originalName,
          size: u.size,
        }))}
        specialRequests={project.activities
          .filter((a) => a.type === ActivityType.SPECIAL_REQUEST)
          .map((a) => a.body)}
        flags={project.activities
          .filter((a) => a.type === ActivityType.FLAG)
          .map((a) => a.body)}
      />
    </div>
  );
}

function DropboxFolders({
  project,
}: {
  project: { title: string; addressLine: string | null; shootDate: Date | null; createdAt: Date; client: { name: string } };
}) {
  const f = projectFolderPaths(project);
  const rows = [
    { label: "Raw Photos", path: f.rawPhotos, icon: ImageIcon, raw: true },
    { label: "Raw Video", path: f.rawVideo, icon: Video, raw: true },
    { label: "Final Photos", path: f.finalPhotos, icon: ImageIcon, raw: false },
    { label: "Final Video", path: f.finalVideo, icon: Video, raw: false },
  ];
  return (
    <section className="mt-4 rounded-2xl border bg-surface p-4">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Dropbox folders for this shoot</h2>
      </div>
      <p className="mt-1 text-xs text-muted">
        Upload originals into the <strong>Raw</strong> folders. The hub watches these — once raw files land, the
        project moves to <em>Shot/Uploaded</em>; final files move it to <em>Review</em>.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2">
            <r.icon className={`size-4 ${r.raw ? "text-warning" : "text-success"}`} />
            <div className="min-w-0">
              <div className="text-xs font-medium">{r.label}</div>
              <div className="truncate font-mono text-[10px] text-muted-2">{r.path}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
