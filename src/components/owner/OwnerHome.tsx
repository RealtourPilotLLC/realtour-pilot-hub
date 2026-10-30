import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarCheck, CalendarDays, Camera, ClipboardList, Clock, DollarSign, Eye, FileText, Lightbulb, Mail,
  MessageSquare, Plus, RefreshCw, Scissors, Send, TrendingUp, Upload, Users, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
// Oct 27 2026 Loom (26:50): a Messages button on the main dashboards.
import { MessagesButton } from "@/components/comms/MessagesButton";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { cn } from "@/lib/utils";
import { etDate, etDateTime, etFullDate, etMinutesOfDay, etMonthDay, etTime } from "@/lib/datetime";
import { listAssignees, type Assignee } from "@/lib/assignees";
import { prisma } from "@/lib/prisma";
import { syntheticClientIds } from "@/lib/syntheticClients";
import {
  clientIssuesSection, financialPosition, productionHealth, teamCoverage, weeklyPerformance,
  type ClientIssues, type FinancialPosition, type Measure, type ProductionHealth, type RowAction, type StageKey, type TeamCoverage, type Tone, type WeeklyPerformance,
} from "@/lib/ownerDashboard";
import type { BottleneckTopic } from "@/lib/ownerTopicsCore";
import type { DelegatedTaskView } from "@/lib/delegation";
import {
  creativeDecisions, delegatedByMe, emailNeedingReply, meetingsSection, EMAIL_CLASS_WORDS,
  type CreativeDecisions, type DelegatedByMe, type DelegatedRow, type EmailSection, type Meetings,
} from "@/lib/ownerWork";
import { OwnerShell, PanelButton, RowActionButton, PRIMARY, QUIET } from "@/components/owner/OwnerShell";
import { RevenueMonthPanel } from "@/components/finance/RevenueMonthPanel";
import { StripeCard } from "@/components/finance/StripeCard";
import type { ListRow, PanelSpec, RosterOption, ShellAction } from "@/components/owner/panelTypes";

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
const SHOWN = 3;
const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-danger" };
const TONE_TILE: Record<Tone, string> = { ok: "bg-success/10", warn: "bg-warning/10", bad: "bg-danger/10" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-success", warn: "text-warning", bad: "text-danger" };

// Paired cards stretch to the taller one (Oct 27 2026: "cards fit a two-column
// equal-height grid"); each card's footer sits on its bottom edge (mt-auto).
function Card({ title, id, right, children, className }: { title: string; id: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(CARD, "flex min-w-0 scroll-mt-20 flex-col p-4 sm:p-5", className)} data-section={id}>
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

/**
 * A row's button (Oct 27 2026). A plain function, not a component: a task's
 * panel needs the server's read (TaskOpen, streamed), every other kind runs
 * in the client shell (RowActionButton).
 */
function act(a: RowAction, i = 0, className?: string): ReactNode {
  if (a.kind === "task") return <TaskOpen key={`${a.kind}:${a.taskId}:${i}`} taskId={a.taskId} label={a.label} className={className ?? ""} />;
  return <RowActionButton key={`${a.kind}:${a.label}:${i}`} a={a} className={className} />;
}
/** The first button a list panel can run on its own. */
const shellAction = (actions: RowAction[]): ShellAction | null => (actions.find((a) => a.kind !== "task") as ShellAction | undefined) ?? null;

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
          {/* THE STRIP (Oct 27 2026, his mockup): five figures in one row, each
              opening where it comes from. The rail table, Stripe and the gaps
              fold under Details, closed. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-0 lg:divide-x lg:divide-border" data-finance-strip>
            {f.figures.map((x) => {
              const Icon = FIGURE_ICON[x.key];
              return (
                <Link key={x.key} href={x.href} title={x.sub} data-figure={x.key} data-value={x.value == null ? "unknown" : String(x.value)} className="group flex min-h-11 min-w-0 items-start gap-2.5 rounded-xl p-1 hover:bg-surface-2/60 lg:px-4">
                  <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10"><Icon className="size-4 text-brand" /></span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">{x.label}{x.tag && <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">{x.tag}</span>}</p>
                    <p className={cn("text-xl font-bold tabular-nums", x.value == null && "text-base font-semibold text-muted", x.tone && TONE_TEXT[x.tone])}>{x.display}</p>
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted">{x.sub}</p>
                  </div>
                </Link>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted" data-freshness>{f.period} · Freshness: {f.freshness}</p>
          <details className="group/details mt-1" data-finance-details>
            <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm font-semibold text-brand">Details: revenue by rail, Stripe, sources{f.limitations.length ? `, what's left out (${f.limitations.length})` : ""}</summary>
            <div className="mt-2 space-y-3">
              <div className="grid items-stretch gap-4 lg:grid-cols-2">
                <RevenueMonthPanel r={f.revenue} />
                <StripeCard s={f.stripe} inset />
              </div>
              <p className="text-[11px] text-muted">{f.period} · {f.sources}</p>
              {f.limitations.length > 0 && (
                <details className="text-[12px] text-muted">
                  <summary className="min-h-8 cursor-pointer py-1 font-medium">What these figures leave out ({f.limitations.length})</summary>
                  <ul className="list-disc space-y-1 pl-5">{f.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                </details>
              )}
            </div>
          </details>
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
  const shownTopics = h.topics.slice(0, 6);
  const rowsOf = new Map(await Promise.all(h.topics.map(async (t) => [t.key, await topicRows(t)] as const)));
  // A row whose only button is its task (an escalation: "Decide") opens that
  // task's panel right in the list, not a link away (Oct 28 2026).
  const panels = await taskPanels(h.bottlenecks.filter((b) => !shellAction(b.actions)).map((b) => b.taskId));
  const bottleneckRows: ListRow[] = h.bottlenecks.map((b) => {
    const open = b.taskId ? panels.get(b.taskId) ?? null : null;
    return { id: b.id, title: b.issue, sub: [b.owner, b.handledBy?.words, b.nextStep, b.clientUpdate].filter(Boolean).join(" · "), tone: b.tone, href: b.href, assign: b.taskId ? null : b.assign, action: shellAction(b.actions), open, openLabel: open ? b.actions.find((a) => a.kind === "task")?.label ?? null : null };
  });
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
                <span className="text-[11px] leading-snug text-muted" data-stage-detail={s.key}>
                  {s.detail ?? ([s.counts.overdue ? `${s.counts.overdue} overdue` : null, s.counts.dueSoon ? `${s.counts.dueSoon} due soon` : null, s.counts.blocked ? `${s.counts.blocked} blocked` : null, hoursWords(s.oldestWaitHours) ? `oldest ${hoursWords(s.oldestWaitHours)}` : null, s.nextOwner ? `next: ${s.nextOwner}` : null].filter(Boolean).join(" · ") || "Nothing waiting")}
                </span>
              )}
            </PanelButton>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted" data-punctuality>{h.punctuality}</p>

      {/* TOPICS, NOT RECORDS (Jordan's Loom, Oct 27 2026, 0:22: "I don't
          really want to see, like, late videos filling this up. I'd rather
          see like a topic here ... and then I can click on it to view it").
          One row per topic: what it is and its count; the records, their
          buttons and his moves open in the panel. Every record stays one
          press away under "View all". */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <h4 className="mr-auto text-base font-semibold">Bottlenecks requiring action</h4>
        {h.bottlenecks.length > 0 && <ViewAll n={h.bottlenecks.length} spec={{ kind: "list", title: "Bottlenecks requiring action", subtitle: "Every late, blocked or unowned record, one row each.", rows: bottleneckRows }} />}
      </div>
      <Unavailable what={h.unavailable} />
      {h.topics.length === 0 ? (
        !h.unavailable.length && <p className="mt-2 text-sm text-muted" data-empty="bottlenecks">No late, blocked or unowned work, and nothing that keeps coming back, right now.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border" data-topics={h.topics.length} data-bottlenecks={h.bottlenecks.length}>
          {shownTopics.map((t) => (
            <li key={t.key} data-topic={t.key} data-topic-count={t.count}>
              <PanelButton spec={{ kind: "topic", topic: t, rows: rowsOf.get(t.key) ?? [] }} label={`${t.title}: open`} className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2/60">
                <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[t.tone])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm [overflow-wrap:anywhere]"><b className="font-semibold">{t.title}</b>: {t.summary}</span>
                  <span className="block text-[12px] text-muted">{[t.handledBy?.words ?? (t.owner ? `Owner ${t.owner}` : null), t.window === "Now" ? null : t.window, t.source === "ai" ? "Grouped by AI" : null].filter(Boolean).join(" · ")}</span>
                </span>
                <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
              </PanelButton>
            </li>
          ))}
        </ul>
      )}
      {h.topics.length > shownTopics.length && (
        <p className="mt-2 text-[12px] text-muted" data-topics-more>{h.topics.length - shownTopics.length} more: <ViewAll n={h.topics.length} spec={{ kind: "list", title: "Every topic", rows: h.topics.map((t) => ({ id: t.key, title: `${t.title}: ${t.summary}`, sub: t.handledBy?.words ?? (t.owner ? `Owner ${t.owner}` : null), tone: t.tone, open: { kind: "topic" as const, topic: t, rows: rowsOf.get(t.key) ?? [] } })) }} /></p>
      )}
      {h.topicsNote && <p className="mt-2 text-[11px] text-muted" data-topics-note>{h.topicsNote}</p>}
    </Card>
  );
}

