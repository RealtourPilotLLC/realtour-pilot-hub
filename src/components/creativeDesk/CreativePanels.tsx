"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDate, etDateTime } from "@/lib/datetime";
import type { AssignedRow, CloseoutLine, CreativeDesk as Desk, CreativeCloseoutKey, FrictionRow } from "@/lib/creativeDesk";
import type { DevGroupKey, Evidence } from "@/lib/teamDevelopment";
import { approveCut } from "@/app/review/actions";
import {
  acceptTaskAction, completeTaskAction, escalateTaskAction, flagBlockerAction, submitForVerificationAction, updateTaskAction,
} from "@/app/delegation/actions";
import { HANDOFF_CLOSE_REASONS, type HandoffCloseReason } from "@/lib/handoffCloseOut";
import {
  addImprovementAction, askJordanImprovementAction, assignPracticeAction, closeOutHandoffAction, creativeCloseoutTickAction, escalateCutAction,
  finishImprovementAction, handMyTaskAction, myTaskStepAction, recommendToJordanAction, recordFeedbackAction, recordFollowUpAction,
  saveAssessmentAction, startAssessmentAction, updateImprovementAction, updatePlanAction, verifyImprovementAction,
} from "@/app/creativeDeskActions";

// ---------------------------------------------------------------------------
// The creative manager's side panel and small controls (Oct 23 2026). Each
// button calls an EXISTING action (the Review Room's approveCut, the
// delegation workflow's task steps) or one of the dashboard's own records
// (app/creativeDeskActions), then refreshes the page in place. A preview
// ("view as") shows the detail and no controls.
// ---------------------------------------------------------------------------

export type Panel =
  | { kind: "cut"; id: string }
  | { kind: "dev-item"; id: string }
  | { kind: "signal"; key: string }
  | { kind: "new-dev"; group: DevGroupKey }
  | { kind: "readiness"; id: string }
  | { kind: "new-readiness" }
  | { kind: "improvement"; id: string }
  | { kind: "new-improvement" }
  | { kind: "friction"; key: string }
  | { kind: "task"; id: string };

type Result = { ok: boolean; message: string; canApproveAnyway?: boolean };

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
const QUIET = `${BTN} border border-border-strong font-medium hover:bg-surface-2`;
const INPUT = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm";
const LABEL = "block text-[12px] font-medium text-muted";

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  return { busy, msg, run };
}

function Said({ msg }: { msg: Result | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "font-medium text-success" : "text-danger")}>{msg.message}</p>;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function Fold({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-xl border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">{title}</summary>
      <div className="space-y-2 border-t border-border p-3">{children}</div>
    </details>
  );
}

function Submit({ busy, children, primary = false }: { busy: boolean; children: React.ReactNode; primary?: boolean }) {
  return (
    <button type="submit" disabled={busy} className={primary ? PRIMARY : QUIET}>
      {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} {children}
    </button>
  );
}

function EvidenceList({ items, href }: { items: Evidence[]; href: (h: string) => string }) {
  if (!items.length) return <p className="text-sm text-muted">No examples recorded.</p>;
  return (
    <ul data-evidence className="space-y-1 text-sm">
      {items.map((e, i) => (
        <li key={`${e.source}:${i}`} className="[overflow-wrap:anywhere]">
          {e.href ? <Link href={href(e.href)} className="text-brand hover:underline">{e.label}</Link> : e.label}
          {e.at && <span className="text-[12px] text-muted"> · {etDate(e.at)}</span>}
        </li>
      ))}
    </ul>
  );
}

const ReadOnlyNote = () => <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Preview: read-only. Actions are off.</p>;

// ---- the panel ---------------------------------------------------------------------------

