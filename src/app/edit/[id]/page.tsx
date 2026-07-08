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
import { ReelRecipeCard } from "@/components/project/ReelRecipeCard";
import { ScriptStudioCard } from "@/components/project/ScriptStudioCard";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { FrameioButton } from "@/components/project/FrameioButton";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import { SlaCountdown } from "@/components/editing/SlaCountdown";
import { refinedDeliverableLabel } from "@/lib/pipeline";
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

  const [project, team] = await Promise.all([getProject(id), getTeam()]);
  if (!project) notFound();

  const isOwnerAdmin = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN";
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

      {sla && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-sm text-muted sm:px-6">
          <span>
            Due {sla.due.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </span>
          <span className="text-muted-2">·</span>
          <SlaCountdown dueISO={sla.due.toISOString()} />
        </div>
      )}

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the brief */}
        <div className="space-y-6 lg:col-span-2">
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

          {/* Reel recipe — the creative plan (video jobs only) */}
          {videoDeliverables.length > 0 && (
            <>
              <ReelRecipeCard
                projectId={project.id}
                hook={project.reelHook}
                script={project.reelScript}
                song={project.reelSong}
                shotList={project.reelShotList}
                scriptUrl={project.reelScriptUrl}
                updatedAt={project.reelRecipeUpdatedAt ? formatDistanceToNow(project.reelRecipeUpdatedAt, { addSuffix: true }) : null}
              />
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
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#5b53ff]/25 bg-[#5b53ff]/5 p-3">
              <Clapperboard className="size-4 text-[#5b53ff]" />
              <span className="text-sm text-foreground/85">When the cut is ready, upload it to Frame.io and click <strong>“Send to RealTour for review.”</strong></span>
              <span className="ml-auto"><FrameioButton projectId={project.id} viewUrl={project.frameioViewUrl} /></span>
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
