"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { acknowledgeCoachingNote } from "@/app/coaching/actions";
import { ACK_NOTE_MAX, type CoachingAck } from "@/lib/coachingAck";

// ---------------------------------------------------------------------------
// "Got it" under a coaching note, for the person it is about (Jordan, Oct 27
// 2026). One primary button; a short note of their own is optional and folded
// until wanted. Once pressed it says when, and the note can still be changed.
// The time is printed by the server page (`atWords`) so it never differs
// between the server and the browser.
// ---------------------------------------------------------------------------

export function AckControl({ teamMemberId, dayKey, initial, atWords, readOnly = false }: {
  teamMemberId: string;
  dayKey: string;
  initial: CoachingAck | null;
  /** "Mon, Oct 27, 4:12 PM ET", from the server, when `initial` is set. */
  atWords: string | null;
  readOnly?: boolean;
}) {
  const [ack, setAck] = useState<CoachingAck | null>(initial);
  const [note, setNote] = useState(initial?.note ?? "");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, go] = useTransition();
  const save = () =>
    go(async () => {
      setMsg(null);
      const res = await acknowledgeCoachingNote({ teamMemberId, dayKey, note }).catch(() => ({ ok: false as const, message: "Not saved. Try again." }));
      if (res.ok) {
        setAck(res.ack);
        setOpen(false);
      } else setMsg(res.message);
    });

  return (
    <div className="mt-3 border-t border-border pt-3" data-coaching-ack={ack ? "done" : "open"}>
      {ack ? (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-success">
            <CheckCircle2 aria-hidden className="size-4" /> You said Got it{atWords && initial?.at === ack.at ? ` ${atWords}` : ""}.
          </p>
          {ack.note && <p className="text-muted">Your note: {ack.note}</p>}
          {!readOnly && !open && (
            <button type="button" onClick={() => setOpen(true)} className="min-h-9 text-xs font-medium text-muted underline underline-offset-2 hover:text-foreground">
              {ack.note ? "Change your note" : "Add a note"}
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} busy={pending} busyLabel="Saving" disabled={readOnly}>Got it</Button>
          {!open && !readOnly && (
            <button type="button" onClick={() => setOpen(true)} className="min-h-9 text-xs font-medium text-muted underline underline-offset-2 hover:text-foreground">
              Add a note (optional)
            </button>
          )}
        </div>
      )}
      {open && !readOnly && (
        <div className="mt-2 space-y-2">
          <label className="block text-xs font-medium text-muted" htmlFor={`ack-${teamMemberId}-${dayKey}`}>Your note for Jordan (optional)</label>
          <textarea
            id={`ack-${teamMemberId}-${dayKey}`}
            value={note}
            maxLength={ACK_NOTE_MAX}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} busy={pending} busyLabel="Saving">{ack ? "Save note" : "Got it"}</Button>
            <Button variant="quiet" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
      {msg && <p role="status" className="mt-2 text-xs text-danger">{msg}</p>}
    </div>
  );
}
