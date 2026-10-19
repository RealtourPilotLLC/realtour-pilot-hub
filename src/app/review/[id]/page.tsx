import { videoNavigationFor } from "@/lib/videoNavigation";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ClipboardCheck, ExternalLink, Film, History, Images, MessageSquareQuote, Music, PenLine, ScrollText } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCutWorkspace, nextCutToReview } from "@/lib/reviewRoom";
import { isSyntheticClientRow } from "@/lib/testClients";
import { editorMeta } from "@/lib/editors";
import { CutReviewPanel } from "@/components/review/CutReviewPanel";
import { VerdictReceipts } from "@/components/review/VerdictReceipts";
import { cutTakeBackFlags } from "@/app/review/actions";
import { BackLink } from "@/components/ui/BackLink";
// Every video on the job, its state and next action (folded with the earlier versions).
import { ProjectVideoStatusList, ProjectVideoStatusUnavailable, readProjectVideoStatus } from "@/components/review/ProjectVideoStatus";
import { CreativeReviewPanel } from "@/components/review/CreativeReviewPanel";
import { JudgeAgainst, type JudgeBrand, type JudgeScript } from "@/components/review/JudgeAgainst";
import { BeforeYouSendView, loadBeforeYouSend } from "@/components/jobs/BeforeYouSend";
import { byLine, clientNoteStatusWords, officeReopenLine, officeReopenOf, requesterLine, verdictLine, whenET } from "@/lib/reviewAttribution";

export const dynamic = "force-dynamic";
// A verdict pressed here answers at once and finishes its follow-ons (the
// Dropbox copy waits on Dropbox for up to 15 s, the client-library rebuild) in
// after(), inside this route's function budget (Oct 5) — the same 60 s ceiling
// /edit/<id> uses. Anything a cut-short run leaves undone, the hourly sweeps
// named in review/actions.ts finish.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// One project's cut-review workspace: the submitted video with timestamped
// notes + the Approve / Request-changes verdict (CutReviewPanel), alongside
// everything needed to JUDGE the cut — what was ordered, the editing notes the
// photographer left, and the reel recipe. Photo review stays in the project
// gallery; the header links straight to it.
// Tightened Oct 19 2026 (Jordan: "we can tighten up that as well"), top to
// bottom on the left: the video tabs (several videos only), the version line
// with the editor's note under it, the held-for-check warning (why there is
// no verdict), ONE "Before you approve" box (this round's ask, the shoot
// flags, the client's open requests, the order and edit notes), the player
// and the verdict, a creative review when one is open, then one fold: this
// job's other videos and earlier versions. On the right: Judge against, the
// brief (folded), the client's notes (folded when there are none).
// ---------------------------------------------------------------------------

// The client's ask in their own words: the work order's system preamble
// ("[Video 2 of 4] Video revision requested from the client portal by … (cut:
// …mp4, v1):") is for the ledger, not for the person watching the video.
function plainAsk(text: string): string {
  return text
    .replace(/^\s*(?:\[[^\]]*\]\s*)?(?:Video\s+)?revision requested\b[^\n]*?:\s*(?:\n|$)/i, "")
    .replace(/^\s*•\s*/gm, "• ")
    .trim();
}

