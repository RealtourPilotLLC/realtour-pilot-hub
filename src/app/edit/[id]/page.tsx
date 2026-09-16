import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle, Film, FileVideo, FolderOpen, Palette, MessageSquare, ExternalLink, PlayCircle, Quote,
} from "lucide-react";
import { EXPORT_SPEC, VIDEO_TIER, VIDEO_TYPES, videoTypeForDeliverable } from "@/lib/videoStyles";
import { listClientAssets } from "@/lib/clientAssets";
import { ClientAssetsCard } from "@/components/clients/ClientAssetsCard";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getProject, getTeam } from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { parseClientProfile } from "@/lib/clientProfile";
import { ClientProfileCard } from "@/components/clients/ClientProfileCard";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { EditInstructionsCard } from "@/components/editing/EditInstructionsCard";
import { MusicCard } from "@/components/editing/MusicCard";
import { epidemicSoundConnected } from "@/lib/integrations/epidemicSound";
import { parseEditSpec, musicPickOf } from "@/lib/musicPick";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { EditorCutPanel } from "@/components/editing/EditorCutPanel";
import { CutUploader } from "@/components/editing/CutUploader";
import { autoSyncScript } from "@/lib/scriptSync";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { getVideoSlaStatus, videoTier } from "@/lib/projectStatus";
import { SubmitCutCard } from "@/components/editing/EditorActions";
import { EditFeedback } from "@/components/editing/EditFeedback";
import { EditTracker, deriveEditStage, type RoundRow } from "@/components/editing/EditTracker";
import { EditOverridesButton } from "@/components/editing/EditOverridesDialog";
import { computedView, computedVideosOwed, effectiveDue, effectiveTypeDetail, overrideView } from "@/lib/editOverrides";
import { STATUS_LABEL } from "@/lib/editorQueue";
import { editorKeyForTeamName, editorMeta } from "@/lib/editors";
import { RevisionBriefCard, type BouncedCutView } from "@/components/editing/RevisionBriefCard";
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
// "Standard Reels don't get scripts" (Jordan, Sep 2): the agent-intro reel has
// an intro script, and every premium and personal-branding cut is scripted; a
// plain standard reel or cinematic is B-roll to music, so the Script card —
// and its "No script on file yet" warning — would only send the editor
// waiting for words that are never coming.
const SCRIPTED_STYLE_RE = /^(standard_reel_agent_intro|premium_|personal_branding)/;

