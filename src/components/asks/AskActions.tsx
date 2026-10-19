"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, Loader2, RotateCcw, X } from "lucide-react";
import { confirmAskAction, doneAskAction, notNeededAskAction, reopenAskAction, assignAskJobAction, type AskActionResult } from "@/app/ops/requests/actions";

// ---------------------------------------------------------------------------
// The buttons on one client ask (Oct 19 2026, lib/clientAsks). Plain words:
//   · Confirmed: checked on the finished work (who is recorded; a note is
//     optional). Releases the delivery hold.
//   · Done: handled. Not offered on an ask that holds delivery: that one
//     needs a Confirmed, so nothing goes out on a "passed it on".
//   · Not needed: set aside. Releases the delivery hold.
//   · Reopen: a closed ask back on the list.
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9";

export function AskActions({
  id,
  kind,
  holdsDelivery,
  state,
  jobChoices,
}: {
  id: string;
  kind: "SPECIAL_REQUEST" | "SCHEDULING";
  holdsDelivery: boolean;
  state: "OPEN" | "DONE" | "CONFIRMED" | "NOT_NEEDED";
  /** For an ask on no job yet: the client's jobs in flight to put it on. */
  jobChoices?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<AskActionResult | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [job, setJob] = useState("");
  const run = (fn: () => Promise<AskActionResult>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through. Reload the page and try again." }));
      setMsg(r);
      if (r.ok) {
        setNoting(false);
        setNote("");
        router.refresh();
      }
    });

  if (state !== "OPEN") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => run(() => reopenAskAction(id))} className={`${BTN} border border-border-strong hover:bg-surface-2`}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <RotateCcw aria-hidden className="size-4" />} Reopen
        </button>
        {msg && <span role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {jobChoices && jobChoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`ask-job-${id}`}>Which job is it for?</label>
          <select id={`ask-job-${id}`} value={job} onChange={(e) => setJob(e.target.value)} className="min-h-11 max-w-full rounded-lg border bg-surface-2 px-2 text-sm sm:min-h-9">
            <option value="">Which job is it for?</option>
            {jobChoices.map((j) => (
              <option key={j.id} value={j.id}>{j.label}</option>
            ))}
          </select>
          <button type="button" disabled={busy || !job} onClick={() => run(() => assignAskJobAction(id, job))} className={`${BTN} border border-border-strong hover:bg-surface-2`}>
            Put it on this job
          </button>
        </div>
      )}
      {noting && kind === "SPECIAL_REQUEST" && (
        <div className="space-y-1.5">
          <label htmlFor={`ask-note-${id}`} className="text-[12px] text-muted">What you checked (optional)</label>
          <input
            id={`ask-note-${id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="e.g. all 4 lots and their numbers match the plat"
            className="w-full rounded-lg border bg-surface-2 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {kind === "SPECIAL_REQUEST" &&
          (noting ? (
            <button type="button" disabled={busy} onClick={() => run(() => confirmAskAction(id, note))} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`}>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCheck aria-hidden className="size-4" />} Save as confirmed
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => setNoting(true)} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`} data-ask-confirm>
              <CheckCheck aria-hidden className="size-4" /> Confirmed
            </button>
          ))}
        {!(kind === "SPECIAL_REQUEST" && holdsDelivery) && (
          <button type="button" disabled={busy} onClick={() => run(() => doneAskAction(id))} className={`${BTN} border border-border-strong hover:bg-surface-2`} data-ask-done>
            {busy && !noting ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Check aria-hidden className="size-4" />} Done
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => run(() => notNeededAskAction(id))} className={`${BTN} border border-border-strong text-muted hover:bg-surface-2 hover:text-foreground`} data-ask-not-needed>
          <X aria-hidden className="size-4" /> Not needed
        </button>
        {noting && (
          <button type="button" disabled={busy} onClick={() => { setNoting(false); setNote(""); }} className={`${BTN} text-muted hover:text-foreground`}>
            Cancel
          </button>
        )}
      </div>
      {msg && <p role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}
