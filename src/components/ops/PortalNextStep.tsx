"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { retryPortalPublicationAction, run1080pAction } from "@/app/ops/deliveryRecoveryActions";
import type { PortalStep } from "@/lib/readyToSend";

/**
 * A PORTAL VIDEO'S NEXT STEP — one sentence, one button (Oct 5 2026).
 *
 * The sentence comes from readyToSend.portalStepFor: exactly what stands
 * between this version and the client. The button answers at once (the slow
 * work runs after the server replies) and the row repaints a moment later with
 * whatever is true then. (Oct 12 2026: no "Mark as sent" here any more —
 * Realtour never sends clients Dropbox links; Dropbox is internal. Every
 * checked monthly video goes to the portal.)
 *
 * Type-only import from readyToSend — nothing server-side crosses into the
 * browser bundle.
 */
const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const REPAINT_MS = 2500;

export function PortalNextStep({ submissionId, street, step }: { submissionId: string; street: string; clientName?: string; step: PortalStep; dropboxUrl?: string | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, repaint = REPAINT_MS) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing changed; try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) later(() => router.refresh(), repaint);
  });

  const label = step.action === "run-1080p" ? "Run 1080p" : step.action === "retry-1080p" ? "Retry 1080p" : step.action === "retry-publication" ? "Retry publication" : null;
  return (
    <div className="mt-2 min-w-0 space-y-2">
      <p className={step.blocked ? "text-sm font-medium text-warning" : "text-sm text-foreground/85"}>{step.says}</p>
      <div className="flex flex-wrap items-center gap-2">
        {label && (
          <button type="button" disabled={busy} onClick={() => run(() => step.action === "retry-publication" ? retryPortalPublicationAction(submissionId) : run1080pAction(submissionId))} className={btn} aria-label={`${label} for ${street}`}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />} {label}
          </button>
        )}
      </div>
      {msg && <p role="status" className={msg.ok ? "text-sm text-muted" : "text-sm text-danger"}>{msg.text}</p>}
    </div>
  );
}
