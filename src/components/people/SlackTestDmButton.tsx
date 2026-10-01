"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button, ActionLink } from "@/components/ui/Action";
import { sendTestSlackDm } from "@/app/team/actions";
import { useSlackAttempt } from "./useSlackAttempt";

// The server reads this exact Team row's current Slack recipient. The action
// still sends only the existing fixed test sentence, under requireAdmin().
export function SlackTestDmButton({ memberId, firstName, slackId }: { memberId: string; firstName: string; slackId: string | null }) {
  const [note, setNote] = useState<{ memberId: string; ok: boolean; msg: string } | null>(null);
  const attempt = useSlackAttempt(`slack-test-unconfirmed:${memberId}`);
  const can = !!slackId;
  async function send() {
    if (!can) return;
    const id = attempt.begin("dm");
    if (!id) return;
    setNote(null);
    try {
      const r = await sendTestSlackDm(memberId);
      const confirmed = r.ok && r.outcome === "confirmed";
      setNote({ memberId, ok: confirmed, msg: r.message });
      attempt.finish(id, confirmed || !r.ok && r.outcome === "refused");
    } catch { attempt.finish(id, false); }
  }
  const visibleNote = note?.memberId === memberId ? note : null;
  return (
    <div className="mt-3 text-sm">
      <Button variant="secondary" disabled={attempt.blocked || !can} busy={attempt.pending} onClick={send}
        title={can ? `DM ${firstName} one test sentence on Slack (${slackId})` : `No Slack ID on ${firstName}'s card yet — add it first.`}>
        <Send className="size-4" /> Send test DM
      </Button>
      {attempt.held && <div role="alert" className="mt-3 space-y-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed">
        <p>The test DM for {firstName} is unconfirmed. It may already have reached Slack. Ask Kyle to check this Team row’s recipient, the Slack conversation and request logs before sending again.</p>
        <p>This tab holds repeats. Reloading does not prove the earlier send ended.</p>
        <ActionLink href={`/team/${memberId}`}>Inspect {firstName}’s Team row</ActionLink>
      </div>}
      {attempt.localError && <p role="alert" className="mt-2 text-danger">{attempt.localError}</p>}
      {visibleNote && <p role={visibleNote.ok ? "status" : "alert"} className={`mt-2 whitespace-pre-line leading-relaxed ${visibleNote.ok ? "text-success" : "text-warning"}`}>{visibleNote.msg}</p>}
    </div>
  );
}
