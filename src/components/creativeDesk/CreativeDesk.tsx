"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, BarChart3, Camera, CheckCircle2, ClipboardCheck, Clapperboard, ExternalLink, FileText,
  GraduationCap, ListChecks, ShieldCheck, Upload, Users, Video, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { etDate } from "@/lib/datetime";
import { homeRecordHref } from "@/lib/homeRecordScope";
import type { AssignedRow, Chip, CreativeDesk as Desk, CutRow, DevGroupView, FrictionRow, HandoffRow, ImprovementRow, PrepRow, ShootRow } from "@/lib/creativeDesk";
import type { DevItemView, ReadinessView, Signal } from "@/lib/teamDevelopment";
import { AssignedAction, CloseoutTick, HandoffCloseOut, PanelBody, type Panel } from "@/components/creativeDesk/CreativePanels";
import { AskOnJob, MarkBriefRead } from "@/components/shoot/AskOnJob";

// ---------------------------------------------------------------------------
// THE CREATIVE MANAGER'S DASHBOARD, the screen (Oct 23 2026, Jordan's spec §6
// and the mockup he approved; rebuilt to the mockup Oct 27 2026, Jordan: "All
// the cards should fit nicely, just like the example"). Every row carries the
// action that resolves it (Finish handoff, Mark brief read, Review, Assess
// work, Add input, Accept, Done...), and a side panel holds the detail and
// the rest (the Review Room's approve, the delegation workflow's task steps,
// the coaching and readiness records), so the page never changes under James.
// Every number arrives computed (lib/creativeDesk); this file lays it out.
// Desktop: two columns of equal-height cards; a phone: one column.
// ---------------------------------------------------------------------------

export const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
export const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
export const QUIET = `${BTN} border border-brand/50 text-brand hover:bg-brand/5`;
const LINK = "inline-flex min-h-8 items-center text-[12px] font-medium text-brand hover:underline";
/** Two equal-height columns on a desktop, one on a phone (Oct 27 2026). */
const GRID = "grid gap-4 lg:grid-cols-2";

const CHIP_TONE: Record<Chip["tone"], string> = {
  ok: "text-success",
  todo: "text-warning",
  info: "text-muted",
  off: "text-muted-2",
};
const PILL_TONE: Record<Chip["tone"], string> = {
  ok: "bg-success/15 text-success",
  todo: "bg-warning/15 text-warning",
  info: "bg-brand/10 text-brand",
  off: "bg-surface-2 text-muted",
};

export type DeskMode = "home" | "development" | "production";

