import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  Film, FolderOpen, Palette, Clapperboard, MessageSquare, Star, ExternalLink, PenLine,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getProject, getTeam } from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { parseClientProfile } from "@/lib/clientProfile";
import { ClientProfileCard } from "@/components/clients/ClientProfileCard";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { ScriptStudioCard } from "@/components/project/ScriptStudioCard";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { FrameioButton } from "@/components/project/FrameioButton";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import { SubmitCutCard } from "@/components/editing/EditorActions";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { EditTracker, deriveEditStage, type RoundRow } from "@/components/editing/EditTracker";
import { getEditorFeedback } from "@/lib/reviewRoom";
import { slugForName } from "@/lib/assignees";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import { stripMoneySentences } from "@/lib/text";
import { prisma } from "@/lib/prisma";
import { ActivityType } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

// The EDITOR's brief screen for one job — everything they need to cut the video:
// the photographer's editing notes, the agent's branding/style profile, the edit
// type, the RAW folder, the Frame.io project to upload finals to, and a per-job
// message thread. Creative-safe (no pricing/financials).
export default async function EditBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const viewer = await getCurrentUser();
  // Photographers get their own field view; everyone else (owner/admin/editor) sees this.
  if (viewer && viewer.role === "PHOTOGRAPHER") redirect(`/shoot/${id}`);

  const [project, team, submissions] = await Promise.all([
    getProject(id),
    getTeam(),
    prisma.reviewSubmission.findMany({
      where: { projectId: id },
      orderBy: { round: "asc" },
      select: { round: true, status: true, submittedByName: true, note: true, createdAt: true, decidedAt: true },
    }),
  ]);
  if (!project) notFound();

  const isOwnerAdmin = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN";

  // Review Room feedback addressed to this editor (owner/admin see all lanes'
  // editor notes read-only — their interactive desk is /review).
  const editorScope =
    viewer?.role === "EDITOR" ? (viewer.editorKey || (viewer.name ? slugForName(viewer.name) : null)) : null;
  const feedback = await getEditorFeedback(id, isOwnerAdmin ? null : editorScope).catch(() => []);
  const profile = parseClientProfile(project.client.profileJson);
  const folders = projectFolderPaths(project);
  const rawUrl = dropboxWebUrl(folders.rawVideo);
  const finalUrl = dropboxWebUrl(folders.finalVideo);
  const brandUrl = project.client.brandAssetsPath ? dropboxWebUrl(project.client.brandAssetsPath) : null;
  const brandColors = (project.client.brandColors ?? "")
    .split(/[,\s]+/).map((c) => c.trim()).filter((c) => /^#?[0-9a-f]{3,8}$/i.test(c)).map((c) => (c.startsWith("#") ? c : `#${c}`));
  const street = project.title?.split(",")[0]?.trim() || project.title || "Project";

  // Video SLA header line — when the cut is due + a live countdown, so the
  // editor (and Kyle/Jordan glancing at the brief) always sees the clock.
  const sla = getVideoSlaStatus({
    shootDate: project.shootDate,
    status: project.status,
    deliverables: project.deliverables,
    client: { socialClient: project.client.socialClient },
  });

  const videoDeliverables = project.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const editDeliverables = videoDeliverables.length ? videoDeliverables : project.deliverables;
  const specialRequests = project.activities.filter((a) => a.type === ActivityType.SPECIAL_REQUEST);
  const deliverableNotes = project.deliverables.filter((d) => d.notes?.trim());

  // ---- The tracker: stage + rounds + revision asks, all from hard state ----
  // VIDEO-lane revision tasks only: a photo retouch routed to Kyle also flips
  // the project to REVISION, but it is NOT this editor's work order — it must
  // never flip the video tracker or render as their ask (review finding).
  const VIDEO_REVISION_KEYS = new Set(["kim", "remar", "luma"]);
  const videoRevisionTasks = project.smartTasks.filter(
    (t) => t.taskType === "revision" && VIDEO_REVISION_KEYS.has(t.assignedKey ?? ""),
  );
  const revisionOpen = videoRevisionTasks.length > 0;
  let rawsLanded = false;
  try {
    const ev = project.statusEvidence ? (JSON.parse(project.statusEvidence) as { dropbox?: { rawVideo?: number } | null }) : null;
    rawsLanded = (ev?.dropbox?.rawVideo ?? 0) > 0;
  } catch { /* evidence is best-effort */ }
  const latestRound = submissions.length ? submissions[submissions.length - 1] : null;
  // A stale flag must not resurrect "changes requested" on an approved cut:
  // only a video revision RAISED AFTER the approval outranks it.
  const approvedAt = latestRound?.status === "APPROVED" ? latestRound.decidedAt : null;
  const revisionAfterApproval =
    revisionOpen && (!approvedAt || videoRevisionTasks.some((t) => t.createdAt > approvedAt));
  const { stage, label: statusLine } = deriveEditStage({
    projectStatus: project.status,
    revisionOpen,
    revisionAfterApproval,
    latestRoundStatus: latestRound?.status ?? null,
    rawsLanded: rawsLanded || submissions.length > 0,
  });
  const hadRevision =
    revisionOpen ||
    (!!project.revisionRequestedAt && project.status === "REVISION") ||
    submissions.some((s) => s.status === "CHANGES_REQUESTED");
  // The client's asks: raiseRevision APPENDS later rounds onto the open task's
  // description ("\n\nNew request: …"). Money never reaches an editor's screen
  // — and the gate is STRICT (an unknown/expired session scrubs too; only a
  // live OWNER/ADMIN sees raw text). Scrubbed-empty asks become placeholders,
  // never dropped, so the round labels stay on the right ask.
  const canSeeRaw = viewer?.role === "OWNER" || viewer?.role === "ADMIN";
  const rawAsks = videoRevisionTasks
    .flatMap((t) => (t.description ?? t.summary ?? "").split(/\n\nNew request: /))
    .map((s) => s.trim())
    .filter(Boolean);
  const revisionAsks = canSeeRaw
    ? rawAsks
    : rawAsks.map((a) => stripMoneySentences(a) || "(a note was held back — ask Jordan)");
  const revisionAtISO =
    videoRevisionTasks.length > 0
      ? new Date(Math.max(...videoRevisionTasks.map((t) => t.createdAt.getTime()))).toISOString()
      : null;
  const rounds: RoundRow[] = submissions.map((s) => ({
    round: s.round,
    status: s.status,
    submittedByName: s.submittedByName,
    note: s.note,
    createdAtISO: s.createdAt.toISOString(),
    decidedAtISO: s.decidedAt ? s.decidedAt.toISOString() : null,
  }));
  // The tracker narrates a VIDEO edit — a photos-only or cancelled job has no
  // edit lifecycle to track (the brief below still renders for reference).
  const showTracker = videoDeliverables.length > 0 && project.status !== "CANCELLED";

  return (
    <div>
      <PageHeader
        eyebrow="Editor brief"
        title={street}
        subtitle={project.client.name}
        actions={
          <div className="flex items-center gap-2">
            <FrameioButton projectId={project.id} viewUrl={project.frameioViewUrl} />
            {isOwnerAdmin && (
              <Link href={`/projects/${project.id}`} className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground">
                Full details <ExternalLink className="size-3.5" />
              </Link>
            )}
          </div>
        }
      />

      {/* The tracker — where this edit stands, at a glance (stage timeline,
          order facts incl. the deadline + live countdown, the client's
          revision asks, every round sent to review). Video jobs only — a
          photos-only or cancelled job has no edit lifecycle to narrate. */}
      {showTracker && (
        <div className="px-4 pt-4 sm:px-6">
          <EditTracker
            stage={stage}
            statusLine={statusLine}
            hadRevision={hadRevision}
            editType={editDeliverables.map((d) => refinedDeliverableLabel(d.type, d.label)).join(" · ") || "Video edit"}
            dueISO={sla ? sla.due.toISOString() : null}
            shootDateISO={project.shootDate ? project.shootDate.toISOString() : null}
            photographerName={project.photographer?.name ?? null}
            song={project.reelSong}
            rounds={rounds}
            revisionAsks={revisionAsks}
            revisionAtISO={revisionAtISO}
            showSubmitAnchor={!isOwnerAdmin}
          />
        </div>
      )}

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the brief */}
        <div className="space-y-6 lg:col-span-2">
          {/* Feedback from the Review Room — first, it's the most actionable */}
          <EditFeedback notes={feedback} canFix={!isOwnerAdmin} viewerName={viewer?.name} />

          {/* What to make */}
          <Section icon={Film} title="What to make">
            <div className="flex flex-wrap gap-2">
              {editDeliverables.map((d) => {
                const premium = /premium|influencer/i.test(d.label ?? "");
                const color = premium ? "#a78bfa" : "#64748b";
                return (
                  <span
                    key={d.id}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium"
                    style={{ backgroundColor: `${color}1a`, color }}
                  >
                    <Film className="size-3.5" /> {refinedDeliverableLabel(d.type, d.label)}
                  </span>
                );
              })}
              {editDeliverables.length === 0 && <span className="text-sm text-muted">No deliverables listed.</span>}
            </div>
          </Section>

          {/* The locked script — READ-ONLY, straight from Script Studio (the
              API/webhook sync owns these fields; scripts are never written in
              the hub). The editor pastes overlay text from here — re-typing is
              the #1 typo/revision driver. */}
          {videoDeliverables.length > 0 && (
            <>
              {(project.reelHook || project.reelScript) ? (
                <ReelScriptCard
                  hook={project.reelHook}
                  script={project.reelScript}
                  song={project.reelSong}
                  shotList={project.reelShotList}
                  updatedAt={project.reelRecipeUpdatedAt ? project.reelRecipeUpdatedAt.toISOString() : null}
                  studioUrl={isOwnerAdmin ? (project.scriptingUrl ?? project.reelScriptUrl) : null}
                />
              ) : (
                <div className="rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground/85">
                  <span className="font-semibold">No script on file yet.</span> Scripts are written in Script Studio
                  and sync here automatically — use the Script Studio card below to link the job or pull the latest.
                </div>
              )}
              <ScriptStudioCard projectId={project.id} />
            </>
          )}

          {/* Editing notes from the photographer */}
          <Section icon={PenLine} title="Editing notes">
            {project.editorBrief ? (
              <div className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2.5 text-sm leading-relaxed text-foreground/90">
                {project.editorBrief}
              </div>
            ) : (
              <p className="text-sm text-muted">No editing notes were submitted on the upload.</p>
            )}
            {deliverableNotes.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {deliverableNotes.map((d) => (
                  <li key={d.id} className="text-sm text-foreground/85">
                    <span className="font-medium">{refinedDeliverableLabel(d.type, d.label)}:</span> {d.notes}
                  </li>
                ))}
              </ul>
            )}
            {specialRequests.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning"><Star className="size-3.5" /> Special requests</div>
                {specialRequests.map((a) => (
                  <p key={a.id} className="text-sm text-foreground/85">{a.body}</p>
                ))}
              </div>
            )}
          </Section>

          {/* Files + where to deliver */}
          <Section icon={FolderOpen} title="Files & delivery">
            <div className="flex flex-wrap gap-2">
              <a href={rawUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                <FolderOpen className="size-4 text-muted" /> RAW footage <ExternalLink className="size-3.5 text-muted-2" />
              </a>
              <a href={finalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                <FolderOpen className="size-4 text-muted" /> Final footage <ExternalLink className="size-3.5 text-muted-2" />
              </a>
              {brandUrl && (
                <a href={brandUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                  <Palette className="size-4 text-muted" /> Brand assets (logo, fonts) <ExternalLink className="size-3.5 text-muted-2" />
                </a>
              )}
            </div>
            <div id="submit-cut" className="mt-3 space-y-2 scroll-mt-20 rounded-lg border border-[#5b53ff]/25 bg-[#5b53ff]/5 p-3">
              <div className="flex items-start gap-2">
                <Clapperboard className="mt-0.5 size-4 shrink-0 text-[#5b53ff]" />
                <span className="text-sm text-foreground/85">
                  When the cut is ready: <strong>1)</strong> drop the finished file in the <strong>Final footage</strong> folder
                  above, <strong>2)</strong> hit <strong>Done — send to review</strong>. It goes straight to the Review Room
                  with a player — Jordan gets pinged the moment you send it.
                </span>
              </div>
              <SubmitCutCard projectId={project.id} />
            </div>
          </Section>

          {/* Per-job messages */}
          <Section icon={MessageSquare} title="Project chat" flush>
            <div className="p-4 sm:p-5">
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
            </div>
          </Section>
        </div>

        {/* RIGHT — the agent's brand + working profile */}
        <div className="space-y-6">
          {videoDeliverables.length > 0 && <AocPlaybookCard context="edit" />}
          {brandColors.length > 0 && (
            <Section icon={Palette} title="Brand colors">
              <div className="flex flex-wrap items-center gap-2">
                {brandColors.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2 py-1 text-xs font-medium">
                    <span className="size-4 rounded" style={{ backgroundColor: c }} /> {c.toUpperCase()}
                  </span>
                ))}
              </div>
            </Section>
          )}

          <ClientProfileCard
            clientId={project.client.id}
            profile={profile}
            updatedAt={project.client.profileUpdatedAt ? formatDistanceToNow(project.client.profileUpdatedAt, { addSuffix: true }) : null}
          />
        </div>
      </div>
    </div>
  );
}
