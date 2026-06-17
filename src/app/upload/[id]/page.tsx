import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { UploadPortal } from "@/components/upload/UploadPortal";
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
