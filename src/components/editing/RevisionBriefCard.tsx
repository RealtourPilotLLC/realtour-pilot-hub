"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Inbox,
  Loader2,
  MessageSquareQuote,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { setBriefItemDone, reanalyzeBrief } from "@/app/edit/revisionActions";
import type { BriefView } from "@/lib/revisionBrief";

// Every change asked for on this job, in one card — and both kinds of ask
// reach it now (Jordan, Sep 16, on Sharra Mercer's 16-video job: "the revision
// requests are not showing up well in the editor brief. When I click the
// revisions, it goes down to the cuts. It should go directly to the cut that
// needs a revision."). Two things are asks:
//   · a CLIENT work order — a phone call / email / text, AI-split into items
//     the editor ticks off (everything below this block);
//   · a REVIEW ROOM bounce — Jordan sent a cut back with timestamped notes on
//     it. That produced NO entry here at all until today, so 893 S Matlack's
//     one bounced cut and its notes sat silently inside slot 1 of 16.
// The bounce block goes FIRST, and every line of it links straight to that
// cut's own anchor (#cut-<submissionId>) further down the page.
//
// The client's change request as a WORK ORDER, not a paragraph.
//
// Jordan, Aug 27, on Marcee's call for 1244 West Chester Pike: "This should be
// analyzed and put into actionable items, making sure every aspect of what she
// said is organized so the editor can act on that information. Right now it
// just shows a big paragraph and not even the full transcript."
//
// Sep 7, having lived with the first version: "Its way too big when you first
// open the page. Its not clean right now… it looks extra intimidating and not
// user-friendly." So the card now opens SHUT — one line saying what the round
// is about and how far through it you are — and everything the old card threw
// on screen at once is one click behind that line. Nothing was deleted: the
// client's own words, each item's detail and quote, what to leave alone, what
// they're sending and the questions are all still here.
//
// The rules the layout follows:
//   · Collapsed by default; the header alone says the ask and "1/4 complete".
//   · A ticked item MINIMISES to a single line and sinks to the bottom, so
//     what's left is what you see — and it reopens with one click.
//   · Every item goes green as it's ticked; the whole card goes green when the
//     round is finished.
//   · A checkbox NEVER waits on the server (see `toggle`).
//   · The raw ask is still one click away — the editor should be able to check
//     our reading against what the client actually said.

