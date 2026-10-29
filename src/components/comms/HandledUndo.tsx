"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, X } from "lucide-react";
import { handledTodayAction, undoCommsHandled } from "@/app/actions";
import { etTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// UNDO A MARK HANDLED (Kyle, Oct 29 2026: "I clicked on marked as handled on
// this task by mistake 🤦 i was trying to screenshot it"). The row leaves the
// list the moment the tick lands, so the Undo can't live on the row: Shell
// mounts one HandledUndoHost, every Mark handled hands it the tick's undoId
// (flashHandled), and it shows the words with Undo for UNDO_MS. After that,
// Handled today lists the day's ticks with Reopen (lib/handledUndo).
// ---------------------------------------------------------------------------

const UNDO_MS = 12_000;
const hosts = new Set<(undoId: string, text: string) => void>();

/** Offer Undo for a tick; false when no host is mounted (the caller keeps its own line). */
export function flashHandled(undoId: string | null | undefined, text: string): boolean {
  if (!undoId) return false;
  hosts.forEach((show) => show(undoId, text));
  return hosts.size > 0;
}

export function HandledUndoHost() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ undoId: string | null; text: string; n: number } | null>(null);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((undoId: string | null, text: string, ms = UNDO_MS) => {
    setMsg((cur) => ({ undoId, text, n: (cur?.n ?? 0) + 1 }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), ms);
  }, []);
  useEffect(() => {
    const host = (undoId: string, text: string) => show(undoId, text);
    hosts.add(host);
    return () => { hosts.delete(host); if (timer.current) clearTimeout(timer.current); };
  }, [show]);
  const undo = (undoId: string) =>
    start(async () => {
      const r = await undoCommsHandled(undoId).catch(() => ({ ok: false, message: "That didn't go through. Open Handled today to reopen it." }));
      show(null, r.message, 6000);
      if (r.ok) router.refresh();
    });
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[1400] flex justify-center px-4 sm:bottom-6">
      {msg && (
        <div key={msg.n} data-handled-undo className="pointer-events-auto flex max-w-md flex-wrap items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg ring-1 ring-border-strong">
          <span className="min-w-0 flex-1 basis-40">{msg.text}</span>
          {msg.undoId && (
            <button type="button" disabled={busy} onClick={() => undo(msg.undoId!)} data-undo-handled className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-background/15 px-3 font-semibold hover:bg-background/25 disabled:opacity-60">
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <RotateCcw aria-hidden className="size-4" />} Undo
            </button>
          )}
          <button type="button" onClick={() => setMsg(null)} aria-label="Dismiss" className="-mr-1 shrink-0 rounded p-0.5 opacity-80 hover:opacity-100"><X className="size-4" /></button>
        </div>
      )}
    </div>
  );
}

type Row = { id: string; atISO: string; by: string | null; label: string; family: "phone" | "email"; reason: string | null };

/** The day's Mark handled ticks, each with Reopen. Loads when opened. */
export function HandledToday({ className }: { className?: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [said, setSaid] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const load = () => start(async () => setRows((await handledTodayAction().catch(() => ({ ok: false, rows: [] as Row[] }))).rows));
  const reopen = (id: string) =>
    start(async () => {
      const r = await undoCommsHandled(id).catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
      setSaid({ id, ok: r.ok, text: r.message });
      if (r.ok) { setRows((cur) => (cur ?? []).filter((x) => x.id !== id)); router.refresh(); }
    });
  return (
    <details className={cn("group rounded-lg bg-surface-2/50 px-3", className)} data-handled-today onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows == null) load(); }}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex-1">Handled today{rows ? ` (${rows.length})` : ""}</span>
        <RotateCcw aria-hidden className="size-4" />
      </summary>
      {rows == null ? (
        <p className="pb-2 text-[13px] text-muted">{busy ? "Loading…" : "Open to load."}</p>
      ) : rows.length === 0 ? (
        <p className="pb-2 text-[13px] text-muted">Nothing marked handled today.</p>
      ) : (
        <ul className="divide-y divide-border pb-1">
          {rows.map((r) => (
            <li key={r.id} data-handled-row={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 basis-48 text-sm">
                <span className="font-medium [overflow-wrap:anywhere]">{r.label}</span>
                <span className="block text-[12px] text-muted">{[r.family === "email" ? "Email" : "Text", etTime(r.atISO), r.by, r.reason].filter(Boolean).join(" · ")}</span>
              </span>
              <button type="button" disabled={busy} onClick={() => reopen(r.id)} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50">
                <RotateCcw aria-hidden className="size-3.5" /> Reopen
              </button>
            </li>
          ))}
        </ul>
      )}
      {said && <p role={said.ok ? "status" : "alert"} className={cn("pb-2 text-[13px]", said.ok ? "text-success" : "text-danger")}>{said.text}</p>}
    </details>
  );
}
