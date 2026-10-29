import { requirePageAccess } from "@/lib/auth/guards";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Camera, CheckCircle2, Clapperboard, Flag, MessageSquare, Pencil, Send } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { followUpHref, getReviewQueue } from "@/lib/reviewRoom";
import { getFixPatterns, getQcStats } from "@/lib/qc";
import { revisionQuality } from "@/lib/revisionQuality";
import { RevisionQualitySummary } from "@/components/review/RevisionQualitySummary";
import { CutRow, Fold, RowHead } from "@/components/review/ReviewRoomParts";
import { etDateTime } from "@/lib/datetime";
import type { VideoDeliveryBoard } from "@/lib/videoDelivery";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Video Review Room history" };

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM'S HISTORY (Oct 19 2026). When the room was tightened
// to three sections (To review, Ready to send, With the editors), what looks
// back moved here, one quiet link from the bottom of /review, so nothing was
// lost: Approved in the last 14 days, Sent this week, Feedback follow-through
// (review notes still moving), Revision causes and Review observations, each
// exactly as the room showed it. Same door as the room: the review desk
// (owner, admin, or a seated reviewer); Sent this week is the office's.
// ---------------------------------------------------------------------------

export default async function ReviewHistoryPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  await requirePageAccess("review");
  const includeTest = (await searchParams).test === "1";
  const me = await getCurrentUser().catch(() => null);
  const { isReviewDesk } = await import("@/lib/reviewerAssignment");
  const ownerDesk = await isReviewDesk(me, { authEnforced: authEnforced() });
  // A photographer's own room is /review (their shoots' cuts); the office's history is not theirs.
  if (!ownerDesk && me?.role === "PHOTOGRAPHER") redirect("/review");
  if (!ownerDesk) redirect(homeFor(me?.role));

  // Read-only here (what was sent, by whom): the creative manager too (Oct 21 2026).
  const deliveryDesk = !me || me.role === "OWNER" || me.role === "ADMIN" || me.role === "CREATIVE_MANAGER";
  const [q, patterns, qcStats, causes, board] = await Promise.all([
    getReviewQueue({ includeTest }),
    getFixPatterns(60, { includeTest }),
    getQcStats(30, { includeTest }),
    revisionQuality(30, { includeTest }).catch(() => null),
    deliveryDesk
      ? import("@/lib/videoDelivery").then((m) => m.videoDeliveryBoard({ fresh: true })).catch((e) => {
          console.error("[video-review] history: delivery board failed", e);
          return null;
        })
      : Promise.resolve(null as VideoDeliveryBoard | null),
  ]);
  const laneMeta = {
    EDIT: { label: "Delivery fixes", icon: Pencil },
    PHOTOGRAPHER: { label: "Photographer: capture", icon: Camera },
    EDITOR: { label: "Editor: cut", icon: Clapperboard },
  } as const;
  const sent = board?.lanes.delivered ?? [];
  const back = includeTest ? "/review?test=1" : "/review";

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href={back} label="Video Review Room" />
      </div>
      <PageHeader eyebrow="Video Review Room" title="History" subtitle="Approved and sent videos, review notes still moving, and why revisions happen." />

      <div className="space-y-6 p-4 sm:p-6">
        <Section icon={CheckCircle2} title="Approved, last 14 days" count={q.recentlyApproved.length}>
          {q.recentlyApproved.length ? (
            <ul className="space-y-2.5">{q.recentlyApproved.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          ) : (
            <p className="text-sm text-muted">Nothing approved in the last 14 days.</p>
          )}
        </Section>

        {deliveryDesk && (
          <Section icon={Send} title="Sent this week" count={board ? sent.length : null}>
            {!board ? (
              <p role="alert" className="text-sm text-warning">What was sent this week could not be read just now. Refresh to try again.</p>
            ) : sent.length ? (
              <ul className="divide-y divide-border">
                {sent.map((r) => (
                  <li key={r.key} className="py-2.5 text-sm">
                    <RowHead r={{ ...r, late: false }} />
                    <p className="text-muted">Sent {r.deliveredAtISO ? `${etDateTime(r.deliveredAtISO)} ET` : ""}{r.deliveredBy ? ` by ${r.deliveredBy}` : ""}{r.late ? " · after its promised date" : ""}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No listing video was sent this week.</p>
            )}
          </Section>
        )}

        <Section icon={MessageSquare} title="Feedback follow-through" count={q.followUps.length}>
          {q.followUps.length ? (
            <>
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
                        // The cut with its notes (Sep 28); the project page only
                        // when the notes are not on a cut (photos).
                        href={followUpHref(f)}
                        // Phone layout (Jordan, Oct 28 2026): the counts wrap under the
                        // street instead of squeezing it to nothing.
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 hover:text-brand"
                      >
                        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                          <m.icon className="size-4 shrink-0 text-muted-2" />
                          <span className="truncate text-sm font-medium">{f.street}</span>
                          <span className="text-xs text-muted">{m.label}</span>
                        </div>
                        <span className="ml-auto shrink-0 text-xs">
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
            </>
          ) : (
            <p className="text-sm text-muted">No review notes are still moving.</p>
          )}
        </Section>

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
                  Photo fix reasons, last {patterns.windowDays} days
                </h3>
                {patterns.byTag.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No photos flagged for fixes.</p>
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
                  Optional QC checks not recorded, last {qcStats.windowDays} days
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
                  Capture notes by photographer, last {patterns.windowDays} days
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {patterns.captureByPhotographer.map((p) => (
                    <span key={p.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium">
                      <Camera className="size-3 text-muted-2" /> {p.name}
                      <span className="tabular-nums text-muted">{p.count}</span>
                    </span>
                  ))}
                  <Link href="/shoot/feedback" className="inline-flex min-h-9 items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium text-brand hover:bg-surface-2">
                    Photographer scoreboard →
                  </Link>
                </div>
              </div>
            )}
          </Fold>
        )}
      </div>
    </div>
  );
}
