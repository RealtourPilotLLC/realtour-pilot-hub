"use client";

import { useState, useTransition } from "react";
import { Flag, Loader2, CheckCircle2 } from "lucide-react";
import { flagPay } from "@/app/my-pay/actions";

// "Something look off?" — a photographer flags a pay line (or asks a general
// question). Goes straight to Jordan; nothing here changes any numbers.
export function PayFlag({ projectId, street, periodStartKey, already, general }: {
  projectId?: string | null;
  street?: string | null;
  periodStartKey: string;
  already?: boolean; // an open flag exists for this line
  general?: boolean; // the bottom "ask about this period" variant
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const send = () =>
    start(async () => {
      setErr(null);
      const r = await flagPay({ projectId: projectId ?? null, street: street ?? null, periodStartKey, comment: text });
      if (r.ok) { setNote(r.message); setOpen(false); setText(""); }
      else setErr(r.message);
    });

  if (note) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CheckCircle2 className="size-3.5" /> {note}
      </span>
    );
  }

  return (
    <span className={general ? "block" : "inline-block"}>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className={
            general
              ? "rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
              : "inline-flex items-center gap-1 text-[11px] font-medium text-muted-2 hover:text-warning"
          }
        >
          <Flag className={general ? "mr-1 inline size-4" : "size-3"} />
          {general ? "Ask a question about this period" : already ? "Flagged — add more" : "Flag"}
        </button>
      )}
      {open && (
        <span className="mt-1.5 block space-y-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={general ? "What's your question about this period's pay?" : "What looks off about this one?"}
            className="w-full rounded-xl border border-border bg-surface-2/50 p-2.5 text-sm"
          />
          <span className="flex items-center gap-2">
            <button onClick={send} disabled={busy || !text.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 className="size-3 animate-spin" />} Send to Jordan
            </button>
            <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-foreground">Cancel</button>
            {err && <span className="text-xs text-danger">{err}</span>}
          </span>
        </span>
      )}
    </span>
  );
}
