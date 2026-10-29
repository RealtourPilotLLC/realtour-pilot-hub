"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDate, etDayKey, etMonthDay } from "@/lib/datetime";
import type { PlanView } from "@/lib/clientIssuePlan";
import type { StepKind } from "@/lib/clientIssuePlanCore";
import {
  addComplaintPrefsAction, addComplaintStepAction, addComplaintToKpiAction, approveComplaintDraftAction, completeComplaintStepAction,
  dismissComplaintDraftAction, draftComplaintPlanAction, loadComplaintPlanAction, removeComplaintStepAction, saveComplaintSummaryAction,
} from "@/app/clients/complaintPlanActions";
import { moveClientIssueAction } from "@/app/clients/clientCareActions";
import { SendToJordan } from "@/components/delegation/SendToJordan";

// ---------------------------------------------------------------------------
// A COMPLAINT'S PLAN, ON SCREEN (Oct 29 2026, lib/clientIssuePlan). The same
// panel on Jordan's dashboard, the client's page, Kyle's desk and James's
// desk: the summary, the steps (each one a task on that person's list), the
// hub's draft to approve, the client's preferences for their notes, and the
// KPI tracker. It reads the record itself and reads it again every 30
// seconds while the tab is in view, so a step Kyle ticks shows ticked on
// Jordan's screen without a reload ("when one of us updates something, it
// reflects those changes for everyone").
// ---------------------------------------------------------------------------

type Msg = { ok: boolean; text: string } | null;
type DraftRow = { keep: boolean; text: string; ownerKey: string; due: string; kind: StepKind; alreadyDone: string | null };

const FIELD = "block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm";
const PRIMARY = "inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-medium text-white disabled:opacity-50";
const QUIET = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-50";
const POLL_MS = 30_000;

/** `sendUp`: the viewer is a lead who isn't Jordan (Kyle, James): Send to Jordan under the plan (James call, Oct 28 2026). */
export function ComplaintPlan({ issueId, readOnly = false, initial = null, compact = false, fallbackWords = null, sendUp = false }: { issueId: string; readOnly?: boolean; initial?: PlanView | null; compact?: boolean; fallbackWords?: string | null; sendUp?: boolean }) {
  const router = useRouter();
  const [plan, setPlan] = useState<PlanView | null>(initial);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const asked = useRef(false);

  const reload = useCallback(async () => {
    const r = await loadComplaintPlanAction(issueId).catch(() => null);
    if (!r) return;
    if (r.ok) { setPlan(r.plan); setLoadErr(null); } else setLoadErr(r.message);
  }, [issueId]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, POLL_MS);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [reload]);

  // A fresh complaint with no plan: the hub drafts one as soon as someone looks.
  useEffect(() => {
    if (!plan || readOnly || asked.current || !plan.canDraft) return;
    asked.current = true;
    void draftComplaintPlanAction(issueId).then(() => reload()).catch(() => {});
    setTimeout(() => void reload(), 800);
  }, [plan, readOnly, issueId, reload]);

  // While the hub drafts, look again every few seconds.
  useEffect(() => {
    if (plan?.draft?.state !== "drafting") return;
    const id = setInterval(() => void reload(), 4000);
    return () => clearInterval(id);
  }, [plan?.draft?.state, reload]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      setMsg(null);
      const r = await fn().catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) after?.();
      await reload();
      router.refresh();
    });

  if (!plan) {
    return (
      <div className="space-y-1" data-complaint-plan-loading>
        {fallbackWords && <p className="line-clamp-4 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{fallbackWords}</p>}
        <p className="text-xs text-muted">{loadErr ?? <><Loader2 className="mr-1 inline size-3.5 animate-spin" />Loading the plan…</>}</p>
      </div>
    );
  }
  const p = plan;
  const showDraft = p.steps.length === 0 && p.draft && (p.draft.state === "ready" || p.draft.state === "drafting" || p.draft.state === "failed");
  return (
    <section className={cn("space-y-3", !compact && "rounded-xl border border-border p-3")} data-complaint-plan={p.issueId} aria-label="The plan">
      <Summary plan={p} readOnly={readOnly} pending={pending} run={run} />

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border pt-2">
        <h3 className="text-sm font-semibold">The plan</h3>
        <span data-plan-progress className={cn("min-w-0 flex-1 basis-48 text-right text-[12px] [overflow-wrap:anywhere]", p.progress.late ? "text-danger" : "text-muted")}>{p.progress.words}</span>
      </div>

      {showDraft && <DraftBox plan={p} readOnly={readOnly} pending={pending} run={run} />}

      {p.steps.length > 0 && <Steps plan={p} readOnly={readOnly} pending={pending} run={run} />}
      {!readOnly && (p.steps.length > 0 || p.draft?.state === "dismissed" || p.draft?.state === "approved" || (!p.draft && !p.canDraft)) && <AddStep plan={p} pending={pending} run={run} />}
      {!readOnly && !p.draft && !p.canDraft && p.steps.length === 0 && p.state === "OPEN" && (
        <button type="button" disabled={pending} onClick={() => run(() => draftComplaintPlanAction(p.issueId, { force: true }))} className={QUIET}><Sparkles aria-hidden className="size-4" />Have the hub draft the steps</button>
      )}

      {p.progress.allDone && p.state === "OPEN" && !readOnly && (
        <div className="rounded-lg bg-success/10 px-3 py-2 text-sm" data-plan-all-done>
          <p>Every step is done. Mark it corrected and Kyle gets a task to check in with {p.clientFirst} in two business days.</p>
          <button type="button" disabled={pending} onClick={() => run(() => moveClientIssueAction({ id: p.issueId, to: "CORRECTED", correction: p.correctionFromSteps }))} className={cn(PRIMARY, "mt-2")}>Mark it corrected</button>
        </div>
      )}

      <Preferences plan={p} readOnly={readOnly} pending={pending} run={run} />
      <KpiTracker plan={p} readOnly={readOnly} pending={pending} run={run} />
      {sendUp && !readOnly && p.state === "OPEN" && (
        <SendToJordan title={`${p.clientName ?? "A client"}: ${p.title}`} href={`/clients/${p.clientId}#issue-${p.issueId}`} clientId={p.clientId} projectId={p.projects[0]?.id ?? null} />
      )}

      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </section>
  );
}

