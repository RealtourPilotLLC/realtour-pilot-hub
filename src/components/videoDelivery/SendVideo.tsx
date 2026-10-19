"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BellRing, Loader2, RotateCcw, Send, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { remindVideoAction, sendAllVideosAction, sendVideoToAryeoAction } from "@/app/review/videoSendActions";

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM'S BUTTONS (Jordan, Oct 19 2026).
//
// SendVideo: "Upload to Aryeo and send". The hub uploads a listing video ONLY
// when somebody presses this (or Send all, or Try again). When the job has
// open client requests, the first press shows them and asks "Checked, upload
// and send"; when the Aryeo listing already shows a video that could be this
// one, the first press says so and asks "Upload anyway". After the press the
// row shows the upload's own progress (the page refreshes itself while a
// video is on its way).
// SendAll: every ready row with no open request, one press.
// RemindButton: "Remind editor" / "Remind reviewer", at most once every 4
// hours per video (the server decides; the row then says who was reminded).
// ---------------------------------------------------------------------------

const btn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const primary = cn(btn, "border-brand bg-brand text-white hover:bg-brand/90");

type Ask = { summary: string; askedBy: string | null };

export function SendVideo(props: {
  submissionId: string;
  street: string;
  label: "Upload to Aryeo and send" | "Send" | "Try again";
  openAsks: Ask[];
  asksUnknown: boolean;
  listingWarning: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<"idle" | "asks" | "listing">("idle");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const guard = useRef(false);
  const go = (checkedRequests: boolean) => {
    if (guard.current) return;
    guard.current = true;
    setStep("idle");
    setMsg(null);
    start(async () => {
      try {
        const r = await sendVideoToAryeoAction(props.submissionId, { checkedRequests });
        setMsg({ ok: r.ok, text: r.message });
        router.refresh();
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload to see whether it started; nothing is sent twice." });
      } finally {
        guard.current = false;
      }
    });
  };
  const press = () => {
    if (props.asksUnknown) {
      setMsg({ ok: false, text: "The client's requests could not be read just now, so nothing was sent. Reload the page and try again." });
      return;
    }
    if (props.openAsks.length) return setStep("asks");
    if (props.listingWarning && props.label !== "Try again") return setStep("listing");
    go(false);
  };
  const Icon = props.label === "Try again" ? RotateCcw : props.label === "Send" ? Send : UploadCloud;
  return (
    <div className="mt-2 space-y-2">
      {step === "idle" && (
        <button type="button" disabled={pending} className={props.label === "Try again" ? btn : primary} onClick={press}>
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Icon aria-hidden className="size-4" />} {pending ? "Starting" : props.label}
        </button>
      )}
      {step === "asks" && (
        <div role="group" aria-label={`Client requests for ${props.street}`} className="rounded-lg border border-warning/40 bg-warning-soft/30 p-3 text-sm">
          <p className="font-semibold">Check {props.openAsks.length === 1 ? "this request" : `these ${props.openAsks.length} requests`} in the video first:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {props.openAsks.map((a, i) => (
              <li key={i}>{a.summary}{a.askedBy ? <span className="text-muted"> ({a.askedBy})</span> : null}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={pending} className={primary} onClick={() => go(true)}>
              <UploadCloud aria-hidden className="size-4" /> Checked, upload and send
            </button>
            <button type="button" className={btn} onClick={() => setStep("idle")}>Cancel</button>
          </div>
        </div>
      )}
      {step === "listing" && (
        <div role="group" aria-label={`The Aryeo listing for ${props.street}`} className="rounded-lg border border-warning/40 bg-warning-soft/30 p-3 text-sm">
          <p className="flex items-start gap-1.5 font-medium"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> {props.listingWarning}</p>
          <p className="mt-1 text-muted">Play it in Aryeo first. If it is this video, record it under &ldquo;Done it by hand?&rdquo; instead.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={pending} className={primary} onClick={() => go(false)}>
              <UploadCloud aria-hidden className="size-4" /> Upload anyway
            </button>
            <button type="button" className={btn} onClick={() => setStep("idle")}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-muted" : "font-medium text-warning")}>{msg.text}</p>}
    </div>
  );
}

export function SendAll(props: { submissionIds: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = props.submissionIds.length;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!confirming ? (
        <button type="button" disabled={pending} className={btn} onClick={() => setConfirming(true)}>
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Send aria-hidden className="size-4" />} Send all ({n})
        </button>
      ) : (
        <>
          <span className="text-sm">Upload and send all {n} to their Aryeo listings?</span>
          <button
            type="button"
            disabled={pending}
            className={primary}
            onClick={() => {
              setConfirming(false);
              start(async () => {
                try {
                  const r = await sendAllVideosAction(props.submissionIds);
                  setMsg({ ok: r.ok, text: r.message });
                  router.refresh();
                } catch {
                  setMsg({ ok: false, text: "The hub didn't answer. Reload to see which ones started; nothing is sent twice." });
                }
              });
            }}
          >
            Yes, send all {n}
          </button>
          <button type="button" className={btn} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
      {msg && <p role="status" className={cn("w-full text-sm", msg.ok ? "text-muted" : "font-medium text-warning")}>{msg.text}</p>}
    </div>
  );
}

export function RemindButton(props: { rowKey: string; projectId: string; submissionId: string | null; label: "Remind editor" | "Remind reviewer"; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!done && (
        <button
          type="button"
          disabled={pending}
          className={btn}
          aria-label={`${props.label}: ${props.name}`}
          onClick={() =>
            start(async () => {
              try {
                const r = await remindVideoAction({ key: props.rowKey, projectId: props.projectId, submissionId: props.submissionId });
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) {
                  setDone(true);
                  router.refresh();
                }
              } catch {
                setMsg({ ok: false, text: "The hub didn't answer. Reload to see whether the reminder went." });
              }
            })
          }
        >
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <BellRing aria-hidden className="size-4" />} {props.label}
        </button>
      )}
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}
    </div>
  );
}

/** While a video is on its way, look again every 20 seconds (only while the tab is visible). */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") router.refresh();
    }, 20_000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
