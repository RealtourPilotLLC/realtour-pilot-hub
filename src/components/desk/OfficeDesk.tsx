"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { etDate, etDateTime, etTime } from "@/lib/datetime";
import type { AssetLine, DeskAction, DeskItem, DeskTabKey, OfficeDesk as Desk, PrepVisit } from "@/lib/officeDesk";
import { SendVideo } from "@/components/videoDelivery/SendVideo";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { NotTold } from "@/components/ops/NotTold";
import { CommsDismissButton } from "@/components/tasks/ChecklistButtons";
import { OldItemActions } from "@/components/home/OldItemActions";
import { AskQuickActions } from "@/components/home/AskQuickActions";
import { RemindPhotographerButton } from "@/components/editing/RemindPhotographer";
import { CloseoutTick, ConfirmControls, FinishDay, PhotoApprove, PRIMARY, QUIET, ReplyBox, WaitOn } from "@/components/desk/DeskControls";

// ---------------------------------------------------------------------------
// KYLE'S DESK, the screen (Oct 23 2026). Jordan: "I just want to come in and
// either make a quick edit or just approve." So:
//   · the top: the status line, how fresh the data is, and Do next (at most
//     five, each with a reason, a due time and one button);
//   · five tabs with their counts (a scrollable strip on a phone), compact
//     rows: one line of what to do, one line of why and when;
//   · a side panel for one job, conversation, visit or task, holding the
//     existing actions, so the page never changes under Kyle. After an
//     action the page refreshes in place and the counts recompute.
// Every number arrives computed (lib/officeDesk); this file only lays it out.
// No checklists inside review: the free photo check's findings are context.
// ---------------------------------------------------------------------------

const TONE_DOT = { ok: "bg-success", warn: "bg-warning", bad: "bg-danger" } as const;
const ASSET_TONE: Record<AssetLine["tone"], string> = {
  now: "bg-warning/15 text-warning",
  waiting: "bg-surface-2 text-muted",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
};
const ASSET_WORD: Record<AssetLine["tone"], string> = { now: "Needs you", waiting: "Waiting", done: "Done", failed: "Failed" };
const FRESH_TONE = { ok: "text-muted", stale: "text-warning", failed: "text-danger", unknown: "text-warning" } as const;
const ROWS_SHOWN = 12;

