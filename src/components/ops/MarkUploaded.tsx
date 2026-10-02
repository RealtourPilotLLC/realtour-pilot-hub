"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markVideoUploadedAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

export function MarkUploaded({ submissionId, fingerprint }: { submissionId: string; fingerprint: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [held, setHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  const key = `rtp:upload-record:${submissionId}`;
  useEffect(() => { queueMicrotask(() => { try { setHeld(Boolean(sessionStorage.getItem(key))); } catch { setHeld(true); } }); }, [key]);
  function save(reconcile = false) {
    if (guard.current || (held && !reconcile)) return;
    try {
      if (!reconcile && sessionStorage.getItem(key)) { setHeld(true); return; }
      sessionStorage.setItem(key, "unconfirmed");
    } catch { setHeld(true); setMessage("Browser recovery storage is unavailable. Nothing was submitted."); return; }
    guard.current = true;
    start(async () => {
      try {
        const result = await markVideoUploadedAction(submissionId, fingerprint);
        setMessage(result.message);
        if (result.ok) { sessionStorage.removeItem(key); setHeld(false); router.refresh(); }
        else setHeld(true);
      } catch { setHeld(true); setMessage("Upload status is unconfirmed. Refresh or reconcile this exact version before another action."); }
      finally { guard.current = false; }
    });
  }
  return <div className="space-y-2">
    <Button variant="secondary" busy={busy} busyLabel="Saving…" disabled={held} onClick={() => save()}>Mark as Uploaded</Button>
    {message && <SaveStatus state={held ? "error" : "saved"} message={message} className="block" />}
    {held && <div className="space-y-2 text-sm"><p>Upload status is unconfirmed. Check this version before another action.</p><Button variant="secondary" busy={busy} onClick={() => save(true)}>Reconcile upload record</Button></div>}
  </div>;
}