// The EDITOR's brief screen for one job. Creative-safe (no pricing/financials).
//
// Ordered around the editor's actual job (Jordan, Sep 2: "there is too much to
// look at"): where the media is → what to make → how to make it → do the work
// → what the client is like → history.
//   0. Back — to the Editing Room queue, or wherever they came from in-app
//   1. the work order (only on a bounced job — then it IS the job)
//   2. Media — RAW, Final, brand assets, the client's asset shelf, their colors
//      (first, so the download is running while they read — Jordan, Sep 2)
//   3. What to make — each video with ITS style (Deliverable.videoStyle) and
//      the Guide's notes + examples for that style. Above the instructions
//      (Jordan, Sep 2: "What to make should be above edit instructions")
//   4. Edit instructions — ONE card: the spec, the customer's words on this
//      order, everything that came off the shoot, then our Additional notes
//   5. Script — the locked words; only for styles that HAVE a script
//   6. Send to Review — upload a version per cut, the cut in review, the notes
//      on it (Jordan, Sep 2: "instead of Cuts to deliver, it should say Send
//      to Review")
//   7. Project chat
// The right rail is client context only — the same compact working-profile
// brief for every viewer, owner included (Jordan, Sep 2, round 3); reference
// material sits in a <details> so it is there without being in the way.
export default async function EditBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string; slots?: string }>;
}) {
  const { id } = await params;
  // `slots=all` opens the empty cut slots a big job collapses by default
  // (Jordan, Sep 16 — see the Send to Review block below).
  const { cut, slots: slotsParam } = await searchParams;
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
      // decidedBy: who sent the cut back, named on the revision block (Sep 16).
      // sourceWidth/Height: what the version actually was (Sep 16, the 1080p
      // export spec) — printed on its Send-to-Review row.
      select: { id: true, round: true, status: true, assetUrl: true, assetPath: true, fileName: true, submittedByName: true, note: true, createdAt: true, decidedAt: true, decidedBy: true, deliverableId: true, slot: true, source: true, blobUrl: true, completedAt: true, sourceWidth: true, sourceHeight: true },
    }),
  ]);
  if (!project) notFound();

  // Opening the edit page reads its Project chat (Sep 16, Kyle call): only the
  // message centre stamped the ThreadRead watermark, so a thread read HERE —
  // where the editor actually works — stayed bold on the Messages badge and on
  // Communications → Team. Same upsert as the centre, seenAt only (a closed
  // conversation stays closed), never from a "view as" preview.
  if (viewer && !viewer.impersonating) {
    await prisma.threadRead
      .upsert({
        where: { userKey_projectId: { userKey: viewer.id, projectId: project.id } },
        update: { seenAt: new Date() },
        create: { userKey: viewer.id, projectId: project.id },
      })
      .catch(() => {});
  }

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
    slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot) ?? null;
  const slotLabelOf = (s: (typeof submissions)[number]) => slotOf(s)?.label ?? null;
  // WHICH of the job's cuts this is — "cut 1 of 16". The position in the owed
  // list, not the slot number, so a job with several deliverables still counts
  // straight through (Jordan, Sep 16: one bounced cut inside sixteen identical
  // slots named nothing at all).
  const cutIndexOf = (s: (typeof submissions)[number]) => {
    const i = slots.findIndex((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot);
    return i === -1 ? null : i + 1;
  };
  const activeSub =
    (cut ? submissions.find((s) => s.id === cut) : null) ??
    [...currentCuts].reverse().find((s) => s.status === "CHANGES_REQUESTED" || s.status === "PENDING") ??
    // Never auto-open on a cut that was taken back — it is still reachable by
    // ?cut=<id> from the round history (Sep 16).
    liveSubs[liveSubs.length - 1] ??
    latestRound;
  const assetKeyOf = (s: (typeof submissions)[number]) => s.assetUrl ?? `cut:${s.id}`;
  const notesFor = (s: (typeof submissions)[number]) => feedback.filter((n) => n.assetUrl === assetKeyOf(s));
  const activeNotes = activeSub ? notesFor(activeSub) : [];
  // EVERY bounced cut gets its own panel, not just the active one — a link
  // that says "cut 3 of 16" has to land on cut 3 even when cut 1 is the one
  // the page opened on. Ordered the way the job owes them.
  const bouncedCuts = [...latestLivePerCut.values()].filter((s) => s.status === "CHANGES_REQUESTED");
  const panelSubs = [
    ...new Map([...(activeSub ? [activeSub] : []), ...bouncedCuts].map((s) => [s.id, s])).values(),
  ].sort((a, b) => (cutIndexOf(a) ?? 9999) - (cutIndexOf(b) ?? 9999) || a.round - b.round);
  // ONE player on the page: the cut in front of them. Every other panel is
  // notes-only (Sep 16 review — four bounced cuts would otherwise mount four
  // <video> elements and fetch four sets of metadata); they still carry their
  // anchor, and one click makes them the cut in front.
  const playerSubId = activeSub?.id ?? panelSubs[0]?.id ?? null;
  const panelIds = new Set(panelSubs.map((s) => s.id));
  const panelKeys = new Set(panelSubs.map(assetKeyOf));
  const otherNotes = feedback.filter((n) => !panelKeys.has(n.assetUrl));
  // The cut a revision link must land on: the one in front of them if it is
  // the bounced one, else the first cut waiting on changes.
  const revisionCut = (activeSub?.status === "CHANGES_REQUESTED" ? activeSub : null) ?? bouncedCuts[0] ?? null;
  const revisionHref = revisionCut ? `#cut-${revisionCut.id}` : null;
  // Which submissions have an anchor on this page — a panel, or (on a
  // multi-cut job) their chip in the switcher. Only those become links.
  const anchored = new Set<string>([
    ...panelIds,
    ...(currentCuts.length > 1 ? currentCuts.map((s) => s.id) : []),
  ]);
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
    // Name the cut and link to it — sixteen "Round 1" lines are unreadable,
    // and a round the editor can click is one they can act on (Sep 16).
    cutLabel: slotLabelOf(s),
    href: anchored.has(s.id) ? `#cut-${s.id}` : null,
  }));
  // THE REVIEW ROOM'S ASKS, as a work order. A bounce writes no RevisionBrief
  // — it is Jordan's own timestamped notes on a cut — so the revision card
  // rendered NOTHING for it and the notes lived only inside the cut panel,
  // wherever that happened to be on the page (Jordan, Sep 16: "the revision
  // requests are not showing up well in the editor brief").
  const bouncedCards: BouncedCutView[] = bouncedCuts.map((s) => ({
    submissionId: s.id,
    index: cutIndexOf(s),
    total: slots.length || null,
    cutLabel: slotOf(s)?.deliverableLabel ?? null,
    round: s.round,
    fileName: s.fileName,
    sentBackAtISO: s.decidedAt ? s.decidedAt.toISOString() : null,
    sentBackBy: s.decidedBy,
    notes: notesFor(s).map((n) => ({
      id: n.id,
      timeSec: n.timeSec,
      body: n.body,
      authorName: n.authorName,
      status: n.status,
      kind: n.kind,
    })),
  }));
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
  const trackerDue = effectiveDue(project, sla?.due ?? null);
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
      label: sl.label,
      latest: latest
        ? { id: latest.id, round: latest.round, status: latest.status, fileName: latest.fileName, completedAt: latest.completedAt ? latest.completedAt.toISOString() : null, note: latest.note, sourceWidth: latest.sourceWidth, sourceHeight: latest.sourceHeight }
        : null,
      openNotes,
    };
  });
  const nextEmptyIdx = cutRows.findIndex((r) => !r.latest);
  const keepSlot = (r: (typeof cutRows)[number], i: number) => !!r.latest || i === nextEmptyIdx;
  const hiddenSlots = cutRows.filter((r, i) => !keepSlot(r, i)).length;
  // Worth a fold only when it hides a wall of rows; a normal job is untouched.
  const collapseSlots = hiddenSlots >= 3 && !showAllSlots;
  const shownCutRows = collapseSlots ? cutRows.filter(keepSlot) : cutRows;
  const uploadedSlots = cutRows.filter((r) => r.latest && isLive(r.latest)).length;
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

  return (
    <div>
      {/* Back to where they came from — BackLink walks the in-app history
          (the Editing Room queue for an editor, Ops Day or the project page
          for the owner) and falls back to the queue on a cold deep link. */}
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/editing" label="Editing Room" />
      </div>
      <PageHeader
        eyebrow="Editor brief"
        title={street}
        // The agent's headshot beside their name — Aryeo's customer avatar,
        // mirrored to Client.avatarUrl by the nightly sync; the initials disc
        // when they have none (Jordan, Sep 2: "if the agent has a profile
        // photo in aryeo that should be shown here too as well as in other
        // places the clients are mentioned").
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Avatar name={project.client.name} src={project.client.avatarUrl} size={20} />
            {project.client.name}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* THE OVERRIDE (Jordan, Sep 13) — office only, and never from a
                "view as" preview (read-only; the server re-checks). Wears the
                Override chip when one is set; its receipt shows as a note
                under the button. */}
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
            // The office's override, when set, outranks both (Sep 13) — and
            // the facts say so with a tag.
            editType={trackerEditType}
            dueISO={trackerDue ? trackerDue.toISOString() : null}
            overridden={{ due: overrides.dueAt != null, editType: overrides.typeDetail != null }}
            shootDateISO={project.shootDate ? project.shootDate.toISOString() : null}
            photographerName={project.photographer?.name ?? null}
            song={project.reelSong}
            rounds={rounds}
            // When a work order exists it carries the asks in full, itemised —
            // repeating the raw paragraph here would be the wall of text twice.
            revisionAsks={briefs.length > 0 ? [] : revisionAsks}
            revisionAtISO={revisionAtISO}
            // "It should go directly to the cut that needs a revision"
            // (Jordan, Sep 16) — the status line and the ask both land on it.
            revisionHref={revisionHref}
            showSubmitAnchor={!isOwnerAdmin}
          />
        </div>
      )}

      {/* One line, only when something is owed on the current cut. It used to
          jump to #submit-cut — the whole Send-to-Review block — which on a
          16-slot job is "down to the cuts", not to the cut (Jordan, Sep 16).
          Now it lands on that cut's own panel. */}
      {needsWork && (
        <div className="px-4 pt-4 sm:px-6">
          <a
            href={revisionHref ?? (activeSub ? `#cut-${activeSub.id}` : "#submit-cut")}
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
        {/* LEFT — where the media is, what to make, how to make it, the work, the history */}
        {/* min-w-0: a grid item's automatic minimum is its MIN-CONTENT, so one
            line of non-wrapping text anywhere in this column stretches the
            whole track past the screen. The revision card's one-line summary
            (white-space: nowrap, ellipsised) did exactly that — on a 375px
            phone the column measured 1144px and every card in it, Media
            included, ran off the right edge. */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* 1 · THE WORK ORDER — every change asked for on this job. Two
              kinds reach it: the CLIENT's own request, split into items the
              editor ticks off with their words kept whole underneath, and (as
              of Sep 16) each cut the Review Room sent back, with Jordan's
              timestamped notes on it and a link straight to that cut below.
              It renders nothing when neither exists; when it does render, it
              is the job, so it goes first. */}
          <RevisionBriefCard
            briefs={briefs}
            bounced={bouncedCards}
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
                  <FolderOpen className="size-4 text-muted" /> RAW footage <UploadDot n={folderCounts.raw} stale={folderCounts.stale} /> <ExternalLink className="size-3.5 text-muted-2" />
                </a>
                <a href={finalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                  <FolderOpen className="size-4 text-muted" /> Final footage <UploadDot n={folderCounts.final} stale={folderCounts.stale} /> <ExternalLink className="size-3.5 text-muted-2" />
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

          {/* 3 · WHAT TO MAKE, by type — each deliverable with ITS style's
              notes and live examples (same data as the Style Guide, so they
              can't drift). Jordan: "notes about the type of video should be on
              the editing page in the What to make section, with examples." The
              style comes from Deliverable.videoStyle (the product actually
              ordered), and the verbatim order line sits beside it when it says
              more than the category label does — 626 Greycliffe was "Standard
              Reel with Agent Intro" on the order and "Social Reel" here
              (Jordan: "That should be shown as video type"). ABOVE the
              instructions: the editor sees WHAT they are cutting before they
              read how this client wants it cut (Jordan, Sep 2: "What to make
              should be above edit instructions"). */}
          <Section icon={Film} title="What to make">
            {editDeliverables.length === 0 && <span className="text-sm text-muted">No deliverables listed.</span>}
            <div className="space-y-4">
              {editDeliverables.map((d) => {
                const vt = videoTypeOf(d);
                const tierMeta = VIDEO_TIER[vt.tier];
                const chip = refinedDeliverableLabel(d.type, d.label);
                const orderedAs = d.productTitle?.trim() && d.productTitle.trim() !== chip ? d.productTitle.trim() : null;
                return (
                  <div key={d.id} className="rounded-xl border border-border bg-surface-2/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium"
                        style={{ backgroundColor: `${tierMeta.color}1a`, color: tierMeta.color }}
                      >
                        <Film className="size-3.5" /> {chip}
                      </span>
                      <span className="text-xs text-muted">{vt.name} · {tierMeta.edit}</span>
                      {orderedAs && <span className="text-xs text-muted-2">ordered as “{orderedAs}”</span>}
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
            {/* HOW IT LEAVES FINAL CUT — one line for the whole job, not one
                per video: the export is the same whatever the style. It sits
                at the BOTTOM of "What to make" on purpose (Jordan, Sep 16:
                "that should be in the editor brief that the final files should
                be exported in 1080") — the editor has just read what they are
                cutting, and the last thing this section says is what the
                finished file has to be. The Send-to-Review panel says it again
                at the moment of export, and the Style Guide and the printable
                brief print the same EXPORT_SPEC (lib/videoStyles), so no two
                surfaces can disagree.
                ONLY when the job actually owes video (Sep 16 review):
                editDeliverables falls back to the whole owed list when there is
                no video on the order, so without this gate a photo-only job's
                brief would list the retouching and then tell a retoucher how to
                export from Final Cut. It also keeps the card off an empty
                section — no deliverables listed, and then an export spec for
                nothing. */}
            {videoDeliverables.length > 0 && (
              <div className="mt-4 rounded-xl border border-brand/25 bg-brand-soft/40 p-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <FileVideo className="size-4 text-brand" /> {EXPORT_SPEC.headline}
                </p>
                <p className="mt-1.5 text-xs font-medium leading-relaxed text-foreground">{EXPORT_SPEC.finalCut}</p>
                <p className="mt-1 text-xs leading-relaxed text-foreground/85">{EXPORT_SPEC.edit}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">{EXPORT_SPEC.orientation}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">{EXPORT_SPEC.why}</p>
              </div>
            )}
          </Section>

          {/* 3b · MUSIC — right under What to make (Jordan, Sep 15: "they
              should be able to find music in the editor brief for copyright
              free music"): search, preview, pick and download a licensed
              Epidemic Sound track for this job. Video jobs only. Photographers
              never reach this page; editors see the card once the key is
              connected, the office sees the "connect it" note until then;
              a "view as" preview can look but not pick or download. */}
          {videoDeliverables.length > 0 && (musicConnected || isOwnerAdmin) && (
            <MusicCard
              projectId={project.id}
              connected={musicConnected}
              isOffice={isOwnerAdmin}
              canAct={!viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR")}
              pick={musicPick}
              pickUrl={musicPickUrl}
              musicType={typeof editSpec.musicType === "string" ? editSpec.musicType : null}
            />
          )}

          {/* 4 · HOW TO MAKE IT, in words — the spec, the customer's own words
              on this order, and everything that came off the shoot, in one
              card. */}
          <EditInstructionsCard
            projectId={project.id}
            spec={{ ...editSpec, music: musicPick }}
            canEdit={isOwnerAdmin}
            brief={briefFields}
          />

          {/* 5 · THE SCRIPT — READ-ONLY, pulled automatically from the Script
              Writing platform by this project's id (page render + hourly cron
              + signed webhook; scripts are never written in the hub). The
              editor pastes overlay text from here — re-typing is the #1
              typo/revision driver. Only for styles that HAVE a script (see
              SCRIPTED_STYLE_RE): a plain Standard Reel gets no card and no
              "No script on file yet" to wait on. */}
          {showScript && (
            (project.reelHook || project.reelScript) ? (
              <ReelScriptCard
                hook={project.reelHook}
                script={project.reelScript}
                song={project.reelSong}
                shotList={project.reelShotList}
                updatedAt={project.reelRecipeUpdatedAt ? project.reelRecipeUpdatedAt.toISOString() : null}
                studioUrl={isOwnerAdmin ? (project.scriptingUrl ?? project.reelScriptUrl) : null}
                projectId={project.id}
                canEdit={isOwnerAdmin}
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

          {/* 6 · SEND TO REVIEW — upload a version per cut, then the cut in
              review with the owner's timestamped notes under it. #submit-cut
              is the anchor the tracker's "Done? Send to review" jumps to. */}
          <div id="submit-cut" className="scroll-mt-20 space-y-6">
            {currentCuts.length > 1 && (
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
            {/* What the job owes, in one line — said out loud because the
                panel below may be showing only the slots that need someone
                (Sep 16). The count itself is untouched. */}
            {collapseSlots && (
              <p className="text-xs text-muted">
                {slots.length} videos owed on this job · {approvedSlots} of {slots.length} approved ·{" "}
                {uploadedSlots} sent to review. Showing the {shownCutRows.length} slot
                {shownCutRows.length === 1 ? "" : "s"} that need you — the rest are empty.
              </p>
            )}
            {/* The way in: upload a version per cut (Jordan, Sep 1), each with
                the editor's own message to whoever reviews it (Sep 2).
                Owner/admin can upload on an editor's behalf (vendor cuts). */}
            <CutUploader
              projectId={project.id}
              canUpload={!viewer?.impersonating && (isOwnerAdmin || viewer?.role === "EDITOR")}
              // Only Jordan and Kyle may send an over-spec file anyway, and
              // only for real: the server checks the role again and puts their
              // name on it (startCutUpload).
              canOverrideExport={!viewer?.impersonating && isOwnerAdmin}
              cuts={shownCutRows}
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
                Dropbox Final folder. Folded away (uploading here is the path)
                but kept for everyone who had it before, owner included. */}
            <details className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-muted">
              <summary className="cursor-pointer">Already dropped a file in the Final footage folder instead?</summary>
              {/* The other door into review, and it is a busy one — 12 of the
                  26 cut rows on file came in this way. There is no browser in
                  it, so nothing can be checked BEFORE the work is exported:
                  the spec is stated here instead, and lib/reviewCuts measures
                  each file it enters (recordArrivedDimensions) so this door
                  counts in the answer to "are they exporting 1080p now?"
                  rather than quietly not applying (Sep 16). Measured, never
                  blocked — a finished cut that silently fails to reach the
                  Review Room is worse than a 4K one that does. */}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-2">{EXPORT_SPEC.headline}: {EXPORT_SPEC.finalCut}</p>
              <div className="mt-2"><SubmitCutCard projectId={project.id} /></div>
            </details>
            {/* ONE PANEL PER CUT that needs looking at — the one they opened,
                and every cut sitting at "changes requested". Each carries its
                own anchor (id="cut-<id>"), which is where every revision link
                on this page, and every cut-note bell, now lands (Sep 16). */}
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
              />
            ))}
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
          {/* The compact brief for EVERY viewer — this is the editor's screen,
              and Jordan reads it as OWNER to see what they see (Sep 2, round
              3: "The working profile still hasn't changed" — the brief had
              been gated to the EDITOR role). The full card lives on
              /clients/<id>. */}
          <ClientProfileCard
            clientId={project.client.id}
            profile={profile}
            updatedAt={project.client.profileUpdatedAt ? formatDistanceToNow(project.client.profileUpdatedAt, { addSuffix: true }) : null}
            variant="brief"
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
