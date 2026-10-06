"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { pauseEditingAction, startEditingAction } from "@/app/editing/workActions";
import type { WorkBar } from "@/lib/editorWork";
import { barWords, HOW_START_WORKS } from "@/lib/editorDesk";

// ---------------------------------------------------------------------------
// START / PAUSE / RESUME / SWITCH, on the editor's actual working screen (§7.1).
//
// Jordan, Sep 25: a job is "In editing" only because the editor said so, and
// starting another job pauses the one they were on. This bar is where they
// say so. Opening this page, reading the brief or playing a cut does nothing
// to it — only these buttons do.
//
// Sep 28 ("there is just a lot of information to look at, and they get
// confused"): ONE line and ONE button. The words come from lib/editorDesk
// (barWords), in the editor's own timezone. Switching is one tap — the line
// under it already says which job will pause. The fine print folds under
// "details".
//
// Oct 5: the video picker sits beside Start, set to the video on screen. It
// used to hide under "details" on "Any / not sure", so nearly every Start
// named no video — and a Start that names no video is ended by ANY hand-in on
// the job (editorWork's closeScope), not just the video being edited. The
// selected video comes from the page (selectedOutputId) or the URL's
// ?output=; a video not on the picker (already approved) falls back to the
// one already picked, then to "Any". The press shows its result at once
// (useOptimistic); the server's answer replaces it, or puts it back with the
// reason. The one-active-job rule and the Start rule are the server's
// (editorWork), untouched here.
//
// The office sees the same state in Eastern time and, where it has to,
// corrects it: "Start for Kim" / "Pause for Kim" are labelled as corrections
// and logged as the office, never as the editor.
// ---------------------------------------------------------------------------

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const BUTTON_WORDS = { start: "Start", resume: "Resume", pause: "Pause", switch: "Switch to this job" } as const;

