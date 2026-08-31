import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { CheckCircle2, Camera, ArrowRight, Upload, FolderOpen, Scissors } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, ink } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { CullingReminder } from "@/components/upload/CullingReminder";
import { getCurrentUser } from "@/lib/auth/user";
import { photographerMemberId } from "@/lib/shoot";
import { rawPhotoCounts } from "@/lib/dropboxFolders";
import { photoTargetFor, rawOverageCeiling } from "@/lib/culling";
import { stageMeta, DELIVERABLE_META } from "@/lib/pipeline";
import { DeliverableType } from "@prisma/client";
import { etDateTime, etDaysAgo } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// Day-buckets for the "come home, unload gear, upload" flow — newest first.
const BUCKETS = [
  { key: "today", label: "Today's jobs" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Past 7 days" },
  { key: "older", label: "Previous weeks" },
  { key: "upcoming", label: "Upcoming" },
  { key: "unscheduled", label: "Unscheduled" },
] as const;
type BucketKey = (typeof BUCKETS)[number]["key"];

function bucketFor(shootDate: Date | null): BucketKey {
  if (!shootDate) return "unscheduled";
  const days = etDaysAgo(shootDate); // +past / -future, in Eastern calendar days
  if (days < 0) return "upcoming";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  return "older";
}

export default async function UploadListPage() {
  await requirePageAccess("upload");
  // Photographers see ONLY their own shoots here (fail-closed: unresolvable →
  // none). Owner/admin/editor see all.
  const user = await getCurrentUser();
  // First visit under the new process: photographers read the standard and
  // agree once before the queue opens (Jordan, Sep 1).
  if (user?.role === "PHOTOGRAPHER" && user.email) {
    const ack = await prisma.appSetting.findUnique({ where: { key: `upload-ack-${user.email.toLowerCase()}` } });
    if (!ack) redirect("/upload/welcome");
  }
  const mine = user?.role === "PHOTOGRAPHER" ? ((await photographerMemberId(user)) ?? "__none__") : null;

  const shoots = await prisma.project.findMany({
    where: {
      status: { in: ["BOOKED", "SCHEDULED", "SHOT"] },
      ...(mine ? { OR: [{ photographerId: mine }, { appointments: { some: { assignedToId: mine } } }] } : {}),
    },
    orderBy: [{ shootDate: "desc" }, { createdAt: "desc" }],
    include: {
      client: true,
      photographer: true,
      deliverables: { select: { id: true, type: true } },
      _count: { select: { uploads: true } },
    },
  });

  // "Over budget" chip: only SHOT jobs have raws in the folder, so we only spend
  // Dropbox calls on those (one call each, in parallel). A shoot is over budget
  // when its raw pile exceeds its home's target × the overage factor.
  const overBudget = new Set<string>();
  const shotJobs = shoots.filter((s) => s.status === "SHOT");
  if (shotJobs.length > 0) {
    const counts = await rawPhotoCounts(shotJobs);
    if (counts) {
      for (const s of shotJobs) {
        const raw = counts.get(s) ?? 0;
        if (raw > rawOverageCeiling(photoTargetFor(s))) overBudget.add(s.id);
      }
    }
  }

  const grouped = new Map<BucketKey, typeof shoots>();
  for (const s of shoots) {
    const b = bucketFor(s.shootDate);
    const arr = grouped.get(b) ?? [];
    arr.push(s);
    grouped.set(b, arr);
  }
  // "Upcoming" oldest-first (next shoot first); everything else newest-first.
  const up = grouped.get("upcoming");
  if (up) up.sort((a, b) => (a.shootDate?.getTime() ?? 0) - (b.shootDate?.getTime() ?? 0));

  const pendingToday = (grouped.get("today") ?? []).filter((s) => !s.uploadedAt).length;

  return (
    <div>
      <PageHeader
        title="Upload Portal"
        subtitle="Unload gear, sit down, and clear today's uploads — newest shoots first"
      />
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <CullingReminder />

        {shoots.length === 0 && <p className="text-sm text-muted">No shoots ready for upload right now.</p>}

        {BUCKETS.map(({ key, label }) => {
          const items = grouped.get(key);
          if (!items || items.length === 0) return null;
          const pending = items.filter((s) => !s.uploadedAt).length;
          return (
            <section key={key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">{label}</h2>
                <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{items.length}</span>
                {pending > 0 && key !== "upcoming" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 text-xs font-medium text-brand">
                    <Upload className="size-3" /> {pending} to upload
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {items.map((s) => (
                  <JobRow key={s.id} s={s} overBudget={overBudget.has(s.id)} />
                ))}
              </div>
            </section>
          );
        })}

        {pendingToday === 0 && (grouped.get("today")?.length ?? 0) > 0 && (
          <p className="text-center text-sm text-success">All of today's jobs are uploaded. Nice work.</p>
        )}
      </div>
    </div>
  );
}

type Shoot = {
  debriefSubmittedAt: Date | null;
  id: string; title: string; status: string; shootDate: Date | null; uploadedAt: Date | null;
  client: { name: string }; photographer: { name: string; avatarColor: string } | null;
  deliverables: { type: DeliverableType }[]; _count: { uploads: number };
};

// Shoots from Sep 2 2026 on ride the payroll gate: pay shows in My Pay only
// once the upload page is SUBMITTED (debriefSubmittedAt — not the Dropbox
// auto-stamp). The row says so until they do.
const DEBRIEF_PAY_GATE_FROM = Date.parse("2026-09-02T00:00:00-04:00");

function JobRow({ s, overBudget }: { s: Shoot; overBudget: boolean }) {
  const stage = stageMeta(s.status as Parameters<typeof stageMeta>[0]);
  const uploaded = s.uploadedAt != null;
  const payrollPending =
    !s.debriefSubmittedAt &&
    s.shootDate != null &&
    s.shootDate.getTime() >= DEBRIEF_PAY_GATE_FROM &&
    s.shootDate.getTime() <= Date.now();
  // Distinct deliverable types = the checklist of what to capture/upload.
  const types = [...new Set(s.deliverables.map((d) => d.type))];
  return (
    <Link href={`/upload/${s.id}`} className="flex items-center gap-4 rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: stage.soft, color: ink(stage.color) }}>
        {uploaded ? <CheckCircle2 className="size-5" /> : <Camera className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{s.title}</span>
          {uploaded ? (
            <Badge color="#34d399" soft="rgba(52,211,153,0.14)">Uploaded</Badge>
          ) : (
            <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
          )}
          {/* Raw pile blew past this home's budget — cull before it goes to edit. */}
          {overBudget && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
              <Scissors className="size-3" /> Over budget
            </span>
          )}
          {payrollPending && (
            <span className="inline-flex items-center rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand">
              Submit to add to payroll
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {s.client.name}
          {s.shootDate ? ` · ${etDateTime(s.shootDate)}` : ""}
          {s._count.uploads > 0 ? ` · ${s._count.uploads} file${s._count.uploads === 1 ? "" : "s"}` : ""}
        </div>
        {types.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {types.map((t) => (
              <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">
                {DELIVERABLE_META[t]?.label ?? t}
              </span>
            ))}
          </div>
        )}
      </div>
      {s.photographer && <Avatar name={s.photographer.name} color={s.photographer.avatarColor} size={28} />}
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-brand">
        {uploaded ? "Review" : <><FolderOpen className="size-4" /> Upload</>} <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