export function PanelBody({ panel, desk, href, onClose }: { panel: Panel; desk: Desk; href: (h: string) => string; onClose: () => void }) {
  const { title, sub, body } = content(panel, desk, href);
  return (
    <>
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="creative-panel-title" className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{title}</h2>
          {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
        </div>
        <button type="button" autoFocus onClick={onClose} aria-label="Close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">{body}</div>
    </>
  );
}

function gone(what: string) {
  return { title: "Done", sub: null, body: <p role="status" className="text-sm text-success">That {what} has left the list. The counts have been updated.</p> };
}

function content(panel: Panel, desk: Desk, href: (h: string) => string): { title: string; sub: string | null; body: React.ReactNode } {
  const ro = desk.readOnly;
  switch (panel.kind) {
    case "cut": {
      const c = [...desk.review.ready, ...desk.review.delayed].find((x) => x.id === panel.id);
      if (!c) return gone("cut");
      return {
        title: `${c.street}: version ${c.version}`,
        sub: [c.clientName, c.editor ? `Editor: ${c.editor}` : null, c.reviewer ? `Held by ${c.reviewer}` : "Nobody holds it yet"].filter(Boolean).join(" · "),
        body: (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Waiting</dt><dd>{c.waitedWords}{c.delayed ? " (past the cover window)" : ""}</dd>
              <dt className="text-muted">Due</dt><dd>{c.dueWords ?? "No promised date on the job"}</dd>
              <dt className="text-muted">Earlier feedback</dt><dd>{c.priorNotes.total ? `${c.priorNotes.total} notes on earlier versions, ${c.priorNotes.open} still open` : "None: this is the first review"}</dd>
              <dt className="text-muted">Client asks</dt><dd>{c.asks.length ? c.asks.join(" · ") : "None open"}</dd>
            </dl>
            {c.why && <p className="text-sm font-medium text-warning">{c.why}</p>}
            <Link href={href(c.href)} className={PRIMARY}>Review version {c.version} <ExternalLink aria-hidden className="size-4" /></Link>
            <p className="text-[12px] text-muted">The brief, the client&rsquo;s requirements and the timestamped notes are in the review workspace. Request changes there, with your notes on the video.</p>
            {ro ? <ReadOnlyNote /> : (
              <>
                {!c.heldForCheck && (c.mine || !c.reviewer) && <ApproveVersion id={c.id} version={c.version} href={href(c.href)} />}
                <EscalateCut id={c.id} />
              </>
            )}
          </>
        ),
      };
    }
    case "dev-item": {
      const i = (desk.team?.groups ?? []).flatMap((g) => g.items).find((x) => x.id === panel.id);
      if (!i) return gone("coaching item");
      const field = i.group === "FIELD";
      return {
        title: `${i.personName} · ${i.skill}`,
        sub: [`Recorded ${etDate(i.createdISO)} by ${i.createdBy}`, i.followUpISO ? `Follow up ${etDate(i.followUpISO)}` : "No follow-up date"].join(" · "),
        body: (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Standard</dt><dd>{i.standard ?? "Not written yet"}</dd>
              <dt className="text-muted">Next action</dt><dd>{i.nextAction ?? "None yet"}</dd>
              <dt className="text-muted">Practice</dt><dd>{i.practice ? `${i.practice}${i.practiceDueISO ? ` (by ${etDate(i.practiceDueISO)})` : ""}` : "None"}</dd>
              <dt className="text-muted">Progress</dt><dd>{i.progress ?? "Nothing recorded yet"}</dd>
            </dl>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Examples</h3>
              <EvidenceList items={i.evidence} href={href} />
            </div>
            {ro ? <ReadOnlyNote /> : (
              <div className="space-y-2">
                <FeedbackForm itemId={i.id} />
                <FollowUpForm itemId={i.id} />
                <PlanForm itemId={i.id} standard={i.standard} nextAction={i.nextAction} />
                <PracticeForm itemId={i.id} field={field} />
                <VerifyForm itemId={i.id} />
              </div>
            )}
            <div>
              <h3 className="mb-1 text-sm font-semibold">History</h3>
              <ol data-log className="space-y-1 text-[12px] text-muted">
                {i.log.map((l, n) => <li key={n}>{etDateTime(l.at)} · {l.by} · {l.kind.replace(/_/g, " ")}{l.result ? ` (${l.result.replace(/_/g, " ")})` : ""}{l.note ? `: ${l.note}` : ""}</li>)}
              </ol>
            </div>
          </>
        ),
      };
    }
    case "signal": {
      const g = (desk.team?.groups ?? []).find((x) => x.signals.some((s) => s.key === panel.key));
      const s = g?.signals.find((x) => x.key === panel.key);
      if (!s || !g) return gone("evidence");
      return {
        title: `${s.personName} · ${s.skill}`,
        sub: `${s.detail}. Source: ${s.source}.`,
        body: (
          <>
            <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-[12px] text-muted">Evidence, not a judgment. Look at the examples before recording anything.</p>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Review examples</h3>
              <EvidenceList items={s.examples} href={href} />
            </div>
            {ro ? <ReadOnlyNote /> : <NewItemForm group={g.key} people={[{ id: s.personId, name: s.personName }]} signalKey={s.key} skill={s.skill} />}
          </>
        ),
      };
    }
    case "new-dev": {
      const g = desk.team?.groups.find((x) => x.key === panel.group);
      if (!g) return gone("group");
      return {
        title: `Record feedback · ${g.label}`,
        sub: g.blurb,
        body: ro ? <ReadOnlyNote /> : g.people.length === 0 ? <p className="text-sm text-muted">Nobody in this group on the roster.</p> : <NewItemForm group={g.key} people={g.people} />,
      };
    }
    case "readiness": {
      const a = desk.readiness?.items.find((x) => x.id === panel.id);
      if (!a) return gone("assessment");
      return {
        title: `${a.personName} · ${a.trackLabel}`,
        sub: [`Started ${etDate(a.createdISO)} by ${a.createdBy}`, a.status === "RECOMMENDED" ? `Recommended ${a.recommendedISO ? etDate(a.recommendedISO) : ""}` : "In progress"].join(" · "),
        body: (
          <>
            {a.decision && <p data-decision className="rounded-lg bg-surface-2 px-3 py-2 text-sm"><span className="font-semibold">Jordan&rsquo;s decision:</span> {a.decision.words}{a.decision.update ? `. ${a.decision.update}` : ""}</p>}
            <p className="text-[12px] text-muted">You assess and recommend. Jordan decides; nothing about staffing or pay changes from here.</p>
            <AssessmentForm a={a} readOnly={ro || a.status === "RECOMMENDED"} />
            {!ro && <RecommendButton id={a.id} ready={!!a.recommendation} sent={a.status === "RECOMMENDED"} />}
            <ol data-log className="space-y-1 text-[12px] text-muted">
              {a.log.map((l, n) => <li key={n}>{etDateTime(l.at)} · {l.by}{l.note ? `: ${l.note}` : ""}</li>)}
            </ol>
          </>
        ),
      };
    }
    case "new-readiness": {
      return {
        title: "Start a readiness assessment",
        sub: "Independent work, premium projects, a production skill, or Creative Specialist progression",
        body: ro ? <ReadOnlyNote /> : <NewAssessmentForm people={desk.readiness?.people ?? []} criteria={(desk.readiness?.criteria ?? []).map((c) => c.label)} />,
      };
    }
    case "improvement": {
      const i = desk.improvements.items.find((x) => x.taskId === panel.id);
      if (!i) return gone("improvement");
      return {
        title: i.problem,
        sub: [i.area, `Owner: ${i.owner}`, i.status, i.dueISO ? `Due ${etDate(i.dueISO)}` : null].filter(Boolean).join(" · "),
        body: (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Next step</dt><dd>{i.nextStep ?? "None yet"}</dd>
              <dt className="text-muted">Expected outcome</dt><dd>{i.outcome ?? "Not written yet"}</dd>
              <dt className="text-muted">Policy</dt><dd>{i.policy ? "Changes policy: Jordan approves it" : "Within your process work"}</dd>
            </dl>
            {ro ? <ReadOnlyNote /> : <ImprovementForms i={i} />}
          </>
        ),
      };
    }
    case "new-improvement": {
      return { title: "Log a process improvement", sub: "Shot lists, uploads and handoffs, briefs, review, client direction, training, checklists", body: ro ? <ReadOnlyNote /> : <NewImprovementForm /> };
    }
    case "friction": {
      const f = desk.improvements.frictions.find((x) => x.key === panel.key);
      if (!f) return gone("friction");
      return {
        title: f.title,
        sub: `${f.evidence}. ${f.area}.`,
        body: (
          <>
            <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-[12px] text-muted">Counted by the hub, not a judgment. Look at the examples, then start the improvement: it is tracked here until you finish it with the outcome.</p>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Examples</h3>
              <EvidenceList items={f.examples} href={href} />
            </div>
            {ro ? <ReadOnlyNote /> : <NewImprovementForm from={f} />}
          </>
        ),
      };
    }
    case "task": {
      const t = desk.assigned.items.find((x) => x.taskId === panel.id);
      if (!t) return gone("task");
      return {
        title: t.title,
        sub: [t.assignedBy ? `From ${t.assignedBy}` : null, t.dueWords ? `Due ${t.dueWords}` : null, t.stateWords].filter(Boolean).join(" · "),
        body: (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Expected outcome</dt><dd>{t.outcome ?? "Not stated"}</dd>
              <dt className="text-muted">Latest update</dt><dd>{t.latestUpdate ?? "None yet"}</dd>
              <dt className="text-muted">Next step</dt><dd>{t.nextStep ?? "None yet"}</dd>
              <dt className="text-muted">Blocker</dt><dd>{t.blocker ?? "None"}</dd>
            </dl>
            <Link href={href(t.href)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">Open the source <ExternalLink aria-hidden className="size-3.5" /></Link>
            {ro ? <ReadOnlyNote /> : t.delegated ? <TaskControls t={t} /> : <PlainTaskControls t={t} people={desk.assigned.people} ownerKey={desk.ownerKey} />}
          </>
        ),
      };
    }
  }
}

// ---- review --------------------------------------------------------------------------------

function ApproveVersion({ id, version, href }: { id: string; version: number; href: string }) {
  const { busy, msg, run } = useRun();
  return (
    <div className="space-y-2" data-control="approve">
      <button type="button" disabled={busy || !!msg?.ok} onClick={() => run(() => approveCut(id))} className={PRIMARY}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} Approve version {version}
      </button>
      <p className="text-[12px] text-muted">Approves this version only. It goes to Kyle&rsquo;s Ready to send; it is not delivered to the client.</p>
      <Said msg={msg} />
      {msg && !msg.ok && <Link href={href} className="text-sm font-medium text-brand hover:underline">Open the cut to decide</Link>}
    </div>
  );
}

function EscalateCut({ id }: { id: string }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title="Escalate a decision to Jordan">
      <form data-control="escalate-cut" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => escalateCutAction(id, str(f, "why"))); }} className="space-y-2">
        <label className={LABEL} htmlFor={`why-${id}`}>What needs his decision</label>
        <textarea id={`why-${id}`} name="why" rows={3} className={INPUT} required />
        <Submit busy={busy}>Escalate</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

