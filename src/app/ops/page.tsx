import Link from "next/link";
import {
  AlarmClock, AlertTriangle, ArrowRight, Camera, CheckCircle2, ClipboardCheck, Clapperboard, Clock,
  CloudSun, Coffee, ExternalLink, Hourglass, ListChecks, MessageSquare, Moon, Plane, PlayCircle,
  RefreshCw, Route, Sunrise, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { buildOpsDay, OPEN_LOOPS_CAP, type OpsDay, type OpsShoot, type OpsQcRow } from "@/lib/opsDay";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { QcComplete } from "@/components/ops/QcComplete";
import { LoopActions } from "@/components/ops/LoopActions";
import type { VideoCutState } from "@/lib/reviewCuts";
import { cn } from "@/lib/utils";
import { aryeoListingUrl } from "@/lib/aryeoUrl";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Kyle's Ops Day — Jordan's "Daily Operations & Client Experience Structure"
// as a guided screen (v2: parsed, glanceable shoot cards with weather /
// airspace / comms; QC grouped Overdue · Due today · Waiting with evidence,
// Dropbox state and Aryeo links; the pipeline says what's holding things up).
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etMinutes(d: Date): number {
  const [h, m] = d
    .toLocaleTimeString("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":")
    .map(Number);
  return h * 60 + m;
}
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
// "Tue 9:00 AM" — a turnaround promise needs the hour, not just the day.
const fmtDayTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" });
// "3h" / "2 days" — how long something has sat, in the unit a person would use.
function ageText(iso: string, now: Date): string {
  const h = Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
function loopKind(kind: string): string {
  return kind === "comms_followup" ? "Follow-up"
    : kind === "internal_instruction" ? "Instruction"
    : kind === "callback" ? "Callback"
    : kind === "client_reply" ? "Reply owed"
    : "Follow-up";
}

type BlockDef = { key: string; from: number; to: number; time: string; title: string; short: string; icon: LucideIcon; goal: string };
const BLOCKS: BlockDef[] = [
  { key: "tower", from: 9 * 60, to: 9 * 60 + 30, time: "9:00 – 9:30", title: "Morning Control Tower", short: "Tower", icon: Sunrise, goal: "Know what's happening today, what needs attention, and what could go wrong — before the day gets moving." },
  { key: "qc-am", from: 9 * 60 + 30, to: 10 * 60 + 15, time: "9:30 – 10:15", title: "QC + Morning Deliveries", short: "QC", icon: ClipboardCheck, goal: "Catch mistakes before the client does; get finished work delivered early. Only what's due today lives here — the backlog has its own card." },
  { key: "overdue", from: 10 * 60 + 15, to: 10 * 60 + 30, time: "10:15 – 10:30", title: "Overdue Check", short: "Overdue", icon: AlarmClock, goal: "Everything past its promised date gets a decision today: chase it, close it, or tell the client. Nothing sits late in silence." },
  { key: "comms-1", from: 10 * 60 + 30, to: 11 * 60, time: "10:30 – 11:00", title: "Client Communication Sweep #1", short: "Comms 1", icon: MessageSquare, goal: "Nobody waits wondering if we got their message." },
  { key: "prep", from: 11 * 60, to: 11 * 60 + 30, time: "11:00 – 11:30", title: "Tomorrow + Upcoming Prep", short: "Tomorrow", icon: Route, goal: "Tomorrow is operationally ready before today ends — problems get solved the day before, not 30 minutes before the shoot." },
  { key: "loops", from: 11 * 60 + 30, to: 12 * 60, time: "11:30 – 12:00", title: "Open Loops + Follow-Ups", short: "Loops", icon: RefreshCw, goal: "Nothing stays stuck because someone forgot to follow up. Ask: what am I waiting on that could become a problem?" },
  { key: "lunch", from: 12 * 60, to: 13 * 60, time: "12:00 – 1:00", title: "Lunch", short: "Lunch", icon: Coffee, goal: "Protected — unless there's a genuine operational or client emergency." },
  // Video Review (Jordan, Sep 1): "a card for videos in revision and videos
  // waiting on review." Every uploaded cut gets a verdict here; the pipeline
  // check moves to 1:30 so nothing overlaps.
  { key: "video-review", from: 13 * 60, to: 13 * 60 + 30, time: "1:00 – 1:30", title: "Video Review", short: "Video", icon: PlayCircle, goal: "Every cut the editors uploaded gets a verdict today — approve it, or send it back with notes. Cuts in revisions stay listed until the next version lands." },
  { key: "pipeline", from: 13 * 60 + 30, to: 14 * 60, time: "1:30 – 2:00", title: "Production Pipeline Check", short: "Pipeline", icon: ListChecks, goal: "Know the status of every active project — and exactly what's holding each one up — before the client asks." },
  { key: "comms-2", from: 14 * 60, to: 14 * 60 + 30, time: "2:00 – 2:30", title: "Client Communication Sweep #2", short: "Comms 2", icon: MessageSquare, goal: "Proactive, not reactive — if something changed, the client hears it from us first." },
  { key: "systems", from: 14 * 60 + 30, to: 15 * 60 + 10, time: "2:30 – 3:10", title: "Systems + Admin Work", short: "Admin", icon: Wrench, goal: "Keep the backend organized — without letting admin work interfere with active client needs." },
  { key: "monthly", from: 15 * 60 + 10, to: 15 * 60 + 30, time: "3:10 – 3:30", title: "Monthly Content Check", short: "Monthly", icon: Clapperboard, goal: "Personal-branding retainers run on their own rhythm — a batch of videos on a 7–10 business-day window, delivered as a set. Never mixed into listing QC." },
  // "Final QC + Deliveries" (4:15-5:00) was dropped Sep 1 — Jordan: it duplicated
  // the morning QC + Deliveries block and the Production Pipeline Check. Its
  // slot folds into Next-Day Finalization so the timeline has no dead gap
  // (currentKey falls back to the LAST block inside a gap, which would have
  // lit up Daily Closeout at 4:15).
  { key: "final-prep", from: 15 * 60 + 30, to: 17 * 60, time: "3:30 – 5:00", title: "Next-Day Finalization", short: "Finalize", icon: Route, goal: "By the end of this block, tomorrow is locked in and ready to go." },
  { key: "comms-3", from: 17 * 60, to: 17 * 60 + 30, time: "5:00 – 5:30", title: "Client Communication Sweep #3", short: "Comms 3", icon: MessageSquare, goal: "Don't carry simple client questions into the next business day." },
  { key: "closeout", from: 17 * 60 + 30, to: 18 * 60, time: "5:30 – 6:00", title: "Daily Closeout", short: "Closeout", icon: Moon, goal: "Review the whole operation before ending the day — escalate anything that needs Jordan." },
];

export default async function OpsDayPage() {
  await requirePageAccess("ops");
  const d = await buildOpsDay();
  const nowMin = etMinutes(new Date(d.nowISO));
  const currentKey =
    BLOCKS.find((b) => nowMin >= b.from && nowMin < b.to)?.key ??
    (nowMin < BLOCKS[0].from ? BLOCKS[0].key : BLOCKS[BLOCKS.length - 1].key);

  return (
    <div>
      <AutoRefresh />
      <PageHeader
        eyebrow="Operations + Client Experience"
        title="Ops Day"
        subtitle="Nothing surprises the client · nothing gets missed · problems die before they're client-facing"
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">

        {/* Five numbers, one per card below — "QC open" used to fold the
            overdue backlog and the monthly batches into one figure, so the
            headline never matched any list Kyle could open (Jordan, Sep 1). */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Shoots today" value={String(d.todayShoots.length)} warn={false} href="#tower" />
          <Stat label="Unanswered clients" value={String(d.unanswered.count)} warn={d.unanswered.count > 0} href="#comms-1" />
          <Stat label="QC due today" value={String(listingQc(d).filter((q) => q.bucket === "today").length)} warn={false} href="#qc-am" />
          {/* Listing jobs only — the number must equal the list it links to.
              Late monthly batches are counted on the Monthly Content card. */}
          <Stat
            label="Overdue"
            value={String(listingQc(d).filter((q) => q.bucket === "overdue").length)}
            warn={listingQc(d).some((q) => q.bucket === "overdue")}
            href="#overdue"
          />
          <Stat label="Videos to review" value={String(d.videoReview.waiting.length)} warn={d.videoReview.waiting.length > 0} href="#video-review" />
          <Stat label="Tomorrow gaps" value={String(d.closeout.tomorrowGaps)} warn={d.closeout.tomorrowGaps > 0} href="#prep" />
        </div>

        {/* Jump bar — the day at a glance, with what's waiting in each block.
            (Not sticky: the page header already is, and two sticky bars fought
            for the same 60px.) */}
        <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-1 sm:-mx-6 sm:flex-wrap sm:px-6 [&::-webkit-scrollbar]:hidden" aria-label="Blocks">
          {BLOCKS.map((b) => {
            const n = countFor(b.key, d);
            const cur = b.key === currentKey;
            return (
              <a
                key={b.key}
                href={`#${b.key}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  cur ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <span className="tabular-nums opacity-70">{b.time.split(" – ")[0]}</span>
                {b.short}
                {n != null && n > 0 && (
                  <span className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums", cur ? "bg-white/20" : "bg-surface-2 text-foreground")}>{n}{plusFor(b.key, n)}</span>
                )}
              </a>
            );
          })}
        </nav>

        {BLOCKS.map((b) => (
          <Block key={b.key} def={b} current={b.key === currentKey} d={d} />
        ))}

        <section className="rounded-2xl border bg-surface p-5">
          <h2 className="text-sm font-semibold">Priority order — the inbox is not the task list</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            1. Active client issue happening right now · 2. Today&rsquo;s shoot · 3. Today&rsquo;s delivery ·
            4. Tomorrow&rsquo;s shoot · 5. Overdue project or revision · 6. Client communication ·
            7. Production follow-up · 8. Routine admin · 9. Long-term internal projects
          </p>
          <h2 className="mt-4 text-sm font-semibold">Escalate exceptions, not routine</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Jordan doesn&rsquo;t need &ldquo;a project was delivered.&rdquo; Bring him in when: a client is seriously unhappy,
            wants something outside scope or against policy, an important relationship is at risk, a major
            production mistake happened, tomorrow can&rsquo;t be staffed, or the decision is above your authority.
            Everything else — handle it.
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, warn, href }: { label: string; value: string; warn: boolean; href?: string }) {
  const body = (
    <>
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", warn && "text-warning")}>{value}</div>
    </>
  );
  const className = "panel-shadow block rounded-2xl border bg-surface px-4 py-3";
  return href ? (
    <a href={href} className={cn(className, "transition-colors hover:bg-surface-2/60")}>{body}</a>
  ) : (
    <div className={className}>{body}</div>
  );
}

// "120+" when a capped list is full — never present a truncated count as exact.
const plusFor = (key: string, n: number) => (key === "loops" && n >= OPEN_LOOPS_CAP ? "+" : "");

// What each block has waiting — the number on its header and jump-bar chip.
// null = the block is guidance, not a list (lunch, admin, closeout).
function countFor(key: string, d: OpsDay): number | null {
  switch (key) {
    case "tower": return d.todayShoots.length;
    case "qc-am": return listingQc(d).filter((q) => q.bucket === "today").length;
    case "overdue": return listingQc(d).filter((q) => q.bucket === "overdue").length;
    case "comms-1": case "comms-2": case "comms-3": return d.unanswered.count;
    case "prep": case "final-prep": return d.tomorrowShoots.length;
    case "loops": return d.openLoops.length;
    case "video-review": return d.videoReview.waiting.length + d.videoReview.revising.length;
    case "pipeline": return d.pipeline.rows.length;
    case "monthly": return d.qc.filter((q) => q.monthly).length;
    default: return null;
  }
}

function Block({ def, current, d }: { def: BlockDef; current: boolean; d: OpsDay }) {
  const Icon = def.icon;
  const n = countFor(def.key, d);
  // scroll-mt clears the sticky PageHeader (~104px with a one-line subtitle,
  // ~124px when it wraps on a phone) so a jump never tucks the block's title
  // under the header (review).
  return (
    <section id={def.key} className={cn("panel-shadow scroll-mt-32 rounded-2xl border bg-surface md:scroll-mt-28", current && "border-brand/50 ring-1 ring-brand/30")}>
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", current ? "bg-brand text-white" : "bg-surface-2 text-muted")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold">{def.title}</h2>
            {current && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">Now</span>}
          </div>
          <p className="text-xs text-muted-2"><Clock className="mr-1 inline size-3 -translate-y-px" />{def.time}</p>
        </div>
        {n != null && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
              n > 0 ? "bg-surface-2 text-foreground" : "bg-success/10 text-success",
            )}
            title={n > 0 ? `${n} in this block` : "Nothing waiting in this block"}
          >
            {n > 0 ? `${n}${plusFor(def.key, n)}` : "clear"}
          </span>
        )}
      </div>
      <div className="px-5 py-3.5">
        <p className="text-[13px] italic leading-relaxed text-muted">{def.goal}</p>
        <div className="mt-3">
          <BlockBody blockKey={def.key} d={d} />
        </div>
      </div>
    </section>
  );
}

function BlockBody({ blockKey, d }: { blockKey: string; d: OpsDay }) {
  switch (blockKey) {
    case "tower":
      return (
        <div className="space-y-3">
          <ShootList shoots={d.todayShoots} empty="No shoots on today's calendar." showDebrief />
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Pill warn={d.unanswered.count > 0} label={`${d.unanswered.count} unanswered client${d.unanswered.count === 1 ? "" : "s"}`} href="/tasks?tab=comms" />
            <Pill warn={d.pipeline.overdueTasks > 0} label={`${d.pipeline.overdueTasks} overdue task${d.pipeline.overdueTasks === 1 ? "" : "s"}`} href="/tasks?tab=other" />
            <Pill warn={false} label={`${d.pipeline.dueTodayTasks} due today`} href="/tasks?tab=other" />
            <Pill warn={d.pipeline.revision > 0} label={`${d.pipeline.revision} open revision${d.pipeline.revision === 1 ? "" : "s"}`} href="/tasks?tab=revisions" />
            <Pill warn={d.needsAssigning > 0} label={`${d.needsAssigning} need assigning`} href="/tasks?tab=slack" />
          </div>
        </div>
      );

    case "qc-am":
      return <QcDueToday d={d} />;

    case "overdue":
      return <OverdueCard d={d} />;

    case "monthly":
      return <MonthlyCard d={d} />;

    case "comms-1":
    case "comms-2":
    case "comms-3":
      return (
        <div className="space-y-2">
          {d.unanswered.count === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> Every client message has an answer.</p>
          ) : (
            <>
              {d.unanswered.preview.map((u, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-2 text-sm">
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold">{u.name}</span>
                    <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", u.hours >= 24 ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {u.hours}h</span>
                    <span className="block truncate text-[13px] text-muted">&ldquo;{u.snippet}&rdquo;</span>
                  </p>
                  <Link href="/communications?tab=replies" className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground">Reply</Link>
                </div>
              ))}
              <Link href="/tasks?tab=comms" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                Clear the queue — {d.unanswered.count} waiting <ArrowRight className="size-4" />
              </Link>
            </>
          )}
        </div>
      );

    case "prep":
    case "final-prep":
      return (
        <div className="space-y-3">
          <ShootList shoots={d.tomorrowShoots} empty="Nothing on tomorrow's calendar yet." showGaps />
          {d.tomorrowShoots.length > 0 && d.closeout.tomorrowGaps === 0 && (
            <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> Tomorrow looks ready — every shoot assigned with access notes on file.</p>
          )}
        </div>
      );

    case "loops": {
      const now = new Date(d.nowISO);
      return (
        <div className="space-y-2">
          {d.openLoops.length === 0 && (
            <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> No follow-ups waiting on someone else.</p>
          )}
          {/* All rendered inline — the Other tab hides comm-type tasks, so an
              overflow link there showed none of these rows (review). Each row
              has View + Handled (Jordan, Sep 1) instead of being one big link. */}
          {d.openLoops.map((l) => (
            <div key={l.taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium leading-snug">{l.title}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {loopKind(l.kind)}
                  {l.projectTitle ? ` · ${l.projectTitle}` : ""}
                  {l.dueISO ? (l.overdue ? ` · ${ageText(l.dueISO, now)} overdue` : ` · due ${fmtDay(l.dueISO)}`) : ""}
                </p>
              </div>
              {l.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
              <LoopActions taskId={l.taskId} viewHref={l.projectId ? `/projects/${l.projectId}` : `/tasks?tab=other&task=${l.taskId}`} />
            </div>
          ))}
        </div>
      );
    }

    case "video-review":
      return <VideoReviewCard d={d} />;

    case "lunch":
      return <p className="text-sm text-muted">Eat. The hub holds the fort.</p>;

    case "pipeline":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Pill warn={false} label={`${d.pipeline.editing} in editing`} href="/editing" />
            <Pill warn={d.pipeline.review > 0} label={`${d.pipeline.review} in review`} href="/review" />
            <Pill warn={d.pipeline.revision > 0} label={`${d.pipeline.revision} in revision`} href="/tasks?tab=revisions" />
          </div>
          <div className="space-y-2">
            {d.pipeline.rows.map((r) => (
              <Link key={r.projectId} href={`/edit/${r.projectId}`} className="block rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:bg-surface-2/60">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.title}</span>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    r.status === "REVISION" ? "bg-warning/15 text-warning" : r.status === "REVIEW" ? "bg-brand/15 text-brand" : "bg-surface-2 text-muted",
                  )}>
                    {r.status === "REVISION" ? "revision" : r.status === "REVIEW" ? "in review" : "editing"}
                  </span>
                  {r.editor && <span className="shrink-0 text-xs text-muted">→ {r.editor}</span>}
                </div>
                {/* Who it's for + what was ordered (Jordan: "more details on
                    who it is, what it's for"). */}
                {(r.clientName || r.services.length > 0) && (
                  <p className="mt-0.5 text-xs text-muted">
                    {r.clientName}
                    {r.clientName && r.services.length > 0 && " · "}
                    {r.services.join(", ")}
                  </p>
                )}
                <p className="mt-1 text-[13px]">
                  {r.sent.length > 0 && <span className="text-success">Sent: {r.sent.join(", ")}</span>}
                  {r.sent.length > 0 && r.waitingOn.length > 0 && <span className="text-muted-2"> · </span>}
                  {r.waitingOn.length > 0 && <span className="font-medium text-warning">Still needs: {r.waitingOn.join(", ")}</span>}
                  {r.sent.length === 0 && r.waitingOn.length === 0 && <span className="text-muted">No delivery evidence yet.</span>}
                  {r.videoDueISO && (
                    <span className={cn("ml-1", r.videoOverdue ? "font-semibold text-danger" : "text-muted-2")}>
                      · video due {fmtDay(r.videoDueISO)}{r.videoOverdue ? " — LATE" : ""}
                    </span>
                  )}
                </p>
                {r.revision && (r.revision.headline || r.revision.items.length > 0) && (
                  <div className="mt-1.5 rounded-lg bg-warning/[0.07] px-2.5 py-1.5 text-[13px]">
                    {r.revision.headline && <p className="font-medium text-foreground/85">Revising: {r.revision.headline}</p>}
                    {r.revision.items.map((it, i) => (
                      <p key={i} className="text-foreground/75">· {it.slice(0, 110)}</p>
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </div>
      );

    case "systems":
      return (
        <p className="text-[13px] leading-relaxed text-muted">
          Lower-priority block: Aryeo cleanup · client record updates · Dropbox organization · SOP maintenance ·
          review requests · process improvements. Drop it instantly if a client needs something.
        </p>
      );

    case "closeout": {
      const c = d.closeout;
      const rows: { ok: boolean; label: string }[] = [
        { ok: c.todayShootsDone, label: c.todayShootsDone ? "Today's shoots all happened" : "Some of today's shoots haven't happened yet" },
        { ok: c.todayDebriefsMissing === 0, label: c.todayDebriefsMissing === 0 ? "Every shot job's upload page is submitted" : `${c.todayDebriefsMissing} upload page${c.todayDebriefsMissing === 1 ? "" : "s"} still not submitted (10 PM text will chase)` },
        { ok: c.unanswered === 0, label: c.unanswered === 0 ? "No unanswered client messages" : `${c.unanswered} client message${c.unanswered === 1 ? "" : "s"} still waiting` },
        { ok: c.openQc === 0, label: c.openQc === 0 ? "QC queue is clear" : `${c.openQc} QC card${c.openQc === 1 ? "" : "s"} still open` },
        { ok: c.tomorrowGaps === 0, label: c.tomorrowGaps === 0 ? "Tomorrow is locked in" : `Tomorrow has ${c.tomorrowGaps} gap${c.tomorrowGaps === 1 ? "" : "s"} to close` },
        { ok: c.openRevisions === 0, label: c.openRevisions === 0 ? "No revisions outstanding" : `${c.openRevisions} revision${c.openRevisions === 1 ? "" : "s"} in flight — confirm they're assigned` },
      ];
      return (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <p key={i} className={cn("flex items-start gap-2 text-sm", r.ok ? "text-success" : "text-warning")}>
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              {r.label}
            </p>
          ))}
        </div>
      );
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shoot cards — parsed and glanceable: bold labels, weather, airspace, comms.
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed">
      <span className="font-semibold text-foreground/90">{label}: </span>
      <span className="text-foreground/75">{children}</span>
    </p>
  );
}

function ShootList({ shoots, empty, showGaps, showDebrief }: { shoots: OpsShoot[]; empty: string; showGaps?: boolean; showDebrief?: boolean }) {
  if (shoots.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-2.5">
      {shoots.map((s) => (
        <div key={s.id} className="rounded-xl border border-border px-4 py-3">
          {/* Header: time · address · quick links */}
          <div className="flex items-center gap-2">
            <Camera className="size-4 shrink-0 text-muted-2" />
            <Link href={`/projects/${s.id}`} className="min-w-0 flex-1 truncate text-[15px] font-semibold hover:text-brand">{s.title}</Link>
            {s.timeISO && <span className="shrink-0 text-sm font-semibold tabular-nums text-brand">{fmtTime(s.timeISO)}</span>}
            {s.aryeoListingId && (
              <a
                href={aryeoListingUrl(s.aryeoListingId)}
                target="_blank" rel="noopener noreferrer"
                title="Open the listing in Aryeo"
                className="shrink-0 rounded-lg border border-border p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>

          <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Field label="Client">{s.clientName}</Field>
            <Field label="Creative">{s.photographer ?? <span className="font-semibold text-danger">unassigned</span>}</Field>
            <Field label="Services">{s.services.join(", ") || "—"}</Field>
            {s.access.name && <Field label="Contact">{s.access.name}{s.access.phone ? ` · ${s.access.phone}` : ""}</Field>}
            {/* The door code is the single most operational thing on this card —
                give it its own emphasised row, not a buried note (audit HIGH). */}
            {s.access.lockbox && (
              <div className="sm:col-span-2">
                <Field label="Lockbox / door code">
                  <span className="font-semibold text-brand">{s.access.lockbox}</span>
                </Field>
              </div>
            )}
            {s.access.access && <div className="sm:col-span-2"><Field label="Getting in">{s.access.access}</Field></div>}
            {s.access.presence && <Field label="Who's there">{s.access.presence}</Field>}
            {s.access.special && (
              <div className="sm:col-span-2">
                <Field label="Special instructions"><span className="text-warning">{s.access.special}</span></Field>
              </div>
            )}
            {s.access.orderNotes && <div className="sm:col-span-2"><Field label="Order notes">{s.access.orderNotes}</Field></div>}
            {s.access.notes && <div className="sm:col-span-2"><Field label="Client preferences">{s.access.notes}</Field></div>}
            {s.specialRequests.length > 0 && (
              <div className="sm:col-span-2">
                <p className="text-[13px] leading-relaxed">
                  <span className="font-semibold text-warning">Special requests: </span>
                  <span className="text-foreground/75">{s.specialRequests.join(" · ").slice(0, 200)}</span>
                </p>
              </div>
            )}
          </div>

          {/* Conditions + comms strip */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[13px]">
            {s.weather && (
              <span className={cn("inline-flex items-center gap-1", s.weather.precipPct >= 40 || s.weather.windMph >= 20 ? "font-semibold text-warning" : "text-muted")}>
                <CloudSun className="size-3.5" />
                {s.weather.tempF}° · {s.weather.precipPct}% rain · wind {s.weather.windMph} mph
              </span>
            )}
            {s.droneOrdered && s.airspace && (
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  !s.airspace.available ? "text-muted" : s.airspace.warning ? "font-semibold text-warning" : "text-success",
                )}
                title={s.airspace.airport ? `Controlling airport: ${s.airspace.airport}` : undefined}
              >
                <Plane className="size-3.5" />
                {!s.airspace.available ? (
                  <>
                    Airspace check unavailable —{" "}
                    <a href="https://b4ufly.aloft.ai/" target="_blank" rel="noopener noreferrer" className="underline">
                      verify on B4UFLY
                    </a>
                  </>
                ) : s.airspace.status === "clear" ? (
                  "Airspace clear — OK to 400 ft"
                ) : s.airspace.status === "restricted" ? (
                  `No-fly without FAA authorization${s.airspace.airport ? ` (${s.airspace.airport})` : ""} — 0 ft grid`
                ) : (
                  `LAANC required — auto-auth to ${s.airspace.ceilingFt} ft${s.airspace.airport ? ` near ${s.airspace.airport}` : ""}`
                )}
              </span>
            )}
            {s.comms && (
              <Link href={`/communications`} className={cn("inline-flex items-center gap-1 hover:underline", s.comms.count > 0 && s.comms.latestInbound ? "font-semibold text-brand" : "text-muted")}>
                <MessageSquare className="size-3.5" />
                {s.comms.count > 0 && (
                  <>
                    {s.comms.count} msg{s.comms.count === 1 ? "" : "s"} (72h)
                    {s.comms.latestSnippet && <> · {s.comms.latestInbound ? "them" : "us"}: &ldquo;{s.comms.latestSnippet.slice(0, 60)}&rdquo;</>}
                  </>
                )}
                {s.comms.otherCount > 0 && (
                  <span className="text-muted-2">{s.comms.count > 0 ? "· " : ""}+{s.comms.otherCount} on other job{s.comms.otherCount === 1 ? "" : "s"}</span>
                )}
              </Link>
            )}
            {showDebrief && s.timeISO && new Date(s.timeISO) < new Date() && (
              <span className={cn(s.debriefSubmitted ? "text-success" : "font-semibold text-warning")}>
                {s.debriefSubmitted ? "Upload page submitted ✓" : "Shot — upload page not submitted"}
              </span>
            )}
            {showGaps && s.gaps.length > 0 && (
              <span className="font-semibold text-danger">Missing: {s.gaps.join(" · ")}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QC — grouped Overdue · Due today · Waiting, with evidence and quick links.
// ---------------------------------------------------------------------------

// Listing QC only. Monthly personal-branding content runs on its own rhythm (a
// BATCH of videos on a 7-10 business-day window) and has its own card.
const listingQc = (d: OpsDay) => d.qc.filter((q) => !q.monthly);

// The 9:30 block is for TODAY's work. The backlog (overdue + not-yet-due) was
// burying it: on Sep 1 the card held 8 stale rows and nothing actually due, so
// Kyle couldn't tell what this hour was for (Jordan: "too clogged up with
// overdue and waiting — that should be a separate card to check").
function QcDueToday({ d }: { d: OpsDay }) {
  const qc = listingQc(d);
  const rows = qc.filter((q) => q.bucket === "today");
  // Each number must match the card it links to — monthly rows are counted
  // once, under monthly, even when they are also late.
  const overdue = qc.filter((q) => q.bucket === "overdue").length;
  const waiting = qc.filter((q) => q.bucket === "waiting").length;
  const monthly = d.qc.filter((q) => q.monthly).length;
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing due for QC today.
        </p>
      ) : (
        <div className="space-y-2">
          {/* All rows inline — the Other tab hides media_qa for non-editors,
              so the old "All N →" link landed on an empty list (review). */}
          {rows.map((q) => <QcRow key={q.taskId} q={q} />)}
        </div>
      )}
      {(overdue > 0 || waiting > 0 || monthly > 0) && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted">
          Not in this block:
          {overdue > 0 && <a href="#overdue" className="font-semibold text-danger hover:underline">{overdue} overdue →</a>}
          {waiting > 0 && <a href="#overdue" className="hover:underline">{waiting} not due yet →</a>}
          {monthly > 0 && <a href="#monthly" className="font-semibold text-brand hover:underline">{monthly} monthly content →</a>}
        </p>
      )}
    </div>
  );
}

// Everything past its promised date, oldest first, plus what is not due yet.
// Monthly batches are deliberately absent — they have their own card and their
// own turnaround (Jordan: monthly content shouldn't sit in the QC pile).
function OverdueCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const qc = listingQc(d);
  const byDueAsc = (a: OpsQcRow, b: OpsQcRow) =>
    (a.dueISO ? Date.parse(a.dueISO) : Infinity) - (b.dueISO ? Date.parse(b.dueISO) : Infinity);
  const overdue = qc.filter((q) => q.bucket === "overdue").sort(byDueAsc);
  const waiting = qc.filter((q) => q.bucket === "waiting").sort(byDueAsc);
  const monthlyLate = d.qc.filter((q) => q.monthly && q.bucket === "overdue").length;
  return (
    <div className="space-y-4">
      {overdue.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing is past its promised date.
        </p>
      ) : (
        <div>
          <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-danger">Overdue · {overdue.length}</h3>
          <div className="space-y-2">
            {overdue.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
          </div>
        </div>
      )}
      {waiting.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-muted-2">Not due yet · {waiting.length}</h3>
          <p className="mb-2 text-[13px] text-muted">Nothing to do today — listed so none of it creeps up on you.</p>
          <div className="space-y-2">
            {waiting.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
          </div>
        </div>
      )}
      {monthlyLate > 0 && (
        <p className="text-[13px] text-muted">
          {monthlyLate} monthly content batch{monthlyLate === 1 ? " is" : "es are"} also past due —{" "}
          <a href="#monthly" className="font-semibold text-brand hover:underline">Monthly Content Check →</a>
        </p>
      )}
    </div>
  );
}

function MonthlyCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const monthly = d.qc.filter((q) => q.monthly);
  if (monthly.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 className="size-4" /> No monthly batches open right now.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {monthly.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
    </div>
  );
}

// One labelled line of the QC status grid — the same shape as the shoot
// card's Field, so both cards read the same way.
function StatusLine({ label, tone, children }: { label: string; tone: "success" | "warning" | "brand" | "muted" | "danger"; children: React.ReactNode }) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "brand" ? "text-brand" : tone === "danger" ? "text-danger" : "text-foreground/90";
  return (
    <p className="text-[13px] leading-relaxed">
      <span className={cn("font-semibold", toneClass)}>{label}: </span>
      <span className="text-foreground/80">{children}</span>
    </p>
  );
}

const actionBtn = "inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground";

function QcRow({ q, now }: { q: OpsQcRow; now?: Date }) {
  const db = q.evidence.dropbox;
  // How late, in plain days — "due Aug 21" makes Kyle do the subtraction.
  const lateDays =
    now && q.dueISO && Date.parse(q.dueISO) < now.getTime()
      ? Math.floor((now.getTime() - Date.parse(q.dueISO)) / 86_400_000)
      : null;
  const v = q.video;
  const videoTone =
    !v ? "muted" :
    v.stage === "waiting_review" ? "brand" :
    v.stage === "in_revisions" ? "warning" :
    v.stage === "approved" || v.stage === "delivered" ? "success" :
    "muted";
  const videoHref = !v ? null : v.stage === "waiting_review" ? `/review/${q.projectId}` : `/edit/${q.projectId}`;
  return (
    <div className="rounded-xl border border-border">
      {/* Header: address + who, chips on the right (wrap under on a phone) */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3.5 pt-2.5">
        <div className="min-w-0 flex-1 basis-52">
          <Link href={`/projects/${q.projectId}`} className="text-sm font-semibold leading-snug hover:text-brand">{q.title}</Link>
          <p className="mt-0.5 text-[12px] text-muted">
            {q.clientName}
            {q.shootISO ? ` · shot ${fmtDay(q.shootISO)}` : ""}
            {q.photographer ? ` · ${q.photographer}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {lateDays != null && (
            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">
              {lateDays === 0 ? "late today" : `${lateDays} day${lateDays === 1 ? "" : "s"} late`}
            </span>
          )}
          {q.videosOwed != null && (
            <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand" title="Videos this monthly session owes — the photographer's count, else the plan quota">
              {q.videosOwed} video{q.videosOwed === 1 ? "" : "s"}
            </span>
          )}
          {/* "Ready now" is the number that matters: checks whose media is
              already live. The rest of itemsLeft is the card waiting on media,
              not work — showing only the total made a job with photos live and
              six checks waiting look identical to one where nothing had landed. */}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
              q.actionable > 0 ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted",
            )}
            title={
              q.actionable > 0
                ? `${q.actionable} of ${q.itemsLeft} unticked boxes can be done right now — that media is live on Aryeo. The rest tick themselves as each remaining category lands.`
                : "Unticked boxes on this job's QC task. They tick themselves as each deliverable goes live on Aryeo — nothing to check until then."
            }
          >
            {q.actionable > 0
              ? `${q.actionable} ready now`
              : `${q.itemsLeft} check${q.itemsLeft === 1 ? "" : "s"} left`}
          </span>
        </div>
      </div>

      {/* Status grid — what's live, what's owed, where the video is, what
          Dropbox holds. Labelled lines instead of two run-on sentences. */}
      <div className="mt-2 grid gap-x-6 gap-y-0.5 px-3.5 sm:grid-cols-2">
        <StatusLine label="Ordered" tone="muted">{q.services.join(", ") || "—"}</StatusLine>
        {q.evidence.present.length > 0 ? (
          <StatusLine label="Live on Aryeo" tone="success">
            {q.evidence.present.join(", ")}
            {q.actionable > 0 && <> — <span className="font-semibold text-warning">{q.actionable} check{q.actionable === 1 ? "" : "s"} ready for you</span></>}
          </StatusLine>
        ) : (
          <StatusLine label="Live on Aryeo" tone="muted">nothing yet</StatusLine>
        )}
        {/* WHY it's still open, in words — "missing: Floor plan" alone didn't
            say whether we're waiting on the editor, on Aryeo, or on nothing at
            all (Jordan, Sep 1: 195 Woodhill's floor plan was removed). */}
        {q.evidence.missing.length > 0 ? (
          <StatusLine label="Still owed" tone="warning">
            {q.evidence.missing.join(", ")}
            {q.nextDueISO ? ` — ${q.nextDueCategories.join(" + ").toLowerCase()} due ${fmtDayTime(q.nextDueISO)}` : ""}
          </StatusLine>
        ) : q.itemsLeft > 0 ? (
          <StatusLine label="Still owed" tone="muted">nothing — everything ordered is live, finish the checks</StatusLine>
        ) : (
          <StatusLine label="Status" tone="success">Everything is live and checked — safe to close.</StatusLine>
        )}
        {/* Video status for shoots that have one (Jordan, Sep 1). */}
        {v && (
          <StatusLine label="Video" tone={videoTone}>
            {v.detail}
            {videoHref && (v.stage === "waiting_review" || v.stage === "in_revisions") && (
              <> · <Link href={videoHref} className="font-medium text-brand hover:underline">{v.stage === "waiting_review" ? "review it" : "open edit"}</Link></>
            )}
          </StatusLine>
        )}
        <StatusLine label="Dropbox" tone="muted">
          {db ? (
            <>
              Raw {db.rawPhotos + db.rawVideo} · Final {db.finalPhotos + db.finalVideo}
              {db.stale && <span className="text-muted-2"> (last read {db.at ? fmtDay(db.at) : "earlier"})</span>}
            </>
          ) : (
            // Not consulted ≠ empty. Hiding the line read as "no files".
            <span title="The last status check didn't read Dropbox for this job (Aryeo already accounted for everything ordered, or the read failed with nothing to carry forward).">not read this pass</span>
          )}
        </StatusLine>
      </div>

      {/* Actions — one row, same buttons on every card */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border/60 px-3.5 py-2">
        <QcComplete taskId={q.taskId} waitingOn={q.evidence.missing} />
        {q.aryeoListingId && (
          <a href={aryeoListingUrl(q.aryeoListingId)} target="_blank" rel="noopener noreferrer" title="Open the listing in Aryeo" className={actionBtn}>
            <ExternalLink className="size-3" /> Aryeo
          </a>
        )}
        <Link href={`/projects/${q.projectId}`} className={actionBtn}>Project</Link>
        {v?.stage === "waiting_review" && (
          <Link href={`/review/${q.projectId}`} className={cn(actionBtn, "border-brand/40 text-brand hover:text-brand")}>
            <PlayCircle className="size-3" /> Review video
          </Link>
        )}
        {q.evidence.missing.length > 0 && (
          <span className="ml-auto text-[11px] text-muted-2">Removed from the order or handled elsewhere? Mark complete.</span>
        )}
      </div>
      <ShootNotes q={q} />
    </div>
  );
}

// Everything the photographer wrote on the upload portal, verbatim and in full
// — except the video editing brief, which belongs to the editor on /edit
// (Jordan, Sep 1). These notes were previously either missing (shot order,
// flags, per-item notes, "anything else for the editor") or clipped mid-sentence
// at 140 characters, which is where the useful half usually was.
function ShootNotes({ q }: { q: OpsQcRow }) {
  const b = q.debrief;
  const has =
    b.unsubmitted || q.notCompleted.length > 0 || b.flags.length > 0 || !!b.removals ||
    b.nothingToRemove || !!b.shotOrder || !!b.editorBrief || b.itemNotes.length > 0 ||
    b.culled || b.videosFilmed != null;
  if (!has) return null;
  return (
    <div className="mx-3.5 mb-3 rounded-lg bg-surface-2/60 px-3 py-2">
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-2">From the shoot</h4>
      <div className="mt-1 space-y-1 text-[13px]">
        {b.unsubmitted && (
          <p className="font-medium text-danger">Upload page never submitted — treat the gallery as unculled.</p>
        )}
        {q.notCompleted.map((nc, i) => (
          <p key={i} className="font-medium text-warning">
            Couldn&rsquo;t complete {nc.label}: <span className="font-normal text-foreground/80">{nc.reason}</span>
          </p>
        ))}
        {b.flags.map((f, i) => (
          <p key={i} className="font-medium text-danger">Flagged: <span className="font-normal text-foreground/80">{f}</span></p>
        ))}
        {b.shotOrder && <NoteLine label="Shot order" body={b.shotOrder} />}
        {b.removals && <NoteLine label="Remove in editing" body={b.removals} />}
        {b.editorBrief && <NoteLine label="Anything else" body={b.editorBrief} />}
        {b.itemNotes.map((n, i) => <NoteLine key={i} label={n.label} body={n.note} />)}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-muted">
          {b.videosFilmed != null && <span>{b.videosFilmed} video{b.videosFilmed === 1 ? "" : "s"} filmed</span>}
          {b.culled && <span className="text-success">Culled to standard ✓</span>}
          {b.nothingToRemove && !b.removals && <span>Nothing to remove ✓</span>}
        </div>
      </div>
    </div>
  );
}

// whitespace-pre-wrap: multi-line wrap-up notes keep the photographer's line
// breaks instead of collapsing into one run-on paragraph.
function NoteLine({ label, body }: { label: string; body: string }) {
  return (
    <p className="whitespace-pre-wrap text-foreground/80">
      <span className="font-semibold text-foreground/90">{label}:</span> {body}
    </p>
  );
}

function Pill({ warn, label, href }: { warn: boolean; label: string; href: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1 font-medium transition-colors hover:bg-surface-2",
        warn ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted",
      )}
    >
      {label}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Video Review — every uploaded cut waiting on a verdict, and every cut that
// went back to an editor (Jordan, Sep 1). Rows are per CUT, not per job: a
// monthly package with four videos shows four rows, each with its own button.
// ---------------------------------------------------------------------------

function VideoReviewCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const { waiting, revising } = d.videoReview;
  return (
    <div className="space-y-4">
      <VideoGroup
        icon={PlayCircle}
        title="Waiting on your review"
        tone="brand"
        cuts={waiting}
        now={now}
        empty="Nothing waiting — every uploaded cut has a verdict."
        action="Review"
        hrefFor={(c) => `/review/${c.projectId}?cut=${c.submissionId}`}
      />
      <VideoGroup
        icon={Hourglass}
        title="In revisions"
        tone="warning"
        cuts={revising}
        now={now}
        empty="No cuts are back with an editor."
        action="Open edit"
        hrefFor={(c) => `/edit/${c.projectId}?cut=${c.submissionId}`}
      />
    </div>
  );
}

function VideoGroup({ icon: Icon, title, tone, cuts, now, empty, action, hrefFor }: {
  icon: LucideIcon;
  title: string;
  tone: "brand" | "warning";
  cuts: VideoCutState[];
  now: Date;
  empty: string;
  action: string;
  hrefFor: (c: VideoCutState) => string;
}) {
  const toneText = tone === "brand" ? "text-brand" : "text-warning";
  const toneChip = tone === "brand" ? "bg-brand/15 text-brand" : "bg-warning/15 text-warning";
  return (
    <div>
      <h3 className={cn("flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest", toneText)}>
        <Icon className="size-3.5" /> {title}
        <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", toneChip)}>{cuts.length}</span>
      </h3>
      {cuts.length === 0 ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> {empty}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {cuts.map((c) => {
            const age = ageText(c.sinceISO, now);
            const stale = now.getTime() - Date.parse(c.sinceISO) > 48 * 3_600_000;
            return (
              <div key={c.submissionId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm leading-snug">
                    <Link href={`/projects/${c.projectId}`} className="font-semibold hover:text-brand">{c.street}</Link>
                    <span className="text-muted">· {c.cutLabel}</span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">v{c.round}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {c.clientName}
                    {c.submittedByName?.startsWith("Auto") ? " · found in the Final folder" : c.submittedByName || c.editorKey ? ` · ${c.submittedByName ?? c.editorKey}` : ""}
                    {" · "}
                    <span className={cn(stale && "font-semibold text-danger")}>
                      {c.status === "PENDING" ? `waiting ${age}` : age === "just now" ? "sent back just now" : `sent back ${age} ago`}
                    </span>
                    {c.status === "CHANGES_REQUESTED" && c.openNotes > 0 && ` · ${c.openNotes} note${c.openNotes === 1 ? "" : "s"} to fix`}
                  </p>
                </div>
                <Link
                  href={hrefFor(c)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold",
                    tone === "brand" ? "border-brand/40 bg-brand/10 text-brand hover:bg-brand/20" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  {action} <ArrowRight className="size-3" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
