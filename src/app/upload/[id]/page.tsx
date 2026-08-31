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
import { BRACKET_RATIO, photoTargetFor, rawBudgetFor, rawOverageCeiling } from "@/lib/culling";
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
    <div className="mx-auto max-w-3xl p-6">
      <BackLink href="/upload" label="All shoots" />

      <DropboxFolders state={folderState} photoTarget={photoTarget} />

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
          cullingConfirmedAt: project.cullingConfirmedAt?.toISOString() ?? null,
          removalNotes: project.removalNotes,
          videoInstructions: project.videoInstructions,
          scriptConfirmedAt: project.scriptConfirmedAt?.toISOString() ?? null,
          scriptConfirmNote: project.scriptConfirmNote,
        }}
        policy={{
          photosOrdered,
          videoOrdered,
          photoTarget,
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

  // Live raw-photo count vs this home's budget. Amber past the bracket budget
  // (target × BRACKET_RATIO), red past the overage ceiling (× RAW_OVERAGE_FACTOR
  // → over-shot even accounting for the 5-bracket JPG sets).
  const rawPhotoCount = state.folders.find((f) => f.key === "rawPhotos")?.count ?? 0;
  const rawBudget = rawBudgetFor(photoTarget);
  const overage = rawOverageCeiling(photoTarget);
  const budgetTone =
    rawPhotoCount > overage ? "danger" : rawPhotoCount > rawBudget ? "warning" : "muted";

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

      {/* Raw count vs budget — only meaningful once Dropbox is connected AND raws
          have started landing. Turns amber/red as the pile blows past budget. */}
      {state.connected && rawPhotoCount > 0 && (
        <div
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium",
            budgetTone === "danger" && "bg-danger/10 text-danger",
            budgetTone === "warning" && "bg-warning/10 text-warning",
            budgetTone === "muted" && "bg-surface-2 text-muted",
          )}
        >
          <ImageIcon className="size-3.5" />
          Raw photos: {rawPhotoCount} / ~{rawBudget} budget
          {budgetTone === "danger" && " — over budget, cull before delivering"}
          {budgetTone === "warning" && " — approaching the budget"}
        </div>
      )}

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
                    // count null = the Dropbox read FAILED — show "couldn't
                    // check", never "empty" (a photographer verifying their
                    // 300-raw drop must not be told the folder is empty).
                    <span
                      className={`rounded-full px-1.5 text-[10px] font-semibold ${
                        (r.count ?? 0) > 0 ? "bg-success/15 text-success" : "bg-surface-2 text-muted-2"
                      }`}
                    >
                      {r.count === null
                        ? "couldn't check"
                        : r.count > 0
                        ? `${r.count} file${r.count === 1 ? "" : "s"}`
                        : "empty"}
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
