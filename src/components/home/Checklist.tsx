import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { etTime } from "@/lib/datetime";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { GROUP_ALIASES } from "@/lib/homeAnchors";
import { EARLIER_SHOWN, OLD_AFTER_DAYS, PUSHES_BEFORE_FLAG, WEEK_OLD_DAYS, type OldItem } from "@/lib/taskAging";
import {
  stillOpenWords,
  type ChecklistGroup, type ChecklistLine, type DoneLine, type KyleChecklist,
} from "@/lib/opsHome";
import type { BehindState } from "@/lib/behindAlert";
import { HandledButton } from "@/components/tasks/ChecklistButtons";
import { OldItemActions } from "@/components/home/OldItemActions";
import { AskQuickActions, ReopenAskButton } from "@/components/home/AskQuickActions";
import { AddAskForm } from "@/components/asks/AddAskForm";

// ---------------------------------------------------------------------------
// KYLE'S DAILY CHECKLIST, Oct 19 2026. Jordan (evening): "We just need Kyle to
// be able to keep track of what he got done and what's still outstanding at
// the end of the day." Since that night (the dashboard took "/") it is its own
// page, "Your list" (app/ops/checklist), one tap from the dashboard's "Kyle's
// day" card:
//   · the red line when we are behind (behindAlert.behindState)
//   · the daily checklist: one list for today in five groups, each line one
//     tap to open the thing and one tap to close it (or the natural move:
//     Reply, Checked); then the items from earlier days; then Done today
//     (folded) and Still open.
// Every number and line arrives computed (lib/opsHome.kyleChecklist); these
// components only lay it out. Words speak to the reader ("you").
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold";
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

/** The red line across the top when the team is behind. Nothing when we are not. */
export function BehindLine({ state, href }: { state: BehindState | null; href: string }) {
  if (!state || state.level === "ok") return null;
  const text = state.headline
    ?? `We're behind: ${state.videosLate} video${state.videosLate === 1 ? "" : "s"} and ${state.photosLate} photo job${state.photosLate === 1 ? "" : "s"} late.`;
  return (
    <Link
      href={href}
      data-behind={state.level}
      className="flex min-h-12 items-center gap-2.5 rounded-xl border-2 border-danger/60 bg-danger/10 px-4 py-2.5 text-[15px] font-semibold text-danger hover:bg-danger/15"
    >
      <AlertTriangle aria-hidden className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      <ArrowRight aria-hidden className="size-4 shrink-0" />
    </Link>
  );
}

// ---- the checklist ------------------------------------------------------------------

function Aliases({ group }: { group: string }) {
  return <>{(GROUP_ALIASES[group] ?? []).map((id) => <span key={id} id={id} aria-hidden className="block scroll-mt-32 md:scroll-mt-28" />)}</>;
}

function LineActions({ line, href, includeTest }: { line: ChecklistLine; href: string; includeTest: boolean }) {
  const a = line.action;
  if (a.kind === "open") {
    return <Link href={href} className={`${BTN} bg-brand-action text-white hover:opacity-90`}>{a.label}</Link>;
  }
  if (a.kind === "reply") {
    return (
      <>
        <Link href={homeRecordHref(a.href, includeTest)} className={`${BTN} bg-brand-action text-white hover:opacity-90`}>Reply</Link>
        <HandledButton clientId={a.clientId} family={a.family} groupKey={a.groupKey} />
      </>
    );
  }
  if (a.kind === "ask") return <AskQuickActions id={a.id} askKind={a.askKind} />;
  return <OldItemActions taskId={a.id} allowNewDate={false} />;
}

