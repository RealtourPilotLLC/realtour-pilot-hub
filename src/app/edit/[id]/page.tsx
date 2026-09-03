import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle, Film, FolderOpen, Palette, MessageSquare, ExternalLink, PlayCircle, Quote,
} from "lucide-react";
import { VIDEO_TIER, videoTypeForDeliverable } from "@/lib/videoStyles";
import { listClientAssets } from "@/lib/clientAssets";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getProject, getTeam } from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { parseClientProfile } from "@/lib/clientProfile";
import { ClientProfileCard } from "@/components/clients/ClientProfileCard";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { EditInstructionsCard } from "@/components/editing/EditInstructionsCard";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { EditorCutPanel } from "@/components/editing/EditorCutPanel";
import { CutUploader } from "@/components/editing/CutUploader";
import { autoSyncScript } from "@/lib/scriptSync";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus, videoTier } from "@/lib/projectStatus";
import { SubmitCutCard } from "@/components/editing/EditorActions";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { EditTracker, deriveEditStage, type RoundRow } from "@/components/editing/EditTracker";
import { RevisionBriefCard } from "@/components/editing/RevisionBriefCard";
import { getRevisionBriefs } from "@/lib/revisionBrief";
import { aryeoCustomerNote } from "@/lib/shoot";
// Per-CLIENT note (the merged, Aryeo-mirrored one) — distinct from
// aryeoCustomerNote just above, which is the note on THIS order.
import { customerNote } from "@/lib/clientNotes";
import { getEditorFeedback } from "@/lib/reviewRoom";
import { slugForName } from "@/lib/assignees";
import { refinedDeliverableLabel, isMonthlyContentJob, videoTypeLabel } from "@/lib/pipeline";
import { stripMoneySentences } from "@/lib/text";
import { prisma } from "@/lib/prisma";
import { ActivityType } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

