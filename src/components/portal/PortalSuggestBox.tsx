"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { portalSuggestScript } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";

// "Suggest a change" under each script on the client portal. Creates a
// suggestion record for Jordan's review — the script itself never changes
// until a human applies it.
export function PortalSuggestBox({ scriptId }: { scriptId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (done) return <p className="mt-2 text-xs font-medium text-success">{done}</p>;
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-foreground"
      >
        <MessageSquarePlus className="size-3.5" /> Suggest a change
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What would you say differently? We'll rework it and send the update."
        rows={3}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            start(async () => {
              const r = await portalSuggestScript(portalAuthFromLocation(), scriptId, text).catch(() => ({ ok: false, message: "That didn't send — try again." }));
              if (r.ok) setDone(r.message);
              else setErr(r.message);
            })
          }
          disabled={busy || text.trim().length < 3}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3 animate-spin" />} Send suggestion
        </button>
        <button onClick={() => { setOpen(false); setErr(null); }} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface">
          Cancel
        </button>
      </div>
      {err && <p className="text-[11px] text-danger">{err}</p>}
    </div>
  );
}