/** A topic's records as panel rows; a decision waiting on him opens its task (read here, server side). */
async function topicRows(t: BottleneckTopic): Promise<ListRow[]> {
  const ids = t.items.map((i) => i.taskId).filter((x): x is string => !!x);
  const views = ids.length ? await import("@/lib/delegation").then(async (m) => ({ m, v: await m.delegationFor(ids).catch(() => new Map()) })) : null;
  return t.items.map((i) => {
    const v = i.taskId && views ? views.v.get(i.taskId) : null;
    return { id: i.id, title: i.title, sub: i.sub, tone: i.tone, href: i.href, action: i.action, open: v && views ? { kind: "task" as const, task: { ...v, resurface: views.m.resurfaceOf(v, new Date()) } } : null };
  });
}

/** Delegated tasks' panels by id, read here (server side), so a list row can open its task in place. */
async function taskPanels(ids: (string | null | undefined)[]): Promise<Map<string, PanelSpec>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { delegationFor, resurfaceOf } = await import("@/lib/delegation");
  const views = await delegationFor(want).catch(() => new Map<string, DelegatedTaskView>());
  const now = new Date();
  return new Map([...views].map(([id, v]) => [id, { kind: "task" as const, task: { ...v, resurface: resurfaceOf(v, now) } }]));
}

