import Link from "next/link";
import {
  AlertTriangle, ArrowRight, Camera, CheckCircle2, ClipboardCheck, Clock, Coffee,
  ListChecks, MessageSquare, Moon, RefreshCw, Route, Sunrise, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { buildOpsDay, type OpsDay, type OpsShoot } from "@/lib/opsDay";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Kyle's Ops Day — Jordan's "Daily Operations & Client Experience Structure"
// as a guided screen: the day's time blocks in order, each filled with LIVE
// data from the same sources the rest of the hub reads, the current block
// spotlighted. Kyle's job in one sentence: nothing surprises the client,
// nothing gets missed, problems die before they're client-facing, and Jordan
// is only pulled in for owner-level calls.
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

type BlockDef = { key: string; from: number; to: number; time: string; title: string; icon: LucideIcon; goal: string };
const BLOCKS: BlockDef[] = [
  { key: "tower", from: 9 * 60, to: 9 * 60 + 30, time: "9:00 – 9:30", title: "Morning Control Tower", icon: Sunrise, goal: "Know what's happening today, what needs attention, and what could go wrong — before the day gets moving." },
  { key: "qc-am", from: 9 * 60 + 30, to: 10 * 60 + 30, time: "9:30 – 10:30", title: "QC + Morning Deliveries", icon: ClipboardCheck, goal: "Catch mistakes before the client does; get finished work delivered early." },
  { key: "comms-1", from: 10 * 60 + 30, to: 11 * 60, time: "10:30 – 11:00", title: "Client Communication Sweep #1", icon: MessageSquare, goal: "Nobody waits wondering if we got their message." },
  { key: "prep", from: 11 * 60, to: 12 * 60, time: "11:00 – 12:00", title: "Tomorrow + Upcoming Prep", icon: Route, goal: "Tomorrow is operationally ready before today ends — problems get solved the day before, not 30 minutes before the shoot." },
  { key: "loops", from: 12 * 60, to: 12 * 60 + 30, time: "12:00 – 12:30", title: "Open Loops + Follow-Ups", icon: RefreshCw, goal: "Nothing stays stuck because someone forgot to follow up. Ask: what am I waiting on that could become a problem?" },
  { key: "lunch", from: 12 * 60 + 30, to: 13 * 60, time: "12:30 – 1:00", title: "Lunch", icon: Coffee, goal: "Protected — unless there's a genuine operational or client emergency." },
  { key: "pipeline", from: 13 * 60, to: 14 * 60, time: "1:00 – 2:00", title: "Production Pipeline Check", icon: ListChecks, goal: "Know the status of every active project without the client having to ask first." },
  { key: "comms-2", from: 14 * 60, to: 14 * 60 + 30, time: "2:00 – 2:30", title: "Client Communication Sweep #2", icon: MessageSquare, goal: "Proactive, not reactive — if something changed, the client hears it from us first." },
  { key: "systems", from: 14 * 60 + 30, to: 15 * 60 + 30, time: "2:30 – 3:30", title: "Systems + Admin Work", icon: Wrench, goal: "Keep the backend organized — without letting admin work interfere with active client needs." },
  { key: "final-prep", from: 15 * 60 + 30, to: 16 * 60 + 15, time: "3:30 – 4:15", title: "Next-Day Finalization", icon: Route, goal: "By the end of this block, tomorrow is locked in and ready to go." },
  { key: "qc-pm", from: 16 * 60 + 15, to: 17 * 60, time: "4:15 – 5:00", title: "Final QC + Deliveries", icon: ClipboardCheck, goal: "Finished work doesn't sit overnight — get it into clients' hands before end of day." },
  { key: "comms-3", from: 17 * 60, to: 17 * 60 + 30, time: "5:00 – 5:30", title: "Client Communication Sweep #3", icon: MessageSquare, goal: "Don't carry simple client questions into the next business day." },
  { key: "closeout", from: 17 * 60 + 30, to: 18 * 60, time: "5:30 – 6:00", title: "Daily Closeout", icon: Moon, goal: "Review the whole operation before ending the day — escalate anything that needs Jordan." },
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
      <PageHeader
        eyebrow="Operations + Client Experience"
        title="Ops Day"
        subtitle="Nothing surprises the client · nothing gets missed · problems die before they're client-facing"
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">

        {/* The four numbers that matter right now */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Shoots today" value={String(d.todayShoots.length)} warn={false} />
          <Stat label="Unanswered clients" value={String(d.unanswered.count)} warn={d.unanswered.count > 0} />
          <Stat label="QC open" value={String(d.qc.length)} warn={d.qc.some((q) => q.overdue)} />
          <Stat label="Tomorrow gaps" value={String(d.closeout.tomorrowGaps)} warn={d.closeout.tomorrowGaps > 0} />
        </div>

        {BLOCKS.map((b) => (
          <Block key={b.key} def={b} current={b.key === currentKey} d={d} />
        ))}

        {/* The rules that frame every block */}
        <section className="rounded-2xl border bg-surface p-5">
          <h2 className="text-sm font-semibold">Priority order — the inbox is not the task list</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            1. Active client issue happening right now · 2. Today&rsquo;s shoot · 3. Today&rsquo;s delivery ·
            4. Tomorrow&rsquo;s shoot · 5. Overdue project or revision · 6. Client communication ·
            7. Production follow-up · 8. Routine admin · 9. Long-term internal projects
          </p>
          <h2 className="mt-4 text-sm font-semibold">Escalate exceptions, not routine</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Jordan doesn&rsquo;t need &ldquo;a project was delivered&rdquo; or &ldquo;a shoot went fine.&rdquo; Bring him in when: a client
            is seriously unhappy, wants something outside scope or against policy, an important relationship is at
            risk, a major production mistake happened, tomorrow can&rsquo;t be staffed, or the decision is above your
            authority. Everything else — handle it.
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface px-4 py-3">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", warn && "text-warning")}>{value}</div>
    </div>
  );
}

