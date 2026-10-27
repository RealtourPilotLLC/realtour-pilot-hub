import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import {
  MapPin,
  Package,
  FileText,
  Star,
  Flag,
  StickyNote,
  RefreshCw,
  Calendar,
  CalendarClock, GitMerge,
  ChevronDown,
  ClipboardList,
  Clock,
  Mail,
  Phone,
  Building2,
  Sparkles,
  CreditCard,
  ExternalLink,
  ListTodo,
  ListChecks,
  History,
  User,
  Users,
} from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { Suspense } from "react";
import { ListingMedia, ListingMediaSkeleton } from "@/components/project/ListingMedia";
import { StatusEvidenceCard } from "@/components/project/StatusEvidenceCard";
import { ProjectBriefCard } from "@/components/project/ProjectBriefCard";
import { DetailsHashOpener } from "@/components/project/DetailsHashOpener";
import { projectBrief } from "@/lib/projectBrief";
import { MergeWork } from "@/components/project/MergeWork";
import { mergeFrom, mergedInto } from "@/lib/projectMerge";
import { TaskCard } from "@/components/queue/TaskCard";
import { ReelScriptCard, currentScriptOf } from "@/components/project/ReelScriptCard";
import { getProject, getTeam } from "@/lib/queries";
import { AssignmentPanel } from "@/components/project/AssignmentPanel";
import { AppointmentManager } from "@/components/project/AppointmentManager";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, ink } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { CopyButton } from "@/components/ui/CopyButton";
import { taskToView } from "@/lib/taskView";
import { scrubTaskMoney } from "@/components/tasks/scrubTaskMoney";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { VendorBadge } from "@/components/editing/VendorBadge";
import { StageSelector } from "@/components/project/StageSelector";
import { RefreshFromAryeo } from "@/components/projects/RefreshFromAryeo";
import { Checklist } from "@/components/project/Checklist";
import { ActivityComposer } from "@/components/project/ActivityComposer";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { ProjectMap } from "@/components/map/ProjectMap";
import { DroneBadge, hasDroneOps } from "@/components/project/DroneBadge";
import { DroneAdvisory } from "@/components/project/DroneAdvisory";
import { DeliverableStatusSelect } from "@/components/project/DeliverableStatusSelect";
import { PRIORITY_META, DELIVERABLE_META, refinedDeliverableLabel, stageMeta } from "@/lib/pipeline";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { photoTargetFor } from "@/lib/culling";
import { PhotoTargetControl } from "@/components/project/PhotoTargetControl";
import { formatMoney } from "@/lib/utils";
import { canSeeMoney, canSeePrices, isOffice } from "@/lib/auth/access";
import { isOwnerPrivateTask } from "@/lib/ownerPrivateTasks";
import { redactMoney } from "@/lib/hubTools";
import { customerNote, creativeCustomerNote } from "@/lib/clientNotes";
import { formatDistanceToNow } from "date-fns";
import { etDateTime, etDateYear } from "@/lib/datetime";
import { listAssignees } from "@/lib/assignees";
import { prisma } from "@/lib/prisma";
import { JobNoteEditor } from "@/components/editing/JobNoteEditor";
import { PhotoBatchPanel } from "@/components/project/PhotoBatchPanel";
import { ReworkCostPanel } from "@/components/project/ReworkCostPanel";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { mayOpenMedia } from "@/lib/mediaAccess";
import { JobDeliverablesSection } from "@/components/jobs/JobDeliverables";
import { ShootFlags } from "@/components/jobs/ShootFlags";
import { VideoSetupNotice } from "@/components/jobs/VideoSetupNotice";
import { SecondShootCard } from "@/components/jobs/SecondShootCard";

export const dynamic = "force-dynamic";

const ACTIVITY_ICON: Record<string, { icon: typeof Star; color: string }> = {
  SPECIAL_REQUEST: { icon: Star, color: "#d97706" },
  FLAG: { icon: Flag, color: "#dc2626" },
  STATUS_CHANGE: { icon: RefreshCw, color: "#0ea5e9" },
  ASSIGNMENT: { icon: RefreshCw, color: "#8b5cf6" },
  NOTE: { icon: StickyNote, color: "#64748b" },
  SYSTEM: { icon: Sparkles, color: "#64748b" },
  REMINDER: { icon: Clock, color: "#d97706" },
  FILE: { icon: Package, color: "#64748b" },
};

// What an admin reads in place of a note that was ENTIRELY about money (the
// whole sentence went, not just the figure — 1 activity row in 5,795 today).
// The row keeps its slot, author and timestamp on purpose: a line that silently
// vanished would read as "nothing happened here", which is the one thing an
// audit trail must never say.
const HELD_BACK = "Money detail — owner only.";

