"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, BarChart3, Camera, CheckCircle2, ClipboardCheck, Clapperboard, ExternalLink, FileText,
  GraduationCap, ShieldCheck, Users, Video, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { homeRecordHref } from "@/lib/homeRecordScope";
import type { AssignedRow, Chip, CreativeDesk as Desk, CutRow, DevGroupView, HandoffRow, ImprovementRow, PrepRow, ShootRow } from "@/lib/creativeDesk";
import type { ReadinessView } from "@/lib/teamDevelopment";
import { CloseoutTick, HandoffCloseOut, PanelBody, type Panel } from "@/components/creativeDesk/CreativePanels";

// ---------------------------------------------------------------------------
// THE CREATIVE MANAGER'S DASHBOARD, the screen (Oct 23 2026, Jordan's spec §6
// and the mockup he approved). Simple and scannable: each section shows at
// most three rows and a "View all"; a side panel holds the detail and the
// actions (the Review Room's approve, the delegation workflow's task steps,
// the coaching and readiness records), so the page never changes under James.
// Every number arrives computed (lib/creativeDesk); this file lays it out.
// Desktop: two columns where the mockup has them; a phone: one column.
// ---------------------------------------------------------------------------

export const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
export const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
export const QUIET = `${BTN} border border-brand/50 text-brand hover:bg-brand/5`;

const CHIP_TONE: Record<Chip["tone"], string> = {
  ok: "text-success",
  todo: "text-warning",
  info: "text-muted",
  off: "text-muted-2",
};

export type DeskMode = "home" | "development";

