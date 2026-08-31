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
import { cn } from "@/lib/utils";
import { UploadPortal } from "@/components/upload/UploadPortal";
import { AppointmentFeedback } from "@/components/upload/AppointmentFeedback";
import { getProjectFolderState } from "@/lib/dropboxFolders";
import { photoRangeFor, photoTargetFor, rawBudgetFor, rawOverageCeiling } from "@/lib/culling";
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
    // New-process acknowledgment first (one time), then ownership.
    if (viewer.email) {
      const ack = await prisma.appSetting.findUnique({ where: { key: `upload-ack-${viewer.email.toLowerCase()}` } });
      if (!ack) redirect(`/upload/welcome?next=${encodeURIComponent(`/upload/${id}`)}`);
    }
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
  // This home's photo budget (from sq ft or the owner override) — the standard
  // the cull confirmation on this page holds them to.
  const photoTarget = photoTargetFor(project);
  // Photo policy sections only render for jobs that ordered photos; the video
  // script + instructions only for jobs that ordered video (audit Aug 25).
  const photosOrdered = project.deliverables.some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
  const videoOrdered = project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");

  // Video jobs: pull the shoot script from Script Studio (freshness-gated,
  // never blocks the page on a dead Studio) so the photographer confirms the
  // words the agent actually read.
  let scriptBody = project.reelScript;
  let scriptHook = project.reelHook;
  let scriptUrl = project.reelScriptUrl;
  if (videoOrdered) {
    try {
      const { autoSyncScript } = await import("@/lib/scriptSync");
      const pulled = await autoSyncScript(project.id);
      if (pulled) {
        const fresh = await prisma.project.findUnique({
          where: { id: project.id },
          select: { reelScript: true, reelHook: true, reelScriptUrl: true },
        });
        scriptBody = fresh?.reelScript ?? scriptBody;
        scriptHook = fresh?.reelHook ?? scriptHook;
        scriptUrl = fresh?.reelScriptUrl ?? scriptUrl;
      }
    } catch { /* Studio down → the page still works with what's stored */ }
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4"><BackLink href="/upload" label="All shoots" /></div>

      <UploadPortal
        foldersSlot={<DropboxFolders state={folderState} photoTarget={photoTarget} />}
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
          cullingConfirmedAt: project.cullingConfirmedAt?.toISOString() ?? null,
          shotOrderNotes: project.shotOrderNotes,
          removalNotes: project.removalNotes,
          videoInstructions: project.videoInstructions,
          scriptConfirmedAt: project.scriptConfirmedAt?.toISOString() ?? null,
          scriptConfirmNote: project.scriptConfirmNote,
        }}
        policy={{
          photosOrdered,
          videoOrdered,
          photoTarget,
          range: photoRangeFor(project.squareFeet),
          squareFeet: project.squareFeet ?? null,
        }}
        script={scriptBody ? { body: scriptBody, hook: scriptHook, url: scriptUrl } : null}
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

      {/* How the shoot went — client issues, anything we should change on our
          end. Routes to Kyle + the feedback board when it wasn't smooth. */}
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
  photoTarget,
}: {
  state: Awaited<ReturnType<typeof getProjectFolderState>>;
  photoTarget: number;
}) {
  if (!state) return null;
  const iconFor = (label: string) => (/video/i.test(label) ? Video : ImageIcon);

  // Photographers see the folders THEY use: Raw Photos, Raw Video, Backup
  // Photos. The Final folders are the editors' side — removed per Jordan.
  const shown = state.folders.filter((f) => f.key !== "finalPhotos" && f.key !== "finalVideo");

  // Live raw-photo count vs this home's budget.
  const rawPhotoCount = state.folders.find((f) => f.key === "rawPhotos")?.count ?? 0;
  const rawBudget = rawBudgetFor(photoTarget);
  const overage = rawOverageCeiling(photoTarget);
  const budgetTone =
    rawPhotoCount > overage ? "danger" : rawPhotoCount > rawBudget ? "warning" : "muted";

  return (
    <div>
      {state.connected && rawPhotoCount > 0 && (
        <div
          className={cn(
            "mb-2.5 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium",
            budgetTone === "danger" && "bg-danger/10 text-danger",
            budgetTone === "warning" && "bg-warning/10 text-warning",
            budgetTone === "muted" && "bg-surface-2 text-muted",
          )}
        >
          <ImageIcon className="size-3.5" />
          Raw photos: {rawPhotoCount} / ~{rawBudget} budget
          {budgetTone === "danger" && " — over budget, cull before submitting"}
          {budgetTone === "warning" && " — approaching the budget"}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        {shown.map((r) => {
          const Icon = iconFor(r.label);
          const backup = r.key === "backupPhotos";
          return (
            <a
              key={r.key}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-xl border bg-surface-2 px-3 py-2.5 transition-colors hover:border-brand hover:bg-brand-soft/40"
            >
              <Icon className={cn("size-4 shrink-0", backup ? "text-muted" : "text-warning")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {r.label}
                  {state.connected && (
                    // count null = the Dropbox read FAILED — show "?", never
                    // "empty".
                    <span
                      className={`rounded-full px-1.5 text-[11px] font-semibold ${
                        (r.count ?? 0) > 0 ? "bg-success/15 text-success" : "bg-surface text-muted-2"
                      }`}
                    >
                      {r.count === null ? "?" : r.count > 0 ? `${r.count}` : "empty"}
                    </span>
                  )}
                </div>
                {backup && <div className="text-[11px] text-muted-2">culled extras live here</div>}
              </div>
              <ExternalLink className="size-3.5 shrink-0 text-muted-2 group-hover:text-brand" />
            </a>
          );
        })}
      </div>
      {!state.connected && <p className="mt-1.5 text-xs text-muted-2">Connect Dropbox to see live file counts.</p>}
    </div>
  );
}
