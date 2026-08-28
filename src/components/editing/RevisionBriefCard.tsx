"use client";

import { useState, useTransition } from "react";
import {
  Check,
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

// The client's change request as a WORK ORDER, not a paragraph.
//
// Jordan, Aug 27, on Marcee's call for 1244 West Chester Pike: "This should be
// analyzed and put into actionable items, making sure every aspect of what she
// said is organized so the editor can act on that information. Right now it
// just shows a big paragraph and not even the full transcript."
//
// So the card leads with the checklist, and the raw ask is still one click
// away — because the editor should be able to check our reading against what
// the client actually said.

const SOURCE_LABEL: Record<string, string> = {
  openphone: "phone call",
  "openphone-call": "phone call",
  gmail: "email",
  comms: "message",
  slack: "Slack",
  manual: "added by hand",
  review_room: "review notes",
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

export function RevisionBriefCard({
  briefs,
  canTick,
  canReanalyze,
}: {
  briefs: BriefView[];
  canTick: boolean;
  canReanalyze: boolean;
}) {
  if (briefs.length === 0) return null;
  return (
    <div className="space-y-4">
      {briefs.map((b, i) => (
        <OneBrief key={b.id} brief={b} round={i + 1} rounds={briefs.length} canTick={canTick} canReanalyze={canReanalyze} />
      ))}
    </div>
  );
}

function OneBrief({
  brief, round, rounds, canTick, canReanalyze,
}: {
  brief: BriefView; round: number; rounds: number; canTick: boolean; canReanalyze: boolean;
}) {
  const [done, setDone] = useState<string[]>(brief.done);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => {
    const next = done.includes(id);
    const optimistic = next ? done.filter((d) => d !== id) : [...done, id];
    setDone(optimistic); // snap-back below if the server refuses
    start(async () => {
      const r = await setBriefItemDone(brief.id, id, !next).catch(() => ({ ok: false, message: "That didn't save." }));
      if (!r.ok) { setDone(done); setErr(r.message); } else setErr(null);
    });
  };

  const rerun = () => {
    setErr(null);
    start(async () => {
      const r = await reanalyzeBrief(brief.id).catch(() => ({ ok: false, message: "That didn't run." }));
      if (!r.ok) setErr(r.message);
    });
  };

  // Group by area, preserving the order the client raised things in.
  const areas: { area: string; items: typeof brief.items }[] = [];
  for (const it of brief.items) {
    const slot = areas.find((a) => a.area === it.area);
    if (slot) slot.items.push(it);
    else areas.push({ area: it.area, items: [it] });
  }
  const total = brief.items.length;
  const ticked = brief.items.filter((i) => done.includes(i.id)).length;
  const sourceLabel = SOURCE_LABEL[brief.source] ?? brief.source;

  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-danger/25 bg-surface">
      <header className="border-b border-border bg-danger/5 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
            <Undo2 className="size-3" /> Changes requested
          </span>
          {rounds > 1 && (
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">Round {round}</span>
          )}
          <span className="text-[11px] text-muted-2">
            from a {sourceLabel} · {fmtWhen(brief.createdAtISO)}
          </span>
          {total > 0 && (
            <span className={cn("ml-auto text-xs font-semibold tabular-nums", ticked === total ? "text-success" : "text-muted")}>
              {ticked}/{total} done
            </span>
          )}
        </div>
        {brief.headline && <h3 className="mt-1.5 text-sm font-semibold leading-snug text-foreground">{brief.headline}</h3>}
      </header>

      {/* CONFIRM FIRST — the things too vague to start on. Above the list on
          purpose: doing the wrong version of these costs a whole round. */}
      {brief.questions.length > 0 && (
        <div className="border-b border-border bg-warning/5 px-4 py-3 sm:px-5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
            <CircleHelp className="size-3.5" /> Confirm before you start
          </div>
          <ul className="space-y-1">
            {brief.questions.map((q, i) => (
              <li key={i} className="flex gap-2 text-sm text-foreground/85">
                <span className="text-warning">·</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* THE WORK */}
      {total > 0 ? (
        <div className="divide-y divide-border/60">
          {areas.map((group) => (
            <div key={group.area} className="px-4 py-3 sm:px-5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">{group.area}</div>
              <ul className="space-y-2.5">
                {group.items.map((it) => {
                  const isDone = done.includes(it.id);
                  return (
                    <li key={it.id} className="flex gap-2.5">
                      <button
                        disabled={!canTick || busy}
                        onClick={() => toggle(it.id)}
                        aria-label={isDone ? "Mark not done" : "Mark done"}
                        title={canTick ? (isDone ? "Mark not done" : "Mark done") : "Only the editor on this job can tick these off"}
                        className={cn(
                          "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors",
                          isDone ? "border-success bg-success text-white" : "border-border bg-surface-2 hover:border-brand",
                          (!canTick || busy) && "cursor-not-allowed opacity-60",
                        )}
                      >
                        {isDone && <Check className="size-3" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm font-medium leading-snug", isDone ? "text-muted-2 line-through" : "text-foreground")}>
                          {it.ask}
                        </p>
                        {it.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted">{it.detail}</p>}
                        {it.quote && (
                          <p className="mt-1 border-l-2 border-border pl-2 text-xs italic leading-relaxed text-muted-2">
                            &ldquo;{it.quote}&rdquo;
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        // No split available (AI unreachable, or a short ask that didn't need
        // one) — the client's words ARE the work order, so show them plainly
        // rather than an empty checklist.
        <div className="px-4 py-3 text-sm leading-relaxed text-foreground/85 sm:px-5">
          <p className="whitespace-pre-wrap">{brief.originalText}</p>
          {brief.analysisError && (
            <p className="mt-2 text-[11px] text-muted-2">
              We couldn&rsquo;t break this into steps automatically{canReanalyze ? " — try again below." : "."}
            </p>
          )}
        </div>
      )}

      {/* LEAVE ALONE + WHAT THEY'RE SENDING */}
      {(brief.keep.length > 0 || brief.references.length > 0) && (
        <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2">
          {brief.keep.length > 0 && (
            <div className="bg-surface px-4 py-3 sm:px-5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-success">
                <ShieldCheck className="size-3.5" /> Leave alone
              </div>
              <ul className="space-y-1">
                {brief.keep.map((k, i) => (
                  <li key={i} className="text-sm text-foreground/85">{k}</li>
                ))}
              </ul>
            </div>
          )}
          {brief.references.length > 0 && (
            <div className="bg-surface px-4 py-3 sm:px-5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
                <Paperclip className="size-3.5" /> They&rsquo;re sending
              </div>
              <ul className="space-y-1">
                {brief.references.map((r, i) => (
                  <li key={i} className="text-sm text-foreground/85">
                    {r.what}
                    {r.where && <span className="text-muted"> — {r.where}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* THE RECEIPT — our reading is a reading; the client's own words are the
          truth, kept whole and one click away. */}
      <div className="border-t border-border">
        <button
          onClick={() => setShowRaw((s) => !s)}
          className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[11px] font-medium text-muted hover:bg-surface-2 sm:px-5"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !showRaw && "-rotate-90")} />
          <MessageSquareQuote className="size-3.5" />
          {showRaw ? "Hide" : brief.twoSided ? "Read the full call" : "Read their full message"}
          {total > 0 && <span className="text-muted-2">— check anything that looks off</span>}
          {canReanalyze && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); rerun(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); rerun(); } }}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium hover:bg-surface-2 hover:text-foreground"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Re-read
            </span>
          )}
        </button>
        {showRaw && (
          <div className="border-t border-border bg-surface-2/40 px-4 py-3 sm:px-5">
            {brief.twoSided && (
              <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-2">
                <Inbox className="size-3" /> Both sides of the call, exactly as transcribed — the transcription is rough in places.
              </p>
            )}
            <p className="max-h-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
              {brief.originalText}
            </p>
          </div>
        )}
        {err && <p className="px-4 pb-2 text-[11px] text-danger sm:px-5">{err}</p>}
      </div>
    </section>
  );
}