// ---- coaching -----------------------------------------------------------------------------------

function FeedbackForm({ itemId }: { itemId: string }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title="Record feedback">
      <form data-control="feedback" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => recordFeedbackAction({ itemId, note: str(f, "note"), exampleLabel: str(f, "ex") || null, exampleHref: str(f, "exHref") || null })); }} className="space-y-2">
        <label className={LABEL} htmlFor={`fb-${itemId}`}>The feedback you gave</label>
        <textarea id={`fb-${itemId}`} name="note" rows={3} className={INPUT} required />
        <label className={LABEL} htmlFor={`fbx-${itemId}`}>Example (optional)</label>
        <input id={`fbx-${itemId}`} name="ex" className={INPUT} placeholder="The job or moment you looked at" />
        <input name="exHref" className={INPUT} placeholder="Link inside the hub, e.g. /review/..." aria-label="Example link" />
        <Submit busy={busy}>Save feedback</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

function FollowUpForm({ itemId }: { itemId: string }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title="Record a follow-up">
      <form data-control="follow-up" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => recordFollowUpAction(itemId, { note: str(f, "note"), result: str(f, "result") as "improved" | "not_yet" | "noted", nextDay: str(f, "next") || null })); }} className="space-y-2">
        <label className={LABEL} htmlFor={`fu-${itemId}`}>What you saw</label>
        <textarea id={`fu-${itemId}`} name="note" rows={3} className={INPUT} required />
        <label className={LABEL} htmlFor={`fur-${itemId}`}>Result</label>
        <select id={`fur-${itemId}`} name="result" className={INPUT} defaultValue="noted">
          <option value="improved">Improving</option>
          <option value="not_yet">Not yet</option>
          <option value="noted">Noted</option>
        </select>
        <label className={LABEL} htmlFor={`fun-${itemId}`}>Next follow-up (optional)</label>
        <input id={`fun-${itemId}`} name="next" type="date" className={INPUT} />
        <Submit busy={busy}>Save follow-up</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

