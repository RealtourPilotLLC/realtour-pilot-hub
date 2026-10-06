import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Camera, CheckCircle2, Clapperboard, ClipboardCheck, Flag, Hourglass, MessageSquare, Pencil, PlayCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { followUpHref, getReviewQueue, type QueueSubmission } from "@/lib/reviewRoom";
import { getFixPatterns, getQcStats } from "@/lib/qc";
import { revisionQuality } from "@/lib/revisionQuality";
import { RevisionQualitySummary } from "@/components/review/RevisionQualitySummary";
import { VerdictReceipts } from "@/components/review/VerdictReceipts";
import { verdictLine } from "@/lib/reviewAttribution";

export const dynamic = "force-dynamic";
// A verdict pressed here answers at once and finishes its follow-ons (the
// Dropbox copy waits on Dropbox for up to 15 s, the client-library rebuild) in
// after(), inside this route's function budget (Oct 5) — the same 60 s ceiling
// /edit/<id> uses. Anything a cut-short run leaves undone, the hourly sweeps
// named in review/actions.ts finish.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// The REVIEW ROOM — the owner's quality desk, its own page. Everything that
// needs (or is waiting on) a quality verdict, across every project:
//   · cuts editors submitted for review   → /review/<id> workspace
//   · changes-requested cuts (on the editor)
//   · photo sets sitting in QC (Kyle's media_qa cards)
//   · open feedback follow-through by lane (who owes a fix / a re-review)
// Owner/admin only — creatives get their feedback on their own surfaces
// (/shoot for photographers, /edit for editors).
// ---------------------------------------------------------------------------

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

// Secondary panels, folded to their title line (Oct 5): the desk opens on the
// cuts to rule on; history and scoreboards are one tap away.
function Fold({ icon: Icon, title, count, children }: { icon: LucideIcon; title: string; count?: number | null; children: React.ReactNode }) {
  return (
    <details className="panel-shadow rounded-2xl border bg-surface px-5 py-1">
      <summary className="flex min-h-12 cursor-pointer items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="text-base font-semibold">{title}</span>
        {count != null && <span className="rounded-full bg-surface-2 px-2 text-ui-status font-medium text-muted">{count}</span>}
      </summary>
      <div className="border-t border-border py-4">{children}</div>
    </details>
  );
}

// §8.1: who the cut waits on, from the row itself — never from a notice.
function ReviewerChip({ s, viewerTeamMemberId }: { s: QueueSubmission; viewerTeamMemberId: string | null }) {
  if (s.status !== "PENDING" || s.heldForCheck) return null;
  if (!s.reviewer) {
    return <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">Nobody holds it — the office</span>;
  }
  if (viewerTeamMemberId && s.reviewer.id === viewerTeamMemberId) {
    return <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">Waiting on you</span>;
  }
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">With {s.reviewer.name.split(/\s+/)[0]}</span>;
}