export function OfficeDesk({ desk, includeTest = false, initialTab, initialOpen = null }: {
  desk: Desk;
  includeTest?: boolean;
  initialTab?: DeskTabKey;
  /** a drill can render the panel open */
  initialOpen?: string | null;
}) {
  const all = new Map(desk.tabs.flatMap((t) => [...t.now, ...t.waiting, ...t.ok]).map((i) => [i.id, i]));
  const firstTab = desk.doNext[0]?.tab ?? "delivery";
  const [tab, setTab] = useState<DeskTabKey>(initialTab ?? firstTab);
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [openedTitle, setOpenedTitle] = useState<string | null>(initialOpen ? all.get(initialOpen)?.title ?? null : null);
  const show = (i: DeskItem) => { setOpen(i.id); setOpenedTitle(i.title); };
  const current = desk.tabs.find((t) => t.key === tab) ?? desk.tabs[0];
  const item = open ? all.get(open) ?? null : null;

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

      {/* THE TOP: status, freshness, Do next */}
      <section aria-label="Where the day stands" className="panel-shadow rounded-2xl border border-border bg-surface px-4 py-3">
        <p data-status-line className="flex items-start gap-2 text-sm font-medium">
          <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[desk.status.tone])} />
          <span>{desk.status.line}</span>
        </p>
        <ul aria-label="Data freshness" data-freshness className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {desk.freshness.map((f) => (
            <li key={f.key} data-fresh={f.key} data-state={f.state} className={cn("inline-flex items-center gap-1", FRESH_TONE[f.state])}>
              {f.state !== "ok" && <AlertTriangle aria-hidden className="size-3.5" />}
              <span className="font-medium">{f.label}</span> {f.words}
            </li>
          ))}
        </ul>
      </section>

      <section id="do-next" aria-labelledby="do-next-title" data-do-next className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 id="do-next-title" className="text-base font-semibold">Do next</h2>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{desk.doNext.length}</span>
        </div>
        {desk.doNext.length === 0 ? (
          <p className="flex items-center gap-1.5 px-4 py-3 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing needs you right now.</p>
        ) : (
          <ol className="divide-y divide-border">
            {desk.doNext.map((i, n) => (
              <li key={i.id} data-do-next-item={i.id} className="flex items-center gap-3 px-4 py-2.5">
                <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", i.late || i.rank === 0 ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>{n + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</p>
                  <p className="truncate text-[12px] text-muted">
                    {i.dueWords && <span className={cn("font-medium", i.late ? "text-danger" : "text-foreground")}>{i.dueWords} · </span>}
                    {i.reason}
                  </p>
                </div>
                <button type="button" onClick={() => show(i)} data-open-panel={i.id} className={cn(i.late || i.rank === 0 ? PRIMARY : QUIET, "shrink-0")}>
                  {i.primary?.label ?? "Open"}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* THE FIVE TABS */}
      <section aria-label="Your work" className="panel-shadow rounded-2xl border border-border bg-surface">
        <div role="tablist" aria-label="Areas" className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2 [scrollbar-width:thin]">
          {desk.tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === tab}
              aria-controls={`desk-panel-${t.key}`}
              id={`desk-tab-${t.key}`}
              data-desk-tab={t.key}
              data-count={t.count == null ? "?" : String(t.count)}
              onClick={() => setTab(t.key)}
              className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg border-b-2 px-3 text-sm font-medium", t.key === tab ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground")}
            >
              {t.label}
              <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", t.count ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{t.count == null ? "?" : t.count}</span>
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`desk-panel-${current.key}`} aria-labelledby={`desk-tab-${current.key}`} data-desk-panel={current.key} className="p-2 sm:p-3">
          {current.key === "closeout" ? <CloseoutView desk={desk} /> : <TabView tab={current} onOpen={show} />}
        </div>
      </section>

      {open && <SidePanel item={item} fallbackTitle={openedTitle} desk={desk} includeTest={includeTest} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---- a tab -----------------------------------------------------------------------------

function Row({ i, onOpen }: { i: DeskItem; onOpen: (i: DeskItem) => void }) {
  return (
    <li data-desk-item={i.id} data-state={i.state}>
      <button type="button" onClick={() => onOpen(i)} className="flex min-h-11 w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand">
        <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", i.state === "ok" ? "bg-success" : i.state === "waiting" ? "bg-border-strong" : i.late || i.rank === 0 ? "bg-danger" : "bg-warning")} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-snug [overflow-wrap:anywhere]">{i.title}</span>
          <span className="block truncate text-[12px] text-muted">
            {i.dueWords && <span className={cn(i.late ? "font-medium text-danger" : "")}>{i.dueWords} · </span>}
            {i.who && i.state === "waiting" ? `${i.who} · ` : ""}{i.reason}
          </span>
        </span>
      </button>
    </li>
  );
}

function TabView({ tab, onOpen }: { tab: Desk["tabs"][number]; onOpen: (i: DeskItem) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? tab.now : tab.now.slice(0, ROWS_SHOWN);
  return (
    <div className="space-y-2">
      {tab.unavailable.length > 0 && (
        <p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Couldn&rsquo;t read {tab.unavailable.join(", ")} just now. This list may be missing items; refresh to try again.</p>
      )}
      {tab.now.length === 0 ? (
        <p className="flex items-center gap-1.5 px-2 py-2 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing here needs you now.</p>
      ) : (
        <ul data-list="now" className="divide-y divide-border">{shown.map((i) => <Row key={i.id} i={i} onOpen={onOpen} />)}</ul>
      )}
      {!all && tab.now.length > ROWS_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className="min-h-11 w-full rounded-lg text-sm font-medium text-muted hover:bg-surface-2/60">Show {tab.now.length - ROWS_SHOWN} more</button>
      )}
      {tab.waiting.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-4 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
            {tab.key === "delivery" ? "In progress" : "Waiting on others"} <span className="text-muted tabular-nums">({tab.waiting.length})</span>
            <span className="hidden text-[12px] font-normal text-muted sm:inline">· each with a person and a time it comes back</span>
          </summary>
          <ul data-list="waiting" className="divide-y divide-border border-t border-border px-1">{tab.waiting.map((i) => <Row key={i.id} i={i} onOpen={onOpen} />)}</ul>
        </details>
      )}
      {tab.ok.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-4 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
            Ready <span className="text-muted tabular-nums">({tab.ok.length})</span>
          </summary>
          <ul data-list="ok" className="divide-y divide-border border-t border-border px-1">{tab.ok.map((i) => <Row key={i.id} i={i} onOpen={onOpen} />)}</ul>
        </details>
      )}
    </div>
  );
}

