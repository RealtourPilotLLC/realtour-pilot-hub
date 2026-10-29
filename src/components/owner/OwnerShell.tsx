"use client";

import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime, etDayKey } from "@/lib/datetime";
import {
  assignTaskAction, cancelTaskAction, completeTaskAction, reassignTaskAction, requestUpdateAction, returnForChangesAction, updateTaskAction,
} from "@/app/delegation/actions";
import { markCommsHandled, setSmartTaskStatus } from "@/app/actions";
import { draftEmailThreadReply } from "@/app/emailActions";
import { EmailReplyBox } from "@/components/comms/EmailReplyBox";
import { closeIssueSignalAction } from "@/app/clients/clientCareActions";
import { makeOwnerTopicMyTask, setOwnerTopicState } from "@/app/ownerTopicActions";
import { ROUND_CAUSES } from "@/lib/issueSignalsCore";
import { ComplaintPlan } from "@/components/clientCare/ComplaintPlan";
import type { AssignSeed, ClientIssueRow } from "@/lib/ownerDashboard";
import type { PanelSpec, RosterOption, ShellAction } from "@/components/owner/panelTypes";

// ---------------------------------------------------------------------------
// The side panel for Jordan's dashboard (Oct 23 2026): detail, assignment and
// reply, without leaving the page. Every section opens one through
// <PanelButton>; every button inside calls an EXISTING server action (the
// delegation actions, Messages' Handled tick, the task status) and refreshes
// the page in place. In the owner's read-only "view as" nothing here acts.
// ---------------------------------------------------------------------------

export const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
export const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
export const QUIET = `${BTN} border border-brand/50 font-medium text-brand hover:bg-brand/10`;
const FIELD = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm";

type Ctx = { open: (p: PanelSpec) => void; roster: RosterOption[]; readOnly: boolean };
const PanelCtx = createContext<Ctx>({ open: () => {}, roster: [], readOnly: true });

export function OwnerShell({ roster, readOnly, initial = null, children }: { roster: RosterOption[]; readOnly: boolean; initial?: PanelSpec | null; children?: ReactNode }) {
  const [panel, setPanel] = useState<PanelSpec | null>(initial);
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);
  return (
    <PanelCtx.Provider value={{ open: setPanel, roster, readOnly }}>
      <div data-owner-dashboard data-readonly={readOnly ? "true" : "false"}>{children}</div>
      {panel && <SidePanel spec={panel} onClose={() => setPanel(null)} />}
    </PanelCtx.Provider>
  );
}

/** A button that opens a side panel. */
export function PanelButton({ spec, children, className, label }: { spec: PanelSpec; children: ReactNode; className?: string; label?: string }) {
  const { open } = useContext(PanelCtx);
  return (
    <button type="button" aria-label={label} data-open-panel={spec.kind} onClick={() => open(spec)} className={className ?? QUIET}>
      {children}
    </button>
  );
}

/**
 * A row's own button (Oct 27 2026, Jordan: "make sure everything has an
 * action that can resolve it, escalate it, respond, or delegate"). A link
 * goes where it is done (#anchor); Assign opens the panel; the one-press
 * kinds call an EXISTING action and say what happened in place:
 *   ask    assignTaskAction with the row's seed (keyed to the record, so a
 *          second press reads "Already with James", nothing new sent);
 *   nudge  requestUpdateAction (at most hourly, the delegation rule);
 *   done   setSmartTaskStatus COMPLETED on the row's own task.
 * Every one of them needs the press: nothing here runs on render.
 */