export function CreativeDesk({ desk, mode = "home", includeTest = false, initialPanel = null }: {
  desk: Desk;
  mode?: DeskMode;
  includeTest?: boolean;
  /** a drill (or a link from Jordan's decision task) can open a panel */
  initialPanel?: Panel | null;
}) {
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const limit = mode === "home" ? 3 : 1000;
  const href = (h: string) => homeRecordHref(h, includeTest);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  const open = (p: Panel) => setPanel(p);
  const g = desk.glance;

  return (
    <div data-creative-desk data-mode={mode} data-readonly={desk.readOnly ? "true" : "false"} className="space-y-4">
      {desk.readOnly && (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
          Preview: read-only. The buttons are off while you view as {desk.person.first}.
        </p>
      )}
      {desk.unavailable.length > 0 && (
        <p role="status" data-unavailable className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>Couldn&rsquo;t read {desk.unavailable.join(", ")} just now. Those sections may be missing items; refresh to try again.</span>
        </p>
      )}

      {/* A · TODAY AT A GLANCE */}
      {mode === "home" && (
        <section id="glance" data-section="glance" aria-labelledby="glance-title" className="panel-shadow rounded-2xl border border-border bg-surface px-4 py-3">
          <div className="grid grid-cols-2 items-center gap-x-3 sm:flex sm:flex-wrap sm:gap-x-6">
            <h2 id="glance-title" className="col-span-2 text-base font-semibold">Today at a glance</h2>
            <GlanceChip id="shoots" icon={<Camera aria-hidden className="size-4" />} n={g.shoots} one="shoot today" many="shoots today" to="#production" />
            <GlanceChip id="reviews" icon={<FileText aria-hidden className="size-4" />} n={g.reviews} one="review ready" many="reviews ready" to="#review" />
            {desk.team && <GlanceChip id="followups" icon={<Users aria-hidden className="size-4" />} n={g.followUps} one="coaching follow-up" many="coaching follow-ups" to="#team" />}
            <GlanceChip id="urgent" icon={<AlertTriangle aria-hidden className="size-4" />} n={g.urgent} one="urgent task" many="urgent tasks" to="#assigned" />
          </div>
          <p data-glance-line className="mt-1.5 text-[13px] text-muted">{g.line}</p>
        </section>
      )}

      {mode === "home" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {/* B · MY PRODUCTION */}
          <Section id="production" title="My Production" subtitle="Capture, client direction, and clean handoffs." count={desk.production.mine.length + desk.production.handoffs.length} viewAll={{ label: "View my shoots", href: href(desk.production.myShootsHref) }} unavailable={desk.production.unavailable}>
            <SubHead>Your upcoming shoots</SubHead>
            {desk.production.mine.length === 0 ? (
              <Empty>{desk.production.unavailable ? "Your shoots couldn't be read." : "No shoots on your calendar for the next week."}</Empty>
            ) : (
              <ul data-list="my-shoots" className="divide-y divide-border">
                {desk.production.mine.slice(0, limit).map((s) => <ShootLine key={s.id} s={s} href={href} />)}
              </ul>
            )}
            <More n={desk.production.mine.length - limit} href={href(desk.production.myShootsHref)} what="shoot" />
            {desk.production.handoffs.length > 0 && (
              <>
                <SubHead>Handoffs to finish</SubHead>
                <ul data-list="my-handoffs" className="divide-y divide-border">
                  {desk.production.handoffs.slice(0, limit).map((h) => <HandoffLine key={h.projectId} h={h} href={href} readOnly={desk.readOnly} />)}
                </ul>
                <More n={desk.production.handoffs.length - limit} href={href("/upload")} what="handoff" />
              </>
            )}
            <SubHead>Team shoots you supervise</SubHead>
            {desk.production.team.length === 0 ? (
              <Empty>{desk.production.unavailable ? "The team's shoots couldn't be read." : "Every team shoot from the last two weeks is handed off."}</Empty>
            ) : (
              <ul data-list="team-handoffs" className="divide-y divide-border">
                {desk.production.team.slice(0, limit).map((h) => <HandoffLine key={h.projectId} h={h} href={href} readOnly={desk.readOnly} team />)}
              </ul>
            )}
            <More n={desk.production.team.length - limit} href={href("/upload")} what="team handoff" />
            {desk.production.closedOut > 0 && (
              <p data-closed-out={desk.production.closedOut} className="mt-1 text-[12px] text-muted">{desk.production.closedOut} closed out. Each comes back if anything new turns up on the job.</p>
            )}
          </Section>

          {/* C · CREATIVE REVIEW */}
          <Section id="review" title="Creative Review" subtitle="Review cuts and approve the correct version." count={desk.review.ready.length} viewAll={{ label: "View review queue", href: href("/review") }} unavailable={desk.review.unavailable}>
            {desk.review.ready.length === 0 ? (
              <Empty>{desk.review.unavailable ? "The review queue couldn't be read." : "No cut is waiting on your review."}</Empty>
            ) : (
              <ul data-list="review-ready" className="divide-y divide-border">
                {desk.review.ready.slice(0, limit).map((c) => <CutLine key={c.id} c={c} href={href} onOpen={() => open({ kind: "cut", id: c.id })} />)}
              </ul>
            )}
            <More n={desk.review.ready.length - limit} href={href("/review")} what="cut" />
            <p className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2 text-[12px] text-muted">
              Review standards: story and sequence · capture and edit · color · audio · text and spelling · AI accuracy · client brief
            </p>
            <p className="mt-2 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Approval covers that one version and sends it to Kyle&rsquo;s Ready to send. It never delivers to the client.
            </p>
            {desk.review.delayed.length > 0 && (
              <>
                <SubHead>Delayed or blocked</SubHead>
                <ul data-list="review-delayed" className="divide-y divide-border">
                  {desk.review.delayed.slice(0, limit).map((c) => <CutLine key={c.id} c={c} href={href} onOpen={() => open({ kind: "cut", id: c.id })} delayed />)}
                </ul>
                <More n={desk.review.delayed.length - limit} href={href("/review")} what="delayed cut" />
              </>
            )}
          </Section>
        </div>
      )}

      {/* D · TEAM DEVELOPMENT & QUALITY (+ E · READINESS) */}
      {desk.team && (
        <Section id="team" title="Team Development & Quality" subtitle="Train, coach, assess readiness, and follow through." count={desk.team.groups.reduce((n, gr) => n + gr.items.length + gr.signals.length, 0)} viewAll={mode === "home" ? { label: "View all", href: href("/development") } : null}>
          {desk.team.unavailable.length > 0 && (
            <p role="status" className="mb-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">Couldn&rsquo;t read {desk.team.unavailable.join(", ")}. The groups below may be missing evidence.</p>
          )}
          <div className="space-y-2">
            {desk.team.groups.map((gr) => <GroupBlock key={gr.key} g={gr} limit={mode === "home" ? 2 : 1000} onOpen={open} readOnly={desk.readOnly} recordsUnavailable={desk.team!.recordsUnavailable} />)}
          </div>
          {desk.readiness && (
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <FollowUps desk={desk} onOpen={open} />
              <ReadinessBlock items={desk.readiness.items} unavailable={desk.readiness.unavailable} limit={limit} onOpen={open} readOnly={desk.readOnly} viewAll={mode === "home" ? href("/development#readiness") : null} />
            </div>
          )}
          <p className="mt-3 text-center text-[12px] text-muted">James assesses readiness and recommends. Jordan makes staffing and pay decisions.</p>
        </Section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* F · CREATIVE PREPARATION */}
        {mode === "home" && (
          <Section id="prep" title="Creative Preparation" subtitle="Listing and monthly content." count={desk.prep.items.length} viewAll={{ label: "View monthly content", href: href("/content") }} unavailable={desk.prep.unavailable}>
            {desk.prep.items.length === 0 ? (
              <Empty>{desk.prep.unavailable ? "Creative preparation couldn't be read." : "No listing or monthly preparation is assigned to you for the next two weeks."}</Empty>
            ) : (
              <ul data-list="prep" className="divide-y divide-border">
                {desk.prep.items.slice(0, limit).map((p) => <PrepLine key={p.key} p={p} href={href} />)}
              </ul>
            )}
            <More n={desk.prep.items.length - limit} href={href("/content")} what="item" />
            <p className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2 text-[12px] text-muted">Assigned work only. Ownership is shown on every item; nothing moves to you in bulk.</p>
          </Section>
        )}

        {/* G · PROCESS IMPROVEMENTS */}
        <Section id="improvements" title="Process Improvements" subtitle="Fix recurring production friction." count={desk.improvements.items.length} viewAll={mode === "home" ? { label: "Track improvement tasks", href: href("/development#improvements") } : null} unavailable={desk.improvements.unavailable}
          action={!desk.readOnly ? <button type="button" data-open-panel="new-improvement" onClick={() => open({ kind: "new-improvement" })} className={QUIET}>Log one</button> : null}>
          {desk.improvements.items.length === 0 ? (
            <Empty>{desk.improvements.unavailable ? "Improvement tasks couldn't be read." : "No improvement tasks are open."}</Empty>
          ) : (
            <ul data-list="improvements" className="divide-y divide-border">
              {desk.improvements.items.slice(0, limit).map((i) => <ImprovementLine key={i.taskId} i={i} onOpen={() => open({ kind: "improvement", id: i.taskId })} />)}
            </ul>
          )}
          <More n={desk.improvements.items.length - limit} href={href("/development#improvements")} what="improvement" />
        </Section>
      </div>

      {/* H · ASSIGNED TO ME & HANDOFFS, with the end-of-day check */}
      {mode === "home" && (
        <>
          <Section id="assigned" title="Assigned to Me & Handoffs" count={desk.assigned.items.length} viewAll={{ label: "View all tasks", href: href("/tasks") }} unavailable={desk.assigned.unavailable}>
            {desk.assigned.items.length === 0 ? (
              <Empty>{desk.assigned.unavailable ? "Your tasks couldn't be read." : "Nothing is assigned to you right now."}</Empty>
            ) : (
              <AssignedTable rows={desk.assigned.items.slice(0, Math.max(limit, 5))} onOpen={(id) => open({ kind: "task", id })} href={href} />
            )}
            <More n={desk.assigned.items.length - Math.max(limit, 5)} href={href("/tasks")} what="task" />
            <p className="mt-2 text-[12px] text-muted">Every handoff keeps an owner and a next step.</p>
          </Section>

          <section id="end-of-day" data-section="closeout" aria-labelledby="eod-title" className="panel-shadow rounded-2xl border border-border bg-surface px-4 py-3">
            <h2 id="eod-title" className="text-base font-semibold">End-of-day check</h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {desk.closeout.lines.map((l) => (
                <li key={l.key} data-closeout={l.key} data-done={l.done ? "true" : "false"}>
                  <CloseoutTick line={l} dayKey={desk.closeout.dayKey} readOnly={desk.readOnly} />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">Ticking records that you checked. It never completes a task.</p>
          </section>
        </>
      )}

      {panel && (
        <div className="fixed inset-0 z-50 flex justify-end" data-side-panel={panelKey(panel)}>
          <button type="button" aria-label="Close the panel" onClick={() => setPanel(null)} className="absolute inset-0 bg-black/30" />
          <aside role="dialog" aria-modal="true" aria-labelledby="creative-panel-title" className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-surface shadow-xl">
            <PanelBody panel={panel} desk={desk} href={href} onClose={() => setPanel(null)} />
          </aside>
        </div>
      )}
    </div>
  );
}

const panelKey = (p: Panel) => ("id" in p ? `${p.kind}:${p.id}` : "key" in p ? `${p.kind}:${p.key}` : "group" in p ? `${p.kind}:${p.group}` : p.kind);

// ---- building blocks ----------------------------------------------------------------------

function GlanceChip({ id, icon, n, one, many, to }: { id: string; icon: React.ReactNode; n: number | null; one: string; many: string; to: string }) {
  return (
    <a href={to} data-glance={id} data-count={n == null ? "?" : String(n)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-sm font-medium hover:text-brand">
      <span className="text-muted">{icon}</span>
      <span className={cn("tabular-nums", n ? "text-foreground" : "text-muted")}>{n == null ? "?" : n}</span>
      <span className={n ? "" : "text-muted"}>{n === 1 ? one : many}</span>
    </a>
  );
}

function Section({ id, title, subtitle, count, children, viewAll, unavailable, action }: {
  id: string;
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
  viewAll: { label: string; href: string } | null;
  unavailable?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <section id={id} data-section={id} data-count={unavailable ? "?" : String(count)} aria-labelledby={`${id}-title`} className="panel-shadow min-w-0 scroll-mt-28 rounded-2xl border border-border bg-surface">
      <div className="flex items-start gap-3 px-4 pb-1 pt-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-lg font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="text-[13px] text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="px-4 pb-3">{children}</div>
      {viewAll && (
        <div className="border-t border-border px-4 py-1">
          <Link href={viewAll.href} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
            {viewAll.label} <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      )}
    </section>
  );
}

const SubHead = ({ children }: { children: React.ReactNode }) => <h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted-2 first:mt-1">{children}</h3>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="py-2 text-sm text-muted">{children}</p>;

function More({ n, href, what }: { n: number; href: string; what: string }) {
  if (n <= 0) return null;
  return <Link href={href} className="inline-flex min-h-11 items-center text-[13px] font-medium text-muted hover:text-brand">+{n} more {what}{n === 1 ? "" : "s"}</Link>;
}

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
      {chips.map((c) => (
        <li key={c.key} data-chip={c.key} data-tone={c.tone} className={cn("inline-flex items-center gap-1", CHIP_TONE[c.tone])}>
          {c.tone === "ok" ? <CheckCircle2 aria-hidden className="size-3.5" /> : <span aria-hidden className={cn("size-2.5 rounded-full border", c.tone === "todo" ? "border-warning" : "border-border-strong")} />}
          {c.label}
        </li>
      ))}
    </ul>
  );
}

function ShootLine({ s, href }: { s: ShootRow; href: (h: string) => string }) {
  return (
    <li data-shoot={s.id} data-today={s.today ? "true" : "false"} className="py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{s.street}{s.clientName ? <span className="font-normal text-muted"> · {s.clientName}</span> : null}</p>
          <p className="text-[12px] text-muted">{s.whenWords}{s.services.length ? ` · ${s.services.slice(0, 4).join(", ")}` : ""}</p>
        </div>
        {s.missing.length > 0 && <span className="hidden shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning sm:inline">{s.missing.length} to prepare</span>}
        <Link href={href(s.links[0].href)} className={cn(s.missing.length ? PRIMARY : QUIET, "shrink-0")}>{s.links[0].label}</Link>
      </div>
      <Chips chips={s.chips} />
      {s.requests.length > 0 && <p className="mt-1 text-[12px] text-muted [overflow-wrap:anywhere]">Requests: {s.requests.slice(0, 2).join(" · ")}{s.requests.length > 2 ? ` (+${s.requests.length - 2})` : ""}</p>}
      <p className="mt-0.5 flex flex-wrap gap-x-3 text-[12px]">
        {s.links.slice(1).map((l) => l.external
          ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 font-medium text-brand hover:underline">{l.label} <ExternalLink aria-hidden className="size-3" /></a>
          : <Link key={l.label} href={href(l.href)} className="inline-flex min-h-8 items-center font-medium text-brand hover:underline">{l.label}</Link>)}
      </p>
    </li>
  );
}

function HandoffLine({ h, href, readOnly, team = false }: { h: HandoffRow; href: (h: string) => string; readOnly: boolean; team?: boolean }) {
  return (
    <li data-handoff={h.projectId} data-mine={h.mine ? "true" : "false"} className="py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{team ? `${h.photographer.split(" ")[0]} · ` : ""}{h.street}{h.clientName ? <span className="font-normal text-muted"> · {h.clientName}</span> : null}</p>
          <p className="text-[12px] font-medium text-warning">{h.status}</p>
        </div>
        <Link href={href(h.links[0].href)} className={cn(team ? QUIET : PRIMARY, "shrink-0")}>{team ? "Open" : h.links[0].label}</Link>
      </div>
      <Chips chips={h.lines} />
      {h.missing.length > 0 && <p className="mt-1 text-[12px] text-muted [overflow-wrap:anywhere]">Missing: {h.missing.join("; ")}</p>}
      {h.exceptions.length > 0 && <p className="mt-0.5 text-[12px] text-muted [overflow-wrap:anywhere]">Exceptions: {h.exceptions.join("; ")}</p>}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-4 text-[12px]">
        {!team && <Link href={href(h.links[1].href)} className="inline-flex min-h-8 items-center font-medium text-brand hover:underline">{h.links[1].label}</Link>}
        <HandoffCloseOut row={h} readOnly={readOnly} />
      </div>
    </li>
  );
}

function CutLine({ c, href, onOpen, delayed = false }: { c: CutRow; href: (h: string) => string; onOpen: () => void; delayed?: boolean }) {
  return (
    <li data-cut={c.id} data-version={c.version} className="py-2.5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><Video className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{c.street}{c.clientName ? <span className="font-normal text-muted"> · {c.clientName}</span> : null}</p>
          <p className="text-[12px] text-muted">
            Version {c.version}{c.editor ? ` · ${c.editor}` : ""}{delayed && c.reviewer ? ` · with ${c.reviewer}` : ""} · {c.priorNotes.total ? `${c.priorNotes.total} earlier notes` : "first review"} · waiting {c.waitedWords}
          </p>
          {(c.dueWords || c.why) && <p className={cn("text-[12px]", c.delayed ? "font-medium text-danger" : "text-muted")}>{[c.dueWords ? `Due ${c.dueWords.replace(/^Today/, "today")}` : null, c.why].filter(Boolean).join(" · ")}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
          {!delayed && <Link href={href(c.href)} className={PRIMARY}>Review</Link>}
          <button type="button" data-open-panel={`cut:${c.id}`} onClick={onOpen} className={QUIET}>{delayed ? "Follow up" : "Decide"}</button>
        </div>
      </div>
    </li>
  );
}

const GROUP_ICON = { FIELD: Camera, EDITOR: Clapperboard, QC: ShieldCheck } as const;
const GROUP_TINT = { FIELD: "bg-sky-500/10 text-sky-500", EDITOR: "bg-violet-500/10 text-violet-500", QC: "bg-emerald-500/10 text-emerald-500" } as const;
const GROUP_WORDS = { FIELD: "field creatives", EDITOR: "editors", QC: "admin QC" } as const;

function GroupBlock({ g, limit, onOpen, readOnly, recordsUnavailable }: { g: DevGroupView; limit: number; onOpen: (p: Panel) => void; readOnly: boolean; recordsUnavailable: boolean }) {
  const Icon = GROUP_ICON[g.key];
  const rows = [
    ...g.items.map((i) => ({ kind: "item" as const, id: i.id, who: i.personName.split(" ")[0], what: i.skill, next: i.nextAction ? `Next step: ${i.nextAction}` : i.followUpISO ? "Follow-up scheduled" : "No next step yet", due: i.followUpDue, panel: { kind: "dev-item", id: i.id } as Panel, label: "Open" })),
    ...g.signals.map((s) => ({ kind: "signal" as const, id: s.key, who: s.personName.split(" ")[0], what: s.skill, next: s.detail, due: false, panel: { kind: "signal", key: s.key } as Panel, label: "Review examples" })),
  ];
  return (
    <div data-group={g.key} data-items={g.items.length} data-signals={g.signals.length} className="rounded-xl border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", GROUP_TINT[g.key])}><Icon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide">{g.label}</h3>
          <p className="text-[12px] text-muted">{g.blurb}</p>
        </div>
        {!readOnly && (
          <button type="button" data-open-panel={`new-dev:${g.key}`} onClick={() => onOpen({ kind: "new-dev", group: g.key })} className={QUIET} disabled={recordsUnavailable}>Record feedback</button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-1.5 pl-[3.25rem] text-[13px] text-muted">
          {g.people.length === 0 ? "Nobody in this group on the roster." : `No recorded coaching and no quality evidence for ${GROUP_WORDS[g.key]} right now.`}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-border sm:pl-[3.25rem]">
          {rows.slice(0, limit).map((r) => (
            <li key={`${r.kind}:${r.id}`} data-dev-row={r.kind} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{r.who} · {r.what}{r.kind === "signal" && <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">evidence</span>}</p>
                <p className={cn("text-[12px] [overflow-wrap:anywhere]", r.due ? "font-medium text-warning" : "text-muted")}>{r.due ? "Follow-up due · " : ""}{r.next}</p>
              </div>
              <button type="button" data-open-panel={`${r.kind === "item" ? "dev-item" : "signal"}:${r.id}`} onClick={() => onOpen(r.panel)} className={cn(r.due ? PRIMARY : QUIET, "shrink-0")}>{r.label}</button>
            </li>
          ))}
          {rows.length > limit && <li className="py-1 text-[12px] text-muted"><Link href="/development" className="inline-flex min-h-8 items-center hover:text-brand">+{rows.length - limit} more</Link></li>}
        </ul>
      )}
    </div>
  );
}

function FollowUps({ desk, onOpen }: { desk: Desk; onOpen: (p: Panel) => void }) {
  const items = (desk.team?.groups ?? []).flatMap((g) => g.items).filter((i) => desk.team!.dueIds.includes(i.id));
  return (
    <div data-followups={items.length} className="rounded-xl border border-border px-3 py-2">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500"><GraduationCap className="size-5" /></span>
        <h3 className="text-sm font-semibold">Coaching follow-ups due</h3>
      </div>
      {items.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted">{desk.team?.recordsUnavailable ? "Recorded coaching couldn't be read." : "None due today."}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {items.slice(0, 3).map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-1.5">
              <p className="min-w-0 flex-1 text-[13px]"><span className="font-semibold">{i.personName.split(" ")[0]}</span> · {i.skill}</p>
              <button type="button" onClick={() => onOpen({ kind: "dev-item", id: i.id })} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand hover:underline">Record</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const REC_WORDS = { READY: "Ready", READY_WITH_SUPPORT: "Ready with support", NOT_YET: "Not yet" } as const;

function ReadinessBlock({ items, unavailable, limit, onOpen, readOnly, viewAll }: { items: ReadinessView[]; unavailable: boolean; limit: number; onOpen: (p: Panel) => void; readOnly: boolean; viewAll: string | null }) {
  return (
    <div id="readiness" data-section="readiness" data-count={unavailable ? "?" : String(items.length)} className="scroll-mt-28 rounded-xl border border-border px-3 py-2">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><BarChart3 className="size-5" /></span>
        <h3 className="min-w-0 flex-1 text-sm font-semibold">Readiness assessments</h3>
        {!readOnly && !unavailable && <button type="button" data-open-panel="new-readiness" onClick={() => onOpen({ kind: "new-readiness" })} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand hover:underline">Start one</button>}
      </div>
      {items.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted">{unavailable ? "Readiness assessments couldn't be read." : "No assessments yet. Start one when someone may be ready for independent work, premium projects, a skill, or progression."}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {items.slice(0, limit).map((a) => (
            <li key={a.id} data-readiness={a.id} data-status={a.status} className="flex items-start gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{a.personName.split(" ")[0]} · {a.trackLabel}</p>
                <p className="text-[12px] text-muted">
                  {a.met} of {a.criteria.length} criteria met{a.recommendation ? ` · You recommend: ${REC_WORDS[a.recommendation]}` : " · No recommendation yet"}
                  {a.decision ? ` · ${a.decision.words}` : ""}
                </p>
              </div>
              <button type="button" data-open-panel={`readiness:${a.id}`} onClick={() => onOpen({ kind: "readiness", id: a.id })} className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-brand hover:underline">
                {a.status === "DRAFT" && a.recommendation ? "Recommend to Jordan" : "Open"} <ArrowRight aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewAll && items.length > limit && <Link href={viewAll} className="inline-flex min-h-8 items-center text-[12px] text-muted hover:text-brand">+{items.length - limit} more</Link>}
    </div>
  );
}

const MODE_TONE = { JORDAN_OWNS: "bg-warning/15 text-warning", JAMES_DRAFTS: "bg-success/15 text-success", JAMES_OWNS: "bg-brand/15 text-brand" } as const;
const MODE_LABEL = { JORDAN_OWNS: "Jordan owns", JAMES_DRAFTS: "James drafts", JAMES_OWNS: "James owns" } as const;

function PrepLine({ p, href }: { p: PrepRow; href: (h: string) => string }) {
  const main = p.links[0];
  return (
    <li data-prep={p.key} data-mode={p.mode} className="py-2.5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><FileText className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{p.title}{p.clientName ? <span className="font-normal text-muted"> · {p.clientName}</span> : null}</p>
          <p className="text-[12px] text-muted">Writer: {p.writer} · Approver: {p.approver} · {p.role}</p>
          <p className="text-[12px] text-muted">{[p.deadlineWords, p.status].filter(Boolean).join(" · ")}</p>
        </div>
        <span title={p.source} className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", MODE_TONE[p.mode])}>{MODE_LABEL[p.mode]}</span>
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-3 pl-12 text-[12px]">
        {p.links.map((l) => l.external
          ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 font-medium text-brand hover:underline">{l.label} <ExternalLink aria-hidden className="size-3" /></a>
          : <Link key={l.label} href={href(l.href)} className={cn("inline-flex min-h-8 items-center font-medium text-brand hover:underline", l === main && "font-semibold")}>{l.label}</Link>)}
      </p>
    </li>
  );
}

function ImprovementLine({ i, onOpen }: { i: ImprovementRow; onOpen: () => void }) {
  return (
    <li data-improvement={i.taskId} className="flex items-start gap-3 py-2.5">
      <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{i.area === "Quality checklists" ? <ClipboardCheck className="size-4" /> : <Wrench className="size-4" />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{i.problem}</p>
        <p className="text-[12px] text-muted">{[i.area, `Owner: ${i.owner}`, i.status].filter(Boolean).join(" · ")}{i.policy ? " · Jordan approves" : ""}</p>
        <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{i.nextStep ? `Next: ${i.nextStep}` : "No next step yet"}{i.outcome ? ` · Outcome: ${i.outcome}` : ""}</p>
      </div>
      <button type="button" data-open-panel={`improvement:${i.taskId}`} onClick={onOpen} className={cn(QUIET, "shrink-0")}>Update</button>
    </li>
  );
}

const STATE_TONE: Record<string, string> = {
  ASSIGNED: "bg-warning/15 text-warning",
  ACCEPTED: "bg-brand/15 text-brand",
  IN_PROGRESS: "bg-brand/15 text-brand",
  BLOCKED: "bg-danger/15 text-danger",
  READY_FOR_VERIFICATION: "bg-success/15 text-success",
  OPEN: "bg-surface-2 text-muted",
  WAITING: "bg-surface-2 text-muted",
};

function AssignedTable({ rows, onOpen, href }: { rows: AssignedRow[]; onOpen: (id: string) => void; href: (h: string) => string }) {
  const actionLabel = (r: AssignedRow) => !r.delegated ? "Open" : r.state === "ASSIGNED" ? "Accept" : r.state === "READY_FOR_VERIFICATION" ? "Open" : "Update";
  return (
    <div data-list="assigned" className="overflow-hidden rounded-xl border border-border">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_8rem] gap-3 bg-surface-2/70 px-3 py-2 text-[12px] font-semibold text-muted md:grid">
        <span>Task</span><span>Due</span><span>Status</span><span>Action</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.taskId} data-task={r.taskId} data-state={r.state} data-urgent={r.urgent ? "true" : "false"} className="grid gap-1 px-3 py-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_8rem] md:items-center md:gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-snug [overflow-wrap:anywhere]">{r.title}</p>
              <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{[r.assignedBy ? `From ${r.assignedBy}` : null, r.blocker ? `Blocked: ${r.blocker}` : r.nextStep ? `Next: ${r.nextStep}` : null].filter(Boolean).join(" · ")}</p>
            </div>
            <p className={cn("text-[13px]", r.overdue ? "font-medium text-danger" : "text-muted")}>{r.dueWords ?? "No due date"}</p>
            <p><span className={cn("inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium", STATE_TONE[r.state] ?? "bg-surface-2 text-muted")}>{r.stateWords}</span></p>
            <div>
              {r.delegated
                ? <button type="button" data-open-panel={`task:${r.taskId}`} onClick={() => onOpen(r.taskId)} className={cn(r.state === "ASSIGNED" ? PRIMARY : QUIET, "w-full md:w-32")}>{actionLabel(r)}</button>
                : <Link href={href(r.href)} className={cn(QUIET, "w-full md:w-32")}>Open</Link>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
