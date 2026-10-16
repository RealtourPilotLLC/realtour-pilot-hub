"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AlarmClock, Check } from "lucide-react";
import { MISS_CAUSES, MISS_CAUSE_WORDS, type MissCause } from "@/lib/programWatchCore";
import { recordMissCauseAction, saveProgramWatchRulesAction } from "@/app/pipeline/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// PROGRAM VIDEOS BEHIND SCHEDULE (Oct 15 2026, lib/programWatch). Every
// monthly video that missed a milestone, passed its promise, or reached the
// portal late in the last three weeks, with where it stands and the hub's
// guess at why. The office records the real cause here: a person's call,
// pre-filled from the evidence, never written by the hub on its own.
// ---------------------------------------------------------------------------

export type WatchViewRow = {
  outputId: string;
  projectId: string;
  enrollmentId: string | null;
  clientName: string;
  monthWords: string;
  title: string;
  level: "late" | "risk" | "delivered-late";
  why: string;
  promise: string | null;
  milestones: { label: string; by: string; state: "met" | "late" | "missed" | "ahead" }[];
  suggestion: { cause: MissCause; why: string } | null;
  recorded: { cause: MissCause | null; note: string | null; by: string | null; at: string | null } | null;
};

export type WatchRulesView = { alerts: boolean; chaseEscalation: boolean; portalExpectedBy: boolean; libraryRepoint: boolean };

const LEVEL: Record<WatchViewRow["level"], { label: string; cls: string }> = {
  late: { label: "Past its promise", cls: "bg-danger/15 text-danger border-danger/30" },
  risk: { label: "Behind schedule", cls: "bg-warning/15 text-warning border-warning/30" },
  "delivered-late": { label: "Delivered late", cls: "bg-surface-2 text-muted border-border" },
};

const STEP: Record<WatchViewRow["milestones"][number]["state"], string> = {
  met: "text-success",
  late: "text-warning",
  missed: "text-danger font-semibold",
  ahead: "text-muted-2",
};

