import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Film, History, Images, MessageSquareQuote, Music, PenLine, ScrollText } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCutWorkspace } from "@/lib/reviewRoom";
import { editorMeta } from "@/lib/editors";
import { CutReviewPanel } from "@/components/review/CutReviewPanel";
import { cutTakeBackFlags } from "@/app/review/actions";
import { BackLink } from "@/components/ui/BackLink";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// One project's cut-review workspace: the submitted video with timestamped
// notes + the Approve / Request-changes verdict (CutReviewPanel), alongside
// everything needed to JUDGE the cut — what was ordered, the editing notes the
// photographer left, and the reel recipe. Photo review stays in the project
// gallery; the header links straight to it.
// ---------------------------------------------------------------------------

export default async function CutReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cut?: string }>;
}) {
  const { id } = await params;
  const { cut } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  const ownerDesk = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  // A PHOTOGRAPHER reaches this page from a tag on the cut — Jordan, Sep 17:
  // "I want to be able to tag james on the video - he gets a text with my
  // message and a link to see the review room video and comment." Scoped to
  // the shoots they actually worked, not the Room's whole queue: the index at
  // /review is every client's cut and stays owner and admin only, exactly like
  // the Upload Portal was narrowed for the same reason. Ownership is asked of
  // the same helper the tag used to build the link, so the page and the text
  // can never disagree about who may open it.
  const shotThis =
    !ownerDesk && me?.role === "PHOTOGRAPHER" && me.teamMemberId
      ? await (await import("@/lib/shoot")).photographerOwnsShoot(id, me.teamMemberId).catch(() => false)
      : false;
  if (!ownerDesk && !shotThis) redirect(homeFor(me?.role));

  // The photographer's lens is applied in the query, not in the markup: the
  // editor brief, the reel recipe and every lane that is not their own never
  // leave the server (audit finding 4, Sep 17).
  const w = await getCutWorkspace(id, cut ?? null, shotThis && me?.teamMemberId ? { kind: "photographer", memberId: me.teamMemberId } : { kind: "office" });
  // Portal notes across this job's cuts, newest last.
  // Newest 30, shown oldest-first (desc+take keeps the LATEST notes when a
  // chatty client passes thirty — asc+take silently dropped the new ones).
  const clientNotes = shotThis ? [] : (await prisma.portalComment.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, timeSec: true, body: true, status: true },
  }).catch(() => [])).reverse();
  // The client's own words to the office are not the photographer's to read.
  if (!w) notFound();

  // Sep 16: a withdrawn cut is history, not the thing to rule on — getCutWorkspace
  // skips past it when nothing asked for it by id. That choice lives THERE, with
  // the note read: swapping the cut here left `w.notes` (built for the workspace's
  // own pick) hanging off the wrong version (reviewer, Sep 16).
  const active = w.active;
  // The job's CURRENT cuts — latest round per video file. One video job = one
  // chip (hidden); a monthly package = a switcher so each video is reviewed
  // individually (Jordan: "review each one individually in a timely manner").
  // A cut = (deliverable × slot) for uploaded rows, the file for legacy
  // folder rows; the newest round of each is the current cut.
  const cutKeyOf = (s: (typeof w.submissions)[number]) => (s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id));
  const latestPerCut = new Map<string, (typeof w.submissions)[number]>();
  // WITHDRAWN rounds don't speak for a cut (Sep 16) — a slot whose only round
  // was taken back reads as "nothing in yet", exactly like the editor's page.
  for (const s of [...w.submissions].filter((s) => s.status !== "WITHDRAWN").sort((a, b) => a.round - b.round)) latestPerCut.set(cutKeyOf(s), s);
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(w.projectId).catch(() => []);
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
  const takeBack = active ? (cutFlags.find((f) => f.submissionId === active.id) ?? null) : null;
  const { videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
  const clientAsk = active
    ? await prisma.smartTask.findFirst({
        where: videoLaneRevisionWhere(w.projectId),
        orderBy: { createdAt: "desc" },
        select: { status: true, description: true, summary: true, createdAt: true, assignedKey: true },
      }).catch(() => null)
    : null;

  return (
    <div>
      {/* Back to where they came from — the in-app history (the home's Video
          Review card, the Review Room queue), or the Room on a cold deep link.
          This page had no way back except the sidebar, which sits behind the
          menu on a phone — Kyle reviewed a cut and had no obvious control to
          get back to the list (audit, Sep 8 2026). Same placement as /edit. */}
      <div className="border-b border-border px-4 py-3 sm:px-6">
        {/* /review is the office's whole queue and a photographer is redirected
            off it — sending them back there was a dead end (audit finding 5). */}
        <BackLink href={shotThis ? "/shoot" : "/review"} label={shotThis ? "My Shoots" : "Review Room"} />
      </div>
      <PageHeader
        eyebrow="Review Room"
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

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-3">
        {/* LEFT — the cut */}
        <div className="space-y-4 lg:col-span-2">
          {currentCuts.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {currentCuts.map((c, i) => (
                <Link
                  key={c.id}
                  // Every cut answers #cut-<id> on this page too (Sep 16), so
                  // the same anchor works whichever desk the link came from —
                  // the active cut carries it below, the rest carry it here.
                  id={active?.id === c.id ? undefined : `cut-${c.id}`}
                  href={`/review/${w.projectId}?cut=${c.id}`}
                  className={`inline-flex scroll-mt-24 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    active?.id === c.id ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: c.status === "APPROVED" ? "#34d399" : c.status === "CHANGES_REQUESTED" ? "#f87171" : "#f59e0b" }}
                  />
                  <span className="max-w-48 truncate">{slotLabel(c) ?? c.fileName ?? `Video ${i + 1}`}</span>
                  {c.round > 1 && <span className="text-[10px] text-muted-2">v{c.round}</span>}
                </Link>
              ))}
            </div>
          )}
          {active ? (
            <>
              <div id={`cut-${active.id}`} className="flex scroll-mt-24 flex-wrap items-center gap-2 text-sm text-muted">
                {slotLabel(active) && <span className="font-semibold text-foreground">{slotLabel(active)}</span>}
                {slotLabel(active) && <span className="text-muted-2">·</span>}
                <span className="font-medium text-foreground/85">Version {active.round}</span>
                <span className="text-muted-2">·</span>
                <span>from {editorLabel}</span>
                <span className="text-muted-2">·</span>
                <span>{formatDistanceToNow(new Date(active.createdAt), { addSuffix: true })}</span>
                {active.fileName && (
                  <>
                    <span className="text-muted-2">·</span>
                    <span className="truncate text-xs text-muted-2">{active.fileName}</span>
                  </>
                )}
              </div>
              {active.note && (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm italic text-foreground/80">“{active.note}”</p>
              )}
              {clientAsk && active.status !== "APPROVED" && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
                  <p className="font-semibold text-foreground">
                    {clientAsk.status === "IN_PROGRESS" ? "Corrected cut for a client revision" : "A client revision is open on this job"}
                    <span className="font-normal text-muted"> · asked {formatDistanceToNow(new Date(clientAsk.createdAt), { addSuffix: true })}</span>
                  </p>
                  {(clientAsk.description ?? clientAsk.summary) && (
                    <p className="mt-1 whitespace-pre-wrap text-foreground/85">{(clientAsk.description ?? clientAsk.summary ?? "").slice(0, 600)}</p>
                  )}
                  <p className="mt-1.5 text-xs text-muted">
                    Approve → the revision closes and the job goes back to where it stands (a delivered job re-delivers, with Kyle&apos;s follow-up). Request changes → the job stays in Revisions and the ask stays open.
                  </p>
                </div>
              )}
              <CutReviewPanel
                projectId={w.projectId}
                submission={active}
                notes={w.notes}
                editorLabel={editorLabel}
                takeBack={takeBack}
                cutLabel={slotLabel(active) ?? active.fileName ?? "this cut"}
                canDecide={!shotThis}
              />
            </>
          ) : (
            <Section icon={Film} title="No cut uploaded yet">
              <p className="text-sm text-muted">
                When the editor uploads a version from the editor portal, it shows up here with a player and
                timestamped notes. This job is currently <span className="font-medium text-foreground/80">{w.status.toLowerCase()}</span>.
              </p>
            </Section>
          )}

          {earlierRounds.length > 0 && (
            <Section icon={History} title="Earlier rounds">
              <ul className="divide-y divide-border">
                {earlierRounds.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-medium">Version {s.round}</span>
                    <span className="text-xs text-muted">
                      {s.status === "APPROVED"
                        ? "approved"
                        : s.status === "CHANGES_REQUESTED"
                          ? "changes requested"
                          : s.status === "WITHDRAWN"
                            ? "withdrawn"
                            : "superseded"}
                      {s.decidedAt ? ` ${formatDistanceToNow(new Date(s.decidedAt), { addSuffix: true })}` : ""}
                    </span>
                    {s.assetUrl && (
                      <a href={s.assetUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                        Watch
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {/* RIGHT — what to judge it against */}
        <div className="space-y-4">
          <Section icon={Film} title="What was ordered">
            {w.deliverables.length ? (
              <div className="flex flex-wrap gap-1.5">
                {w.deliverables.map((d) => (
                  <span key={d} className="rounded-lg bg-surface-2 px-2 py-1 text-xs font-medium text-foreground/85">
                    {d}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No video deliverables listed.</p>
            )}
            {w.premium && (
              <p className="mt-2 text-xs font-medium" style={{ color: "#a78bfa" }}>
                Premium tier — hold it to the influencer standard.
              </p>
            )}
          </Section>

          {(w.reelHook || w.reelScript || w.reelSong) && (
            <Section icon={ScrollText} title="The plan (reel recipe)">
              <div className="space-y-2 text-sm">
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
            </Section>
          )}

          {w.editorBrief && (
            <Section icon={PenLine} title="Photographer's editing notes">
              <p className="whitespace-pre-wrap text-sm text-foreground/85">{w.editorBrief}</p>
            </Section>
          )}

          {/* The client's own portal notes on this job's cuts (interactive
              layer, Aug 28) — read-only context while judging the next round;
              SENT ones already became the revision work order. */}
          {clientNotes.length > 0 && (
            <Section icon={MessageSquareQuote} title="Client's notes" count={clientNotes.length}>
              <ul className="space-y-1.5">
                {clientNotes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 text-sm">
                    {n.timeSec != null && (
                      <span className="mt-0.5 shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                        {Math.floor(n.timeSec / 60)}:{String(Math.floor(n.timeSec % 60)).padStart(2, "0")}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-foreground/85">{n.body}</span>
                    <span className="shrink-0 text-[10px] text-muted-2">{n.status === "SENT" ? "sent to editor" : "new"}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
