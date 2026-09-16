"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Eye, Loader2, X } from "lucide-react";
import { markLoopHandled } from "@/app/ops/actions";
import { dismissTask } from "@/app/actions";
import { DISMISS_REASONS } from "@/lib/triage";

// View + Handled on every open loop (Jordan, Sep 1) — the row used to be one
// big link with no way to close it without leaving the page.
//
// Sep 16 (Kyle's call): "Handled" was the only exit, and it writes COMPLETED —
// which is a lie on a row that describes work nobody did and nobody is going
// to. "Not needed" sits beside it now: it cancels with a reason on the record,
// so the Done tab can show what was cleared and why instead of the row simply
// evaporating off the home.
const REASON_LABEL: Record<string, string> = {
  "already done": "Already done",
  "not needed": "Not needed",
  duplicate: "Duplicate",
  spam: "Spam",
};

export function LoopActions({ taskId, viewHref }: { taskId: string; viewHref: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"handled" | "dismissed" | null>(null);
  const [asking, setAsking] = useState(false);

  const handle = () =>
    start(async () => {
      const r = await markLoopHandled(taskId).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      if (r.ok) { setDone("handled"); router.refresh(); }
      else setErr(r.message);
    });

  const dismiss = (reason: string) =>
    start(async () => {
      const r = await dismissTask(taskId, reason).catch(() => ({ ok: false as const, message: "Couldn’t save — try again." }));
      if (r.ok) { setDone("dismissed"); setAsking(false); router.refresh(); }
      else setErr(r.message);
    });

  if (done) {
    return done === "handled" ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-success/10 px-2 py-1 text-[11px] font-semibold text-success">
        <Check className="size-3.5" /> Handled
      </span>
    ) : (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-[11px] font-semibold text-muted">
        <X className="size-3.5" /> Dismissed
      </span>
    );
  }

  if (asking) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="text-[11px] font-medium text-muted-2">Why?</span>
        {DISMISS_REASONS.map((r) => (
          <button
            key={r}
            onClick={() => dismiss(r)}
            disabled={busy}
            className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-foreground/80 hover:bg-surface-2 disabled:opacity-50"
          >
            {REASON_LABEL[r] ?? r}
          </button>
        ))}
        <button onClick={() => setAsking(false)} disabled={busy} className="px-1.5 py-1 text-[11px] text-muted hover:text-foreground">
          Cancel
        </button>
        {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
        {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
      </div>
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
      <button
        onClick={() => setAsking(true)}
        disabled={busy}
        title="Close it without pretending it got done — say why and it goes on the record"
        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3.5" /> Not needed
      </button>
      {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
    </div>
  );
}
