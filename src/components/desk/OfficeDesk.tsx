"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, ChevronDown, Circle, Clock, ExternalLink, Film, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { etDate, etDateTime, etTime } from "@/lib/datetime";
// Types only: lib/officeDesk is server code, never part of this client module graph.
import type { AssetLine, CheckGroup, DeskAction, DeskItem, DeskSection, DeskTag, OfficeDesk as Desk, PrepVisit } from "@/lib/officeDesk";
import { PhotoImg } from "@/components/photoDelivery/PhotoImg";
import { SendVideo } from "@/components/videoDelivery/SendVideo";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { NotTold } from "@/components/ops/NotTold";
import { CommsDismissButton } from "@/components/tasks/ChecklistButtons";
import { OldItemActions } from "@/components/home/OldItemActions";
import { AskQuickActions } from "@/components/home/AskQuickActions";
import { RemindPhotographerButton } from "@/components/editing/RemindPhotographer";
import { BriefSend, CloseoutTick, ConfirmControls, FinishDay, FollowUpCreate, PhotoApprove, PRIMARY, QUIET, ReplyBox, WaitOn } from "@/components/desk/DeskControls";

// ---------------------------------------------------------------------------
// KYLE'S DESK, THE SCREEN, revision 2 (Oct 23 2026, evening: Jordan's mockup).
// No "Do next", no wall of counts, no tabs: the Daily checks bar, then four
// sections all visible in a wide two-column grid (one column on a phone):
// Review & Deliver, Client Communications, Today's Shoots, Requests &
// Follow-Ups. A few rows each, "View all" for the rest, a clear empty state.
// A row's button opens the side panel, which holds the existing actions, so
// the page never changes under Kyle; after an action it refreshes in place
// and the counts recompute. Every number arrives computed (lib/officeDesk).
// No checklists inside review: the free photo check's findings are context.
// ---------------------------------------------------------------------------

