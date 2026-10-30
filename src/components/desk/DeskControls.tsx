"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CalendarClock, Check, ExternalLink, Loader2, Mail, Plus, RotateCcw, Send, UserRoundPlus, X } from "lucide-react";
import { approveAryeoAction } from "@/app/ops/photo-delivery/actions";
import { sendThreadText } from "@/app/communications/threadActions";
import { createManualTask, dismissTask, draftTaskReply, markCommsHandled, sendConfirmationText } from "@/app/actions";
import { pushOldItem } from "@/app/ops/old/actions";
import { generateReply, sendReply } from "@/app/communications/replyActions";
import { resolveEmailRecipient, sendEmailReply } from "@/app/emailActions";
import { recipientWords } from "@/lib/emailRecipients";
import { postProgramMessageAction } from "@/app/content/[id]/workspaceActions";
import { acceptTaskAction, assignTaskAction, completeTaskAction, escalateTaskAction, flagBlockerAction, submitForVerificationAction, updateTaskAction } from "@/app/delegation/actions";
import { sendPhotographerBriefNow } from "@/app/shoot/brief/actions";
import {
  closeoutTickAction, deskCloseTaskAction, deskFollowUpAction, deskMarkDeliveredAction, deskRevisionDecisionAction, deskWaitAction, draftProgramReplyAction, finishDayAction,
  type DeskResult, type FollowUpInput, type WaitInput,
} from "@/app/deskActions";
import type { CheckKey, DeskAction, RevisionChoice } from "@/lib/officeDesk";
import { etDateTime } from "@/lib/datetime";
import { deskRowHref } from "@/lib/deskHandOff";
import { flashHandled } from "@/components/comms/HandledUndo";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The desk's own small controls (Oct 23 2026). Each calls an EXISTING action
// (Approve and deliver / upload, the Messages text send, the confirmation
// text, Send brief now, Not needed) or one of the desk's own writes (a daily
// check's tick, Waiting on, Create follow-up), then refreshes the page in
// place: the dashboard and its side panel stay where they are, and the counts
// recompute.
// ---------------------------------------------------------------------------

export const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
export const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
export const QUIET = `${BTN} border border-border-strong font-medium hover:bg-surface-2`;

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<DeskResult | null>(null);
  const run = (fn: () => Promise<DeskResult>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  return { busy, msg, run, setMsg };
}

function Said({ msg }: { msg: DeskResult | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? "status" : "alert"} className={cn("w-full text-sm", msg.ok ? "font-medium text-success" : "text-danger")}>{msg.message}</p>;
}

/** Kyle's approval of a photo set (the Photos desk's own action). */
export function PhotoApprove({ jobId }: { jobId: string }) {
  const { busy, msg, run } = useRun();
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="photo-approve">
      <button type="button" disabled={busy} onClick={() => run(() => approveAryeoAction(jobId, { deliver: true }))} className={PRIMARY}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} Approve and deliver
      </button>
      <button type="button" disabled={busy} onClick={() => run(() => approveAryeoAction(jobId, { deliver: false }))} className={QUIET}>
        Approve and upload
      </button>
      <Said msg={msg} />
      {msg && !msg.ok && <Link href={`/ops/photo-delivery/${jobId}`} className="text-sm font-medium text-brand hover:underline">Open the job to decide</Link>}
    </div>
  );
}

/** A text back to the client (or a photographer), through the Messages screen's own send. */
export function ReplyBox({ phone, clientId, label = "Text back" }: { phone: string; clientId: string | null; label?: string }) {
  const { busy, msg, run, setMsg } = useRun();
  const [text, setText] = useState("");
  const send = () => {
    const intentId = (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36)}${Math.random().toString(36)}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    run(async () => {
      const r = await sendThreadText(phone, text, undefined, clientId, intentId);
      if (r.ok) setText("");
      return { ok: r.ok, message: r.ok ? "Sent. It leaves the list once the reply is logged." : r.message };
    });
  };
  return (
    <div className="space-y-2" data-control="reply">
      <label className="block text-sm font-medium" htmlFor="desk-reply">{label}</label>
      <textarea
        id="desk-reply"
        value={text}
        onChange={(e) => { setText(e.target.value); if (msg) setMsg(null); }}
        rows={3}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand"
        placeholder="Write the reply"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !text.trim()} onClick={send} className={PRIMARY}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} Send text
        </button>
        <Said msg={msg} />
      </div>
    </div>
  );
}

