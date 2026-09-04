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
import { isVideoStyleKey, type VideoStyleKey } from "@/lib/videoStyles";
import { AppointmentFeedback } from "@/components/upload/AppointmentFeedback";
import { AddedAtShoot } from "./AddedAtShoot";
import { itemFromTaskTitle, shootAddonKeyPrefix, streetOf, type ShootAddOn } from "@/app/upload/shootAddOns";
import { getProjectFolderState } from "@/lib/dropboxFolders";
import { photoPolicyFor, rawBudgetFor, rawOverageCeiling } from "@/lib/culling";
import { ActivityType } from "@prisma/client";
import { isFieldFlag } from "@/lib/debrief";
import { videoStepSpec, isMonthlyContentJob, type VideoStepSpec } from "@/lib/pipeline";
import { creativeCustomerNote } from "@/lib/clientNotes";
import { videoTier } from "@/lib/projectStatus";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// WHICH video this job is (shared contract, Sep 2 2026). The Aryeo sync stamps
// Deliverable.videoStyle from Product.videoStyle at order time, so the brief's
// shape follows the PRODUCT the client bought — "Photography and Standard Reel
// w/ Agent intro" used to reach here as a "Social Reel" label, and the intro
// script was only demanded when a name regex happened to match. The stamp is
// authoritative; a job with no stamped live row (orders synced before the
// column existed, products nobody has mapped) falls back to exactly the Sep 2
// name + tier logic, so nothing regresses.
// ---------------------------------------------------------------------------
// The most demanding brief wins when a job carries several video lines (a reel
// + a cinematic, a bundle + an intro add-on) — the precedence videoStepSpec
// already uses: monthly, then premium, then agent intro, then standard.
const STYLE_RANK: Record<VideoStyleKey, number> = {
  personal_branding: 0,
  premium_cinematic: 1,
  premium_social_reel: 2,
  standard_reel_agent_intro: 3,
  standard_cinematic: 4,
  standard_reel: 5,
};
/** What the video step demands for a resolved style — the same VideoStepSpec
 *  videoStepSpec() builds from names, so the portal (and the server gate in
 *  upload/actions.ts once it reads the stamp) keep consuming one type. Per
 *  Jordan: standard reels don't get scripts; agent-intro reels get the intro
 *  script + notes; premium can't be submitted without the script; monthly
 *  plans need every field plus the videos-filmed count. */
function specForStyle(style: VideoStyleKey): VideoStepSpec {
  const base = { requireScript: false, requireIntro: false, requireVideoCount: false, fullBrief: false, minimalReel: false, fixedStyle: false };
  switch (style) {
    case "personal_branding":
      return { ...base, mode: "standard", requireVideoCount: true, fullBrief: true, fixedStyle: true };
    case "premium_social_reel":
    case "premium_cinematic":
      return { ...base, mode: "premium-script", requireScript: true, fullBrief: true };
    case "standard_reel_agent_intro":
      return { ...base, mode: "agent-intro", requireIntro: true };
    case "standard_cinematic":
      // One box like a reel, but a full horizontal cut always needs direction
      // — only a plain reel earns "nothing demanded" (videoStepSpec's rule).
      return { ...base, mode: "standard", fullBrief: true };
    case "standard_reel":
      return { ...base, mode: "standard", minimalReel: true };
  }
}