function PlanForm({ itemId, standard, nextAction }: { itemId: string; standard: string | null; nextAction: string | null }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title="Update the plan">
      <form data-control="plan" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => updatePlanAction(itemId, { standard: str(f, "standard"), nextAction: str(f, "next"), ...(str(f, "day") ? { followUpDay: str(f, "day") } : {}) })); }} className="space-y-2">
        <label className={LABEL} htmlFor={`ps-${itemId}`}>Expected standard</label>
        <textarea id={`ps-${itemId}`} name="standard" rows={2} className={INPUT} defaultValue={standard ?? ""} />
        <label className={LABEL} htmlFor={`pn-${itemId}`}>Next action</label>
        <input id={`pn-${itemId}`} name="next" className={INPUT} defaultValue={nextAction ?? ""} />
        <label className={LABEL} htmlFor={`pd-${itemId}`}>Follow-up date</label>
        <input id={`pd-${itemId}`} name="day" type="date" className={INPUT} />
        <Submit busy={busy}>Save plan</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

function PracticeForm({ itemId, field }: { itemId: string; field: boolean }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title={field ? "Assign a practice activity" : "Recommend a practice activity"}>
      <form data-control="practice" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => assignPracticeAction(itemId, { practice: str(f, "practice"), dueDay: str(f, "day") || null })); }} className="space-y-2">
        {!field && <p className="text-[12px] text-muted">Assigning work to editors and admin QC is Jordan&rsquo;s call, so this goes to him as a recommendation.</p>}
        <label className={LABEL} htmlFor={`pr-${itemId}`}>The practice</label>
        <textarea id={`pr-${itemId}`} name="practice" rows={2} className={INPUT} required />
        <label className={LABEL} htmlFor={`prd-${itemId}`}>Due (optional)</label>
        <input id={`prd-${itemId}`} name="day" type="date" className={INPUT} />
        <Submit busy={busy}>{field ? "Assign practice" : "Recommend to Jordan"}</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

function VerifyForm({ itemId }: { itemId: string }) {
  const { busy, msg, run } = useRun();
  return (
    <Fold title="Verify improvement">
      <form data-control="verify" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => verifyImprovementAction(itemId, { note: str(f, "note"), exampleLabel: str(f, "ex") || null, exampleHref: str(f, "exHref") || null })); }} className="space-y-2">
        <label className={LABEL} htmlFor={`vf-${itemId}`}>What shows the improvement</label>
        <textarea id={`vf-${itemId}`} name="note" rows={2} className={INPUT} required />
        <input name="ex" className={INPUT} placeholder="The job you checked (optional)" aria-label="Example" />
        <input name="exHref" className={INPUT} placeholder="Link inside the hub (optional)" aria-label="Example link" />
        <Submit busy={busy} primary>Verify and close</Submit>
        <Said msg={msg} />
      </form>
    </Fold>
  );
}