export function RowActionButton({ a, primary = false, className }: { a: ShellAction; primary?: boolean; className?: string }) {
  const { open, readOnly } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const cls = cn(primary ? PRIMARY : QUIET, className);
  if (a.kind === "link") return <Link href={a.href} className={cls} data-row-action="link">{a.label}</Link>;
  if (a.kind === "assign") {
    return <button type="button" data-open-panel="assign" data-row-action="assign" onClick={() => open({ kind: "assign", seed: a.seed, heading: a.label })} className={cls}>{a.label}</button>;
  }
  if (msg?.ok) return <span role="status" className="inline-flex min-h-11 items-center text-[12px] font-medium text-success" data-row-done>{msg.message}</span>;
  const press = () => run(() =>
    a.kind === "ask"
      ? assignTaskAction({
          title: a.seed.title, outcome: a.seed.outcome ?? undefined, assigneeKey: a.seed.assigneeKey ?? "", dueAt: a.seed.dueAt ?? undefined, needsVerification: !!a.seed.needsVerification,
          sourceTaskId: a.seed.sourceTaskId ?? undefined, sourceHref: a.seed.sourceHref ?? undefined, clientId: a.seed.clientId ?? undefined, projectId: a.seed.projectId ?? undefined,
        })
      : a.kind === "nudge" ? requestUpdateAction(a.taskId) : setSmartTaskStatus(a.taskId, "COMPLETED"));
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" disabled={busy || readOnly} onClick={press} className={cls} data-row-action={a.kind}>{busy && <Loader2 aria-hidden className="size-4 animate-spin" />}{a.label}</button>
      {msg && <Said msg={msg} />}
    </span>
  );
}

const titleOf = (s: PanelSpec): string =>
  s.kind === "assign" ? s.heading ?? "Assign a task"
    : s.kind === "task" ? s.task.title
      : s.kind === "list" ? s.title
        : s.kind === "email" ? `${s.row.sender}: ${s.row.subject}`
          : s.kind === "issue" ? `${s.row.client ?? "A client"}: ${s.row.title}`
            : s.kind === "meeting" ? `${s.row.type} with ${s.row.who}`
              : s.kind === "topic" ? s.topic.title
                : s.title;

function SidePanel({ spec, onClose }: { spec: PanelSpec; onClose: () => void }) {
  const { readOnly } = useContext(PanelCtx);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-side-panel={spec.kind}>
      <button type="button" aria-label="Close the panel" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <aside role="dialog" aria-modal="true" aria-labelledby="owner-panel-title" className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-surface shadow-xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <h2 id="owner-panel-title" className="min-w-0 flex-1 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{titleOf(spec)}</h2>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {readOnly && spec.kind !== "list" && spec.kind !== "info" && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Preview: read-only. Actions are off.</p>}
          {spec.kind === "assign" && <AssignForm seed={spec.seed} />}
          {spec.kind === "task" && <TaskBody spec={spec} />}
          {spec.kind === "list" && <ListBody spec={spec} />}
          {spec.kind === "email" && <EmailBody spec={spec} />}
          {spec.kind === "issue" && <IssueBody spec={spec} />}
          {spec.kind === "meeting" && <MeetingBody spec={spec} />}
          {spec.kind === "topic" && <TopicBody spec={spec} />}
          {spec.kind === "info" && (
            <dl className="space-y-3 text-sm">
              {spec.lines.map((l) => (
                <div key={l.label}><dt className="font-semibold">{l.label}</dt><dd className="mt-0.5 text-muted">{l.value}</dd></div>
              ))}
            </dl>
          )}
        </div>
      </aside>
    </div>
  );
}

function Lines({ rows }: { rows: [string, string | null | undefined][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows.filter(([, v]) => !!v).map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>
      ))}
    </dl>
  );
}

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message?: string } | undefined | void>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through. Nothing was changed; try again." }));
      const out = r && typeof r === "object" ? { ok: !!r.ok, message: r.message ?? (r.ok ? "Done." : "That didn't go through.") } : { ok: true, message: "Done." };
      setMsg(out);
      if (out.ok) router.refresh();
    });
  return { busy, msg, run };
}

function Said({ msg }: { msg: { ok: boolean; message: string } | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "font-medium text-success" : "text-danger")}>{msg.message}</p>;
}

// ---- assign ------------------------------------------------------------------------------

const dayOf = (iso: string | null | undefined) => (iso ? etDayKey(new Date(iso)) : "");

