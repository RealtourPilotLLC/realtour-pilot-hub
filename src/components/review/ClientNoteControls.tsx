"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, ListX, Loader2, Pencil, RotateCcw } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { holdBackClientNoteAction, removeClientNoteAction, rewordClientNoteAction, undoClientNoteChangeAction } from "@/app/review/noteEditActions";
import { byLine } from "@/lib/reviewAttribution";

// ---------------------------------------------------------------------------
// A CLIENT'S NOTE, CORRECTED ON OUR SIDE (Jordan, Oct 28 2026: "we need to be
// able to delete revision notes in the review room and also edit them"). The
// portal is the client's, so their words are never rewritten here. The owner,
// the office and the creative manager may:
//   · before it is sent: hold it back from the editor, or change what the
//     editor gets (sent later with the client's words beside it);
//   · after it is sent: change what the editor gets, or take it off the
//     editor's list.
// Each with Undo. lib/noteEdits holds the rules; the server re-checks.
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50";

export type ClientNoteChange = {
  heldBack: { by: string; atISO: string; changeId: string | null } | null;
  reworded: { words: string; by: string; atISO: string; changeId: string; afterSend: boolean } | null;
  removed: { by: string; atISO: string; changeId: string } | null;
};

export function ClientNoteControls({ id, status, change, editorName }: { id: string; status: string; change: ClientNoteChange | null; editorName?: string | null }) {
  const router = useRouter();
  const [rewording, setRewording] = useState(false);
  const [words, setWords] = useState(change?.reworded?.words ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sent = status === "SENT";
  const waiting = status === "OPEN";
  const who = editorName ?? "The editor";

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await fn();
      if (!r.ok) { setErr(r.message); return; }
      after?.();
      setMsg(r.message);
      router.refresh();
    });
  const undo = (changeId: string) => run(() => undoClientNoteChangeAction(changeId));

  return (
    <div className="mt-1.5 space-y-1.5" data-client-note-controls>
      {change?.heldBack && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span className="min-w-0">Held back from the editor by {byLine(change.heldBack.by, change.heldBack.atISO)}.</span>
          {change.heldBack.changeId && status === "RESOLVED" && (
            <button type="button" disabled={pending} onClick={() => undo(change.heldBack!.changeId!)} className={BTN}>
              <RotateCcw aria-hidden className="size-4" /> Undo
            </button>
          )}
        </p>
      )}
      {change?.reworded && !rewording && (
        <div className="rounded-lg bg-surface-2/60 px-2.5 py-1.5 text-[13px]">
          <p className="min-w-0 break-words">
            <span className="font-medium">{sent ? `${who} gets:` : "The editor will get:"}</span> &ldquo;{change.reworded.words}&rdquo;
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted">
            <span>Worded by {byLine(change.reworded.by, change.reworded.atISO)}. The client&rsquo;s own words stay on their page.</span>
            {/* Our wording from before the send already went in those words: change it again instead. */}
            {(change.reworded.afterSend || !sent) && (
              <button type="button" disabled={pending} onClick={() => undo(change.reworded!.changeId)} className={BTN}>
                <RotateCcw aria-hidden className="size-4" /> Undo
              </button>
            )}
          </p>
        </div>
      )}
      {change?.removed && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span className="min-w-0">Taken off the editor&rsquo;s list by {byLine(change.removed.by, change.removed.atISO)}.</span>
          <button type="button" disabled={pending} onClick={() => undo(change.removed!.changeId)} className={BTN}>
            <RotateCcw aria-hidden className="size-4" /> Undo
          </button>
        </p>
      )}
      {rewording ? (
        <div className="space-y-2">
          <AutoTextarea
            autoFocus
            minRows={2}
            maxRows={8}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            aria-label="What the editor should get"
            placeholder="What the editor should do, in plain words"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
          />
          <p className="text-[13px] text-muted">
            {sent ? `${who} already has this note. Saving changes it on their list and tells them.` : "It goes to the editor in your words, with the client's words beside it."} The client&rsquo;s note on their page does not change.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending || words.trim().length < 3} onClick={() => run(() => rewordClientNoteAction(id, words), () => setRewording(false))} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-4 text-sm font-semibold text-white disabled:opacity-50">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />} Save
            </button>
            <button type="button" disabled={pending} onClick={() => setRewording(false)} className={BTN}>Cancel</button>
          </div>
        </div>
      ) : (
        (waiting || (sent && !change?.removed)) && (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={() => { setWords(change?.reworded?.words ?? ""); setRewording(true); }} className={BTN} data-client-note-reword>
              <Pencil aria-hidden className="size-4" /> Change what the editor gets
            </button>
            {waiting && (
              <button type="button" disabled={pending} onClick={() => run(() => holdBackClientNoteAction(id))} className={BTN} data-client-note-hold>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <EyeOff aria-hidden className="size-4" />} Don&rsquo;t send to the editor
              </button>
            )}
            {sent && (
              <button type="button" disabled={pending} onClick={() => run(() => removeClientNoteAction(id))} className={`${BTN} text-danger hover:bg-danger-soft/40`} data-client-note-remove>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <ListX aria-hidden className="size-4" />} Take off the editor&rsquo;s list
              </button>
            )}
          </div>
        )
      )}
      {msg && <p role="status" className="text-[13px] text-success">{msg}</p>}
      {err && <p role="alert" className="text-[13px] text-danger">{err}</p>}
    </div>
  );
}
