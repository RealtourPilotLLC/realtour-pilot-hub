"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Copy, Loader2, Sparkles, X } from "lucide-react";
import { draftAtRiskUpdateAction } from "@/app/tasks/atRiskActions";
import { cn } from "@/lib/utils";
import { ModalDialog } from "@/components/ui/ModalDialog";

// The "Draft update" dialog on a promise at risk (AU-24 / F5, Sep 26 2026).
// The person types ONE time — the new delivery time they have confirmed, or
// the time they will confirm one by — and the draft is written from that and
// the recorded promise, nothing else. It is shown here and filed on Kyle's
// list; nothing is sent from this dialog.

export function DraftUpdateDialog({
  projectId,
  outputId,
  label,
}: {
  projectId: string;
  outputId: string | null;
  /** "His and hers (video 2) — 812 Linden Ave", for the dialog heading */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"newTime" | "confirmBy">("confirmBy");
  const [when, setWhen] = useState("");
  const [busy, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string; draft?: string; taskId?: string; warning?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const submitting = useRef(false);

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setRes(null); setCopied(false); }}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand/10 px-3 text-sm font-medium text-brand hover:bg-brand/20"
      >
        <Sparkles className="size-3.5" /> Draft update
      </button>
      {open && (
        <ModalDialog label="Draft a client update" busy={busy} onCancel={() => setOpen(false)} className="max-w-md">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">Draft a client update</p>
                <p className="truncate text-xs text-muted">{label}</p>
              </div>
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)} className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2">
                <X className="size-4" />
              </button>
            </div>
            <p className="mb-3 text-[12px] text-muted">
              The draft only ever names the recorded promise and the time you type here. It is saved to Kyle&rsquo;s list for a
              person to read and send — nothing goes to the client from this box.
            </p>
            <div className="mb-2 flex gap-1.5">
              {([
                ["confirmBy", "We'll confirm a time by…"],
                ["newTime", "New delivery time (confirmed)"],
              ] as const).map(([k, words]) => (
                <button
                  key={k}
                  type="button"
                  disabled={busy}
                  onClick={() => { setMode(k); setRes(null); }}
                  className={cn("min-h-11 rounded-lg px-3 text-sm font-medium", mode === k ? "bg-surface-2 ring-1 ring-border" : "text-muted hover:bg-surface-2")}
                >
                  {words}
                </button>
              ))}
            </div>
            <label className="mb-3 block text-[12px] text-muted">
              {mode === "newTime" ? "The delivery time you have confirmed (Eastern)" : "When you will confirm the new time by (Eastern)"}
              <input
                type="datetime-local"
                data-modal-initial-focus
                disabled={busy}
                value={when}
                onChange={(e) => { setWhen(e.target.value); setRes(null); }}
                className="mt-1 block min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-brand"
              />
            </label>
            <button
              type="button"
              disabled={busy || !when}
              onClick={() => {
                if (submitting.current) return;
                submitting.current = true;
                start(async () => {
                  setCopied(false);
                  try {
                    const r = await draftAtRiskUpdateAction({ projectId, outputId, mode, when }).catch(() => ({ ok: false, message: "Could not draft — try again." }));
                    setRes(r);
                  } finally {
                    submitting.current = false;
                  }
                });
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Draft it
            </button>
            {res && !res.ok && <p className="mt-2 text-xs text-danger">{res.message}</p>}
            {res?.ok && res.draft && (
              <div className="mt-3 rounded-xl border border-brand/30 p-3">
                {res.warning && <p className="mb-2 text-[12px] font-medium text-warning">⚠ {res.warning}</p>}
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Draft — not sent</span>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard?.writeText(res.draft ?? ""); setCopied(true); }}
                    className="inline-flex min-h-11 items-center gap-1 px-2 text-sm text-muted hover:text-foreground"
                  >
                    <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{res.draft}</p>
                <p className="mt-2 text-[11px] text-muted-2">
                  {res.message}{" "}
                  {res.taskId && <Link href={`/tasks?tab=other&task=${res.taskId}`} className="underline">Open the task</Link>}
                </p>
              </div>
            )}
        </ModalDialog>
      )}
    </>
  );
}
