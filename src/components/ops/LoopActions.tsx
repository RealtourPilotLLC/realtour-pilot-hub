"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Eye, Loader2 } from "lucide-react";
import { markLoopHandled } from "@/app/ops/actions";

// View + Handled on every open loop (Jordan, Sep 1) — the row used to be one
// big link with no way to close it without leaving the page.
export function LoopActions({ taskId, viewHref }: { taskId: string; viewHref: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handle = () =>
    start(async () => {
      const r = await markLoopHandled(taskId).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      if (r.ok) { setDone(true); router.refresh(); }
      else setErr(r.message);
    });

  if (done) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-success/10 px-2 py-1 text-[11px] font-semibold text-success">
        <Check className="size-3.5" /> Handled
      </span>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Link
        href={viewHref}
        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
      >
        <Eye className="size-3.5" /> View
      </Link>
      <button
        onClick={handle}
        disabled={busy}
        title="Mark this follow-up handled"
        className="inline-flex items-center gap-1 rounded-lg border border-success/40 bg-success/10 px-2 py-1 text-[11px] font-semibold text-success hover:bg-success/20 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Handled
      </button>
      {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
    </div>
  );
}
