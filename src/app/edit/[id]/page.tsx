import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  Film, FolderOpen, Palette, Clapperboard, MessageSquare, Star, ExternalLink, PenLine, PlayCircle, Quote,
} from "lucide-react";
import { VIDEO_TIER, videoTypeForDeliverable } from "@/lib/videoStyles";
import { listClientAssets } from "@/lib/clientAssets";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getProject, getTeam } from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { parseClientProfile } from "@/lib/clientProfile";
import { ClientProfileCard } from "@/components/clients/ClientProfileCard";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { EditInstructionsCard } from "@/components/editing/EditInstructionsCard";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { EditorCutPanel } from "@/components/editing/EditorCutPanel";
import { autoSyncScript } from "@/lib/scriptSync";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import { SubmitCutCard } from "@/components/editing/EditorActions";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { EditTracker, deriveEditStage, type RoundRow } from "@/components/editing/EditTracker";
import { JobNoteEditor } from "@/components/editing/JobNoteEditor";
import { aryeoCustomerNote } from "@/lib/shoot";
import { getEditorFeedback } from "@/lib/reviewRoom";
import { slugForName } from "@/lib/assignees";
import { refinedDeliverableLabel, isMonthlyContentJob } from "@/lib/pipeline";
import { stripMoneySentences } from "@/lib/text";
import { prisma } from "@/lib/prisma";
import { ActivityType } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