type PartProps = { plan: PlanView; readOnly: boolean; pending: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) => void };

function Summary({ plan: p, readOnly, pending, run }: PartProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.summary ?? "");
  if (editing) {
    return (
      <div className="space-y-1.5">
        <label className="text-xs text-muted">Summary (what the dashboards show)<textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={FIELD} /></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending || text.trim().length < 10} onClick={() => run(() => saveComplaintSummaryAction(p.issueId, text), () => setEditing(false))} className={PRIMARY}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className={QUIET}>Cancel</button>
        </div>
      </div>
    );
  }
  // The summary leads; the client's own words (often a whole call) fold under it.
  const words = p.whatHappened.trim();
  return (
    <div className="text-sm" data-plan-summary={p.summary ? "summary" : "words"}>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.summary ?? words}</p>
      {p.summary && words && words !== p.summary && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">What they said, as recorded</summary>
          <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-foreground/80 [overflow-wrap:anywhere]">{words}</p>
        </details>
      )}
      {!readOnly && <button type="button" onClick={() => { setText(p.summary ?? p.draft?.summary ?? ""); setEditing(true); }} className="mt-0.5 text-xs font-medium text-brand">{p.summary ? "Edit summary" : "Write a short summary"}</button>}
    </div>
  );
}

function DraftBox({ plan: p, readOnly, pending, run }: PartProps) {
  const d = p.draft!;
  const [summary, setSummary] = useState(d.summary);
  const [rows, setRows] = useState<DraftRow[]>(() => d.steps.map((s, i) => ({ keep: true, text: s.text, ownerKey: s.ownerKey ?? "", due: p.draftDueDays[i] ?? "", kind: s.kind, alreadyDone: s.alreadyDone })));
  const seen = useRef(d.at);
  useEffect(() => {
    if (seen.current === d.at) return;
    seen.current = d.at;
    setSummary(d.summary);
    setRows(d.steps.map((s, i) => ({ keep: true, text: s.text, ownerKey: s.ownerKey ?? "", due: p.draftDueDays[i] ?? "", kind: s.kind, alreadyDone: s.alreadyDone })));
  }, [d.at, d.summary, d.steps, p.draftDueDays]);
  if (d.state === "drafting") return <p className="text-sm text-muted" data-plan-drafting><Loader2 className="mr-1 inline size-4 animate-spin" />The hub is reading the conversation and drafting the steps…</p>;
  if (d.state === "failed") {
    return (
      <div className="space-y-1.5 text-sm" data-plan-draft-failed>
        <p className="text-danger">The hub couldn&rsquo;t draft it{d.error ? `: ${d.error}` : "."}</p>
        {!readOnly && <button type="button" disabled={pending} onClick={() => run(() => draftComplaintPlanAction(p.issueId, { force: true }))} className={QUIET}>Try again</button>}
      </div>
    );
  }
  const kept = rows.filter((r) => r.keep);
  const set = (i: number, patch: Partial<DraftRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2 rounded-lg bg-surface-2 p-3" data-plan-draft>
      <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles aria-hidden className="size-4 text-brand" />The hub&rsquo;s draft. Check it, then create the steps.</p>
      <label className="block text-xs text-muted">Summary<textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} disabled={readOnly} className={FIELD} /></label>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className={cn("rounded-lg border border-border bg-surface p-2", !r.keep && "opacity-60")} data-draft-step={i}>
            <div className="flex items-start gap-2">
              <input type="checkbox" checked={r.keep} disabled={readOnly} onChange={(e) => set(i, { keep: e.target.checked })} aria-label="Keep this step" className="mt-2.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <input value={r.text} onChange={(e) => set(i, { text: e.target.value })} disabled={readOnly} className={FIELD} aria-label="Step" />
                {r.alreadyDone ? (
                  <p className="text-xs text-success">Already done: {r.alreadyDone}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <select value={r.ownerKey} onChange={(e) => set(i, { ownerKey: e.target.value })} disabled={readOnly} aria-label="Who" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm">
                      <option value="">Who?</option>
                      {p.roster.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
                    </select>
                    <input type="date" value={r.due} onChange={(e) => set(i, { due: e.target.value })} disabled={readOnly} aria-label="Due" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm" />
                    {r.kind !== "task" && <span className="self-center text-[11px] text-muted">{r.kind === "coach" ? "Coaching" : "Preferences"}</span>}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || kept.length === 0 || kept.some((r) => !r.alreadyDone && !r.ownerKey) || kept.some((r) => r.text.trim().length < 3)}
            onClick={() => run(() => approveComplaintDraftAction(p.issueId, { summary, steps: kept.map((r) => ({ text: r.text, ownerKey: r.ownerKey, dueISO: r.due || null, kind: r.kind, alreadyDone: r.alreadyDone })) }))}
            className={PRIMARY}
            data-approve-draft
          >
            {pending && <Loader2 className="size-4 animate-spin" />}Create {kept.length} step{kept.length === 1 ? "" : "s"}
          </button>
          <button type="button" disabled={pending} onClick={() => run(() => draftComplaintPlanAction(p.issueId, { force: true }))} className={QUIET}>Draft again</button>
          <button type="button" disabled={pending} onClick={() => run(() => dismissComplaintDraftAction(p.issueId))} className={QUIET}>Set aside</button>
        </div>
      )}
      <p className="text-[11px] text-muted">Each step goes on that person&rsquo;s list and dashboard. Nothing is sent to the client.</p>
    </div>
  );
}

