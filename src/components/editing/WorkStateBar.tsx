"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDayKey, etMonthDay, etTime } from "@/lib/datetime";
import { pauseEditingAction, startEditingAction } from "@/app/editing/workActions";
import type { WorkBar } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// START / PAUSE / RESUME, on the editor's actual working screen (§7.1).
//
// Jordan, Sep 25: a job is "In editing" only because the editor said so, and
// starting another job pauses the one they were on. This bar is where they
// say so. Opening this page, reading the brief or playing a cut does nothing
// to it — only these buttons do.
//
// The office sees the same state and, where it has to, corrects it: "Start for
// Kim" / "Pause for Kim" are labelled as corrections and logged as the office,
// never as the editor.
// ---------------------------------------------------------------------------

const clock = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const t = etTime(d).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  return etDayKey(d) === etDayKey(new Date()) ? t : `${etMonthDay(d)} ${t}`;
};

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function WorkStateBar({ bar }: { bar: WorkBar }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [outputId, setOutputId] = useState<string>(bar.mine.outputId ?? "");
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
    run(`start:${outputId}:${forEditorKey ?? ""}`, (requestId) =>
      startEditingAction({ projectId: bar.projectId, requestId, outputId: outputId || null, forEditorKey: forEditorKey ?? null }));
  const doPause = (forEditorKey?: string) =>
    run(`pause:${forEditorKey ?? ""}`, (requestId) => pauseEditingAction({ projectId: bar.projectId, requestId, forEditorKey: forEditorKey ?? null }));

  const { active, paused } = bar.people;

  // ---- the words ----------------------------------------------------------
  let state: string;
  if (bar.mode === "editor") {
    state =
      bar.mine.state === "ACTIVE" ? `You're editing this — since ${clock(bar.mine.sinceISO)}`
      : bar.mine.state === "PAUSED" ? `Paused ${clock(bar.mine.sinceISO)} — everything on it is where you left it`
      : "Not started — press Start editing when you begin";
  } else if (active.length) {
    state = `In editing — ${active.map((a) => `${a.name}${a.sinceISO ? ` since ${clock(a.sinceISO)}` : ""}`).join(", ")}`;
  } else if (paused.length) {
    state = `Paused — ${paused.map((p) => `${p.name}${p.sinceISO ? ` ${clock(p.sinceISO)}` : ""}`).join(", ")}`;
  } else {
    state = "Nobody has started this one";
  }
  const onBehalf = active.concat(paused).find((x) => x.onBehalfBy);
  const tone = (bar.mode === "editor" ? bar.mine.state === "ACTIVE" : active.length > 0) ? "active" : (bar.mode === "editor" ? bar.mine.state === "PAUSED" : paused.length > 0) ? "paused" : "idle";

  const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50";
  return (
    <div
      className={cn(
        "mb-3 rounded-2xl border px-4 py-3",
        tone === "active" ? "border-[#8b5cf6]/40 bg-[#8b5cf6]/10" : tone === "paused" ? "border-border bg-surface-2/60" : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            <span className={cn("mr-2 inline-block size-2 rounded-full align-middle", tone === "active" ? "bg-[#8b5cf6]" : tone === "paused" ? "border border-muted-2" : "bg-muted-2/40")} />
            {state}
          </p>
          {onBehalf && (
            <p className="mt-0.5 text-[11px] text-muted-2">Last change made by {onBehalf.onBehalfBy} for {onBehalf.name} (office correction).</p>
          )}
          {bar.mode === "editor" && bar.blocked && <p className="mt-0.5 text-[11px] text-muted">{bar.blocked}</p>}
          <p className="mt-0.5 text-[11px] text-muted-2">What you say you&rsquo;re working on — not a timer, and it isn&rsquo;t used for pay.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {bar.outputs.length > 1 && bar.mode !== "view" && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              Video
              <select
                value={outputId}
                onChange={(e) => setOutputId(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
                aria-label="Which video you're on (optional)"
              >
                <option value="">Any / not sure</option>
                {bar.outputs.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}</option>
                ))}
              </select>
            </label>
          )}

          {bar.mode === "editor" && bar.mine.state === "ACTIVE" && (
            <button type="button" disabled={pending} onClick={() => doPause()} className={cn(btn, "border border-border bg-surface text-foreground hover:bg-surface-2")}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
              Pause
            </button>
          )}
          {bar.mode === "editor" && bar.mine.state !== "ACTIVE" && bar.canStart && (
            <button
              type="button"
              disabled={pending}
              // Before a switch, say which job will pause (Jordan: starting B
              // pauses A — the editor should see that happen, not discover it).
              onClick={() => (bar.elsewhere && !confirmSwitch ? setConfirmSwitch(true) : (setConfirmSwitch(false), doStart()))}
              className={cn(btn, "bg-[#8b5cf6] text-white hover:bg-[#7c3aed]")}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {bar.mine.state === "PAUSED" ? "Resume" : "Start editing"}
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

      {confirmSwitch && bar.elsewhere && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft/40 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            You&rsquo;re on <span className="font-semibold">{bar.elsewhere.street}</span> — starting this pauses it. Everything on it stays as it is.
          </span>
          <button type="button" disabled={pending} onClick={() => { setConfirmSwitch(false); doStart(); }} className={cn(btn, "bg-[#8b5cf6] text-white hover:bg-[#7c3aed]")}>
            Pause it and start this
          </button>
          <button type="button" onClick={() => setConfirmSwitch(false)} className={cn(btn, "text-muted hover:text-foreground")}>
            Cancel
          </button>
        </div>
      )}

      {msg && (
        <p className={cn("mt-2 text-xs", msg.ok ? "text-success" : "text-warning")} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