function NewItemForm({ group, people, signalKey, skill }: { group: DevGroupKey; people: { id: string; name: string }[]; signalKey?: string; skill?: string }) {
  const { busy, msg, run } = useRun();
  return (
    <form data-control="new-item" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(() => recordFeedbackAction({ personId: str(f, "person"), group, skill: str(f, "skill") || skill || null, note: str(f, "note"), signalKey: signalKey ?? null, exampleLabel: str(f, "ex") || null, exampleHref: str(f, "exHref") || null, standard: str(f, "standard") || null, nextAction: str(f, "next") || null, followUpDay: str(f, "day") || null }));
    }} className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">Record feedback</h3>
      {people.length > 1 ? (
        <>
          <label className={LABEL} htmlFor="nf-person">Person</label>
          <select id="nf-person" name="person" className={INPUT} required>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </>
      ) : <input type="hidden" name="person" value={people[0]?.id ?? ""} />}
      <label className={LABEL} htmlFor="nf-skill">Skill or issue</label>
      <input id="nf-skill" name="skill" className={INPUT} defaultValue={skill ?? ""} required={!skill} />
      <label className={LABEL} htmlFor="nf-note">The feedback you gave</label>
      <textarea id="nf-note" name="note" rows={3} className={INPUT} required />
      {!signalKey && (
        <>
          <label className={LABEL} htmlFor="nf-ex">Example (optional)</label>
          <input id="nf-ex" name="ex" className={INPUT} placeholder="The job or moment you looked at" />
          <input name="exHref" className={INPUT} placeholder="Link inside the hub (optional)" aria-label="Example link" />
        </>
      )}
      <label className={LABEL} htmlFor="nf-standard">Expected standard (optional)</label>
      <input id="nf-standard" name="standard" className={INPUT} />
      <label className={LABEL} htmlFor="nf-next">Next action (optional)</label>
      <input id="nf-next" name="next" className={INPUT} />
      <label className={LABEL} htmlFor="nf-day">Follow-up date (optional)</label>
      <input id="nf-day" name="day" type="date" className={INPUT} />
      <Submit busy={busy} primary>Save</Submit>
      <Said msg={msg} />
    </form>
  );
}

// ---- readiness --------------------------------------------------------------------------------

function AssessmentForm({ a, readOnly }: { a: NonNullable<Desk["readiness"]>["items"][number]; readOnly: boolean }) {
  const { busy, msg, run } = useRun();
  return (
    <form data-control="assessment" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(() => saveAssessmentAction(a.id, {
        criteria: a.criteria.map((c) => ({ key: c.key, met: str(f, `met:${c.key}`) as "yes" | "no" | "unknown", evidence: str(f, `ev:${c.key}`) || null })),
        addCriterion: str(f, "add") || null,
        gaps: str(f, "gaps"),
        recommendation: str(f, "rec") || null,
        note: str(f, "note"),
      }));
    }} className="space-y-3">
      <fieldset disabled={readOnly || busy} className="space-y-3">
        <legend className="text-sm font-semibold">Criteria</legend>
        <ul className="space-y-2">
          {a.criteria.map((c) => (
            <li key={c.key} data-criterion={c.key} data-source={c.source} className="rounded-lg border border-border p-2">
              <p className="text-sm font-medium">{c.label} <span className="text-[11px] font-normal text-muted">{c.source === "kpi" ? "from the KPI terms" : "James's criterion"}</span></p>
              {c.covers && <p className="text-[12px] text-muted">{c.covers}</p>}
              <div className="mt-1 grid gap-2 sm:grid-cols-[9rem_1fr]">
                <select name={`met:${c.key}`} defaultValue={c.met} className={INPUT} aria-label={`${c.label}: met`}>
                  <option value="unknown">Not assessed</option>
                  <option value="yes">Met</option>
                  <option value="no">Not met</option>
                </select>
                <input name={`ev:${c.key}`} defaultValue={c.evidence ?? ""} className={INPUT} placeholder="Evidence reviewed" aria-label={`${c.label}: evidence`} />
              </div>
            </li>
          ))}
        </ul>
        {!readOnly && <input name="add" className={INPUT} placeholder="Add your own criterion (labelled yours)" aria-label="Add a criterion" />}
        <label className={LABEL} htmlFor={`gaps-${a.id}`}>Remaining gaps</label>
        <textarea id={`gaps-${a.id}`} name="gaps" rows={2} className={INPUT} defaultValue={a.gaps ?? ""} />
        <label className={LABEL} htmlFor={`rec-${a.id}`}>Your recommendation</label>
        <select id={`rec-${a.id}`} name="rec" defaultValue={a.recommendation ?? ""} className={INPUT}>
          <option value="">Not decided yet</option>
          <option value="READY">Ready</option>
          <option value="READY_WITH_SUPPORT">Ready with support</option>
          <option value="NOT_YET">Not yet</option>
        </select>
        <label className={LABEL} htmlFor={`note-${a.id}`}>Why (for Jordan)</label>
        <textarea id={`note-${a.id}`} name="note" rows={2} className={INPUT} defaultValue={a.recommendationNote ?? ""} />
        {!readOnly && <Submit busy={busy}>Save assessment</Submit>}
      </fieldset>
      <Said msg={msg} />
    </form>
  );
}

function RecommendButton({ id, ready, sent }: { id: string; ready: boolean; sent: boolean }) {
  const { busy, msg, run } = useRun();
  return (
    <div className="space-y-1" data-control="recommend">
      <button type="button" disabled={busy || !ready} onClick={() => run(() => recommendToJordanAction(id))} className={PRIMARY}>
        {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} {sent ? "Check Jordan's decision task" : "Recommend to Jordan"}
      </button>
      {!ready && <p className="text-[12px] text-muted">Save a recommendation first.</p>}
      <Said msg={msg} />
    </div>
  );
}

