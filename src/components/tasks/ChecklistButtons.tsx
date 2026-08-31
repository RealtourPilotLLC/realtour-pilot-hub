"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { markCommsHandled, setSmartTaskStatus } from "@/app/actions";
import { useRouter } from "next/navigation";

// "I handled this outside the hub" — completes the silent client_reply task,
// which every unanswered-comms surface honors as answered.
export function HandledButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <span className="shrink-0 text-xs font-medium text-success"><Check className="mr-1 inline size-3.5" />Handled</span>;
  return (
    <button
      disabled={busy}
      onClick={() => start(async () => {
        const r = await markCommsHandled(clientId).catch(() => ({ ok: false }));
        if (r.ok) { setDone(true); router.refresh(); }
      })}
      title="Mark handled — answered on a personal phone, in person, or no reply needed"
      className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Handled ✓"}
    </button>
  );
}

export function SlackDoneButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <span className="mt-0.5 shrink-0 text-xs font-medium text-success"><Check className="mr-1 inline size-3.5" />Done</span>;
  return (
    <button
      disabled={busy}
      onClick={() => start(async () => {
        await setSmartTaskStatus(taskId, "COMPLETED").catch(() => {});
        setDone(true);
        router.refresh();
      })}
      className="mt-0.5 shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Done ✓"}
    </button>
  );
}
