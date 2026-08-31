"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { markCommsHandled, setSmartTaskStatus } from "@/app/actions";
import { useRouter } from "next/navigation";

// "I handled this outside the hub" — completes the silent client_reply task,
// which every unanswered-comms surface honors as answered. `groupKey` scopes
// an email tick to exactly this sender's card.
export function HandledButton({ clientId, family = "phone", groupKey }: { clientId: string; family?: "phone" | "email"; groupKey?: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (done) return <span className="shrink-0 text-xs font-medium text-success"><Check className="mr-1 inline size-3.5" />Handled</span>;
  return (
    <>
      {err && <span className="shrink-0 text-xs text-danger">{err}</span>}
      <button
        disabled={busy}
        onClick={() => start(async () => {
          setErr(null);
          const r = await markCommsHandled(clientId, family, groupKey).catch(() => ({ ok: false as const, message: "Something went wrong — try again." }));
          if (r.ok) { setDone(true); router.refresh(); }
          else setErr(("message" in r && r.message) || "No access — admins only.");
        })}
        title="Mark handled — answered on a personal phone, in person, or no reply needed"
        className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Handled ✓"}
      </button>
    </>
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