function CauseControl({ row }: { row: WatchViewRow }) {
  const start = row.recorded?.cause ?? row.suggestion?.cause ?? "";
  const [cause, setCause] = useState<string>(start);
  const [note, setNote] = useState(row.recorded?.note ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, go] = useTransition();
  const save = () =>
    go(async () => {
      const r = await recordMissCauseAction({ outputId: row.outputId, cause: cause || null, note }).catch(() => ({ ok: false, message: "Not saved. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
    });
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-muted">
        Why it slipped
        <select
          value={cause}
          onChange={(e) => { setCause(e.target.value); setMsg(null); }}
          className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
        >
          <option value="">Not decided yet</option>
          {MISS_CAUSES.map((k) => (
            <option key={k} value={k}>{MISS_CAUSE_WORDS[k].label}{row.suggestion?.cause === k && !row.recorded?.cause ? " (suggested)" : ""}</option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-[11px] font-medium text-muted">
        Note (for the office)
        <input
          value={note}
          onChange={(e) => { setNote(e.target.value); setMsg(null); }}
          maxLength={500}
          placeholder="What happened, in a few words"
          className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Saving…" : row.recorded?.cause ? "Update" : "Record cause"}
      </button>
      {msg && <span role="status" className={cn("basis-full text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
    </div>
  );
}

function Switches({ rules, canEdit }: { rules: WatchRulesView; canEdit: boolean }) {
  const [r, setR] = useState(rules);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, go] = useTransition();
  const flip = (k: keyof WatchRulesView) =>
    go(async () => {
      const next = !r[k];
      const res = await saveProgramWatchRulesAction({ [k]: next }).catch(() => ({ ok: false, message: "Not saved. Try again." }));
      if (res.ok) setR({ ...r, [k]: next });
      setMsg(res.ok ? "Saved." : res.message);
    });
  const items: { k: keyof WatchRulesView; label: string; hint: string }[] = [
    { k: "alerts", label: "Tell Kyle when a program video falls behind", hint: "A Slack message and a drafted client update on his list. Nothing is sent to the client." },
    { k: "chaseEscalation", label: "Escalate repeated \"any update?\" messages", hint: "The 2nd ask in 14 days makes a HIGH task for Kyle; the 3rd also tells Jordan." },
    { k: "portalExpectedBy", label: "Show clients \"expected by\" dates on their portal", hint: "Each video in production shows its stage and date, and a plain reason if the date moved." },
    { k: "libraryRepoint", label: "Point old library rows at their re-edit (V2)", hint: "Off: the nightly check only reports them." },
  ];
  return (
    <details className="border-t border-border px-5 py-3 text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-muted">Switches for this watch</summary>
      <ul className="mt-2 space-y-2">
        {items.map((i) => (
          <li key={i.k} className="flex items-start gap-2">
            <input
              id={`pw-${i.k}`}
              type="checkbox"
              checked={r[i.k]}
              disabled={!canEdit || pending}
              onChange={() => flip(i.k)}
              className="mt-1 size-4"
            />
            <label htmlFor={`pw-${i.k}`} className="min-w-0">
              <span className="font-medium">{i.label}</span>
              <span className="block text-xs text-muted">{i.hint}</span>
            </label>
          </li>
        ))}
      </ul>
      {!canEdit && <p className="mt-2 text-xs text-muted">Only the owner or the office can change these.</p>}
      {msg && <p role="status" className="mt-2 text-xs text-muted">{msg}</p>}
    </details>
  );
}

export function ProgramVideoWatch({ rows, rules, canEdit, causesAvailable }: { rows: WatchViewRow[]; rules: WatchRulesView; canEdit: boolean; causesAvailable: boolean }) {
  const late = rows.filter((r) => r.level === "late").length;
  const risk = rows.filter((r) => r.level === "risk").length;
  return (
    <section id="program-watch" className="panel-shadow mb-5 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><AlarmClock aria-hidden className="size-4" /></span>
        <h2 className="text-base font-semibold">Program videos behind schedule</h2>
        <span className="text-xs text-muted">
          {rows.length === 0 ? "none right now" : [late && `${late} past the promise`, risk && `${risk} behind a milestone`, rows.length - late - risk && `${rows.length - late - risk} delivered late`].filter(Boolean).join(" · ")}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted"><Check className="size-4 text-success" aria-hidden /> Every program video is on schedule against its milestones.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.outputId} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-semibold", LEVEL[r.level].cls)}>{LEVEL[r.level].label}</span>
                <span className="min-w-0 break-words text-sm font-semibold">{r.title}</span>
                <span className="text-xs text-muted">{r.clientName} · {r.monthWords}</span>
              </div>
              <p className="mt-1 text-xs text-foreground/80">{r.why}{r.promise ? `. Promise ${r.promise}` : ""}.</p>
              <ol className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                {r.milestones.map((m) => (
                  <li key={m.label} className={STEP[m.state]}>{m.label} by {m.by}{m.state === "late" ? " (late)" : m.state === "missed" ? " (missed)" : m.state === "met" ? " ✓" : ""}</li>
                ))}
              </ol>
              {r.suggestion && (
                <p className="mt-1 text-[11px] text-muted">
                  Suggested cause: <span className="font-medium text-foreground/80">{MISS_CAUSE_WORDS[r.suggestion.cause].label}</span>, because {r.suggestion.why}.
                </p>
              )}
              {r.recorded?.cause && (
                <p className="mt-0.5 text-[11px] text-muted">Recorded: <span className="font-medium text-foreground/80">{MISS_CAUSE_WORDS[r.recorded.cause].label}</span>{r.recorded.by ? ` by ${r.recorded.by}` : ""}{r.recorded.note ? `. ${r.recorded.note}` : ""}</p>
              )}
              {canEdit && causesAvailable && <CauseControl row={r} />}
              <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
                <Link href={`/edit/${r.projectId}`} className="font-medium text-brand hover:underline">Open the job</Link>
                {r.enrollmentId && <Link href={`/content/${r.enrollmentId}?tab=production&view=videos`} className="font-medium text-brand hover:underline">Client&rsquo;s videos</Link>}
                <Link href="/tasks?tab=comms#at-risk" className="font-medium text-brand hover:underline">Draft a client update</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit && !causesAvailable && rows.length > 0 && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted">Recording a cause turns on after tonight&rsquo;s database update.</p>
      )}
      <Switches rules={rules} canEdit={canEdit} />
    </section>
  );
}
