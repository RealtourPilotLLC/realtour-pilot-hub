"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import type { CallTranscriptUi } from "@/lib/callAnalysis";
import { analyzeCallAction, callAnalysisStatusAction } from "@/app/content/callAnalysisActions";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// A CALL'S TRANSCRIPT, ON SCREEN (Oct 12 2026) — the month's call card, the
// Strategy calls desk and Settings show the same line per call: where the
// transcript came from, whether it has been analyzed (and what it proposed),
// why the automatic run has not done it, and the button that does it now.
//
// Instant: the click draws "Analyzing…" at once, the server claims the call
// and answers, the AI runs in the background, and this polls until the call
// reads analyzed or failed — then refreshes the page so the proposals show.
// A refusal puts the line back and says why.
// ---------------------------------------------------------------------------

// Two-call ET date + time (Oct 9 2026): one call asking for both prints "at" in Safari and breaks hydration.
const whenET = (iso: string | null) => (iso ? `${etDateTime(iso)} ET` : "no time on file");

const STATE_WORD: Record<CallTranscriptUi["state"], string> = {
  none: "no transcript yet", in: "transcript in, not analyzed", analyzing: "analyzing", analyzed: "analyzed", failed: "analysis failed", review: "transcript needs a person",
};
const STATE_TONE: Record<CallTranscriptUi["state"], string> = {
  none: "bg-surface-2 text-muted", in: "bg-warning/15 text-warning", analyzing: "bg-brand-soft text-brand", analyzed: "bg-success/15 text-success", failed: "bg-danger/10 text-danger", review: "bg-warning/15 text-warning",
};

const POLL_MS = 4000;
const POLL_MAX = 90; // six minutes — longer than any one analysis is allowed to run

export function TranscriptStateChip({ state }: { state: CallTranscriptUi["state"] }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", STATE_TONE[state])}>{STATE_WORD[state]}</span>;
}

/**
 * One call's transcript line.
 *   variant "card"    a bordered row (the month's call card, Settings)
 *   variant "inline"  no frame, for a row that already has one (the desk)
 *   runHere           false → a link to the call's card instead of the button
 *                     (Settings: its page has a 60-second ceiling, the month's 300)
 */
export function CallTranscriptItem({ call, variant = "card", showCall = true, showWord = true, showClient = false, runHere = true }: {
  call: CallTranscriptUi; variant?: "card" | "inline"; showCall?: boolean; showWord?: boolean; showClient?: boolean; runHere?: boolean;
}) {
  const router = useRouter();
  const [c, setC] = useState(call);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);
  // A fresh server read replaces the line — unless a run started here is still going.
  useEffect(() => { if (!busy.current) setC(call); }, [call]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  function poll() {
    let tries = 0;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      tries++;
      callAnalysisStatusAction(c.callRecordId).then((res) => {
        if (!res.ok || !res.call) return;
        if (res.call.state === "analyzing" && tries < POLL_MAX) return;
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        busy.current = false;
        setC(res.call);
        if (res.call.state === "analyzing") setNote("Still running — check back in a minute.");
        router.refresh();
      }).catch(() => { /* a missed poll is retried on the next tick */ });
    }, POLL_MS);
  }

  function analyze() {
    const before = c;
    busy.current = true;
    setNote(null);
    setC({ ...c, state: "analyzing", error: null });
    analyzeCallAction(c.callRecordId)
      .then((res) => {
        if (!res.ok) { busy.current = false; setC(before); setNote(res.message); return; }
        poll();
      })
      .catch(() => { busy.current = false; setC(before); setNote("Could not reach the hub — nothing was started."); });
  }

  // Opened (or refreshed) while a run is going: follow it to the end too.
  useEffect(() => {
    if (call.state === "analyzing" && !timer.current) { busy.current = true; poll(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arriving "analyzing" read; poll is stable in what it does
  }, [call.state, call.callRecordId]);

  const canRun = c.canAnalyze && (c.state === "in" || c.state === "failed" || c.state === "analyzed");
  const label = c.state === "analyzed" ? "Re-analyze" : c.state === "failed" ? "Try again" : "Analyze the call";
  const primary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
  const quiet = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

  return (
    <div className={cn("min-w-0 text-[13px]", variant === "card" && "rounded-xl border border-border px-3 py-2.5")} data-call-transcript={c.callRecordId} data-state={c.state}>
      {showCall && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {showWord && <span className="font-medium">{c.callWord}</span>}
          <span className={showWord ? "text-muted" : "font-medium"}>{whenET(c.whenISO)}</span>
          {showClient && c.clientName && <span className="text-muted">· {c.clientName}</span>}
          <TranscriptStateChip state={c.state} />
        </div>
      )}
      {c.sourceLine && (
        <p className={cn("break-words", showCall && "mt-1")}>
          {c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{c.sourceLine}</a> : c.sourceLine}
          {!showCall && <> · <TranscriptStateChip state={c.state} /></>}
        </p>
      )}
      {!c.sourceLine && !showCall && <p><TranscriptStateChip state={c.state} /></p>}
      {c.state === "analyzing" && (
        <p className="mt-1 flex items-center gap-1.5 text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Analyzing — about a minute. You can leave this page.</p>
      )}
      {c.resultLine && c.state !== "analyzing" && <p className="mt-1 text-success">{c.resultLine}</p>}
      {(c.state === "in" || c.state === "failed") && c.autoLine && <p className="mt-1 text-[12px] text-muted">{c.autoLine}</p>}
      {c.error && c.state !== "analyzing" && <p className="mt-1 break-words text-[12px] text-warning">{c.error}</p>}
      {c.waitLine && <p className="mt-1 text-[12px] text-muted">{c.waitLine}</p>}
      {c.blocked && <p className="mt-1 text-[12px] text-warning">{c.blocked}</p>}
      {(canRun || (!runHere && c.href)) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {canRun && runHere && (
            <button type="button" onClick={analyze} className={c.state === "analyzed" ? quiet : primary}
              title={c.state === "analyzed" ? "Run the analysis again — topics a person already confirmed, removed or rejected stay exactly as they are" : "Proposes topics, answers, facts and script inputs from the call for you to review — nothing reaches the client"}>
              {c.state !== "analyzed" && <Sparkles className="size-4" aria-hidden />}{label}
            </button>
          )}
          {!runHere && c.href && (canRun || c.state === "analyzing") && (
            <Link href={c.href} className={quiet}>{c.state === "analyzed" ? "Open on the month" : "Analyze on the month"} →</Link>
          )}
        </div>
      )}
      {note && <p role="status" className="mt-1 text-[12px] text-danger">{note}</p>}
    </div>
  );
}

/** The month's calls, one line each (the call card on Plan › Calls). */
export function CallTranscriptList({ calls }: { calls: CallTranscriptUi[] }) {
  if (!calls.length) return null;
  return <div className="mt-2.5 space-y-2">{calls.map((c) => <CallTranscriptItem key={c.callRecordId} call={c} showWord={false} />)}</div>;
}