/** The client's shoot confirmation: the hub's own template text (through
 *  the outbox, never twice), or "Confirmed another way" (by phone). */
export function ConfirmControls({ taskId }: { taskId: string }) {
  const { busy, msg, run } = useRun();
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="confirm">
      <button type="button" disabled={busy} onClick={() => run(() => sendConfirmationText(taskId))} className={PRIMARY}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} Send the confirmation text
      </button>
      <button type="button" disabled={busy} onClick={() => run(() => dismissTask(taskId, "already done"))} className={QUIET}>
        <Check aria-hidden className="size-4" /> Confirmed another way
      </button>
      <Said msg={msg} />
    </div>
  );
}

/** Create follow-up: a task linked to the client, back at the time picked. */
export function FollowUpCreate({ clientId, projectId, title }: { clientId: string | null; projectId: string | null; title: string }) {
  const { busy, msg, run } = useRun();
  const [text, setText] = useState(title);
  const [when, setWhen] = useState<FollowUpInput["when"]>("tomorrow");
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-control="follow-up">
      <legend className="px-1 text-sm font-semibold">Create a follow-up</legend>
      <input aria-label="What to follow up on" value={text} onChange={(e) => setText(e.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="When to follow up" value={when} onChange={(e) => setWhen(e.target.value as FollowUpInput["when"])} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm">
          <option value="2h">In 2 hours</option>
          <option value="tomorrow">Next business day, 10 AM</option>
          <option value="2days">In 2 business days, 10 AM</option>
        </select>
        <button type="button" disabled={busy || text.trim().length < 3} onClick={() => run(() => deskFollowUpAction({ clientId, projectId, title: text, when }))} className={QUIET}>
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Create follow-up
        </button>
        <Said msg={msg} />
      </div>
    </fieldset>
  );
}

/** Waiting on someone: a named person and a time it comes back. Creative
 *  questions go to the creative manager, business or policy to the owner. */
export function WaitOn({ taskId, creative, owner }: { taskId: string; creative: string; owner: string }) {
  const { busy, msg, run } = useRun();
  const [who, setWho] = useState<WaitInput["who"]>("other");
  const [name, setName] = useState("");
  const [when, setWhen] = useState<WaitInput["when"]>("tomorrow");
  const [note, setNote] = useState("");
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-control="wait">
      <legend className="px-1 text-sm font-semibold">Waiting on someone</legend>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Who it is waiting on" value={who} onChange={(e) => setWho(e.target.value as WaitInput["who"])} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm">
          <option value="other">Someone else (name them)</option>
          <option value="creative">{creative}: a creative question</option>
          <option value="owner">{owner}: a business or policy question</option>
        </select>
        {who === "other" && (
          <input aria-label="Their name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="min-h-11 w-36 rounded-lg border border-border bg-surface px-2 text-sm" />
        )}
        <select aria-label="When to follow up" value={when} onChange={(e) => setWhen(e.target.value as WaitInput["when"])} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm">
          <option value="2h">Follow up in 2 hours</option>
          <option value="tomorrow">Follow up next business day, 10 AM</option>
          <option value="2days">Follow up in 2 business days, 10 AM</option>
        </select>
      </div>
      <input aria-label="What you asked (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you asked (optional)" className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || (who === "other" && name.trim().length < 2)} onClick={() => run(() => deskWaitAction({ taskId, who, name, when, note }))} className={QUIET}>
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Set waiting
        </button>
        <Said msg={msg} />
      </div>
    </fieldset>
  );
}

/** One closeout line's manual tick (a timestamped AppSetting entry). */
export function CloseoutTick({ dayKey, itemKey, checked, disabled, label }: { dayKey: string; itemKey: CheckKey; checked: boolean; disabled: boolean; label: string }) {
  const { busy, msg, run } = useRun();
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled || busy}
        onChange={(e) => { const on = e.target.checked; run(() => closeoutTickAction(dayKey, itemKey, on)); }}
        className="size-5 shrink-0"
      />
      {msg && !msg.ok && <span role="alert" className="text-xs text-danger">{msg.message}</span>}
    </span>
  );
}