export function AssignForm({ seed }: { seed: AssignSeed }) {
  const { roster, readOnly } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const [title, setTitle] = useState(seed.title);
  const [outcome, setOutcome] = useState(seed.outcome ?? "");
  const [who, setWho] = useState(seed.assigneeKey && roster.some((r) => r.key === seed.assigneeKey) ? seed.assigneeKey : "");
  const [due, setDue] = useState(dayOf(seed.dueAt));
  const [verify, setVerify] = useState(!!seed.needsVerification);
  const [note, setNote] = useState("");
  if (msg?.ok) return <div className="space-y-3"><Said msg={msg} /><p className="text-sm text-muted">It shows under Delegated by me with its acceptance status.</p></div>;
  return (
    <form
      className="space-y-3"
      data-assign-form
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly || busy) return;
        run(() => assignTaskAction({
          title, outcome: outcome || undefined, assigneeKey: who, dueAt: due || undefined, needsVerification: verify, note: note || undefined,
          sourceTaskId: seed.sourceTaskId ?? undefined, sourceHref: seed.sourceHref ?? undefined, clientId: seed.clientId ?? undefined, projectId: seed.projectId ?? undefined,
        }));
      }}
    >
      {seed.sourceTaskId || seed.sourceHref ? <p className="text-sm text-muted">Linked to its record, so it stays one task: assigning it again moves it, it never copies it.</p> : null}
      <label className="block text-sm font-medium">Task<input required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} className={cn(FIELD, "mt-1")} /></label>
      <label className="block text-sm font-medium">Expected outcome<textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} rows={2} maxLength={600} className={cn(FIELD, "mt-1")} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">Assign to
          <select required value={who} onChange={(e) => setWho(e.target.value)} className={cn(FIELD, "mt-1 min-h-11")}>
            <option value="">Choose a person</option>
            {roster.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">Due (5 PM ET)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={cn(FIELD, "mt-1 min-h-11")} /></label>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} className="size-4" /> I verify it before it counts as done</label>
      <label className="block text-sm font-medium">Note for them (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={600} className={cn(FIELD, "mt-1")} /></label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || readOnly || !who || !title.trim()} className={PRIMARY}>{busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Assign</button>
        <Said msg={msg} />
      </div>
    </form>
  );
}

// ---- a delegated task -------------------------------------------------------------------