export function LineRow({ line, includeTest = false, readOnly = false }: { line: ChecklistLine; includeTest?: boolean; readOnly?: boolean }) {
  const href = homeRecordHref(line.href, includeTest);
  return (
    <li data-line={line.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <Link href={href} className="text-sm font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand">{line.title}</Link>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", line.late ? "bg-danger/15 text-danger" : "bg-surface-2 text-foreground/80")}>{line.need}</span>
          {line.when && <span className={cn(line.late && "font-semibold text-danger")}>{line.when}</span>}
          {line.detail && <span className="[overflow-wrap:anywhere]">· {line.detail}</span>}
        </p>
      </div>
      {!readOnly && <div className="flex shrink-0 flex-wrap items-center gap-2"><LineActions line={line} href={href} includeTest={includeTest} /></div>}
    </li>
  );
}

function GroupCard({ g, includeTest, extra }: { g: ChecklistGroup; includeTest: boolean; extra?: React.ReactNode }) {
  const lateN = g.lines.filter((l) => l.late).length;
  const quiet = !g.unavailable && g.lines.length === 0;
  return (
    <section id={g.key} data-group={g.key} aria-labelledby={`${g.key}-title`} className={cn("scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28", quiet ? "px-4 py-2.5" : "panel-shadow px-4 pt-3 pb-1")}>
      <Aliases group={g.key} />
      {quiet ? (
        <p className="flex min-h-8 flex-wrap items-center gap-x-2 text-sm">
          <span id={`${g.key}-title`} className="font-semibold">{g.title}</span>
          <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 aria-hidden className="size-4" /> {g.empty}</span>
        </p>
      ) : (
        <>
          <h3 id={`${g.key}-title`} className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {g.title}
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{g.unavailable ? "?" : g.lines.length}</span>
            {lateN > 0 && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-semibold text-danger">{lateN} late</span>}
          </h3>
          {g.unavailable && <p role="status" className="py-2 text-sm text-warning">Part of this list couldn&rsquo;t load. Refresh, or open the screen to check.</p>}
          {g.lines.length > 0 && <ul className="divide-y divide-border">{g.lines.map((l) => <LineRow key={l.key} line={l} includeTest={includeTest} />)}</ul>}
        </>
      )}
      {g.later.length > 0 && (
        <details className="group/later border-t border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted hover:text-foreground">
            <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 transition-transform group-open/later:rotate-0" />
            {g.later.length} more on jobs going out later
          </summary>
          <ul className="divide-y divide-border">{g.later.map((l) => <LineRow key={l.key} line={l} includeTest={includeTest} />)}</ul>
        </details>
      )}
      {extra && <div className="pt-2 pb-3">{extra}</div>}
    </section>
  );
}

/** One task from earlier days: how far past its date, and Done, Not needed or a new date. */
export function OldItemRow({ item, minDay, maxDay, includeTest = false }: { item: OldItem; minDay: string; maxDay: string; includeTest?: boolean }) {
  const old = item.daysPast >= OLD_AFTER_DAYS;
  return (
    <li className="py-3" data-old-item={item.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Link href={homeRecordHref(item.href, includeTest)} className="min-w-0 flex-1 basis-56 text-sm font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand">{item.title}</Link>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", item.daysPast >= WEEK_OLD_DAYS ? "bg-danger/15 text-danger" : old ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>
          {item.daysPast >= 1 ? `${item.daysPast} day${item.daysPast === 1 ? "" : "s"} past its date` : "since yesterday"}
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-muted">
        {item.kind}
        {item.projectTitle ? ` · ${item.projectTitle}` : ""}
        {item.dueISO ? ` · due ${fmtDay(item.dueISO)}` : ""}
        {item.pushedToISO ? ` · moved to ${fmtDay(item.pushedToISO)}` : ""}
        {item.pushes > 0 ? (
          <span className={cn(item.pushes >= PUSHES_BEFORE_FLAG - 1 && "font-semibold text-danger")}>
            {` · pushed ${item.pushes} time${item.pushes === 1 ? "" : "s"}`}{item.pushes === PUSHES_BEFORE_FLAG - 1 ? " (one more tells Jordan)" : ""}
          </span>
        ) : null}
      </p>
      <div className="mt-2">
        <OldItemActions taskId={item.id} minDay={minDay} maxDay={maxDay} />
      </div>
    </li>
  );
}

function EarlierCard({ list, minDay, maxDay, includeTest }: { list: KyleChecklist["earlier"]; minDay: string; maxDay: string; includeTest: boolean }) {
  const shown = list.items.slice(0, EARLIER_SHOWN);
  const rest = list.items.slice(EARLIER_SHOWN);
  return (
    <section id="earlier" data-group="earlier" aria-labelledby="earlier-title" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface px-4 pt-3 pb-1 md:scroll-mt-28">
      <Aliases group="earlier" />
      <h3 id="earlier-title" className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
        From earlier days, still open
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium tabular-nums", list.items.length > 0 ? "bg-danger/15 text-danger" : "bg-surface-2")}>{list.unavailable ? "?" : list.items.length}</span>
      </h3>
      {list.unavailable ? (
        <p role="status" className="py-2 text-sm text-warning">These couldn&rsquo;t load. Refresh to try again.</p>
      ) : list.items.length === 0 ? (
        <p className="flex items-center gap-1.5 py-2 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing left over from earlier days.</p>
      ) : (
        <>
          <p className="mt-0.5 text-[13px] text-muted">
            Oldest first. For each one: Done, Not needed, or pick a new date. {OLD_AFTER_DAYS}+ days past its date counts as old; the {PUSHES_BEFORE_FLAG === 3 ? "third" : `${PUSHES_BEFORE_FLAG}th`} new date on one item tells Jordan.
          </p>
          <ul className="divide-y divide-border">{shown.map((i) => <OldItemRow key={i.id} item={i} minDay={minDay} maxDay={maxDay} includeTest={includeTest} />)}</ul>
          {rest.length > 0 && (
            <details className="group/earlier border-t border-border">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted hover:text-foreground">
                <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 transition-transform group-open/earlier:rotate-0" />
                Show {rest.length} more
              </summary>
              <ul className="divide-y divide-border">{rest.map((i) => <OldItemRow key={i.id} item={i} minDay={minDay} maxDay={maxDay} includeTest={includeTest} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function DoneRow({ d, includeTest, undo }: { d: DoneLine; includeTest: boolean; undo: boolean }) {
  return (
    <li data-done={d.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
      <Check aria-hidden className="size-4 shrink-0 text-success" />
      <span className="font-medium text-success">{d.what}</span>
      {d.href ? <Link href={homeRecordHref(d.href, includeTest)} className="min-w-0 [overflow-wrap:anywhere] hover:text-brand">{d.title}</Link> : <span className="min-w-0 [overflow-wrap:anywhere]">{d.title}</span>}
      <span className="text-[12px] text-muted">{[d.atISO ? `${etTime(d.atISO)} ET` : null, d.by].filter(Boolean).join(" · ")}</span>
      {undo && d.reopenAskId && <ReopenAskButton id={d.reopenAskId} />}
    </li>
  );
}

/** Done today, folded: everything closed today on these lists, by anyone. */
export function DoneToday({ list, includeTest = false, undo = true }: { list: KyleChecklist; includeTest?: boolean; undo?: boolean }) {
  return (
    <details id="done-today" className="group/done scroll-mt-32 rounded-2xl border border-border bg-surface px-4 md:scroll-mt-28">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-[15px] font-semibold">
        <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/done:rotate-0" />
        Done today ({list.done.length})
        {list.doneUnavailable && <span className="text-[12px] font-normal text-warning">· part of this couldn&rsquo;t load</span>}
      </summary>
      {list.done.length === 0 ? (
        <p className="pb-3 text-sm text-muted">Nothing closed yet today.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">{list.done.map((d) => <DoneRow key={d.key} d={d} includeTest={includeTest} undo={undo} />)}</ul>
      )}
    </details>
  );
}

/** Still open: how many are left, by group, each a jump to its group. */
export function StillOpen({ list }: { list: KyleChecklist }) {
  const { total, parts } = list.stillOpen;
  return (
    <section id="still-open" aria-label="Still open" className="scroll-mt-32 rounded-2xl border border-border bg-surface px-4 py-3 md:scroll-mt-28">
      <Aliases group="still-open" />
      {total === 0 ? (
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-success"><CheckCircle2 aria-hidden className="size-4" /> Still open (0): everything on today&rsquo;s list is done.</p>
      ) : (
        <p className="text-[15px]">
          <span className="font-semibold">Still open ({total}):</span>{" "}
          {parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 ? ", " : ""}
              <a href={`#${p.key}`} className="text-brand hover:underline">{stillOpenWords([p])}</a>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

/** The whole daily checklist for Kyle's Home. */
export function DailyChecklist({ list, includeTest = false, minDay, maxDay }: { list: KyleChecklist; includeTest?: boolean; minDay: string; maxDay: string }) {
  return (
    <section id="checklist" aria-labelledby="checklist-title" className="scroll-mt-32 space-y-2.5 md:scroll-mt-28">
      <Aliases group="checklist" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1">
        <h2 id="checklist-title" className="text-base font-semibold">Today&rsquo;s checklist</h2>
        <p className="text-sm text-muted">{list.stillOpen.total} still open · {list.done.length} done today</p>
      </div>
      {list.groups.map((g) => (
        <GroupCard
          key={g.key}
          g={g}
          includeTest={includeTest}
          // Something a client said on a call or in person: added here, it
          // lands on this list and holds the job's delivery until checked.
          extra={g.key === "requests" && list.requestJobs ? <AddAskForm jobs={list.requestJobs} /> : undefined}
        />
      ))}
      <EarlierCard list={list.earlier} minDay={minDay} maxDay={maxDay} includeTest={includeTest} />
      <DoneToday list={list} includeTest={includeTest} />
      <StillOpen list={list} />
    </section>
  );
}
