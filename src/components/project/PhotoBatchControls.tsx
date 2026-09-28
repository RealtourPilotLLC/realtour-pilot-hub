"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { recordPhotoBatchRerun, refreshPhotoBatch } from "@/app/projects/photoBatchActions";

// The register's two buttons. "Record a re-run" is offered only when the batch
// reads short; the server looks at Dropbox again before it writes anything and
// refuses while edits are still arriving.
export function PhotoBatchControls({ projectId, canRecordRerun }: { projectId: string; canRecordRerun: boolean }) {
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) { setReason(""); setOpen(false); }
      } catch (e) {
        setMsg({ ok: false, text: e instanceof Error ? e.message : "That didn't work." });
      }
    });

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => refreshPhotoBatch(projectId))}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Look again now
        </button>
        {canRecordRerun && !open && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setOpen(true)}
            className="rounded-lg border border-warning/40 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning-soft disabled:opacity-50"
          >
            Record a re-run…
          </button>
        )}
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => recordPhotoBatchRerun(projectId, reason));
          }}
          className="space-y-2 rounded-xl border bg-surface-2/40 p-3"
        >
          <p className="text-xs text-muted">
            Only once AutoHDR has confirmed the missing edits aren&rsquo;t coming. A re-run is a second charge. This records it — the hub does not upload or pay for anything.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why it is being re-run (e.g. AutoHDR support said the job failed)"
            className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={pending || reason.trim().length < 3} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {pending ? "Checking Dropbox…" : "Record the re-run"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-2">
              Cancel
            </button>
          </div>
        </form>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </div>
  );
}
