import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarCheck, CalendarDays, Camera, ClipboardList, Clock, DollarSign, Eye, FileText, Lightbulb, Mail,
  MessageSquare, Plus, RefreshCw, Scissors, Send, TrendingUp, Upload, Users, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { cn } from "@/lib/utils";
import { etDate, etDateTime, etFullDate, etMinutesOfDay, etMonthDay, etTime } from "@/lib/datetime";
import { listAssignees, type Assignee } from "@/lib/assignees";
import { prisma } from "@/lib/prisma";
import { syntheticClientIds } from "@/lib/syntheticClients";
import {
  clientIssuesSection, financialPosition, productionHealth, teamCoverage, weeklyPerformance,
  type ClientIssues, type FinancialPosition, type ProductionHealth, type StageKey, type TeamCoverage, type Tone, type WeeklyPerformance,
} from "@/lib/ownerDashboard";
import {
  creativeDecisions, delegatedByMe, emailNeedingReply, meetingsSection, EMAIL_CLASS_WORDS,
  type CreativeDecisions, type DelegatedByMe, type EmailSection, type Meetings,
} from "@/lib/ownerWork";
import { OwnerShell, PanelButton, PRIMARY, QUIET } from "@/components/owner/OwnerShell";
import { RevenueMonthPanel } from "@/components/finance/RevenueMonthPanel";
import { StripeCard } from "@/components/finance/StripeCard";
import type { ListRow, PanelSpec, RosterOption } from "@/components/owner/panelTypes";

// ---------------------------------------------------------------------------
// JORDAN'S DASHBOARD (Oct 23 2026, his spec §4 and his mockup): "/" for the
// owner. Business oversight first (money, production, clients, team), then
// his own work (meetings, scripts, email, what he delegated), then the week.
// Each section is its own streamed read and owns its failure: a section that
// can't load says so in its card, never a reassuring zero. Concise rows with
// "View all"; detail, assignment and replies open in a side panel.
// Owner only: money appears on no other screen's home.
// ---------------------------------------------------------------------------

