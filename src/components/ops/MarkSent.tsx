"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { markVideoSentAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { SaveStatus, type SaveState } from "@/components/ui/SaveStatus";

// Values are the existing server notice choices. This control records a fact;
// it never notifies a client. Monthly portal handoffs have no Aryeo email step.
export const NOTICE_OPTIONS: { value: string; label: string }[] = [
  { value: "aryeo-email", label: "Aryeo emailed them" },
  { value: "our-text", label: "We texted them" },
  { value: "phone", label: "Call or in person" },
  { value: "not-yet", label: "Not told yet" },
];
const UNKNOWN = "The delivery record is unconfirmed. It may already have saved. Refresh delivery status, or explicitly reconcile this exact handoff. Nothing retries automatically. Refreshing alone does not prove that it failed.";

/** The server owns destination proof, authorization and idempotent bookkeeping.
 * Keep explicit reconciliation after an uncertain save. Persist only an opaque retry
 * guard, never client details, notice choices or a claim of server completion. */
export function MarkSent({ submissionId, street, monthly = false, expectedFingerprint }: { submissionId: string; street: string; monthly?: boolean; expectedFingerprint?: string }) {
  const router = useRouter();
  const [receipt, setReceipt] = useState<{ state: SaveState; message: string } | null>(null);
  const [done, setDone] = useState(false), [incomplete, setIncomplete] = useState(false);
  const [held, setHeld] = useState(false), [busy, start] = useTransition(), [refreshing, refresh] = useTransition();
  const pending = useRef(false), uncertain = useRef(false), completed = useRef(false);
  const storageKey = `rtp:delivery-record:${submissionId}`;
  const hold = () => { uncertain.current = true; setHeld(true); setReceipt({ state: "error", message: UNKNOWN }); };

  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try { if (sessionStorage.getItem(storageKey)) { uncertain.current = true; setHeld(true); setReceipt({ state: "error", message: UNKNOWN }); } }
      catch { /* Submission checks storage before any server action. */ }
    });
    return () => { stopped = true;  };
  }, [storageKey]);

  const press = (notice?: string, reconcile = false) => {
    if (pending.current || (uncertain.current && !reconcile) || completed.current) return;
    try { if (sessionStorage.getItem(storageKey) && !reconcile) { hold(); return; } }
    catch { setReceipt({ state: "error", message: "Browser recovery storage is unavailable. Nothing was submitted. Restore storage before recording delivery." }); return; }
    let attempt: string;
    try { attempt = crypto.randomUUID(); sessionStorage.setItem(storageKey, attempt); }
    catch { setReceipt({ state: "error", message: "This browser could not prepare a recoverable save. Nothing was submitted; keep this cut open and restore storage before trying again." }); return; }
    pending.current = true;

    setReceipt(null);
    start(async () => {
      try {
        const r = await markVideoSentAction(submissionId, reconcile || incomplete ? undefined : notice, expectedFingerprint);
        if (!r || typeof r.ok !== "boolean" || typeof r.message !== "string") { hold(); return; }
        // A refused recovery did not perform a new write, but cannot establish
        // whether the earlier request finished. Keep its recoverable guard.
        if (reconcile && !r.ok) { hold(); setReceipt({ state: "error", message: `${r.message} The earlier delivery record is still unconfirmed. Resolve this blocker before reconciling again.` }); return; }
        const partial = r.ok && !!r.incomplete?.length;
        completed.current = r.ok && !partial;
        setIncomplete(partial); setDone(completed.current);
        const message = partial
          ? `Handoff recorded. ${r.already ? `${r.message} ` : ""}Follow-up still needs attention: ${r.incomplete!.join("; ")}. Finish those records without uploading or sending again.`
          : r.ok && monthly
            ? `${r.already ? `Portal handoff already recorded. ${r.message}` : "Portal handoff recorded."} Client approval and notification remain separate.`
            : r.message;
        setReceipt({ state: partial ? "partial" : r.ok ? "saved" : "error", message });
        uncertain.current = false; setHeld(false);
        try {
          if (sessionStorage.getItem(storageKey) === attempt) sessionStorage.removeItem(storageKey);
          if (sessionStorage.getItem(storageKey)) {
            uncertain.current = true; setHeld(true);
            setReceipt({ state: partial ? "partial" : r.ok ? "saved" : "error", message: `${message} A different unconfirmed change is still held in this tab. Refresh delivery status before any further action.` });
          }
        } catch {
          uncertain.current = true; setHeld(true);
          setReceipt({ state: partial ? "partial" : r.ok ? "saved" : "error", message: `${message} The local recovery guard could not be cleared. Inspect the exact cut before another change.` });
        }
        if (r.ok && !partial) router.refresh();
      } catch { hold(); }
      finally { pending.current = false; }
    });
  };

  return <div className="min-w-0 space-y-2">
    <Button variant="secondary" onClick={() => press()} busy={busy} busyLabel="Recording…" disabled={done || held}
      title={incomplete
        ? `${street}'s handoff is recorded. Retry only the unfinished records; nothing is sent to the client.`
        : monthly
          ? `Record ${street}'s verified portal handoff and final Dropbox backup. This does not notify the client or record their approval.`
          : `Record that ${street}'s video has been uploaded to Aryeo and delivered. This sends nothing to the client.`}>
      {done && <Check aria-hidden className="size-4" />}
      {done ? (monthly ? "Portal handoff recorded" : "Delivery recorded") : incomplete ? "Finish the bookkeeping" : monthly ? "Record portal handoff" : "Mark as sent"}
    </Button>
    {receipt && <SaveStatus state={receipt.state} message={receipt.message} className="block" />}
    {held && <div className="space-y-2">
      <p className="text-sm text-muted">Reconciliation checks this exact cut and records or repairs the handoff you already confirmed. It preserves any saved delivery and notice. It does not upload a file or send a message; notification remains owed if no notice was saved.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" busy={refreshing} busyLabel="Refreshing…" disabled={busy} onClick={() => refresh(() => router.refresh())}>Refresh delivery status</Button>
        <Button variant="secondary" busy={busy} busyLabel="Reconciling…" disabled={refreshing || done} onClick={() => press(undefined, true)}>Check and reconcile delivery record</Button>
      </div>
    </div>}
  </div>;
}
