import Link from "next/link";
import type { Prisma } from "@prisma/client";
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
  MESSAGE_TASK_TYPES, getStuckJobs, getShootWindow,
  getProactiveFlags, getHandledToday, getOwnerStats, getOwnerPulse, getOwnerDials,
} from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import { recentProjectWhere } from "@/lib/recency";
import { boardVisibleWhere, isNeedsAssigning } from "@/lib/triage";
import { clientTextWhere } from "@/lib/clientTexts";
import { unansweredCommsBoard } from "@/lib/commsBoard";
import { replyWaitingSummary } from "@/lib/replyQueue";
import { videoReviewBoard, type VideoCutState } from "@/lib/reviewCuts";
import { openLoopsList, OPEN_LOOPS_CAP } from "@/lib/opsDay";
import { LoopActions } from "@/components/ops/LoopActions";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier, homeFor } from "@/lib/auth/access";
import { formatMoney } from "@/lib/utils";
import { etDate, etDayStartUtc, etFullDate, etTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The dashboard's ONE job: a 10-second, role-aware glance — is anything on
// fire, and one button into where the work happens. It shows COUNTS; the
// surfaces it links to show rows. It never renders a task list. Keep it to
// ~one phone screen with exactly one primary CTA. (The old page was ~5,000px
// tall with 154 links and no primary action — don't let it grow back.)

// ---------------------------------------------------------------------------
// THE RULE FOR EVERY NUMBER ON THIS PAGE (audit fault #9, Sep 2 2026):
// a count is computed with THE QUERY OF THE LIST IT LINKS TO. Anything else is
// a number the owner can't trust, and it doesn't ship.
//
// What that replaced, measured against live data the morning it was written:
//   "39 things need you" → /tasks?tab=today — a tab that no longer exists. The
//      hub rewrites ?tab=today to Comms, which rendered ONE sender group.
//   "in QC 19"           → /tasks?tab=board (the Other tab), which HIDES
//      media_qa and delivery_text: 0 of the 19 were on it.
//   "running late 36"    → the same tab, which showed 7 overdue rows.
//   "message to-dos 18"  → the Comms checklist, which renders the senders still
//      waiting, not the silent SmartTasks that chip counted.
//   "walk me through it" → the guided /today walkthrough, deleted Aug 31.
// Only "to assign" pointed at a list that contained it, and it stays.
//
// The one number deliberately DELETED rather than corrected is the aggregate on
// the button. The Tasks hub's work tabs share rows — on the day of the fix, 4 of
// the 5 unassigned Slack to-dos were counted by BOTH the Slack tab and the Other
// tab's "Needs assigning" pile — so no single total can equal the page it opens.
// The hub's own tab bar is the breakdown; the button is now just the door.
// ---------------------------------------------------------------------------

// The Tasks hub's "Other" tab, exactly as BoardView builds it for a non-editor
// (`boardWhere` in src/components/tasks/BoardView.tsx). Editors are redirected
// off this page, so there is no editor scope to mirror.
// TODO(cross-file): `boardWhere` belongs beside `boardVisibleWhere` in
// src/lib/triage.ts so this can be imported instead of restated. Until it is,
// any change there must be mirrored here or the chips start lying again.
const BOARD_ACTIVE = [
  "OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED",
];
function otherTabWhere(): Prisma.SmartTaskWhereInput {
  return {
    status: { in: BOARD_ACTIVE },
    AND: [
      boardVisibleWhere(),
      { OR: [{ projectId: null }, { project: recentProjectWhere() }, { taskType: { in: MESSAGE_TASK_TYPES } }] },
    ],
  };
}

// The Review Room's "Photo sets in QC" list, exactly as getReviewQueue reads it
// (src/lib/reviewRoom.ts): open media_qa cards on a job that isn't cancelled or
// on hold. That section renders one row per card under a count badge, so the
// chip and the list are the same number by construction.
//
// Ops Day was the other candidate and was REJECTED on the evidence: it splits
// the same 8 cards across three separate blocks (#qc-am "due today" = 2, the
// Overdue block, and Monthly), so no anchor there holds the whole pile — a chip
// reading 8 would have landed on a list of 2. Same fault, new coat of paint.
function photoQcWhere(): Prisma.SmartTaskWhereInput {
  return {
    taskType: "media_qa",
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    OR: [{ projectId: null }, { project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } } }],
  };
}