/** A delegated task's panel, opened by id (the task is read here, server side). */
async function TaskOpen({ taskId, label, className = "w-full" }: { taskId: string; label: string; className?: string }) {
  const { delegationFor, resurfaceOf } = await import("@/lib/delegation");
  const v = (await delegationFor([taskId]).catch(() => new Map())).get(taskId);
  // Not readable as a delegation just now: the task's own row on Tasks, never back to this page (Oct 28 2026).
  if (!v) return <Link href={`/tasks?task=${encodeURIComponent(taskId)}`} className={cn(QUIET, className)}>{label}</Link>;
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
      {c && rows.length === 0 && !c.unavailable.length && <p className="text-sm text-muted" data-empty="client-issues">No open complaints, negative feedback, retake requests, repeated revisions, cancellations or refunds in the last 30 days.</p>}
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
  // Each assignment opens its own task (see it, ask for an update, reassign),
  // not a line of text (Jordan, Oct 28 2026: "make sure every task and
  // assignment has an actionable button").
  const { resurfaceOf } = await import("@/lib/delegation");
  const now = new Date(nowMs);
  const workload: ListRow[] = [
    ...Object.values(t.byPerson).flat().map((d) => ({ id: d.taskId, title: `${d.assigneeName ?? "Nobody"}: ${d.title}`, sub: [(STATE_WORD[d.state] ?? d.state).toLowerCase(), d.dueAt ? `due ${etDateTime(d.dueAt)}` : null, d.assignedBy ? `from ${d.assignedBy}` : null].filter(Boolean).join(" · "), tone: (d.dueAt && Date.parse(d.dueAt) < nowMs ? "bad" : d.state === "ASSIGNED" ? "warn" : "ok") as Tone, open: { kind: "task" as const, task: { ...d, resurface: resurfaceOf(d, now) } } })),
    ...t.unassigned.map((u) => ({ id: `un:${u.what}`, title: `${u.count} ${u.what.charAt(0).toLowerCase()}${u.what.slice(1)}`, sub: u.what.includes(" while off") ? "Booked on someone who is off" : "Unassigned", tone: "bad" as Tone, href: u.href })),
    ...t.timeOff.map((o, i) => ({ id: `off:${i}`, title: `${o.name}: ${o.words}`, sub: "Time off", tone: "warn" as Tone })),
  ];
  return (
    <Card title="Team coverage" id="team" right={<ViewAll n={0} spec={{ kind: "list", title: "Team workload", subtitle: t.note, rows: workload, empty: "No open assignments, unassigned work or time off on record." }} />}>
      <Unavailable what={t.unavailable} />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="hidden grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_auto] gap-2 bg-surface-2/60 px-3 py-2 text-[12px] font-medium text-muted sm:grid"><span>Person</span><span>Area</span><span>Status</span><span className="w-28">Action</span></div>
        <ul className="divide-y divide-border" data-coverage={t.rows.length}>
          {t.rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_auto]" data-coverage-row={r.key}>
              <span className="font-medium [overflow-wrap:anywhere]">{r.person}<span className="block text-[12px] font-normal text-muted sm:hidden">{r.area}</span></span>
              <span className="hidden [overflow-wrap:anywhere] sm:block">{r.area}</span>
              <span className={cn("col-start-1 flex items-start gap-1.5 sm:col-start-auto", TONE_TEXT[r.tone])}><span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[r.tone])} /><span className="[overflow-wrap:anywhere]">{r.status}</span></span>
              <span className="col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto sm:w-28">{act(r.action, 0, "w-full")}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        {/* No acceptance step (Oct 30 2026): the line counts the open assignments and the late ones. */}
        {(() => { const n = Object.values(t.byPerson).flat().length; return (
          <p className="mr-auto flex items-center gap-1.5 text-sm text-muted" data-open-assignments={n}><Users aria-hidden className="size-4" /> {n} open assignment{n === 1 ? "" : "s"}{t.overdue.length ? ` · ${t.overdue.length} overdue` : ""}</p>
        ); })()}
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
  const all: ListRow[] = rows.map((r) => ({ id: r.id, title: `${r.kind === "listing" ? "Listing script" : "Monthly content"}: ${r.client}, ${r.what}`, sub: `Writing: ${r.writer} · Approval: ${r.approver}${r.related ? ` · ${r.related}` : ""}`, tone: r.tone, href: r.href, assign: r.assign, action: shellAction(r.actions) }));
  return (
    <Card title="Scripts & creative decisions" id="creative" right={c ? <span className="flex flex-wrap gap-1.5 text-[11px] font-semibold"><span className="rounded-md bg-warning/15 px-2 py-1 text-warning">Jordan owns {c.jordanOwns}</span><span className="rounded-md bg-waiting-soft px-2 py-1 text-waiting">Others draft {c.othersDraft}</span>{rows.length > SHOWN && <ViewAll n={rows.length} spec={{ kind: "list", title: "Scripts & creative decisions", rows: all }} />}</span> : undefined}>
      {!c ? <Unavailable what={["scripts"]} /> : <Unavailable what={c.unavailable} />}
      {c && rows.length === 0 && !c.listingFyi && !c.unavailable.length && <p className="text-sm text-muted" data-empty="creative">No scripts or creative decisions waiting on you.</p>}
      {/* Listing scripts are James's (the Loom, Oct 27 2026): one quiet line, Open lists them. */}
      {c?.listingFyi && (
        <p className="mb-2 flex flex-wrap items-center gap-x-2 text-[13px] text-muted" data-listing-fyi={c.listingFyi.count}>
          <FileText aria-hidden className="size-4 shrink-0" />
          <span>{c.listingFyi.words}.</span>
          <PanelButton spec={{ kind: "list", title: `Listing scripts with ${c.listingFyi.owner}`, subtitle: `${c.listingFyi.owner} writes and approves listing scripts. Nothing here needs you.`, rows: c.listingFyi.rows.map((r) => ({ id: r.id, title: r.title, sub: r.sub, href: r.href, tone: r.tone })) }} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">Open</PanelButton>
        </p>
      )}
      <ul className="space-y-2.5" data-creative={rows.length}>
        {rows.slice(0, SHOWN).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3" data-creative-row={r.kind}>
            {r.kind === "listing" ? <FileText aria-hidden className="size-5 shrink-0 text-brand" /> : <Lightbulb aria-hidden className="size-5 shrink-0 text-brand" />}
            {/* Phone layout (Jordan, Oct 28 2026): the buttons wrap under the words instead of squeezing them. */}
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-semibold [overflow-wrap:anywhere]">{r.kind === "listing" ? "Listing script" : "Monthly content"} · {r.client}</p>
              <p className="text-[13px] [overflow-wrap:anywhere]">{r.what}</p>
              <p className="text-[12px] text-muted">Writing: {r.writer} · Approval: {r.approver}{r.related ? ` · ${r.related}` : ""}</p>
            </div>
            <div className="ml-auto flex flex-wrap justify-end gap-2" data-creative-actions={r.actions.map((a) => a.label).join("|")}>
              {r.actions.map((a, i) => act(a, i))}
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
  // A DELEGATED EMAIL LEAVES THIS LIST (Jordan's Loom, Oct 27 2026, 6:51:
  // "email needing my reply should be empty now, because I've delegated all
  // of these"). It used to fill the card whenever nothing else did; now it is
  // under Delegated by me, with the assignee's state, and counted here in one
  // quiet line.
  const open = rows.filter((r) => r.cls !== "waiting");
  const delegated = rows.length - open.length;
  const all: ListRow[] = open.map((r) => ({ id: r.key, title: `${r.sender}: ${r.subject}`, sub: [EMAIL_CLASS_WORDS[r.cls], r.handledBy, `waiting since ${etDateTime(r.waitingSinceISO)}`].filter(Boolean).join(" · "), tone: r.cls === "reply" || r.cls === "decide" ? "bad" : "ok", open: { kind: "email", row: r } }));
  return (
    <Card title="Email needing my reply" id="email" right={open.length > 3 ? <ViewAll n={open.length} spec={{ kind: "list", title: "Email in your inbox waiting on an answer", rows: all }} /> : undefined}>
      {!e ? <Unavailable what={["email"]} /> : e.unavailable.length ? <p role="status" data-unavailable className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">{e.note}</p> : null}
      {e && !e.unavailable.length && open.length === 0 && <p className="text-sm text-muted" data-empty="email">No client email in your inbox is waiting on you.</p>}
      <ul className="space-y-2.5" data-email={open.length} data-email-counts={e ? JSON.stringify(e.counts) : undefined}>
        {open.slice(0, 3).map((r) => (
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
      {delegated > 0 && <p className="mt-2 text-[12px] text-muted" data-email-delegated={delegated}>{delegated === 1 ? "1 email" : `${delegated} emails`} handed on: see <a href="#delegated" className="font-medium text-brand hover:underline">Delegated by me</a>.</p>}
    </Card>
  );
}

// =====================================================================================
// H. DELEGATED BY ME
// =====================================================================================

const STATE_DOT: Record<string, string> = { ASSIGNED: "bg-warning", ACCEPTED: "bg-success", IN_PROGRESS: "bg-waiting", BLOCKED: "bg-danger", READY_FOR_VERIFICATION: "bg-brand", COMPLETED: "bg-success", CANCELLED: "bg-border-strong" };
const STATE_WORD: Record<string, string> = { ASSIGNED: "Assigned", ACCEPTED: "Assigned", IN_PROGRESS: "In progress", BLOCKED: "Blocked", READY_FOR_VERIFICATION: "Ready to verify", COMPLETED: "Completed", CANCELLED: "Cancelled" };

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
          <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto] gap-2 bg-surface-2/60 px-3 py-2 text-[12px] font-medium text-muted sm:grid"><span>Task</span><span>Owner</span><span>Status</span><span>Deadline</span><span className="w-24">Action</span></div>
          <ul className="divide-y divide-border" data-delegated={d?.open ?? 0} data-flagged={d?.flagged ?? 0}>
            {rows.slice(0, 4).map((r) => (
              <li key={r.taskId} data-delegated-row={r.taskId} data-state={r.state} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1.5 text-sm sm:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto]">
                <PanelButton spec={{ kind: "task", task: r }} label={`Open ${r.title}`} className="min-h-11 min-w-0 text-left hover:underline">
                  <span className="[overflow-wrap:anywhere]">{r.resurface && <AlertTriangle aria-label="Needs your follow-up" className="mr-1 inline size-3.5 text-danger" />}{r.title}</span>
                  <span className="block text-[12px] text-muted sm:hidden">{r.assigneeName ?? "Nobody"} · {STATE_WORD[r.state]} · {r.dueAt ? etDateTime(r.dueAt) : "no deadline"}</span>
                </PanelButton>
                <span className="hidden [overflow-wrap:anywhere] sm:block">{r.assigneeName ?? "Nobody"}</span>
                <span className="hidden items-center gap-1.5 sm:flex"><span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[r.state])} />{STATE_WORD[r.state]}</span>
                <span className={cn("hidden tabular-nums sm:block", r.resurface?.kind === "overdue" && "font-semibold text-danger")}>{r.dueAt ? etDateTime(r.dueAt) : "None"}</span>
                <span className="sm:w-24">
                  {/* Open work: one press asks them for an update (the delegation rule: at most hourly).
                      Waiting on him (to verify, or to decide): opens the task. Closed: opens it. */}
                  {r.state === "COMPLETED" || r.state === "CANCELLED"
                    ? <PanelButton spec={{ kind: "task", task: r }} className={cn(QUIET, "w-full")}>Open</PanelButton>
                    : r.state === "READY_FOR_VERIFICATION" || r.resurface?.kind === "escalated" || r.resurface?.kind === "recommended"
                      ? <PanelButton spec={{ kind: "task", task: r }} className={cn(PRIMARY, "w-full")}>{r.state === "READY_FOR_VERIFICATION" ? "Verify" : "Decide"}</PanelButton>
                      : <RowActionButton a={{ kind: "nudge", label: "Follow up", taskId: r.taskId }} primary={!!r.resurface} className="w-full" />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {flagged && (
        <p className="mt-auto pt-3 text-[13px] text-danger" data-delegated-flag>{flagged.resurface!.words}: {flagged.title}</p>
      )}
    </Card>
  );
}

// =====================================================================================
// I. WEEKLY PERFORMANCE
// =====================================================================================

const MEASURE_ICON: Record<string, typeof Clock> = { ontime: Clock, photos: Camera, videos: Clock, revisions: RefreshCw, replies: MessageSquare, shoots: CalendarCheck, quality: ClipboardList, week: Upload };

/** One headline tile. On-time delivery holds photos and listing videos side by side: two services, never one average. */
function MeasureTile({ icon, label, parts }: { icon: string; label: string; parts: Measure[] }) {
  const Icon = MEASURE_ICON[icon] ?? Clock;
  const tone = parts.find((m) => m.tone === "bad")?.tone ?? parts.find((m) => m.tone === "warn")?.tone ?? parts[0]?.tone ?? null;
  return (
    <div className="flex min-w-0 gap-2.5 rounded-xl border border-border p-3" data-tile={icon}>
      <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2"><Icon className={cn("size-4", tone ? TONE_TEXT[tone] : "text-muted")} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted">{label}</p>
        <div className={cn(parts.length > 1 && "grid grid-cols-2 gap-2")}>
          {parts.map((m) => (
            <div key={m.key} className="min-w-0" data-measure={m.key}>
              <p className={cn("font-bold tabular-nums", m.value.length > 8 ? "text-sm leading-6" : "text-xl", m.tone && TONE_TEXT[m.tone])}>{m.value}{parts.length > 1 && <span className="ml-1 text-[11px] font-medium text-muted">{m.key === "photos" ? "photos" : "videos"}</span>}</p>
              <p className="text-[11px] leading-snug text-muted">{m.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

async function WeeklySection({ p }: { p: Promise<WeeklyPerformance | null> }) {
  const w = await p;
  return (
    <Card title="Weekly performance" id="weekly" right={w ? <PanelButton spec={{ kind: "info", title: "Metric definitions", lines: w.measures.map((m) => ({ label: m.label, value: `${m.detail}. Period: ${m.period}. Source: ${m.source || "n/a"}.` })) }} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">View metric definitions <ArrowRight aria-hidden className="size-4" /></PanelButton> : undefined}>
      {!w ? <Unavailable what={["this week's figures"]} /> : (
        <>
          {/* FOUR HEADLINES (Oct 27 2026, his mockup): on-time delivery, revision
              rate, client replies, upcoming shoots covered. Too few to judge reads
              "Not enough data", never a percent of two. */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-weekly-tiles>
            {(() => {
              const by = (k: string) => w.measures.filter((m) => m.key === k);
              const tiles: { icon: string; label: string; parts: Measure[] }[] = [
                { icon: "ontime", label: "On-time delivery", parts: [...by("photos"), ...by("videos")] },
                { icon: "revisions", label: "Revision rate", parts: by("revisions") },
                { icon: "replies", label: "Client replies within 1 hour", parts: by("replies") },
                { icon: "shoots", label: "Upcoming shoots covered", parts: by("shoots") },
                { icon: "week", label: "This week", parts: by("week") },
              ].filter((t) => t.parts.length);
              return tiles.map((t) => <MeasureTile key={t.icon} {...t} />);
            })()}
          </div>
          {w.measures.filter((m) => m.key === "quality").map((m) => (
            <p key={m.key} className="mt-2 text-[12px] text-muted" data-measure={m.key}>{m.label} ({m.period.toLowerCase()}): <b className="font-semibold text-foreground">{m.value}</b> · {m.detail}</p>
          ))}
          <p className="mt-2 text-[11px] text-muted">Each measure&rsquo;s period and source are under View metric definitions. Services are never averaged together. Updated {etTime(w.updatedISO)} ET.</p>
        </>
      )}
    </Card>
  );
}

// =====================================================================================
// ASSIGNED TO ME (Jordan, Oct 30 2026: Kyle handed him tasks and he had nowhere to find
// them). Shown only when something is on him; each row opens the task with its notes.
// =====================================================================================

async function assignedToMe(meKey: string, now: Date): Promise<DelegatedRow[]> {
  const { tasksAssignedTo, resurfaceOf } = await import("@/lib/delegation");
  const rows = (await tasksAssignedTo(meKey)).map((d) => ({ ...d, resurface: resurfaceOf(d, now) }));
  return rows.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
}

async function openTaskPanel(taskId: string, now: Date): Promise<PanelSpec | null> {
  const { delegationFor, resurfaceOf } = await import("@/lib/delegation");
  const v = (await delegationFor([taskId])).get(taskId);
  return v ? { kind: "task", task: { ...v, resurface: resurfaceOf(v, now) } } : null;
}

async function AssignedToMeSection({ p }: { p: Promise<DelegatedRow[] | null> }) {
  const rows = (await p) ?? [];
  if (!rows.length) return null;
  const all: ListRow[] = rows.map((r) => ({ id: r.taskId, title: r.title, sub: [r.assignedBy ? `from ${r.assignedBy}` : null, r.dueAt ? `due ${etDateTime(r.dueAt)}` : null].filter(Boolean).join(" · "), tone: r.resurface ? "bad" : "warn", open: { kind: "task", task: r } }));
  return (
    <Card title="Assigned to me" id="assigned-to-me" right={rows.length > 5 ? <ViewAll n={rows.length} spec={{ kind: "list", title: "Assigned to me", subtitle: "Tasks the team handed to you. Open one to see its notes and finish it or give it back.", rows: all }} /> : undefined}>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" data-assigned-to-me={rows.length}>
        {rows.slice(0, 5).map((r) => (
          <li key={r.taskId} data-mine-row={r.taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm">
            <PanelButton spec={{ kind: "task", task: r }} label={`Open ${r.title}`} className="min-h-11 min-w-0 flex-1 basis-60 text-left hover:underline">
              <span className="[overflow-wrap:anywhere]">{r.resurface && <AlertTriangle aria-label="Overdue" className="mr-1 inline size-3.5 text-danger" />}{r.title}</span>
              <span className="block text-[12px] text-muted">{[r.assignedBy ? `From ${r.assignedBy}` : null, r.dueAt ? `due ${etDateTime(r.dueAt)}` : "no deadline", r.notes ? "has notes" : null].filter(Boolean).join(" · ")}</span>
            </PanelButton>
            <PanelButton spec={{ kind: "task", task: r }} className={cn(PRIMARY, "shrink-0")}>Open</PanelButton>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// =====================================================================================
// THE PAGE
// =====================================================================================

export async function OwnerHome({ me, includeTest = false, now: at, openTaskId = null }: {
  me: { email: string; name: string | null; impersonating: boolean } | null;
  includeTest?: boolean;
  now?: Date;
  /** A task link (/?task=<id>, from an assignment text) opens that task's panel. */
  openTaskId?: string | null;
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
  // Who "me" is on the roster: the owner row with one of his sign-in addresses, else the owner row.
  const meKey = (roster.find((a) => a.kind === "owner" && !!a.email && ownerEmails.includes(a.email.toLowerCase())) ?? roster.find((a) => a.kind === "owner"))?.key ?? null;
  const mineP = soft("assigned to me", meKey ? assignedToMe(meKey, now) : Promise.resolve([] as DelegatedRow[]));
  const initial: PanelSpec | null = openTaskId ? await soft("task link", openTaskPanel(openTaskId, now)) : null;

  const minute = etMinutesOfDay(now);
  const first = me?.name?.trim().split(/\s+/)[0] ?? "Jordan";
  return (
    <OwnerShell roster={people} readOnly={!!me?.impersonating} initial={initial} meKey={meKey}>
      <AutoRefresh seconds={120} />
      <PageHeader
        eyebrow="Dashboard"
        title={`${minute < 12 * 60 ? "Good morning" : minute < 18 * 60 ? "Good afternoon" : "Good evening"}, ${first}`}
        subtitle={`Business oversight & your work · ${etFullDate(now)} · updated ${etTime(now)} ET`}
        actions={<><MessagesButton variant="dashboard" role="OWNER" /><PanelButton spec={{ kind: "assign", seed: { title: "" }, heading: "Assign a task" }} className={PRIMARY}><Plus aria-hidden className="size-4" /> Assign task</PanelButton></>}
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
        <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading client issues…" />}><ClientIssuesSection p={issuesP} /></Suspense>
          <Suspense fallback={<Loading label="Reading team coverage…" />}><TeamSection p={teamP} nowMs={now.getTime()} /></Suspense>
        </div>

        <h2 className="flex items-center gap-3 pt-2 text-xl font-bold tracking-tight">My work<span aria-hidden className="h-px flex-1 bg-border" /></h2>
        <Suspense fallback={null}><AssignedToMeSection p={mineP} /></Suspense>
        <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading meetings…" />}><MeetingsSection p={meetingsP} /></Suspense>
          <Suspense fallback={<Loading label="Reading scripts…" />}><CreativeSection p={creativeP} /></Suspense>
        </div>
        <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <Suspense fallback={<Loading label="Reading email…" />}><EmailSectionView p={emailP} /></Suspense>
          <Suspense fallback={<Loading label="Reading your assignments…" />}><DelegatedSection p={delegatedP} /></Suspense>
        </div>
        <Suspense fallback={<Loading label="Counting this week…" />}><WeeklySection p={weeklyP} /></Suspense>
        <p className="text-[11px] text-muted">Read {etMonthDay(now)} at {etTime(now)} ET. Every count opens the list it counts.</p>
      </div>
    </OwnerShell>
  );
}
