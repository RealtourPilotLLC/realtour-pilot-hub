import Link from "next/link";
import { authEnforced } from "@/lib/auth/guards";
import { redirect } from "next/navigation";
import { ArrowRight, Camera, CheckCircle2, Hourglass, PlayCircle, RefreshCw, Sun } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ProactiveFlags } from "@/components/dashboard/ProactiveFlags";
import { StuckJobs } from "@/components/dashboard/StuckJobs";
import { WeekStrip } from "@/components/dashboard/WeekStrip";
import { PulseStrip } from "@/components/dashboard/PulseStrip";
import { QualityDials } from "@/components/dashboard/QualityDials";
import {
  getTodayCardCount, getActionCounts, getStuckJobs, getShootWindow,
  getProactiveFlags, getHandledToday, getOwnerStats, getOwnerPulse, getOwnerDials,
} from "@/lib/queries";
import { replyWaitingSummary } from "@/lib/replyQueue";
import { videoReviewBoard, type VideoCutState } from "@/lib/reviewCuts";
import { openLoopsList, OPEN_LOOPS_CAP } from "@/lib/opsDay";
import { LoopActions } from "@/components/ops/LoopActions";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier, homeFor } from "@/lib/auth/access";
import { formatMoney } from "@/lib/utils";
import { etDate, etFullDate, etTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The dashboard's ONE job: a 10-second, role-aware glance — is anything on
// fire, and one button into where the work happens (/today). It shows COUNTS;
// /today shows rows. It never renders a task list. Keep it to ~one phone
// screen with exactly one primary CTA. (The old page was ~5,000px tall with
// 154 links and no primary action — don't let it grow back.)
//
// The counts are HONEST and system-wide (audit 2026-07-08: the old chips read
// "1 replies / 0 to assign" off the brief slice while 34 tasks sat unassigned),
// and each chip deep-links to where that pile is worked.

function CountChip({ label, count, tone, href }: { label: string; count: number; tone: string; href: string }) {
  return (
    <Link
      href={href}
      className="flex min-w-[30%] flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm hover:bg-surface-2"
    >
      <span className="text-lg font-semibold tabular-nums" style={{ color: tone }}>{count}</span>
      <span className="text-muted">{label}</span>
    </Link>
  );
}

export default async function DashboardPage() {
  const me = await getCurrentUser().catch(() => null);
  // Creatives never see the ops overview (middleware already bounces the roles;
  // this covers per-user "dashboard" permission overrides). Sessionless local
  // dev renders the full owner view.
  if (me && contentTier(me.role) === "CREATIVE") redirect(homeFor(me.role));
  // A revoked account keeps a valid JWT for up to 7 days, and /: has no PAGES
  // entry so middleware only checks that the token verifies — fail closed here
  // rather than letting a null viewer read as owner (Sep 2 review).
  if (!me && authEnforced()) redirect("/login");
  const isOwner = !me || me.role === "OWNER";

  const [todayCount, counts, stuck, shoots, radar, handledToday, ownerStats, pulse, dials, unanswered, videoReview, openLoops] = await Promise.all([
    getTodayCardCount(), // = the card count /today renders, so the button never lies
    getActionCounts(),
    getStuckJobs(),
    getShootWindow(),
    getProactiveFlags(),
    getHandledToday(),
    isOwner ? getOwnerStats() : Promise.resolve(null),
    isOwner ? getOwnerPulse() : Promise.resolve(null),
    // Owner-only quality dials (video-SLA roll-up + QC health) — same gate.
    isOwner ? getOwnerDials() : Promise.resolve(null),
    // Inbound texts still owed an answer, counted off the comms log rather than
    // off reply tasks — so the ones from senders we never matched to a client
    // (new leads, an assistant, an unsaved number) are included. They're the
    // ones that go unanswered, and no task ever existed to represent them.
    replyWaitingSummary(),
    // Every uploaded cut waiting on a verdict or back with its editor — the same
    // list Ops Day's Video Review block renders (Jordan, Sep 1: "I'd like the
    // same on my dashboard"). Owner AND admin both review now.
    videoReviewBoard().catch(() => ({ waiting: [] as VideoCutState[], revising: [] as VideoCutState[] })),
    // Open loops with View + Handled — Jordan (Sep 1): "I'd like to be able to
    // close things out on the dashboard." The one deliberate exception to this
    // page's counts-only rule.
    openLoopsList().catch(() => []),
  ]);
  const cutsToReview = videoReview.waiting.length;
  const cutsRevising = videoReview.revising.length;

  const firstName = me?.name?.split(" ")[0] ?? (isOwner ? "Jordan" : "there");
  // All clear = nothing to work, nothing stuck, nothing shooting today, and
  // nobody left hanging on a text. That last clause matters: unanswered texts
  // are counted from the comms log, so a message from someone we never matched
  // to a client contributes no task and no todayCount — without it the page
  // could tell you you're clear while seven people wait on a reply. The pulse +
  // money strips still render below; trends matter on quiet days too.
  // An OVERDUE follow-up blocks the clear banner the same way an unanswered
  // text does — otherwise "You're clear" renders directly above a red
  // "overdue" callback (review).
  const allClear =
    todayCount === 0 && stuck.length === 0 && shoots.today.length === 0 && unanswered.count === 0 && cutsToReview === 0 &&
    !openLoops.some((l) => l.overdue);
  const nextShoot = shoots.week[0] ?? null;

  return (
    <div>
      <PageHeader eyebrow="Eastern time" title="Dashboard" subtitle={etFullDate(new Date())} />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {/* 1 · Orientation */}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand"><Sun className="size-5" /></span>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Good morning, {firstName}</h2>
            <p className="text-xs text-muted">{handledToday} thing{handledToday === 1 ? "" : "s"} handled today</p>
          </div>
        </div>

        {allClear ? (
          /* All clear — one calm card instead of five empty sections. */
          <div className="panel-shadow rounded-2xl border border-border bg-surface p-6 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" />
            <p className="mt-2 text-sm font-semibold">You&apos;re clear — {handledToday} handled today.</p>
            <p className="mt-1 text-xs text-muted">
              Next shoot: {nextShoot ? `${etDate(nextShoot.shootDate)} ${etTime(nextShoot.shootDate)} — ${nextShoot.title.split(",")[0]} · ${nextShoot.photographer?.name ?? "unassigned"}` : "none scheduled"}
            </p>
          </div>
        ) : (
          <>
            {/* 2 · THE button — the page's single primary action. Its number is
                the exact card count /today renders (shared query logic). */}
            <Link
              href="/tasks?tab=today"
              className="flex w-full items-center justify-between rounded-2xl bg-brand px-5 py-4 text-white shadow-lg transition-opacity hover:opacity-90"
            >
              <span className="text-base font-semibold">Start your day</span>
              <span className="flex items-center gap-2 text-sm font-medium opacity-90">
                {todayCount} thing{todayCount === 1 ? "" : "s"} need you <ArrowRight className="size-4" />
              </span>
            </Link>
            {/* Guided variant: same stack, one card at a time */}
            <Link href="/tasks?tab=today&guided=1" className="-mt-2 block px-1 text-xs font-medium text-muted hover:text-foreground">
              or walk me through it one at a time →
            </Link>

            {/* 3 · The numbers without the walls — system-wide truth, each one a
                deep link into the surface where that pile gets worked. The amber
                "to assign" chip only exists while something actually needs an
                owner (routine work defaults to Kyle and isn't triage). */}
            <div className="flex flex-wrap gap-2">
              {/* Unanswered TEXTS — counted off the comms log, so it sees the
                  messages no task was ever made for. Distinct from "message
                  to-dos" beside it, which counts open SmartTasks of every
                  message kind (replies, instructions, leads, vendor chases).
                  Goes red once someone has waited a full day. */}
              {unanswered.count > 0 && (
                <CountChip
                  label={unanswered.oldestHours >= 24 ? `unanswered · oldest ${Math.round(unanswered.oldestHours / 24)}d` : "texts unanswered"}
                  count={unanswered.count}
                  tone={unanswered.oldestHours >= 24 ? "var(--danger)" : "#38bdf8"}
                  href="/communications?tab=replies"
                />
              )}
              <CountChip label="message to-dos" count={counts.replies} tone="#38bdf8" href="/tasks" />
              <CountChip label="in QC" count={counts.qc} tone="#a78bfa" href="/tasks?tab=board" />
              <CountChip label="running late" count={counts.late} tone="var(--danger)" href="/tasks?tab=other" />
              {counts.toAssign > 0 && (
                <CountChip label="to assign" count={counts.toAssign} tone="var(--warning)" href="/tasks?tab=board&who=needs-assigning" />
              )}
            </div>

            {/* 4 · Stuck jobs — PROJECT-level fires (late vs promise, stale
                revision, shot-but-undelivered), not overdue admin tasks. */}
            <StuckJobs jobs={stuck} />

            {/* 5 · Today's schedule (rendered once — the only shoots list here),
                with the week ahead as a per-day strip instead of a one-liner. */}
            <div className="panel-shadow rounded-2xl border border-border bg-surface">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <Camera className="size-3.5" /> Today&apos;s shoots
                <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{shoots.today.length}</span>
              </div>
              {shoots.today.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-2">No shoots today.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {shoots.today.slice(0, 4).map((s) => (
                    <Link key={s.apptId} href={`/shoot/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-surface-2">
                      <span className="min-w-0 truncate">{s.title.split(",")[0]}</span>
                      <span className="shrink-0 text-xs text-muted">{etTime(s.shootDate)} · {s.photographer?.name ?? "Unassigned"}</span>
                    </Link>
                  ))}
                </div>
              )}
              <WeekStrip week={shoots.week} />
            </div>
          </>
        )}

        {/* Videos — waiting on a verdict vs. back with an editor — the two
            numbers Jordan asked for, with the oldest cuts listed so the stale
            one is visible without opening the room. Outside the all-clear
            branch so "in revisions" stays visible on a quiet day. */}
        {(cutsToReview > 0 || cutsRevising > 0) && (
          <VideoReviewCard waiting={videoReview.waiting} revising={videoReview.revising} />
        )}

        {/* Open loops — follow-ups / instructions / callbacks still owed, each
            closable right here. Outside the all-clear branch on purpose: these
            are what "clear" is waiting on. */}
        {openLoops.length > 0 && (
          <section className="panel-shadow rounded-2xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <RefreshCw className="size-3.5" /> Open loops
              <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{openLoops.length}{openLoops.length >= OPEN_LOOPS_CAP ? "+" : ""}</span>
              <Link href="/ops#loops" className="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted-2 hover:text-foreground">
                All on Ops Day →
              </Link>
            </div>
            <div className="divide-y divide-border/60">
              {openLoops.slice(0, 8).map((l) => (
                <div key={l.taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm leading-snug">{l.title}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {l.projectTitle ?? loopKind(l.kind)}
                      {l.dueISO ? ` · ${l.overdue ? `overdue since ${etDate(new Date(l.dueISO))}` : `due ${etDate(new Date(l.dueISO))}`}` : ""}
                    </p>
                  </div>
                  {l.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
                  <LoopActions taskId={l.taskId} viewHref={l.projectId ? `/projects/${l.projectId}` : `/tasks?tab=other&task=${l.taskId}`} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 6 · Radar — fresh risk only (≤3; creatives never reach this page) */}
        {radar.flags.length > 0 && <ProactiveFlags flags={radar.flags} />}

        {/* 7 · Money strip — owner only */}
        {isOwner && ownerStats && (
          <Link href="/sales" className="panel-shadow flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-border bg-surface px-5 py-3.5 text-sm hover:bg-surface-2">
            <span><span className="text-muted">Delivered this month</span> <b>{formatMoney(ownerStats.revenueThisMonth)}</b> <span className="text-muted-2">({ownerStats.deliveredThisMonth})</span></span>
            <span><span className="text-muted">Pipeline</span> <b>{formatMoney(ownerStats.pipelineRevenue)}</b> <span className="text-muted-2">({ownerStats.activeCount} active)</span></span>
            {radar.topAr && <span><span className="text-muted">Top AR</span> <b>{radar.topAr.name} {formatMoney(radar.topAr.total)}</b></span>}
            <ArrowRight className="ml-auto size-4 text-muted-2" />
          </Link>
        )}

        {/* 8 · Owner pulse — health trends (30d vs prior 30d). Owner-only, and
            deliberately OUTSIDE the all-clear branch: quiet days still show
            whether the machine is speeding up or slipping. */}
        {isOwner && pulse && <PulseStrip pulse={pulse} />}

        {/* 9 · Quality dials — the two already-built Phase-2/3 helpers surfaced:
            a compact video-SLA roll-up (links to the Editor Queue; NOT a re-list
            of the stuck jobs above) + the QC quality dial. Owner-only, same gate
            as the pulse. Self-hides when there's no video in flight AND no QC
            history yet (fresh install), and guards the QC empty state so a new
            DB never shows a misleading 0%. */}
        {isOwner && dials && <QualityDials dials={dials} />}

        {/* Quiet secondary links — everything else lives in the sidebar. (The
            old footer also repeated the chip numbers in grey; deleted — the
            same number twice on one screen is how dashboards start lying.) */}
        <div className="flex flex-wrap items-center gap-4 px-1 text-xs text-muted-2">
          <Link href="/tasks?tab=board" className="hover:text-foreground">Full task board</Link>
          <Link href="/pipeline" className="hover:text-foreground">Project tracker</Link>
        </div>
      </div>
    </div>
  );
}

function loopKind(kind: string): string {
  return kind === "comms_followup" ? "Follow-up"
    : kind === "internal_instruction" ? "Instruction"
    : kind === "callback" ? "Callback"
    : kind === "client_reply" ? "Reply owed"
    : "Follow-up";
}

function ageShort(iso: string): string {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Two counts, one card: "waiting on review" is the owner's queue; "in revisions"
// is what's back with the editors. The three oldest of each are listed so a
// cut that has sat for days is visible without opening the room.
function VideoReviewCard({ waiting, revising }: { waiting: VideoCutState[]; revising: VideoCutState[] }) {
  const rows = [...waiting.slice(0, 3), ...revising.slice(0, 3)];
  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="grid grid-cols-2 divide-x divide-border">
        <Link href="/review" className="rounded-tl-2xl px-4 py-3 transition-colors hover:bg-surface-2/60">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><PlayCircle className="size-3.5 text-brand" /> Videos waiting on review</p>
          <p className={`mt-0.5 text-xl font-semibold tabular-nums ${waiting.length > 0 ? "text-brand" : ""}`}>{waiting.length}</p>
        </Link>
        <Link href="/review" className="rounded-tr-2xl px-4 py-3 transition-colors hover:bg-surface-2/60">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><Hourglass className="size-3.5 text-warning" /> Videos in revisions</p>
          <p className={`mt-0.5 text-xl font-semibold tabular-nums ${revising.length > 0 ? "text-warning" : ""}`}>{revising.length}</p>
        </Link>
      </div>
      {rows.length > 0 && (
        <div className="divide-y divide-border/60 border-t border-border">
          {rows.map((c) => (
            <Link
              key={c.submissionId}
              href={c.status === "PENDING" ? `/review/${c.projectId}?cut=${c.submissionId}` : `/edit/${c.projectId}?cut=${c.submissionId}`}
              className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-surface-2/60"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{c.street}</span>
                <span className="text-muted"> · {c.cutLabel}</span>
              </span>
              {c.round > 1 && <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">v{c.round}</span>}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.status === "PENDING" ? "bg-brand/15 text-brand" : "bg-warning/15 text-warning"}`}>
                {c.status === "PENDING" ? "review" : "in revisions"}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-2">{ageShort(c.sinceISO)}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
