"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDay } from "@/lib/datetime";
import { confirmCurrentWorkAction, pauseEditingAction, startEditingAction } from "@/app/editing/workActions";
import type { UnconfirmedClaim } from "@/lib/editorWork";
import { HOW_START_WORKS, yourClock, type DeskJob } from "@/lib/editorDesk";

// ---------------------------------------------------------------------------
// THE EDITOR'S OWN DESK, at the top of their Editing Room (§7.1; rebuilt Sep 28).
//
// Jordan, Sep 28: "the working on now button for the editors needs to be
// clearer … It says Kim is not working on anything, but I believe he is!" Kim
// had uploaded three versions that day and never pressed Start — because his
// page had no Start button on it. The old desk drew NOTHING until something
// was already active.
//
// So the desk is always here, with a compact current-work strip:
//   · nothing on → Start a job opens the chooser from lib/editorDesk.toDeskJobs.
//     Opening the chooser never starts work; choosing a job is their Start.
//   · on a job   → "You're on 12 Oak St since 12:40am your time" with Pause
//     and Switch job. Switching is the same Start: the server pauses the old
//     job in the same transaction, so there is no second confirm — and it is
//     only that: it never answers the legacy "which one are you on?" for the
//     other marked jobs (only the on-nothing list does, and says so).
// Times are in the editor's own timezone (Manila) and say "your time"; due
// dates are Eastern days like the table below. A job on their list that is
// not handed to them yet is one line, never a button the server refuses.
//
// Nothing here runs by itself: no effect, no timer, no page-open write. Every
// action call sits inside an onClick, and one click carries one request id,
// reused if the network makes them press it again.
// ---------------------------------------------------------------------------

const PREVIEW_TITLE = "You're previewing — exit the preview to press this.";
const NETWORK_FAIL = "That didn't reach the hub — press it again to retry (it won't be logged twice).";
const FIRST = 5;

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type ActiveWork = { projectId: string; street: string; sinceISO: string | null; outputTitle: string | null };

function dueWords(j: DeskJob): { text: string; late: boolean } {
  if (!j.dueISO) return { text: "No due date", late: false };
  return j.late ? { text: `Late · was due ${etMonthDay(j.dueISO)}`, late: true } : { text: `Due ${etMonthDay(j.dueISO)}`, late: false };
}