// The EDITOR's brief screen for one job — everything they need to cut the video:
// the photographer's editing notes, the agent's branding/style profile, the edit
// type, the RAW folder, the Frame.io project to upload finals to, and a per-job
// message thread. Creative-safe (no pricing/financials).
export default async function EditBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string }>;
}) {
  const { id } = await params;
  const { cut } = await searchParams;

  const viewer = await getCurrentUser();
  // Photographers get their own field view; everyone else (owner/admin/editor) sees this.
  if (viewer && viewer.role === "PHOTOGRAPHER") redirect(`/shoot/${id}`);

  // Scripts sync THEMSELVES from the Script Writing platform (by this project
  // id) — cheap freshness gate inside; run before getProject so a just-pulled
  // script renders on this very load.
  await autoSyncScript(id);

  const [project, team, submissions] = await Promise.all([
    getProject(id),
    getTeam(),
    prisma.reviewSubmission.findMany({
      where: { projectId: id },
      orderBy: { round: "asc" },
      select: { id: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, submittedByName: true, note: true, createdAt: true, decidedAt: true },
    }),
  ]);
  if (!project) notFound();

  const isOwnerAdmin = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN";
  // Who may rewrite the customer/shoot notes (saveJobNotes enforces this
  // server-side too). realRole, so a "view as" preview can't write; editors
  // read the brief, they don't rewrite what the customer or photographer said.
  const canEditNotes =
    ["OWNER", "ADMIN", "PHOTOGRAPHER"].includes(viewer?.realRole ?? "OWNER") && !viewer?.impersonating;

  // Review Room feedback addressed to this editor (owner/admin see all lanes'
  // editor notes read-only — their interactive desk is /review).
  const editorScope =
    viewer?.role === "EDITOR" ? (viewer.editorKey || (viewer.name ? slugForName(viewer.name) : null)) : null;
  // Fail CLOSED for an editor whose scope can't resolve — a null scope meant
  // "all lanes" and leaked every editor's notes to a keyless EDITOR login (audit).
  const feedback = await getEditorFeedback(id, isOwnerAdmin ? null : editorScope ?? "__none__").catch(() => []);
  // The client's asset shelf (logos, endcards, brand kit) — folder truth from
  // Dropbox; editors upload here too.
  const assets = await listClientAssets(project.client.id).catch(() => null);
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
  // The customer's OWN words from the Aryeo order intake ("Special
  // Instructions", "Order Notes") — moved here from the queue's note columns
  // (Jordan, Aug 27: rows stay clean, the notes live on the edit page).
  const orderNote = aryeoCustomerNote(project.appointments[0]?.description);

  // ---- The tracker: stage + rounds + revision asks, all from hard state ----
  // VIDEO-lane revision tasks only: a photo retouch routed to Kyle also flips
  // the project to REVISION, but it is NOT this editor's work order — it must
  // never flip the video tracker or render as their ask (review finding).
  // Remar departed Aug 2026 (John took the lane) but stays here: his last
  // in-production job still needs its revision lane to render.
  const VIDEO_REVISION_KEYS = new Set(["kim", "john", "remar", "luma"]);
  // Null-key = an unassigned video revision (personal-branding routing is
  // manual by design) — still this tracker's lane. Kyle's photo asks stay out.
  const videoRevisionTasks = project.smartTasks.filter(
    (t) => t.taskType === "revision" && (t.assignedKey == null || VIDEO_REVISION_KEYS.has(t.assignedKey)),
  );
  const revisionOpen = videoRevisionTasks.length > 0;
  let rawsLanded = false;
  try {
    const ev = project.statusEvidence ? (JSON.parse(project.statusEvidence) as { dropbox?: { rawVideo?: number } | null }) : null;
    rawsLanded = (ev?.dropbox?.rawVideo ?? 0) > 0;
  } catch { /* evidence is best-effort */ }
  const latestRound = submissions.length ? submissions[submissions.length - 1] : null;
  // The cut panel (editor's side of the review): pick the active cut like the
  // owner's workspace does — ?cut=<id> wins, else the newest PENDING/bounced
  // one, else the latest round. Multi-video jobs get a switcher (one chip per
  // video file, latest round each) so the editor works each cut's notes with
  // its own player — same convention as /review/[id].
  const latestPerCut = new Map<string, (typeof submissions)[number]>();
  for (const s of submissions) latestPerCut.set(s.assetPath ?? s.id, s); // round-asc → latest wins
  const currentCuts = [...latestPerCut.values()];
  const activeSub =
    (cut ? submissions.find((s) => s.id === cut) : null) ??
    [...currentCuts].reverse().find((s) => s.status === "CHANGES_REQUESTED" || s.status === "PENDING") ??
    latestRound;
  const activeAssetKey = activeSub ? (activeSub.assetUrl ?? `cut:${activeSub.id}`) : null;
  const activeNotes = activeAssetKey ? feedback.filter((n) => n.assetUrl === activeAssetKey) : [];
  const otherNotes = activeAssetKey ? feedback.filter((n) => n.assetUrl !== activeAssetKey) : feedback;
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
  // The customer-notes trio, money-scrubbed for editor eyes like everything
  // else on this screen (owner/admin see raw — they're also the only ones who
  // can edit, so the editor never rewrites over a scrubbed value).
  const scrub = (s: string | null) => (s == null ? null : canSeeRaw ? s : stripMoneySentences(s) || null);
  const showOrderNote = scrub(orderNote);
  const showPrefs = scrub(project.client.editingPreferences);
  const showJobNote = scrub(project.notes);
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
          {/* The editor's side of the review (the in-hub Frame.io): the cut
              they submitted plays here, the owner's timestamped notes under
              it — tap a time to jump the player, reply, mark fixed. Notes on
              the ACTIVE round live in the panel; anything else falls through
              to the flat feedback list below. */}
          {currentCuts.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {currentCuts.map((c, i) => (
                <Link
                  key={c.id}
                  href={`/edit/${project.id}?cut=${c.id}`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    activeSub?.id === c.id ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: c.status === "APPROVED" ? "#34d399" : c.status === "CHANGES_REQUESTED" ? "#f87171" : "#f59e0b" }}
                  />
                  <span className="max-w-40 truncate">{c.fileName ?? `Video ${i + 1}`}</span>
                </Link>
              ))}
            </div>
          )}
          {activeSub && (
            <EditorCutPanel
              projectId={project.id}
              submissionId={activeSub.id}
              round={activeSub.round}
              status={activeSub.status}
              assetUrl={activeSub.assetUrl}
              fileName={activeSub.fileName}
              finalFolderUrl={finalUrl}
              notes={activeNotes}
              canFix={!isOwnerAdmin}
              viewerName={viewer?.name}
            />
          )}
          {/* Feedback from the Review Room — first, it's the most actionable */}
          <EditFeedback notes={otherNotes} canFix={!isOwnerAdmin} viewerName={viewer?.name} />

          {/* What to make — each deliverable with ITS type's style notes and
              live examples (same data as the Style Guide, so they can't
              drift). Jordan: "notes about the type of video should be on the
              editing page in the What to make section, with examples." */}
          <Section icon={Film} title="What to make">
            {editDeliverables.length === 0 && <span className="text-sm text-muted">No deliverables listed.</span>}
            <div className="space-y-4">
              {editDeliverables.map((d) => {
                const vt = videoTypeForDeliverable(d.label, isMonthlyContentJob(project.deliverables));
                const tierMeta = VIDEO_TIER[vt.tier];
                return (
                  <div key={d.id} className="rounded-xl border border-border bg-surface-2/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium"
                        style={{ backgroundColor: `${tierMeta.color}1a`, color: tierMeta.color }}
                      >
                        <Film className="size-3.5" /> {refinedDeliverableLabel(d.type, d.label)}
                      </span>
                      <span className="text-xs text-muted">{vt.name} · {tierMeta.edit}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {vt.style.map((s) => (
                        <span key={s} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">
                          {s}
                        </span>
                      ))}
                    </div>
                    {vt.note && <p className="mt-2 text-xs leading-relaxed text-muted">{vt.note}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {vt.examples.map((e) => (
                        <a
                          key={e.url}
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-brand hover:border-brand"
                        >
                          <PlayCircle className="size-3" /> {e.label}
                        </a>
                      ))}
                      <Link href="/resources/video-styles" className="text-[11px] font-medium text-muted hover:text-foreground">
                        Full Style Guide →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Edit instructions (Luma-form fields): owner/admin set them, the
              editor reads them. Sits above the script — the spec before the words. */}
          <EditInstructionsCard
            projectId={project.id}
            spec={project.editSpec ? JSON.parse(project.editSpec) : {}}
            canEdit={isOwnerAdmin}
          />

          {/* The locked script — READ-ONLY, pulled automatically from the
              Script Writing platform by this project's id (page render +
              hourly cron + signed webhook; scripts are never written in the
              hub). The editor pastes overlay text from here — re-typing is
              the #1 typo/revision driver. */}
          {videoDeliverables.length > 0 && (
            (project.reelHook || project.reelScript) ? (
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
                <span className="font-semibold">No script on file yet.</span>{" "}
                {isOwnerAdmin
                  ? "The hub checks the Script Writing platform automatically — the script appears here the moment one is written for this shoot."
                  : "The script appears here automatically once it's written — cut B-roll first, or ask in the chat."}
              </div>
            )
          )}

          {/* The customer's voice — three separate registers, kept apart on
              purpose: what they asked for on THIS order, their standing style
              preferences, and our own per-job note. */}
          <Section icon={Quote} title="Customer notes">
            {showOrderNote && (
              <div className="mb-3 rounded-lg border-l-2 border-brand/50 bg-surface-2/60 px-3 py-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-brand">From their order</div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{showOrderNote}</p>
              </div>
            )}
            {showPrefs && (
              <div className="mb-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Their usual style</div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{showPrefs}</p>
              </div>
            )}
            <JobNoteEditor
              projectId={project.id}
              field="customer"
              // An editor edits the RAW note or not at all — saving a scrubbed
              // rendering back would destroy the held-back text.
              value={canEditNotes ? project.notes : showJobNote}
              canEdit={canEditNotes}
              label="Note for this job"
              placeholder="Anything the editor should know about this customer or job…"
              empty={
                showOrderNote || showPrefs
                  ? "Nothing added."
                  : "None on file — cut it to the Style Guide."
              }
            />
          </Section>

          {/* Editing notes from the photographer — owner/admin can correct
              what the upload left behind; editors read. */}
          <Section icon={PenLine} title="Editing notes">
            <JobNoteEditor
              projectId={project.id}
              field="shoot"
              value={project.editorBrief}
              canEdit={canEditNotes}
              label=""
              placeholder="What the editor needs to know from the shoot…"
              empty="No editing notes were submitted on the upload."
            />
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
          {/* Client assets — logos, endcards, brand kit. "Assets available"
              vs "No assets" is the Dropbox folder truth; editors, admin and
              owner can all upload (Jordan's spec). */}
          {assets && (
            <Section icon={Palette} title="Client assets">
              <ClientAssetsCard
                clientId={assets.clientId}
                files={assets.files.map((f) => ({ name: f.name, url: f.url }))}
                folderUrl={assets.folderUrl}
                canUpload
              />
            </Section>
          )}
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