export default async function CutReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string; output?: string }>;
}) {
  const { id } = await params;
  const { cut, output } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  // THE SAME QUESTION THE ACTIONS ASK (§8.1, review fix Sep 25): owner/admin,
  // or a login seated as a reviewer — the desk is drawn exactly where approveCut
  // and requestCutChanges will accept the press. It used to be the OWNER/ADMIN
  // role alone, which sent a seated reviewer on a narrower login home from the
  // very link their "Waiting on you" notice carries. View-as is refused.
  const { isReviewDesk } = await import("@/lib/reviewerAssignment");
  const ownerDesk = await isReviewDesk(me, { authEnforced: authEnforced() });
  // A PHOTOGRAPHER reaches this page from a tag on the cut (Jordan, Sep 17:
  // "I want to be able to tag james on the video - he gets a text with my
  // message and a link to see the review room video and comment") and, since
  // Sep 18, from their own index at /review and from the ping the cut itself
  // sends them. Scoped to the shoots they actually worked — ownership, never a
  // tag — and asked of the same helper the link and the bell are built from,
  // so the page, the text and the index can never disagree about who may open
  // it. The office's cross-client queue is still not theirs; see /review.
  const shotThis =
    !ownerDesk && me?.role === "PHOTOGRAPHER" && me.teamMemberId
      ? await (await import("@/lib/shoot")).photographerOwnsShoot(id, me.teamMemberId).catch(() => false)
      : false;
  if (!ownerDesk && !shotThis) redirect(homeFor(me?.role));

  // The photographer's lens is applied in the query, not in the markup: the
  // editor brief, the reel recipe and every lane that is not their own never
  // leave the server (audit finding 4, Sep 17).
  const w = await getCutWorkspace(id, cut ?? null, shotThis && me?.teamMemberId ? { kind: "photographer", memberId: me.teamMemberId } : { kind: "office" });
  // Portal notes across this job's cuts, newest 30 shown oldest-first (desc+take
  // keeps the LATEST notes when a chatty client passes thirty — asc+take
  // silently dropped the new ones). Since Sep 28 (gap 8) each note says who
  // wrote it — staff on the client's behalf marked as such — and when, its
  // replies sit under it, and the notes are grouped by the cut they are on.
  const clientNoteGroups = shotThis
    ? []
    : await import("@/lib/clientDecisions").then((m) => m.clientNotesForReviewRoom(id, 30)).catch(() => []);
  const clientNoteCount = clientNoteGroups.reduce((n, g) => n + g.notes.length, 0);
  // The client's own words to the office are not the photographer's to read.
  if (!w) notFound();


  // Sep 16: a withdrawn cut is history, not the thing to rule on — getCutWorkspace
  // skips past it when nothing asked for it by id. That choice lives THERE, with
  // the note read: swapping the cut here left `w.notes` (built for the workspace's
  // own pick) hanging off the wrong version (reviewer, Sep 16).
  let active = w.active;
  // The job's CURRENT cuts — latest round per video file. One video job = one
  // chip (hidden); a monthly package = a switcher so each video is reviewed
  // individually (Jordan: "review each one individually in a timely manner").
  // A cut = (deliverable × slot) for uploaded rows, the file for legacy
  // folder rows; the newest round of each is the current cut.
  const cutKeyOf = (s: (typeof w.submissions)[number]) => (s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id));
  const { cutSlots, owedSlotKeyOf } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(w.projectId);
  const navigation = await videoNavigationFor(w.projectId);
  const latestPerCut = new Map<string, (typeof w.submissions)[number]>();
  // WITHDRAWN rounds don't speak for a cut (Sep 16) — a slot whose only round
  // was taken back reads as "nothing in yet", exactly like the editor's page.
  for (const s of [...w.submissions].filter((s) => s.status !== "WITHDRAWN").sort((a, b) => a.round - b.round)) latestPerCut.set(owedSlotKeyOf(s, slots.map((slot) => `${slot.deliverableId}:${slot.slot}`)) ?? cutKeyOf(s), s);
  if (output && slots.some((slot) => `${slot.deliverableId}:${slot.slot}` === output) && !latestPerCut.has(output)) active = null;
  const slotLabel = (s: (typeof w.submissions)[number]) =>
    slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot)?.label ?? null;
  const earlierRounds = w.submissions.filter((s) => s.id !== active?.id && (!active || cutKeyOf(s) === cutKeyOf(active)));
  const currentCuts = [...latestPerCut.values()].sort((a, b) => {
    const ia = slots.findIndex((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(a));
    const ib = slots.findIndex((sl) => `${sl.deliverableId}:${sl.slot}` === cutKeyOf(b));
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.round - b.round;
  });
  const editorLabel =
    active?.submittedByName ??
    (active?.submittedByKey ? (editorMeta(active.submittedByKey)?.name ?? active.submittedByKey) : "the editor");
  // Sep 8 (revision lifecycle): when this cut is the editor's answer to a
  // CLIENT's revision, the verdict does more than approve a cut — it closes
  // the ask and re-delivers the job (or sends it back to Revisions). Say so
  // above the player, with the ask itself, so Jordan judges the cut against
  // what the client wanted. Video lane only — Kyle's photo card is not this.
  // Remove / move state for this job's cuts (Sep 16). The action is the one
  // place that decides who may act, so the page asks it rather than re-deriving
  // the rule from the session here — and the row for the cut ON SCREEN is then
  // handed to CutReviewPanel. WITHOUT this prop the "Wrong video?" control
  // renders nowhere in the Review Room and only the editor's own page has it,
  // which would leave Jordan unable to pull a cut from the desk he reviews on.
  const cutFlags = active ? await cutTakeBackFlags(w.projectId).catch(() => []) : [];
  // The earlier asks this version's check claimed fixed, for the verdict's
  // "not actually fixed" ticks (§8.3). The desk only; a failed read shows none.
  const fixesToCheck =
    active && !shotThis && active.status === "PENDING"
      ? await import("@/lib/revisionIssues")
          .then((m) => m.issuesForProject(w.projectId, { scrub: false }))
          .then((all) => all.filter((i) => i.state === "ADDRESSED" && i.addressedInSubmissionId === active.id).map((i) => ({ id: i.id, text: (i.summary ?? i.text).slice(0, 200) })))
          .catch(() => [])
      : [];
  const takeBack = active ? (cutFlags.find((f) => f.submissionId === active.id) ?? null) : null;
  // WHERE A VERDICT TAKES THE REVIEWER (Oct 5): named now, so the move happens
  // on the click instead of after the server answers. Only when there is a
  // verdict to give. Test clients only from a test job, like the Room's index.
  const nextCut =
    active && !shotThis && active.status === "PENDING" && !active.heldForCheck
      ? await nextCutToReview({
          afterSubmissionId: active.id,
          projectId: w.projectId,
          viewer: {
            teamMemberId: me && !me.impersonating ? me.teamMemberId : null,
            office: !me || (!me.impersonating && (me.realRole === "OWNER" || me.realRole === "ADMIN")),
          },
          includeTest: isSyntheticClientRow({ name: w.clientName }),
        }).catch(() => null)
      : null;
  const { videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
  const clientAsk = active
    ? await prisma.smartTask.findFirst({
        where: videoLaneRevisionWhere(w.projectId),
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, description: true, summary: true, createdAt: true, assignedKey: true, contactName: true, source: true, title: true, reasonCreated: true },
      }).catch(() => null)
    : null;
  // WHO ASKED (gap 11, Sep 28): the office's own reopen (the Editing Room's
  // queue-add) names whoever pressed it — while the row is still theirs; a
  // client's later ask rewrites it (officeReopenOf). Otherwise the newest brief
  // on that revision names its requester (RevisionBrief.requestedBy) — the
  // client, their teammate, our staff on their behalf, the email or text
  // sender — else the task's own person (contactName). Nothing is guessed — an
  // older ask with neither says nothing, as it always did.
  const officeReopen = officeReopenOf(clientAsk);
  const askBrief = clientAsk && !officeReopen
    ? await prisma.revisionBrief.findFirst({
        where: { taskId: clientAsk.id, requestedBy: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { requestedBy: true, requestedByKind: true, createdAt: true },
      }).catch(() => null)
    : null;
  const askedByLine = officeReopen
    ? officeReopenLine(officeReopen)
    : askBrief
      ? requesterLine({ requestedBy: askBrief.requestedBy, requestedByKind: askBrief.requestedByKind, at: askBrief.createdAt })
      : clientAsk?.contactName
        ? `Asked by ${clientAsk.contactName} · ${whenET(clientAsk.createdAt)}`
        : null;
  // ---- Oct 15 2026: the reviewer's two-part check, creative review, and what
  // to judge the cut against (lib/reviewChecklist, lib/creativeReview,
  // components/review/JudgeAgainst). The desk only; a failed read shows none.
  // Oct 16 2026 (Jordan: "Make sure you didn't overcomplicate the review
  // portion ... We know what to look for when reviewing the video"): no
  // checklist to tick before Approve. The approval itself is the sign-off and
  // is recorded with who and when; the script, brand and style stay one tap
  // away beside the video (JudgeAgainst), folded.
  const { isCreativeApprover } = await import("@/lib/reviewChecklist");
  const creativeApprover = !shotThis && (await isCreativeApprover(me, { authEnforced: authEnforced() }).catch(() => false));
  const creativeReviews = shotThis ? [] : await import("@/lib/creativeReview").then((m) => m.openCreativeReviews(w.projectId)).catch(() => []);
  // "BEFORE YOU APPROVE" (Oct 19 2026): ONE box above the player with what
  // the client asked for this round (the revision ask) and the job's own
  // checks (components/jobs/BeforeYouSend, lib/jobChecks): what was flagged
  // at the shoot, the client's open requests for the video (texts, emails,
  // the order; one Checked for all of them) and the order and edit notes. It
  // replaced the separate "Open client asks on this job" card and the
  // separate "What the client asked for" block. Approve is never blocked
  // here: an open request holds the DELIVERY until it is checked, not the
  // verdict. The office only; a failed read shows none.
  // Plus every video's state for the fold under the player (a failed read is
  // said out loud, never folded away).
  const [jobBox, videoStatus] = shotThis
    ? [null, null]
    : await Promise.all([
        loadBeforeYouSend(w.projectId, "video").catch(() => null),
        readProjectVideoStatus(w.projectId),
      ]);
  let judgeScript: JudgeScript = null;
  let judgeTopic: string | null = null;
  let judgeBrand: JudgeBrand = null;
  let judgeStyle: import("@/lib/creativeGuard").StyleMemory | null = null;
  if (!shotThis) {
    const clientId = (await prisma.project.findUnique({ where: { id: w.projectId }, select: { clientId: true } }).catch(() => null))?.clientId ?? null;
    const [brief, brand] = await Promise.all([
      active?.deliverableId ? import("@/lib/deliverableOutputs").then((m) => m.filmingBriefFor(w.projectId)).catch(() => null) : Promise.resolve(null),
      clientId ? import("@/lib/brandProfile").then((m) => m.brandBriefFor(clientId, { projectId: w.projectId, scrub: !!me && me.role !== "OWNER" })).catch(() => null) : Promise.resolve(null),
    ]);
    const row = active?.deliverableId ? brief?.rows.find((r) => r.key === `${active.deliverableId}:${active.slot ?? 1}`) ?? null : null;
    judgeTopic = row?.topicTitle ?? null;
    judgeScript = row?.script ? { title: row.script.title, versionNo: row.script.versionNo, text: row.script.text, standing: row.script.standing } : null;
    if (brand) {
      judgeBrand = {
        colors: brand.colors, colorWords: brand.colorWords, fontNames: brand.fontNames,
        files: brand.files.map((f) => ({ name: f.fileName ?? f.name, typeWord: f.typeWord, url: f.url, versionNo: f.versionNo })),
        videoStyle: brand.videoStyle, preferences: brand.preferences, acceptedPreferences: brand.acceptedPreferences, music: brand.music,
      };
      judgeStyle = brand.styleMemory;
    }
  }

  // The box's parts: this round's ask (until the cut is approved) and the job's own checks.
  const roundAsk = !!clientAsk && !!active && active.status !== "APPROVED";
  const boxHasChecks = !!jobBox && (jobBox.data.flags.length > 0 || jobBox.data.requests.length > 0 || jobBox.data.notes.length > 0);
  const boxTitle = active?.status === "APPROVED" ? "Before you send" : "Before you approve";

  // Which cut each client note is on, in the Room's own words.
  const cutNameOf = (submissionId: string) => {
    const s = w.submissions.find((x) => x.id === submissionId);
    return s ? `${slotLabel(s) ?? s.fileName ?? "A cut"} · version ${s.round}` : "An earlier cut";
  };

  return (
    <div>
      {/* Back to where they came from — the in-app history (the home's Video
          Review card, the Review Room queue), or the Room on a cold deep link.
          This page had no way back except the sidebar, which sits behind the
          menu on a phone — Kyle reviewed a cut and had no obvious control to
          get back to the list (audit, Sep 8 2026). Same placement as /edit. */}
      <div className="border-b border-border px-4 py-3 sm:px-6">
        {/* Both go to /review now (Sep 18). It used to point a photographer at
            /shoot because the Room's index redirected them away; the index
            answers them with their own cuts today, so "back" means back to the
            list they came from, for everybody. */}
        <BackLink href="/review" label="Video Review Room" />
      </div>
      <PageHeader
        eyebrow="Video Review Room"
        title={w.street}
        // The agent's Aryeo headshot beside their name (Jordan, Sep 2). An
        // empty name stays hidden, exactly as the bare string used to.
        subtitle={
          w.clientName ? (
            <span className="inline-flex items-center gap-2">
              <Avatar name={w.clientName} src={w.clientAvatarUrl} size={20} /> {w.clientName}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${w.projectId}`}
              className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
            >
              <Images className="size-3.5" /> Photo review & project <ExternalLink className="size-3.5" />
            </Link>
          </div>
        }
      />

      <div className="grid min-w-0 grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the cut. Oct 19 2026 (Jordan: "we can tighten up that as
            well"): the player with its notes and Approve / Request changes
            leads, with only the version line above it (and the video tabs when
            the job has several videos), then ONE "Before you approve" box. The
            rest is folded under the player. */}
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {slots.length > 1 && <nav aria-label="Project videos" className="-mx-1 flex max-w-full snap-x gap-2 overflow-x-auto px-1 py-1">
            {slots.map((slot, index) => {
              const key = `${slot.deliverableId}:${slot.slot}`;
              const current = latestPerCut.get(key);
              const selected = current ? active?.id === current.id : output === key;
              const tone = current?.status === "APPROVED" ? "border-success/40 bg-success-soft text-success" : current?.status === "PENDING" ? "border-warning/40 bg-warning-soft text-warning" : "border-border bg-surface text-muted";
              return <Link key={key} aria-current={selected ? "page" : undefined} href={current ? `/review/${w.projectId}?cut=${current.id}#cut-${current.id}` : `/review/${w.projectId}?output=${key}`} title={slot.topicTitle ?? slot.deliverableLabel} className={`inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-sm sm:min-h-9 ${tone} ${selected ? "border-brand ring-1 ring-inset ring-brand" : ""}`}><span className="font-semibold">Video {navigation.get(key)?.number ?? index + 1}<span className="font-normal opacity-70"> of {navigation.get(key)?.total ?? slots.length}</span></span><span className="text-xs opacity-80">{current ? `V${current.round}` : "Awaiting edit"}</span></Link>;
            })}
          </nav>}
          {slots.length === 0 && currentCuts.length > 1 && <nav aria-label="Legacy videos" className="flex flex-wrap gap-2">{currentCuts.map((current) => <Link key={current.id} href={`/review/${w.projectId}?cut=${current.id}`} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm">{current.fileName ?? "Unmapped video"} · V{current.round}</Link>)}</nav>}
          {active ? (
            <>
              {/* Oct 9 2026 (Jordan: "fix the spacing"): what this is on one line,
                  who/when/file quietly underneath; the editor's note one quiet
                  line under that (Oct 19). */}
              <div id={`cut-${active.id}`} className="min-w-0 scroll-mt-24 space-y-0.5">
                <p className="text-sm">
                  {slotLabel(active) && <span className="font-semibold text-foreground">{slotLabel(active)}</span>}
                  {slotLabel(active) && <span className="text-muted-2"> · </span>}
                  <span className="font-medium text-foreground/85">Version {active.round}</span>
                </p>
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  <span className="shrink-0">from {editorLabel} · {formatDistanceToNow(new Date(active.createdAt), { addSuffix: true })}</span>
                  {active.fileName && <span className="min-w-0 truncate text-muted-2" title={active.fileName}>· {active.fileName}</span>}
                </p>
                {active.note && (
                  <p className="text-xs text-muted" data-editor-note>
                    {editorLabel === "the editor" ? "The editor" : editorLabel.split(/\s+/)[0]}&rsquo;s note: <span className="italic text-foreground/80">&ldquo;{active.note}&rdquo;</span>
                  </p>
                )}
              </div>
              {active.heldForCheck && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
                  <p className="font-semibold text-foreground">Waiting on {editorLabel}&rsquo;s send-for-review check</p>
                  <p className="mt-1 text-xs text-muted">
                    This version is in, but the editor hasn&rsquo;t finished the check on it yet, so there is nothing to rule on.
                    It joins the review list once they do.{" "}
                    {!shotThis && (
                      <Link href={`/edit/${w.projectId}#self-check`} className="font-medium text-brand hover:underline">
                        Finish it for them
                      </Link>
                    )}
                  </p>
                </div>
              )}
              {(roundAsk || boxHasChecks) && (
                <section aria-label={boxTitle} data-before-you-approve className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 px-3 py-3 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-foreground">
                    <ClipboardCheck aria-hidden className="size-4 text-brand" />
                    {boxTitle}
                  </p>
                  {clientAsk && roundAsk && (
                    <div data-round-ask className="space-y-0.5">
                      <p className="font-semibold text-foreground">
                        {/* The office's reopen is not the client's ask (review, Sep 28):
                            the heading used to say "client" right above "Put back by
                            Kyle Cabrera (the office)". */}
                        {officeReopen ? "What the office asked for" : "What the client asked for"}
                        <span className="font-normal text-muted"> · {officeReopen ? "reopened" : "asked"} {formatDistanceToNow(new Date(clientAsk.createdAt), { addSuffix: true })}</span>
                      </p>
                      {askedByLine && <p className="text-xs text-muted">{askedByLine}</p>}
                      {(clientAsk.description ?? clientAsk.summary) && (
                        <p className="mt-1 whitespace-pre-wrap text-foreground/85">{plainAsk(clientAsk.description ?? clientAsk.summary ?? "").slice(0, 600)}</p>
                      )}
                    </div>
                  )}
                  {/* The job's own box (lib/jobChecks), its title dropped: this box is titled. */}
                  {jobBox && boxHasChecks && (
                    <div className="[&>section]:space-y-3 [&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0 [&>section>p:first-child]:hidden">
                      <BeforeYouSendView data={jobBox.data} medium="video" canCheck={jobBox.canCheck} />
                    </div>
                  )}
                </section>
              )}
              <CutReviewPanel
                key={active.id}
                projectId={w.projectId}
                submission={active}
                notes={w.notes}
                editorLabel={editorLabel}
                takeBack={takeBack}
                cutLabel={slotLabel(active) ?? active.fileName ?? "this cut"}
                canDecide={!shotThis}
                heldForCheck={active.heldForCheck}
                fixesToCheck={fixesToCheck}
                readStamp={new Date().toISOString()}
                nextCut={nextCut ? { href: nextCut.href, label: nextCut.label } : null}
                street={w.street}
              />

            </>
          ) : (
            <>
              <Section icon={Film} title="No cut uploaded yet">
                <p className="text-sm text-muted">
                  When the editor uploads a version from the editor portal, it shows up here with a player and
                  timestamped notes. This job is currently <span className="font-medium text-foreground/80">{w.status.toLowerCase()}</span>.
                </p>
              </Section>
              {jobBox && boxHasChecks && <BeforeYouSendView data={jobBox.data} medium="video" canCheck={jobBox.canCheck} />}
            </>
          )}

          {/* A client's feeling that could not be turned into an instruction
              waits here for Jordan or James (only when one is open). */}
          {creativeReviews.length > 0 && <CreativeReviewPanel reviews={creativeReviews} canResolve={creativeApprover} />}

          {/* Folded under the player (Oct 19): every video on this job with its
              state and next action, and the earlier versions of this one. A
              failed status read is said out loud, never folded away. */}
          {videoStatus === null && !shotThis && <ProjectVideoStatusUnavailable />}
          {((videoStatus?.length ?? 0) > 0 || earlierRounds.length > 0) && (
            <details className="rounded-xl border border-border px-4 py-1" data-other-videos>
              <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 text-sm">
                <History aria-hidden className="size-4 text-muted-2" />
                <span className="font-semibold">This job&rsquo;s other videos and earlier versions</span>
                <span className="text-muted">
                  {[
                    videoStatus?.length ? `${videoStatus.length} video${videoStatus.length === 1 ? "" : "s"}` : null,
                    earlierRounds.length ? `${earlierRounds.length} earlier version${earlierRounds.length === 1 ? "" : "s"}` : null,
                  ].filter(Boolean).join(" · ")}
                </span>
              </summary>
              <div className="space-y-3 border-t border-border py-3">
                {videoStatus && videoStatus.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-2">Every video on this job</h3>
                    <ProjectVideoStatusList rows={videoStatus} selectedKey={active?.deliverableId ? `${active.deliverableId}:${active.slot ?? 1}` : output} />
                  </div>
                )}
                {earlierRounds.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-2">Earlier versions of this video</h3>
                    <ul className="divide-y divide-border border-t border-border">
                      {earlierRounds.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                          <span className="font-medium">Version {s.round}</span>
                          <span className="text-xs text-muted">
                            {/* Who ruled on it, and when (Sep 28), or what became of it. */}
                            {verdictLine(s.verdict) ??
                              `${s.status === "WITHDRAWN" ? "withdrawn" : "superseded"}${s.decidedAt ? ` ${formatDistanceToNow(new Date(s.decidedAt), { addSuffix: true })}` : ""}`}
                          </span>
                          {s.assetUrl && (
                            <a href={s.assetUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                              Watch
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>

        {/* RIGHT — what to judge it against */}
        <div className="min-w-0 space-y-4">
          {!shotThis && <JudgeAgainst topicTitle={judgeTopic} script={judgeScript} brand={judgeBrand} style={judgeStyle} />}
          {/* What to judge the cut against, folded to one line (Oct 5): the
              order, the plan and the photographer's notes are a tap away, and
              the one fact that changes the bar — premium — stays on the line. */}
          <details className="rounded-xl border border-border px-4 py-1">
            <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 text-sm">
              <Film className="size-4 text-muted-2" />
              <span className="font-semibold">The brief</span>
              <span className="text-muted">
                {[
                  "what was ordered",
                  w.reelHook || w.reelScript || w.reelSong ? "the plan" : null,
                  w.editorBrief ? "editing notes" : null,
                ].filter(Boolean).join(" · ")}
              </span>
              {w.premium && (
                <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: "#a78bfa1a", color: "#a78bfa" }}>
                  Premium
                </span>
              )}
            </summary>
            <div className="space-y-4 border-t border-border py-3">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-2">What was ordered</h3>
                {w.deliverables.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {w.deliverables.map((d) => (
                      <span key={d} className="rounded-lg bg-surface-2 px-2 py-1 text-xs font-medium text-foreground/85">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-muted">No video deliverables listed.</p>
                )}
                {w.premium && (
                  <p className="mt-2 text-xs font-medium" style={{ color: "#a78bfa" }}>
                    Premium tier — hold it to the influencer standard.
                  </p>
                )}
              </div>

              {(w.reelHook || w.reelScript || w.reelSong) && (
                <div className="space-y-2 text-sm">
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-2">
                    <ScrollText className="size-3.5" /> The plan (reel recipe)
                  </h3>
                  {w.reelHook && (
                    <p>
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-2">Hook</span>
                      <br />
                      {w.reelHook}
                    </p>
                  )}
                  {w.reelSong && (
                    <p className="flex items-center gap-1.5 text-foreground/85">
                      <Music className="size-3.5 text-muted-2" /> {w.reelSong}
                    </p>
                  )}
                  {w.reelScript && (
                    <details>
                      <summary className="cursor-pointer text-xs font-medium text-brand">Full script</summary>
                      <p className="mt-1 whitespace-pre-wrap text-foreground/85">{w.reelScript}</p>
                    </details>
                  )}
                </div>
              )}

              {w.editorBrief && (
                <div>
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-2">
                    <PenLine className="size-3.5" /> Photographer&apos;s editing notes
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">{w.editorBrief}</p>
                </div>
              )}
            </div>
          </details>

          {/* The client's own portal notes on this job's cuts (interactive
              layer, Aug 28) — read-only context while judging the next round;
              SENT ones already became the revision work order. Open when there
              are any, folded to its title line when there are none (Oct 19). */}
          {!shotThis && (
            <details className="rounded-xl border border-border px-4 py-1" open={clientNoteCount > 0} data-client-notes={clientNoteCount}>
              <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 text-sm">
                <MessageSquareQuote aria-hidden className="size-4 text-muted-2" />
                <span className="font-semibold">Client&rsquo;s notes</span>
                <span className="text-muted">{clientNoteCount || "none"}</span>
              </summary>
              <div className="space-y-3 border-t border-border py-3">
                {clientNoteCount === 0 && <p className="text-sm text-muted">The client has not left a note on this job&rsquo;s videos.</p>}
                {clientNoteGroups.map((g) => (
                  <div key={g.submissionId}>
                    {clientNoteGroups.length > 1 && (
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">{cutNameOf(g.submissionId)}</p>
                    )}
                    <ul className="space-y-2">
                      {g.notes.map((n) => (
                        <li key={n.id} className="text-sm">
                          <div className="flex items-start gap-2">
                            {n.timeSec != null && (
                              <span className="mt-0.5 shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                                {Math.floor(n.timeSec / 60)}:{String(Math.floor(n.timeSec % 60)).padStart(2, "0")}
                              </span>
                            )}
                            <span className="min-w-0 flex-1 text-foreground/85">{n.body}</span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-2">
                            {byLine(n.author, n.createdAtISO)}
                            {" · "}
                            {/* Keyed on the resolve stamp, like the portal (review, Sep 28). */}
                            {clientNoteStatusWords(n)}
                          </p>
                          {n.replies.length > 0 && (
                            <ul className="mt-1 space-y-1 border-l-2 border-border pl-3">
                              {n.replies.map((r) => (
                                <li key={r.id} className="text-[13px]">
                                  <span className="text-foreground/80">{r.body}</span>
                                  <span className="ml-1.5 text-[11px] text-muted-2">{byLine(r.author, r.createdAtISO)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      {/* The confirmation a verdict leaves behind follows the reviewer here. */}
      {!shotThis && <VerdictReceipts />}
    </div>
  );
}
