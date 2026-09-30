"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { acknowledgeEditorBrief } from "@/app/edit/[id]/receipt.actions";
import type { AssignmentReceiptState } from "@/lib/editorBriefReceipt";

export function EditorBriefReceiptCard({ projectId, outputId, state, canAcknowledge }: {
  projectId: string;
  outputId: string;
  state: AssignmentReceiptState | null;
  canAcknowledge: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [markedDigest, setMarkedDigest] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!state) return <p className="mt-2 text-xs text-warning">Assignment receipts are unavailable until this update is released.</p>;
  if (!state.editorKey) return <p className="mt-2 text-xs text-warning">No saved editor assignment; Kyle needs to assign this video.</p>;
  const received = (state.acceptedAtISO && !state.changedSinceReceipt) || markedDigest === state.digest;
  const when = state.acceptedAtISO ? new Date(state.acceptedAtISO).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="mt-2 border-t border-border pt-2 text-xs">
      {received ? (
        <p className="flex items-start gap-1.5 text-success"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> Assignment received{markedDigest === state.digest ? " just now" : ` by ${state.acceptedBy ?? "the assigned editor"}${when ? ` · ${when}` : ""}`}.</p>
      ) : state.changedSinceReceipt ? (
        <p className="text-warning">The assignment changed since {state.acceptedBy ?? "the editor"} received it{when ? ` on ${when}` : ""}. Read this version and receive it again.</p>
      ) : (
        <p className="text-warning">Assignment not yet received by the editor.</p>
      )}
      <p className="mt-1 text-muted">Receiving the brief records what was shown. Start and Pause still record actual editing work separately.</p>
      {message && <p role="status" className={`mt-1 ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
      {canAcknowledge && !received && (
        <button type="button" disabled={pending} className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-brand px-3 py-1.5 font-semibold text-brand hover:bg-brand-soft/40 disabled:opacity-50" onClick={() => start(async () => {
          const result = await acknowledgeEditorBrief(projectId, outputId, state.digest).catch(() => ({ ok: false, message: "Could not save the receipt. Try again." }));
          setMessage({ ok: result.ok, text: result.message });
          if (result.ok) { setMarkedDigest(state.digest); router.refresh(); }
        })}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {state.changedSinceReceipt ? "Receive changed brief" : "Receive this assignment"}
        </button>
      )}
    </div>
  );
}