const CHIP_TONE = { ok: "bg-success/15 text-success", warn: "bg-warning/15 text-warning", bad: "bg-danger/15 text-danger", muted: "bg-surface-2 text-muted" } as const;
const ASSET_TONE: Record<AssetLine["tone"], string> = {
  now: "bg-warning/15 text-warning",
  waiting: "bg-surface-2 text-muted",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
};
const ASSET_WORD: Record<AssetLine["tone"], string> = { now: "Needs you", waiting: "On its way", done: "Done", failed: "Failed" };
const TAG: Record<DeskTag, { label: string; cls: string }> = {
  revision: { label: "Client revision", cls: "bg-brand-soft text-brand" },
  request: { label: "Special request", cls: "bg-brand-soft text-brand" },
  jordan: { label: "From Jordan", cls: "bg-warning/15 text-warning" },
  production: { label: "Production", cls: "bg-surface-2 text-muted" },
  task: { label: "Your task", cls: "bg-surface-2 text-muted" },
  reply: { label: "Reply", cls: "bg-surface-2 text-muted" },
  program: { label: "Content Program", cls: "bg-surface-2 text-muted" },
  booking: { label: "Booking", cls: "bg-surface-2 text-muted" },
  lead: { label: "Lead", cls: "bg-surface-2 text-muted" },
};
/** Rows a section shows before "View all" (the rest are one press away). */
const ROWS_SHOWN = 4;
const SOLID = new Set<DeskAction["kind"]>(["photo-approve", "video-send", "video-push", "reply", "confirm"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function OfficeDesk({ desk, includeTest = false, initialOpen = null, initialChecks = null, initialDay = "today" }: {
  desk: Desk;
  includeTest?: boolean;
  /** a drill can render the side panel open */
  initialOpen?: string | null;
  /** a drill can render a review's checks open */
  initialChecks?: CheckGroup["key"] | null;
  initialDay?: "today" | "next";
}) {
  const all = new Map(desk.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]).map((i) => [i.id, i]));
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [openedTitle, setOpenedTitle] = useState<string | null>(initialOpen ? all.get(initialOpen)?.title ?? null : null);
  const show = (i: DeskItem) => { setOpen(i.id); setOpenedTitle(i.title); };
  const showId = (id: string) => { const i = all.get(id); if (i) show(i); };
  const item = open ? all.get(open) ?? null : null;
  const sec = (k: DeskSection["key"]) => desk.sections.find((s) => s.key === k)!;
  const problems = desk.freshness.filter((f) => f.state !== "ok");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div data-office-desk data-readonly={desk.readOnly ? "true" : "false"} className="space-y-4">
      {desk.readOnly && (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
          Preview: read-only. The buttons are off while you view as {desk.person}.
        </p>
      )}
      {problems.length > 0 && (
        <ul aria-label="Data freshness" data-freshness className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-warning/30 bg-warning/5 px-4 py-2 text-[13px]">
          {problems.map((f) => (
            <li key={f.key} data-fresh={f.key} data-state={f.state} className={cn("inline-flex items-center gap-1", f.state === "failed" ? "text-danger" : "text-warning")}>
              <AlertTriangle aria-hidden className="size-3.5" /> <span className="font-medium">{f.label}</span> {f.words}
            </li>
          ))}
        </ul>
      )}
      {desk.urgent.length > 0 && (
        <section aria-label="Needs you now" data-urgent className="rounded-2xl border border-danger/40 bg-danger/5 px-4 py-3">
          <ul className="space-y-1.5">
            {desk.urgent.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
                <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />
                <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{u.text}</span>
                <button type="button" onClick={() => showId(u.id)} data-open-panel={u.id} className={PRIMARY}>Open</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DailyChecksBar desk={desk} initial={initialChecks} />

      <div className="grid items-start gap-4 lg:grid-cols-2" data-desk-grid>
        <ReviewDeliver s={sec("deliver")} onOpen={show} />
        <Communications s={sec("comms")} onOpen={show} />
        <Shoots s={sec("shoots")} onOpen={show} initialDay={initialDay} includeTest={includeTest} />
        <FollowUps s={sec("followups")} onOpen={show} backlog={desk.backlog} includeTest={includeTest} />
      </div>

      {open && <SidePanel item={item} fallbackTitle={openedTitle} desk={desk} includeTest={includeTest} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---- the daily checks ------------------------------------------------------------------

function DailyChecksBar({ desk, initial }: { desk: Desk; initial: CheckGroup["key"] | null }) {
  const [open, setOpen] = useState<CheckGroup["key"] | null>(initial);
  const c = desk.checks;
  const group = c.groups.find((g) => g.key === open) ?? null;
  return (
    <section aria-labelledby="daily-checks-title" data-daily-checks className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-5">
        <h2 id="daily-checks-title" className="mr-2 text-base font-semibold">Daily checks</h2>
        {c.groups.map((g) => (
          <button
            key={g.key}
            type="button"
            aria-expanded={open === g.key}
            data-check-group={g.key}
            data-done={g.done ? "true" : "false"}
            onClick={() => setOpen(open === g.key ? null : g.key)}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-sm hover:text-foreground"
          >
            {g.done ? <CheckCircle2 aria-label="Done" className="size-5 text-success" /> : <Circle aria-label="Not done" className="size-5 text-muted-2" />}
            {g.label}
            <ChevronDown aria-hidden className={cn("size-4 text-muted-2 transition-transform", open === g.key && "rotate-180")} />
          </button>
        ))}
      </div>
      {group && (
        <div className="space-y-3 border-t border-border px-4 py-3 sm:px-5" data-check-panel={group.key}>
          <ul className="space-y-1.5">
            {group.lines.map((l) => (
              <li key={l.key} data-check-line={l.key} data-done={l.done ? "true" : "false"} className="flex items-start gap-3">
                {l.auto === true ? (
                  <CheckCircle2 aria-label="Done (the system checked it)" className="mt-0.5 size-5 shrink-0 text-success" />
                ) : l.manual ? (
                  <CloseoutTick dayKey={c.dayKey} itemKey={l.key} checked={!!l.tick} disabled={desk.readOnly} label={l.label} />
                ) : (
                  <Circle aria-label="Not yet (the system ticks this when the work is done)" className="mt-0.5 size-5 shrink-0 text-muted-2" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{l.label}</span>
                  <span className="block text-[12px] text-muted">
                    {l.autoWords}
                    {l.tick && ` · reviewed by ${l.tick.by.split(" ")[0]} at ${etTime(l.tick.atISO)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-muted">A tick records your review; it never closes the work under it.</p>
          {group.key === "eod" && <EndOfDay desk={desk} />}
        </div>
      )}
    </section>
  );
}

function EndOfDay({ desk }: { desk: Desk }) {
  const c = desk.checks;
  const s = c.summary;
  const eod = c.groups.find((g) => g.key === "eod")!;
  return (
    <div className="space-y-3" data-day-summary>
      {c.finished ? (
        <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          Day finished at {etTime(c.finished.atISO)}.
          {c.newSinceFinish > 0 && <span className="text-warning"> {c.newSinceFinish} new since then: still on the desk.</span>}
        </p>
      ) : (
        <FinishDay dayKey={c.dayKey} disabled={desk.readOnly || !eod.done} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Block title={`You completed (${s.completedTotal})`}>
          {s.completed.length === 0 ? <li className="text-muted">Nothing recorded yet today.</li> : s.completed.map((x) => (
            <li key={x.what}><span className="font-medium">{x.count} · {x.what}</span>{x.examples.length > 0 && <span className="block text-[12px] text-muted">{x.examples.join(" · ")}</span>}</li>
          ))}
        </Block>
        <Block title="Still open">
          {s.pending.map((p) => <li key={p.section}>{p.section}: <span className="font-medium tabular-nums">{p.now == null ? "?" : p.now}</span>{p.waiting ? `, ${p.waiting} waiting on others` : ""}</li>)}
        </Block>
        <Block title="Blockers">{s.blockers.length === 0 ? <li className="text-muted">None.</li> : s.blockers.map((b) => <li key={b}>{b}</li>)}</Block>
        <Block title={`Next business day · ${s.tomorrow.dayWords}`}>{s.tomorrow.lines.map((l) => <li key={l}>{l}</li>)}</Block>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="mt-1 space-y-1 text-sm">{children}</ul>
    </div>
  );
}

// ---- the sections ------------------------------------------------------------------------

function Card({ s, subtitle, children, footer }: { s: DeskSection; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section aria-labelledby={`desk-${s.key}-title`} data-desk-section={s.key} data-count={s.count == null ? "?" : String(s.count)} className="panel-shadow flex min-w-0 flex-col rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5">
      <h2 id={`desk-${s.key}-title`} className="text-xl font-semibold leading-tight">{s.title}</h2>
      <p className="mt-0.5 text-sm text-muted" data-subtitle>{subtitle}</p>
      {s.unavailable.length > 0 && (
        <p role="status" className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Couldn&rsquo;t read {s.unavailable.join(", ")} just now. This may be missing items; refresh to try again.</p>
      )}
      <div className="mt-3 min-w-0 flex-1">{children}</div>
      {footer && <div className="mt-3 border-t border-border pt-3">{footer}</div>}
    </section>
  );
}

function Empty({ words }: { words: string }) {
  return <p className="flex items-center gap-2 py-2 text-sm text-success" data-empty><CheckCircle2 aria-hidden className="size-5" /> {words}</p>;
}

function ViewAll({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  if (total <= shown) return null;
  return (
    <button type="button" onClick={onClick} data-view-all className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
      View all {total} <ArrowRight aria-hidden className="size-3.5" />
    </button>
  );
}

function RowButton({ i, onOpen }: { i: DeskItem; onOpen: (i: DeskItem) => void }) {
  if (!i.primary) return null;
  const solid = SOLID.has(i.primary.action.kind) || i.late || i.rank === 0;
  return (
    <button type="button" onClick={() => onOpen(i)} data-open-panel={i.id} className={cn(solid ? PRIMARY : QUIET, "shrink-0 sm:min-w-28")}>
      {i.primary.label}
    </button>
  );
}

function Thumb({ i, icon }: { i: DeskItem; icon: "photo" | "video" | "shoot" }) {
  const Icon = icon === "video" ? Film : icon === "shoot" ? Camera : ImageIcon;
  return (
    <span className="relative flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-muted-2 sm:h-16 sm:w-24">
      {i.thumb ? <PhotoImg photoId={i.thumb.photoId} hash={i.thumb.hash} fallbackUrl={i.thumb.fallbackUrl} size="thumb256" alt="" className="size-full object-cover" /> : <Icon aria-hidden className="size-6" />}
    </span>
  );
}

function ReviewDeliver({ s, onOpen }: { s: DeskSection; onOpen: (i: DeskItem) => void }) {
  const [all, setAll] = useState(false);
  const rows = all ? s.now : s.now.slice(0, ROWS_SHOWN);
  const media = rows.filter((i) => i.group === "media");
  const video = rows.filter((i) => i.group === "video");
  const row = (i: DeskItem) => (
    <li key={i.id} data-desk-item={i.id} className="flex items-center gap-3 py-2.5">
      <Thumb i={i} icon={i.group === "video" ? "video" : "photo"} />
      <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
        <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
        <span className={cn("block text-sm", i.late ? "text-danger" : "text-foreground/80")}>{i.line}</span>
        <span className="block text-[13px] text-muted">{[i.client && `Client: ${i.client}`, i.dueWords].filter(Boolean).join(" · ")}</span>
      </button>
      <RowButton i={i} onOpen={onOpen} />
    </li>
  );
  return (
    <Card s={s} subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Nothing waiting on you" : `${plural(s.count, "job")} ready for your attention`}
      footer={s.quiet.length ? <ul className="space-y-1 text-[13px] text-muted" data-quiet>{s.quiet.map((q) => <li key={q.text}>{q.href ? <Link href={q.href} className="hover:text-foreground hover:underline">{q.text}</Link> : q.text}</li>)}</ul> : undefined}>
      {s.now.length === 0 ? <Empty words={s.empty} /> : (
        <>
          {media.length > 0 && <GroupHead>Photos, floor plans &amp; tours</GroupHead>}
          {media.length > 0 && <ul className="divide-y divide-border">{media.map(row)}</ul>}
          {video.length > 0 && <GroupHead>Approved videos</GroupHead>}
          {video.length > 0 && <ul className="divide-y divide-border">{video.map(row)}</ul>}
          <ViewAll shown={rows.length} total={s.now.length} onClick={() => setAll(true)} />
        </>
      )}
    </Card>
  );
}

function GroupHead({ children }: { children: ReactNode }) {
  return <h3 className="mt-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

function Communications({ s, onOpen }: { s: DeskSection; onOpen: (i: DeskItem) => void }) {
  const [all, setAll] = useState(false);
  const rows = all ? s.now : s.now.slice(0, ROWS_SHOWN);
  return (
    <Card s={s} subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Everyone has an answer" : `${plural(s.count, "client")} ${s.count === 1 ? "needs" : "need"} a reply`}
      footer={s.count != null && s.count > 0 && !s.unavailable.length ? <p className="flex items-center gap-2 text-sm text-muted"><CheckCircle2 aria-hidden className="size-4 text-success" /> Other conversations are up to date</p> : undefined}>
      {s.now.length === 0 ? <Empty words={s.empty} /> : (
        <>
          <ul className="divide-y divide-border">
            {rows.map((i) => (
              <li key={i.id} data-desk-item={i.id} className="flex items-center gap-3 py-3">
                <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold", i.late ? "bg-danger/15 text-danger" : "bg-brand-soft text-brand")}>{i.initials ?? "?"}</span>
                <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left sm:grid sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-3">
                  <span className="block min-w-0">
                    <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
                    <span className={cn("block text-[13px]", i.late ? "text-danger" : "text-muted")}>{[i.channel, i.elapsed].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="block text-sm text-foreground/80 [overflow-wrap:anywhere]">{i.line}</span>
                </button>
                <RowButton i={i} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          <ViewAll shown={rows.length} total={s.now.length} onClick={() => setAll(true)} />
        </>
      )}
    </Card>
  );
}

function Shoots({ s, onOpen, initialDay, includeTest }: { s: DeskSection; onOpen: (i: DeskItem) => void; initialDay: "today" | "next"; includeTest: boolean }) {
  const [day, setDay] = useState<"today" | "next">(initialDay);
  const everyone = [...s.now, ...s.waiting, ...s.ok];
  const ofDay = everyone.filter((i) => i.day === day).sort((a, b) => (timeOf(a) ?? "9999").localeCompare(timeOf(b) ?? "9999"));
  const over = (i: DeskItem) => i.panel.kind === "visit" && i.panel.visit.over;
  const upcoming = ofDay.filter((i) => !over(i));
  const past = ofDay.filter(over);
  const needs = (d: "today" | "next") => s.now.filter((i) => i.day === d).length;
  const count = (d: "today" | "next") => everyone.filter((i) => i.day === d).length;
  const row = (i: DeskItem) => {
    const v = i.panel.kind === "visit" ? i.panel.visit : null;
    return (
      <li key={i.id} data-desk-item={i.id} data-state={i.state} className="flex flex-wrap items-center gap-3 py-2.5 sm:flex-nowrap">
        <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{v?.timeISO ? `${day === "next" ? `${etDate(v.timeISO).split(",")[0]} ` : ""}${etTime(v.timeISO)}` : "No time"}</span>
        <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
          <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
          <span className="block text-[13px] text-muted">{v?.photographer ?? "No photographer"}</span>
        </button>
        <span className="min-w-0 sm:w-56">
          {i.chip && <span data-chip className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium", CHIP_TONE[i.chip.tone])}>{i.chip.tone === "ok" ? <CheckCircle2 aria-hidden className="size-3.5" /> : i.chip.tone === "muted" ? null : <Clock aria-hidden className="size-3.5" />}{i.chip.label}</span>}
          <span className="mt-0.5 block text-[12px] text-muted">{i.state === "now" ? i.line : v ? [v.confirmation.words, v.brief.words].join(" · ") : i.line}</span>
        </span>
        <RowButton i={i} onOpen={onOpen} />
      </li>
    );
  };
  return (
    <Card s={s} subtitle={`${plural(count(day), "shoot")} ${day === "today" ? "today" : "next business day"}${needs(day) ? ` · ${needs(day)} ${needs(day) === 1 ? "needs" : "need"} you` : ""}`}
      footer={<Link href={homeRecordHref("/schedule", includeTest)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">View schedule <ArrowRight aria-hidden className="size-3.5" /></Link>}>
      <div role="group" aria-label="Which day" className="mb-2 inline-flex rounded-lg border border-border p-0.5 text-sm">
        {(["today", "next"] as const).map((d) => (
          <button key={d} type="button" aria-pressed={day === d} data-day={d} onClick={() => setDay(d)} className={cn("min-h-9 rounded-md px-3 font-medium", day === d ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}>
            {d === "today" ? "Today" : "Next business day"}{needs(d) ? ` (${needs(d)})` : ""}
          </button>
        ))}
      </div>
      {ofDay.length === 0 ? <Empty words={day === "today" ? "No shoots today" : "No shoots on the next business day"} /> : (
        <>
          {upcoming.length > 0 ? <ul className="divide-y divide-border">{upcoming.map(row)}</ul> : <p className="py-2 text-sm text-muted">Every shoot today has started.</p>}
          {past.length > 0 && (
            <details className="group mt-1 rounded-lg border border-border" data-past>
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronDown aria-hidden className="size-4 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
                Earlier today ({past.length})
              </summary>
              <ul className="divide-y divide-border border-t border-border px-2">{past.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

const timeOf = (i: DeskItem) => (i.panel.kind === "visit" ? i.panel.visit.timeISO : i.dueISO);

function FollowUps({ s, onOpen, backlog, includeTest }: { s: DeskSection; onOpen: (i: DeskItem) => void; backlog: Desk["backlog"]; includeTest: boolean }) {
  const [all, setAll] = useState(false);
  const overdue = s.now.filter((i) => i.late).length;
  const rows = all ? s.now : s.now.slice(0, ROWS_SHOWN);
  const row = (i: DeskItem) => (
    <li key={i.id} data-desk-item={i.id} data-state={i.state} className="flex items-center gap-3 py-2.5">
      <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
        {i.tag && <span data-tag={i.tag} className={cn("mb-0.5 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", TAG[i.tag].cls)}>{TAG[i.tag].label}</span>}
        <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
        <span className={cn("block text-sm", i.late ? "text-danger" : "text-muted")}>{i.line}</span>
      </button>
      <RowButton i={i} onOpen={onOpen} />
    </li>
  );
  return (
    <Card s={s} subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Nothing due today" : overdue === 0 ? `${plural(s.count, "follow-up")} due today` : `${plural(s.count, "follow-up")} due, ${overdue} overdue`}
      footer={backlog.count > 0 ? <Link href={homeRecordHref(backlog.href, includeTest)} data-backlog className="inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-foreground hover:underline">{plural(backlog.count, "older task")} in your full list <ArrowRight aria-hidden className="size-3.5" /></Link> : undefined}>
      {s.now.length === 0 ? <Empty words={s.empty} /> : (
        <>
          <ul className="divide-y divide-border">{rows.map(row)}</ul>
          <ViewAll shown={rows.length} total={s.now.length} onClick={() => setAll(true)} />
        </>
      )}
      {s.waiting.length > 0 && (
        <details className="group mt-2" data-waiting>
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            {plural(s.waiting.length, "item")} waiting on others <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-border">{s.waiting.map(row)}</ul>
        </details>
      )}
    </Card>
  );
}

// ---- the side panel ----------------------------------------------------------------------

function SidePanel({ item, fallbackTitle, desk, includeTest, onClose }: { item: DeskItem | null; fallbackTitle: string | null; desk: Desk; includeTest: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-side-panel={item?.id ?? "gone"}>
      <button type="button" aria-label="Close the panel" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <aside role="dialog" aria-modal="true" aria-labelledby="desk-panel-title" className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-surface shadow-xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="desk-panel-title" className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{item?.title ?? fallbackTitle ?? "Done"}</h2>
            {item && <p className="mt-0.5 text-[12px] text-muted">{[item.line, item.dueWords, item.who && `Whose move: ${item.who}`].filter(Boolean).join(" · ")}</p>}
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {!item ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Done: it has left the list. The counts have been updated.</p>
          ) : (
            <>
              <p className="text-sm">{item.reason}</p>
              <PanelBody item={item} readOnly={desk.readOnly} />
              {desk.readOnly ? (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Preview: read-only. Actions are off.</p>
              ) : (
                <div className="space-y-3" data-panel-actions>
                  {item.actions.filter((a) => !(item.panel.kind === "visit" && a.kind === "ask")).map((a, n) => <ActionControl key={`${a.kind}:${n}`} a={a} item={item} desk={desk} />)}
                </div>
              )}
              {item.href && (
                <Link href={homeRecordHref(item.href, includeTest)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
                  Open the full page <ExternalLink aria-hidden className="size-3.5" />
                </Link>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function PanelBody({ item, readOnly }: { item: DeskItem; readOnly: boolean }) {
  const p = item.panel;
  if (p.kind === "job") {
    return (
      <div className="space-y-3" data-panel="job">
        {p.client && <p className="text-[12px] text-muted">Client: {p.client}</p>}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {p.assets.map((a) => (
            <li key={a.id} data-asset={a.id} data-tone={a.tone} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{a.label}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", ASSET_TONE[a.tone])}>{ASSET_WORD[a.tone]}</span>
                {a.late && <span className="text-[11px] font-semibold text-danger">Late</span>}
              </div>
              <p className="text-sm">{a.status}</p>
              {(a.who || a.note) && <p className="text-[12px] text-muted">{[a.who && a.tone === "waiting" ? `Waiting on ${a.who}` : null, a.note].filter(Boolean).join(" · ")}</p>}
            </li>
          ))}
        </ul>
        {p.findings.length > 0 && (
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">What the free photo check found</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{p.findings.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        )}
        {p.aryeoUrl && <a href={p.aryeoUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">Aryeo listing <ExternalLink aria-hidden className="size-3.5" /></a>}
      </div>
    );
  }
  if (p.kind === "thread") {
    return (
      <div className="space-y-2" data-panel="thread">
        <ol className="space-y-1.5">
          {p.messages.map((m, n) => (
            <li key={n} className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
              <span className="block text-[11px] text-muted">{etDateTime(m.atISO)}</span>
              {m.text}
            </li>
          ))}
        </ol>
        {p.alsoAsked.length > 0 && <p className="text-sm" data-also-asked>They also asked: {p.alsoAsked.join("; ")}</p>}
        {p.holding && <p className="text-[12px] text-muted">Your last word: &ldquo;{p.holding}&rdquo; (a holding line is not an answer)</p>}
        {p.revisionNote && <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning" data-revision-note>{p.revisionNote}</p>}
      </div>
    );
  }
  if (p.kind === "visit") return <VisitBody v={p.visit} readOnly={readOnly} />;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-panel="task">
      {p.lines.map((l) => (
        <div key={l.label} className="contents">
          <dt className="text-muted">{l.label}</dt>
          <dd className="[overflow-wrap:anywhere]">{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function VisitBody({ v, readOnly }: { v: PrepVisit; readOnly: boolean }) {
  const field = (label: string, value: string | null | undefined) => (value ? <div key={label} className="contents"><dt className="text-muted">{label}</dt><dd className="[overflow-wrap:anywhere]">{value}</dd></div> : null);
  return (
    <div className="space-y-3" data-panel="visit">
      {v.conflicts.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" data-conflicts>
          {v.conflicts.map((c) => <li key={c} className="flex gap-1.5"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />{c}</li>)}
        </ul>
      )}
      {v.gaps.length > 0 && <ul className="list-disc pl-5 text-sm text-warning" data-gaps>{v.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {field("When", v.timeISO ? etDateTime(v.timeISO) : null)}
        {field("Address", v.street)}
        {field("Client", v.client)}
        {field("Photographer", v.photographer ?? "Not assigned")}
        {field("Confirmation", v.confirmation.words)}
        {field("Brief", v.brief.words)}
        {v.brief.state !== "off" && v.brief.why && !v.brief.words.includes(v.brief.why) ? field("Why", v.brief.why) : null}
        {field("This visit", v.services.length ? v.services.join(", ") : "No services listed for this visit")}
        {field("Lockbox / code", v.access.lockbox)}
        {field("Access", v.access.access)}
        {field("Who is there", v.access.presence)}
        {field("Contact", [v.access.contactName, v.access.contactPhone].filter(Boolean).join(" · ") || null)}
      </dl>
      {v.brief.href && (
        <Link href={v.brief.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline" data-brief-link>
          Open the full brief <ExternalLink aria-hidden className="size-3.5" />
        </Link>
      )}
      {(v.requests.length > 0 || v.instructions.length > 0) && (
        <div data-visit-requests>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">For this visit</p>
          <ul className="mt-1 space-y-1.5 text-sm">
            {v.instructions.map((t) => <li key={`i:${t}`} className="list-inside list-disc">{t}</li>)}
            {v.requests.map((r) => (
              <li key={`r:${r.text}`} className="space-y-1">
                <span className="block">{r.text}</span>
                {r.askId && !readOnly && <AskQuickActions id={r.askId} askKind="SPECIAL_REQUEST" />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.revisionsAfterDelivery.length > 0 && (
        <p className="text-[12px] text-muted" data-revisions-elsewhere>
          {v.revisionsAfterDelivery.length === 1 ? "1 change was" : `${v.revisionsAfterDelivery.length} changes were`} asked after delivery. Those are revisions, in Requests &amp; Follow-Ups, not requests for this visit.
        </p>
      )}
      {(v.earlier.length > 0 || v.otherVisits.length > 0) && (
        <details className="group rounded-lg border border-border" data-earlier-notes>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-4 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
            Other visits and older notes ({v.earlier.length + v.otherVisits.length})
          </summary>
          <ul className="space-y-1 border-t border-border px-3 py-2 text-sm text-muted">
            {v.otherVisits.map((o, n) => <li key={`v${n}`}>Visit {o.whenISO ? etDate(o.whenISO) : ""}: {o.services.join(", ") || "no services listed"}</li>)}
            {v.earlier.map((e, n) => <li key={`e${n}`}>{e.text}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function ActionControl({ a, item, desk }: { a: DeskAction; item: DeskItem; desk: Desk }) {
  switch (a.kind) {
    case "photo-approve":
      return (
        <div className="space-y-1.5">
          <p className="text-[12px] text-muted">Photos go to Aryeo only after you approve. <Link href={`/ops/photo-delivery/${a.jobId}`} className="font-medium text-brand hover:underline">Look at the photos</Link></p>
          <PhotoApprove jobId={a.jobId} />
        </div>
      );
    case "video-send":
      return <SendVideo submissionId={a.submissionId} street={a.street} label={a.label} openAsks={a.openAsks} asksUnknown={a.asksUnknown} listingWarning={a.listingWarning} uploadOnly={a.uploadOnly} />;
    case "video-push":
      return <PushControls submissionId={a.submissionId} canDeliverNow={a.canDeliverNow} canRelease={a.canRelease} uploadedOnly={a.uploadedOnly} />;
    case "video-notice":
      return <NotTold rows={[a.row]} />;
    case "reply":
      return (
        <div className="space-y-3">
          {a.family === "phone" && a.phone ? <ReplyBox phone={a.phone} clientId={a.clientId} /> : <p className="text-[12px] text-muted">Reply to this {a.family === "email" ? "email" : "conversation"} in Messages; it stays here until the answer is logged.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Link href={a.href} className={QUIET}>Open in Messages</Link>
            <CommsDismissButton threadKey={a.threadKey} family={a.family} clientId={a.clientId} groupKey={a.groupKey} />
          </div>
        </div>
      );
    case "follow-up":
      return <FollowUpCreate clientId={a.clientId} projectId={a.projectId} title={a.title} />;
    case "task":
      return (
        <div className="space-y-3">
          <OldItemActions taskId={a.taskId} allowNewDate={a.allowNewDate} />
          {a.canWait && <WaitOn taskId={a.taskId} creative={desk.people.creative} owner={desk.people.owner} />}
        </div>
      );
    case "ask":
      return <AskQuickActions id={a.askId} askKind={a.askKind} />;
    case "remind":
      return <RemindPhotographerButton projectId={a.projectId} street={a.street} view={a.view} showMissing />;
    case "confirm":
      return <ConfirmControls taskId={a.taskId} />;
    case "brief-send":
      return <BriefSend teamMemberId={a.teamMemberId} day={a.day} name={a.name} resend={a.resend} />;
    case "link":
      return item.href === a.href ? null : <Link href={a.href} className={QUIET}>{a.label}</Link>;
  }
}
