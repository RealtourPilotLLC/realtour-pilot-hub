"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { startEditingAction } from "@/app/editing/workActions";

// ---------------------------------------------------------------------------
// "Are you still working on this job?" — asked right after an upload
// (Jordan, Sep 28). Since Oct 5 it sits directly under the upload panel's own
// confirmation ("Video 1 v1 sent to James for review"), so it no longer says
// "Sent." a second time.
//
// Handing a version in ends the editor's Start on that job (editorWork's
// closeActiveWork on submit), and nothing ever asked them to press Start
// again — so an editor mid-way through a four-video job read "not on anything"
// to the office all afternoon. This is the moment they obviously ARE working,
// so the hub asks — it never assumes:
//
//   · Yes → the editor's own Start, stamped at the moment they press it (the
//     server's clock, never back-dated to the upload). A restart after a
//     hand-in is a quiet start on the server, so it rings no bell. It names no
//     video (the one just handed in is not the next one) — unless their item
//     here is only PAUSED, when Yes is a resume and keeps the video they had
//     picked. The hand-in never ends a Start pressed after it (editorWork.
//     closeActiveWork's startedBefore), however late the store's callback is.
//   · No  → closes the card. No action, no write.
//
// Shown only to the editor who can start this job (the page decides: never
// the office, a preview, a blocked editor or the outside shop). Every action
// call sits inside an onClick; one click carries one request id, reused if
// they have to press it again.
// ---------------------------------------------------------------------------

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function StillWorkingPrompt({
  projectId,
  remaining,
  elsewhereStreet,
  resumes = false,
  onClose,
}: {
  projectId: string;
  /** Videos on the job still to make after the one just sent. */
  remaining: number;
  /** Their item on this job is PAUSED (not closed): Yes resumes it, keeping
   *  the video they picked, instead of starting afresh with none. */
  resumes?: boolean;
  /** The job they're on elsewhere, which Yes would pause. */
  elsewhereStreet: string | null;
  /** Closes the card; carries the server's sentence when Yes landed. */
  onClose: (receipt?: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inflight = useRef<string | null>(null);

  const yes = () => {
    const id = inflight.current ?? newId();
    inflight.current = id;
    setMsg(null);
    start(async () => {
      try {
        const r = await startEditingAction({ projectId, requestId: id, ...(resumes ? {} : { outputId: null }) });
        inflight.current = null;
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) {
          router.refresh();
          onClose(r.message);
        }
      } catch {
        setMsg({ ok: false, text: "That didn't reach the hub — press it again to retry (it won't be logged twice)." });
      }
    });
  };

  const no = () => onClose();

  return (
    <div className="mt-2 rounded-xl border border-warning/40 bg-warning-soft/60 p-3" role="group" aria-label="Are you still working on this job?">
      <p className="text-sm font-semibold text-foreground">
        Are you still working on this job?{" "}
        <span className="font-normal text-muted">{remaining} more video{remaining === 1 ? "" : "s"} to make here.</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={yes}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[#8b5cf6] px-3 py-2 text-sm font-semibold text-white hover:bg-[#7c3aed] disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Yes, I&rsquo;m on it
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={no}
          className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
        >
          No, done for now
        </button>
      </div>
      {elsewhereStreet && <p className="mt-1.5 text-[11px] text-muted">Yes pauses {elsewhereStreet}.</p>}
      {msg && (
        <p className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-warning")} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