/** The activity feed's length: the newest this many (audit A24). */
const ACTIVITY_SHOWN = 150;

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `notice` carries the waive/unwaive action's own words back to the page —
  // a plain form post has nowhere else to put them, and a press that quietly
  // did nothing is the worst outcome of the three (Sep 16 review).
  searchParams?: Promise<{ notice?: string }>;
}) {
  const { id } = await params;
  const notice = (await searchParams)?.notice?.slice(0, 200) ?? null;

  // Owner/admin only. /projects isn't a top-level nav key, so the middleware
  // doesn't gate it — guard here. Photographers get the guided field view of
  // their shoot; editors (and any other non-admin role) are bounced home.
  // Passing this gate is NOT a money grant: an admin gets the whole job file,
  // and the owner alone gets the figures (see showMoney below).
  const viewer = await getCurrentUser();
  // Fail CLOSED on a null viewer once enforcement is on (the same line /shoot/<id>
  // now carries). pathKey() returns null for /projects/<id>, so the middleware
  // only proves the JWT verifies — and a disabled account keeps a valid one for
  // the full 7-day token life. Null then falls straight THROUGH the role test
  // below as "owner-ish", which is this page's whole payload: order pricing,
  // invoice + payment links, balance owed, and the client's phone and email.
  if (!viewer && authEnforced()) redirect(`/login?next=/projects/${id}`);
  // The creative manager reads the job file too (Oct 21 2026): money-blind
  // like the office (showMoney below), and the office's controls stay the
  // office's (canWaive, canMerge, the deadlines on task cards).
  if (viewer && viewer.role !== "OWNER" && viewer.role !== "ADMIN" && viewer.role !== "CREATIVE_MANAGER") {
    redirect(viewer.role === "PHOTOGRAPHER" ? `/shoot/${id}` : "/");
  }

  // The job page is the screen Kyle and James open most, and it was the whole
  // order file: total, balance owed, invoice + payment links, and any pricing a
  // client happened to text us. Jordan, Sep 2 2026: an admin gets FULL ops
  // access and NO money. canSeeMoney() is that rule stated once for the hub
  // (src/lib/auth/access.ts) — OWNER only. It reads the EFFECTIVE role, so an
  // owner previewing as Kyle ("view as") sees the money-blind page Kyle sees.
  // A null viewer only survives the redirect above with enforcement off (local
  // dev, operated by Jordan alone), which is the same call isOwnerView() makes.
  const showMoney = viewer ? canSeeMoney(viewer.role) : !authEnforced();
  // WHAT THE CLIENT IS CHARGED (Jordan, Oct 27 2026: "Admins can see prices of
  // services and billing. I just dont want admin seeing what I pay other team
  // members"): the order total and the Billing card (balance, invoice,
  // payment link) follow canSeePrices, so Kyle sees them; James (creative
  // manager) does not. Everything else on this page that is money (the free
  // text scrub, owner-private tasks, rework cost) stays on showMoney above.
  const showPrices = viewer ? canSeePrices(viewer.role) : !authEnforced();
  // Who gets the "Not required" control. The role test is already done above
  // (editors and photographers never reach this page), so what is left is the
  // preview: "view as" is read-only, requireAdmin refuses it, and a button
  // that cannot work should not be on the screen (Sep 16 review).
  // The office's controls on this page (Oct 21 2026): the creative manager reads them.
  const officeControls = !viewer || isOffice(viewer.role);
  const canWaive = !viewer?.impersonating && officeControls;
  // One money rule for every free-text block on this page. redactMoney (the
  // hub's rule, src/lib/hubTools.ts) keeps the sentence and removes the FIGURE,
  // so "chase the invoice on 12 Oak" still reads for Kyle while "$450" does not,
  // and a sentence whose SUBJECT is internal money (AR, margin, payroll) goes
  // whole. Owner text is untouched. Probe over all 5,795 activity rows: 60
  // changed, 48 show the [amount withheld] marker, 0 residual $ figures.
  const scrub = (t: string) => (showMoney ? t : redactMoney(t));
  // The same rule line by line, for the blocks drawn whitespace-pre (briefs,
  // the appointment's notes): redactMoney folds whitespace, so a multi-line
  // brief scrubbed whole would read as one paragraph.
  const scrubLines = (t: string | null | undefined) => (t == null || showMoney ? t ?? null : t.split("\n").map((l) => (l.trim() ? redactMoney(l) : l)).join("\n"));
  // Oct 20 2026 (audit A1): the rule above covered the activity feed, the
  // requests and the customer note, while the open tasks, team messages, the
  // briefs, the per-deliverable notes and the summary's latest request went
  // to Kyle raw. Every free-text block below now passes one of these.

  // The office's waiver, wired straight to the deliverables list below (Sep 16,
  // Kyle call). Plain form posts on purpose: no client bundle for two buttons
  // that need a page refresh anyway, and the guard lives in the action
  // (requireAdmin) rather than in anything the browser can skip.
  //
  // Whatever the action answers comes BACK to the page as ?notice= (Sep 16
  // review): requireAdmin refuses an owner who is previewing as someone else,
  // and the old wrapper swallowed that into a button that looked like it
  // worked. Success says so too — the row moves, but the sentence names what
  // changed everywhere else.
  async function waive(formData: FormData) {
    "use server";
    const { waiveDeliverable } = await import("@/app/projects/deliverableActions");
    const r = await waiveDeliverable(String(formData.get("id") ?? ""), String(formData.get("note") ?? ""));
    redirect(`/projects/${id}?notice=${encodeURIComponent(r.message)}#deliverables`);
  }
  async function unwaive(formData: FormData) {
    "use server";
    const { unwaiveDeliverable } = await import("@/app/projects/deliverableActions");
    const r = await unwaiveDeliverable(String(formData.get("id") ?? ""));
    redirect(`/projects/${id}?notice=${encodeURIComponent(r.message)}#deliverables`);
  }

  // The newest ACTIVITY_SHOWN activity rows: a long-lived job carries hundreds,
  // and the feed is the only reader on this page (audit A24).
  const [project, team, assigneeList] = await Promise.all([getProject(id, { activities: ACTIVITY_SHOWN }), getTeam(), listAssignees()]);
  if (!project) notFound();

  const assignees = assigneeList.map((a) => ({ key: a.key, name: a.name }));
  // A teammate's pay question filed on this job is the owner's alone (audit Oct 25 2026, F7).
  const openTasks = showMoney ? project.smartTasks : project.smartTasks.filter((t) => !isOwnerPrivateTask(t));
  // THE customer note — one list (src/lib/clientNotes.ts). Owner reads it raw;
  // everyone else gets the money-scrubbed cut, LINE BY LINE so a bulleted note
  // keeps its shape (the flat redactor would fold this whitespace-pre-line
  // block into one paragraph). Display only here — the note is edited on the
  // client page, so nobody can save a scrubbed copy back over the real one.
  const clientNote = showMoney ? customerNote(project.client) : creativeCustomerNote(project.client);

  // WHERE THIS JOB'S WORK LIVES (Jordan, Sep 18: "I should be able to merge
  // projects together"). Read for the office only — it is the one control on
  // this page that moves rows between jobs.
  const canMerge = viewer ? viewer.role === "OWNER" || viewer.role === "ADMIN" : !authEnforced();
  const [mergeAway, mergeIn] = canMerge
    ? await Promise.all([mergeFrom(project.id).catch(() => null), mergedInto(project.id).catch(() => [])])
    : [null, []];
  const mergeAwayView = mergeAway
    ? {
        intoId: mergeAway.intoId,
        intoStreet: (
          (await prisma.project.findUnique({ where: { id: mergeAway.intoId }, select: { title: true } }))?.title ?? "another job"
        ).split(",")[0].trim(),
        by: mergeAway.by,
        atISO: mergeAway.at.toISOString(),
        note: mergeAway.note,
      }
    : null;
  const mergeInView = await Promise.all(
    mergeIn.map(async (m) => ({
      fromId: m.fromId,
      fromStreet: (
        (await prisma.project.findUnique({ where: { id: m.fromId }, select: { title: true } }))?.title ?? "another job"
      ).split(",")[0].trim(),
      atISO: m.at.toISOString(),
    })),
  );

  // The summary reads the same engines the cards below do; a failure here must
  // never cost the page, so it degrades to no card at all.
  const briefRaw = await projectBrief(project.id).catch((e: unknown) => {
    console.warn("projectBrief failed", (e as Error).message);
    return null;
  });
  // The summary quotes the client's latest ask and names the blocker in words.
  const brief = briefRaw && !showMoney
    ? {
        ...briefRaw,
        latestRequest: briefRaw.latestRequest ? { ...briefRaw.latestRequest, text: scrub(briefRaw.latestRequest.text) || HELD_BACK } : null,
        blocker: briefRaw.blocker ? scrub(briefRaw.blocker) || HELD_BACK : null,
      }
    : briefRaw;

  const priority = PRIORITY_META[project.priority];

  const addressParts = [
    project.addressLine,
    project.city,
    project.state,
    project.zip,
  ].filter(Boolean);

  // For a viewer without prices the card is worth showing ONLY for the payment
  // status: the figures and links inside it are gated on showPrices below, so
  // a job with a balance but no status would otherwise render an empty card.
  const hasBilling = showPrices
    ? !!project.paymentStatus ||
      project.balanceAmount != null ||
      !!project.invoiceUrl ||
      !!project.paymentUrl
    : !!project.paymentStatus;

  // Deep links to this project's Dropbox folders — where they ACTUALLY are
  // (a same-street re-shoot or a month-moved shoot lives off the convention
  // path; the Sep 9 Rowan job's nine links opened the Sep 3 folder — audit, Sep 8).
  const folders = actualFolderPaths({
    title: project.title,
    addressLine: project.addressLine,
    shootDate: project.shootDate,
    createdAt: project.createdAt,
    client: { name: project.client.name },
    dropboxFolder: project.dropboxFolder,
  });
  const dropboxLinks = [
    { label: "Raw Photos", url: dropboxWebUrl(folders.rawPhotos) },
    { label: "Raw Video", url: `/api/dropbox/open/${project.id}?folder=rawVideo` },
    { label: "Final Photos", url: dropboxWebUrl(folders.finalPhotos) },
    { label: "Final Video", url: dropboxWebUrl(folders.finalVideo) },
  ];

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      {/* In-app this walks the history (BackLink); a cold open — a Slack or
          text deep link — falls back to the dashboard, where every list that
          links here lives. It used to fall back to /pipeline, the tracker
          Jordan retired from the nav (audit, Sep 8 2026). Labelled
          "Dashboard", as the menu says (audit A24, Oct 20 2026). */}
      <BackLink href="/" label="Dashboard" />

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
            <Badge color={priority.color} soft={priority.soft}>
              {priority.label}
            </Badge>
            {hasDroneOps(project.deliverables) && <DroneBadge />}
          </div>
          {addressParts.length > 0 && (
            <div className="mt-1 flex items-center gap-1.5 text-sm text-muted">
              <MapPin className="size-3.5 shrink-0" /> {addressParts.join(", ")}
              <CopyButton value={addressParts.join(", ")} title="Copy address" className="shrink-0" />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          {(project.aryeoOrderId || project.aryeoListingId) && <RefreshFromAryeo projectId={project.id} />}
          {/* The listing as the client received it, with downloads (Oct 23 2026, /listings). */}
          {(!viewer || mayOpenMedia(viewer)) && (
            <Link href={`/listings/${project.id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium hover:bg-surface-2">
              Listing page
            </Link>
          )}
          {/* The LISTING editor (…/admin/listings/<id>/edit) — the same link the
              QC cards use and the one that opens for Kyle; the order page does
              not (Jordan, Sep 15). The order is the fallback for a job with no
              listing on record. */}
          {(project.aryeoListingId || project.aryeoOrderId) && (
            <a
              href={project.aryeoListingId ? aryeoListingUrl(project.aryeoListingId) : aryeoOrderUrl(project.aryeoOrderId as string)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium hover:bg-surface-2"
            >
              Open in Aryeo <ExternalLink className="size-3.5" />
            </a>
          )}
          <StageSelector projectId={project.id} status={project.status} readOnly={!!viewer?.impersonating} />
        </div>
      </div>

      {/* PHOTOS AND VIDEO, FIRST (Oct 19 2026, the Shoots build). Jordan: "I
          need to be able to track each job and where they are at, and special
          requests for either photo or video, and individual photos and
          videos." Where each stands, the individual photos and videos, and
          that medium's client requests with who owns each one; the shoot's
          flags and notes come from the job's "Before you send" read. Every
          section below is unchanged. A failed read shows no cards, never the
          page's loss. */}
      <div className="mt-6 space-y-4">
        {/* Oct 22 2026: more videos ordered than set up (lib/videoSetup). */}
        <Suspense fallback={null}>
          <VideoSetupNotice projectId={project.id} />
        </Suspense>
        {/* Oct 22 2026: a video held for a second shoot, and the office's
            Release to the editor (lib/secondShoot). */}
        <Suspense fallback={null}>
          <SecondShootCard projectId={project.id} />
        </Suspense>
        <Suspense fallback={null}>
          <ShootFlags projectId={project.id} />
        </Suspense>
        <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-surface-2 motion-reduce:animate-none" aria-hidden />}>
          <JobDeliverablesSection projectId={project.id} />
        </Suspense>
      </div>

      {/* Client — who the project is for, surfaced at the top (was buried in the
          side rail, and fell to the very bottom on mobile). */}
      <Section icon={User} title="Client" className="mt-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Avatar name={project.client.name} src={project.client.avatarUrl} size={44} color="#4f46e5" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={`/clients/${project.client.id}`} className="text-base font-semibold hover:underline">
                  {project.client.name}
                </Link>
                <SegmentBadge segment={project.client.segment} size="xs" />
                <SocialBadge socialClient={project.client.socialClient} socialPlan={project.client.socialPlan} size="xs" />
              </div>
              {project.client.company && (
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                  <Building2 className="size-3" /> {project.client.company}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:justify-end">
            {project.client.email && (
              <a href={`mailto:${project.client.email}`} className="flex min-h-9 min-w-0 items-center gap-1.5 text-muted hover:text-foreground">
                <Mail className="size-3.5 shrink-0" /> <span className="truncate">{project.client.email}</span>
              </a>
            )}
            {project.client.phone && (
              <a href={`tel:${project.client.phone}`} className="flex min-h-9 items-center gap-1.5 text-muted hover:text-foreground">
                <Phone className="size-3.5 shrink-0" /> {project.client.phone}
              </a>
            )}
          </div>
        </div>
        {/* ONE customer note (generalNotes, mirrored to Aryeo — the retired
            editingPreferences column is read as a fallback inside customerNote).
            This used to print the two columns side by side as if they were
            separate things; the left one has had no writer since the notes cards
            merged and was empty on every client. */}
        {clientNote && (
          <div className="mt-3">
            <div className="rounded-lg bg-brand-soft px-3 py-2">
              <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
                <Sparkles className="size-3" /> Customer notes
              </div>
              <p className="whitespace-pre-line text-xs text-foreground/80">{clientNote}</p>
            </div>
          </div>
        )}
      </Section>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main column — the work, in workflow order:
            status → tasks → order → logistics → output → money → collaboration */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* THE JOB SAYS ITS STATUS ONCE (Jordan, Oct 21 2026; audit A24).
              The stage pill in the header and the Photos and Video cards at
              the top say where the job is. The three longer reads of the same
              thing (the summary, the status cross-check and the ordered
              deliverables with their own status select) are folded here,
              closed by default: nothing is removed, it is one tap away. It
              opens by itself after a Not required press (its notice) and on
              a link to #deliverables (DetailsHashOpener). */}
          <details id="job-details" open={!!notice} className="group/details panel-shadow rounded-2xl border border-border bg-surface">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-2xl px-5 py-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                <ClipboardList aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold leading-snug">Details</span>
                <span className="block text-sm text-muted">Where this job is, the status check and the ordered deliverables</span>
              </span>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted transition-transform group-open/details:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="space-y-6 border-t border-border p-4 sm:p-5">
              {/* ONE SUMMARY (R08). The cards below are in workflow order,
                  which is right for doing the job and wrong for answering a
                  question about it. Same facts, same engines, said once. */}
              {brief && <ProjectBriefCard brief={brief} />}

              {/* Smart status cross-check */}
              <StatusEvidenceCard
                status={project.status}
                evidence={project.statusEvidence}
                checkedAt={project.statusCheckedAt}
                projectId={project.id}
                revisionNote={project.revisionNote ? scrub(project.revisionNote) || HELD_BACK : project.revisionNote}
                revisionRequestedAt={project.revisionRequestedAt}
                dropboxLinks={dropboxLinks}
                dropboxRootUrl={dropboxWebUrl(folders.listing)}
                canResolveRevision={officeControls}
              />

            {/* Ordered deliverables — retired rows (item removed from the Aryeo
                order) stay visible, dimmed, with why: retire-not-delete only
                pays off if a human can see what happened. */}
            {/* "Not required on this job" (Sep 16, Kyle call) — the office's
                waiver. Retired-by-Aryeo and waived-by-us are different facts and
                read differently here: a package still implies the floor plan
                195 Woodhill's client was never charged for, so only a human can
                say it isn't owed. The row stays, with who said so and why. */}
            <div id="deliverables" className="scroll-mt-20">
            <Section icon={Package} title="Ordered deliverables" count={project.deliverables.filter((d) => !d.removedFromOrderAt && !d.waivedAt).length || null} flush>
              <div className="divide-y">
                {/* What the last press actually did (or why it didn't). */}
                {notice && (
                  <p className="bg-surface-2/60 px-5 py-2.5 text-xs text-muted">{notice}</p>
                )}
                {project.deliverables.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted">Nothing ordered yet.</p>
                )}
                {/* Oct 27 2026: the first row of each kind is an anchor (#deliverable-floorplan, …), so the
                    dashboard's "Open the job's floor plan section" lands on it. */}
                {project.deliverables.map((d, n) => (
                  <div key={d.id} id={project.deliverables.findIndex((x) => x.type === d.type) === n ? `deliverable-${d.type.toLowerCase()}` : undefined} data-deliverable-type={d.type} className={`flex scroll-mt-20 flex-wrap items-center justify-between gap-3 px-5 py-3 ${d.removedFromOrderAt || d.waivedAt ? "opacity-60" : ""}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                        <Package className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <div className={`flex flex-wrap items-center gap-2 text-sm font-medium ${d.removedFromOrderAt || d.waivedAt ? "line-through decoration-muted-2" : ""}`}>
                          {refinedDeliverableLabel(d.type, d.label)}
                          {d.quantity > 1 && (
                            <span className="text-muted"> ×{d.quantity}</span>
                          )}
                          <VendorBadge type={d.type} label={d.label} />
                          {d.manual && (
                            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-muted" title="Added by hand in the hub — not from the Aryeo order">manual</span>
                          )}
                          {d.waivedAt && (
                            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-muted" title="The office said this isn't required on this job — nothing counts it as owed">not required</span>
                          )}
                        </div>
                        {d.removedFromOrderAt && (
                          <div className="text-xs text-warning">
                            Removed from the order {new Date(d.removedFromOrderAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
                            {d.removedFromOrderNote ? ` — ${d.removedFromOrderNote}` : ""}
                          </div>
                        )}
                        {/* The waiver, in the words of whoever made the call. */}
                        {d.waivedAt && (
                          <div className="text-xs text-muted">
                            Not required — {d.waivedBy ?? "the office"}
                            {d.waivedNote ? `, ${d.waivedNote}` : ""}
                            {" · "}
                            {new Date(d.waivedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
                          </div>
                        )}
                        {/* What the photographer said on the upload page. Kyle's
                            one-press answer is the form on the right. */}
                        {!d.waivedAt && !d.removedFromOrderAt && d.notCompletedReason && (
                          <div className="text-xs text-warning">
                            Photographer couldn&rsquo;t complete it: {scrub(d.notCompletedReason) || HELD_BACK}
                          </div>
                        )}
                        {d.notes && <div className="text-xs text-muted">{scrub(d.notes) || HELD_BACK}</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!d.removedFromOrderAt && !d.waivedAt && <DeliverableStatusSelect id={d.id} status={d.status} readOnly={!officeControls} />}
                      {!d.removedFromOrderAt && canWaive && (
                        d.waivedAt ? (
                          <form action={unwaive}>
                            <input type="hidden" name="id" value={d.id} />
                            <button type="submit" className="inline-flex min-h-11 items-center rounded-lg border px-2.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                              It is owed after all
                            </button>
                          </form>
                        ) : (
                          <details className="group">
                            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-lg border px-2.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                              Not required
                            </summary>
                            <form action={waive} className="mt-2 flex flex-wrap items-center gap-2">
                              <input type="hidden" name="id" value={d.id} />
                              <input
                                name="note"
                                required
                                maxLength={300}
                                placeholder={d.notCompletedReason ? d.notCompletedReason.slice(0, 60) : "Why isn't it required? (kept on the job)"}
                                className="min-h-11 w-64 max-w-full rounded-lg border bg-surface-2/50 px-2.5 text-base sm:text-xs"
                              />
                              <button type="submit" className="inline-flex min-h-11 items-center rounded-lg bg-brand-action px-2.5 text-xs font-semibold text-white">
                                Mark not required
                              </button>
                            </form>
                          </details>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
            </div>
            </div>
          </details>
          <DetailsHashOpener detailsId="job-details" anchors={["deliverables"]} />

          {/* Open tasks for this job (a pay question filed on it is the owner's alone: audit Oct 25 2026, F7) */}
          {openTasks.length > 0 && (
            <Section icon={ListTodo} title="Open tasks" count={openTasks.length} flush>
              <div className="grid gap-3 p-5 sm:grid-cols-2">
                {openTasks.map((t) => (
                  <TaskCard key={t.id} task={showMoney ? taskToView(t) : scrubTaskMoney(taskToView(t))} assignees={assignees} editorView={!officeControls} deadlineOffice={viewer ? !viewer.impersonating && (viewer.role === "OWNER" || viewer.role === "ADMIN") : !authEnforced()} />
                ))}
              </div>
            </Section>
          )}

          {/* The locked reel script from Script Studio — visible to the whole
              crew here (the photographer also gets it on their shoot screen). */}
          <ReelScriptCard
            hook={project.reelHook}
            script={project.reelScript}
            song={project.reelSong}
            shotList={project.reelShotList}
            updatedAt={project.reelRecipeUpdatedAt ? project.reelRecipeUpdatedAt.toISOString() : null}
            studioUrl={project.scriptingUrl ?? project.reelScriptUrl}
            current={currentScriptOf(project)}
            recordNote={project.scriptConfirmNote}
            showClientVersion
          />

          {/* Order gone from Aryeo — the one place a human decides. Automations
              (status checks, texts, chases, task mints) are paused while set. */}
          {project.aryeoMissingAt && (
            <div className="rounded-2xl border border-danger/40 bg-danger/[0.06] px-5 py-4">
              <p className="text-sm font-semibold text-danger">This order no longer exists in Aryeo</p>
              <p className="mt-1 text-[13px] leading-relaxed text-foreground/80">
                Aryeo has returned “not found” for order {project.aryeoOrderId} since {new Date(project.aryeoMissingAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}.
                Every automation on this job is paused. Decide: it was deleted or archived there — cancel the job here
                (Move to Cancelled), keep it as a manual job (On hold), or update its Aryeo order id if it was re-created.
                If the order comes back, this clears itself on the next hourly check.
              </p>
            </div>
          )}

          {/* Appointments (from Aryeo) */}
          {project.appointments.length > 0 && (
            <Section
              icon={Calendar}
              title={`Appointment${project.appointments.length > 1 ? "s" : ""}`}
              count={project.appointments.length > 1 ? project.appointments.length : null}
              flush
            >
              <div className="divide-y">
                {project.appointments.map((a) => (
                  <AppointmentManager
                    key={a.id}
                    appt={{
                      id: a.id,
                      startAt: a.startAt,
                      endAt: a.endAt,
                      durationMin: a.durationMin,
                      status: a.status,
                      title: a.title,
                      description: scrubLines(a.description),
                      preferenceType: a.preferenceType,
                      requiresConfirmation: a.requiresConfirmation,
                      canCancel: a.canCancel,
                      canReschedule: a.canReschedule,
                      rescheduledAt: a.rescheduledAt,
                      postponedAt: a.postponedAt,
                      previousStartAt: a.previousStartAt,
                      assignedTo: a.assignedTo
                        ? { name: a.assignedTo.name, avatarColor: a.assignedTo.avatarColor }
                        : null,
                    }}
                  />
                ))}
              </div>
            </Section>
          )}

          {/* Location map — pin, weather for the shoot time, drive times */}
          {project.lat != null && project.lng != null && (
            <Section icon={MapPin} title="Location" bodyClassName="p-4">
              <ProjectMap
                pins={[{
                  id: project.id,
                  projectId: project.id,
                  title: project.title,
                  lat: project.lat,
                  lng: project.lng,
                  color: stageMeta(project.status).color,
                  stage: stageMeta(project.status).short,
                  client: project.client.name,
                  shootISO: (project.appointments[0]?.startAt ?? project.shootDate)?.toISOString() ?? null,
                  endISO: project.appointments[0]?.endAt?.toISOString() ?? null,
                  photographer: project.photographer?.name ?? null,
                }]}
              />
            </Section>
          )}

          {/* Drone operations — FAA airspace check + advisory to the creative */}
          {hasDroneOps(project.deliverables) && <DroneAdvisory projectId={project.id} />}

          {/* Delivered media pulled live from Aryeo */}
          {project.aryeoListingId && (
            <Suspense fallback={<ListingMediaSkeleton />}>
              <ListingMedia listingId={project.aryeoListingId} title={project.title} projectId={project.id} />
            </Suspense>
          )}

          {/* Uploads & editor brief — also surfaces pre-submit when the
              photographer marked something "couldn't complete" (the Admin
              must see the reason without waiting for the full submit). */}
          {(project.uploads.length > 0 || project.editorPdfPath || project.editorBrief || project.deliverables.some((d) => d.notCompletedReason)) && (
            <Section
              icon={FileText}
              title="Uploads & editor brief"
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {project.editorPdfPath && (
                    <a
                      href={`/api/projects/${project.id}/editor-brief`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand hover:opacity-90"
                    >
                      <FileText className="size-3.5" /> Editor brief PDF
                    </a>
                  )}
                </div>
              }
              bodyClassName="space-y-3"
            >
              {(project.shotOrderNotes || project.removalNotes || project.videoInstructions || project.videosFilmed != null || project.deliverables.some((d) => d.notCompletedReason)) && (
                <div className="space-y-2 border-b border-border pb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Shoot debrief</div>
                  {project.deliverables.filter((d) => d.notCompletedReason).map((d) => (
                    <p key={d.id} className="text-sm font-medium text-warning">
                      Couldn&rsquo;t complete {d.label ?? d.type}: <span className="font-normal text-foreground/85">{scrub(d.notCompletedReason ?? "") || HELD_BACK}</span>
                    </p>
                  ))}
                  {project.videosFilmed != null && (
                    <p className="text-sm text-foreground/85"><span className="font-medium">Videos filmed:</span> {project.videosFilmed}</p>
                  )}
                  {project.shotOrderNotes && (
                    <p className="text-sm text-foreground/85"><span className="font-medium">Shot order:</span> {scrub(project.shotOrderNotes) || HELD_BACK}</p>
                  )}
                  {project.removalNotes && (
                    <p className="text-sm text-foreground/85"><span className="font-medium">Remove in editing:</span> {scrub(project.removalNotes) || HELD_BACK}</p>
                  )}
                  {project.videoInstructions && (
                    <div>
                      <p className="text-sm font-medium">Video brief:</p>
                      <p className="whitespace-pre-wrap text-sm text-foreground/85">{scrubLines(project.videoInstructions) || HELD_BACK}</p>
                    </div>
                  )}
                </div>
              )}
              {project.editorBrief && (
                <div className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-sm text-foreground/85">
                  {scrubLines(project.editorBrief) || HELD_BACK}
                </div>
              )}
              {project.uploads.length === 0 ? (
                <p className="text-sm text-muted">No files uploaded yet.</p>
              ) : (
                <ul className="space-y-1">
                  {project.uploads.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-xs"
                    >
                      <Package className="size-3.5 shrink-0 text-muted" />
                      <a
                        href={`/api/file?path=${encodeURIComponent(u.storedPath)}&download=1`}
                        className="min-w-0 flex-1 truncate py-2.5 hover:underline"
                      >
                        {u.originalName}
                      </a>
                      {u.deliverable && (
                        <span className="shrink-0 text-muted-2">
                          {DELIVERABLE_META[u.deliverable.type].label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {/* ADDITIONAL NOTES — the editor's note, readable and editable from
              the job file (Kyle call, Sep 16). Project.notes only ever rendered
              on /edit/<id>, so Kyle had to open the Editing Room to read or
              write the note Jordan pointed him at — and, believing it reached
              the crew, he typed the same client ask twice on 358 N Church St
              (once here as a Note, once there) and it reached the photographer
              neither time. Same component as /edit, same server action, same
              audience caption: this field is the EDITOR's. Anything the
              photographer must also see is a Request in the composer below. */}
          <Section icon={StickyNote} title="Additional notes for the editor">
            <JobNoteEditor
              projectId={project.id}
              field="customer"
              // Raw for whoever may edit it — saving a scrubbed rendering back
              // would destroy the held-back text (the rule /edit already
              // states); a read-only "view as" preview gets the scrub.
              value={viewer?.impersonating ? (project.notes ? scrub(project.notes) : null) : project.notes}
              canEdit={!viewer?.impersonating}
              label=""
              placeholder="Anything else the editor should know about this customer or job…"
              empty="Nothing added."
            />
          </Section>

          {/* Billing (from Aryeo) — payment STATUS for anyone who can open this
              page, the figures and links for the OWNER only. Paid/unpaid is the
              ops fact Kyle runs delivery off ("they've paid, go ahead") and
              carries no amount; the balance, the invoice and the payment link
              ARE the money and they go. The card keeps its title and says so
              rather than disappearing — an admin must not read a silent card as
              "nothing owed" and must know whom to ask. */}
          {hasBilling && (
            <Section
              icon={CreditCard}
              title="Billing"
              action={
                project.paymentStatus ? (
                  project.paymentStatus === "PAID" ? (
                    <Badge color="#16a34a" soft="#dcfce7">Paid</Badge>
                  ) : (
                    <Badge color="#d97706" soft="#fef3c7">
                      {project.paymentStatus.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                  )
                ) : null
              }
            >
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
                {showPrices ? (
                  <>
                    {project.balanceAmount != null && (
                      <div>
                        <div className="text-xs text-muted">Balance due</div>
                        <div className={project.balanceAmount > 0 ? "font-semibold text-warning" : "font-semibold text-success"}>
                          {formatMoney(project.balanceAmount / 100)}
                        </div>
                      </div>
                    )}
                    <div className="ml-auto flex gap-2">
                      {project.invoiceUrl && (
                        <a href={project.invoiceUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium hover:bg-surface-2">
                          <FileText className="size-3.5" /> Invoice
                        </a>
                      )}
                      {project.paymentUrl && project.balanceAmount != null && project.balanceAmount > 0 && (
                        <a href={project.paymentUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-xs font-medium text-brand-fg hover:opacity-90">
                          <ExternalLink className="size-3.5" /> Payment link
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted">
                    The balance, the invoice and the payment link are for Jordan and Kyle. Ask Kyle for the figure.
                  </p>
                )}
              </div>
            </Section>
          )}

          {/* The AutoHDR batch (§10 A53, Sep 26): what was sent and what came
              back, before anyone re-runs it — office, counts only. Then what
              the job's rework actually cost (§10 AU-26) — owner only. */}
          <PhotoBatchPanel projectId={project.id} canAct={!viewer?.impersonating && officeControls} />
          {showMoney && <ReworkCostPanel projectId={project.id} />}

          {/* Team messages — editor/crew coordination on this job */}
          <ProjectMessages
            projectId={project.id}
            readOnly={!!viewer?.impersonating}
            canRequestRevision={!viewer?.impersonating}
            team={team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
            messages={project.messages.map((m) => ({
              id: m.id,
              authorId: m.authorId,
              authorName: m.authorName,
              // Display only: "Send to the editor as a revision" and replies
              // carry the message id, and the server reads the stored words.
              body: scrubLines(m.body) || HELD_BACK,
              createdAt: m.createdAt.toISOString(),
              ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
              replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: scrub(m.replyTo.body) || HELD_BACK } : null,
            }))}
          />

          {/* Checklist */}
          <Section icon={ListChecks} title="Checklist">
            <Checklist items={project.checklist} />
          </Section>

          {/* Activity */}
          <Section icon={History} title="Activity & notes" bodyClassName="space-y-4">
            <ActivityComposer projectId={project.id} readOnly={!!viewer?.impersonating} />
            <ol className="space-y-3">
              {project.activities.map((a) => {
                const meta = ACTIVITY_ICON[a.type] ?? ACTIVITY_ICON.NOTE;
                const Icon = meta.icon;
                // The feed replays the OpenPhone/Gmail thread verbatim, which is
                // where per-product pricing actually reaches this page — "$50
                // per room", "exterior only would be $200". Redacting the figure
                // keeps the conversation Kyle needs.
                const body = scrub(a.body);
                return (
                  <li key={a.id} className="flex gap-3">
                    <span
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${meta.color}1a`, color: ink(meta.color) }}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={body ? "text-sm text-foreground/90" : "text-sm italic text-muted"}>
                        {body || HELD_BACK}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {a.author?.name ?? "System"} ·{" "}
                        {formatDistanceToNow(a.createdAt, { addSuffix: true })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
            {project.activities.length >= ACTIVITY_SHOWN && (
              <p className="text-xs text-muted">The newest {ACTIVITY_SHOWN} are shown.</p>
            )}
          </Section>
        </div>

        {/* Side column — reference: who, when, how much, who's on it */}
        <div className="space-y-6">
          {/* No side "Special requests" card (Oct 20 2026, audit A2): it listed
              the composer's rows, which never closed. A Request typed below
              files a client ask too, and the Photos and Video cards at the top
              list the open ones with their owner and "Checked". */}

          {/* NOT "where this job's work lives" — the summary card at the top of
              this page is already called "Where this job is", and two headings
              that close together read as one thing said twice. */}
          {canMerge && (
            <Section icon={GitMerge} title="Linked jobs">
              <MergeWork
                projectId={project.id}
                street={(project.addressLine || project.title.split(",")[0] || "this job").trim()}
                mergedAway={mergeAwayView}
                mergedIn={mergeInView}
              />
            </Section>
          )}

          <Section icon={CalendarClock} title="Order & schedule">
            <dl className="space-y-2.5 text-sm">
              {project.packageName && (
                <Row label="Package" value={project.packageName} />
              )}
              {/* The package NAME above is operational: everyone on this page has
                  to know a Premium Reel was ordered. The total is the client's
                  price: the owner and admins see it (Oct 27 2026). */}
              {showPrices && project.price != null && (
                <Row label="Order total" value={formatMoney(project.price)} />
              )}
              {project.squareFeet && (
                <Row label="Size" value={`${project.squareFeet.toLocaleString()} sq ft`} />
              )}
              {/* Owner/admin photo-culling budget (the whole page is admin-gated). */}
              <div className="pt-1">
                <PhotoTargetControl
                  projectId={project.id}
                  photoTarget={project.photoTarget}
                  computed={photoTargetFor({ squareFeet: project.squareFeet, photoTarget: null, shootDate: project.shootDate })}
                  squareFeet={project.squareFeet}
                />
              </div>
              <Row
                label="Shoot"
                value={
                  project.shootDate ? (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="size-3.5 text-muted" />
                      {etDateTime(project.shootDate)}
                    </span>
                  ) : (
                    "Not scheduled"
                  )
                }
              />
              <Row
                label="Delivery due"
                value={
                  project.deliveryDue ? etDateYear(project.deliveryDue) : "—"
                }
              />
              {project.deliveredAt && (
                <Row label="Delivered" value={etDateYear(project.deliveredAt)} />
              )}
            </dl>
          </Section>

          {/* Team — editable assignments */}
          {/* #team: the owner dashboard's Reassign and Assign editor land here (Oct 27 2026). */}
          <Section id="team" icon={Users} title="Team" flush>
            <AssignmentPanel
              projectId={project.id}
              team={team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
              current={{
                photographer: project.photographerId,
                editor: project.editorId,
                va: project.vaId,
              }}
              readOnly={!officeControls}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