/** Rows the Production card shows before "Open full view" (Jordan, Oct 27 2026: "only the first two, like the example"). */
export const PRODUCTION_SHOWN = 2;

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
  const listing = desk.prep.items.filter((p) => p.kind === "listing");
  const monthly = desk.prep.items.filter((p) => p.kind === "monthly");

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
        <div data-grid="production-review" className={GRID}>
          {/* B · PRODUCTION (the first two rows; the rest in the full view) */}
          <ProductionCard desk={desk} href={href} shown={PRODUCTION_SHOWN} />

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
            {desk.review.delayed.length > 0 && (
              <>
                <SubHead>Delayed or blocked</SubHead>
                <ul data-list="review-delayed" className="divide-y divide-border">
                  {desk.review.delayed.slice(0, 2).map((c) => <CutLine key={c.id} c={c} href={href} onOpen={() => open({ kind: "cut", id: c.id })} delayed />)}
                </ul>
                <More n={desk.review.delayed.length - 2} href={href("/review")} what="delayed cut" />
              </>
            )}
            <p data-review-standards className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2 text-[12px] text-muted">
              Review standards: Sequence · Capture · Color · Audio · Text · AI · Client brief
            </p>
            <p data-approval-line className="mt-2 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Approval sends the verified version to Kyle&rsquo;s delivery queue, never straight to the client.
            </p>
          </Section>
        </div>
      )}

      {mode === "production" && <ProductionFull desk={desk} href={href} />}

      {/* D · TEAM DEVELOPMENT & QUALITY (+ E · READINESS) */}
      {desk.team && mode !== "production" && (
        <Section id="team" title="Team Development & Quality" subtitle="Train, coach, assess readiness, and follow through." count={desk.team.groups.reduce((n, gr) => n + gr.items.length + gr.signals.length, 0)} viewAll={mode === "home" ? { label: "View all", href: href("/development") } : null}>
          {desk.team.unavailable.length > 0 && (
            <p role="status" className="mb-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">Couldn&rsquo;t read {desk.team.unavailable.join(", ")}. The groups below may be missing evidence.</p>
          )}
          <div className="space-y-2">
            {desk.team.groups.map((gr) => <GroupBlock key={gr.key} g={gr} full={mode !== "home"} onOpen={open} readOnly={desk.readOnly} recordsUnavailable={desk.team!.recordsUnavailable} href={href} />)}
          </div>
          {desk.readiness && (mode === "home" ? (
            <div data-grid="tiles" className="mt-3 grid gap-3 sm:grid-cols-2">
              <TrainingTile desk={desk} onOpen={open} />
              <ReadinessTile items={desk.readiness.items} unavailable={desk.readiness.unavailable} onOpen={open} readOnly={desk.readOnly} />
            </div>
          ) : (
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <FollowUps desk={desk} onOpen={open} />
              <ReadinessBlock items={desk.readiness.items} unavailable={desk.readiness.unavailable} limit={limit} onOpen={open} readOnly={desk.readOnly} viewAll={null} />
            </div>
          ))}
          <p data-staffing-line className="mt-3 text-center text-[12px] text-muted">{seatName(desk)} assesses readiness. Jordan makes staffing decisions.</p>
        </Section>
      )}

      {mode !== "production" && (
        <div data-grid="prep-improvements" className={GRID}>
          {/* F · CREATIVE PREPARATION, split (Jordan, Oct 27 2026: "one for listing scripts and one for monthly content scripts") */}
          {mode === "home" && (
            <div className="flex min-w-0 flex-col gap-4">
              <Section id="prep" title="Listing scripts" subtitle="Your listing shoots with an agent script." count={listing.length} viewAll={{ label: "View my shoots", href: href(desk.production.myShootsHref) }} unavailable={desk.prep.unavailable}>
                {listing.length === 0 ? (
                  <Empty>{desk.prep.unavailable ? "Creative preparation couldn't be read." : "No listing scripts on your shoots in the next two weeks."}</Empty>
                ) : (
                  <ul data-list="prep-listing" className="divide-y divide-border">
                    {listing.slice(0, limit).map((p) => <PrepLine key={p.key} p={p} href={href} readOnly={desk.readOnly} />)}
                  </ul>
                )}
                <More n={listing.length - limit} href={href(desk.production.myShootsHref)} what="listing script" />
              </Section>
              <Section id="prep-monthly" title="Monthly content scripts" subtitle="Scripts approved before each filming session." count={monthly.length} viewAll={{ label: "View monthly content", href: href("/content") }} unavailable={desk.prep.unavailable}>
                {monthly.length === 0 ? (
                  <Empty>{desk.prep.unavailable ? "Creative preparation couldn't be read." : "No monthly content assigned to you for this month or next."}</Empty>
                ) : (
                  <ul data-list="prep-monthly" className="divide-y divide-border">
                    {monthly.slice(0, limit).map((p) => <PrepLine key={p.key} p={p} href={href} readOnly={desk.readOnly} />)}
                  </ul>
                )}
                <More n={monthly.length - limit} href={href("/content")} what="client" />
                <p className="mt-2 text-[12px] text-muted">Assigned work only. Ownership is shown on every item.</p>
              </Section>
            </div>
          )}

          {/* G · PROCESS IMPROVEMENTS */}
          <ImprovementsCard desk={desk} mode={mode} href={href} onOpen={open} />
        </div>
      )}

      {/* H · ASSIGNED TO ME & HANDOFFS, with the end-of-day check */}
      {mode === "home" && (
        <>
          <Section id="assigned" title="Assigned to Me & Handoffs" count={desk.assigned.items.length} viewAll={{ label: "View all tasks", href: href("/tasks") }} unavailable={desk.assigned.unavailable}>
            {desk.assigned.items.length === 0 ? (
              <Empty>{desk.assigned.unavailable ? "Your tasks couldn't be read." : "Nothing is assigned to you right now."}</Empty>
            ) : (
              <AssignedTable rows={desk.assigned.items.slice(0, Math.max(limit, 5))} onOpen={(id) => open({ kind: "task", id })} href={href} readOnly={desk.readOnly} />
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

/** Who assesses: the creative manager by name on his own desk. */
const seatName = (desk: Desk) => (desk.person.key && desk.person.key !== desk.ownerKey ? desk.person.first : "The creative manager");

// ---- B · production --------------------------------------------------------------------------

type ProdRow = { kind: "shoot"; s: ShootRow } | { kind: "handoff"; h: HandoffRow };

/** Today's visits first (in time order), then his handoffs to finish, then the visits ahead. */
function productionRows(desk: Desk): ProdRow[] {
  const today = desk.production.mine.filter((s) => s.today).map((s) => ({ kind: "shoot" as const, s }));
  const later = desk.production.mine.filter((s) => !s.today).map((s) => ({ kind: "shoot" as const, s }));
  const handoffs = desk.production.handoffs.map((h) => ({ kind: "handoff" as const, h }));
  return [...today, ...handoffs, ...later];
}

function ProductionCard({ desk, href, shown }: { desk: Desk; href: (h: string) => string; shown: number }) {
  const rows = productionRows(desk);
  const team = desk.production.team.length;
  const total = rows.length + team;
  return (
    <Section id="production" title="Production" subtitle="Capture, client direction, and clean handoffs." count={rows.length} viewAll={{ label: total > shown ? `Open full view (${total})` : "Open full view", href: href(desk.production.fullHref) }} unavailable={desk.production.unavailable}>
      {rows.length === 0 ? (
        <Empty>{desk.production.unavailable ? "Your shoots couldn't be read." : "No shoots on your calendar this week and no handoffs open."}</Empty>
      ) : (
        <ul data-list="production" className="divide-y divide-border">
          {rows.slice(0, shown).map((r) => r.kind === "shoot"
            ? <ShootLine key={`s:${r.s.id}`} s={r.s} href={href} readOnly={desk.readOnly} />
            : <HandoffLine key={`h:${r.h.projectId}`} h={r.h} href={href} readOnly={desk.readOnly} />)}
        </ul>
      )}
      {(rows.length > shown || team > 0) && (
        <p data-production-more className="mt-1 text-[12px] text-muted">
          {[rows.length > shown ? `${rows.length - shown} more of yours` : null, team ? `${team} team ${team === 1 ? "handoff" : "handoffs"} to check` : null].filter(Boolean).join(" · ")} in the full view.
        </p>
      )}
    </Section>
  );
}

function ProductionFull({ desk, href }: { desk: Desk; href: (h: string) => string }) {
  const p = desk.production;
  return (
    <>
      <Link href="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline">Back to the dashboard</Link>
      <Section id="production" title="Your shoots" subtitle="This week, today first." count={p.mine.length} viewAll={{ label: "My shoots list", href: href(p.myShootsHref) }} unavailable={p.unavailable}>
        {p.mine.length === 0 ? (
          <Empty>{p.unavailable ? "Your shoots couldn't be read." : "No shoots on your calendar for the next week."}</Empty>
        ) : (
          <ul data-list="my-shoots" className="divide-y divide-border">
            {p.mine.map((s) => <ShootLine key={s.id} s={s} href={href} readOnly={desk.readOnly} />)}
          </ul>
        )}
      </Section>
      <Section id="handoffs" title="Handoffs to finish" subtitle="Your shoots whose upload or instructions are not in." count={p.handoffs.length} viewAll={null} unavailable={p.unavailable}>
        {p.handoffs.length === 0 ? (
          <Empty>{p.unavailable ? "Your handoffs couldn't be read." : "Every shoot of yours is handed off."}</Empty>
        ) : (
          <ul data-list="my-handoffs" className="divide-y divide-border">
            {p.handoffs.map((h) => <HandoffLine key={h.projectId} h={h} href={href} readOnly={desk.readOnly} />)}
          </ul>
        )}
      </Section>
      <Section id="team-handoffs" title="Team shoots you supervise" subtitle="The field team's last two weeks, handoffs not complete." count={p.team.length} viewAll={null} unavailable={p.unavailable}>
        {p.team.length === 0 ? (
          <Empty>{p.unavailable ? "The team's shoots couldn't be read." : "Every team shoot from the last two weeks is handed off."}</Empty>
        ) : (
          <ul data-list="team-handoffs" className="divide-y divide-border">
            {p.team.map((h) => <HandoffLine key={h.projectId} h={h} href={href} readOnly={desk.readOnly} team />)}
          </ul>
        )}
        {p.closedOut > 0 && (
          <p data-closed-out={p.closedOut} className="mt-1 text-[12px] text-muted">{p.closedOut} closed out. Each comes back if anything new turns up on the job.</p>
        )}
      </Section>
    </>
  );
}

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
  // Full height of its grid cell, the link pinned to the bottom: two cards
  // side by side end level (Oct 27 2026: "All the cards should fit nicely").
  return (
    <section id={id} data-section={id} data-count={unavailable ? "?" : String(count)} aria-labelledby={`${id}-title`} className="panel-shadow flex h-full min-w-0 flex-1 scroll-mt-28 flex-col rounded-2xl border border-border bg-surface">
      <div className="flex items-start gap-3 px-4 pb-1 pt-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-lg font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="text-[13px] text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="flex-1 px-4 pb-3">{children}</div>
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
const RowIcon = ({ children }: { children: React.ReactNode }) => <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{children}</span>;

function More({ n, href, what }: { n: number; href: string; what: string }) {
  if (n <= 0) return null;
  return <Link href={href} className="inline-flex min-h-11 items-center text-[13px] font-medium text-muted hover:text-brand">+{n} more {what}{n === 1 ? "" : "s"}</Link>;
}

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-12 text-[12px]">
      {chips.map((c) => (
        <li key={c.key} data-chip={c.key} data-tone={c.tone} className={cn("inline-flex items-center gap-1", CHIP_TONE[c.tone])}>
          {c.tone === "ok" ? <CheckCircle2 aria-hidden className="size-3.5" /> : <span aria-hidden className={cn("size-2.5 rounded-full border", c.tone === "todo" ? "border-warning" : "border-border-strong")} />}
          {c.label}
        </li>
      ))}
    </ul>
  );
}

function ShootLine({ s, href, readOnly }: { s: ShootRow; href: (h: string) => string; readOnly: boolean }) {
  // The row's ONE main action (Oct 27 2026): the handoff once the visit is
  // over, the brief's Got it while Kyle waits on it, else the brief itself.
  const primary = s.over ? "finish" : s.briefAck && !readOnly ? "ack" : "brief";
  const studio = s.links.filter((l) => l.external);
  return (
    <li data-shoot={s.id} data-today={s.today ? "true" : "false"} data-over={s.over ? "true" : "false"} data-started={s.started ? "true" : "false"} className="py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <RowIcon><Camera className="size-4" /></RowIcon>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{s.street}{s.clientName ? <span className="font-normal text-muted"> · {s.clientName}</span> : null}</p>
          <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{s.whenWords}{s.services.length ? ` · ${s.services.slice(0, 3).join(", ")}` : ""}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {s.status && <span data-status={s.status.label} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PILL_TONE[s.status.tone])}>{s.status.label}</span>}
          {primary === "finish" && <Link href={href(s.finishHref)} data-primary="finish" className={PRIMARY}><Upload aria-hidden className="size-4" />Finish handoff</Link>}
          {primary === "ack" && s.briefAck && <MarkBriefRead day={s.briefAck.day} digest={s.briefAck.digest} again={s.briefAck.again} />}
          {primary === "brief" && <Link href={href(s.links[0].href)} data-primary="brief" className={QUIET}>{s.links[0].label}</Link>}
        </div>
      </div>
      <Chips chips={s.chips} />
      {s.requests.length > 0 && <p className="mt-1 pl-12 text-[12px] text-muted [overflow-wrap:anywhere]">Requests: {s.requests.slice(0, 2).join(" · ")}{s.requests.length > 2 ? ` (+${s.requests.length - 2})` : ""}</p>}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-4 pl-12">
        {primary !== "brief" && <Link href={href(s.links[0].href)} className={LINK}>{s.links[0].label}</Link>}
        <AskOnJob projectId={s.projectId} label="Ask Kyle or Jordan" placeholder="e.g. Is the agent on camera? How do I get in?" readOnly={readOnly} />
        <Link href={href(`/shoot/${s.projectId}#flag`)} className={LINK}>Flag a problem</Link>
        {studio.map((l) => <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className={cn(LINK, "gap-1")}>{l.label} <ExternalLink aria-hidden className="size-3" /></a>)}
      </div>
    </li>
  );
}

function HandoffLine({ h, href, readOnly, team = false }: { h: HandoffRow; href: (h: string) => string; readOnly: boolean; team?: boolean }) {
  return (
    <li data-handoff={h.projectId} data-mine={h.mine ? "true" : "false"} className="py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <RowIcon><Upload className="size-4" /></RowIcon>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{team ? `${h.photographer.split(" ")[0]} · ` : ""}{h.street}{h.clientName ? <span className="font-normal text-muted"> · {h.clientName}</span> : null}</p>
          <p className="text-[12px] font-medium text-warning [overflow-wrap:anywhere]">{h.status}</p>
        </div>
        {team
          ? <Link href={href(h.links[0].href)} className={cn(QUIET, "shrink-0")}>Check upload</Link>
          : <Link href={href(h.finishHref)} data-primary="finish" className={cn(PRIMARY, "shrink-0")}>Finish handoff</Link>}
      </div>
      <Chips chips={h.lines} />
      {h.missing.length > 0 && <p className="mt-1 pl-12 text-[12px] text-muted [overflow-wrap:anywhere]">Missing: {h.missing.join("; ")}</p>}
      {h.exceptions.length > 0 && <p className="mt-0.5 pl-12 text-[12px] text-muted [overflow-wrap:anywhere]">Exceptions: {h.exceptions.join("; ")}</p>}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-4 pl-12">
        {!team && <Link href={href(`/shoot/${h.projectId}#flag`)} className={LINK}>Flag a problem</Link>}
        <HandoffCloseOut row={h} readOnly={readOnly} />
      </div>
    </li>
  );
}

// ---- C · review --------------------------------------------------------------------------------

function CutLine({ c, href, onOpen, delayed = false }: { c: CutRow; href: (h: string) => string; onOpen: () => void; delayed?: boolean }) {
  return (
    <li data-cut={c.id} data-version={c.version} className="py-2.5">
      {/* Phone layout (Jordan, Oct 28 2026): the buttons wrap under the words instead of squeezing them. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <RowIcon><Video className="size-4" /></RowIcon>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{c.street}{c.clientName ? <span className="font-normal text-muted"> · {c.clientName}</span> : null}</p>
          <p className="text-[12px] text-muted">
            Version {c.version} · {c.priorNotes.total ? "Corrections returned" : "First review"}{c.editor ? ` · ${c.editor}` : ""}{delayed && c.reviewer ? ` · with ${c.reviewer}` : ""} · waiting {c.waitedWords}
          </p>
          {(c.dueWords || c.why) && <p className={cn("text-[12px]", c.delayed ? "font-medium text-danger" : "text-muted")}>{[c.dueWords ? `Due ${c.dueWords.replace(/^Today/, "today")}` : null, c.why].filter(Boolean).join(" · ")}</p>}
          {!delayed && <button type="button" data-open-panel={`cut:${c.id}`} onClick={onOpen} className={LINK}>Approve or escalate</button>}
        </div>
        {delayed
          ? <button type="button" data-open-panel={`cut:${c.id}`} onClick={onOpen} className={cn(QUIET, "ml-auto")}>Follow up</button>
          : <Link href={href(c.href)} className={cn(PRIMARY, "ml-auto")}>Review</Link>}
      </div>
    </li>
  );
}

// ---- D · team development ------------------------------------------------------------------------

const GROUP_ICON = { FIELD: Camera, EDITOR: Clapperboard, QC: ShieldCheck } as const;
const GROUP_TINT = { FIELD: "bg-sky-500/10 text-sky-500", EDITOR: "bg-violet-500/10 text-violet-500", QC: "bg-emerald-500/10 text-emerald-500" } as const;
const GROUP_WORDS = { FIELD: "field creatives", EDITOR: "editors", QC: "admin QC" } as const;
/** The group's one action, in the mockup's words. */
const GROUP_ACTION = { FIELD: "Assess work", EDITOR: "Review examples", QC: "Open QC review" } as const;

type DevRow = { kind: "item" | "signal"; id: string; who: string; what: string; count: string | null; next: string; due: boolean; panel: Panel };

/** One group's rows, the one that needs him first: a follow-up due, then recorded coaching, then the evidence with the most cases. */
function devRows(g: DevGroupView): DevRow[] {
  const first = (n: string) => n.split(" ")[0];
  const item = (i: DevItemView): DevRow => ({
    kind: "item", id: i.id, who: first(i.personName), what: i.skill, count: null, due: i.followUpDue,
    next: i.followUpDue ? `Record the follow-up${i.nextAction ? `: ${i.nextAction}` : ""}` : i.nextAction ?? (i.followUpISO ? `Follow up ${etDate(i.followUpISO)}` : "Set a next step"),
    panel: { kind: "dev-item", id: i.id },
  });
  const signal = (s: Signal): DevRow => ({
    kind: "signal", id: s.key, who: first(s.personName), what: s.skill, count: s.countWords, due: false,
    next: "Review the examples and record feedback", panel: { kind: "signal", key: s.key },
  });
  const items = [...g.items].sort((a, b) => Number(b.followUpDue) - Number(a.followUpDue));
  const signals = [...g.signals].sort((a, b) => b.count - a.count);
  return [...items.map(item), ...signals.map(signal)];
}

function GroupBlock({ g, full, onOpen, readOnly, recordsUnavailable, href }: { g: DevGroupView; full: boolean; onOpen: (p: Panel) => void; readOnly: boolean; recordsUnavailable: boolean; href: (h: string) => string }) {
  const Icon = GROUP_ICON[g.key];
  const rows = devRows(g);
  const top = rows[0] ?? null;
  return (
    <div data-group={g.key} data-items={g.items.length} data-signals={g.signals.length} className="rounded-xl border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", GROUP_TINT[g.key])}><Icon className="size-5" /></span>
        <h3 className="w-32 shrink-0 text-sm font-semibold uppercase tracking-wide">{g.label}</h3>
        <div className="min-w-0 flex-1 basis-48">
          {top && !full ? (
            <>
              <p data-dev-row={top.kind} className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{top.who} · {top.what}{top.count && <span className="font-normal text-muted"> ({top.count})</span>}</p>
              <p className={cn("text-[12px] [overflow-wrap:anywhere]", top.due ? "font-medium text-warning" : "text-muted")}>Next step: {top.next}</p>
            </>
          ) : !top ? (
            <p className="text-[13px] text-muted">{g.people.length === 0 ? "Nobody in this group on the roster." : `No recorded coaching and no quality evidence for ${GROUP_WORDS[g.key]} right now.`}</p>
          ) : (
            <p className="text-[12px] text-muted">{g.blurb}</p>
          )}
        </div>
        {top && !full ? (
          <button type="button" data-open-panel={`${top.kind === "item" ? "dev-item" : "signal"}:${top.id}`} onClick={() => onOpen(top.panel)} className={cn(top.due || g.key === "FIELD" ? PRIMARY : QUIET, "shrink-0")}>{top.due ? "Record follow-up" : GROUP_ACTION[g.key]}</button>
        ) : !readOnly ? (
          <button type="button" data-open-panel={`new-dev:${g.key}`} onClick={() => onOpen({ kind: "new-dev", group: g.key })} className={cn(QUIET, "shrink-0")} disabled={recordsUnavailable}>Record feedback</button>
        ) : null}
      </div>
      {!full && rows.length > 1 && (
        <p className="mt-0.5 pl-[3.25rem] text-[12px] text-muted"><Link href={href("/development")} className="inline-flex min-h-8 items-center hover:text-brand">+{rows.length - 1} more in team development</Link></p>
      )}
      {full && rows.length > 0 && (
        <ul className="mt-1 divide-y divide-border sm:pl-[3.25rem]">
          {rows.map((r) => (
            <li key={`${r.kind}:${r.id}`} data-dev-row={r.kind} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{r.who} · {r.what}{r.count && <span className="font-normal text-muted"> ({r.count})</span>}</p>
                <p className={cn("text-[12px] [overflow-wrap:anywhere]", r.due ? "font-medium text-warning" : "text-muted")}>Next step: {r.next}</p>
              </div>
              <button type="button" data-open-panel={`${r.kind === "item" ? "dev-item" : "signal"}:${r.id}`} onClick={() => onOpen(r.panel)} className={cn(r.due ? PRIMARY : QUIET, "ml-auto")}>{r.due ? "Record follow-up" : r.kind === "item" ? "Open" : "Review examples"}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({ icon, title, children, tint }: { icon: React.ReactNode; title: string; children: React.ReactNode; tint: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-border px-3 py-2.5">
      <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", tint)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Training follow-up: the coaching follow-up due (or the next one scheduled), one action. */
function TrainingTile({ desk, onOpen }: { desk: Desk; onOpen: (p: Panel) => void }) {
  const items = (desk.team?.groups ?? []).flatMap((g) => g.items);
  const due = items.filter((i) => desk.team!.dueIds.includes(i.id));
  const next = due[0] ?? [...items].filter((i) => i.followUpISO || i.practiceDueISO).sort((a, b) => (a.followUpISO ?? a.practiceDueISO ?? "").localeCompare(b.followUpISO ?? b.practiceDueISO ?? ""))[0] ?? null;
  return (
    <div data-followups={due.length}>
      <Tile icon={<GraduationCap className="size-5" />} title="Training follow-up" tint="bg-sky-500/10 text-sky-500">
        {!next ? (
          <p className="text-[13px] text-muted">{desk.team?.recordsUnavailable ? "Recorded coaching couldn't be read." : "No follow-up scheduled."}</p>
        ) : (
          <>
            <p className="text-[13px] font-semibold [overflow-wrap:anywhere]">{next.personName.split(" ")[0]} · {next.skill}</p>
            <p className={cn("text-[12px]", due.length ? "font-medium text-warning" : "text-muted")}>
              {due.length ? `Follow-up due${due.length > 1 ? ` (${due.length} in all)` : ""}` : next.practice && next.practiceDueISO ? `Practice due ${etDate(next.practiceDueISO)}` : next.followUpISO ? `Follow up ${etDate(next.followUpISO)}` : ""}
            </p>
            <button type="button" data-open-panel={`dev-item:${next.id}`} onClick={() => onOpen({ kind: "dev-item", id: next.id })} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">
              {due.length ? "Record follow-up" : "View training plan"} <ArrowRight aria-hidden className="size-4" />
            </button>
          </>
        )}
      </Tile>
    </div>
  );
}

const REC_WORDS = { READY: "Ready", READY_WITH_SUPPORT: "Ready with support", NOT_YET: "Not yet" } as const;

/** Readiness recommendations: the assessment that needs him first, one action. */
function ReadinessTile({ items, unavailable, onOpen, readOnly }: { items: ReadinessView[]; unavailable: boolean; onOpen: (p: Panel) => void; readOnly: boolean }) {
  const rank = (a: ReadinessView) => (a.status === "DRAFT" && a.recommendation ? 0 : a.status === "DRAFT" ? 1 : 2);
  const a = [...items].sort((x, y) => rank(x) - rank(y))[0] ?? null;
  return (
    <div id="readiness" data-section="readiness" data-count={unavailable ? "?" : String(items.length)} className="scroll-mt-28">
      <Tile icon={<BarChart3 className="size-5" />} title="Readiness recommendations" tint="bg-brand/10 text-brand">
        {!a ? (
          <>
            <p className="text-[13px] text-muted">{unavailable ? "Readiness assessments couldn't be read." : "No assessment in progress."}</p>
            {!readOnly && !unavailable && <button type="button" data-open-panel="new-readiness" onClick={() => onOpen({ kind: "new-readiness" })} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">Start one <ArrowRight aria-hidden className="size-4" /></button>}
          </>
        ) : (
          <>
            <p data-readiness={a.id} data-status={a.status} className="text-[13px] font-semibold [overflow-wrap:anywhere]">{a.personName.split(" ")[0]} · {a.trackLabel}</p>
            <p className="text-[12px] text-muted">
              {a.status === "RECOMMENDED" ? (a.decision ? a.decision.words : "With Jordan for a decision")
                : a.recommendation ? `${a.met} of ${a.criteria.length} criteria met · You recommend: ${REC_WORDS[a.recommendation]}`
                : `${a.met} of ${a.criteria.length} criteria met · Evidence needed before recommendation`}
            </p>
            <button type="button" data-open-panel={`readiness:${a.id}`} onClick={() => onOpen({ kind: "readiness", id: a.id })} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">
              {a.status === "RECOMMENDED" ? "See the decision" : a.recommendation ? "Recommend to Jordan" : "Assess the evidence"} <ArrowRight aria-hidden className="size-4" />
            </button>
            {items.length > 1 && <p className="text-[12px] text-muted">{items.length - 1} more in team development</p>}
          </>
        )}
      </Tile>
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
          {items.map((i) => (
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
            <li key={a.id} data-readiness={a.id} data-status={a.status} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-1.5">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-[13px] font-semibold">{a.personName.split(" ")[0]} · {a.trackLabel}</p>
                <p className="text-[12px] text-muted">
                  {a.met} of {a.criteria.length} criteria met{a.recommendation ? ` · You recommend: ${REC_WORDS[a.recommendation]}` : " · No recommendation yet"}
                  {a.decision ? ` · ${a.decision.words}` : ""}
                </p>
              </div>
              <button type="button" data-open-panel={`readiness:${a.id}`} onClick={() => onOpen({ kind: "readiness", id: a.id })} className="ml-auto inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">
                {a.status === "DRAFT" && a.recommendation ? "Recommend to Jordan" : a.status === "DRAFT" ? "Assess" : "See the decision"} <ArrowRight aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewAll && items.length > limit && <Link href={viewAll} className="inline-flex min-h-8 items-center text-[12px] text-muted hover:text-brand">+{items.length - limit} more</Link>}
    </div>
  );
}

// ---- F · creative preparation ---------------------------------------------------------------------

const MODE_TONE = { JORDAN_OWNS: "bg-warning/15 text-warning", JAMES_DRAFTS: "bg-success/15 text-success", JAMES_OWNS: "bg-brand/15 text-brand" } as const;
const MODE_LABEL = { JORDAN_OWNS: "Jordan owns", JAMES_DRAFTS: "James drafts", JAMES_OWNS: "James owns" } as const;

/** One line of detail, the owner chip, one button (Oct 27 2026: "clean it up so it looks nicer"). */
function PrepLine({ p, href, readOnly }: { p: PrepRow; href: (h: string) => string; readOnly: boolean }) {
  const listing = p.kind === "listing";
  const name = listing ? p.title.replace(/^Listing script · /, "") : p.clientName ?? p.title;
  const sub = listing ? p.clientName : null;
  const script = p.links[0];
  // The button: a listing script is his to approve (Oct 27 2026), so it opens
  // the script; a monthly draft of his opens, one he owns is reviewed;
  // Jordan's monthly takes his input on the session's job.
  const jordans = !listing && p.mode === "JORDAN_OWNS" && !!p.projectId;
  const button = listing
    ? <PrepLink l={script} href={href} label={/your review/.test(p.status ?? "") ? "Review script" : "Open script"} primary />
    : jordans
      ? <AskOnJob projectId={p.projectId!} to="jordan" label="Add input" variant="primary" placeholder="Production input for the script: shots, location, on-camera notes" readOnly={readOnly} />
      : <PrepLink l={script} href={href} label={p.mode === "JAMES_DRAFTS" ? "Open draft" : p.mode === "JAMES_OWNS" ? "Review" : "Open scripts"} primary={p.mode !== "JORDAN_OWNS"} />;
  return (
    <li data-prep={p.key} data-mode={p.mode} className="py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <RowIcon><FileText className="size-4" /></RowIcon>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{name}{sub ? <span className="font-normal text-muted"> · {sub}</span> : null}</p>
          <p data-prep-detail className="text-[12px] text-muted [overflow-wrap:anywhere]">{p.detail}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span title={`${p.role}. ${p.source}.`} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", MODE_TONE[p.mode])}>{MODE_LABEL[p.mode]}</span>
          {button}
        </div>
      </div>
      {jordans && script && (
        <p className="mt-0.5 pl-12"><PrepLink l={script} href={href} label="Open scripts" /></p>
      )}
    </li>
  );
}

function PrepLink({ l, href, label, primary }: { l: PrepRow["links"][number] | undefined; href: (h: string) => string; label: string; primary?: boolean }) {
  if (!l) return null;
  const cls = primary === undefined ? cn(LINK, "gap-1") : primary ? PRIMARY : QUIET;
  return l.external
    ? <a href={l.href} target="_blank" rel="noreferrer" className={cls}>{label} <ExternalLink aria-hidden className="size-3" /></a>
    : <Link href={href(l.href)} className={cls}>{label}</Link>;
}

// ---- G · process improvements ------------------------------------------------------------------

const AREA_ICON: Record<string, typeof Wrench> = { "Quality checklists": ClipboardCheck, "Shot lists": ListChecks, "Uploads and handoffs": Upload, "Review procedure": Video };

function ImprovementsCard({ desk, mode, href, onOpen }: { desk: Desk; mode: DeskMode; href: (h: string) => string; onOpen: (p: Panel) => void }) {
  const { frictions, items, unavailable } = desk.improvements;
  // A tracked friction shows once, on its friction row.
  const shownFriction = new Set(frictions.map((f) => f.key));
  const rest = items.filter((i) => !i.friction || !shownFriction.has(i.friction));
  const total = frictions.length + rest.length;
  const cap = mode === "home" ? 3 : 1000;
  const fShown = frictions.slice(0, cap);
  const iShown = rest.slice(0, Math.max(0, cap - fShown.length));
  return (
    <Section id="improvements" title="Process Improvements" subtitle="Fix recurring production friction." count={total} viewAll={mode === "home" ? { label: "Track improvement tasks", href: href("/development#improvements") } : null} unavailable={unavailable}
      action={!desk.readOnly ? <button type="button" data-open-panel="new-improvement" onClick={() => onOpen({ kind: "new-improvement" })} className={QUIET}>Log one</button> : null}>
      {total === 0 ? (
        <Empty>{unavailable ? "Improvement tasks couldn't be read." : "Nothing recurring in what the hub counts, and no improvement tasks open."}</Empty>
      ) : (
        <ul data-list="improvements" className="divide-y divide-border">
          {fShown.map((f) => <FrictionLine key={f.key} f={f} onOpen={onOpen} />)}
          {iShown.map((i) => <ImprovementLine key={i.taskId} i={i} onOpen={() => onOpen({ kind: "improvement", id: i.taskId })} />)}
        </ul>
      )}
      <More n={total - fShown.length - iShown.length} href={href("/development#improvements")} what="improvement" />
      {frictions.length > 0 && <p className="mt-1 text-[12px] text-muted">Counted from upload times, handoff notes, the photo check and revision causes. Shown once it happens twice.</p>}
    </Section>
  );
}

function FrictionLine({ f, onOpen }: { f: FrictionRow; onOpen: (p: Panel) => void }) {
  const Icon = AREA_ICON[f.area] ?? Wrench;
  return (
    <li data-friction={f.key} data-count={f.count} data-tracked={f.taskId ? "true" : "false"} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
      <RowIcon><Icon className="size-4" /></RowIcon>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{f.title}</p>
        <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{f.evidence}{f.taskId ? " · Improvement open" : ""}</p>
      </div>
      {f.taskId
        ? <button type="button" data-open-panel={`improvement:${f.taskId}`} onClick={() => onOpen({ kind: "improvement", id: f.taskId! })} className={cn(QUIET, "shrink-0")}>Update</button>
        : <button type="button" data-open-panel={`friction:${f.key}`} onClick={() => onOpen({ kind: "friction", key: f.key })} className={cn(QUIET, "shrink-0")}>{f.action}</button>}
    </li>
  );
}

function ImprovementLine({ i, onOpen }: { i: ImprovementRow; onOpen: () => void }) {
  const Icon = AREA_ICON[i.area ?? ""] ?? Wrench;
  return (
    <li data-improvement={i.taskId} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
      <RowIcon><Icon className="size-4" /></RowIcon>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{i.problem}</p>
        <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{i.nextStep ? `Next: ${i.nextStep}` : "No next step yet"} · {i.status}{i.owner && !i.mine ? ` · ${i.owner}` : ""}{i.policy ? " · Jordan approves" : ""}</p>
      </div>
      <button type="button" data-open-panel={`improvement:${i.taskId}`} onClick={onOpen} className={cn(QUIET, "shrink-0")}>Update</button>
    </li>
  );
}

// ---- H · assigned -------------------------------------------------------------------------------

const STATE_TONE: Record<string, string> = {
  ASSIGNED: "bg-warning/15 text-warning",
  ACCEPTED: "bg-brand/15 text-brand",
  IN_PROGRESS: "bg-brand/15 text-brand",
  BLOCKED: "bg-danger/15 text-danger",
  READY_FOR_VERIFICATION: "bg-success/15 text-success",
  OPEN: "bg-warning/15 text-warning",
  WAITING: "bg-surface-2 text-muted",
};

function AssignedTable({ rows, onOpen, href, readOnly }: { rows: AssignedRow[]; onOpen: (id: string) => void; href: (h: string) => string; readOnly: boolean }) {
  return (
    <div data-list="assigned" className="overflow-hidden rounded-xl border border-border">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_9rem] gap-3 bg-surface-2/70 px-3 py-2 text-[12px] font-semibold text-muted md:grid">
        <span>Task</span><span>Due</span><span>Status</span><span>Action</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.taskId} data-task={r.taskId} data-state={r.state} data-urgent={r.urgent ? "true" : "false"} className="grid gap-1 px-3 py-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_9rem] md:items-center md:gap-3">
            <div className="min-w-0">
              <Link href={href(r.href)} className="text-sm font-medium leading-snug hover:text-brand [overflow-wrap:anywhere]">{r.title}</Link>
              <p className="text-[12px] text-muted [overflow-wrap:anywhere]">{[r.assignedBy ? `From ${r.assignedBy}` : null, r.blocker ? `Blocked: ${r.blocker}` : r.nextStep ? `Next: ${r.nextStep}` : null, r.closesItself ? "Closes when the editors tap Got it" : null].filter(Boolean).join(" · ")}</p>
            </div>
            <p className={cn("text-[13px]", r.overdue ? "font-medium text-danger" : "text-muted")}>{r.dueWords ?? "No due date"}</p>
            <p><span className={cn("inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium", STATE_TONE[r.state] ?? "bg-surface-2 text-muted")}>{r.state === "OPEN" ? "Awaiting acceptance" : r.stateWords}</span></p>
            <AssignedAction r={r} href={href} onOpen={() => onOpen(r.taskId)} readOnly={readOnly} />
          </li>
        ))}
      </ul>
    </div>
  );
}