// The EDITOR's brief screen for one job. Creative-safe (no pricing/financials).
//
// Ordered around the editor's actual job (Jordan, Sep 2: "there is too much to
// look at"): where the media is → what to make → do the work → what the client
// is like → history.
//   1. the work order (only on a bounced job — then it IS the job)
//   2. Media — RAW, Final, brand assets, the client's asset shelf, their colors
//      (first, so the download is running while they read — Jordan, Sep 2)
//   3. Edit instructions — ONE card: the spec, the customer's words on this
//      order, and everything that came off the shoot
//   4. What to make — the deliverables with their style tier and examples
//   5. Script — the locked words
//   6. Cuts to deliver — upload, the cut in review, the notes on it
//   7. Project chat
// The right rail is client context only; reference material sits in a
// <details> so it is there without being in the way.
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
  // Fail CLOSED on a null viewer once enforcement is on (the same line /shoot/<id>
  // now carries). pathKey() returns null for /edit/<id>, so the middleware only
  // proves the JWT verifies — and a disabled account keeps a valid one for the
  // full 7-day token life. Null doesn't just skip the role test below: further
  // down it reads as owner/admin (isOwnerAdmin, canEditNotes), which would hand a
  // revoked session EVERY editor's Review Room feedback and the client's raw,
  // un-money-scrubbed wording. Past this line `!viewer` can only mean local dev
  // with auth off.
  if (!viewer && authEnforced()) redirect(`/login?next=/edit/${id}`);
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
      where: { projectId: id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
      orderBy: { round: "asc" },
      select: { id: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, submittedByName: true, note: true, createdAt: true, decidedAt: true, deliverableId: true, slot: true, source: true, blobUrl: true, completedAt: true },
    }),
  ]);
  if (!project) notFound();
  // The cuts this job owes (deliverable × slot) with the newest version of
  // each — the editor's upload panel and the cut switcher both hang off it.
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(id).catch(() => []);
  const cutKeyOf = (s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string }) =>
    s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : (s.assetPath ?? s.id);

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
  // The client's change requests, itemised. Money-scrubbed unless a LIVE
  // owner/admin is looking — this is the client's raw wording and they do talk
  // price, so the gate is the strict one the revision asks use (an unknown or
  // expired session scrubs too). Ticking off items is the working editor's job
  // as well as the owner's; a "view as" preview is read-only, and the server
  // re-checks either way.
  const strictOwnerAdmin = viewer?.role === "OWNER" || viewer?.role === "ADMIN";
  const briefs = await getRevisionBriefs(id, !strictOwnerAdmin).catch(() => []);
  const canTickBrief = !viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR");
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
    deliverables: project.deliverables.filter((d) => !d.removedFromOrderAt),
    client: { socialClient: project.client.socialClient },
  });

  // Owed rows only — an item removed from the Aryeo order is not work to edit
  // (the project page still shows it, dimmed, as history).
  const owedDeliverables = project.deliverables.filter((d) => !d.removedFromOrderAt);
  const videoDeliverables = owedDeliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const editDeliverables = videoDeliverables.length ? videoDeliverables : owedDeliverables;
  const specialRequests = project.activities.filter((a) => a.type === ActivityType.SPECIAL_REQUEST);
  const deliverableNotes = owedDeliverables.filter((d) => d.notes?.trim());
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
  for (const s of submissions) latestPerCut.set(cutKeyOf(s), s); // round-asc → latest wins
  const currentCuts = [...latestPerCut.values()];
  const slotLabelOf = (s: (typeof submissions)[number]) =>
    slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot)?.label ?? null;
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
  // THE customer note: generalNotes (mirrors Aryeo's customer internal_notes,
  // the only note anyone can still write) with the retired editingPreferences
  // column as fallback. It used to read editingPreferences alone — NULL on all
  // 349 clients since the notes cards were merged, so this card was blank for
  // every job while 17 clients had a real note the editor needed.
  const showPrefs = scrub(customerNote(project.client));
  // The client's OWN style notes, typed on their portal (client-owned column,
  // distinct from our internal editing notes) — scrubbed like everything else.
  const showTheirStyle = scrub(project.client.portalVideoStyle);
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
  // ReviewSubmission.note is the EDITOR'S message to whoever reviews the cut —
  // except on rows the hourly folder sweep created, where it parked its own
  // provenance line instead ("Cut detected in the Dropbox Final folder…",
  // 11 of the 13 cuts on file). Quoting that back as if a person wrote it is
  // noise on every surface, so it is dropped here and in the cut rows.
  const editorMessage = (n: string | null) =>
    n && !/^Cut detected in the Dropbox Final folder/i.test(n) ? n : null;
  const rounds: RoundRow[] = submissions.map((s) => ({
    id: s.id,
    round: s.round,
    status: s.status,
    submittedByName: s.submittedByName,
    note: editorMessage(s.note),
    createdAtISO: s.createdAt.toISOString(),
    decidedAtISO: s.decidedAt ? s.decidedAt.toISOString() : null,
  }));
  // The tracker narrates a VIDEO edit — a photos-only or cancelled job has no
  // edit lifecycle to track (the brief below still renders for reference).
  const showTracker = videoDeliverables.length > 0 && project.status !== "CANCELLED";
  // ---- ONE instruction card ----------------------------------------------
  // Everything the editor is TOLD to do, gathered from the three cards that
  // used to say it separately ("Edit instructions", "Editing notes", and the
  // instruction half of "Customer notes"). The client's STANDING style
  // preferences deliberately stay out: those are client context and sit beside
  // their working profile in the right rail.
  const briefFields = {
    canEditNotes,
    orderNote: showOrderNote,
    // An editor edits the RAW note or not at all — saving a scrubbed rendering
    // back would destroy the held-back text.
    jobNote: canEditNotes ? project.notes : showJobNote,
    editorBrief: project.editorBrief,
    videoInstructions: project.videoInstructions,
    shotOrderNotes: project.shotOrderNotes,
    removalNotes: project.removalNotes,
    videosFilmed: project.videosFilmed,
    scriptConfirmNote: project.scriptConfirmNote,
    deliverableNotes: deliverableNotes.map((d) => ({
      id: d.id,
      label: refinedDeliverableLabel(d.type, d.label),
      notes: d.notes ?? "",
    })),
    specialRequests: specialRequests.map((a) => ({ id: a.id, body: a.body })),
  };

  // What the editor OWES on the cut in front of them. The cut panel sits below
  // the brief now, so when work is waiting the page says so at the top and
  // jumps them straight to it — a review note must never go unseen because it
  // is four cards down.
  const openOnActive = activeNotes.filter((n) => n.status === "OPEN").length;
  const needsWork = activeSub?.status === "CHANGES_REQUESTED" || openOnActive > 0;

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
            // The ACTUAL product name, or the tier-decorated type for a generic
            // Aryeo label — never the bare word "Video" (208 N Adams St). The
            // tier is the same videoTier() verdict the deadline is built on.
            editType={videoTypeLabel(editDeliverables, videoTier(owedDeliverables)) || "Video edit"}
            dueISO={sla ? sla.due.toISOString() : null}
            shootDateISO={project.shootDate ? project.shootDate.toISOString() : null}
            photographerName={project.photographer?.name ?? null}
            song={project.reelSong}
            rounds={rounds}
            // When a work order exists it carries the asks in full, itemised —
            // repeating the raw paragraph here would be the wall of text twice.
            revisionAsks={briefs.length > 0 ? [] : revisionAsks}
            revisionAtISO={revisionAtISO}
            showSubmitAnchor={!isOwnerAdmin}
          />
        </div>
      )}

      {/* One line, only when something is owed on the current cut. */}
      {needsWork && (
        <div className="px-4 pt-4 sm:px-6">
          <a
            href="#submit-cut"
            className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-3.5 py-2.5 text-sm font-medium text-danger hover:bg-danger-soft"
          >
            <AlertTriangle className="size-4 shrink-0" />
            {openOnActive > 0
              ? `${openOnActive} note${openOnActive === 1 ? "" : "s"} to fix on this cut`
              : "Changes were requested on this cut"}
            <span className="ml-auto text-xs font-semibold">Go to your cut →</span>
          </a>
        </div>
      )}

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — what to make, where the media is, the work, the history */}
        <div className="space-y-6 lg:col-span-2">
          {/* 1 · THE WORK ORDER — what the client asked for, split into items
              the editor ticks off, their own words kept whole underneath. It
              renders nothing unless the job has been bounced; when it does
              render, it is the job, so it goes first. */}
          <RevisionBriefCard
            briefs={briefs}
            canTick={canTickBrief}
            canReanalyze={isOwnerAdmin && !viewer?.impersonating}
          />

          {/* 2 · WHERE THE MEDIA IS — footage in, footage out, and everything
              of the client's that goes on top of it. ABOVE the instructions:
              the RAW download is the slow part of starting an edit, so the
              editor kicks it off first and reads the brief while it runs
              (Jordan, Sep 2: "Media should be above the edit instructions so
              they can start the download immediately"). */}
          <Section icon={FolderOpen} title="Media">
            <div className="space-y-3">
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
              {/* The client's asset shelf — "Assets available" vs "No assets"
                  is the Dropbox folder truth; editors, admin and owner can all
                  upload (Jordan's spec). */}
              {assets && (
                <div className="border-t border-border pt-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Client assets — logos, endcards, brand kit</div>
                  <ClientAssetsCard
                    clientId={assets.clientId}
                    files={assets.files.map((f) => ({ name: f.name, url: f.url }))}
                    folderUrl={assets.folderUrl}
                    canUpload
                  />
                </div>
              )}
              {brandColors.length > 0 && (
                <div className="border-t border-border pt-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Brand colors</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {brandColors.map((c) => (
                      <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2 py-1 text-xs font-medium">
                        <span className="size-4 rounded" style={{ backgroundColor: c }} /> {c.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* 3 · WHAT TO MAKE, in words — the spec, the customer's own words on
              this order, and everything that came off the shoot, in one card. */}
          <EditInstructionsCard
            projectId={project.id}
            spec={project.editSpec ? JSON.parse(project.editSpec) : {}}
            canEdit={isOwnerAdmin}
            brief={briefFields}
          />

          {/* 4 · WHAT TO MAKE, by type — each deliverable with ITS type's style
              notes and live examples (same data as the Style Guide, so they
              can't drift). Jordan: "notes about the type of video should be on
              the editing page in the What to make section, with examples." */}
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

          {/* 5 · THE SCRIPT — READ-ONLY, pulled automatically from the Script
              Writing platform by this project's id (page render + hourly cron
              + signed webhook; scripts are never written in the hub). The
              editor pastes overlay text from here — re-typing is the #1
              typo/revision driver. */}
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

          {/* 6 · THE WORK ITSELF — upload a version per cut, then the cut in
              review with the owner's timestamped notes under it. #submit-cut
              is the anchor the tracker's "Done? Send to review" jumps to. */}
          <div id="submit-cut" className="scroll-mt-20 space-y-6">
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
                    <span className="max-w-48 truncate">{slotLabelOf(c) ?? c.fileName ?? `Video ${i + 1}`}</span>
                    {c.round > 1 && <span className="text-[10px] text-muted-2">v{c.round}</span>}
                  </Link>
                ))}
              </div>
            )}
            {/* The way in: upload a version per cut (Jordan, Sep 1), each with
                the editor's own message to whoever reviews it (Sep 2).
                Owner/admin can upload on an editor's behalf (vendor cuts). */}
            <CutUploader
              projectId={project.id}
              canUpload={!viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR")}
              cuts={slots.map((sl) => {
                const latest = latestPerCut.get(`${sl.deliverableId}:${sl.slot}`) ?? null;
                const openNotes = latest?.assetUrl ? feedback.filter((n) => n.assetUrl === latest.assetUrl && n.status === "OPEN").length : 0;
                return {
                  deliverableId: sl.deliverableId,
                  slot: sl.slot,
                  label: sl.label,
                  latest: latest
                    ? { id: latest.id, round: latest.round, status: latest.status, fileName: latest.fileName, completedAt: latest.completedAt ? latest.completedAt.toISOString() : null, note: latest.note }
                    : null,
                  openNotes,
                };
              })}
            />
            {/* The rescue hatch for the old habit — exporting straight into the
                Dropbox Final folder. Folded away (uploading here is the path)
                but kept for everyone who had it before, owner included. */}
            <details className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-muted">
              <summary className="cursor-pointer">Already dropped a file in the Final footage folder instead?</summary>
              <div className="mt-2"><SubmitCutCard projectId={project.id} /></div>
            </details>
            {activeSub && (
              <EditorCutPanel
                projectId={project.id}
                submissionId={activeSub.id}
                round={activeSub.round}
                status={activeSub.status}
                assetUrl={activeSub.assetUrl}
                streamable={!!activeSub.blobUrl}
                fileName={activeSub.fileName}
                finalFolderUrl={finalUrl}
                notes={activeNotes}
                canFix={!isOwnerAdmin}
                viewerName={viewer?.name}
              />
            )}
            {/* Review-Room notes that aren't on the active cut (renders nothing
                when the list is empty). */}
            <EditFeedback notes={otherNotes} canFix={!isOwnerAdmin} viewerName={viewer?.name} />
          </div>

          {/* 7 · HISTORY — the per-job thread. */}
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

        {/* RIGHT — what this client is like, and nothing else */}
        <div className="space-y-6">
          {/* Their STANDING preferences — two registers kept apart on purpose:
              the note we hold on file, and what they typed on their portal.
              Not job instructions, so they sit with the profile, not in the
              instruction card — and ABOVE the profile: the client's own words
              outrank the AI's read of them (Jordan, Sep 2: "How they like it
              should be above the working profile"). */}
          {(showPrefs || showTheirStyle) && (
            <Section icon={Quote} title="How they like it">
              <div className="space-y-3">
                {showPrefs && (
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Customer notes on file</div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{showPrefs}</p>
                  </div>
                )}
                {showTheirStyle && (
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">In their own words — from their portal</div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{showTheirStyle}</p>
                  </div>
                )}
              </div>
            </Section>
          )}
          <ClientProfileCard
            clientId={project.client.id}
            profile={profile}
            updatedAt={project.client.profileUpdatedAt ? formatDistanceToNow(project.client.profileUpdatedAt, { addSuffix: true }) : null}
          />
          {/* Reference, not instruction — there when they want it, folded away
              when they don't. */}
          {videoDeliverables.length > 0 && (
            <details>
              <summary className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2.5 text-xs font-semibold text-muted hover:text-foreground">
                Coaching &amp; reference
              </summary>
              <div className="mt-3">
                <AocPlaybookCard context="edit" />
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