function TaskBody({ spec }: { spec: Extract<PanelSpec, { kind: "task" }> }) {
  const t = spec.task;
  const { roster, readOnly } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const open = t.state !== "COMPLETED" && t.state !== "CANCELLED";
  const recommendedKey = t.recommendedTo ? roster.find((r) => r.name === t.recommendedTo)?.key ?? null : null;
  return (
    <div className="space-y-4" data-task-panel={t.taskId}>
      {t.resurface && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">{t.resurface.words}</p>}
      <Lines rows={[
        ["Status", stateWords(t.state)],
        ["Assigned to", t.assigneeName ?? "Nobody"],
        ["Assigned by", t.assignedBy ? `${t.assignedBy}${t.assignedAt ? `, ${etDateTime(t.assignedAt)}` : ""}` : null],
        ["Due", t.dueAt ? etDateTime(t.dueAt) : "No due time"],
        ["Outcome", t.outcome],
        ["Latest update", t.latestUpdate],
        ["Blocker", t.blocker],
        ["Next step", t.nextStep],
        ["Verification", t.needsVerification ? "Needed before it counts as done" : null],
        ["Evidence", t.evidence],
      ]} />
      {t.sourceHref && <Link href={t.sourceHref} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">Open the record <ExternalLink aria-hidden className="size-3.5" /></Link>}
      {open && !readOnly && (
        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-2">
            {recommendedKey && <button type="button" disabled={busy} onClick={() => run(() => reassignTaskAction(t.taskId, recommendedKey))} className={PRIMARY}>Assign to {t.recommendedTo}</button>}
            {t.state === "READY_FOR_VERIFICATION" && <button type="button" disabled={busy} onClick={() => run(() => completeTaskAction(t.taskId, text || undefined))} className={PRIMARY}>Verify and complete</button>}
            {t.state === "READY_FOR_VERIFICATION" && <button type="button" disabled={busy || !text.trim()} onClick={() => run(() => returnForChangesAction(t.taskId, text))} className={QUIET}>Send back</button>}
            <button type="button" disabled={busy} onClick={() => run(() => requestUpdateAction(t.taskId, text || undefined))} className={t.state === "READY_FOR_VERIFICATION" || recommendedKey ? QUIET : PRIMARY}>Request update</button>
            <button type="button" disabled={busy || !text.trim()} onClick={() => run(() => updateTaskAction(t.taskId, text))} className={QUIET}>Add a note</button>
            {t.state !== "READY_FOR_VERIFICATION" && <button type="button" disabled={busy} onClick={() => run(() => completeTaskAction(t.taskId, text || undefined))} className={QUIET}>{t.needsVerification ? "Verify and complete" : "Mark complete"}</button>}
            <button type="button" disabled={busy || !text.trim()} onClick={() => run(() => cancelTaskAction(t.taskId, text))} className={QUIET}>Cancel it</button>
          </div>
          <label className="block text-sm font-medium">Note, reason or evidence<textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={600} className={cn(FIELD, "mt-1")} placeholder="Sent with Request update, a note, Send back or Cancel" /></label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-40 flex-1 text-sm font-medium">Reassign to
              <select value={to} onChange={(e) => setTo(e.target.value)} className={cn(FIELD, "mt-1 min-h-11")}>
                <option value="">Choose a person</option>
                {roster.filter((r) => r.key !== t.assigneeKey).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || !to} onClick={() => run(() => reassignTaskAction(t.taskId, to))} className={QUIET}>Reassign</button>
          </div>
          <Said msg={msg} />
        </div>
      )}
      {t.events.length > 0 && (
        <div className="border-t border-border pt-3">
          <h3 className="text-sm font-semibold">History</h3>
          <ol className="mt-2 space-y-1.5 text-sm" data-task-history>
            {[...t.events].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-2"><span className="tabular-nums text-muted">{etDateTime(e.at)}</span><span><b className="font-medium">{e.by}</b> {eventWords(e)}</span></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const stateWords = (s: string) => ({ ASSIGNED: "Awaiting acceptance", ACCEPTED: "Accepted", IN_PROGRESS: "In progress", BLOCKED: "Blocked", READY_FOR_VERIFICATION: "Ready for verification", COMPLETED: "Completed", CANCELLED: "Cancelled" })[s] ?? s;

function eventWords(e: { kind: string; text?: string | null; from?: string | null; to?: string | null }): string {
  const t = e.text ? `: ${e.text}` : "";
  switch (e.kind) {
    case "assigned": return `assigned it to ${e.to ?? "someone"}${t}`;
    case "recommended": return `recommended ${e.to ?? "someone"}${t}`;
    case "reassigned": return `moved it from ${e.from ?? "nobody"} to ${e.to ?? "someone"}`;
    case "accepted": return "accepted it";
    case "started": return "started it";
    case "update": return `updated${t}`;
    case "blocked": return `flagged a blocker${t}`;
    case "unblocked": return "cleared the blocker";
    case "submitted": return `submitted it for verification${t}`;
    case "returned": return `sent it back${t}`;
    case "completed": return `completed it${t}`;
    case "escalated": return `escalated it${t}`;
    case "cancelled": return `cancelled it${t}`;
    case "reopened": return `reopened it${t}`;
    case "update_requested": return `asked for an update${t}`;
    default: return `${e.kind}${t}`;
  }
}

// ---- a bottleneck topic -------------------------------------------------------------------

/**
 * ONE TOPIC, OPENED (Jordan's Loom, Oct 27 2026: "I can click on it to view
 * it"). What it is and how it was counted, the records behind the count with
 * their own buttons, then his moves: Review (the page where the work is
 * done), Delegate (the Assign form, keyed to the topic, so a second press
 * moves the same task; Kyle or James, with a note), Make it my task (his
 * own list), Mark handled (back only when something new turns up) and
 * Snooze 7 days.
 */
function TopicBody({ spec }: { spec: Extract<PanelSpec, { kind: "topic" }> }) {
  const t = spec.topic;
  const { open, readOnly } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const lines = spec.rows.map((r) => [r.title, r.sub].filter(Boolean).join(" · "));
  return (
    <div className="space-y-4" data-topic-panel={t.key}>
      <p className="text-sm font-medium" data-topic-summary>{t.summary}</p>
      <Lines rows={[["Counted", t.window === "Now" ? "Open right now" : t.window], ["Owner", t.owner], ["Delegated", t.handledBy?.words]]} />
      {t.note && <p className="text-[12px] text-muted" data-topic-note={t.source}>{t.note}</p>}
      <ListBody spec={{ kind: "list", title: t.title, rows: spec.rows, empty: "Nothing behind this topic any more." }} />
      {msg?.ok ? <Said msg={msg} /> : (
        <div className="flex flex-wrap gap-2" data-topic-actions>
          {t.review && <Link href={t.review.href} className={QUIET} data-topic-review>{t.review.label}</Link>}
          {t.handledBy && <RowActionButton a={{ kind: "nudge", label: "Request update", taskId: t.handledBy.taskId }} />}
          {!readOnly && <button type="button" data-topic-delegate onClick={() => open({ kind: "assign", seed: t.delegate, heading: t.handledBy ? "Reassign the topic" : "Delegate the topic" })} className={t.handledBy ? QUIET : PRIMARY}>{t.handledBy ? "Reassign" : "Delegate"}</button>}
          {!readOnly && <button type="button" data-topic-mine disabled={busy} onClick={() => run(() => makeOwnerTopicMyTask({ key: t.key, title: t.title, summary: t.summary, ids: t.ids, lines }))} className={QUIET}>Make it my task</button>}
          {!readOnly && <button type="button" data-topic-handled disabled={busy} onClick={() => run(() => setOwnerTopicState({ key: t.key, state: "handled", ids: t.ids }))} className={QUIET}>{busy && <Loader2 aria-hidden className="size-4 animate-spin" />}Mark handled</button>}
          {!readOnly && <button type="button" data-topic-snooze disabled={busy} onClick={() => run(() => setOwnerTopicState({ key: t.key, state: "snoozed", ids: t.ids }))} className={QUIET}>Snooze 7 days</button>}
        </div>
      )}
      {msg && !msg.ok && <Said msg={msg} />}
    </div>
  );
}

// ---- lists, email, issues, meetings -------------------------------------------------------

function ListBody({ spec }: { spec: Extract<PanelSpec, { kind: "list" }> }) {
  const { open, readOnly } = useContext(PanelCtx);
  if (!spec.rows.length) return <p className="text-sm text-muted">{spec.empty ?? "Nothing here."}</p>;
  return (
    <div className="space-y-2">
      {spec.subtitle && <p className="text-sm text-muted">{spec.subtitle}</p>}
      <ul className="divide-y divide-border rounded-xl border border-border" data-panel-list={spec.rows.length}>
        {spec.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <span className={cn("size-2 shrink-0 rounded-full", r.tone === "bad" ? "bg-danger" : r.tone === "warn" ? "bg-warning" : "bg-success")} aria-hidden />
            {/* Phone layout (Jordan, Oct 28 2026): the button wraps under the words instead of squeezing them. */}
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm font-medium [overflow-wrap:anywhere]">
                {r.open ? <button type="button" onClick={() => open(r.open!)} className="text-left hover:underline">{r.title}</button> : r.href ? <Link href={r.href} className="hover:underline">{r.title}</Link> : r.title}
              </p>
              {r.sub && <p className="text-[13px] text-muted">{r.sub}</p>}
            </div>
            {/* EVERY ROW HAS A BUTTON (Jordan, Oct 28 2026: "make sure every task
                and assignment has an actionable button"). The row's own action,
                else Assign, else Open: its panel (the task, the email) or its exact
                page. Only a plain fact (time off) has none. */}
            {r.action ? <RowActionButton a={r.action} className="ml-auto" />
              : r.assign && !readOnly ? <button type="button" onClick={() => open({ kind: "assign", seed: r.assign! })} className={cn(QUIET, "ml-auto")}>Assign</button>
                : r.open ? <button type="button" onClick={() => open(r.open!)} className={cn(QUIET, "ml-auto")} data-row-open>{r.openLabel ?? "Open"}</button>
                  : r.href ? <Link href={r.href} className={cn(QUIET, "ml-auto")} data-row-open>{r.openLabel ?? "Open"}</Link> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * REPLY RIGHT HERE (Jordan's Loom, Oct 27 2026, 4:14: "I should be able to
 * reply to the email from here ... I should see his last email, response, and
 * draft a reply, and send it from here, or open it up so I can see the rest of
 * the thread, and I can either delegate it to Kyle, or ... a button that says
 * mark as handled"). Their last email and our last reply, then the hub's own
 * email reply box (Messages' box: the AI draft is only the starting text, and
 * nothing sends until he presses Send), the whole thread under "Open thread",
 * Delegate to Kyle, and Mark as handled. A reply sent from Gmail is picked up
 * by the Sent-folder read and the email leaves the list on its own.
 */
function EmailBody({ spec }: { spec: Extract<PanelSpec, { kind: "email" }> }) {
  const r = spec.row;
  const { open, readOnly, roster } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const office = r.assign.assigneeKey ? roster.find((p) => p.key === r.assign.assigneeKey)?.name ?? null : null;
  const where = r.delegated ? `${r.delegated.assignee} has it · ${r.delegated.state.toLowerCase()}` : { reply: "You need to reply", decide: "You need to decide (open complaint)", team: "Also in the office inbox", waiting: "Waiting on someone else" }[r.cls];
  return (
    <div className="space-y-4" data-email-panel={r.key}>
      <p className="text-sm"><b className="font-semibold">{where}</b> · waiting since {etDateTime(r.waitingSinceISO)}{r.businessHours != null ? ` (${r.businessHours} business hours)` : ""}</p>
      {r.lastFromThem && (
        <section aria-label="Their last email" data-email-last="them">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{r.sender} · {etDateTime(r.lastFromThem.atISO)}</h3>
          <p className="mt-1 whitespace-pre-line rounded-lg bg-surface-2 px-3 py-2 text-sm [overflow-wrap:anywhere]">{r.lastFromThem.text || r.summary}</p>
        </section>
      )}
      <section aria-label="Our last reply" data-email-last="us">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Our last reply{r.lastFromUs ? ` · ${etDateTime(r.lastFromUs.atISO)}` : ""}</h3>
        {r.lastFromUs
          ? <p className="mt-1 line-clamp-6 whitespace-pre-line rounded-lg border border-border px-3 py-2 text-sm text-muted [overflow-wrap:anywhere]">{r.lastFromUs.text}</p>
          : <p className="mt-1 text-sm text-muted">No reply from us in this thread yet.</p>}
      </section>
      {!readOnly && !r.delegated && (
        r.commLogId
          ? <div data-control="email-reply"><EmailReplyBox target={{ kind: "log", commLogId: r.commLogId }} draft={() => draftEmailThreadReply({ kind: "log", commLogId: r.commLogId! })} startOpen /></div>
          : <p className="text-sm text-muted" data-email-messages-only>This email can only be answered in Messages.</p>
      )}
      {r.thread.length > 0 && (
        <details className="rounded-lg border border-border" data-email-thread={r.thread.length}>
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Open thread ({r.thread.length})</summary>
          <ol className="space-y-2 border-t border-border px-3 py-2">
            {r.thread.map((m, i) => (
              <li key={`${m.atISO}-${i}`} className="text-sm">
                <p className="text-[12px] text-muted">{m.role === "us" ? "Us" : r.sender}{m.atISO ? ` · ${etDateTime(m.atISO)}` : ""}</p>
                <p className="whitespace-pre-line [overflow-wrap:anywhere]">{m.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {!readOnly && !r.delegated && <button type="button" onClick={() => open({ kind: "assign", seed: r.assign, heading: office ? `Delegate to ${office}` : "Delegate this email" })} className={QUIET} data-email-delegate>{office ? `Delegate to ${office}` : "Delegate"}</button>}
        {!readOnly && (
          <button type="button" disabled={busy} onClick={() => run(() => markCommsHandled(r.clientId, "email", r.clientId ? r.groupKey : undefined, r.clientId ? {} : { threadKey: r.threadKey }))} className={QUIET} data-email-handled>
            Mark as handled
          </button>
        )}
        <Link href={r.replyHref} className={QUIET}>Open in Messages</Link>
      </div>
      <Said msg={msg} />
      <p className="text-[12px] text-muted">A reply sent from Gmail is picked up on its own. A new email from them puts it back on this list.</p>
    </div>
  );
}

function IssueBody({ spec }: { spec: Extract<PanelSpec, { kind: "issue" }> }) {
  const r = spec.row;
  const { open, readOnly } = useContext(PanelCtx);
  return (
    <div className="space-y-4" data-issue-panel={r.id}>
      {r.suggested && <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Suggested flag for review: the hub's classifier read this as unhappy. It isn't a confirmed complaint.</p>}
      <Lines rows={[
        ["Severity", `${r.severity[0].toUpperCase()}${r.severity.slice(1)}: ${r.severityWhy}`],
        ["Project", r.project],
        ["Evidence", r.evidence],
        ["Why it's here", r.whyHere],
        ["Closed before", r.close?.kind === "rounds" ? r.close.reopenedFrom : null],
        ["Responsible", r.handledBy ? r.handledBy.words : r.owner ?? "Nobody yet"],
        ["Last client update", r.close ? null : r.lastClientUpdateISO ? etDateTime(r.lastClientUpdateISO) : "None on record"],
        ["Next action", `${r.nextAction}${r.deadlineISO ? ` by ${etDateTime(r.deadlineISO)}` : ""}`],
        ["Your decision", r.decision],
      ]} />
      {/* A complaint carries its plan (Oct 29 2026): the same record Kyle and James work from their desks. */}
      {r.kind === "complaint"
        ? <ComplaintPlan issueId={r.id.replace(/^issue:/, "")} readOnly={readOnly} fallbackWords={r.summary} />
        : <blockquote className="rounded-lg bg-surface-2 px-3 py-2 text-sm">{r.summary}</blockquote>}
      {r.records && r.records.length > 0 && (
        <section aria-labelledby={`records-${r.id}`} data-issue-records={r.records.length}>
          <h3 id={`records-${r.id}`} className="text-sm font-semibold">The flags</h3>
          <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
            {r.records.map((f) => (
              <li key={f.id}>
                <Link href={f.href} className="block px-3 py-2 text-sm hover:bg-surface-2">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium">{f.label}</span>
                    <span className="text-[12px] text-muted">{etDateTime(f.atISO)}</span>
                  </span>
                  <span className="mt-0.5 block text-muted [overflow-wrap:anywhere]">{f.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {r.conversationHref && <Link href={r.conversationHref} className={QUIET}>Review conversation</Link>}
        {r.conversationHref && <Link href={r.conversationHref} className={QUIET}>Reply</Link>}
        {!readOnly && (r.kind !== "complaint" || r.handledBy) && <button type="button" onClick={() => open({ kind: "assign", seed: r.assign, heading: r.handledBy ? "Reassign" : r.close ? "Assign it" : "Assign recovery" })} className={r.close || r.handledBy ? QUIET : PRIMARY}>{r.handledBy ? "Reassign" : r.close?.kind === "rounds" ? "Assign the check-in" : r.close ? "Assign it" : "Assign recovery"}</button>}
        <Link href={r.href} className={QUIET}>{r.close ? (r.projectId ? "Open the job" : r.kind === "pattern" && r.clientId ? "Open the client" : "Open the record") : "Record decision or resolve"}</Link>
      </div>
      {r.close && !readOnly && <CloseSignal row={r} />}
      {!r.close && <p className="text-[12px] text-muted">A reply or an apology doesn't resolve it: resolve it with the outcome on the client's page.</p>}
    </div>
  );
}

/** Close a signal (lib/issueSignals): revision rounds with the client's answer and why, the rest with one line. */
function CloseSignal({ row }: { row: ClientIssueRow }) {
  const c = row.close!;
  const { busy, msg, run } = useRun();
  const [mode, setMode] = useState<"HAPPY" | "COMPLAINT" | "DONE" | null>(c.kind === "done" ? "DONE" : null);
  const [cause, setCause] = useState("");
  const [note, setNote] = useState("");
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <section className="space-y-3 rounded-xl border border-border p-3" data-close-signal={row.id} aria-labelledby={`close-${row.id}`}>
      <h3 id={`close-${row.id}`} className="text-sm font-semibold">{c.kind === "rounds" ? "Close it" : "Mark it done"}</h3>
      {c.kind === "rounds" && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="How did it end?">
          <button type="button" aria-pressed={mode === "HAPPY"} onClick={() => setMode("HAPPY")} className={mode === "HAPPY" ? PRIMARY : QUIET} data-close-mode="HAPPY">{c.clientFirst} is happy</button>
          <button type="button" aria-pressed={mode === "COMPLAINT"} onClick={() => setMode("COMPLAINT")} className={mode === "COMPLAINT" ? PRIMARY : QUIET} data-close-mode="COMPLAINT">Still unhappy</button>
        </div>
      )}
      {mode && (
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); run(() => closeIssueSignalAction({ rowId: row.id, outcome: mode, cause: cause || null, note: note || null })); }}
        >
          {c.kind === "rounds" && (
            <label className="block text-sm">
              <span className="font-medium">{c.rounds === 1 ? `Why did it need ${c.retake ? "a retake" : "the fix"}?` : `Why did it take ${c.rounds} rounds?`}{mode === "COMPLAINT" ? " (if you know)" : ""}</span>
              <select required={mode === "HAPPY"} value={cause} onChange={(e) => setCause(e.target.value)} className={cn(FIELD, "mt-1")} data-close-cause>
                <option value="">Pick one</option>
                {ROUND_CAUSES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
          )}
          {mode !== "HAPPY" && (
            <label className="block text-sm">
              <span className="font-medium">{c.kind === "rounds" ? "What's still wrong for them" : c.prompt}</span>
              <textarea required minLength={3} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={cn(FIELD, "mt-1")} data-close-note />
            </label>
          )}
          <button type="submit" disabled={busy} className={PRIMARY}>
            {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
            {mode === "COMPLAINT" ? "Open a complaint" : c.kind === "rounds" ? "Close it" : "Mark done"}
          </button>
        </form>
      )}
      <Said msg={msg} />
      <p className="text-[12px] text-muted">
        {c.kind === "rounds"
          ? `${mode === "COMPLAINT" ? "The complaint takes over with its own owner and check-in. " : ""}${c.settlesAtISO ? `Left alone, it closes on its own ${etDateTime(c.settlesAtISO)} if ${c.clientFirst} asks for nothing more. ` : ""}A new ask from ${c.clientFirst} brings it back.`
          : "It comes back only if something new happens."}
      </p>
    </section>
  );
}

/**
 * THE MEETING BRIEF (Jordan's Loom, Oct 27 2026, 3:22: "Open brief" took him
 * to the content program page). The panel is the brief: who, when and why,
 * the client's context from records (program, last call, the last thing they
 * wrote, the month's topics and open items), what to prepare, and questions
 * to ask. The program page is one link at the bottom.
 */
function MeetingBody({ spec }: { spec: Extract<PanelSpec, { kind: "meeting" }> }) {
  const r = spec.row;
  const b = r.brief;
  const { open, readOnly } = useContext(PanelCtx);
  const { busy, msg, run } = useRun();
  const section = (title: string, items: string[], key: string) => items.length > 0 && (
    <div data-brief={key}><h3 className="text-sm font-semibold">{title}</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{items.map((p) => <li key={p}>{p}</li>)}</ul></div>
  );
  return (
    <div className="space-y-4" data-meeting-panel={r.id}>
      <Lines rows={[["When", `${etDateTime(r.startISO)} ET`], ["Who", r.who], ["Purpose", r.purpose], ["Program", b?.program], ["Last call", b?.lastCall], ["Preparation", r.prep.words]]} />
      {b?.lastFromClient && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm [overflow-wrap:anywhere]" data-brief="last-from-client"><span className="block text-[12px] font-semibold text-muted">The last thing they wrote</span>{b.lastFromClient}</p>}
      {r.missing.length > 0 && <p className="text-sm font-medium text-warning">{r.missing.join(" · ")}</p>}
      {section("Prepare", r.points, "prepare")}
      {section("Open on the month", b?.openItems ?? [], "open-items")}
      {section("The month's topics", b?.topics ?? [], "topics")}
      {section("Questions to ask", b?.questions ?? [], "questions")}
      <div className="flex flex-wrap gap-2">
        {r.joinLink && <a href={r.joinLink} target="_blank" rel="noreferrer" className={PRIMARY}>Join <ExternalLink aria-hidden className="size-3.5" /></a>}
        {!readOnly && r.prep.taskId && !r.prep.delegated && r.assignPrep && <button type="button" disabled={busy} onClick={() => run(() => setSmartTaskStatus(r.prep.taskId!, "COMPLETED"))} className={PRIMARY}>Mark prep done</button>}
        {!readOnly && r.assignPrep && <button type="button" onClick={() => open({ kind: "assign", seed: r.assignPrep!, heading: "Assign preparation" })} className={QUIET}>Assign preparation</button>}
        {!readOnly && <button type="button" onClick={() => open({ kind: "assign", seed: r.followUp, heading: "Create a follow-up" })} className={QUIET}>Create follow-up</button>}
        <Link href="/content/calls" className={QUIET}>Record notes</Link>
        <Link href={r.href} className={QUIET} data-brief-program-link>{r.href.startsWith("/content/") ? "Open the program" : "Open the client"}</Link>
      </div>
      <Said msg={msg} />
    </div>
  );
}