// ---- closeout ------------------------------------------------------------------------

function CloseoutView({ desk }: { desk: Desk }) {
  const c = desk.closeout;
  const s = c.summary;
  return (
    <div className="space-y-4 px-1 py-1" data-closeout>
      <ul className="space-y-1.5">
        {c.lines.map((l) => (
          <li key={l.key} data-closeout-line={l.key} data-done={l.done ? "true" : "false"} className="flex items-start gap-3 rounded-lg px-2 py-1.5">
            {l.auto === true ? (
              <CheckCircle2 aria-label="Done (from the system)" className="mt-0.5 size-5 shrink-0 text-success" />
            ) : (
              <CloseoutTick dayKey={c.dayKey} itemKey={l.key} checked={!!l.tick} disabled={desk.readOnly} label={l.label} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{l.label}</span>
              <span className="block text-[12px] text-muted">
                {l.autoWords}
                {l.tick && ` · ticked by ${l.tick.by.split(" ")[0]} at ${etTime(l.tick.atISO)}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {c.finished ? (
        <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          Day finished at {etTime(c.finished.atISO)}.
          {c.newSinceFinish > 0 && <span className="text-warning"> {c.newSinceFinish} new since then: still listed above.</span>}
        </p>
      ) : (
        <FinishDay dayKey={c.dayKey} disabled={desk.readOnly || !c.allDone} />
      )}

      <div className="grid gap-3 sm:grid-cols-2" data-day-summary>
        <SummaryBlock title={`You completed (${s.completedTotal})`}>
          {s.completed.length === 0 ? <li className="text-muted">Nothing recorded yet today.</li> : s.completed.map((x) => (
            <li key={x.what}><span className="font-medium">{x.count} · {x.what}</span>{x.examples.length > 0 && <span className="block text-[12px] text-muted">{x.examples.join(" · ")}</span>}</li>
          ))}
        </SummaryBlock>
        <SummaryBlock title="Still pending">
          {s.pending.map((p) => <li key={p.tab}>{p.tab}: <span className="font-medium tabular-nums">{p.now == null ? "?" : p.now}</span> need you{p.waiting ? `, ${p.waiting} waiting on others` : ""}</li>)}
        </SummaryBlock>
        <SummaryBlock title="Blockers">
          {s.blockers.length === 0 ? <li className="text-muted">None.</li> : s.blockers.map((b) => <li key={b}>{b}</li>)}
        </SummaryBlock>
        <SummaryBlock title={`Next business day · ${s.tomorrow.dayWords}`}>
          {s.tomorrow.lines.map((l) => <li key={l}>{l}</li>)}
        </SummaryBlock>
      </div>
    </div>
  );
}

function SummaryBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="mt-1 space-y-1 text-sm">{children}</ul>
    </div>
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
            {item && <p className="mt-0.5 text-[12px] text-muted">{[item.dueWords, item.who && `Whose move: ${item.who}`].filter(Boolean).join(" · ")}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {!item ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Done: it has left the list. The counts have been updated.</p>
          ) : (
            <>
              <p className="text-sm">{item.reason}</p>
              <PanelBody item={item} />
              {desk.readOnly ? (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Preview: read-only. Actions are off.</p>
              ) : (
                <PanelActions item={item} desk={desk} />
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

function PanelBody({ item }: { item: DeskItem }) {
  const p = item.panel;
  if (p.kind === "job") {
    return (
      <div className="space-y-3" data-panel="job">
        {p.client && <p className="text-[12px] text-muted">{p.client}</p>}
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
        {p.holding && <p className="text-[12px] text-muted">Your last word: &ldquo;{p.holding}&rdquo; (a holding line is not an answer)</p>}
        {p.revisionNote && <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning" data-revision-note>{p.revisionNote}</p>}
      </div>
    );
  }
  if (p.kind === "visit") return <VisitBody v={p.visit} />;
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

function VisitBody({ v }: { v: PrepVisit }) {
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
        {field("This visit", v.services.length ? v.services.join(", ") : "No services listed for this visit")}
        {field("Lockbox / code", v.access.lockbox)}
        {field("Access", v.access.access)}
        {field("Who is there", v.access.presence)}
        {field("Contact", [v.access.contactName, v.access.contactPhone].filter(Boolean).join(" · ") || null)}
      </dl>
      {(v.requests.length > 0 || v.instructions.length > 0) && (
        <div data-visit-requests>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">For this visit</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {v.instructions.map((t) => <li key={`i:${t}`}>{t}</li>)}
            {v.requests.map((r) => <li key={`r:${r.text}`}>{r.text}</li>)}
          </ul>
        </div>
      )}
      {v.revisionsAfterDelivery.length > 0 && (
        <p className="text-[12px] text-muted" data-revisions-elsewhere>
          {v.revisionsAfterDelivery.length === 1 ? "1 change was" : `${v.revisionsAfterDelivery.length} changes were`} asked after delivery. Those are revisions, tracked in Follow-Ups, not requests for this visit.
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

function PanelActions({ item, desk }: { item: DeskItem; desk: Desk }) {
  const { creative, owner } = desk.people;
  return (
    <div className="space-y-3" data-panel-actions>
      {item.actions.map((a, n) => <ActionControl key={`${a.kind}:${n}`} a={a} item={item} creative={creative} owner={owner} desk={desk} />)}
    </div>
  );
}

function ActionControl({ a, item, creative, owner }: { a: DeskAction; item: DeskItem; creative: string; owner: string; desk: Desk }) {
  switch (a.kind) {
    case "photo-approve":
      return (
        <div className="space-y-1.5">
          <p className="text-[12px] text-muted">Photos go to Aryeo only after you approve. <Link href={`/ops/photo-delivery/${a.jobId}`} className="font-medium text-brand hover:underline">Look at the photos</Link></p>
          <PhotoApprove jobId={a.jobId} />
        </div>
      );
    case "video-send":
      return <SendVideo submissionId={a.submissionId} street={a.street} label={a.label} openAsks={a.openAsks} asksUnknown={a.asksUnknown} listingWarning={a.listingWarning} />;
    case "video-push":
      return <PushControls submissionId={a.submissionId} canDeliverNow={a.canDeliverNow} canRelease={a.canRelease} />;
    case "video-notice":
      return <NotTold rows={[a.row]} />;
    case "reply":
      return (
        <div className="space-y-3">
          {a.family === "phone" && a.phone ? <ReplyBox phone={a.phone} clientId={a.clientId} /> : <p className="text-[12px] text-muted">Reply to this {a.family === "email" ? "email" : "conversation"} in Messages; it stays on this list until the answer is logged.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Link href={a.href} className={QUIET}>Open in Messages</Link>
            <CommsDismissButton threadKey={a.threadKey} family={a.family} clientId={a.clientId} groupKey={a.groupKey} />
          </div>
        </div>
      );
    case "task":
      return (
        <div className="space-y-3">
          <OldItemActions taskId={a.taskId} allowNewDate={a.allowNewDate} />
          {a.canWait && <WaitOn taskId={a.taskId} creative={creative} owner={owner} />}
        </div>
      );
    case "ask":
      return <AskQuickActions id={a.askId} askKind={a.askKind} />;
    case "remind":
      return <RemindPhotographerButton projectId={a.projectId} street={a.street} view={a.view} showMissing />;
    case "confirm":
      return <ConfirmControls taskId={a.taskId} outboxHref={a.outboxHref} />;
    case "link":
      return item.href === a.href ? null : <Link href={a.href} className={QUIET}>{a.label}</Link>;
  }
}
