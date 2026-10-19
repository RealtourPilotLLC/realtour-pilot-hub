"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hand, Loader2, Play, RotateCcw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { deliverVideoNowAction, holdVideoPushAction, releaseVideoPushAction, retryVideoPushAction } from "@/app/ops/video-delivery/actions";

// ---------------------------------------------------------------------------
// The buttons on a video a person already started sending (Oct 19 2026):
// Deliver now (on the listing, waiting for a person), Try again (a stopped or
// held run; the listing is checked before anything is sent again), Hold /
// Release (the hub does nothing more with this video until it is released).
// Each press answers in plain words. The off/shadow/upload/deliver switch
// that used to sit beside these is gone: the hub sends a video only when a
// person presses Upload to Aryeo and send.
// ---------------------------------------------------------------------------

const btn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function PushControls(props: { submissionId: string; street: string; canRetry: boolean; canDeliverNow: boolean; canHold: boolean; canRelease: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload to see what is saved." });
      }
    });
  if (!props.canRetry && !props.canDeliverNow && !props.canHold && !props.canRelease) return null;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.canDeliverNow && (
          <button type="button" disabled={pending} className={cn(btn, "border-brand/40 bg-brand/10 text-brand")} onClick={() => run(() => deliverVideoNowAction(props.submissionId))}>
            {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Send aria-hidden className="size-4" />} Deliver now
          </button>
        )}
        {props.canRetry && (
          <button type="button" disabled={pending} className={btn} onClick={() => run(() => retryVideoPushAction(props.submissionId))}>
            <RotateCcw aria-hidden className="size-4" /> Try again
          </button>
        )}
        {props.canHold && !asking && (
          <button type="button" disabled={pending} className={btn} onClick={() => setAsking(true)}>
            <Hand aria-hidden className="size-4" /> Hold
          </button>
        )}
        {props.canRelease && (
          <button type="button" disabled={pending} className={btn} onClick={() => run(() => releaseVideoPushAction(props.submissionId))}>
            <Play aria-hidden className="size-4" /> Release
          </button>
        )}
      </div>
      {asking && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAsking(false);
            run(() => holdVideoPushAction(props.submissionId, reason.trim() || null));
          }}
        >
          <label className="sr-only" htmlFor={`hold-${props.submissionId}`}>Why hold {props.street}</label>
          <input
            id={`hold-${props.submissionId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why (optional)"
            maxLength={200}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm"
          />
          <button type="submit" disabled={pending} className={btn}>Hold it</button>
          <button type="button" className={btn} onClick={() => setAsking(false)}>Cancel</button>
        </form>
      )}
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}
    </div>
  );
}
