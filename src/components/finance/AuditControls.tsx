"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ListChecks, Loader2, Upload } from "lucide-react";
import { syncAuditTasksAction, uploadVenmoStatementsAction } from "@/app/sales/auditActions";

// The two buttons on Finance → Audit (Oct 24 2026): put the action items on
// the task list now, and add Venmo statement CSVs.

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";

export function AuditTaskButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  if (!count) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-[12px] font-medium text-success" : "text-[12px] text-danger"}>{msg.message}</span>}
      <button type="button" disabled={busy} onClick={() => start(async () => { const r = await syncAuditTasksAction().catch(() => ({ ok: false, message: "That didn't go through; try again." })); setMsg(r); if (r.ok) router.refresh(); })} className={`${BTN} border border-brand/50 font-medium text-brand hover:bg-brand/10`} data-audit-sync>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ListChecks aria-hidden className="size-4" />} Put these on my task list
      </button>
    </div>
  );
}

export function VenmoUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, start] = useTransition();
  const [names, setNames] = useState<string[]>([]);
  const [results, setResults] = useState<{ ok: boolean; message: string }[]>([]);
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await uploadVenmoStatementsAction(fd).catch(() => ({ ok: false, results: [{ ok: false, message: "That didn't go through. Nothing was added; try again." }] }));
          setResults(r.results);
          if (r.results.some((x) => x.ok)) { router.refresh(); if (input.current) input.current.value = ""; setNames([]); }
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${BTN} cursor-pointer border border-border font-medium hover:bg-surface-2`}>
          <Upload aria-hidden className="size-4" /> Choose statements
          <input ref={input} type="file" name="files" accept=".csv,text/csv" multiple className="sr-only" onChange={(e) => { setNames([...(e.target.files ?? [])].map((f) => f.name)); setResults([]); }} data-venmo-file />
        </label>
        <button type="submit" disabled={busy || !names.length} className={`${BTN} bg-brand-action text-brand-fg hover:brightness-95`} data-venmo-upload>
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />} Add to the books
        </button>
        {names.length > 0 && <span className="text-[12px] text-muted">{names.length === 1 ? names[0] : `${names.length} files`}</span>}
      </div>
      {results.length > 0 && (
        <ul className="space-y-1" role="status">
          {results.map((r, i) => <li key={i} className={r.ok ? "text-[13px] text-success" : "text-[13px] text-danger"}>{r.message}</li>)}
        </ul>
      )}
    </form>
  );
}