function CutRow({ s, decided, viewerTeamMemberId = null }: { s: QueueSubmission; decided?: boolean; viewerTeamMemberId?: string | null }) {
  return (
    <li>
      <Link
        // ?cut= opens THIS submission — a monthly package's videos each get
        // their own row here and are reviewed one by one.
        href={`/review/${s.projectId}?cut=${s.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
      >
        <PlayCircle className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{s.street}</span>
            {s.fileName && (
              <span className="max-w-48 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{s.fileName}</span>
            )}
            {s.premium && (
              <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: "#a78bfa1a", color: "#a78bfa" }}>
                Premium
              </span>
            )}
            {s.round > 1 && (
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Round {s.round}</span>
            )}
            {!s.hasAsset && (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">No file found</span>
            )}
            <ReviewerChip s={s} viewerTeamMemberId={viewerTeamMemberId} />
            {s.openEditorNotes > 0 && (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
                {s.openEditorNotes} open note{s.openEditorNotes === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {/* The agent's headshot beside their name (Jordan, Sep 2: show the
              Aryeo profile photo "in other places the clients are mentioned").
              18px sits inside the text-xs line, so the row doesn't grow. */}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {s.clientName && <Avatar name={s.clientName} src={s.clientAvatarUrl} size={18} />}
            <span className="truncate">
              {s.clientName}
              {s.submittedByName ? ` · from ${s.submittedByName}` : ""}
              {" · "}
              {/* WHO RULED, AND WHEN (Sep 28): "Sent back by James Rivera · Mon,
                  Sep 28, 2:14 PM", or the client's own send-back on an approved
                  cut — the row used to say only "decided 2 hours ago". */}
              {decided && s.decidedAt
                ? verdictLine(s.verdict) ?? `decided ${ago(s.decidedAt)}`
                : `submitted ${ago(s.createdAt)}`}
            </span>
          </div>
          {s.note && <div className="mt-1 truncate text-xs italic text-muted-2">“{s.note}”</div>}
        </div>
      </Link>
    </li>
  );
}

export default async function ReviewRoomPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  await requirePageAccess("review");
  const includeTest = (await searchParams).test === "1";
  const me = await getCurrentUser().catch(() => null);
  // THE SAME QUESTION THE ACTIONS ASK (§8.1, review fix Sep 25): owner/admin,
  // or a login seated as one of the three reviewers. It used to be the
  // OWNER/ADMIN role alone, so a seated reviewer on a narrower login was rung
  // for cuts and allowed to rule on them by the server, with no desk to do it
  // from. View-as is still refused (canRuleOnCuts says no to a preview).
  const { isReviewDesk } = await import("@/lib/reviewerAssignment");
  const ownerDesk = await isReviewDesk(me, { authEnforced: authEnforced() });
  // A PHOTOGRAPHER gets the Room narrowed to their own shoots rather than the
  // door (Jordan, Sep 18). Sending them to /shoot — the Sep 17 answer — meant
  // the only way into a cut was a tag, so a video from their own shoot that
  // nobody thought to tag them on was unreachable. Everything below this line
  // is the office's desk: every client's cut, Kyle's photo QC, the follow-up
  // rollup and the scoreboards. None of it is theirs, and none of it loads.
  if (!ownerDesk && me?.role === "PHOTOGRAPHER") {
    // THE SAME RULE AS THE PAGE THIS INDEX LINKS TO (review, Sep 18). This read
    // the roster with photographerMemberId, which falls back to an email match
    // when the login carries no teamMemberId; /review/<id> and askCutChange
    // both require AppUser.teamMemberId itself. An unlinked login therefore got
    // an index of cuts where every row redirected it straight back out, and a
    // composer that refused it. One rule, and it is the narrower one, because
    // it is the one the writes are guarded by. (Live today: the one
    // photographer login is linked, so nobody's list changes.)
    const mid = me.teamMemberId;
    // No roster link = no way to say which shoots are theirs. Fail closed to
    // their own home rather than to somebody else's cuts.
    if (!mid) redirect(homeFor(me.role));
    const { PhotographerRoom } = await import("@/components/review/PhotographerRoom");
    return <PhotographerRoom memberId={mid} firstName={(me.name ?? "there").split(" ")[0]} />;
  }
  if (!ownerDesk) redirect(homeFor(me?.role));

  const [q, patterns, qcStats, causes] = await Promise.all([
    getReviewQueue({ includeTest }),
    getFixPatterns(60, { includeTest }),
    getQcStats(30, { includeTest }),
    revisionQuality(30, { includeTest }).catch(() => null),
  ]);
  // "Waiting on YOUR verdict" counts only the cuts that are yours (§8.1) —
  // Kyle's Room must not tell him James's cuts are his to rule on.
  // A cut nobody holds (no chain configured, or everyone away) is the
  // office's, so it counts as waiting on an owner/admin viewer.
  const viewerTeamMemberId = me && !me.impersonating ? me.teamMemberId : null;
  const officeViewer = !!me && !me.impersonating && (me.realRole === "OWNER" || me.realRole === "ADMIN");
  const mine = viewerTeamMemberId || officeViewer
    ? q.pending.filter((s) => (s.reviewer ? s.reviewer.id === viewerTeamMemberId : officeViewer)).length
    : 0;
  const withOthers = q.pending.length - mine;
  const laneMeta = {
    EDIT: { label: "Kyle — delivery fixes", icon: Pencil },
    PHOTOGRAPHER: { label: "Photographer — capture", icon: Camera },
    EDITOR: { label: "Editor — cut", icon: Clapperboard },
  } as const;

  return (
    <div>
      <PageHeader
        eyebrow="Quality desk"
        title="Review Room"
        subtitle={
          !viewerTeamMemberId && !officeViewer && q.pending.length
            ? `${q.pending.length} cut${q.pending.length === 1 ? "" : "s"} waiting on a verdict`
            : mine
              ? `${mine} cut${mine === 1 ? "" : "s"} waiting on you${withOthers ? ` · ${withOthers} with someone else` : ""}`
              : withOthers
                ? `No cuts awaiting your verdict · ${withOthers} cut${withOthers === 1 ? "" : "s"} with someone else`
                : "No cuts awaiting your verdict · check revisions and delivery below"
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex justify-end">
          <Link href={includeTest ? "/review" : "/review?test=1"} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            {includeTest ? "Hide test records" : "Show test records"}
          </Link>
        </div>
        {/* ————— VIDEO LANE ————— */}
        <div className="flex items-center gap-2 px-1 pt-1">
          <span className="flex size-6 items-center justify-center rounded-lg" style={{ background: "#a78bfa22", color: "#a78bfa" }}>
            <PlayCircle className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold">Video</h2>
          <span className="text-[11px] text-muted-2">· a cut arrives once the editor uploads a version and finishes their send-for-review check</span>
        </div>
        <Section icon={PlayCircle} title="Cuts to review" count={q.pending.length || null}>
          {q.pending.length === 0 ? (
            <p className="text-sm text-muted">
              No cuts waiting. When an editor uploads a version on the edit page and finishes the send-for-review
              check, it shows up here with a player and timestamped notes.
            </p>
          ) : (
            <ul className="space-y-2.5">{q.pending.map((s) => <CutRow key={s.id} s={s} viewerTeamMemberId={viewerTeamMemberId} />)}</ul>
          )}
        </Section>

        {/* §8.2: handed in, held for the editor's own send-for-review check —
            the found-in-the-folder cut, the upload that wasn't the file
            checked, the moved cut. Nothing here can be ruled on yet. */}
        {q.waitingOnCheck.length > 0 && (
          <Section icon={Hourglass} title="Waiting on the editor's check" count={q.waitingOnCheck.length}>
            <p className="mb-3 text-xs text-muted">
              These are in, but the editor hasn&rsquo;t finished the send-for-review check on them — they reach the list
              above once they do. They can finish it on the job&rsquo;s edit page (or the office can, for them).
            </p>
            <ul className="space-y-2.5">{q.waitingOnCheck.map((s) => <CutRow key={s.id} s={s} />)}</ul>
          </Section>
        )}

        {q.waitingOnEditor.length > 0 && (
          <Section icon={Hourglass} title="In revisions" count={q.waitingOnEditor.length}>
            <ul className="space-y-2.5">{q.waitingOnEditor.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          </Section>
        )}


        {/* media_qa is a mixed-media task type. Do not present a video-only
            program job as a photo set. */}
        <div className="flex items-center gap-2 px-1 pt-3">
          <span className="flex size-6 items-center justify-center rounded-lg" style={{ background: "#34d39922", color: "#34d399" }}>
            <ClipboardCheck className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold">Delivery checks</h2>
          <span className="text-[11px] text-muted-2">· photo and video work awaiting a media check</span>
        </div>
        {q.photoQc.length > 0 && (
          <Section icon={ClipboardCheck} title="Media checks to finish" count={q.photoQc.length}>
            <ul className="divide-y divide-border">
              {q.photoQc.map((t) => (
                <li key={t.taskId}>
                  <Link
                    href={t.projectId ? `/projects/${t.projectId}` : "/tasks"}
                    className="flex items-center justify-between gap-3 py-2.5 hover:text-brand"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{t.street}</span>
                      {t.clientName && (
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
                          <Avatar name={t.clientName} src={t.clientAvatarUrl} size={18} />
                          <span className="truncate">{t.clientName}</span>
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted">
                      {t.assignedKey ? `${t.assignedKey} · ` : ""}
                      {t.dueAt ? `due ${ago(t.dueAt)}` : "no due date"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {q.followUps.length > 0 && (
          <Section icon={MessageSquare} title="Feedback follow-through" count={q.followUps.length}>
            <p className="mb-3 text-xs text-muted">
              Review notes still moving: <span className="font-medium text-foreground/80">open</span> = someone owes a
              fix · <span className="font-medium text-foreground/80">fixed</span> = they say it&rsquo;s done, you owe a
              re-look.
            </p>
            <ul className="divide-y divide-border">
              {q.followUps.map((f) => {
                const m = laneMeta[f.lane];
                return (
                  <li key={`${f.projectId}-${f.lane}`}>
                    <Link
                      // The cut with its notes (Sep 28) — the project page only
                      // when the notes are not on a cut (photos).
                      href={followUpHref(f)}
                      className="flex items-center justify-between gap-3 py-2.5 hover:text-brand"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <m.icon className="size-4 shrink-0 text-muted-2" />
                        <span className="truncate text-sm font-medium">{f.street}</span>
                        <span className="text-xs text-muted">{m.label}</span>
                      </div>
                      <span className="shrink-0 text-xs">
                        {f.awaitingReply > 0 && (
                          <span className="mr-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                            {f.awaitingReply} unanswered {f.awaitingReply === 1 ? "reply" : "replies"}
                          </span>
                        )}
                        {f.open > 0 && <span className="font-medium text-brand">{f.open} open</span>}
                        {f.open > 0 && f.awaitingReReview > 0 && <span className="text-muted-2"> · </span>}
                        {f.awaitingReReview > 0 && <span className="font-medium text-success">{f.awaitingReReview} fixed</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {q.recentlyApproved.length > 0 && (
          <Fold icon={CheckCircle2} title="Approved — last 14 days" count={q.recentlyApproved.length}>
            <ul className="space-y-2.5">{q.recentlyApproved.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          </Fold>
        )}

        {causes ? (
          <Fold icon={Flag} title="Revision causes">
            <RevisionQualitySummary report={causes} />
          </Fold>
        ) : (
          <Section icon={Flag} title="Revision causes">
            <p role="status" className="text-sm text-warning">Revision causes could not be loaded. Refresh to retry; no quality result is available from this read.</p>
          </Section>
        )}

        {/* Recording gaps and reported observations are separate from confirmed causes. */}
        {(patterns.flagsTotal > 0 || qcStats.byMiss.length > 0 || patterns.captureByPhotographer.length > 0) && (
          <Fold icon={Flag} title="Review observations and optional check records">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Photo fix reasons — last {patterns.windowDays} days
                </h3>
                {patterns.byTag.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No photos flagged for fixes. 🎉</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {patterns.byTag.slice(0, 6).map((t) => (
                      <li key={t.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{t.label}</span>
                        <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-warning">
                          {t.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-muted-2">
                  {patterns.flagsTotal} photo{patterns.flagsTotal === 1 ? "" : "s"} flagged
                  {patterns.flagsOpen > 0 ? ` · ${patterns.flagsOpen} still open` : ""}
                  {patterns.editNotes > 0 ? ` · +${patterns.editNotes} review fix note${patterns.editNotes === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Optional QC checks not recorded — last {qcStats.windowDays} days
                </h3>
                {qcStats.byMiss.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No unrecorded checklist items found across {qcStats.qcPasses} QC passes. This does not measure defects.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {qcStats.byMiss.slice(0, 6).map((m) => (
                      <li key={m.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{m.label}</span>
                        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular-nums text-muted">
                          {m.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {qcStats.qcPasses > 0 && (
                  <p className="mt-2 text-[11px] text-muted-2">
                    {qcStats.qcPasses} QC pass{qcStats.qcPasses === 1 ? "" : "es"} · {qcStats.reopenedRate}% later
                    reopened after a revision (cause not assigned)
                  </p>
                )}
              </div>
            </div>
            {patterns.captureByPhotographer.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Capture notes by photographer — last {patterns.windowDays} days
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {patterns.captureByPhotographer.map((p) => (
                    <span key={p.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium">
                      <Camera className="size-3 text-muted-2" /> {p.name}
                      <span className="tabular-nums text-muted">{p.count}</span>
                    </span>
                  ))}
                  <Link href="/shoot/feedback" className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium text-brand hover:bg-surface-2">
                    Photographer scoreboard →
                  </Link>
                </div>
              </div>
            )}
          </Fold>
        )}
      </div>
      {/* A verdict given in a cut follows the reviewer back here (Oct 5). */}
      <VerdictReceipts />
    </div>
  );
}