function NewAssessmentForm({ people, criteria }: { people: { id: string; name: string }[]; criteria: string[] }) {
  const { busy, msg, run } = useRun();
  const [track, setTrack] = useState("INDEPENDENT");
  if (!people.length) return <p className="text-sm text-muted">Nobody on the roster to assess.</p>;
  return (
    <form data-control="new-assessment" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => startAssessmentAction({ personId: str(f, "person"), track: str(f, "track"), skill: str(f, "skill") || null })); }} className="space-y-2">
      <label className={LABEL} htmlFor="na-person">Person</label>
      <select id="na-person" name="person" className={INPUT}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <label className={LABEL} htmlFor="na-track">For</label>
      <select id="na-track" name="track" className={INPUT} value={track} onChange={(e) => setTrack(e.target.value)}>
        <option value="INDEPENDENT">Independent work</option>
        <option value="PREMIUM">Premium projects</option>
        <option value="SKILL">A production skill</option>
        <option value="SPECIALIST">Creative Specialist progression</option>
      </select>
      {track === "SKILL" && (<><label className={LABEL} htmlFor="na-skill">Which skill</label><input id="na-skill" name="skill" className={INPUT} required /></>)}
      <p className="text-[12px] text-muted">It starts with the criteria that exist (the KPI terms: {criteria.join(", ") || "none found"}). Add your own inside; they are labelled yours.</p>
      <Submit busy={busy} primary>Start</Submit>
      <Said msg={msg} />
    </form>
  );
}

// ---- improvements ---------------------------------------------------------------------------

function ImprovementForms({ i }: { i: Desk["improvements"]["items"][number] }) {
  const upd = useRun();
  const fin = useRun();
  const ask = useRun();
  return (
    <div className="space-y-2">
      <Fold title="Update next step and outcome" open>
        <form data-control="improvement-update" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); upd.run(() => updateImprovementAction(i.taskId, { nextStep: str(f, "next"), outcome: str(f, "outcome") })); }} className="space-y-2">
          <label className={LABEL} htmlFor={`in-${i.taskId}`}>Next step</label>
          <input id={`in-${i.taskId}`} name="next" className={INPUT} defaultValue={i.nextStep ?? ""} />
          <label className={LABEL} htmlFor={`io-${i.taskId}`}>Expected outcome</label>
          <input id={`io-${i.taskId}`} name="outcome" className={INPUT} defaultValue={i.outcome ?? ""} />
          <Submit busy={upd.busy}>Save</Submit>
          <Said msg={upd.msg} />
        </form>
      </Fold>
      {i.policy && (
        <div className="space-y-1">
          <button type="button" disabled={ask.busy} onClick={() => ask.run(() => askJordanImprovementAction(i.taskId))} className={QUIET}>Ask Jordan to approve</button>
          <Said msg={ask.msg} />
        </div>
      )}
      <Fold title="Finish with the outcome">
        <form data-control="improvement-finish" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); fin.run(() => finishImprovementAction(i.taskId, str(f, "outcome"))); }} className="space-y-2">
          <label className={LABEL} htmlFor={`if-${i.taskId}`}>What changed</label>
          <textarea id={`if-${i.taskId}`} name="outcome" rows={2} className={INPUT} required />
          <Submit busy={fin.busy}>Finish</Submit>
          <Said msg={fin.msg} />
        </form>
      </Fold>
    </div>
  );
}

const AREAS = ["Shot lists", "Uploads and handoffs", "Creative briefs", "Review procedure", "Client direction", "Training materials", "Quality checklists"];

/** Log an improvement; from a friction row it starts filled in with what was counted (Oct 27 2026). */
function NewImprovementForm({ from = null }: { from?: FrictionRow | null }) {
  const { busy, msg, run } = useRun();
  return (
    <form data-control="new-improvement" data-friction={from?.key ?? undefined} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => addImprovementAction({ problem: str(f, "problem"), area: str(f, "area"), nextStep: str(f, "next") || null, outcome: str(f, "outcome") || null, policy: f.get("policy") === "on", dueDay: str(f, "day") || null, friction: from?.key ?? null })); }} className="space-y-2">
      <label className={LABEL} htmlFor="ni-problem">The problem</label>
      <textarea id="ni-problem" name="problem" rows={2} className={INPUT} required defaultValue={from ? `${from.problem} (${from.evidence})` : undefined} />
      <label className={LABEL} htmlFor="ni-area">Area</label>
      <select id="ni-area" name="area" className={INPUT} defaultValue={from?.area}>{AREAS.map((a) => <option key={a}>{a}</option>)}</select>
      <label className={LABEL} htmlFor="ni-next">Next step</label>
      <input id="ni-next" name="next" className={INPUT} defaultValue={from?.nextStep} />
      <label className={LABEL} htmlFor="ni-outcome">Expected outcome</label>
      <input id="ni-outcome" name="outcome" className={INPUT} />
      <label className={LABEL} htmlFor="ni-day">Due (optional)</label>
      <input id="ni-day" name="day" type="date" className={INPUT} />
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="policy" className="size-4" /> This changes a policy (Jordan approves it)</label>
      <Submit busy={busy} primary>{from ? "Start the improvement" : "Log it"}</Submit>
      <Said msg={msg} />
    </form>
  );
}

