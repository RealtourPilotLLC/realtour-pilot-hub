"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { removeFromAr } from "@/app/billing/actions";

// Take a junk row off the AR list — a cancelled appointment we never did, or a
// test order (Jordan, Sep 1). It's a FLAG, not a delete: the Aryeo sync would
// re-import a deleted project, and the order history still matters for the
// books. Asks for a reason IN PAGE (no native dialogs anywhere in the hub —
// they're unreliable on mobile) and the reason lands on the project timeline.
export function RemoveFromAr({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setErr(null); }}
        title="Remove this from the unpaid list (cancelled appointment, test order)"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium text-muted hover:bg-danger-soft hover:text-danger"
      >
        <Trash2 className="size-3.5" /> Remove
      </button>
    );
  }
  return (
    <div className="w-full rounded-lg border border-danger/30 bg-danger-soft/40 p-2.5">
      <p className="text-[11px] font-medium text-foreground/80">
        Why is this off the books? It stays on the project, just not in what&rsquo;s owed.
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); setNote(""); }
          }}
          placeholder="e.g. cancelled appointment, never shot · test order"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand"
        />
        <button
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await removeFromAr(projectId, note).catch(() => ({ ok: false, message: "Couldn’t remove it — try again." }));
              if (r.ok) { setOpen(false); setNote(""); router.refresh(); }
              else setErr(r.message);
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Remove
        </button>
        <button
          onClick={() => { setOpen(false); setNote(""); setErr(null); }}
          className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {err && <p className="mt-1.5 text-[11px] font-medium text-danger">{err}</p>}
    </div>
  );
}