/** The photographer brief's own "Send brief now" (the briefing build's action). */
export function BriefSend({ teamMemberId, day, name, resend }: { teamMemberId: string; day: string; name: string; resend: boolean }) {
  const { busy, msg, run } = useRun();
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="brief-send">
      <button type="button" disabled={busy} onClick={() => run(() => sendPhotographerBriefNow(teamMemberId, day))} className={QUIET}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} {resend ? `Resend ${name} the brief` : `Send ${name} the brief`}
      </button>
      <Said msg={msg} />
    </div>
  );
}

export function FinishDay({ dayKey, disabled }: { dayKey: string; disabled: boolean }) {
  const { busy, msg, run } = useRun();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled || busy} onClick={() => run(() => finishDayAction(dayKey))} className={PRIMARY} data-control="finish-day">
        {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Finish the day
      </button>
      <Said msg={msg} />
    </div>
  );
}

const mintIntent = () => (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36)}${Math.random().toString(36)}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

/** EVERY CONVERSATION OPENS WITH A DRAFT (Jordan's huddle with Kyle, Oct 23
 *  2026). The reply engine writes it when the panel opens (texts: the Replies
 *  queue's own drafter; email: the Gmail task's drafter; Content Program: the
 *  same drafter given the program conversation); Kyle sends it as is, or edits
 *  and sends. Each send goes through that channel's own send (one press, one
 *  message: a text carries the press's identity, so a double press never sends
 *  twice). Nothing is sent without a press. */