/** The Sep 2 tier answer as a style key — for jobs nothing has stamped yet. */
function styleFromTier(spec: VideoStepSpec, hasFullVideo: boolean): VideoStyleKey {
  if (spec.fixedStyle) return "personal_branding";
  if (spec.mode === "premium-script") return hasFullVideo ? "premium_cinematic" : "premium_social_reel";
  if (spec.mode === "agent-intro") return "standard_reel_agent_intro";
  return hasFullVideo ? "standard_cinematic" : "standard_reel";
}

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
      // Owed rows only — an item removed from the Aryeo order must not show up
      // as a capture/upload step or gate the wrap-up.
      deliverables: { where: { removedFromOrderAt: null }, orderBy: { createdAt: "asc" } },
      // Canceled lines must NOT drive the video step: a downgraded order
      // would keep demanding the old package's script (review HIGH).
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      activities: {
        where: { type: { in: [ActivityType.SPECIAL_REQUEST, ActivityType.FLAG] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) notFound();

  const folderState = await getProjectFolderState(project);

  // Items the agent added on site, already logged from this portal. Read back
  // off the tasks themselves (their dedupeKey is prefixed per project) so the
  // photographer sees what they've already reported instead of re-adding it,
  // and CANCELLED rows stay hidden — those were withdrawn here.
  const addOnTasks = await prisma.smartTask.findMany({
    where: { projectId: project.id, dedupeKey: { startsWith: shootAddonKeyPrefix(project.id) }, status: { not: "CANCELLED" } },
    select: { id: true, title: true, description: true, contactName: true, createdAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const street = streetOf(project.title);
  const addOns: ShootAddOn[] = addOnTasks.map((t) => ({
    id: t.id,
    item: itemFromTaskTitle(t.title, street),
    note: t.description,
    addedBy: t.contactName,
    addedAtISO: t.createdAt.toISOString(),
    handled: t.status === "COMPLETED",
  }));
  // ONE policy source for everything this page says about photo counts — the
  // enforcement target, the display range, and which regime produced them
  // (override / legacy / SOP), so the chip can never contradict the sweep.
  const photoPolicy = photoPolicyFor(project);
  const photoTarget = photoPolicy.target;
  // Photo policy sections only render for jobs that ordered photos; the video
  // script + instructions only for jobs that ordered video (audit Aug 25).
  const photosOrdered = project.deliverables.some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
  const videoOrdered = project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  // Which flavor of the video step this package gets (Jordan, Sep 1): premium
  // packages require the SCRIPT; agent-intro packages require the typed INTRO
  // script + just editing notes. Deliverables the photographer marked
  // "couldn't complete" are excused, so they must not drive the requirements
  // either (review).
  const liveDeliverables = project.deliverables.filter((d) => !d.notCompletedReason);
  const hasFullVideo = liveDeliverables.some((d) => d.type === "VIDEO");
  // Tier comes from the SETTINGS product mapping (videoTier() reads the label
  // itemToDeliverables stamped from Product.videoTier), so "Premium Video" and
  // anything else Jordan maps premium follows the premium rules automatically.
  // Sep 2: premium is shot S-Log3 / D-LogM and gets every instruction field;
  // standard is an iPhone reel and gets one editing-instructions box.
  const isPremium = videoTier(liveDeliverables) === "premium";
  // The name + tier answer: THE spec when no live row is stamped, and the
  // agent-intro signal even when one is (below). Names live in the verbatim
  // order items.
  const tierSpec = videoStepSpec(
    [project.packageName, ...project.orderItems.map((i) => i.title), ...liveDeliverables.map((d) => d.label)],
    { hasFullVideo, isPremium, isMonthly: isMonthlyContentJob(liveDeliverables, project.packageName) },
  );
  // The stamp — read off EVERY live row, not just the video ones: the "Agent
  // on Camera" add-on is mapped OTHER, so its style can ride on a non-video
  // row. Most demanding first (STYLE_RANK).
  const stamped = liveDeliverables
    .map((d) => d.videoStyle)
    .filter(isVideoStyleKey)
    .sort((a, b) => STYLE_RANK[a] - STYLE_RANK[b]);
  let stampedStyle: VideoStyleKey | null = stamped.length ? stamped[0] : null;
  // An agent-intro line on the order still upgrades a STANDARD stamp — the
  // add-on is its own product and may be unmapped while the reel is mapped
  // (Jordan: the "Agent on Camera" add-on upgrades a standard reel to
  // agent-intro). Never a premium one: "Premium Social Media Reel (No Agent
  // on camera …)" is live data, and videoStepSpec checks premium first.
  if (tierSpec.mode === "agent-intro" && (stampedStyle === "standard_reel" || stampedStyle === "standard_cinematic")) {
    stampedStyle = "standard_reel_agent_intro";
  }
  // Resolved ONCE here and handed to the portal, never re-derived from a name.
  const videoStyle: VideoStyleKey = stampedStyle ?? styleFromTier(tierSpec, hasFullVideo);
  const videoSpec: VideoStepSpec = stampedStyle ? specForStyle(stampedStyle) : tierSpec;

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
          // The agent's Aryeo headshot for the portal header (Jordan, Sep 2:
          // show the profile photo "in other places the clients are mentioned").
          clientAvatarUrl: project.client.avatarUrl,
          // THE customer note (Aryeo-mirrored generalNotes, legacy
          // editingPreferences as fallback), money-scrubbed for a field screen.
          // editingPreferences alone had no writer left, so this was null on
          // every one of the 349 clients.
          customerNote: creativeCustomerNote(project.client),
          photographerName: project.photographer?.name ?? null,
          cullingConfirmedAt: project.cullingConfirmedAt?.toISOString() ?? null,
          shotOrderNotes: project.shotOrderNotes,
          removalNotes: project.removalNotes,
          videoInstructions: project.videoInstructions,
          videosFilmed: project.videosFilmed,
          scriptConfirmedAt: project.scriptConfirmedAt?.toISOString() ?? null,
          scriptConfirmNote: project.scriptConfirmNote,
        }}
        policy={{
          photosOrdered,
          videoOrdered,
          photoTarget,
          range: photoPolicy.range,
          rangeMode: photoPolicy.mode,
          squareFeet: project.squareFeet ?? null,
          squareFeetBand: project.squareFeetBand ?? null,
          videoSpec,
          videoStyle,
          isPremium,
        }}
        script={scriptBody ? { body: scriptBody, hook: scriptHook, url: scriptUrl } : null}
        deliverables={project.deliverables.map((d) => ({
          id: d.id,
          type: d.type,
          quantity: d.quantity,
          status: d.status,
          uploadedAt: d.uploadedAt?.toISOString() ?? null,
          notCompletedReason: d.notCompletedReason,
        }))}
        specialRequests={project.activities
          .filter((a) => a.type === ActivityType.SPECIAL_REQUEST)
          .map((a) => a.body)}
        flags={project.activities
          // Human field flags only. FLAG is a shared bucket: it also holds the
          // wrap-up's own "Not completed — …" echo (already shown as its own
          // amber row) and machine-written client revision rows whose body is a
          // whole email thread — neither is a problem the photographer raised.
          .filter((a) => a.type === ActivityType.FLAG && isFieldFlag(a.body))
          .map((a) => a.body)}
      />

      {/* Anything the agent added on site that the order doesn't know about —
          becomes one task for the office to add the item to the Aryeo order. */}
      <AddedAtShoot projectId={project.id} initial={addOns} />

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
