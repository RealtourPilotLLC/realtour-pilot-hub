"use client";

import { useState, useTransition } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { sendToJordanAction } from "@/app/delegation/actions";
import { cn } from "@/lib/utils";

/**
 * SEND TO JORDAN (James call, Oct 28 2026): the one way up, on any card a
 * lead (James, Kyle) sees: a task, a complaint, a photo job, a shoot brief.
 * A reason box, then a decision on Jordan's dashboard (lib/sendToJordan).
 * Pages draw it only for a lead who isn't Jordan.
 */
export function SendToJordan({ title, href, taskId, projectId, clientId, className }: {
  title: string;
  href?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  const send = () =>
    start(async () => {
      const r = await sendToJordanAction({ title, why, href, taskId, projectId, clientId }).catch(() => ({ ok: false, message: "That didn't reach the hub. Nothing was sent; try again." }));
      setSaid(r);
      if (r.ok) { setOpen(false); setWhy(""); }
    });
  if (said?.ok) return <p role="status" className={cn("text-xs font-medium text-success", className)} data-sent-to-jordan>{said.message}</p>;
  return (
    <div className={cn("space-y-1.5", className)} data-control="send-to-jordan">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
          <ArrowUpRight aria-hidden className="size-3.5" /> Send to Jordan
        </button>
      ) : (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface-2/50 p-2">
          <label className="block text-xs font-medium" htmlFor={`stj-${taskId ?? title}`}>What Jordan needs to decide</label>
          <textarea id={`stj-${taskId ?? title}`} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} autoFocus
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || why.trim().length < 3} onClick={send} className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-brand-action px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <ArrowUpRight aria-hidden className="size-3.5" />} Send to Jordan
            </button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setSaid(null); }} className="text-xs text-muted hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}
      {said && !said.ok && <p role="alert" className="text-xs text-danger">{said.message}</p>}
    </div>
  );
}
