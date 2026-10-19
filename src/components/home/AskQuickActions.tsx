"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { confirmAskAction, doneAskAction, notNeededAskAction, reopenAskAction, type AskActionResult } from "@/app/ops/requests/actions";

// One tap on a client ask from Kyle's checklist (Oct 19 2026). The server
// actions are the Special requests and Scheduling screens' own (they guard
// first and say what happened in plain words):
//   · a special request: Checked (looked at on the finished work; releases a
//     delivery hold) or Not needed;
//   · a scheduling ask: Done or Not needed.
// A note on a Checked, or putting an ask on a different job, stays on the
// job's own page (Review Room, photo job), which carries the full card.

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium disabled:opacity-60";

export function AskQuickActions({ id, askKind }: { id: string; askKind: "SPECIAL_REQUEST" | "SCHEDULING" }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<AskActionResult | null>(null);
  const run = (fn: () => Promise<AskActionResult>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through. Reload the page and try again." }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  if (msg?.ok) return <p role="status" className="text-sm font-medium text-success">{msg.message || "Saved."}</p>;
  const primary = askKind === "SPECIAL_REQUEST" ? "Checked" : "Done";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => (askKind === "SPECIAL_REQUEST" ? confirmAskAction(id) : doneAskAction(id)))}
        className={`${BTN} border-success/40 bg-success/10 text-success hover:bg-success/20`}
      >
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} {primary}
      </button>
      <button type="button" disabled={busy} onClick={() => run(() => notNeededAskAction(id))} className={`${BTN} border-border text-muted hover:bg-surface-2 hover:text-foreground`}>
        <X aria-hidden className="size-4" /> Not needed
      </button>
      {msg && !msg.ok && <p role="alert" className="w-full text-sm text-danger">{msg.message}</p>}
    </div>
  );
}

/** Put an ask closed today back on the list (from "Done today"). */
export function ReopenAskButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<AskActionResult | null>(null);
  if (msg?.ok) return <span role="status" className="text-[12px] font-medium text-success">Back on the list</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => start(async () => {
          const r = await reopenAskAction(id).catch(() => ({ ok: false, message: "That didn't go through." }));
          setMsg(r);
          if (r.ok) router.refresh();
        })}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RotateCcw aria-hidden className="size-3.5" />} Undo
      </button>
      {msg && !msg.ok && <span role="alert" className="text-[12px] text-danger">{msg.message}</span>}
    </span>
  );
}