function Steps({ plan: p, readOnly, pending, run }: PartProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  // A refused Remove says so beside the step, not only at the foot of the
  // plan (Kyle, Oct 29 2026: "Remove button is not working").
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null);
  return (
    <ol className="space-y-1.5" data-plan-steps={p.steps.length}>
      {p.steps.map((s) => (
        <li key={s.id} id={`step-${s.id}`} className={cn("rounded-lg border px-2.5 py-2 text-sm", s.cancelled ? "border-border opacity-60" : s.late ? "border-danger/40" : "border-border")} data-plan-step={s.done ? "done" : s.cancelled ? "cancelled" : s.late ? "late" : "open"}>
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <button
              type="button"
              disabled={readOnly || pending || s.done || s.cancelled}
              onClick={() => run(() => completeComplaintStepAction(s.id))}
              aria-label={s.done ? "Done" : "Mark this step done"}
              className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border", s.done ? "border-success-action bg-success-action text-white" : "border-border hover:border-brand")}
            >
              {s.done && <Check aria-hidden className="size-4" />}
            </button>
            <div className="min-w-0 flex-1 basis-48">
              <p className={cn("[overflow-wrap:anywhere]", (s.done || s.cancelled) && "text-muted line-through")}>{s.text}</p>
              <p className={cn("text-[12px]", s.late ? "text-danger" : "text-muted")}>
                {s.ownerName ?? "Nobody yet"}
                {s.done ? ` · done${s.doneAtISO ? ` ${etMonthDay(s.doneAtISO)}` : ""}${s.doneNote ? `: ${s.doneNote}` : ""}` : s.cancelled ? " · no longer needed" : s.dueAtISO ? ` · ${s.late ? "late, was due" : "due"} ${etDate(s.dueAtISO)}` : ""}
              </p>
              {!s.done && s.kind === "coach" && p.photosHref && <Link href={p.photosHref} className="text-[12px] font-medium text-brand">Open the photos to pin coaching notes</Link>}
              {!s.done && s.kind === "prefs" && <p className="text-[12px] text-muted">Done when the preferences below are added to the client&rsquo;s notes.</p>}
            </div>
            {!readOnly && !s.done && !s.cancelled && (
              <button type="button" onClick={() => { setRemoving(removing === s.id ? null : s.id); setWhy(""); setRefused(null); }} aria-label="Remove this step" className="grid size-8 place-items-center rounded-md text-muted hover:text-danger"><X aria-hidden className="size-4" /></button>
            )}
          </div>
          {removing === s.id && (
            <div className="mt-2 space-y-1" data-remove-step>
              <div className="flex flex-wrap gap-2">
                <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why this step isn't needed" aria-label="Why this step isn't needed" className="min-h-11 min-w-0 flex-1 basis-48 rounded-md border border-border bg-surface px-2 text-sm" />
                <button
                  type="button"
                  disabled={pending || why.trim().length < 3}
                  onClick={() => {
                    setRefused(null);
                    run(async () => {
                      const r = await removeComplaintStepAction(s.id, why);
                      if (!r.ok) setRefused({ id: s.id, text: r.message });
                      return r;
                    }, () => setRemoving(null));
                  }}
                  className={QUIET}
                >
                  {pending ? "Removing…" : "Remove"}
                </button>
              </div>
              {refused?.id === s.id && <p role="alert" className="text-[12px] text-danger" data-remove-refused>Not removed: {refused.text}</p>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function AddStep({ plan: p, pending, run }: Omit<PartProps, "readOnly">) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand" data-add-step>Add a step</button>;
  return (
    <div className="space-y-2 rounded-lg border border-border p-2.5">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs doing" className={FIELD} aria-label="Step" />
      <div className="flex flex-wrap gap-2">
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Who" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm">
          <option value="">Who?</option>
          {p.roster.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
        </select>
        <input type="date" value={due} min={etDayKey(new Date())} onChange={(e) => setDue(e.target.value)} aria-label="Due" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm" />
        <button type="button" disabled={pending || text.trim().length < 3 || !owner} onClick={() => run(() => addComplaintStepAction(p.issueId, { text, ownerKey: owner, dueISO: due || null }), () => { setText(""); setDue(""); setOpen(false); })} className={PRIMARY}>Add</button>
        <button type="button" onClick={() => setOpen(false)} className={QUIET}>Cancel</button>
      </div>
    </div>
  );
}

function Preferences({ plan: p, readOnly, pending, run }: PartProps) {
  const [text, setText] = useState(() => p.prefs.suggestion.join("\n"));
  const [touched, setTouched] = useState(false);
  const sugg = p.prefs.suggestion.join("\n");
  useEffect(() => { if (!touched) setText(sugg); }, [sugg, touched]);
  if (p.prefs.addedText) {
    return (
      <div className="rounded-lg border border-border p-2.5 text-sm" data-plan-prefs="added">
        <p className="text-xs font-medium text-muted">Preferences on {p.clientFirst}&rsquo;s client notes</p>
        <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{p.prefs.addedText}</p>
        <p className="mt-1 text-[11px] text-muted">Added by {p.prefs.addedBy ?? "someone"}{p.prefs.addedAtISO ? ` on ${etDate(p.prefs.addedAtISO)}` : ""}. The photographer sees them on the shoot screen and the editor on the brief. Change them in Customer notes on the client&rsquo;s page.</p>
      </div>
    );
  }
  if (readOnly && !sugg) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2.5 text-sm" data-plan-prefs="open">
      <p className="text-xs font-medium text-muted">{p.clientFirst}&rsquo;s preferences for every future shoot and edit{sugg ? " (the hub wrote these from what they said; edit before adding)" : ""}</p>
      <textarea value={text} onChange={(e) => { setTouched(true); setText(e.target.value); }} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} disabled={readOnly} placeholder="One preference a line" className={FIELD} aria-label="Preferences" />
      {!readOnly && (
        <button type="button" disabled={pending || text.trim().length < 3} onClick={() => run(() => addComplaintPrefsAction(p.issueId, text))} className={QUIET} data-add-prefs>
          Add to {p.clientFirst}&rsquo;s client notes
        </button>
      )}
      <p className="text-[11px] text-muted">Added under what is already on their notes and saved to Aryeo. The photographer sees them on the shoot screen, the editor on the brief.</p>
    </div>
  );
}

function KpiTracker({ plan: p, readOnly, pending, run }: PartProps) {
  const k = p.kpi;
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState(k.defaultMemberId ?? "");
  const [area, setArea] = useState("client");
  const [points, setPoints] = useState<number | null>(null);
  const [title, setTitle] = useState(k.title);
  const [note, setNote] = useState(k.note);
  const chosen = k.people.find((x) => x.id === member);
  const first = chosen ? chosen.name.split(" ")[0] : null;
  const already = new Set(k.links.map((l) => l.memberId));
  if (k.people.length === 0 && k.links.length === 0) return null;
  return (
    <div className="space-y-1.5 text-sm" data-plan-kpi={k.links.length}>
      {k.links.map((l) => (
        <p key={l.entryId} className="text-[12px] text-muted">
          On {l.memberName.split(" ")[0]}&rsquo;s KPI tracker: {l.points === 0 ? "a note" : `${l.points} points`}, {k.areas.find((a) => a.key === l.area)?.label ?? l.area} · added by {l.by} {etMonthDay(l.at)}
        </p>
      ))}
      {!readOnly && !open && k.people.some((x) => !already.has(x.id)) && (
        <button type="button" onClick={() => setOpen(true)} className={QUIET} data-open-kpi>Add to KPI tracker</button>
      )}
      {open && (
        <div className="space-y-2 rounded-lg border border-border p-2.5" data-kpi-form>
          <div className="flex flex-wrap gap-2">
            <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Whose tracker" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm">
              <option value="">Whose tracker?</option>
              {k.people.filter((x) => !already.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === k.defaultMemberId ? " (shot this job)" : ""}</option>)}
            </select>
            <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Category" className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm">
              {k.areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} aria-label="Title" />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} className={FIELD} aria-label="What the client said" />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="mb-1 text-xs text-muted">How it counts (pick one)</legend>
            {k.choices.map((c) => (
              <label key={c.points} className="inline-flex min-h-11 items-center gap-1.5 text-sm">
                <input type="radio" name={`kpi-points-${p.issueId}`} checked={points === c.points} onChange={() => setPoints(c.points)} />{c.label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || !member || points == null || title.trim().length < 3}
              onClick={() => run(() => addComplaintToKpiAction(p.issueId, { memberId: member, area, points: points!, title, note }), () => setOpen(false))}
              className={PRIMARY}
            >
              Add to {first ? `${first}'s` : "the"} tracker
            </button>
            <button type="button" onClick={() => setOpen(false)} className={QUIET}>Cancel</button>
          </div>
          <p className="text-[11px] text-muted">{first ?? "They"} see{first ? "s" : ""} it on {first ? "their" : "the"} scorecard with {p.clientFirst} named, and can dispute it. Jordan or James decides a dispute.</p>
        </div>
      )}
    </div>
  );
}
