import Link from "next/link";
import {
  AlertTriangle, ArrowRight, Camera, CheckCircle2, ClipboardCheck, Clock, CloudSun, Coffee,
  ExternalLink, ListChecks, MessageSquare, Moon, Plane, RefreshCw, Route, Sunrise, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { buildOpsDay, type OpsDay, type OpsShoot, type OpsQcRow } from "@/lib/opsDay";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { cn } from "@/lib/utils";

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

type BlockDef = { key: string; from: number; to: number; time: string; title: string; icon: LucideIcon; goal: string };
const BLOCKS: BlockDef[] = [
  { key: "tower", from: 9 * 60, to: 9 * 60 + 30, time: "9:00 – 9:30", title: "Morning Control Tower", icon: Sunrise, goal: "Know what's happening today, what needs attention, and what could go wrong — before the day gets moving." },
  { key: "qc-am", from: 9 * 60 + 30, to: 10 * 60 + 30, time: "9:30 – 10:30", title: "QC + Morning Deliveries", icon: ClipboardCheck, goal: "Catch mistakes before the client does; get finished work delivered early." },
  { key: "comms-1", from: 10 * 60 + 30, to: 11 * 60, time: "10:30 – 11:00", title: "Client Communication Sweep #1", icon: MessageSquare, goal: "Nobody waits wondering if we got their message." },
  { key: "prep", from: 11 * 60, to: 11 * 60 + 30, time: "11:00 – 11:30", title: "Tomorrow + Upcoming Prep", icon: Route, goal: "Tomorrow is operationally ready before today ends — problems get solved the day before, not 30 minutes before the shoot." },
  { key: "loops", from: 11 * 60 + 30, to: 12 * 60, time: "11:30 – 12:00", title: "Open Loops + Follow-Ups", icon: RefreshCw, goal: "Nothing stays stuck because someone forgot to follow up. Ask: what am I waiting on that could become a problem?" },
  { key: "lunch", from: 12 * 60, to: 13 * 60, time: "12:00 – 1:00", title: "Lunch", icon: Coffee, goal: "Protected — unless there's a genuine operational or client emergency." },
  { key: "pipeline", from: 13 * 60, to: 14 * 60, time: "1:00 – 2:00", title: "Production Pipeline Check", icon: ListChecks, goal: "Know the status of every active project — and exactly what's holding each one up — before the client asks." },
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
      <AutoRefresh />
      <PageHeader
        eyebrow="Operations + Client Experience"
        title="Ops Day"
        subtitle="Nothing surprises the client · nothing gets missed · problems die before they're client-facing"
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Shoots today" value={String(d.todayShoots.length)} warn={false} />
          <Stat label="Unanswered clients" value={String(d.unanswered.count)} warn={d.unanswered.count > 0} />
          <Stat label="QC open" value={String(d.qc.length)} warn={d.qc.some((q) => q.bucket === "overdue")} />
          <Stat label="Tomorrow gaps" value={String(d.closeout.tomorrowGaps)} warn={d.closeout.tomorrowGaps > 0} />
        </div>

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
    <section id={def.key} className={cn("panel-shadow rounded-2xl border bg-surface", current && "border-brand/50 ring-1 ring-brand/30")}>
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
    case "qc-pm":
      return <QcGroups qc={d.qc} />;

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
                  <span className="font-semibold">{u.name}</span>
                  <span className="text-muted"> · waiting {u.hours}h · &ldquo;{u.snippet}&rdquo;</span>
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

    case "loops":
      return (
        <div className="space-y-2">
          {d.openLoops.length === 0 && <p className="text-sm text-muted">No follow-ups waiting on someone else.</p>}
          {/* All rendered inline — the Other tab hides comm-type tasks, so an
              overflow link there showed none of these rows (review). */}
          {d.openLoops.map((l) => (
            <Link key={l.taskId} href={l.projectId ? `/projects/${l.projectId}` : "/tasks"} className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-2 text-sm transition-colors hover:bg-surface-2/60">
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
              {l.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
            </Link>
          ))}
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
                href={`https://app.aryeo.com/listings/${s.aryeoListingId}`}
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
            {s.access.notes && <div className="sm:col-span-2"><Field label="Access / notes">{s.access.notes}</Field></div>}
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
            {s.droneOrdered && (
              <span className={cn("inline-flex items-center gap-1", s.airspace?.checked && s.airspace.ceilingFt != null && s.airspace.ceilingFt < 400 ? "font-semibold text-warning" : "text-muted")}>
                <Plane className="size-3.5" />
                {s.airspace?.checked
                  ? s.airspace.ceilingFt == null
                    ? "Airspace: uncontrolled"
                    : s.airspace.ceilingFt === 0
                      // A 0-ft grid has NO LAANC auto-authorization — a LAANC
                      // request there gets denied; manual FAA auth or no-fly.
                      ? "Airspace: 0 ft grid — manual FAA auth required (likely no-fly)"
                      : `Airspace: ${s.airspace.ceilingFt} ft grid — LAANC`
                  : <a href="https://b4ufly.aloft.ai/" target="_blank" rel="noopener noreferrer" className="underline">check airspace</a>}
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

function QcGroups({ qc }: { qc: OpsQcRow[] }) {
  if (qc.length === 0) return <p className="text-sm text-muted">Nothing waiting on QC right now.</p>;
  const groups: { key: OpsQcRow["bucket"]; label: string; tone: string }[] = [
    { key: "overdue", label: "Overdue", tone: "text-danger" },
    { key: "today", label: "Due today", tone: "text-warning" },
    { key: "waiting", label: "Waiting", tone: "text-muted-2" },
  ];
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const rows = qc.filter((q) => q.bucket === g.key);
        if (rows.length === 0) return null;
        return (
          <div key={g.key}>
            <h3 className={cn("mb-1.5 text-xs font-bold uppercase tracking-widest", g.tone)}>{g.label} · {rows.length}</h3>
            <div className="space-y-2">
              {/* All rows inline — the Other tab hides media_qa for non-editors,
                  so the old "All N →" link landed on an empty list (review). */}
              {rows.map((q) => <QcRow key={q.taskId} q={q} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DropboxChip({ label, n }: { label: string; n: number }) {
  return (
    <span
      // Hover explains the count — "Raw 150 ✓" reads as a mystery otherwise
      // (Jordan asked what these mean).
      title={
        label === "Raw"
          ? n > 0 ? `${n} raw files are in the job's Dropbox RAW folders` : "No files found in the job's Dropbox RAW folders yet"
          : n > 0 ? `${n} finished files are in the job's Dropbox FINAL folders` : "No finished files in the job's Dropbox FINAL folders yet"
      }
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        n > 0 ? "bg-success/15 text-success" : "bg-surface-2 text-muted-2",
      )}
    >
      {label} {n > 0 ? `${n} ✓` : "—"}
    </span>
  );
}

function QcRow({ q }: { q: OpsQcRow }) {
  const db = q.evidence.dropbox;
  return (
    <div className="rounded-xl border border-border px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <Link href={`/projects/${q.projectId}`} className="min-w-0 flex-1 truncate text-sm font-semibold hover:text-brand">{q.title}</Link>
        <span
          className="shrink-0 text-xs text-muted"
          title="Unticked boxes on this job's QC task — one per deliverable to check (photos, video, floor plan…). They tick themselves as each one goes live on Aryeo."
        >
          {q.itemsLeft} check{q.itemsLeft === 1 ? "" : "s"} left
        </span>
        {q.aryeoListingId && (
          <a
            href={`https://app.aryeo.com/listings/${q.aryeoListingId}`}
            target="_blank" rel="noopener noreferrer"
            title="Open the listing in Aryeo"
            className="shrink-0 rounded-lg border border-border p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <p className="mt-0.5 text-[13px] text-muted">
        {q.clientName}
        {q.shootISO ? ` · shot ${fmtDay(q.shootISO)}` : ""}
        {q.photographer ? ` · ${q.photographer}` : ""}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {q.services.slice(0, 5).map((s) => (
          <span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{s}</span>
        ))}
        {db && (
          <>
            <span className="mx-0.5 text-muted-2">·</span>
            <DropboxChip label="Raw" n={db.rawPhotos + db.rawVideo} />
            <DropboxChip label="Final" n={db.finalPhotos + db.finalVideo} />
          </>
        )}
        {q.evidence.missing.length > 0 && (
          <span className="text-[11px] font-medium text-warning">missing: {q.evidence.missing.join(", ")}</span>
        )}
      </div>
      {(q.debrief.removals || q.debrief.unsubmitted || q.notCompleted.length > 0) && (
        <div className="mt-1.5 space-y-0.5 text-[13px]">
          {q.debrief.unsubmitted && <p className="font-medium text-danger">Upload page never submitted — treat the gallery as unculled.</p>}
          {q.notCompleted.map((nc, i) => (
            <p key={i} className="font-medium text-warning">
              Couldn&rsquo;t complete {nc.label}: <span className="font-normal text-foreground/80">{nc.reason.slice(0, 160)}</span>
            </p>
          ))}
          {q.debrief.removals && <p className="text-foreground/80"><span className="font-semibold">Remove in editing:</span> {q.debrief.removals.slice(0, 140)}</p>}
        </div>
      )}
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