// ---- assigned tasks (the delegation workflow's steps) ------------------------------------------

function TaskControls({ t }: { t: Desk["assigned"]["items"][number] }) {
  const { busy, msg, run } = useRun();
  const [mode, setMode] = useState<"update" | "blocker" | "complete" | "escalate" | null>(null);
  const [words, setWords] = useState("");
  const go = () => {
    const w = words.trim();
    if (mode === "update") run(() => updateTaskAction(t.taskId, w));
    if (mode === "blocker") run(() => flagBlockerAction(t.taskId, w));
    if (mode === "complete") run(() => completeTaskAction(t.taskId, w || undefined));
    if (mode === "escalate") run(() => escalateTaskAction(t.taskId, w));
  };
  return (
    <div className="space-y-2" data-control="task">
      <div className="flex flex-wrap gap-2">
        {t.state === "ASSIGNED" && <button type="button" disabled={busy} onClick={() => run(() => acceptTaskAction(t.taskId))} className={PRIMARY}>Accept</button>}
        <button type="button" onClick={() => setMode("update")} className={QUIET}>Update</button>
        <button type="button" onClick={() => setMode("blocker")} className={QUIET}>Flag blocker</button>
        {t.needsVerification && t.state !== "READY_FOR_VERIFICATION" && <button type="button" disabled={busy} onClick={() => run(() => submitForVerificationAction(t.taskId))} className={QUIET}>Submit for verification</button>}
        {!t.needsVerification && <button type="button" onClick={() => setMode("complete")} className={QUIET}>Complete</button>}
        <button type="button" onClick={() => setMode("escalate")} className={QUIET}>Escalate</button>
      </div>
      {mode && (
        <div className="space-y-2">
          <label className={LABEL} htmlFor={`tw-${t.taskId}`}>{mode === "update" ? "Your update" : mode === "blocker" ? "What is blocking it" : mode === "complete" ? "Evidence it is done (optional)" : "Why it needs Jordan"}</label>
          <textarea id={`tw-${t.taskId}`} rows={2} value={words} onChange={(e) => setWords(e.target.value)} className={INPUT} />
          <button type="button" disabled={busy || (mode !== "complete" && words.trim().length < 3)} onClick={go} className={PRIMARY}>Save</button>
        </div>
      )}
      <Said msg={msg} />
    </div>
  );
}

/**
 * A task of his that nobody delegated (Oct 27 2026): an engine's brand
 * update to confirm, a program's mid-month check, a tag. Accept, Done, hand
 * it to Kyle, escalate it to Jordan, or delegate it to someone on the team,
 * each with the reason on the task.
 */
function PlainTaskControls({ t, people, ownerKey }: { t: AssignedRow; people: { key: string; name: string }[]; ownerKey: string | null }) {
  const { busy, msg, run } = useRun();
  const [to, setTo] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const kyle = people.find((p) => p.key === "kyle") ?? null;
  const others = people.filter((p) => p.key !== ownerKey && p.key !== "kyle");
  const target = to ? people.find((p) => p.key === to) ?? null : null;
  return (
    <div className="space-y-2" data-control="my-task">
      <div className="flex flex-wrap gap-2">
        {(t.state === "OPEN" || t.state === "WAITING") && <button type="button" disabled={busy} onClick={() => run(() => myTaskStepAction(t.taskId, "start"))} className={PRIMARY}>Accept</button>}
        {!t.closesItself && <button type="button" disabled={busy} onClick={() => run(() => myTaskStepAction(t.taskId, "done"))} className={QUIET}>Done</button>}
        {kyle && <button type="button" onClick={() => setTo(kyle.key)} className={QUIET}>Hand to Kyle</button>}
        {ownerKey && <button type="button" onClick={() => setTo(ownerKey)} className={QUIET}>Escalate to Jordan</button>}
      </div>
      {t.closesItself && <p className="text-[12px] text-muted">This closes by itself when every editor on the client taps Got it on the brief (or the office records an override there).</p>}
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className={LABEL} htmlFor={`dg-${t.taskId}`}>Delegate to</label>
          <select id={`dg-${t.taskId}`} value={to && to !== ownerKey && to !== "kyle" ? to : ""} onChange={(e) => setTo(e.target.value || null)} className={cn(INPUT, "w-auto min-h-11")}>
            <option value="">Pick someone</option>
            {others.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </div>
      )}
      {target && (
        <div className="space-y-2">
          <label className={LABEL} htmlFor={`hw-${t.taskId}`}>{to === ownerKey ? "What Jordan needs to decide" : `What ${target.name.split(" ")[0]} needs to do`}</label>
          <textarea id={`hw-${t.taskId}`} rows={2} value={words} onChange={(e) => setWords(e.target.value)} className={INPUT} />
          <button type="button" disabled={busy || words.trim().length < 3} onClick={() => run(() => handMyTaskAction(t.taskId, target.key, words))} className={PRIMARY}>
            {to === ownerKey ? "Escalate to Jordan" : `Hand to ${target.name.split(" ")[0]}`}
          </button>
        </div>
      )}
      <Said msg={msg} />
    </div>
  );
}

