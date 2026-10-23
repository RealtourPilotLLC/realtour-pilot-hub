"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, Send } from "lucide-react";
import { approveAryeoAction } from "@/app/ops/photo-delivery/actions";
import { sendThreadText } from "@/app/communications/threadActions";
import { dismissTask } from "@/app/actions";
import { sendPhotographerBriefNow } from "@/app/shoot/brief/actions";
import { closeoutTickAction, deskWaitAction, finishDayAction, type DeskResult, type WaitInput } from "@/app/deskActions";
import type { CloseoutKey } from "@/lib/officeDesk";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The desk's own small controls (Oct 23 2026). Each calls an EXISTING action
// (Approve and deliver / upload, the Messages text send, Not needed) or one
// of the desk's two writes (closeout ticks, Waiting on), then refreshes the
// page in place: the dashboard, its tab and its side panel stay where they
// are, and the counts recompute.
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

/** A text back to the client, through the Messages screen's own send. */
export function ReplyBox({ phone, clientId }: { phone: string; clientId: string | null }) {
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
      <label className="block text-sm font-medium" htmlFor="desk-reply">Text back</label>
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

/** A shoot confirmed by phone (or otherwise): the confirmation text is not needed. */
export function ConfirmControls({ taskId, outboxHref }: { taskId: string; outboxHref: string }) {
  const { busy, msg, run } = useRun();
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="confirm">
      <Link href={outboxHref} className={QUIET}>Send the confirmation text</Link>
      <button type="button" disabled={busy} onClick={() => run(() => dismissTask(taskId, "already done"))} className={QUIET}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} Confirmed another way
      </button>
      <Said msg={msg} />
    </div>
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
export function CloseoutTick({ dayKey, itemKey, checked, disabled, label }: { dayKey: string; itemKey: CloseoutKey; checked: boolean; disabled: boolean; label: string }) {
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
export function BriefSend({ teamMemberId, day, name }: { teamMemberId: string; day: string; name: string }) {
  const { busy, msg, run } = useRun();
  if (msg?.ok) return <Said msg={msg} />;
  return (
    <div className="flex flex-wrap items-center gap-2" data-control="brief-send">
      <button type="button" disabled={busy} onClick={() => run(() => sendPhotographerBriefNow(teamMemberId, day))} className={QUIET}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} Send {name} the brief now
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
