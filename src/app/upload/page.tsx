import Link from "next/link";
import { CheckCircle2, Camera, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { stageMeta } from "@/lib/pipeline";
import { format } from "date-fns";

export const dynamic = "force-dynamic";

export default async function UploadListPage() {
  const shoots = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT"] } },
    orderBy: [{ shootDate: "asc" }, { createdAt: "desc" }],
    include: {
      client: true,
      photographer: true,
      deliverables: true,
      _count: { select: { uploads: true } },
    },
  });

  return (
    <div>
      <PageHeader
        title="Upload Portal"
        subtitle="Pick a shoot to upload content and leave notes for the editors"
      />
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        {shoots.length === 0 && (
          <p className="text-sm text-muted">No shoots ready for upload right now.</p>
        )}
        {shoots.map((s) => {
          const stage = stageMeta(s.status);
          const uploaded = s.uploadedAt != null;
          return (
            <Link
              key={s.id}
              href={`/upload/${s.id}`}
              className="flex items-center gap-4 rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md"
            >
              <span
                className="flex size-11 items-center justify-center rounded-xl"
                style={{ backgroundColor: stage.soft, color: stage.color }}
              >
                {uploaded ? <CheckCircle2 className="size-5" /> : <Camera className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{s.title}</span>
                  <Badge color={stage.color} soft={stage.soft}>
                    {stage.short}
                  </Badge>
                  {uploaded && (
                    <Badge color="#16a34a" soft="#dcfce7">
                      Uploaded
                    </Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted">
                  {s.client.name}
                  {s.shootDate ? ` · ${format(s.shootDate, "EEE MMM d, h:mm a")}` : ""}
                  {` · ${s.deliverables.length} item${s.deliverables.length === 1 ? "" : "s"} ordered`}
                  {s._count.uploads > 0 ? ` · ${s._count.uploads} file${s._count.uploads === 1 ? "" : "s"}` : ""}
                </div>
              </div>
              {s.photographer && (
                <Avatar name={s.photographer.name} color={s.photographer.avatarColor} size={28} />
              )}
              <span className="flex items-center gap-1 text-sm font-medium text-brand">
                {uploaded ? "Review" : "Upload"} <ArrowRight className="size-4" />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