// Whole phrases, not nouns: the old card built "from a " + the noun, which
// read "from a email" and "from a added by hand".
const SOURCE_LABEL: Record<string, string> = {
  openphone: "From a phone call",
  "openphone-call": "From a phone call",
  gmail: "From an email",
  comms: "From a message",
  slack: "From Slack",
  manual: "Added by hand",
  review_room: "From the review notes",
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** One cut the Review Room sent back — the ask that never had a card. */
export type BouncedCutView = {
  submissionId: string;
  /** Where the cut sits in what the job owes ("cut 1 of 16"). Null on a legacy
   *  folder row that belongs to no deliverable/slot. */
  index: number | null;
  total: number | null;
  /** The slot's own name — "Personal Branding Reel". */
  cutLabel: string | null;
  round: number;
  fileName: string | null;
  /** When it was sent back, and by whom (ReviewSubmission.decidedAt/decidedBy). */
  sentBackAtISO: string | null;
  sentBackBy: string | null;
  notes: {
    id: string;
    timeSec: number | null;
    body: string;
    authorName: string | null;
    status: string; // OPEN | FIXED | RESOLVED
    kind: string; // fix | note
  }[];
};

export function RevisionBriefCard({
  briefs,
  bounced = [],
  canTick,
  canReanalyze,
}: {
  briefs: BriefView[];
  /** Cuts sitting at CHANGES_REQUESTED — the Review Room's asks (Sep 16). */
  bounced?: BouncedCutView[];
  canTick: boolean;
  canReanalyze: boolean;
}) {
  // The card used to render nothing whenever getRevisionBriefs came back empty
  // — which is EVERY review-room bounce, because a bounce writes no brief.
  if (briefs.length === 0 && bounced.length === 0) return null;
  return (
    <div className="space-y-2">
      {bounced.map((c) => (
        <BouncedCut key={c.submissionId} cut={c} />
      ))}
      {briefs.map((b, i) => (
        <OneBrief key={b.id} brief={b} round={i + 1} rounds={briefs.length} canTick={canTick} canReanalyze={canReanalyze} />
      ))}
    </div>
  );
}

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// A cut Jordan sent back, with his notes on it — and a way IN. Open on arrival
// (unlike the client work order below, which Jordan asked to start shut on Sep
// 7): this is a short list of one-line notes, and it is the one thing he said
// was missing. Every row is a link to #cut-<id> — "it should go directly to
// the cut that needs a revision".
function BouncedCut({ cut }: { cut: BouncedCutView }) {
  const [open, setOpen] = useState(true);
  const href = `#cut-${cut.submissionId}`;
  const openCount = cut.notes.filter((n) => n.status === "OPEN").length;
  // "cut 1 of 16" when the slot is known; a legacy folder row only knows which
  // round it was.
  const which = cut.index && cut.total ? `cut ${cut.index} of ${cut.total}` : `round ${cut.round}`;
  const noteLine = `${cut.notes.length} note${cut.notes.length === 1 ? "" : "s"}`;
  // Both numbers on the header row the moment they differ — "6 notes · 2 still
  // to fix". The header used to count every note while the footer counted only
  // the open ones, so one ticked note left two different counts of the same
  // thing on one card (Sep 16 review).
  const fixLine =
    cut.notes.length === 0 || openCount === cut.notes.length
      ? null
      : openCount === 0
        ? "all ticked fixed"
        : `${openCount} still to fix`;

  return (
    <section className="overflow-hidden rounded-xl border border-danger/25 bg-surface">
      <div className="flex items-center gap-2 bg-danger-soft/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Hide the notes" : "Show the notes"}
          aria-expanded={open}
          className="shrink-0 rounded p-0.5 text-muted hover:bg-danger-soft"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
        <a href={href} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
            <Undo2 className="size-3" /> Changes requested
          </span>
          <span className="text-[13px] font-medium text-foreground">
            {which} · {noteLine}
            {fixLine ? ` · ${fixLine}` : ""}
          </span>
          <span className="truncate text-[11px] text-muted">
            {cut.round > 1 ? `round ${cut.round} · ` : ""}
            {cut.sentBackAtISO ? `sent back ${fmtWhen(cut.sentBackAtISO)}` : "sent back"}
            {cut.sentBackBy ? ` by ${cut.sentBackBy}` : ""}
          </span>
        </a>
        <a
          href={href}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-danger px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90"
        >
          Go to this cut <ArrowRight className="size-3" />
        </a>
      </div>
      {open && (
        <div className="border-t border-border">
          {(cut.cutLabel || cut.fileName) && (
            <p className="truncate px-3 pt-2 text-[11px] text-muted-2">
              {cut.cutLabel}
              {cut.cutLabel && cut.fileName ? " · " : ""}
              {cut.fileName}
            </p>
          )}
          {cut.notes.length > 0 ? (
            <ul className="divide-y divide-border/60 px-1.5 py-1">
              {cut.notes.map((n) => (
                <li key={n.id}>
                  {/* The note itself — the timestamp, the words, who wrote them,
                      and whether the editor has already ticked it fixed. The row
                      links to the cut, where the timestamp is playable. */}
                  <a href={href} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-surface-2/60">
                    {n.timeSec != null ? (
                      <span className="mt-px shrink-0 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-brand">
                        {fmtClock(n.timeSec)}
                      </span>
                    ) : (
                      <span className="mt-px shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted-2">note</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-[13px] leading-snug", n.status === "OPEN" ? "text-foreground" : "text-muted")}>
                        {n.body}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-muted-2">
                        {n.authorName ?? "The reviewer"}
                        {n.status === "FIXED" && <span className="ml-1.5 font-semibold text-success">Fixed — awaiting re-review</span>}
                        {n.status === "RESOLVED" && <span className="ml-1.5 font-semibold text-muted">Approved</span>}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[12px] text-muted">
              No timestamped notes on this one — the reason it came back is in the round history and the project chat.
            </p>
          )}
          {openCount > 0 && (
            <p className="border-t border-border px-3 py-1.5 text-[11px] font-semibold text-danger">
              {openCount} still to fix on this cut.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// A small always-visible disclosure: a one-line summary you click to open.
// Used for everything that used to be permanently on screen.
function Fold({
  label,
  icon: Icon,
  tone = "muted",
  defaultOpen = false,
  children,
}: {
  label: string;
  icon: typeof CircleHelp;
  tone?: "muted" | "warning" | "success" | "brand";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneClass =
    tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : tone === "brand" ? "text-brand" : "text-muted";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[11px] font-semibold hover:bg-surface-2", toneClass)}
      >
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")} />
        <Icon className="size-3.5 shrink-0" />
        {label}
      </button>
      {open && <div className="pb-1 pl-6 pr-1">{children}</div>}
    </div>
  );
}

// ONE line of work. Open: the instruction, its area, and the specifics clamped
// to a single line. Ticked: one struck-through green line — "each item ticks
// off and minimises when done" (Jordan, Sep 7) — reopened by the same box.
// Module-level, not nested in OneBrief: a component redeclared on every render
// is a new type to React, which would tear down and remount every row (and any
// open detail) on each tick.
function Item({
  it, isDone, canTick, showing, onToggle, onShow,
}: {
  it: BriefView["items"][number];
  isDone: boolean;
  canTick: boolean;
  showing: boolean;
  onToggle: () => void;
  onShow: () => void;
}) {
  const hasMore = !!(it.detail || it.quote);
  return (
    <li className={cn("flex gap-2 rounded-lg px-1.5 py-1", isDone ? "opacity-70" : "hover:bg-surface-2/60")}>
      <button
        type="button"
        disabled={!canTick}
        onClick={onToggle}
        aria-label={isDone ? "Mark not done" : "Mark done"}
        aria-pressed={isDone}
        title={canTick ? (isDone ? "Reopen this one" : "Mark done") : "Only the editor on this job can tick these off"}
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors",
          isDone ? "border-success bg-success text-white" : "border-border bg-surface-2 hover:border-brand",
          !canTick && "cursor-not-allowed opacity-60",
        )}
      >
        {isDone && <Check className="size-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <p className={cn("min-w-0 flex-1 text-[13px] leading-snug", isDone ? "text-success line-through" : "font-medium text-foreground")}>
            {it.ask}
          </p>
          {!isDone && (
            <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] font-medium text-muted-2">{it.area}</span>
          )}
        </div>
        {/* The specifics stay on screen but clamped to one line until asked
            for — the detail plus the client's verbatim quote on every item are
            what made the old card five screens tall. Nothing is hidden from
            the editor; it's one click, per item. */}
        {hasMore && (
          <>
            {it.detail && !showing && !isDone && (
              <p className="mt-0.5 line-clamp-1 text-[11px] leading-relaxed text-muted">{it.detail}</p>
            )}
            <button
              type="button"
              onClick={onShow}
              className="mt-0.5 text-[10px] font-medium text-muted-2 hover:text-brand"
            >
              {showing ? "Hide details" : it.quote ? "Details + their words" : "Details"}
            </button>
            {showing && (
              <div className="mt-1 space-y-1">
                {it.detail && <p className="text-[11px] leading-relaxed text-muted">{it.detail}</p>}
                {it.quote && (
                  <p className="border-l-2 border-border pl-2 text-[11px] italic leading-relaxed text-muted-2">
                    &ldquo;{it.quote}&rdquo;
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function OneBrief({
  brief, round, rounds, canTick, canReanalyze,
}: {
  brief: BriefView; round: number; rounds: number; canTick: boolean; canReanalyze: boolean;
}) {
  const [done, setDone] = useState<string[]>(brief.done);
  // Re-read replaces the items on the server; the ticks must follow, or a
  // stale local list reads as a green "Done" card over real work (review).
  const doneKey = brief.done.join("|");
  useEffect(() => { setDone(brief.done); }, [doneKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Shut on arrival — Jordan, Sep 7: "Its way too big when you first open the
  // page." The header carries the ask and the score; opening is one click.
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  // Which items have their detail + the client's own words showing. Per item,
  // so opening one receipt doesn't unfurl the whole card again.
  const [shown, setShown] = useState<string[]>([]);
  // A COUNT, not a boolean: two quick ticks each own their own save, and the
  // header's "Saving…" only clears when the last one has answered.
  const [saving, setSaving] = useState(0);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // THE FIX for "the current checkboxes have a do not click symbol and are
  // locked once clicked" (Jordan, Sep 7). The old card disabled EVERY box on
  // one shared useTransition pending flag, so ticking one item froze all nine
  // until the server answered — hence the not-allowed cursor and the "after
  // clicking around a bunch it works". A tick is optimistic and instant; the
  // ONLY thing that ever disables a box is not being allowed to tick it. If
  // the server refuses, the box snaps back and says why.
  const toggle = async (id: string) => {
    if (!canTick) return;
    const wasDone = done.includes(id);
    setDone((d) => (wasDone ? d.filter((x) => x !== id) : [...new Set([...d, id])]));
    setErr(null);
    setSaving((n) => n + 1);
    try {
      const r = await setBriefItemDone(brief.id, id, !wasDone).catch(() => ({
        ok: false,
        message: "That didn't save — check your connection and try again.",
      }));
      if (!r.ok) {
        // Functional, not `setDone(done)`: another tick may have landed while
        // this one was in flight, and reverting to a stale snapshot would undo
        // it too.
        setDone((d) => (wasDone ? [...new Set([...d, id])] : d.filter((x) => x !== id)));
        setErr(r.message);
      }
    } finally {
      setSaving((n) => n - 1);
    }
  };

  const rerun = () => {
    setErr(null);
    start(async () => {
      const r = await reanalyzeBrief(brief.id).catch(() => ({ ok: false, message: "That didn't run." }));
      if (!r.ok) setErr(r.message);
    });
  };

  const total = brief.items.length;
  const ticked = brief.items.filter((i) => done.includes(i.id)).length;
  const allDone = total > 0 && ticked === total;
  const sourceLabel = SOURCE_LABEL[brief.source] ?? `From ${brief.source}`;
  // What's LEFT first, what's done underneath — "so what is left is what you
  // see". Within each half the client's own order stands. The old card grouped
  // by area under seven uppercase headings; the area is now a tag on the item
  // itself, which says the same thing without seven rows of chrome.
  const todo = brief.items.filter((i) => !done.includes(i.id));
  const finished = brief.items.filter((i) => done.includes(i.id));

  const line = brief.headline || brief.originalText.replace(/\s+/g, " ").trim();

  const itemRow = (it: BriefView["items"][number], isDone: boolean) => (
    <Item
      key={it.id}
      it={it}
      isDone={isDone}
      canTick={canTick}
      showing={shown.includes(it.id)}
      onToggle={() => void toggle(it.id)}
      onShow={() => setShown((s) => (s.includes(it.id) ? s.filter((x) => x !== it.id) : [...s, it.id]))}
    />
  );

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-surface",
        allDone ? "border-success/40" : "border-danger/25",
      )}
    >
      {/* THE WHOLE CARD, COLLAPSED: what they asked for, and how far through it
          you are. Everything else is behind this line. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          allDone ? "bg-success-soft/60 hover:bg-success-soft" : "bg-danger-soft/40 hover:bg-danger-soft/60",
        )}
      >
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted", !open && "-rotate-90")} />
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
            allDone ? "bg-success/15 text-success" : "bg-danger/10 text-danger",
          )}
        >
          {allDone ? <CheckCircle2 className="size-3" /> : <Undo2 className="size-3" />}
          {allDone ? "Done" : "Changes requested"}
        </span>
        {rounds > 1 && (
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">R{round}</span>
        )}
        <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", allDone ? "text-muted" : "text-foreground")}>
          {line}
        </span>
        {saving > 0 && <Loader2 className="size-3 shrink-0 animate-spin text-muted-2" />}
        {total > 0 && (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-[11px] font-semibold tabular-nums",
              allDone ? "text-success" : "text-muted",
            )}
          >
            {ticked}/{total} complete
          </span>
        )}
      </button>
      {/* One flat bar of progress — reads at a glance from across the room. */}
      {total > 0 && (
        <div className="h-0.5 w-full bg-border">
          <div
            className={cn("h-full transition-all", allDone ? "bg-success" : "bg-warning")}
            style={{ width: `${Math.round((ticked / total) * 100)}%` }}
          />
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          <p className="text-[11px] text-muted-2">
            {sourceLabel} · {fmtWhen(brief.createdAtISO)}
            {rounds > 1 && ` · round ${round} of ${rounds}`}
          </p>
          {/* The full headline — the header line above truncates it. */}
          {brief.headline && total > 0 && (
            <p className="text-[13px] font-semibold leading-snug text-foreground">{brief.headline}</p>
          )}

          {/* CONFIRM FIRST — the things too vague to start on. Open by default,
              above the list, on purpose: doing the wrong version of these
              costs a whole round. */}
          {brief.questions.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning-soft/50 px-2 py-1">
              <Fold
                label={`${brief.questions.length} to confirm before you start`}
                icon={CircleHelp}
                tone="warning"
                defaultOpen
              >
                <ul className="space-y-1">
                  {brief.questions.map((q, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-foreground/85">
                      {q}
                    </li>
                  ))}
                </ul>
              </Fold>
            </div>
          )}

          {/* THE WORK */}
          {total > 0 ? (
            <div>
              {allDone ? (
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-success">
                  <CheckCircle2 className="size-3.5" /> Every item on this round is ticked off.
                </p>
              ) : (
                <ul>{todo.map((it) => itemRow(it, false))}</ul>
              )}
              {finished.length > 0 && (
                <div className={cn(!allDone && "mt-1.5 border-t border-border/60 pt-1.5")}>
                  {!allDone && (
                    <div className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                      Done ({finished.length})
                    </div>
                  )}
                  <ul>{finished.map((it) => itemRow(it, true))}</ul>
                </div>
              )}
            </div>
          ) : (
            // No split available (AI unreachable, or a short ask that didn't
            // need one) — the client's words ARE the work order, so show them
            // plainly rather than an empty checklist.
            <div className="text-[13px] leading-relaxed text-foreground/85">
              <p className="whitespace-pre-wrap">{brief.originalText}</p>
              {brief.analysisError && (
                <p className="mt-2 text-[11px] text-muted-2">
                  We couldn&rsquo;t break this into steps automatically{canReanalyze ? " — try “Re-read” below." : "."}
                </p>
              )}
            </div>
          )}

          {/* LEAVE ALONE + WHAT THEY'RE SENDING — folded, not deleted. */}
          {brief.keep.length > 0 && (
            <Fold label={`Leave alone (${brief.keep.length})`} icon={ShieldCheck} tone="success">
              <ul className="space-y-0.5">
                {brief.keep.map((k, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-foreground/85">{k}</li>
                ))}
              </ul>
            </Fold>
          )}
          {brief.references.length > 0 && (
            <Fold label={`They're sending (${brief.references.length})`} icon={Paperclip} tone="brand">
              <ul className="space-y-0.5">
                {brief.references.map((r, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-foreground/85">
                    {r.what}
                    {r.where && <span className="text-muted"> — {r.where}</span>}
                  </li>
                ))}
              </ul>
            </Fold>
          )}

          {/* THE RECEIPT — our reading is a reading; the client's own words are
              the truth, kept whole and one click away. */}
          {(total > 0 || canReanalyze) && (
            <div className="flex items-center gap-2 border-t border-border pt-1.5">
              {/* With no split, the client's words ARE the body above — there
                  is nothing left to unfold, so only Re-read shows. */}
              {total > 0 && (
                <button
                  type="button"
                  onClick={() => setShowRaw((s) => !s)}
                  className="flex items-center gap-1.5 rounded-md py-0.5 text-left text-[11px] font-medium text-muted hover:text-foreground"
                >
                  <ChevronDown className={cn("size-3 transition-transform", !showRaw && "-rotate-90")} />
                  <MessageSquareQuote className="size-3.5" />
                  {showRaw ? "Hide" : brief.twoSided ? "Read the full call" : "Read their full message"}
                </button>
              )}
              {canReanalyze && (
                <button
                  type="button"
                  onClick={rerun}
                  title="Read the client's words again and rebuild this list (clears the tick-offs)"
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Re-read
                </button>
              )}
            </div>
          )}
          {showRaw && (
            <div className="rounded-lg bg-surface-2/50 px-2.5 py-2">
              {brief.twoSided && (
                <p className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-2">
                  <Inbox className="size-3" /> Both sides of the call, exactly as transcribed — the transcription is rough in places.
                </p>
              )}
              <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
                {brief.originalText}
              </p>
            </div>
          )}
          {err && <p className="text-[11px] font-medium text-danger">{err}</p>}
        </div>
      )}
    </section>
  );
}