export function WorkStateBar({ bar: served, tz, selectedOutputId = null }: { bar: WorkBar; tz: string; selectedOutputId?: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The editor's own press, shown before the server answers.
  const [bar, showPressed] = useOptimistic(served, (b: WorkBar, press: { kind: "start" | "pause"; outputId: string | null; atISO: string }): WorkBar =>
    press.kind === "start"
      ? { ...b, mine: { state: "ACTIVE", sinceISO: press.atISO, outputId: press.outputId }, elsewhere: null }
      : { ...b, mine: { state: "PAUSED", sinceISO: press.atISO, outputId: b.mine.outputId } });
  // WHICH VIDEO: the one on screen, unless the editor changed it here. The
  // choice is kept per selected video, so moving to another video on the page
  // follows it rather than carrying a stale pick across.
  const onScreen = selectedOutputId ?? params?.get("output") ?? null;
  const fallback = (onScreen && served.outputs.some((o) => o.id === onScreen) ? onScreen : null) ?? served.mine.outputId ?? "";
  const [picked, setPicked] = useState<{ for: string | null; id: string } | null>(null);
  const outputId = picked && picked.for === onScreen ? picked.id : fallback;
  const setOutputId = (id: string) => setPicked({ for: onScreen, id });
  // ONE ID PER CLICK, KEPT FOR ITS RETRY: a request that never came back is
  // sent again under the same id, so the server logs it once however many
  // times the network makes us ask. Keyed by WHAT was pressed, with its
  // arguments (the video, whose work) — a different press gets a new id, or
  // the server would answer it "Already recorded" and drop the new video or
  // the pause (review fix, Sep 25; the same rule EditorDesk keeps).
  const inflight = useRef<{ what: string; id: string } | null>(null);

  const run = (what: string, fn: (requestId: string) => Promise<{ ok: boolean; message: string }>) => {
    const id = inflight.current?.what === what ? inflight.current.id : newId();
    inflight.current = { what, id };
    setMsg(null);
    start(async () => {
      try {
        const r = await fn(id);
        inflight.current = null; // a definite answer — the next click is a new request
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        // No answer at all: keep the id so "Try again" is the SAME request.
        setMsg({ ok: false, text: "That didn't reach the hub — press it again to retry (it won't be logged twice)." });
      }
    });
  };

  const doStart = (forEditorKey?: string) =>
    run(`start:${outputId}:${forEditorKey ?? ""}`, (requestId) => {
      if (!forEditorKey) showPressed({ kind: "start", outputId: outputId || null, atISO: new Date().toISOString() });
      return startEditingAction({ projectId: bar.projectId, requestId, outputId: outputId || null, forEditorKey: forEditorKey ?? null });
    });
  const doPause = (forEditorKey?: string) =>
    run(`pause:${forEditorKey ?? ""}`, (requestId) => {
      if (!forEditorKey) showPressed({ kind: "pause", outputId: null, atISO: new Date().toISOString() });
      return pauseEditingAction({ projectId: bar.projectId, requestId, forEditorKey: forEditorKey ?? null });
    });

  const { active, paused } = bar.people;
  const words = barWords(bar, tz, new Date());
  const onBehalf = active.concat(paused).find((x) => x.onBehalfBy);
  const tone =
    (bar.mode === "editor" ? bar.mine.state === "ACTIVE" : active.length > 0) ? "active"
    : (bar.mode === "editor" ? bar.mine.state === "PAUSED" : paused.length > 0) ? "paused"
    : "idle";
  const button = bar.mode === "editor" ? words.button : null;
  // Beside a press that starts work: the editor's Start / Resume / Switch, or
  // the office's "Start for …". Never beside Pause, where it decides nothing.
  const officeStarts = bar.mode === "office" && !!bar.assignee && !active.some((a) => a.editorKey === bar.assignee!.key);
  const showPicker = bar.outputs.length > 1 && ((!!button && button !== "pause") || officeStarts);

  const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";
  return (
    <div
      className={cn(
        "mb-3 rounded-2xl border px-4 py-3",
        tone === "active" ? "border-[#8b5cf6]/40 bg-[#8b5cf6]/10" : tone === "paused" ? "border-border bg-surface-2/60" : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span
            className={cn(
              "mt-1.5 inline-block size-2 shrink-0 rounded-full",
              tone === "active" ? "bg-[#8b5cf6]" : tone === "paused" ? "border border-[#8b5cf6]" : "bg-muted-2/40",
            )}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{words.state}</p>
            {words.sub && <p className="mt-0.5 text-[11px] text-muted">{words.sub}</p>}
            {onBehalf && (
              <p className="mt-0.5 text-[11px] text-muted-2">Last change made by {onBehalf.onBehalfBy} for {onBehalf.name} (office correction).</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {showPicker && (
            <label className="inline-flex items-center gap-1.5 text-sm text-muted">
              Video
              <select
                value={outputId}
                onChange={(e) => setOutputId(e.target.value)}
                disabled={pending}
                className="min-h-11 max-w-[14rem] rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                aria-label="Which video you're working on"
              >
                <option value="">Any / not sure</option>
                {bar.outputs.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}</option>
                ))}
              </select>
            </label>
          )}
          {button && (
            <button
              type="button"
              disabled={pending}
              onClick={() => (button === "pause" ? doPause() : doStart())}
              className={cn(btn, "bg-[#8b5cf6] text-white hover:bg-[#7c3aed]")}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : button === "pause" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {BUTTON_WORDS[button]}
            </button>
          )}

          {bar.mode === "office" && bar.assignee && (
            <>
              {active.some((a) => a.editorKey === bar.assignee!.key) ? (
                <button type="button" disabled={pending} onClick={() => doPause(bar.assignee!.key)} className={cn(btn, "border border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground")} title="Recorded as your correction, on their behalf">
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
                  Pause for {bar.assignee.name}
                </button>
              ) : (
                <button type="button" disabled={pending} onClick={() => doStart(bar.assignee!.key)} className={cn(btn, "border border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground")} title="Recorded as your correction, on their behalf — it pauses whatever they were on">
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  Start for {bar.assignee.name}
                </button>
              )}
              <span className="text-[10px] text-muted-2">office correction</span>
            </>
          )}
        </div>
      </div>

      {msg && (
        <p className={cn("mt-2 text-xs", msg.ok ? "text-success" : "text-warning")} role="status">
          {msg.text}
        </p>
      )}

      <details className="mt-2 text-[11px] text-muted-2">
        <summary className="cursor-pointer select-none hover:text-foreground">How Start and Pause work</summary>
        <div className="mt-1.5 space-y-2">
          <ul className="list-disc space-y-0.5 pl-4">
            {HOW_START_WORKS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
