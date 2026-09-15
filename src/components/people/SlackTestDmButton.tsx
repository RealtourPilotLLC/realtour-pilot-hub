"use client";

import { useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { sendTestSlackDm } from "@/app/team/actions";

// Per-row "Send test DM" (owner/admin, Sep 15): DMs THAT person one fixed
// sentence so the office can prove the Slack bridge works for each editor
// before a real ping rides it — the Sep 15 morning version only ever tested
// the signed-in owner's own account. Disabled, with the reason, until a
// Slack ID is on the card; the server action refuses again on its own, and
// hands Slack's error back verbatim when the DM fails (a missing im:write
// reads as the exact re-install hint).
export function SlackTestDmButton({ memberId, firstName, slackId }: { memberId: string; firstName: string; slackId: string | null }) {
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pending, start] = useTransition();
  const can = !!slackId;
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        disabled={pending || !can}
        title={can ? `DM ${firstName} one test sentence on Slack (${slackId})` : `No Slack ID on ${firstName}'s card yet — add it first.`}
        onClick={() => start(async () => { const r = await sendTestSlackDm(memberId); setNote({ ok: r.ok, msg: r.message }); })}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send test DM
      </button>
      {note && <p className={`mt-1.5 whitespace-pre-line ${note.ok ? "text-success" : "text-warning"}`}>{note.msg}</p>}
    </div>
  );
}