const CARD = "panel-shadow rounded-2xl border border-border bg-surface";
const SHOWN = 4;
const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-danger" };
const TONE_TILE: Record<Tone, string> = { ok: "bg-success/10", warn: "bg-warning/10", bad: "bg-danger/10" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-success", warn: "text-warning", bad: "text-danger" };

function Card({ title, id, right, children, className }: { title: string; id: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(CARD, "min-w-0 p-4 sm:p-5", className)} data-section={id}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="mr-auto text-lg font-semibold tracking-tight">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Loading({ label }: { label: string }) {
  return <div role="status" className={cn(CARD, "flex min-h-24 items-center px-5 text-sm text-muted")}>{label}</div>;
}

function Unavailable({ what }: { what: string[] }) {
  if (!what.length) return null;
  return <p role="status" data-unavailable className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Couldn&rsquo;t load {what.join(", ")}. This is not an empty list; refresh to try again.</p>;
}

function ViewAll({ spec, n }: { spec: PanelSpec; n: number }) {
  return (
    <PanelButton spec={spec} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">
      View all{n ? ` (${n})` : ""} <ArrowRight aria-hidden className="size-4" />
    </PanelButton>
  );
}

const hoursWords = (h: number | null) => (h == null ? null : h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

// =====================================================================================
// A. FINANCIAL POSITION
// =====================================================================================

const FIGURE_ICON = { cash: Wallet, obligations: CalendarDays, collections: TrendingUp, forecast: BarChart3, profit: DollarSign } as const;

async function FinanceSection({ p }: { p: Promise<FinancialPosition | null> }) {
  const f = await p;
  return (
    <Card title="Financial Position" id="finance" right={<Link href="/sales" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">View finances <ArrowRight aria-hidden className="size-4" /></Link>}>
      {!f ? (
        <Unavailable what={["the financial position"]} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-0 lg:divide-x lg:divide-border">
            {f.figures.map((x) => {
              const Icon = FIGURE_ICON[x.key];
              return (
                <Link key={x.key} href={x.href} data-figure={x.key} data-value={x.value == null ? "unknown" : String(x.value)} className="group flex min-w-0 gap-2.5 rounded-xl p-1 hover:bg-surface-2/60 lg:px-4">
                  <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand" />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">{x.label}{x.tag && <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">{x.tag}</span>}</p>
                    <p className={cn("text-xl font-bold tabular-nums sm:text-2xl", x.value == null && "text-base font-semibold text-muted sm:text-lg", x.tone && TONE_TEXT[x.tone])}>{x.display}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">{x.sub}</p>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
            <RevenueMonthPanel r={f.revenue} />
            <StripeCard s={f.stripe} inset />
          </div>
          <p className="mt-3 text-[11px] text-muted">{f.period} · {f.sources}</p>
          <p className="text-[11px] text-muted" data-freshness>Freshness: {f.freshness}</p>
          {f.limitations.length > 0 && (
            <details className="mt-1 text-[12px] text-muted">
              <summary className="min-h-8 cursor-pointer py-1 font-medium">What these figures leave out ({f.limitations.length})</summary>
              <ul className="list-disc space-y-1 pl-5">{f.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

// =====================================================================================
// B. PRODUCTION HEALTH + BOTTLENECKS
// =====================================================================================

const STAGE_ICON: Record<StageKey, typeof FileText> = { pre: FileText, capture: Camera, editing: Scissors, review: Eye, delivery: Send };

async function ProductionSection({ p }: { p: Promise<ProductionHealth | null> }) {
  const h = await p;
  if (!h) return <Card title="Production health" id="production"><Unavailable what={["production"]} /></Card>;
  const shown = h.bottlenecks.slice(0, 5);
  const bottleneckRows: ListRow[] = h.bottlenecks.map((b) => ({ id: b.id, title: b.issue, sub: [b.owner, b.handledBy?.words, b.nextStep, b.clientUpdate].filter(Boolean).join(" · "), tone: b.tone, href: b.href, assign: b.taskId ? null : b.assign }));
  return (
    <Card title="Production health" id="production">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {h.stages.map((s) => {
          const Icon = STAGE_ICON[s.key];
          const spec: PanelSpec = {
            kind: "list",
            title: s.label,
            subtitle: [`${s.counts.total} in this stage`, s.counts.overdue ? `${s.counts.overdue} overdue` : null, s.counts.dueSoon ? `${s.counts.dueSoon} due by the end of the next business day` : null, s.counts.blocked ? `${s.counts.blocked} blocked or unassigned` : null].filter(Boolean).join(" · "),
            rows: s.items.map((i) => ({ id: i.id, title: `${i.street}: ${i.what}`, sub: [i.client, i.owner, i.dueISO ? `${i.late ? "Was due" : "Due"} ${etDateTime(i.dueISO)}` : null, i.blocked].filter(Boolean).join(" · "), tone: i.late || i.blocked ? "bad" : i.dueSoon ? "warn" : "ok", href: i.href })),
            empty: s.unavailable ?? "Nothing in this stage right now.",
          };
          return (
            <PanelButton key={s.key} spec={spec} label={`${s.label}: open the list`} className={cn("flex min-h-28 flex-col items-start gap-1 rounded-xl p-3 text-left", s.unavailable ? "bg-surface-2" : TONE_TILE[s.tone])}>
              <span className="flex items-center gap-1.5 text-sm font-semibold"><Icon aria-hidden className="size-4" /> {s.label}</span>
              <span data-stage={s.key} data-count={s.unavailable ? "?" : String(s.headline.n)} data-total={s.unavailable ? "?" : String(s.counts.total)} className="flex items-baseline gap-1.5">
                <b className={cn("text-2xl font-bold tabular-nums", !s.unavailable && TONE_TEXT[s.tone])}>{s.unavailable ? "?" : s.headline.n}</b>
                <span className="text-[13px] text-muted">{s.unavailable ? "couldn't load" : s.headline.words}</span>
              </span>
              {!s.unavailable && (
                <span className="text-[11px] leading-snug text-muted">
                  {[s.counts.overdue ? `${s.counts.overdue} overdue` : null, s.counts.dueSoon ? `${s.counts.dueSoon} due soon` : null, s.counts.blocked ? `${s.counts.blocked} blocked` : null, hoursWords(s.oldestWaitHours) ? `oldest ${hoursWords(s.oldestWaitHours)}` : null, s.nextOwner ? `next: ${s.nextOwner}` : null].filter(Boolean).join(" · ") || "Nothing waiting"}
                </span>
              )}
            </PanelButton>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted" data-punctuality>{h.punctuality}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <h4 className="mr-auto text-base font-semibold">Bottlenecks requiring action</h4>
        {h.bottlenecks.length > shown.length && <ViewAll n={h.bottlenecks.length} spec={{ kind: "list", title: "Bottlenecks requiring action", rows: bottleneckRows }} />}
      </div>
      <Unavailable what={h.unavailable} />
      {shown.length === 0 ? (
        !h.unavailable.length && <p className="mt-2 text-sm text-muted" data-empty="bottlenecks">No late, blocked or unowned work right now.</p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl border border-border" data-bottlenecks={h.bottlenecks.length}>
          <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-3 bg-surface-2/60 px-3 py-2 text-[12px] font-medium text-muted md:grid">
            <span>Issue</span><span>Owner</span><span>Next step</span><span className="w-32">Action</span>
          </div>
          <ul className="divide-y divide-border">
            {shown.map((b) => (
              <li key={b.id} className="grid gap-x-3 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center" data-bottleneck={b.id}>
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium"><span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[b.tone])} aria-hidden /><Link href={b.href} className="[overflow-wrap:anywhere] hover:underline">{b.issue}</Link></p>
                  <p className="text-[12px] text-muted">{[b.client, b.commitment, b.clientUpdate].filter(Boolean).join(" · ")}</p>
                </div>
                <p className="text-sm"><span className="md:hidden text-muted">Owner: </span>{b.owner}{b.handledBy && <span className="block text-[12px] text-muted">{b.handledBy.words}</span>}</p>
                <p className="text-sm"><span className="md:hidden text-muted">Next: </span>{b.nextStep}</p>
                <div className="md:w-32">
                  {b.taskId ? (
                    <TaskOpen taskId={b.taskId} label={b.handledBy?.words.startsWith("Escalated") || b.handledBy?.words.startsWith("Recommended") ? "Decide" : "Request update"} />
                  ) : (
                    <PanelButton spec={{ kind: "assign", seed: b.assign, heading: "Assign" }} className={cn(QUIET, "w-full")}>Assign</PanelButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** A delegated task's panel, opened by id (the task is read here, server side). */
async function TaskOpen({ taskId, label, className = "w-full" }: { taskId: string; label: string; className?: string }) {
  const { delegationFor, resurfaceOf } = await import("@/lib/delegation");
  const v = (await delegationFor([taskId]).catch(() => new Map())).get(taskId);
  if (!v) return <Link href="/" className={cn(QUIET, className)}>{label}</Link>;
  return <PanelButton spec={{ kind: "task", task: { ...v, resurface: resurfaceOf(v, new Date()) } }} className={cn(QUIET, className)}>{label}</PanelButton>;
}

// =====================================================================================
// C. CLIENT ISSUES
// =====================================================================================

const SEV: Record<"high" | "medium" | "low", { bar: string; chip: string; word: string }> = {
  high: { bar: "bg-danger", chip: "bg-danger/10 text-danger", word: "High priority" },
  medium: { bar: "bg-warning", chip: "bg-warning/15 text-warning", word: "Medium" },
  low: { bar: "bg-border-strong", chip: "bg-surface-2 text-muted", word: "Low" },
};

async function ClientIssuesSection({ p }: { p: Promise<ClientIssues | null> }) {
  const c = await p;
  const rows = c?.rows ?? [];
  const all: ListRow[] = rows.map((r) => ({ id: r.id, title: `${r.client ?? "A client"}: ${r.title}`, sub: [r.suggested ? "Suggested flag" : SEV[r.severity].word, r.handledBy ? r.handledBy.words : r.owner ? `Owner ${r.owner}` : "No owner yet", r.nextAction].join(" · "), tone: r.severity === "high" ? "bad" : r.severity === "medium" ? "warn" : "ok", open: { kind: "issue", row: r } }));
  return (
    <Card title="Client issues" id="client-issues" right={rows.length > 3 ? <ViewAll n={rows.length} spec={{ kind: "list", title: "Client issues", rows: all }} /> : undefined}>
      {!c ? <Unavailable what={["client issues"]} /> : <Unavailable what={c.unavailable} />}
      {c && rows.length === 0 && !c.unavailable.length && <p className="text-sm text-muted" data-empty="client-issues">No open complaints, negative feedback, repeated revisions, cancellations or refunds in the last 30 days.</p>}
      <ul className="space-y-3" data-client-issues={rows.length}>
        {rows.slice(0, 3).map((r) => (
          <li key={r.id} className="relative overflow-hidden rounded-xl border border-border py-3 pl-4 pr-3" data-issue={r.id}>
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", SEV[r.severity].bar)} />
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <span className="[overflow-wrap:anywhere]">{r.client ?? "A client"} · {r.title}</span>
              <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", r.suggested ? "bg-warning/15 text-warning" : SEV[r.severity].chip)}>{r.suggested ? "Suggested flag" : SEV[r.severity].word}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap items-end gap-x-6 gap-y-2">
              <p className="text-[13px]"><span className="block text-[11px] text-muted">Owner</span>{r.owner ?? "Nobody yet"}{r.handledBy && <span className="block text-[11px] text-muted" data-issue-handled>{r.handledBy.words}</span>}</p>
              <p className="text-[13px]"><span className="block text-[11px] text-muted">{r.deadlineISO ? "Due" : "Next"}</span>{r.deadlineISO ? etDateTime(r.deadlineISO) : r.nextAction}</p>
              <div className="ml-auto flex gap-2">
                <PanelButton spec={{ kind: "issue", row: r }} className={PRIMARY}>Review</PanelButton>
                {/* Given to someone already: open their task (see it, nudge, reassign), not Assign again. */}
                {r.handledBy
                  ? <TaskOpen taskId={r.handledBy.taskId} label="Request update" className="" />
                  : <PanelButton spec={{ kind: "assign", seed: r.assign, heading: "Assign recovery" }}>Assign</PanelButton>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// =====================================================================================
// D. TEAM COVERAGE
// =====================================================================================

async function TeamSection({ p, nowMs }: { p: Promise<TeamCoverage | null>; nowMs: number }) {
  const t = await p;
  if (!t) return <Card title="Team coverage" id="team"><Unavailable what={["team coverage"]} /></Card>;
  const workload: ListRow[] = [
    ...Object.values(t.byPerson).flat().map((d) => ({ id: d.taskId, title: `${d.assigneeName ?? "Nobody"}: ${d.title}`, sub: [d.state === "ASSIGNED" ? "Awaiting acceptance" : d.state.toLowerCase().replace(/_/g, " "), d.dueAt ? `due ${etDateTime(d.dueAt)}` : null, d.assignedBy ? `from ${d.assignedBy}` : null].filter(Boolean).join(" · "), tone: (d.dueAt && Date.parse(d.dueAt) < nowMs ? "bad" : d.state === "ASSIGNED" ? "warn" : "ok") as Tone })),
    ...t.unassigned.map((u) => ({ id: `un:${u.what}`, title: `${u.count} ${u.what.charAt(0).toLowerCase()}${u.what.slice(1)}`, sub: u.what.includes(" while off") ? "Booked on someone who is off" : "Unassigned", tone: "bad" as Tone, href: u.href })),
    ...t.timeOff.map((o, i) => ({ id: `off:${i}`, title: `${o.name}: ${o.words}`, sub: "Time off", tone: "warn" as Tone })),
  ];
  return (
    <Card title="Team coverage" id="team" right={<ViewAll n={0} spec={{ kind: "list", title: "Team workload", subtitle: t.note, rows: workload, empty: "No open assignments, unassigned work or time off on record." }} />}>
      <Unavailable what={t.unavailable} />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.4fr)] gap-2 bg-surface-2/60 px-3 py-2 text-[12px] font-medium text-muted"><span>Person</span><span>Area</span><span>Status</span></div>
        <ul className="divide-y divide-border" data-coverage={t.rows.length}>
          {t.rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.4fr)] items-center gap-2 px-3 py-2.5 text-sm">
              <span className="font-medium [overflow-wrap:anywhere]">{r.person}</span>
              <span className="[overflow-wrap:anywhere]">{r.area}</span>
              <span className={cn("flex items-start gap-1.5", TONE_TEXT[r.tone])}><span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[r.tone])} /><span className="[overflow-wrap:anywhere]">{r.status}</span></span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto flex items-center gap-1.5 text-sm text-muted" data-awaiting={t.awaitingAcceptance.length}><Users aria-hidden className="size-4" /> {t.awaitingAcceptance.length} assignment{t.awaitingAcceptance.length === 1 ? "" : "s"} awaiting acceptance{t.overdue.length ? ` · ${t.overdue.length} overdue` : ""}</p>
        <PanelButton spec={{ kind: "list", title: "Team workload", subtitle: t.note, rows: workload, empty: "No open assignments, unassigned work or time off on record." }}>Review workload</PanelButton>
      </div>
    </Card>
  );
}

// =====================================================================================
// E. MEETINGS & PREPARATION
// =====================================================================================

async function MeetingsSection({ p }: { p: Promise<Meetings | null> }) {
  const m = await p;
  const rows = m?.rows ?? [];
  const chip = m ? (
    <span data-calendly={m.calendly.state} className={cn("inline-flex items-center gap-1.5 text-[12px]", m.calendly.state === "connected" ? "text-muted" : "font-medium text-warning")}>
      <CalendarCheck aria-hidden className="size-4" />{m.calendly.words}
    </span>
  ) : null;
  const all: ListRow[] = rows.map((r) => ({ id: r.id, title: `${etDateTime(r.startISO)}: ${r.type}, ${r.who}`, sub: [r.prep.words, ...r.missing].join(" · "), tone: r.prep.tone, open: { kind: "meeting", row: r } }));
  return (
    <Card title="Meetings & preparation" id="meetings" right={<>{chip}{rows.length > 3 && <ViewAll n={rows.length} spec={{ kind: "list", title: "Meetings in the next 14 days", rows: all }} />}</>}>
      {!m ? <Unavailable what={["meetings"]} /> : <Unavailable what={m.unavailable} />}
      {m && rows.length === 0 && !m.unavailable.length && (
        <p className="text-sm text-muted" data-empty="meetings">{m.calendly.state === "connected" ? "No program calls booked in the next 14 days." : "Meetings can't be checked until Calendly is read again."}</p>
      )}
      <ul className="space-y-3" data-meetings={rows.length}>
        {rows.slice(0, 3).map((r) => (
          <li key={r.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 rounded-xl border border-border p-3" data-meeting={r.id}>
            <div className="text-sm"><p className="font-semibold">{etDate(r.startISO)}</p><p className="text-muted">{etTime(r.startISO)}</p></div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{r.type}<span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", r.prep.tone === "ok" ? "bg-success/15 text-success" : r.prep.tone === "bad" ? "bg-danger/10 text-danger" : "bg-warning/15 text-warning")} data-prep={r.prep.words}>{r.missing[0] ?? (r.prep.words.startsWith("Prep ready") ? "Prep ready" : r.prep.words.split(" · ")[0])}</span></p>
              <p className="text-[13px] text-muted">{r.who} · {r.purpose}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <PanelButton spec={{ kind: "meeting", row: r }}>Open brief</PanelButton>
                {r.assignPrep && <PanelButton spec={{ kind: "assign", seed: r.assignPrep, heading: "Assign preparation" }}>Assign prep</PanelButton>}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {m && <p className="mt-3 text-[11px] text-muted" data-calendar-note>{m.calendarNote} {m.scopeNote}</p>}
    </Card>
  );
}

// =====================================================================================
// F. SCRIPTS & CREATIVE DECISIONS
// =====================================================================================

async function CreativeSection({ p }: { p: Promise<CreativeDecisions | null> }) {
  const c = await p;
  const rows = c?.rows ?? [];
  const all: ListRow[] = rows.map((r) => ({ id: r.id, title: `${r.kind === "listing" ? "Listing script" : "Monthly content"}: ${r.client}, ${r.what}`, sub: `Writing: ${r.writer} · Approval: ${r.approver}${r.related ? ` · ${r.related}` : ""}`, tone: r.tone, href: r.href, assign: r.assign }));
  return (
    <Card title="Scripts & creative decisions" id="creative" right={c ? <span className="flex flex-wrap gap-1.5 text-[11px] font-semibold"><span className="rounded-md bg-warning/15 px-2 py-1 text-warning">Jordan owns {c.jordanOwns}</span><span className="rounded-md bg-waiting-soft px-2 py-1 text-waiting">Others draft {c.othersDraft}</span>{rows.length > SHOWN && <ViewAll n={rows.length} spec={{ kind: "list", title: "Scripts & creative decisions", rows: all }} />}</span> : undefined}>
      {!c ? <Unavailable what={["scripts"]} /> : <Unavailable what={c.unavailable} />}
      {c && rows.length === 0 && !c.unavailable.length && <p className="text-sm text-muted" data-empty="creative">No scripts or creative decisions waiting on you.</p>}
      <ul className="space-y-2.5" data-creative={rows.length}>
        {rows.slice(0, SHOWN).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3" data-creative-row={r.kind}>
            {r.kind === "listing" ? <FileText aria-hidden className="size-5 shrink-0 text-brand" /> : <Lightbulb aria-hidden className="size-5 shrink-0 text-brand" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold [overflow-wrap:anywhere]">{r.kind === "listing" ? "Listing script" : "Monthly content"} · {r.client}</p>
              <p className="text-[13px] [overflow-wrap:anywhere]">{r.what}</p>
              <p className="text-[12px] text-muted">Writing: {r.writer} · Approval: {r.approver}{r.related ? ` · ${r.related}` : ""}</p>
            </div>
            <div className="flex gap-2">
              <Link href={r.href} className={QUIET}>Review</Link>
              <PanelButton spec={{ kind: "assign", seed: r.assign, heading: "Delegate" }}>Delegate</PanelButton>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// =====================================================================================
// G. EMAIL NEEDING MY REPLY
// =====================================================================================

async function EmailSectionView({ p }: { p: Promise<EmailSection | null> }) {
  const e = await p;
  const rows = e?.rows ?? [];
  const all: ListRow[] = rows.map((r) => ({ id: r.key, title: `${r.sender}: ${r.subject}`, sub: [EMAIL_CLASS_WORDS[r.cls], r.handledBy, `waiting since ${etDateTime(r.waitingSinceISO)}`].filter(Boolean).join(" · "), tone: r.cls === "reply" || r.cls === "decide" ? "bad" : "ok", open: { kind: "email", row: r } }));
  const needYou = rows.filter((r) => r.cls === "reply" || r.cls === "decide");
  return (
    <Card title="Email needing my reply" id="email" right={rows.length > 3 ? <ViewAll n={rows.length} spec={{ kind: "list", title: "Email in your inbox waiting on an answer", rows: all }} /> : undefined}>
      {!e ? <Unavailable what={["email"]} /> : e.unavailable.length ? <p role="status" data-unavailable className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">{e.note}</p> : null}
      {e && !e.unavailable.length && (
        <p className="mb-2 text-[12px] text-muted" data-email-counts={JSON.stringify(e.counts)}>
          {e.counts.reply} to reply · {e.counts.decide} to decide · {e.counts.team} the team can handle · {e.counts.waiting} waiting on someone else
        </p>
      )}
      {e && !e.unavailable.length && rows.length === 0 && <p className="text-sm text-muted" data-empty="email">No client email in your inbox is waiting on an answer.</p>}
      <ul className="space-y-2.5" data-email={rows.length}>
        {(needYou.length ? needYou : rows).slice(0, 3).map((r) => (
          <li key={r.key} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto]" data-email-row={r.cls}>
            <div className="flex min-w-0 gap-2.5">
              <Mail aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="text-sm font-semibold [overflow-wrap:anywhere]">{r.sender}</p>
                <p className="text-[12px] text-muted [overflow-wrap:anywhere]">Re: {r.subject}</p>
                <p className="mt-1 text-[13px] [overflow-wrap:anywhere]"><b className="font-medium">{EMAIL_CLASS_WORDS[r.cls]}</b>{r.handledBy ? ` · ${r.handledBy}` : ""} · {r.businessHours != null ? `${r.businessHours} business h` : etDateTime(r.waitingSinceISO)}</p>
              </div>
            </div>
            <div className="flex gap-2 sm:flex-col">
              <PanelButton spec={{ kind: "email", row: r }} className={PRIMARY}>Reply</PanelButton>
              <PanelButton spec={{ kind: "assign", seed: r.assign, heading: "Delegate this email" }}>Delegate</PanelButton>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// =====================================================================================
// H. DELEGATED BY ME
// =====================================================================================

const STATE_DOT: Record<string, string> = { ASSIGNED: "bg-warning", ACCEPTED: "bg-success", IN_PROGRESS: "bg-waiting", BLOCKED: "bg-danger", READY_FOR_VERIFICATION: "bg-brand", COMPLETED: "bg-success", CANCELLED: "bg-border-strong" };
const STATE_WORD: Record<string, string> = { ASSIGNED: "Awaiting acceptance", ACCEPTED: "Accepted", IN_PROGRESS: "In progress", BLOCKED: "Blocked", READY_FOR_VERIFICATION: "Ready to verify", COMPLETED: "Completed", CANCELLED: "Cancelled" };

async function DelegatedSection({ p }: { p: Promise<DelegatedByMe | null> }) {
  const d = await p;
  const rows = d?.rows ?? [];
  const all: ListRow[] = rows.map((r) => ({ id: r.taskId, title: r.title, sub: [r.assigneeName ?? "Nobody", STATE_WORD[r.state], r.dueAt ? `due ${etDateTime(r.dueAt)}` : null, r.resurface?.words].filter(Boolean).join(" · "), tone: r.resurface ? "bad" : r.state === "COMPLETED" ? "ok" : "warn", open: { kind: "task", task: r } }));
  const flagged = rows.find((r) => r.resurface);
  return (
    <Card title="Delegated by me" id="delegated" right={rows.length > 5 ? <ViewAll n={rows.length} spec={{ kind: "list", title: "Delegated by me", subtitle: "Open first; completed and cancelled ones stay 7 days with their evidence.", rows: all }} /> : undefined}>
      {!d ? <Unavailable what={["your assignments"]} /> : <Unavailable what={d.unavailable} />}
      {d && rows.length === 0 && !d.unavailable.length && <p className="text-sm text-muted" data-empty="delegated">Nothing delegated yet. Use Assign task, or Assign beside any row.</p>}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-2 bg-surface-2/60 px-3 py-2 text-[12px] font-medium text-muted"><span>Task</span><span>Owner</span><span>Status</span><span>Deadline</span></div>
          <ul className="divide-y divide-border" data-delegated={d?.open ?? 0} data-flagged={d?.flagged ?? 0}>
            {rows.slice(0, 5).map((r) => (
              <li key={r.taskId} data-delegated-row={r.taskId} data-state={r.state}>
                <PanelButton spec={{ kind: "task", task: r }} label={`Open ${r.title}`} className="grid min-h-11 w-full grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2/60">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{r.resurface && <AlertTriangle aria-label="Needs your follow-up" className="mr-1 inline size-3.5 text-danger" />}{r.title}</span>
                  <span className="[overflow-wrap:anywhere]">{r.assigneeName ?? "Nobody"}</span>
                  <span className="flex items-center gap-1.5"><span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[r.state])} />{STATE_WORD[r.state]}</span>
                  <span className={cn("tabular-nums", r.resurface?.kind === "overdue" && "font-semibold text-danger")}>{r.dueAt ? etDateTime(r.dueAt) : "None"}</span>
                </PanelButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {flagged && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-[13px] text-danger">{flagged.resurface!.words}: {flagged.title}</p>
          <PanelButton spec={{ kind: "task", task: flagged }} className={PRIMARY}>Follow up</PanelButton>
        </div>
      )}
    </Card>
  );
}

// =====================================================================================
// I. WEEKLY PERFORMANCE
// =====================================================================================

const MEASURE_ICON: Record<string, typeof Clock> = { photos: Camera, videos: Clock, revisions: RefreshCw, replies: MessageSquare, shoots: CalendarCheck, quality: ClipboardList, week: Upload };

async function WeeklySection({ p }: { p: Promise<WeeklyPerformance | null> }) {
  const w = await p;
  return (
    <Card title="Weekly performance" id="weekly" right={w ? <PanelButton spec={{ kind: "info", title: "Metric definitions", lines: w.measures.map((m) => ({ label: m.label, value: `${m.detail}. Period: ${m.period}. Source: ${m.source || "n/a"}.` })) }} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">View metric definitions <ArrowRight aria-hidden className="size-4" /></PanelButton> : undefined}>
      {!w ? <Unavailable what={["this week's figures"]} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {w.measures.map((m) => {
              const Icon = MEASURE_ICON[m.key] ?? Clock;
              return (
                <div key={m.key} className="flex min-w-0 gap-2.5 rounded-xl border border-border p-3" data-measure={m.key}>
                  <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", m.tone ? TONE_TEXT[m.tone] : "text-muted")} />
                  <div className="min-w-0">
                    <p className="text-[12px] text-muted">{m.label}</p>
                    <p className="text-lg font-bold tabular-nums">{m.value}</p>
                    <p className="text-[11px] leading-snug text-muted">{m.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted">Each measure&rsquo;s period and source are under View metric definitions. Services are never averaged together. Updated {etTime(w.updatedISO)} ET.</p>
        </>
      )}
    </Card>
  );
}

// =====================================================================================
// THE PAGE
// =====================================================================================

export async function OwnerHome({ me, includeTest = false, now: at }: {
  me: { email: string; name: string | null; impersonating: boolean } | null;
  includeTest?: boolean;
  now?: Date;
}) {
  const now = at ?? new Date();
  const roster: Assignee[] = await listAssignees().catch(() => []);
  const people: RosterOption[] = roster.filter((a) => a.kind !== "vendor" && a.key !== "creative_director").map((a) => ({ key: a.key, name: a.name }));
  const exclude = includeTest ? [] : await syntheticClientIds().catch(() => [] as string[]);
  const ownerEmail = me?.email?.toLowerCase() ?? null;
  // The owner signs in with more than one address; each is him.
  const ownerEmails = [...new Set([...(await prisma.appUser.findMany({ where: { role: "OWNER", status: "ACTIVE" }, select: { email: true } }).catch(() => [] as { email: string }[])).map((u) => u.email.toLowerCase()), ...(ownerEmail ? [ownerEmail] : [])])];
  const soft = <T,>(what: string, p: Promise<T>): Promise<T | null> => p.catch((e: unknown) => { console.warn(`owner home: ${what} failed`, (e as Error)?.message); return null; });

  const financeP = soft("finance", financialPosition({ now, excludeClientIds: exclude }));
  const productionP = soft("production", productionHealth({ now, includeTest, excludeClientIds: exclude, roster, ownerEmail }));
  const issuesP = soft("client issues", clientIssuesSection({ now, excludeClientIds: exclude }));
  const teamP = soft("team", productionP.then((production) => teamCoverage({ now, includeTest, roster, production })));
  const meetingsP = soft("meetings", meetingsSection({ now, excludeClientIds: exclude }));
  const creativeP = soft("creative", creativeDecisions({ now, excludeClientIds: exclude, ownerEmail, ownerEmails }));
  const emailP = soft("email", emailNeedingReply({ now, excludeClientIds: exclude }));
  const delegatedP = soft("delegated", delegatedByMe({ now, email: ownerEmail, emails: ownerEmails }));
  const weeklyP = soft("weekly", weeklyPerformance({ now, excludeClientIds: exclude }));

  const minute = etMinutesOfDay(now);
  const first = me?.name?.trim().split(/\s+/)[0] ?? "Jordan";
  return (
    <OwnerShell roster={people} readOnly={!!me?.impersonating}>
      <AutoRefresh seconds={120} />
      <PageHeader
        eyebrow="Dashboard"
        title={`${minute < 12 * 60 ? "Good morning" : minute < 18 * 60 ? "Good afternoon" : "Good evening"}, ${first}`}
        subtitle={`Business oversight & your work · ${etFullDate(now)} · updated ${etTime(now)} ET`}
        actions={<PanelButton spec={{ kind: "assign", seed: { title: "" }, heading: "Assign a task" }} className={PRIMARY}><Plus aria-hidden className="size-4" /> Assign task</PanelButton>}
      />
      <div className="mx-auto max-w-7xl space-y-5 p-4 pb-16 sm:p-6">
        {includeTest && (
          <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <p className="font-semibold">Showing real and test records on the dashboard</p>
            <p className="mt-1 text-muted">The lists you open from here show their own default view. Figures from the books keep Finance&rsquo;s existing definitions.</p>
          </div>
        )}
        <Suspense fallback={<Loading label="Reading the money…" />}><FinanceSection p={financeP} /></Suspense>

        <h2 className="pt-2 text-xl font-bold tracking-tight">Business oversight</h2>
        <Suspense fallback={<Loading label="Reading production…" />}><ProductionSection p={productionP} /></Suspense>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading client issues…" />}><ClientIssuesSection p={issuesP} /></Suspense>
          <Suspense fallback={<Loading label="Reading team coverage…" />}><TeamSection p={teamP} nowMs={now.getTime()} /></Suspense>
        </div>

        <h2 className="flex items-center gap-3 pt-2 text-xl font-bold tracking-tight">My work<span aria-hidden className="h-px flex-1 bg-border" /></h2>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading meetings…" />}><MeetingsSection p={meetingsP} /></Suspense>
          <Suspense fallback={<Loading label="Reading scripts…" />}><CreativeSection p={creativeP} /></Suspense>
        </div>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading email…" />}><EmailSectionView p={emailP} /></Suspense>
          <Suspense fallback={<Loading label="Reading your assignments…" />}><DelegatedSection p={delegatedP} /></Suspense>
        </div>
        <Suspense fallback={<Loading label="Counting this week…" />}><WeeklySection p={weeklyP} /></Suspense>
        <p className="text-[11px] text-muted">Read {etMonthDay(now)} at {etTime(now)} ET. Every count opens the list it counts.</p>
      </div>
    </OwnerShell>
  );
}