function Block({ def, current, d }: { def: BlockDef; current: boolean; d: OpsDay }) {
  const Icon = def.icon;
  return (
    <section
      id={def.key}
      className={cn(
        "panel-shadow rounded-2xl border bg-surface",
        current && "border-brand/50 ring-1 ring-brand/30",
      )}
    >
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          current ? "bg-brand text-white" : "bg-surface-2 text-muted",
        )}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold">{def.title}</h2>
            {current && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">Now</span>}
          </div>
          <p className="text-xs text-muted-2"><Clock className="mr-1 inline size-3 -translate-y-px" />{def.time}</p>
        </div>
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

// ---------------------------------------------------------------------------
// Per-block live payloads
// ---------------------------------------------------------------------------

function BlockBody({ blockKey, d }: { blockKey: string; d: OpsDay }) {
  switch (blockKey) {
    case "tower":
      return (
        <div className="space-y-3">
          <ShootList shoots={d.todayShoots} empty="No shoots on today's calendar." showDebrief />
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Pill warn={d.unanswered.count > 0} label={`${d.unanswered.count} unanswered client message${d.unanswered.count === 1 ? "" : "s"} overnight`} href="/communications?tab=replies" />
            <Pill warn={d.pipeline.overdueTasks > 0} label={`${d.pipeline.overdueTasks} overdue task${d.pipeline.overdueTasks === 1 ? "" : "s"}`} href="/tasks" />
            <Pill warn={false} label={`${d.pipeline.dueTodayTasks} task${d.pipeline.dueTodayTasks === 1 ? "" : "s"} due today`} href="/tasks" />
            <Pill warn={d.revisions.length > 0} label={`${d.revisions.length} open revision${d.revisions.length === 1 ? "" : "s"}`} href="/editing" />
            <Pill warn={d.needsAssigning > 0} label={`${d.needsAssigning} task${d.needsAssigning === 1 ? "" : "s"} need assigning`} href="/tasks" />
          </div>
        </div>
      );

    case "qc-am":
    case "qc-pm":
      return (
        <div className="space-y-2">
          {d.qc.length === 0 && <p className="text-sm text-muted">Nothing waiting on QC right now.</p>}
          {d.qc.slice(0, 8).map((q) => (
            <Link key={q.taskId} href={`/projects/${q.projectId}`} className="block rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:bg-surface-2/60">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{q.title}</span>
                {q.overdue && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
                <span className="text-xs text-muted">{q.itemsLeft} check{q.itemsLeft === 1 ? "" : "s"} left</span>
              </div>
              {(q.debrief.removals || q.debrief.shotOrder || q.debrief.videoBrief || q.debrief.unsubmitted) && (
                <div className="mt-1.5 space-y-0.5 text-[13px]">
                  {q.debrief.unsubmitted && <p className="font-medium text-danger">Upload page never submitted — treat the gallery as unculled.</p>}
                  {q.debrief.removals && <p className="text-foreground/80"><span className="font-medium">Remove in editing:</span> {q.debrief.removals.slice(0, 140)}</p>}
                  {q.debrief.shotOrder && <p className="text-muted">Shot order: {q.debrief.shotOrder.slice(0, 120)}</p>}
                  {q.debrief.videoBrief && <p className="text-muted">Video brief on file — check the cut against it.</p>}
                </div>
              )}
            </Link>
          ))}
          {d.qc.length > 8 && <Link href="/tasks" className="text-[13px] font-medium text-brand hover:underline">All {d.qc.length} QC cards →</Link>}
        </div>
      );

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
                <div key={i} className="rounded-xl border border-border px-3.5 py-2 text-sm">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-muted"> · waiting {u.hours}h · &ldquo;{u.snippet}&rdquo;</span>
                </div>
              ))}
              <Link href="/communications?tab=replies" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
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

    case "loops":
      return (
        <div className="space-y-2">
          {d.openLoops.length === 0 && <p className="text-sm text-muted">No follow-ups waiting on someone else.</p>}
          {d.openLoops.slice(0, 8).map((l) => (
            <Link key={l.taskId} href={l.projectId ? `/projects/${l.projectId}` : "/tasks"} className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-2 text-sm transition-colors hover:bg-surface-2/60">
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
              {l.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
            </Link>
          ))}
          {d.openLoops.length > 8 && <Link href="/tasks" className="text-[13px] font-medium text-brand hover:underline">All follow-ups →</Link>}
        </div>
      );

    case "lunch":
      return <p className="text-sm text-muted">Eat. The hub holds the fort.</p>;

    case "pipeline":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Pill warn={false} label={`${d.pipeline.editing} in editing`} href="/editing" />
            <Pill warn={d.pipeline.review > 0} label={`${d.pipeline.review} in review`} href="/review" />
            <Pill warn={d.pipeline.revision > 0} label={`${d.pipeline.revision} in revision`} href="/editing" />
            <Pill warn={d.pipeline.overdueTasks > 0} label={`${d.pipeline.overdueTasks} overdue tasks`} href="/tasks" />
          </div>
          {d.revisions.length > 0 && (
            <div className="space-y-1.5">
              {d.revisions.slice(0, 5).map((r) => (
                <Link key={r.projectId} href={`/edit/${r.projectId}`} className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-2 text-sm hover:bg-surface-2/60">
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className={cn("shrink-0 text-xs", r.ageDays >= 2 ? "font-semibold text-danger" : "text-muted")}>revision · {r.ageDays}d</span>
                </Link>
              ))}
            </div>
          )}
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

function ShootList({ shoots, empty, showGaps, showDebrief }: { shoots: OpsShoot[]; empty: string; showGaps?: boolean; showDebrief?: boolean }) {
  if (shoots.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-2">
      {shoots.map((s) => (
        <Link key={s.id} href={`/projects/${s.id}`} className="block rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:bg-surface-2/60">
          <div className="flex items-center gap-2">
            <Camera className="size-4 shrink-0 text-muted-2" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
            {s.timeISO && <span className="shrink-0 text-xs tabular-nums text-muted">{fmtTime(s.timeISO)}</span>}
          </div>
          <p className="mt-0.5 pl-6 text-[13px] text-muted">
            {s.clientName}
            {s.photographer ? ` · ${s.photographer}` : ""}
            {s.services.length > 0 ? ` · ${s.services.slice(0, 4).join(", ")}` : ""}
          </p>
          {s.accessNote && <p className="mt-1 pl-6 text-[13px] text-foreground/75">Access: {s.accessNote.slice(0, 160)}</p>}
          {s.specialRequests.length > 0 && (
            <p className="mt-0.5 pl-6 text-[13px] text-warning">Special: {s.specialRequests.join(" · ").slice(0, 160)}</p>
          )}
          {showGaps && s.gaps.length > 0 && (
            <p className="mt-1 pl-6 text-[13px] font-medium text-danger">Missing: {s.gaps.join(" · ")}</p>
          )}
          {showDebrief && s.timeISO && new Date(s.timeISO) < new Date() && (
            <p className={cn("mt-1 pl-6 text-[13px]", s.debriefSubmitted ? "text-success" : "text-warning")}>
              {s.debriefSubmitted ? "Upload page submitted ✓" : "Shot — upload page not submitted yet"}
            </p>
          )}
        </Link>
      ))}
    </div>
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
