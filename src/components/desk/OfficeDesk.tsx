"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarDays, Camera, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock, ExternalLink, FileText, Film, Image as ImageIcon, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { etDate, etDateTime, etTime } from "@/lib/datetime";
// Types only: lib/officeDesk is server code, never part of this client module graph.
import type { AssetLine, CheckGroup, DeskAction, DeskItem, DeskSection, DeskTag, OfficeDesk as Desk, PrepVisit } from "@/lib/officeDesk";
import { PhotoImg } from "@/components/photoDelivery/PhotoImg";
import { SendVideo } from "@/components/videoDelivery/SendVideo";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { NotTold } from "@/components/ops/NotTold";
import { RerunTopaz } from "@/components/ops/RerunTopaz";
import { AskQuickActions } from "@/components/home/AskQuickActions";
import { PlacementUndoHost } from "@/components/requests/RequestPlacement";
import { RemindPhotographerButton } from "@/components/editing/RemindPhotographer";
import { EmailReplyBox } from "@/components/comms/EmailReplyBox";
import { LeadDisregardButton } from "@/components/tasks/ChecklistButtons";
import { draftEmailThreadReply } from "@/app/emailActions";
import {
  BriefSend, CloseoutTick, ConfirmControls, DelegationControls, DraftReply, FinishDay, FollowUpCreate, HandOn, MarkDelivered, MarkHandled, PhotoApprove, PRIMARY, QUIET, ReplyBox, RevisionDecide, TaskResolve, WaitOn,
} from "@/components/desk/DeskControls";