/**
 * The Action cell of a row on Assigned to Me (Oct 27 2026): the one step
 * that moves it, in place (Accept, Done, Update), and More for the rest
 * (delegate, escalate to Jordan, flag a blocker) in the side panel.
 */
export function AssignedAction({ r, href, onOpen, readOnly }: { r: AssignedRow; href: (h: string) => string; onOpen: () => void; readOnly: boolean }) {
  const { busy, msg, run } = useRun();
  const W = "w-full md:w-36";
  let main: React.ReactNode;
  if (readOnly) main = <button type="button" data-open-panel={`task:${r.taskId}`} onClick={onOpen} className={cn(QUIET, W)}>Open</button>;
  else if (r.delegated) {
    main = r.state === "ASSIGNED"
      ? <button type="button" data-step="accept" disabled={busy} onClick={() => run(() => acceptTaskAction(r.taskId))} className={cn(PRIMARY, W)}>Accept</button>
      : <button type="button" data-open-panel={`task:${r.taskId}`} onClick={onOpen} className={cn(QUIET, W)}>Update</button>;
  } else if (r.state === "OPEN" || r.state === "WAITING") {
    main = <button type="button" data-step="accept" disabled={busy} onClick={() => run(() => myTaskStepAction(r.taskId, "start"))} className={cn(PRIMARY, W)}>Accept</button>;
  } else if (r.closesItself) {
    main = <Link href={href(r.href)} className={cn(QUIET, W)}>Check the brief</Link>;
  } else {
    main = <button type="button" data-step="done" disabled={busy} onClick={() => run(() => myTaskStepAction(r.taskId, "done"))} className={cn(QUIET, W)}>Done</button>;
  }
  return (
    <div className="flex flex-col items-stretch gap-0.5 md:items-start">
      {main}
      {!readOnly && <button type="button" data-open-panel={`task:${r.taskId}`} onClick={onOpen} className="inline-flex min-h-8 items-center text-[12px] font-medium text-muted hover:text-brand">More: delegate, escalate</button>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-[12px]", msg.ok ? "text-success" : "text-danger")}>{msg.message}</p>}
    </div>
  );
}

// ---- the end-of-day check --------------------------------------------------------------------

export function CloseoutTick({ line, dayKey, readOnly }: { line: CloseoutLine; dayKey: string; readOnly: boolean }) {
  const { busy, msg, run } = useRun();
  const auto = line.auto === true;
  return (
    <div className="space-y-0.5">
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          data-tick={line.key}
          className="size-5 accent-[var(--color-brand)]"
          checked={line.done}
          disabled={readOnly || busy || auto}
          onChange={(e) => run(() => creativeCloseoutTickAction(dayKey, line.key as CreativeCloseoutKey, e.target.checked))}
        />
        {line.label}
      </label>
      <p className={cn("pl-7 text-[12px]", line.done ? "text-success" : "text-muted")}>{line.words}{line.tick && !auto ? ` · ticked ${etDateTime(line.tick.atISO)}` : ""}</p>
      {msg && !msg.ok && <p role="alert" className="pl-7 text-[12px] text-danger">{msg.message}</p>}
    </div>
  );
}

/**
 * "Close out" on a handoff row (Oct 26 2026, lib/handoffCloseOut): takes it off
 * his list with a reason and leaves a note on the job. It comes back if
 * anything on the row changes ("I followed up" brings it back in two days).
 */
export function HandoffCloseOut({ row, readOnly }: { row: { projectId: string; sig: string; street: string; photographer: string; mine: boolean }; readOnly: boolean }) {
  const { busy, msg, run } = useRun();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<HandoffCloseReason | null>(null);
  const [note, setNote] = useState("");
  if (readOnly) return null;
  const first = row.photographer.trim().split(/\s+/)[0] || "the photographer";
  // His own shoot: there is nobody to follow up with.
  const reasons = HANDOFF_CLOSE_REASONS.filter((r) => !(row.mine && r.key === "followed_up"));
  if (!open) {
    return (
      <button type="button" data-close-out={row.projectId} onClick={() => setOpen(true)} className="inline-flex min-h-8 items-center text-[12px] font-medium text-muted hover:text-brand">
        Close out
      </button>
    );
  }
  return (
    <form
      data-close-out-form={row.projectId}
      className="mt-2 w-full basis-full space-y-2 rounded-xl border border-border p-3"
      onSubmit={(e) => { e.preventDefault(); if (reason) run(() => closeOutHandoffAction(row.projectId, row.sig, reason, note)); }}
    >
      <fieldset className="space-y-0.5">
        <legend className={LABEL}>Why is {row.street} closed out?</legend>
        {reasons.map((r) => (
          <label key={r.key} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="radio" name={`close-out-${row.projectId}`} value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} className="size-4 accent-[var(--color-brand)]" />
            {r.key === "followed_up" ? `I followed up with ${first} (back in 2 days if nothing changes)` : r.label}
          </label>
        ))}
      </fieldset>
      <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Note for the job (optional)" aria-label="Note for the job (optional)" />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={PRIMARY} disabled={busy || !reason}>{busy && <Loader2 aria-hidden className="size-4 animate-spin" />}Close out</button>
        <button type="button" className={QUIET} onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
      <Said msg={msg} />
    </form>
  );
}