// Every chip's number, each one the destination's own query.
async function dashboardNumbers() {
  const [board, qc, textsToSend, emailsWaiting] = await Promise.all([
    // The Other tab's rows themselves (a dozen or so) — "running late" and
    // "to assign" are then counted off that set with the tab's OWN arithmetic,
    // so a chip can never disagree with the header it lands on.
    prisma.smartTask.findMany({
      where: otherTabWhere(),
      select: { assignedKey: true, taskType: true, dueAt: true },
    }),
    prisma.smartTask.count({ where: photoQcWhere() }),
    // The comms Outbox lists exactly clientTextWhere() (ClientTextsPanel), and
    // its tab badge is this same count.
    prisma.smartTask.count({ where: clientTextWhere() }),
    // The Comms tab's Email sub-tab renders one card per sender-group; its own
    // "Email N" pill is this number.
    unansweredCommsBoard("email").then((g) => g.length).catch(() => 0),
  ]);
  // BoardView's overdue rule verbatim: due before the START of today in ET, so
  // something due later today is not "late".
  const startToday = etDayStartUtc(new Date()).getTime();
  return {
    boardOpen: board.length,
    late: board.filter((t) => t.dueAt !== null && t.dueAt.getTime() < startToday).length,
    toAssign: board.filter(isNeedsAssigning).length,
    qc,
    textsToSend,
    emailsWaiting,
  };
}

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

  const [counts, stuck, shoots, radar, handledToday, ownerStats, pulse, dials, unanswered, videoReview, openLoops] = await Promise.all([
    dashboardNumbers(), // every chip = the query of the list it links to
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
  // All clear = EVERY chip on this page is zero, plus nothing stuck, nothing
  // shooting today, and nobody left hanging on a text. Built off the chip
  // numbers themselves so the banner can't contradict the row beneath it: the
  // old rule keyed on one /today count and could read "You're clear" with QC
  // cards open and a dozen texts still to send. (`late`/`toAssign` are subsets
  // of `boardOpen`, so that one covers them.)
  // Unanswered texts are counted from the comms log, so a message from someone
  // we never matched to a client — which produces no task at all — still blocks
  // the banner. An OVERDUE follow-up blocks it too, otherwise "You're clear"
  // renders directly above a red "overdue" callback (review).
  const allClear =
    counts.boardOpen === 0 && counts.qc === 0 && counts.textsToSend === 0 && counts.emailsWaiting === 0 &&
    stuck.length === 0 && shoots.today.length === 0 && unanswered.count === 0 && cutsToReview === 0 &&
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
            {/* 2 · THE button — the page's single primary action, and now just
                a door. It carries no total: the Tasks hub's tabs share rows
                (a Slack to-do with no owner is on BOTH the Slack tab and the
                Other tab's "Needs assigning" pile), so any sum would count
                real work twice. The hub's tab bar is the honest breakdown, and
                the chips below carry the numbers that matter here. */}
            <Link
              href="/tasks"
              className="flex w-full items-center justify-between rounded-2xl bg-brand px-5 py-4 text-white shadow-lg transition-opacity hover:opacity-90"
            >
              <span className="text-base font-semibold">Start your day</span>
              <span className="flex items-center gap-2 text-sm font-medium opacity-90">
                Your tasks <ArrowRight className="size-4" />
              </span>
            </Link>

            {/* 3 · The numbers. Each one is its destination's own count — open
                the chip and the list has exactly that many rows in it. The
                three conditional chips only exist while their pile is non-empty
                ("to assign" in particular: routine work defaults to Kyle and
                isn't triage). "in QC" and "running late" always render, because
                a zero there is information too. */}
            <div className="flex flex-wrap gap-2">
              {/* Unanswered TEXTS — counted off the comms log, so it sees the
                  messages no task was ever made for (a new lead, an assistant,
                  an unsaved number). /communications?tab=replies is built on
                  that same scan and its header prints the same number. Goes red
                  once someone has waited a full day. */}
              {unanswered.count > 0 && (
                <CountChip
                  label={unanswered.oldestHours >= 24 ? `unanswered · oldest ${Math.round(unanswered.oldestHours / 24)}d` : "texts unanswered"}
                  count={unanswered.count}
                  tone={unanswered.oldestHours >= 24 ? "var(--danger)" : "#38bdf8"}
                  href="/communications?tab=replies"
                />
              )}
              {/* Email had no chip at all; the "message to-dos" chip that stood
                  here counted silent SmartTasks nothing renders. This is the
                  Comms tab's Email sub-tab, sender for sender. */}
              {counts.emailsWaiting > 0 && (
                <CountChip label="emails waiting" count={counts.emailsWaiting} tone="#38bdf8" href="/tasks?tab=comms&via=email" />
              )}
              {/* QC never appears on the task board — it hides media_qa
                  outright, which is why this chip used to open a tab with none
                  of it. The Review Room's "Photo sets in QC" section is the one
                  list that holds the whole pile. */}
              <CountChip label="in QC" count={counts.qc} tone="#a78bfa" href="/review" />
              {/* The delivery/confirmation texts that used to be folded into the
                  QC number (11 of the old 19) — they aren't QC, they're drafts
                  sitting in the comms Outbox. */}
              {counts.textsToSend > 0 && (
                <CountChip label="texts to send" count={counts.textsToSend} tone="#22c55e" href="/communications?tab=outbox" />
              )}
              {/* Overdue ON THE TASK BOARD. Deliberately not "everything late
                  in the business": QC lateness lives in the chip above, late
                  client texts in the Outbox chip, and late JOBS in Stuck jobs
                  below. One alarm per list, each one true. */}
              <CountChip label="running late" count={counts.late} tone="var(--danger)" href="/tasks?tab=other" />
              {counts.toAssign > 0 && (
                <CountChip label="to assign" count={counts.toAssign} tone="var(--warning)" href="/tasks?tab=other&who=needs-assigning" />
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
                /* Every shoot, not the first four: the badge above prints
                   shoots.today.length, and a badge of 5 over a list of 4 is the
                   same fault as the chips (audit fault #9). A day's shoot list
                   is short by nature. */
                <div className="divide-y divide-border/60">
                  {shoots.today.map((s) => (
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
            {/* The badge counts the whole pile; only the eight oldest are
                closable here. Say so, rather than letting "21" sit over eight
                rows (audit fault #9 — same class as the chips). */}
            {openLoops.length > 8 && (
              <Link
                href="/ops#loops"
                className="block border-t border-border px-4 py-2 text-[11px] font-medium text-muted-2 hover:text-foreground"
              >
                {openLoops.length - 8} more{openLoops.length >= OPEN_LOOPS_CAP ? "+" : ""} on Ops Day →
              </Link>
            )}
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
          {/* "Full task board" pointed at the Other tab, which is not full —
              it hides QC, comms, edits and the auto-texts. The hub with its
              tab bar is the honest name for that link. */}
          <Link href="/tasks" className="hover:text-foreground">All tasks</Link>
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