// ---------------------------------------------------------------------------
// KYLE'S DESK, THE SCREEN, revision 3 (Oct 23 2026, evening: Jordan's updated
// mockup). The Daily checks bar (Morning, Midday, End-of-day review, each
// saying when it was completed), then the four sections in a wide two-column
// grid (Review & Deliver, Client Communications, Today's Shoots, Requests &
// Follow-Ups), a full-width "Next business day" card, then the End-of-day
// closeout and Completed today. One column on a phone. A few rows each, "View
// all" for the rest, a clear empty state. A row's button opens the side panel,
// which holds the existing actions (every conversation opens with the reply
// engine's draft), so the page never changes under Kyle; after an action it
// refreshes in place and the counts recompute. Every number arrives computed
// (lib/officeDesk). No checklists inside review.
//
// Oct 27 2026 (Jordan: "Make the dashboard look more like what the example
// shows"): the cards are equal height in each pair, three rows each, then
// "View all" or a fold ("2 awaiting files", "4 waiting on others", the
// thank-yous that need nothing). Review & Deliver's chevron and "View all
// deliveries" open the Shoots page's Review & deliver view. Today's Shoots
// keeps every shoot of the day in time order, started or not. The side panel
// (full screen on a phone) is the quick action menu: each row's button there
// resolves it, answers it, or hands it on (Delegate, Escalate to Jordan).
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
  assigned: { label: "Assigned to you", cls: "bg-warning/15 text-warning" },
  production: { label: "Production", cls: "bg-surface-2 text-muted" },
  task: { label: "Your task", cls: "bg-surface-2 text-muted" },
  reply: { label: "Reply", cls: "bg-surface-2 text-muted" },
  program: { label: "Content Program", cls: "bg-surface-2 text-muted" },
  booking: { label: "Booking", cls: "bg-surface-2 text-muted" },
  lead: { label: "Lead", cls: "bg-surface-2 text-muted" },
};
/** Rows a section shows before "View all" (the mockup: two or three a card; the rest are one press away). */
const ROWS_SHOWN = 3;
const ACTIVITY_SHOWN = 5;
const SOLID = new Set<DeskAction["kind"]>(["photo-approve", "video-send", "video-push", "reply", "program-reply", "confirm", "revision-decide"]);
/** A row link that opens the side panel on one control first (Create follow-up, Mark handled, Disregard). */
type Focus = "follow-up" | "handled" | "disregard" | null;
const FOCUS_KIND: Record<Exclude<Focus, null>, DeskAction["kind"]> = { "follow-up": "follow-up", handled: "handled", disregard: "lead-disregard" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The side panel's own views that are not one row: the briefs, Prepare <Day>, Review & finish day. */
type Special = "special:briefs" | "special:prepare" | "special:finish";

export function OfficeDesk({ desk, includeTest = false, initialOpen = null, initialChecks = null, initialDay = "today", initialDrafts = null }: {
  desk: Desk;
  includeTest?: boolean;
  /** a drill can render the side panel open (an item id, or a special view) */
  initialOpen?: string | null;
  /** a drill can render a review's checks open */
  initialChecks?: CheckGroup["key"] | null;
  initialDay?: "today" | "next";
  /** a drill can hand the reply drafts in (the browser fetches them on open) */
  initialDrafts?: Record<string, string> | null;
}) {
  const all = new Map(desk.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]).map((i) => [i.id, i]));
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [focus, setFocus] = useState<Focus>(null);
  const [openedTitle, setOpenedTitle] = useState<string | null>(initialOpen ? all.get(initialOpen)?.title ?? null : null);
  const show = (i: DeskItem, f: Focus = null) => { setOpen(i.id); setFocus(f); setOpenedTitle(i.title); };
  const showId = (id: string) => { const i = all.get(id); if (i) show(i); };
  const special = (s: Special) => { setOpen(s); setFocus(null); setOpenedTitle(null); };
  const item = open && !open.startsWith("special:") ? all.get(open) ?? null : null;
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
      {/* A request's "Not for this project" (Oct 28 2026) takes its row off the desk; its Undo waits here. */}
      {!desk.readOnly && <PlacementUndoHost />}
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

      {/* Equal-height cards in each pair (the mockup); one column on a phone. */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2" data-desk-grid>
        <ReviewDeliver s={sec("deliver")} onOpen={show} readOnly={desk.readOnly} href={desk.deliverHref} />
        <Communications s={sec("comms")} onOpen={show} fresh={desk.commsFresh} />
        <Shoots s={sec("shoots")} onOpen={show} initialDay={initialDay} includeTest={includeTest} briefs={desk.briefsPending} onBriefs={() => special("special:briefs")} />
        <FollowUps s={sec("followups")} onOpen={show} backlog={desk.backlog} includeTest={includeTest} />
        <NextDayCard desk={desk} onPrepare={() => special("special:prepare")} />
        <CloseoutCard desk={desk} onFinish={() => special("special:finish")} />
        <CompletedToday desk={desk} />
      </div>

      {open && (
        <SidePanel
          item={item}
          special={open.startsWith("special:") ? (open as Special) : null}
          focus={focus}
          fallbackTitle={openedTitle}
          desk={desk}
          includeTest={includeTest}
          drafts={initialDrafts}
          onOpenItem={showId}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

// ---- the daily checks ------------------------------------------------------------------

function checkState(g: CheckGroup): string {
  if (!g.done) return "Not yet completed";
  return g.completedAtISO ? `Completed ${etTime(g.completedAtISO)}` : "Completed";
}

function DailyChecksBar({ desk, initial }: { desk: Desk; initial: CheckGroup["key"] | null }) {
  const [open, setOpen] = useState<CheckGroup["key"] | null>(initial === "eod" ? null : initial);
  const c = desk.checks;
  const group = c.groups.find((g) => g.key === open) ?? null;
  const head = (g: CheckGroup) => (
    <>
      {g.done ? <CheckCircle2 aria-label="Done" className="size-5 shrink-0 text-success" /> : <Circle aria-label="Not done" className="size-5 shrink-0 text-muted-2" />}
      <span className="text-left">
        <span className="block text-sm font-medium">{g.label}</span>
        <span className="block text-[12px] text-muted" data-check-state>{checkState(g)}</span>
      </span>
    </>
  );
  return (
    <section aria-labelledby="daily-checks-title" data-daily-checks className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-5">
        <h2 id="daily-checks-title" className="mr-4 text-base font-semibold">Daily checks</h2>
        {c.groups.map((g) => g.key === "eod" ? (
          // The end of the day has its own card (the closeout); the bar says where it stands and goes there.
          <a key={g.key} href="#closeout" data-check-group={g.key} data-done={g.done ? "true" : "false"} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 hover:text-foreground">{head(g)}</a>
        ) : (
          <button key={g.key} type="button" aria-expanded={open === g.key} data-check-group={g.key} data-done={g.done ? "true" : "false"} onClick={() => setOpen(open === g.key ? null : g.key)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 hover:text-foreground">
            {head(g)}
            <ChevronDown aria-hidden className={cn("size-4 text-muted-2 transition-transform", open === g.key && "rotate-180")} />
          </button>
        ))}
      </div>
      {group && (
        <div className="space-y-3 border-t border-border px-4 py-3 sm:px-5" data-check-panel={group.key}>
          <CheckLines desk={desk} group={group} />
          <p className="text-[12px] text-muted">A tick records your review; it never closes the work under it.</p>
        </div>
      )}
    </section>
  );
}

function CheckLines({ desk, group }: { desk: Desk; group: CheckGroup }) {
  return (
    <ul className="space-y-1.5">
      {group.lines.map((l) => (
        <li key={l.key} data-check-line={l.key} data-done={l.done ? "true" : "false"} className="flex items-start gap-3">
          {l.auto === true ? (
            <CheckCircle2 aria-label="Done (the system checked it)" className="mt-0.5 size-5 shrink-0 text-success" />
          ) : l.manual ? (
            <CloseoutTick dayKey={desk.checks.dayKey} itemKey={l.key} checked={!!l.tick} disabled={desk.readOnly} label={l.label} />
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

function Card({ s, title, subtitle, children, footer, id, wide = false, href }: { s?: DeskSection; title?: string; subtitle: string; children: ReactNode; footer?: ReactNode; id?: string; wide?: boolean; href?: string | null }) {
  const key = s?.key ?? id;
  return (
    <section id={id} aria-labelledby={`desk-${key}-title`} data-desk-section={s?.key} data-desk-card={id} data-count={s ? (s.count == null ? "?" : String(s.count)) : undefined} className={cn("panel-shadow flex min-w-0 scroll-mt-32 flex-col rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5 md:scroll-mt-28", wide && "lg:col-span-2")}>
      <div className="flex items-start gap-2">
        <h2 id={`desk-${key}-title`} className="flex-1 text-xl font-semibold leading-tight">{s?.title ?? title}</h2>
        {href && <Link href={href} aria-label={`Open ${s?.title ?? title}`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2"><ChevronRight aria-hidden className="size-5" /></Link>}
      </div>
      <p className="mt-0.5 text-sm text-muted" data-subtitle>{subtitle}</p>
      {s && s.unavailable.length > 0 && (
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

/**
 * EVERY ROW HAS A BUTTON (Jordan, Oct 28 2026: "make sure every task and
 * assignment has an actionable button"). A row with its own primary says what
 * it does. A row whose move is someone else's (waiting on James, AutoHDR,
 * CubiCasa, a verification) still opens its quick actions: Follow up on a task,
 * a reminder or an assignment (Mark done, a new date, Waiting on, Update,
 * Delegate), the floor plan's own Mark delivered, else Open. The line beside it
 * names who it waits on.
 */
function rowButtonLabel(i: DeskItem): { label: string; solid: boolean } {
  if (i.primary) return { label: i.primary.label, solid: SOLID.has(i.primary.action.kind) || i.late || i.rank === 0 };
  const plan = i.actions.find((a): a is Extract<DeskAction, { kind: "mark-delivered" }> => a.kind === "mark-delivered");
  return { label: i.actions.some((a) => a.kind === "task" || a.kind === "remind" || a.kind === "delegation") ? "Follow up" : plan ? plan.label : "Open", solid: false };
}

function RowButton({ i, onOpen, small = false }: { i: DeskItem; onOpen: (i: DeskItem) => void; small?: boolean }) {
  const { label, solid } = rowButtonLabel(i);
  return (
    <button type="button" onClick={() => onOpen(i)} data-open-panel={i.id} className={cn(solid ? PRIMARY : QUIET, "shrink-0", small ? "font-medium" : "sm:min-w-28")}>
      {label}
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

function ReviewDeliver({ s, onOpen, readOnly, href }: { s: DeskSection; onOpen: (i: DeskItem, f?: Focus) => void; readOnly: boolean; href: string }) {
  const [all, setAll] = useState(false);
  const rows = all ? s.now : s.now.slice(0, ROWS_SHOWN);
  const media = rows.filter((i) => i.group === "media");
  const video = rows.filter((i) => i.group === "video");
  // Run Topaz again on an approved video's row (Jordan, Oct 23 2026), under
  // the row's own button; the side panel carries the same control.
  const reruns = (i: DeskItem) => (readOnly || i.group !== "video" ? [] : i.actions.filter((a): a is Extract<DeskAction, { kind: "topaz-rerun" }> => a.kind === "topaz-rerun"));
  const row = (i: DeskItem) => (
    <li key={i.id} data-desk-item={i.id} className="flex flex-wrap items-center gap-3 py-2.5">
      <Thumb i={i} icon={i.group === "video" ? "video" : "photo"} />
      <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
        <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
        <span className={cn("block text-sm", i.late ? "text-danger" : "text-foreground/80")}>{i.line}</span>
        <span className="block text-[13px] text-muted">{[i.client && `Client: ${i.client}`, i.dueWords].filter(Boolean).join(" · ")}</span>
      </button>
      <RowButton i={i} onOpen={onOpen} />
      {reruns(i).length > 0 && (
        <div className="basis-full sm:pl-[6.75rem]" data-row-rerun={i.id}>
          {reruns(i).map((a) => <RerunTopaz key={a.jobId} jobId={a.jobId} street={a.street} credits={a.credits} limit={a.limit} video={reruns(i).length > 1 ? a.video : undefined} />)}
        </div>
      )}
    </li>
  );
  return (
    <Card s={s} href={href} subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Nothing waiting on you" : `${plural(s.count, "job")} ready for your attention`}
      footer={
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-start gap-3">
            {/* The full status page: every job in review and delivery, each piece's state and what is missing. */}
            <Link href={href} data-view-deliveries className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">View all deliveries <ArrowRight aria-hidden className="size-3.5" /></Link>
            {s.waiting.length > 0 && (
              <details className="group ml-auto min-w-0 basis-full sm:basis-auto sm:open:basis-full" data-awaiting>
                <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                  {s.waiting.length} awaiting files <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                {/* Each with its own button (Oct 28 2026): Open, or the floor plan's Mark delivered. */}
                <ul className="mt-1 divide-y divide-border text-[13px]">
                  {s.waiting.map((i) => (
                    <li key={i.id} data-desk-item={i.id} data-state="waiting" className="flex items-center gap-2 py-1.5">
                      <button type="button" onClick={() => onOpen(i)} className="min-h-9 min-w-0 flex-1 text-left [overflow-wrap:anywhere] hover:underline">
                        <span className="font-medium">{i.title}</span> <span className="text-muted">· {i.line}{i.dueWords ? ` · ${i.dueWords}` : ""}</span>
                      </button>
                      <RowButton i={i} onOpen={onOpen} small />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {s.quiet.length > 0 && <ul className="space-y-1 text-[13px] text-muted" data-quiet>{s.quiet.map((q) => <li key={q.text}>{q.href ? <Link href={q.href} className="hover:text-foreground hover:underline">{q.text}</Link> : q.text}</li>)}</ul>}
        </div>
      }>
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

function Communications({ s, onOpen, fresh }: { s: DeskSection; onOpen: (i: DeskItem, f?: Focus) => void; fresh: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? s.now : s.now.slice(0, ROWS_SHOWN);
  const upToDate = fresh && s.count != null && <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2.5 text-sm" data-up-to-date><CheckCircle2 aria-hidden className="size-5 text-success" /> Other conversations are up to date.</p>;
  // Thank-yous and closers (Jordan, Oct 27 2026: "If someone says thank you - no reply is needed"):
  // never counted, folded with Mark handled so they can be cleared.
  const thanks = s.ok.length > 0 && (
    <details className="group mt-2 rounded-lg bg-surface-2/50 px-3" data-no-reply-needed={s.ok.length}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{plural(s.ok.length, "thank-you")} or closers: no reply needed</span> <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="divide-y divide-border">
        {s.ok.map((i) => (
          <li key={i.id} data-desk-item={i.id} data-state="ok" className="flex items-center gap-3 py-2">
            <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
              <span className="block text-sm font-medium">{i.title}</span>
              <span className="block text-[13px] text-muted [overflow-wrap:anywhere]">{[i.channel, i.line].filter(Boolean).join(" · ")}</span>
            </button>
            <button type="button" onClick={() => onOpen(i, "handled")} data-open-panel={i.id} className={cn(QUIET, "shrink-0")}>Mark handled</button>
          </li>
        ))}
      </ul>
    </details>
  );
  return (
    <Card s={s} href="/communications" subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Everyone has an answer" : `${plural(s.count, "client")} ${s.count === 1 ? "needs" : "need"} a reply`}>
      {s.now.length === 0 ? (s.count === 0 && fresh ? <Empty words={s.empty} /> : s.count === 0 ? <p className="py-2 text-sm text-muted" data-empty>No client replies found; the mail sync is not fresh, so check Messages too.</p> : null) : (
        <>
          <ul className="divide-y divide-border">
            {rows.map((i) => (
              <li key={i.id} data-desk-item={i.id} className="flex items-start gap-3 py-3">
                <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold", i.late ? "bg-danger/15 text-danger" : "bg-brand-soft text-brand")}>{i.initials ?? "?"}</span>
                <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
                  <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
                  <span className={cn("block text-[13px]", i.late ? "text-danger" : "text-muted")}>{[i.channel, i.elapsed].filter(Boolean).join(" · ")}</span>
                  <span className="mt-0.5 block text-sm text-foreground/80 [overflow-wrap:anywhere]">{i.line}</span>
                </button>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <RowButton i={i} onOpen={onOpen} />
                  {i.actions.some((a) => a.kind === "follow-up") && (
                    <button type="button" onClick={() => onOpen(i, "follow-up")} data-create-follow-up={i.id} className="min-h-9 text-[13px] font-medium text-brand underline-offset-2 hover:underline">Create follow-up</button>
                  )}
                  {i.actions.some((a) => a.kind === "handled") && (
                    <button type="button" onClick={() => onOpen(i, "handled")} data-mark-handled-row={i.id} className="min-h-9 text-[13px] text-muted underline-offset-2 hover:text-foreground hover:underline">Mark handled</button>
                  )}
                  {/* A lead that is spam (Kyle, Oct 26 2026: "a lot of them are spam"), on the dashboard too. */}
                  {i.actions.some((a) => a.kind === "lead-disregard") && (
                    <button type="button" onClick={() => onOpen(i, "disregard")} data-disregard-row={i.id} className="min-h-9 text-[13px] text-muted underline-offset-2 hover:text-foreground hover:underline">Disregard</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <ViewAll shown={rows.length} total={s.now.length} onClick={() => setAll(true)} />
        </>
      )}
      {thanks}
      {/* An email he answered, waiting on whoever handed it to him to verify (Oct 28 2026):
          it was in the data and never on the card. Folded, each with its button (Follow up:
          Update, Escalate). */}
      {s.waiting.length > 0 && (
        <details className="group mt-2 rounded-lg bg-surface-2/50 px-3" data-waiting>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="flex-1">{s.waiting.length} waiting on others</span> <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-border">
            {s.waiting.map((i) => (
              <li key={i.id} data-desk-item={i.id} data-state="waiting" className="flex items-center gap-3 py-2">
                <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
                  <span className="block text-sm font-medium [overflow-wrap:anywhere]">{i.title}</span>
                  <span className="block text-[13px] text-muted [overflow-wrap:anywhere]">{[i.channel, i.line].filter(Boolean).join(" · ")}</span>
                </button>
                <RowButton i={i} onOpen={onOpen} small />
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.now.length > 0 && <div className="mt-3">{upToDate}</div>}
    </Card>
  );
}

function Shoots({ s, onOpen, initialDay, includeTest, briefs, onBriefs }: { s: DeskSection; onOpen: (i: DeskItem, f?: Focus) => void; initialDay: "today" | "next"; includeTest: boolean; briefs: Desk["briefsPending"]; onBriefs: () => void }) {
  const [day, setDay] = useState<"today" | "next">(initialDay);
  const everyone = [...s.now, ...s.waiting, ...s.ok];
  // EVERY SHOOT OF THE DAY, IN TIME ORDER (Jordan, Oct 27 2026: "Today's shoots, even if they
  // started, should not be collapsed. They should still show."). One under way or done keeps
  // its row, its chip saying so ("On site", "Shot").
  const ofDay = everyone.filter((i) => i.day === day).sort((a, b) => (timeOf(a) ?? "9999").localeCompare(timeOf(b) ?? "9999"));
  const over = (i: DeskItem) => i.panel.kind === "visit" && i.panel.visit.over;
  const needs = (d: "today" | "next") => s.now.filter((i) => i.day === d).length;
  const count = (d: "today" | "next") => everyone.filter((i) => i.day === d).length;
  const pending = briefs.filter((b) => b.day === day);
  const row = (i: DeskItem) => {
    const v = i.panel.kind === "visit" ? i.panel.visit : null;
    return (
      <li key={i.id} data-desk-item={i.id} data-state={i.state} data-started={over(i) ? "true" : undefined} className="flex flex-wrap items-center gap-3 py-2.5 sm:flex-nowrap">
        <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{v?.timeISO ? `${day === "next" ? `${etDate(v.timeISO).split(",")[0]} ` : ""}${etTime(v.timeISO)}` : "No time"}</span>
        <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
          <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{i.title}</span>
          <span className="block text-[13px] text-muted">{v?.photographer ?? "No photographer"}</span>
        </button>
        <span className="min-w-0 sm:w-56">
          {i.chip && <span data-chip className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium", CHIP_TONE[i.chip.tone])}>{i.chip.tone === "ok" ? <CheckCircle2 aria-hidden className="size-3.5" /> : i.chip.tone === "muted" ? null : <Clock aria-hidden className="size-3.5" />}{i.chip.label}</span>}
          {/* A shoot under way or done says so once (Kyle, Oct 28 2026: "Shot" chip, then "Shot" again under it). */}
          {sub(i, v) && <span className="mt-0.5 block text-[12px] text-muted" data-shoot-sub>{sub(i, v)}</span>}
        </span>
        <RowButton i={i} onOpen={onOpen} />
      </li>
    );
  };
  return (
    <Card s={s} href={homeRecordHref("/schedule", includeTest)} subtitle={`${plural(count(day), "shoot")} ${day === "today" ? "today" : "next business day"}${needs(day) ? ` · ${needs(day)} ${needs(day) === 1 ? "needs" : "need"} you` : ""}`}
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
          <ul className="divide-y divide-border">{ofDay.map(row)}</ul>
          {pending.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2/60 px-3 py-2.5" data-briefs-pending={pending.length}>
              <FileText aria-hidden className="size-5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Photographer briefs</span>
                <span className="block text-[12px] text-muted">{plural(pending.length, "acknowledgment")} pending</span>
              </span>
              <button type="button" onClick={onBriefs} data-open-panel="special:briefs" className={QUIET}>Follow up</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const timeOf = (i: DeskItem) => (i.panel.kind === "visit" ? i.panel.visit.timeISO : i.dueISO);
/** The line under a shoot's chip: what needs Kyle, else the confirmation and the brief. Nothing once
 *  the shoot has started: the chip already says "On site" or "Shot", and the brief no longer matters. */
const sub = (i: DeskItem, v: PrepVisit | null): string | null => {
  // confirmation "na" = the shoot has started (its words are "On site now" / "Shot", the chip's own).
  const words = i.state === "now" ? i.line : v ? (v.confirmation.state === "na" ? "" : [v.confirmation.words, v.brief.words].join(" · ")) : i.line;
  return words && words !== i.chip?.label ? words : null;
};

function FollowUps({ s, onOpen, backlog, includeTest }: { s: DeskSection; onOpen: (i: DeskItem, f?: Focus) => void; backlog: Desk["backlog"]; includeTest: boolean }) {
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
    <Card s={s} href={homeRecordHref("/tasks", includeTest)} subtitle={s.count == null ? "Couldn't count" : s.count === 0 ? "Nothing due today" : overdue === 0 ? `${plural(s.count, "follow-up")} due today` : `${plural(s.count, "follow-up")} due, ${overdue} overdue`}
      footer={backlog.count > 0 ? <Link href={homeRecordHref(backlog.href, includeTest)} data-backlog className="inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-foreground hover:underline">{plural(backlog.count, "older task")} in your full list <ArrowRight aria-hidden className="size-3.5" /></Link> : undefined}>
      {s.now.length === 0 ? <Empty words={s.empty} /> : (
        <>
          <ul className="divide-y divide-border">{rows.map(row)}</ul>
          <ViewAll shown={rows.length} total={s.now.length} onClick={() => setAll(true)} />
        </>
      )}
      {s.waiting.length > 0 && (
        <details className="group mt-2 rounded-lg bg-surface-2/50 px-3" data-waiting>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="flex-1">{s.waiting.length} waiting on others</span> <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-border">{s.waiting.map(row)}</ul>
        </details>
      )}
    </Card>
  );
}

// ---- the next business day, the closeout, completed today ----------------------------------------

function NextDayCard({ desk, onPrepare }: { desk: Desk; onPrepare: () => void }) {
  const n = desk.nextDay;
  const stat = (icon: ReactNode, label: string, body: ReactNode, key: string) => (
    <div key={key} data-next-stat={key} className="flex min-w-0 items-start gap-3 py-2 sm:px-4 sm:first:pl-0">
      <span className="mt-0.5 text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[13px]">{body}</span>
      </span>
    </div>
  );
  const ok = (t: string) => <span className="text-success">{t}</span>;
  const warn = (t: string) => <span className="text-warning">{t}</span>;
  return (
    <Card id="next-day" wide title={`Next business day · ${n.dayName}`} subtitle={n.visits === 0 ? `No shoots on the calendar for ${n.dayName}.` : `Everything you need for a smooth ${n.dayName}: ${plural(n.visits, "visit")}.`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="grid flex-1 gap-1 divide-border sm:grid-cols-3 sm:divide-x">
          {stat(<CalendarDays aria-hidden className="size-5" />, "Appointments", n.visits === 0 ? <span className="text-muted">None</span> : <>{ok(`${n.appointments.confirmed} confirmed`)} / {n.appointments.pending ? warn(`${n.appointments.pending} pending`) : <span className="text-muted">0 pending</span>}</>, "appointments")}
          {stat(<Users aria-hidden className="size-5" />, "Access & contacts", n.visits === 0 ? <span className="text-muted">None</span> : n.access.missing === 0 ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 aria-hidden className="size-3.5" /> All details recorded</span> : <>{ok(`${n.access.recorded} recorded`)} / {warn(`${n.access.missing} missing`)}</>, "access")}
          {stat(<FileText aria-hidden className="size-5" />, "Photographer instructions", n.visits === 0 ? <span className="text-muted">None</span> : <>{ok(`${n.instructions.ready} ready`)} / {n.instructions.review ? warn(`${n.instructions.review} need review`) : <span className="text-muted">0 need review</span>}</>, "instructions")}
        </div>
        <div className="flex flex-col items-start gap-1 lg:items-center">
          <button type="button" onClick={onPrepare} data-open-panel="special:prepare" className={n.missing.length ? PRIMARY : QUIET}>Prepare {n.dayName}</button>
          <span className="text-[12px] text-muted">Current visit instructions only</span>
        </div>
      </div>
    </Card>
  );
}

function CloseoutCard({ desk, onFinish }: { desk: Desk; onFinish: () => void }) {
  const eod = desk.checks.groups.find((g) => g.key === "eod")!;
  return (
    <Card id="closeout" title="End-of-day closeout" subtitle={desk.checks.finished ? `Day finished at ${etTime(desk.checks.finished.atISO)}.` : "A quick check to wrap up your day."}>
      <CheckLines desk={desk} group={eod} />
      {desk.checks.finished && desk.checks.newSinceFinish > 0 && <p className="mt-2 text-sm text-warning">{desk.checks.newSinceFinish} new since then: still on the desk.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onFinish} data-open-panel="special:finish" className={PRIMARY}>Review &amp; finish day</button>
        <span className="text-[12px] text-muted">A tick records your review; it never closes the work under it.</span>
      </div>
    </Card>
  );
}

function CompletedToday({ desk }: { desk: Desk }) {
  const [all, setAll] = useState(false);
  const list = desk.checks.summary.activity;
  const rows = all ? list : list.slice(0, ACTIVITY_SHOWN);
  return (
    <Card id="completed-today" title="Completed today" subtitle={list.length ? `Recent activity from your day: ${plural(list.length, "thing")} done.` : "Nothing recorded yet today."}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {list.length > rows.length && <button type="button" onClick={() => setAll(true)} data-view-activity className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">View activity <ArrowRight aria-hidden className="size-3.5" /></button>}
          <span className="ml-auto text-[12px] text-muted">Completed actions are logged automatically.</span>
        </div>
      }>
      {rows.length === 0 ? <p className="py-2 text-sm text-muted">Approvals, sends, replies and checks you do today show here.</p> : (
        <ol className="space-y-2.5">
          {rows.map((a, n) => (
            <li key={`${a.atISO}:${n}`} data-activity className="flex items-start gap-3">
              <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
              <span className="w-16 shrink-0 text-sm tabular-nums text-muted">{etTime(a.atISO)}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium [overflow-wrap:anywhere]">{a.what}</span>
                {a.detail && <span className="block text-[12px] text-muted [overflow-wrap:anywhere]">{a.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---- the side panel ----------------------------------------------------------------------

/** The SmartTask a row stands for, when it is one (Delegate and Escalate move that task itself). */
function taskIdOf(item: DeskItem): string | null {
  const m = /^(?:task|rev|lead):([a-z0-9]{10,40})$/i.exec(item.id);
  if (m) return m[1];
  const a = item.actions.find((x) => x.kind === "task");
  return a?.kind === "task" ? a.taskId : null;
}

function SidePanel({ item, special, focus, fallbackTitle, desk, includeTest, drafts, onOpenItem, onClose }: {
  item: DeskItem | null; special: Special | null; focus: Focus; fallbackTitle: string | null; desk: Desk; includeTest: boolean;
  drafts: Record<string, string> | null; onOpenItem: (id: string) => void; onClose: () => void;
}) {
  const title = special === "special:briefs" ? "Photographer briefs" : special === "special:prepare" ? `Prepare ${desk.nextDay.dayName}` : special === "special:finish" ? "Review & finish day" : item?.title ?? fallbackTitle ?? "Done";
  const actions = item ? item.actions.filter((a) => !(item.panel.kind === "visit" && a.kind === "ask")) : [];
  const first = focus ? FOCUS_KIND[focus] : null;
  const ordered = first ? [...actions.filter((a) => a.kind === first), ...actions.filter((a) => a.kind !== first)] : actions;
  const visit = item?.panel.kind === "visit" ? item.panel.visit : null;
  // Every row can be handed on: Delegate, or Escalate to Jordan (a delegated task has its own Escalate).
  const handOn = !!item && !desk.readOnly && !item.actions.some((a) => a.kind === "delegation") && desk.delegates.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-side-panel={special ?? item?.id ?? "gone"}>
      <button type="button" aria-label="Close the panel" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <aside role="dialog" aria-modal="true" aria-labelledby="desk-panel-title" className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-surface shadow-xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="desk-panel-title" className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{title}</h2>
            {item && <p className="mt-0.5 text-[12px] text-muted">{[item.line, item.dueWords, item.who && `Whose move: ${item.who}`].filter(Boolean).join(" · ")}</p>}
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {special === "special:briefs" ? <BriefsPanel desk={desk} />
            : special === "special:prepare" ? <PreparePanel desk={desk} onOpenItem={onOpenItem} />
            : special === "special:finish" ? <FinishPanel desk={desk} />
            : !item ? (
              <p role="status" className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Done: it has left the list. The counts have been updated.</p>
            ) : (
              <>
                <p className="text-sm">{item.reason}</p>
                <PanelBody item={item} readOnly={desk.readOnly} />
                {desk.readOnly ? (
                  <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Preview: read-only. Actions are off.</p>
                ) : (
                  <div className="space-y-3" data-panel-actions>
                    {ordered.map((a, n) => <ActionControl key={`${a.kind}:${n}`} a={a} item={item} desk={desk} draft={drafts?.[item.id] ?? null} />)}
                    {visit?.photographerPhone && visit.photographer && (
                      <ReplyBox phone={visit.photographerPhone} clientId={null} label={`Text ${visit.photographer.split(" ")[0]}`} />
                    )}
                  </div>
                )}
                {handOn && (
                  <HandOn
                    taskId={taskIdOf(item)}
                    title={`${item.title}: ${item.line}`.slice(0, 140)}
                    href={item.href}
                    projectId={item.panel.kind === "job" ? item.panel.projectId : item.panel.kind === "visit" ? item.panel.visit.projectId : null}
                    clientId={null}
                    delegates={desk.delegates}
                    ownerKey={desk.people.ownerKey}
                    ownerName={desk.people.owner}
                  />
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

/** The briefs that went and still wait on a Got it: the brief's own Resend, or a text to the photographer. */
function BriefsPanel({ desk }: { desk: Desk }) {
  const list = desk.briefsPending;
  if (!list.length) return <Empty words="Every brief that went has its Got it." />;
  return (
    <ul className="space-y-4" data-panel="briefs">
      {list.map((b) => (
        <li key={b.visitId} className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm"><span className="font-semibold">{b.photographer}</span> · {b.street}{b.timeISO ? ` · ${b.day === "today" ? "" : `${etDate(b.timeISO)} `}${etTime(b.timeISO)}` : ""}</p>
          <p className="text-[12px] text-muted">{b.state === "changed" ? "The instructions changed: waiting for a new Got it." : "Brief sent: no Got it yet."}</p>
          {desk.readOnly ? <p className="text-[12px] text-muted">Preview: read-only.</p> : (
            <>
              <BriefSend teamMemberId={b.teamMemberId} day={b.dayKey} name={b.photographer.split(" ")[0]} resend />
              {b.phone ? <ReplyBox phone={b.phone} clientId={null} /> : <p className="text-[12px] text-muted">No phone number on file for {b.photographer.split(" ")[0]}.</p>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Prepare <Day>: what is missing for the next business day, each with its visit's own action. */
function PreparePanel({ desk, onOpenItem }: { desk: Desk; onOpenItem: (id: string) => void }) {
  const n = desk.nextDay;
  if (!n.missing.length) return <Empty words={n.visits ? `${n.dayName} is ready: every visit confirmed, with access and current instructions.` : `No shoots on ${n.dayName}.`} />;
  return (
    <ul className="space-y-3" data-panel="prepare">
      {n.missing.map((m, k) => (
        <li key={`${m.visitId}:${k}`} className="space-y-1.5 rounded-lg border border-border p-3" data-missing={m.visitId}>
          <p className="text-sm"><span className="font-semibold">{m.street}</span>{m.timeISO ? ` · ${etDate(m.timeISO)} ${etTime(m.timeISO)}` : ""}</p>
          <p className="text-sm text-warning">{m.problem}</p>
          {desk.readOnly ? null : m.action && m.action.kind !== "link" ? <ActionControl a={m.action} item={null} desk={desk} draft={null} /> : (
            <button type="button" onClick={() => onOpenItem(m.visitId)} className={QUIET}>Open the visit</button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Review & finish day: the summary of the day, then Finish (held until the end-of-day review is done). */
function FinishPanel({ desk }: { desk: Desk }) {
  const c = desk.checks;
  const s = c.summary;
  const eod = c.groups.find((g) => g.key === "eod")!;
  return (
    <div className="space-y-3" data-day-summary>
      <CheckLines desk={desk} group={eod} />
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
        {v.over ? null : field("Brief", v.brief.words)}
        {!v.over && v.brief.state !== "off" && v.brief.why && !v.brief.words.includes(v.brief.why) ? field("Why", v.brief.why) : null}
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

function ActionControl({ a, item, desk, draft }: { a: DeskAction; item: DeskItem | null; desk: Desk; draft: string | null }) {
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
      // The reply box ready (Oct 27 2026): a text with the reply engine's draft; an email in the
      // hub's own email reply box (the thread's newest email, Messages' send), else the reply task's draft.
      return (
        <div className="space-y-3">
          {a.family === "phone"
            ? <DraftReply mode="text" threadKey={a.threadKey} initialDraft={draft} autoDraft={!draft} />
            : a.commLogId
              ? <div data-control="email-reply"><EmailReplyBox target={{ kind: "log", commLogId: a.commLogId }} draft={() => draftEmailThreadReply({ kind: "log", commLogId: a.commLogId! })} startOpen /></div>
              : a.taskId
                ? <DraftReply mode="email" taskId={a.taskId} initialDraft={draft} autoDraft={!draft} />
                : <p className="text-[12px] text-muted">This email can only be answered in Messages. It stays here until the answer is logged.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Link href={a.href} className={QUIET}>Open in Messages</Link>
          </div>
        </div>
      );
    case "handled":
      return <MarkHandled threadKey={a.threadKey} family={a.family} clientId={a.clientId} groupKey={a.groupKey} />;
    case "mark-delivered":
      return <MarkDelivered a={a} />;
    case "revision-decide":
      return <RevisionDecide a={a} />;
    case "program-reply":
      return (
        <div className="space-y-3">
          <DraftReply mode="program" enrollmentId={a.enrollmentId} initialDraft={draft} autoDraft={!draft} />
          <Link href={a.href} className={QUIET}>Open the program&rsquo;s Messages</Link>
        </div>
      );
    case "follow-up":
      return <FollowUpCreate clientId={a.clientId} projectId={a.projectId} title={a.title} />;
    case "delegation":
      return <DelegationControls taskId={a.taskId} state={a.state} needsVerification={a.needsVerification} />;
    case "task":
      return (
        <div className="space-y-3">
          <TaskResolve taskId={a.taskId} nextDay={desk.nextDay.dayKey} allowNewDate={a.allowNewDate} doneLabel={a.doneLabel} />
          {a.canWait && <WaitOn taskId={a.taskId} creative={desk.people.creative} owner={desk.people.owner} />}
        </div>
      );
    case "ask":
      return <AskQuickActions id={a.askId} askKind={a.askKind} />;
    case "lead-disregard":
      // The Tasks board's own Disregard (Spam mutes the sender; Not a lead closes just this one).
      return <div className="flex flex-wrap items-center gap-2" data-control="lead-disregard"><LeadDisregardButton taskId={a.taskId} phoneLead={a.phoneLead} className={QUIET} /></div>;
    case "remind":
      return <RemindPhotographerButton projectId={a.projectId} street={a.street} view={a.view} showMissing />;
    case "confirm":
      return <ConfirmControls taskId={a.taskId} />;
    case "topaz-rerun":
      return <RerunTopaz jobId={a.jobId} street={a.street} credits={a.credits} limit={a.limit} video={(item?.actions.filter((x) => x.kind === "topaz-rerun").length ?? 0) > 1 ? a.video : undefined} />;
    case "brief-send":
      return <BriefSend teamMemberId={a.teamMemberId} day={a.day} name={a.name} resend={a.resend} />;
    case "link":
      return item?.href === a.href ? null : <Link href={a.href} className={QUIET}>{a.label}</Link>;
  }
}
