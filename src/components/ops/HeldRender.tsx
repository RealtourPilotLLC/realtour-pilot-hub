"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Headphones, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { recheckHeldRenderAction, resolveHeldRenderAction } from "@/app/review/actions";
import { HELD_ATTESTATION } from "@/lib/topazHold";

/**
 * A 1080p FILE THE HUB COULDN'T CHECK — the decision, on the row where it is
 * (unified handoff O02, Sep 25 2026).
 *
 * The pass finished, but neither Topaz's copy nor the one in Dropbox could be
 * read to confirm the sound survived, so the file was held: not filed as the
 * deliverable, not handed to Kyle. The editor's approved original is untouched
 * and still the file to send until somebody decides. Three buttons:
 *   · Check again   — reads the Dropbox copy once more. Free; never re-renders.
 *   · Keep original — two taps, like Mark as sent: the unchecked file goes to
 *                     superseded/ (never deleted) and the original is offered.
 *   · Use this file — only after ticking the sentence that you listened to it.
 *                     The server refuses without that exact sentence.
 *
 * A client component that takes ids and calls server actions. It must not
 * import @/lib/topazJobs (server-only) — the attestation comes from the pure
 * @/lib/topazHold so both sides compare the same words. Every answer is shown,
 * refusals included ("someone else is deciding this one").
 */
export function HeldRender({
  jobId,
  street,
  fileName,
  dropboxUrl,
  lastCheck,
}: {
  jobId: string;
  street: string;
  fileName: string;
  dropboxUrl: string | null;
  lastCheck: string | null;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [askingOriginal, setAskingOriginal] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [listened, setListened] = useState(false);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A row that leaves on a refresh must not take a pending timer with it.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "Couldn't reach the hub — try again." }));
      setMsg(r.message);
      if (r.ok) router.refresh();
    });

  const keepOriginal = () => {
    if (!askingOriginal) {
      setAskingOriginal(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAskingOriginal(false), 6000);
      return;
    }
    setAskingOriginal(false);
    run(() => resolveHeldRenderAction(jobId, "use-original"));
  };

  const btn =
    "inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:bg-surface-2 disabled:opacity-50";

  return (
    <div className="mt-1 min-w-0 space-y-1.5 rounded-lg bg-warning/10 px-2.5 py-2">
      <p className="min-w-0 break-words text-[11px] text-muted">
        <Headphones className="mr-1 inline size-3 align-[-2px]" />
        {dropboxUrl ? (
          <a href={dropboxUrl} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
            {fileName} <ExternalLink className="inline size-3 align-[-2px]" />
          </a>
        ) : (
          <span className="font-medium text-foreground">{fileName}</span>
        )}
        <span> — play it in Dropbox. The approved original is untouched until you choose.</span>
        {lastCheck && <span className="block text-muted-2">{lastCheck}</span>}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => recheckHeldRenderAction(jobId))}
          aria-label={`Check the 1080p file for ${street} again`}
          className={btn}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Check again
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={keepOriginal}
          aria-label={askingOriginal ? `Yes, keep the approved original for ${street}` : `Keep the approved original for ${street}`}
          className={btn}
        >
          <Undo2 className="size-3" /> {askingOriginal ? "Yes, keep the original" : "Keep the approved original"}
        </button>
        {!accepting && (
          <button type="button" disabled={busy} onClick={() => setAccepting(true)} className={btn}>
            <Check className="size-3" /> I listened — use this file
          </button>
        )}
      </div>
      {accepting && (
        <div className="space-y-1.5">
          <label className="flex items-start gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={listened} onChange={(e) => setListened(e.target.checked)} className="mt-0.5" />
            <span>{HELD_ATTESTATION}.</span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy || !listened}
              onClick={() => run(() => resolveHeldRenderAction(jobId, "accept-processed", HELD_ATTESTATION))}
              className={btn}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Use the 1080p file
            </button>
            <button type="button" disabled={busy} onClick={() => { setAccepting(false); setListened(false); }} className={btn}>
              Not yet
            </button>
          </div>
        </div>
      )}
      {msg && <p className="text-[10px] text-muted-2">{msg}</p>}
    </div>
  );
}
