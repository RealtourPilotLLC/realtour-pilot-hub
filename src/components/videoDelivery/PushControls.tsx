"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hand, Loader2, Play, RotateCcw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { deliverVideoNowAction, holdVideoPushAction, releaseVideoPushAction, retryVideoPushAction, saveVideoPushModeAction } from "@/app/ops/video-delivery/actions";

// ---------------------------------------------------------------------------
// Kyle's buttons on one video (Oct 19 2026): Retry (a stopped or held run; the
// listing is checked before anything is sent again), Deliver now (on the
// listing, waiting for him), Hold / Release (the hub does nothing more with
// this video until he releases it). Each press answers in plain words.
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
            <RotateCcw aria-hidden className="size-4" /> Retry
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

export type ModeOption = { value: "off" | "shadow" | "upload" | "deliver"; label: string; help: string };

/** The switch (owner only). Kyle sees the same card, read-only. */
export function PushModeCard(props: { value: ModeOption["value"]; options: ModeOption[]; canChange: boolean; connected: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(props.value);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-3">
      <fieldset disabled={!props.canChange || pending} className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Video upload and delivery to Aryeo</legend>
        {props.options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-sm",
              value === o.value ? "border-brand bg-brand/5" : "border-border hover:bg-surface-2/50",
              !props.canChange && "cursor-default",
            )}
          >
            <input type="radio" name="video-push-mode" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} className="mt-1" />
            <span>
              <span className="block font-semibold">{o.label}</span>
              <span className="block text-muted">{o.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {!props.connected && <p className="text-sm text-warning">The hub&rsquo;s Aryeo login is not set up yet. Jordan adds it on Connections, Aryeo hub login.</p>}
      {props.canChange ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || value === props.value}
            className={cn(btn, "border-brand/40 bg-brand/10 text-brand")}
            onClick={() =>
              start(async () => {
                try {
                  const r = await saveVideoPushModeAction(value);
                  setMsg({ ok: r.ok, text: r.message });
                  if (r.ok) router.refresh();
                } catch {
                  setMsg({ ok: false, text: "The hub didn't answer. Reload to see what is saved." });
                }
              })
            }
          >
            {pending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />} Save
          </button>
          {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted">Jordan changes this.</p>
      )}
    </div>
  );
}
