"use client";

import { useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { sendTestSlackDm } from "@/app/team/actions";

// Owner only: DM YOURSELF one fixed sentence to prove the Slack bridge works
// end to end (Sep 15). The action refuses, with the reason, when the signed-
// in owner's Team row has no Slack ID.
export function SlackTestDmButton() {
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => { const r = await sendTestSlackDm(); setNote({ ok: r.ok, msg: r.message }); })}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send me a test Slack DM
      </button>
      {note && <span className={`max-w-xs text-right text-[11px] ${note.ok ? "text-success" : "text-warning"}`}>{note.msg}</span>}
    </div>
  );
}