export function DraftReply({ mode, threadKey, taskId, enrollmentId, initialDraft = null, autoDraft = true }: {
  mode: "text" | "email" | "program";
  threadKey?: string | null;
  taskId?: string | null;
  enrollmentId?: string | null;
  initialDraft?: string | null;
  autoDraft?: boolean;
}) {
  const { busy, msg, run, setMsg } = useRun();
  const [text, setText] = useState(initialDraft ?? "");
  const [drafting, setDrafting] = useState(false);
  const [note, setNote] = useState<string | null>(initialDraft ? "Draft ready. Read it before sending." : null);
  const asked = useRef(false);
  // Oct 29 2026 (Kyle): an email reply goes to everyone on the email (Reply
  // all, never us); the box says who before Send, and the send is pinned to it.
  const [emailTo, setEmailTo] = useState<{ pin: string; words: string } | null>(null);
  useEffect(() => {
    if (mode !== "email" || !taskId) return;
    let alive = true;
    resolveEmailRecipient(taskId)
      .then((r) => { if (alive && r.ok && r.to) setEmailTo({ pin: r.to, words: recipientWords({ to: r.to, alsoTo: r.alsoTo, cc: r.cc }) }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [mode, taskId]);
  const draft = async () => {
    setDrafting(true);
    setNote("Writing a draft…");
    try {
      const r = mode === "text" && threadKey ? await generateReply(threadKey)
        : mode === "email" && taskId ? await draftTaskReply(taskId).then((x) => ({ ok: x.ok, message: x.ok ? "Draft ready. Read it before sending." : x.error ?? "Could not draft a reply.", draft: x.text }))
        : mode === "program" && enrollmentId ? await draftProgramReplyAction(enrollmentId)
        : { ok: false, message: "No draft for this one: write the reply.", draft: undefined };
      if (r.ok && r.draft) setText((cur) => (cur.trim() ? cur : r.draft!));
      setNote(r.message);
    } catch {
      setNote("Could not draft a reply just now: write it, or try again.");
    } finally {
      setDrafting(false);
    }
  };
  useEffect(() => {
    if (!autoDraft || initialDraft || asked.current) return;
    asked.current = true;
    void draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const send = () => run(async () => {
    const body = text.trim();
    if (mode === "text" && threadKey) return sendReply(threadKey, body, mintIntent()).then((r) => ({ ok: r.ok, message: r.ok ? "Sent. It leaves the list once the reply is logged." : r.message }));
    if (mode === "email" && taskId) return sendEmailReply(taskId, body, emailTo ? { expectedTo: emailTo.pin } : undefined).then((r) => ({ ok: r.ok, message: r.message }));
    if (mode === "program" && enrollmentId) return postProgramMessageAction(enrollmentId, body, null);
    return { ok: false, message: "This conversation can only be answered in Messages." };
  });
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="space-y-2" data-control="draft-reply" data-mode={mode}>
      <label className="block text-sm font-medium" htmlFor={`desk-reply-${mode}`}>{mode === "program" ? "Reply on Content Program" : mode === "email" ? "Reply by email" : "Text back"}</label>
      <textarea
        id={`desk-reply-${mode}`}
        value={text}
        onChange={(e) => { setText(e.target.value); if (msg) setMsg(null); }}
        rows={5}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand"
        placeholder={drafting ? "Writing a draft…" : "Write the reply"}
      />
      {mode === "email" && emailTo && <p className="text-[12px] text-muted [overflow-wrap:anywhere]" data-email-to>To {emailTo.words}</p>}
      {note && <p className="text-[12px] text-muted" data-draft-note>{note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || drafting || !text.trim()} onClick={send} className={PRIMARY}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} Send
        </button>
        <button type="button" disabled={busy || drafting} onClick={() => { setText(""); void draft(); }} className={QUIET}>
          <RotateCcw aria-hidden className="size-4" /> New draft
        </button>
        <Said msg={msg} />
      </div>
    </div>
  );
}

/** A task assigned to Kyle through delegation: Accept until he has, then Update,
 *  Flag a blocker, Submit for verification (when it needs one) or Complete, Escalate. */
export function DelegationControls({ taskId, state, needsVerification }: { taskId: string; state: string; needsVerification: boolean }) {
  const { busy, msg, run } = useRun();
  const [note, setNote] = useState("");
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="space-y-2" data-control="delegation">
      {state === "ASSIGNED" && (
        <button type="button" disabled={busy} onClick={() => run(() => acceptTaskAction(taskId))} className={PRIMARY}>
          <Check aria-hidden className="size-4" /> Accept
        </button>
      )}
      <input aria-label="An update, a blocker or a reason" value={note} onChange={(e) => setNote(e.target.value)} placeholder="An update, a blocker or a reason" className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || note.trim().length < 3} onClick={() => run(() => updateTaskAction(taskId, note))} className={QUIET}>Update</button>
        <button type="button" disabled={busy || note.trim().length < 3} onClick={() => run(() => flagBlockerAction(taskId, note))} className={QUIET}>Flag a blocker</button>
        {needsVerification
          ? <button type="button" disabled={busy} onClick={() => run(() => submitForVerificationAction(taskId))} className={QUIET}>Submit for verification</button>
          : <button type="button" disabled={busy} onClick={() => run(() => completeTaskAction(taskId, note || undefined))} className={QUIET}>Complete</button>}
        <button type="button" disabled={busy || note.trim().length < 3} onClick={() => run(() => escalateTaskAction(taskId, note))} className={QUIET}>Escalate</button>
      </div>
      <Said msg={msg} />
    </div>
  );
}

// ---- the quick actions (Oct 27 2026) ------------------------------------------------------------
// Jordan: "Buttons should either handle the action or take the user to where it
// can be handled and scroll to the correct part of the screen or page." Each
// control below does the thing in place (one press, its result said), or links
// to the exact section (#anchor) where it is done. Nothing here sends a
// message to a client or the team without its own press.

const FIELD = "min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm";
const AREA = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand";

/** A floor plan or 3D tour: what is missing and why, its history, and Mark delivered
 *  (records who and when, closes the vendor chase). The vendor's email opens in
 *  Kyle's own mail with the job filled in; nothing is sent from here. */
export function MarkDelivered({ a }: { a: Extract<DeskAction, { kind: "mark-delivered" }> }) {
  const { busy, msg, run } = useRun();
  const [note, setNote] = useState("");
  const what = a.category === "Floor plan" ? "floor plan" : "3D tour";
  const mail = `mailto:?subject=${encodeURIComponent(`${a.category} for ${a.street}`)}&body=${encodeURIComponent(`Hi ${a.maker} team,\n\nCould you send the ${what} for ${a.street}? It is not on the listing yet.\n\nThank you,\nRealtour Pilot`)}`;
  return (
    <div className="space-y-3" data-control="mark-delivered" data-category={a.category}>
      <p className="text-sm" data-why>{a.why}</p>
      {a.history.length > 0 && (
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">History</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted" data-history>{a.history.map((h) => <li key={h}>{h}</li>)}</ul>
        </div>
      )}
      {msg?.ok ? <Said msg={msg} /> : (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="block text-sm font-medium" htmlFor={`md-note-${a.projectId}`}>Note (optional)</label>
          <input id={`md-note-${a.projectId}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Where you saw the ${what}`} className={FIELD} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => deskMarkDeliveredAction({ projectId: a.projectId, category: a.category, note }))} className={PRIMARY} data-mark-delivered>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} Mark {what} delivered
            </button>
            <Said msg={msg} />
          </div>
          <p className="text-[12px] text-muted">Records you and the time, and closes the {a.maker} chase.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <a href={mail} className={QUIET} data-email-vendor><Mail aria-hidden className="size-4" /> Email {a.maker}</a>
        <Link href={`/projects/${a.projectId}#${a.anchor}`} className={QUIET} data-anchor-link={a.anchor}><ArrowUpRight aria-hidden className="size-4" /> Open the job&rsquo;s {what} section</Link>
      </div>
    </div>
  );
}

const CHOICES: { key: RevisionChoice; label: string; hint: string }[] = [
  { key: "editor", label: "Send to the photo editor (AutoHDR fix)", hint: "Then open the photos and send the fix." },
  { key: "self", label: "Fix it myself", hint: "Then make the fix and deliver again." },
  { key: "none", label: "No change needed", hint: "Closes the change request: the photos stay as delivered. Say what was settled with the client." },
  { key: "ask", label: "Ask the client", hint: "Sets a follow-up for the next business day." },
];

/** A client's photo change request: their own words, then Kyle's decision and
 *  his note. "No change needed" is Photo Delivery's own Settled with the client. */
export function RevisionDecide({ a }: { a: Extract<DeskAction, { kind: "revision-decide" }> }) {
  const { busy, msg, run, setMsg } = useRun();
  const [choice, setChoice] = useState<RevisionChoice | null>(a.decided?.choice ?? null);
  const [note, setNote] = useState(a.decided?.note ?? "");
  const [href, setHref] = useState<string | null>(null);
  const min = choice === "none" ? 10 : 3;
  const save = () => {
    if (!choice) return;
    run(async () => {
      const r = await deskRevisionDecisionAction({ jobId: a.jobId, choice, note });
      if (r.ok && r.href) setHref(r.href);
      return r;
    });
  };
  return (
    <div className="space-y-3" data-control="revision-decide">
      <div data-client-words>
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">What the client asked</p>
        {a.asks.length ? (
          <ul className="mt-1 space-y-1.5">
            {a.asks.map((x) => (
              <li key={x.id} className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
                <span className="block text-[11px] text-muted">{etDateTime(x.askedAtISO)}</span>
                &ldquo;{x.text}&rdquo;
              </li>
            ))}
          </ul>
        ) : a.taskNote ? <p className="mt-1 rounded-lg bg-surface-2/60 px-3 py-2 text-sm">{a.taskNote}</p> : <p className="mt-1 text-sm text-muted">The request&rsquo;s own words are not on file. Open the photos to see it.</p>}
      </div>
      {a.decided && !msg && <p className="text-sm text-muted" data-decided={a.decided.choice}>Decided by {a.decided.by.split(" ")[0]}: {CHOICES.find((c) => c.key === a.decided!.choice)?.label}{a.decided.note ? `. ${a.decided.note}` : ""}</p>}
      {msg?.ok ? (
        <div className="space-y-2">
          <Said msg={msg} />
          {href && <Link href={href} className={PRIMARY} data-next-step>Open the photos <ExternalLink aria-hidden className="size-4" /></Link>}
        </div>
      ) : (
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">Decide the fix</legend>
          {CHOICES.map((c) => (
            <label key={c.key} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-surface-2" data-choice={c.key}>
              <input type="radio" name={`rev-${a.jobId}`} checked={choice === c.key} onChange={() => { setChoice(c.key); setMsg(null); }} className="mt-1 size-4" />
              <span><span className="block text-sm font-medium">{c.label}</span><span className="block text-[12px] text-muted">{c.hint}</span></span>
            </label>
          ))}
          <label className="block text-sm font-medium" htmlFor={`rev-note-${a.jobId}`}>Note the fix</label>
          <textarea id={`rev-note-${a.jobId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={AREA} placeholder={choice === "none" ? "What was settled with the client, and why nothing goes out again" : "What will change, or what you will ask"} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !choice || note.trim().length < min} onClick={save} className={PRIMARY}>
              {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Save decision
            </button>
            <Link href={`/ops/photo-delivery/${a.jobId}#pd-holding-h`} className={QUIET}>Open the photos</Link>
            <Said msg={msg} />
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Mark done (with a note), Not needed, or a new date: the task lists' own closes. */
/** `doneLabel` (Oct 27 2026): "Mark handled" on a client request Kyle handles (officeDesk taskPrimary). */
export function TaskResolve({ taskId, nextDay, allowNewDate = true, doneLabel = "Mark done" }: { taskId: string; nextDay: string; allowNewDate?: boolean; doneLabel?: string }) {
  const { busy, msg, run } = useRun();
  const [note, setNote] = useState("");
  const [day, setDay] = useState(nextDay);
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-control="task-resolve">
      <legend className="px-1 text-sm font-semibold">Close it</legend>
      <input aria-label="What was done (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done (optional)" className={FIELD} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => run(() => deskCloseTaskAction({ taskId, how: "done", note }))} className={PRIMARY} data-task-done>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} {doneLabel}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => deskCloseTaskAction({ taskId, how: "not-needed", note }))} className={QUIET}>
          <X aria-hidden className="size-4" /> Not needed
        </button>
      </div>
      {allowNewDate && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <label className="text-sm" htmlFor={`snooze-${taskId}`}>Follow up on</label>
          <input id={`snooze-${taskId}`} type="date" value={day} onChange={(e) => setDay(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm" />
          <button type="button" disabled={busy || !day} onClick={() => run(async () => { const r = await pushOldItem(taskId, day); return { ok: r.ok, message: r.message || "Moved." }; })} className={QUIET} data-snooze>
            <CalendarClock aria-hidden className="size-4" /> New date
          </button>
        </div>
      )}
      <Said msg={msg} />
    </fieldset>
  );
}

/** Delegate (to James, Jordan, an editor, a photographer) or Escalate to Jordan,
 *  through the delegation build (one canonical task; the person is told in
 *  the hub). A row with no task of its own gets one, linked back to it, the
 *  row's id on the link so the desk knows that row went (lib/deskHandOff). */
export function HandOn({ taskId, rowId, title, href, projectId, clientId, delegates, ownerKey, ownerName, context = null }: {
  taskId: string | null; rowId?: string | null; title: string; href: string | null; projectId: string | null; clientId: string | null;
  delegates: { key: string; name: string }[]; ownerKey: string | null; ownerName: string;
  /** the row's own words, carried onto the task as its notes */
  context?: string | null;
}) {
  const { busy, msg, run } = useRun();
  const [who, setWho] = useState(delegates[0]?.key ?? "");
  const [note, setNote] = useState("");
  if (msg?.ok) return <Said msg={msg} />;
  const send = (to: string) => run(() => assignTaskAction({ title, assigneeKey: to, sourceTaskId: taskId ?? undefined, sourceHref: taskId || !href ? undefined : rowId ? deskRowHref(href, rowId) : href, projectId: projectId ?? undefined, clientId: clientId ?? undefined, note: note || undefined, outcome: note || undefined, context: context || undefined }));
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-control="hand-on">
      <legend className="px-1 text-sm font-semibold">Hand it on</legend>
      <input aria-label="What they need to know" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What they need to know" className={FIELD} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Who to delegate to" value={who} onChange={(e) => setWho(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm">
          {delegates.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
        </select>
        <button type="button" disabled={busy || !who} onClick={() => send(who)} className={QUIET} data-delegate>
          <UserRoundPlus aria-hidden className="size-4" /> Delegate
        </button>
        {ownerKey && (
          <button type="button" disabled={busy || note.trim().length < 3} onClick={() => send(ownerKey)} className={QUIET} data-escalate title={note.trim().length < 3 ? `Say what ${ownerName} needs to decide` : undefined}>
            <ArrowUpRight aria-hidden className="size-4" /> Escalate to {ownerName}
          </button>
        )}
      </div>
      <Said msg={msg} />
    </fieldset>
  );
}

/** "Mark handled": the conversation closes with no reply (Messages' own Handled,
 *  a cut point: a new message from them is waiting again). */
export function MarkHandled({ threadKey, family, clientId, groupKey }: { threadKey: string; family: "phone" | "email"; clientId: string | null; groupKey: string }) {
  const { busy, msg, run } = useRun();
  // On a phone the first tap asks again (Kyle, Oct 29 2026: pressed by mistake while taking a screenshot).
  const [arming, setArming] = useState<string | null>(null);
  if (msg?.ok) return <Said msg={msg} />;
  const press = (reason: "no reply needed" | "answered elsewhere") => {
    if (arming !== reason && typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches) {
      setArming(reason);
      setTimeout(() => setArming((cur) => (cur === reason ? null : cur)), 4000);
      return;
    }
    setArming(null);
    run(async () => {
      const r = await markCommsHandled(clientId, family, groupKey, { threadKey, reason });
      const words = r.ok ? (r.message ?? "Marked handled. It has left the list.") : r.message ?? "That didn't go through. Try again.";
      if (r.ok) flashHandled(r.undoId, words);
      return { ok: r.ok, message: r.ok && r.undoId ? `${words} Undo it from the notice, or from Handled today.` : words };
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="handled">
      <button type="button" disabled={busy} onClick={() => press("no reply needed")} className={QUIET} data-mark-handled>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} {arming === "no reply needed" ? "Tap again: no reply needed" : "Mark handled: no reply needed"}
      </button>
      <button type="button" disabled={busy} onClick={() => press("answered elsewhere")} className={QUIET}>{arming === "answered elsewhere" ? "Tap again: answered elsewhere" : "Answered elsewhere"}</button>
      <Said msg={msg} />
    </div>
  );
}

/** "+ Add task" (Jordan's mockup): a task for Kyle himself (the Tasks page's own
 *  add), or assigned to someone else through delegation. Its own small panel;
 *  off in the owner's preview. The panel is portaled to <body>: the button sits
 *  in the page header, whose backdrop blur makes a `fixed` child hang off the
 *  header instead of the window (Kyle, Oct 28 2026: "it shows up at the header"). */
export function AddTaskButton({ people, me, readOnly = false, initialOpen = false }: { people: { key: string; name: string }[]; me: string | null; readOnly?: boolean; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // In place until mounted (a server render has no <body> to portal to).
  const portal = (node: ReactNode) => (mounted ? createPortal(node, document.body) : node);
  const { busy, msg, run, setMsg } = useRun();
  const [title, setTitle] = useState("");
  const [who, setWho] = useState(me ?? "kyle");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const close = () => { setOpen(false); setMsg(null); };
  const save = () => run(async () => {
    if (who === (me ?? "kyle")) return createManualTask({ title, notes: note || undefined, dueDate: due || undefined, assignedKey: who });
    return assignTaskAction({ title, outcome: note || undefined, assigneeKey: who, dueAt: due || undefined });
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={readOnly} data-add-task className={PRIMARY} title={readOnly ? "Read-only preview" : undefined}>
        <Plus aria-hidden className="size-4" /> Add task
      </button>
      {open && portal(
        <div className="fixed inset-0 z-50 flex justify-end" data-add-task-panel>
          <button type="button" aria-label="Close" onClick={close} className="absolute inset-0 bg-black/30" />
          <aside role="dialog" aria-modal="true" aria-labelledby="add-task-title" className="relative flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <h2 id="add-task-title" className="flex-1 text-base font-semibold">Add a task</h2>
              <button type="button" autoFocus onClick={close} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2"><X aria-hidden className="size-5" /></button>
            </div>
            {msg?.ok ? <Said msg={msg} /> : (
              <>
                <label className="text-sm font-medium" htmlFor="add-task-what">What needs doing</label>
                <input id="add-task-what" value={title} onChange={(e) => setTitle(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm" />
                <label className="text-sm font-medium" htmlFor="add-task-who">Who</label>
                <select id="add-task-who" value={who} onChange={(e) => setWho(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm">
                  {people.map((p) => <option key={p.key} value={p.key}>{p.key === me ? `Me (${p.name})` : p.name}</option>)}
                </select>
                <label className="text-sm font-medium" htmlFor="add-task-due">Due (optional)</label>
                <input id="add-task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm" />
                <label className="text-sm font-medium" htmlFor="add-task-note">{who === (me ?? "kyle") ? "Notes (optional)" : "The outcome you want (optional)"}</label>
                <textarea id="add-task-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm" />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy || title.trim().length < 3} onClick={save} className={PRIMARY}>
                    {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} {who === (me ?? "kyle") ? "Add to my tasks" : "Assign"}
                  </button>
                  <Said msg={msg} />
                </div>
              </>
            )}
          </aside>
        </div>,
      )}
    </>
  );
}
