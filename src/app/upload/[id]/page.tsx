import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { photographerMemberId, photographerOwnsShoot } from "@/lib/shoot";
import {
  Image as ImageIcon,
  Video,
  ExternalLink,
} from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { UploadPortal, type BriefNoteResult, type PortalOutputBrief } from "@/components/upload/UploadPortal";
import type { OutputBrief } from "@/lib/deliverableOutputs";
import type { VideoStyleKey } from "@/lib/videoStyles";
import { AppointmentFeedback } from "@/components/upload/AppointmentFeedback";
import { AddedAtShoot } from "./AddedAtShoot";
import { AdditionalShoot } from "./AdditionalShoot";
import { itemFromTaskTitle, shootAddonKey, shootAddonKeyPrefix, streetOf, type ShootAddOn } from "@/app/upload/shootAddOns";
import {
  additionalShootItem,
  additionalShootLabel,
  isAdditionalVideoType,
  type AdditionalShoot as AdditionalShootRow,
} from "@/app/upload/additionalShoots";
import { UPLOAD_PENDING_STATUSES } from "@/lib/uploadHistory";
import { etDayKey } from "@/lib/datetime";
import { getProjectFolderState } from "@/lib/dropboxFolders";
import { photoPolicyFor, rawBudgetFor, rawOverageCeiling } from "@/lib/culling";
import { ActivityType } from "@prisma/client";
import { isFieldFlag } from "@/lib/debrief";
import { resolveVideoSpec, type VideoStepSpec } from "@/lib/pipeline";
import { evidenceView, handoffEvidence } from "@/lib/handoff";
import { normalizeDraftPayload, draftHasContent, submittedFieldsHash, type DraftPayload } from "@/lib/uploadDraft";
import { creativeCustomerNote } from "@/lib/clientNotes";
import { videoTier } from "@/lib/projectStatus";
import { submissionTrail, UPLOAD_COMPLETED_BODY, UPLOAD_EDITED_BY_PREFIX, UPLOAD_SUBMITTED_BY_PREFIX } from "@/lib/uploadSummary";
import { DEBRIEF_PAY_GATE_FROM } from "@/lib/payroll";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// WHICH video this job is (shared contract, Sep 2 2026). The Aryeo sync stamps
// Deliverable.videoStyle from Product.videoStyle at order time, so the brief's
// shape follows the PRODUCT the client bought. The stamp is authoritative; a
// job with no stamped live row falls back to the Sep 2 name + tier logic.
// §7.4 (Sep 25 2026): the resolution that lived here is now
// pipeline.resolveVideoSpec, so the submit gate, the handoff engine and the
// project brief ask it exactly the way this page does.
// ---------------------------------------------------------------------------

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
      // Files uploaded through this page — read back on the submitted card.
      uploads: { select: { originalName: true, size: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  // ONE ROUND OF INDEPENDENT READS (Oct 5: "speed up the page"). Every read
  // below needs only the project row, so they run side by side instead of one
  // after another; each keeps its own failure rule from before, and the reads
  // that depend on one of these (topic folders, the pending report, the
  // creative scrub of the gaps) follow straight after.
  const videoOrderedRow = project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const canSaveDraft = !!viewer?.email && !viewer.impersonating;
  const { readSessionTopics } = await import("@/lib/filmedTopics");
  const { gapsForProject, gapsForCreatives } = await import("@/lib/productionGaps");
  const { fieldReportsForProject } = await import("@/lib/clientFacts");
  const { outputBriefsFor, ON_SITE_NOTE_CAP } = await import("@/lib/deliverableOutputs");
  const [trailRows, folderState, addOnTasks, extraShootRows, topicsRead, draftRow, ladder, gapsRaw, fieldReportRows, allBriefs] = await Promise.all([
    // Who submitted / last edited the page (Sep 15): read off the timeline
    // lines finalizeUpload writes — see submissionTrail for the rules.
    prisma.activity.findMany({
      where: {
        projectId: project.id,
        OR: [
          { type: ActivityType.FILE, body: UPLOAD_COMPLETED_BODY },
          { body: { startsWith: UPLOAD_SUBMITTED_BY_PREFIX } },
          { body: { startsWith: UPLOAD_EDITED_BY_PREFIX } },
        ],
      },
      select: { type: true, body: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    getProjectFolderState(project),
    // Items the agent added on site, already logged from this portal. Read back
    // off the tasks themselves (their dedupeKey is prefixed per project) so the
    // photographer sees what they've already reported instead of re-adding it,
    // and CANCELLED rows stay hidden — those were withdrawn here.
    prisma.smartTask.findMany({
      where: { projectId: project.id, dedupeKey: { startsWith: shootAddonKeyPrefix(project.id) }, status: { not: "CANCELLED" } },
      select: { id: true, title: true, description: true, contactName: true, createdAt: true, status: true, dedupeKey: true },
      orderBy: { createdAt: "asc" },
    }),
    // Extra shoots this job has been reopened for (Jordan, Sep 18 — 204 Spring
    // Ln). Read with their OWN counts rather than off `project.deliverables`
    // above: whether a cut or a file already hangs off the row is what decides
    // if the photographer may still take it back, and the shared include does
    // not carry it. See app/upload/additionalShoots.ts for the shape.
    prisma.deliverable.findMany({
      where: {
        projectId: project.id,
        manual: true,
        removedFromOrderAt: null,
        capturedAt: { not: null },
        type: { in: ["VIDEO", "SOCIAL_REEL"] },
      },
      orderBy: { capturedAt: "asc" },
      select: {
        id: true, type: true, label: true, capturedAt: true, uploadedAt: true, createdAt: true,
        _count: { select: { uploads: true, reviewSubmissions: true } },
      },
    }),
    // F12 / R02: the content-program topics (see the note on topicsRead below).
    readSessionTopics(project.id),
    // O04: this viewer's unsent answers, if any. One draft per person per job —
    // the office's "Edit this upload" never sees the photographer's.
    canSaveDraft
      ? prisma.uploadDraft
          .findUnique({
            where: { projectId_authorKey: { projectId: project.id, authorKey: viewer!.email.trim().toLowerCase() } },
            select: { revision: true, payloadJson: true, savedAt: true, consumedAt: true, baseHash: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
    // §7.3: the files ladder (see `evidence` below for its fallback).
    import("@/lib/handoffLadder").then((m) => m.handoffLadderFor(project.id)).catch(() => null),
    gapsForProject(project.id).catch(() => []),
    fieldReportsForProject(project.id).catch(() => []),
    // §7.5 / §6.8: each video's own brief (which ones show is decided below).
    videoOrderedRow ? outputBriefsFor(project.id, { scrub: true }).catch(() => [] as OutputBrief[]) : Promise.resolve([] as OutputBrief[]),
  ]);
  const trail = submissionTrail(
    trailRows.map((a) => ({ type: a.type, body: a.body, createdAtISO: a.createdAt.toISOString() })),
    { photographerName: project.photographer?.name ?? null, submittedAtISO: project.debriefSubmittedAt?.toISOString() ?? null },
  );
  // The office edits a record; the photographer finishes a job — the portal
  // words its reopen button for each (Sep 15). OPEN mode (no session) reads
  // as the office, the same way the list page does.
  const viewerIsOffice = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN";

  const street = streetOf(project.title);
  const addOns: ShootAddOn[] = addOnTasks.map((t) => ({
    id: t.id,
    item: itemFromTaskTitle(t.title, street),
    note: t.description,
    addedBy: t.contactName,
    addedAtISO: t.createdAt.toISOString(),
    handled: t.status === "COMPLETED",
  }));

  // Who logged it: the office card the same action minted carries the name
  // (SmartTask.contactName), and the two are joined by the dedupe key the item
  // name slugifies to — nothing is stored twice.
  const addOnByKey = new Map(addOnTasks.map((t) => [t.dedupeKey ?? "", t.contactName]));
  const extraShoots: AdditionalShootRow[] = extraShootRows.flatMap((d) => {
    if (!isAdditionalVideoType(d.type) || !d.capturedAt) return [];
    const key = shootAddonKey(project.id, additionalShootItem(d.type, etDayKey(d.capturedAt)));
    return [{
      id: d.id,
      type: d.type,
      label: d.label ?? additionalShootLabel(d.type, etDayKey(d.capturedAt)),
      shotOnISO: d.capturedAt.toISOString(),
      uploadedISO: d.uploadedAt?.toISOString() ?? null,
      addedBy: addOnByKey.get(key) ?? null,
      addedAtISO: d.createdAt.toISOString(),
      hasWork: d._count.uploads > 0 || d._count.reviewSubmissions > 0,
    }];
  });
  // "This job has left the upload portal" — the hub's own definition
  // (uploadHistory.UPLOAD_PENDING_WHERE), so the card that offers a way back in
  // appears on exactly the jobs that have no other way back in.
  const leftThePortal =
    !(UPLOAD_PENDING_STATUSES as string[]).includes(project.status) || project.debriefSubmittedAt != null;

  // ONE policy source for everything this page says about photo counts — the
  // enforcement target, the display range, and which regime produced them
  // (override / legacy / SOP), so the chip can never contradict the sweep.
  const photoPolicy = photoPolicyFor(project);
  const photoTarget = photoPolicy.target;
  // F12: the content-program topics this session is for. Null on an ordinary
  // listing shoot, which has no month and no topic bank.
  //
  // R02 (external review, Sep 28 2026): a list that FAILED to load is not a
  // job with no list. This was `.catch(() => null)`: the page then dropped the
  // stored draft's topic ticks (nothing to match them against), its next
  // autosave wrote [] over them even once the database was healthy, the count
  // box replaced the topics, and the submit sent no filming report at all. Now
  // the page is told the list is UNKNOWN (topicsUnavailable, content jobs only
  // — a listing shoot has no list to lose): it keeps the stored ticks exactly
  // as saved, says so, and holds the video half until a reload brings the list.
  // (Read in the parallel round above.)
  const session = topicsRead.ok ? topicsRead.session : null;
  if (!topicsRead.ok) console.warn(`[upload-page] topic list unreadable for ${project.id}: ${topicsRead.error}`);
  // CP-09 (batch C): each topic's raw folder, where it is TODAY (the folder
  // engine may have moved the listing since it was made), and — when the
  // photographer's last report has not landed yet — what that report said, so
  // the reopened page shows their answer instead of a blank one. Re-sending it
  // unchanged is the same report (payloadHash), not a second one.
  const { topicFolderLinksFor } = await import("@/lib/dropboxFolders");
  // The two reads that need the session run together (Oct 5).
  const [topicFolders, pendingRead] = await Promise.all([
    session
      ? topicFolderLinksFor(project.id).catch(() => new Map<string, { label: string; path: string; url: string }>())
      : Promise.resolve(new Map<string, { label: string; path: string; url: string }>()),
  // R02 follow-up (Sep 28 2026): this read was `.catch(() => null)` too — the
  // same catch-to-empty the repair took out of the list read above.
  // A report the session SAYS is pending, whose own row could not be read,
  // became "ticked nothing, no extras" on a page that loaded fine and showed no
  // warning; the next autosave stored that as the draft's answer, and every
  // later render restored it over the report's. What the report said is
  // unknown, so the page is treated exactly like a list that did not load:
  // topicsUnavailable, the reload banner, the video half held, and no topic
  // answer in the draft.
    session?.pendingReport
      ? prisma.contentFilmingReport
          .findUnique({ where: { id: session.pendingReport.id }, select: { topicIdsJson: true, extrasJson: true } })
          .then(
            (row) => ({ ok: true as const, row }),
            (e: unknown) => ({ ok: false as const, error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300) }),
          )
      : Promise.resolve(null),
  ]);
  // A row that vanished between the two reads is no more known than one that
  // failed: nothing may be said about what the photographer ticked.
  const pendingUnknown = !!session?.pendingReport && (!pendingRead?.ok || !pendingRead.row);
  if (pendingUnknown) {
    console.warn(`[upload-page] pending filming report unreadable for ${project.id}: ${pendingRead && !pendingRead.ok ? pendingRead.error : "the row was not found"}`);
  }
  const pendingRow = pendingRead?.ok ? pendingRead.row : null;
  const topicsUnavailable = (!topicsRead.ok || pendingUnknown) && !!project.contentMonthId;
  const parsed = <T,>(s: string | null | undefined, fallback: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  // Unavailable = no list handed to the portal at all (not a list with an
  // empty report): the portal's one "unknown" path then holds everything.
  const sessionTopics = session && !topicsUnavailable
    ? {
        owed: session.owed,
        topics: session.topics.map((t) => {
          const folder = topicFolders.get(t.topicId);
          return {
            topicId: t.topicId, title: t.title, pillarName: t.pillarName, scriptTitle: t.scriptTitle,
            clientApproved: t.clientApproved, filmedConfirmedAtISO: t.filmedConfirmedAtISO, filmedConfirmedBy: t.filmedConfirmedBy,
            // CP-09: which session confirmed it — the page pre-ticks only its own.
            confirmedOnProjectId: t.confirmedOnProjectId,
            overflow: t.overflow,
            note: t.note,
            folder: folder ? { label: folder.label, url: folder.url } : null,
          };
        }),
        pending: session.pendingReport
          ? {
              state: session.pendingReport.state,
              topicIds: parsed<unknown[]>(pendingRow?.topicIdsJson, []).filter((x): x is string => typeof x === "string"),
              extras: parsed<{ title?: unknown; note?: unknown }[]>(pendingRow?.extrasJson, [])
                .filter((x) => typeof x?.title === "string" && !!(x.title as string).trim())
                .map((x) => ({ title: x.title as string, note: typeof x.note === "string" ? x.note : "" })),
            }
          : null,
      }
    : null;
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
  // Tier comes from the SETTINGS product mapping (videoTier() reads the label
  // itemToDeliverables stamped from Product.videoTier), so "Premium Video" and
  // anything else Jordan maps premium follows the premium rules automatically.
  // Sep 2: premium is shot S-Log3 / D-LogM and gets every instruction field;
  // standard is an iPhone reel and gets one editing-instructions box.
  const isPremium = videoTier(liveDeliverables) === "premium";
  // Resolved ONCE here and handed to the portal, never re-derived from a name
  // — and the submit gate and the handoff engine ask the same function.
  const resolved = resolveVideoSpec({
    deliverables: project.deliverables,
    orderItems: project.orderItems,
    packageName: project.packageName,
    isPremium,
  });
  const videoStyle: VideoStyleKey = resolved.style;
  const videoSpec: VideoStepSpec = resolved.spec;

  // O04: this viewer's unsent answers (read in the parallel round above).
  // baseHash: the fingerprint the draft was typed against (review, Sep 25). A
  // restored draft submits with IT, not this page's, so a job that moved
  // underneath it — Kyle's Editing Room edit, an office submit — is refused
  // and named instead of being overwritten by answers typed before it.
  let draft: { revision: number; payload: DraftPayload; savedAtISO: string; baseHash: string | null } | null = null;
  if (draftRow && !draftRow.consumedAt) {
    let payload: DraftPayload | null = null;
    try { payload = normalizeDraftPayload(JSON.parse(draftRow.payloadJson)); } catch { payload = null; }
    if (payload && draftHasContent(payload)) draft = { revision: draftRow.revision, payload, savedAtISO: draftRow.savedAt.toISOString(), baseHash: draftRow.baseHash };
  }
  // The revision a fresh page saves onto: the open draft's, or none.
  const draftRevision = draftRow && !draftRow.consumedAt ? draftRow.revision : null;
  // §7.3: what is actually true about the files, half by half — the SAME read
  // the edit tracker and the project summary print (lib/handoffLadder), so the
  // portal says "upload reported / files found in Dropbox / handed off …" in
  // their words, rung for rung (Sep 28). Should that read fail, the pure
  // reader on this page's own rows still answers — the same words, without
  // the "editing started" and "cuts handed in" rungs only that read knows.
  const evidence = (
    ladder ??
    handoffEvidence({
      deliverables: project.deliverables,
      statusEvidence: project.statusEvidence,
      photosHandoffAt: project.photosHandoffAt,
      videoHandoffAt: project.videoHandoffAt,
      debriefSubmittedAt: project.debriefSubmittedAt,
      handoffReadyAt: project.handoffReadyAt,
      handoffBlockedReason: project.handoffBlockedReason,
    })
  ).map(evidenceView);
  // §7.6 / §7.8: the job's production gaps and field reports. A gap's words
  // are the office's as often as the field's (a limitation off a brief, a
  // reshoot's scope), so anyone but the office gets them money-scrubbed, like
  // the briefs below (review, Sep 28). The office keeps the raw words: its
  // Plan form is filled from them and saves them back, so the gate is the one
  // that shows that form (viewerIsOffice).
  const gaps = viewerIsOffice ? gapsRaw : await gapsForCreatives(gapsRaw).catch(() => []);
  const fieldReports = fieldReportRows.map((f) => ({
    id: f.id, body: f.body, status: f.status, scope: f.scope, basis: f.basis, createdAtISO: f.createdAt.toISOString(),
  }));

  // Video jobs: pull the shoot script from Script Studio (freshness-gated,
  // never blocks the page on a dead Studio) so the photographer confirms the
  // words the agent actually read. NOT on a content session (Oct 5): its
  // scripts come from the program (the topic list), never from Studio, and
  // the pull was a network round trip on every open of the page for nothing.
  let scriptBody = project.reelScript;
  let scriptHook = project.reelHook;
  let scriptUrl = project.reelScriptUrl;
  // The script the fingerprint below is taken over — the stored one after any pull.
  let hashScript = project.reelScript;
  if (videoOrdered && !project.contentMonthId) {
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
        if (fresh) hashScript = fresh.reelScript;
      }
    } catch { /* Studio down → the page still works with what's stored */ }
  }

  // O04: the fingerprint of what is SUBMITTED right now — a re-submit that
  // would write over somebody else's later edit is refused with it. Taken
  // AFTER the Studio pull above (review, Sep 25): taken before it, a pulled
  // script made the page's own next submit read as "somebody changed the
  // notes" when nobody had.
  const baseHash = submittedFieldsHash({
    editorBrief: project.editorBrief, videoInstructions: project.videoInstructions, removalNotes: project.removalNotes,
    shotOrderNotes: project.shotOrderNotes, reelScript: hashScript, scriptConfirmNote: project.scriptConfirmNote,
    videosFilmed: project.videosFilmed,
  });

  // §7.5 / §6.8 (Sep 28): each video's own brief, the rows the editor's page,
  // the printed brief and the shoot screen read — money-scrubbed, because this
  // is a creative's page whoever opens it. WHICH ones this page shows:
  //   · a listing job with two or more videos (a reel and an MLS film): every
  //     one, each with its own brief or the plain "goes by the job's
  //     instructions", so a note can be added to the one it is about;
  //   · a one-video job: only once it has a brief of its own. Until then the
  //     instructions box below IS that video's brief (the batch-4 law);
  //   · a content session: only the videos the office briefed one by one. The
  //     rest are directed through the topic list and its notes further down.
  // A content session whose topic list did not load is still a content
  // session: its videos are directed through that list, not one by one.
  const shownBriefs = session || topicsUnavailable
    ? allBriefs.filter((b) => b.directionSource === "own")
    : allBriefs.length > 1 || allBriefs.some((b) => b.directionSource === "own")
      ? allBriefs
      : [];
  // A preview writes nothing (the action refuses it too, enforced or not).
  const briefNoteBlocked = viewer?.impersonating ? "You're previewing as someone else, so notes can't be added from here." : null;

  // The page's one clock reading, handed down (a render must not read the clock twice).
  const renderedAt = new Date();

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4"><BackLink href="/upload" label="All shoots" /></div>

      <UploadPortal
        sessionTopics={sessionTopics}
        topicsUnavailable={topicsUnavailable}
        foldersSlot={<DropboxFolders state={folderState} photoTarget={photoTarget} photosOrdered={photosOrdered} />}
        handoffFolders={folderState?.folders.filter((f) => f.key === "rawPhotos" || f.key === "rawVideo").map((f) => ({ key: f.key, label: f.label, url: f.url })) ?? []}
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
          debriefSubmittedAt: project.debriefSubmittedAt?.toISOString() ?? null,
          photosHandoffAt: project.photosHandoffAt?.toISOString() ?? null,
          photosHandoffBy: project.photosHandoffBy,
          videoHandoffAt: project.videoHandoffAt?.toISOString() ?? null,
          videoHandoffBy: project.videoHandoffBy,
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
          waivedAt: d.waivedAt?.toISOString() ?? null,
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
        submission={{
          submittedBy: trail.submittedBy,
          lastEdited: trail.lastEdited,
          addOns: addOns.map((a) => ({ item: a.item, note: a.note, addedBy: a.addedBy, handled: a.handled })),
          files: project.uploads.map((u) => ({ name: u.originalName, size: u.size })),
        }}
        viewerIsOffice={viewerIsOffice}
        payGateFromMs={DEBRIEF_PAY_GATE_FROM}
        draft={draft}
        draftRevision={draftRevision}
        canSaveDraft={canSaveDraft}
        baseHash={baseHash}
        evidence={evidence}
        gaps={gaps}
        fieldReports={fieldReports}
        nowMs={renderedAt.getTime()}
        outputBriefs={shownBriefs.map(portalBriefOf)}
        onBriefNote={addOnSiteBriefNote}
        briefNoteBlocked={briefNoteBlocked}
        briefNoteCap={ON_SITE_NOTE_CAP}
      />

      {/* Anything the agent added on site that the order doesn't know about —
          becomes one task for the office to add the item to the Aryeo order. */}
      <AddedAtShoot projectId={project.id} initial={addOns} />

      {/* The way back in for a job that has already left the portal: a second
          reel or video filmed on another day joins THIS job as its own video.
          Hidden while the job is still a live to-do — the checklist above is
          the place for footage from the shoot it was booked for. */}
      {leftThePortal && (
        <AdditionalShoot
          projectId={project.id}
          initial={extraShoots}
          todayKey={etDayKey(new Date())}
          minKey={project.shootDate ? etDayKey(project.shootDate) : ""}
          jobShootISO={project.shootDate?.toISOString() ?? null}
          delivered={project.deliveredAt != null}
        />
      )}

      {/* How the shoot went — client issues, anything we should change on our
          end. Routes to Kyle + the feedback board when it wasn't smooth. */}
      <AppointmentFeedback projectId={project.id} />

    </div>
  );
}

/** One video's brief as the portal carries it: plain, serialisable, already money-scrubbed. */
function portalBriefOf(b: OutputBrief): PortalOutputBrief {
  return {
    outputId: b.outputId,
    index: b.index,
    label: b.label,
    format: b.format,
    topicTitle: b.topicTitle,
    version: b.version,
    versionLabel: b.versionLabel,
    updatedBy: b.updatedBy,
    updatedAtISO: b.updatedAtISO,
    directionSource: b.directionSource,
    sections: b.sections.map((s) => ({ key: s.key, label: s.label, text: s.text })),
  };
}

// ---------------------------------------------------------------------------
// §7.5 / §6.8 (Sep 28 2026): the photographer's on-site note on ONE video's
// brief, from this page. Who may: the shoot's own photographer or the office
// (requireShootAccess, fail-closed once auth is enforced); never a "view as"
// preview, enforced or not; never an editor. Signed with the person's display
// name (lib/actorName: login name, then roster, then email) and added through
// deliverableOutputs.addOnSiteNote, so it is a new version of that brief with
// the same refusals the office's own save has. It answers with the video's
// brief as it now reads, money-scrubbed. Nothing here is sent to anybody, and
// no client surface reads a brief.
// ---------------------------------------------------------------------------
async function addOnSiteBriefNote(projectId: string, outputId: string, note: string): Promise<BriefNoteResult> {
  "use server";
  const pid = String(projectId ?? "").trim().slice(0, 64);
  const oid = String(outputId ?? "").trim().slice(0, 64);
  // Well past the note cap, so an over-long note still reaches addOnSiteNote's own "too long" answer.
  const text = String(note ?? "").slice(0, 4000);
  const refuse = (message: string): BriefNoteResult => ({ ok: false, changed: false, message, brief: null });
  if (!pid || !oid) return refuse("That video could not be found. Reload the page and try again.");
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return refuse("You're previewing as someone else, so notes can't be added from here.");
  try {
    const { requireShootAccess } = await import("@/lib/auth/guards");
    await requireShootAccess(pid);
  } catch (e) {
    return refuse((e as Error).message || "You don't have access to that shoot.");
  }
  const { displayNameFor } = await import("@/lib/actorName");
  const actor = (await displayNameFor(me)) || "the photographer";
  const dout = await import("@/lib/deliverableOutputs");
  const res = await dout.addOnSiteNote({ outputId: oid, projectId: pid, note: text, actor }).catch(() => null);
  if (!res) return refuse("Couldn't save the note. Try again in a moment.");
  if (res.ok && res.changed) for (const p of [`/upload/${pid}`, `/edit/${pid}`, `/shoot/${pid}`]) revalidatePath(p);
  const now = await dout
    .outputBriefsFor(pid, { scrub: true })
    .then((all) => all.find((b) => b.outputId === oid) ?? null)
    .catch(() => null);
  return {
    ok: res.ok,
    changed: res.ok && res.changed,
    message: res.ok
      ? res.changed
        ? `Added to the brief. It is now v${res.version}.`
        : "That note is already on the brief, so nothing changed."
      : res.message,
    brief: now ? portalBriefOf(now) : null,
  };
}

function DropboxFolders({
  state,
  photoTarget,
  photosOrdered = true,
}: {
  state: Awaited<ReturnType<typeof getProjectFolderState>>;
  photoTarget: number;
  /** false on a video-only job (a monthly content session): no Backup Photos */
  photosOrdered?: boolean;
}) {
  if (!state) return null;
  const iconFor = (label: string) => (/video/i.test(label) ? Video : ImageIcon);

  // Photographers see the folders THEY use: Raw Photos, Raw Video, Backup
  // Photos. The Final folders are the editors' side — removed per Jordan.
  // A video-only job has no culled photo extras, so no Backup Photos (Oct 5).
  const shown = state.folders.filter((f) => f.key !== "finalPhotos" && f.key !== "finalVideo" && (photosOrdered || f.key !== "backupPhotos"));

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
