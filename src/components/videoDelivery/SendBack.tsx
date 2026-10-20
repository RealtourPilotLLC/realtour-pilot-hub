"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { sendBackForRevisionsAction } from "@/app/review/videoSendActions";

// "Send back for revisions" on a Ready to send row (Jordan, Oct 19 2026): an
// approved video that turns out not to be ready goes back to the editor with
// a note, and leaves Ready to send.
export function SendBack({ submissionId, projectId, street }: { submissionId: string; projectId: string; street: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const go = () =>
    start(async () => {
      const r = await sendBackForRevisionsAction(submissionId, projectId, note).catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  const id = `sendback-${submissionId}`;
  return (
    <details className="mt-2 rounded-lg border border-border bg-surface-2/40">
      <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Not ready? Send back for revisions</summary>
      <div className="space-y-2 px-3 pb-3 text-sm">
        <label htmlFor={id} className="block text-muted">What needs changing on {street}? The editor gets this as a note.</label>
        <textarea
          id={id}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand"
          placeholder="e.g. Update the lot lines to show the 4 separate lots instead of one big lot."
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={go}
            disabled={busy || note.trim().length < 3}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-strong px-3 text-sm font-semibold hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Undo2 aria-hidden className="size-4" /> {busy ? "Sending back…" : "Send back to the editor"}
          </button>
          {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-success" : "text-danger"}>{msg.text}</span>}
        </div>
      </div>
    </details>
  );
}