export function EditorDesk({
  desk,
  jobs,
  tz,
  readOnly = false,
}: {
  /** null = the read of what they're on FAILED (not "nothing"). */
  desk: { active: ActiveWork | null; unconfirmed: UnconfirmedClaim[] } | null;
  jobs: DeskJob[];
  tz: string;
  /** A "view as" preview: everything drawn, nothing pressable. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  // ONE ID PER CLICK, KEPT FOR ITS RETRY — keyed by what was pressed, so a
  // different button gets a new id and the same one pressed again replays.
  const inflight = useRef<{ what: string; id: string } | null>(null);

  const run = (what: string, fn: (requestId: string) => Promise<{ ok: boolean; message: string }>) => {
    if (readOnly) return;
    const id = inflight.current?.what === what ? inflight.current.id : newId();
    inflight.current = { what, id };
    setMsg(null);
    setPressed(what);
    start(async () => {
      try {
        const r = await fn(id);
        inflight.current = null; // a definite answer — the next click is a new request
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) {
          setSwitching(false);
          router.refresh();
        }
      } catch {
        // No answer at all: keep the id so pressing it again is the SAME request.
        setMsg({ ok: false, text: NETWORK_FAIL });
      }
    });
  };

  const active = desk?.active ?? null;
  // A tap on a legacy claim CONFIRMS it — and marks their other claims paused —
  // only from the on-nothing list, where the sentence under it says so. From
  // Switch job it is the plain Start: one job, nothing said about the others.
  // Neither sends a video: omitted, the server keeps the one they picked on
  // the job page (a resume must not wipe "· Video 3").
  const confirms = (j: DeskJob) => j.claim && !active;
  const pick = (j: DeskJob) =>
    confirms(j)
      ? run(`confirm:${j.projectId}`, (requestId) => confirmCurrentWorkAction({ projectId: j.projectId, requestId }))
      : run(`start:${j.projectId}`, (requestId) => startEditingAction({ projectId: j.projectId, requestId }));

  const startable = jobs.filter((j) => j.startable);
  const notYours = jobs.filter((j) => !j.startable);
  const list = active ? startable.filter((j) => j.projectId !== active.projectId) : startable;
  const shown = showAll ? list : list.slice(0, FIRST);
  const hasClaims = !active && startable.some((j) => j.claim);
  const spin = (what: string) => pending && pressed === what;
  const lock = { disabled: pending || readOnly, title: readOnly ? PREVIEW_TITLE : undefined };

  const jobButtons = (
    <div className="space-y-1.5">
      {shown.map((j) => {
        const due = dueWords(j);
        const what = `${confirms(j) ? "confirm" : "start"}:${j.projectId}`;
        const second = [j.pausedSinceISO ? `Paused ${yourClock(j.pausedSinceISO, tz)}` : null, j.note].filter(Boolean).join(" · ");
        return (
          <button
            key={j.projectId}
            type="button"
            {...lock}
            onClick={() => pick(j)}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60"
          >
            {spin(what) ? <Loader2 className="size-4 shrink-0 animate-spin text-brand" /> : <Play className="size-4 shrink-0 text-brand" />}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words text-sm font-semibold text-foreground">{confirms(j) ? "Confirm" : j.pausedSinceISO ? "Resume" : "Start"} · {j.street}</span>
                <span className={cn("shrink-0 text-sm", due.late ? "font-semibold text-danger" : "text-muted")}>{due.text}</span>
              </span>
              {second && <span className="mt-0.5 block text-sm text-muted">{second}</span>}
            </span>
          </button>
        );
      })}
      {list.length > FIRST && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="min-h-11 rounded-lg px-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">
          {showAll ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </div>
  );

  const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60";
  const chooser = (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{active ? "Switch to a job" : "Choose the job you are editing"}</p>
        <button type="button" onClick={() => setSwitching(false)} className={cn(btn, "text-muted hover:bg-surface-2")}>Cancel</button>
      </div>
      {active && <p className="text-sm text-muted">{active.street} will be paused when you start another job.</p>}
      {jobButtons}
      {hasClaims && (
        <div className="space-y-2 text-sm text-muted">
          <p>Confirming a previous &ldquo;In editing&rdquo; mark pauses the other marked jobs.</p>
          <button type="button" {...lock} onClick={() => run("confirm:none", (requestId) => confirmCurrentWorkAction({ projectId: null, requestId }))}
            className={cn(btn, "border border-border text-foreground hover:bg-surface-2")}>
            {spin("confirm:none") ? "Saving…" : "I'm not on any of them"}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section
      aria-label="What you're working on now"
      className="rounded-xl border border-border bg-surface px-4 py-3"
    >
      {desk === null && (
        <p className="mb-2 flex items-start gap-1.5 text-sm text-warning" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Couldn&rsquo;t load what you&rsquo;re on right now — refresh the page. Starting a job below is still safe.
        </p>
      )}

      {active ? (
        <>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:flex sm:flex-wrap">
            <span className="size-2.5 shrink-0 rounded-full bg-success" />
            <p className="min-w-0 break-words text-sm text-foreground sm:flex-1">
              You&rsquo;re on{" "}
              <Link href={`/edit/${active.projectId}`} className="font-semibold underline-offset-2 hover:underline">
                {active.street}
              </Link>
              {active.outputTitle ? ` · ${active.outputTitle}` : ""}
              {active.sinceISO ? <span className="text-muted"> since {yourClock(active.sinceISO, tz)}</span> : null}
            </p>
            <div className="col-span-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                {...lock}
                onClick={() => run(`pause:${active.projectId}`, (requestId) => pauseEditingAction({ projectId: active.projectId, requestId }))}
                className={cn(btn, "border border-border bg-surface text-foreground hover:bg-surface-2")}
              >
                {spin(`pause:${active.projectId}`) ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
                Pause
              </button>
              {list.length > 0 && (
                <button
                  type="button"
                  disabled={readOnly}
                  title={readOnly ? PREVIEW_TITLE : undefined}
                  aria-expanded={switching}
                  onClick={() => setSwitching((v) => !v)}
                  className={cn(btn, "border border-border bg-surface text-foreground hover:bg-surface-2")}
                >
                  <ArrowLeftRight className="size-3.5" />
                  Switch job
                </button>
              )}
            </div>
          </div>
          {switching && chooser}
        </>
      ) : startable.length === 0 ? (
        <p className="text-sm text-muted">{desk === null ? "Your current job is unavailable. The work queue is below." : "Nothing to edit right now."}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Current work</h2>
              <p className="mt-0.5 text-sm text-muted">{desk === null ? "Current job unavailable." : hasClaims ? "A previous In editing mark needs your confirmation." : "No job started in the hub."}</p>
            </div>
            <button type="button" {...lock} aria-expanded={switching} onClick={() => setSwitching((v) => !v)}
              className={cn(btn, "bg-brand-action text-white hover:opacity-90")}>
              <Play aria-hidden="true" className="size-4" />{hasClaims ? "Choose current job" : "Start a job"}
            </button>
          </div>
          {switching && chooser}
        </>
      )}

      {/* On their list, not handed to them: said once, never a Start button
          the server would refuse (the job page's bar says the same). */}
      {notYours.length > 0 && (
        <details className="mt-2 text-sm text-muted">
          <summary className="min-h-11 cursor-pointer content-center rounded-lg focus-visible:outline-2 focus-visible:outline-brand">{notYours.length} job{notYours.length === 1 ? "" : "s"} not assigned to you yet</summary>
          <p>Ask the office: {notYours.map((j) => j.street).join(", ")}</p>
        </details>
      )}

      {msg && (
        <p className={cn("mt-2 text-sm", msg.ok ? "text-success" : "text-warning")} role="status">
          {msg.text}
        </p>
      )}

      <div className="mt-3 border-t border-border/60 pt-2 text-[13px] text-muted">
        {/* While ON a job the only true advice is Pause: nothing ends a Start
            by itself, so a closed tab would leave the office reading "On …"
            all night. */}
        <p>{active ? "Stopped for now? Tap Pause." : "Not editing right now? You don’t need to press anything."}</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <details>
            <summary className="min-h-11 cursor-pointer content-center rounded-lg hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">How Start and Pause work</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {HOW_START_WORKS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
          <Link href="/people/capacity" className="inline-flex min-h-11 items-center font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand">
            Offline or stuck? Tell the office →
          </Link>
        </div>
      </div>
    </section>
  );
}
