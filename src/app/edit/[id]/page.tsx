import { videoNavigationFor } from "@/lib/videoNavigation";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle, ChevronDown, Film, FileVideo, FolderOpen, Palette, MessageSquare, ExternalLink, PlayCircle, Quote,
} from "lucide-react";
import { EXPORT_SPEC, VIDEO_TIER, VIDEO_TYPES, defaultMakeThis, makeThisFor, videoStyleByKey, videoStyleFor, videoTypeForDeliverable } from "@/lib/videoStyles";
import { listClientAssets } from "@/lib/clientAssets";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";
import { BrandUpdatesBanner } from "@/components/editing/BrandUpdatesBanner";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { queueReturnHref } from "@/lib/editingQueueUrl";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Action";
import { getProject, getTeam } from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced, canViewProject } from "@/lib/auth/guards";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
// Oct 5: the brief's own script block (no "(empty)" sections, one Copy), the
// one-per-job "Got it", the Agent Profile and the live due countdown.
import { BriefScript } from "@/components/editing/BriefScript";
import { BriefGotIt } from "@/components/editing/BriefGotIt";
import { AgentProfileCard } from "@/components/clients/ClientProfileCard";
import { SlaCountdown } from "@/components/editing/SlaCountdown";
import { EditInstructionsCard } from "@/components/editing/EditInstructionsCard";
import { MusicCard } from "@/components/editing/MusicCard";
import { epidemicSoundConnected } from "@/lib/integrations/epidemicSound";
import { parseEditSpec, musicPickLine, musicPickOf } from "@/lib/musicPick";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { EditorCutPanel } from "@/components/editing/EditorCutPanel";
import { CutUploader } from "@/components/editing/CutUploader";
// The server's own answer to "may this viewer replace the approved cut on this
// slot" — the panel draws the door from it rather than guessing (Sep 18).
import { canReplaceApprovedCut } from "@/app/review/actions";
// §7.5 / §7.7: the per-video brief and the Luma Visuals packet record, posted
// from plain server-rendered forms on this page.
import { recordEditorPacketAckForm, recordEditorPacketSentForm, saveVideoBriefForm } from "@/app/editing/actions";
// §7.6: a limitation on one video's brief becomes missing work in one press.
import { raiseGapFromBriefForm } from "@/app/editing/gapActions";
import { etDate } from "@/lib/datetime";
import { autoSyncScript } from "@/lib/scriptSync";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus, videoTier } from "@/lib/projectStatus";
// §8.2: the Final-folder submit and the held cuts both go through the check.
import { FolderSendForReview, HeldCutsCard } from "@/components/editing/SelfCheckSend";
import { RevisionIssuesPanel, type AttestationView } from "@/components/editing/RevisionIssuesPanel";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { EditTracker, deriveEditStage, type RoundRow } from "@/components/editing/EditTracker";
// §7.1: the editor's own Start / Pause / Resume, on the screen they work from.
import { WorkStateBar } from "@/components/editing/WorkStateBar";
// §8.1: the ONE person each waiting cut is waiting on, and the desk's doors.
import { ReviewerStrip } from "@/components/review/ReviewerStrip";
import { EditOverridesButton, RushButton } from "@/components/editing/EditOverridesDialog";
// §10 J3: the office's "waiting on a file" card (a plat, a logo).
import { AssetDependencyCard } from "@/components/editing/AssetDependencyCard";
import { computedView, computedVideosOwed, effectiveDue, effectiveTypeDetail, overrideView } from "@/lib/editOverrides";
import { STATUS_LABEL } from "@/lib/editorQueue";
import { DEFAULT_EDITOR_TZ, editorKeyForTeamName, editorMeta } from "@/lib/editors";
import { openSlotKeys as openSlotKeysFor } from "@/lib/editorDesk";
import { RevisionBriefCard } from "@/components/editing/RevisionBriefCard";
import { getRevisionBriefs } from "@/lib/revisionBrief";
import { aryeoCustomerNote } from "@/lib/shoot";
// Per-CLIENT note (the merged, Aryeo-mirrored one) — distinct from
// aryeoCustomerNote just above, which is the note on THIS order.
import { getEditorFeedback } from "@/lib/reviewRoom";
import { slugForName } from "@/lib/assignees";
import { refinedDeliverableLabel, isMonthlyContentJob, videoTypeLabel } from "@/lib/pipeline";
import { stripMoneySentences } from "@/lib/text";
import { prisma } from "@/lib/prisma";
// Who ruled on each version, and when (Review Room attribution, Sep 28).
import { officeReopenOf, verdictLine, verdictOf } from "@/lib/reviewAttribution";
import { ActivityType } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";
// The Music card's "Download to the job folder" action posts to this segment:
// a signed-MP3 fetch plus a Dropbox upload of up to 60 MB can outrun the
// default function budget (review, Sep 15) — the same ceiling /my-pay and
// /sales use.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Style KEY ↔ Style Guide type. The keys are the shared contract that
// Product.videoStyle and Deliverable.videoStyle are written in at sync (Sep 2
// 2026) — the product NAME on the Aryeo order line ("Photography and Standard
// Reel w/ Agent intro") used to be thrown away, leaving only the category
// ("Social Reel"), so every video read as a plain Standard Reel here. The Guide
// (src/lib/videoStyles.ts) has no separate premium cinematic entry yet, so that
// key borrows the premium reel's notes rather than rendering blank.
// ---------------------------------------------------------------------------
const STYLE_KEY_TO_TYPE: Record<string, string> = {
  standard_reel: "Standard Reel",
  standard_reel_agent_intro: "Standard Reel with Agent Intro",
  standard_cinematic: "Standard Cinematic Video",
  personal_branding: "Personal Branding Reel",
  premium_social_reel: "Premium Social Media Reel",
  premium_cinematic: "Premium Social Media Reel",
};
const TYPE_TO_STYLE_KEY: Record<string, string> = {
  "Standard Reel": "standard_reel",
  "Standard Reel with Agent Intro": "standard_reel_agent_intro",
  "Standard Cinematic Video": "standard_cinematic",
  "Personal Branding Reel": "personal_branding",
  "Premium Social Media Reel": "premium_social_reel",
};
// Same-page sections use native fragments so repeated jumps keep one hash.
const BRIEF_SECTION_LINK = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold leading-snug whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
// "Standard Reels don't get scripts" (Jordan, Sep 2): the agent-intro reel has
// an intro script, and every premium and personal-branding cut is scripted; a
// plain standard reel or cinematic is B-roll to music, so the Script card —
// and its "No script on file yet" warning — would only send the editor
// waiting for words that are never coming.
const SCRIPTED_STYLE_RE = /^(standard_reel_agent_intro|premium_|personal_branding)/;

