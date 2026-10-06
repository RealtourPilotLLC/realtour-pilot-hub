"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileVideo, Loader2, RotateCcw, Send } from "lucide-react";
import { markSentOutsidePortalAction, retryPortalPublicationAction, run1080pAction } from "@/app/ops/deliveryRecoveryActions";
import type { PortalStep } from "@/lib/readyToSend";

/**
 * A PORTAL VIDEO'S NEXT STEP — one sentence, one button (Oct 5 2026).
 *
 * The sentence comes from readyToSend.portalStepFor: exactly what stands
 * between this version and the client. The button answers at once (the slow
 * work runs after the server replies) and the row repaints a moment later with
 * whatever is true then. Mark as sent asks once first: it records a send that
 * cannot be taken back from this card.
 *
 * Type-only import from readyToSend — nothing server-side crosses into the
 * browser bundle.
 */
const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const REPAINT_MS = 2500;

export function PortalNextStep({ submissionId, street, clientName, step, dropboxUrl }: { submissionId: string; street: string; clientName: string; step: PortalStep; dropboxUrl: string | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, start] = useTransition();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, repaint = REPAINT_MS) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing changed; try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) later(() => router.refresh(), repaint);
  });

  const markSent = () => {
    if (!asking) {
      setAsking(true);
      later(() => setAsking(false), 6000);
      return;
    }
    setAsking(false);
    setDone(true); // the press is the answer; a refusal puts the button back
    start(async () => {
      const r = await markSentOutsidePortalAction(submissionId).catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing was recorded; try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (!r.ok) setDone(false);
      else later(() => router.refresh(), 400);
    });
  };

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
        {step.action === "send-outside-portal" && (
          <>
            {dropboxUrl && (
              <a href={dropboxUrl} target="_blank" rel="noreferrer" className={btn}>
                <FileVideo className="size-4" aria-hidden /> Open in Dropbox
              </a>
            )}
            <button type="button" disabled={busy || done} onClick={markSent} className={btn} aria-label={asking ? `Yes, I sent ${clientName} the link for ${street}` : `Mark ${street} as sent`}>
              {done ? <Check className="size-4" aria-hidden /> : busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              {done ? "Marked as sent" : asking ? `Yes, I sent ${clientName} the link` : "Mark as sent"}
            </button>
          </>
        )}
      </div>
      {msg && <p role="status" className={msg.ok ? "text-sm text-muted" : "text-sm text-danger"}>{msg.text}</p>}
    </div>
  );
}