// The EDITOR's brief screen for one job. Creative-safe: no pricing or
// financials — but a client-approved script is never cut for mentioning a
// price (a real-estate script talks about prices; see lib/text).
//
// Read top to bottom as ONE selected video (Oct 5 2026 — the order and the
// reasons are spelled out above the render below): header, Make this,
// Script, Footage, Brand, Client, Music, Changes to make; then Send to Review
// and the team messages; everything else folded; the office's writing tools
// last. Earlier orderings (Sep 2: media first, "What to make" above the
// instructions, the client rail) are folded into it: the footage link is the
// Footage section's one link, the style guide is folded at the end, and the
// client's own words now sit in the brief instead of under the chat.
export default async function EditBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string; output?: string; slots?: string; notice?: string; queue?: string }>;
}) {
  const { id } = await params;
  // `slots=all` opens the empty cut slots a big job collapses by default
  // (Jordan, Sep 16 — see the Send to Review block below).
  const { cut, output: outputParam, slots: slotsParam, notice, queue } = await searchParams;
  const showAllSlots = slotsParam === "all";

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
  // This contextual route is not scoped by middleware. Check the effective
  // viewer (including "view as") before the script sync or any job read.
  if (!(await canViewProject(id, viewer))) notFound();

  // Scripts sync THEMSELVES from the Script Writing platform (by this project
  // id) — cheap freshness gate inside; run before getProject so a just-pulled
  // script renders on this very load. Owner preview is read-only: even this
  // background refresh can replace saved words and stamp sync timestamps.
  if (!viewer?.impersonating) await autoSyncScript(id);

  const [project, team, submissions] = await Promise.all([
    getProject(id),
    getTeam(),
    prisma.reviewSubmission.findMany({
      where: { projectId: id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
      orderBy: { round: "asc" },
      // decidedBy: who sent the cut back, named on the revision block (Sep 16).
      // sourceWidth/Height: what the version actually was (Sep 16, the 1080p
      // export spec) — printed on its Send-to-Review row.
      // clientRequestedAt/By (Sep 28, gap 1): a client's send-back on an
      // approved cut keeps the office's decidedAt/By — without these the
      // revision block named the approver as the sender.
      select: { id: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, submittedByName: true, note: true, createdAt: true, decidedAt: true, decidedBy: true, clientRequestedAt: true, clientRequestedBy: true, deliverableId: true, slot: true, source: true, blobUrl: true, completedAt: true, sourceWidth: true, sourceHeight: true },
    }),
  ]);
  if (!project) notFound();
  // The brief is long and the conversation is near its end. A read-only cue
  // gives the editor a direct path without advancing ThreadRead just because
  // they opened the brief to inspect footage or download a file.
  let unreadTeamMessages: number | null = 0;
  if (viewer && !viewer.impersonating && project.messages.length > 0) {
    try {
      const receipt = await prisma.threadRead.findUnique({
        where: { userKey_projectId: { userKey: viewer.id, projectId: id } },
        select: { seenAt: true },
      });
      unreadTeamMessages = project.messages.filter((m) => !receipt || m.createdAt > receipt.seenAt).length;
    } catch {
      unreadTeamMessages = null;
    }
  }

  // The cuts this job owes (deliverable × slot) with the newest version of
  // each — the editor's upload panel and the cut switcher both hang off it.
  const { cutSlots, videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(id);
  const { owedSlotKeyOf } = await import("@/lib/reviewCuts");
  const cutKeyOf = (s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string }) =>
    owedSlotKeyOf(s, slots.map((slot) => `${slot.deliverableId}:${slot.slot}`)) ?? (s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : (s.assetPath ?? s.id));

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
  // §8.2 / §8.3 (Sep 25): the send-for-review checklist per video, the cuts
  // waiting on a check, and the job's revision issues — read BY THE JOB, so an
  // editor who inherits it sees what the last one was asked. Reviewers
  // (owner/admin or a named review seat) also get the controls and the checks
  // each version came in with. Each read fails soft: the page never breaks
  // over its own quality bookkeeping.
  const quality = await (async () => {
    const { checkContextsForProject, heldCutsFor, attestationFor } = await import("@/lib/selfCheckStore");
    const { issuesForProject } = await import("@/lib/revisionIssues");
    let canReview = strictOwnerAdmin && !viewer?.impersonating;
    if (!canReview && viewer && !viewer.impersonating) {
      try {
        const { canRuleOnCuts } = await import("@/lib/reviewerAssignment");
        canReview = (await canRuleOnCuts(viewer)).ok;
      } catch { /* not a review seat */ }
    }
    const [checks, held, issues] = await Promise.all([
      checkContextsForProject(id).catch(() => ({})),
      heldCutsFor(id).catch(() => []),
      // Off the desk (an editor), a cause verdict shows on their own versions
      // only, and no reviewer history leaves the server (§8.4).
      issuesForProject(id, { scrub: !strictOwnerAdmin, viewer: canReview ? null : { editorKey: editorScope } }).catch(() => []),
    ]);
    const attestations: AttestationView[] = [];
    if (canReview) {
      for (const s of submissions.filter((x) => x.status !== "WITHDRAWN")) {
        const a = await attestationFor(s.id).catch(() => null);
        if (!a) continue;
        const slotLabel = slots.find((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(s))?.label ?? s.fileName ?? "Video";
        attestations.push({
          submissionId: s.id, round: s.round, label: slotLabel, actorName: a.actorName, onBehalfOf: a.onBehalfOf, atISO: a.at.toISOString(), checklistKey: a.checklistKey,
          notApplicable: a.items.filter((i) => i.answer === "NA").map((i) => ({ label: i.label, reason: i.reason })),
          notAddressed: Object.entries(a.declarations.notAddressed).map(([issueId, reason]) => ({ text: issues.find((i) => i.id === issueId)?.summary ?? issues.find((i) => i.id === issueId)?.text ?? "an earlier note", reason })),
        });
      }
    }
    // Whom the office is checking for when it uploads (vendor / editor cuts).
    let onBehalfOf: string | null = null;
    if (strictOwnerAdmin) {
      const card = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${id}` }, select: { assignedKey: true } }).catch(() => null);
      onBehalfOf = editorMeta(card?.assignedKey)?.name ?? "the editor or vendor who made it";
    }
    return { checks, held, issues, attestations, canReview, onBehalfOf };
  })();
  // The client's asset shelf (logos, endcards, brand kit) — folder truth from
  // Dropbox; editors upload here too.
  const assets = await listClientAssets(project.client.id).catch(() => null);
  // The job's spec JSON — the office's Luma-form fields plus, since Sep 15,
  // the Epidemic Sound pick under `music` (src/lib/musicPick.ts).
  const editSpec = parseEditSpec(project.editSpec);
  const musicPick = musicPickOf(editSpec);
  // Is the music catalogue wired? Owner/admin see the card either way (with a
  // "connect it" note until the key is in); editors only once it works.
  const musicConnected = await epidemicSoundConnected().catch(() => false);
  const folders = actualFolderPaths(project); // the job's OWN folder, not the convention path (audit, Sep 8)
  const rawUrl = dropboxWebUrl(folders.rawVideo);
  // The pick's "Open in Dropbox" link, built here (dropboxFolders is
  // server-only) from the path the download recorded, so it survives a
  // reload instead of living only in the session that clicked Download
  // (review, Sep 15).
  const musicPickUrl = (() => {
    const p = musicPick?.dropboxPath;
    if (!p) return null;
    const cut = p.lastIndexOf("/");
    return cut > 0 ? `${dropboxWebUrl(p.slice(0, cut))}?preview=${encodeURIComponent(p.slice(cut + 1))}` : dropboxWebUrl(p);
  })();
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
    // The legs and the office's tier (B2 handover, Sep 16): a second-visit reel
    // dates from the visit that shot it, and Personal Branding runs on the
    // 7–10 business-day clock — the header must not read the 48h video rule.
    appointments: project.appointments,
    tierOverride: project.tierOverride,
    packageName: project.packageName,
    deliverables: project.deliverables.filter((d) => !d.removedFromOrderAt),
    client: { socialClient: project.client.socialClient },
  });

  // Owed rows only — an item removed from the Aryeo order is not work to edit
  // (the project page still shows it, dimmed, as history).
  const owedDeliverables = project.deliverables.filter((d) => !d.removedFromOrderAt);
  const videoDeliverables = owedDeliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const editDeliverables = videoDeliverables.length ? videoDeliverables : owedDeliverables;
  // Which STYLE each video is cut in. Deliverable.videoStyle is resolved at
  // sync from the Aryeo product ("Standard Reel with Agent Intro" →
  // standard_reel_agent_intro) and is the truth when present. Rows synced
  // before the column existed fall back to what this page always inferred:
  // the label's own signal (the Guide's regex read — "intro", "premium",
  // "cinematic", monthly plan) with the deadline's tier verdict on top, so a
  // premium job never reads as standard just because its label is generic.
  const monthly = isMonthlyContentJob(project.deliverables);
  const tier = videoTier(owedDeliverables);
  const videoStyleOf = (d: { label: string | null; videoStyle: string | null }): string => {
    if (d.videoStyle) return d.videoStyle;
    const byLabel = TYPE_TO_STYLE_KEY[videoTypeForDeliverable(d.label, monthly).name] ?? "standard_reel";
    if (tier === "premium" && byLabel.startsWith("standard")) {
      return byLabel === "standard_cinematic" ? "premium_cinematic" : "premium_social_reel";
    }
    return byLabel;
  };
  // The Style Guide entry for that style — notes, examples, hours.
  const videoTypeOf = (d: { label: string | null; videoStyle: string | null }) =>
    VIDEO_TYPES.find((t) => t.name === STYLE_KEY_TO_TYPE[videoStyleOf(d)]) ?? videoTypeForDeliverable(d.label, monthly);
  // The Script card shows when any video's style is a scripted one — or when
  // a script IS on file: words the Studio already wrote for this job outrank
  // the inference, and hiding them would be the worse mistake.
  const scriptOnFile = !!(project.reelHook || project.reelScript);
  const showScript = scriptOnFile || videoDeliverables.some((d) => SCRIPTED_STYLE_RE.test(videoStyleOf(d)));
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
  //
  // ONE PREDICATE, THE SERVER'S (drill, Sep 18). This page used to keep its own
  // — assignedKey null or one of kim/john/remar/luma — against the
  // videoLaneRevisionWhere that startCutUpload, correctedCutSubmitted and the
  // rest of the cut machinery ask. The server's also counts external_agency,
  // also counts a task TITLED "Video revision…" or "New cut…" whatever key it
  // carries, and subtracts the photo-lane dedupe key. comms.raiseRevision pins
  // an ask for the outside shop or Luma onto assignedKey "kyle" while still
  // titling it "Video revision — <address>", so that ask read OPEN on the
  // server and CLOSED here — and the panel then drew the replace-the-approved-
  // video door, took the editor's reason and dropped it on the floor. Seven
  // jobs carry editorVendorKey = external_agency, so the shape is live; no row
  // is sitting in it as this ships. Asking the same question in the same words
  // is the only way the two cannot drift apart again.
  const videoRevisionTasks = await prisma.smartTask.findMany({
    where: videoLaneRevisionWhere(id),
    select: { id: true, createdAt: true, summary: true, description: true, contactName: true, source: true, title: true, reasonCreated: true, outputId: true },
    orderBy: { createdAt: "asc" },
  });
  // THE OFFICE'S OWN REOPEN (the Editing Room's "New cut" queue-add) is not a
  // client's ask — the pill and the tracker say who put it back instead
  // (review, Sep 28). Read from the row's own sentence while it is still the
  // office's; a client's later ask rewrites it.
  const officeReopens = videoRevisionTasks.map((t) => ({ t, office: officeReopenOf(t) }));
  const clientRevisionTasks = officeReopens.filter((x) => !x.office).map((x) => x.t);
  // WHO ASKED (gap 11, Sep 28): the requesters recorded on the clients' asks'
  // work orders, in the order they asked, each once — the office's own reopen
  // rows are not an ask — then whoever in the office put it back. A task whose
  // briefs predate the column falls back to its own person (contactName).
  const revisionAskedBy = await (async () => {
    if (videoRevisionTasks.length === 0) return null;
    const { requesterWords } = await import("@/lib/reviewAttribution");
    const briefs = clientRevisionTasks.length
      ? await prisma.revisionBrief
          .findMany({
            where: { taskId: { in: clientRevisionTasks.map((t) => t.id) }, requestedBy: { not: null }, source: { not: "office" } },
            orderBy: { createdAt: "asc" },
            select: { requestedBy: true, requestedByKind: true },
          })
          .catch(() => [])
      : [];
    const names = briefs.map((b) => requesterWords(b.requestedByKind, b.requestedBy)).filter((x): x is string => !!x);
    const fallback = clientRevisionTasks.map((t) => t.contactName).filter((x): x is string => !!x);
    const office = officeReopens
      .map((x) => (x.office ? requesterWords("OFFICE", x.office.by) ?? "the office" : null))
      .filter((x): x is string => !!x);
    const all = [...new Set([...(names.length ? names : fallback), ...office])];
    return all.length ? all.join(", ") : null;
  })();
  const revisionOpen = videoRevisionTasks.length > 0;
  // Every open ask on the video lane is the office's reopen: the approved
  // cut's pill says who reopened it, not "client asked for changes".
  const officeReopen = revisionOpen && clientRevisionTasks.length === 0 ? officeReopens[officeReopens.length - 1]?.office ?? null : null;
  let rawsLanded = false;
  let folderCounts = { raw: 0, final: 0, stale: false };
  try {
    const ev = project.statusEvidence ? (JSON.parse(project.statusEvidence) as { dropbox?: { rawVideo?: number; finalVideo?: number; stale?: boolean } | null }) : null;
    rawsLanded = (ev?.dropbox?.rawVideo ?? 0) > 0;
    // Same identifiers the Editing Room shows on its rows (Jordan, Sep 2):
    // green when the hourly sweep found files in the folder, hollow when not.
    folderCounts = { raw: ev?.dropbox?.rawVideo ?? 0, final: ev?.dropbox?.finalVideo ?? 0, stale: !!ev?.dropbox?.stale };
  } catch { /* evidence is best-effort */ }
  // A WITHDRAWN row (Sep 16) is history, not a version in play: the editor
  // pulled it back. It still lists in the round history, struck through, and
  // the Send-to-Review row still carries its "v1 withdrawn" state — but the
  // page never OPENS on one, and the cut still owing work is the newest round
  // that wasn't taken back (a bounced v1 under a withdrawn v2 is the job
  // again). Guarded on the string so this reads correctly whether or not a
  // withdrawal has been recorded yet.
  const isLive = (s: { status: string }) => s.status !== "WITHDRAWN";
  const liveSubs = submissions.filter(isLive);
  const latestRound = submissions.length ? submissions[submissions.length - 1] : null;
  // The cut panel (editor's side of the review): pick the active cut like the
  // owner's workspace does — ?cut=<id> wins, else the newest PENDING/bounced
  // one, else the latest round. Multi-video jobs get a switcher (one chip per
  // video file, latest round each) so the editor works each cut's notes with
  // its own player — same convention as /review/[id].
  const latestPerCut = new Map<string, (typeof submissions)[number]>();
  for (const s of submissions) latestPerCut.set(cutKeyOf(s), s); // round-asc → latest wins
  const currentCuts = [...latestPerCut.values()];
  // The same map with the taken-back rounds skipped — what the cut still owes.
  const latestLivePerCut = new Map<string, (typeof submissions)[number]>();
  for (const s of liveSubs) latestLivePerCut.set(cutKeyOf(s), s);
  const slotOf = (s: (typeof submissions)[number]) =>
    slots.find((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(s)) ?? null;
  const slotLabelOf = (s: (typeof submissions)[number]) => slotOf(s)?.label ?? null;
  // WHICH of the job's cuts this is — "cut 1 of 16". The position in the owed
  // list, not the slot number, so a job with several deliverables still counts
  // straight through (Jordan, Sep 16: one bounced cut inside sixteen identical
  // slots named nothing at all).
  const cutIndexOf = (s: (typeof submissions)[number]) => {
    const i = slots.findIndex((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(s));
    return i === -1 ? null : i + 1;
  };
  const selectedOutput = outputParam ? await prisma.deliverableOutput.findFirst({ where: { id: outputParam, projectId: project.id, waivedAt: null, removedFromOrderAt: null }, select: { deliverableId: true, slot: true } }) : null;
  const requestedCut = cut ? submissions.find((submission) => submission.id === cut) : null;
  const selectedSlot = requestedCut ? slotOf(requestedCut) : selectedOutput ? slots.find((slot) => slot.deliverableId === selectedOutput.deliverableId && slot.slot === selectedOutput.slot) :
    slots.find((slot) => latestLivePerCut.get(`${slot.deliverableId}:${slot.slot}`)?.status === "CHANGES_REQUESTED") ??
    slots.find((slot) => !latestLivePerCut.has(`${slot.deliverableId}:${slot.slot}`)) ??
    slots.find((slot) => latestLivePerCut.get(`${slot.deliverableId}:${slot.slot}`)?.status === "PENDING") ?? slots[0];
  const selectedKey = selectedSlot ? `${selectedSlot.deliverableId}:${selectedSlot.slot}` : null;
  const activeSub = requestedCut ?? (selectedKey ? latestLivePerCut.get(selectedKey) ?? null : liveSubs[liveSubs.length - 1] ?? latestRound);
  const assetKeyOf = (s: (typeof submissions)[number]) => s.assetUrl ?? `cut:${s.id}`;
  const linkedNoteIds = new Set(quality.issues.filter((issue) => issue.sourceKind === "REVIEW_NOTE" && issue.sourceId).map((issue) => issue.sourceId));
  const notesFor = (s: (typeof submissions)[number]) => feedback.filter((note) => note.assetUrl === assetKeyOf(s) && !linkedNoteIds.has(note.id) && note.kind === "fix" && note.status !== "RESOLVED");
  const activeNotes = activeSub ? notesFor(activeSub) : [];
  // EVERY bounced cut gets its own panel, not just the active one — a link
  // that says "cut 3 of 16" has to land on cut 3 even when cut 1 is the one
  // the page opened on. Ordered the way the job owes them.
  const bouncedCuts = [...latestLivePerCut.values()].filter((submission) => submission.status === "CHANGES_REQUESTED");
  const panelSubs = activeSub ? [activeSub] : [];
  // ONE player on the page: the cut in front of them. Every other panel is
  // notes-only (Sep 16 review — four bounced cuts would otherwise mount four
  // <video> elements and fetch four sets of metadata); they still carry their
  // anchor, and one click makes them the cut in front.
  const playerSubId = activeSub?.id ?? panelSubs[0]?.id ?? null;
  const panelIds = new Set(panelSubs.map((s) => s.id));
  // The cut a revision link must land on: the one in front of them if it is
  // the bounced one, else the first cut waiting on changes.
  const revisionCut = (activeSub?.status === "CHANGES_REQUESTED" ? activeSub : null) ?? bouncedCuts[0] ?? null;
  const revisionHref = revisionCut ? `/edit/${project.id}?cut=${revisionCut.id}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}#cut-${revisionCut.id}` : null;
  // WHO EACH WAITING CUT IS WITH (unified handoff §8.1, Sep 25). Read here so
  // the tracker's "with …" and the strip below say the same name. A failed
  // read shows no strip; nothing on the page waits on it.
  const reviewerStrip = await import("@/lib/reviewerAssignment")
    .then((m) => m.reviewerStripFor(id, viewer, { authEnforced: authEnforced() }))
    .catch(() => null);
  const latestReviewer =
    activeSub?.status === "PENDING"
      ? reviewerStrip?.rows.find((r) => r.submissionId === activeSub.id)?.reviewer?.name ?? null
      : null;
  // WHO IS ON THIS JOB RIGHT NOW (§7.1, Sep 25) — the editor's own Start,
  // not the status. Read-only here: opening this page never starts anything.
  // A failed read shows no bar and the tracker says "not confirmed".
  const workBar = await import("@/lib/editorWork").then((m) => m.workBarFor(id, viewer)).catch(() => null);
  // §7.3: what is true about the footage, rung by rung — the video half of
  // the ladder the project summary prints (lib/handoffLadder, one read, one
  // set of words). A failed read draws no row.
  const footage = await import("@/lib/handoffLadder")
    .then((m) => m.handoffLadderRows(id))
    .then((rows) => rows.filter((r) => r.category === "video"))
    .catch(() => null);
  const { stage, label: statusLine } = deriveEditStage({
    projectStatus: project.status,
    revisionOpen: activeSub?.status === "CHANGES_REQUESTED" || quality.issues.some((issue) => !issue.duplicateOfId && ["OPEN", "REOPENED"].includes(issue.state) && (selectedKey ? issue.cutKey === selectedKey : issue.raisedOnSubmissionId === activeSub?.id)),
    revisionAfterApproval: !!activeSub?.clientRequestedAt && (!activeSub.decidedAt || activeSub.clientRequestedAt > activeSub.decidedAt),
    latestRoundStatus: activeSub?.status ?? null,
    rawsLanded: rawsLanded || submissions.length > 0,
    reviewerName: latestReviewer,
    work: workBar?.stageWork,
    // §8.2: a newest version still waiting on its check is not "in review".
    heldForCheck: !!activeSub && quality.held.some((h) => h.submissionId === activeSub.id),
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
  // Client-originated free text only (Oct 5): the order note, the client's
  // portal boxes, the office's job note. NEVER a script — a client-approved
  // real-estate script talks about prices, and stripMoneySentences now drops
  // only OUR billing language anyway (lib/text).
  const scrub = (s: string | null) => (s == null ? null : canSeeRaw ? s : stripMoneySentences(s) || null);
  const showOrderNote = scrub(orderNote);
  // THE customer note: generalNotes (mirrors Aryeo's customer internal_notes,
  // the only note anyone can still write) with the retired editingPreferences
  // column as fallback. It used to read editingPreferences alone — NULL on all
  // 349 clients since the notes cards were merged, so this card was blank for
  // every job while 17 clients had a real note the editor needed.
  // The client's OWN style notes, typed on their portal (client-owned column,
  // distinct from our internal editing notes) — scrubbed like everything else.
  const showTheirStyle = scrub(project.client.portalVideoStyle);
  // F18 (Sep 22 2026). The portal's profile page tells the client, in these
  // words, "Everything here reaches your editor and photographer on every job",
  // above three boxes: brand colors, video style, working preferences. Two of
  // the three arrived here. This is the third — it is the client's own
  // client-owned column and it was written to a screen nobody rendered.
  const showTheirPrefs = scrub(project.client.portalPreferences);
  const showJobNote = scrub(project.notes);
  // CP-06: the client's brand as the REGISTRY holds it — the latest active
  // version of every asset, the structured slots (fonts, links, music), the
  // standing production defaults and accepted call preferences (both dead code
  // until now), and the changes the editor has not yet said "Got it" to.
  // Money-scrubbed exactly like the notes above.
  const { brandBriefFor } = await import("@/lib/brandProfile");
  const brandBrief = await brandBriefFor(project.client.id, { projectId: project.id, scrub: !canSeeRaw, editorKey: viewer?.role === "EDITOR" ? viewer.editorKey : null }).catch(() => null);
  // §7.8 (Sep 25): what the client ASKED for on site, for this job, that the
  // office has not confirmed yet. Shown to the editor as exactly that — never
  // as a preference (a photographer's own guess is not listed here at all).
  const { fieldReportsForProject } = await import("@/lib/clientFacts");
  const unconfirmedAsks = (await fieldReportsForProject(project.id).catch(() => []))
    .filter((f) => f.status === "PROPOSED" && f.basis === "client_said" && f.scope === "PROJECT")
    .map((f) => ({ id: f.id, body: scrub(f.body) ?? "", by: f.speaker }))
    .filter((f) => f.body);
  const canAckBrand = !!viewer && !viewer.impersonating && viewer.role === "EDITOR" && !!viewer.editorKey;
  const canOverrideBrand = !!viewer && !viewer.impersonating && isOwnerAdmin;
  // CP-09: WHICH topic each owed video is — the note from the shoot, the
  // script the client approved and the topic's raw folder. The same rows the
  // printed brief and the project summary read (filmingBriefFor), so the three
  // cannot describe one video differently. Money-scrubbed like the notes above.
  const { filmingBriefFor } = await import("@/lib/deliverableOutputs");
  const filming = await filmingBriefFor(project.id).catch(() => null);
  // §7.5 (Sep 25): each owed video's OWN brief, with the version it is — the
  // same rows the printed brief, the shoot screen and the outside agency's
  // packet read (deliverableOutputs.outputBriefsFor). Money-scrubbed for an
  // editor, exactly like the notes above.
  const { outputBriefsFor, OUTPUT_BRIEF_FIELDS, OUTPUT_BRIEF_FIELD_CAP } = await import("@/lib/deliverableOutputs");
  const navigation = await videoNavigationFor(project.id);
  const outputBriefs = await outputBriefsFor(project.id, { scrub: !canSeeRaw }).catch(() => []);
  // A receipt belongs to the creative-safe assignment the editor sees. An
  // owner may see raw customer wording elsewhere, but that must not produce a
  // different digest for the same editor's brief.
  const receiptBriefs = canSeeRaw ? await outputBriefsFor(project.id, { scrub: true }).catch(() => []) : outputBriefs;
  const { assignmentReceiptStates } = await import("@/lib/editorBriefReceipt");
  const receiptStates = await assignmentReceiptStates(project.id, receiptBriefs, project).catch(() => null);
  const { editorMonthFor } = await import("@/lib/editorMonth");
  const monthRead = await editorMonthFor(project.id, viewer).then((data) => ({ data, failed: false })).catch(() => ({ data: null, failed: true }));
  const editorMonth = monthRead.data;
  const canWriteBriefs = canSeeRaw && !viewer?.impersonating;
  // §7.6: the gaps raised off a video's brief, so its card says so instead of
  // offering the button again. A failed read shows no line and keeps the button
  // (a second press finds the open gap and says "already raised"). Its words
  // are money-scrubbed for an editor like the brief itself (review, Sep 28):
  // the office writes them, and the line below prints to every viewer.
  const briefGaps = outputBriefs.length
    ? (
        await import("@/lib/productionGaps")
          .then(async (m) => {
            const gs = await m.gapsForProject(project.id);
            return canSeeRaw ? gs : m.gapsForCreatives(gs);
          })
          .catch(() => [])
      ).filter((g) => g.outputId && (g.state === "OPEN" || g.state === "PLANNED"))
    : [];
  // §7.7 / A33: the Luma Visuals packet card — the office's, and only on a job
  // handed to the agency or one with a send already on record.
  const agencyMod = await import("@/lib/editorPacket");
  const agency = canSeeRaw
    ? await (async () => {
        const relevant = (await agencyMod.isHandedToAgency(project.id)) || (await prisma.editorDispatch.count({ where: { projectId: project.id } })) > 0;
        return relevant ? agencyMod.editorDispatchState(project.id) : null;
      })().catch(() => null)
    : null;
  // What the last brief/packet form did (a code from editing/actions — never
  // the words typed, which can carry a name).
  const PAGE_NOTICES: Record<string, { where: "brief" | "packet"; ok: boolean; text: string }> = {
    "brief-saved": { where: "brief", ok: true, text: "Brief saved as a new version." },
    "brief-unchanged": { where: "brief", ok: true, text: "Nothing changed, so no new version was made." },
    "brief-conflict": { where: "brief", ok: false, text: "Someone else saved that brief while you were editing, so yours was not saved. What you see now is the newest version." },
    "brief-too-long": { where: "brief", ok: false, text: `A section was over ${OUTPUT_BRIEF_FIELD_CAP} characters, so nothing was saved.` },
    "brief-brand-invalid": { where: "brief", ok: false, text: "That brand file is no longer current for this client. Nothing was saved. Choose an active file from their brand kit." },
    "brief-error": { where: "brief", ok: false, text: "That brief could not be saved. Reload and try again." },
    "gap-raised": { where: "brief", ok: true, text: "Raised as missing work. It is on the delivery board until the office plans the recovery." },
    "gap-exists": { where: "brief", ok: true, text: "Already raised as missing work, so nothing new was added." },
    "gap-error": { where: "brief", ok: false, text: "Not raised. The brief needs a limitation written down, and the video must still be owed." },
    "packet-sent": { where: "packet", ok: true, text: "The send is recorded, with the packet exactly as it went." },
    "packet-duplicate": { where: "packet", ok: true, text: "Already recorded: that exact packet went to that recipient, so no new version was made." },
    "packet-error": { where: "packet", ok: false, text: "Not recorded. Say who it went to and how, and check the job is handed to the agency." },
    "ack-saved": { where: "packet", ok: true, text: "Their acknowledgement is recorded." },
    "ack-error": { where: "packet", ok: false, text: "Not recorded. Say who acknowledged it and how (it may already be acknowledged)." },
  };
  const pageNotice = notice ? PAGE_NOTICES[notice] ?? null : null;
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
    // Who ruled on it, and when (Sep 28) — the client's send-back as the client's.
    verdictLine: verdictLine(verdictOf(s)),
    // Name the cut and link to it — sixteen "Round 1" lines are unreadable,
    // and a round the editor can click is one they can act on (Sep 16).
    cutLabel: navigation.get(`${s.deliverableId}:${s.slot ?? 1}`) ? `Video ${navigation.get(`${s.deliverableId}:${s.slot ?? 1}`)!.number} of ${navigation.get(`${s.deliverableId}:${s.slot ?? 1}`)!.total}` : slotLabelOf(s) ?? s.fileName,
    href: `/edit/${project.id}?cut=${s.id}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}#cut-${s.id}`,
  }));
  // THE REVIEW ROOM'S ASKS, as a work order. A bounce writes no RevisionBrief
  // — it is Jordan's own timestamped notes on a cut — so the revision card
  // rendered NOTHING for it and the notes lived only inside the cut panel,
  // wherever that happened to be on the page (Jordan, Sep 16: "the revision
  // requests are not showing up well in the editor brief").
  // The tracker narrates a VIDEO edit — a photos-only or cancelled job has no
  // edit lifecycle to track (the brief below still renders for reference).
  const showTracker = videoDeliverables.length > 0 && project.status !== "CANCELLED";

  // ---- THE OFFICE'S OVERRIDES (Jordan, Sep 13: "I want to be able to
  // override anything") ------------------------------------------------------
  // What the office set on this job, read straight off the project row (the
  // same overrideView the queue row carries), and what the hub would say on
  // its own — the same sources this page already shows (the SLA deadline,
  // the order's video count, the tier verdict). The header's Override button
  // hands both to the dialog so each field can show the hub's value beside
  // the override; the tracker below prefers the override where one is set,
  // like every other reader of these columns.
  const overrides = overrideView(project);
  const computed = computedView({
    dueAt: sla?.due ?? null,
    videosOwed: computedVideosOwed(project, videoDeliverables),
    tier: monthly ? "branding" : tier === "premium" ? "premium" : "standard",
    typeDetail: videoDeliverables.map((d) => d.label || d.type).join(" · "),
    priority: project.priority,
  });
  // The editor as the hub records it: the open edit task's key, else the
  // TeamMember on the project, else the vendor key (the outside shop has no
  // TeamMember). The routing rules' guess is the queue's business, not this
  // page's — an untouched Editor field sends nothing.
  const editorKey =
    project.smartTasks.find((t) => t.taskType === "edit_video" && t.assignedKey)?.assignedKey ??
    editorKeyForTeamName(project.editor?.name) ??
    project.editorVendorKey ??
    null;
  const editorName = editorKey ? editorMeta(editorKey)?.name ?? project.editor?.name ?? editorKey : null;
  // The effective deadline and type for the tracker: the office's word wins.
  // A REOPENED job reads its reopen clock instead (A52) — the same reader and
  // the same answer as Kyle's board and the Editing Room row — and the office
  // can move it here, which is the "a person sets it" half of the rule.
  const reopened = await (async () => {
    if (!project.deliveredAt) return null;
    try {
      const { reopenedClocksFor, reopenedDueFor, isReopenedJob, dueSetTimesFor } = await import("@/lib/deliveryBoard");
      const clock = (await reopenedClocksFor([id])).get(id) ?? null;
      if (!isReopenedJob(project, clock)) return null;
      const dueSetAt = project.dueOverrideAt ? (await dueSetTimesFor([id])).get(id) ?? null : null;
      return reopenedDueFor({ ...project, dueSetAt }, clock);
    } catch {
      return null;
    }
  })();
  const trackerDue = reopened ? reopened.at : effectiveDue(project, sla?.due ?? null);
  const selectedDeliverable = videoDeliverables.find((item) => item.id === selectedSlot?.deliverableId);
  const selectedVideoStyle = selectedDeliverable ? videoStyleFor(selectedDeliverable, { monthly: !!project.contentMonthId }) : null;
  // Social exports never use the licensed catalogue chooser. Existing picks
  // stay saved; this UI rule does not delete a project's music history.
  const catalogueMusicAllowed = selectedVideoStyle?.key === "standard_cinematic";
  const selectedPromise = outputBriefs.find((brief) => brief.key === selectedKey)?.promisedAtISO;
  const selectedDue = selectedPromise ? new Date(selectedPromise) : trackerDue;

  // §10 RUSH (Sep 28): the header's Rush button — the override dialog on the
  // due date and priority alone, with the jobs it pushes back shown before
  // Save. The desk only: owner / admin (James, Kyle and Jordan are all on
  // those logins), never an editor, never a "view as" preview — the same gate
  // as Override and as the server actions it calls, so nobody gets a button
  // the server refuses. Who may APPROVE a displacing rush (James, Kyle, or
  // Jordan) is the server's rushAuthority; anyone else on the desk sees the
  // list and can send it to Jordan. An ask already sent to him is read here
  // so it shows on the job, where it is approved.
  const rushDesk = isOwnerAdmin && !viewer?.impersonating && showTracker;
  // The card is closed by any save that settles it (editing/actions
  // saveEditOverrides), so an ask shown here is one still waiting on Jordan.
  const rushAsk = rushDesk ? await import("@/lib/editorWorkload").then((m) => m.openRushAsk(id)).catch(() => null) : null;
  // §10 J3 (Sep 28): WAITING ON A FILE — what this job cannot start without
  // (the plat for lot lines, the client's logo), recorded and attached by the
  // office. A LIVE owner/admin only, never a "view as" preview — the same
  // strict gate as the raise-gap form above, and the server actions refuse
  // everyone else anyway. Any job, not just a video one: lot lines go on the
  // aerial photos. Editors read the same sentences in the job's brief. A
  // failed read says so rather than showing "nothing waiting".
  const assetDesk = strictOwnerAdmin && !viewer?.impersonating;
  const assetDeps = assetDesk
    ? await import("@/lib/assetDependencies").then((m) => m.openAssetDependencies(project.id)).catch(() => null)
    : null;
  const assetVideoWords = new Map(outputBriefs.map((o) => [o.outputId, `Video ${navigation.get(o.key)?.number ?? o.index}: ${o.label}`]));
  const assetPeople = assetDesk
    ? await import("@/lib/assetDependencies").then((m) => m.INTERPRETER_KEYS.map((k) => ({ key: k, name: editorMeta(k)?.name ?? k })))
    : [];
  const dueNotice = notice ? REOPENED_DUE_NOTICES[notice] ?? null : null;
  const trackerEditType = effectiveTypeDetail(project, videoTypeLabel(editDeliverables, videoTier(owedDeliverables)) || "Video edit");
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
    // No shotOrderNotes: the photographers file their video into folders, so
    // the editor never needs the walk-through (Jordan, Sep 2, round 3). The
    // project page's shoot debrief still shows it to admins.
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

  // ---- SEND TO REVIEW: the slots, with the dead ones out of the way -------
  // 893 S Matlack owes SIXTEEN videos (the office's videosOwedOverride), so
  // its one bounced cut sat in row 1 of sixteen identical "Not uploaded yet"
  // rows (Jordan, Sep 16). The job still owes sixteen — nothing here changes
  // that count, and the line above the panel says it — but the rows the
  // editor cannot act on fold behind one toggle: every slot holding a cut
  // stays, plus the next empty one (the slot they would fill next).
  const cutRows = slots.map((sl) => {
    const latest = latestPerCut.get(`${sl.deliverableId}:${sl.slot}`) ?? null;
    const openNotes = latest ? feedback.filter((n) => n.assetUrl === assetKeyOf(latest) && n.status === "OPEN").length : 0;
    return {
      deliverableId: sl.deliverableId,
      slot: sl.slot,
      // CP-09: the topic it was filmed for, beside the slot's own name — the
      // name itself stays as it is (the approved file is named by it).
      label: sl.topicTitle ? `${sl.label} · ${sl.topicTitle}` : sl.label,
      latest: latest
        ? { id: latest.id, round: latest.round, status: latest.status, fileName: latest.fileName, completedAt: latest.completedAt ? latest.completedAt.toISOString() : null, note: latest.note, sourceWidth: latest.sourceWidth, sourceHeight: latest.sourceHeight, held: quality.held.some((h) => h.submissionId === latest.id), verdict: verdictOf(latest) }
        : null,
      openNotes,
    };
  });
  const canUploadCuts = !viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR");
  // WHOSE DOOR IT IS, asked of the server that answers it (drill, Sep 18). The
  // replace-the-approved-video control used to be drawn from the viewer's role
  // and the cut's status alone, while uploadAuthor scoped an EDITOR to a job
  // carrying an OPEN edit_video/revision task of theirs — which is exactly the
  // task an approved, submitted and delivered cut has already closed. Ten doors
  // rendered on the real board and the server would take two; the other eight
  // refused the editor AFTER they had picked the file and typed their reason,
  // John Mark's six own submissions among them. The server now also admits the
  // editor whose key is on the approved version, and this asks it per row so
  // the two sets are the same set. One cheap call per approved row: owner/admin
  // answers without touching the database at all.
  const replaceableCuts = new Set(
    (
      await Promise.all(
        cutRows
          .filter((r) => canUploadCuts && !revisionOpen && r.latest?.status === "APPROVED")
          .map(async (r) =>
            (await canReplaceApprovedCut({ projectId: id, deliverableId: r.deliverableId, slot: r.slot }).catch(() => false))
              ? `${r.deliverableId}:${r.slot}`
              : null,
          ),
      )
    ).filter((k): k is string => k !== null),
  );
  const hiddenSlots = 0;
  const collapseSlots = false;
  const shownCutRows = cutRows.filter((row) => `${row.deliverableId}:${row.slot}` === selectedKey).map((row) => ({ ...row, canReplace: replaceableCuts.has(`${row.deliverableId}:${row.slot}`) }));
  // THE EDITOR'S OWN CLOCK (Sep 28): their Start / Pause read in their own
  // timezone (Manila for Kim and John Mark); everyone else reads Eastern.
  const deskTz =
    viewer?.role === "EDITOR" && viewer.editorKey ? (editorMeta(viewer.editorKey)?.tz ?? DEFAULT_EDITOR_TZ) : "America/New_York";
  // "SENT. ARE YOU STILL WORKING ON THIS JOB?" (Jordan, Sep 28). Handing a
  // version in ends the editor's Start, so the upload row asks — only the
  // editor who could press Start here and is not on it now (workBar's editor
  // mode already excludes the office, a preview and an editor without a desk;
  // canStart excludes a job that isn't theirs or is held). Counted over EVERY
  // slot, not the folded list: a video still owed is owed whether or not its
  // row is drawn. A slot is open when nothing is in, the last version came
  // back, was withdrawn, is held for the editor's own check — or is approved
  // and the client has asked again ABOUT THAT VIDEO, after it was approved
  // (Sep 28 review): an open ask is a job-level flag, and counting every
  // approved video under it told Kim "3 more videos to make" on a job that
  // owed none. An ask that names no video counts no approved one — the card
  // is a question, and it is never asked off a guess.
  const askedAgain = cutRows.some((r) => r.latest?.status === "APPROVED")
    ? await import("@/lib/videoAsks").then((m) => m.slotsAskedAgain(id, videoRevisionTasks, submissions)).catch(() => new Map<string, Date>())
    : new Map<string, Date>();
  const openSlotKeys = openSlotKeysFor(
    cutRows.map((r) => {
      const key = `${r.deliverableId}:${r.slot}`;
      const decided = r.latest?.status === "APPROVED" ? (latestPerCut.get(key)?.decidedAt ?? null) : null;
      return {
        key,
        status: r.latest?.status ?? null,
        held: !!r.latest?.held,
        approvedAtISO: decided ? decided.toISOString() : r.latest?.status === "APPROVED" ? r.latest.completedAt : null,
      };
    }),
    askedAgain,
  );
  const stillWorking =
    workBar && workBar.mode === "editor" && workBar.canStart && workBar.mine.state !== "ACTIVE"
      ? { openSlotKeys, elsewhereStreet: workBar.elsewhere?.street ?? null, paused: workBar.mine.state === "PAUSED" }
      : null;
  // The panel below counts approved against the rows IT was handed, which is
  // the short list while the empty slots are folded. The real totals are said
  // out loud above it, so "0 of 2 approved" can't be read as the job's tally
  // (Sep 16 review).
  const approvedSlots = cutRows.filter((r) => r.latest?.status === "APPROVED").length;
  // The toggle keeps whichever cut they were looking at and lands back on the
  // panel rather than the top of the page.
  const slotsHref = (all: boolean) => {
    const q = new URLSearchParams();
    if (cut) q.set("cut", cut);
    if (all) q.set("slots", "all");
    const qs = q.toString();
    return `/edit/${project.id}${qs ? `?${qs}` : ""}#submit-cut`;
  };

  // =========================================================================
  // THE SELECTED VIDEO'S BRIEF, IN THE ORDER AN EDITOR WORKS (Oct 5 2026).
  //
  // Jordan onboards his first content client: "the editor brief easy for our
  // editors to read and the process smooth and seamless", no overload. The
  // audit (rendered as Kim and John) found the same footage link five times,
  // the brand kit four, the script twice (once inside the photographer's
  // report), the export spec three times, music four and the deadline four —
  // two of them different dates — and a client-approved hook deleted by the
  // money scrub. So the selected video now reads top to bottom, each thing
  // ONCE:
  //   1. header — client · "Video 2 of 4 — <topic>" · the ONE deadline (the
  //      editor's time and ET, both labelled) · where the video stands
  //   2. Make this — the specs line (the style's default, or the office's own
  //      for this video), then the office's direction
  //   3. Script — the approved words, open, with Copy; a badge when the client
  //      has not approved them; nothing at all for a style that is cut to music
  //   4. Footage — this topic's clips (or the honest one-line fallback), the
  //      photographer's note, what changed on site
  //   5. Brand — the logo / end card for this video, colours, fonts, files
  //   6. The client — the Agent Profile (collapsed) and their own words, which
  //      win over the house style
  //   7. Music — one rule
  //   8. Changes to make — only when it was sent back
  // then Send to Review and the team messages, and everything else FOLDED:
  // other videos, the month, history, the full style guide, export details.
  // The office's writing tools sit last, under their own heading.
  // =========================================================================
  const ET = "America/New_York";
  const isVideoJob = videoDeliverables.length > 0;
  const selectedBrief = outputBriefs.find((o) => o.key === selectedKey) ?? null;
  const selectedNav = selectedKey ? navigation.get(selectedKey) ?? null : null;
  const videoNumber = selectedNav?.number ?? selectedBrief?.index ?? 1;
  const videoTotal = selectedNav?.total ?? (outputBriefs.length || slots.length || 1);
  const styleKey = selectedVideoStyle?.key ?? (isVideoJob ? videoStyleFor(videoDeliverables[0], { monthly: !!project.contentMonthId }).key : null);
  const styleType = styleKey ? videoStyleByKey(styleKey) : null;
  const sectionText = (key: string) => selectedBrief?.sections.find((x) => x.key === key)?.text ?? null;
  const makeThis = makeThisFor(styleKey, sectionText("specs"));
  const videoTitle = selectedBrief?.topicTitle || selectedBrief?.format || selectedSlot?.deliverableLabel || styleType?.name || "Video";
  const fmtDue = (d: Date, tz: string) => d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // ONE deadline, said in both clocks for an editor abroad (Kim and John Mark
  // are in Manila): "Sat, Oct 17, 5:00 AM your time · Fri, Oct 16, 5:00 PM ET".
  const dueLine = selectedDue
    ? deskTz === ET ? `${fmtDue(selectedDue, ET)} ET` : `${fmtDue(selectedDue, deskTz)} your time · ${fmtDue(selectedDue, ET)} ET`
    : null;
  const dueWhy = !selectedPromise && reopened ? (reopened.at ? reopened.words : "Reopened — no due date yet; Kyle sets it.") : null;
  const selectedHeld = !!activeSub && quality.held.some((h) => h.submissionId === activeSub.id);
  const videoState =
    activeSub?.status === "CHANGES_REQUESTED" ? { text: "Changes requested", tone: "bg-danger/10 text-danger" }
    : selectedHeld ? { text: "Waiting on your check before it goes to review", tone: "bg-warning/15 text-warning" }
    : activeSub?.status === "PENDING" ? { text: `In review${latestReviewer ? ` — with ${latestReviewer.split(/\s+/)[0]}` : ""}`, tone: "bg-warning/15 text-warning" }
    : activeSub?.status === "APPROVED" ? { text: "Approved", tone: "bg-success/10 text-success" }
    : { text: "Awaiting edit", tone: "bg-surface-2 text-muted" };

  // 2 · the office's direction for this video, and for every video on the job.
  const officeDirection = (["purpose", "direction", "mustShow", "avoid"] as const)
    .map((k) => selectedBrief?.sections.find((x) => x.key === k))
    .filter((x): x is NonNullable<typeof x> => !!x);
  const specText = (k: string) => (typeof editSpec[k] === "string" && (editSpec[k] as string).trim() ? (editSpec[k] as string).trim() : null);
  const jobSpec = [specText("desiredLength") ? `Length: ${specText("desiredLength")}` : null, specText("colorProfile") ? `Colour profile: ${specText("colorProfile")}` : null].filter((x): x is string => !!x);
  const specialAsks = specialRequests.map((a) => ({ id: a.id, body: canSeeRaw ? a.body : stripMoneySentences(a.body) })).filter((a) => a.body.trim());

  // 3 · the script for THIS video: the topic's approved words, else the
  // Studio's script WHENEVER one is on file (review, Oct 5 night: a premium
  // cinematic job with a Studio script read "No script on file", because the
  // Studio script was only shown for a style named "reel"); a style cut to
  // music with no script on file gets no section at all. On a job with more
  // than one video the Studio script is the job's one script, not tied to a
  // video — said once, in plain words.
  const topicScript = selectedBrief?.script ?? null;
  const reelScriptOnFile = !!(project.reelHook?.trim() || project.reelScript?.trim());
  const reelStyle = !!styleKey && /reel|personal_branding/.test(styleKey);
  const useReelScript = !topicScript && reelScriptOnFile;
  const sharedJobScript = useReelScript && outputBriefs.length > 1;
  const studioShotList = useReelScript ? project.reelShotList?.trim() || null : null;
  const scriptMissing = isVideoJob && !topicScript && !useReelScript && !!styleKey && SCRIPTED_STYLE_RE.test(styleKey);

  // 4 · the footage: this topic's own folder, else the job's raw folder — one link.
  const ownFolder = selectedBrief?.folder ?? null;
  const footageUrl = ownFolder?.url ?? rawUrl;
  const shootNotes = [
    selectedBrief?.note ? { label: "From the shoot", text: selectedBrief.note } : null,
    ...(["onSite", "footage", "limitations"] as const).map((k) => {
      const x = selectedBrief?.sections.find((y) => y.key === k);
      return x ? { label: x.label, text: x.text } : null;
    }),
    project.editorBrief?.trim() ? { label: "Photographer's notes", text: project.editorBrief.trim() } : null,
    project.videoInstructions?.trim() ? { label: "Video notes from the shoot", text: project.videoInstructions.trim() } : null,
    ...deliverableNotes.map((d) => ({ label: refinedDeliverableLabel(d.type, d.label), text: canSeeRaw ? d.notes ?? "" : stripMoneySentences(d.notes ?? "") })),
  ].filter((x): x is { label: string; text: string } => !!x && !!x.text.trim());

  // 5 · the brand. The Agent Profile's merged style (portal first, then the
  // Aryeo note) is the one source of colours and fonts on this page.
  const agent = await import("@/lib/clientProfile")
    .then((m) => m.agentProfileFor(project.client.id, { brand: brandBrief, links: true }))
    .catch(() => null);
  const chosenFile = selectedBrief?.brandAsset?.state === "current" ? brandBrief?.files.find((f) => f.versionId === selectedBrief.brandAsset?.versionId) ?? null : null;
  const logoFile = brandBrief?.files.find((f) => f.type === "LOGO") ?? brandBrief?.files.find((f) => f.type === "BRANDING_CARD") ?? null;
  // The end card. The monthly / personal-branding spec ends on the logo (or a
  // name card), so that style always gets a line; a listing video gets one
  // only when there is a logo or the office chose for this video. A logo that
  // is only a file in their Dropbox brand folder is named, not linked — the
  // folder card below links it, once.
  const brandingStyle = styleKey === "personal_branding";
  const folderLogo = !logoFile ? assets?.files.find((f) => /logo/i.test(f.name)) ?? null : null;
  const endWord = brandingStyle ? "End card" : "Logo";
  const endCard: { text: string; file: { name: string; url: string | null } | null; warn: boolean } | null =
    selectedBrief?.brandAsset && selectedBrief.brandAsset.state !== "current"
      ? { text: "The logo chosen for this video is no longer their current one — check with Kyle before the end card.", file: null, warn: true }
      : chosenFile
        ? { text: `${endWord}: use this file —`, file: { name: chosenFile.fileName ?? chosenFile.name, url: chosenFile.url }, warn: false }
        : selectedBrief?.brandChoice === "none"
          ? { text: `No logo on this video — the office's choice.${brandingStyle ? " End on a name card (name and brokerage)." : ""}`, file: null, warn: false }
          : logoFile
            ? { text: `${endWord}: their logo —`, file: { name: logoFile.fileName ?? logoFile.name, url: logoFile.url }, warn: false }
            : folderLogo
              ? { text: `${endWord}: their logo (${folderLogo.name}, in their brand folder below).`, file: null, warn: false }
              // Their notes ask for the logo and there is no file: say so
              // (any style) rather than leave the editor to notice.
              : agent?.style.preferences.some((p) => /\blogo/i.test(p.text))
                ? { text: `Their notes ask for their logo, and there's no logo file yet — ask Kyle for it.${brandingStyle ? " Until it comes, end on a name card (name and brokerage)." : ""}`, file: null, warn: true }
                : brandingStyle
                  ? { text: assets?.files.length ? "No logo picked out — check their brand folder below, or end on a name card (name and brokerage)." : "No logo on file — end on a name card (name and brokerage).", file: null, warn: false }
                  : null;
  const linkedBrand = new Set([chosenFile?.versionId, !chosenFile && selectedBrief?.brandChoice !== "none" ? logoFile?.versionId : null].filter(Boolean));
  const seenBrandUrl = new Set<string>();
  const otherBrandFiles = (brandBrief?.files ?? []).filter((f) => {
    if (linkedBrand.has(f.versionId)) return false;
    const k = f.url ?? f.versionId;
    if (seenBrandUrl.has(k)) return false;
    seenBrandUrl.add(k);
    return true;
  });
  const brandColorsShown = agent?.style.colors.length ? agent.style.colors.map((c) => c.hex) : brandColors.map((c) => c.toLowerCase());
  const brandFonts = agent?.style.fonts?.text ?? brandBrief?.fontNames ?? null;

  // 6 · their own words — they win over the house style where the two differ.
  const confirmedPrefs = [
    ...(brandBrief?.productionDefaults ?? []).map((d) => `${d.name}: ${d.text}`),
    ...(brandBrief?.acceptedPreferences ?? []),
  ];
  // The look-and-brand lines of the Aryeo customer note (the office's standing
  // note on the client) — said here, in the brief, not only inside the folded
  // Agent Profile: "Use his logo on every video" is an instruction.
  const customerNoteLines = (agent?.style.preferences ?? []).filter((p) => p.from === "aryeo").map((p) => p.text);
  const hasTheirWords = !!(showTheirStyle || showTheirPrefs || showOrderNote || confirmedPrefs.length || customerNoteLines.length);

  // 7 · ONE music rule. The office's word for this video wins; a listing reel
  // with a song picked beside its Studio script uses that song; the cinematic
  // video gets the licensed chooser; everything social is trending audio.
  const musicForVideo = sectionText("music");
  // The Studio's song travels with the Studio's script, whatever the style.
  const reelSong = useReelScript || (reelStyle && !project.contentMonthId) ? project.reelSong?.trim() || null : null;
  const musicType = specText("musicType");

  // 8 · what was asked when it came back — for THIS video (review, Oct 5
  // night: a client's ask about video 3 showed under every video). On a job
  // with more than one video an ask is this video's when its revision task
  // (or its itemised brief) names this video; an ask that names none is the
  // whole job's and says so. A one-video job keeps every ask.
  const selectedIssues = quality.issues.filter((issue) => !issue.duplicateOfId && ["OPEN", "REOPENED", "ADDRESSED"].includes(issue.state) && (selectedKey ? issue.cutKey === selectedKey : issue.raisedOnSubmissionId === activeSub?.id));
  const unassignedIssues = quality.issues.filter((issue) => !issue.cutKey && !issue.duplicateOfId && ["OPEN", "REOPENED", "ADDRESSED"].includes(issue.state));
  const selectedOutputId = selectedBrief?.outputId ?? null;
  const scopeAsks = outputBriefs.length > 1 && !!selectedOutputId;
  const asksOf = (tasks: typeof videoRevisionTasks) => {
    const raw = tasks.flatMap((t) => (t.description ?? t.summary ?? "").split(/\n\nNew request: /)).map((x) => x.trim()).filter(Boolean);
    return canSeeRaw ? raw : raw.map((a) => stripMoneySentences(a) || "(a note was held back — ask Jordan)");
  };
  const thisVideoAsks = scopeAsks ? asksOf(videoRevisionTasks.filter((t) => t.outputId === selectedOutputId)) : revisionAsks;
  const jobWideAsks = scopeAsks ? asksOf(videoRevisionTasks.filter((t) => !t.outputId)) : [];
  const briefsHere = scopeAsks ? briefs.filter((b) => !b.outputId || b.outputId === selectedOutputId) : briefs;
  const revisionOpenHere = scopeAsks ? videoRevisionTasks.some((t) => !t.outputId || t.outputId === selectedOutputId) : revisionOpen;
  const showChanges = needsWork || selectedIssues.length > 0 || unassignedIssues.length > 0 || (revisionOpenHere && (briefsHere.length > 0 || thisVideoAsks.length > 0 || jobWideAsks.length > 0));

  // ONE "Got it" per job (BriefGotIt) — every video assigned to THIS editor
  // whose current brief they have not received yet.
  const myEditorKey = viewer?.role === "EDITOR" && !viewer.impersonating ? viewer.editorKey ?? null : null;
  const myPending = myEditorKey && receiptStates
    ? outputBriefs.flatMap((o) => {
        const st = receiptStates.get(o.outputId);
        if (!st || !st.digest || st.editorKey !== myEditorKey || (st.acceptedAtISO && !st.changedSinceReceipt)) return [];
        return [{ outputId: o.outputId, digest: st.digest, changed: st.changedSinceReceipt, noLogo: !!st.intentionalNoBrand, number: navigation.get(o.key)?.number ?? o.index }];
      })
    : [];
  const mySelectedPending = myPending.filter((p) => p.outputId === selectedBrief?.outputId);
  const myOtherPending = myPending.filter((p) => p.outputId !== selectedBrief?.outputId);
  // The office reads the same receipts as one line per editor.
  const receiptLines = isOwnerAdmin && receiptStates
    ? [...outputBriefs.reduce((m, o) => {
        const st = receiptStates.get(o.outputId);
        if (!st?.editorKey) return m;
        const row = m.get(st.editorKey) ?? { got: 0, total: 0, changed: 0 };
        row.total++;
        if (st.acceptedAtISO && !st.changedSinceReceipt) row.got++;
        if (st.changedSinceReceipt) row.changed++;
        return m.set(st.editorKey, row);
      }, new Map<string, { got: number; total: number; changed: number }>())].map(([key, r]) => {
        const who = editorMeta(key)?.name ?? key;
        return r.got === r.total ? `${who} has the current brief.` : `${who} has said Got it on ${r.got} of ${r.total} video${r.total === 1 ? "" : "s"}${r.changed ? ` (${r.changed} changed since)` : ""}.`;
      })
    : [];
  const otherVideos = outputBriefs.filter((o) => o.key !== selectedKey);

  const CARD = "min-w-0 rounded-2xl border border-border bg-surface p-4";
  const H3 = "text-base font-semibold";
  const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-muted-2";

  return (
    <div className="[&_[id]]:scroll-mt-56 md:[&_[id]]:scroll-mt-44 lg:[&_[id]]:scroll-mt-32">
      {/* Queue links carry their validated filters, including for cold/new-tab
          visits. Other entrances use in-app history or the Editing Room. */}
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href={queueReturnHref(queue)} label="Editing Room" preferHref={!!queue} />
      </div>
      <PageHeader
        sticky="desktop"
        eyebrow="Editor brief"
        title={street}
        actions={
          // Wraps at phone width now that Rush sits beside Override (375px).
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* §10 rush: the desk only (see rushDesk above). */}
            {rushDesk && (
              <RushButton
                ask={rushAsk}
                job={{
                  projectId: project.id,
                  street,
                  status: STATUS_LABEL[project.status] ?? project.status,
                  editorKey,
                  editorName,
                  editorAuto: false,
                  overrides,
                  computed,
                }}
              />
            )}
            {/* THE OVERRIDE (Jordan, Sep 13) — office only, and never from a
                "view as" preview (read-only; the server re-checks). */}
            {isOwnerAdmin && !viewer?.impersonating && (
              <EditOverridesButton
                variant="header"
                job={{
                  projectId: project.id,
                  street,
                  status: STATUS_LABEL[project.status] ?? project.status,
                  editorKey,
                  editorName,
                  editorAuto: false,
                  overrides,
                  computed,
                }}
              />
            )}
            {isOwnerAdmin && (
              <Link href={`/projects/${project.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">
                Full details <ExternalLink className="size-3.5" />
              </Link>
            )}
          </div>
        }
      />

      {showTracker && workBar && <div className="px-4 pt-4 sm:px-6"><WorkStateBar bar={workBar} tz={deskTz} selectedOutputId={selectedBrief?.outputId ?? null} /></div>}

      {/* Sent back: the ONE next action, straight to the exact cut. */}
      {needsWork && <div className="px-4 pt-4 sm:px-6">
        <a href={revisionHref ?? (activeSub ? `#cut-${activeSub.id}` : "#submit-cut")} className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-4 py-3 text-sm font-medium text-danger hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-brand">
          <AlertTriangle className="size-4 shrink-0" />
          {openOnActive > 0 ? `${openOnActive} note${openOnActive === 1 ? "" : "s"} to fix on this cut` : "Changes were requested on this cut"}
          <span className="ml-auto font-semibold">Open exact cut →</span>
        </a>
      </div>}

      {brandBrief && brandBrief.pending.length > 0 && <div className="px-4 pt-4 sm:px-6">
        <BrandUpdatesBanner projectId={project.id} items={brandBrief.pending.map((c) => ({ id: c.id, line: c.line, actorLabel: c.actorLabel, createdAtISO: c.createdAtISO }))} canAck={canAckBrand} canOverride={canOverrideBrand} />
      </div>}

      {/* WHICH VIDEO — each chip names its topic on the chip itself, not only
          in a hover tooltip (Oct 5). One video on the job: no chooser. */}
      {outputBriefs.length > 1 && (
        <section className="px-4 pt-4 sm:px-6" aria-label="Video selector">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Videos on this job</h2>
            <p className="text-xs text-muted">{approvedSlots} of {slots.length} approved</p>
          </div>
          <nav className="mt-2 flex max-w-full gap-2 overflow-x-auto pb-2">
            {outputBriefs.map((brief) => {
              const latest = cutRows.find((row) => `${row.deliverableId}:${row.slot}` === brief.key)?.latest;
              const selected = brief.key === selectedKey;
              const tone = latest?.status === "APPROVED" ? "border-success/40 bg-success-soft text-success" : latest?.status === "PENDING" ? "border-warning/40 bg-warning-soft text-warning" : latest?.status === "CHANGES_REQUESTED" ? "border-danger/40 bg-danger-soft/60 text-danger" : "border-border bg-surface text-foreground/80";
              const state = latest ? (latest.status === "APPROVED" ? "Approved" : latest.status === "CHANGES_REQUESTED" ? `Changes requested on v${latest.round}` : `In review · v${latest.round}`) : "Awaiting edit";
              // WHOSE VIDEO (review, Oct 5 night): a month can be split between
              // editors, so each chip names the editor it is assigned to — "you"
              // for the viewer's own.
              const ownerKey = receiptStates?.get(brief.outputId)?.editorKey ?? null;
              const owner = ownerKey ? (ownerKey === myEditorKey ? "you" : (editorMeta(ownerKey)?.name ?? ownerKey).split(/\s+/)[0]) : null;
              return (
                <Link key={brief.outputId} aria-current={selected ? "page" : undefined} href={`/edit/${project.id}?output=${brief.outputId}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}`} className={`inline-flex min-h-11 max-w-80 shrink-0 items-center rounded-lg border px-3 py-2 text-sm font-medium ${tone} ${selected ? "ring-2 ring-brand ring-offset-2 ring-offset-background" : ""}`}>
                  <span className="truncate">{navigation.get(brief.key)?.number ?? brief.index} · {brief.topicTitle || brief.format} · {state}{owner ? <span data-video-editor> · {owner}</span> : null}</span>
                </Link>
              );
            })}
          </nav>
        </section>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-5 p-4 sm:p-6">
        <article id={selectedBrief ? `brief-${selectedBrief.outputId}` : "brief-job"} data-brief="selected-video" className="min-w-0 space-y-5">
          {/* 1 · WHAT, WHOSE, BY WHEN */}
          <header data-brief-section="header" className={CARD}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{project.client.name}</p>
            <h2 className="mt-0.5 text-lg font-semibold leading-snug">{isVideoJob ? `Video ${videoNumber} of ${videoTotal} — ${videoTitle}` : street}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm" data-due>
              {dueLine && selectedDue ? (
                <>
                  <span><span className="font-semibold">Due</span> {dueLine}</span>
                  {activeSub?.status !== "APPROVED" && <SlaCountdown dueISO={selectedDue.toISOString()} />}
                </>
              ) : (
                <span className="text-muted">No due date yet — Kyle sets it.</span>
              )}
            </div>
            {dueWhy && <p className="mt-0.5 text-xs text-muted">{dueWhy}</p>}
            {/* Which version of this video's brief is in force — the office's
                bookkeeping (the printed brief and the shoot screen print the
                same line), not an editor's: they read the brief itself. */}
            {isOwnerAdmin && selectedBrief && <p className="mt-0.5 text-xs text-muted" data-office-version>{selectedBrief.directionSource === "own" ? selectedBrief.versionLabel : selectedBrief.version ? `Brief v${selectedBrief.version} · saved by ${selectedBrief.updatedBy ?? "the office"} (logo choice only)` : "No brief written for this video yet."}</p>}
            {isVideoJob && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${videoState.tone}`}>{videoState.text}</span>
                <span className="ml-auto flex flex-wrap gap-2">
                  <a href="#submit-cut" className={`${BRIEF_SECTION_LINK} ${canUploadCuts ? "border-transparent bg-brand-action text-brand-fg hover:brightness-95" : "border-border-strong bg-surface hover:bg-surface-2"}`}>{canUploadCuts ? "Upload for review" : "Cuts and review"}</a>
                  <a href="#messages" className={`${BRIEF_SECTION_LINK} border-border bg-surface hover:bg-surface-2`}>
                    <MessageSquare className="size-4 shrink-0" />
                    Messages{viewer && !viewer.impersonating && unreadTeamMessages ? ` · ${unreadTeamMessages} new` : ""}
                  </a>
                </span>
              </div>
            )}
            {/* "Got it" is for the video ON THIS PAGE (review, Oct 5 night):
                one press used to acknowledge every pending video, opened or
                not. The others are named, one tap away. */}
            {(mySelectedPending.length > 0 || myOtherPending.length > 0) && (
              <div className="mt-3 border-t border-border pt-3">
                <BriefGotIt
                  projectId={project.id}
                  videoNumber={videoNumber}
                  pending={mySelectedPending.map((p) => ({ outputId: p.outputId, digest: p.digest }))}
                  changed={mySelectedPending.some((p) => p.changed)}
                  noLogo={mySelectedPending.some((p) => p.noLogo)}
                  otherVideos={myOtherPending.map((p) => ({ number: p.number, href: `/edit/${project.id}?output=${p.outputId}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}` }))}
                />
              </div>
            )}
          </header>

          {/* 2 · MAKE THIS */}
          {isVideoJob && (
            <section id="video-make" data-brief-section="make" className={CARD}>
              <h3 className={H3}>Make this</h3>
              <p className="mt-1 text-sm font-medium leading-relaxed" data-make-this>{makeThis.line}</p>
              {makeThis.source === "office" && <p className="mt-0.5 text-xs text-muted">Set by the office for this video.</p>}
              {(officeDirection.length > 0 || jobSpec.length > 0 || specText("instructions") || showJobNote || specialAsks.length > 0 || !!brandBrief?.scopedInstructions.length) && (
                <dl className="mt-3 space-y-2.5 border-t border-border pt-3 text-sm leading-relaxed">
                  {officeDirection.map((x) => (
                    <div key={x.key}><dt className="font-medium text-muted">{x.label}</dt><dd className="whitespace-pre-wrap text-foreground/90">{x.text}</dd></div>
                  ))}
                  {jobSpec.length > 0 && <div><dt className="font-medium text-muted">Every video on this job</dt><dd>{jobSpec.join(" · ")}</dd></div>}
                  {specText("instructions") && <div><dt className="font-medium text-muted">Instructions</dt><dd className="whitespace-pre-wrap text-foreground/90">{specText("instructions")}</dd></div>}
                  {showJobNote && <div><dt className="font-medium text-muted">From the office</dt><dd className="whitespace-pre-wrap text-foreground/90">{showJobNote}</dd></div>}
                  {specialAsks.map((a) => <div key={a.id}><dt className="font-medium text-muted">Special request</dt><dd className="whitespace-pre-wrap text-foreground/90">{a.body}</dd></div>)}
                  {brandBrief?.scopedInstructions.map((fact) => <div key={fact.id}><dt className="font-medium text-muted">{fact.scope === "MONTH" ? "This month" : "This job"}</dt><dd className="whitespace-pre-wrap text-foreground/90">{fact.body}</dd></div>)}
                </dl>
              )}
            </section>
          )}

          {/* 3 · THE SCRIPT — open, with Copy; never money-scrubbed. */}
          {(topicScript || useReelScript || scriptMissing) && (
            <section id="video-script" data-brief-section="script" className={CARD}>
              <details open className="group">
                <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                  <h3 className={H3}>Script</h3>
                  {topicScript && <span className="text-sm text-muted">{topicScript.versionNo ? `v${topicScript.versionNo}` : "draft"}</span>}
                  {topicScript && (topicScript.clientApproved
                    ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">Approved by the client</span>
                    : <span data-not-approved className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">Not approved by the client yet</span>)}
                  {useReelScript && <span className="text-sm text-muted">From the Script Studio</span>}
                  <ChevronDown aria-hidden className="ml-auto size-4 text-muted transition-transform group-open:rotate-180" />
                </summary>
                {topicScript && !topicScript.clientApproved && <p className="mb-2 text-xs text-warning">These words are {topicScript.standing.replace(/^a /, "a ")}. Check with Kyle before you burn in the captions.</p>}
                {topicScript && (topicScript.text ? <BriefScript body={topicScript.text} /> : <p className="text-sm text-muted">No words on file for this script yet — ask Kyle.</p>)}
                {sharedJobScript && <p className="mb-2 text-xs text-muted" data-shared-script>One script for the whole job — it isn&apos;t tied to one video. Ask Kyle in the messages which video it&apos;s for.</p>}
                {useReelScript && (
                  <BriefScript
                    body={[project.reelHook?.trim() ? `Hook: ${project.reelHook.trim()}` : null, project.reelScript?.trim() ? `Script: ${project.reelScript.trim()}` : null].filter(Boolean).join("\n\n")}
                    parts={[{ label: "Hook", text: project.reelHook ?? "" }, { label: "Script", text: project.reelScript ?? "" }]}
                  />
                )}
                {studioShotList && (
                  <div className="mt-3 border-t border-border pt-3 text-sm" data-shot-list>
                    <p className={LABEL}>Shot list</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{studioShotList}</p>
                  </div>
                )}
                {scriptMissing && <p className="text-sm text-muted">No script on file for this video yet — cut the B-roll first, or ask in the messages.</p>}
                {topicScript?.direction && (
                  <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                    {topicScript.direction.creativeDirection && <div><dt className="font-medium text-muted">Direction</dt><dd className="whitespace-pre-wrap">{topicScript.direction.creativeDirection}</dd></div>}
                    {topicScript.direction.productionNotes && <div><dt className="font-medium text-muted">Production</dt><dd className="whitespace-pre-wrap">{topicScript.direction.productionNotes}</dd></div>}
                    {topicScript.direction.filmingNotes && <div><dt className="font-medium text-muted">Filming</dt><dd className="whitespace-pre-wrap">{topicScript.direction.filmingNotes}</dd></div>}
                  </dl>
                )}
                {project.scriptConfirmNote?.trim() && <p className="mt-2 text-xs text-muted">Confirmed on site: {project.scriptConfirmNote.split("\n").map((x) => x.trim()).filter(Boolean).join(" · ")}</p>}
              </details>
            </section>
          )}

          {/* 4 · FOOTAGE — one link, then what the people who were there said. */}
          {isVideoJob && (
            <section id="video-footage" data-brief-section="footage" className={CARD}>
              <h3 className={H3}>Footage</h3>
              <a href={footageUrl} target="_blank" rel="noopener noreferrer" data-footage-link className="mt-2 inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand">
                <FolderOpen className="size-4 shrink-0" />
                <span className="truncate">{ownFolder ? `Open this video's clips · ${ownFolder.label}` : "Open the raw footage"}</span>
                {!ownFolder && <UploadDot n={folderCounts.raw} stale={folderCounts.stale} />}
              </a>
              {monthly && !ownFolder && <p className="mt-1.5 text-sm text-muted">This video&apos;s clips aren&apos;t in a folder of their own — they&apos;re in the session&apos;s raw footage. Ask Kyle if you can&apos;t tell which takes are this topic.</p>}
              {shootNotes.length > 0 && (
                <dl className="mt-3 space-y-2.5 text-sm leading-relaxed">
                  {shootNotes.map((n, i) => <div key={i}><dt className="font-medium text-muted">{n.label}</dt><dd className="whitespace-pre-wrap text-foreground/90">{n.text}</dd></div>)}
                </dl>
              )}
              {filming?.pending && filming.pending.topics.length > 0 && (
                <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  <p className="font-medium">The photographer&apos;s report is still being saved:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {filming.pending.topics.map((t, i) => <li key={i}>{t.title}{t.extra ? " (filmed on site)" : ""}{t.note ? ` — ${scrub(t.note) ?? ""}` : ""}</li>)}
                  </ul>
                </div>
              )}
              {selectedBrief && briefGaps.filter((g) => g.outputId === selectedBrief.outputId).map((g) => (
                <p key={g.id} className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                  Missing work raised by {g.raisedBy}: {g.what}
                  {g.state === "PLANNED" && g.ownerKey ? ` · ${g.ownerKey.charAt(0).toUpperCase()}${g.ownerKey.slice(1)} is getting it${g.dueISO ? ` by ${etDate(g.dueISO)}` : ""}` : " · the office is planning how to get it"}
                </p>
              ))}
            </section>
          )}

          {/* 5 · BRAND — this video's end card, then the kit. */}
          <section id="brand-assets" data-brief-section="brand" className={CARD}>
            <h3 className={H3}>Brand</h3>
            {isVideoJob && endCard && (
              <p data-end-card className={`mt-1 text-sm ${endCard.warn ? "text-warning" : ""}`}>
                {endCard.text}{" "}
                {endCard.file && (endCard.file.url
                  ? <a href={endCard.file.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">{endCard.file.name} ↗</a>
                  : <span className="font-medium">{endCard.file.name}</span>)}
              </p>
            )}
            {brandColorsShown.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2" data-brand-colors>
                <Palette className="size-3.5 text-muted" />
                {brandColorsShown.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium">
                    <span aria-hidden className="size-4 rounded border border-border" style={{ backgroundColor: c }} /> {c.toUpperCase()}
                  </span>
                ))}
                {agent?.style.colorWords && <span className="text-xs text-muted">{agent.style.colorWords}</span>}
              </div>
            )}
            {brandFonts && <p className="mt-2 text-sm"><span className="text-muted">Fonts:</span> {brandFonts}</p>}
            {otherBrandFiles.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {otherBrandFiles.map((f) => (
                  <li key={f.versionId} className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                    <span className="font-semibold text-muted">{f.typeWord}</span>
                    {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-brand hover:underline">{f.fileName ?? f.name}</a> : <span className="min-w-0 truncate">{f.fileName ?? f.name}</span>}
                  </li>
                ))}
              </ul>
            )}
            {brandBrief?.website && <p className="mt-2 text-sm"><span className="text-muted">Website:</span> {brandBrief.website}</p>}
            {!brandColorsShown.length && !brandFonts && !otherBrandFiles.length && !endCard?.file && <p className="mt-2 text-sm text-muted">No colours or fonts on file — keep it clean and neutral.</p>}
            {assets ? (
              <details className="mt-3 border-t border-border pt-2">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand">Their brand folder · add a file</summary>
                <ClientAssetsCard
                  clientId={assets.clientId}
                  files={assets.files.map((f) => ({ name: f.name, url: f.url }))}
                  folderUrl={assets.folderUrl}
                  canUpload
                />
              </details>
            ) : brandUrl ? (
              <a href={brandUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand hover:underline">Their brand folder <ExternalLink className="size-3.5" /></a>
            ) : null}
          </section>

          {/* 6 · THE CLIENT — who they are (collapsed) and their own words. */}
          <section id="video-client" data-brief-section="client" className="min-w-0 space-y-3">
            {agent && <AgentProfileCard agent={agent} hidePreferencesFrom={["portal", "aryeo"]} linkLogo={false} />}
            {hasTheirWords && (
              <div className={CARD}>
                <h3 className={H3}>In their words</h3>
                <p className="mt-0.5 text-xs text-muted">Where this differs from the house style, theirs wins.</p>
                <div className="mt-3 space-y-3 text-sm leading-relaxed">
                  {showTheirStyle && <div><p className={LABEL}>How they like their videos — from their portal</p><p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{showTheirStyle}</p></div>}
                  {showTheirPrefs && <div><p className={LABEL}>How they like to work — from their portal</p><p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{showTheirPrefs}</p></div>}
                  {showOrderNote && <div><p className={LABEL}>On this order</p><p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{showOrderNote}</p></div>}
                  {customerNoteLines.length > 0 && (
                    <div><p className={LABEL}>From their customer notes</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-foreground/90">{customerNoteLines.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    </div>
                  )}
                  {confirmedPrefs.length > 0 && (
                    <div><p className={LABEL}>Confirmed preferences</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-foreground/90">{confirmedPrefs.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* 7 · MUSIC — one rule. */}
          {isVideoJob && (
            <section id="video-music" data-brief-section="music" className={CARD}>
              <h3 className={H3}>Music</h3>
              <p className="mt-1 text-sm" data-music-rule>
                {musicForVideo
                  ? <>For this video: {musicForVideo}</>
                  : reelSong
                    ? <>Use the song picked with the Studio script: {/^https?:\/\//i.test(reelSong) ? <a href={reelSong} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">song link ↗</a> : reelSong}</>
                    : catalogueMusicAllowed
                      ? "Pick a licensed track below."
                      : "Use trending audio that fits the script's energy, low under the voice."}
              </p>
              {brandBrief?.music && <p className="mt-1 text-sm"><span className="text-muted">They prefer:</span> {brandBrief.music}</p>}
              {(musicType || musicPick) && <p className="mt-1 text-sm text-muted">{[musicType ? `Music type: ${musicType}` : null, musicPick ? `Picked: ${musicPickLine(musicPick)}` : null].filter(Boolean).join(" · ")}</p>}
              {catalogueMusicAllowed && (musicConnected || isOwnerAdmin) && (
                <div className="mt-3">
                  <MusicCard
                    projectId={project.id}
                    connected={musicConnected}
                    isOffice={isOwnerAdmin}
                    canAct={!viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR")}
                    pick={musicPick}
                    pickUrl={musicPickUrl}
                    musicType={musicType}
                  />
                </div>
              )}
            </section>
          )}

          {/* 8 · CHANGES TO MAKE — only when it came back. */}
          {showChanges && (
            <section id="video-changes" data-brief-section="changes" className="min-w-0 space-y-3 rounded-2xl border border-danger/30 bg-danger-soft/20 p-4">
              <h3 className={H3}>Changes to make</h3>
              {/* The reviewer's timestamped notes live on the cut itself
                  (Send to Review, below), where each is played and marked
                  fixed — said here once, not copied. */}
              {activeSub && openOnActive > 0 && (
                <p className="text-sm" data-cut-notes>
                  {openOnActive} note{openOnActive === 1 ? "" : "s"} to fix on v{activeSub.round}{verdictOf(activeSub)?.by ? ` from ${verdictOf(activeSub)!.by!.split(/\s+/)[0]}` : ""} — on the cut under Send to Review, each at its moment in the video.
                </p>
              )}
              {briefsHere.length === 0 && thisVideoAsks.length > 0 && (
                <div className="space-y-2" data-asks="video">
                  <p className={LABEL}>What the client asked{revisionAskedBy ? ` · ${revisionAskedBy}` : ""}</p>
                  {thisVideoAsks.map((ask, i) => <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{ask}</p>)}
                </div>
              )}
              {briefsHere.length === 0 && jobWideAsks.length > 0 && (
                <div className="space-y-2" data-asks="job">
                  <p className={LABEL}>For every video on this job</p>
                  {jobWideAsks.map((ask, i) => <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{ask}</p>)}
                </div>
              )}
              {briefsHere.length > 0 && <details><summary className="flex min-h-11 cursor-pointer items-center text-sm">The client&apos;s original request</summary>
                <RevisionBriefCard briefs={briefsHere} bounced={[]} canTick={false} canReanalyze={isOwnerAdmin && !viewer?.impersonating} />
              </details>}
              {unassignedIssues.length > 0 && <div className="rounded-lg border border-warning/30 p-3 text-sm"><p className="font-medium">Not tied to a video yet — Kyle will confirm which</p><RevisionIssuesPanel issues={unassignedIssues} canReview={false} /></div>}
              <RevisionIssuesPanel issues={selectedIssues} canReview={false} />
            </section>
          )}
        </article>

        {/* SEND TO REVIEW — upload a version, the cut in front of them, the
            notes on it. #submit-cut is where every "upload" link lands. */}
        <div id="submit-cut" className="scroll-mt-20 space-y-4">
          {selectedBrief?.reviewer && <p className="text-sm text-muted">{selectedBrief.reviewer.from === "cut" ? `${selectedBrief.reviewer.name} is reviewing this video.` : `${selectedBrief.reviewer.name} reviews it first.`}</p>}
          {slots.length === 0 && currentCuts.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {currentCuts.map((c, i) => (
                <Link
                  key={c.id}
                  // A cut with no panel of its own still answers #cut-<id>
                  // here, so no revision link can point at nothing.
                  id={panelIds.has(c.id) ? undefined : `cut-${c.id}`}
                  href={`/edit/${project.id}?cut=${c.id}`}
                  className={`inline-flex scroll-mt-24 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
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
          {/* Versions that exist but wait on the send-for-review check (§8.2).
              Anchor #self-check is where the "check needed" bell lands. */}
          <HeldCutsCard
            held={quality.held.map((h) => ({
              submissionId: h.submissionId, round: h.round, fileName: h.fileName, reason: h.reason, sizeBytes: h.sizeBytes, context: h.context,
              label: slots.find((sl) => sl.deliverableId === h.deliverableId && sl.slot === h.slot)?.label ?? h.fileName ?? "Video",
            }))}
            canFinish={canUploadCuts && !viewer?.impersonating}
            onBehalfOf={quality.onBehalfOf}
          />
          {panelSubs.map((s) => (
            <EditorCutPanel
              key={s.id}
              projectId={project.id}
              submissionId={s.id}
              round={s.round}
              status={s.status}
              cutIndex={cutIndexOf(s)}
              cutTotal={slots.length || null}
              cutLabel={slotOf(s)?.deliverableLabel ?? null}
              assetUrl={s.assetUrl}
              streamable={!!s.blobUrl}
              fileName={s.fileName}
              finalFolderUrl={finalUrl}
              notes={notesFor(s)}
              canFix={!isOwnerAdmin}
              viewerName={viewer?.name}
              player={s.id === playerSubId}
              verdict={verdictOf(s)}
            />
          ))}
          <CutUploader
            projectId={project.id}
            canUpload={canUploadCuts}
            checks={quality.checks}
            onBehalfOf={quality.onBehalfOf}
            // Only Jordan and Kyle may send an over-spec file anyway, and
            // only for real: the server checks the role again and puts their
            // name on it (startCutUpload).
            canOverrideExport={!viewer?.impersonating && isOwnerAdmin}
            // Only a named ask raised AFTER this slot's approval reopens its
            // upload door. Another video's revision is not permission to
            // treat this approved cut as the client's change request.
            reopenedSlotKeys={openSlotKeys}
            officeReopen={officeReopen}
            cuts={shownCutRows}
            stillWorking={stillWorking}
          />
          {hiddenSlots >= 3 && (
            <Link
              href={slotsHref(!showAllSlots)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
            >
              {collapseSlots
                ? `${hiddenSlots} more slots with nothing uploaded yet — show`
                : `Hide the ${hiddenSlots} slots with nothing uploaded yet`}
            </Link>
          )}
          {/* The rescue hatch for the old habit — exporting straight into the
              Dropbox Final folder (12 of 26 cuts once came this way). The
              export spec is in the upload panel just above, so it is not
              repeated here. */}
          {/* NOT FOR MONTHLY VIDEOS (Oct 5 2026): their portal only takes the
              checked 1080p file, and the 1080p pass needs the hub's own copy —
              a file sent from the Final folder could never reach the client. */}
          {project.contentMonthId ? (
            <p className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-muted">Monthly videos are sent from here only: upload the file above, even if it&apos;s already in the Final folder. The 1080p finish needs the hub&apos;s own copy.</p>
          ) : (
            <details className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-muted">
              <summary className="flex min-h-11 cursor-pointer items-center">Already dropped a file in the Final footage folder instead?</summary>
              <div className="mt-2"><FolderSendForReview projectId={project.id} onBehalfOf={quality.onBehalfOf} /></div>
            </details>
          )}
          {viewer?.role === "EDITOR" && (
            <Link href="/quality?tab=editors" className="inline-flex text-xs font-medium text-brand hover:underline">
              Your review results →
            </Link>
          )}
        </div>

        {/* THE TEAM'S MESSAGES ON THIS JOB — the board carries its own
            "Team messages" heading and card (and the #messages anchor). */}
        <div className="min-w-0">
          <div>
            <ProjectMessages
              projectId={project.id}
              readOnly={!!viewer?.impersonating}
              canRequestRevision={quality.canReview}
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
        </div>

        {/* ---- EVERYTHING ELSE, FOLDED ---- */}
        <div className="space-y-3" data-brief-more>
          {otherVideos.length > 0 && (
            <details className={CARD}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">Other videos on this job · {otherVideos.length}</summary>
              <ul className="mt-2 space-y-2 text-sm">
                {otherVideos.map((o) => {
                  const latest = cutRows.find((row) => `${row.deliverableId}:${row.slot}` === o.key)?.latest ?? null;
                  return (
                    <li key={o.outputId} className="rounded-xl border border-border bg-surface-2/40 p-3">
                      <span className="font-medium">{navigation.get(o.key)?.number ?? o.index}. {o.topicTitle || o.format}</span>
                      <span className="text-muted"> · {latest ? (latest.status === "APPROVED" ? "Approved" : latest.status === "CHANGES_REQUESTED" ? "Changes requested" : "In review") : "Awaiting edit"}{o.script ? ` · script ${o.script.clientApproved ? "approved by the client" : "not approved by the client yet"}` : ""}</span>
                      {o.note && <p className="mt-1 text-xs text-foreground/85"><span className="text-muted">From the shoot: </span>{o.note}</p>}
                    </li>
                  );
                })}
              </ul>
              {(filming?.slotsWithoutTopic ?? 0) > 0 && <p className="mt-2 text-xs text-muted">{filming!.slotsWithoutTopic} video{filming!.slotsWithoutTopic === 1 ? " has" : "s have"} no topic recorded yet — Kyle will say which.</p>}
            </details>
          )}

          {editorMonth && (
            <details className={CARD}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">{project.client.name}&apos;s month · {editorMonth.monthKey}</summary>
              {editorMonth.allSessionsVisible && editorMonth.counts ? (
                <>
                  <p className="mt-2 text-sm">{editorMonth.allowance} video{editorMonth.allowance === 1 ? "" : "s"} this month · {editorMonth.counts.filmedConfirmed} filmed · {editorMonth.counts.submitted} sent for review · {editorMonth.counts.approved} approved · {editorMonth.counts.delivered} delivered</p>
                  {/* The scope checks are the office's to act on, not the editor's to read. */}
                  {isOwnerAdmin && editorMonth.counts.slotsOnJobs !== editorMonth.allowance && <p className="mt-1 text-xs text-warning">These jobs record {editorMonth.counts.slotsOnJobs} video slots against a package of {editorMonth.allowance}. Reconcile the scope; the slots have not been changed.</p>}
                  {isOwnerAdmin && editorMonth.counts.unpairedCuts > 0 && <p className="mt-1 text-xs text-warning">{editorMonth.counts.unpairedCuts} cut{editorMonth.counts.unpairedCuts === 1 ? " is" : "s are"} not paired with a current video slot.</p>}
                  {isOwnerAdmin && editorMonth.counts.filmedConfirmed < editorMonth.counts.delivered && <p className="mt-1 text-xs text-warning">Filming confirmation is incomplete in the Hub.</p>}
                </>
              ) : <p className="mt-2 text-sm text-muted">Only sessions you can open are shown. Ask Kyle for the full month.</p>}
              <details className="mt-2" id="month-sessions">
                <summary className="min-h-11 cursor-pointer rounded-lg px-2 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand">Sessions this month · {editorMonth.sessions.length}</summary>
                <div className="grid gap-2 lg:grid-cols-2">
                  {editorMonth.sessions.map((session) => (
                    <div key={session.key} className={`rounded-xl border p-3 text-xs leading-relaxed ${session.id === project.id ? "border-brand/40 bg-brand/5" : "border-border bg-surface-2/40"}`}>
                      <p className="text-sm font-semibold">{session.id === project.id ? "This job · " : ""}{session.title}{session.appointmentsOnJob > 1 ? ` · appointment ${session.appointmentIndex} of ${session.appointmentsOnJob}` : ""}</p>
                      <p className="text-muted">{session.dateISO ? `${new Date(session.dateISO).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET` : "Date not recorded"} · {session.status.toLowerCase().replace(/_/g, " ")}</p>
                      <p>Topics: {session.topics.length ? session.topics.join("; ") : "none linked to this job"}</p>
                      {session.id !== project.id && (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-medium text-brand">
                          <Link href={`/edit/${session.id}`} className="hover:underline">Open that job&apos;s brief →</Link>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
              {isOwnerAdmin && <p className="mt-2 text-xs text-muted">{editorMonth.unlinkedClientJobs > 0 ? `${editorMonth.unlinkedClientJobs} other client video job${editorMonth.unlinkedClientJobs === 1 ? " has" : "s have"} no month link. ` : ""}Repair a missing or wrong month link in <Link href={`/content/${editorMonth.enrollmentId}?tab=production&view=sessions&month=${editorMonth.monthKey}`} className="font-medium text-brand hover:underline">Content Program → Sessions</Link>.</p>}
            </details>
          )}
          {monthRead.failed && project.contentMonthId && <p role="alert" className="rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm text-warning">This client&apos;s month could not be loaded. The video brief above is complete; reload to try the month again.</p>}

          {/* HISTORY — the tracker, every version sent, the review notes. */}
          {(showTracker || feedback.length > 0 || quality.issues.length > 0) && (
            // Open when the office has just moved a reopened job's date, so
            // the form's own confirmation is on screen (#reopened-due).
            <details className={CARD} open={!!dueNotice}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">History · {rounds.length} version{rounds.length === 1 ? "" : "s"} sent for review</summary>
              <div className="mt-3 space-y-4">
                {showTracker && (
                  <section id="edit-history" className="scroll-mt-24">
                    <EditTracker
                      stage={stage}
                      statusLine={statusLine}
                      hadRevision={hadRevision}
                      editType={trackerEditType}
                      dueISO={selectedDue ? selectedDue.toISOString() : null}
                      // The deadline is said once, at the top of the brief —
                      // except where the office moves a reopened job's date,
                      // which needs the date beside its form.
                      hideDue={!(!selectedPromise && reopened && strictOwnerAdmin && !viewer?.impersonating)}
                      hideMusic
                      overridden={{ due: selectedPromise ? false : reopened ? reopened.office : overrides.dueAt != null, editType: overrides.typeDetail != null }}
                      dueWords={selectedPromise ? "This video’s promised deadline" : reopened ? (reopened.at ? reopened.words : "Reopened, no due date yet") : null}
                      moveDue={
                        !selectedPromise && reopened && strictOwnerAdmin && !viewer?.impersonating
                          ? { action: moveReopenedDueForm, projectId: id, defaultLocal: etLocalInput(trackerDue ?? new Date()), notice: dueNotice }
                          : null
                      }
                      shootDateISO={project.shootDate ? project.shootDate.toISOString() : null}
                      photographerName={project.photographer?.name ?? null}
                      song={project.reelSong}
                      rounds={rounds}
                      // The client's asks are in "Changes to make" above.
                      revisionAsks={[]}
                      revisionAtISO={revisionAtISO}
                      revisionAskedBy={revisionAskedBy}
                      revisionHref={revisionHref}
                      showSubmitAnchor={false}
                      evidence={footage}
                    />
                  </section>
                )}
                {reviewerStrip && <ReviewerStrip data={reviewerStrip} />}
                <EditFeedback notes={feedback} canFix={false} />
                <RevisionIssuesPanel issues={quality.issues} canReview={quality.canReview} attestations={quality.attestations} />
              </div>
            </details>
          )}

          {/* THE FULL STYLE GUIDE for what is on this job — same data as
              /resources/video-styles, so the two cannot drift. */}
          {editDeliverables.length > 0 && (
            <details className={CARD}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">Style guide{styleType ? ` · ${styleType.name}` : ""}</summary>
              <div className="mt-3 space-y-4">
                {editDeliverables.map((d) => {
                  const vt = videoTypeOf(d);
                  const tierMeta = VIDEO_TIER[vt.tier];
                  const chip = refinedDeliverableLabel(d.type, d.label);
                  const orderedAs = d.productTitle?.trim() && d.productTitle.trim() !== chip ? d.productTitle.trim() : null;
                  return (
                    <div key={d.id} className="rounded-xl border border-border bg-surface-2/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium" style={{ backgroundColor: `${tierMeta.color}1a`, color: tierMeta.color }}>
                          <Film className="size-3.5" /> {chip}
                        </span>
                        <span className="text-xs text-muted">{vt.name} · {tierMeta.edit}</span>
                        {orderedAs && <span className="text-xs text-muted-2">ordered as “{orderedAs}”</span>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {vt.style.map((st) => <span key={st} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">{st}</span>)}
                      </div>
                      {vt.note && <p className="mt-2 text-xs leading-relaxed text-muted">{vt.note}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {vt.examples.map((e) => (
                          <a key={e.url} href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-brand hover:border-brand">
                            <PlayCircle className="size-3" /> {e.label}
                          </a>
                        ))}
                        <Link href="/resources/video-styles" className="text-[11px] font-medium text-muted hover:text-foreground">Full Style Guide →</Link>
                      </div>
                    </div>
                  );
                })}
                {isVideoJob && <AocPlaybookCard context="edit" />}
              </div>
            </details>
          )}

          {/* EXPORT DETAILS — the full 1080p guide (lib/videoStyles EXPORT_SPEC). */}
          {isVideoJob && (
            <details className={CARD}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">Export details · 1080p</summary>
              <div className="mt-2 space-y-1.5 text-sm leading-relaxed">
                <p className="flex items-center gap-1.5 font-semibold"><FileVideo className="size-4 text-brand" /> {EXPORT_SPEC.headline}</p>
                <p className="font-medium">{EXPORT_SPEC.finalCut}</p>
                <p className="text-foreground/85">{EXPORT_SPEC.edit}</p>
                <p className="text-muted">{EXPORT_SPEC.orientation}</p>
                <p className="font-medium">{EXPORT_SPEC.audio}</p>
                <p className="text-muted">{EXPORT_SPEC.why}</p>
              </div>
            </details>
          )}
        </div>

        {/* ---- FOR THE OFFICE — writing the brief, packets, waiting files ---- */}
        {isOwnerAdmin && (
          <div className="space-y-4" data-office-tools>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">For the office</h2>
            {pageNotice?.where === "brief" && (
              <p className={`rounded-lg px-3 py-2 text-xs font-medium ${pageNotice.ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>{pageNotice.text}</p>
            )}
            {receiptLines.length > 0 && <p className="text-sm text-muted">{receiptLines.join(" ")}</p>}
            {unconfirmedAsks.length > 0 && (
              <Section icon={Quote} title="Asked for on site, not confirmed yet">
                <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
                  {unconfirmedAsks.map((f) => (
                    <li key={f.id}>
                      {f.body}
                      <span className="ml-1.5 text-xs text-muted-2">{f.by ? `${f.by}, ` : ""}waiting for the office to confirm</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {selectedBrief && canWriteBriefs && (
              <details id={`office-brief-${selectedBrief.outputId}`} className={CARD}>
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">
                  {selectedBrief.version ? `Edit video ${videoNumber}'s brief · v${selectedBrief.version}${selectedBrief.updatedBy ? `, saved by ${selectedBrief.updatedBy}` : ""}` : `Write a brief for video ${videoNumber}`}
                </summary>
                <form action={saveVideoBriefForm} className="mt-2 space-y-2">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="outputId" value={selectedBrief.outputId} />
                  <input type="hidden" name="expectedVersion" value={selectedBrief.version ?? ""} />
                  {brandBrief ? <label className="block text-sm font-medium text-muted">
                    Logo or branding card for this video
                    <select name="brandAssetVersionId" defaultValue={selectedBrief.brandChoice === "none" ? "__none__" : selectedBrief.brandAsset?.versionId ?? ""} className="mt-0.5 min-h-11 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm font-normal text-foreground focus-visible:outline-2 focus-visible:outline-brand">
                      <option value="">Not chosen — the editor uses their logo if there is one</option>
                      <option value="__none__">No logo or branding card on this video</option>
                      {selectedBrief.brandAsset && !brandBrief.files.some((f) => f.versionId === selectedBrief.brandAsset?.versionId) && <option value={selectedBrief.brandAsset.versionId}>{selectedBrief.brandAsset.name} · previously chosen, check current kit</option>}
                      {brandBrief.files.filter((f) => f.type === "LOGO" || f.type === "BRANDING_CARD").map((f) => <option key={f.versionId} value={f.versionId}>{f.typeWord} · {f.name} · v{f.versionNo}{f.fileName ? ` · ${f.fileName}` : ""}</option>)}
                    </select>
                  </label> : <p className="text-sm text-warning">The brand kit could not be read. This video&apos;s saved brand choice will stay as it is.</p>}
                  {OUTPUT_BRIEF_FIELDS.map((f) => (
                    <label key={f.key} className="block text-sm font-medium text-muted">
                      {f.label}
                      {f.key === "specs" && <span className="block text-xs font-normal text-muted-2">Leave empty to use the default: {defaultMakeThis(styleKey)}</span>}
                      <textarea
                        name={`s_${f.key}`}
                        defaultValue={selectedBrief.sections.find((x) => x.key === f.key)?.text ?? ""}
                        maxLength={OUTPUT_BRIEF_FIELD_CAP}
                        rows={2}
                        placeholder={f.key === "specs" ? defaultMakeThis(styleKey) : undefined}
                        className="mt-1 w-full rounded-lg border bg-surface px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-brand"
                      />
                    </label>
                  ))}
                  <Button type="submit">Save as v{(selectedBrief.version ?? 0) + 1}</Button>
                </form>
                {/* §7.6: a limitation is missing work once somebody says so. */}
                {selectedBrief.sections.some((x) => x.key === "limitations" && x.text.trim()) && !briefGaps.some((g) => g.outputId === selectedBrief.outputId) && (
                  <form action={raiseGapFromBriefForm} className="mt-2">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="outputId" value={selectedBrief.outputId} />
                    <Button type="submit" variant="secondary" className="border-warning/40 text-warning">Raise the limitation as missing work</Button>
                  </form>
                )}
              </details>
            )}
            {/* The job-wide spec and notes, and the Studio reel script, where
                the office edits them (editors read them in the brief above). */}
            <details className={CARD}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand">Job instructions and notes (every video)</summary>
              <div className="mt-3 space-y-4">
                <EditInstructionsCard projectId={project.id} spec={{ ...editSpec, music: musicPick }} canEdit={isOwnerAdmin} brief={briefFields} />
                {(reelScriptOnFile || showScript) && (
                  <ReelScriptCard
                    hook={project.reelHook}
                    script={project.reelScript}
                    song={project.reelSong}
                    shotList={project.reelShotList}
                    updatedAt={project.reelRecipeUpdatedAt ? project.reelRecipeUpdatedAt.toISOString() : null}
                    studioUrl={project.scriptingUrl ?? project.reelScriptUrl}
                    projectId={project.id}
                    canEdit={isOwnerAdmin}
                  />
                )}
              </div>
            </details>
            {/* §10 J3 (Sep 28) — WAITING ON A FILE. See assetDesk above. */}
            {assetDesk && (
              <AssetDependencyCard
                projectId={project.id}
                open={(assetDeps ?? []).map((d) => ({
                  taskId: d.taskId,
                  stage: d.stage,
                  sentence: d.sentence,
                  scope: d.outputId ? assetVideoWords.get(d.outputId) ?? "A video no longer on this job" : "The whole job",
                }))}
                videos={outputBriefs.map((o) => ({ outputId: o.outputId, label: assetVideoWords.get(o.outputId) ?? o.label }))}
                people={assetPeople}
                readFailed={assetDeps === null}
              />
            )}
            {/* §7.7 / A33 — THE LUMA VISUALS PACKET. The hub sends nothing. */}
            {agency && (
              <div id="agency-packet">
                <Section icon={ExternalLink} title={`${agency.vendorName} packet`} tone={agency.status === "not_sent" || agency.status === "out_of_date" ? "warning" : "default"} bodyClassName="space-y-3">
                  {pageNotice?.where === "packet" && (
                    <p className={`rounded-lg px-3 py-2 text-xs font-medium ${pageNotice.ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>{pageNotice.text}</p>
                  )}
                  <p className="text-sm font-medium">{agency.line}</p>
                  {!agency.handedOver && (
                    <p className="text-xs text-muted">This job is not handed to {agency.vendorName} right now. The sends below are its history.</p>
                  )}
                  {agency.packet && agency.packet.missing.length > 0 && (
                    <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                      <p className="font-medium">Missing from the packet right now:</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {agency.packet.missing.map((m) => <li key={m.key}>{m.label} ({m.owner})</li>)}
                      </ul>
                    </div>
                  )}
                  <p className="text-xs">
                    <a href={`/api/projects/${project.id}/editor-packet/preview`} className="font-medium text-brand hover:underline">Preview the packet as it would go now</a>
                    <span className="text-muted"> · nothing is sent from the hub</span>
                  </p>
                  {agency.history.length > 0 && (
                    <ul className="space-y-1.5 text-xs">
                      {agency.history.map((d) => (
                        <li key={d.id} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                          <span className="font-medium">v{d.version}</span> sent to {d.recipient} ({d.channelLabel}) by {d.dispatchedBy},{" "}
                          {new Date(d.dispatchedAtISO).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET
                          {d.acknowledgedAtISO ? ` · acknowledged by ${d.acknowledgedBy ?? "someone"}` : " · not acknowledged"}
                          {d.superseded ? " · replaced by a later version" : ""}
                          {d.missing.length > 0 ? ` · ${d.missing.length} missing when sent` : ""}{" "}
                          <a href={`/api/projects/${project.id}/editor-packet/${d.version}`} className="font-medium text-brand hover:underline">Download v{d.version}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {agency.handedOver && !viewer?.impersonating && (
                    <form action={recordEditorPacketSentForm} className="space-y-2 rounded-xl border border-border p-3">
                      <p className="text-xs font-semibold">Record a send</p>
                      <input type="hidden" name="projectId" value={project.id} />
                      <input name="recipient" required minLength={2} maxLength={200} placeholder={`Who at ${agency.vendorName} it went to (email or name)`} className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs" />
                      <select name="channel" required defaultValue="" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs">
                        <option value="" disabled>How it was sent</option>
                        {agencyMod.DISPATCH_CHANNELS.map((c) => <option key={c} value={c}>{agencyMod.DISPATCH_CHANNEL_LABEL[c]}</option>)}
                      </select>
                      <input name="note" maxLength={500} placeholder="Note (optional)" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs" />
                      <button type="submit" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                        Record packet v{(agency.latest?.version ?? 0) + 1} as sent
                      </button>
                    </form>
                  )}
                  {agency.latest && !agency.latest.acknowledgedAtISO && !viewer?.impersonating && (
                    <form action={recordEditorPacketAckForm} className="space-y-2 rounded-xl border border-border p-3">
                      <p className="text-xs font-semibold">Record that {agency.vendorName} has v{agency.latest.version}</p>
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="dispatchId" value={agency.latest.id} />
                      <input name="by" required maxLength={120} placeholder="Who acknowledged it" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs" />
                      <select name="source" required defaultValue="" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs">
                        <option value="" disabled>How they said so</option>
                        {agencyMod.ACK_SOURCES.map((c) => <option key={c} value={c}>{agencyMod.ACK_SOURCE_LABEL[c]}</option>)}
                      </select>
                      <input name="note" maxLength={500} placeholder="Note (optional)" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-xs" />
                      <button type="submit" className="rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-soft/40">Record acknowledgement</button>
                    </form>
                  )}
                </Section>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The Editing Room's upload identifier, reused on the brief's Media buttons so
// the editor sees the same truth in both places: green = the hourly sweep found
// files in that folder (with the count), hollow = nothing there yet, and a
// muted dot when the last read was stale (Dropbox couldn't be read this pass).
function UploadDot({ n, stale }: { n: number; stale: boolean }) {
  const title = n > 0 ? `${n} file${n === 1 ? "" : "s"} uploaded (checked hourly)` : stale ? "Last Dropbox read failed — count may be behind" : "Nothing uploaded yet (checked hourly)";
  return (
    <span
      title={title}
      aria-label={title}
      className={
        n > 0
          ? "ml-0.5 inline-block size-2.5 rounded-full bg-success"
          : stale
            ? "ml-0.5 inline-block size-2.5 rounded-full bg-muted-2/60"
            : "ml-0.5 inline-block size-2.5 rounded-full border border-muted-2"
      }
    />
  );
}

// ---------------------------------------------------------------------------
// MOVE THE REOPENED DUE (A52 — "a person can move it"). A plain form post, so
// it works before any script loads; the office only, re-checked here because a
// server action is reachable by a direct POST. The time is typed as ET wall
// clock (the office's own clock) and saved by revisionBrief.moveReopenedDue,
// which records who, when, and what it was.
// ---------------------------------------------------------------------------
const REOPENED_DUE_NOTICES: Record<string, { ok: boolean; text: string }> = {
  "due-moved": { ok: true, text: "Moved. The board, the Editing Room and this page all read the new date." },
  "due-error": { ok: false, text: "Not moved. Pick a time that hasn't passed and is within 60 days, on a job that is reopened." },
  "due-denied": { ok: false, text: "Only the office can move a due date." },
};

/** A Date as the value a datetime-local input takes, on the ET wall clock. */
function etLocalInput(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

async function moveReopenedDueForm(form: FormData): Promise<void> {
  "use server";
  const projectId = String(form.get("projectId") ?? "").trim().slice(0, 64);
  const raw = String(form.get("dueAt") ?? "").trim();
  const back = (n: string): never => redirect(`/edit/${encodeURIComponent(projectId)}?notice=${n}#reopened-due`);
  const { requireRole } = await import("@/lib/auth/guards");
  const allowed = await requireRole(["OWNER", "ADMIN"]).then(() => true, () => false);
  if (!allowed) back("due-denied");
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!projectId || !m) back("due-error");
  const { etAt } = await import("@/lib/datetime");
  const dueAt = etAt(m![1], Number(m![2]), Number(m![3]));
  const me = await getCurrentUser().catch(() => null);
  // A preview dates nothing, enforced or not (Sep 28, gap 20).
  if (me?.impersonating) back("due-denied");
  const { moveReopenedDue } = await import("@/lib/revisionBrief");
  // The display name — roster before email (Sep 28).
  const { displayNameFor } = await import("@/lib/actorName");
  const by = (await displayNameFor(me)) || "The office";
  const r = await moveReopenedDue({ projectId, dueAt, by }).catch(() => ({ ok: false }));
  back(r.ok ? "due-moved" : "due-error");
}
